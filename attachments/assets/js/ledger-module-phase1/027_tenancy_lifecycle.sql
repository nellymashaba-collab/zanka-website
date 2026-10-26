-- ============================================================================
-- ZANKA — TENANCY LIFECYCLE
-- 027_tenancy_lifecycle.sql   (run after 024, 025, 026)
--
-- Closes the gaps between "tenant moves in" and "unit is let again":
--   1. Notices to vacate reach admin (inbox + email), with the Consumer
--      Protection Act 20-business-day minimum worked out automatically.
--   2. Deposits: where each deposit is held, interest, deductions WITH
--      receipts, refunds, and the Rental Housing Act refund deadline
--      (7 / 14 / 21 days) for every move-out.
--   3. End of tenancy as one case: notice → move-out inspection (last 3
--      days of the lease) → outcome → deposit settled → lease closed →
--      unit re-listed as a new vacancy.
--   4. A daily automation: CPA lease-expiry notice (40–80 business days),
--      month-to-month rollover, rent-escalation notices and application,
--      deadline reminders to admin, viewing reminders.
--   5. Arrears: list of overdue rent, reminders at day 3 and day 7, and a
--      letter of demand prepared at day 14 for admin to approve and send.
--   7. Viewings: admin opens viewing slots per listing; prospective
--      tenants book online (with pre-qualification) and get confirmation
--      and reminder emails.
--   8. Data for creating a tenant account straight from an accepted
--      application (the account itself is created by the Edge Function).
--
-- EMAILS go through one outbox, tenancy_notifications, sent by the Edge
-- Function `tenancy-automation` (same pattern as rental_notifications).
-- Every automatic email has a dedupe key, so nothing is ever sent twice
-- however often the daily job runs.
--
-- Business days follow South African public holidays (incl. Good Friday,
-- Family Day and the Sunday→Monday rule).
--
-- Safe to re-run. Requires is_admin() and the tables from 024/026.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. South African business days
-- ---------------------------------------------------------------------------

create or replace function public.za_easter_sunday(p_year integer)
returns date
language plpgsql
immutable
as $$
declare
  a int := p_year % 19; b int := p_year / 100; c int := p_year % 100;
  d int := b / 4; e int := b % 4; f int := (b + 8) / 25; g int := (b - f + 1) / 3;
  h int := (19 * a + b - d - g + 15) % 30; i int := c / 4; k int := c % 4;
  l int := (32 + 2 * e + 2 * i - h - k) % 7; m int := (a + 11 * h + 22 * l) / 451;
  mon int := (h + l - 7 * m + 114) / 31; dy int := ((h + l - 7 * m + 114) % 31) + 1;
begin
  return make_date(p_year, mon, dy);
end;
$$;

create or replace function public.za_is_public_holiday(p_day date)
returns boolean
language plpgsql
immutable
as $$
declare
  y int := extract(year from p_day)::int;
  easter date := public.za_easter_sunday(y);
  fixed date[] := array[
    make_date(y, 1, 1), make_date(y, 3, 21), make_date(y, 4, 27), make_date(y, 5, 1),
    make_date(y, 6, 16), make_date(y, 8, 9), make_date(y, 9, 24), make_date(y, 12, 16),
    make_date(y, 12, 25), make_date(y, 12, 26)];
  f date;
begin
  if p_day = easter - 2 or p_day = easter + 1 then return true; end if; -- Good Friday, Family Day
  foreach f in array fixed loop
    if p_day = f then return true; end if;
    -- Public Holidays Act: a holiday on a Sunday moves to the Monday.
    if extract(isodow from f) = 7 and p_day = f + 1 then return true; end if;
  end loop;
  return false;
end;
$$;

create or replace function public.za_is_business_day(p_day date)
returns boolean
language sql
immutable
as $$
  select extract(isodow from p_day) < 6 and not public.za_is_public_holiday(p_day);
$$;

-- The date that is p_days business days AFTER p_from (p_from itself not counted).
create or replace function public.za_add_business_days(p_from date, p_days integer)
returns date
language plpgsql
immutable
as $$
declare
  d date := p_from;
  n int := 0;
begin
  while n < p_days loop
    d := d + 1;
    if public.za_is_business_day(d) then n := n + 1; end if;
  end loop;
  return d;
end;
$$;

-- Business days after p_from, up to and including p_to (0 if p_to <= p_from).
create or replace function public.za_business_days_between(p_from date, p_to date)
returns integer
language sql
immutable
as $$
  select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') g
  where public.za_is_business_day(g::date);
$$;

grant execute on function public.za_easter_sunday(integer), public.za_is_public_holiday(date),
  public.za_is_business_day(date), public.za_add_business_days(date, integer),
  public.za_business_days_between(date, date) to anon, authenticated;

create or replace function public.za_today()
returns date
language sql
stable
as $$ select (now() at time zone 'Africa/Johannesburg')::date $$;


-- ---------------------------------------------------------------------------
-- 2. Settings
-- ---------------------------------------------------------------------------

alter table public.rental_recruitment_settings
  add column if not exists lease_automation_enabled boolean not null default true,
  add column if not exists arrears_reminder_1_days integer not null default 3,
  add column if not exists arrears_reminder_2_days integer not null default 7,
  add column if not exists arrears_demand_days integer not null default 14,
  add column if not exists demand_remedy_business_days integer not null default 20,
  -- Automatic arrears reminders only for rent due on/after this date, so
  -- switching this on never fires reminders about old, possibly stale,
  -- "Pending" payments. Older arrears still show in the arrears list.
  add column if not exists arrears_automation_start date not null default public.za_today();

alter table public.rental_recruitment_settings drop constraint if exists rrs_arrears_order;
alter table public.rental_recruitment_settings add constraint rrs_arrears_order
  check (arrears_reminder_1_days >= 1 and arrears_reminder_1_days < arrears_reminder_2_days and arrears_reminder_2_days < arrears_demand_days and demand_remedy_business_days between 5 and 60);


-- ---------------------------------------------------------------------------
-- 3. Email outbox for tenancy events
-- ---------------------------------------------------------------------------

create table if not exists public.tenancy_notifications (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'notice_received', 'ending_confirmed', 'move_out_inspection_scheduled', 'deposit_refund_statement', 'tenancy_closed',
    'lease_expiry_notice', 'lease_rolled_over', 'escalation_notice',
    'arrears_reminder', 'letter_of_demand',
    'viewing_booked', 'viewing_reminder', 'viewing_cancelled', 'viewing_followup',
    'tenant_account_created', 'admin_alert'
  )),
  dedupe_key text unique,
  lease_id bigint,
  notice_ref text,
  ending_id uuid,
  payment_ref text,
  escalation_ref text,
  letter_id uuid,
  booking_id uuid,
  application_id uuid,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  recipients jsonb,
  last_error text,
  requested_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz
);

create index if not exists tenancy_notifications_status_idx on public.tenancy_notifications (status, id);
create index if not exists tenancy_notifications_lease_idx on public.tenancy_notifications (lease_id);

alter table public.tenancy_notifications enable row level security;

drop policy if exists "Admins read tenancy_notifications" on public.tenancy_notifications;
create policy "Admins read tenancy_notifications" on public.tenancy_notifications for select using (is_admin());
drop policy if exists "Admins queue tenancy_notifications" on public.tenancy_notifications;
create policy "Admins queue tenancy_notifications" on public.tenancy_notifications
  for insert with check (is_admin() and status = 'pending' and recipients is null and dedupe_key is null);
drop policy if exists "Admins retry tenancy_notifications" on public.tenancy_notifications;
create policy "Admins retry tenancy_notifications" on public.tenancy_notifications
  for update using (is_admin() and status in ('failed', 'skipped')) with check (is_admin() and status = 'pending');

revoke all on public.tenancy_notifications from anon, authenticated;
grant select on public.tenancy_notifications to authenticated;
grant insert (event_type, lease_id, notice_ref, ending_id, payment_ref, escalation_ref, letter_id, booking_id, application_id, detail, status, requested_by)
  on public.tenancy_notifications to authenticated;
grant update (status, attempts, last_error) on public.tenancy_notifications to authenticated;

-- Internal helper: queue an email once (dedupe_key) — used by triggers and
-- the daily job. Returns true if a new email was queued.
create or replace function public.queue_tenancy_email(
  p_event text, p_dedupe text, p_lease_id bigint default null, p_detail jsonb default '{}'::jsonb,
  p_notice_ref text default null, p_ending_id uuid default null, p_payment_ref text default null,
  p_escalation_ref text default null, p_letter_id uuid default null, p_booking_id uuid default null,
  p_application_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.tenancy_notifications (event_type, dedupe_key, lease_id, detail, notice_ref, ending_id, payment_ref, escalation_ref, letter_id, booking_id, application_id)
  values (p_event, p_dedupe, p_lease_id, coalesce(p_detail, '{}'::jsonb), p_notice_ref, p_ending_id, p_payment_ref, p_escalation_ref, p_letter_id, p_booking_id, p_application_id)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.queue_tenancy_email(text, text, bigint, jsonb, text, uuid, text, text, uuid, uuid, uuid) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Notices from tenants (existing table, extended)
-- ---------------------------------------------------------------------------

alter table public.notices
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists lease_id bigint,
  add column if not exists move_out_date date,
  add column if not exists earliest_end_date date,
  add column if not exists short_notice boolean not null default false,
  add column if not exists status text not null default 'New',
  add column if not exists confirmed_end_date date,
  add column if not exists admin_note text,
  add column if not exists acknowledged_by uuid references public.profiles(id),
  add column if not exists acknowledged_at timestamptz,
  add column if not exists ending_id uuid;

alter table public.notices drop constraint if exists notices_status_check;
alter table public.notices add constraint notices_status_check check (status in ('New', 'Acknowledged', 'Closed', 'Withdrawn'));

alter table public.notices enable row level security;
drop policy if exists "Admins manage notices" on public.notices;
create policy "Admins manage notices" on public.notices for all using (is_admin()) with check (is_admin());
drop policy if exists "Tenants add own notices" on public.notices;
create policy "Tenants add own notices" on public.notices for insert with check (tenant_id = auth.uid());
drop policy if exists "Tenants read own notices" on public.notices;
create policy "Tenants read own notices" on public.notices for select using (tenant_id = auth.uid());

-- Fills in the lease and the legal earliest end date; tenants can't set
-- admin-only fields.
create or replace function public.notices_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  l record;
begin
  if not public.is_admin() then
    new.status := 'New';
    new.confirmed_end_date := null; new.admin_note := null;
    new.acknowledged_by := null; new.acknowledged_at := null; new.ending_id := null;
    new.lease_id := null; -- always resolved below, never trusted from the browser
  end if;
  new.created_at := coalesce(new.created_at, now());

  if new.lease_id is null then
    select id into new.lease_id from public.leases
     where tenant_id = new.tenant_id and status in ('Active', 'Active_Month_to_Month', 'Renewal_Due', 'Fully Signed')
     order by start_date desc nulls last limit 1;
  end if;

  if new.type = 'Notice to Vacate' then
    select * into l from public.leases where id = new.lease_id;
    -- CPA s14: a fixed-term tenant may cancel on 20 business days' written
    -- notice; a month-to-month tenancy needs one calendar month.
    new.earliest_end_date := case
      when l.status = 'Active_Month_to_Month' then ((new.created_at at time zone 'Africa/Johannesburg')::date + interval '1 month')::date
      else public.za_add_business_days((new.created_at at time zone 'Africa/Johannesburg')::date, 20) end;
    new.move_out_date := coalesce(new.move_out_date, new.earliest_end_date);
    new.short_notice := new.move_out_date < new.earliest_end_date;
  end if;
  return new;
end;
$$;

drop trigger if exists notices_before_insert on public.notices;
create trigger notices_before_insert before insert on public.notices
  for each row execute function public.notices_before_insert();

create or replace function public.notices_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.queue_tenancy_email('notice_received', 'notice:' || new.id::text, new.lease_id, '{}'::jsonb, new.id::text);
  return new;
end;
$$;

drop trigger if exists notices_after_insert on public.notices;
create trigger notices_after_insert after insert on public.notices
  for each row execute function public.notices_after_insert();


-- ---------------------------------------------------------------------------
-- 5. End of tenancy
-- ---------------------------------------------------------------------------

create table if not exists public.tenancy_endings (
  id uuid primary key default gen_random_uuid(),
  lease_id bigint not null references public.leases(id),
  source text not null check (source in ('tenant_notice', 'not_renewing', 'mutual')),
  notice_ref text,
  end_date date not null,
  status text not null default 'Open' check (status in ('Open', 'Inspected', 'Deposit settled', 'Closed', 'Cancelled')),
  inspection_at timestamptz,
  inspection_outcome text check (inspection_outcome is null or inspection_outcome in ('no_damage', 'damage', 'tenant_absent')),
  outcome_recorded_on date,
  restoration_completed_on date,
  refund_due_by date,
  refund_paid_on date,
  relisted_vacancy_id uuid references public.rental_vacancies(id),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists tenancy_endings_one_open_per_lease
  on public.tenancy_endings (lease_id) where status not in ('Closed', 'Cancelled');

alter table public.tenancy_endings enable row level security;
drop policy if exists "Admins manage tenancy_endings" on public.tenancy_endings;
create policy "Admins manage tenancy_endings" on public.tenancy_endings for all using (is_admin()) with check (is_admin());
drop policy if exists "Tenants read own tenancy_endings" on public.tenancy_endings;
create policy "Tenants read own tenancy_endings" on public.tenancy_endings for select
  using (exists (select 1 from public.leases l where l.id = lease_id and l.tenant_id = auth.uid()));
revoke all on public.tenancy_endings from anon;

-- Rental Housing Act refund deadline, worked out from the inspection outcome:
--   no damage ........ 7 days after the lease ends
--   damage ........... 14 days after the property is restored
--   tenant absent .... 21 days after the lease ends (landlord inspects alone)
create or replace function public.tenancy_endings_before_write()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.refund_due_by := case new.inspection_outcome
    when 'no_damage' then new.end_date + 7
    when 'tenant_absent' then new.end_date + 21
    when 'damage' then case when new.restoration_completed_on is null then null else new.restoration_completed_on + 14 end
    else null end;
  if new.inspection_outcome is not null and new.status = 'Open' then new.status := 'Inspected'; end if;
  if new.refund_paid_on is not null and new.status in ('Open', 'Inspected') then new.status := 'Deposit settled'; end if;
  if new.status = 'Closed' and new.closed_at is null then new.closed_at := now(); end if;
  return new;
end;
$$;

drop trigger if exists tenancy_endings_before_write on public.tenancy_endings;
create trigger tenancy_endings_before_write before insert or update on public.tenancy_endings
  for each row execute function public.tenancy_endings_before_write();

create or replace function public.tenancy_endings_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.queue_tenancy_email('ending_confirmed', 'ending:' || new.id, new.lease_id, jsonb_build_object('source', new.source), new.notice_ref, new.id);
    return new;
  end if;

  if new.inspection_at is not null and new.inspection_at is distinct from old.inspection_at then
    perform public.queue_tenancy_email('move_out_inspection_scheduled', 'inspection:' || new.id || ':' || new.inspection_at::text, new.lease_id, '{}'::jsonb, null, new.id);
  end if;

  if new.status = 'Closed' and old.status <> 'Closed' then
    update public.leases set status = 'Expired' where id = new.lease_id and status <> 'Expired';
    insert into public.lease_audit_logs (lease_id, user_id, action_performed, previous_state, new_state)
    values (new.lease_id, auth.uid(), 'Tenancy closed after move-out', null, 'Expired');
    update public.properties p set occupancy_status = 'Vacant'
     where p.id = (select property_id from public.leases where id = new.lease_id)
       and not exists (select 1 from public.leases o where o.property_id = p.id and o.id <> new.lease_id
                         and o.status in ('Active', 'Active_Month_to_Month', 'Fully Signed', 'Pending Signature'));
    perform public.queue_tenancy_email('tenancy_closed', 'closed:' || new.id, new.lease_id, '{}'::jsonb, null, new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists tenancy_endings_after_write on public.tenancy_endings;
create trigger tenancy_endings_after_write after insert or update on public.tenancy_endings
  for each row execute function public.tenancy_endings_after_write();

-- Admin: accept a tenant's notice and open the move-out case.
create or replace function public.acknowledge_notice(p_notice_ref text, p_end_date date, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  n record;
  v_ending uuid;
begin
  if not public.is_admin() then raise exception 'Only admins can acknowledge notices.'; end if;
  execute 'select id::text as ref, lease_id, type, status from public.notices where id::text = $1' into n using p_notice_ref;
  if n.ref is null then raise exception 'Notice not found.'; end if;
  if n.status <> 'New' then raise exception 'This notice has already been handled.'; end if;
  if n.type = 'Notice to Vacate' then
    if n.lease_id is null then raise exception 'This notice is not linked to a lease. Link the tenant to a lease first.'; end if;
    if p_end_date is null then raise exception 'Confirm the date the tenancy ends.'; end if;
    insert into public.tenancy_endings (lease_id, source, notice_ref, end_date, created_by)
    values (n.lease_id, 'tenant_notice', n.ref, p_end_date, auth.uid())
    returning id into v_ending;
  end if;
  execute 'update public.notices set status = ''Acknowledged'', confirmed_end_date = $2, admin_note = $3, acknowledged_by = $4, acknowledged_at = now(), ending_id = $5 where id::text = $1'
    using p_notice_ref, p_end_date, p_note, auth.uid(), v_ending;
  return v_ending;
end;
$$;
revoke all on function public.acknowledge_notice(text, date, text) from public, anon;
grant execute on function public.acknowledge_notice(text, date, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. Deposits
-- ---------------------------------------------------------------------------

create table if not exists public.lease_deposits (
  lease_id bigint primary key references public.leases(id) on delete cascade,
  bank_name text,
  account_name text,
  account_reference text,
  interest_rate_annual numeric(5, 2) check (interest_rate_annual is null or interest_rate_annual between 0 and 30),
  notes text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.deposit_movements (
  id uuid primary key default gen_random_uuid(),
  lease_id bigint not null references public.leases(id) on delete cascade,
  movement_type text not null check (movement_type in ('received', 'interest', 'deduction', 'refund')),
  amount numeric(12, 2) not null check (amount > 0),
  movement_date date not null default public.za_today(),
  description text,
  receipt_path text,
  ending_id uuid references public.tenancy_endings(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  -- Rental Housing Act: deductions must be justified, and the tenant may
  -- inspect the receipts. No receipt, no deduction.
  constraint deposit_deduction_needs_receipt check (movement_type <> 'deduction' or (receipt_path is not null and coalesce(trim(description), '') <> ''))
);
create index if not exists deposit_movements_lease_idx on public.deposit_movements (lease_id, movement_date);

alter table public.lease_deposits enable row level security;
alter table public.deposit_movements enable row level security;
drop policy if exists "Admins manage lease_deposits" on public.lease_deposits;
create policy "Admins manage lease_deposits" on public.lease_deposits for all using (is_admin()) with check (is_admin());
drop policy if exists "Admins manage deposit_movements" on public.deposit_movements;
create policy "Admins manage deposit_movements" on public.deposit_movements for all using (is_admin()) with check (is_admin());
drop policy if exists "Tenants read own deposit_movements" on public.deposit_movements;
create policy "Tenants read own deposit_movements" on public.deposit_movements for select
  using (exists (select 1 from public.leases l where l.id = lease_id and l.tenant_id = auth.uid()));
revoke all on public.lease_deposits, public.deposit_movements from anon;

-- Current deposit position for a lease (held = received + interest − deductions − refunds).
-- Security INVOKER on purpose: the deposit_movements RLS policies decide
-- who sees what (admin: all; tenant: own lease; anyone else: nothing).
create or replace function public.deposit_position(p_lease_id bigint)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'received', coalesce(sum(amount) filter (where movement_type = 'received'), 0),
    'interest', coalesce(sum(amount) filter (where movement_type = 'interest'), 0),
    'deductions', coalesce(sum(amount) filter (where movement_type = 'deduction'), 0),
    'refunded', coalesce(sum(amount) filter (where movement_type = 'refund'), 0),
    'held', coalesce(sum(case when movement_type in ('received', 'interest') then amount else -amount end), 0),
    'deduction_lines', coalesce(jsonb_agg(jsonb_build_object('date', movement_date, 'description', description, 'amount', amount) order by movement_date)
                        filter (where movement_type = 'deduction'), '[]'::jsonb),
    'first_received', min(movement_date) filter (where movement_type = 'received'))
  from public.deposit_movements
  where lease_id = p_lease_id;
$$;
grant execute on function public.deposit_position(bigint) to authenticated;

-- Private bucket for deduction receipts (admin only; shared with tenants on request).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'deposit-receipts', 'deposit-receipts', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
where not exists (select 1 from storage.buckets where id = 'deposit-receipts');
drop policy if exists "Admins manage deposit-receipts" on storage.objects;
create policy "Admins manage deposit-receipts" on storage.objects
  for all using (bucket_id = 'deposit-receipts' and is_admin()) with check (bucket_id = 'deposit-receipts' and is_admin());


-- ---------------------------------------------------------------------------
-- 7. Arrears: letters of demand (prepared automatically, sent by admin)
-- ---------------------------------------------------------------------------

create table if not exists public.arrears_letters (
  id uuid primary key default gen_random_uuid(),
  payment_ref text not null,
  tenant_id uuid references public.profiles(id),
  lease_id bigint references public.leases(id),
  amount numeric(12, 2) not null,
  due_date date not null,
  status text not null default 'Draft' check (status in ('Draft', 'Sent', 'Cancelled')),
  remedy_by date,
  admin_note text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by uuid references public.profiles(id)
);
create unique index if not exists arrears_letters_one_live_per_payment on public.arrears_letters (payment_ref) where status <> 'Cancelled';

alter table public.arrears_letters enable row level security;
drop policy if exists "Admins manage arrears_letters" on public.arrears_letters;
create policy "Admins manage arrears_letters" on public.arrears_letters for all using (is_admin()) with check (is_admin());
revoke all on public.arrears_letters from anon;

create or replace function public.arrears_letters_before_write()
returns trigger
language plpgsql
as $$
declare
  v_days int;
begin
  if new.status = 'Sent' and (tg_op = 'INSERT' or old.status <> 'Sent') then
    select demand_remedy_business_days into v_days from public.rental_recruitment_settings order by updated_at desc limit 1;
    -- CPA s14: the tenant must be given 20 business days to remedy a breach.
    new.remedy_by := public.za_add_business_days(public.za_today(), coalesce(v_days, 20));
    new.sent_at := now();
    new.sent_by := coalesce(new.sent_by, auth.uid());
  end if;
  return new;
end;
$$;
drop trigger if exists arrears_letters_before_write on public.arrears_letters;
create trigger arrears_letters_before_write before insert or update on public.arrears_letters
  for each row execute function public.arrears_letters_before_write();

create or replace function public.arrears_letters_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'Sent' and (tg_op = 'INSERT' or old.status <> 'Sent') then
    perform public.queue_tenancy_email('letter_of_demand', 'demand:' || new.id, new.lease_id, '{}'::jsonb, null, null, new.payment_ref, null, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists arrears_letters_after_write on public.arrears_letters;
create trigger arrears_letters_after_write after insert or update on public.arrears_letters
  for each row execute function public.arrears_letters_after_write();

-- Overdue rent, for the admin arrears list.
create or replace function public.arrears_overview()
returns table (payment_ref text, tenant_id uuid, tenant_name text, tenant_email text, lease_id bigint, property_address text,
               amount numeric, due_date date, days_overdue integer, reminders_sent integer, letter_status text, automated boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_start date;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  select arrears_automation_start into v_start from public.rental_recruitment_settings order by updated_at desc limit 1;
  return query
  select p.id::text, p.tenant_id, pr.full_name, pr.email, l.id, prop.address,
         p.amount::numeric, p.due_date::date, (public.za_today() - p.due_date::date)::int,
         (select count(*)::int from public.tenancy_notifications n where n.payment_ref = p.id::text and n.event_type = 'arrears_reminder' and n.status = 'sent'),
         (select al.status from public.arrears_letters al where al.payment_ref = p.id::text and al.status <> 'Cancelled' limit 1),
         p.due_date::date >= coalesce(v_start, public.za_today())
  from public.payments p
  left join public.profiles pr on pr.id = p.tenant_id
  left join lateral (select ls.id, ls.property_id from public.leases ls where ls.tenant_id = p.tenant_id
                     order by (ls.status in ('Active', 'Active_Month_to_Month')) desc, ls.start_date desc nulls last limit 1) l on true
  left join public.properties prop on prop.id = l.property_id
  where p.status = 'Pending' and p.due_date::date < public.za_today()
  order by p.due_date;
end;
$$;
grant execute on function public.arrears_overview() to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Viewings
-- ---------------------------------------------------------------------------

create table if not exists public.rental_viewing_slots (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.rental_vacancies(id) on delete cascade,
  starts_at timestamptz not null,
  duration_minutes integer not null default 30 check (duration_minutes between 10 and 240),
  capacity integer not null default 6 check (capacity between 1 and 50),
  meeting_point text,
  status text not null default 'Open' check (status in ('Open', 'Cancelled')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists rental_viewing_slots_vacancy_idx on public.rental_viewing_slots (vacancy_id, starts_at);

create table if not exists public.rental_viewing_bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('VW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))),
  slot_id uuid not null references public.rental_viewing_slots(id) on delete cascade,
  vacancy_id uuid not null references public.rental_vacancies(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text not null,
  occupants integer check (occupants is null or occupants between 1 and 20),
  gross_monthly_income numeric(12, 2),
  move_in_date date,
  employment_type text,
  meets_income boolean,
  status text not null default 'Booked' check (status in ('Booked', 'Cancelled', 'Attended', 'No-show')),
  cancel_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);
create unique index if not exists rental_viewing_bookings_one_per_slot on public.rental_viewing_bookings (slot_id, lower(email)) where status = 'Booked';

alter table public.rental_viewing_slots enable row level security;
alter table public.rental_viewing_bookings enable row level security;
drop policy if exists "Admins manage rental_viewing_slots" on public.rental_viewing_slots;
create policy "Admins manage rental_viewing_slots" on public.rental_viewing_slots for all using (is_admin()) with check (is_admin());
drop policy if exists "Admins manage rental_viewing_bookings" on public.rental_viewing_bookings;
create policy "Admins manage rental_viewing_bookings" on public.rental_viewing_bookings for all using (is_admin()) with check (is_admin());
revoke all on public.rental_viewing_slots, public.rental_viewing_bookings from anon;
revoke update (cancel_token) on public.rental_viewing_bookings from authenticated;

create or replace function public.list_viewing_slots(p_vacancy_id uuid)
returns table (id uuid, starts_at timestamptz, duration_minutes integer, meeting_point text, spaces_left integer)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.starts_at, s.duration_minutes, s.meeting_point,
         (s.capacity - (select count(*) from public.rental_viewing_bookings b where b.slot_id = s.id and b.status = 'Booked'))::int
  from public.rental_viewing_slots s
  join public.rental_vacancies v on v.id = s.vacancy_id
  where s.vacancy_id = p_vacancy_id and s.status = 'Open' and v.status = 'Open'
    and s.starts_at > now() + interval '1 hour'
  order by s.starts_at;
$$;
revoke all on function public.list_viewing_slots(uuid) from public;
grant execute on function public.list_viewing_slots(uuid) to anon, authenticated;

create or replace function public.book_viewing(p_slot_id uuid, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_min numeric;
  v_email text := lower(trim(coalesce(p_details->>'email', '')));
  v_income numeric := nullif(p_details->>'gross_monthly_income', '')::numeric;
  v_booked int;
  b record;
begin
  select sl.*, v.status as vacancy_status, v.monthly_rent, v.max_occupants into s
    from public.rental_viewing_slots sl join public.rental_vacancies v on v.id = sl.vacancy_id
   where sl.id = p_slot_id for update of sl;
  if s.id is null or s.status <> 'Open' or s.vacancy_status <> 'Open' or s.starts_at <= now() + interval '1 hour' then
    raise exception 'This viewing time is no longer available. Please pick another.' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_details->>'full_name'), '') = '' or coalesce(trim(p_details->>'phone'), '') = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please give your name, a valid email address and a phone number.' using errcode = 'P0001';
  end if;
  select count(*) into v_booked from public.rental_viewing_bookings where slot_id = p_slot_id and status = 'Booked';
  if v_booked >= s.capacity then
    raise exception 'This viewing time is full. Please pick another.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rental_viewing_bookings where slot_id = p_slot_id and lower(email) = v_email and status = 'Booked') then
    raise exception 'You are already booked for this viewing.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.rental_viewing_bookings where lower(email) = v_email and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Too many bookings from this email today.' using errcode = 'P0001';
  end if;

  select ceil(s.monthly_rent / affordability_knockout_max) into v_min from public.rental_recruitment_settings order by updated_at desc limit 1;

  insert into public.rental_viewing_bookings (slot_id, vacancy_id, full_name, email, phone, occupants, gross_monthly_income, move_in_date, employment_type, meets_income)
  values (p_slot_id, s.vacancy_id, left(trim(p_details->>'full_name'), 200), left(v_email, 200), left(trim(p_details->>'phone'), 40),
          nullif(p_details->>'occupants', '')::int, v_income, nullif(p_details->>'move_in_date', '')::date,
          nullif(p_details->>'employment_type', ''), case when v_income is null then null else v_income >= v_min end)
  returning * into b;

  perform public.queue_tenancy_email('viewing_booked', 'vw_booked:' || b.id, null, '{}'::jsonb, null, null, null, null, null, b.id);
  return jsonb_build_object('reference', b.reference, 'booking_id', b.id, 'cancel_token', b.cancel_token, 'meets_income', b.meets_income, 'min_gross_income', v_min);
end;
$$;
revoke all on function public.book_viewing(uuid, jsonb) from public;
grant execute on function public.book_viewing(uuid, jsonb) to anon, authenticated;

create or replace function public.cancel_viewing_booking(p_booking_id uuid, p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
begin
  update public.rental_viewing_bookings set status = 'Cancelled', cancelled_at = now()
   where id = p_booking_id and cancel_token = p_token and status = 'Booked'
  returning * into b;
  if b.id is null then
    raise exception 'This booking could not be found, or it was already cancelled.' using errcode = 'P0001';
  end if;
  perform public.queue_tenancy_email('viewing_cancelled', 'vw_cancel:' || b.id, null, jsonb_build_object('by', 'applicant'), null, null, null, null, null, b.id);
  return jsonb_build_object('reference', b.reference, 'status', 'Cancelled');
end;
$$;
revoke all on function public.cancel_viewing_booking(uuid, uuid) from public;
grant execute on function public.cancel_viewing_booking(uuid, uuid) to anon, authenticated;

-- Admin changes: cancelling a slot cancels its bookings (and tells them);
-- marking someone Attended sends the "here's how to apply" follow-up.
create or replace function public.rental_viewing_slots_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
begin
  if new.status = 'Cancelled' and old.status <> 'Cancelled' then
    for b in update public.rental_viewing_bookings set status = 'Cancelled', cancelled_at = now()
              where slot_id = new.id and status = 'Booked' returning * loop
      perform public.queue_tenancy_email('viewing_cancelled', 'vw_cancel:' || b.id, null, jsonb_build_object('by', 'zanka'), null, null, null, null, null, b.id);
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists rental_viewing_slots_after_update on public.rental_viewing_slots;
create trigger rental_viewing_slots_after_update after update of status on public.rental_viewing_slots
  for each row execute function public.rental_viewing_slots_after_update();

create or replace function public.rental_viewing_bookings_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'Attended' and old.status <> 'Attended' then
    perform public.queue_tenancy_email('viewing_followup', 'vw_follow:' || new.id, null, '{}'::jsonb, null, null, null, null, null, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists rental_viewing_bookings_after_update on public.rental_viewing_bookings;
create trigger rental_viewing_bookings_after_update after update of status on public.rental_viewing_bookings
  for each row execute function public.rental_viewing_bookings_after_update();


-- ---------------------------------------------------------------------------
-- 9. The daily automation
-- ---------------------------------------------------------------------------

create table if not exists public.tenancy_automation_runs (
  id bigint generated always as identity primary key,
  run_for date not null,
  ran_at timestamptz not null default now(),
  summary jsonb not null
);
alter table public.tenancy_automation_runs enable row level security;
drop policy if exists "Admins read tenancy_automation_runs" on public.tenancy_automation_runs;
create policy "Admins read tenancy_automation_runs" on public.tenancy_automation_runs for select using (is_admin());
revoke all on public.tenancy_automation_runs from anon;

create or replace function public.run_tenancy_automation(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := coalesce(p_today, public.za_today());
  s record;
  l record;
  e record;
  p record;
  en record;
  bk record;
  v_bd int;
  v_days int;
  v_stage text;
  v_level int;
  v_new_letters int := 0;
  out jsonb := jsonb_build_object('expiry_notices', 0, 'rollovers', 0, 'renewals_overdue', 0, 'escalation_notices', 0,
                                  'escalations_applied', 0, 'arrears_reminders', 0, 'demand_drafts', 0, 'admin_alerts', 0, 'viewing_reminders', 0);
  bump text;
begin
  select * into s from public.rental_recruitment_settings order by updated_at desc limit 1;
  if s.id is not null and not s.lease_automation_enabled then
    insert into public.tenancy_automation_runs (run_for, summary) values (v_today, jsonb_build_object('skipped', 'Lease automation is switched off'));
    return jsonb_build_object('skipped', 'Lease automation is switched off');
  end if;

  -- (a) CPA s14: tell the tenant 40–80 business days before a fixed term ends.
  for l in select * from public.leases
            where status = 'Active' and end_date is not null and end_date >= v_today
              and not exists (select 1 from public.lease_renewals r where r.lease_id = leases.id)
              and not exists (select 1 from public.tenancy_endings t where t.lease_id = leases.id and t.status not in ('Cancelled'))
  loop
    v_bd := public.za_business_days_between(v_today, l.end_date);
    if v_bd <= 80 then
      if public.queue_tenancy_email('lease_expiry_notice', 'expiry:' || l.id || ':' || l.end_date, l.id,
           jsonb_build_object('business_days_left', v_bd, 'late', v_bd < 40)) then
        out := jsonb_set(out, '{expiry_notices}', to_jsonb((out->>'expiry_notices')::int + 1));
        if v_bd < 40 then
          perform public.queue_tenancy_email('admin_alert', 'expiry_late:' || l.id || ':' || l.end_date, l.id,
            jsonb_build_object('kind', 'expiry_notice_late', 'business_days_left', v_bd, 'end_date', l.end_date));
        end if;
      end if;
    end if;
  end loop;

  -- (b) Fixed term over and nothing decided: the lease continues month to month (CPA).
  for l in select * from public.leases where status = 'Active' and end_date is not null and end_date < v_today loop
    if exists (select 1 from public.tenancy_endings t where t.lease_id = l.id and t.status not in ('Cancelled', 'Closed')) then
      continue;
    elsif exists (select 1 from public.lease_renewals r where r.lease_id = l.id and r.renewal_type = 'Renew' and r.new_lease_id is null) then
      if public.queue_tenancy_email('admin_alert', 'renewal_overdue:' || l.id || ':' || l.end_date, l.id,
           jsonb_build_object('kind', 'renewal_overdue', 'end_date', l.end_date)) then
        out := jsonb_set(out, '{renewals_overdue}', to_jsonb((out->>'renewals_overdue')::int + 1));
      end if;
    elsif exists (select 1 from public.lease_renewals r where r.lease_id = l.id) then
      continue; -- a decision exists (renewed into a new lease, or ending handled elsewhere)
    else
      update public.leases set status = 'Active_Month_to_Month' where id = l.id;
      insert into public.lease_audit_logs (lease_id, user_id, action_performed, previous_state, new_state)
      values (l.id, null, 'Fixed term ended with no renewal decision: continues month to month (automatic)', 'Active', 'Active_Month_to_Month');
      perform public.queue_tenancy_email('lease_rolled_over', 'rollover:' || l.id || ':' || l.end_date, l.id, jsonb_build_object('end_date', l.end_date));
      out := jsonb_set(out, '{rollovers}', to_jsonb((out->>'rollovers')::int + 1));
    end if;
  end loop;

  -- (c) Rent escalations: notices at 90 / 60 / 30 days, then apply on the date.
  for e in select x.* from public.lease_escalations x join public.leases ls on ls.id = x.lease_id
            where coalesce(x.applied, false) = false and ls.status in ('Active', 'Active_Month_to_Month')
  loop
    v_days := e.effective_date - v_today;
    v_stage := null;
    if v_days <= 0 then
      update public.leases set monthly_rent = e.new_rental_amount where id = e.lease_id;
      update public.lease_escalations set applied = true, applied_at = now(), notification_90_sent = true,
             notification_60_sent = true, notification_30_sent = true where id = e.id;
      insert into public.lease_audit_logs (lease_id, user_id, action_performed, previous_state, new_state)
      values (e.lease_id, null, 'Rent escalation applied (automatic)', e.previous_rental_amount::text, e.new_rental_amount::text);
      v_stage := 'effective';
      out := jsonb_set(out, '{escalations_applied}', to_jsonb((out->>'escalations_applied')::int + 1));
    elsif v_days <= 30 and not coalesce(e.notification_30_sent, false) then
      v_stage := '30_day';
      update public.lease_escalations set notification_30_sent = true, notification_60_sent = true, notification_90_sent = true where id = e.id;
    elsif v_days <= 60 and not coalesce(e.notification_60_sent, false) then
      v_stage := '60_day';
      update public.lease_escalations set notification_60_sent = true, notification_90_sent = true where id = e.id;
    elsif v_days <= 90 and not coalesce(e.notification_90_sent, false) then
      v_stage := '90_day';
      update public.lease_escalations set notification_90_sent = true where id = e.id;
    end if;
    if v_stage is not null and public.queue_tenancy_email('escalation_notice', 'escalation:' || e.id || ':' || v_stage, e.lease_id,
         jsonb_build_object('stage', v_stage), null, null, null, e.id::text) then
      out := jsonb_set(out, '{escalation_notices}', to_jsonb((out->>'escalation_notices')::int + 1));
    end if;
  end loop;

  -- (d) Arrears: reminders, then a letter of demand prepared for admin.
  for p in select * from public.payments where status = 'Pending' and due_date is not null and due_date::date < v_today
            and due_date::date >= coalesce(s.arrears_automation_start, v_today) loop
    v_days := v_today - p.due_date::date;
    v_level := case when v_days >= coalesce(s.arrears_reminder_2_days, 7) then 2 when v_days >= coalesce(s.arrears_reminder_1_days, 3) then 1 else 0 end;
    if v_level > 0 and public.queue_tenancy_email('arrears_reminder', 'arrears:' || p.id || ':L' || v_level, null,
         jsonb_build_object('level', v_level, 'days_overdue', v_days), null, null, p.id::text) then
      out := jsonb_set(out, '{arrears_reminders}', to_jsonb((out->>'arrears_reminders')::int + 1));
    end if;
    if v_days >= coalesce(s.arrears_demand_days, 14)
       and not exists (select 1 from public.arrears_letters al where al.payment_ref = p.id::text and al.status <> 'Cancelled') then
      insert into public.arrears_letters (payment_ref, tenant_id, lease_id, amount, due_date)
      values (p.id::text, p.tenant_id,
              (select ls.id from public.leases ls where ls.tenant_id = p.tenant_id order by (ls.status in ('Active', 'Active_Month_to_Month')) desc, ls.start_date desc nulls last limit 1),
              p.amount, p.due_date::date);
      v_new_letters := v_new_letters + 1;
    end if;
  end loop;
  if v_new_letters > 0 then
    out := jsonb_set(out, '{demand_drafts}', to_jsonb(v_new_letters));
    perform public.queue_tenancy_email('admin_alert', 'demand_drafts:' || v_today, null, jsonb_build_object('kind', 'demand_drafts', 'count', v_new_letters));
  end if;

  -- (e) Move-out deadlines for admin.
  for en in select * from public.tenancy_endings where status not in ('Closed', 'Cancelled') loop
    if en.inspection_at is null and en.end_date - v_today <= 5 then
      if public.queue_tenancy_email('admin_alert', 'insp_unscheduled:' || en.id, en.lease_id,
           jsonb_build_object('kind', 'inspection_not_scheduled', 'end_date', en.end_date), null, en.id) then
        out := jsonb_set(out, '{admin_alerts}', to_jsonb((out->>'admin_alerts')::int + 1));
      end if;
    end if;
    if en.refund_due_by is not null and en.refund_paid_on is null then
      if en.refund_due_by >= v_today and en.refund_due_by - v_today <= 2 then
        bump := 'refund_due_soon:' || en.id || ':' || en.refund_due_by;
        if public.queue_tenancy_email('admin_alert', bump, en.lease_id, jsonb_build_object('kind', 'refund_due_soon', 'refund_due_by', en.refund_due_by), null, en.id) then
          out := jsonb_set(out, '{admin_alerts}', to_jsonb((out->>'admin_alerts')::int + 1));
        end if;
      elsif en.refund_due_by < v_today then
        bump := 'refund_overdue:' || en.id || ':' || ((v_today - en.refund_due_by) / 7);
        if public.queue_tenancy_email('admin_alert', bump, en.lease_id, jsonb_build_object('kind', 'refund_overdue', 'refund_due_by', en.refund_due_by), null, en.id) then
          out := jsonb_set(out, '{admin_alerts}', to_jsonb((out->>'admin_alerts')::int + 1));
        end if;
      end if;
    end if;
  end loop;

  -- (f) Viewing reminders the day before.
  for bk in select b.* from public.rental_viewing_bookings b join public.rental_viewing_slots sl on sl.id = b.slot_id
             where b.status = 'Booked' and sl.status = 'Open' and (sl.starts_at at time zone 'Africa/Johannesburg')::date = v_today + 1 loop
    if public.queue_tenancy_email('viewing_reminder', 'vw_rem:' || bk.id, null, '{}'::jsonb, null, null, null, null, null, bk.id) then
      out := jsonb_set(out, '{viewing_reminders}', to_jsonb((out->>'viewing_reminders')::int + 1));
    end if;
  end loop;

  insert into public.tenancy_automation_runs (run_for, summary) values (v_today, out);
  return out;
end;
$$;
revoke all on function public.run_tenancy_automation(date) from public, anon, authenticated;
grant execute on function public.run_tenancy_automation(date) to service_role;


-- ---------------------------------------------------------------------------
-- 10. Sender functions (service role only)
-- ---------------------------------------------------------------------------

create or replace function public.tenancy_notification_context(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n record; s record; l record; t record; o record; prop record; nt record; en record; esc record; pay record;
  lt record; bk record; sl record; vac record;
  v_owner uuid; v_lease_id bigint;
begin
  select * into n from public.tenancy_notifications where id = p_id;
  select * into s from public.rental_recruitment_settings order by updated_at desc limit 1;

  execute 'select id::text as ref, type, message, move_out_date, earliest_end_date, short_notice, created_at, confirmed_end_date, lease_id, tenant_id from public.notices where id::text = $1'
    into nt using n.notice_ref;
  select * into en from public.tenancy_endings where id = n.ending_id;
  select * into esc from public.lease_escalations where id::text = n.escalation_ref;
  execute 'select id::text as ref, tenant_id, amount, due_date::date as due_date, status from public.payments where id::text = $1' into pay using n.payment_ref;
  select * into lt from public.arrears_letters where id = n.letter_id;
  select * into bk from public.rental_viewing_bookings where id = n.booking_id;
  select * into sl from public.rental_viewing_slots where id = bk.slot_id;
  select * into vac from public.rental_vacancies where id = bk.vacancy_id;

  v_lease_id := coalesce(n.lease_id, en.lease_id, nt.lease_id, esc.lease_id, lt.lease_id);
  if v_lease_id is null and pay.tenant_id is not null then
    select ls.id into v_lease_id from public.leases ls where ls.tenant_id = pay.tenant_id
     order by (ls.status in ('Active', 'Active_Month_to_Month')) desc, ls.start_date desc nulls last limit 1;
  end if;
  select * into l from public.leases where id = v_lease_id;
  select full_name, email into t from public.profiles where id = coalesce(l.tenant_id, nt.tenant_id, pay.tenant_id, lt.tenant_id);
  select * into prop from public.properties where id = l.property_id;
  v_owner := prop.owner_id;
  if v_owner is null and prop.id is not null then
    begin
      execute 'select public.get_effective_owner_id($1)' into v_owner using prop.id;
    exception when others then v_owner := null;
    end;
  end if;
  select full_name, email into o from public.profiles where id = v_owner;

  return jsonb_build_object(
    'admin_email', coalesce(s.notification_admin_email, 'admin@zankagroup.co.za'),
    'tenant', case when t.email is null then null else jsonb_build_object('name', t.full_name, 'email', t.email) end,
    'owner', case when o.email is null then null else jsonb_build_object('name', o.full_name, 'email', o.email) end,
    'lease', case when l.id is null then null else jsonb_build_object('id', l.id, 'status', l.status, 'start_date', l.start_date, 'end_date', l.end_date,
               'monthly_rent', l.monthly_rent, 'deposit_required', l.deposit_required, 'lease_number', l.lease_number) end,
    'property_address', prop.address,
    'notice', case when nt.ref is null then null else jsonb_build_object('type', nt.type, 'message', nt.message, 'move_out_date', nt.move_out_date,
                'earliest_end_date', nt.earliest_end_date, 'short_notice', nt.short_notice, 'submitted_at', nt.created_at, 'confirmed_end_date', nt.confirmed_end_date) end,
    'ending', case when en.id is null then null else jsonb_build_object('id', en.id, 'source', en.source, 'end_date', en.end_date, 'inspection_at', en.inspection_at,
                'outcome', en.inspection_outcome, 'restoration_completed_on', en.restoration_completed_on, 'refund_due_by', en.refund_due_by,
                'refund_paid_on', en.refund_paid_on, 'relisted', en.relisted_vacancy_id is not null) end,
    'deposit', case when l.id is null then null else public.deposit_position(l.id) end,
    'escalation', case when esc.id is null then null else jsonb_build_object('effective_date', esc.effective_date, 'percentage', esc.percentage,
                'previous_rental_amount', esc.previous_rental_amount, 'new_rental_amount', esc.new_rental_amount) end,
    'payment', case when pay.ref is null then null else jsonb_build_object('amount', pay.amount, 'due_date', pay.due_date, 'status', pay.status,
                'days_overdue', public.za_today() - pay.due_date) end,
    'letter', case when lt.id is null then null else jsonb_build_object('amount', lt.amount, 'due_date', lt.due_date, 'remedy_by', lt.remedy_by) end,
    'booking', case when bk.id is null then null else jsonb_build_object('id', bk.id, 'reference', bk.reference, 'full_name', bk.full_name, 'email', bk.email,
                'cancel_token', bk.cancel_token, 'status', bk.status, 'meets_income', bk.meets_income) end,
    'slot', case when sl.id is null then null else jsonb_build_object('starts_at', sl.starts_at, 'duration_minutes', sl.duration_minutes, 'meeting_point', sl.meeting_point) end,
    'vacancy', case when vac.id is null then null else jsonb_build_object('id', vac.id, 'title', vac.title, 'area', vac.area, 'monthly_rent', vac.monthly_rent) end
  );
end;
$$;

create or replace function public.claim_tenancy_notifications(p_limit integer default 20)
returns table (n_id bigint, n_event text, n_detail jsonb, n_context jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  s record;
begin
  select * into s from public.rental_recruitment_settings order by updated_at desc limit 1;
  if s.id is not null and not s.notifications_enabled then
    update public.tenancy_notifications set status = 'skipped', processed_at = now(),
           last_error = 'Email notifications are switched off in Screening settings'
     where status = 'pending';
    return;
  end if;
  for r in
    update public.tenancy_notifications q
       set status = 'sending', claimed_at = now(), attempts = q.attempts + 1
     where q.id in (
       select x.id from public.tenancy_notifications x
        where x.status = 'pending'
           or (x.status = 'failed' and x.attempts < 3 and x.claimed_at < now() - interval '2 minutes')
           or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes')
        order by x.id
        limit greatest(1, least(p_limit, 50))
        for update skip locked)
    returning q.*
  loop
    n_id := r.id; n_event := r.event_type; n_detail := r.detail;
    n_context := public.tenancy_notification_context(r.id);
    return next;
  end loop;
end;
$$;

create or replace function public.complete_tenancy_notification(p_id bigint, p_status text, p_recipients jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then raise exception 'Invalid status %', p_status; end if;
  update public.tenancy_notifications
     set status = p_status, recipients = p_recipients, last_error = left(p_error, 1000), processed_at = now()
   where id = p_id;
end;
$$;

-- For the "create tenant account" action: the accepted applicant's details.
create or replace function public.tenant_account_candidate(p_application_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('id', a.id, 'status', a.status, 'full_name', a.full_name, 'email', lower(a.email), 'phone', a.phone,
                            'id_number', a.id_number, 'current_address', a.current_address, 'reference', a.reference,
                            'vacancy_title', v.title, 'tenant_profile_id', a.tenant_profile_id)
  from public.rental_applications a join public.rental_vacancies v on v.id = a.vacancy_id
  where a.id = p_application_id;
$$;

-- Log a directly-sent email (used for the account email, whose one-time
-- link must never be stored).
create or replace function public.log_tenancy_email_sent(p_event text, p_application_id uuid, p_recipients jsonb, p_requested_by uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.tenancy_notifications (event_type, application_id, status, attempts, recipients, requested_by, processed_at)
  values (p_event, p_application_id, 'sent', 1, p_recipients, p_requested_by, now());
$$;

revoke all on function public.tenancy_notification_context(bigint) from public, anon, authenticated;
revoke all on function public.claim_tenancy_notifications(integer) from public, anon, authenticated;
revoke all on function public.complete_tenancy_notification(bigint, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.tenant_account_candidate(uuid) from public, anon, authenticated;
revoke all on function public.log_tenancy_email_sent(text, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.tenancy_notification_context(bigint), public.claim_tenancy_notifications(integer),
  public.complete_tenancy_notification(bigint, text, jsonb, text), public.tenant_account_candidate(uuid),
  public.log_tenancy_email_sent(text, uuid, jsonb, uuid) to service_role;
