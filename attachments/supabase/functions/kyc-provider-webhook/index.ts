// supabase/functions/kyc-provider-webhook/index.ts
// Deploy with: supabase functions deploy kyc-provider-webhook --no-verify-jwt
//   (--no-verify-jwt is required: the provider calling this has no Supabase
//   session/JWT — authenticity is verified via HMAC signature instead, below)
//
// SECRETS REQUIRED: KYC_WEBHOOK_SECRET — a shared secret only Zanka and the
// real provider know. Set via: supabase secrets set KYC_WEBHOOK_SECRET=...
// (The placeholder provider signs its own simulated callbacks with this
// same secret in kyc-start-check's flow — no separate config needed for
// testing.)
//
// NORMALIZED PAYLOAD CONTRACT this endpoint expects (a real provider
// adapter is responsible for translating ITS OWN webhook shape into this
// one before/while calling processCheckResult — that translation is the
// only provider-specific code that belongs in this file):
//   {
//     provider: string,
//     provider_reference: string,
//     status: 'completed' | 'failed',
//     result?: 'pass' | 'fail' | 'review',
//     score?: number,
//     risk_level?: 'LOW' | 'MEDIUM' | 'HIGH',
//     failure_reason?: string,
//     raw_response?: unknown,
//   }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { processCheckResult } from '../_shared/kyc-engine.ts';
import type { CheckResult } from '../_shared/kyc-provider.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('KYC_WEBHOOK_SECRET');
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET) {
    console.error('KYC_WEBHOOK_SECRET is not set — refusing to process webhook (fail closed, not open).');
    return false;
  }
  if (!signatureHeader) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const macBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(macBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Constant-time-ish comparison — signature headers are short-ish (64
  // hex chars) so this isn't a hot timing-attack path, but avoid the
  // trivially-optimizable `===` short-circuit anyway.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

// Very small in-memory rate limiter — resets on cold start, which is fine
// here: its only job is to blunt an obvious retry storm within one warm
// instance, not to be a durable global limiter.
const recentByReference = new Map<string, number>();
function isRateLimited(reference: string): boolean {
  const now = Date.now();
  const count = recentByReference.get(reference) ?? 0;
  if (count > 20) return true; // something is very wrong if the same reference fires >20x
  recentByReference.set(reference, count + 1);
  for (const [ref, ts] of recentByReference) if (now - ts > 60_000) recentByReference.delete(ref);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const rawBody = await req.text();
  const signature = req.headers.get('x-webhook-signature');
  if (!(await verifySignature(rawBody, signature))) {
    console.error('KYC webhook signature verification failed.');
    return json({ error: 'Invalid signature' }, 401);
  }

  let payload: Partial<CheckResult> & { provider_reference?: string };
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { provider, provider_reference } = payload;
  if (!provider || !provider_reference) return json({ error: 'provider and provider_reference are required' }, 400);
  if (!['completed', 'failed'].includes(payload.status ?? '')) return json({ error: "status must be 'completed' or 'failed'" }, 400);

  if (isRateLimited(`${provider}:${provider_reference}`)) {
    console.error(`Rate limit hit for webhook reference ${provider}:${provider_reference} — possible retry storm.`);
    return json({ received: true, note: 'rate limited, no further processing' }, 200);
  }

  const { data: check } = await supabaseAdmin.from('kyc_checks').select('id, status').eq('provider', provider).eq('provider_reference', provider_reference).maybeSingle();

  if (!check) {
    // Unknown reference — either a stale retry for something already
    // cleaned up, or a genuine bug on the provider's side. Return 200 so
    // the provider stops retrying; this is logged, not silently dropped.
    console.error(`Webhook for unknown provider_reference ${provider}:${provider_reference} — no matching kyc_checks row.`);
    return json({ received: true, matched: false }, 200);
  }

  // IDEMPOTENCY: if this check has already reached a terminal state,
  // treat this as a duplicate/retry and do nothing further — this is what
  // stops provider retries from creating duplicate results or duplicate
  // downstream decisions (a second risk assessment, a second audit event,
  // etc.).
  if (['completed', 'failed', 'expired', 'cancelled'].includes(check.status)) {
    return json({ received: true, matched: true, already_processed: true }, 200);
  }

  try {
    await processCheckResult(supabaseAdmin, check.id, payload as CheckResult, null);
  } catch (err) {
    console.error('Error processing KYC webhook:', (err as Error).message);
    return json({ error: 'Internal error processing webhook' }, 500);
  }

  return json({ received: true, matched: true }, 200);
});
