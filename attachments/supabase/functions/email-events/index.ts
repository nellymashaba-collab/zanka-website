// supabase/functions/email-events/index.ts
// Deno runtime. Receives Resend's delivery webhooks and adds them to the
// evidence trail for formal notices (029_notice_evidence.sql): when an email
// was sent, delivered, delayed, bounced or marked as spam.
//
// Deploy: Edge Functions → Deploy a new function → Via editor → name it
// `email-events` → paste this file. Then turn OFF "Verify JWT" / "Enforce JWT
// verification" for this function: Resend cannot send a Supabase login.
// Instead every request is checked against Resend's signing secret.
//
// Secrets: RESEND_WEBHOOK_SECRET (the "whsec_…" signing secret shown in
// Resend → Webhooks). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const TOLERANCE_SECONDS = 5 * 60;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "id.timestamp.body",
// keyed with the base64 part of the whsec_ secret. The header can hold
// several space-separated "v1,<signature>" values.
export async function verifySignature(secret: string, id: string, timestamp: string, body: string, signatureHeader: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', base64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = bytesToBase64(mac);
  return signatureHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && !!sig && timingSafeEqual(sig, expected);
  });
}

// deno-lint-ignore no-explicit-any
export async function handle(req: Request, db: any, secret: string | undefined): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!secret) return json({ error: 'RESEND_WEBHOOK_SECRET is not set' }, 500);
  const body = await req.text();
  const id = req.headers.get('svix-id') || '';
  const ok = await verifySignature(secret, id, req.headers.get('svix-timestamp') || '', body, req.headers.get('svix-signature') || '');
  if (!ok) return json({ error: 'Invalid signature' }, 401);

  // deno-lint-ignore no-explicit-any
  let event: any;
  try { event = JSON.parse(body); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const messageId = event?.data?.email_id;
  if (!messageId || !event?.type) return json({ ok: true, ignored: 'not an email event' });

  // Keep only what proves delivery; drop the rest of the payload.
  const payload = {
    type: event.type,
    created_at: event.created_at ?? null,
    to: event.data.to ?? null,
    subject: event.data.subject ?? null,
    bounce: event.data.bounce ?? null,
  };
  const { data, error } = await db.rpc('record_email_event', {
    p_webhook_id: id, p_message_id: messageId, p_event_type: String(event.type),
    p_occurred_at: event.created_at || null, p_payload: payload,
  });
  if (error) return json({ error: error.message }, 500); // Resend retries
  return json({ ok: true, stored: data === true });
}

if (typeof Deno !== 'undefined' && Deno.serve) {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  Deno.serve((req: Request) => handle(req, db, Deno.env.get('RESEND_WEBHOOK_SECRET')));
}
