-- ============================================================================
-- ZANKA KYC / TENANT-SCREENING MODULE
-- 022_kyc_module.sql
--
-- ARCHITECTURE NOTE — read before running:
-- The platform has NO existing tenant-facing "application" table or public
-- apply flow (verified by inspection, not assumed). A tenant's file today
-- starts when an admin creates a Draft lease (leases.status = 'Draft',
-- leases.fica_status = 'Pending') via the Lease Wizard, before any
-- signature happens. Per your explicit choice, kyc_cases.application_id
-- therefore references leases.id — "application" on this platform IS the
-- Draft lease. No new public application table is created.
--
-- This also means the existing fica_status manual toggle on `leases` is
-- exactly the gap this module automates: a trigger below flips
-- leases.fica_status to 'Approved'/'Rejected' automatically when a
-- kyc_cases row reaches a terminal outcome, so lease-manager.js's existing
-- "Send for Signature" gate (which already checks fica_status) keeps
-- working completely unchanged.
--
-- PROPERTY MANAGER ROLE: no `property_manager` profiles.role value exists
-- anywhere on this platform today (verified — only tenant/owner/partner/
-- investor/admin are real). The policies below are written to support it
-- via a new, currently-empty property_manager_assignments table, so they
-- are safe no-ops today and need no rework if/when real property-manager
-- accounts are introduced. Run `select distinct role from profiles;`
-- yourself if you want to double-check before relying on this.
--
-- OWNER ACCESS: owners are deliberately NOT granted direct RLS SELECT on
-- any kyc_* table. The spec calls for a "restricted summary" only — that's
-- served exclusively through the kyc-get-status Edge Function (service
-- role, curated fields), which is a much safer way to guarantee an owner
-- can never see raw_response/reviewer notes than trying to hand-craft a
-- row-level policy that leaks by accident.
--
-- RAW PROVIDER DATA: raw_response (and provider/provider_reference) are
-- revoked from the `authenticated` Postgres role entirely via column-level
-- GRANTs, not just RLS — Supabase's `authenticated` role is shared by every
-- logged-in user regardless of app-level profiles.role, so column grants
-- are the only way to guarantee NO frontend (tenant, owner, property
-- manager, or admin) can ever pull raw provider payloads via a direct
-- table query. The admin case-detail screen gets a properly formatted view
-- of this data from kyc-get-status (service role) instead.
--
-- BEFORE RUNNING: this assumes `is_admin()` already exists in your live
-- Supabase project (it's used throughout the ledger/units modules already
-- built this session) — confirm with:
--   select proname from pg_proc where proname = 'is_admin';
-- If it doesn't exist, stop and tell me — do not guess its definition.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Small forward-compat helper — see PROPERTY MANAGER note above.
-- ---------------------------------------------------------------------------

create table if not exists public.property_manager_assignments (
  id uuid primary key default gen_random_uuid(),
  property_manager_id uuid not null references public.profiles(id),
  property_id bigint not null references public.properties(id),
  assigned_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (property_manager_id, property_id)
);

alter table public.property_manager_assignments enable row level security;

drop policy if exists "Admins manage property_manager_assignments" on public.property_manager_assignments;
create policy "Admins manage property_manager_assignments" on public.property_manager_assignments
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Property managers view their own assignments" on public.property_manager_assignments;
create policy "Property managers view their own assignments" on public.property_manager_assignments
  for select using (property_manager_id = auth.uid());

create or replace function public.is_property_manager()
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'property_manager');
$$;

-- True if the given property is one the current user manages (property
-- manager) or administers (admin always passes). Used to scope kyc_* rows
-- to "properties they manage" per the spec, without a manager seeing
-- unrelated applicants.
create or replace function public.can_access_property_kyc(p_property_id bigint)
returns boolean
language sql
stable
as $$
  select public.is_admin()
    or exists (
      select 1 from public.property_manager_assignments pma
      where pma.property_id = p_property_id and pma.property_manager_id = auth.uid()
    );
$$;

-- ---------------------------------------------------------------------------
-- 1. Compliance settings — the one configurable row driving thresholds,
-- enabled checks, provider choice and retention periods. Never hardcode
-- these in frontend or Edge Function code; always read from here.
-- ---------------------------------------------------------------------------

create table if not exists public.compliance_settings (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'placeholder',
  enabled_checks jsonb not null default '{
    "identity": true, "id_document": true, "face_match": false, "liveness": false,
    "bank_account": true, "credit": true, "aml": true, "pep": true,
    "sanctions": true, "affordability": true
  }'::jsonb,
  -- overall_score (0-100, lower = riskier is a choice you can flip in the
  -- scoring engine — documented there) maps to a risk_level using these
  -- configurable cutoffs rather than a hardcoded if/else anywhere.
  risk_thresholds jsonb not null default '{"low_max": 39, "medium_max": 69}'::jsonb,
  require_manual_review boolean not null default true,
  require_kyc_before_lease boolean not null default true,
  -- Deliberately nullable — do NOT invent a legal retention number here.
  -- Null means "not yet configured"; the admin Settings screen should
  -- visibly flag these as unset until Zanka's legal/privacy review sets
  -- real values.
  document_retention_period_days integer,
  kyc_record_retention_period_days integer,
  audit_log_retention_period_days integer,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

insert into public.compliance_settings (provider)
select 'placeholder'
where not exists (select 1 from public.compliance_settings);

alter table public.compliance_settings enable row level security;

drop policy if exists "Admins manage compliance_settings" on public.compliance_settings;
create policy "Admins manage compliance_settings" on public.compliance_settings
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 2. Core tables
-- ---------------------------------------------------------------------------

create table if not exists public.kyc_cases (
  id uuid primary key default gen_random_uuid(),
  application_id bigint not null references public.leases(id), -- see architecture note above — leases.id is bigint, not uuid, on this database
  tenant_id uuid references public.profiles(id),
  property_id bigint references public.properties(id), -- denormalized from the lease at creation time, for simple RLS/reporting joins
  status text not null default 'pending_consent' check (status in (
    'pending_consent','consent_given','in_progress','verification_complete',
    'manual_review','approved','declined','expired','cancelled'
  )),
  overall_result text,
  risk_level text check (risk_level in ('LOW','MEDIUM','HIGH')),
  provider text,
  provider_case_id text,
  consent_given boolean not null default false,
  consent_timestamp timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  review_required boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one non-terminal (active) KYC case per lease/application — a
-- declined or cancelled case can be legitimately superseded by a fresh one
-- (e.g. re-applying after supplying missing information via a new case),
-- but two case simultaneously "in flight" for the same lease is a bug.
create unique index if not exists idx_kyc_cases_one_active_per_application
  on public.kyc_cases (application_id)
  where status not in ('declined','expired','cancelled');

create index if not exists idx_kyc_cases_tenant on public.kyc_cases(tenant_id);
create index if not exists idx_kyc_cases_property on public.kyc_cases(property_id);
create index if not exists idx_kyc_cases_status on public.kyc_cases(status);

create table if not exists public.kyc_checks (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  check_type text not null check (check_type in (
    'identity','id_document','face_match','liveness','aml','pep','sanctions',
    'bank_account','credit','income','employment','address','rental_history'
  )),
  provider text,
  provider_reference text,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','failed','expired','cancelled')),
  result text check (result in ('pass','fail','review')),
  score numeric,
  risk_level text check (risk_level in ('LOW','MEDIUM','HIGH')),
  started_at timestamptz,
  completed_at timestamptz,
  failure_reason text,
  raw_response jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_kyc_checks_case on public.kyc_checks(kyc_case_id);
create index if not exists idx_kyc_checks_type on public.kyc_checks(check_type);
-- Idempotency support for the provider webhook — see kyc-provider-webhook.
create unique index if not exists idx_kyc_checks_provider_ref
  on public.kyc_checks(provider, provider_reference)
  where provider_reference is not null;

create table if not exists public.kyc_documents (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  tenant_id uuid references public.profiles(id),
  document_type text not null,
  storage_path text not null,
  file_name text,
  mime_type text,
  file_size integer,
  document_hash text,
  verification_status text not null default 'pending' check (verification_status in ('pending','verified','rejected')),
  uploaded_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz
);

create index if not exists idx_kyc_documents_case on public.kyc_documents(kyc_case_id);
create index if not exists idx_kyc_documents_tenant on public.kyc_documents(tenant_id);

create table if not exists public.kyc_consents (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  tenant_id uuid references public.profiles(id),
  consent_type text not null check (consent_type in ('identity_verification','credit_background_screening','data_processing')),
  consent_text text not null,
  consent_version text not null,
  accepted boolean not null,
  accepted_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_kyc_consents_case on public.kyc_consents(kyc_case_id);

create table if not exists public.kyc_risk_assessments (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  identity_score numeric,
  credit_score numeric,
  affordability_score numeric,
  document_score numeric,
  aml_score numeric,
  overall_score numeric,
  risk_level text check (risk_level in ('LOW','MEDIUM','HIGH')),
  recommendation text check (recommendation in ('PROCEED','REVIEW','DO_NOT_PROCEED')),
  rules_triggered jsonb,
  assessed_at timestamptz not null default now()
);

create index if not exists idx_kyc_risk_assessments_case on public.kyc_risk_assessments(kyc_case_id);

create table if not exists public.kyc_reviews (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id),
  decision text not null check (decision in ('approved','declined','request_information','escalated')),
  reason text,
  notes text,
  reviewed_at timestamptz not null default now()
);

create index if not exists idx_kyc_reviews_case on public.kyc_reviews(kyc_case_id);

create table if not exists public.kyc_audit_log (
  id uuid primary key default gen_random_uuid(),
  kyc_case_id uuid not null references public.kyc_cases(id) on delete cascade,
  user_id uuid references public.profiles(id),
  event_type text not null,
  event_description text,
  old_status text,
  new_status text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_kyc_audit_log_case on public.kyc_audit_log(kyc_case_id);
create index if not exists idx_kyc_audit_log_created on public.kyc_audit_log(created_at);

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------

alter table public.kyc_cases enable row level security;
alter table public.kyc_checks enable row level security;
alter table public.kyc_documents enable row level security;
alter table public.kyc_consents enable row level security;
alter table public.kyc_risk_assessments enable row level security;
alter table public.kyc_reviews enable row level security;
alter table public.kyc_audit_log enable row level security;

-- kyc_cases
drop policy if exists "Admins manage kyc_cases" on public.kyc_cases;
create policy "Admins manage kyc_cases" on public.kyc_cases
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Property managers view assigned kyc_cases" on public.kyc_cases;
create policy "Property managers view assigned kyc_cases" on public.kyc_cases
  for select using (public.is_property_manager() and public.can_access_property_kyc(property_id));

drop policy if exists "Tenants view their own kyc_cases" on public.kyc_cases;
create policy "Tenants view their own kyc_cases" on public.kyc_cases
  for select using (tenant_id = auth.uid());

-- kyc_checks
drop policy if exists "Admins manage kyc_checks" on public.kyc_checks;
create policy "Admins manage kyc_checks" on public.kyc_checks
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Property managers view assigned kyc_checks" on public.kyc_checks;
create policy "Property managers view assigned kyc_checks" on public.kyc_checks
  for select using (
    public.is_property_manager()
    and exists (select 1 from public.kyc_cases c where c.id = kyc_checks.kyc_case_id and public.can_access_property_kyc(c.property_id))
  );

drop policy if exists "Tenants view their own kyc_checks" on public.kyc_checks;
create policy "Tenants view their own kyc_checks" on public.kyc_checks
  for select using (
    exists (select 1 from public.kyc_cases c where c.id = kyc_checks.kyc_case_id and c.tenant_id = auth.uid())
  );

-- kyc_documents
drop policy if exists "Admins manage kyc_documents" on public.kyc_documents;
create policy "Admins manage kyc_documents" on public.kyc_documents
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Property managers view assigned kyc_documents" on public.kyc_documents;
create policy "Property managers view assigned kyc_documents" on public.kyc_documents
  for select using (
    public.is_property_manager()
    and exists (select 1 from public.kyc_cases c where c.id = kyc_documents.kyc_case_id and public.can_access_property_kyc(c.property_id))
  );

drop policy if exists "Tenants manage their own kyc_documents" on public.kyc_documents;
create policy "Tenants manage their own kyc_documents" on public.kyc_documents
  for select using (tenant_id = auth.uid());

drop policy if exists "Tenants upload their own kyc_documents" on public.kyc_documents;
create policy "Tenants upload their own kyc_documents" on public.kyc_documents
  for insert with check (tenant_id = auth.uid());

-- kyc_consents
drop policy if exists "Admins manage kyc_consents" on public.kyc_consents;
create policy "Admins manage kyc_consents" on public.kyc_consents
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Tenants manage their own kyc_consents" on public.kyc_consents;
create policy "Tenants manage their own kyc_consents" on public.kyc_consents
  for select using (tenant_id = auth.uid());

drop policy if exists "Tenants record their own kyc_consents" on public.kyc_consents;
create policy "Tenants record their own kyc_consents" on public.kyc_consents
  for insert with check (tenant_id = auth.uid());

-- kyc_risk_assessments — admin + property manager only. Not exposed to
-- tenants at all (internal scoring detail); tenants get a plain-language
-- status via kyc-get-status instead, per "Do not display sensitive
-- internal risk information to the applicant unless explicitly configured."
drop policy if exists "Admins manage kyc_risk_assessments" on public.kyc_risk_assessments;
create policy "Admins manage kyc_risk_assessments" on public.kyc_risk_assessments
  for all using (is_admin()) with check (is_admin());

drop policy if exists "Property managers view assigned kyc_risk_assessments" on public.kyc_risk_assessments;
create policy "Property managers view assigned kyc_risk_assessments" on public.kyc_risk_assessments
  for select using (
    public.is_property_manager()
    and exists (select 1 from public.kyc_cases c where c.id = kyc_risk_assessments.kyc_case_id and public.can_access_property_kyc(c.property_id))
  );

-- kyc_reviews — admin only. Internal reviewer notes must never reach a
-- tenant, and the spec doesn't ask for property-manager visibility here.
drop policy if exists "Admins manage kyc_reviews" on public.kyc_reviews;
create policy "Admins manage kyc_reviews" on public.kyc_reviews
  for all using (is_admin()) with check (is_admin());

-- kyc_audit_log — admin only.
drop policy if exists "Admins manage kyc_audit_log" on public.kyc_audit_log;
create policy "Admins manage kyc_audit_log" on public.kyc_audit_log
  for all using (is_admin()) with check (is_admin());

-- Column-level lockdown — applies to the shared `authenticated` Postgres
-- role regardless of app-level profiles.role, so this is what actually
-- guarantees raw provider payloads never reach ANY frontend directly, not
-- just RLS. Admin's rich detail view is served by kyc-get-status (service
-- role) instead, which can read every column.
revoke all on public.kyc_checks from authenticated;
grant select (id, kyc_case_id, check_type, status, result, risk_level, started_at, completed_at, failure_reason, created_at) on public.kyc_checks to authenticated;

revoke all on public.kyc_cases from authenticated;
grant select (id, application_id, tenant_id, property_id, status, overall_result, risk_level, consent_given, consent_timestamp, started_at, completed_at, expires_at, review_required, created_at, updated_at) on public.kyc_cases to authenticated;
-- review_reason intentionally excluded — internal compliance note.

revoke all on public.kyc_risk_assessments from authenticated;
grant select (id, kyc_case_id, risk_level, recommendation, assessed_at) on public.kyc_risk_assessments to authenticated;
-- Individual sub-scores (identity_score, credit_score, etc.) and
-- rules_triggered intentionally excluded from direct client reads.

-- kyc_documents / kyc_consents / kyc_reviews / kyc_audit_log: no raw
-- provider data lives in these, existing RLS row policies are sufficient;
-- grant full column access to authenticated (row policies already scope
-- correctly), except kyc_reviews/kyc_audit_log which only admins can
-- select at all per their RLS above.
grant select, insert on public.kyc_documents to authenticated;
grant select, insert on public.kyc_consents to authenticated;
grant select on public.kyc_reviews to authenticated;
grant select on public.kyc_audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Private storage bucket for KYC documents
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
select 'kyc-documents', 'kyc-documents', false
where not exists (select 1 from storage.buckets where id = 'kyc-documents');

-- Objects are stored under `${tenant_id}/${kyc_case_id}/...` — tenants can
-- only reach their own folder; admin has full access; nobody gets a public
-- URL (bucket is private, always requires a signed URL).
drop policy if exists "Tenants manage their own kyc-documents objects" on storage.objects;
create policy "Tenants manage their own kyc-documents objects" on storage.objects
  for all using (
    bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'kyc-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Admins manage kyc-documents objects" on storage.objects;
create policy "Admins manage kyc-documents objects" on storage.objects
  for all using (bucket_id = 'kyc-documents' and is_admin())
  with check (bucket_id = 'kyc-documents' and is_admin());

-- ---------------------------------------------------------------------------
-- 5. Integration trigger — kyc_cases.status -> leases.fica_status.
-- Keeps the EXISTING lease-signature gate (lease-manager.js already checks
-- fica_status before allowing "Send for Signature") working unchanged; the
-- KYC pipeline becomes the automated engine behind that field instead of
-- requiring a rewrite of the lease flow.
-- ---------------------------------------------------------------------------

create or replace function public.sync_kyc_case_to_lease_fica()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'approved' then
      update public.leases set fica_status = 'Approved' where id = new.application_id;
    elsif new.status = 'declined' then
      update public.leases set fica_status = 'Rejected' where id = new.application_id;
    end if;

    -- Generic safety-net audit row for every status transition, in
    -- addition to the richer, event-specific rows Edge Functions write.
    insert into public.kyc_audit_log (kyc_case_id, user_id, event_type, event_description, old_status, new_status)
    values (new.id, auth.uid(), 'STATUS_CHANGED', format('kyc_cases.status changed from %s to %s', old.status, new.status), old.status, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_kyc_case_to_lease_fica on public.kyc_cases;
create trigger trg_sync_kyc_case_to_lease_fica
  after update on public.kyc_cases
  for each row execute function public.sync_kyc_case_to_lease_fica();

create or replace function public.touch_kyc_cases_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Consent trigger — tenants can INSERT their own kyc_consents rows
-- (RLS above), but cannot UPDATE kyc_cases or INSERT kyc_audit_log
-- directly (by design — those are admin-only). This SECURITY DEFINER
-- trigger is the narrow, tightly-scoped exception: it logs the consent
-- event, and once all three required consent types have been accepted for
-- a case, flips kyc_cases.consent_given/consent_timestamp/status itself.
-- This is what lets kyc-start-check safely trust consent_given without
-- a tenant ever having write access to that column directly.
-- ---------------------------------------------------------------------------

create or replace function public.sync_kyc_consent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_all_accepted boolean;
begin
  insert into public.kyc_audit_log (kyc_case_id, user_id, event_type, event_description, metadata)
  values (
    new.kyc_case_id, new.tenant_id,
    case when new.accepted then 'CONSENT_ACCEPTED' else 'CONSENT_DECLINED' end,
    format('%s consent %s (version %s).', new.consent_type, case when new.accepted then 'accepted' else 'declined' end, new.consent_version),
    jsonb_build_object('consent_type', new.consent_type, 'consent_version', new.consent_version)
  );

  if new.accepted then
    select bool_and(accepted) into v_all_accepted
    from (
      select distinct on (consent_type) consent_type, accepted
      from public.kyc_consents
      where kyc_case_id = new.kyc_case_id
        and consent_type in ('identity_verification','credit_background_screening','data_processing')
      order by consent_type, created_at desc
    ) latest_per_type
    having count(*) = 3;

    if coalesce(v_all_accepted, false) then
      update public.kyc_cases
      set consent_given = true, consent_timestamp = now(), status = 'consent_given'
      where id = new.kyc_case_id and status = 'pending_consent';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_kyc_consent on public.kyc_consents;
create trigger trg_sync_kyc_consent
  after insert on public.kyc_consents
  for each row execute function public.sync_kyc_consent();

drop trigger if exists trg_touch_kyc_cases_updated_at on public.kyc_cases;
create trigger trg_touch_kyc_cases_updated_at
  before update on public.kyc_cases
  for each row execute function public.touch_kyc_cases_updated_at();
