// Zanka Group — Owner dashboard 20h35
// Requires supabase-client.js and auth.js loaded first.

document.addEventListener('DOMContentLoaded', async () => {
  const profile = await requireSession('owner', 'owner-login.html');
  if (!profile) return;

  document.querySelectorAll('[data-owner-name]').forEach(el => {
    el.textContent = profile.full_name || profile.email;
  });

  await handleLogout('owner-login.html');
  await checkPendingLeaseSignature(profile.id);
  await loadOwnerData(profile.id);
});

// Same gap fix as the tenant portal — see tenant-dashboard.js for the
// full explanation. Owners sign too in this system's design (Tenant,
// then Guarantor if any, then Owner), so they need this prompt as well.
async function checkPendingLeaseSignature(ownerId) {
  try {
    const { data: pending } = await supabaseClient
      .from('lease_signatures')
      .select('id, lease_id, leases:lease_id ( properties:property_id ( address ) )')
      .eq('signed_by', ownerId)
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

  // Statements, lease docs, inspection reports, invoices, levy statements —
  // all stored as file rows with a URL. loadDocs fetches every matching row
  // (no .single()/.maybeSingle()), so leases naturally return full history.
  await loadDocs('statements', 'statements-list', ownerId);
  await loadDocs('leases', 'leases-list', ownerId, 'owner_id');
  await loadDocs('inspections', 'inspections-list', ownerId);
  await loadDocs('contractor_invoices', 'invoices-list', ownerId);
  await loadDocs('levy_statements', 'levies-list', ownerId);
  await loadLeaseInspections(ownerId);

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
  container.innerHTML = inspections.map(i => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy text-sm">${typeLabels[i.inspection_type] || i.inspection_type} &middot; ${i.properties?.address || '—'}</p>
        <p class="text-xs text-gray-500">${new Date(i.inspection_date).toLocaleDateString()}${i.overall_condition ? ' · ' + i.overall_condition : ''}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${i.status === 'Completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${i.status}</span>
    </div>`).join('');
}

async function loadDocs(table, elementId, ownerId, ownerColumn = 'owner_id') {
  const { data } = await supabaseClient
    .from(table)
    .select('*')
    .eq(ownerColumn, ownerId)
    .order('created_at', { ascending: false });
  renderList(elementId, data, (d) => {
    if (!d.file_url) {
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 -mx-2 px-2">
          <span class="text-navy font-medium">${d.title || d.name || 'Document'}</span>
          <span class="text-xs text-gray-400 italic">No document attached</span>
        </div>`;
    }
    return `
      <a href="${d.file_url}" target="_blank" rel="noopener" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
        <span class="text-navy font-medium">${d.title || d.name || 'Document'}</span>
        <span class="learn-more">Download →</span>
      </a>`;
  });
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
