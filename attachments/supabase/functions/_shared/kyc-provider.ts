// ============================================================================
// KYC PROVIDER ABSTRACTION
//
// Zanka is not contracted with a real KYC/credit-bureau provider yet (no
// provider name was given, and picking one — e.g. Smile ID, iiDENTIFii,
// Trulioo for identity, TransUnion/XDS/Compuscan for SA credit bureau data,
// ComplyAdvantage for AML/PEP/sanctions — is a real vendor/compliance
// decision, not something to guess into code). Every function in this
// module is written against the KYCProvider interface below, and the
// PLACEHOLDER implementation is what's actually wired up today, so the
// whole pipeline (consent -> case -> checks -> webhook -> risk score ->
// outcome) is fully wired and testable right now.
//
// SWAPPING IN A REAL PROVIDER: implement KYCProvider against the real
// provider's SDK/REST API in a new class below, add its name to
// getProvider(), and set compliance_settings.provider to that name. No
// database schema change is required — every kyc_checks/kyc_cases column
// this module writes to is provider-agnostic already.
// ============================================================================

export type CheckType =
  | 'identity' | 'id_document' | 'face_match' | 'liveness'
  | 'aml' | 'pep' | 'sanctions'
  | 'bank_account' | 'credit' | 'income' | 'employment' | 'address' | 'rental_history';

export interface CheckInput {
  kycCaseId: string;
  tenantId: string;
  checkType: CheckType;
  // Free-form payload — real providers need different fields per check
  // type (ID number + selfie for identity, account number for bank,
  // etc.). The placeholder ignores most of this; a real adapter would
  // validate/forward exactly what its API needs.
  payload: Record<string, unknown>;
}

export interface CheckResult {
  // 'completed' means the provider answered synchronously (the
  // placeholder always does this). 'in_progress' means the provider will
  // call kyc-provider-webhook later with the real result — a real async
  // provider (most real ones) will return this instead.
  status: 'completed' | 'in_progress' | 'failed';
  provider: string;
  provider_reference: string;
  result?: 'pass' | 'fail' | 'review';
  score?: number; // 0-100
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH';
  failure_reason?: string;
  raw_response?: unknown;
}

export interface KYCProvider {
  name: string;
  createCase(tenantId: string, kycCaseId: string): Promise<{ provider_case_id: string }>;
  verifyIdentity(input: CheckInput): Promise<CheckResult>;
  verifyDocument(input: CheckInput): Promise<CheckResult>;
  verifyBank(input: CheckInput): Promise<CheckResult>;
  screenAML(input: CheckInput): Promise<CheckResult>;
  screenPEP(input: CheckInput): Promise<CheckResult>;
  screenSanctions(input: CheckInput): Promise<CheckResult>;
  runCreditCheck(input: CheckInput): Promise<CheckResult>;
  // Generic fallback for check types without a dedicated method above
  // (liveness, face_match, income, employment, address, rental_history).
  runGenericCheck(input: CheckInput): Promise<CheckResult>;
  getResult(providerReference: string): Promise<CheckResult | null>;
}

function ref(): string {
  return crypto.randomUUID();
}

// Deterministic-but-varied placeholder scoring so the UI and risk engine
// have something realistic to react to during testing, without ever
// pretending to be a real verification. Every raw_response is explicitly
// tagged `simulated: true` so nobody mistakes this for a genuine result.
function simulate(checkType: CheckType, seedInput: Record<string, unknown>): CheckResult {
  const seedStr = JSON.stringify(seedInput) + checkType;
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  const score = hash % 100; // 0-99, deterministic per input so re-testing the same tenant is stable
  const result: CheckResult['result'] = score >= 70 ? 'pass' : score >= 40 ? 'review' : 'fail';
  const risk_level: CheckResult['risk_level'] = score >= 70 ? 'LOW' : score >= 40 ? 'MEDIUM' : 'HIGH';

  return {
    status: 'completed',
    provider: 'placeholder',
    provider_reference: ref(),
    result,
    score,
    risk_level,
    raw_response: { simulated: true, check_type: checkType, score, note: 'PLACEHOLDER PROVIDER — not a real verification. Replace before production use.' },
  };
}

class PlaceholderProvider implements KYCProvider {
  name = 'placeholder';

  async createCase(_tenantId: string, kycCaseId: string) {
    return { provider_case_id: `placeholder-case-${kycCaseId}` };
  }
  async verifyIdentity(input: CheckInput) { return simulate('identity', input.payload); }
  async verifyDocument(input: CheckInput) { return simulate('id_document', input.payload); }
  async verifyBank(input: CheckInput) { return simulate('bank_account', input.payload); }
  async screenAML(input: CheckInput) { return simulate('aml', input.payload); }
  async screenPEP(input: CheckInput) { return simulate('pep', input.payload); }
  async screenSanctions(input: CheckInput) { return simulate('sanctions', input.payload); }
  async runCreditCheck(input: CheckInput) { return simulate('credit', input.payload); }
  async runGenericCheck(input: CheckInput) { return simulate(input.checkType, input.payload); }
  async getResult(_providerReference: string) { return null; } // placeholder never has anything queued
}

export function getProvider(providerName: string): KYCProvider {
  switch (providerName) {
    case 'placeholder':
    default:
      return new PlaceholderProvider();
    // case 'smile_identity': return new SmileIdentityProvider(...);
    // case 'trulioo': return new TruliooProvider(...);
  }
}

// Routes a check type to the right provider method — the one place that
// needs to know the mapping, so kyc-start-check itself stays simple.
export async function runCheck(provider: KYCProvider, input: CheckInput): Promise<CheckResult> {
  switch (input.checkType) {
    case 'identity': return provider.verifyIdentity(input);
    case 'id_document': return provider.verifyDocument(input);
    case 'bank_account': return provider.verifyBank(input);
    case 'aml': return provider.screenAML(input);
    case 'pep': return provider.screenPEP(input);
    case 'sanctions': return provider.screenSanctions(input);
    case 'credit': return provider.runCreditCheck(input);
    default: return provider.runGenericCheck(input);
  }
}
