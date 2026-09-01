// Zanka Group — Tenant dashboard 21h28
// Requires supabase-client.js and auth.js loaded first.

let currentProfile = null;
let rentalBreakdownState = { view: 'month', period: '', propertyId: null };
let rentalBreakdownChartInstance = null;

document.addEventListener('DOMContentLoaded', async () => {
  currentProfile = await requireSession('tenant', 'tenant-login.html');
  if (!currentProfile) return;

  document.querySelectorAll('[data-tenant-name]').forEach(el => {
    el.textContent = currentProfile.full_name || currentProfile.email;
  });

  await handleLogout('tenant-login.html');
  await checkPendingLeaseSignature(currentProfile.id);
  await loadTenantData(currentProfile.id);
  await loadLeaseInspections(currentProfile.id);
  wireMaintenanceForm(currentProfile.id);
  wireNoticeForm(currentProfile.id);
  wireDetailsForm(currentProfile);
  await wirePayNow(currentProfile.id);
  await wireRentalBreakdown(currentProfile.id);
});

// This was the actual gap behind "FICA approved but nothing asked me
// to sign" — the dashboard had no UI at all pointing to lease-sign.html,
// only the (separate, file-based) Lease Documents card below, which
// has nothing to show until AFTER signing produces a real document.
// A lease_signatures row with otp_code set but signed_at still null
// means it's genuinely this tenant's turn to sign right now.
async function checkPendingLeaseSignature(tenantId) {
  try {
    const { data: pending } = await supabaseClient
      .from('lease_signatures')
      .select('id, lease_id, leases:lease_id ( properties:property_id ( address ) )')
      .eq('signed_by', tenantId)
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
          <p class="font-semibold text-navy">Your lease is ready to sign</p>
          <p class="text-sm text-gray-600">${p.leases?.properties?.address || 'A property'} — action needed to complete your lease.</p>
        </div>
        <a href="lease-sign.html?lease=${p.lease_id}" class="btn btn-primary">Sign Now →</a>
      </div>
    `).join('');
    main.prepend(banner);
  } catch (err) {
    // Never let a banner-check failure block the rest of the page —
    // this is exactly what happened when this had no try/catch: the
    // whole dashboard (including the Lease Documents card) went blank
    // because this awaited call threw before loadTenantData() ran.
    console.error('checkPendingLeaseSignature failed (non-blocking):', err);
  }
}

async function loadTenantData(tenantId) {
  // Lease history — a tenant can have multiple lease rows over time
  const { data: leases } = await supabaseClient
    .from('leases')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('start_date', { ascending: false });
  renderDocList('lease-list', leases, (l) => {
    const range = [l.start_date, l.end_date].filter(Boolean).join(' – ');
    if (!l.file_url) {
      return `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 -mx-2 px-2">
          <div>
            <span class="text-navy font-medium block">${l.title || 'Lease Agreement'}</span>
            ${range ? `<span class="text-xs text-gray-500">${range}</span>` : ''}
          </div>
          <span class="text-xs text-gray-400 italic">No document attached</span>
        </div>`;
    }
    return `
      <a href="${l.file_url}" target="_blank" rel="noopener" class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded">
        <div>
          <span class="text-navy font-medium block">${l.title || 'Lease Agreement'}</span>
          ${range ? `<span class="text-xs text-gray-500">${range}</span>` : ''}
        </div>
        <span class="learn-more">Download →</span>
      </a>`;
  });

  // Invoices — reads from `documents` (the real DMS table), not the
  // nonexistent `tenant_invoices`. Only approved documents addressed to
  // this tenant are visible here (enforced by the existing "Tenants can
  // view their approved documents" RLS policy). The bucket is private,
  // so each row generates a short-lived signed URL on click rather than
  // storing a permanent public link.
  const { data: tenantDocuments } = await supabaseClient
    .from('documents')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'Approved')
    .neq('category', 'Levy Statement') // owner-only — a tenant_id can still be set here (e.g. the levy recharge feature), so exclude explicitly rather than relying on tenant_id alone
    .order('created_at', { ascending: false });

  const invoicesList = document.getElementById('tenant-invoices-list');
  if (invoicesList) {
    if (!tenantDocuments || tenantDocuments.length === 0) {
      invoicesList.innerHTML = `<p class="text-sm text-gray-400 py-4">Nothing to show yet.</p>`;
    } else {
      invoicesList.innerHTML = tenantDocuments.map(d => {
        const monthLabel = d.statement_month
          ? new Date(d.statement_month).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' })
          : new Date(d.created_at).toLocaleDateString();
        return `
          <button data-doc-download="${d.id}" data-doc-path="${d.storage_path}" class="w-full flex items-center justify-between py-3 border-b border-gray-100 last:border-0 hover:bg-offwhite -mx-2 px-2 rounded text-left">
            <div>
              <span class="text-navy font-medium block">${d.category}</span>
              <span class="text-xs text-gray-500">${monthLabel}${d.total_amount ? ' · R' + Number(d.total_amount).toLocaleString() : ''}</span>
            </div>
            <span class="learn-more">Download →</span>
          </button>`;
      }).join('');

      invoicesList.querySelectorAll('[data-doc-download]').forEach(btn => {
        btn.addEventListener('click', async () => {
          // Mobile browsers (especially iOS Safari) only allow window.open()
          // to succeed if it happens SYNCHRONOUSLY within the tap — once you
          // await something first, the browser no longer treats it as a
          // direct result of user interaction and silently blocks the popup
          // (no error, nothing visibly happens). Fix: open a blank tab
          // immediately, then point it at the real file once we have it.
          const newTab = window.open('', '_blank');
          const { data, error } = await supabaseClient
            .storage.from('documents').createSignedUrl(btn.dataset.docPath, 300);
          if (error) {
            if (newTab) newTab.close();
            alert('Could not open file: ' + error.message);
            return;
          }
          if (newTab) {
            newTab.location.href = data.signedUrl;
          } else {
            // Popup blocker still caught it even with the synchronous open
            // (rare, but possible with strict settings) — fall back to
            // navigating the current tab instead of failing silently.
            window.location.href = data.signedUrl;
          }
        });
      });
    }
  }

  // Payment history
  const { data: payments } = await supabaseClient
    .from('payments').select('*').eq('tenant_id', tenantId).order('paid_at', { ascending: false });
  const tbody = document.getElementById('payments-table-body');
  if (tbody) {
    if (!payments || payments.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="py-4 text-sm text-gray-400">No payments recorded yet.</td></tr>`;
    } else {
      tbody.innerHTML = payments.map(p => {
        const isPaid = p.status === 'Paid' && p.paid_at;
        const dateLabel = isPaid
          ? new Date(p.paid_at).toLocaleDateString()
          : (p.due_date ? 'Due ' + new Date(p.due_date).toLocaleDateString() : '—');
        return `
        <tr class="border-b border-gray-100">
          <td class="py-3 text-sm text-gray-600">${dateLabel}</td>
          <td class="py-3 text-sm font-semibold text-navy">R${Number(p.amount).toLocaleString()}</td>
          <td class="py-3 text-sm"><span class="text-xs font-semibold px-3 py-1 rounded-full ${p.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${p.status}</span></td>
        </tr>`;
      }).join('');
    }
  }

  // Maintenance requests
  const { data: requests } = await supabaseClient
    .from('maintenance_requests').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
  const list = document.getElementById('maintenance-list');
  if (list) {
    if (!requests || requests.length === 0) {
      list.innerHTML = `<p class="text-sm text-gray-400 py-4">No maintenance requests logged yet.</p>`;
    } else {
      list.innerHTML = requests.map(r => `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
          <div>
            <p class="font-semibold text-navy">${r.title}</p>
            <p class="text-sm text-gray-500">${new Date(r.created_at).toLocaleDateString()}</p>
          </div>
          <span class="text-xs font-semibold px-3 py-1 rounded-full ${r.status === 'Completed' ? 'bg-green-100 text-green-700' : r.status === 'In Progress' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}">${r.status}</span>
        </div>`).join('');
    }
  }
}

/* ---------------- Rental Breakdown Module ---------------- */
async function wireRentalBreakdown(tenantId) {
  // Resolve the property this tenant actually leases via their most recent
  // lease row — NOT an arbitrary row from the properties table.
  let resolvedPropertyId = null;
  const { data: tenantLeases } = await supabaseClient
    .from('leases')
    .select('property_id')
    .eq('tenant_id', tenantId)
    .order('start_date', { ascending: false })
    .limit(1);

  if (tenantLeases && tenantLeases.length > 0) {
    resolvedPropertyId = tenantLeases[0].property_id;
  }

  rentalBreakdownState.propertyId = resolvedPropertyId;

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

  await loadRentalBreakdown();
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
  const { propertyId, view, period } = rentalBreakdownState;
  if (!propertyId || !period) {
    renderRentalBreakdown({ net_rental: 0, electricity: 0, water: 0, sewerage: 0, other_charges: 0 });
    return;
  }

  const year = parseInt(period.split('-')[0], 10);
  const month = parseInt(period.split('-')[1], 10);

  let query = supabaseClient
    .from('rental_invoices')
    .select('*')
    .eq('property_id', propertyId);

  if (view === 'month') {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 1);
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

  const listEl = document.getElementById('rental-breakdown-list');
  const canvas = document.getElementById('rental-breakdown-chart');

  if (total <= 0) {
    if (listEl) {
      listEl.innerHTML = `<p class="text-sm text-gray-400 py-4">No invoiced rental data for this period.</p>`;
    }
    if (rentalBreakdownChartInstance) {
      rentalBreakdownChartInstance.destroy();
      rentalBreakdownChartInstance = null;
    }
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }

  if (listEl) {
    listEl.innerHTML = labels.map((label, i) => {
      const pct = (values[i] / total) * 100;
      return `
        <div class="flex items-center justify-between text-sm py-1 border-b border-gray-50/50 last:border-0">
          <span class="flex items-center gap-2 text-gray-600">
            <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${colors[i]}"></span>
            ${label}
          </span>
          <span class="font-semibold text-navy">R${values[i].toLocaleString()} <span class="text-gray-400 font-normal text-xs">(${pct.toFixed(1)}%)</span></span>
        </div>`;
    }).join('') + `
      <div class="flex items-center justify-between text-sm pt-3 mt-2 border-t border-gray-100">
        <span class="font-semibold text-navy text-base">Total Invoiced</span>
        <span class="font-semibold text-navy text-base">R${total.toLocaleString()}</span>
      </div>`;
  }

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
      maintainAspectRatio: false,
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

/* ---------------- Missing Document List UI Renderer Function ---------------- */
// RLS ("Tenants can view inspections on their own lease") already
// scopes this correctly — no explicit tenant filter needed on the
// query itself.
async function loadLeaseInspections(tenantId) {
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

function renderDocList(elementId, rows, template) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<p class="text-sm text-gray-400 py-4">Nothing to show yet.</p>`;
    return;
  }
  el.innerHTML = rows.map(template).join('');
}

async function notifyLeaseEvent(eventType, extra = {}) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ maintenance_event: eventType, ...extra }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`dms-notifications returned ${res.status} for event '${eventType}':`, body);
    }
  } catch (err) {
    console.error('Notification request failed:', err);
  }
}

function wireMaintenanceForm(tenantId) {
  const form = document.getElementById('maintenance-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('maintenance-title').value.trim();
    const description = document.getElementById('maintenance-description').value.trim();

    // property_id was never being set here at all — maintenance
    // requests had no property association, which also silently
    // broke the Investor Portal's Maintenance section (it filters by
    // property_id). Resolved from the tenant's own active lease,
    // since a tenant only ever has one property they'd be reporting
    // an issue for.
    const { data: activeLease } = await supabaseClient
      .from('leases').select('property_id')
      .eq('tenant_id', tenantId).eq('status', 'Active')
      .order('start_date', { ascending: false }).limit(1).maybeSingle();

    const { data: inserted, error } = await supabaseClient.from('maintenance_requests').insert([{
      tenant_id: tenantId, property_id: activeLease?.property_id || null, title, description, status: 'Submitted'
    }]).select('id').single();

    const note = document.getElementById('maintenance-note');
    if (!error) {
      note.textContent = 'Request submitted.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
      form.reset();
      loadTenantData(tenantId);

      if (inserted?.id) {
        await notifyLeaseEvent('maintenance_request_created', { maintenance_request_id: inserted.id });
      }
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

function wireNoticeForm(tenantId) {
  const form = document.getElementById('notice-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('notice-type').value;
    const message = document.getElementById('notice-message').value.trim();
    const { error } = await supabaseClient.from('notices').insert([{ tenant_id: tenantId, type, message }]);
    const note = document.getElementById('notice-note');
    if (!error) {
      note.textContent = 'Notice submitted.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
      form.reset();
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

function wireDetailsForm(profile) {
  const form = document.getElementById('details-form');
  if (!form) return;
  document.getElementById('details-full-name').value = profile.full_name || '';
  document.getElementById('details-phone').value = profile.phone || '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const full_name = document.getElementById('details-full-name').value.trim();
    const phone = document.getElementById('details-phone').value.trim();
    const { error } = await supabaseClient.from('profiles').update({ full_name, phone }).eq('id', profile.id);
    const note = document.getElementById('details-note');
    if (!error) {
      note.textContent = 'Details updated.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

async function wirePayNow(tenantId) {
  const btn = document.getElementById('pay-rent-btn');
  if (!btn) return;

  // Find the tenant's actual outstanding payment, linked to a real
  // invoice — replaces the old stub that just inserted a blank R0 row
  // and told the admin to "connect a payment gateway."
  const { data: pending } = await supabaseClient
    .from('payments')
    .select('id, amount, due_date, tenant_invoice_id, tenant_invoices:tenant_invoice_id ( invoice_number )')
    .eq('tenant_id', tenantId)
    .eq('status', 'Pending')
    .order('due_date', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending || !pending.amount) {
    btn.textContent = 'Nothing due';
    btn.disabled = true;
    return;
  }

  btn.textContent = `Pay ${Number(pending.amount).toLocaleString(undefined, { style: 'currency', currency: 'ZAR' })} Now →`;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Redirecting to secure payment…';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch(`${SUPABASE_URL}/functions/v1/payfast-initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ payment_id: pending.id }),
      });
      const result = await res.json();
      if (!res.ok || !result.fields || !result.action_url) {
        throw new Error(result.error || 'Could not start the payment — please try again.');
      }

      // PayFast requires a genuine HTML form POST, not a fetch/redirect
      // — build one dynamically and submit it.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = result.action_url;
      Object.entries(result.fields).forEach(([key, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
      });
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      alert(err.message || 'Payment could not be started.');
      btn.disabled = false;
      btn.textContent = `Pay ${Number(pending.amount).toLocaleString(undefined, { style: 'currency', currency: 'ZAR' })} Now →`;
    }
  });
}
