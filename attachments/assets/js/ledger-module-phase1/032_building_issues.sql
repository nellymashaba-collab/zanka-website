-- 032_building_issues.sql
-- Building-wide maintenance issue log (first building: Roberts Avenue Mansions).
--
-- Any owner, tenant, trustee or staff member of a building can log an issue
-- from the public building page (ram.html) with the building's shared access
-- code — no account needed. Zanka admins allocate, approve and close issues
-- from building-issues.html, and everyone in the building can follow progress
-- on the public board, which shows no personal details.
--
-- Controls built in:
--   * every status change, assignment and approval is written to an audit trail
--   * work estimated above the building's approval threshold cannot start until
--     the required number of quotes is recorded and a named trustee approves it
--   * each issue gets a response deadline from its urgency (SLA), so the board
--     and the age analysis show what is overdue and with whom
--
-- Requires is_admin() (already used by 015, 021, 022, 024).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Buildings
-- ---------------------------------------------------------------------------
create table if not exists public.buildings (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9-]{2,20}$'),
  name text not null,
  address text,
  access_code_hash text,
  approval_threshold numeric(12,2) not null default 5000 check (approval_threshold >= 0),
  required_quotes int not null default 3 check (required_quotes between 1 and 5),
  sla_emergency_hours int not null default 24 check (sla_emergency_hours > 0),
  sla_urgent_hours int not null default 72 check (sla_urgent_hours > 0),
  sla_routine_hours int not null default 336 check (sla_routine_hours > 0),
  next_issue_no int not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.buildings enable row level security;
drop policy if exists "Admins manage buildings" on public.buildings;
create policy "Admins manage buildings" on public.buildings
  for all using (is_admin()) with check (is_admin());

insert into public.buildings (code, name, address)
values ('ram', 'Roberts Avenue Mansions', 'Roberts Avenue, Kensington, Johannesburg')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Issues
-- ---------------------------------------------------------------------------
create table if not exists public.building_issues (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references public.buildings(id),
  reference text not null unique,
  location_type text not null check (location_type in ('Common property', 'Unit')),
  unit_label text,
  location_detail text,
  category text not null check (category in (
    'Plumbing', 'Electrical', 'Gates & access', 'Security & cameras', 'Roof & waterproofing',
    'Building & masonry', 'Carpentry', 'Painting', 'Garden & grounds', 'Cleaning & refuse',
    'Pest control', 'Parking', 'Other')),
  urgency text not null default 'Routine' check (urgency in ('Emergency', 'Urgent', 'Routine')),
  title text not null,
  description text,
  reporter_name text not null,
  reporter_contact text not null,
  reporter_role text not null check (reporter_role in ('Owner', 'Tenant', 'Trustee', 'Staff', 'Other')),
  popia_consent_at timestamptz not null,
  status text not null default 'Logged' check (status in (
    'Logged', 'Assigned', 'Awaiting approval', 'Approved', 'In progress', 'Completed', 'Closed', 'Rejected')),
  assigned_to text,
  assigned_at timestamptz,
  estimated_cost numeric(12,2) check (estimated_cost is null or estimated_cost >= 0),
  quotes_received int not null default 0 check (quotes_received between 0 and 20),
  approved_by text,
  approved_at timestamptz,
  final_cost numeric(12,2) check (final_cost is null or final_cost >= 0),
  due_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  upload_token uuid,
  upload_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists building_issues_building_created_idx on public.building_issues (building_id, created_at desc);
create index if not exists building_issues_contact_idx on public.building_issues (building_id, lower(reporter_contact), created_at);

alter table public.building_issues enable row level security;
drop policy if exists "Admins manage building issues" on public.building_issues;
create policy "Admins manage building issues" on public.building_issues
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 3. Audit trail
-- ---------------------------------------------------------------------------
create table if not exists public.building_issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.building_issues(id) on delete cascade,
  event_type text not null check (event_type in ('Logged', 'Status', 'Assigned', 'Approved', 'Cost', 'Note')),
  from_status text,
  to_status text,
  note text,
  is_public boolean not null default true,
  actor_id uuid default auth.uid(),
  actor_label text,
  created_at timestamptz not null default now()
);

create index if not exists building_issue_events_issue_idx on public.building_issue_events (issue_id, created_at);

alter table public.building_issue_events enable row level security;
drop policy if exists "Admins read building issue events" on public.building_issue_events;
create policy "Admins read building issue events" on public.building_issue_events
  for select using (is_admin());
drop policy if exists "Admins add building issue notes" on public.building_issue_events;
create policy "Admins add building issue notes" on public.building_issue_events
  for insert with check (is_admin() and event_type = 'Note');
-- No update or delete policy: the trail cannot be edited.

-- ---------------------------------------------------------------------------
-- 4. Photos
-- ---------------------------------------------------------------------------
create table if not exists public.building_issue_photos (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.building_issues(id) on delete cascade,
  storage_path text not null unique,
  original_filename text,
  size_bytes bigint,
  uploaded_at timestamptz not null default now()
);

alter table public.building_issue_photos enable row level security;
drop policy if exists "Admins manage building issue photos" on public.building_issue_photos;
create policy "Admins manage building issue photos" on public.building_issue_photos
  for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 5. Rules: deadlines, time stamps and the approval control
-- ---------------------------------------------------------------------------
create or replace function public.building_issue_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.buildings%rowtype;
  v_hours int;
begin
  select * into b from public.buildings where id = new.building_id;

  if tg_op = 'INSERT' or new.urgency is distinct from old.urgency then
    v_hours := case new.urgency
      when 'Emergency' then b.sla_emergency_hours
      when 'Urgent' then b.sla_urgent_hours
      else b.sla_routine_hours end;
    new.due_at := coalesce(new.created_at, now()) + make_interval(hours => v_hours);
  end if;

  if tg_op = 'UPDATE' then
    new.reference := old.reference;
    new.building_id := old.building_id;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;

  new.assigned_to := nullif(trim(coalesce(new.assigned_to, '')), '');
  new.approved_by := nullif(trim(coalesce(new.approved_by, '')), '');

  if new.assigned_to is null then
    new.assigned_at := null;
  elsif tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    new.assigned_at := now();
  end if;

  if new.approved_by is null then
    new.approved_at := null;
  elsif tg_op = 'INSERT' or new.approved_by is distinct from old.approved_by then
    new.approved_at := now();
  end if;

  if new.status <> 'Logged' and new.status <> 'Rejected' and new.assigned_to is null then
    raise exception 'Assign the issue to someone before moving it to "%".', new.status using errcode = 'P0001';
  end if;

  -- The approval control: costly work needs quotes and a named approver.
  if new.status in ('Approved', 'In progress', 'Completed', 'Closed')
     and coalesce(new.estimated_cost, 0) > b.approval_threshold then
    if new.quotes_received < b.required_quotes then
      raise exception 'This job is estimated above R% so it needs % quotes before it can be approved (% recorded).',
        to_char(b.approval_threshold, 'FM999G999G990'), b.required_quotes, new.quotes_received using errcode = 'P0001';
    end if;
    if new.approved_by is null then
      raise exception 'This job is estimated above R% so a trustee must approve it first. Enter who approved it.',
        to_char(b.approval_threshold, 'FM999G999G990') using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'Approved' and new.approved_by is null then
    raise exception 'Enter who approved this job.' using errcode = 'P0001';
  end if;

  if new.status in ('Completed', 'Closed') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'Rejected' then
    new.completed_at := null;
  end if;

  if new.status in ('Closed', 'Rejected') then
    new.closed_at := coalesce(new.closed_at, now());
  else
    new.closed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists building_issue_before_write on public.building_issues;
create trigger building_issue_before_write
  before insert or update on public.building_issues
  for each row execute function public.building_issue_before_write();

create or replace function public.building_issue_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := case when auth.uid() is null then null else 'Zanka Group' end;
begin
  if tg_op = 'INSERT' then
    insert into public.building_issue_events (issue_id, event_type, to_status, note, actor_id, actor_label)
    values (new.id, 'Logged', new.status, 'Logged by ' || lower(new.reporter_role), null, new.reporter_role);
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.building_issue_events (issue_id, event_type, from_status, to_status, actor_label)
    values (new.id, 'Status', old.status, new.status, v_actor);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.building_issue_events (issue_id, event_type, note, actor_label)
    values (new.id, 'Assigned', coalesce('Assigned to ' || new.assigned_to, 'Unassigned'), v_actor);
  end if;
  if new.approved_by is distinct from old.approved_by and new.approved_by is not null then
    insert into public.building_issue_events (issue_id, event_type, note, actor_label)
    values (new.id, 'Approved', 'Approved by ' || new.approved_by
      || coalesce(' (' || new.quotes_received || ' quotes, estimate R' || to_char(new.estimated_cost, 'FM999G999G990D00') || ')', ''), v_actor);
  end if;
  if new.estimated_cost is distinct from old.estimated_cost or new.final_cost is distinct from old.final_cost
     or new.quotes_received is distinct from old.quotes_received then
    insert into public.building_issue_events (issue_id, event_type, note, is_public, actor_label)
    values (new.id, 'Cost', concat_ws('; ',
      case when new.estimated_cost is distinct from old.estimated_cost then 'Estimate ' || coalesce('R' || to_char(new.estimated_cost, 'FM999G999G990D00'), 'cleared') end,
      case when new.quotes_received is distinct from old.quotes_received then new.quotes_received || ' quotes received' end,
      case when new.final_cost is distinct from old.final_cost then 'Final cost ' || coalesce('R' || to_char(new.final_cost, 'FM999G999G990D00'), 'cleared') end),
      true, v_actor);
  end if;
  return new;
end;
$$;

drop trigger if exists building_issue_after_write on public.building_issues;
create trigger building_issue_after_write
  after insert or update on public.building_issues
  for each row execute function public.building_issue_after_write();

-- ---------------------------------------------------------------------------
-- 6. Public functions (anon) — all gated by the building's access code
-- ---------------------------------------------------------------------------
create or replace function public.building_hash_access_code(p_code text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(extensions.digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex');
$$;
revoke all on function public.building_hash_access_code(text) from public, anon, authenticated;

-- Internal: the building, if the code and access code match. Raises otherwise.
create or replace function public.building_for_access(p_building text, p_access text)
returns public.buildings
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.buildings%rowtype;
begin
  select * into b from public.buildings where code = lower(trim(coalesce(p_building, ''))) and is_active;
  if not found then
    raise exception 'Building not found.' using errcode = 'P0001';
  end if;
  if b.access_code_hash is null then
    raise exception 'This building page is not open yet.' using errcode = 'P0001';
  end if;
  if b.access_code_hash <> public.building_hash_access_code(p_access) then
    raise exception 'That building access code is not right. Ask your trustees or Zanka Group for it.' using errcode = 'P0001';
  end if;
  return b;
end;
$$;
revoke all on function public.building_for_access(text, text) from public, anon, authenticated;

create or replace function public.building_public_info(p_building text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('code', code, 'name', name, 'address', address, 'is_open', access_code_hash is not null,
    'sla_emergency_hours', sla_emergency_hours, 'sla_urgent_hours', sla_urgent_hours, 'sla_routine_hours', sla_routine_hours)
  from public.buildings
  where code = lower(trim(coalesce(p_building, ''))) and is_active;
$$;
revoke all on function public.building_public_info(text) from public;
grant execute on function public.building_public_info(text) to anon, authenticated;

create or replace function public.building_check_access(p_building text, p_access text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.building_for_access(p_building, p_access);
  return true;
end;
$$;
revoke all on function public.building_check_access(text, text) from public;
grant execute on function public.building_check_access(text, text) to anon, authenticated;

create or replace function public.building_log_issue(p_building text, p_access text, p_issue jsonb, p_consent boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  b public.buildings%rowtype;
  v_no int;
  v_id uuid;
  v_ref text;
  v_token uuid := gen_random_uuid();
  v_title text := trim(coalesce(p_issue->>'title', ''));
  v_desc text := nullif(trim(coalesce(p_issue->>'description', '')), '');
  v_name text := trim(coalesce(p_issue->>'reporter_name', ''));
  v_contact text := trim(coalesce(p_issue->>'reporter_contact', ''));
  v_loc text := coalesce(p_issue->>'location_type', '');
  v_unit text := nullif(trim(coalesce(p_issue->>'unit_label', '')), '');
begin
  b := public.building_for_access(p_building, p_access);

  if not coalesce(p_consent, false) then
    raise exception 'Please agree to how we use your details before logging the issue.' using errcode = 'P0001';
  end if;
  if length(v_title) < 3 or length(v_title) > 120 then
    raise exception 'Give the issue a short title (3 to 120 characters).' using errcode = 'P0001';
  end if;
  if length(coalesce(v_desc, '')) > 2000 then
    raise exception 'Please keep the description under 2,000 characters.' using errcode = 'P0001';
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then
    raise exception 'Please enter your name.' using errcode = 'P0001';
  end if;
  if length(v_contact) < 5 or length(v_contact) > 120 then
    raise exception 'Please enter a phone number or email address we can reach you on.' using errcode = 'P0001';
  end if;
  if v_loc = 'Unit' and (v_unit is null or length(v_unit) > 20) then
    raise exception 'Please enter your unit number.' using errcode = 'P0001';
  end if;

  if (select count(*) from public.building_issues
      where building_id = b.id and lower(reporter_contact) = lower(v_contact)
        and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'You have logged a lot of issues today. Please contact Zanka Group directly.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.building_issues
      where building_id = b.id and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many issues are being logged right now. Please try again shortly.' using errcode = 'P0001';
  end if;

  update public.buildings set next_issue_no = next_issue_no + 1
  where id = b.id returning next_issue_no - 1 into v_no;
  v_ref := upper(b.code) || '-' || lpad(v_no::text, 4, '0');

  insert into public.building_issues (
    building_id, reference, location_type, unit_label, location_detail, category, urgency, title, description,
    reporter_name, reporter_contact, reporter_role, popia_consent_at, upload_token, upload_expires_at)
  values (
    b.id, v_ref, v_loc, case when v_loc = 'Unit' then v_unit end,
    left(nullif(trim(coalesce(p_issue->>'location_detail', '')), ''), 120),
    coalesce(p_issue->>'category', 'Other'), coalesce(nullif(p_issue->>'urgency', ''), 'Routine'),
    v_title, v_desc, v_name, v_contact, coalesce(p_issue->>'reporter_role', 'Other'), now(),
    v_token, now() + interval '30 minutes')
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'reference', v_ref, 'upload_token', v_token);
end;
$$;
revoke all on function public.building_log_issue(text, text, jsonb, boolean) from public;
grant execute on function public.building_log_issue(text, text, jsonb, boolean) to anon, authenticated;

-- The public board: open issues plus anything closed in the last 90 days.
-- No names, contact details or descriptions.
create or replace function public.building_issue_board(p_building text, p_access text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b public.buildings%rowtype;
begin
  b := public.building_for_access(p_building, p_access);
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.logged_at desc)
    from (
      select i.reference, i.title, i.category, i.location_type, i.unit_label, i.location_detail, i.urgency, i.status,
             i.assigned_to, i.created_at as logged_at, i.due_at, i.completed_at, i.closed_at,
             (i.status not in ('Completed', 'Closed', 'Rejected')) as is_open,
             (i.status not in ('Completed', 'Closed', 'Rejected') and now() > i.due_at) as is_overdue,
             (select max(e.created_at) from public.building_issue_events e where e.issue_id = i.id and e.is_public) as last_update_at,
             (select e.note from public.building_issue_events e
               where e.issue_id = i.id and e.is_public and e.event_type = 'Note'
               order by e.created_at desc limit 1) as last_note
      from public.building_issues i
      where i.building_id = b.id
        and (i.status not in ('Completed', 'Closed', 'Rejected') or coalesce(i.closed_at, i.completed_at) > now() - interval '90 days')
    ) x
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.building_issue_board(text, text) from public;
grant execute on function public.building_issue_board(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Photo uploads (same pattern as rental applications in 024)
-- Path convention: {issue_id}/{random}-{filename}
-- ---------------------------------------------------------------------------
create or replace function public.building_issue_accepting_uploads(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.building_issues i
    where i.id::text = p_folder and i.upload_token is not null and i.upload_expires_at > now()
  );
$$;
revoke all on function public.building_issue_accepting_uploads(text) from public;
grant execute on function public.building_issue_accepting_uploads(text) to anon, authenticated;

create or replace function public.register_building_issue_photo(
  p_issue_id uuid, p_upload_token uuid, p_storage_path text, p_original_filename text, p_size_bytes bigint)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.building_issues i
    where i.id = p_issue_id and i.upload_token = p_upload_token and i.upload_expires_at > now()
  ) then
    raise exception 'The photo upload window has closed. Your issue is still logged.' using errcode = 'P0001';
  end if;
  if p_storage_path is null or p_storage_path not like p_issue_id::text || '/%' then
    raise exception 'Invalid photo path.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'building-issues' and o.name = p_storage_path) then
    raise exception 'The photo upload did not complete. Please try again.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.building_issue_photos where issue_id = p_issue_id) >= 5 then
    raise exception 'Up to 5 photos per issue.' using errcode = 'P0001';
  end if;

  insert into public.building_issue_photos (issue_id, storage_path, original_filename, size_bytes)
  values (p_issue_id, p_storage_path, left(coalesce(p_original_filename, 'photo'), 255), p_size_bytes)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.register_building_issue_photo(uuid, uuid, text, text, bigint) from public;
grant execute on function public.register_building_issue_photo(uuid, uuid, text, text, bigint) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'building-issues', 'building-issues', false, 10485760,
       array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
where not exists (select 1 from storage.buckets where id = 'building-issues');

drop policy if exists "Residents upload building issue photos" on storage.objects;
create policy "Residents upload building issue photos" on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'building-issues'
    and public.building_issue_accepting_uploads((storage.foldername(name))[1])
  );

drop policy if exists "Admins manage building issue photos" on storage.objects;
create policy "Admins manage building issue photos" on storage.objects
  for all using (bucket_id = 'building-issues' and is_admin())
  with check (bucket_id = 'building-issues' and is_admin());

-- ---------------------------------------------------------------------------
-- 8. Admin: set or change a building's access code
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_building_access_code(p_building_id uuid, p_access text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change the access code.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_access, ''))) < 6 then
    raise exception 'Use an access code of at least 6 characters.' using errcode = 'P0001';
  end if;
  update public.buildings set access_code_hash = public.building_hash_access_code(p_access) where id = p_building_id;
end;
$$;
revoke all on function public.admin_set_building_access_code(uuid, text) from public, anon;
grant execute on function public.admin_set_building_access_code(uuid, text) to authenticated;
