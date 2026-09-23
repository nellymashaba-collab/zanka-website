# WhatsApp Message Receiver — Deployment Guide

Covers getting inbound WhatsApp messages flowing from Meta into Zanka's own database and admin dashboard. This is receive-only: it stores every message sent to Zanka's WhatsApp number so staff can see it inside the site, alongside (not instead of) the Meta Business Suite Inbox. Sending replies through the API is a separate, not-yet-built piece.

Read this top to bottom once — step 0 is a prerequisite you do on Meta's side before any of the code steps matter.

## 0. Prerequisite: a Meta Developer App (do this first, on Meta's side)

Right now Zanka's WhatsApp number is only linked through Meta Business Suite's simple "Linked Accounts" flow. That flow has no concept of a webhook — it only feeds Meta's own Inbox. To get messages pushed to code you control, the number needs a Meta Developer App with the WhatsApp product attached to the same WhatsApp Business Account:

1. Go to developers.facebook.com -> My Apps -> Create App -> choose "Business" as the app type.
2. Add the "WhatsApp" product to the app.
3. Under WhatsApp -> API Setup, confirm it's connected to Zanka's existing WhatsApp Business Account (the same one Business Suite uses) and the existing phone number -- you should not need to re-verify the number.
4. Under App Settings -> Basic, copy the **App Secret** -- you'll need it in step 2 below.

You do not need a permanent access token for receiving only (that's only required for sending messages via the API, which this build doesn't do yet).

## 1. Run the database migration

In the Supabase SQL Editor, run `023_whatsapp_messages.sql` (in `ledger-module-phase1/`). It's safe to re-run -- `create table if not exists`, `drop policy if exists` before every `create policy`.

This creates `whatsapp_messages` with RLS restricting reads to `admin` and `property_manager` roles, and updates (used for marking a message "replied" from the dashboard) to `admin` only. There's deliberately no insert policy for logged-in users -- only the webhook (running as service role) can create rows.

## 2. Set secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already provided automatically to every Edge Function. Two secrets are specific to this function:

```
WHATSAPP_VERIFY_TOKEN   # any string you make up, e.g. openssl rand -hex 20
WHATSAPP_APP_SECRET     # the App Secret from step 0.4 above
```

Set both via:

```bash
supabase secrets set WHATSAPP_VERIFY_TOKEN=<value you generated> WHATSAPP_APP_SECRET=<value from Meta>
```

`WHATSAPP_VERIFY_TOKEN` is not a secret Meta gives you -- it's one you invent, and you'll type the exact same value into Meta's dashboard in step 4. `WHATSAPP_APP_SECRET` is real and signs every webhook call; without it set, the function fails closed and rejects everything (same pattern as the existing KYC webhook).

## 3. Deploy the Edge Function

```bash
supabase link --project-ref blhjlsddmwxjchjlfnhk   # skip if already linked
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

`--no-verify-jwt` is required -- Meta calls this endpoint directly with no Supabase session, and authenticates itself via the `X-Hub-Signature-256` header instead (checked against `WHATSAPP_APP_SECRET`).

After deploying, note the function's URL -- it's:

```
https://blhjlsddmwxjchjlfnhk.supabase.co/functions/v1/whatsapp-webhook
```

## 4. Point Meta's webhook at it

Back in the Meta Developer App from step 0:

1. WhatsApp -> Configuration -> Webhook -> Edit.
2. Callback URL: the function URL from step 3.
3. Verify Token: the exact `WHATSAPP_VERIFY_TOKEN` value you set in step 2.
4. Click Verify and Save -- Meta will send the GET handshake to the function; this only succeeds once the function is deployed and the secret matches.
5. Under "Webhook fields," subscribe to **messages** (and optionally **message_status** if you want delivery/read receipts recorded).

## 5. Verify

- Send a WhatsApp message to Zanka's number from a personal phone.
- In the Supabase SQL Editor: `select * from whatsapp_messages order by wa_timestamp desc limit 5;` -- the message should appear within a few seconds.
- Log into the admin dashboard as an admin user and open the new **WhatsApp** tab in the sidebar -- the message should render there, with a "Mark Replied" action.
- Confirm it still also shows up in Meta Business Suite's own Inbox -- both should work side by side.

## 6. Files this touches

Database: `023_whatsapp_messages.sql` (in `ledger-module-phase1/`).

Edge Function: `supabase/functions/whatsapp-webhook/index.ts` (reuses the existing `_shared/cors.ts`).

Frontend: `admin-dashboard.html` (new WhatsApp sidebar link + section), `assets/js/admin-dashboard.js` (`loadWhatsappMessages()`, wired into the page's load sequence and the section's Refresh button).

## 7. Not done here -- natural next steps, not built yet

- **Sending replies from the dashboard.** Needs a `whatsapp-send` Edge Function that calls Meta's Graph API with a permanent access token (a System User token from Business Settings, not the temporary 24-hour token the App Dashboard shows by default) -- kept server-side as another secret, never shipped to the browser. Say the word if you want this built next.
- **Media messages.** Incoming images/documents/audio are recorded (type, caption, Meta's `media_id`) but not downloaded -- fetching and storing the actual file needs an authenticated call to Meta's Graph API per media item, which isn't done here.
- **Role coverage.** `whatsapp_messages` is currently visible to `admin` and `property_manager` only -- widen the select policy if another role (e.g. `partner`) should see it.
