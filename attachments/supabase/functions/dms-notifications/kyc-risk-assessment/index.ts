// supabase/functions/kyc-risk-assessment/index.ts
// Deploy with: supabase functions deploy kyc-risk-assessment
//
// Input: { kyc_case_id: uuid }
// Admin-only manual trigger to (re)calculate the configured risk
// assessment from whatever checks currently exist on the case — this is
// the same engine processCheckResult() calls automatically once every
// check is terminal, exposed directly for a manual recompute (e.g. after
// changing risk_thresholds in Compliance Settings, or investigating a case).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { finalizeRiskAssessment } from '../_shared/kyc-engine.ts';

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

  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  if (callerProfile?.role !== 'admin') return json({ error: 'Only admins can trigger a manual risk assessment.' }, 403);

  let body: { kyc_case_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!body.kyc_case_id) return json({ error: 'kyc_case_id is required' }, 400);

  const { data: kycCase } = await supabaseAdmin.from('kyc_cases').select('id').eq('id', body.kyc_case_id).single();
  if (!kycCase) return json({ error: 'KYC case not found' }, 404);

  try {
    const assessment = await finalizeRiskAssessment(supabaseAdmin, body.kyc_case_id, user.id);
    return json({ ok: true, assessment });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
