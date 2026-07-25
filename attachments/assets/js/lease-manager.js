// Zanka Group — Lease Management Module
// Requires supabase-client.js and auth.js loaded first.
//
// NOTE ON "ECTA COMPLIANCE": this file implements supporting technical
// measures for electronic signing — IP capture, user-agent capture, OTP
// verification, a SHA-256 hash over the signed content, and a full audit
// log. These are genuinely useful evidentiary features, but whether a
// given signing flow satisfies South Africa's Electronic Communications
// and Transactions Act for a specific document type is a legal question,
// not a coding one — get that reviewed by a lawyer before relying on this
// for leases that need to hold up in a dispute. Nothing in this file or
// its UI claims "ECTA compliant" as a certification.
//
// Storage: reuses the existing private 'documents' bucket and its RLS
// policies — no new bucket. Path convention:
//   documents/lease-files/{lease_id}/{category}/{filename}

let currentUser = null;
let wizardState = { step: 1, clauses: [], documents: {}, escalations: [] };

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await requireSession('admin', 'admin-login.html');
  if (!currentUser) return;

  if (document.getElementById('lease-wizard-form')) {
    await initWizard();
  }
  if (document.getElementById('register-tbody')) {
    await initDashboard();
  }
});

/* ================================================================
   WIZARD
   ================================================================ */
async function initWizard() {
  await populateWizardSelects();
  wireWizardNav();
  wireDocumentInputs();
  wireEscalations();
}

function wireEscalations() {
  document.getElementById('lw-add-escalation').addEventListener('click', addEscalationRow);
}

function addEscalationRow() {
  const template = document.getElementById('lw-escalation-row-template');
  const clone = template.content.cloneNode(true);
  const row = clone.querySelector('.escalation-row');
  row.querySelector('.escalation-remove').addEventListener('click', () => row.remove());
  document.getElementById('lw-escalations-list').appendChild(clone);
}

function collectEscalations() {
  return Array.from(document.querySelectorAll('.escalation-row')).map(row => ({
    escalation_type: row.querySelector('.escalation-type').value,
    effective_date: row.querySelector('.escalation-date').value,
    percentage: parseFloat(row.querySelector('.escalation-percentage').value) || 0,
  })).filter(esc => esc.effective_date && esc.percentage > 0);
}

async function populateWizardSelects() {
  const { data: properties } = await supabaseClient
    .from('properties').select('id, address, owner_id, owner:owner_id ( full_name )').order('address');
  const propSelect = document.getElementById('lw-property');
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}" data-owner-name="${p.owner?.full_name || 'Unknown owner'}">${p.address}</option>`).join('');

  propSelect.addEventListener('change', () => {
    const ownerName = propSelect.selectedOptions[0]?.dataset.ownerName;
    document.getElementById('lw-owner-display').textContent = ownerName || 'Select a property first';
  });

  const { data: tenants } = await supabaseClient.from('profiles').select('id, full_name').eq('role', 'tenant').order('full_name');
  const tenantOptions = (tenants || []).map(t => `<option value="${t.id}">${t.full_name}</option>`).join('');

  const tenantSelect = document.getElementById('lw-tenant');
  tenantSelect.innerHTML = '<option value="">Select a tenant</option>' + tenantOptions;

  const guarantorSelect = document.getElementById('lw-guarantor');
  guarantorSelect.innerHTML = '<option value="">No guarantor</option>' + tenantOptions;

  const { data: templates } = await supabaseClient.from('lease_templates').select('id, template_name').order('template_name');
  const templateSelect = document.getElementById('lw-template');
  templateSelect.innerHTML = '<option value="">Select a template</option>' +
    (templates || []).map(t => `<option value="${t.id}">${t.template_name}</option>`).join('');
  templateSelect.addEventListener('change', () => loadClausesForTemplate(templateSelect.value));

  document.getElementById('lw-guarantor').addEventListener('change', (e) => {
    document.getElementById('lw-guarantor-doc-wrap').classList.toggle('hidden', !e.target.value);
  });
}

async function loadClausesForTemplate(templateId) {
  const container = document.getElementById('lw-clause-list');
  if (!templateId) { container.innerHTML = ''; wizardState.clauses = []; return; }

  const { data: clauses, error } = await supabaseClient
    .from('lease_clauses').select('*').eq('template_id', templateId).order('display_order');

  if (error || !clauses) { container.innerHTML = `<p class="text-sm text-red-500">${error?.message || 'Could not load clauses.'}</p>`; return; }

  wizardState.clauses = clauses.map(c => ({ ...c, enabled: true }));
  renderClauseList();
}

function renderClauseList() {
  const container = document.getElementById('lw-clause-list');
  container.innerHTML = wizardState.clauses.map((c, i) => `
    <div class="clause-row border border-gray-200 rounded-lg p-4 ${c.enabled ? '' : 'disabled'}" data-clause-index="${i}">
      <div class="flex items-start justify-between gap-3 mb-2">
        <label class="flex items-center gap-2 font-semibold text-navy text-sm">
          <input type="checkbox" class="clause-toggle" data-clause-index="${i}" ${c.enabled ? 'checked' : ''} ${c.is_mandatory ? 'disabled' : ''}>
          ${c.clause_title} ${c.is_mandatory ? '<span class="text-xs text-gold font-normal">(mandatory)</span>' : ''}
        </label>
        <div class="flex gap-1 flex-shrink-0">
          <button type="button" class="clause-up text-xs text-gray-400 hover:text-navy px-1.5" data-clause-index="${i}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
          <button type="button" class="clause-down text-xs text-gray-400 hover:text-navy px-1.5" data-clause-index="${i}" ${i === wizardState.clauses.length - 1 ? 'disabled' : ''}>&darr;</button>
        </div>
      </div>
      <textarea class="field clause-text text-xs" rows="2" data-clause-index="${i}">${c.clause_text}</textarea>
    </div>
  `).join('');

  container.querySelectorAll('.clause-toggle').forEach(el => el.addEventListener('change', (e) => {
    wizardState.clauses[Number(e.target.dataset.clauseIndex)].enabled = e.target.checked;
    renderClauseList();
  }));
  container.querySelectorAll('.clause-text').forEach(el => el.addEventListener('input', (e) => {
    wizardState.clauses[Number(e.target.dataset.clauseIndex)].clause_text = e.target.value;
  }));
  container.querySelectorAll('.clause-up').forEach(el => el.addEventListener('click', (e) => {
    const i = Number(e.target.dataset.clauseIndex);
    if (i > 0) { [wizardState.clauses[i - 1], wizardState.clauses[i]] = [wizardState.clauses[i], wizardState.clauses[i - 1]]; renderClauseList(); }
  }));
  container.querySelectorAll('.clause-down').forEach(el => el.addEventListener('click', (e) => {
    const i = Number(e.target.dataset.clauseIndex);
    if (i < wizardState.clauses.length - 1) { [wizardState.clauses[i + 1], wizardState.clauses[i]] = [wizardState.clauses[i], wizardState.clauses[i + 1]]; renderClauseList(); }
  }));
}

function wireDocumentInputs() {
  document.querySelectorAll('.lw-doc-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const category = e.target.dataset.category;
      if (e.target.files[0]) wizardState.documents[category] = e.target.files[0];
      else delete wizardState.documents[category];
    });
  });
}

function wireWizardNav() {
  const steps = document.querySelectorAll('.wizard-step');
  const dots = document.querySelectorAll('[data-step-dot]');
  const backBtn = document.getElementById('lw-back');
  const nextBtn = document.getElementById('lw-next');
  const submitBtn = document.getElementById('lw-submit');
  const totalSteps = steps.length;

  function showStep(n) {
    wizardState.step = n;
    steps.forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    dots.forEach(d => {
      const dn = Number(d.dataset.stepDot);
      d.classList.toggle('active', dn === n);
      d.classList.toggle('done', dn < n);
    });
    backBtn.disabled = n === 1;
    nextBtn.classList.toggle('hidden', n === totalSteps);
    submitBtn.classList.toggle('hidden', n !== totalSteps);
    if (n === 10) renderPreview();
  }

  function validateStep(n) {
    const errorEl = document.getElementById('lw-error');
    errorEl.classList.add('hidden');
    if (n === 1 && !document.getElementById('lw-property').value) return 'Select a property.';
    if (n === 3 && !document.getElementById('lw-tenant').value) return 'Select a primary tenant.';
    if (n === 5 && !document.getElementById('lw-template').value) return 'Select a master template.';
    if (n === 6) {
      if (!document.getElementById('lw-monthly-rent').value) return 'Enter the monthly rent.';
      if (!document.getElementById('lw-deposit-required').value) return 'Enter the deposit required.';
    }
    if (n === 8) {
      if (!document.getElementById('lw-start-date').value) return 'Select a start date.';
      if (!document.getElementById('lw-end-date').value) return 'Select an end date.';
      if (document.getElementById('lw-end-date').value <= document.getElementById('lw-start-date').value) return 'End date must be after start date.';
    }
    if (n === 9 && !wizardState.documents['Tenant_FICA']) return 'Tenant FICA document is mandatory.';
    return null;
  }

  nextBtn.addEventListener('click', () => {
    const err = validateStep(wizardState.step);
    if (err) {
      const errorEl = document.getElementById('lw-error');
      errorEl.textContent = err;
      errorEl.classList.remove('hidden');
      return;
    }
    if (wizardState.step < totalSteps) showStep(wizardState.step + 1);
  });

  backBtn.addEventListener('click', () => { if (wizardState.step > 1) showStep(wizardState.step - 1); });

  document.getElementById('lease-wizard-form').addEventListener('submit', handleWizardSubmit);
  showStep(1);
}

// Binds {{MergeField}} tokens in template_html against real values.
// Deliberately simple/explicit rather than a generic templating engine —
// only the fields listed here are ever substituted.
function mergeTemplate(html, values) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

async function buildPreviewValues() {
  const propertySelect = document.getElementById('lw-property');
  const tenantSelect = document.getElementById('lw-tenant');
  const tenantId = tenantSelect.value;
  const startDate = document.getElementById('lw-start-date').value;
  const endDate = document.getElementById('lw-end-date').value;

  let tenantEmail = '', tenantPhone = '';
  if (tenantId) {
    const { data: tenantProfile } = await supabaseClient.from('profiles').select('email, phone').eq('id', tenantId).single();
    tenantEmail = tenantProfile?.email || '';
    tenantPhone = tenantProfile?.phone || '';
  }
  let ownerEmail = '';
  const ownerId = propertySelect.selectedOptions[0]?.dataset.ownerId;
  if (ownerId) {
    const { data: ownerProfile } = await supabaseClient.from('profiles').select('email').eq('id', ownerId).single();
    ownerEmail = ownerProfile?.email || '';
  }

  const monthlyRental = 'R' + (parseFloat(document.getElementById('lw-monthly-rent').value) || 0).toLocaleString();
  const deposit = 'R' + (parseFloat(document.getElementById('lw-deposit-required').value) || 0).toLocaleString();

  return {
    // Spec's exact field names
    TenantName: tenantSelect.selectedOptions[0]?.textContent || '',
    TenantID: tenantId || '',
    TenantEmail: tenantEmail,
    TenantPhone: tenantPhone,
    OwnerName: document.getElementById('lw-owner-display').textContent || '',
    OwnerEmail: ownerEmail,
    PropertyAddress: propertySelect.selectedOptions[0]?.textContent || '',
    UnitNumber: '', // no separate units table in this system
    LeaseStartDate: startDate,
    LeaseEndDate: endDate,
    MonthlyRental: monthlyRental,
    Deposit: deposit,
    Parking: 'R' + (parseFloat(document.getElementById('lw-parking').value) || 0).toLocaleString(),
    Electricity: 'R' + (parseFloat(document.getElementById('lw-electricity').value) || 0).toLocaleString(),
    Water: 'R' + (parseFloat(document.getElementById('lw-water').value) || 0).toLocaleString(),
    Fibre: 'R' + (parseFloat(document.getElementById('lw-fibre').value) || 0).toLocaleString(),
    LateInterest: '', // no stored field for this yet
    PropertyManager: currentUser?.full_name || '',
    EmergencyContact: '',
    InspectionDate: '',
    RenewalDate: '',
    CurrentDate: new Date().toLocaleDateString(),
    // Kept for backward compatibility with the seed template, which
    // uses the shorter names.
    StartDate: startDate,
    EndDate: endDate,
    DepositRequired: deposit,
  };
}

async function renderPreview() {
  const templateId = document.getElementById('lw-template').value;
  const container = document.getElementById('lw-preview');
  if (!templateId) { container.innerHTML = '<p class="text-gray-400">No template selected.</p>'; return; }

  const { data: template } = await supabaseClient.from('lease_templates').select('content_html').eq('id', templateId).single();
  const merged = mergeTemplate(template?.content_html || '', await buildPreviewValues());
  const clausesHtml = wizardState.clauses.filter(c => c.enabled)
    .map(c => `<div class="mb-4"><p class="font-semibold text-navy mb-1">${c.clause_title}</p><p>${c.clause_text}</p></div>`).join('');

  container.innerHTML = `<div class="mb-6">${merged}</div><hr class="my-4 border-gray-200"><div>${clausesHtml}</div>`;
}

async function handleWizardSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('lw-error');
  const successEl = document.getElementById('lw-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const submitBtn = document.getElementById('lw-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    const propertyId = document.getElementById('lw-property').value;
    const tenantId = document.getElementById('lw-tenant').value;
    const guarantorId = document.getElementById('lw-guarantor').value || null;
    const templateId = document.getElementById('lw-template').value;
    const monthlyRent = parseFloat(document.getElementById('lw-monthly-rent').value) || 0;
    const depositRequired = parseFloat(document.getElementById('lw-deposit-required').value) || 0;
    const depositStatus = document.getElementById('lw-deposit-status').value;
    const parking = parseFloat(document.getElementById('lw-parking').value) || 0;
    const electricity = parseFloat(document.getElementById('lw-electricity').value) || 0;
    const water = parseFloat(document.getElementById('lw-water').value) || 0;
    const fibre = parseFloat(document.getElementById('lw-fibre').value) || 0;
    const commission = parseFloat(document.getElementById('lw-commission').value) || 0;
    const startDate = document.getElementById('lw-start-date').value;
    const endDate = document.getElementById('lw-end-date').value;
    const escalationMonth = document.getElementById('lw-escalation-month').value || null;
    const enabledClauseIds = wizardState.clauses.filter(c => c.enabled).map(c => c.id);
    const escalations = collectEscalations();

    // 1. Create the lease itself, status Draft, FICA Pending.
    const { data: lease, error: leaseError } = await supabaseClient.from('leases').insert([{
      tenant_id: tenantId,
      property_id: propertyId,
      guarantor_id: guarantorId,
      start_date: startDate,
      end_date: endDate,
      monthly_rent: monthlyRent,
      status: 'Draft',
      deposit_required: depositRequired,
      deposit_status: depositStatus,
      parking, electricity, water, fibre, commission,
      terms_version: 1,
      fica_status: 'Pending',
      template_id: templateId,
      escalation_month: escalationMonth,
      enabled_clause_ids: enabledClauseIds,
    }]).select().single();
    if (leaseError) throw leaseError;

    // 1b. Record any escalation periods. previous_rental_amount for the
    // first escalation is the base rent; each subsequent one compounds
    // off the previous escalation's new_rental_amount, matching the
    // spec's multi-period example (Year 1 base, Year 2 +8%, Year 3 +6%
    // off the Year 2 amount, not the base).
    let runningRental = monthlyRent;
    const sortedEscalations = [...escalations].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    for (const esc of sortedEscalations) {
      const newRental = Math.round(runningRental * (1 + esc.percentage / 100) * 100) / 100;
      const { error: escError } = await supabaseClient.from('lease_escalations').insert([{
        lease_id: lease.id,
        escalation_type: esc.escalation_type,
        effective_date: esc.effective_date,
        percentage: esc.percentage,
        previous_rental_amount: runningRental,
        new_rental_amount: newRental,
        created_by: currentUser.id,
      }]);
      if (escError) throw escError;
      runningRental = newRental;
    }

    // 2. Upload each collected verification document and log it.
    for (const [category, file] of Object.entries(wizardState.documents)) {
      const storagePath = `documents/lease-files/${lease.id}/${category}/${file.name}`;
      await uploadLeaseFile(file, storagePath);
      const { error: docError } = await supabaseClient.from('lease_documents').insert([{
        lease_id: lease.id,
        category,
        original_filename: file.name,
        storage_path: storagePath,
        uploaded_by: currentUser.id,
      }]);
      if (docError) throw docError;
    }

    // 3. Audit log the creation.
    await supabaseClient.from('lease_audit_logs').insert([{
      lease_id: lease.id,
      user_id: currentUser.id,
      action_performed: 'Lease created',
      previous_state: null,
      new_state: 'Draft',
    }]);

    successEl.textContent = 'Lease saved as Draft. It now needs FICA approval before it can be sent for signature.';
    successEl.classList.remove('hidden');
    setTimeout(() => { window.location.href = 'lease-dashboard.html'; }, 1800);
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save Draft';
  }
}

function uploadLeaseFile(file, path) {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Session expired — log in again.'));
    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Upload failed: ' + xhr.responseText));
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(file);
  });
}

/* ================================================================
   DASHBOARD / REGISTER
   ================================================================ */
let registerLeases = [];
let registerSort = { key: 'end_date', dir: 'asc' };

async function initDashboard() {
  await loadKpis();
  await loadFicaReviewList();
  await loadRenewalsDueList();
  await loadRegister();
  wireRegisterControls();
  wireAuditModal();
}

async function loadKpis() {
  const { data: leases } = await supabaseClient.from('leases').select('status, fica_status, end_date');
  const { data: properties } = await supabaseClient.from('properties').select('id, occupancy_status');

  const active = (leases || []).filter(l => l.status === 'Active' || l.status === 'Active_Month_to_Month').length;
  const pendingSig = (leases || []).filter(l => l.status === 'Pending Signature' || l.status === 'Partially Signed').length;
  const ficaPending = (leases || []).filter(l => l.fica_status === 'Pending').length;
  const occupied = (properties || []).filter(p => p.occupancy_status === 'Occupied').length;
  const occupancyRate = properties?.length ? ((occupied / properties.length) * 100).toFixed(1) + '%' : '—';

  const ninetyDaysOut = new Date(); ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90);
  const upcoming = (leases || []).filter(l => {
    if (!l.end_date || !['Active', 'Renewal_Due'].includes(l.status)) return false;
    return new Date(l.end_date) <= ninetyDaysOut && new Date(l.end_date) >= new Date();
  }).length;

  setText('kpi-active-leases', active);
  setText('kpi-pending-signatures', pendingSig);
  setText('kpi-fica-pending', ficaPending);
  setText('kpi-occupancy', occupancyRate);
  setText('kpi-upcoming-expiries', upcoming);
}

async function loadFicaReviewList() {
  const { data: leases } = await supabaseClient
    .from('leases')
    .select('id, fica_status, properties ( address ), profiles:tenant_id ( full_name )')
    .eq('fica_status', 'Pending');

  const container = document.getElementById('fica-review-list');
  if (!leases || leases.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-3">Nothing awaiting FICA review.</p>';
    return;
  }

  container.innerHTML = leases.map(l => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0" data-fica-row="${l.id}">
      <div>
        <p class="font-semibold text-navy text-sm">${l.profiles?.full_name || 'Unknown tenant'}</p>
        <p class="text-xs text-gray-500">${l.properties?.address || '—'}</p>
      </div>
      <div class="flex gap-2">
        <button data-fica-view="${l.id}" class="learn-more text-xs">View FICA doc</button>
        <button data-fica-approve="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-green-600 text-white hover:bg-green-700 transition">Approve</button>
        <button data-fica-reject="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-600 text-white hover:bg-red-700 transition">Reject</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-fica-view]').forEach(btn => btn.addEventListener('click', () => viewFicaDocument(btn.dataset.ficaView)));
  container.querySelectorAll('[data-fica-approve]').forEach(btn => btn.addEventListener('click', () => setFicaStatus(btn.dataset.ficaApprove, 'Approved')));
  container.querySelectorAll('[data-fica-reject]').forEach(btn => btn.addEventListener('click', () => setFicaStatus(btn.dataset.ficaReject, 'Rejected')));
}

async function viewFicaDocument(leaseId) {
  // Same mobile popup-blocker fix as the tenant Invoices download:
  // window.open() must happen synchronously within the click to work
  // reliably on mobile browsers, so open a blank tab first and redirect
  // it once we actually have the signed URL.
  const newTab = window.open('', '_blank', 'noopener');
  const { data: doc } = await supabaseClient.from('lease_documents').select('storage_path').eq('lease_id', leaseId).eq('category', 'Tenant_FICA').single();
  if (!doc) { if (newTab) newTab.close(); alert('No FICA document found for this lease.'); return; }
  const { data, error } = await supabaseClient.storage.from('documents').createSignedUrl(doc.storage_path, 300);
  if (error) { if (newTab) newTab.close(); alert('Could not open file: ' + error.message); return; }
  if (newTab) { newTab.location.href = data.signedUrl; } else { window.location.href = data.signedUrl; }
}

async function setFicaStatus(leaseId, status) {
  const { data: lease } = await supabaseClient.from('leases').select('fica_status').eq('id', leaseId).single();

  const { error } = await supabaseClient.from('leases').update({
    fica_status: status,
    fica_reviewed_by: currentUser.id,
    fica_reviewed_at: new Date().toISOString(),
  }).eq('id', leaseId);

  if (error) { alert('Could not update FICA status: ' + error.message); return; }

  await supabaseClient.from('lease_audit_logs').insert([{
    lease_id: leaseId,
    user_id: currentUser.id,
    action_performed: `FICA ${status.toLowerCase()}`,
    previous_state: lease?.fica_status || null,
    new_state: status,
  }]);

  if (status === 'Approved') {
    await notifyLeaseEvent(leaseId, 'lease_fica_approved');
  }

  await loadFicaReviewList();
  await loadKpis();
}

/* ---------------- Renewals Due panel ---------------- */
async function loadRenewalsDueList() {
  const ninetyDaysOut = new Date(); ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90);
  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: leases } = await supabaseClient
    .from('leases')
    .select('id, end_date, monthly_rent, properties ( address ), profiles:tenant_id ( full_name )')
    .eq('status', 'Active')
    .gte('end_date', todayStr)
    .lte('end_date', ninetyDaysOut.toISOString().slice(0, 10));

  // Exclude any lease that already has a renewal decision recorded.
  const { data: existingRenewals } = await supabaseClient.from('lease_renewals').select('lease_id');
  const decidedIds = new Set((existingRenewals || []).map(r => r.lease_id));
  const pending = (leases || []).filter(l => !decidedIds.has(l.id));

  const container = document.getElementById('renewals-due-list');
  if (pending.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400 py-3">No renewals due in the next 90 days.</p>';
    return;
  }

  container.innerHTML = pending.map(l => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div>
        <p class="font-semibold text-navy text-sm">${l.profiles?.full_name || 'Unknown tenant'}</p>
        <p class="text-xs text-gray-500">${l.properties?.address || '—'} &middot; Ends ${new Date(l.end_date).toLocaleDateString()}</p>
      </div>
      <div class="flex gap-2 flex-wrap">
        <button data-renew="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-green-600 text-white hover:bg-green-700 transition">Renew</button>
        <button data-month-to-month="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-yellow-500 text-white hover:bg-yellow-600 transition">Month-to-Month</button>
        <button data-terminate="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-600 text-white hover:bg-red-700 transition">Terminate</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-renew]').forEach(btn => btn.addEventListener('click', () => recordRenewalDecision(btn.dataset.renew, 'Renew')));
  container.querySelectorAll('[data-month-to-month]').forEach(btn => btn.addEventListener('click', () => recordRenewalDecision(btn.dataset.monthToMonth, 'Month_to_Month')));
  container.querySelectorAll('[data-terminate]').forEach(btn => btn.addEventListener('click', () => recordRenewalDecision(btn.dataset.terminate, 'Terminate')));
}

// Records the decision. Actually CREATING the new lease for a "Renew"
// choice, or scheduling the move-out inspection for "Terminate", are
// meaningfully separate follow-up actions the spec describes — this
// records the decision itself, which is what stops the automatic
// month-to-month rollover from firing, and is the piece the cron job
// checks. Building the "auto-create next lease" / "auto-schedule
// move-out inspection" flows out is a reasonable next increment, not
// done here to keep this from growing even further.
async function recordRenewalDecision(leaseId, renewalType) {
  const { data: lease } = await supabaseClient.from('leases').select('status, monthly_rent').eq('id', leaseId).single();

  const { error } = await supabaseClient.from('lease_renewals').insert([{
    lease_id: leaseId,
    renewal_type: renewalType,
    new_rental_amount: renewalType === 'Renew' ? lease?.monthly_rent : null,
    renewal_status: 'Approved',
  }]);
  if (error) { alert('Could not record renewal decision: ' + error.message); return; }

  if (renewalType === 'Month_to_Month') {
    await supabaseClient.from('leases').update({ status: 'Active_Month_to_Month' }).eq('id', leaseId);
  } else if (renewalType === 'Terminate') {
    await supabaseClient.from('leases').update({ status: 'Expired' }).eq('id', leaseId);
  }

  await supabaseClient.from('lease_audit_logs').insert([{
    lease_id: leaseId, user_id: currentUser.id, action_performed: `Renewal decision recorded: ${renewalType}`,
    previous_state: lease?.status, new_state: renewalType === 'Renew' ? lease?.status : renewalType,
  }]);

  await loadRenewalsDueList();
  await loadRegister();
  await loadKpis();
}


async function loadRegister() {
  const { data: leases, error } = await supabaseClient
    .from('leases')
    .select('*, properties ( address ), profiles:tenant_id ( full_name )')
    .order('end_date', { ascending: true });

  const tbody = document.getElementById('register-tbody');
  if (error) { tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`; return; }

  registerLeases = leases || [];
  renderRegister();
}

function renderRegister() {
  const search = document.getElementById('register-search').value.toLowerCase();
  const statusFilter = document.getElementById('register-status-filter').value;
  const dateFrom = document.getElementById('register-date-from').value;
  const dateTo = document.getElementById('register-date-to').value;

  let rows = registerLeases.filter(l => {
    if (statusFilter && l.status !== statusFilter) return false;
    if (dateFrom && l.end_date < dateFrom) return false;
    if (dateTo && l.end_date > dateTo) return false;
    if (search) {
      const haystack = `${l.properties?.address || ''} ${l.profiles?.full_name || ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    const map = { property: a.properties?.address, tenant: a.profiles?.full_name, status: a.status, end_date: a.end_date };
    const mapB = { property: b.properties?.address, tenant: b.profiles?.full_name, status: b.status, end_date: b.end_date };
    const av = map[registerSort.key] || '', bv = mapB[registerSort.key] || '';
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return registerSort.dir === 'asc' ? cmp : -cmp;
  });

  const tbody = document.getElementById('register-tbody');
  if (rows.length === 0) { tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-sm text-gray-400 text-center">No leases match.</td></tr>`; return; }

  tbody.innerHTML = rows.map(l => `
    <tr class="border-b border-gray-100 text-sm">
      <td class="py-3 px-3 text-navy font-medium">${l.properties?.address || '—'}</td>
      <td class="py-3 px-3 text-gray-600">${l.profiles?.full_name || '—'}</td>
      <td class="py-3 px-3"><span class="text-xs font-semibold px-2.5 py-1 rounded-full ${statusColor(l.status)}">${l.status}</span></td>
      <td class="py-3 px-3 text-gray-600">${l.end_date ? new Date(l.end_date).toLocaleDateString() : '—'}</td>
      <td class="py-3 px-3">
        <div class="flex flex-wrap gap-2">
          <button data-audit="${l.id}" class="learn-more text-xs">Audit Trail</button>
          ${l.status === 'Draft' && l.fica_status === 'Approved' ? `<button data-send-signature="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-navy text-white hover:bg-navy-deep transition">Send for Signature</button>` : ''}
          ${l.status === 'Draft' && l.fica_status !== 'Approved' ? `<span class="text-xs text-gray-400 italic">Awaiting FICA</span>` : ''}
          ${['Active', 'Renewal_Due'].includes(l.status) ? `<button data-renewal-notice="${l.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full border border-gray-300 text-navy hover:border-gold transition">Renewal Notice</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-audit]').forEach(btn => btn.addEventListener('click', () => showAuditTrail(btn.dataset.audit)));
  tbody.querySelectorAll('[data-send-signature]').forEach(btn => btn.addEventListener('click', () => sendForSignature(btn.dataset.sendSignature)));
  tbody.querySelectorAll('[data-renewal-notice]').forEach(btn => btn.addEventListener('click', () => triggerRenewalNotice(btn.dataset.renewalNotice)));
}

function statusColor(status) {
  if (['Active'].includes(status)) return 'bg-green-100 text-green-700';
  if (['Active_Month_to_Month', 'Renewal_Due'].includes(status)) return 'bg-yellow-100 text-yellow-700';
  if (['Expired', 'Archived'].includes(status)) return 'bg-gray-100 text-gray-600';
  if (['Pending Signature', 'Partially Signed', 'Fully Signed', 'Pending Approval'].includes(status)) return 'bg-blue-100 text-blue-700';
  return 'bg-gray-100 text-gray-500'; // Draft
}

function wireRegisterControls() {
  ['register-search', 'register-status-filter', 'register-date-from', 'register-date-to'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderRegister);
  });
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      registerSort.dir = registerSort.key === key && registerSort.dir === 'asc' ? 'desc' : 'asc';
      registerSort.key = key;
      renderRegister();
    });
  });
}

/* ---------------- Send for Signature ----------------
   FICA-gated: the Send for Signature button only renders (see
   renderRegister above) when fica_status === 'Approved'. This function
   double-checks server-side data too, since the button's presence in
   the DOM isn't itself a security boundary — RLS is.

   Signing sequence: Tenant -> Guarantor (if any) -> Owner. Each
   party's lease_parties row is created upfront so the whole picture
   is visible immediately, but only the tenant's lease_signatures row
   gets an OTP issued now — the rest stay dormant until their turn,
   the same sequential pattern v1 built for tenant->guarantor, now
   extended to include the owner as the final required signer. */
async function sendForSignature(leaseId) {
  const { data: lease } = await supabaseClient
    .from('leases')
    .select('*, properties ( owner_id ), tenant:tenant_id ( full_name, email ), guarantor:guarantor_id ( full_name, email )')
    .eq('id', leaseId).single();

  if (!lease) { alert('Lease not found.'); return; }
  if (lease.fica_status !== 'Approved') { alert('FICA must be approved before sending for signature.'); return; }

  const ownerId = lease.properties?.owner_id;
  let ownerProfile = null;
  if (ownerId) {
    const { data } = await supabaseClient.from('profiles').select('full_name, email').eq('id', ownerId).single();
    ownerProfile = data;
  }

  // 1. Create a lease_parties row for every required signer.
  const partyRows = [
    { lease_id: leaseId, party_type: 'Tenant', user_id: lease.tenant_id, email: lease.tenant?.email, full_name: lease.tenant?.full_name },
  ];
  if (lease.guarantor_id) {
    partyRows.push({ lease_id: leaseId, party_type: 'Guarantor', user_id: lease.guarantor_id, email: lease.guarantor?.email, full_name: lease.guarantor?.full_name });
  }
  if (ownerId) {
    partyRows.push({ lease_id: leaseId, party_type: 'Owner', user_id: ownerId, email: ownerProfile?.email, full_name: ownerProfile?.full_name });
  }

  const { data: parties, error: partiesError } = await supabaseClient.from('lease_parties').insert(partyRows).select();
  if (partiesError) { alert('Could not create signing parties: ' + partiesError.message); return; }

  const tenantParty = parties.find(p => p.party_type === 'Tenant');

  // 2. Issue the tenant's OTP now — everyone else waits their turn.
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(); expires.setHours(expires.getHours() + 48);

  const { error } = await supabaseClient.from('lease_signatures').insert([{
    lease_id: leaseId,
    party_id: tenantParty.id,
    party_type: 'Tenant',
    signed_by: lease.tenant_id,
    otp_code: otp,
    otp_expires_at: expires.toISOString(),
    otp_verified: false,
  }]);
  if (error) { alert('Could not create signature record: ' + error.message); return; }

  // Dormant rows for whoever signs later — no OTP yet, created so the
  // full party list is visible on the lease immediately.
  const laterParties = parties.filter(p => p.party_type !== 'Tenant');
  if (laterParties.length > 0) {
    await supabaseClient.from('lease_signatures').insert(
      laterParties.map(p => ({ lease_id: leaseId, party_id: p.id, party_type: p.party_type, signed_by: p.user_id, otp_verified: false }))
    );
  }

  await supabaseClient.from('leases').update({ status: 'Pending Signature' }).eq('id', leaseId);
  await supabaseClient.from('lease_audit_logs').insert([{
    lease_id: leaseId, user_id: currentUser.id, action_performed: 'Sent for signature (tenant OTP issued)',
    previous_state: lease.status, new_state: 'Pending Signature',
  }]);

  await notifyLeaseEvent(leaseId, 'lease_signature_request', { otp, recipient_role: 'tenant' });

  alert('Signature request sent to the tenant.');
  await loadRegister();
  await loadKpis();
}

async function triggerRenewalNotice(leaseId) {
  await notifyLeaseEvent(leaseId, 'lease_renewal_reminder');
  await supabaseClient.from('lease_audit_logs').insert([{
    lease_id: leaseId, user_id: currentUser.id, action_performed: 'Manual renewal notice triggered',
  }]);
  alert('Renewal notice sent.');
}

/* ---------------- Audit trail modal ---------------- */
function wireAuditModal() {
  document.getElementById('audit-modal-close').addEventListener('click', () => document.getElementById('audit-modal').classList.add('hidden'));
}

async function showAuditTrail(leaseId) {
  const { data: logs } = await supabaseClient
    .from('lease_audit_logs').select('*, profiles:user_id ( full_name )').eq('lease_id', leaseId).order('timestamp', { ascending: false });

  const body = document.getElementById('audit-modal-body');
  if (!logs || logs.length === 0) {
    body.innerHTML = '<p class="text-sm text-gray-400">No audit entries yet.</p>';
  } else {
    body.innerHTML = logs.map(l => `
      <div class="py-3 border-b border-gray-100 last:border-0 text-sm">
        <p class="font-semibold text-navy">${l.action_performed}</p>
        <p class="text-xs text-gray-500">${l.profiles?.full_name || 'System'} &middot; ${new Date(l.timestamp).toLocaleString()}</p>
        ${l.previous_state || l.new_state ? `<p class="text-xs text-gray-400 mt-1">${l.previous_state || '—'} &rarr; ${l.new_state || '—'}</p>` : ''}
      </div>
    `).join('');
  }
  document.getElementById('audit-modal').classList.remove('hidden');
}

/* ---------------- Shared helpers ---------------- */
async function notifyLeaseEvent(leaseId, eventType, extra = {}) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ lease_event: eventType, lease_id: leaseId, ...extra }),
    });
  } catch (err) {
    console.error('Lease notification failed:', err);
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
