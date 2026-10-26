-- ============================================================================
-- ZANKA TENANT RECRUITMENT — AUTOMATIC EMAILS
-- 026_rental_notifications.sql   (run after 024 and 025)
--
-- HOW IT WORKS
-- 1. Triggers on rental_vacancies and rental_applications write one row per
--    event into rental_notifications (an "outbox"). This happens inside the
--    same transaction as the change itself, so an event can never be lost,
--    whichever page or script made the change.
-- 2. The Edge Function `rental-notifications` sends whatever is waiting. The
--    website calls it straight after each change; anything that still
--    hasn't gone (e.g. the browser was closed) is sent the next time it runs,
--    and failures are retried. The function reads everything it needs from
--    claim_rental_notifications(), so a caller can only make it send emails
--    that the database itself queued — nobody can inject an email.
-- 3. Every email is recorded: recipients, status, and any error.
--
-- WHO GETS WHAT (admin is cc'd on every email)
--   Listing created / goes live / closed / let / unpublished ..... owner
--   Listing rent, deposit, dates or title changed ................ owner
--   New application ..... applicant (confirmation) + owner (no personal data)
--   Offer made .......... applicant (offer letter)  + owner (no personal data)
--   Offer accepted ................................................ owner
--   Declined ................................................ applicant
--   Tenant account invitation (sent from the admin page) ...... applicant
-- Owners never receive applicants' names or contact details: the POPIA
-- consent applicants sign covers Zanka Group and its agents, not owners.
--
-- Safe to re-run.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------

alter table public.rental_recruitment_settings
  add column if not exists notifications_enabled boolean not null default true,
  add column if not exists notification_admin_email text not null default 'admin@zankagroup.co.za';

alter table public.rental_recruitment_settings drop constraint if exists rrs_admin_email_format;
alter table public.rental_recruitment_settings add constraint rrs_admin_email_format
  check (notification_admin_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');


-- ---------------------------------------------------------------------------
-- 2. Outbox
-- ---------------------------------------------------------------------------

create table if not exists public.rental_notifications (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'listing_created', 'listing_status_changed', 'listing_updated',
    'application_received', 'application_offered', 'application_accepted',
    'application_declined', 'tenant_account_invite'
  )),
  vacancy_id uuid references public.rental_vacancies(id) on delete cascade,
  application_id uuid references public.rental_applications(id) on delete cascade,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  recipients jsonb,          -- [{ "audience": "owner", "to": [...], "cc": [...], "subject": "..." }, ...]
  last_error text,
  requested_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  constraint rental_notifications_target check (vacancy_id is not null or application_id is not null)
);

create index if not exists rental_notifications_status_idx on public.rental_notifications (status, id);
create index if not exists rental_notifications_vacancy_idx on public.rental_notifications (vacancy_id);
create index if not exists rental_notifications_application_idx on public.rental_notifications (application_id);

alter table public.rental_notifications enable row level security;

drop policy if exists "Admins read rental_notifications" on public.rental_notifications;
create policy "Admins read rental_notifications" on public.rental_notifications
  for select using (is_admin());

-- Admins can queue a resend or a tenant-account invitation, and put a
-- failed email back in the queue. They cannot write recipients or content:
-- those are decided by the sender from the database.
drop policy if exists "Admins queue rental_notifications" on public.rental_notifications;
create policy "Admins queue rental_notifications" on public.rental_notifications
  for insert with check (is_admin() and status = 'pending' and recipients is null);

drop policy if exists "Admins retry rental_notifications" on public.rental_notifications;
create policy "Admins retry rental_notifications" on public.rental_notifications
  for update using (is_admin() and status in ('failed', 'skipped'))
  with check (is_admin() and status = 'pending');

-- Supabase gives every new table full privileges for anon and authenticated
-- by default; take them back and grant only what the policies above need.
revoke all on public.rental_notifications from anon, authenticated;
grant select on public.rental_notifications to authenticated;
grant insert (event_type, vacancy_id, application_id, detail, status, requested_by) on public.rental_notifications to authenticated;
grant update (status, attempts, last_error) on public.rental_notifications to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Triggers: queue an event for every change worth telling someone about
-- ---------------------------------------------------------------------------

create or replace function public.rental_vacancy_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_pending_id bigint;
  v_merged jsonb;
  k text;
begin
  if tg_op = 'INSERT' then
    insert into public.rental_notifications (event_type, vacancy_id, detail)
    values ('listing_created', new.id, jsonb_build_object('status', new.status));
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.rental_notifications (event_type, vacancy_id, detail)
    values ('listing_status_changed', new.id, jsonb_build_object('from', old.status, 'to', new.status));
  end if;

  if new.title is distinct from old.title then
    v_changes := v_changes || jsonb_build_object('title', jsonb_build_object('from', old.title, 'to', new.title));
  end if;
  if new.monthly_rent is distinct from old.monthly_rent then
    v_changes := v_changes || jsonb_build_object('monthly_rent', jsonb_build_object('from', old.monthly_rent, 'to', new.monthly_rent));
  end if;
  if new.deposit is distinct from old.deposit then
    v_changes := v_changes || jsonb_build_object('deposit', jsonb_build_object('from', old.deposit, 'to', new.deposit));
  end if;
  if new.available_from is distinct from old.available_from then
    v_changes := v_changes || jsonb_build_object('available_from', jsonb_build_object('from', old.available_from, 'to', new.available_from));
  end if;
  if new.applications_close_at is distinct from old.applications_close_at then
    v_changes := v_changes || jsonb_build_object('applications_close_at', jsonb_build_object('from', old.applications_close_at, 'to', new.applications_close_at));
  end if;

  if v_changes <> '{}'::jsonb then
    -- Several quick edits before the email goes out become ONE email that
    -- shows each field's original and latest value.
    select n.id, n.detail->'changes' into v_pending_id, v_merged
    from public.rental_notifications n
    where n.vacancy_id = new.id and n.event_type = 'listing_updated' and n.status = 'pending'
    order by n.id desc limit 1;

    if v_pending_id is null then
      insert into public.rental_notifications (event_type, vacancy_id, detail)
      values ('listing_updated', new.id, jsonb_build_object('changes', v_changes));
    else
      for k in select jsonb_object_keys(v_changes) loop
        if v_merged ? k then
          v_merged := jsonb_set(v_merged, array[k, 'to'], v_changes->k->'to');
        else
          v_merged := v_merged || jsonb_build_object(k, v_changes->k);
        end if;
        if (v_merged->k->'from') = (v_merged->k->'to') then
          v_merged := v_merged - k;   -- changed and changed back: nothing to report
        end if;
      end loop;
      if v_merged = '{}'::jsonb then
        delete from public.rental_notifications where id = v_pending_id;
      else
        update public.rental_notifications set detail = jsonb_build_object('changes', v_merged) where id = v_pending_id;
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists rental_vacancies_notify on public.rental_vacancies;
create trigger rental_vacancies_notify after insert or update on public.rental_vacancies
  for each row execute function public.rental_vacancy_notify();


create or replace function public.rental_application_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  v_event := case
    when new.status = 'Submitted' and old.status = 'Uploading' then 'application_received'
    when new.status = 'Offered' then 'application_offered'
    when new.status = 'Accepted' then 'application_accepted'
    when new.status = 'Declined' then 'application_declined'
  end;
  if v_event is not null then
    insert into public.rental_notifications (event_type, application_id, vacancy_id)
    values (v_event, new.id, new.vacancy_id);
  end if;
  return new;
end;
$$;

drop trigger if exists rental_applications_notify on public.rental_applications;
create trigger rental_applications_notify after update of status on public.rental_applications
  for each row execute function public.rental_application_notify();


-- ---------------------------------------------------------------------------
-- 4. Functions used ONLY by the Edge Function (service role)
-- ---------------------------------------------------------------------------

-- Takes up to p_limit emails off the queue (pending, failed ones due a
-- retry, or ones stuck mid-send) and returns each with everything needed to
-- write it. Rows are locked as they are claimed, so two senders running at
-- the same moment never send the same email twice.
create or replace function public.claim_rental_notifications(p_limit integer default 20)
returns table (n_id bigint, n_event text, n_detail jsonb, n_context jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  s record;
  v record;
  a record;
  o record;
  v_owner uuid;
  v_count integer;
begin
  select * into s from public.rental_recruitment_settings order by updated_at desc limit 1;

  if s.id is not null and not s.notifications_enabled then
    update public.rental_notifications
       set status = 'skipped', processed_at = now(),
           last_error = 'Email notifications are switched off in Screening settings'
     where status = 'pending';
    return;
  end if;

  for r in
    update public.rental_notifications q
       set status = 'sending', claimed_at = now(), attempts = q.attempts + 1
     where q.id in (
       select x.id from public.rental_notifications x
        where x.status = 'pending'
           or (x.status = 'failed' and x.attempts < 3 and x.claimed_at < now() - interval '2 minutes')
           or (x.status = 'sending' and x.claimed_at < now() - interval '10 minutes')
        order by x.id
        limit greatest(1, least(p_limit, 50))
        for update skip locked)
    returning q.*
  loop
    v_owner := null; v_count := 0;

    -- SELECT INTO with no matching row leaves every field NULL, which is
    -- what the context below expects for events without an application.
    select * into a from public.rental_applications where id = r.application_id;

    select vac.*, p.address as property_address, p.name as property_name, p.owner_id as property_owner_id
      into v
      from public.rental_vacancies vac
      join public.properties p on p.id = vac.property_id
     where vac.id = coalesce(r.vacancy_id, a.vacancy_id);

    -- Owner: the property's owner, or for entity-owned properties the
    -- entity's representative (same rule as get_effective_owner_id, which
    -- is called dynamically so this file also runs where it doesn't exist).
    v_owner := v.property_owner_id;
    if v_owner is null and v.property_id is not null then
      begin
        execute 'select public.get_effective_owner_id($1)' into v_owner using v.property_id;
      exception when others then
        v_owner := null;
      end;
    end if;
    select full_name, email into o from public.profiles where id = v_owner;

    if v.id is not null then
      select count(*) into v_count from public.rental_applications
       where vacancy_id = v.id and status <> 'Uploading';
    end if;

    n_id := r.id;
    n_event := r.event_type;
    n_detail := r.detail;
    n_context := jsonb_build_object(
      'admin_email', coalesce(s.notification_admin_email, 'admin@zankagroup.co.za'),
      'retention_days', coalesce(s.declined_doc_retention_days, 90),
      'vacancy', case when v.id is null then null else jsonb_build_object(
        'id', v.id, 'title', v.title, 'area', v.area, 'status', v.status,
        'monthly_rent', v.monthly_rent, 'deposit', v.deposit,
        'available_from', v.available_from, 'applications_close_at', v.applications_close_at,
        'property_address', v.property_address, 'property_name', v.property_name) end,
      'owner', case when o.email is null then null else jsonb_build_object('name', o.full_name, 'email', o.email) end,
      'application', case when a.id is null then null else jsonb_build_object(
        'reference', a.reference, 'full_name', a.full_name, 'email', a.email, 'status', a.status,
        'offer_expires_at', a.offer_expires_at, 'move_in_date', a.move_in_date,
        'lease_term_months', a.lease_term_months, 'total_score', a.total_score,
        'conditional', coalesce(a.recommendation = 'Conditional' or a.decision_reason ilike 'Conditional%', false),
        'credit_checked', a.credit_score is not null, 'credit_bureau', a.credit_bureau) end,
      'application_count', v_count
    );
    return next;
  end loop;
end;
$$;

create or replace function public.complete_rental_notification(
  p_id bigint,
  p_status text,
  p_recipients jsonb,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Invalid notification status %', p_status;
  end if;
  update public.rental_notifications
     set status = p_status, recipients = p_recipients, last_error = left(p_error, 1000), processed_at = now()
   where id = p_id;
end;
$$;

revoke all on function public.claim_rental_notifications(integer) from public, anon, authenticated;
revoke all on function public.complete_rental_notification(bigint, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_rental_notifications(integer) to service_role;
grant execute on function public.complete_rental_notification(bigint, text, jsonb, text) to service_role;
