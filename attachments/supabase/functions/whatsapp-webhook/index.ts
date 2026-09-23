// supabase/functions/whatsapp-webhook/index.ts
// Deploy with: supabase functions deploy whatsapp-webhook --no-verify-jwt
//   (--no-verify-jwt is required: Meta calls this directly, with no Supabase
//   session/JWT — authenticity is verified via Meta's own X-Hub-Signature-256
//   header instead, below. Same reasoning as kyc-provider-webhook.)
//
// SECRETS REQUIRED:
//   WHATSAPP_VERIFY_TOKEN — a string you make up yourself (e.g. openssl rand
//     -hex 20). Enter this SAME value in Meta's App Dashboard when you
//     configure the webhook (Meta calls it the "Verify Token"). Used only
//     for the one-time GET handshake below.
//   WHATSAPP_APP_SECRET — the App Secret from your Meta Developer App
//     (App Dashboard → App Settings → Basic → App Secret). Meta signs every
//     webhook POST body with this via HMAC-SHA256 in X-Hub-Signature-256;
//     without it configured here we fail closed and refuse everything.
// Set via: supabase secrets set WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=...
//
// WHAT THIS DOES: Meta's WhatsApp Business Platform pushes every inbound
// message (and delivery/read status update) to this endpoint in real time.
// We store inbound messages in public.whatsapp_messages so the admin
// dashboard's WhatsApp tab can show them. This is receive-only — sending
// replies via the API is a separate function, not built here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN');
const APP_SECRET = Deno.env.get('WHATSAPP_APP_SECRET');
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!APP_SECRET) {
    console.error('WHATSAPP_APP_SECRET is not set — refusing to process webhook (fail closed, not open).');
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const macBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(macBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

// Best-effort text extraction across message types — not exhaustive, but
// covers what a small business actually receives day to day.
function extractBody(message: Record<string, unknown>): { bodyText: string | null; mediaId: string | null } {
  const type = message.type as string;
  switch (type) {
    case 'text':
      return { bodyText: (message.text as { body?: string })?.body ?? null, mediaId: null };
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker': {
      const media = message[type] as { id?: string; caption?: string } | undefined;
      return { bodyText: media?.caption ?? null, mediaId: media?.id ?? null };
    }
    case 'location': {
      const loc = message.location as { latitude?: number; longitude?: number; name?: string; address?: string } | undefined;
      const label = loc?.name || loc?.address || null;
      return { bodyText: loc ? `Location: ${loc.latitude}, ${loc.longitude}${label ? ` (${label})` : ''}` : null, mediaId: null };
    }
    case 'button':
      return { bodyText: (message.button as { text?: string })?.text ?? null, mediaId: null };
    case 'interactive': {
      const interactive = message.interactive as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined;
      return { bodyText: interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? null, mediaId: null };
    }
    case 'reaction':
      return { bodyText: (message.reaction as { emoji?: string })?.emoji ?? null, mediaId: null };
    default:
      return { bodyText: null, mediaId: null };
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // --- Meta's one-time webhook verification handshake (GET) ---
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    console.error('WhatsApp webhook verification failed — mode/token mismatch.');
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  if (!(await verifySignature(rawBody, signature))) {
    console.error('WhatsApp webhook signature verification failed.');
    return json({ error: 'Invalid signature' }, 401);
  }

  let payload: {
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { display_phone_number?: string; phone_number_id?: string };
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: Array<Record<string, unknown>>;
          statuses?: Array<{ id?: string; status?: string }>;
        };
      }>;
    }>;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Always acknowledge quickly — Meta retries aggressively (and eventually
  // disables the webhook) if it doesn't get a fast 200, so we do the DB work
  // best-effort and never let a single bad row fail the whole batch.
  try {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id ?? null;
        const contactsByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

        for (const message of value.messages ?? []) {
          const waMessageId = message.id as string | undefined;
          const from = message.from as string | undefined;
          const timestampRaw = message.timestamp as string | undefined;
          if (!from) continue;

          const { bodyText, mediaId } = extractBody(message);
          const waTimestamp = timestampRaw ? new Date(Number(timestampRaw) * 1000).toISOString() : new Date().toISOString();

          const { error } = await supabaseAdmin.from('whatsapp_messages').upsert(
            {
              wa_message_id: waMessageId ?? null,
              direction: 'inbound',
              wa_from: from,
              wa_to: phoneNumberId,
              contact_name: contactsByWaId.get(from) ?? null,
              message_type: (message.type as string) ?? 'unknown',
              body_text: bodyText,
              media_id: mediaId,
              status: 'received',
              wa_timestamp: waTimestamp,
              raw_payload: message,
            },
            { onConflict: 'wa_message_id', ignoreDuplicates: true },
          );
          if (error) console.error('Failed to store WhatsApp message:', error.message);
        }

        // Delivery/read receipts for messages WE sent. No outbound-sending
        // function exists yet, so these will typically find no matching
        // row — that's expected, not an error.
        for (const status of value.statuses ?? []) {
          if (!status.id || !status.status) continue;
          const { error } = await supabaseAdmin.from('whatsapp_messages').update({ status: status.status }).eq('wa_message_id', status.id);
          if (error) console.error('Failed to update WhatsApp message status:', error.message);
        }
      }
    }
  } catch (err) {
    console.error('Error processing WhatsApp webhook payload:', (err as Error).message);
    // Still return 200 — Meta will retry on non-200, and the payload has
    // already been logged above for manual follow-up.
  }

  return json({ received: true }, 200);
});
