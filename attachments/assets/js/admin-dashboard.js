// Zanka Group — Admin Dashboard
// Requires supabase-client.js and auth.js loaded first.
//
// SECURITY NOTE: This dashboard uses the same public anon key as the rest
// of the site. It does NOT use (and must never use) the Supabase service
// role key — that key bypasses Row Level Security entirely and must only
// ever run on a private backend, never ship in browser JS. Instead, admin
// access is granted through RLS policies scoped to profiles.role = 'admin'
// (see admin-rls-policies.sql). If a user isn't an admin, these queries
// simply return no rows — they don't error, they return nothing.

let currentAdmin = null;

document.addEventListener('DOMContentLoaded', async () => {
  // requireSession redirects to admin-login.html and signs the user out
  // if their profiles.role isn't exactly 'admin'.
  currentAdmin = await requireSession('admin', 'admin-login.html');
  if (!currentAdmin) return;

  document.querySelectorAll('[data-admin-name]').forEach(el => {
    el.textContent = currentAdmin.full_name || currentAdmin.email;
  });

  await handleLogout('admin-login.html');
  wireSidebar();
  await loadAdminMetrics();
  await loadPortfolioTable();
  await loadGlobalMaintenance();
  await loadGlobalPayments();
  await populateRentalSelects();
  wireRentalUploadForm();
  await populateDirectSelects();
  wireDirectUploadForm();
  await populateAssignPropertyForm();
  wireAssignPropertyForm();
  await loadAssignmentsList();
  await populateInvoiceGenerateSelects();
  await initInvestorManagement();
  await initQuickLinkForm();
  wireInvoiceGenerateForm();
  await loadApprovalGrid();
  wireRejectModal();
});

/* ---------------- Sidebar section switching ---------------- */
function wireSidebar() {
  const links = document.querySelectorAll('[data-section-link]');
  const sections = document.querySelectorAll('[data-section]');
  const toggle = document.getElementById('sidebar-toggle');
  const nav = document.getElementById('sidebar-nav');

  function showSection(key) {
    sections.forEach(s => s.classList.toggle('hidden', s.dataset.section !== key));
    links.forEach(l => {
      const active = l.dataset.sectionLink === key;
      l.classList.toggle('bg-white/10', active);
      l.classList.toggle('text-white', active);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (window.innerWidth < 1024 && nav) nav.classList.add('hidden');
  }

  links.forEach(l => l.addEventListener('click', () => showSection(l.dataset.sectionLink)));
  if (toggle && nav) toggle.addEventListener('click', () => nav.classList.toggle('hidden'));
  showSection('dashboard');
}

/* ---------------- KPI cards ---------------- */
async function loadAdminMetrics() {
  const { data: properties, error: propError } = await supabaseClient
    .from('properties')
    .select('cost_price, rent_amount, occupancy_status');

  if (propError) {
    console.error('Could not load properties for admin metrics:', propError.message);
  }

  const { data: requests, error: reqError } = await supabaseClient
    .from('maintenance_requests')
    .select('status');

  if (reqError) {
    console.error('Could not load maintenance requests for admin metrics:', reqError.message);
  }

  if (properties) {
    const totalProperties = properties.length;
    const occupiedCount = properties.filter(p => p.occupancy_status === 'Occupied').length;
    const totalPortfolioValue = properties.reduce((sum, p) => sum + Number(p.cost_price || 0), 0);
    const totalExpectedIncome = properties.reduce((sum, p) => sum + Number(p.rent_amount || 0), 0);

    setText('admin-total-properties', totalProperties);
    setText('admin-occupancy-rate', totalProperties > 0 ? ((occupiedCount / totalProperties) * 100).toFixed(1) + '%' : '0%');
    setText('admin-portfolio-value', 'R' + totalPortfolioValue.toLocaleString());
    setText('admin-expected-income', 'R' + totalExpectedIncome.toLocaleString());
  }

  if (requests) {
    setText('admin-active-maintenance', requests.filter(r => r.status !== 'Completed').length);
  }
}

/* ---------------- Portfolio table (via admin_portfolio_overview view) ---------------- */
async function loadPortfolioTable() {
  const { data: portfolio, error } = await supabaseClient
    .from('admin_portfolio_overview')
    .select('*')
    .order('address', { ascending: true });

  const tbody = document.getElementById('admin-portfolio-tbody');
  if (!tbody) return;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`;
    return;
  }

  if (!portfolio || portfolio.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-sm text-gray-400 text-center">No properties found.</td></tr>`;
    return;
  }

  tbody.innerHTML = portfolio.map(item => `
    <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition text-sm">
      <td class="py-3.5 px-4 font-medium text-navy">${item.address || 'Unknown address'}</td>
      <td class="py-3.5 px-4 text-gray-600">R${Number(item.cost_price || 0).toLocaleString()}</td>
      <td class="py-3.5 px-4 text-gray-600">R${Number(item.rent_amount || 0).toLocaleString()}</td>
      <td class="py-3.5 px-4">
        <span class="text-xs font-semibold px-2.5 py-1 rounded-full ${item.occupancy_status === 'Occupied' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">
          ${item.occupancy_status || 'Vacant'}
        </span>
      </td>
      <td class="py-3.5 px-4 text-gray-500">
        ${item.tenant_name ? item.tenant_name : '<span class="text-gray-400 italic">None</span>'}
      </td>
    </tr>
  `).join('');
}

/* ---------------- Maintenance, across every property ---------------- */
async function loadGlobalMaintenance() {
  const { data: requests, error } = await supabaseClient
    .from('maintenance_requests')
    .select('*')
    .order('created_at', { ascending: false });

  const container = document.getElementById('admin-maintenance-list');
  if (!container) return;

  if (error) {
    container.innerHTML = `<p class="text-sm text-red-500 py-4 text-center">${error.message}</p>`;
    return;
  }

  if (!requests || requests.length === 0) {
    container.innerHTML = `<p class="text-sm text-gray-400 py-4 text-center">No maintenance requests logged.</p>`;
    return;
  }

  container.innerHTML = requests.map(r => `
    <div class="flex items-start justify-between py-3.5 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy text-sm">${r.title}</p>
        <p class="text-xs text-gray-500 mt-0.5">${r.description || 'No detail provided.'}</p>
        <span class="text-[10px] text-gray-400 block mt-1">Logged ${new Date(r.created_at).toLocaleDateString()}</span>
      </div>
      <span class="text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${r.status === 'Completed' ? 'bg-green-100 text-green-700' : r.status === 'In Progress' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}">
        ${r.status}
      </span>
    </div>
  `).join('');
}

/* ---------------- Payments, across every tenant ---------------- */
async function loadGlobalPayments() {
  const { data: payments, error } = await supabaseClient
    .from('payments')
    .select('*')
    .order('paid_at', { ascending: false });

  const renderInto = (id, rows) => {
    const tbody = document.getElementById(id);
    if (!tbody) return;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="3" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`;
      return;
    }
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="py-4 text-sm text-gray-400 text-center">No payments recorded.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(p => `
      <tr class="border-b border-gray-100 text-sm">
        <td class="py-3 px-2 text-gray-600">${p.paid_at ? new Date(p.paid_at).toLocaleDateString() : 'Pending'}</td>
        <td class="py-3 px-2 font-semibold text-navy">R${Number(p.amount).toLocaleString()}</td>
        <td class="py-3 px-2">
          <span class="text-xs font-semibold px-2.5 py-0.5 rounded-full ${p.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">
            ${p.status}
          </span>
        </td>
      </tr>`).join('');
  };

  // Full table on the Payments section; most recent 10 on the Dashboard section.
  renderInto('admin-payments-tbody', payments);
  renderInto('admin-payments-tbody-dashboard', (payments || []).slice(0, 10));
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/* ================================================================
   DOCUMENT MANAGEMENT SYSTEM
   Merged in from the standalone DMS build. Every category now
   supports two upload paths: admin uploads directly (immediate
   publish, no approval step) or a partner submits it (documents row
   only, admin approval REQUIRED before publish). Who receives it —
   owner only, or owner AND tenant — is fixed per category, regardless
   of which path it came through.
   ================================================================ */

/* ---------------- Category metadata ----------------
   audience: 'owner' | 'owner_tenant' — drives both which fields the
     upload forms show (tenant required or not) and who the Edge
     Function notifies on approval.
   requiresTenant: whether tenant_id must be set for this category.
   financialMode: 'generic' (single Amount field), 'rental' (the
     5-field utility breakdown), or 'none' (no financial fields at
     all — Inspection Report/Pictures/Bulletin aren't invoices).
   publish: builds the operational-table insert. null = no
     operational table exists for this category (Pictures, Bulletin)
     — approval just marks the documents row Approved, nothing else. */
const CATEGORY_CONFIG = {
  'Lease': {
    audience: 'owner_tenant',
    requiresTenant: true,
    financialMode: 'generic',
    publish: (doc) => ({
      table: 'leases',
      row: {
        tenant_id: doc.tenant_id,
        property_id: doc.property_id,
        start_date: doc.document_date,
        end_date: doc.due_date,
        monthly_rent: doc.total_amount,
        status: 'Active',
        file_url: doc.signed_url,
      },
    }),
  },
  'Rent/Utility Invoice': {
    audience: 'owner_tenant',
    requiresTenant: true,
    financialMode: 'rental',
    publish: (doc) => ({
      table: 'rental_invoices',
      row: {
        property_id: doc.property_id,
        invoice_date: doc.document_date,
        net_rental: doc.breakdown.net_rental,
        electricity: doc.breakdown.electricity,
        water: doc.breakdown.water,
        sewerage: doc.breakdown.sewerage,
        other_charges: doc.breakdown.other_charges,
      },
    }),
  },
  'Inspection Report': {
    audience: 'owner_tenant',
    requiresTenant: true,
    financialMode: 'none',
    // ASSUMES inspections has the same thin shape as statements/
    // contractor_invoices (id, owner_id, title, file_url) — confirm
    // against the real schema before relying on this in production.
    publish: (doc) => ({
      table: 'inspections',
      row: {
        owner_id: doc.owner_id,
        title: doc.generated_filename,
        file_url: doc.signed_url,
      },
    }),
  },
  'Pictures': {
    audience: 'owner_tenant',
    requiresTenant: true,
    financialMode: 'none',
    publish: null, // no operational table — approval just marks it Approved
  },
  'Bulletin': {
    audience: 'owner_tenant',
    requiresTenant: true,
    financialMode: 'none',
    publish: null,
  },
  'Commission Statement': {
    audience: 'owner',
    requiresTenant: false,
    financialMode: 'generic',
    publish: (doc) => ({
      table: 'commissions',
      row: {
        partner_id: doc.partner_id,
        property_id: doc.property_id,
        description: doc.generated_filename,
        amount: doc.total_amount,
        status: 'Approved',
      },
    }),
  },
  'Maintenance Invoice': {
    audience: 'owner',
    requiresTenant: false,
    financialMode: 'generic',
    // partner_invoices.job_id is nullable, confirmed — safe to omit here
    // since this pipeline isn't tied to a specific `jobs` row.
    publish: (doc) => ({
      table: 'partner_invoices',
      row: {
        property_id: doc.property_id,
        owner_id: doc.owner_id,
        partner_id: doc.partner_id,
        amount: doc.total_amount,
        file_url: doc.signed_url,
        status: 'Approved',
      },
    }),
  },
  'Professional Fees Invoice': {
    // Attorneys, transfer attorneys, bond attorneys, conveyancers,
    // accountants, valuers — any professional-services invoice billed
    // to the owner. Structurally identical to Maintenance Invoice
    // (partner bills owner, no tenant involved), so it shares the same
    // partner_invoices table — just a distinct category label so it's
    // tracked and named correctly rather than lumped in as "maintenance."
    audience: 'owner',
    requiresTenant: false,
    financialMode: 'generic',
    publish: (doc) => ({
      table: 'partner_invoices',
      row: {
        property_id: doc.property_id,
        owner_id: doc.owner_id,
        partner_id: doc.partner_id,
        amount: doc.total_amount,
        file_url: doc.signed_url,
        status: 'Approved',
      },
    }),
  },
  'Owner Statement': {
    audience: 'owner',
    requiresTenant: false,
    financialMode: 'generic',
    publish: (doc) => ({
      table: 'statements',
      row: {
        owner_id: doc.owner_id,
        title: doc.generated_filename,
        file_url: doc.signed_url,
      },
    }),
  },
};

const DOCUMENT_CATEGORY_FOLDERS = {
  'Lease': 'leases',
  'Rent/Utility Invoice': 'rent-utility-invoices',
  'Inspection Report': 'inspection-reports',
  'Pictures': 'pictures',
  'Bulletin': 'bulletins',
  'Commission Statement': 'commission-statements',
  'Maintenance Invoice': 'maintenance-invoices',
  'Professional Fees Invoice': 'professional-fees-invoices',
  'Owner Statement': 'owner-statements',
};

function sanitiseSegment(text) {
  return String(text || 'NA').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildGeneratedFilename({ documentDate, category, propertyCode, tenantName, statementMonth, extension }) {
  return [
    documentDate,
    sanitiseSegment(category),
    sanitiseSegment(propertyCode),
    sanitiseSegment(tenantName),
    sanitiseSegment(statementMonth),
  ].join('_') + '.' + extension;
}

/* Direct XHR upload to Supabase Storage — the browser SDK's storage.upload()
   has no progress callback, so this hits the Storage REST endpoint directly.
   formKind picks which progress bar elements to update ('rental' here). */
function uploadFileWithProgress(file, path, formKind = 'rental') {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Your session expired — please log in again.'));

    const progressWrap = document.getElementById(`${formKind}-progress-wrap`);
    const progressBar = document.getElementById(`${formKind}-progress-bar`);
    const progressLabel = document.getElementById(`${formKind}-progress-label`);
    if (progressWrap) progressWrap.classList.remove('hidden');

    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (progressBar) progressBar.style.width = pct + '%';
      if (progressLabel) progressLabel.textContent = pct + '%';
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('File upload failed: ' + xhr.responseText));
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(file);
  });
}

async function notifyEdgeFunction(payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    // Kept non-blocking (this always runs after the real data write
    // already succeeded — a failed email shouldn't undo that), but now
    // actually logs the real reason instead of staying silent when the
    // Edge Function itself returns an error status.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Edge Function notification failed:', res.status, body);
    }
  } catch (err) {
    console.error('Edge Function notification failed:', err);
  }
}

/* ================= Rent/Utility Invoice — direct admin upload ================= */
let rentalUploadFile = null;

async function populateRentalSelects() {
  // Excludes 10%-package properties — those are invoiced exclusively
  // through the Generate Invoice panel above, to avoid the same
  // tenant getting billed twice through two different flows.
  const { data: properties } = await supabaseClient
    .from('properties')
    .select('id, address, owner_id')
    .neq('package_tier', '10%')
    .order('address');
  const propSelect = document.getElementById('rental-property');
  if (!propSelect) return;
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}">${p.address}</option>`).join('');

  const tenantSelect = document.getElementById('rental-tenant');
  tenantSelect.innerHTML = '<option value="">Select a property first</option>';
  tenantSelect.disabled = true;

  // Tenant list is scoped to whichever property is selected — pulled via
  // that property's leases, not a flat list of every tenant in the
  // system. Without this, nothing stopped picking a property and a
  // tenant who has no actual lease connecting them.
  propSelect.addEventListener('change', () => populateTenantsForProperty(propSelect.value, tenantSelect));

  // Pull the Net Rental figure straight from the tenant's active lease
  // (leases.monthly_rent) rather than leaving it blank for manual entry
  // — this is the "lease amount flows into the rental invoice" link.
  // Still editable afterward, in case a specific month needs a
  // one-off adjustment.
  tenantSelect.addEventListener('change', () => {
    const rent = tenantSelect.selectedOptions[0]?.dataset.monthlyRent;
    const netRentalInput = document.getElementById('rental-net-rental');
    if (rent && netRentalInput) {
      netRentalInput.value = rent;
      recalculateRentalTotals();
    }
  });
}

async function populateTenantsForProperty(propertyId, tenantSelect) {
  if (!propertyId) {
    tenantSelect.innerHTML = '<option value="">Select a property first</option>';
    tenantSelect.disabled = true;
    return;
  }

  const { data: leases, error } = await supabaseClient
    .from('leases')
    .select('tenant_id, monthly_rent, start_date, profiles:tenant_id ( id, full_name )')
    .eq('property_id', propertyId)
    .order('start_date', { ascending: false });

  if (error || !leases || leases.length === 0) {
    tenantSelect.innerHTML = '<option value="">No tenant on lease for this property</option>';
    tenantSelect.disabled = true;
    return;
  }

  // A property can have lease history (past + current tenants) — de-dupe
  // in case of renewals creating multiple lease rows for the same tenant.
  // Since leases are ordered most-recent-first, the first row kept per
  // tenant is also their most recent lease — which is what we want for
  // pulling the current monthly_rent onto each option.
  const seen = new Set();
  const uniqueTenants = leases
    .filter(l => l.profiles && !seen.has(l.profiles.id) && seen.add(l.profiles.id))
    .map(l => ({ ...l.profiles, monthly_rent: l.monthly_rent }));

  tenantSelect.disabled = false;
  tenantSelect.innerHTML = '<option value="">Select a tenant</option>' +
    uniqueTenants.map(t => `<option value="${t.id}" data-monthly-rent="${t.monthly_rent || 0}">${t.full_name}</option>`).join('');
}

function wireRentalUploadForm() {
  const form = document.getElementById('rental-upload-form');
  if (!form) return;

  const dropzone = document.getElementById('rental-dropzone');
  const fileInput = document.getElementById('rental-file-input');
  const MAX_BYTES = 20 * 1024 * 1024;

  function setFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { alert('File exceeds the 20MB limit.'); return; }
    rentalUploadFile = file;
    const nameEl = document.getElementById('rental-file-name');
    nameEl.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`;
    nameEl.classList.remove('hidden');
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => setFile(e.target.files[0]));
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-gold'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-gold'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-gold');
    setFile(e.dataTransfer.files[0]);
  });

  document.querySelectorAll('.rental-financial-input').forEach(el => {
    el.addEventListener('input', recalculateRentalTotals);
  });

  form.addEventListener('submit', handleRentalUploadSubmit);
}

function recalculateRentalTotals() {
  let subtotal = 0;
  ['rental-net-rental', 'rental-electricity', 'rental-water', 'rental-sewerage', 'rental-other-charges'].forEach(id => {
    subtotal += parseFloat(document.getElementById(id).value) || 0;
  });
  const discount = parseFloat(document.getElementById('rental-discount').value) || 0;
  const vat = parseFloat(document.getElementById('rental-vat').value) || 0;
  const total = subtotal - discount + vat;

  document.getElementById('rental-subtotal').textContent = 'R' + subtotal.toFixed(2);
  document.getElementById('rental-total').textContent = 'R' + total.toFixed(2);
}

async function handleRentalUploadSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('rental-error');
  const successEl = document.getElementById('rental-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  if (!rentalUploadFile) {
    errorEl.textContent = 'Attach a file before publishing.';
    errorEl.classList.remove('hidden');
    return;
  }

  const submitBtn = document.getElementById('rental-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Publishing…';

  try {
    const propertySelect = document.getElementById('rental-property');
    const propertyId = propertySelect.value;
    const ownerId = propertySelect.selectedOptions[0]?.dataset.ownerId || null;
    const tenantSelect = document.getElementById('rental-tenant');
    const tenantId = tenantSelect.value;
    const statementMonth = document.getElementById('rental-statement-month').value;
    const documentDate = document.getElementById('rental-document-date').value;

    if (!propertyId || !tenantId || !statementMonth || !documentDate) {
      throw new Error('All fields are required.');
    }

    const extension = (rentalUploadFile.name.split('.').pop() || 'pdf').toLowerCase();
    const generatedFilename = buildGeneratedFilename({
      documentDate, category: 'Rent/Utility Invoice', propertyCode: propertyId,
      tenantName: tenantSelect.selectedOptions[0]?.textContent || 'NA',
      statementMonth, extension,
    });

    const [year, month] = statementMonth.split('-');
    const storagePath = `documents/rent-utility-invoices/${propertyId}/${tenantId}/${year}/${month}/${generatedFilename}`;

    await uploadFileWithProgress(rentalUploadFile, storagePath, 'rental');

    const breakdown = {
      net_rental: parseFloat(document.getElementById('rental-net-rental').value) || 0,
      electricity: parseFloat(document.getElementById('rental-electricity').value) || 0,
      water: parseFloat(document.getElementById('rental-water').value) || 0,
      sewerage: parseFloat(document.getElementById('rental-sewerage').value) || 0,
      other_charges: parseFloat(document.getElementById('rental-other-charges').value) || 0,
    };
    const subtotal = Object.values(breakdown).reduce((s, v) => s + v, 0);
    const discount = parseFloat(document.getElementById('rental-discount').value) || 0;
    const vat = parseFloat(document.getElementById('rental-vat').value) || 0;
    const totalAmount = subtotal - discount + vat;

    // Publish immediately — no Pending Approval state for this category.
    const { data: opRow, error: opError } = await supabaseClient
      .from('rental_invoices').insert([{
        property_id: propertyId,
        invoice_date: documentDate,
        net_rental: breakdown.net_rental,
        electricity: breakdown.electricity,
        water: breakdown.water,
        sewerage: breakdown.sewerage,
        other_charges: breakdown.other_charges,
      }]).select().single();
    if (opError) throw opError;

    const { data: docRow, error: docError } = await supabaseClient.from('documents').insert([{
      category: 'Rent/Utility Invoice',
      property_id: propertyId,
      tenant_id: tenantId,
      owner_id: ownerId,
      partner_id: null,
      statement_month: statementMonth + '-01',
      document_date: documentDate,
      due_date: null,
      original_filename: rentalUploadFile.name,
      generated_filename: generatedFilename,
      storage_path: storagePath,
      subtotal,
      discount,
      vat,
      total_amount: totalAmount,
      status: 'Approved',
      uploaded_by: currentAdmin.id,
      approved_by: currentAdmin.id,
      operational_table: 'rental_invoices',
      operational_id: String(opRow.id),
    }]).select().single();
    if (docError) throw docError;

    // Create the actual outstanding payment record. Without this, the
    // invoice only appears in the Rental Breakdown chart — the tenant's
    // Payment History table (and any "amount owed" view) reads from
    // `payments`, not `rental_invoices`, so publishing an invoice needs
    // to create something here too or nothing looks "outstanding."
    // Due date defaults to 7 days after the document date since this
    // form has no separate due-date field — adjust if you want a
    // different grace period.
    const dueDate = new Date(documentDate);
    dueDate.setDate(dueDate.getDate() + 7);

    const { error: paymentError } = await supabaseClient.from('payments').insert([{
      tenant_id: tenantId,
      amount: totalAmount,
      due_date: dueDate.toISOString().slice(0, 10),
      status: 'Pending',
    }]);
    if (paymentError) throw paymentError;

    // Single call — the Edge Function emails both tenant and owner for
    // this category+status combination on its own.
    await notifyEdgeFunction({
      document_id: docRow.id,
      status: 'Approved',
      recipient_context: 'tenant_and_owner',
      meta_notes: `Rental invoice published for ${statementMonth}.`,
    });

    successEl.textContent = 'Invoice published to owner and tenant.';
    successEl.classList.remove('hidden');
    document.getElementById('rental-upload-form').reset();
    rentalUploadFile = null;
    document.getElementById('rental-file-name').classList.add('hidden');
    document.getElementById('rental-progress-wrap').classList.add('hidden');
    document.getElementById('rental-progress-bar').style.width = '0%';
    recalculateRentalTotals();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publish to Owner & Tenant';
  }
}

/* ================= Partner submissions: approval grid ================= */
async function loadApprovalGrid() {
  const { data: documents, error } = await supabaseClient
    .from('documents')
    .select(`
      *,
      properties ( address ),
      uploader:profiles!uploaded_by ( full_name )
    `)
    .eq('status', 'Pending Approval')
    .order('created_at', { ascending: false });

  const tbody = document.getElementById('admin-approval-tbody');
  const banner = document.getElementById('admin-notification-banner');
  const bannerText = document.getElementById('admin-notification-text');
  if (!tbody) return;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`;
    return;
  }

  if (!documents || documents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-4 text-sm text-gray-400 text-center">No documents awaiting review.</td></tr>`;
    if (banner) banner.classList.add('hidden');
    return;
  }

  if (banner) {
    banner.classList.remove('hidden');
    bannerText.textContent = `${documents.length} document${documents.length === 1 ? '' : 's'} awaiting your review.`;
  }

  tbody.innerHTML = documents.map(doc => `
    <tr class="border-b border-gray-100 text-sm" data-doc-row="${doc.id}">
      <td class="py-3 px-3 text-navy font-medium">${doc.uploader?.full_name || 'Unknown'}</td>
      <td class="py-3 px-3 text-gray-600">${doc.category}</td>
      <td class="py-3 px-3 text-gray-600">${doc.properties?.address || '—'}</td>
      <td class="py-3 px-3 text-gray-600">${doc.statement_month ? new Date(doc.statement_month).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }) : '—'}</td>
      <td class="py-3 px-3 font-semibold text-navy">R${Number(doc.total_amount).toLocaleString()}</td>
      <td class="py-3 px-3"><button data-preview="${doc.id}" data-path="${doc.storage_path}" class="learn-more text-xs">Preview</button></td>
      <td class="py-3 px-3">
        <div class="flex gap-2">
          <button data-approve="${doc.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-green-600 text-white hover:bg-green-700 transition">Approve</button>
          <button data-reject="${doc.id}" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-red-600 text-white hover:bg-red-700 transition">Reject</button>
        </div>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => previewDocument(btn.dataset.path));
  });
  tbody.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveDocument(btn.dataset.approve, documents.find(d => d.id === btn.dataset.approve)));
  });
  tbody.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', () => openRejectModal(btn.dataset.reject));
  });
}

async function previewDocument(path) {
  const { data, error } = await supabaseClient.storage.from('documents').createSignedUrl(path, 300);
  if (error) { alert('Could not open file: ' + error.message); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

async function approveDocument(docId, doc) {
  if (!doc) return;
  const config = CATEGORY_CONFIG[doc.category];
  if (!config) { alert('Unknown category — cannot publish.'); return; }

  // Some categories (Lease, Rent/Utility Invoice, Inspection Report,
  // Pictures, Bulletin) require a tenant to reach the tenant-facing
  // side. Catch a missing one here with a clear message instead of
  // either a raw DB error (for categories with a NOT NULL tenant_id
  // column) or a silently owner-only publish (for the rest).
  if (config.requiresTenant && !doc.tenant_id) {
    alert(`This ${doc.category} has no tenant attached and cannot be approved. Reject it with feedback asking the partner to resubmit with a tenant selected.`);
    return;
  }

  try {
    // Long-lived signed URL so the resulting dashboard link keeps
    // working — the bucket is private by design.
    const { data: signedUrlData, error: signErr } = await supabaseClient
      .storage.from('documents').createSignedUrl(doc.storage_path, 60 * 60 * 24 * 365 * 10);
    if (signErr) throw signErr;

    let operationalTable = null;
    let operationalId = null;

    // Pictures and Bulletin have no operational table to publish into —
    // the document itself, once Approved, IS the deliverable. Skip the
    // insert step entirely for these.
    if (config.publish) {
      const publishPayload = config.publish({ ...doc, signed_url: signedUrlData.signedUrl });
      const { data: opRow, error: opError } = await supabaseClient
        .from(publishPayload.table).insert([publishPayload.row]).select().single();
      if (opError) throw opError;
      operationalTable = publishPayload.table;
      operationalId = String(opRow.id);
    }

    const { error: updateError } = await supabaseClient.from('documents').update({
      status: 'Approved',
      approved_by: currentAdmin.id,
      operational_table: operationalTable,
      operational_id: operationalId,
    }).eq('id', docId);
    if (updateError) throw updateError;

    await notifyEdgeFunction({
      document_id: docId,
      status: 'Approved',
      recipient_context: 'owner',
      meta_notes: `Your ${doc.category} has been approved and published.`,
    });

    await loadApprovalGrid();
  } catch (err) {
    alert('Approval failed: ' + err.message);
  }
}

/* ---------------- Reject ---------------- */
let rejectingDocId = null;

function openRejectModal(docId) {
  rejectingDocId = docId;
  document.getElementById('reject-notes').value = '';
  document.getElementById('reject-modal').classList.remove('hidden');
}

function wireRejectModal() {
  const modal = document.getElementById('reject-modal');
  const cancelBtn = document.getElementById('reject-cancel');
  const confirmBtn = document.getElementById('reject-confirm');
  if (!modal) return;

  cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));

  confirmBtn.addEventListener('click', async () => {
    const notes = document.getElementById('reject-notes').value.trim();
    if (!notes) { alert('Rejection feedback notes are required.'); return; }

    const { error } = await supabaseClient.from('documents').update({
      status: 'Rejected',
      rejection_notes: notes,
      approved_by: currentAdmin.id,
    }).eq('id', rejectingDocId);

    if (error) { alert('Could not reject document: ' + error.message); return; }

    await notifyEdgeFunction({
      document_id: rejectingDocId,
      status: 'Rejected',
      recipient_context: 'partner',
      meta_notes: notes,
    });

    modal.classList.add('hidden');
    await loadApprovalGrid();
  });
}

/* ================= Admin direct upload — every other category ================= */
let directUploadFile = null;

async function populateDirectSelects() {
  const { data: properties } = await supabaseClient.from('properties').select('id, address, owner_id').order('address');
  const propSelect = document.getElementById('direct-property');
  if (!propSelect) return;
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}">${p.address}</option>`).join('');

  const tenantSelect = document.getElementById('direct-tenant');
  tenantSelect.innerHTML = '<option value="">Select a property first</option>';

  propSelect.addEventListener('change', () => populateTenantsForProperty(propSelect.value, tenantSelect));

  const categorySelect = document.getElementById('direct-category');
  categorySelect.addEventListener('change', () => applyDirectCategoryRules(categorySelect.value));
}

function applyDirectCategoryRules(category) {
  const config = CATEGORY_CONFIG[category];
  const tenantWrap = document.getElementById('direct-tenant-wrap');
  const tenantSelect = document.getElementById('direct-tenant');
  const requiredMark = document.getElementById('direct-tenant-required-mark');
  const financialWrap = document.getElementById('direct-financial-wrap');
  const financialSummary = document.getElementById('direct-financial-summary');

  if (!config) {
    tenantSelect.required = false;
    requiredMark.textContent = '';
    financialWrap.classList.remove('hidden');
    financialSummary.classList.remove('hidden');
    return;
  }

  tenantSelect.required = !!config.requiresTenant;
  requiredMark.textContent = config.requiresTenant ? '(required — this document goes to the owner AND tenant)' : '(optional — this document is owner-only)';

  const showFinancials = config.financialMode !== 'none';
  financialWrap.classList.toggle('hidden', !showFinancials);
  financialSummary.classList.toggle('hidden', !showFinancials);
  recalculateDirectTotals();
}

function wireDirectUploadForm() {
  const form = document.getElementById('direct-upload-form');
  if (!form) return;

  const dropzone = document.getElementById('direct-dropzone');
  const fileInput = document.getElementById('direct-file-input');
  const MAX_BYTES = 20 * 1024 * 1024;

  function setFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { alert('File exceeds the 20MB limit.'); return; }
    directUploadFile = file;
    const nameEl = document.getElementById('direct-file-name');
    nameEl.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`;
    nameEl.classList.remove('hidden');
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => setFile(e.target.files[0]));
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-gold'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-gold'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-gold');
    setFile(e.dataTransfer.files[0]);
  });

  document.querySelectorAll('.direct-financial-input').forEach(el => {
    el.addEventListener('input', recalculateDirectTotals);
  });

  form.addEventListener('submit', handleDirectUploadSubmit);
}

function recalculateDirectTotals() {
  const subtotal = parseFloat(document.getElementById('direct-amount').value) || 0;
  const discount = parseFloat(document.getElementById('direct-discount').value) || 0;
  const vat = parseFloat(document.getElementById('direct-vat').value) || 0;
  const total = subtotal - discount + vat;

  document.getElementById('direct-subtotal').textContent = 'R' + subtotal.toFixed(2);
  document.getElementById('direct-total').textContent = 'R' + total.toFixed(2);
}

async function handleDirectUploadSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('direct-error');
  const successEl = document.getElementById('direct-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const category = document.getElementById('direct-category').value;
  const config = CATEGORY_CONFIG[category];

  if (!category || !config) {
    errorEl.textContent = 'Select a document category.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!directUploadFile) {
    errorEl.textContent = 'Attach a file before publishing.';
    errorEl.classList.remove('hidden');
    return;
  }

  const propertySelect = document.getElementById('direct-property');
  const propertyId = propertySelect.value;
  const ownerId = propertySelect.selectedOptions[0]?.dataset.ownerId || null;
  const tenantId = document.getElementById('direct-tenant').value || null;

  if (config.requiresTenant && !tenantId) {
    errorEl.textContent = `${category} requires a tenant — this document must reach both the owner and the tenant.`;
    errorEl.classList.remove('hidden');
    return;
  }

  const submitBtn = document.getElementById('direct-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Publishing…';

  try {
    const statementMonth = document.getElementById('direct-statement-month').value;
    const documentDate = document.getElementById('direct-document-date').value;
    if (!propertyId || !statementMonth || !documentDate) throw new Error('All fields are required.');

    const extension = (directUploadFile.name.split('.').pop() || 'pdf').toLowerCase();
    const tenantLabel = document.getElementById('direct-tenant').selectedOptions[0]?.textContent || 'NA';
    const generatedFilename = buildGeneratedFilename({
      documentDate, category, propertyCode: propertyId,
      tenantName: tenantId ? tenantLabel : 'NA', statementMonth, extension,
    });

    const folder = DOCUMENT_CATEGORY_FOLDERS[category];
    const [year, month] = statementMonth.split('-');
    const storagePath = `documents/${folder}/${propertyId}/${tenantId || 'none'}/${year}/${month}/${generatedFilename}`;

    await uploadFileWithProgress(directUploadFile, storagePath, 'direct');

    const subtotal = config.financialMode === 'none' ? 0 : (parseFloat(document.getElementById('direct-amount').value) || 0);
    const discount = config.financialMode === 'none' ? 0 : (parseFloat(document.getElementById('direct-discount').value) || 0);
    const vat = config.financialMode === 'none' ? 0 : (parseFloat(document.getElementById('direct-vat').value) || 0);
    const totalAmount = subtotal - discount + vat;

    // Admin uploads publish immediately — status goes straight to
    // Approved, no Pending Approval stage, same as the Rent/Utility panel.
    const { data: signedUrlData, error: signErr } = await supabaseClient
      .storage.from('documents').createSignedUrl(storagePath, 60 * 60 * 24 * 365 * 10);
    if (signErr) throw signErr;

    let operationalTable = null;
    let operationalId = null;

    if (config.publish) {
      const publishPayload = config.publish({
        category, property_id: propertyId, tenant_id: tenantId, owner_id: ownerId,
        partner_id: null, document_date: documentDate, due_date: null,
        total_amount: totalAmount, generated_filename: generatedFilename,
        signed_url: signedUrlData.signedUrl,
      });
      const { data: opRow, error: opError } = await supabaseClient
        .from(publishPayload.table).insert([publishPayload.row]).select().single();
      if (opError) throw opError;
      operationalTable = publishPayload.table;
      operationalId = String(opRow.id);
    }

    const { data: docRow, error: docError } = await supabaseClient.from('documents').insert([{
      category,
      property_id: propertyId,
      tenant_id: tenantId,
      owner_id: ownerId,
      partner_id: null,
      statement_month: statementMonth + '-01',
      document_date: documentDate,
      due_date: null,
      original_filename: directUploadFile.name,
      generated_filename: generatedFilename,
      storage_path: storagePath,
      subtotal, discount, vat, total_amount: totalAmount,
      status: 'Approved',
      uploaded_by: currentAdmin.id,
      approved_by: currentAdmin.id,
      operational_table: operationalTable,
      operational_id: operationalId,
    }]).select().single();
    if (docError) throw docError;

    await notifyEdgeFunction({
      document_id: docRow.id,
      status: 'Approved',
      recipient_context: config.audience,
      meta_notes: `${category} published for ${statementMonth}.`,
    });

    successEl.textContent = `${category} published${config.audience === 'owner_tenant' ? ' to owner and tenant.' : ' to owner.'}`;
    successEl.classList.remove('hidden');
    document.getElementById('direct-upload-form').reset();
    directUploadFile = null;
    document.getElementById('direct-file-name').classList.add('hidden');
    document.getElementById('direct-progress-wrap').classList.add('hidden');
    document.getElementById('direct-progress-bar').style.width = '0%';
    applyDirectCategoryRules('');
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Publish';
  }
}

/* ================================================================
   AUTO-GENERATED TENANT INVOICING (10% package properties only)
   The system renders the actual branded invoice — no manual file
   upload. Invoice number and due date are computed, not typed:
   invoice_number via a DB trigger/sequence, due_date from the
   lease's own payment_terms_days rather than a hardcoded guess.
   ================================================================ */

async function populateInvoiceGenerateSelects() {
  const propSelect = document.getElementById('invoice-property');
  if (!propSelect) return;

  const { data: properties } = await supabaseClient
    .from('properties')
    .select('id, address, owner_id')
    .eq('package_tier', '10%')
    .order('address');

  const emptyNote = document.getElementById('invoice-property-empty-note');
  if (!properties || properties.length === 0) {
    propSelect.innerHTML = '<option value="">No 10% package properties</option>';
    propSelect.disabled = true;
    emptyNote.classList.remove('hidden');
    return;
  }

  emptyNote.classList.add('hidden');
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    properties.map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}">${p.address}</option>`).join('');

  const tenantSelect = document.getElementById('invoice-tenant');
  propSelect.addEventListener('change', () => populateInvoiceTenants(propSelect.value, tenantSelect));

  document.getElementById('invoice-date').valueAsDate = new Date();
  document.getElementById('invoice-date').addEventListener('change', updateInvoiceDueDateDisplay);

  document.querySelectorAll('.invoice-financial-input').forEach(el => {
    el.addEventListener('input', recalculateInvoiceTotal);
  });
}

// Parallel to populateTenantsForProperty (used by the manual panel),
// but also pulls payment_terms_days per lease — that's the actual
// "interval used in the lease" the due date needs to read from.
async function populateInvoiceTenants(propertyId, tenantSelect) {
  if (!propertyId) {
    tenantSelect.innerHTML = '<option value="">Select a property first</option>';
    tenantSelect.disabled = true;
    return;
  }

  const { data: leases, error } = await supabaseClient
    .from('leases')
    .select('tenant_id, monthly_rent, payment_terms_days, start_date, profiles:tenant_id ( id, full_name )')
    .eq('property_id', propertyId)
    .order('start_date', { ascending: false });

  if (error || !leases || leases.length === 0) {
    tenantSelect.innerHTML = '<option value="">No tenant on lease for this property</option>';
    tenantSelect.disabled = true;
    return;
  }

  const seen = new Set();
  const uniqueTenants = leases
    .filter(l => l.profiles && !seen.has(l.profiles.id) && seen.add(l.profiles.id))
    .map(l => ({ ...l.profiles, monthly_rent: l.monthly_rent, payment_terms_days: l.payment_terms_days || 15 }));

  tenantSelect.disabled = false;
  tenantSelect.innerHTML = '<option value="">Select a tenant</option>' +
    uniqueTenants.map(t => `<option value="${t.id}" data-monthly-rent="${t.monthly_rent || 0}" data-payment-terms="${t.payment_terms_days}">${t.full_name}</option>`).join('');

  tenantSelect.addEventListener('change', () => {
    const rent = tenantSelect.selectedOptions[0]?.dataset.monthlyRent;
    const netRentalInput = document.getElementById('invoice-net-rental');
    if (rent && netRentalInput) {
      netRentalInput.value = rent;
      recalculateInvoiceTotal();
    }
    updateInvoiceDueDateDisplay();
  });
}

function updateInvoiceDueDateDisplay() {
  const tenantSelect = document.getElementById('invoice-tenant');
  const termsDays = parseInt(tenantSelect.selectedOptions[0]?.dataset.paymentTerms, 10);
  const invoiceDateVal = document.getElementById('invoice-date').value;

  if (!termsDays || !invoiceDateVal) {
    document.getElementById('invoice-due-date-display').textContent = 'Select a tenant first';
    document.getElementById('invoice-terms-display').textContent = '—';
    return;
  }

  const dueDate = new Date(invoiceDateVal);
  dueDate.setDate(dueDate.getDate() + termsDays);

  document.getElementById('invoice-due-date-display').textContent = dueDate.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('invoice-terms-display').textContent = `Due in ${termsDays} days`;
}

function recalculateInvoiceTotal() {
  const total = ['invoice-net-rental', 'invoice-electricity', 'invoice-water', 'invoice-sewerage', 'invoice-refuse']
    .reduce((sum, id) => sum + (parseFloat(document.getElementById(id).value) || 0), 0);
  document.getElementById('invoice-total-due').textContent = 'R' + total.toLocaleString(undefined, { minimumFractionDigits: 2 });
}

function wireInvoiceGenerateForm() {
  const form = document.getElementById('invoice-generate-form');
  if (!form) return;
  form.addEventListener('submit', handleInvoiceGenerateSubmit);
}

async function handleInvoiceGenerateSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('invoice-error');
  const successEl = document.getElementById('invoice-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const propertySelect = document.getElementById('invoice-property');
  const tenantSelect = document.getElementById('invoice-tenant');
  const propertyId = propertySelect.value;
  const ownerId = propertySelect.selectedOptions[0]?.dataset.ownerId || null;
  const tenantId = tenantSelect.value;
  const tenantName = tenantSelect.selectedOptions[0]?.textContent || '';
  const termsDays = parseInt(tenantSelect.selectedOptions[0]?.dataset.paymentTerms, 10) || 15;
  const propertyAddress = propertySelect.selectedOptions[0]?.textContent || '';
  const invoiceDate = document.getElementById('invoice-date').value;

  if (!propertyId || !tenantId || !invoiceDate) {
    errorEl.textContent = 'Property, tenant and invoice date are all required.';
    errorEl.classList.remove('hidden');
    return;
  }

  const submitBtn = document.getElementById('invoice-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Generating…';

  try {
    const netRental = parseFloat(document.getElementById('invoice-net-rental').value) || 0;
    const electricity = parseFloat(document.getElementById('invoice-electricity').value) || 0;
    const water = parseFloat(document.getElementById('invoice-water').value) || 0;
    const sewerage = parseFloat(document.getElementById('invoice-sewerage').value) || 0;
    const refuse = parseFloat(document.getElementById('invoice-refuse').value) || 0;
    const totalDue = netRental + electricity + water + sewerage + refuse;

    const dueDate = new Date(invoiceDate);
    dueDate.setDate(dueDate.getDate() + termsDays);
    const dueDateStr = dueDate.toISOString().slice(0, 10);

    // Fetch tenant contact details for the "Bill To" block.
    const { data: tenantProfile } = await supabaseClient.from('profiles').select('phone').eq('id', tenantId).single();

    // 1. Create the invoice record — the trigger assigns invoice_number.
    const { data: invoice, error: invError } = await supabaseClient.from('tenant_invoices').insert([{
      lease_id: null, // resolved implicitly via property+tenant; not required for the record itself
      property_id: propertyId,
      tenant_id: tenantId,
      invoice_date: invoiceDate,
      due_date: dueDateStr,
      net_rental: netRental, electricity, water, sewerage, refuse,
      total_due: totalDue,
      status: 'Sent',
      created_by: currentAdmin.id,
    }]).select().single();
    if (invError) throw invError;

    // Everything from here on is wrapped so that ANY failure — the
    // Storage upload, or any of the three downstream inserts that
    // actually drive what tenant/owner see — deletes the invoice
    // record we just created rather than leaving an orphaned
    // tenant_invoices row with no matching document, chart entry, or
    // payment. This is the same rollback pattern used for lease
    // creation; it was missing here, which is exactly how an earlier
    // invoice ended up stuck with storage_path = null and nothing else.
    try {
      // 2. Render the branded invoice HTML with real values.
      const invoiceHtml = renderTenantInvoiceHtml({
        invoiceNumber: invoice.invoice_number,
        invoiceDate, dueDate: dueDateStr, termsDays,
        tenantName, tenantPhone: tenantProfile?.phone || '',
        propertyAddress,
        netRental, electricity, water, sewerage, refuse, totalDue,
      });

      // 3. Render the invoice HTML into a real PDF, then upload the PDF
      // to Storage. Tenants receive this via email/WhatsApp/download —
      // a raw .html file is unreliable across devices and apps (some
      // show source code instead of rendering it), whereas a .pdf opens
      // identically everywhere with no ambiguity.
      const invoicePdfBlob = await generateInvoicePdfBlob(invoiceHtml);
      const storagePath = `documents/tenant-invoices/${invoice.id}/${invoice.invoice_number}.pdf`;
      await uploadInvoiceFile(invoicePdfBlob, storagePath, 'application/pdf');
      const { error: pathUpdateError } = await supabaseClient.from('tenant_invoices').update({ storage_path: storagePath }).eq('id', invoice.id);
      if (pathUpdateError) throw pathUpdateError;

      // 4. Feed the existing Rental Breakdown chart — unchanged mechanism.
      const { error: rentalError } = await supabaseClient.from('rental_invoices').insert([{
        property_id: propertyId,
        invoice_date: invoiceDate,
        net_rental: netRental, electricity, water, sewerage,
        other_charges: refuse, // "Refuse" on this invoice IS this column, relabeled
      }]);
      if (rentalError) throw rentalError;

      // 5. Publish into `documents` too, so it shows in the tenant's
      // existing Invoices card and the owner's document views — same
      // place everything else already appears, not a separate list.
      const { data: docRow, error: docError } = await supabaseClient.from('documents').insert([{
        category: 'Rent/Utility Invoice',
        property_id: propertyId,
        tenant_id: tenantId,
        owner_id: ownerId,
        partner_id: null,
        statement_month: invoiceDate.slice(0, 7) + '-01',
        document_date: invoiceDate,
        due_date: dueDateStr,
        original_filename: `${invoice.invoice_number}.pdf`,
        generated_filename: `${invoice.invoice_number}.pdf`,
        storage_path: storagePath,
        subtotal: totalDue, discount: 0, vat: 0, total_amount: totalDue,
        status: 'Approved',
        uploaded_by: currentAdmin.id,
        approved_by: currentAdmin.id,
        operational_table: 'tenant_invoices',
        operational_id: String(invoice.id),
      }]).select().single();
      if (docError) throw docError;

      // 6. Create the actual outstanding payment, due date matching the lease.
      const { error: paymentError } = await supabaseClient.from('payments').insert([{
        tenant_id: tenantId,
        amount: totalDue,
        due_date: dueDateStr,
        status: 'Pending',
      }]);
      if (paymentError) throw paymentError;

      // 7. Notify tenant + owner — reuses the exact same Edge Function
      // path the manual upload flow already uses for this category.
      await notifyEdgeFunction({
        document_id: docRow.id,
        status: 'Approved',
        recipient_context: 'tenant_and_owner',
        meta_notes: `Invoice ${invoice.invoice_number} generated for ${invoiceDate}.`,
      });
    } catch (innerErr) {
      await supabaseClient.from('tenant_invoices').delete().eq('id', invoice.id);
      throw new Error(`${innerErr.message} — the incomplete invoice was removed, please try again.`);
    }

    successEl.textContent = `Invoice ${invoice.invoice_number} generated and sent — due ${new Date(dueDateStr).toLocaleDateString()}.`;
    successEl.classList.remove('hidden');
    document.getElementById('invoice-generate-form').reset();
    document.getElementById('invoice-date').valueAsDate = new Date();
    recalculateInvoiceTotal();
    document.getElementById('invoice-due-date-display').textContent = 'Select a tenant first';
    document.getElementById('invoice-terms-display').textContent = '—';
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate & Send Invoice';
  }
}

// Retries a failing operation up to `retries` times, only for
// transient-looking failures (5xx gateway/server errors, network
// errors) — not for real errors like RLS denials or bad input, which
// would just fail identically every time anyway. Short exponential
// backoff between attempts (1s, then 2s) since 504s are almost always
// resolved within a few seconds.
async function retryTransient(fn, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTransient = /5\d\d|Gateway|network|timeout/i.test(err.message || '');
      if (!isTransient || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Renders a self-contained invoice HTML string into an actual PDF Blob,
// using html2pdf.js (loaded in admin-dashboard.html). The HTML is drawn
// into an off-screen container (not visible to the admin) so the exact
// branded layout renders pixel-for-pixel, then converted to a single
// A4 PDF page and cleaned up afterward.
function generateInvoicePdfBlob(htmlString) {
  return new Promise((resolve, reject) => {
    // html2pdf.js's chained API (.from().toCanvas().toPdf()...) has
    // produced three different silent/broken results in testing.
    // html2canvas and jsPDF are both bundled inside html2pdf.bundle.min.js
    // and exposed as globals — calling them directly gives full control
    // and a clear error at each step instead of a black-box chain.
    const html2canvasFn = window.html2canvas;
    const jsPDFCtor = window.jspdf?.jsPDF || window.jsPDF;

    if (typeof html2canvasFn !== 'function' || typeof jsPDFCtor !== 'function') {
      reject(new Error('PDF library failed to load — check your internet connection and try again.'));
      return;
    }

    const MAX_Z = 2147483647;
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = '#ffffff';
    overlay.style.zIndex = String(MAX_Z);

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '800px';
    container.style.zIndex = String(MAX_Z - 1);
    container.innerHTML = htmlString;

    document.body.appendChild(container);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (container.parentNode) container.parentNode.removeChild(container);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    void container.offsetHeight;

    const capture = () => {
      html2canvasFn(container, { scale: 2, useCORS: true, logging: true })
        .then((canvas) => {
          console.log('[PDF DEBUG] canvas dimensions:', canvas.width, 'x', canvas.height);
          if (!canvas.width || !canvas.height) {
            throw new Error('html2canvas produced an empty canvas (0 dimensions).');
          }
          const imgData = canvas.toDataURL('image/jpeg', 0.98);
          const pdf = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'portrait' });
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = (canvas.height * pageWidth) / canvas.width;
          pdf.addImage(imgData, 'JPEG', 0, 0, pageWidth, pageHeight);
          const pdfBlob = pdf.output('blob');
          cleanup();
          resolve(pdfBlob);
        })
        .catch((err) => { cleanup(); reject(new Error('Failed to render invoice PDF: ' + (err?.message || err))); });
    };

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => setTimeout(capture, 150));
    } else {
      setTimeout(capture, 500);
    }
  });
}

function uploadInvoiceFile(blob, path, contentType) {
  return retryTransient(() => new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Session expired — log in again.'));
    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Invoice upload failed: ' + xhr.status + (xhr.status >= 500 ? ' Gateway error' : '')));
    xhr.onerror = () => reject(new Error('Network error uploading invoice.'));
    xhr.send(blob);
  }));
}

// Renders the exact Zanka Group branded template, populated with real
// data. Kept as a single self-contained HTML string (CSS inlined) so
// the stored file opens correctly on its own from Storage, with no
// dependency on the live site's stylesheet.
function renderTenantInvoiceHtml(d) {
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const fmtMoney = (n) => 'R ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const row = (label, amount) => `
          <tr>
            <td>${label}</td>
            <td class="num">${fmtMoney(amount)}</td>
            <td class="num">&ndash;</td>
            <td class="num total-col">${fmtMoney(amount)}</td>
          </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Invoice ${d.invoiceNumber} — Zanka Group</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap');
  :root{ --navy:#1F2A44; --navy-deep:#141C30; --gold:#C89B3C; --gold-light:#E4C77A; --off-white:#F4F4F4; --ink:#20242E; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'Inter', ui-sans-serif, system-ui, sans-serif; color:var(--ink); background:#fff; font-size:13px; }
  .font-display{ font-family:'Playfair Display', Georgia, serif; }
  .sheet{ max-width:800px; margin:0 auto; padding:0 0 40px 0; }
  .header{ background:var(--navy-deep); color:#fff; padding:32px 48px; display:flex; align-items:center; justify-content:space-between; }
  .brand{ display:flex; align-items:center; gap:14px; }
  .logo-mark{ width:44px; height:44px; border-radius:8px; background:var(--gold); color:var(--navy-deep); font-family:'Playfair Display', Georgia, serif; font-weight:800; font-size:22px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .brand-name{ line-height:1.15; }
  .brand-name .primary{ font-family:'Playfair Display', Georgia, serif; font-weight:700; font-size:19px; letter-spacing:.02em; }
  .brand-name .secondary{ font-size:10px; letter-spacing:.28em; color:#B9C0CF; font-weight:600; }
  .header-invoice-title{ text-align:right; }
  .header-invoice-title .label{ font-family:'Playfair Display', Georgia, serif; font-weight:700; font-size:26px; color:#fff; letter-spacing:.04em; }
  .header-invoice-title .ref{ font-size:11px; color:var(--gold-light); margin-top:2px; font-weight:600; }
  .accent-line{ height:4px; background:linear-gradient(90deg, var(--gold), var(--gold-light)); }
  .body{ padding:36px 48px 0 48px; }
  .meta-row{ display:flex; justify-content:space-between; gap:32px; margin-bottom:28px; }
  .meta-block .eyebrow{ font-size:10.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--gold); margin:0 0 8px 0; }
  .bill-to-card{ background:var(--off-white); border-radius:10px; padding:16px 18px; min-width:260px; }
  .bill-to-card .name{ font-family:'Playfair Display', Georgia, serif; font-weight:700; font-size:15px; color:var(--navy); margin:0 0 4px 0; }
  .bill-to-card .line{ color:#4B5163; line-height:1.55; }
  .dates-card{ text-align:right; }
  .dates-card .date-row{ margin-bottom:6px; }
  .dates-card .date-label{ color:#8A90A0; font-size:11px; margin-right:8px; }
  .dates-card .date-value{ font-weight:700; color:var(--navy); }
  .due-pill{ display:inline-block; margin-top:6px; background:#FBF3E3; color:#8A6416; font-weight:700; font-size:11px; padding:4px 12px; border-radius:999px; }
  table.charges{ width:100%; border-collapse:collapse; margin-bottom:20px; border-radius:10px; overflow:hidden; box-shadow:0 1px 2px rgba(20,28,48,.05), 0 8px 24px -14px rgba(20,28,48,.18); }
  table.charges thead th{ background:var(--navy); color:#fff; text-align:left; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; font-weight:700; padding:12px 16px; }
  table.charges thead th.num{ text-align:right; }
  table.charges tbody td{ padding:12px 16px; border-bottom:1px solid #ECEDF1; color:#333846; }
  table.charges tbody tr:last-child td{ border-bottom:none; }
  table.charges tbody td.num{ text-align:right; font-variant-numeric:tabular-nums; }
  table.charges tbody td.total-col{ font-weight:700; color:var(--navy); }
  table.charges tbody tr:nth-child(even){ background:#FAFAFB; }
  .total-due-row{ display:flex; justify-content:flex-end; margin:8px 0 28px 0; }
  .total-due-box{ background:var(--navy); border-radius:10px; padding:14px 22px; text-align:right; min-width:220px; }
  .total-due-box .label{ color:#B9C0CF; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; margin:0 0 4px 0; }
  .total-due-box .amount{ color:var(--gold-light); font-family:'Playfair Display', Georgia, serif; font-weight:800; font-size:24px; }
  .payment-section{ display:flex; gap:20px; margin-bottom:28px; }
  .payment-card{ flex:1; border:1px solid #E4E6EC; border-radius:10px; padding:16px 18px; }
  .payment-card .eyebrow{ font-size:10.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--gold); margin:0 0 10px 0; }
  .payment-card .row{ display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed #ECEDF1; font-size:12.5px; }
  .payment-card .row:last-child{ border-bottom:none; }
  .payment-card .row .k{ color:#8A90A0; }
  .payment-card .row .v{ color:var(--navy); font-weight:600; }
  .payment-card .note{ margin-top:10px; font-size:11px; color:#8A90A0; font-style:italic; }
  .footer{ text-align:center; padding-top:8px; border-top:1px solid #ECEDF1; }
  .footer .thanks{ font-family:'Playfair Display', Georgia, serif; font-style:italic; color:var(--navy); font-size:14px; margin:18px 0 6px 0; }
  .footer .fine-print{ font-size:10.5px; color:#9AA0AE; margin:0; }
  .footer .fine-print a{ color:var(--gold); text-decoration:none; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="brand">
        <div class="logo-mark">Z</div>
        <div class="brand-name">
          <div class="primary">ZANKA GROUP</div>
          <div class="secondary">PROPERTY MANAGEMENT</div>
        </div>
      </div>
      <div class="header-invoice-title">
        <div class="label">INVOICE</div>
        <div class="ref">Ref: ${d.invoiceNumber}</div>
      </div>
    </div>
    <div class="accent-line"></div>
    <div class="body">
      <div class="meta-row">
        <div class="meta-block">
          <p class="eyebrow">Bill To</p>
          <div class="bill-to-card">
            <p class="name">${d.tenantName}</p>
            <p class="line">${d.propertyAddress}</p>
            ${d.tenantPhone ? `<p class="line">${d.tenantPhone}</p>` : ''}
          </div>
        </div>
        <div class="meta-block dates-card">
          <p class="eyebrow">Details</p>
          <div class="date-row"><span class="date-label">Invoice Date</span><span class="date-value">${fmtDate(d.invoiceDate)}</span></div>
          <div class="date-row"><span class="date-label">Due Date</span><span class="date-value">${fmtDate(d.dueDate)}</span></div>
          <div class="due-pill">Due in ${d.termsDays} days</div>
        </div>
      </div>
      <table class="charges">
        <thead><tr><th>Description</th><th class="num">Charges</th><th class="num">Credits</th><th class="num">Total</th></tr></thead>
        <tbody>
          ${row('Rental Billed', d.netRental)}
          ${row('Electricity Billed in Arrears (Pro Rata)', d.electricity)}
          ${row('Water Billed in Arrears', d.water)}
          ${row('Sewage Billed in Arrears', d.sewerage)}
          ${row('Refuse Billed in Arrears', d.refuse)}
        </tbody>
      </table>
      <div class="total-due-row">
        <div class="total-due-box">
          <p class="label">Total Due</p>
          <p class="amount">${fmtMoney(d.totalDue)}</p>
        </div>
      </div>
      <div class="payment-section">
        <div class="payment-card">
          <p class="eyebrow">Payment Details</p>
          <div class="row"><span class="k">Account Name</span><span class="v">Zanka Group (Pty) Ltd</span></div>
          <div class="row"><span class="k">Bank</span><span class="v">FNB</span></div>
          <div class="row"><span class="k">Account Number</span><span class="v">63182018565</span></div>
          <div class="row"><span class="k">Branch Code</span><span class="v">250655</span></div>
          <div class="row"><span class="k">Account Type</span><span class="v">Current Account</span></div>
          <p class="note">This is Zanka Group's rental collection account for tenant payments.</p>
        </div>
        <div class="payment-card">
          <p class="eyebrow">Questions About This Invoice?</p>
          <div class="row"><span class="k">Email</span><span class="v">admin@zankagroup.co.za</span></div>
          <div class="row"><span class="k">Phone</span><span class="v">074 824 8812</span></div>
          <div class="row"><span class="k">WhatsApp</span><span class="v">+27 67 214 6008</span></div>
          <p class="note">Or download past invoices any time from your Tenant Portal.</p>
        </div>
      </div>
      <div class="footer">
        <p class="thanks">Thank you for your business.</p>
        <p class="fine-print">Zanka Group (Pty) Ltd &middot; Company Reg: 2025 / 862423 / 07 &middot; <a href="mailto:admin@zankagroup.co.za">admin@zankagroup.co.za</a> &middot; Sandton, Johannesburg, South Africa &middot; zankagroup.co.za</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/* ================= Assign properties to partners ================= */
async function populateAssignPropertyForm() {
  const partnerSelect = document.getElementById('assign-partner');
  const propertySelect = document.getElementById('assign-property');
  if (!partnerSelect || !propertySelect) return;

  const { data: partners } = await supabaseClient.from('profiles').select('id, full_name').eq('role', 'partner').order('full_name');
  partnerSelect.innerHTML = '<option value="">Select a partner</option>' +
    (partners || []).map(p => `<option value="${p.id}">${p.full_name}</option>`).join('');

  const { data: properties } = await supabaseClient.from('properties').select('id, address').order('address');
  propertySelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}">${p.address}</option>`).join('');
}

function wireAssignPropertyForm() {
  const form = document.getElementById('assign-property-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('assign-error');
    const successEl = document.getElementById('assign-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const partnerId = document.getElementById('assign-partner').value;
    const propertyId = document.getElementById('assign-property').value;

    const { error } = await supabaseClient.from('partner_property_assignments').insert([{
      partner_id: partnerId, property_id: propertyId, assigned_by: currentAdmin.id,
    }]);

    if (error) {
      errorEl.textContent = error.message.includes('duplicate') ? 'That partner is already assigned to this property.' : error.message;
      errorEl.classList.remove('hidden');
      return;
    }

    successEl.textContent = 'Assigned.';
    successEl.classList.remove('hidden');
    form.reset();
    await loadAssignmentsList();
  });
}

async function loadAssignmentsList() {
  const { data: assignments } = await supabaseClient
    .from('partner_property_assignments')
    .select('id, partner:partner_id ( full_name ), properties ( address )')
    .order('assigned_at', { ascending: false });

  const container = document.getElementById('assignments-list');
  if (!container) return;

  if (!assignments || assignments.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400">No assignments yet.</p>';
    return;
  }

  container.innerHTML = assignments.map(a => `
    <div class="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
      <span class="text-navy font-medium">${a.partner?.full_name || 'Unknown partner'}</span>
      <span class="text-gray-500">${a.properties?.address || 'Unknown property'}</span>
      <button data-unassign="${a.id}" class="text-xs text-red-500 hover:text-red-700">Remove</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-unassign]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await supabaseClient.from('partner_property_assignments').delete().eq('id', btn.dataset.unassign);
      await loadAssignmentsList();
    });
  });
}

/* ================================================================
   INVESTOR MANAGEMENT (admin)
   Investors are juristic entities, not individuals — this creates
   the entity, links a representative (an existing investor-role
   account, created manually in Supabase), and assigns properties
   with the valuation fields the investor dashboard needs.
   ================================================================ */

async function initInvestorManagement() {
  wireCreatePropertyForm();
  wireCreateProfileForm();
  wireCreateEntityForm();
  await populateRepForms();
  wireLinkRepForm();
  await populateEntityPropertyForm();
  wireAssignEntityPropertyForm();
  wireLoanCalcPreview();
  await loadEntitiesOverview();
}

function wireCreateEntityForm() {
  const form = document.getElementById('create-entity-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('entity-error');
    const successEl = document.getElementById('entity-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const { error } = await supabaseClient.from('investor_entities').insert([{
      entity_name: document.getElementById('entity-name').value.trim(),
      registration_number: document.getElementById('entity-registration').value.trim() || null,
      entity_type: document.getElementById('entity-type').value,
      created_by: currentAdmin.id,
    }]);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }
    successEl.textContent = 'Entity created.';
    successEl.classList.remove('hidden');
    form.reset();
    await populateRepForms();
    await populateEntityPropertyForm();
    await loadEntitiesOverview();
  });
}

async function populateRepForms() {
  const { data: entities } = await supabaseClient.from('investor_entities').select('id, entity_name').order('entity_name');
  const repEntitySelect = document.getElementById('rep-entity');
  if (repEntitySelect) {
    repEntitySelect.innerHTML = '<option value="">Select an entity</option>' +
      (entities || []).map(en => `<option value="${en.id}">${en.entity_name}</option>`).join('');
  }

  const { data: people } = await supabaseClient.from('profiles').select('id, full_name, role').in('role', ['investor', 'owner']).order('full_name');
  const repProfileSelect = document.getElementById('rep-profile');
  const emptyNote = document.getElementById('rep-profile-empty-note');
  if (repProfileSelect) {
    if (!people || people.length === 0) {
      repProfileSelect.innerHTML = '<option value="">No eligible accounts found</option>';
      repProfileSelect.disabled = true;
      if (emptyNote) emptyNote.classList.remove('hidden');
    } else {
      repProfileSelect.disabled = false;
      if (emptyNote) emptyNote.classList.add('hidden');
      // Owners linked this way don't need a separate investor login —
      // they access the Investor Portal from a button on their existing
      // Owner Portal session, added below.
      repProfileSelect.innerHTML = '<option value="">Select a person</option>' +
        people.map(p => `<option value="${p.id}">${p.full_name} (${p.role === 'owner' ? 'Owner account' : 'Investor account'})</option>`).join('');
    }
  }
}

function wireLinkRepForm() {
  const form = document.getElementById('link-rep-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('rep-error');
    const successEl = document.getElementById('rep-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const { error } = await supabaseClient.from('investor_representatives').insert([{
      entity_id: document.getElementById('rep-entity').value,
      profile_id: document.getElementById('rep-profile').value,
      title: document.getElementById('rep-title').value.trim(),
    }]);

    if (error) {
      errorEl.textContent = error.message.includes('duplicate') ? 'This person is already linked to this entity.' : error.message;
      errorEl.classList.remove('hidden');
      return;
    }
    successEl.textContent = 'Representative linked.';
    successEl.classList.remove('hidden');
    form.reset();
    await loadEntitiesOverview();
  });
}

async function populateEntityPropertyForm() {
  const { data: entities } = await supabaseClient.from('investor_entities').select('id, entity_name').order('entity_name');
  const entitySelect = document.getElementById('entity-property-entity');
  if (entitySelect) {
    entitySelect.innerHTML = '<option value="">Select an entity</option>' +
      (entities || []).map(en => `<option value="${en.id}">${en.entity_name}</option>`).join('');
  }

  const { data: properties } = await supabaseClient.from('properties').select('id, address').order('address');
  const propSelect = document.getElementById('entity-property-select');
  if (propSelect) {
    propSelect.innerHTML = '<option value="">Select a property</option>' +
      (properties || []).map(p => `<option value="${p.id}">${p.address}</option>`).join('');
  }
}

function wireAssignEntityPropertyForm() {
  const form = document.getElementById('assign-entity-property-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('entity-property-error');
    const successEl = document.getElementById('entity-property-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const marketValue = document.getElementById('entity-market-value').value;
    const loanAmount = document.getElementById('entity-loan-amount').value;
    const interestRate = document.getElementById('entity-interest-rate').value;
    const loanTerm = document.getElementById('entity-loan-term').value;
    const loanStart = document.getElementById('entity-loan-start').value;

    const { error } = await supabaseClient.from('properties').update({
      investor_entity_id: document.getElementById('entity-property-entity').value,
      property_type: document.getElementById('entity-property-type').value,
      current_market_value: marketValue ? parseFloat(marketValue) : null,
      loan_amount: loanAmount ? parseFloat(loanAmount) : null,
      interest_rate: interestRate ? parseFloat(interestRate) : null,
      loan_term_months: loanTerm ? parseInt(loanTerm, 10) : null,
      loan_start_date: loanStart || null,
    }).eq('id', document.getElementById('entity-property-select').value);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }
    successEl.textContent = 'Property assigned and saved.';
    successEl.classList.remove('hidden');
    form.reset();
    await loadEntitiesOverview();
  });
}

async function loadEntitiesOverview() {
  const container = document.getElementById('entities-overview-list');
  if (!container) return;

  const { data: entities } = await supabaseClient.from('investor_entities').select('id, entity_name, entity_type').order('entity_name');

  if (!entities || entities.length === 0) {
    container.innerHTML = '<p class="text-sm text-gray-400">No investor entities yet.</p>';
    return;
  }

  const rows = await Promise.all(entities.map(async (en) => {
    const { data: reps } = await supabaseClient.from('investor_representatives').select('title, profiles:profile_id ( full_name )').eq('entity_id', en.id);
    const { data: props } = await supabaseClient.from('properties').select('address').eq('investor_entity_id', en.id);

    const repList = (reps || []).map(r => `${r.profiles?.full_name || 'Unknown'} (${r.title || 'Representative'})`).join(', ') || 'No representative linked';
    const propList = (props || []).map(p => p.address).join(', ') || 'No properties assigned';

    return `
      <div class="py-3 border-b border-gray-100 last:border-0">
        <p class="font-semibold text-navy text-sm">${en.entity_name} <span class="text-xs text-gray-400 font-normal">${en.entity_type}</span></p>
        <p class="text-xs text-gray-500 mt-1">Representatives: ${repList}</p>
        <p class="text-xs text-gray-500">Properties: ${propList}</p>
      </div>`;
  }));

  container.innerHTML = rows.join('');
}

/* ================================================================
   LOAN AMORTIZATION — shared calculation
   Standard amortization formula, assuming consistent monthly
   payments: outstanding balance after k of n payments =
   P * [(1+i)^n - (1+i)^k] / [(1+i)^n - 1], where i is the monthly
   rate. Computed live, not stored/recalculated by a scheduled job —
   it's cheap enough to compute on every page load and never goes
   stale that way.
   ================================================================ */
function calculateOutstandingBalance(loanAmount, annualRatePct, termMonths, startDateStr) {
  if (!loanAmount || annualRatePct == null || !termMonths || !startDateStr) return null;

  const start = new Date(startDateStr);
  const now = new Date();
  let monthsElapsed = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  monthsElapsed = Math.max(0, Math.min(monthsElapsed, termMonths));

  if (monthsElapsed >= termMonths) return 0;

  const monthlyRate = (annualRatePct / 100) / 12;
  if (monthlyRate === 0) {
    // No interest — straight-line reduction.
    return loanAmount * (1 - monthsElapsed / termMonths);
  }

  const factorN = Math.pow(1 + monthlyRate, termMonths);
  const factorK = Math.pow(1 + monthlyRate, monthsElapsed);
  return loanAmount * (factorN - factorK) / (factorN - 1);
}

function wireLoanCalcPreview() {
  const inputs = document.querySelectorAll('.loan-calc-input');
  if (inputs.length === 0) return;
  inputs.forEach(el => el.addEventListener('input', updateLoanCalcPreview));
}

function updateLoanCalcPreview() {
  const loanAmount = parseFloat(document.getElementById('entity-loan-amount').value) || null;
  const rate = document.getElementById('entity-interest-rate').value;
  const term = parseInt(document.getElementById('entity-loan-term').value, 10) || null;
  const start = document.getElementById('entity-loan-start').value;

  const outstanding = calculateOutstandingBalance(loanAmount, rate === '' ? null : parseFloat(rate), term, start);
  const preview = document.getElementById('entity-outstanding-preview');
  preview.textContent = outstanding !== null ? 'R' + outstanding.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
}

/* ================================================================
   CREATE PROPERTY — no SQL. The id is a database identity column,
   assigned automatically the moment this INSERT runs.
   ================================================================ */
function wireCreatePropertyForm() {
  const form = document.getElementById('create-property-form');
  if (!form) return;

  populateOwnerSelectForPropertyForm();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-property-error');
    const successEl = document.getElementById('create-property-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const ownerId = document.getElementById('new-property-owner').value;
    if (!ownerId) {
      errorEl.textContent = 'Select an owner — every property needs one, there is no "assign later" option in this database.';
      errorEl.classList.remove('hidden');
      return;
    }

    const { data: property, error } = await supabaseClient.from('properties').insert([{
      name: document.getElementById('new-property-name').value.trim(),
      address: document.getElementById('new-property-address').value.trim(),
      owner_id: ownerId,
      units_count: parseInt(document.getElementById('new-property-units').value, 10) || 1,
      rent_amount: parseFloat(document.getElementById('new-property-rent').value) || 0,
      cost_price: parseFloat(document.getElementById('new-property-cost').value) || 0,
      package_tier: document.getElementById('new-property-package').value,
      occupancy_status: document.getElementById('new-property-occupancy').value,
    }]).select().single();

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }

    successEl.textContent = `Property created — ID ${property.id}.`;
    successEl.classList.remove('hidden');
    form.reset();

    // Refresh every dropdown elsewhere on this page that lists
    // properties, so the new one is immediately usable without a
    // page reload.
    await populateEntityPropertyForm();
    if (typeof populateRentalSelects === 'function') await populateRentalSelects();
    if (typeof populateDirectSelects === 'function') await populateDirectSelects();
    if (typeof populateInvoiceGenerateSelects === 'function') await populateInvoiceGenerateSelects();
  });
}

async function populateOwnerSelectForPropertyForm() {
  const select = document.getElementById('new-property-owner');
  if (!select) return;
  const { data: owners } = await supabaseClient.from('profiles').select('id, full_name').eq('role', 'owner').order('full_name');
  select.innerHTML = '<option value="">Select an owner</option>' +
    (owners || []).map(o => `<option value="${o.id}">${o.full_name}</option>`).join('');
}

/* ================================================================
   CREATE ACCOUNT PROFILE — works for owner/tenant/partner/investor.
   Only handles the profiles row; the actual login (auth.users) still
   has to be created in Supabase Dashboard first, since that requires
   privileges this browser session deliberately never has.
   ================================================================ */
function wireCreateProfileForm() {
  const form = document.getElementById('create-profile-form');
  if (!form) return;

  const roleSelect = document.getElementById('new-profile-role');
  const partnerTypeWrap = document.getElementById('new-profile-partner-type-wrap');
  roleSelect.addEventListener('change', () => {
    partnerTypeWrap.classList.toggle('hidden', roleSelect.value !== 'partner');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-profile-error');
    const successEl = document.getElementById('create-profile-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const uid = document.getElementById('new-profile-uid').value.trim();
    const role = roleSelect.value;

    const { error } = await supabaseClient.from('profiles').upsert([{
      id: uid,
      full_name: document.getElementById('new-profile-name').value.trim(),
      email: document.getElementById('new-profile-email').value.trim(),
      role,
    }]);

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }

    // Partners additionally need a partner_profiles row for their
    // type/category — same pattern already used by partner-signup.html.
    if (role === 'partner') {
      const partnerType = document.getElementById('new-profile-partner-type').value;
      const { error: partnerProfileError } = await supabaseClient.from('partner_profiles').upsert([{
        id: uid,
        partner_type: partnerType,
      }]);
      if (partnerProfileError) {
        errorEl.textContent = 'Profile created, but partner details failed: ' + partnerProfileError.message;
        errorEl.classList.remove('hidden');
        return;
      }
    }

    successEl.textContent = `${role.charAt(0).toUpperCase() + role.slice(1)} profile created.`;
    successEl.classList.remove('hidden');
    form.reset();
    partnerTypeWrap.classList.add('hidden');

    // Refresh dropdowns elsewhere that list people by role.
    await populateRepForms();
    await populateOwnerSelectForPropertyForm();
  });
}

/* ================================================================
   QUICK LINK: Tenant to Property
   A tenant-property connection in this system IS a lease record —
   there's no lighter-weight link. This creates one directly as
   Active, skipping FICA approval and e-signature entirely, for the
   common case of just needing to connect an already-verified tenant
   to a property administratively. Use the full Lease Wizard instead
   when FICA verification and formal e-signing actually matter.
   ================================================================ */
async function initQuickLinkForm() {
  const propSelect = document.getElementById('quick-link-property');
  const tenantSelect = document.getElementById('quick-link-tenant');
  if (!propSelect) return;

  const { data: properties } = await supabaseClient.from('properties').select('id, address, rent_amount').order('address');
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}" data-rent="${p.rent_amount || 0}">${p.address}</option>`).join('');

  const { data: tenants } = await supabaseClient.from('profiles').select('id, full_name').eq('role', 'tenant').order('full_name');
  tenantSelect.innerHTML = '<option value="">Select a tenant</option>' +
    (tenants || []).map(t => `<option value="${t.id}">${t.full_name}</option>`).join('');

  propSelect.addEventListener('change', () => {
    const rent = propSelect.selectedOptions[0]?.dataset.rent;
    const rentInput = document.getElementById('quick-link-rent');
    if (rent && rentInput && !rentInput.value) rentInput.value = rent;
  });

  const form = document.getElementById('quick-link-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('quick-link-error');
    const successEl = document.getElementById('quick-link-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const propertyId = propSelect.value;
    const tenantId = tenantSelect.value;
    const startDate = document.getElementById('quick-link-start').value;
    const endDate = document.getElementById('quick-link-end').value;
    const rent = parseFloat(document.getElementById('quick-link-rent').value) ||
      parseFloat(propSelect.selectedOptions[0]?.dataset.rent) || 0;

    if (endDate <= startDate) {
      errorEl.textContent = 'End date must be after the start date.';
      errorEl.classList.remove('hidden');
      return;
    }

    const { data: lease, error } = await supabaseClient.from('leases').insert([{
      tenant_id: tenantId,
      property_id: propertyId,
      start_date: startDate,
      end_date: endDate,
      monthly_rent: rent,
      status: 'Active',
      fica_status: 'Approved', // administrative link, not a formal e-signed lease
      terms_version: 1,
    }]).select().single();

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden');
      return;
    }

    await supabaseClient.from('lease_audit_logs').insert([{
      lease_id: lease.id,
      user_id: currentAdmin.id,
      action_performed: 'Tenant linked to property (quick admin link, no FICA/e-signature)',
      new_state: 'Active',
    }]);

    successEl.textContent = `Linked — lease #${lease.id} created and set Active.`;
    successEl.classList.remove('hidden');
    form.reset();

    // Also update the property's occupancy status, since it now has a tenant.
    await supabaseClient.from('properties').update({ occupancy_status: 'Occupied' }).eq('id', propertyId);
  });
}
