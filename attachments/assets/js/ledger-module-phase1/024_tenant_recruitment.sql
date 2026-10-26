-- ============================================================================
-- ZANKA TENANT RECRUITMENT MODULE
-- 024_tenant_recruitment.sql
--
-- WHAT THIS ADDS
-- Everything that happens BEFORE a Draft lease exists:
--   vacancy -> public application (no account needed) -> POPIA consent ->
--   document upload -> admin screening (knockouts + 100-point score) ->
--   offer -> acceptance -> hand-over to the existing Lease Wizard.
--
-- HOW IT FITS THE EXISTING PLATFORM
-- * The Lease Wizard still creates the Draft lease, and still auto-creates
--   the KYC case (022). Nothing in the lease, inspection or KYC modules is
--   replaced. A rental_application simply records which lease it became
--   (rental_applications.lease_id -> leases.id, bigint).
-- * Deliberately NOT reusing the existing `applications` table: that table
--   is a thin partner-scoped list used by partner-dashboard.js (estate agent
--   workspace) and its live columns are not in this repo. All new objects
--   are prefixed `rental_` so nothing collides.
-- * Applicants are anonymous. They never read any table directly: every
--   public action goes through a SECURITY DEFINER function below, and the
--   tables themselves have admin-only RLS. Anonymous uploads are allowed
--   only into the folder of an application that is still in 'Uploading'
--   status and less than 2 hours old.
-- * Thresholds live in rental_recruitment_settings (one row), never in
--   frontend code. They are seeded with the draft values from the Tenant
--   Recruitment & Screening Pack and marked unconfirmed until the property
--   practitioner signs them off (settings_confirmed = true).
--
-- BEFORE RUNNING
-- Requires `is_admin()` (already used by 015, 021, 022). Confirm with:
--   select proname from pg_proc where proname = 'is_admin';
-- Run in a Supabase branch / staging project first.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Settings (single row)
-- ---------------------------------------------------------------------------

create table if not exists public.rental_recruitment_settings (
  id uuid primary key default gen_random_uuid(),
  -- Affordability = monthly rent / gross monthly household income
  affordability_knockout_max numeric(4,3) not null default 0.350,
  affordability_full_max     numeric(4,3) not null default 0.250,
  affordability_half_max     numeric(4,3) not null default 0.300,
  -- Credit score bands (bureau-specific; confirm with practitioner)
  credit_full_min integer not null default 650,
  credit_half_min integer not null default 600,
  -- Debt burden = monthly instalments (excl. rent) / net monthly income
  debt_full_max numeric(4,3) not null default 0.200,
  debt_half_max numeric(4,3) not null default 0.350,
  -- Decision bands on the 100-point score
  approve_min_score     integer not null default 70,
  conditional_min_score integer not null default 60,
  -- Process
  offer_valid_hours          integer not null default 48,
  declined_doc_retention_days integer not null default 90,
  max_upload_mb              integer not null default 10,
  settings_confirmed boolean not null default false,
  confirmed_by_note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  constraint rrs_affordability_order check (affordability_full_max <= affordability_half_max and affordability_half_max <= affordability_knockout_max),
  constraint rrs_debt_order check (debt_full_max <= debt_half_max),
  constraint rrs_credit_order check (credit_half_min <= credit_full_min),
  constraint rrs_score_order check (conditional_min_score <= approve_min_score and approve_min_score <= 100)
);

insert into public.rental_recruitment_settings (settings_confirmed)
select false
where not exists (select 1 from public.rental_recruitment_settings);

alter table public.rental_recruitment_settings enable row level security;

drop policy if exists "Admins manage rental_recruitment_settings" on public.rental_recruitment_settings;
create policy "Admins manage rental_recruitment_settings" on public.rental_recruitment_settings
  for all using (is_admin()) with check (is_admin());


-- ---------------------------------------------------------------------------
-- 2. Vacancies
-- ---------------------------------------------------------------------------

create table if not exists public.rental_vacancies (
  id uuid primary key default gen_random_uuid(),
  property_id bigint not null references public.properties(id),
  -- Public-facing text. Never put the exact unit number here.
  title text not null,
  area text not null default 'Kensington, Johannesburg',
  description text,
  bedrooms integer check (bedrooms is null or bedrooms >= 0),
  bathrooms numeric(3,1) check (bathrooms is null or bathrooms >= 0),
  parking_bays integer check (parking_bays is null or parking_bays >= 0),
  max_occupants integer check (max_occupants is null or max_occupants > 0),
  pets_policy text not null default 'No pets',
  features text[] not null default '{}',
  monthly_rent numeric(12,2) not null check (monthly_rent > 0),
  deposit numeric(12,2) check (deposit is null or deposit >= 0),
  available_from date,
  applications_close_at timestamptz,
  status text not null default 'Draft' check (status in ('Draft', 'Open', 'Closed', 'Let')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rental_vacancies_status_idx on public.rental_vacancies (status);
create index if not exists rental_vacancies_property_idx on public.rental_vacancies (property_id);

alter table public.rental_vacancies enable row level security;

drop policy if exists "Admins manage rental_vacancies" on public.rental_vacancies;
create policy "Admins manage rental_vacancies" on public.rental_vacancies
  for all using (is_admin()) with check (is_admin());


-- ---------------------------------------------------------------------------
-- 3. Applications
-- ---------------------------------------------------------------------------

create table if not exists public.rental_applications (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique
    default ('APP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  vacancy_id uuid not null references public.rental_vacancies(id),
  status text not null default 'Uploading' check (status in (
    'Uploading',      -- created, documents still being uploaded (not yet visible as a real application)
    'Submitted',      -- complete, waiting for screening
    'Screening',      -- admin is verifying / scoring
    'Shortlisted',
    'Reserve',        -- passed, kept as backup while another applicant holds the offer
    'Offered',        -- offer sent, waiting for written acceptance
    'Accepted',       -- applicant accepted in writing; ready for lease
    'Lease created',  -- Draft lease created in the Lease Wizard
    'Declined',
    'Withdrawn'
  )),

  -- 1. Personal
  full_name text not null,
  id_number text not null,
  date_of_birth date,
  email text not null,
  phone text not null,
  current_address text not null,
  marital_status text,
  dependants integer check (dependants is null or dependants >= 0),
  move_in_date date,
  lease_term_months integer not null default 12,

  -- 2. Occupants
  occupants jsonb not null default '[]'::jsonb,   -- [{ "name": "...", "age": 9 }, ...] incl. the applicant
  occupant_count integer not null default 1 check (occupant_count > 0),
  pets text,
  vehicles integer check (vehicles is null or vehicles >= 0),

  -- 3. Employment and income
  employment_type text not null check (employment_type in ('Permanent', 'Contract', 'Self-employed', 'Other')),
  employer text,
  job_title text,
  employment_start_date date,
  contract_end_date date,
  hr_contact_name text,
  hr_contact_phone text,
  hr_contact_email text,
  gross_monthly_income numeric(12,2) not null check (gross_monthly_income >= 0),
  net_monthly_income numeric(12,2) not null check (net_monthly_income >= 0),
  other_monthly_income numeric(12,2) not null default 0 check (other_monthly_income >= 0),
  other_income_source text,
  business_name text,
  business_registration text,
  accountant_contact text,

  -- 4. Accommodation history
  time_at_current_address text,
  current_rent numeric(12,2),
  current_landlord_name text,
  current_landlord_phone text,
  current_landlord_email text,
  reason_for_moving text,
  previous_address text,
  previous_landlord_contact text,

  -- 5. Commitments
  monthly_debt_instalments numeric(12,2) not null default 0 check (monthly_debt_instalments >= 0),
  adverse_history_declared boolean not null default false,
  adverse_history_explanation text,

  -- 6. Emergency contact
  emergency_contact_name text,
  emergency_contact_relationship text,
  emergency_contact_phone text,

  -- 7. Surety
  surety jsonb,   -- { "full_name", "id_number", "relationship", "phone", "email" }

  -- 8. Declaration
  declaration_accepted boolean not null default false check (declaration_accepted),
  submitted_at timestamptz,

  -- Screening (admin only)
  credit_score integer check (credit_score is null or credit_score between 0 and 999),
  credit_bureau text,
  credit_checked_at date,
  adverse_listing_found boolean,           -- judgment / adverse rental listing in last 3 years, unsettled or unexplained
  landlord_reference text check (landlord_reference is null or landlord_reference in ('positive', 'minor_late', 'none', 'negative')),
  identity_verified boolean not null default false,
  employer_verified boolean not null default false,
  income_verified boolean not null default false,
  landlord_verified boolean not null default false,
  document_mismatch boolean not null default false,
  application_quality text check (application_quality is null or application_quality in ('complete', 'follow_up', 'chasing')),
  red_flags text,
  screening_notes text,
  score_breakdown jsonb,          -- snapshot of the scoring engine output when last saved
  total_score numeric(5,1),
  knockout_failed boolean,
  recommendation text,
  screened_by uuid references public.profiles(id),
  screened_at timestamptz,

  -- Decision and hand-over
  decision_reason text,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  offer_sent_at timestamptz,
  offer_expires_at timestamptz,
  accepted_at timestamptz,
  tenant_profile_id uuid references public.profiles(id),
  lease_id bigint references public.leases(id),
  documents_purged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rental_applications_vacancy_idx on public.rental_applications (vacancy_id);
create index if not exists rental_applications_status_idx on public.rental_applications (status);
create index if not exists rental_applications_email_idx on public.rental_applications (lower(email));

alter table public.rental_applications enable row level security;

drop policy if exists "Admins manage rental_applications" on public.rental_applications;
create policy "Admins manage rental_applications" on public.rental_applications
  for all using (is_admin()) with check (is_admin());


-- Upload tokens live in their own table with NO policies at all, so no
-- client role (anon, tenant, owner, admin) can ever read one back. Only the
-- SECURITY DEFINER functions below touch it.
create table if not exists public.rental_application_tokens (
  application_id uuid primary key references public.rental_applications(id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  expires_at timestamptz not null default (now() + interval '2 hours')
);

alter table public.rental_application_tokens enable row level security;
revoke all on public.rental_application_tokens from anon, authenticated;


create table if not exists public.rental_application_documents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.rental_applications(id) on delete cascade,
  category text not null check (category in (
    'id_document', 'payslip', 'bank_statement', 'employment_letter',
    'business_financials', 'landlord_reference', 'surety_document', 'other'
  )),
  original_filename text not null,
  storage_path text not null unique,
  size_bytes bigint,
  uploaded_at timestamptz not null default now()
);

create index if not exists rental_application_documents_app_idx on public.rental_application_documents (application_id);

alter table public.rental_application_documents enable row level security;

drop policy if exists "Admins manage rental_application_documents" on public.rental_application_documents;
create policy "Admins manage rental_application_documents" on public.rental_application_documents
  for all using (is_admin()) with check (is_admin());


create table if not exists public.rental_application_consents (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.rental_applications(id) on delete cascade,
  party text not null default 'applicant' check (party in ('applicant', 'surety')),
  consent_version text not null,
  consent_text text not null,
  signed_full_name text not null,
  signed_id_number text not null,
  user_agent text,
  consented_at timestamptz not null default now()
);

create index if not exists rental_application_consents_app_idx on public.rental_application_consents (application_id);

alter table public.rental_application_consents enable row level security;

drop policy if exists "Admins read rental_application_consents" on public.rental_application_consents;
create policy "Admins read rental_application_consents" on public.rental_application_consents
  for select using (is_admin());
-- Consent records are evidence: no update/delete policy for anyone. They
-- are removed only by the cascade when an application itself is deleted.


create table if not exists public.rental_application_events (
  id bigint generated always as identity primary key,
  application_id uuid not null references public.rental_applications(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  detail jsonb,
  actor_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists rental_application_events_app_idx on public.rental_application_events (application_id, created_at);

alter table public.rental_application_events enable row level security;

drop policy if exists "Admins read rental_application_events" on public.rental_application_events;
create policy "Admins read rental_application_events" on public.rental_application_events
  for select using (is_admin());

drop policy if exists "Admins add rental_application_events" on public.rental_application_events;
create policy "Admins add rental_application_events" on public.rental_application_events
  for insert with check (is_admin());

-- Applicants never touch these tables directly.
revoke all on public.rental_vacancies, public.rental_applications,
  public.rental_application_documents, public.rental_application_consents,
  public.rental_application_events, public.rental_recruitment_settings
  from anon;


-- ---------------------------------------------------------------------------
-- 4. Triggers: updated_at, status audit trail, vacancy -> Let
-- ---------------------------------------------------------------------------

create or replace function public.rental_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rental_vacancies_touch on public.rental_vacancies;
create trigger rental_vacancies_touch before update on public.rental_vacancies
  for each row execute function public.rental_touch_updated_at();

drop trigger if exists rental_applications_touch on public.rental_applications;
create trigger rental_applications_touch before update on public.rental_applications
  for each row execute function public.rental_touch_updated_at();

drop trigger if exists rental_recruitment_settings_touch on public.rental_recruitment_settings;
create trigger rental_recruitment_settings_touch before update on public.rental_recruitment_settings
  for each row execute function public.rental_touch_updated_at();


create or replace function public.rental_application_status_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.rental_application_events (application_id, event_type, from_status, to_status, actor_id, detail)
    values (new.id, 'status_change', old.status, new.status, auth.uid(),
            case when new.decision_reason is not null and new.status in ('Declined', 'Withdrawn')
                 then jsonb_build_object('reason', new.decision_reason) end);

    -- A lease now exists for this unit: take the vacancy off the market.
    if new.status = 'Lease created' then
      update public.rental_vacancies set status = 'Let' where id = new.vacancy_id and status <> 'Let';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists rental_applications_status_audit on public.rental_applications;
create trigger rental_applications_status_audit after update of status on public.rental_applications
  for each row execute function public.rental_application_status_audit();


-- ---------------------------------------------------------------------------
-- 5. Public functions (the ONLY way anonymous applicants touch the module)
-- ---------------------------------------------------------------------------

-- Open vacancies for the public "to let" page. Exposes no property id,
-- address or owner — only the public listing text.
create or replace function public.list_open_rental_vacancies()
returns table (
  id uuid, title text, area text, description text,
  bedrooms integer, bathrooms numeric, parking_bays integer, max_occupants integer,
  pets_policy text, features text[], monthly_rent numeric, deposit numeric,
  available_from date, applications_close_at timestamptz, min_gross_income numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.title, v.area, v.description,
         v.bedrooms, v.bathrooms, v.parking_bays, v.max_occupants,
         v.pets_policy, v.features, v.monthly_rent, v.deposit,
         v.available_from, v.applications_close_at,
         ceil(v.monthly_rent / s.affordability_knockout_max) as min_gross_income
  from public.rental_vacancies v
  cross join (select affordability_knockout_max from public.rental_recruitment_settings order by updated_at desc limit 1) s
  where v.status = 'Open'
    and (v.applications_close_at is null or v.applications_close_at > now())
  order by v.available_from nulls last, v.created_at;
$$;

revoke all on function public.list_open_rental_vacancies() from public;
grant execute on function public.list_open_rental_vacancies() to anon, authenticated;


-- Creates the application in 'Uploading' status and returns an upload
-- token. p_application is the form as JSON (keys = column names above);
-- p_consent = { "consent_version", "consent_text", "signed_full_name",
-- "signed_id_number", "user_agent" }.
create or replace function public.submit_rental_application(
  p_vacancy_id uuid,
  p_application jsonb,
  p_consent jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vacancy public.rental_vacancies%rowtype;
  v_app_id uuid;
  v_reference text;
  v_token uuid;
  v_id_number text := trim(coalesce(p_application->>'id_number', ''));
  v_email text := lower(trim(coalesce(p_application->>'email', '')));
  v_occupants jsonb := coalesce(p_application->'occupants', '[]'::jsonb);
begin
  select * into v_vacancy from public.rental_vacancies where id = p_vacancy_id;
  if not found or v_vacancy.status <> 'Open'
     or (v_vacancy.applications_close_at is not null and v_vacancy.applications_close_at <= now()) then
    raise exception 'This unit is no longer accepting applications.' using errcode = 'P0001';
  end if;

  -- Required fields
  if coalesce(trim(p_application->>'full_name'), '') = '' or v_id_number = '' or v_email = ''
     or coalesce(trim(p_application->>'phone'), '') = '' or coalesce(trim(p_application->>'current_address'), '') = ''
     or coalesce(p_application->>'employment_type', '') = ''
     or p_application->>'gross_monthly_income' is null or p_application->>'net_monthly_income' is null then
    raise exception 'Please complete all required fields.' using errcode = 'P0001';
  end if;

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address.' using errcode = 'P0001';
  end if;

  if coalesce((p_application->>'declaration_accepted')::boolean, false) is not true then
    raise exception 'You must accept the declaration to apply.' using errcode = 'P0001';
  end if;

  if coalesce(trim(p_consent->>'signed_full_name'), '') = '' or coalesce(trim(p_consent->>'signed_id_number'), '') = ''
     or coalesce(p_consent->>'consent_text', '') = '' or coalesce(p_consent->>'consent_version', '') = '' then
    raise exception 'Consent to the credit and reference checks is required.' using errcode = 'P0001';
  end if;

  if trim(p_consent->>'signed_id_number') <> v_id_number then
    raise exception 'The ID number on the consent must match the application.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_occupants) <> 'array' or jsonb_array_length(v_occupants) > 20 then
    raise exception 'Occupants list is invalid.' using errcode = 'P0001';
  end if;

  -- One live application per ID number per unit. Abandoned 'Uploading'
  -- attempts older than 2 hours don't count.
  if exists (
    select 1 from public.rental_applications a
    where a.vacancy_id = p_vacancy_id and a.id_number = v_id_number
      and (a.status <> 'Uploading' or a.created_at > now() - interval '2 hours')
      and a.status not in ('Withdrawn')
  ) then
    raise exception 'An application with this ID number already exists for this unit. Please contact us if you need to update it.' using errcode = 'P0001';
  end if;

  -- Basic abuse guard: at most 5 new applications per email per day.
  if (select count(*) from public.rental_applications a
      where lower(a.email) = v_email and a.created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many applications from this email today. Please try again tomorrow.' using errcode = 'P0001';
  end if;

  insert into public.rental_applications (
    vacancy_id, status,
    full_name, id_number, date_of_birth, email, phone, current_address, marital_status, dependants,
    move_in_date, lease_term_months,
    occupants, occupant_count, pets, vehicles,
    employment_type, employer, job_title, employment_start_date, contract_end_date,
    hr_contact_name, hr_contact_phone, hr_contact_email,
    gross_monthly_income, net_monthly_income, other_monthly_income, other_income_source,
    business_name, business_registration, accountant_contact,
    time_at_current_address, current_rent, current_landlord_name, current_landlord_phone, current_landlord_email,
    reason_for_moving, previous_address, previous_landlord_contact,
    monthly_debt_instalments, adverse_history_declared, adverse_history_explanation,
    emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
    surety, declaration_accepted
  ) values (
    p_vacancy_id, 'Uploading',
    left(trim(p_application->>'full_name'), 200), left(v_id_number, 30),
    nullif(p_application->>'date_of_birth', '')::date, left(v_email, 200),
    left(trim(p_application->>'phone'), 40), left(trim(p_application->>'current_address'), 500),
    nullif(p_application->>'marital_status', ''), nullif(p_application->>'dependants', '')::integer,
    nullif(p_application->>'move_in_date', '')::date, coalesce(nullif(p_application->>'lease_term_months', '')::integer, 12),
    v_occupants, greatest(1, coalesce(nullif(p_application->>'occupant_count', '')::integer, jsonb_array_length(v_occupants), 1)),
    nullif(p_application->>'pets', ''), nullif(p_application->>'vehicles', '')::integer,
    p_application->>'employment_type', nullif(p_application->>'employer', ''), nullif(p_application->>'job_title', ''),
    nullif(p_application->>'employment_start_date', '')::date, nullif(p_application->>'contract_end_date', '')::date,
    nullif(p_application->>'hr_contact_name', ''), nullif(p_application->>'hr_contact_phone', ''), nullif(p_application->>'hr_contact_email', ''),
    (p_application->>'gross_monthly_income')::numeric, (p_application->>'net_monthly_income')::numeric,
    coalesce(nullif(p_application->>'other_monthly_income', '')::numeric, 0), nullif(p_application->>'other_income_source', ''),
    nullif(p_application->>'business_name', ''), nullif(p_application->>'business_registration', ''), nullif(p_application->>'accountant_contact', ''),
    nullif(p_application->>'time_at_current_address', ''), nullif(p_application->>'current_rent', '')::numeric,
    nullif(p_application->>'current_landlord_name', ''), nullif(p_application->>'current_landlord_phone', ''), nullif(p_application->>'current_landlord_email', ''),
    nullif(p_application->>'reason_for_moving', ''), nullif(p_application->>'previous_address', ''), nullif(p_application->>'previous_landlord_contact', ''),
    coalesce(nullif(p_application->>'monthly_debt_instalments', '')::numeric, 0),
    coalesce((p_application->>'adverse_history_declared')::boolean, false), nullif(p_application->>'adverse_history_explanation', ''),
    nullif(p_application->>'emergency_contact_name', ''), nullif(p_application->>'emergency_contact_relationship', ''), nullif(p_application->>'emergency_contact_phone', ''),
    case when jsonb_typeof(p_application->'surety') = 'object' and coalesce(p_application->'surety'->>'full_name', '') <> ''
         then p_application->'surety' end,
    true
  )
  returning id, reference into v_app_id, v_reference;

  insert into public.rental_application_consents (application_id, party, consent_version, consent_text, signed_full_name, signed_id_number, user_agent)
  values (v_app_id, 'applicant', p_consent->>'consent_version', p_consent->>'consent_text',
          left(trim(p_consent->>'signed_full_name'), 200), left(trim(p_consent->>'signed_id_number'), 30),
          left(p_consent->>'user_agent', 400));

  if jsonb_typeof(p_consent->'surety') = 'object' and coalesce(trim(p_consent->'surety'->>'signed_full_name'), '') <> '' then
    insert into public.rental_application_consents (application_id, party, consent_version, consent_text, signed_full_name, signed_id_number, user_agent)
    values (v_app_id, 'surety', p_consent->>'consent_version', p_consent->>'consent_text',
            left(trim(p_consent->'surety'->>'signed_full_name'), 200), left(trim(coalesce(p_consent->'surety'->>'signed_id_number', '')), 30),
            left(p_consent->>'user_agent', 400));
  end if;

  insert into public.rental_application_tokens (application_id) values (v_app_id)
  returning token into v_token;

  insert into public.rental_application_events (application_id, event_type, to_status)
  values (v_app_id, 'created', 'Uploading');

  return jsonb_build_object('id', v_app_id, 'reference', v_reference, 'upload_token', v_token);
end;
$$;

revoke all on function public.submit_rental_application(uuid, jsonb, jsonb) from public;
grant execute on function public.submit_rental_application(uuid, jsonb, jsonb) to anon, authenticated;


-- Used by the storage policy: may an upload land in this application's folder?
create or replace function public.rental_application_accepting_uploads(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rental_applications a
    join public.rental_application_tokens t on t.application_id = a.id
    where a.id::text = p_folder
      and a.status = 'Uploading'
      and t.expires_at > now()
  );
$$;

revoke all on function public.rental_application_accepting_uploads(text) from public;
grant execute on function public.rental_application_accepting_uploads(text) to anon, authenticated;


create or replace function public.register_rental_application_document(
  p_application_id uuid,
  p_upload_token uuid,
  p_category text,
  p_original_filename text,
  p_storage_path text,
  p_size_bytes bigint
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc_id uuid;
begin
  if not exists (
    select 1 from public.rental_application_tokens t
    join public.rental_applications a on a.id = t.application_id
    where t.application_id = p_application_id and t.token = p_upload_token
      and t.expires_at > now() and a.status = 'Uploading'
  ) then
    raise exception 'This upload session has expired. Please start your application again.' using errcode = 'P0001';
  end if;

  if p_storage_path is null or p_storage_path not like p_application_id::text || '/%' then
    raise exception 'Invalid document path.' using errcode = 'P0001';
  end if;

  if not exists (select 1 from storage.objects o where o.bucket_id = 'rental-applications' and o.name = p_storage_path) then
    raise exception 'The document upload did not complete. Please try again.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.rental_application_documents where application_id = p_application_id) >= 25 then
    raise exception 'Too many documents on one application.' using errcode = 'P0001';
  end if;

  insert into public.rental_application_documents (application_id, category, original_filename, storage_path, size_bytes)
  values (p_application_id, p_category, left(coalesce(p_original_filename, 'document'), 255), p_storage_path, p_size_bytes)
  returning id into v_doc_id;

  return v_doc_id;
end;
$$;

revoke all on function public.register_rental_application_document(uuid, uuid, text, text, text, bigint) from public;
grant execute on function public.register_rental_application_document(uuid, uuid, text, text, text, bigint) to anon, authenticated;


-- Checks the required documents are present, then submits. Returns the
-- reference. Required: ID; 3 months' bank statements; plus payslips for
-- employed applicants, or business financials for the self-employed.
create or replace function public.complete_rental_application(
  p_application_id uuid,
  p_upload_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app public.rental_applications%rowtype;
  v_missing text[] := '{}';
  v_has_surety boolean;
begin
  select a.* into v_app
  from public.rental_applications a
  join public.rental_application_tokens t on t.application_id = a.id
  where a.id = p_application_id and t.token = p_upload_token and t.expires_at > now();

  if not found then
    raise exception 'This upload session has expired. Please start your application again.' using errcode = 'P0001';
  end if;

  if v_app.status <> 'Uploading' then
    return jsonb_build_object('reference', v_app.reference, 'status', v_app.status);
  end if;

  if not exists (select 1 from public.rental_application_documents where application_id = v_app.id and category = 'id_document') then
    v_missing := array_append(v_missing, 'ID document');
  end if;
  if not exists (select 1 from public.rental_application_documents where application_id = v_app.id and category = 'bank_statement') then
    v_missing := array_append(v_missing, 'Bank statements');
  end if;
  if v_app.employment_type = 'Self-employed' then
    if not exists (select 1 from public.rental_application_documents where application_id = v_app.id and category = 'business_financials') then
      v_missing := array_append(v_missing, 'Business financials or tax return');
    end if;
  elsif not exists (select 1 from public.rental_application_documents where application_id = v_app.id and category = 'payslip') then
    v_missing := array_append(v_missing, 'Payslips');
  end if;

  v_has_surety := v_app.surety is not null;
  if v_has_surety and not exists (select 1 from public.rental_application_documents where application_id = v_app.id and category = 'surety_document') then
    v_missing := array_append(v_missing, 'Surety documents');
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'Missing required documents: %', array_to_string(v_missing, ', ') using errcode = 'P0001';
  end if;

  update public.rental_applications
     set status = 'Submitted', submitted_at = now()
   where id = v_app.id;

  -- Token is single-use from here on.
  delete from public.rental_application_tokens where application_id = v_app.id;

  return jsonb_build_object('reference', v_app.reference, 'status', 'Submitted');
end;
$$;

revoke all on function public.complete_rental_application(uuid, uuid) from public;
grant execute on function public.complete_rental_application(uuid, uuid) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. Private storage bucket for application documents
-- Path convention: {application_id}/{category}/{random}-{filename}
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'rental-applications', 'rental-applications', false, 10485760,
       array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
where not exists (select 1 from storage.buckets where id = 'rental-applications');

-- Anyone (anon included) may ADD a file, but only into the folder of an
-- application that is still uploading with a live token. No read, update
-- or delete for applicants: once uploaded, only admins can see a file.
drop policy if exists "Applicants upload rental-application documents" on storage.objects;
create policy "Applicants upload rental-application documents" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'rental-applications'
    and public.rental_application_accepting_uploads((storage.foldername(name))[1])
  );

drop policy if exists "Admins manage rental-application documents" on storage.objects;
create policy "Admins manage rental-application documents" on storage.objects
  for all using (bucket_id = 'rental-applications' and is_admin())
  with check (bucket_id = 'rental-applications' and is_admin());
