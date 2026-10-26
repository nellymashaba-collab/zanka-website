// Zanka Group — Tenant Recruitment (admin)
//
// Vacancies -> applications -> verify and score -> offer -> acceptance ->
// hand-over to the existing Lease Wizard (lease-wizard.html?application=ID),
// which creates the Draft lease and the KYC case exactly as it does today.
//
// Tables (024_tenant_recruitment.sql): rental_vacancies, rental_applications,
// rental_application_documents, rental_application_consents,
// rental_application_events, rental_recruitment_settings.
// Storage: private bucket 'rental-applications' ({application_id}/{category}/file).
//
// Everything an applicant typed is untrusted: ALWAYS pass it through esc()
// before it goes into innerHTML.

let currentUser = null;
let settings = null;
let properties = [];
let vacancies = [];
let applications = [];
let openApp = null;       // application currently in the modal
let editingVacancyId = null;
// Photos being edited in the vacancy form. Files go straight to the public
// 'listing-photos' bucket as they are added, under the vacancy's id; they
// only become part of the listing when the vacancy is saved.
let photoState = { vacancyId: null, photos: [], original: [], uploaded: [], saved: false, busy: false };
const PHOTO_BUCKET = 'listing-photos';
const MAX_PHOTOS = 20;

const CLOSED = ['Lease created', 'Declined', 'Withdrawn'];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n === null || n === undefined || n === '' ? '—' : 'R' + Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 }));
const dt = (d) => (d ? new Date(d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dtt = (d) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const pct = (r) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`);

const STATUS_STYLE = {
  Submitted: 'bg-blue-100 text-blue-700', Screening: 'bg-yellow-100 text-yellow-800', Shortlisted: 'bg-indigo-100 text-indigo-700',
  Reserve: 'bg-gray-200 text-gray-700', Offered: 'bg-amber-100 text-amber-800', Accepted: 'bg-green-100 text-green-700',
  'Lease created': 'bg-green-600 text-white', Declined: 'bg-red-100 text-red-700', Withdrawn: 'bg-gray-100 text-gray-500',
  Draft: 'bg-gray-100 text-gray-600', Open: 'bg-green-100 text-green-700', Closed: 'bg-gray-200 text-gray-700', Let: 'bg-navy text-white',
};
const REC_STYLE = { Approve: 'bg-green-100 text-green-700', Conditional: 'bg-amber-100 text-amber-800', Decline: 'bg-red-100 text-red-700', Incomplete: 'bg-gray-100 text-gray-500' };
const pill = (text, style) => `<span class="pill ${style || 'bg-gray-100 text-gray-600'}">${esc(text)}</span>`;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await requireSession('admin', 'admin-login.html');
  if (!currentUser) return;
  wireStatic();
  await loadAll();
  const deepLink = new URLSearchParams(location.search).get('application');
  if (deepLink) openApplication(deepLink);
});

function wireStatic() {
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
  ['vacancy-modal', 'app-modal', 'settings-modal'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) closeModal(id); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ['vacancy-modal', 'app-modal', 'settings-modal'].forEach((id) => { if (!$(id).classList.contains('hidden')) closeModal(id); });
  });
  $('btn-new-vacancy').addEventListener('click', () => openVacancyForm(null));
  $('vacancy-form').addEventListener('submit', saveVacancy);
  $('vf-photos-input').addEventListener('change', (e) => { addPhotos([...e.target.files]); e.target.value = ''; });
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-banner-open').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', saveSettings);
  $('btn-purge').addEventListener('click', purgeExpiredDocuments);
  $('filter-vacancy').addEventListener('change', renderApplications);
  $('filter-status').addEventListener('change', renderApplications);
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('screen-form').addEventListener('submit', saveScreening);
  $('screen-form').addEventListener('input', () => openApp && renderScorePanel(screeningDraft()));
  $('screen-form').addEventListener('change', () => openApp && renderScorePanel(screeningDraft()));
}

/* ================================================================
   LOAD
   ================================================================ */
async function loadAll() {
  const [s, p, v, a, c] = await Promise.all([
    supabaseClient.from('rental_recruitment_settings').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    supabaseClient.from('properties').select('id, name, address').order('address'),
    supabaseClient.from('rental_vacancies').select('*, properties ( address, name )').order('created_at', { ascending: false }),
    supabaseClient.from('rental_applications').select('*').neq('status', 'Uploading').order('submitted_at', { ascending: false }),
    supabaseClient.from('rental_application_consents').select('application_id'),
  ]);
  const err = [s, p, v, a, c].find((r) => r.error);
  if (err) {
    $('vacancies-tbody').innerHTML = `<tr><td colspan="7" class="py-6 px-3 text-red-600">Could not load recruitment data: ${esc(err.error.message)}. Has 024_tenant_recruitment.sql been run?</td></tr>`;
    $('applications-tbody').innerHTML = '';
    return;
  }
  settings = s.data;
  properties = p.data || [];
  vacancies = v.data || [];
  const consented = new Set((c.data || []).map((r) => r.application_id));
  applications = (a.data || []).map((app) => ({ ...app, has_consent: consented.has(app.id) }));

  $('settings-banner').classList.toggle('hidden', !!(settings && settings.settings_confirmed));
  renderKpis();
  renderVacancies();
  renderVacancyFilter();
  renderApplications();
}

function vacancyOf(app) { return vacancies.find((v) => v.id === app.vacancy_id) || null; }
function evaluate(app) { return RecruitmentScoring.evaluateApplication(app, vacancyOf(app), settings); }

/* ================================================================
   KPIs, VACANCIES
   ================================================================ */
function renderKpis() {
  $('kpi-open').textContent = vacancies.filter((v) => v.status === 'Open').length;
  $('kpi-new').textContent = applications.filter((a) => a.status === 'Submitted').length;
  $('kpi-screening').textContent = applications.filter((a) => ['Screening', 'Shortlisted'].includes(a.status)).length;
  $('kpi-offers').textContent = applications.filter((a) => a.status === 'Offered').length;
}

function renderVacancies() {
  if (!vacancies.length) {
    $('vacancies-tbody').innerHTML = `<tr><td colspan="7" class="py-6 px-3 text-gray-400">No vacancies yet. Create one to start taking applications.</td></tr>`;
    return;
  }
  $('vacancies-tbody').innerHTML = vacancies.map((v) => {
    const count = applications.filter((a) => a.vacancy_id === v.id).length;
    const live = applications.filter((a) => a.vacancy_id === v.id && !CLOSED.includes(a.status)).length;
    const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}apply.html?vacancy=${v.id}`;
    return `<tr class="border-b border-gray-100 last:border-0 align-top">
      <td class="py-3 px-3"><div class="flex items-center gap-3">
        ${(v.photos || []).length ? `<img src="${esc(photoUrl(v.photos[0].path))}" alt="" class="w-14 h-10 rounded-md object-cover flex-shrink-0 bg-offwhite" loading="lazy">` : '<span class="w-14 h-10 rounded-md bg-offwhite flex-shrink-0 flex items-center justify-center text-[10px] text-gray-400">No photo</span>'}
        <div><p class="font-semibold text-navy">${esc(v.title)}</p><p class="text-xs text-gray-500">${esc(v.area)}${(v.photos || []).length ? ` · ${v.photos.length} photo${v.photos.length === 1 ? '' : 's'}` : ''}</p></div></div></td>
      <td class="py-3 px-3 text-gray-600">${esc(v.properties?.address || v.properties?.name || '')}</td>
      <td class="py-3 px-3 text-right">${money(v.monthly_rent)}</td>
      <td class="py-3 px-3">${dt(v.available_from)}${v.applications_close_at ? `<p class="text-xs text-gray-400">Closes ${dtt(v.applications_close_at)}</p>` : ''}</td>
      <td class="py-3 px-3 text-right">${count}${live !== count ? ` <span class="text-xs text-gray-400">(${live} active)</span>` : ''}</td>
      <td class="py-3 px-3">${pill(v.status, STATUS_STYLE[v.status])}</td>
      <td class="py-3 px-3 whitespace-nowrap space-x-3">
        <button class="text-gold font-semibold hover:underline" data-edit-vacancy="${v.id}">Edit</button>
        ${v.status === 'Open' ? `<button class="text-navy font-semibold hover:underline" data-copy-link="${esc(link)}">Copy apply link</button>` : ''}
        ${v.status === 'Draft' || v.status === 'Closed' ? `<button class="text-green-700 font-semibold hover:underline" data-set-vacancy="${v.id}:Open">Open</button>` : ''}
        ${v.status === 'Open' ? `<button class="text-gray-500 font-semibold hover:underline" data-set-vacancy="${v.id}:Closed">Close</button>` : ''}
      </td></tr>`;
  }).join('');
  document.querySelectorAll('[data-edit-vacancy]').forEach((b) => b.addEventListener('click', () => openVacancyForm(b.dataset.editVacancy)));
  document.querySelectorAll('[data-copy-link]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copyLink); b.textContent = 'Copied'; } catch { prompt('Copy this link:', b.dataset.copyLink); }
    setTimeout(() => { b.textContent = 'Copy apply link'; }, 1500);
  }));
  document.querySelectorAll('[data-set-vacancy]').forEach((b) => b.addEventListener('click', async () => {
    const [id, status] = b.dataset.setVacancy.split(':');
    const { error } = await supabaseClient.from('rental_vacancies').update({ status }).eq('id', id);
    if (error) return alert('Could not update vacancy: ' + error.message);
    await loadAll();
  }));
}

function renderVacancyFilter() {
  const sel = $('filter-vacancy');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All vacancies</option>' + vacancies.map((v) => `<option value="${v.id}">${esc(v.title)} (${esc(v.status)})</option>`).join('');
  sel.value = vacancies.some((v) => v.id === keep) ? keep : '';
}

function openVacancyForm(id) {
  editingVacancyId = id;
  const existing = (vacancies.find((x) => x.id === id) || {}).photos || [];
  photoState = { vacancyId: id || crypto.randomUUID(), photos: existing.map((p) => ({ ...p })), original: existing.map((p) => p.path), uploaded: [], saved: false, busy: false };
  $('vf-photos-progress').classList.add('hidden');
  renderPhotos();
  const v = vacancies.find((x) => x.id === id) || {};
  $('vacancy-modal-title').textContent = id ? 'Edit vacancy' : 'New vacancy';
  $('vf-property').innerHTML = '<option value="">Select a property</option>' +
    properties.map((p) => `<option value="${p.id}">${esc(p.address || p.name)}</option>`).join('');
  $('vf-property').value = v.property_id ?? '';
  $('vf-title').value = v.title || '';
  $('vf-area').value = v.area || 'Kensington, Johannesburg';
  $('vf-status').value = v.status || 'Draft';
  $('vf-rent').value = v.monthly_rent ?? '';
  $('vf-deposit').value = v.deposit ?? '';
  $('vf-available').value = v.available_from || '';
  $('vf-closes').value = v.applications_close_at ? toLocalInput(v.applications_close_at) : '';
  $('vf-bedrooms').value = v.bedrooms ?? '';
  $('vf-bathrooms').value = v.bathrooms ?? '';
  $('vf-parking').value = v.parking_bays ?? '';
  $('vf-max-occupants').value = v.max_occupants ?? '';
  $('vf-pets').value = v.pets_policy || 'No pets';
  $('vf-features').value = (v.features || []).join('\n');
  $('vf-description').value = v.description || '';
  $('vacancy-error').classList.add('hidden');
  $('vacancy-modal').classList.remove('hidden');
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function saveVacancy(e) {
  e.preventDefault();
  const intOrNull = (id) => ($(id).value === '' ? null : parseInt($(id).value, 10));
  const row = {
    property_id: Number($('vf-property').value),
    title: $('vf-title').value.trim(),
    area: $('vf-area').value.trim(),
    status: $('vf-status').value,
    monthly_rent: parseFloat($('vf-rent').value),
    deposit: $('vf-deposit').value === '' ? null : parseFloat($('vf-deposit').value),
    available_from: $('vf-available').value || null,
    applications_close_at: $('vf-closes').value ? new Date($('vf-closes').value).toISOString() : null,
    bedrooms: intOrNull('vf-bedrooms'),
    bathrooms: $('vf-bathrooms').value === '' ? null : parseFloat($('vf-bathrooms').value),
    parking_bays: intOrNull('vf-parking'),
    max_occupants: intOrNull('vf-max-occupants'),
    pets_policy: $('vf-pets').value.trim() || 'No pets',
    features: $('vf-features').value.split('\n').map((s) => s.trim()).filter(Boolean),
    description: $('vf-description').value.trim() || null,
    photos: photoState.photos.map(({ path, width, height }) => ({ path, width, height })),
  };
  if (photoState.busy) {
    $('vacancy-error').textContent = 'Photos are still uploading. Please wait a moment and save again.';
    $('vacancy-error').classList.remove('hidden');
    return;
  }
  if (!row.property_id || !row.title || !(row.monthly_rent > 0)) {
    $('vacancy-error').textContent = 'Property, title and rent are required.';
    $('vacancy-error').classList.remove('hidden');
    return;
  }
  if (/\b(unit|section|door|flat)\s*\d+/i.test(row.title) && !confirm('The title looks like it includes a unit number, which will be public. Save anyway?')) return;

  const q = editingVacancyId
    ? supabaseClient.from('rental_vacancies').update(row).eq('id', editingVacancyId)
    : supabaseClient.from('rental_vacancies').insert([{ ...row, id: photoState.vacancyId, created_by: currentUser.id }]);
  const { error } = await q;
  if (error) {
    $('vacancy-error').textContent = error.message;
    $('vacancy-error').classList.remove('hidden');
    return;
  }
  // Saved: delete files of photos that were removed from the listing.
  const kept = new Set(photoState.photos.map((p) => p.path));
  const orphaned = [...photoState.original, ...photoState.uploaded].filter((path) => !kept.has(path));
  if (orphaned.length) await supabaseClient.storage.from(PHOTO_BUCKET).remove(orphaned);
  photoState.saved = true;
  $('vacancy-modal').classList.add('hidden');
  await loadAll();
}

/* ================================================================
   APPLICATION LIST
   ================================================================ */
function renderApplications() {
  const vf = $('filter-vacancy').value;
  const sf = $('filter-status').value;
  const rows = applications
    .filter((a) => !vf || a.vacancy_id === vf)
    .filter((a) => (sf === 'active' ? !CLOSED.includes(a.status) : !sf || a.status === sf))
    .map((a) => ({ a, r: evaluate(a) }))
    .sort((x, y) => (y.r.knockoutFailed ? -1 : y.r.total) - (x.r.knockoutFailed ? -1 : x.r.total));

  if (!rows.length) {
    $('applications-tbody').innerHTML = `<tr><td colspan="7" class="py-6 px-3 text-gray-400">No applications match these filters.</td></tr>`;
    return;
  }
  $('applications-tbody').innerHTML = rows.map(({ a, r }) => {
    const v = vacancyOf(a);
    const expired = a.status === 'Offered' && a.offer_expires_at && new Date(a.offer_expires_at) < new Date();
    return `<tr class="border-b border-gray-100 last:border-0 hover:bg-offwhite cursor-pointer" data-open-app="${a.id}">
      <td class="py-3 px-3"><p class="font-semibold text-navy">${esc(a.full_name)}</p><p class="text-xs text-gray-500">${esc(a.reference)}</p></td>
      <td class="py-3 px-3 text-gray-600">${esc(v?.title || '')}</td>
      <td class="py-3 px-3 text-gray-600">${dt(a.submitted_at)}</td>
      <td class="py-3 px-3 text-right ${r.affordability > r.settingsUsed.affordability_knockout_max ? 'text-red-600 font-semibold' : ''}">${pct(r.affordability)}</td>
      <td class="py-3 px-3 text-right font-semibold text-navy">${r.knockoutFailed ? '—' : r.total}${r.complete || r.knockoutFailed ? '' : '<span class="text-xs font-normal text-gray-400"> so far</span>'}</td>
      <td class="py-3 px-3">${pill(r.knockoutFailed ? 'Decline (knockout)' : r.recommendation, REC_STYLE[r.recommendation])}</td>
      <td class="py-3 px-3">${pill(a.status, STATUS_STYLE[a.status])}${expired ? ' ' + pill('Offer expired', 'bg-red-100 text-red-700') : ''}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('[data-open-app]').forEach((tr) => tr.addEventListener('click', () => openApplication(tr.dataset.openApp)));
}

/* ================================================================
   APPLICATION MODAL
   ================================================================ */
async function openApplication(id) {
  const app = applications.find((a) => a.id === id);
  if (!app) return;
  openApp = app;
  const v = vacancyOf(app);
  $('am-reference').textContent = app.reference;
  $('am-name').textContent = app.full_name;
  $('am-sub').textContent = `${v?.title || ''} · ${money(v?.monthly_rent)} pm · submitted ${dtt(app.submitted_at)}`;
  $('am-status').innerHTML = pill(app.status, STATUS_STYLE[app.status]);
  renderDetails(app);
  fillScreeningForm(app);
  renderScorePanel(app);
  renderActions(app);
  selectTab('details');
  $('app-modal').classList.remove('hidden');
  // Lazy tabs
  renderDocuments(app);
  renderHistory(app);
}

function selectTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-tab-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== name));
}

function kv(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="grid grid-cols-[11rem_1fr] gap-3 py-1.5 border-b border-gray-100 last:border-0"><dt class="text-gray-500">${esc(label)}</dt><dd class="text-navy break-words">${value}</dd></div>`;
}
const section = (title, body) => (body.trim() ? `<h4 class="font-semibold text-navy mt-5 mb-1 first:mt-0">${esc(title)}</h4><dl>${body}</dl>` : '');
const telLink = (p) => (p ? `<a class="text-gold hover:underline" href="tel:${esc(p.replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '');
const mailLink = (m) => (m ? `<a class="text-gold hover:underline" href="mailto:${esc(m)}">${esc(m)}</a>` : '');

function renderDetails(a) {
  const occ = (a.occupants || []).map((o) => `${esc(o.name)}${o.age !== null && o.age !== undefined ? ` (${esc(o.age)})` : ''}`).join(', ');
  const surety = a.surety ? `${esc(a.surety.full_name)} · ID ${esc(a.surety.id_number)}${a.surety.relationship ? ' · ' + esc(a.surety.relationship) : ''}<br>${telLink(a.surety.phone)} ${mailLink(a.surety.email)}` : '';
  $('am-details').innerHTML =
    section('Personal', kv('ID / passport', esc(a.id_number)) + kv('Date of birth', esc(a.date_of_birth)) + kv('Email', mailLink(a.email)) + kv('Phone', telLink(a.phone)) +
      kv('Current address', esc(a.current_address)) + kv('Marital status', esc(a.marital_status)) + kv('Dependants', esc(a.dependants)) +
      kv('Move-in date', esc(a.move_in_date)) + kv('Lease term', `${esc(a.lease_term_months)} months`)) +
    section('Household', kv('Occupants', `${esc(a.occupant_count)}: ${occ}`) + kv('Pets', esc(a.pets)) + kv('Vehicles', esc(a.vehicles))) +
    section('Employment and income', kv('Type', esc(a.employment_type)) + kv('Employer', esc(a.employer)) + kv('Job title', esc(a.job_title)) +
      kv('Start date', esc(a.employment_start_date)) + kv('Contract ends', esc(a.contract_end_date)) +
      kv('HR contact', [esc(a.hr_contact_name), telLink(a.hr_contact_phone), mailLink(a.hr_contact_email)].filter(Boolean).join(' · ')) +
      kv('Business', [esc(a.business_name), esc(a.business_registration)].filter(Boolean).join(' · ')) + kv('Accountant', esc(a.accountant_contact)) +
      kv('Gross monthly', money(a.gross_monthly_income)) + kv('Net monthly', money(a.net_monthly_income)) +
      kv('Other income', Number(a.other_monthly_income) ? `${money(a.other_monthly_income)}${a.other_income_source ? ' (' + esc(a.other_income_source) + ')' : ''}` : '') +
      kv('Debt instalments', money(a.monthly_debt_instalments))) +
    section('Rental history', kv('At current address', esc(a.time_at_current_address)) + kv('Current rent', a.current_rent ? money(a.current_rent) : '') +
      kv('Current landlord', [esc(a.current_landlord_name), telLink(a.current_landlord_phone), mailLink(a.current_landlord_email)].filter(Boolean).join(' · ')) +
      kv('Reason for moving', esc(a.reason_for_moving)) + kv('Previous address', esc(a.previous_address)) + kv('Previous landlord', esc(a.previous_landlord_contact))) +
    section('Declared history', kv('Eviction / judgment / listing', a.adverse_history_declared ? '<span class="text-red-700 font-semibold">Declared</span>' : 'None declared') +
      kv('Explanation', esc(a.adverse_history_explanation))) +
    section('Emergency contact', kv('Name', [esc(a.emergency_contact_name), esc(a.emergency_contact_relationship)].filter(Boolean).join(' · ')) + kv('Phone', telLink(a.emergency_contact_phone))) +
    section('Surety', kv('Surety', surety)) +
    section('Consent', kv('POPIA consent', a.has_consent ? 'Signed at submission' : '<span class="text-red-700 font-semibold">Missing</span>'));
}

async function renderDocuments(a) {
  const el = $('am-documents');
  el.innerHTML = '<p class="text-sm text-gray-400">Loading documents…</p>';
  if (a.documents_purged_at) { el.innerHTML = `<p class="text-sm text-gray-500">Documents were deleted on ${dt(a.documents_purged_at)} under the retention policy.</p>`; return; }
  const { data: docs, error } = await supabaseClient.from('rental_application_documents').select('*').eq('application_id', a.id).order('category');
  if (openApp?.id !== a.id) return;
  if (error) { el.innerHTML = `<p class="text-sm text-red-600">${esc(error.message)}</p>`; return; }
  if (!docs.length) { el.innerHTML = '<p class="text-sm text-gray-500">No documents.</p>'; return; }
  const labels = { id_document: 'ID / passport', payslip: 'Payslips', bank_statement: 'Bank statements', employment_letter: 'Employment letter',
    business_financials: 'Business financials', landlord_reference: 'Landlord reference', surety_document: 'Surety documents', other: 'Other' };
  el.innerHTML = `<p class="text-xs text-gray-500 mb-3">Links are private and expire after 10 minutes. Check payslip net pay against the salary deposits on the bank statements.</p>
    <ul class="divide-y divide-gray-100 text-sm">${docs.map((d) => `
      <li class="py-2.5 flex items-center justify-between gap-3">
        <span class="min-w-0"><span class="text-xs text-gray-500 block">${esc(labels[d.category] || d.category)}</span><span class="truncate block text-navy">${esc(d.original_filename)}</span></span>
        <button class="text-gold font-semibold hover:underline flex-shrink-0" data-doc-path="${esc(d.storage_path)}">Open</button>
      </li>`).join('')}</ul>`;
  el.querySelectorAll('[data-doc-path]').forEach((b) => b.addEventListener('click', async () => {
    const win = window.open('', '_blank');
    const { data, error: urlErr } = await supabaseClient.storage.from('rental-applications').createSignedUrl(b.dataset.docPath, 600);
    if (urlErr || !data?.signedUrl) { win && win.close(); return alert('Could not open document: ' + (urlErr?.message || 'unknown error')); }
    if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
  }));
}

async function renderHistory(a) {
  const el = $('am-history');
  el.innerHTML = '<p class="text-sm text-gray-400">Loading…</p>';
  const { data: events, error } = await supabaseClient.from('rental_application_events')
    .select('*, actor:actor_id ( full_name )').eq('application_id', a.id).order('created_at', { ascending: true });
  if (openApp?.id !== a.id) return;
  if (error) { el.innerHTML = `<p class="text-sm text-red-600">${esc(error.message)}</p>`; return; }
  el.innerHTML = `<ol class="space-y-3 text-sm">${(events || []).map((e) => `
    <li class="flex gap-3"><span class="text-xs text-gray-400 w-28 flex-shrink-0">${dtt(e.created_at)}</span>
      <span>${e.event_type === 'status_change' ? `${esc(e.from_status)} &rarr; <span class="font-semibold">${esc(e.to_status)}</span>`
        : e.event_type === 'created' ? 'Application started' : esc(e.event_type.replace(/_/g, ' '))}
        ${e.detail?.reason ? `<span class="block text-xs text-gray-500">Reason: ${esc(e.detail.reason)}</span>` : ''}
        ${e.detail?.note ? `<span class="block text-xs text-gray-500">${esc(e.detail.note)}</span>` : ''}
        <span class="block text-xs text-gray-400">${e.actor?.full_name ? esc(e.actor.full_name) : 'Applicant / system'}</span></span></li>`).join('')}</ol>`;
}

/* ---------------- Screening ---------------- */
const SCREEN_BOOL = ['identity_verified', 'employer_verified', 'income_verified', 'landlord_verified', 'document_mismatch'];
const SCREEN_TEXT = ['credit_bureau', 'credit_checked_at', 'landlord_reference', 'application_quality', 'red_flags', 'screening_notes'];

function fillScreeningForm(a) {
  SCREEN_BOOL.forEach((k) => { $(`sf-${k}`).checked = !!a[k]; });
  SCREEN_TEXT.forEach((k) => { $(`sf-${k}`).value = a[k] ?? ''; });
  $('sf-credit_score').value = a.credit_score ?? '';
  $('sf-adverse_listing_found').value = a.adverse_listing_found === null || a.adverse_listing_found === undefined ? '' : String(a.adverse_listing_found);
  $('screen-msg').classList.add('hidden');
  const locked = CLOSED.includes(a.status);
  $('screen-form').querySelectorAll('input, select, textarea, button').forEach((el) => { el.disabled = locked; });
}

function screeningFields() {
  const out = {};
  SCREEN_BOOL.forEach((k) => { out[k] = $(`sf-${k}`).checked; });
  SCREEN_TEXT.forEach((k) => { out[k] = $(`sf-${k}`).value.trim() || null; });
  out.credit_score = $('sf-credit_score').value === '' ? null : parseInt($('sf-credit_score').value, 10);
  const adv = $('sf-adverse_listing_found').value;
  out.adverse_listing_found = adv === '' ? null : adv === 'true';
  return out;
}

function screeningDraft() { return { ...openApp, ...screeningFields() }; }

async function saveScreening(e) {
  e.preventDefault();
  const fields = screeningFields();
  const r = evaluate({ ...openApp, ...fields });
  const update = {
    ...fields,
    score_breakdown: { knockouts: r.knockouts, factors: r.factors, settings: r.settingsUsed, evaluated_at: new Date().toISOString() },
    total_score: r.total,
    knockout_failed: r.knockoutFailed,
    recommendation: r.recommendation,
    screened_by: currentUser.id,
    screened_at: new Date().toISOString(),
  };
  if (openApp.status === 'Submitted') update.status = 'Screening';
  const { data, error } = await supabaseClient.from('rental_applications').update(update).eq('id', openApp.id).select().single();
  const msg = $('screen-msg');
  msg.classList.remove('hidden', 'text-red-600', 'text-green-700');
  if (error) { msg.textContent = error.message; msg.classList.add('text-red-600'); return; }
  msg.textContent = 'Screening saved.';
  msg.classList.add('text-green-700');
  await refreshOpenApp(data);
}

async function refreshOpenApp(row) {
  const idx = applications.findIndex((a) => a.id === row.id);
  const merged = { ...applications[idx], ...row };
  applications[idx] = merged;
  openApp = merged;
  $('am-status').innerHTML = pill(merged.status, STATUS_STYLE[merged.status]);
  renderScorePanel(merged);
  renderActions(merged);
  renderHistory(merged);
  renderKpis();
  renderVacancies();
  renderApplications();
}

function renderScorePanel(app) {
  const r = evaluate(app);
  const s = r.settingsUsed;
  const recText = r.knockoutFailed ? 'Decline: failed a knockout'
    : r.recommendation === 'Approve' ? 'Approve'
    : r.recommendation === 'Conditional' ? 'Approve only with a surety or larger deposit'
    : r.recommendation === 'Incomplete' ? `Incomplete: capture ${r.missing.join(', ')}`
    : 'Decline: score below threshold';
  const band = { full: 'text-green-700', half: 'text-amber-700', zero: 'text-red-700', missing: 'text-gray-400' };
  $('am-score').innerHTML = `
    <div class="flex items-end justify-between mb-1">
      <p class="text-sm text-gray-500">Score</p>
      <p class="font-display font-bold text-4xl ${r.knockoutFailed ? 'text-red-700' : 'text-navy'}">${r.knockoutFailed ? '—' : r.total}<span class="text-base text-gray-400 font-sans font-normal"> / 100</span></p>
    </div>
    <div class="h-2 rounded-full bg-gray-200 mb-1 relative overflow-hidden">
      <div class="h-2 ${r.knockoutFailed ? 'bg-red-500' : r.total >= s.approve_min_score ? 'bg-green-600' : r.total >= s.conditional_min_score ? 'bg-amber-500' : 'bg-red-500'}" style="width:${r.knockoutFailed ? 100 : r.total}%"></div>
    </div>
    <p class="text-xs text-gray-400 mb-3">Approve from ${s.approve_min_score} · conditional ${s.conditional_min_score}–${s.approve_min_score - 1} · decline below ${s.conditional_min_score}</p>
    <p class="mb-5">${pill(recText, REC_STYLE[r.recommendation])}</p>

    <h4 class="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-1">Knockouts</h4>
    <p class="text-xs text-gray-400 mb-2">Any one triggered means decline, whatever the score.</p>
    <ul class="space-y-2 text-sm mb-5">${r.knockouts.map((k) => `
      <li class="flex items-start justify-between gap-3">
        <span><span class="${k.failed === true ? 'text-red-700 font-semibold' : 'text-gray-700'}">${esc(k.label)}</span><span class="block text-xs text-gray-400">${esc(k.detail)}</span></span>
        ${k.failed === true ? pill('Triggered', 'bg-red-100 text-red-700') : k.failed === false ? pill('Clear', 'bg-green-100 text-green-700') : pill('Not checked', 'bg-gray-100 text-gray-500')}
      </li>`).join('')}</ul>

    <h4 class="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-2">Score breakdown</h4>
    <table class="w-full text-sm"><tbody>${r.factors.map((f) => `
      <tr class="border-b border-gray-200 last:border-0 align-top">
        <td class="py-1.5 pr-2"><span class="text-gray-700">${esc(f.label)}</span><span class="block text-xs text-gray-400">${esc(f.reason)}</span></td>
        <td class="py-1.5 text-right whitespace-nowrap font-semibold ${band[f.band]}">${f.points === null ? '—' : f.points} <span class="text-gray-400 font-normal">/ ${f.weight}</span></td>
      </tr>`).join('')}</tbody></table>
    ${settings && !settings.settings_confirmed ? '<p class="text-xs text-amber-700 mt-3">Thresholds not yet confirmed by your property practitioner.</p>' : ''}`;
}

/* ---------------- Decision actions ---------------- */
function renderActions(a) {
  const el = $('am-actions');
  const r = evaluate(a);
  const btn = (id, label, cls) => `<button data-action="${id}" class="btn ${cls} !py-2 !px-4 text-sm w-full">${esc(label)}</button>`;
  const parts = [];
  const offerable = !r.knockoutFailed && (r.recommendation === 'Approve' || r.recommendation === 'Conditional');

  if (['Submitted', 'Screening', 'Shortlisted', 'Reserve'].includes(a.status)) {
    if (a.status !== 'Shortlisted') parts.push(btn('Shortlisted', 'Shortlist', 'btn-outline-navy'));
    if (a.status !== 'Reserve') parts.push(btn('Reserve', 'Keep on reserve', 'btn-outline-navy'));
    parts.push(offerable ? btn('offer', 'Make offer', 'btn-primary')
      : `<p class="text-xs text-gray-500">An offer is available once the application is fully scored and passes (score ${evaluate(a).settingsUsed.conditional_min_score}+ with no knockouts).</p>`);
    parts.push(btn('decline', 'Decline', 'btn-outline-navy !text-red-700 !border-red-200'));
  }
  if (a.status === 'Offered') {
    const expired = a.offer_expires_at && new Date(a.offer_expires_at) < new Date();
    parts.push(`<p class="text-sm ${expired ? 'text-red-700 font-semibold' : 'text-gray-600'}">Offer ${expired ? 'expired' : 'expires'} ${dtt(a.offer_expires_at)}.</p>`);
    parts.push(btn('email-offer', 'Re-open offer email', 'btn-outline-navy'));
    parts.push(btn('Accepted', 'Applicant accepted in writing', 'btn-primary'));
    parts.push(btn('decline', expired ? 'Offer lapsed: decline' : 'Decline', 'btn-outline-navy !text-red-700 !border-red-200'));
  }
  if (a.status === 'Accepted') parts.push('<div id="handover-box" class="text-sm text-gray-500">Checking for a tenant account…</div>');
  if (a.status === 'Lease created') parts.push(`<p class="text-sm text-green-700 font-semibold">Draft lease created. Continue in <a class="underline" href="lease-dashboard.html">Leases</a>, where KYC and signature run as usual.</p>`);
  if (a.status === 'Declined') parts.push(btn('email-decline', 'Re-open decline email', 'btn-outline-navy'));
  if (!CLOSED.includes(a.status)) parts.push(btn('Withdrawn', 'Applicant withdrew', 'btn-outline-navy !text-gray-500'));

  el.innerHTML = `<h4 class="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-3">Decision</h4><div class="space-y-2.5">${parts.join('')}</div>`;
  el.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => runAction(b.dataset.action)));
  if (a.status === 'Accepted') renderHandover(a);
}

async function setStatus(status, extra = {}) {
  const { data, error } = await supabaseClient.from('rental_applications').update({ status, ...extra }).eq('id', openApp.id).select().single();
  if (error) { alert('Could not update application: ' + error.message); return null; }
  await refreshOpenApp(data);
  return data;
}

async function runAction(action) {
  const a = openApp;
  const v = vacancyOf(a);
  const now = new Date().toISOString();

  if (['Shortlisted', 'Reserve'].includes(action)) return setStatus(action);

  if (action === 'Withdrawn') {
    const reason = prompt('Mark as withdrawn. Note (optional): why did the applicant withdraw?');
    if (reason === null) return; // cancelled
    return setStatus('Withdrawn', { decision_reason: reason || 'Applicant withdrew', decided_by: currentUser.id, decided_at: now });
  }

  if (action === 'offer') {
    const r = evaluate(a);
    const conditional = r.recommendation === 'Conditional';
    const others = applications.filter((x) => x.vacancy_id === a.vacancy_id && x.id !== a.id && x.status === 'Offered');
    if (others.length && !confirm(`${others.map((o) => o.full_name).join(', ')} already holds an offer on this unit. Make a second offer anyway?`)) return;
    if (!confirm(`Offer ${v?.title || 'this unit'} to ${a.full_name}?${conditional ? '\n\nThis applicant scored in the conditional band: the offer email will ask for a surety or a larger deposit.' : ''}`)) return;
    const hours = Number(settings?.offer_valid_hours || 48);
    const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const row = await setStatus('Offered', { offer_sent_at: now, offer_expires_at: expires, decided_by: currentUser.id, decided_at: now, decision_reason: conditional ? 'Conditional approval: surety or larger deposit required' : 'Approved' });
    if (row) openMail(offerEmail(row, v, conditional));
    return;
  }

  if (action === 'email-offer') return openMail(offerEmail(a, v, evaluate(a).recommendation === 'Conditional'));
  if (action === 'email-decline') return openMail(declineEmail(a, v));

  if (action === 'Accepted') {
    if (!confirm(`Confirm ${a.full_name} has accepted the offer in writing?`)) return;
    return setStatus('Accepted', { accepted_at: now });
  }

  if (action === 'decline') {
    const r = evaluate(a);
    const suggested = r.knockoutFailed ? r.reasons.join('; ') : r.recommendation === 'Decline' ? r.reasons.join('; ') : '';
    const reason = prompt('Reason for declining (internal record; not sent to the applicant):', suggested);
    if (reason === null) return;
    if (!reason.trim()) return alert('Please record a reason so the decision can be explained later.');
    const row = await setStatus('Declined', { decision_reason: reason.trim(), decided_by: currentUser.id, decided_at: now });
    if (row) openMail(declineEmail(row, v));
  }
}

/* ---------------- Emails (opened in the admin's mail app) ---------------- */
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function offerEmail(a, v, conditional) {
  const deadline = new Date(a.offer_expires_at).toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' });
  const start = a.move_in_date || v?.available_from;
  const body = `Hi ${firstName(a.full_name)},

Good news: your application to rent ${v?.title || 'the unit'} (${v?.area || ''}) has been approved${conditional ? ', subject to the condition below' : ''}.

Rent: ${money(v?.monthly_rent)} per month, due on the 1st
Deposit: ${money(v?.deposit)}
Lease start: ${start ? new Date(start + 'T00:00:00').toLocaleDateString('en-ZA', { dateStyle: 'long' }) : 'to be agreed'} | Term: ${a.lease_term_months || 12} months
${conditional ? '\nCondition: we require either a surety who meets our screening requirements, or an additional deposit. Please reply to let us know which you prefer.\n' : ''}
Please confirm by ${deadline} that you accept. Once you do, you'll receive the lease to sign through our platform, along with deposit payment details.

The unit stays available to other applicants until we receive your confirmation.

Kind regards,
${currentUser.full_name || 'Zanka Group'}
Zanka Group (Pty) Ltd`;
  return { to: a.email, subject: `Your application for ${v?.title || 'the unit'} – approved (ref ${a.reference})`, body };
}

function declineEmail(a, v) {
  const retention = settings?.declined_doc_retention_days || 90;
  const usedCredit = a.credit_score !== null && a.credit_score !== undefined;
  const body = `Hi ${firstName(a.full_name)},

Thank you for applying for ${v?.title || 'the unit'} (${v?.area || ''}). After assessing all applications against our standard criteria, we are unable to offer you this unit.
${usedCredit ? `\nIf our decision was influenced by your credit report, you are entitled to a free copy of it from ${a.credit_bureau || 'the credit bureau'}, and may dispute anything inaccurate.\n` : ''}
Your documents will be destroyed within ${retention} days, as set out in the consent you signed.

Kind regards,
${currentUser.full_name || 'Zanka Group'}
Zanka Group (Pty) Ltd`;
  return { to: a.email, subject: `Your application for ${v?.title || 'the unit'} (ref ${a.reference})`, body };
}

function openMail({ to, subject, body }) {
  window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/* ---------------- Hand-over to the Lease Wizard ---------------- */
async function renderHandover(a) {
  const box = $('handover-box');
  const { data: tenant, error } = await supabaseClient.from('profiles').select('id, full_name, email, role')
    .ilike('email', a.email.replace(/[\\%_]/g, '\\$&')).limit(1).maybeSingle();
  if (openApp?.id !== a.id || !$('handover-box')) return;
  if (error) { box.innerHTML = `<p class="text-red-600">${esc(error.message)}</p>`; return; }

  const signupUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}tenant-signup.html`;
  if (!tenant) {
    box.innerHTML = `
      <p class="text-gray-700 mb-3">The Lease Wizard needs a tenant account. No account exists for <span class="font-semibold">${esc(a.email)}</span> yet.</p>
      <div class="space-y-2.5">
        <button id="btn-invite" class="btn btn-primary !py-2 !px-4 text-sm w-full">Email account invitation</button>
        <button id="btn-recheck" class="btn btn-outline-navy !py-2 !px-4 text-sm w-full">They've signed up: check again</button>
      </div>`;
    $('btn-invite').addEventListener('click', () => openMail({
      to: a.email,
      subject: `Next step for your lease at ${vacancyOf(a)?.title || 'Zanka Group'}`,
      body: `Hi ${firstName(a.full_name)},\n\nThank you for accepting our offer. To receive and sign your lease online, please create your tenant account here, using this email address (${a.email}):\n\n${signupUrl}\n\nLet us know once you've signed up and we'll send the lease.\n\nKind regards,\n${currentUser.full_name || 'Zanka Group'}\nZanka Group (Pty) Ltd`,
    }));
    $('btn-recheck').addEventListener('click', () => renderHandover(a));
    return;
  }
  if (tenant.role !== 'tenant') {
    box.innerHTML = `<p class="text-red-700">An account exists for ${esc(a.email)}, but it is registered as "${esc(tenant.role)}", not a tenant. Ask the applicant to sign up as a tenant with a different email, or fix the account's role first.</p>`;
    return;
  }
  box.innerHTML = `
    <p class="text-gray-700 mb-3">Tenant account found: <span class="font-semibold">${esc(tenant.full_name)}</span>. The Lease Wizard will open with the property, tenant, rent and deposit filled in; creating the lease also starts KYC.</p>
    <a href="lease-wizard.html?application=${encodeURIComponent(a.id)}" class="btn btn-primary !py-2 !px-4 text-sm w-full text-center block">Create lease in Lease Wizard</a>`;
}

/* ================================================================
   SETTINGS + RETENTION
   ================================================================ */
function openSettings() {
  const s = settings || RecruitmentScoring.DEFAULT_SETTINGS;
  const p = (x) => +(Number(x) * 100).toFixed(2);
  $('st-aff-full').value = p(s.affordability_full_max);
  $('st-aff-half').value = p(s.affordability_half_max);
  $('st-aff-ko').value = p(s.affordability_knockout_max);
  $('st-credit-full').value = s.credit_full_min;
  $('st-credit-half').value = s.credit_half_min;
  $('st-debt-full').value = p(s.debt_full_max);
  $('st-debt-half').value = p(s.debt_half_max);
  $('st-approve').value = s.approve_min_score;
  $('st-conditional').value = s.conditional_min_score;
  $('st-offer-hours').value = settings?.offer_valid_hours ?? 48;
  $('st-retention').value = settings?.declined_doc_retention_days ?? 90;
  $('st-confirmed').checked = !!settings?.settings_confirmed;
  $('st-confirmed-note').value = settings?.confirmed_by_note || '';
  $('settings-msg').classList.add('hidden');
  $('settings-modal').classList.remove('hidden');
}

async function saveSettings(e) {
  e.preventDefault();
  const f = (id) => Number($(id).value) / 100;
  const i = (id) => parseInt($(id).value, 10);
  const row = {
    affordability_full_max: f('st-aff-full'), affordability_half_max: f('st-aff-half'), affordability_knockout_max: f('st-aff-ko'),
    credit_full_min: i('st-credit-full'), credit_half_min: i('st-credit-half'),
    debt_full_max: f('st-debt-full'), debt_half_max: f('st-debt-half'),
    approve_min_score: i('st-approve'), conditional_min_score: i('st-conditional'),
    offer_valid_hours: i('st-offer-hours'), declined_doc_retention_days: i('st-retention'),
    settings_confirmed: $('st-confirmed').checked, confirmed_by_note: $('st-confirmed-note').value.trim() || null,
    updated_by: currentUser.id,
  };
  const msg = $('settings-msg');
  msg.classList.remove('hidden', 'text-red-600', 'text-green-700');
  if (!(row.affordability_full_max <= row.affordability_half_max && row.affordability_half_max <= row.affordability_knockout_max)) {
    msg.textContent = 'Affordability bands must increase: full ≤ half ≤ knockout.'; msg.classList.add('text-red-600'); return;
  }
  if (!(row.conditional_min_score <= row.approve_min_score)) {
    msg.textContent = 'The conditional score must be at or below the approve score.'; msg.classList.add('text-red-600'); return;
  }
  const { data, error } = await supabaseClient.from('rental_recruitment_settings').update(row).eq('id', settings.id).select().single();
  if (error) { msg.textContent = error.message; msg.classList.add('text-red-600'); return; }
  settings = data;
  msg.textContent = 'Settings saved. Scores below use the new values; saved score snapshots update when an application is next saved.';
  msg.classList.add('text-green-700');
  $('settings-banner').classList.toggle('hidden', !!settings.settings_confirmed);
  renderApplications();
  if (openApp) renderScorePanel(openApp);
}

// POPIA: documents of declined or withdrawn applicants are deleted after the
// retention period promised in the consent. Storage files first, then rows.
async function purgeExpiredDocuments() {
  const days = Number(settings?.declined_doc_retention_days || 90);
  const cutoff = new Date(Date.now() - days * 86400 * 1000);
  const due = applications.filter((a) => ['Declined', 'Withdrawn'].includes(a.status) && !a.documents_purged_at && a.decided_at && new Date(a.decided_at) < cutoff);
  if (!due.length) return alert(`Nothing to delete: no declined or withdrawn application is older than ${days} days.`);
  if (!confirm(`Permanently delete the documents of ${due.length} declined or withdrawn application(s) decided before ${cutoff.toLocaleDateString('en-ZA')}? The application record and consent are kept.`)) return;

  let done = 0;
  for (const a of due) {
    const { data: docs, error } = await supabaseClient.from('rental_application_documents').select('id, storage_path').eq('application_id', a.id);
    if (error) { alert(`Stopped at ${a.reference}: ${error.message}`); break; }
    if (docs.length) {
      const { error: rmErr } = await supabaseClient.storage.from('rental-applications').remove(docs.map((d) => d.storage_path));
      if (rmErr) { alert(`Stopped at ${a.reference}: ${rmErr.message}`); break; }
      const { error: delErr } = await supabaseClient.from('rental_application_documents').delete().eq('application_id', a.id);
      if (delErr) { alert(`Stopped at ${a.reference}: ${delErr.message}`); break; }
    }
    await supabaseClient.from('rental_applications').update({ documents_purged_at: new Date().toISOString() }).eq('id', a.id);
    await supabaseClient.from('rental_application_events').insert([{ application_id: a.id, event_type: 'documents_deleted', actor_id: currentUser.id, detail: { note: `${docs.length} file(s) deleted under ${days}-day retention` } }]);
    done++;
  }
  alert(`Deleted documents for ${done} application(s).`);
  await loadAll();
}


/* ================================================================
   LISTING PHOTOS (vacancy form)
   ================================================================ */
function closeModal(id) {
  $(id).classList.add('hidden');
  if (id === 'vacancy-modal') discardUnsavedPhotos();
}

// Closing the form without saving: delete photos uploaded in this session,
// so no unused files are left in public storage.
function discardUnsavedPhotos() {
  if (photoState.saved || !photoState.uploaded.length) return;
  const paths = photoState.uploaded;
  photoState.uploaded = [];
  supabaseClient.storage.from(PHOTO_BUCKET).remove(paths);
}

function photoUrl(path) {
  return supabaseClient.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Decode any photo the browser can read (Safari also reads iPhone HEIC),
// shrink it so its long side is at most 1600px, and re-encode as JPEG.
// A 5 MB phone photo becomes roughly 200–400 KB.
async function resizePhoto(file, maxSide = 1600, quality = 0.82) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} could not be read. Please use a JPG or PNG photo.`)); };
      img.src = url;
    });
  }
  const w0 = source.width || source.naturalWidth;
  const h0 = source.height || source.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const width = Math.round(w0 * scale);
  const height = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  if (source.close) source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error(`${file.name} could not be converted.`);
  return { blob, width, height };
}

async function addPhotos(files) {
  const images = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  const room = MAX_PHOTOS - photoState.photos.length;
  if (!images.length) return;
  if (room <= 0) return showPhotoProgress(`This listing already has ${MAX_PHOTOS} photos. Remove one to add another.`, true);
  const batch = images.slice(0, room);
  const errors = [];
  photoState.busy = true;
  for (let i = 0; i < batch.length; i++) {
    const file = batch[i];
    showPhotoProgress(`Uploading photo ${i + 1} of ${batch.length}…`);
    try {
      const { blob, width, height } = await resizePhoto(file);
      const path = `${photoState.vacancyId}/${crypto.randomUUID()}.jpg`;
      const { error } = await supabaseClient.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
      if (error) throw new Error(`${file.name}: ${error.message}`);
      photoState.uploaded.push(path);
      photoState.photos.push({ path, width, height });
      renderPhotos();
    } catch (err) {
      errors.push(err.message);
    }
  }
  photoState.busy = false;
  if (images.length > room) errors.push(`Only ${room} more photo${room === 1 ? '' : 's'} fit (maximum ${MAX_PHOTOS}).`);
  if (errors.length) showPhotoProgress(errors.join(' '), true);
  else showPhotoProgress(`${batch.length} photo${batch.length === 1 ? '' : 's'} added. Save the vacancy to publish them.`);
}

function showPhotoProgress(text, isError) {
  const el = $('vf-photos-progress');
  el.textContent = text;
  el.classList.remove('hidden', 'text-red-600', 'text-gray-500');
  el.classList.add(isError ? 'text-red-600' : 'text-gray-500');
}

function movePhoto(from, to) {
  const list = photoState.photos;
  if (to < 0 || to >= list.length || from === to) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  renderPhotos();
}

function renderPhotos() {
  const grid = $('vf-photos');
  const list = photoState.photos;
  if (!list.length) {
    grid.innerHTML = '<p class="col-span-full rounded-xl border border-dashed border-gray-300 py-8 text-center text-sm text-gray-400">No photos yet. Listings with good photos attract far more serious applicants.</p>';
    return;
  }
  grid.innerHTML = list.map((p, i) => `
    <figure class="photo-tile group relative rounded-xl overflow-hidden border ${i === 0 ? 'border-gold ring-2 ring-gold/40' : 'border-gray-200'} bg-offwhite" draggable="true" data-index="${i}">
      <img src="${esc(photoUrl(p.path))}" alt="Photo ${i + 1}" class="w-full aspect-[4/3] object-cover pointer-events-none" loading="lazy">
      ${i === 0 ? '<span class="absolute top-2 left-2 pill bg-gold text-navy-deep">Cover</span>' : ''}
      <figcaption class="flex items-center justify-between gap-1 px-1.5 py-1 bg-white text-xs">
        <span class="flex">
          <button type="button" data-move="${i}:-1" class="px-1.5 py-1 rounded hover:bg-offwhite disabled:opacity-30" ${i === 0 ? 'disabled' : ''} aria-label="Move left">&larr;</button>
          <button type="button" data-move="${i}:1" class="px-1.5 py-1 rounded hover:bg-offwhite disabled:opacity-30" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move right">&rarr;</button>
        </span>
        ${i === 0 ? '' : `<button type="button" data-cover="${i}" class="px-1.5 py-1 rounded text-navy font-semibold hover:bg-offwhite" title="Make this the cover photo">Cover</button>`}
        <button type="button" data-remove-photo="${i}" class="w-7 h-7 rounded text-red-700 hover:bg-red-50 text-base leading-none" title="Remove photo" aria-label="Remove photo">&times;</button>
      </figcaption>
    </figure>`).join('');

  grid.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
    const [i, d] = b.dataset.move.split(':').map(Number);
    movePhoto(i, i + d);
  }));
  grid.querySelectorAll('[data-cover]').forEach((b) => b.addEventListener('click', () => movePhoto(Number(b.dataset.cover), 0)));
  grid.querySelectorAll('[data-remove-photo]').forEach((b) => b.addEventListener('click', () => {
    photoState.photos.splice(Number(b.dataset.removePhoto), 1);
    renderPhotos();
  }));

  // Drag and drop to reorder (desktop).
  let dragFrom = null;
  grid.querySelectorAll('.photo-tile').forEach((tile) => {
    tile.addEventListener('dragstart', (e) => { dragFrom = Number(tile.dataset.index); e.dataTransfer.effectAllowed = 'move'; tile.classList.add('opacity-50'); });
    tile.addEventListener('dragend', () => tile.classList.remove('opacity-50'));
    tile.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    tile.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom !== null) movePhoto(dragFrom, Number(tile.dataset.index)); dragFrom = null; });
  });
}
