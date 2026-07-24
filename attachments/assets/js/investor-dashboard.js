// Zanka Group — Investor Portal
// Requires supabase-client.js and auth.js loaded first.
//
// Investors are juristic entities — this page resolves which
// entity/entities the logged-in person represents, then aggregates
// across every property those entities own. Metrics that would
// require data this platform doesn't track (Distributions, IRR,
// Cash-on-Cash Return, Average Days Vacant) are deliberately not
// shown rather than filled with placeholder numbers — see the
// "Not tracked yet" labels in the HTML instead of fake figures.

let currentInvestor = null;
let investorPropertyIds = [];

// auth.js's requireSession() only checks a single expected role — this
// page needs to accept an owner who's crossing over too, without
// touching that shared file (used everywhere else with the
// single-role assumption baked in).
async function requireAnyRoleSession(allowedRoles, fallbackLoginUrl) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = fallbackLoginUrl; return null; }
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (error || !profile || !allowedRoles.includes(profile.role)) {
    window.location.href = fallbackLoginUrl;
    return null;
  }
  return profile;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Accepts either a dedicated investor-role login, or an owner
  // session that's also linked as a representative — owners cross
  // over from their existing Owner Portal session via a button, they
  // don't need (or use) a separate investor-login.html account.
  currentInvestor = await requireAnyRoleSession(['investor', 'owner'], 'investor-login.html');
  if (!currentInvestor) return;

  document.getElementById('investor-name').textContent = currentInvestor.full_name || currentInvestor.email;
  await handleLogout('investor-login.html');

  // Only a crossed-over Owner has anywhere to go back to — a
  // dedicated investor-only account has no owner profile at all.
  if (currentInvestor.role === 'owner') {
    document.getElementById('back-to-owner-link')?.classList.remove('hidden');
  }

  const entities = await resolveInvestorEntities();
  if (entities.length === 0) {
    document.getElementById('investor-entities-display').textContent = 'No entity linked — contact Zanka Group.';
    return;
  }
  document.getElementById('investor-entities-display').textContent = entities.map(e => e.entity_name).join(', ');

  const { data: properties } = await supabaseClient
    .from('properties')
    .select('*')
    .in('investor_entity_id', entities.map(e => e.id));

  investorPropertyIds = (properties || []).map(p => p.id);

  if (investorPropertyIds.length === 0) {
    document.querySelector('main').insertAdjacentHTML('afterbegin', '<p class="text-sm text-gray-400 mb-6">No properties assigned to your entity yet.</p>');
    return;
  }

  await loadKpis(properties);
  await loadEquityAndReturns(properties);
  loadPortfolioOverview(properties);
  loadTypeAllocation(properties);
  await loadIncomeTrend();
  await loadCollectionTrend();
  await loadRenewals();
  document.getElementById('renewal-timeframe').addEventListener('change', loadRenewals);
  await loadLeaseMetrics();
  await loadEscalations();
  renderEquityTable(properties);
});

async function resolveInvestorEntities() {
  const { data: reps } = await supabaseClient
    .from('investor_representatives')
    .select('entity_id, investor_entities ( id, entity_name )')
    .eq('profile_id', currentInvestor.id);
  return (reps || []).map(r => r.investor_entities).filter(Boolean);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function fmtR(n) { return 'R' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function fmtPct(n) { return Number(n || 0).toFixed(1) + '%'; }

/* ---------------- 1. KPIs ---------------- */
async function loadKpis(properties) {
  const monthlyIncome = properties.reduce((s, p) => s + Number(p.rent_amount || 0), 0);
  const annualised = monthlyIncome * 12;
  const occupied = properties.filter(p => p.occupancy_status === 'Occupied').length;
  const occupancyRate = properties.length ? (occupied / properties.length) * 100 : 0;
  const vacancyRate = 100 - occupancyRate;

  setText('kpi-monthly-income', fmtR(monthlyIncome));
  setText('kpi-annualised-income', fmtR(annualised));
  setText('kpi-occupancy', fmtPct(occupancyRate));
  setText('kpi-vacancy', fmtPct(vacancyRate));

  // Collection rate + arrears + outstanding balances, via payments
  // joined through leases on these properties (payments has no
  // property_id column, so this is the only real way to scope it).
  const { data: leases } = await supabaseClient.from('leases').select('tenant_id, outstanding_balance').in('property_id', investorPropertyIds);
  const tenantIds = [...new Set((leases || []).map(l => l.tenant_id))];

  if (tenantIds.length === 0) {
    setText('kpi-collection-rate', '—');
    setText('kpi-arrears', 'R0');
    setText('kpi-outstanding-balances', 'R0');
    return;
  }

  const { data: payments } = await supabaseClient.from('payments').select('*').in('tenant_id', tenantIds);
  const totalDue = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const totalPaid = (payments || []).filter(p => p.status === 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0);
  const collectionRate = totalDue > 0 ? (totalPaid / totalDue) * 100 : 0;

  const today = new Date().toISOString().slice(0, 10);
  const arrears = (payments || [])
    .filter(p => p.status !== 'Paid' && p.due_date && p.due_date < today)
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  const outstandingFromLeases = (leases || []).reduce((s, l) => s + Number(l.outstanding_balance || 0), 0);
  const outstandingFromPayments = (payments || []).filter(p => p.status !== 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0);
  const outstandingBalances = outstandingFromLeases > 0 ? outstandingFromLeases : outstandingFromPayments;

  setText('kpi-collection-rate', fmtPct(collectionRate));
  setText('kpi-arrears', fmtR(arrears));
  setText('kpi-outstanding-balances', fmtR(outstandingBalances));
}

/* ---------------- Equity / Returns / Yields ---------------- */
// Same formula as admin-dashboard.js's calculator — kept as a
// duplicate here since these are separate pages with no shared
// module system, not because the logic differs.
function calculateOutstandingBalance(loanAmount, annualRatePct, termMonths, startDateStr) {
  if (!loanAmount || annualRatePct == null || !termMonths || !startDateStr) return null;

  const start = new Date(startDateStr);
  const now = new Date();
  let monthsElapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  monthsElapsed = Math.max(0, Math.min(monthsElapsed, termMonths));

  if (monthsElapsed >= termMonths) return 0;

  const monthlyRate = (annualRatePct / 100) / 12;
  if (monthlyRate === 0) return loanAmount * (1 - monthsElapsed / termMonths);

  const factorN = Math.pow(1 + monthlyRate, termMonths);
  const factorK = Math.pow(1 + monthlyRate, monthsElapsed);
  return loanAmount * (factorN - factorK) / (factorN - 1);
}

// Prefers the calculated balance (real loan details entered) over the
// old manually-typed bond_outstanding figure, which stays as a
// fallback for any property where loan details aren't known.
function resolveOutstandingBalance(property) {
  const calculated = calculateOutstandingBalance(
    property.loan_amount, property.interest_rate, property.loan_term_months, property.loan_start_date
  );
  return calculated !== null ? calculated : Number(property.bond_outstanding || 0);
}

async function loadEquityAndReturns(properties) {
  const totalPurchasePrice = properties.reduce((s, p) => s + Number(p.cost_price || 0), 0);
  const valuedProperties = properties.filter(p => p.current_market_value != null);
  const totalMarketValue = valuedProperties.reduce((s, p) => s + Number(p.current_market_value || 0), 0);
  const totalBond = properties.reduce((s, p) => s + resolveOutstandingBalance(p), 0);

  const anyValued = valuedProperties.length > 0;
  const equity = anyValued ? totalMarketValue - totalBond : null;
  const capitalAppreciation = anyValued
    ? valuedProperties.reduce((s, p) => s + (Number(p.current_market_value) - Number(p.cost_price || 0)), 0)
    : 0;

  if (equity === null) {
    setText('kpi-equity', 'Not yet valued');
    setText('kpi-equity-note', `${properties.length - valuedProperties.length} of ${properties.length} properties need a market value set`);
  } else {
    setText('kpi-equity', fmtR(equity));
    const missing = properties.length - valuedProperties.length;
    setText('kpi-equity-note', missing > 0 ? `${missing} propert${missing === 1 ? 'y' : 'ies'} not yet valued, excluded` : 'All properties valued');
  }

  // Net Rental Income proxy = rent actually collected (Paid payments)
  // year-to-date. This is deliberately labelled as a proxy in the UI —
  // it's not a full NOI figure since operating expenses aren't tracked
  // in a way that flows into this calculation.
  const { data: leases } = await supabaseClient.from('leases').select('tenant_id').in('property_id', investorPropertyIds);
  const tenantIds = [...new Set((leases || []).map(l => l.tenant_id))];
  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);

  let netRentalYtd = 0;
  if (tenantIds.length > 0) {
    const { data: payments } = await supabaseClient.from('payments').select('amount, status, paid_at').in('tenant_id', tenantIds).eq('status', 'Paid').gte('paid_at', yearStart);
    netRentalYtd = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  }

  const totalReturn = netRentalYtd + capitalAppreciation;
  const grossYield = totalPurchasePrice > 0 ? ((properties.reduce((s, p) => s + Number(p.rent_amount || 0), 0) * 12) / totalPurchasePrice) * 100 : 0;
  const netYield = totalPurchasePrice > 0 ? (netRentalYtd / totalPurchasePrice) * 100 : 0;

  setText('kpi-total-return', fmtR(totalReturn));
  setText('kpi-gross-yield', fmtPct(grossYield));
  setText('kpi-net-yield', fmtPct(netYield));
}

/* ---------------- Portfolio overview ---------------- */
async function loadPortfolioOverview(properties) {
  const occupied = properties.filter(p => p.occupancy_status === 'Occupied').length;
  const vacant = properties.length - occupied;
  const totalPurchasePrice = properties.reduce((s, p) => s + Number(p.cost_price || 0), 0);
  const valuedProperties = properties.filter(p => p.current_market_value != null);
  const totalMarketValue = valuedProperties.reduce((s, p) => s + Number(p.current_market_value || 0), 0);

  const { data: leases } = await supabaseClient.from('leases').select('status').in('property_id', investorPropertyIds);
  const activeLeases = (leases || []).filter(l => ['Active', 'Active_Month_to_Month'].includes(l.status)).length;

  setText('ov-total-properties', properties.length);
  setText('ov-occupied', occupied);
  setText('ov-vacant', vacant);
  setText('ov-active-leases', activeLeases);
  setText('ov-purchase-price', fmtR(totalPurchasePrice));
  setText('ov-market-value', valuedProperties.length > 0 ? fmtR(totalMarketValue) : 'Not yet valued');
}

/* ---------------- Property type allocation ---------------- */
function loadTypeAllocation(properties) {
  const byType = {};
  properties.forEach(p => {
    const type = p.property_type || 'Residential';
    byType[type] = (byType[type] || 0) + Number(p.cost_price || 0);
  });

  const labels = Object.keys(byType);
  const values = Object.values(byType);
  const colors = ['#1F2A44', '#C89B3C', '#6B8FA3'];

  const listEl = document.getElementById('type-allocation-list');
  const total = values.reduce((s, v) => s + v, 0);
  listEl.innerHTML = labels.map((label, i) => {
    const pct = total > 0 ? (values[i] / total) * 100 : 0;
    return `
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-2 text-gray-600"><span class="w-2.5 h-2.5 rounded-full" style="background:${colors[i % colors.length]}"></span>${label}</span>
        <span class="font-semibold text-navy">${fmtR(values[i])} <span class="text-gray-400 font-normal text-xs">(${pct.toFixed(0)}%)</span></span>
      </div>`;
  }).join('') || '<p class="text-gray-400">No properties.</p>';

  const canvas = document.getElementById('type-allocation-chart');
  if (canvas && window.Chart && labels.length > 0) {
    new Chart(canvas, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
      options: { plugins: { legend: { display: false } } },
    });
  }
}

/* ---------------- Trends ---------------- */
async function loadIncomeTrend() {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  const startStr = `${twelveMonthsAgo.getFullYear()}-${String(twelveMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;

  const { data: invoices } = await supabaseClient
    .from('rental_invoices')
    .select('invoice_date, net_rental, electricity, water, sewerage, other_charges')
    .in('property_id', investorPropertyIds)
    .gte('invoice_date', startStr)
    .order('invoice_date');

  const months = buildLast12MonthLabels();
  const totals = months.map(m => (invoices || [])
    .filter(inv => inv.invoice_date.slice(0, 7) === m.key)
    .reduce((s, inv) => s + Number(inv.net_rental || 0) + Number(inv.electricity || 0) + Number(inv.water || 0) + Number(inv.sewerage || 0) + Number(inv.other_charges || 0), 0));

  const canvas = document.getElementById('income-trend-chart');
  if (canvas && window.Chart) {
    new Chart(canvas, {
      type: 'line',
      data: { labels: months.map(m => m.label), datasets: [{ label: 'Rental Income', data: totals, borderColor: '#1F2A44', backgroundColor: 'rgba(31,42,68,0.08)', fill: true, tension: 0.3 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }
}

async function loadCollectionTrend() {
  const { data: leases } = await supabaseClient.from('leases').select('tenant_id').in('property_id', investorPropertyIds);
  const tenantIds = [...new Set((leases || []).map(l => l.tenant_id))];
  const months = buildLast12MonthLabels();

  if (tenantIds.length === 0) {
    renderCollectionChart(months, months.map(() => 0), months.map(() => 0));
    return;
  }

  const { data: payments } = await supabaseClient.from('payments').select('amount, status, due_date, paid_at').in('tenant_id', tenantIds);

  const due = months.map(m => (payments || []).filter(p => p.due_date && p.due_date.slice(0, 7) === m.key).reduce((s, p) => s + Number(p.amount || 0), 0));
  const collected = months.map(m => (payments || []).filter(p => p.status === 'Paid' && p.paid_at && p.paid_at.slice(0, 7) === m.key).reduce((s, p) => s + Number(p.amount || 0), 0));

  renderCollectionChart(months, due, collected);
}

function renderCollectionChart(months, due, collected) {
  const canvas = document.getElementById('collection-trend-chart');
  if (canvas && window.Chart) {
    new Chart(canvas, {
      type: 'line',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          { label: 'Due', data: due, borderColor: '#9CA3AF', borderDash: [4, 4], tension: 0.3 },
          { label: 'Collected', data: collected, borderColor: '#C89B3C', backgroundColor: 'rgba(200,155,60,0.08)', fill: true, tension: 0.3 },
        ],
      },
      options: { scales: { y: { beginAtZero: true } } },
    });
  }
}

function buildLast12MonthLabels() {
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }) });
  }
  return months;
}

/* ---------------- Lease & occupancy management ---------------- */
async function loadRenewals() {
  const days = parseInt(document.getElementById('renewal-timeframe').value, 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: leases } = await supabaseClient
    .from('leases')
    .select('id, end_date, properties ( address ), profiles:tenant_id ( full_name )')
    .in('property_id', investorPropertyIds)
    .in('status', ['Active', 'Renewal_Due'])
    .gte('end_date', todayStr)
    .lte('end_date', cutoff.toISOString().slice(0, 10))
    .order('end_date');

  const container = document.getElementById('renewals-list');
  if (!leases || leases.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-3">No renewals due in this window.</p>';
    return;
  }
  container.innerHTML = leases.map(l => `
    <div class="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 text-sm">
      <div><p class="font-medium text-navy">${l.profiles?.full_name || '—'}</p><p class="text-xs text-gray-500">${l.properties?.address || '—'}</p></div>
      <span class="text-xs text-gray-600">${new Date(l.end_date).toLocaleDateString()}</span>
    </div>`).join('');
}

async function loadLeaseMetrics() {
  const { data: leases } = await supabaseClient.from('leases').select('start_date, end_date').in('property_id', investorPropertyIds).not('end_date', 'is', null);

  if (leases && leases.length > 0) {
    const avgDays = leases.reduce((s, l) => s + (new Date(l.end_date) - new Date(l.start_date)) / (1000 * 60 * 60 * 24), 0) / leases.length;
    const avgMonths = avgDays / 30.44;
    setText('metric-avg-lease-length', avgMonths >= 1 ? `${avgMonths.toFixed(1)} months` : `${Math.round(avgDays)} days`);
  } else {
    setText('metric-avg-lease-length', 'No data yet');
  }

  const { data: renewals } = await supabaseClient
    .from('lease_renewals')
    .select('renewal_type, leases!inner ( property_id )')
    .in('leases.property_id', investorPropertyIds);

  if (renewals && renewals.length > 0) {
    const renewed = renewals.filter(r => r.renewal_type === 'Renew').length;
    setText('metric-retention-rate', fmtPct((renewed / renewals.length) * 100));
  } else {
    setText('metric-retention-rate', 'No data yet');
  }
}

async function loadEscalations() {
  const { data: escalations } = await supabaseClient
    .from('lease_escalations')
    .select('effective_date, percentage, previous_rental_amount, new_rental_amount, leases!inner ( property_id, properties ( address ) )')
    .in('leases.property_id', investorPropertyIds)
    .eq('applied', false)
    .order('effective_date');

  const container = document.getElementById('escalations-list');
  if (!escalations || escalations.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-2">No escalations due.</p>';
    return;
  }
  container.innerHTML = escalations.map(e => `
    <div class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 text-xs">
      <span class="text-gray-600">${e.leases?.properties?.address || '—'} &middot; ${new Date(e.effective_date).toLocaleDateString()}</span>
      <span class="font-semibold text-navy">+${e.percentage}% → ${fmtR(e.new_rental_amount)}</span>
    </div>`).join('');
}

/* ---------------- Equity table ---------------- */
function renderEquityTable(properties) {
  const tbody = document.getElementById('equity-table-tbody');
  tbody.innerHTML = properties.map(p => {
    const hasValue = p.current_market_value != null;
    const outstanding = resolveOutstandingBalance(p);
    const isCalculated = calculateOutstandingBalance(p.loan_amount, p.interest_rate, p.loan_term_months, p.loan_start_date) !== null;
    const equity = hasValue ? Number(p.current_market_value) - outstanding : null;
    return `
      <tr class="border-b border-gray-100 text-sm">
        <td class="py-3 px-3 text-navy font-medium">${p.address}</td>
        <td class="py-3 px-3 text-gray-600">${fmtR(p.cost_price)}</td>
        <td class="py-3 px-3 text-gray-600">${hasValue ? fmtR(p.current_market_value) : '<span class="text-gray-400 italic">Not yet valued</span>'}</td>
        <td class="py-3 px-3 text-gray-600">${fmtR(outstanding)} ${isCalculated ? '<span class="text-xs text-gold">(calculated)</span>' : ''}</td>
        <td class="py-3 px-3 font-semibold text-navy">${equity !== null ? fmtR(equity) : '—'}</td>
      </tr>`;
  }).join('');
}
