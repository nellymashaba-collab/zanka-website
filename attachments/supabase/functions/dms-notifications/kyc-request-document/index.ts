// supabase/functions/kyc-request-document/index.ts
// Deploy with: supabase functions deploy kyc-request-document
//
// Input: { kyc_case_id: uuid, document_type: string, message?: string }
// Admin-only. Records the request as an audit event (there's no separate
// "requested documents" table in the spec'd schema) — the tenant dashboard
// shows "Action Required" by checking for a DOCUMENT_REQUESTED event with
// no later DOCUMENT_UPLOADED of the same document_type.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { writeAuditLog } from '../_shared/kyc-engine.ts';

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
  if (callerProfile?.role !== 'admin') return json({ error: 'Only admins can request additional documents.' }, 403);

  let body: { kyc_case_id?: string; document_type?: string; message?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!body.kyc_case_id || !body.document_type) return json({ error: 'kyc_case_id and document_type are required' }, 400);

  const { data: kycCase } = await supabaseAdmin.from('kyc_cases').select('id, status').eq('id', body.kyc_case_id).single();
  if (!kycCase) return json({ error: 'KYC case not found' }, 404);

  await writeAuditLog(supabaseAdmin, kycCase.id, 'DOCUMENT_REQUESTED', `Requested: ${body.document_type}.${body.message ? ` Note: ${body.message}` : ''}`, {
    userId: user.id,
    metadata: { document_type: body.document_type, message: body.message ?? null },
  });

  return json({ ok: true });
});
