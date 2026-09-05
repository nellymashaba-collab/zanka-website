// supabase/functions/kyc-create-case/index.ts
// Deploy with: supabase functions deploy kyc-create-case
//
// Input: { application_id: number (a Draft lease id — leases.id is bigint on this database, not uuid), tenant_id: uuid, requested_checks: string[] }
// Creates the kyc_cases row plus one kyc_checks row per requested check
// type, both starting in a pending state. Nothing is called out to a
// provider yet — that happens per-check in kyc-start-check, only once
// consent has been captured.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { writeAuditLog } from '../_shared/kyc-engine.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const VALID_CHECK_TYPES = ['identity','id_document','face_match','liveness','aml','pep','sanctions','bank_account','credit','income','employment','address','rental_history'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseAsCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await supabaseAsCaller.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  let body: { application_id?: number; tenant_id?: string; requested_checks?: string[] };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { application_id, tenant_id, requested_checks } = body;
  if (!application_id || !tenant_id || !Array.isArray(requested_checks) || requested_checks.length === 0) {
    return json({ error: 'application_id, tenant_id and a non-empty requested_checks[] are required' }, 400);
  }
  const invalidTypes = requested_checks.filter((t) => !VALID_CHECK_TYPES.includes(t));
  if (invalidTypes.length > 0) return json({ error: `Unsupported check type(s): ${invalidTypes.join(', ')}` }, 400);

  // Authorisation: the caller must be an admin, OR must BE the tenant on
  // this lease creating their own case.
  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  const isAdmin = callerProfile?.role === 'admin';

  const { data: lease, error: leaseError } = await supabaseAdmin.from('leases').select('id, tenant_id, property_id').eq('id', application_id).single();
  if (leaseError || !lease) return json({ error: 'That application (lease) does not exist.' }, 404);
  if (!isAdmin && (user.id !== tenant_id || lease.tenant_id !== tenant_id)) {
    return json({ error: 'Not authorised to create a KYC case for this application.' }, 403);
  }
  if (lease.tenant_id !== tenant_id) return json({ error: 'tenant_id does not match this application.' }, 400);

  // Friendly pre-check before hitting the DB's own uniqueness guard.
  const { data: existing } = await supabaseAdmin.from('kyc_cases').select('id, status')
    .eq('application_id', application_id).not('status', 'in', '("declined","expired","cancelled")').maybeSingle();
  if (existing) return json({ error: 'An active KYC case already exists for this application.', kyc_case_id: existing.id }, 409);

  const { data: kycCase, error: caseError } = await supabaseAdmin.from('kyc_cases').insert([{
    application_id, tenant_id, property_id: lease.property_id, status: 'pending_consent',
  }]).select().single();
  if (caseError) return json({ error: caseError.message }, 500);

  const checkRows = requested_checks.map((check_type) => ({ kyc_case_id: kycCase.id, check_type, status: 'pending' }));
  const { data: checks, error: checksError } = await supabaseAdmin.from('kyc_checks').insert(checkRows).select();
  if (checksError) return json({ error: checksError.message }, 500);

  await writeAuditLog(supabaseAdmin, kycCase.id, 'KYC_CASE_CREATED', `KYC case created with ${requested_checks.length} requested check(s): ${requested_checks.join(', ')}.`, { userId: user.id, newStatus: 'pending_consent' });

  return json({ kyc_case_id: kycCase.id, status: kycCase.status, checks: checks.map((c) => ({ id: c.id, check_type: c.check_type, status: c.status })) });
});
