// Zanka Group — Partner dashboard
// Requires supabase-client.js and auth.js loaded first.

let currentPartner = null;
let currentJobs = [];

document.addEventListener('DOMContentLoaded', async () => {
  currentPartner = await requireSession('partner', 'partner-login.html');
  if (!currentPartner) return;

  document.querySelectorAll('[data-partner-name]').forEach(el => {
    el.textContent = currentPartner.full_name || currentPartner.email;
  });

  await handleLogout('partner-login.html');
  wireSidebar();
  const group = await loadPartnerProfile(currentPartner.id);
  if (group === 'agent') {
    wireListingForm(currentPartner.id);
    await populatePartnerInvoiceSelects();
    wirePartnerInvoiceGenerateForm();
    await loadPartnerPaymentHistory();
  } else {
    await loadJobs(currentPartner.id);
    await loadQuotes(currentPartner.id);
    await loadInvoices(currentPartner.id);
    wireQuoteForm(currentPartner.id);
    wireInvoiceForm(currentPartner.id);
  }
  await loadNotifications(currentPartner.id);
  wireProfileForm(currentPartner.id);
  await populatePropertyAndTenantSelects();
  wireWizard();
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
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('hidden'));
  }
  showSection('dashboard');
}

/* ---------------- Partner type badge ---------------- */
// Fallback map: legacy accounts created via partner-signup.html only ever
// saved a flat partner_type (e.g. "Estate Agent"), never a partner_category.
// This lets the dashboard route the right workspace for those accounts too.
const DASHBOARD_PARTNER_TYPE_CATEGORY_MAP = {
  'Estate Agent': 'Sales & Leasing',
  'Estate Agents': 'Sales & Leasing',
  'Rental Agents': 'Sales & Leasing',
  'Property Finders': 'Sales & Leasing',
  'Contractor': 'Maintenance & Trades',
  'Plumber': 'Maintenance & Trades',
  'Electrician': 'Maintenance & Trades',
  'Painter': 'Maintenance & Trades',
  'Security Company': 'Maintenance & Trades',
  'Cleaning Company': 'Maintenance & Trades',
  'Architect': 'Professional Services',
  'Engineer': 'Professional Services',
  'Conveyancer': 'Professional Services',
  'Attorney': 'Professional Services',
  'Valuer': 'Professional Services',
  'Accountant': 'Professional Services',
  'Inspector': 'Compliance & Inspections',
  'Insurance Assessor': 'Compliance & Inspections',
  'Photographer': 'Media & Marketing',
};

async function loadPartnerProfile(partnerId) {
  const { data: partnerProfile } = await supabaseClient
    .from('partner_profiles').select('*').eq('id', partnerId).maybeSingle();

  document.querySelectorAll('[data-partner-type]').forEach(el => {
    el.textContent = partnerProfile ? partnerProfile.partner_type : '';
  });

  if (partnerProfile) {
    setValue('profile-company', partnerProfile.company_name);
    setValue('profile-registration', partnerProfile.registration_number);
    setValue('profile-vat', partnerProfile.vat_number);
    setValue('profile-banking', partnerProfile.banking_details);
    setValue('profile-insurance', partnerProfile.insurance_details);
    setValue('profile-coverage', partnerProfile.coverage_area);
    setValue('profile-hours', partnerProfile.operating_hours);

    const categorySelect = document.getElementById('profile-category');
    const inferredCategory = partnerProfile.partner_category || DASHBOARD_PARTNER_TYPE_CATEGORY_MAP[partnerProfile.partner_type];
    if (categorySelect && inferredCategory) {
      categorySelect.value = inferredCategory;
      if (window.populatePartnerTypes) {
        window.populatePartnerTypes(inferredCategory, partnerProfile.partner_type);
      }
    }
  }
  setValue('profile-full-name', currentPartner.full_name);

  // Show the right workspace (trade vs agent) based on the partner's category.
  // Falls back to inferring the category from the legacy partner_type value
  // for accounts created before partner_category existed on this table.
  const resolvedCategory = partnerProfile
    ? (partnerProfile.partner_category || DASHBOARD_PARTNER_TYPE_CATEGORY_MAP[partnerProfile.partner_type])
    : null;
  const group = resolvedCategory === 'Sales & Leasing' ? 'agent' : 'trade';
  if (window.applyPartnerGroup) window.applyPartnerGroup(group);
  if (group === 'agent') {
    await loadListings(partnerId);
    await loadReferrals(partnerId);
    await loadViewings(partnerId);
    await loadApplications(partnerId);
    await loadCommission(partnerId);
  }
  return group;
}

/* ---------------- Jobs ---------------- */
async function loadJobs(partnerId) {
  const { data: jobs } = await supabaseClient
    .from('jobs').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });
  currentJobs = jobs || [];

  renderList('jobs-list', currentJobs, (j) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy truncate">${j.title}</p>
        <p class="text-xs text-gray-500">${j.scheduled_date ? new Date(j.scheduled_date).toLocaleDateString() : 'No date scheduled'}</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="text-xs font-semibold px-3 py-1 rounded-full ${jobStatusColor(j.status)}">${j.status}</span>
        ${j.status === 'Assigned' ? `<button data-accept-job="${j.id}" class="btn btn-outline-navy !py-1.5 !px-3 text-xs">Accept</button>` : ''}
      </div>
    </div>`);

  document.querySelectorAll('[data-accept-job]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const jobId = btn.getAttribute('data-accept-job');
      await supabaseClient.from('jobs').update({ status: 'Accepted' }).eq('id', jobId);
      await loadJobs(partnerId);
      updateKpis();
    });
  });

  populateJobSelect('quote-job', currentJobs);
  populateJobSelect('invoice-job', currentJobs);
  updateKpis();
}

function populateJobSelect(selectId, jobs) {
  const select = document.getElementById(selectId);
  if (!select) return;
  if (!jobs.length) {
    select.innerHTML = '<option value="">No jobs yet</option>';
    return;
  }
  select.innerHTML = jobs.map(j => `<option value="${j.id}">${j.title}</option>`).join('');
}

function jobStatusColor(status) {
  if (status === 'Completed' || status === 'Paid') return 'bg-green-100 text-green-700';
  if (status === 'Assigned') return 'bg-red-100 text-red-700';
  return 'bg-yellow-100 text-yellow-700';
}

/* ---------------- Quotes ---------------- */
async function loadQuotes(partnerId) {
  const { data: quotes } = await supabaseClient
    .from('quotes').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('quotes-list', quotes, (q) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy">R${Number(q.total_amount).toLocaleString()}</p>
        <p class="text-xs text-gray-500">${new Date(q.created_at).toLocaleDateString()}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${q.status === 'Approved' ? 'bg-green-100 text-green-700' : q.status === 'Rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">${q.status}</span>
    </div>`);

  updateKpis(quotes);
}

function wireQuoteForm(partnerId) {
  const form = document.getElementById('quote-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const jobId = document.getElementById('quote-job').value;
    const labour = parseFloat(document.getElementById('quote-labour').value) || 0;
    const materials = parseFloat(document.getElementById('quote-materials').value) || 0;
    const travel = parseFloat(document.getElementById('quote-travel').value) || 0;
    const vat = (labour + materials + travel) * 0.15;
    const total = labour + materials + travel + vat;

    const { error } = await supabaseClient.from('quotes').insert([{
      job_id: jobId || null,
      partner_id: partnerId,
      labour_cost: labour,
      materials_cost: materials,
      travel_cost: travel,
      vat_amount: vat,
      total_amount: total,
      warranty_period: document.getElementById('quote-warranty').value.trim(),
      estimated_duration: document.getElementById('quote-duration').value.trim(),
      notes: document.getElementById('quote-notes').value.trim(),
      status: 'Submitted',
    }]);

    const note = document.getElementById('quote-note');
    if (!error) {
      note.textContent = 'Quote submitted.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
      form.reset();
      await loadQuotes(partnerId);
      if (jobId) {
        await supabaseClient.from('jobs').update({ status: 'Quote Submitted' }).eq('id', jobId);
        await loadJobs(partnerId);
      }
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

/* ---------------- Invoices ---------------- */
async function loadInvoices(partnerId) {
  const { data: invoices } = await supabaseClient
    .from('partner_invoices').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('invoices-list', invoices, (i) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy">R${Number(i.amount).toLocaleString()}</p>
        <p class="text-xs text-gray-500">${new Date(i.created_at).toLocaleDateString()}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${i.status === 'Paid' ? 'bg-green-100 text-green-700' : i.status === 'Rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">${i.status}</span>
    </div>`);

  updateKpis(null, invoices);
  renderRevenueChart();
}

function wireInvoiceForm(partnerId) {
  const form = document.getElementById('invoice-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const jobId = document.getElementById('invoice-job').value;
    const amount = parseFloat(document.getElementById('invoice-amount').value) || 0;
    const fileUrl = document.getElementById('invoice-file-url').value.trim();

    const { error } = await supabaseClient.from('partner_invoices').insert([{
      job_id: jobId || null,
      partner_id: partnerId,
      amount,
      file_url: fileUrl,
      status: 'Submitted',
    }]);

    const note = document.getElementById('invoice-note');
    if (!error) {
      note.textContent = 'Invoice submitted for review.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
      form.reset();
      await loadInvoices(partnerId);
      if (jobId) {
        await supabaseClient.from('jobs').update({ status: 'Invoice Submitted' }).eq('id', jobId);
        await loadJobs(partnerId);
      }
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

/* ---------------- Notifications ---------------- */
async function loadNotifications(partnerId) {
  const { data: notifications } = await supabaseClient
    .from('notifications').select('*').eq('recipient_id', partnerId).order('created_at', { ascending: false });

  renderList('notifications-list', notifications, (n) => `
    <div class="flex items-start justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <p class="text-sm text-gray-700">${n.message}</p>
      <span class="text-xs text-gray-400 flex-shrink-0">${new Date(n.created_at).toLocaleDateString()}</span>
    </div>`);
}

/* ---------------- Estate Agent workspace (Sales & Leasing) ---------------- */
async function loadListings(partnerId) {
  const { data: listings } = await supabaseClient
    .from('listings').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('listings-list', listings, (l) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy truncate">${l.address}</p>
        <p class="text-xs text-gray-500">${l.listing_type}${l.price ? ' &middot; R' + Number(l.price).toLocaleString() : ''}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${l.status === 'Let' || l.status === 'Sold' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${l.status || 'Active'}</span>
    </div>`);

  setText('kpi-active-listings', (listings || []).filter(l => l.status !== 'Let' && l.status !== 'Sold').length);
}

function wireListingForm(partnerId) {
  const form = document.getElementById('listing-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await supabaseClient.from('listings').insert([{
      partner_id: partnerId,
      address: document.getElementById('listing-address').value.trim(),
      listing_type: document.getElementById('listing-type').value,
      price: parseFloat(document.getElementById('listing-price').value) || null,
      notes: document.getElementById('listing-notes').value.trim(),
      status: 'Active',
    }]);

    const note = document.getElementById('listing-note');
    if (!error) {
      note.textContent = 'Listing added.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
      form.reset();
      await loadListings(partnerId);
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

async function loadReferrals(partnerId) {
  const { data: referrals } = await supabaseClient
    .from('referrals').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('referrals-list', referrals, (r) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy truncate">${r.referred_name || 'Referral'}</p>
        <p class="text-xs text-gray-500">${new Date(r.created_at).toLocaleDateString()}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${r.status === 'Converted' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${r.status || 'New'}</span>
    </div>`);

  setText('kpi-new-referrals', (referrals || []).filter(r => r.status === 'New' || !r.status).length);
}

async function loadViewings(partnerId) {
  const { data: viewings } = await supabaseClient
    .from('viewings').select('*').eq('partner_id', partnerId).order('scheduled_date', { ascending: true });

  renderList('viewings-list', viewings, (v) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy truncate">${v.property_address || 'Viewing'}</p>
        <p class="text-xs text-gray-500">${v.scheduled_date ? new Date(v.scheduled_date).toLocaleString() : 'No date scheduled'}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${v.status === 'Completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${v.status || 'Scheduled'}</span>
    </div>`);

  setText('kpi-scheduled-viewings', (viewings || []).filter(v => v.status !== 'Completed').length);
}

async function loadApplications(partnerId) {
  const { data: applications } = await supabaseClient
    .from('applications').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('applications-list', applications, (a) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0 gap-3">
      <div class="min-w-0">
        <p class="font-semibold text-navy truncate">${a.applicant_name || 'Applicant'}</p>
        <p class="text-xs text-gray-500">${a.property_address || ''}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${a.status === 'Approved' ? 'bg-green-100 text-green-700' : a.status === 'Rejected' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">${a.status || 'Received'}</span>
    </div>`);
}

async function loadCommission(partnerId) {
  const { data: commission } = await supabaseClient
    .from('commissions').select('*').eq('partner_id', partnerId).order('created_at', { ascending: false });

  renderList('commission-list', commission, (c) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
      <div>
        <p class="font-semibold text-navy">R${Number(c.amount).toLocaleString()}</p>
        <p class="text-xs text-gray-500">${new Date(c.created_at).toLocaleDateString()}</p>
      </div>
      <span class="text-xs font-semibold px-3 py-1 rounded-full ${c.status === 'Paid' ? 'bg-green-100 text-green-700' : c.status === 'Approved' ? 'bg-blue-100 text-blue-700' : 'bg-yellow-100 text-yellow-700'}">${c.status || 'Pending'}</span>
    </div>`);

  const rows = commission || [];
  const sum = (status) => rows.filter(c => c.status === status).reduce((s, c) => s + Number(c.amount || 0), 0);
  const pending = sum('Pending');
  const approved = sum('Approved');
  const paid = sum('Paid');
  const lifetime = pending + approved + paid;

  setText('kpi-commission-pending', 'R' + pending.toLocaleString());
  setText('kpi-commission-centre-pending', 'R' + pending.toLocaleString());
  setText('kpi-commission-approved', 'R' + approved.toLocaleString());
  setText('kpi-commission-paid', 'R' + paid.toLocaleString());
  setText('kpi-commission-lifetime', 'R' + lifetime.toLocaleString());
}

/* ---------------- Profile ---------------- */
function wireProfileForm(partnerId) {
  const form = document.getElementById('profile-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    await supabaseClient.from('profiles')
      .update({ full_name: document.getElementById('profile-full-name').value.trim() })
      .eq('id', partnerId);

    const { error } = await supabaseClient.from('partner_profiles').upsert([{
      id: partnerId,
      company_name: document.getElementById('profile-company').value.trim(),
      partner_category: document.getElementById('profile-category').value,
      partner_type: document.getElementById('profile-partner-type').value,
      registration_number: document.getElementById('profile-registration').value.trim(),
      vat_number: document.getElementById('profile-vat').value.trim(),
      banking_details: document.getElementById('profile-banking').value.trim(),
      insurance_details: document.getElementById('profile-insurance').value.trim(),
      coverage_area: document.getElementById('profile-coverage').value.trim(),
      operating_hours: document.getElementById('profile-hours').value.trim(),
    }]);

    const note = document.getElementById('profile-note');
    if (!error) {
      note.textContent = 'Profile updated.';
      note.classList.remove('hidden', 'text-red-600');
      note.classList.add('text-green-700');
    } else {
      note.textContent = error.message;
      note.classList.remove('hidden');
      note.classList.add('text-red-600');
    }
  });
}

/* ---------------- KPIs + chart ---------------- */
let lastQuotes = null;
let lastInvoices = null;

function updateKpis(quotes, invoices) {
  if (quotes) lastQuotes = quotes;
  if (invoices) lastInvoices = invoices;

  const activeJobs = currentJobs.filter(j => !['Paid', 'Completed'].includes(j.status)).length;
  setText('kpi-active-jobs', activeJobs);

  if (lastQuotes) {
    setText('kpi-pending-quotes', lastQuotes.filter(q => q.status === 'Submitted').length);
  }
  if (lastInvoices) {
    setText('kpi-pending-invoices', lastInvoices.filter(i => !['Paid', 'Rejected'].includes(i.status)).length);
    const thisMonth = new Date().getMonth();
    const paidThisMonth = lastInvoices
      .filter(i => i.status === 'Paid' && new Date(i.created_at).getMonth() === thisMonth)
      .reduce((sum, i) => sum + Number(i.amount || 0), 0);
    setText('kpi-paid-month', 'R' + paidThisMonth.toLocaleString());
  }
}

let revenueChartInstance = null;

function renderRevenueChart() {
  const canvas = document.getElementById('revenue-chart');
  if (!canvas || !window.Chart) return;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const currentYear = new Date().getFullYear();
  const monthlyRevenue = months.map((_, i) =>
    (lastInvoices || [])
      .filter(inv => inv.status === 'Paid'
        && new Date(inv.created_at).getFullYear() === currentYear
        && new Date(inv.created_at).getMonth() === i)
      .reduce((sum, inv) => sum + Number(inv.amount || 0), 0)
  );

  if (revenueChartInstance) {
    revenueChartInstance.data.datasets[0].data = monthlyRevenue;
    revenueChartInstance.update();
    return;
  }
  revenueChartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels: months, datasets: [{ label: 'Revenue (R)', data: monthlyRevenue, borderColor: '#C89B3C', backgroundColor: 'rgba(200,155,60,.15)', tension: .3, fill: true }] },
    options: { responsive: true, plugins: { legend: { display: false } } }
  });
}

/* ---------------- Shared render helpers ---------------- */
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

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || '';
}

/* ================================================================
   DOCUMENT UPLOAD WIZARD
   Merged in from the standalone DMS build. Category → operational
   table mapping only fires on admin approval (see admin-dashboard.js),
   not here — a partner's upload only ever creates a `documents` row
   with status 'Pending Approval'.
   ================================================================ */
let wizardState = { step: 1, file: null };

async function populatePropertyAndTenantSelects() {
  const { data: properties } = await supabaseClient
    .from('properties')
    .select('id, address, owner_id, owner:owner_id ( full_name )')
    .order('address');
  const propSelect = document.getElementById('wiz-property');
  if (!propSelect) return;
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}" data-owner-name="${p.owner?.full_name || 'Unknown owner'}">${p.address}</option>`).join('');

  const ownerDisplay = document.getElementById('wiz-owner-display');
  propSelect.addEventListener('change', () => {
    const ownerName = propSelect.selectedOptions[0]?.dataset.ownerName;
    if (propSelect.value && ownerName) {
      ownerDisplay.textContent = `Owner on record: ${ownerName}`;
      ownerDisplay.classList.remove('hidden');
    } else {
      ownerDisplay.classList.add('hidden');
    }
  });

  const tenantSelect = document.getElementById('wiz-tenant');
  tenantSelect.innerHTML = '<option value="">No tenant (not applicable)</option>';

  // Tenant list is scoped to whichever property is selected, via that
  // property's actual leases — not a flat list of every tenant in the
  // system. Tenant stays optional here (some categories, like Owner
  // Statement, don't need one), so the "not applicable" option remains.
  propSelect.addEventListener('change', () => populateWizardTenantsForProperty(propSelect.value, tenantSelect));
}

async function populateWizardTenantsForProperty(propertyId, tenantSelect) {
  if (!propertyId) {
    tenantSelect.innerHTML = '<option value="">No tenant (not applicable)</option>';
    return;
  }

  const { data: leases, error } = await supabaseClient
    .from('leases')
    .select('tenant_id, profiles:tenant_id ( id, full_name )')
    .eq('property_id', propertyId);

  if (error || !leases || leases.length === 0) {
    tenantSelect.innerHTML = '<option value="">No tenant (not applicable)</option>';
    return;
  }

  const seen = new Set();
  const uniqueTenants = leases
    .map(l => l.profiles)
    .filter(t => t && !seen.has(t.id) && seen.add(t.id));

  tenantSelect.innerHTML = '<option value="">No tenant (not applicable)</option>' +
    uniqueTenants.map(t => `<option value="${t.id}">${t.full_name}</option>`).join('');
}

function wireWizard() {
  const form = document.getElementById('upload-wizard-form');
  if (!form) return;

  const steps = document.querySelectorAll('.wizard-step');
  const dots = document.querySelectorAll('[data-step-dot]');
  const backBtn = document.getElementById('wiz-back');
  const nextBtn = document.getElementById('wiz-next');
  const submitBtn = document.getElementById('wiz-submit');
  const totalSteps = steps.length;

  function currentCategoryRequiresTenant() {
    const category = document.getElementById('wiz-category').value;
    const rules = WIZARD_CATEGORY_RULES[category];
    return !!rules?.requiresTenant;
  }

  // Step 3 (Tenant) only applies to categories that actually need one.
  // Category is chosen in step 2, so by the time we're navigating past
  // it we already know whether to show or skip step 3.
  function getNextStep(current) {
    let next = current + 1;
    if (next === 3 && !currentCategoryRequiresTenant()) next = 4;
    return next;
  }

  function getPrevStep(current) {
    let prev = current - 1;
    if (prev === 3 && !currentCategoryRequiresTenant()) prev = 2;
    return prev;
  }

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
    if (n === 3) {
      const category = document.getElementById('wiz-category').value;
      const note = document.getElementById('wiz-tenant-required-note');
      note.textContent = `${category} requires a tenant — this document will reach both the owner and the tenant.`;
      note.classList.remove('hidden');
    }
    if (n === 8) toggleFinancialFieldsForCategory();
  }

  function validateStep(n) {
    const errorEl = document.getElementById('wiz-error');
    errorEl.classList.add('hidden');
    if (n === 1 && !document.getElementById('wiz-property').value) return 'Select a property to continue.';
    if (n === 2 && !document.getElementById('wiz-category').value) return 'Select a document category.';
    if (n === 3 && currentCategoryRequiresTenant() && !document.getElementById('wiz-tenant').value) {
      const category = document.getElementById('wiz-category').value;
      return `${category} requires a tenant. Please select one.`;
    }
    if (n === 4 && !document.getElementById('wiz-statement-month').value) return 'Select a statement month.';
    if (n === 5 && !document.getElementById('wiz-document-date').value) return 'Select a document date.';
    if (n === 7 && !wizardState.file) return 'Attach a file before continuing.';
    return null;
  }

  nextBtn.addEventListener('click', () => {
    const err = validateStep(wizardState.step);
    if (err) {
      const errorEl = document.getElementById('wiz-error');
      errorEl.textContent = err;
      errorEl.classList.remove('hidden');
      return;
    }
    if (wizardState.step < totalSteps) showStep(getNextStep(wizardState.step));
  });

  backBtn.addEventListener('click', () => {
    if (wizardState.step > 1) showStep(getPrevStep(wizardState.step));
  });

  wireDropzone();
  wireFinancialInputs();
  form.addEventListener('submit', handleWizardSubmit);

  showStep(1);
}

function toggleFinancialFieldsForCategory() {
  // Rent/Utility Invoice is intentionally not a partner-selectable
  // category (admins upload those directly) — so the wizard only ever
  // needs 'generic' (single Amount field) or 'none' (no financials at
  // all, for Inspection Report/Pictures/Bulletin, which aren't invoices).
  const category = document.getElementById('wiz-category').value;
  const rules = WIZARD_CATEGORY_RULES[category];
  const mode = rules?.financialMode || 'generic';

  document.getElementById('wiz-financial-fields-rental').classList.add('hidden');
  document.getElementById('wiz-financial-fields-generic').classList.toggle('hidden', mode === 'none');
  document.getElementById('wiz-no-financials-note').classList.toggle('hidden', mode !== 'none');
  document.getElementById('wiz-financial-summary').classList.toggle('hidden', mode === 'none');

  if (mode === 'none') {
    document.getElementById('wiz-amount').value = 0;
    document.getElementById('wiz-discount').value = 0;
    document.getElementById('wiz-vat').value = 0;
  }
  recalculateTotals();
}

function wireDropzone() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('wiz-file-input');
  const MAX_BYTES = 20 * 1024 * 1024;

  function setFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { alert('File exceeds the 20MB limit.'); return; }
    wizardState.file = file;
    const nameEl = document.getElementById('wiz-file-name');
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
}

function wireFinancialInputs() {
  document.querySelectorAll('.wiz-financial-input, #wiz-discount, #wiz-vat').forEach(el => {
    el.addEventListener('input', recalculateTotals);
  });
}

function recalculateTotals() {
  const subtotal = parseFloat(document.getElementById('wiz-amount').value) || 0;
  const discount = parseFloat(document.getElementById('wiz-discount').value) || 0;
  const vat = parseFloat(document.getElementById('wiz-vat').value) || 0;
  const total = subtotal - discount + vat;

  document.getElementById('wiz-subtotal').textContent = 'R' + subtotal.toFixed(2);
  document.getElementById('wiz-total').textContent = 'R' + total.toFixed(2);
}

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

const DOCUMENT_CATEGORY_FOLDERS = {
  'Lease': 'leases',
  'Inspection Report': 'inspection-reports',
  'Pictures': 'pictures',
  'Bulletin': 'bulletins',
  'Commission Statement': 'commission-statements',
  'Maintenance Invoice': 'maintenance-invoices',
  'Professional Fees Invoice': 'professional-fees-invoices',
  'Owner Statement': 'owner-statements',
};

// Categories that go to owner + tenant (require a tenant) vs owner-only
// (tenant not needed). Mirrors admin-dashboard.js's CATEGORY_CONFIG —
// kept as a separate, simpler map here since the wizard never publishes
// anything itself, it only needs this for validation and to hide the
// financial-breakdown fields for non-invoice categories.
const WIZARD_CATEGORY_RULES = {
  'Lease': { requiresTenant: true, financialMode: 'generic' },
  'Inspection Report': { requiresTenant: true, financialMode: 'none' },
  'Pictures': { requiresTenant: true, financialMode: 'none' },
  'Bulletin': { requiresTenant: true, financialMode: 'none' },
  'Commission Statement': { requiresTenant: false, financialMode: 'generic' },
  'Maintenance Invoice': { requiresTenant: false, financialMode: 'generic' },
  'Professional Fees Invoice': { requiresTenant: false, financialMode: 'generic' },
  'Owner Statement': { requiresTenant: false, financialMode: 'generic' },
};

async function handleWizardSubmit(e) {
  e.preventDefault();
  const errorEl = document.getElementById('wiz-error');
  const successEl = document.getElementById('wiz-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const submitBtn = document.getElementById('wiz-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading…';

  try {
    const propertySelect = document.getElementById('wiz-property');
    const propertyId = propertySelect.value;
    const ownerId = propertySelect.selectedOptions[0]?.dataset.ownerId || null;
    const tenantId = document.getElementById('wiz-tenant').value || null;
    const statementMonth = document.getElementById('wiz-statement-month').value;
    const category = document.getElementById('wiz-category').value;
    const documentDate = document.getElementById('wiz-document-date').value;
    const dueDate = document.getElementById('wiz-due-date').value || null;
    const file = wizardState.file;

    const folder = DOCUMENT_CATEGORY_FOLDERS[category];
    if (!folder) throw new Error('Unknown document category.');

    if (category === 'Lease' && !tenantId) {
      throw new Error('Lease documents require a tenant — go back to step 2 and select one.');
    }

    const extension = (file.name.split('.').pop() || 'pdf').toLowerCase();
    const tenantLabel = document.getElementById('wiz-tenant').selectedOptions[0]?.textContent || 'NA';

    const generatedFilename = buildGeneratedFilename({
      documentDate, category, propertyCode: propertyId, tenantName: tenantId ? tenantLabel : 'NA',
      statementMonth, extension,
    });

    const [year, month] = statementMonth.split('-');
    const storagePath = `documents/${folder}/${propertyId}/${tenantId || 'none'}/${year}/${month}/${generatedFilename}`;

    await uploadFileWithProgress(file, storagePath);

    const subtotal = parseFloat(document.getElementById('wiz-amount').value) || 0;
    const discount = parseFloat(document.getElementById('wiz-discount').value) || 0;
    const vat = parseFloat(document.getElementById('wiz-vat').value) || 0;
    const totalAmount = subtotal - discount + vat;

    const { data: docRow, error: docError } = await supabaseClient.from('documents').insert([{
      category,
      property_id: propertyId,
      tenant_id: tenantId,
      owner_id: ownerId,
      partner_id: currentPartner.id,
      statement_month: statementMonth + '-01',
      document_date: documentDate,
      due_date: dueDate,
      original_filename: file.name,
      generated_filename: generatedFilename,
      storage_path: storagePath,
      subtotal,
      discount,
      vat,
      total_amount: totalAmount,
      status: 'Pending Approval',
      uploaded_by: currentPartner.id,
    }]).select().single();

    if (docError) throw docError;

    await notifyEdgeFunction({
      document_id: docRow.id,
      status: 'Pending Approval',
      recipient_context: 'admin',
      meta_notes: `${currentPartner.full_name || currentPartner.email} uploaded a new ${category} for review.`,
    });

    successEl.textContent = 'Document submitted for approval.';
    successEl.classList.remove('hidden');
    document.getElementById('upload-wizard-form').reset();
    wizardState = { step: 1, file: null };
    document.getElementById('wiz-file-name').classList.add('hidden');
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong during upload.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit for Approval';
  }
}

/* Direct XHR upload to Supabase Storage — the browser SDK's storage.upload()
   has no progress callback, so this hits the Storage REST endpoint directly. */
function uploadFileWithProgress(file, path) {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Your session expired — please log in again.'));

    const progressWrap = document.getElementById('wiz-progress-wrap');
    const progressBar = document.getElementById('wiz-progress-bar');
    const progressLabel = document.getElementById('wiz-progress-label');
    progressWrap.classList.remove('hidden');

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
      progressBar.style.width = pct + '%';
      progressLabel.textContent = pct + '%';
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Edge Function notification failed:', res.status, body);
    }
  } catch (err) {
    console.error('Edge Function notification failed:', err);
  }
}

/* ================================================================
   PARTNER INVOICING (Sales & Leasing partners, assigned 10% package
   properties only). Mirrors admin-dashboard.js's Generate Invoice
   panel exactly, scoped to partner_property_assignments instead of
   every 10%-tier property in the portfolio.
   ================================================================ */

async function populatePartnerInvoiceSelects() {
  const propSelect = document.getElementById('invoice-property');
  if (!propSelect) return;

  const { data: assignments } = await supabaseClient
    .from('partner_property_assignments')
    .select('properties ( id, address, owner_id, package_tier )')
    .eq('partner_id', currentPartner.id);

  const properties = (assignments || [])
    .map(a => a.properties)
    .filter(p => p && p.package_tier === '10%');

  const emptyNote = document.getElementById('invoice-property-empty-note');
  if (properties.length === 0) {
    propSelect.innerHTML = '<option value="">No assigned 10% package properties</option>';
    propSelect.disabled = true;
    emptyNote.classList.remove('hidden');
    return;
  }

  emptyNote.classList.add('hidden');
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    properties.map(p => `<option value="${p.id}" data-owner-id="${p.owner_id}">${p.address}</option>`).join('');

  const tenantSelect = document.getElementById('invoice-tenant');
  propSelect.addEventListener('change', () => populatePartnerInvoiceTenants(propSelect.value, tenantSelect));

  document.getElementById('invoice-date').valueAsDate = new Date();
  document.getElementById('invoice-date').addEventListener('change', updatePartnerInvoiceDueDateDisplay);

  document.querySelectorAll('.invoice-financial-input').forEach(el => {
    el.addEventListener('input', recalculatePartnerInvoiceTotal);
  });
}

async function populatePartnerInvoiceTenants(propertyId, tenantSelect) {
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
    .map(l => ({ ...l.profiles, monthly_rent: l.monthly_rent, payment_terms_days: l.payment_terms_days || 7 }));

  tenantSelect.disabled = false;
  tenantSelect.innerHTML = '<option value="">Select a tenant</option>' +
    uniqueTenants.map(t => `<option value="${t.id}" data-monthly-rent="${t.monthly_rent || 0}" data-payment-terms="${t.payment_terms_days}">${t.full_name}</option>`).join('');

  tenantSelect.addEventListener('change', () => {
    const rent = tenantSelect.selectedOptions[0]?.dataset.monthlyRent;
    const netRentalInput = document.getElementById('invoice-net-rental');
    if (rent && netRentalInput) {
      netRentalInput.value = rent;
      recalculatePartnerInvoiceTotal();
    }
    updatePartnerInvoiceDueDateDisplay();
  });
}

function updatePartnerInvoiceDueDateDisplay() {
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

function recalculatePartnerInvoiceTotal() {
  const total = ['invoice-net-rental', 'invoice-electricity', 'invoice-water', 'invoice-sewerage', 'invoice-refuse']
    .reduce((sum, id) => sum + (parseFloat(document.getElementById(id).value) || 0), 0);
  document.getElementById('invoice-total-due').textContent = 'R' + total.toLocaleString(undefined, { minimumFractionDigits: 2 });
}

function wirePartnerInvoiceGenerateForm() {
  const form = document.getElementById('invoice-generate-form');
  if (!form) return;
  form.addEventListener('submit', handlePartnerInvoiceGenerateSubmit);
}

async function handlePartnerInvoiceGenerateSubmit(e) {
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
  const termsDays = parseInt(tenantSelect.selectedOptions[0]?.dataset.paymentTerms, 10) || 7;
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

    const { data: tenantProfile } = await supabaseClient.from('profiles').select('phone').eq('id', tenantId).single();

    const { data: invoice, error: invError } = await supabaseClient.from('tenant_invoices').insert([{
      lease_id: null,
      property_id: propertyId,
      tenant_id: tenantId,
      invoice_date: invoiceDate,
      due_date: dueDateStr,
      net_rental: netRental, electricity, water, sewerage, refuse,
      total_due: totalDue,
      status: 'Sent',
      created_by: currentPartner.id,
    }]).select().single();
    if (invError) throw invError;

    // Everything from here on is wrapped so ANY failure deletes the
    // invoice record just created rather than leaving an orphaned
    // tenant_invoices row with no matching document, chart entry, or
    // payment — same rollback pattern already used for lease creation
    // and now the admin-side version of this same function.
    try {
      const invoiceHtml = renderPartnerInvoiceHtml({
        invoiceNumber: invoice.invoice_number,
        invoiceDate, dueDate: dueDateStr, termsDays,
        tenantName, tenantPhone: tenantProfile?.phone || '',
        propertyAddress,
        netRental, electricity, water, sewerage, refuse, totalDue,
      });

      const storagePath = `documents/tenant-invoices/${invoice.id}/${invoice.invoice_number}.html`;
      await uploadPartnerInvoiceHtml(invoiceHtml, storagePath);
      const { error: pathUpdateError } = await supabaseClient.from('tenant_invoices').update({ storage_path: storagePath }).eq('id', invoice.id);
      if (pathUpdateError) throw pathUpdateError;

      const { error: rentalError } = await supabaseClient.from('rental_invoices').insert([{
        property_id: propertyId,
        invoice_date: invoiceDate,
        net_rental: netRental, electricity, water, sewerage,
        other_charges: refuse,
      }]);
      if (rentalError) throw rentalError;

      const { data: docRow, error: docError } = await supabaseClient.from('documents').insert([{
        category: 'Rent/Utility Invoice',
        property_id: propertyId,
        tenant_id: tenantId,
        owner_id: ownerId,
        partner_id: currentPartner.id,
        statement_month: invoiceDate.slice(0, 7) + '-01',
        document_date: invoiceDate,
        due_date: dueDateStr,
        original_filename: `${invoice.invoice_number}.html`,
        generated_filename: `${invoice.invoice_number}.html`,
        storage_path: storagePath,
        subtotal: totalDue, discount: 0, vat: 0, total_amount: totalDue,
        status: 'Approved',
        uploaded_by: currentPartner.id,
        approved_by: currentPartner.id,
        operational_table: 'tenant_invoices',
        operational_id: String(invoice.id),
      }]).select().single();
      if (docError) throw docError;

      const { error: paymentError } = await supabaseClient.from('payments').insert([{
        tenant_id: tenantId,
        amount: totalDue,
        due_date: dueDateStr,
        status: 'Pending',
      }]);
      if (paymentError) throw paymentError;

      await notifyPartnerEdgeFunction({
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
    recalculatePartnerInvoiceTotal();
    document.getElementById('invoice-due-date-display').textContent = 'Select a tenant first';
    document.getElementById('invoice-terms-display').textContent = '—';
    await loadPartnerPaymentHistory();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate & Send Invoice';
  }
}

// Same retry helper as admin-dashboard.js — kept as a duplicate since
// these are separate pages with no shared module system.
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

function uploadPartnerInvoiceHtml(htmlString, path) {
  return retryTransient(() => new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Session expired — log in again.'));
    const blob = new Blob([htmlString], { type: 'text/html' });
    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', 'text/html');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Invoice upload failed: ' + xhr.status + (xhr.status >= 500 ? ' Gateway error' : '')));
    xhr.onerror = () => reject(new Error('Network error uploading invoice.'));
    xhr.send(blob);
  }));
}

async function notifyPartnerEdgeFunction(payload) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('Edge Function notification failed:', res.status, body);
    }
  } catch (err) {
    console.error('Edge Function notification failed:', err);
  }
}

// Identical rendering to admin-dashboard.js's renderTenantInvoiceHtml —
// same branded template, same self-contained HTML output.
function renderPartnerInvoiceHtml(d) {
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

/* ---------------- Payment history (assigned properties only) ---------------- */
// RLS ("Assigned partners can view payments for their tenants") scopes
// this to tenants on properties this partner is actually assigned to —
// no need to filter by property here, the database already restricts
// what comes back.
async function loadPartnerPaymentHistory() {
  const { data: payments, error } = await supabaseClient
    .from('payments')
    .select('*, profiles:tenant_id ( full_name )')
    .order('due_date', { ascending: false });

  const tbody = document.getElementById('partner-payments-tbody');
  if (!tbody) return;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`;
    return;
  }
  if (!payments || payments.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-sm text-gray-400 text-center">No payments yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = payments.map(p => `
    <tr class="border-b border-gray-100 text-sm">
      <td class="py-3 px-2 text-navy font-medium">${p.profiles?.full_name || 'Unknown tenant'}</td>
      <td class="py-3 px-2 text-gray-600">${p.due_date ? new Date(p.due_date).toLocaleDateString() : '—'}</td>
      <td class="py-3 px-2 font-semibold text-navy">R${Number(p.amount).toLocaleString()}</td>
      <td class="py-3 px-2"><span class="text-xs font-semibold px-2.5 py-0.5 rounded-full ${p.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${p.status}</span></td>
    </tr>`).join('');
}
