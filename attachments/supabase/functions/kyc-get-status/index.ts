// supabase/functions/kyc-get-status/index.ts
// Deploy with: supabase functions deploy kyc-get-status
//
// Input: { kyc_case_id: uuid } OR { application_id: number } (a leases.id —
// leases.id is bigint on this database, not uuid — looks up that lease's
// most recent KYC case). application_id exists
// because owners have no direct RLS read on kyc_cases (by design — see
// 022_kyc_module.sql), so the owner dashboard has no other way to learn
// a case's id before asking for its status. Returns null (not 404) when
// application_id is supplied and simply has no KYC case yet, so the
// frontend can render "Not started" instead of treating it as an error.
//
// Returns a DIFFERENT, deliberately curated shape depending on who's
// asking — tenant, owner, property manager, or admin — rather than one
// generic payload the frontend filters client-side (that would mean the
// sensitive fields travel over the wire regardless). Never returns
// provider credentials, raw_response, or another applicant's data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS_HEADERS, json } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const TENANT_FRIENDLY_STATUS: Record<string, string> = {
  pending_consent: 'Consent Required',
  consent_given: 'Verification In Progress',
  in_progress: 'Verification In Progress',
  verification_complete: 'Verification Complete',
  manual_review: 'Under Review',
  approved: 'Approved',
  declined: 'Declined',
  expired: 'Action Required',
  cancelled: 'Not Started',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseAsCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await supabaseAsCaller.auth.getUser();
  if (!user) return json({ error: 'Not authenticated' }, 401);

  let body: { kyc_case_id?: string; application_id?: number };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!body.kyc_case_id && !body.application_id) return json({ error: 'kyc_case_id or application_id is required' }, 400);

  let kycCase;
  if (body.kyc_case_id) {
    const { data } = await supabaseAdmin.from('kyc_cases').select('*, properties:property_id ( address, owner_id )').eq('id', body.kyc_case_id).single();
    kycCase = data;
    if (!kycCase) return json({ error: 'KYC case not found' }, 404);
  } else {
    const { data } = await supabaseAdmin.from('kyc_cases').select('*, properties:property_id ( address, owner_id )').eq('application_id', body.application_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    kycCase = data;
    if (!kycCase) return json({ kyc_case_id: null, status: 'not_started' }); // no case yet for this lease — not an error
  }

  const { data: callerProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  const isAdmin = callerProfile?.role === 'admin';
  const isTenant = kycCase.tenant_id === user.id;

  const { data: pmAssignment } = await supabaseAdmin.from('property_manager_assignments').select('id').eq('property_manager_id', user.id).eq('property_id', kycCase.property_id).maybeSingle();
  const isPropertyManager = !!pmAssignment;

  const { data: effectiveOwnerId } = await supabaseAdmin.rpc('get_effective_owner_id', { p_property_id: kycCase.property_id }).maybeSingle().then((r) => r).catch(() => ({ data: null }));
  const isOwner = kycCase.properties?.owner_id === user.id || effectiveOwnerId === user.id;

  if (!isAdmin && !isTenant && !isPropertyManager && !isOwner) return json({ error: 'Not authorised for this KYC case' }, 403);

  // ---- TENANT: friendly status + per-check pending/complete labels, no scores/notes ----
  if (isTenant && !isAdmin) {
    const { data: checks } = await supabaseAdmin.from('kyc_checks').select('check_type, status, result').eq('kyc_case_id', kycCase.id);
    const { data: docsRequested } = await supabaseAdmin.from('kyc_audit_log').select('metadata, created_at').eq('kyc_case_id', kycCase.id).eq('event_type', 'DOCUMENT_REQUESTED').order('created_at', { ascending: false }).limit(1).maybeSingle();

    return json({
      kyc_case_id: kycCase.id,
      status: TENANT_FRIENDLY_STATUS[kycCase.status] ?? kycCase.status,
      consent_given: kycCase.consent_given,
      action_required: !!docsRequested,
      document_request: docsRequested ? { requested_at: docsRequested.created_at, ...(docsRequested.metadata as object) } : null,
      checks: (checks || []).map((c) => ({
        check_type: c.check_type,
        label: c.status === 'completed' ? (c.result === 'fail' ? 'Needs Attention' : 'Complete') : c.status === 'failed' ? 'Needs Attention' : c.status === 'in_progress' ? 'In Progress' : 'Pending',
      })),
    });
  }

  // ---- OWNER: restricted summary only, per the spec's exact example shape ----
  if (isOwner && !isAdmin && !isPropertyManager) {
    const { data: tenantProfile } = await supabaseAdmin.from('profiles').select('full_name').eq('id', kycCase.tenant_id).single();
    const { data: checks } = await supabaseAdmin.from('kyc_checks').select('check_type, status, result').eq('kyc_case_id', kycCase.id);
    const { data: assessment } = await supabaseAdmin.from('kyc_risk_assessments').select('recommendation, risk_level, affordability_score').eq('kyc_case_id', kycCase.id).order('assessed_at', { ascending: false }).limit(1).maybeSingle();

    const identityChecks = (checks || []).filter((c) => ['identity', 'id_document'].includes(c.check_type));
    const identityVerified = identityChecks.length > 0 && identityChecks.every((c) => c.status === 'completed' && c.result === 'pass');
    const allTerminal = (checks || []).length > 0 && (checks || []).every((c) => ['completed', 'failed'].includes(c.status));
    const affordabilityCheck = (checks || []).find((c) => c.check_type === 'income' || c.check_type === 'employment');

    return json({
      tenant_name: tenantProfile?.full_name ?? 'Applicant',
      identity: identityVerified ? 'Verified' : 'Not Verified',
      screening: allTerminal ? 'Complete' : 'In Progress',
      affordability: affordabilityCheck ? (affordabilityCheck.result === 'pass' ? 'Pass' : affordabilityCheck.result === 'fail' ? 'Fail' : 'Pending') : 'Pending',
      risk: assessment?.risk_level ?? 'Pending',
      recommendation: assessment?.recommendation ?? 'Pending',
    });
  }

  // ---- ADMIN / PROPERTY MANAGER: full curated detail, still without raw_response ----
  const [{ data: checks }, { data: documents }, { data: assessment }, { data: reviews }, { data: audit }] = await Promise.all([
    supabaseAdmin.from('kyc_checks').select('id, check_type, status, result, score, risk_level, provider, started_at, completed_at, failure_reason').eq('kyc_case_id', kycCase.id),
    supabaseAdmin.from('kyc_documents').select('id, document_type, file_name, verification_status, uploaded_at, storage_path').eq('kyc_case_id', kycCase.id),
    supabaseAdmin.from('kyc_risk_assessments').select('*').eq('kyc_case_id', kycCase.id).order('assessed_at', { ascending: false }).limit(1).maybeSingle(),
    isPropertyManager && !isAdmin ? Promise.resolve({ data: [] }) : supabaseAdmin.from('kyc_reviews').select('*, profiles:reviewer_id ( full_name )').eq('kyc_case_id', kycCase.id).order('reviewed_at', { ascending: false }),
    isPropertyManager && !isAdmin ? Promise.resolve({ data: [] }) : supabaseAdmin.from('kyc_audit_log').select('*').eq('kyc_case_id', kycCase.id).order('created_at', { ascending: false }),
  ]);

  return json({
    kyc_case_id: kycCase.id, status: kycCase.status, overall_result: kycCase.overall_result, risk_level: kycCase.risk_level,
    review_required: kycCase.review_required, review_reason: isPropertyManager && !isAdmin ? null : kycCase.review_reason,
    property_address: kycCase.properties?.address, checks, documents, risk_assessment: assessment,
    reviews: reviews ?? [], audit_log: audit ?? [],
  });
});
