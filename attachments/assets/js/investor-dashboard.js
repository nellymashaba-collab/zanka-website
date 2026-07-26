// Zanka Group — Investor dashboard 13h51
// Requires supabase-client.js and auth.js loaded first.
//
// No separate investor login exists by design — this is reached from
// the SAME session as owner-dashboard.html (via the "Go to Investor
// Portal" banner there), or directly if someone's ONLY role is
// investor rep with no personal properties. Either way, access is
// governed by actually having an investor_representatives row, not
// by a specific profiles.role value.

let currentProfile = null;
let allEntities = []; // every entity this person represents
let currentEntityId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'owner-login.html'; return; }

  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile) { await supabaseClient.auth.signOut(); window.location.href = 'owner-login.html'; return; }
  currentProfile = profile;

  const { data: reps } = await supabaseClient
    .from('investor_representatives')
    .select('entity_id, title, investor_entities:entity_id ( id, entity_name, entity_type )')
    .eq('profile_id', profile.id);

  if (!reps || reps.length === 0) {
    // Not actually an investor rep for anything — this page isn't
    // for them. Send back to whichever portal makes sense.
    window.location.href = profile.role === 'owner' ? 'owner-dashboard.html' : 'index.html';
    return;
  }

  allEntities = reps.map(r => r.investor_entities).filter(Boolean);

  document.querySelectorAll('[data-investor-name]').forEach(el => {
    el.textContent = profile.full_name || profile.email;
  });

  await handleLogout('owner-login.html');
  await checkPendingLeaseSignature(profile.id);

  // If this person also personally owns properties (owner_id, not
  // via an entity), show the way back to that view.
  const { data: personalProps } = await supabaseClient
    .from('properties').select('id').eq('owner_id', profile.id).limit(1);
  if (personalProps && personalProps.length > 0) {
    document.getElementById('back-to-owner-wrap').classList.remove('hidden');
  }

  setupEntitySwitcher();
  currentEntityId = allEntities[0].id;
  await loadEntityPortfolio(currentEntityId);
});

// Same banner as tenant/owner portals — an investor rep is also who
// signs as "Owner" on entity-owned properties' leases (see
// get_effective_owner_id / resolveEffectiveOwnerId in
// dms-notifications), so they need the same prompt to find it.
async function checkPendingLeaseSignature(profileId) {
  try {
    const { data: pending } = await supabaseClient
      .from('lease_signatures')
      .select('id, lease_id, leases:lease_id ( properties:property_id ( address ) )')
      .eq('signed_by', profileId)
      .is('signed_at', null)
      .not('otp_code', 'is', null);

    if (!pending || pending.length === 0) return;

    const main = document.getElementById('main');
    if (!main) return;

    const banner = document.createElement('div');
    banner.className = 'max-w-7xl mx-auto px-5 sm:px-8 pt-6';
    banner.innerHTML = pending.map(p => `
      <div class="bg-gold/10 border border-gold rounded-xl p-5 mb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p class="font-semibold text-navy">A lease is ready for your signature</p>
          <p class="text-sm text-gray-600">${p.leases?.properties?.address || 'A property'} — action needed to complete this lease.</p>
        </div>
        <a href="lease-sign.html?lease=${p.lease_id}" class="btn btn-primary">Sign Now →</a>
      </div>
    `).join('');
    main.prepend(banner);
  } catch (err) {
    console.error('checkPendingLeaseSignature failed (non-blocking):', err);
  }
}

function setupEntitySwitcher() {
  if (allEntities.length <= 1) return; // nothing to switch between
  const wrap = document.getElementById('entity-switcher-wrap');
  const select = document.getElementById('entity-switcher');
  wrap.classList.remove('hidden');
  select.innerHTML = allEntities.map(e => `<option value="${e.id}">${e.entity_name}</option>`).join('');
  select.addEventListener('change', () => {
    currentEntityId = select.value;
    loadEntityPortfolio(currentEntityId);
  });
}

// Same amortization formula used in the admin dashboard's loan
// calculator — kept in sync manually since this runs in a separate
// file; if the admin version changes, this should too.
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

async function loadEntityPortfolio(entityId) {
  const entity = allEntities.find(e => e.id === entityId);
  document.getElementById('entity-context-note').textContent = entity
    ? `Viewing ${entity.entity_name} (${entity.entity_type})`
    : '';

  // Entity-owned properties are linked via investor_entity_id, NOT
  // owner_id — owner_id is reserved for personal ownership and is
  // null on every entity-owned property (see the properties table's
  // check constraint: exactly one of owner_id / investor_entity_id
  // is ever set, never both, never neither).
  const { data: properties } = await supabaseClient
    .from('properties')
    .select('*')
    .eq('investor_entity_id', entityId);

  const rows = (properties || []).map(p => {
    const outstanding = calculateOutstandingBalance(p.loan_amount, p.interest_rate, p.loan_term_months, p.loan_start_date);
    const marketValue = Number(p.current_market_value || 0);
    const equity = outstanding != null ? marketValue - outstanding : marketValue;
    return { ...p, outstanding, equity };
  });

  renderPropertiesTable(rows);

  const totalValue = rows.reduce((s, p) => s + Number(p.current_market_value || 0), 0);
  const totalLoan = rows.reduce((s, p) => s + (p.outstanding || 0), 0);
  const totalEquity = totalValue - totalLoan;
  const totalPurchasePrice = rows.reduce((s, p) => s + Number(p.cost_price || 0), 0);

  setText('stat-portfolio-value', 'R' + totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-loan-outstanding', 'R' + totalLoan.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-equity', 'R' + totalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-property-count', String(rows.length));
  setText('stat-purchase-price', 'R' + totalPurchasePrice.toLocaleString(undefined, { maximumFractionDigits: 0 }));

  // Portfolio & Asset Overview
  const occupied = rows.filter(p => p.occupancy_status === 'Occupied').length;
  const vacant = rows.length - occupied;
  setText('stat-occ-vacant', `${occupied} / ${vacant}`);
  setText('stat-occupancy-rate', rows.length > 0 ? ((occupied / rows.length) * 100).toFixed(1) + '%' : '—');
  setText('stat-vacancy-rate', rows.length > 0 ? ((vacant / rows.length) * 100).toFixed(1) + '%' : '—');
  renderPropertyTypeAllocation(rows, totalValue);

  const propertyIds = rows.map(p => p.id);

  // Active leases + tenant list (needed by several metrics below)
  const { data: activeLeases } = propertyIds.length > 0
    ? await supabaseClient.from('leases').select('*').in('property_id', propertyIds).in('status', ['Active', 'Active_Month_to_Month'])
    : { data: [] };

  const monthlyIncome = (activeLeases || []).reduce((s, l) => s + Number(l.monthly_rent || 0), 0);
  const annualisedIncome = monthlyIncome * 12;
  setText('stat-monthly-income', 'R' + monthlyIncome.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-annualised-income', 'R' + annualisedIncome.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-active-leases', String((activeLeases || []).length));

  const grossYield = totalPurchasePrice > 0 ? (annualisedIncome / totalPurchasePrice) * 100 : null;
  setText('stat-gross-yield', grossYield != null ? grossYield.toFixed(2) + '%' : '—');

  const tenantIds = [...new Set((activeLeases || []).map(l => l.tenant_id).filter(Boolean))];
  const ytdPaid = await loadPaymentBasedMetrics(tenantIds, totalPurchasePrice);

  // Total Return = YTD net rental collected + capital appreciation
  // (current market value vs purchase price, summed across properties
  // that have both values recorded).
  const appreciation = rows.reduce((s, p) => {
    if (p.current_market_value && p.cost_price) return s + (Number(p.current_market_value) - Number(p.cost_price));
    return s;
  }, 0);
  setText('stat-total-return', 'R' + (ytdPaid + appreciation).toLocaleString(undefined, { maximumFractionDigits: 0 }));

  await loadRepresentatives(entityId);
  await loadEntityLeases(entityId);
  await loadEntityInvoices(entityId);
  await loadEntityInspections(entityId);
  await loadEntityMaintenance(entityId);
  await loadEntityStatements(entityId);
  await loadEntityContractorInvoices(entityId);
  await loadEntityLevyStatements(entityId);
  await loadIncomeTrendChart(propertyIds);
  await loadCollectionTrendChart(tenantIds);
  await loadUpcomingRenewals(propertyIds, document.getElementById('renewal-window')?.value || 90);
  await loadLeaseMetrics(propertyIds);
  await loadEscalationsDue(propertyIds);

  document.getElementById('renewal-window')?.addEventListener('change', (e) => {
    loadUpcomingRenewals(propertyIds, e.target.value);
  });
}

// Payments has no property_id column directly — scoped via the
// tenant_ids of this entity's ACTIVE leases instead (the most
// reliable link available in the current schema).
async function loadPaymentBasedMetrics(tenantIds, purchasePrice) {
  if (tenantIds.length === 0) {
    setText('stat-collection-rate', '—');
    setText('stat-arrears', 'R0');
    setText('stat-outstanding-balances', 'R0');
    setText('stat-net-yield', '—');
    return 0;
  }

  const yearStart = `${new Date().getFullYear()}-01-01`;
  const today = new Date().toISOString().slice(0, 10);

  const { data: ytdPayments } = await supabaseClient
    .from('payments').select('amount, status, due_date, paid_at')
    .in('tenant_id', tenantIds)
    .gte('due_date', yearStart);

  const ytdDue = (ytdPayments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const ytdPaid = (ytdPayments || []).filter(p => p.status === 'Paid').reduce((s, p) => s + Number(p.amount || 0), 0);
  const collectionRate = ytdDue > 0 ? (ytdPaid / ytdDue) * 100 : null;
  setText('stat-collection-rate', collectionRate != null ? collectionRate.toFixed(1) + '%' : '—');

  const { data: allPending } = await supabaseClient
    .from('payments').select('amount, due_date').in('tenant_id', tenantIds).eq('status', 'Pending');
  const outstandingTotal = (allPending || []).reduce((s, p) => s + Number(p.amount || 0), 0);
  const arrearsTotal = (allPending || []).filter(p => p.due_date && p.due_date < today).reduce((s, p) => s + Number(p.amount || 0), 0);
  setText('stat-arrears', 'R' + arrearsTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-outstanding-balances', 'R' + outstandingTotal.toLocaleString(undefined, { maximumFractionDigits: 0 }));

  const netYield = purchasePrice > 0 ? (ytdPaid / purchasePrice) * 100 : null;
  setText('stat-net-yield', netYield != null ? netYield.toFixed(2) + '%' : '—');

  return ytdPaid;
}

function renderPropertyTypeAllocation(rows, totalValue) {
  const container = document.getElementById('property-type-allocation');
  if (!container) return;
  if (rows.length === 0) { container.innerHTML = '<p class="text-gray-400">No properties yet.</p>'; return; }

  const byType = {};
  rows.forEach(p => {
    const type = p.property_type || 'Unspecified';
    byType[type] = (byType[type] || 0) + Number(p.current_market_value || 0);
  });

  container.innerHTML = Object.entries(byType).map(([type, value]) => {
    const pct = totalValue > 0 ? (value / totalValue) * 100 : 0;
    return `
      <div class="flex items-center justify-between py-1.5">
        <span class="text-navy">${type}</span>
        <span class="text-gray-500">R${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${pct.toFixed(0)}%)</span>
      </div>`;
  }).join('');
}

async function loadIncomeTrendChart(propertyIds) {
  const canvas = document.getElementById('income-trend-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (window.__incomeTrendChart) window.__incomeTrendChart.destroy();

  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ label: d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }), start: d, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) });
  }

  let invoices = [];
  if (propertyIds.length > 0) {
    const { data } = await supabaseClient
      .from('rental_invoices').select('invoice_date, net_rental')
      .in('property_id', propertyIds)
      .gte('invoice_date', months[0].start.toISOString().slice(0, 10));
    invoices = data || [];
  }

  const totals = months.map(m => invoices
    .filter(inv => { const d = new Date(inv.invoice_date); return d >= m.start && d < m.end; })
    .reduce((s, inv) => s + Number(inv.net_rental || 0), 0));

  window.__incomeTrendChart = new Chart(canvas, {
    type: 'line',
    data: { labels: months.map(m => m.label), datasets: [{ label: 'Rental Income Billed', data: totals, borderColor: '#C89B3C', backgroundColor: 'rgba(200,155,60,0.1)', fill: true, tension: 0.3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => 'R' + v.toLocaleString() } } } },
  });
}

async function loadCollectionTrendChart(tenantIds) {
  const canvas = document.getElementById('collection-trend-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (window.__collectionTrendChart) window.__collectionTrendChart.destroy();

  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ label: d.toLocaleDateString('en-ZA', { month: 'short', year: '2-digit' }), start: d, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) });
  }

  let payments = [];
  if (tenantIds.length > 0) {
    const { data } = await supabaseClient
      .from('payments').select('amount, status, due_date, paid_at')
      .in('tenant_id', tenantIds)
      .gte('due_date', months[0].start.toISOString().slice(0, 10));
    payments = data || [];
  }

  const due = months.map(m => payments
    .filter(p => { const d = new Date(p.due_date); return d >= m.start && d < m.end; })
    .reduce((s, p) => s + Number(p.amount || 0), 0));
  const collected = months.map(m => payments
    .filter(p => p.status === 'Paid' && p.paid_at && (() => { const d = new Date(p.paid_at); return d >= m.start && d < m.end; })())
    .reduce((s, p) => s + Number(p.amount || 0), 0));

  window.__collectionTrendChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        { label: 'Due', data: due, borderColor: '#1F2A44', backgroundColor: 'transparent', tension: 0.3 },
        { label: 'Collected', data: collected, borderColor: '#C89B3C', backgroundColor: 'transparent', tension: 0.3 },
      ],
    },
    options: { scales: { y: { ticks: { callback: (v) => 'R' + v.toLocaleString() } } } },
  });
}

async function loadUpcomingRenewals(propertyIds, days) {
  const container = document.getElementById('upcoming-renewals-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const today = new Date();
  const windowEnd = new Date(today.getTime() + Number(days) * 24 * 60 * 60 * 1000);

  const { data: leases } = await supabaseClient
    .from('leases').select('*, properties:property_id ( address )')
    .in('property_id', propertyIds)
    .eq('status', 'Active')
    .gte('end_date', today.toISOString().slice(0, 10))
    .lte('end_date', windowEnd.toISOString().slice(0, 10))
    .order('end_date');

  if (!leases || leases.length === 0) {
    container.innerHTML = `<p class="text-sm text-gray-400">No leases expiring in the next ${days} days.</p>`;
    return;
  }

  container.innerHTML = leases.map(l => `
    <div class="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0 text-sm">
      <span class="text-navy font-medium">${l.properties?.address || 'Property'}</span>
      <span class="text-gray-500">${new Date(l.end_date).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
    </div>
  `).join('');
}

async function loadLeaseMetrics(propertyIds) {
  if (propertyIds.length === 0) {
    setText('stat-avg-lease-length', '—');
    setText('stat-retention-rate', '—');
    return;
  }

  const { data: leases } = await supabaseClient
    .from('leases').select('start_date, end_date, renewal_status')
    .in('property_id', propertyIds);

  const withDates = (leases || []).filter(l => l.start_date && l.end_date);
  if (withDates.length > 0) {
    const avgDays = withDates.reduce((s, l) => s + (new Date(l.end_date) - new Date(l.start_date)) / 86400000, 0) / withDates.length;
    setText('stat-avg-lease-length', (avgDays / 30.44).toFixed(1) + ' months');
  } else {
    setText('stat-avg-lease-length', '—');
  }

  // renewal_status isn't populated on any lease yet in this system —
  // showing "Not enough data yet" rather than a fabricated 0%/rate,
  // per the explicit design principle of not presenting unverified
  // placeholder data. This will start working the moment real
  // renewal decisions get recorded.
  const tracked = (leases || []).filter(l => l.renewal_status);
  if (tracked.length === 0) {
    setText('stat-retention-rate', 'Not enough data yet');
  } else {
    const renewed = tracked.filter(l => /renew/i.test(l.renewal_status)).length;
    setText('stat-retention-rate', ((renewed / tracked.length) * 100).toFixed(0) + '%');
  }
}

async function loadEscalationsDue(propertyIds) {
  const container = document.getElementById('escalations-due-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data: leases } = await supabaseClient.from('leases').select('id, property_id, properties:property_id ( address )').in('property_id', propertyIds);
  const leaseIds = (leases || []).map(l => l.id);
  const addressByLease = Object.fromEntries((leases || []).map(l => [l.id, l.properties?.address]));

  if (leaseIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No escalations due.</p>'; return; }

  const { data: escalations } = await supabaseClient
    .from('lease_escalations').select('*')
    .in('lease_id', leaseIds)
    .eq('applied', false)
    .gte('effective_date', new Date().toISOString().slice(0, 10))
    .order('effective_date');

  if (!escalations || escalations.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400">No escalations due.</p>';
    return;
  }

  container.innerHTML = escalations.map(e => `
    <div class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0 text-sm">
      <div>
        <span class="text-navy font-medium block">${addressByLease[e.lease_id] || 'Property'}</span>
        <span class="text-xs text-gray-500">${new Date(e.effective_date).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' })}${e.percentage ? ` · +${e.percentage}%` : ''}</span>
      </div>
      <span class="text-gray-600">R${Number(e.new_rental_amount || 0).toLocaleString()}</span>
    </div>
  `).join('');
}

// Every one of these is scoped by property_id membership within the
// current entity, NOT by an owner_id column on the child table —
// owner_id on documents/leases/etc. isn't reliably set to the
// resolved effective owner (some were created before this entity
// model existed), whereas property_id -> properties.investor_entity_id
// is always correct and doesn't depend on retroactively fixing old
// records.

async function loadEntityLeases(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-leases-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data: leases } = await supabaseClient
    .from('leases').select('*, properties:property_id ( address )')
    .in('property_id', propertyIds)
    .order('created_at', { ascending: false });

  if (!leases || leases.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No leases yet.</p>'; return; }

  container.innerHTML = leases.map(l => {
    const range = [l.start_date, l.end_date].filter(Boolean).join(' – ');
    if (!l.file_url) {
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
          <div>
            <span class="text-navy font-medium block">${l.properties?.address || 'Lease'}</span>
            <span class="text-xs text-gray-500">${range}</span>
          </div>
          <span class="text-xs text-gray-400 italic">No document attached</span>
        </div>`;
    }
    return `
      <a href="${l.file_url}" target="_blank" rel="noopener" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
        <div>
          <span class="text-navy font-medium block">${l.properties?.address || 'Lease'}</span>
          <span class="text-xs text-gray-500">${range}</span>
        </div>
        <span class="learn-more">Download →</span>
      </a>`;
  }).join('');
}

async function loadEntityInvoices(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-invoices-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data: docs } = await supabaseClient
    .from('documents').select('*')
    .eq('category', 'Rent/Utility Invoice')
    .in('property_id', propertyIds)
    .order('document_date', { ascending: false });

  if (!docs || docs.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No invoices yet.</p>'; return; }

  container.innerHTML = docs.map(d => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <span class="text-navy font-medium block">${d.statement_month ? new Date(d.statement_month).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }) : d.document_date}</span>
        <span class="text-xs text-gray-500">R${Number(d.total_amount || 0).toLocaleString()}</span>
      </div>
      ${d.file_url || d.storage_path
        ? `<a href="${d.file_url || d.storage_path}" target="_blank" rel="noopener" class="learn-more">Download →</a>`
        : '<span class="text-xs text-gray-400 italic">No document attached</span>'}
    </div>
  `).join('');
}

async function loadEntityInspections(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-inspections-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data: docs } = await supabaseClient
    .from('documents').select('*')
    .eq('category', 'Inspection Report')
    .in('property_id', propertyIds)
    .order('document_date', { ascending: false });

  if (!docs || docs.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No inspection reports yet.</p>'; return; }

  container.innerHTML = docs.map(d => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <span class="text-navy font-medium">${d.generated_filename || d.original_filename || 'Inspection Report'}</span>
      ${d.file_url || d.storage_path
        ? `<a href="${d.file_url || d.storage_path}" target="_blank" rel="noopener" class="learn-more">Download →</a>`
        : '<span class="text-xs text-gray-400 italic">No document attached</span>'}
    </div>
  `).join('');
}

async function loadEntityMaintenance(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id, address').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const addressById = Object.fromEntries((props || []).map(p => [p.id, p.address]));
  const container = document.getElementById('investor-maintenance-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data: requests } = await supabaseClient
    .from('maintenance_requests').select('*')
    .in('property_id', propertyIds)
    .order('created_at', { ascending: false });

  if (!requests || requests.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No maintenance requests logged.</p>'; return; }

  container.innerHTML = requests.map(r => `
    <div class="flex items-start justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy text-sm">${r.title}</p>
        <p class="text-xs text-gray-500">${addressById[r.property_id] || ''}</p>
      </div>
      <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${r.status === 'Completed' ? 'bg-green-100 text-green-700' : r.status === 'In Progress' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}">
        ${r.status}
      </span>
    </div>
  `).join('');
}

async function loadEntityStatements(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-statements-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data } = await supabaseClient
    .from('statements').select('*')
    .in('property_id', propertyIds)
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No statements yet.</p>'; return; }

  container.innerHTML = data.map(d => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <span class="text-navy font-medium">${d.title || 'Statement'}</span>
      ${d.file_url ? `<a href="${d.file_url}" target="_blank" rel="noopener" class="learn-more">Download →</a>` : '<span class="text-xs text-gray-400 italic">No document attached</span>'}
    </div>
  `).join('');
}

// Contractor Invoices actually live in partner_invoices — see
// owner-dashboard.js's loadOwnerContractorInvoices for the full
// explanation (contractor_invoices itself is never written to by the
// current admin flow).
async function loadEntityContractorInvoices(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-contractor-invoices-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data } = await supabaseClient
    .from('partner_invoices').select('*')
    .in('property_id', propertyIds)
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No contractor invoices yet.</p>'; return; }

  container.innerHTML = data.map(d => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <span class="text-navy font-medium block">R${Number(d.amount || 0).toLocaleString()}</span>
        <span class="text-xs text-gray-500">${d.status || ''}</span>
      </div>
      ${d.file_url ? `<a href="${d.file_url}" target="_blank" rel="noopener" class="learn-more">Download →</a>` : '<span class="text-xs text-gray-400 italic">No document attached</span>'}
    </div>
  `).join('');
}

async function loadEntityLevyStatements(entityId) {
  const { data: props } = await supabaseClient.from('properties').select('id').eq('investor_entity_id', entityId);
  const propertyIds = (props || []).map(p => p.id);
  const container = document.getElementById('investor-levies-list');
  if (!container) return;
  if (propertyIds.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No properties yet.</p>'; return; }

  const { data } = await supabaseClient
    .from('levy_statements').select('*')
    .in('property_id', propertyIds)
    .order('created_at', { ascending: false });

  if (!data || data.length === 0) { container.innerHTML = '<p class="text-sm text-gray-400">No levy statements yet.</p>'; return; }

  container.innerHTML = data.map(d => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <span class="text-navy font-medium">${d.title || 'Levy Statement'}</span>
      ${d.file_url ? `<a href="${d.file_url}" target="_blank" rel="noopener" class="learn-more">Download →</a>` : '<span class="text-xs text-gray-400 italic">No document attached</span>'}
    </div>
  `).join('');
}

function renderPropertiesTable(rows) {
  const tbody = document.getElementById('investor-properties-tbody');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-sm text-gray-400 text-center">No properties held by this entity yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(p => `
    <tr class="border-b border-gray-50 text-sm">
      <td class="py-3 pr-4 font-medium text-navy">${p.address || 'Unknown address'}</td>
      <td class="py-3 pr-4 text-gray-600">${p.property_type || '—'}</td>
      <td class="py-3 pr-4 text-gray-600">${p.cost_price ? 'R' + Number(p.cost_price).toLocaleString() : '—'}</td>
      <td class="py-3 pr-4 text-gray-600">R${Number(p.current_market_value || 0).toLocaleString()}</td>
      <td class="py-3 pr-4 text-gray-600">${p.outstanding != null ? 'R' + p.outstanding.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
      <td class="py-3 pr-4 font-semibold text-navy">R${p.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
      <td class="py-3 pr-4 text-gray-600">R${Number(p.rent_amount || 0).toLocaleString()}</td>
    </tr>
  `).join('');
}

async function loadRepresentatives(entityId) {
  const { data: reps } = await supabaseClient
    .from('investor_representatives')
    .select('title, profiles:profile_id ( full_name, email )')
    .eq('entity_id', entityId);

  const container = document.getElementById('entity-representatives-list');
  if (!container) return;

  if (!reps || reps.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400">No representatives linked.</p>';
    return;
  }

  container.innerHTML = reps.map(r => `
    <div class="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
      <span class="text-navy font-medium">${r.profiles?.full_name || 'Unknown'}</span>
      <span class="text-gray-500">${r.title || 'Representative'}</span>
    </div>
  `).join('');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
