// ============================================================================
// KYC ENGINE — shared by kyc-start-check (synchronous placeholder results)
// and kyc-provider-webhook (asynchronous real-provider callbacks), so both
// code paths finalize a check result, recalculate risk, and advance the
// case status through EXACTLY the same logic. A provider being sync or
// async never changes what happens once a result comes in.
// ============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { CheckResult, CheckType } from './kyc-provider.ts';

export async function writeAuditLog(
  supabaseAdmin: SupabaseClient,
  kycCaseId: string,
  eventType: string,
  eventDescription: string,
  extra: { userId?: string | null; oldStatus?: string | null; newStatus?: string | null; metadata?: Record<string, unknown> } = {}
) {
  await supabaseAdmin.from('kyc_audit_log').insert([{
    kyc_case_id: kycCaseId,
    user_id: extra.userId ?? null,
    event_type: eventType,
    event_description: eventDescription,
    old_status: extra.oldStatus ?? null,
    new_status: extra.newStatus ?? null,
    metadata: extra.metadata ?? null,
  }]);
}

// ---------------------------------------------------------------------------
// Risk scoring — deliberately built from several named, inspectable rules
// rather than one opaque number. `rules_triggered` records exactly which
// rules fired so a reviewer (or an audit) can see WHY a case landed where
// it did, not just a final score.
// ---------------------------------------------------------------------------

interface RiskThresholds { low_max: number; medium_max: number; }

const CHECK_GROUPS: Record<string, CheckType[]> = {
  identity_score: ['identity', 'id_document', 'face_match', 'liveness'],
  credit_score: ['credit'],
  affordability_score: ['income', 'employment'],
  document_score: ['id_document', 'address'],
  aml_score: ['aml', 'pep', 'sanctions'],
};

function average(nums: number[]): number | null {
  const valid = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export function calculateRiskAssessment(
  checks: Array<{ check_type: string; status: string; result: string | null; score: number | null }>,
  thresholds: RiskThresholds
) {
  const rulesTriggered: Array<{ rule: string; description: string; severity: 'info' | 'warning' | 'critical' }> = [];

  const scoreFor = (types: CheckType[]) =>
    average(checks.filter((c) => types.includes(c.check_type as CheckType) && c.score != null).map((c) => c.score as number));

  const identity_score = scoreFor(CHECK_GROUPS.identity_score);
  const credit_score = scoreFor(CHECK_GROUPS.credit_score);
  const affordability_score = scoreFor(CHECK_GROUPS.affordability_score);
  const document_score = scoreFor(CHECK_GROUPS.document_score);
  const aml_score = scoreFor(CHECK_GROUPS.aml_score);

  // Hard rule: any AML/PEP/Sanctions FAIL is a compliance stop regardless
  // of every other score — this can never be averaged away.
  const amlHit = checks.some((c) => CHECK_GROUPS.aml_score.includes(c.check_type as CheckType) && c.result === 'fail');
  if (amlHit) {
    rulesTriggered.push({ rule: 'aml_pep_sanctions_hit', description: 'One or more AML/PEP/Sanctions checks returned a fail result.', severity: 'critical' });
  }

  // Rule: any individual check failing (even a non-AML one) means the
  // overall picture can't be a clean auto-pass, even if the average looks
  // fine — a single failed credit or identity check shouldn't be diluted
  // into a passing blended score.
  const anyFail = checks.some((c) => c.status === 'completed' && c.result === 'fail' && !CHECK_GROUPS.aml_score.includes(c.check_type as CheckType));
  if (anyFail) {
    rulesTriggered.push({ rule: 'individual_check_failed', description: 'At least one completed check returned a fail result.', severity: 'warning' });
  }

  const anyReview = checks.some((c) => c.status === 'completed' && c.result === 'review');
  if (anyReview) {
    rulesTriggered.push({ rule: 'individual_check_review', description: 'At least one completed check returned a review result.', severity: 'info' });
  }

  const anyProviderFailure = checks.some((c) => c.status === 'failed');
  if (anyProviderFailure) {
    rulesTriggered.push({ rule: 'provider_check_failed', description: 'At least one check could not be completed by the provider (a technical failure, not a screening result).', severity: 'warning' });
  }

  const overall_score = average([identity_score, credit_score, affordability_score, document_score, aml_score].filter((s): s is number => s != null));

  let risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  let recommendation: 'PROCEED' | 'REVIEW' | 'DO_NOT_PROCEED';

  if (amlHit || overall_score == null) {
    risk_level = 'HIGH';
    recommendation = 'DO_NOT_PROCEED';
  } else if (anyProviderFailure) {
    // A technical failure is never silently treated as a pass — see
    // "Never silently mark a failed verification as passed."
    risk_level = 'HIGH';
    recommendation = 'REVIEW';
  } else if (overall_score <= thresholds.low_max) {
    risk_level = 'HIGH';
    recommendation = 'DO_NOT_PROCEED';
  } else if (overall_score <= thresholds.medium_max) {
    risk_level = 'MEDIUM';
    recommendation = 'REVIEW';
  } else {
    risk_level = 'LOW';
    recommendation = anyFail || anyReview ? 'REVIEW' : 'PROCEED';
  }

  return { identity_score, credit_score, affordability_score, document_score, aml_score, overall_score, risk_level, recommendation, rules_triggered: rulesTriggered };
}

// ---------------------------------------------------------------------------
// Finalizes ONE check result (from either the synchronous placeholder or a
// real provider's webhook callback), then — if every check on the case has
// now reached a terminal state — recalculates the risk assessment and
// advances kyc_cases.status accordingly.
// ---------------------------------------------------------------------------

export async function processCheckResult(
  supabaseAdmin: SupabaseClient,
  kycCheckId: string,
  result: CheckResult,
  actingUserId: string | null
) {
  const { data: check } = await supabaseAdmin.from('kyc_checks').select('*, kyc_cases(*)').eq('id', kycCheckId).single();
  if (!check) throw new Error(`kyc_checks row ${kycCheckId} not found`);

  const newStatus = result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : 'in_progress';

  await supabaseAdmin.from('kyc_checks').update({
    status: newStatus,
    result: result.result ?? null,
    score: result.score ?? null,
    risk_level: result.risk_level ?? null,
    provider: result.provider,
    provider_reference: result.provider_reference,
    failure_reason: result.failure_reason ?? null,
    raw_response: result.raw_response ?? null,
    completed_at: newStatus === 'completed' || newStatus === 'failed' ? new Date().toISOString() : null,
  }).eq('id', kycCheckId);

  await writeAuditLog(supabaseAdmin, check.kyc_case_id, newStatus === 'failed' ? 'CHECK_FAILED' : 'CHECK_COMPLETED',
    `${check.check_type} check ${newStatus}${result.result ? ` (${result.result})` : ''}`,
    { userId: actingUserId, metadata: { check_type: check.check_type, provider: result.provider, provider_reference: result.provider_reference } });

  if (newStatus === 'in_progress') return; // still waiting on the provider — nothing else to do yet

  // Has every check for this case reached a terminal state?
  const { data: allChecks } = await supabaseAdmin.from('kyc_checks').select('check_type, status, result, score').eq('kyc_case_id', check.kyc_case_id);
  const allTerminal = (allChecks || []).every((c) => ['completed', 'failed', 'expired', 'cancelled'].includes(c.status));
  if (!allTerminal) return; // other checks still pending — wait for them too

  await finalizeRiskAssessment(supabaseAdmin, check.kyc_case_id, actingUserId);
}

// Recalculates the risk assessment from whatever checks currently exist on
// the case and advances kyc_cases.status accordingly. Called automatically
// from processCheckResult() once every check is terminal, and also exposed
// directly as the kyc-risk-assessment Edge Function for an admin-triggered
// manual recompute.
export async function finalizeRiskAssessment(supabaseAdmin: SupabaseClient, kycCaseId: string, actingUserId: string | null) {
  const { data: caseRow } = await supabaseAdmin.from('kyc_cases').select('status').eq('id', kycCaseId).single();
  if (!caseRow) throw new Error(`kyc_cases row ${kycCaseId} not found`);

  const { data: allChecks } = await supabaseAdmin.from('kyc_checks').select('check_type, status, result, score').eq('kyc_case_id', kycCaseId);

  const { data: settingsRow } = await supabaseAdmin.from('compliance_settings').select('*').limit(1).single();
  const thresholds = (settingsRow?.risk_thresholds as RiskThresholds) ?? { low_max: 39, medium_max: 69 };
  const assessment = calculateRiskAssessment(allChecks || [], thresholds);

  await supabaseAdmin.from('kyc_risk_assessments').insert([{
    kyc_case_id: kycCaseId,
    identity_score: assessment.identity_score,
    credit_score: assessment.credit_score,
    affordability_score: assessment.affordability_score,
    document_score: assessment.document_score,
    aml_score: assessment.aml_score,
    overall_score: assessment.overall_score,
    risk_level: assessment.risk_level,
    recommendation: assessment.recommendation,
    rules_triggered: assessment.rules_triggered,
  }]);

  const requireManualReview = settingsRow?.require_manual_review ?? true;
  const oldCaseStatus = caseRow.status;

  let newCaseStatus: string;
  let reviewRequired = false;
  let reviewReason: string | null = null;

  if (assessment.recommendation === 'PROCEED' && !requireManualReview) {
    newCaseStatus = 'approved';
  } else {
    // Every other outcome — REVIEW, DO_NOT_PROCEED, or PROCEED-but-
    // manual-review-is-mandatory — lands in manual_review. The system
    // never auto-declines; a human always makes that call via
    // kyc-complete-review, which is what actually writes a kyc_reviews row.
    newCaseStatus = 'manual_review';
    reviewRequired = true;
    reviewReason = assessment.rules_triggered.length > 0
      ? assessment.rules_triggered.map((r) => r.description).join(' ')
      : (requireManualReview ? 'Manual review required by compliance settings.' : 'Risk assessment recommends review.');
  }

  await supabaseAdmin.from('kyc_cases').update({
    status: newCaseStatus,
    overall_result: assessment.recommendation,
    risk_level: assessment.risk_level,
    completed_at: new Date().toISOString(),
    review_required: reviewRequired,
    review_reason: reviewReason,
  }).eq('id', kycCaseId);

  await writeAuditLog(supabaseAdmin, kycCaseId, newCaseStatus === 'manual_review' ? 'MANUAL_REVIEW_STARTED' : 'APPLICATION_APPROVED',
    `Risk assessment complete: ${assessment.recommendation} (${assessment.risk_level}). Case moved to ${newCaseStatus}.`,
    { userId: actingUserId, oldStatus: oldCaseStatus, newStatus: newCaseStatus, metadata: { overall_score: assessment.overall_score } });

  return assessment;
}
