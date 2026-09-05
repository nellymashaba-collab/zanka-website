// supabase/functions/kyc-complete-review/index.ts
// Deploy with: supabase functions deploy kyc-complete-review
//
// Input: { kyc_case_id, decision: 'approved'|'declined'|'request_information'|'escalated',
//           reason?, notes?, override?: boolean }
// Admin-only. Every decision writes a kyc_reviews row AND a kyc_audit_log
// event. Declining requires a reason. `override: true` lets an admin
// approve even when mandatory KYC hasn't actually completed/passed — this
// is the one explicit, audited exception to "no lease without KYC," and it
// gets its own KYC_OVERRIDE audit event in addition to the normal one.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';
import { writeAuditLog } from '../_shared/kyc-engine.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const DECISION_TO_STATUS: Record<string, string | null> = {
  approved: 'approved',
  declined: 'declined',
  request_information: 'manual_review', // stays in manual_review; INFORMATION_REQUESTED is the signal, not a new kyc_cases.status value
  escalated: 'manual_review',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseAsCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await supabaseAsCaller.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  if (callerProfile?.role !== 'admin') return json({ error: 'Only admins can complete a KYC review.' }, 403);

  let body: { kyc_case_id?: string; decision?: string; reason?: string; notes?: string; override?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const { kyc_case_id, decision, reason, notes, override } = body;

  if (!kyc_case_id || !decision) return json({ error: 'kyc_case_id and decision are required' }, 400);
  if (!Object.keys(DECISION_TO_STATUS).includes(decision)) return json({ error: `Unsupported decision: ${decision}` }, 400);
  if (decision === 'declined' && !reason) return json({ error: 'A reason is required to decline an application.' }, 400);

  const { data: kycCase } = await supabaseAdmin.from('kyc_cases').select('*').eq('id', kyc_case_id).single();
  if (!kycCase) return json({ error: 'KYC case not found' }, 404);

  const isOverride = decision === 'approved' && kycCase.status !== 'manual_review' && kycCase.status !== 'verification_complete';
  if (isOverride && !override) {
    return json({ error: `This case is still ${kycCase.status} — mandatory KYC has not completed. Pass override: true to force approval (this is logged).` }, 409);
  }

  await supabaseAdmin.from('kyc_reviews').insert([{ kyc_case_id, reviewer_id: user.id, decision, reason: reason ?? null, notes: notes ?? null }]);

  const newStatus = DECISION_TO_STATUS[decision];
  const oldStatus = kycCase.status;
  await supabaseAdmin.from('kyc_cases').update({ status: newStatus, review_required: decision === 'request_information' || decision === 'escalated' }).eq('id', kyc_case_id);

  const eventType = decision === 'approved' ? 'APPLICATION_APPROVED' : decision === 'declined' ? 'APPLICATION_DECLINED' : decision === 'request_information' ? 'INFORMATION_REQUESTED' : 'MANUAL_REVIEW_STARTED';
  await writeAuditLog(supabaseAdmin, kyc_case_id, eventType, `Reviewer decision: ${decision}.${reason ? ` Reason: ${reason}` : ''}`, { userId: user.id, oldStatus, newStatus, metadata: { notes } });

  if (isOverride) {
    await writeAuditLog(supabaseAdmin, kyc_case_id, 'KYC_OVERRIDE', `Admin approved without mandatory KYC completion (was ${oldStatus}). Reason: ${reason ?? 'not provided'}.`, { userId: user.id, metadata: { previous_status: oldStatus } });
  }
  if (newStatus === 'approved') {
    await writeAuditLog(supabaseAdmin, kyc_case_id, 'LEASE_ENABLED', 'Digital lease creation is now enabled for this application.', { userId: user.id });
  }

  return json({ ok: true, kyc_case_id, status: newStatus });
});
