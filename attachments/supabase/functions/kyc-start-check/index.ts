// supabase/functions/kyc-start-check/index.ts
// Deploy with: supabase functions deploy kyc-start-check
//
// Input: { kyc_case_id: uuid, check_type: string }
// Validates consent + authorisation, calls the configured provider
// server-side (never from the browser), and saves the provider reference.
// If the provider answers synchronously (the placeholder always does),
// finalizes the result immediately via the same shared engine the webhook
// uses — a provider being sync or async never changes the calling code.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { getProvider, runCheck } from '../_shared/kyc-provider.ts';
import { writeAuditLog, processCheckResult } from '../_shared/kyc-engine.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseAsCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await supabaseAsCaller.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  let body: { kyc_case_id?: string; check_type?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const { kyc_case_id, check_type } = body;
  if (!kyc_case_id || !check_type) return json({ error: 'kyc_case_id and check_type are required' }, 400);

  const { data: kycCase } = await supabaseAdmin.from('kyc_cases').select('*').eq('id', kyc_case_id).single();
  if (!kycCase) return json({ error: 'KYC case not found' }, 404);

  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  const isAdmin = callerProfile?.role === 'admin';
  if (!isAdmin && kycCase.tenant_id !== user.id) return json({ error: 'Not authorised for this KYC case' }, 403);

  // "Only allow verification to begin once required consent has been
  // captured" — enforced server-side, not just by hiding a button.
  if (!kycCase.consent_given) return json({ error: 'Consent has not been captured for this case yet.' }, 403);

  if (['approved', 'declined', 'expired', 'cancelled'].includes(kycCase.status)) {
    return json({ error: `This case is already ${kycCase.status} — checks cannot be started.` }, 409);
  }

  const { data: check } = await supabaseAdmin.from('kyc_checks').select('*').eq('kyc_case_id', kyc_case_id).eq('check_type', check_type).single();
  if (!check) return json({ error: `No ${check_type} check was requested on this case.` }, 404);
  if (check.status !== 'pending') return json({ error: `This check is already ${check.status}.` }, 409);

  const { data: settingsRow } = await supabaseAdmin.from('compliance_settings').select('*').limit(1).single();
  const enabledChecks = (settingsRow?.enabled_checks as Record<string, boolean>) ?? {};
  if (enabledChecks[check_type] === false) return json({ error: `${check_type} checks are currently disabled in Compliance Settings.` }, 403);

  const providerName = settingsRow?.provider ?? 'placeholder';
  const provider = getProvider(providerName);

  await supabaseAdmin.from('kyc_checks').update({ status: 'in_progress', provider: providerName, started_at: new Date().toISOString() }).eq('id', check.id);
  if (!kycCase.started_at) await supabaseAdmin.from('kyc_cases').update({ status: 'in_progress', started_at: new Date().toISOString() }).eq('id', kyc_case_id);

  await writeAuditLog(supabaseAdmin, kyc_case_id, 'CHECK_STARTED', `${check_type} check started via ${providerName}.`, { userId: user.id });

  let result;
  try {
    result = await runCheck(provider, { kycCaseId: kyc_case_id, tenantId: kycCase.tenant_id, checkType: check_type, payload: {} });
  } catch (err) {
    // Provider timeout / API failure — never silently mark this as passed.
    await supabaseAdmin.from('kyc_checks').update({ status: 'failed', failure_reason: (err as Error).message, completed_at: new Date().toISOString() }).eq('id', check.id);
    await writeAuditLog(supabaseAdmin, kyc_case_id, 'CHECK_FAILED', `${check_type} check failed to start: ${(err as Error).message}`, { userId: user.id });
    return json({ error: `Provider error starting ${check_type} check: ${(err as Error).message}` }, 502);
  }

  await supabaseAdmin.from('kyc_checks').update({ provider_reference: result.provider_reference }).eq('id', check.id);

  if (result.status === 'completed' || result.status === 'failed') {
    await processCheckResult(supabaseAdmin, check.id, result, user.id);
  }

  return json({ kyc_case_id, check_type, status: result.status === 'in_progress' ? 'in_progress' : result.status });
});
