// Zanka Group — Investor dashboard 12h40
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

  setText('stat-portfolio-value', 'R' + totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-loan-outstanding', 'R' + totalLoan.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-equity', 'R' + totalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  setText('stat-property-count', String(rows.length));

  await loadRepresentatives(entityId);
  await loadEntityLeases(entityId);
  await loadEntityInvoices(entityId);
  await loadEntityInspections(entityId);
  await loadEntityMaintenance(entityId);
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

function renderPropertiesTable(rows) {
  const tbody = document.getElementById('investor-properties-tbody');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-sm text-gray-400 text-center">No properties held by this entity yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(p => `
    <tr class="border-b border-gray-50 text-sm">
      <td class="py-3 pr-4 font-medium text-navy">${p.address || 'Unknown address'}</td>
      <td class="py-3 pr-4 text-gray-600">${p.property_type || '—'}</td>
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
