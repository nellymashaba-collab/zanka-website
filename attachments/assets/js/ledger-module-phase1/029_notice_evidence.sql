-- 029_notice_evidence.sql
-- Evidence of service for formal notices (letters of demand, notices to
-- vacate, lease-expiry and escalation notices, refund statements …).
--
-- For every tenancy email sent to a tenant or an owner, the
-- `tenancy-automation` Edge Function stores the email exactly as sent,
-- together with the email provider's (Resend) message ID. Resend's delivery
-- webhooks (`email-events` Edge Function) add delivered / bounced events.
--
-- Integrity:
--   * Append-only. Nobody can UPDATE, DELETE or TRUNCATE these rows, admins
--     and the service role included (triggers refuse it). Rows are only
--     written through the two functions below, which only the Edge
--     Functions (service role) may call.
--   * content_sha256 is a SHA-256 fingerprint of the email as sent, so any
--     later change to the stored text is detectable.
--   * record_hash chains every record to the one before it, so removing or
--     altering an earlier record breaks every later hash.
--     verify_notice_evidence() re-checks the whole chain.
--   This makes the trail tamper-evident. A database owner could still switch
--   triggers off, which is why the chain exists.
--
-- Run after 027_tenancy_lifecycle.sql. Safe to run again.

create table if not exists public.notice_evidence (
  id bigint generated always as identity primary key,
  notification_id bigint references public.tenancy_notifications(id),
  event_type text not null,
  audience text not null,
  lease_id bigint,
  notice_ref text,
  ending_id uuid,
  payment_ref text,
  escalation_ref text,
  letter_id uuid,
  from_address text not null,
  to_addresses text[] not null,
  cc_addresses text[] not null default '{}',
  reply_to text,
  subject text not null,
  html_body text not null,
  text_body text,
  content_sha256 text not null,
  prev_hash text,
  record_hash text not null,
  provider text not null default 'resend',
  provider_message_id text unique,
  accepted_at timestamptz not null default now()
);
create index if not exists notice_evidence_letter_idx on public.notice_evidence (letter_id);
create index if not exists notice_evidence_lease_idx on public.notice_evidence (lease_id);
create index if not exists notice_evidence_notification_idx on public.notice_evidence (notification_id);

create table if not exists public.notice_evidence_events (
  id bigint generated always as identity primary key,
  evidence_id bigint not null references public.notice_evidence(id),
  provider_message_id text not null,
  event_type text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  webhook_id text unique,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists notice_evidence_events_evidence_idx on public.notice_evidence_events (evidence_id, occurred_at);

-- Append-only ---------------------------------------------------------------
create or replace function public.notice_evidence_is_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Evidence records are permanent and cannot be changed or deleted.' using errcode = 'P0001';
end;
$$;

drop trigger if exists notice_evidence_no_change on public.notice_evidence;
create trigger notice_evidence_no_change before update or delete on public.notice_evidence
  for each row execute function public.notice_evidence_is_append_only();
drop trigger if exists notice_evidence_no_truncate on public.notice_evidence;
create trigger notice_evidence_no_truncate before truncate on public.notice_evidence
  for each statement execute function public.notice_evidence_is_append_only();
drop trigger if exists notice_evidence_events_no_change on public.notice_evidence_events;
create trigger notice_evidence_events_no_change before update or delete on public.notice_evidence_events
  for each row execute function public.notice_evidence_is_append_only();
drop trigger if exists notice_evidence_events_no_truncate on public.notice_evidence_events;
create trigger notice_evidence_events_no_truncate before truncate on public.notice_evidence_events
  for each statement execute function public.notice_evidence_is_append_only();

alter table public.notice_evidence enable row level security;
alter table public.notice_evidence_events enable row level security;
revoke all on public.notice_evidence, public.notice_evidence_events from anon, authenticated, service_role;
grant select on public.notice_evidence, public.notice_evidence_events to authenticated, service_role;
drop policy if exists "Admins read notice_evidence" on public.notice_evidence;
create policy "Admins read notice_evidence" on public.notice_evidence for select using (is_admin());
drop policy if exists "Admins read notice_evidence_events" on public.notice_evidence_events;
create policy "Admins read notice_evidence_events" on public.notice_evidence_events for select using (is_admin());

-- Fingerprints ----------------------------------------------------------------
-- The exact text that is hashed. evidence page (notice-evidence.html)
-- rebuilds the same string in the browser to verify a record.
create or replace function public.notice_evidence_canonical(p_from text, p_to text[], p_cc text[], p_reply_to text, p_subject text, p_html text, p_text text)
returns text
language sql
immutable
as $$
  select 'from:' || coalesce(p_from, '') || E'\n'
      || 'to:' || array_to_string(coalesce(p_to, '{}'), ',') || E'\n'
      || 'cc:' || array_to_string(coalesce(p_cc, '{}'), ',') || E'\n'
      || 'reply-to:' || coalesce(p_reply_to, '') || E'\n'
      || 'subject:' || coalesce(p_subject, '') || E'\n\n'
      || coalesce(p_html, '') || E'\n\n'
      || coalesce(p_text, '');
$$;

create or replace function public.notice_evidence_sha256(p text)
returns text
language sql
immutable
as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- Writing (service role only) ---------------------------------------------------
create or replace function public.record_notice_evidence(
  p_notification_id bigint, p_audience text, p_from text, p_to text[], p_cc text[], p_reply_to text,
  p_subject text, p_html text, p_text text, p_message_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  n record;
  v_content text;
  v_prev text;
  v_id bigint;
  v_hash text;
begin
  select * into n from public.tenancy_notifications where id = p_notification_id;
  if n.id is null then
    raise exception 'Unknown notification %', p_notification_id;
  end if;
  -- One writer at a time keeps the hash chain in order.
  lock table public.notice_evidence in share row exclusive mode;
  v_content := public.notice_evidence_sha256(public.notice_evidence_canonical(p_from, p_to, p_cc, p_reply_to, p_subject, p_html, p_text));
  select record_hash into v_prev from public.notice_evidence order by id desc limit 1;
  v_id := nextval(pg_get_serial_sequence('public.notice_evidence', 'id'));
  v_hash := public.notice_evidence_sha256(coalesce(v_prev, '') || '|' || v_content || '|' || v_id::text);
  insert into public.notice_evidence (id, notification_id, event_type, audience, lease_id, notice_ref, ending_id, payment_ref, escalation_ref, letter_id,
                                      from_address, to_addresses, cc_addresses, reply_to, subject, html_body, text_body,
                                      content_sha256, prev_hash, record_hash, provider_message_id)
  overriding system value
  values (v_id, n.id, n.event_type, p_audience, n.lease_id, n.notice_ref, n.ending_id, n.payment_ref, n.escalation_ref, n.letter_id,
          p_from, p_to, coalesce(p_cc, '{}'), p_reply_to, p_subject, p_html, p_text,
          v_content, v_prev, v_hash, nullif(p_message_id, ''));
  return v_id;
end;
$$;

-- Resend webhook events. Returns false (and stores nothing) for emails that
-- are not formal notices, e.g. recruitment emails.
create or replace function public.record_email_event(p_webhook_id text, p_message_id text, p_event_type text, p_occurred_at timestamptz, p_payload jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evidence bigint;
begin
  select id into v_evidence from public.notice_evidence where provider_message_id = p_message_id;
  if v_evidence is null then
    return false;
  end if;
  insert into public.notice_evidence_events (evidence_id, provider_message_id, event_type, occurred_at, webhook_id, payload)
  values (v_evidence, p_message_id, left(p_event_type, 60), p_occurred_at, nullif(p_webhook_id, ''), coalesce(p_payload, '{}'::jsonb))
  on conflict (webhook_id) do nothing;
  return true;
end;
$$;

revoke all on function public.record_notice_evidence(bigint, text, text, text[], text[], text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_email_event(text, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_notice_evidence(bigint, text, text, text[], text[], text, text, text, text, text) to service_role;
grant execute on function public.record_email_event(text, text, text, timestamptz, jsonb) to service_role;

-- Verification (admins) ---------------------------------------------------------
-- Re-computes every fingerprint and the chain. An empty result means the
-- whole trail is intact.
create or replace function public.verify_notice_evidence()
returns table (evidence_id bigint, problem text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_prev text := null;
  v_content text;
begin
  if not public.is_admin() then
    raise exception 'Only admins can verify evidence.' using errcode = '42501';
  end if;
  for r in select * from public.notice_evidence order by id loop
    v_content := public.notice_evidence_sha256(public.notice_evidence_canonical(r.from_address, r.to_addresses, r.cc_addresses, r.reply_to, r.subject, r.html_body, r.text_body));
    if v_content <> r.content_sha256 then
      evidence_id := r.id; problem := 'Content does not match its fingerprint'; return next;
    end if;
    if coalesce(r.prev_hash, '') <> coalesce(v_prev, '') then
      evidence_id := r.id; problem := 'Chain link to the previous record is broken (a record is missing or was changed)'; return next;
    end if;
    if public.notice_evidence_sha256(coalesce(r.prev_hash, '') || '|' || r.content_sha256 || '|' || r.id::text) <> r.record_hash then
      evidence_id := r.id; problem := 'Record hash does not match'; return next;
    end if;
    v_prev := r.record_hash;
  end loop;
end;
$$;
revoke all on function public.verify_notice_evidence() from public, anon;
grant execute on function public.verify_notice_evidence() to authenticated;
