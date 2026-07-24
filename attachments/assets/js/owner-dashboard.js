// Zanka Group — Owner dashboard
// Requires supabase-client.js and auth.js loaded first.

document.addEventListener('DOMContentLoaded', async () => {
  const profile = await requireSession('owner', 'owner-login.html');
  if (!profile) return;

  document.querySelectorAll('[data-owner-name]').forEach(el => {
    el.textContent = profile.full_name || profile.email;
  });

  await handleLogout('owner-login.html');
  await checkInvestorRepresentativeLink(profile.id);
  await loadOwnerData(profile.id);
});

// If this owner is also linked as a representative for an investor
// entity (the "front person" pattern — no separate investor login),
// show the crossover button. Same account, same session, just a
// different portal to view.
async function checkInvestorRepresentativeLink(ownerId) {
  const { data: links } = await supabaseClient
    .from('investor_representatives').select('entity_id, investor_entities ( entity_name )').eq('profile_id', ownerId);

  const link = document.getElementById('investor-portal-link');
  if (link && links && links.length > 0) {
    link.classList.remove('hidden');
    link.title = `Representing ${links.map(l => l.investor_entities?.entity_name).filter(Boolean).join(', ')}`;
  }
}

async function loadOwnerData(ownerId) {
  // Properties owned + rental income / occupancy
  const { data: properties } = await supabaseClient
    .from('properties')
    .select('*')
    .eq('owner_id', ownerId);

  renderList('properties-list', properties, (p) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy">${p.address ?? 'Property'}</p>
        <p class="text-sm text-gray-500">${p.occupancy_status ?? 'Unknown status'}</p>
      </div>
      <p class="font-semibold text-gold">R${Number(p.rent_amount ?? 0).toLocaleString()}</p>
    </div>`);

  const totalIncome = (properties || []).reduce((sum, p) => sum + Number(p.rent_amount || 0), 0);
  const occupied = (properties || []).filter(p => p.occupancy_status === 'Occupied').length;
  setText('stat-income', 'R' + totalIncome.toLocaleString());
  setText('stat-occupancy', `${occupied}/${(properties || []).length}`);

  // Portfolio value = sum of each property's cost price
  const portfolioValue = (properties || []).reduce((sum, p) => sum + Number(p.cost_price || 0), 0);
  setText('stat-portfolio-value', portfolioValue ? 'R' + portfolioValue.toLocaleString() : '—');

  // Rental yield = total active (currently occupied) rent ÷ portfolio value, as a %
  const activeRent = (properties || [])
    .filter(p => p.occupancy_status === 'Occupied')
    .reduce((sum, p) => sum + Number(p.rent_amount || 0), 0);
  const rentalYield = portfolioValue > 0 ? (activeRent / portfolioValue) * 100 : 0;
  setText('stat-rental-yield', portfolioValue > 0 ? rentalYield.toFixed(2) + '%' : '—');

  // Maintenance requests
  const { data: maintenance } = await supabaseClient
    .from('maintenance_requests')
    .select('*')
    .in('property_id', (properties || []).map(p => p.id))
    .order('created_at', { ascending: false });

  renderList('maintenance-list', maintenance, (m) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy">${m.title}</p>
        <p class="text-sm text-gray-500">${new Date(m.created_at).toLocaleDateString()}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${statusColor(m.status)}">${m.status}</span>
    </div>`);
  setText('stat-open-maintenance', (maintenance || []).filter(m => m.status !== 'Completed').length);

  // Statements, inspection reports, invoices, levy statements — all
  // stored as file rows with a URL. loadDocs fetches every matching row.
  await loadDocs('statements', 'statements-list', ownerId);
  await loadOwnerLeases(ownerId);
  await loadDocs('inspections', 'inspections-list', ownerId);
  await loadDocs('contractor_invoices', 'invoices-list', ownerId);
  await loadDocs('levy_statements', 'levies-list', ownerId);
  await loadLeaseInspections(ownerId);
  await loadPendingSignatures(ownerId);

  renderPerformanceChart(properties);
  wireRentalBreakdown((properties || []).map(p => p.id));
}

// The new, richer inspection records (lease_inspections), distinct
// from the simple document-based `inspections` table loaded above via
// loadDocs — this one has structured room-by-room data behind it.
// RLS ("Owners can view inspections for their properties") already
// scopes this to the right rows; no ownerId filter needed on the query
// itself.
async function loadLeaseInspections(ownerId) {
  const { data: inspections } = await supabaseClient
    .from('lease_inspections')
    .select('*, properties ( address )')
    .order('inspection_date', { ascending: false });

  const container = document.getElementById('lease-inspections-list');
  if (!container) return;

  if (!inspections || inspections.length === 0) {
    container.innerHTML = `<p class="text-sm text-gray-400 py-4">No inspections recorded yet.</p>`;
    return;
  }

  const typeLabels = { Move_In: 'Move-In', Routine: 'Routine', Move_Out: 'Move-Out' };
  container.innerHTML = inspections.map(i => {
    let badgeClass, badgeText;
    if (i.owner_signed_at) {
      badgeClass = 'bg-green-100 text-green-700';
      badgeText = 'Signed';
    } else if (i.owner_otp_code) {
      badgeClass = 'bg-gold-light text-navy-deep';
      badgeText = 'Needs your signature';
    } else {
      badgeClass = 'bg-gray-100 text-gray-500';
      badgeText = 'Awaiting request';
    }
    return `
    <a href="inspection-history.html?id=${i.id}" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
      <div>
        <p class="font-semibold text-navy text-sm">${typeLabels[i.inspection_type] || i.inspection_type} &middot; ${i.properties?.address || '—'}</p>
        <p class="text-xs text-gray-500">${new Date(i.inspection_date).toLocaleDateString()}${i.overall_condition ? ' · ' + i.overall_condition : ''}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${badgeClass}">${badgeText}</span>
    </a>`;
  }).join('');
}

// The previous version of this filtered `leases` by a column called
// `owner_id` — that column has never existed on `leases`. Ownership
// only exists via `properties.owner_id`, so this joins through that
// instead. This was broken for every owner, not something this
// session's changes caused.
async function loadOwnerLeases(ownerId) {
  const { data: leases } = await supabaseClient
    .from('leases')
    .select('*, properties!inner ( address, owner_id )')
    .eq('properties.owner_id', ownerId)
    .order('start_date', { ascending: false });

  const container = document.getElementById('leases-list');
  if (!container) return;

  if (!leases || leases.length === 0) {
    container.innerHTML = `<p class="text-sm text-gray-400 py-4">Nothing to show yet.</p>`;
    return;
  }

  container.innerHTML = leases.map(l => {
    const range = [l.start_date, l.end_date].filter(Boolean).join(' – ');
    // No file_url until the lease is actually fully signed — no PDF
    // generation step exists yet, so show status instead of a dead link.
    if (!l.file_url) {
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
          <div>
            <span class="text-navy font-medium block">${l.properties?.address || 'Lease'}</span>
            ${range ? `<span class="text-xs text-gray-500">${range}</span>` : ''}
          </div>
          <span class="text-xs font-semibold px-3 py-1 rounded-full bg-gray-100 text-gray-500">${l.status || 'Draft'}</span>
        </div>`;
    }
    return `
      <a href="${l.file_url}" target="_blank" rel="noopener" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
        <div>
          <span class="text-navy font-medium block">${l.properties?.address || 'Lease'}</span>
          ${range ? `<span class="text-xs text-gray-500">${range}</span>` : ''}
        </div>
        <span class="learn-more">Download →</span>
      </a>`;
  }).join('');
}

// Same pending-signature review pattern as the tenant dashboard —
// owners now sign too (v2), and need the same in-app path rather than
// relying solely on the emailed link.
async function loadPendingSignatures(ownerId) {
  const { data: rawSignatures } = await supabaseClient
    .from('lease_signatures')
    .select('*, leases ( id, properties ( address ) )')
    .eq('signed_by', ownerId)
    .eq('otp_verified', false);

  const seen = new Set();
  const signatures = (rawSignatures || []).filter(s => !seen.has(s.lease_id) && seen.add(s.lease_id));

  const container = document.getElementById('pending-signatures-list');
  if (!container) return;

  if (!signatures || signatures.length === 0) {
    container.innerHTML = '';
    document.getElementById('pending-signatures-card')?.classList.add('hidden');
    return;
  }

  document.getElementById('pending-signatures-card')?.classList.remove('hidden');
  container.innerHTML = signatures.map(s => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div>
        <p class="font-semibold text-navy text-sm">${s.leases?.properties?.address || 'Lease #' + s.lease_id}</p>
        <p class="text-xs text-gray-500">Awaiting your signature as owner</p>
      </div>
      ${s.otp_code
        ? `<a href="lease-sign.html?lease=${s.lease_id}" class="btn btn-primary !py-2 text-sm">Review &amp; Sign</a>`
        : `<span class="text-xs text-gray-400 italic">Waiting for your turn</span>`}
    </div>
  `).join('');
}

async function loadDocs(table, elementId, ownerId, ownerColumn = 'owner_id') {
  const { data } = await supabaseClient
    .from(table)
    .select('*')
    .eq(ownerColumn, ownerId)
    .order('created_at', { ascending: false });
  renderList(elementId, data, (d) => `
    <a href="${d.file_url}" target="_blank" rel="noopener" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
      <span class="text-navy font-medium">${d.title || d.name || 'Document'}</span>
      <span class="learn-more">Download →</span>
    </a>`);
}

function renderPerformanceChart(properties) {
  const canvas = document.getElementById('performance-chart');
  if (!canvas || !window.Chart) return;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const income = months.map(() => (properties || []).reduce((s, p) => s + Number(p.rent_amount || 0), 0));
  new Chart(canvas, {
    type: 'bar',
    data: { labels: months, datasets: [{ label: 'Rental Income (R)', data: income, backgroundColor: '#C89B3C' }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

/* ---------------- Rental Breakdown (pie chart, month/year toggle) ---------------- */
let rentalBreakdownState = { view: 'month', period: '', propertyIds: [] };
let rentalBreakdownChartInstance = null;

function wireRentalBreakdown(propertyIds) {
  rentalBreakdownState.propertyIds = propertyIds || [];

  const now = new Date();
  const defaultPeriod = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const periodInput = document.getElementById('rental-period-input');
  if (periodInput) periodInput.value = defaultPeriod;
  rentalBreakdownState.period = defaultPeriod;

  document.querySelectorAll('[data-rental-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      rentalBreakdownState.view = btn.dataset.rentalView;
      updateRentalViewButtons();
      loadRentalBreakdown();
    });
  });
  updateRentalViewButtons();

  if (periodInput) {
    periodInput.addEventListener('change', () => {
      rentalBreakdownState.period = periodInput.value;
      loadRentalBreakdown();
    });
  }

  loadRentalBreakdown();
}

function updateRentalViewButtons() {
  document.querySelectorAll('[data-rental-view]').forEach(btn => {
    const active = btn.dataset.rentalView === rentalBreakdownState.view;
    btn.classList.toggle('bg-navy', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('text-gray-500', !active);
  });
}

async function loadRentalBreakdown() {
  const { propertyIds, view, period } = rentalBreakdownState;
  if (!propertyIds.length || !period) {
    renderRentalBreakdown({ net_rental: 0, electricity: 0, water: 0, sewerage: 0, other_charges: 0 });
    return;
  }

  const year = parseInt(period.split('-')[0], 10);
  const month = parseInt(period.split('-')[1], 10); // 1-12

  let query = supabaseClient
    .from('rental_invoices')
    .select('*')
    .in('property_id', propertyIds);

  if (view === 'month') {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 1); // first day of next month
    const end = endDate.toISOString().slice(0, 10);
    query = query.gte('invoice_date', start).lt('invoice_date', end);
  } else {
    query = query.gte('invoice_date', `${year}-01-01`).lt('invoice_date', `${year + 1}-01-01`);
  }

  const { data: invoices } = await query;

  const totals = (invoices || []).reduce((acc, inv) => {
    acc.net_rental += Number(inv.net_rental || 0);
    acc.electricity += Number(inv.electricity || 0);
    acc.water += Number(inv.water || 0);
    acc.sewerage += Number(inv.sewerage || 0);
    acc.other_charges += Number(inv.other_charges || 0);
    return acc;
  }, { net_rental: 0, electricity: 0, water: 0, sewerage: 0, other_charges: 0 });

  renderRentalBreakdown(totals);
}

function renderRentalBreakdown(totals) {
  const labels = ['Net Rental', 'Electricity', 'Water', 'Sewerage', 'Other'];
  const values = [totals.net_rental, totals.electricity, totals.water, totals.sewerage, totals.other_charges];
  const total = values.reduce((s, v) => s + v, 0);
  const colors = ['#1F2A44', '#C89B3C', '#6B8FA3', '#9CA3AF', '#E4C77A'];

  // List with amount + percentage per category
  const listEl = document.getElementById('rental-breakdown-list');
  if (listEl) {
    if (total <= 0) {
      listEl.innerHTML = `<p class="text-sm text-gray-400 py-4">No invoiced rental data for this period.</p>`;
    } else {
      listEl.innerHTML = labels.map((label, i) => {
        const pct = total > 0 ? (values[i] / total) * 100 : 0;
        return `
          <div class="flex items-center justify-between text-sm">
            <span class="flex items-center gap-2 text-gray-600">
              <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${colors[i]}"></span>
              ${label}
            </span>
            <span class="font-semibold text-navy">R${values[i].toLocaleString()} <span class="text-gray-400 font-normal">(${pct.toFixed(1)}%)</span></span>
          </div>`;
      }).join('') + `
        <div class="flex items-center justify-between text-sm pt-3 mt-1 border-t border-gray-100">
          <span class="font-semibold text-navy">Total Invoiced</span>
          <span class="font-semibold text-navy">R${total.toLocaleString()}</span>
        </div>`;
    }
  }

  const canvas = document.getElementById('rental-breakdown-chart');
  if (!canvas || !window.Chart) return;

  if (rentalBreakdownChartInstance) {
    rentalBreakdownChartInstance.data.datasets[0].data = values;
    rentalBreakdownChartInstance.update();
    return;
  }

  rentalBreakdownChartInstance = new Chart(canvas, {
    type: 'pie',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const sum = ctx.dataset.data.reduce((s, v) => s + v, 0);
              const pct = sum > 0 ? (ctx.parsed / sum) * 100 : 0;
              return `${ctx.label}: R${Number(ctx.parsed).toLocaleString()} (${pct.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });
}

function statusColor(status) {
  if (status === 'Completed') return 'bg-green-100 text-green-700';
  if (status === 'In Progress') return 'bg-yellow-100 text-yellow-700';
  return 'bg-red-100 text-red-700';
}

function renderList(elementId, rows, template) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<p class="text-sm text-gray-400 py-4">Nothing to show yet.</p>`;
    return;
  }
  el.innerHTML = rows.map(template).join('');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
