// Zanka Group — tenant screening engine.
//
// Pure functions, no DOM and no database: the admin screening page uses
// them live as you capture verification results, and they can be tested
// on their own (node). Every threshold comes from the
// rental_recruitment_settings row, never from this file.
//
// Two stages, as in the Tenant Recruitment & Screening Pack:
//   1. Knockouts — any one failed means Decline, whatever the score.
//   2. A score out of 100 across six weighted factors.
// Decision: knockout -> Decline; score >= approve_min -> Approve;
// score >= conditional_min -> Conditional (surety or extra deposit);
// otherwise Decline. Missing verification inputs -> Incomplete.

(function (root) {
  const DEFAULT_SETTINGS = {
    affordability_knockout_max: 0.35,
    affordability_full_max: 0.25,
    affordability_half_max: 0.30,
    credit_full_min: 650,
    credit_half_min: 600,
    debt_full_max: 0.20,
    debt_half_max: 0.35,
    approve_min_score: 70,
    conditional_min_score: 60,
  };

  const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

  // Whole months between two ISO dates (a before b). Day-of-month aware.
  function monthsBetween(a, b) {
    if (!a || !b) return null;
    const d1 = new Date(a + 'T00:00:00Z');
    const d2 = new Date(b + 'T00:00:00Z');
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
    let m = (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12 + (d2.getUTCMonth() - d1.getUTCMonth());
    if (d2.getUTCDate() < d1.getUTCDate()) m -= 1;
    return m;
  }

  function settingsWithDefaults(s) {
    const out = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (s && num(s[k]) !== null) out[k] = Number(s[k]);
    }
    return out;
  }

  // app      = rental_applications row (applicant inputs + admin screening inputs)
  // vacancy  = rental_vacancies row (monthly_rent, max_occupants)
  // settings = rental_recruitment_settings row
  // today    = 'YYYY-MM-DD' (injectable for tests)
  function evaluateApplication(app, vacancy, settings, today) {
    const s = settingsWithDefaults(settings);
    const asOf = today || new Date().toISOString().slice(0, 10);
    const rent = num(vacancy && vacancy.monthly_rent);
    const gross = (num(app.gross_monthly_income) || 0) + (num(app.other_monthly_income) || 0);
    const net = num(app.net_monthly_income);
    const debt = num(app.monthly_debt_instalments) || 0;

    const affordability = rent !== null && gross > 0 ? rent / gross : null;
    const debtRatio = net && net > 0 ? debt / net : null;
    const missing = [];

    // ---------------- Stage 1: knockouts ----------------
    const knockouts = [
      {
        key: 'affordability',
        label: `Rent is more than ${pct(s.affordability_knockout_max)} of gross household income`,
        failed: affordability === null ? null : affordability > s.affordability_knockout_max,
        detail: affordability === null ? 'Income or rent missing' : `Rent is ${pct(affordability)} of gross income`,
      },
      {
        key: 'adverse',
        label: 'Unexplained or unsettled judgment, or adverse rental listing, in the last 3 years',
        failed: app.adverse_listing_found === null || app.adverse_listing_found === undefined ? null : !!app.adverse_listing_found,
        detail: app.adverse_listing_found === null || app.adverse_listing_found === undefined ? 'Credit report not yet captured' : (app.adverse_listing_found ? 'Found on credit report' : 'None found'),
      },
      {
        key: 'landlord',
        label: 'Negative reference from current landlord (arrears, damage, eviction)',
        failed: app.landlord_reference ? app.landlord_reference === 'negative' : null,
        detail: app.landlord_reference ? `Reference: ${app.landlord_reference.replace('_', ' ')}` : 'Reference not yet captured',
      },
      {
        key: 'documents',
        label: 'A document is altered, or does not match the bureau, bank or employer',
        failed: !!app.document_mismatch,
        detail: app.document_mismatch ? 'Mismatch recorded' : 'No mismatch recorded',
      },
      {
        key: 'consent',
        label: 'POPIA consent not signed',
        failed: app.has_consent === false,
        detail: app.has_consent === false ? 'No consent on file' : 'Signed at submission',
      },
      {
        key: 'occupants',
        label: 'More occupants than the unit allows',
        failed: vacancy && num(vacancy.max_occupants) !== null ? (num(app.occupant_count) || 1) > Number(vacancy.max_occupants) : false,
        detail: vacancy && num(vacancy.max_occupants) !== null ? `${num(app.occupant_count) || 1} of max ${vacancy.max_occupants}` : 'No limit set on vacancy',
      },
    ];
    const knockoutFailed = knockouts.some((k) => k.failed === true);

    // ---------------- Stage 2: score ----------------
    const factors = [];

    // Affordability (30)
    {
      let points = null, band = 'missing';
      if (affordability !== null) {
        if (affordability <= s.affordability_full_max) { points = 30; band = 'full'; }
        else if (affordability <= s.affordability_half_max) { points = 15; band = 'half'; }
        else { points = 0; band = 'zero'; }
      } else missing.push('income');
      factors.push({ key: 'affordability', label: 'Affordability (rent ÷ gross income)', weight: 30, points, band,
        reason: affordability === null ? 'Income or rent missing' : `${pct(affordability)} of gross income` });
    }

    // Credit score (20)
    {
      const cs = num(app.credit_score);
      let points = null, band = 'missing';
      if (cs !== null) {
        if (cs >= s.credit_full_min) { points = 20; band = 'full'; }
        else if (cs >= s.credit_half_min) { points = 10; band = 'half'; }
        else { points = 0; band = 'zero'; }
      } else missing.push('credit score');
      factors.push({ key: 'credit', label: 'Credit score', weight: 20, points, band,
        reason: cs === null ? 'Not yet captured' : `${cs}${app.credit_bureau ? ' (' + app.credit_bureau + ')' : ''}` });
    }

    // Landlord reference (20)
    {
      const ref = app.landlord_reference;
      const map = { positive: [20, 'full', 'Paid on time, would rent again'], minor_late: [10, 'half', 'Minor late payments, resolved'],
        none: [0, 'zero', 'No reference (first-time renter)'], negative: [0, 'zero', 'Negative reference (knockout)'] };
      const hit = map[ref];
      if (!hit) missing.push('landlord reference');
      factors.push({ key: 'landlord', label: 'Landlord reference', weight: 20, points: hit ? hit[0] : null, band: hit ? hit[1] : 'missing',
        reason: hit ? hit[2] : 'Not yet captured' });
    }

    // Employment stability (15)
    {
      const type = app.employment_type;
      const tenure = monthsBetween(app.employment_start_date, asOf);
      const left = monthsBetween(asOf, app.contract_end_date);
      let points = null, band = 'missing', reason = 'Employment details missing';
      if (type === 'Permanent' && tenure !== null) {
        if (tenure >= 12) { points = 15; band = 'full'; reason = `Permanent, ${tenure} months`; }
        else { points = 7.5; band = 'half'; reason = `Permanent, ${tenure} months (under 12)`; }
      } else if (type === 'Contract' && left !== null) {
        if (left >= 6) { points = 7.5; band = 'half'; reason = `Contract, ${left} months left`; }
        else { points = 0; band = 'zero'; reason = `Contract, ${Math.max(left, 0)} months left`; }
      } else if (type === 'Self-employed' && tenure !== null) {
        // The pack scores self-employed under 2 years as zero; 2+ years is
        // treated as half marks (income less certain than permanent).
        if (tenure >= 24) { points = 7.5; band = 'half'; reason = `Self-employed, ${Math.floor(tenure / 12)} years`; }
        else { points = 0; band = 'zero'; reason = `Self-employed, ${tenure} months (under 2 years)`; }
      } else if (type === 'Other') {
        points = 0; band = 'zero'; reason = 'Other income type';
      }
      if (points === null) missing.push('employment dates');
      factors.push({ key: 'employment', label: 'Employment stability', weight: 15, points, band, reason });
    }

    // Debt burden (10)
    {
      let points = null, band = 'missing';
      if (debtRatio !== null) {
        if (debtRatio <= s.debt_full_max) { points = 10; band = 'full'; }
        else if (debtRatio <= s.debt_half_max) { points = 5; band = 'half'; }
        else { points = 0; band = 'zero'; }
      } else missing.push('net income');
      factors.push({ key: 'debt', label: 'Debt burden (instalments ÷ net income)', weight: 10, points, band,
        reason: debtRatio === null ? 'Net income missing' : `${pct(debtRatio)} of net income` });
    }

    // Application quality (5)
    {
      const map = { complete: [5, 'full', 'Complete first time, prompt'], follow_up: [2.5, 'half', 'Needed follow-up'], chasing: [0, 'zero', 'Repeated chasing'] };
      const hit = map[app.application_quality];
      if (!hit) missing.push('application quality');
      factors.push({ key: 'quality', label: 'Application quality', weight: 5, points: hit ? hit[0] : null, band: hit ? hit[1] : 'missing',
        reason: hit ? hit[2] : 'Not yet rated' });
    }

    const total = factors.reduce((t, f) => t + (f.points || 0), 0);
    const complete = factors.every((f) => f.points !== null);

    let recommendation;
    if (knockoutFailed) recommendation = 'Decline';
    else if (!complete) recommendation = 'Incomplete';
    else if (total >= s.approve_min_score) recommendation = 'Approve';
    else if (total >= s.conditional_min_score) recommendation = 'Conditional';
    else recommendation = 'Decline';

    const reasons = [];
    if (knockoutFailed) knockouts.filter((k) => k.failed).forEach((k) => reasons.push(`Knockout: ${k.label}`));
    else if (recommendation === 'Conditional') reasons.push(`Score ${total} is between ${s.conditional_min_score} and ${s.approve_min_score - 1}: approve only with a surety or larger deposit`);
    else if (recommendation === 'Decline') reasons.push(`Score ${total} is below ${s.conditional_min_score}`);

    return {
      knockouts, knockoutFailed, factors, total, complete, missing, recommendation, reasons,
      affordability, debtRatio, minGrossIncome: rent !== null ? Math.ceil(rent / s.affordability_knockout_max) : null,
      settingsUsed: s,
    };
  }

  const api = { evaluateApplication, monthsBetween, DEFAULT_SETTINGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecruitmentScoring = api;
})(typeof window !== 'undefined' ? window : globalThis);
