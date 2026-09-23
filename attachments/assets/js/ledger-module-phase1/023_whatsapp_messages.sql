-- ============================================================================
-- ZANKA LEDGER MODULE — PHASE 1
-- 023_whatsapp_messages.sql
--
-- Storage for inbound (and, later, outbound) WhatsApp messages delivered by
-- Meta's WhatsApp Business Platform webhook. Populated exclusively by the
-- whatsapp-webhook Edge Function (service role — bypasses RLS on insert).
-- This table is read-only from the browser; there is deliberately no client
-- insert policy below.
--
-- Safe to re-run: create table if not exists, drop policy if exists before
-- every create policy (same convention as 022_kyc_module.sql).
-- ============================================================================

create table if not exists public.whatsapp_messages (
  id             uuid primary key default gen_random_uuid(),
  wa_message_id  text unique,                 -- Meta's message id (wamid...); null only for legacy/manual rows
  direction      text not null default 'inbound' check (direction in ('inbound','outbound')),
  wa_from        text not null,                -- sender's WhatsApp number (E.164, no leading +) for inbound; recipient for outbound
  wa_to          text,                         -- our business phone_number_id / display number
  contact_name   text,                         -- from Meta's contacts[].profile.name, when present
  message_type   text not null default 'text', -- text, image, document, audio, video, location, button, interactive, reaction, unknown
  body_text      text,                         -- message body / caption, when applicable
  media_id       text,                         -- Meta media id, for types that carry media (fetch separately via Graph API when needed)
  status         text not null default 'received' check (status in ('received','read','replied')),
  wa_timestamp   timestamptz not null default now(), -- Meta's own message timestamp
  raw_payload    jsonb,                        -- full message object as received, for anything not modeled above
  created_at     timestamptz not null default now()
);

comment on table public.whatsapp_messages is
  'Messages sent to/from Zanka''s WhatsApp Business Platform number, delivered via the whatsapp-webhook Edge Function. Write access is service-role only.';

create index if not exists whatsapp_messages_wa_timestamp_idx on public.whatsapp_messages (wa_timestamp desc);
create index if not exists whatsapp_messages_wa_from_idx on public.whatsapp_messages (wa_from);

alter table public.whatsapp_messages enable row level security;

-- Read: staff only (admin + property_manager). Widen later if a broader
-- role should see these (e.g. partner) — nothing else depends on this being
-- narrow, it's just the conservative default matching this project's
-- handling of other customer-communication data.
drop policy if exists "whatsapp_messages_select_staff" on public.whatsapp_messages;
create policy "whatsapp_messages_select_staff" on public.whatsapp_messages
  for select
  using (public.current_user_role() in ('admin','property_manager'));

-- Update: admin only, and only meant for the status column (marking a
-- message read/replied from the dashboard). Not enforced at the column
-- level here — if that matters later, move status changes behind an RPC.
drop policy if exists "whatsapp_messages_update_admin" on public.whatsapp_messages;
create policy "whatsapp_messages_update_admin" on public.whatsapp_messages
  for update
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- No insert/delete policy for authenticated users on purpose: rows are
-- created only by the webhook, which runs as service role and bypasses RLS.
