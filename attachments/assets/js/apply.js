// Zanka Group — public rental application (apply.html)
//
// No account needed. The applicant never reads any table: everything goes
// through the SECURITY DEFINER functions in 024_tenant_recruitment.sql:
//   list_open_rental_vacancies()          -> units to let
//   submit_rental_application()           -> creates the application ('Uploading') + consent, returns an upload token
//   storage upload into rental-applications/{application_id}/...
//   register_rental_application_document() per file
//   complete_rental_application()         -> checks required documents, status 'Submitted'
// Requires assets/js/supabase-client.js.

const CONSENT_VERSION = '2026-10-v1';
const MAX_FILE_MB = 10;
const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

const DOC_CATEGORIES = [
  { key: 'id_document', label: 'Certified copy of your ID or passport', required: () => true },
  { key: 'payslip', label: 'Your 3 most recent payslips', required: (f) => f.employment_type !== 'Self-employed', hideIf: (f) => f.employment_type === 'Self-employed' },
  { key: 'bank_statement', label: "3 months' bank statements (PDF downloaded from your bank, not screenshots)", required: () => true },
  { key: 'business_financials', label: "6 months' bank statements plus latest financial statements or tax return", required: (f) => f.employment_type === 'Self-employed', hideIf: (f) => f.employment_type !== 'Self-employed' },
  { key: 'employment_letter', label: 'Employment confirmation letter (under 30 days old) — recommended if under 6 months in your job', required: () => false, hideIf: (f) => f.employment_type === 'Self-employed' },
  { key: 'landlord_reference', label: 'Reference letter from your current landlord (optional)', required: () => false },
  { key: 'surety_document', label: "Surety's ID, payslips and bank statements", required: (f) => f.has_surety, hideIf: (f) => !f.has_surety },
];

let vacancies = [];
let vacancy = null;
let step = 1;
const TOTAL_STEPS = 6;
const files = {}; // category -> File[]
let uploadSession = null; // { created: {id, reference, upload_token}, uploaded: Set<File> } once submitted

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'R' + Number(n || 0).toLocaleString('en-ZA', { maximumFractionDigits: 0 });
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

document.addEventListener('DOMContentLoaded', async () => {
  const qs = new URLSearchParams(location.search);
  if (qs.get('cancel_viewing')) { showCancelViewing(qs.get('cancel_viewing'), qs.get('t'), qs.get('vacancy')); return; }
  const { data, error } = await supabaseClient.rpc('list_open_rental_vacancies');
  if (error) {
    $('vacancy-list').innerHTML = `<p class="text-red-600">We couldn't load available units right now. Please try again later, or contact us on <a class="underline" href="mailto:info@zankagroup.co.za">info@zankagroup.co.za</a>.</p>`;
    return;
  }
  vacancies = data || [];
  const id = new URLSearchParams(location.search).get('vacancy');
  if (id) {
    vacancy = vacancies.find((v) => v.id === id) || null;
    if (!vacancy) {
      $('list-view').classList.remove('hidden');
      $('list-notice').textContent = 'That unit is no longer accepting applications. Here is what is currently available.';
      $('list-notice').classList.remove('hidden');
      renderList();
      return;
    }
    showApplyView();
  } else {
    $('list-view').classList.remove('hidden');
    renderList();
  }
});

/* ---------------- Vacancy list ---------------- */
function renderList() {
  if (!vacancies.length) {
    $('vacancy-list').innerHTML = `<div class="rounded-2xl border border-gray-200 bg-white p-8 text-center text-gray-500">
      No units are open for applications right now. Check back soon, or email <a class="text-gold font-semibold" href="mailto:info@zankagroup.co.za">info@zankagroup.co.za</a> to hear when one becomes available.</div>`;
    return;
  }
  $('vacancy-list').innerHTML = vacancies.map((v) => `
    <article class="rounded-2xl border border-gray-200 bg-white overflow-hidden flex flex-col">
      <a href="apply.html?vacancy=${encodeURIComponent(v.id)}" class="block bg-offwhite" tabindex="-1" aria-hidden="true">
        ${coverImg(v)}
      </a>
      <div class="p-6 flex flex-col flex-1">
      <p class="eyebrow mb-2">${esc(v.area)}</p>
      <h2 class="font-display font-bold text-navy text-xl mb-3">${esc(v.title)}</h2>
      <p class="font-semibold text-navy text-2xl mb-1">${money(v.monthly_rent)} <span class="text-sm font-normal text-gray-500">per month</span></p>
      <p class="text-sm text-gray-500 mb-4">${v.available_from ? 'Available ' + esc(fmtDate(v.available_from)) : 'Available now'}</p>
      <ul class="text-sm text-gray-600 space-y-1 mb-5">${specLines(v).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <a href="apply.html?vacancy=${encodeURIComponent(v.id)}" class="btn btn-primary mt-auto text-center">View and apply</a>
      </div>
    </article>`).join('');
}

function specLines(v) {
  const out = [];
  const has = (x) => x !== null && x !== undefined && x !== '' && !Number.isNaN(Number(x));
  if (has(v.bedrooms)) out.push(`${Number(v.bedrooms)} bedroom${Number(v.bedrooms) === 1 ? '' : 's'}`);
  if (has(v.bathrooms)) out.push(`${Number(v.bathrooms)} bathroom${Number(v.bathrooms) === 1 ? '' : 's'}`);
  if (has(v.parking_bays)) out.push(`${Number(v.parking_bays)} parking bay${Number(v.parking_bays) === 1 ? '' : 's'}`);
  (v.features || []).forEach((f) => out.push(f));
  return out;
}

/* ---------------- Apply view ---------------- */
function showApplyView() {
  $('apply-view').classList.remove('hidden');
  document.title = `Apply: ${vacancy.title} | Zanka Group`;
  $('v-area').textContent = vacancy.area;
  $('v-title').textContent = vacancy.title;
  $('v-rent').textContent = money(vacancy.monthly_rent);
  $('v-deposit').textContent = vacancy.deposit ? money(vacancy.deposit) : 'On request';
  $('v-available').textContent = vacancy.available_from ? fmtDate(vacancy.available_from) : 'Now';
  $('v-specs').innerHTML = specLines(vacancy).map((l) => `<li>${esc(l)}</li>`).join('');
  $('v-description').textContent = vacancy.description || '';
  $('v-pets').textContent = vacancy.pets_policy || '';
  $('v-occupants').textContent = vacancy.max_occupants ? `Maximum ${vacancy.max_occupants} occupants` : '';
  $('v-min-income').textContent = money(vacancy.min_gross_income);
  if (vacancy.applications_close_at) {
    $('v-closes').textContent = `Applications close ${new Date(vacancy.applications_close_at).toLocaleString('en-ZA', { dateStyle: 'long', timeStyle: 'short' })}.`;
  }

  renderGallery(vacancy);
  loadViewingSlots();
  addOccupantRow('', '');
  wireForm();
  showStep(1, { initial: true });
}

function wireForm() {
  $('f-employment_type').addEventListener('change', onEmploymentChange);
  ['f-gross_monthly_income', 'f-other_monthly_income'].forEach((id) => $(id).addEventListener('input', updateAffordability));
  $('f-adverse_history_declared').addEventListener('change', (e) => $('adverse-wrap').classList.toggle('hidden', !e.target.checked));
  $('f-has_surety').addEventListener('change', (e) => {
    $('surety-wrap').classList.toggle('hidden', !e.target.checked);
    $('consent-surety-wrap').classList.toggle('hidden', !e.target.checked);
  });
  $('add-occupant').addEventListener('click', () => addOccupantRow('', ''));
  $('f-full_name').addEventListener('input', (e) => {
    const first = document.querySelector('.occupant-name');
    if (first && (!first.value || first.dataset.auto === '1')) { first.value = e.target.value; first.dataset.auto = '1'; }
  });
  $('btn-back').addEventListener('click', () => showStep(step - 1));
  $('btn-next').addEventListener('click', () => { if (validateStep(step)) showStep(step + 1); });
  $('apply-form').addEventListener('submit', onSubmit);
  onEmploymentChange();
}

function onEmploymentChange() {
  const t = $('f-employment_type').value;
  $('employed-wrap').classList.toggle('hidden', t === 'Self-employed' || t === '');
  $('contract-wrap').classList.toggle('hidden', t !== 'Contract');
  $('self-employed-wrap').classList.toggle('hidden', t !== 'Self-employed');
  $('start-label').textContent = t === 'Self-employed' ? 'Business trading since' : 'Start date';
}

function updateAffordability() {
  const gross = (parseFloat($('f-gross_monthly_income').value) || 0) + (parseFloat($('f-other_monthly_income').value) || 0);
  const el = $('affordability-hint');
  if (!gross) { el.classList.add('hidden'); return; }
  const ratio = vacancy.monthly_rent / gross;
  el.classList.remove('hidden', 'bg-green-50', 'text-green-800', 'bg-amber-50', 'text-amber-800');
  if (gross >= vacancy.min_gross_income) {
    el.classList.add('bg-green-50', 'text-green-800');
    el.textContent = `The rent is ${(ratio * 100).toFixed(0)}% of your gross household income. This meets our minimum income requirement.`;
  } else {
    el.classList.add('bg-amber-50', 'text-amber-800');
    el.textContent = `The rent is ${(ratio * 100).toFixed(0)}% of your gross household income. The minimum gross household income for this unit is ${money(vacancy.min_gross_income)}, so this application is unlikely to succeed unless you add a co-applicant's or other regular income.`;
  }
}

function addOccupantRow(name, age) {
  const row = document.createElement('div');
  row.className = 'occupant-row grid grid-cols-[1fr_6rem_auto] gap-3 items-end';
  row.innerHTML = `
    <div><label class="field-label">Full name</label><input class="field occupant-name" value="${esc(name)}"></div>
    <div><label class="field-label">Age</label><input type="number" min="0" max="120" class="field occupant-age" value="${esc(age)}"></div>
    <button type="button" class="occupant-remove text-sm text-gray-400 hover:text-red-600 pb-3" aria-label="Remove occupant">Remove</button>`;
  row.querySelector('.occupant-remove').addEventListener('click', () => {
    if (document.querySelectorAll('.occupant-row').length > 1) row.remove();
  });
  $('occupants-list').appendChild(row);
}

function showStep(n, opts = {}) {
  step = Math.max(1, Math.min(TOTAL_STEPS, n));
  document.querySelectorAll('[data-step]').forEach((el) => el.classList.toggle('hidden', Number(el.dataset.step) !== step));
  $('step-count').textContent = `Step ${step} of ${TOTAL_STEPS}`;
  $('step-name').textContent = document.querySelector(`[data-step="${step}"]`).dataset.title;
  $('step-bar').style.width = `${(step / TOTAL_STEPS) * 100}%`;
  $('btn-back').classList.toggle('invisible', step === 1);
  $('btn-next').classList.toggle('hidden', step === TOTAL_STEPS);
  $('btn-submit').classList.toggle('hidden', step !== TOTAL_STEPS);
  $('form-error').classList.add('hidden');
  if (step === 5) renderDocInputs();
  if (step === 6) prepareConsent();
  if (!opts.initial) $('apply-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showError(msg) {
  $('form-error').textContent = msg;
  $('form-error').classList.remove('hidden');
}

function fieldValue(id) { return ($(`f-${id}`)?.value || '').trim(); }

function validateStep(n) {
  const section = document.querySelector(`[data-step="${n}"]`);
  // Native required/format checks on visible fields first.
  for (const el of section.querySelectorAll('input, select, textarea')) {
    if (el.closest('.hidden')) continue;
    if (!el.checkValidity()) { el.reportValidity(); return false; }
  }
  if (n === 1) {
    const id = fieldValue('id_number').replace(/\s/g, '');
    if (!/^[A-Za-z0-9]{6,20}$/.test(id)) { showError('Please enter a valid SA ID or passport number.'); return false; }
  }
  if (n === 2) {
    const names = [...document.querySelectorAll('.occupant-name')].map((e) => e.value.trim()).filter(Boolean);
    if (!names.length) { showError('Please list everyone who will live in the unit, including yourself.'); return false; }
    if (vacancy.max_occupants && names.length > vacancy.max_occupants) {
      showError(`This unit allows a maximum of ${vacancy.max_occupants} occupants.`); return false;
    }
  }
  if (n === 3) {
    const t = fieldValue('employment_type');
    const gross = parseFloat(fieldValue('gross_monthly_income')) || 0;
    const net = parseFloat(fieldValue('net_monthly_income')) || 0;
    if (net > gross && gross > 0) { showError('Net income (after tax and deductions) cannot be more than gross income.'); return false; }
    if (t !== 'Self-employed' && t !== 'Other' && (!fieldValue('employer') || !fieldValue('hr_contact_phone'))) {
      showError("Please give your employer's name and an HR or manager contact number. We call the company switchboard to verify, not only the number you give."); return false;
    }
    if (t === 'Contract' && !fieldValue('contract_end_date')) { showError('Please give your contract end date.'); return false; }
    if (t === 'Self-employed' && !fieldValue('business_name')) { showError('Please give your business name.'); return false; }
  }
  if (n === 4 && $('f-has_surety').checked && (!fieldValue('surety_full_name') || !fieldValue('surety_id_number'))) {
    showError("Please give your surety's full name and ID number, or untick the surety box."); return false;
  }
  if (n === 4 && $('f-adverse_history_declared').checked && !fieldValue('adverse_history_explanation')) {
    showError('Please briefly explain the eviction, judgment or listing.'); return false;
  }
  if (n === 5) {
    const form = collectFormFlags();
    const missing = DOC_CATEGORIES.filter((c) => c.required(form) && !(files[c.key] || []).length).map((c) => c.label);
    if (missing.length) { showError('Please add: ' + missing.join('; ')); return false; }
  }
  return true;
}

/* ---------------- Documents ---------------- */
function collectFormFlags() {
  return { employment_type: fieldValue('employment_type'), has_surety: $('f-has_surety').checked };
}

function renderDocInputs() {
  const flags = collectFormFlags();
  // Drop files from categories that no longer apply (e.g. switched to self-employed).
  DOC_CATEGORIES.forEach((c) => { if (c.hideIf && c.hideIf(flags)) delete files[c.key]; });
  $('docs-list').innerHTML = DOC_CATEGORIES.filter((c) => !(c.hideIf && c.hideIf(flags))).map((c) => `
    <div class="rounded-xl border border-gray-200 p-4">
      <div class="flex items-start justify-between gap-3 mb-2">
        <p class="text-sm font-semibold text-navy">${esc(c.label)}${c.required(flags) ? ' <span class="text-red-600">*</span>' : ''}</p>
      </div>
      <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp" data-doc="${c.key}" class="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-offwhite file:text-navy file:font-semibold hover:file:bg-gray-200">
      <ul class="mt-2 space-y-1 text-xs text-gray-500" data-doc-list="${c.key}"></ul>
    </div>`).join('');
  document.querySelectorAll('[data-doc]').forEach((input) => {
    renderFileList(input.dataset.doc);
    input.addEventListener('change', () => {
      const key = input.dataset.doc;
      const accepted = [];
      for (const f of input.files) {
        if (f.size > MAX_FILE_MB * 1024 * 1024) { showError(`${f.name} is larger than ${MAX_FILE_MB} MB.`); continue; }
        if (f.type && !ALLOWED_TYPES.includes(f.type)) { showError(`${f.name}: please upload PDF, JPG, PNG or HEIC files only.`); continue; }
        accepted.push(f);
      }
      files[key] = [...(files[key] || []), ...accepted].slice(0, 6);
      input.value = '';
      renderFileList(key);
    });
  });
}

function renderFileList(key) {
  const list = document.querySelector(`[data-doc-list="${key}"]`);
  if (!list) return;
  list.innerHTML = (files[key] || []).map((f, i) => `
    <li class="flex items-center justify-between gap-3"><span class="truncate">${esc(f.name)} (${(f.size / 1024 / 1024).toFixed(1)} MB)</span>
    <button type="button" class="text-gray-400 hover:text-red-600" data-remove="${key}:${i}">Remove</button></li>`).join('');
  list.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const [k, i] = b.dataset.remove.split(':');
    files[k].splice(Number(i), 1);
    renderFileList(k);
  }));
}

/* ---------------- Consent ---------------- */
function consentText() {
  return `CONSENT TO PROCESS PERSONAL INFORMATION (version ${CONSENT_VERSION})

Responsible party: Zanka Group (Pty) Ltd, Sandton, Johannesburg. Contact: info@zankagroup.co.za

I consent to Zanka Group (Pty) Ltd and its appointed agents processing my personal information for the sole purpose of assessing my application to rent "${vacancy.title}" (${vacancy.area}), and, if successful, administering the lease.

I specifically consent to Zanka Group:
1. Obtaining my credit report and rental payment history from a registered credit or tenant bureau;
2. Contacting my employer to confirm my employment and income;
3. Contacting my current and previous landlords or agents for a reference;
4. Verifying my identity and the documents I have supplied;
5. If I become a tenant, reporting my rental payment conduct to a registered bureau.

I understand that:
- Providing this information is voluntary, but my application cannot be assessed without it;
- My information will be kept securely, shared only with the parties above, and not used for any other purpose;
- If my application is unsuccessful, my documents will be destroyed within 90 days;
- I may ask to see or correct my information, or object to its processing, by emailing info@zankagroup.co.za;
- I may lodge a complaint with the Information Regulator (inforegulator.org.za).`;
}

function prepareConsent() {
  $('consent-text').textContent = consentText();
  if (!$('c-name').value) $('c-name').value = fieldValue('full_name');
  if (!$('c-id').value) $('c-id').value = fieldValue('id_number');
  if ($('f-has_surety').checked) {
    if (!$('c-surety-name').value) $('c-surety-name').value = fieldValue('surety_full_name');
    if (!$('c-surety-id').value) $('c-surety-id').value = fieldValue('surety_id_number');
  }
}

/* ---------------- Submit ---------------- */
function collectApplication() {
  const n = (id) => { const v = fieldValue(id); return v === '' ? null : v; };
  const occupants = [...document.querySelectorAll('.occupant-row')].map((r) => ({
    name: r.querySelector('.occupant-name').value.trim(),
    age: r.querySelector('.occupant-age').value === '' ? null : Number(r.querySelector('.occupant-age').value),
  })).filter((o) => o.name);
  const hasSurety = $('f-has_surety').checked;
  return {
    full_name: n('full_name'), id_number: fieldValue('id_number').replace(/\s/g, ''), date_of_birth: n('date_of_birth'),
    email: n('email'), phone: n('phone'), current_address: n('current_address'),
    marital_status: n('marital_status'), dependants: n('dependants'), move_in_date: n('move_in_date'), lease_term_months: n('lease_term_months'),
    occupants, occupant_count: occupants.length, pets: n('pets'), vehicles: n('vehicles'),
    employment_type: n('employment_type'), employer: n('employer'), job_title: n('job_title'),
    employment_start_date: n('employment_start_date'), contract_end_date: fieldValue('employment_type') === 'Contract' ? n('contract_end_date') : null,
    hr_contact_name: n('hr_contact_name'), hr_contact_phone: n('hr_contact_phone'), hr_contact_email: n('hr_contact_email'),
    gross_monthly_income: n('gross_monthly_income'), net_monthly_income: n('net_monthly_income'),
    other_monthly_income: n('other_monthly_income'), other_income_source: n('other_income_source'),
    business_name: n('business_name'), business_registration: n('business_registration'), accountant_contact: n('accountant_contact'),
    time_at_current_address: n('time_at_current_address'), current_rent: n('current_rent'),
    current_landlord_name: n('current_landlord_name'), current_landlord_phone: n('current_landlord_phone'), current_landlord_email: n('current_landlord_email'),
    reason_for_moving: n('reason_for_moving'), previous_address: n('previous_address'), previous_landlord_contact: n('previous_landlord_contact'),
    monthly_debt_instalments: n('monthly_debt_instalments'),
    adverse_history_declared: $('f-adverse_history_declared').checked, adverse_history_explanation: n('adverse_history_explanation'),
    emergency_contact_name: n('emergency_contact_name'), emergency_contact_relationship: n('emergency_contact_relationship'), emergency_contact_phone: n('emergency_contact_phone'),
    surety: hasSurety ? {
      full_name: n('surety_full_name'), id_number: n('surety_id_number'), relationship: n('surety_relationship'),
      phone: n('surety_phone'), email: n('surety_email'),
    } : null,
    declaration_accepted: $('c-declaration').checked,
  };
}

function safeName(name) {
  return name.normalize('NFKD').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80) || 'document';
}

function setProgress(text) {
  $('submit-progress').textContent = text;
  $('submit-progress').classList.remove('hidden');
}

async function onSubmit(e) {
  e.preventDefault();
  if (!validateStep(6)) return;
  if (!$('c-consent').checked || !$('c-declaration').checked) { showError('Please tick both boxes to give consent and accept the declaration.'); return; }
  const hasSurety = $('f-has_surety').checked;
  if (hasSurety && (!$('c-surety-name').value.trim() || !$('c-surety-id').value.trim() || !$('c-surety-consent').checked)) {
    showError('Your surety must also consent: enter their full name and ID number and tick their consent box.'); return;
  }

  const btn = $('btn-submit');
  btn.disabled = true; $('btn-back').disabled = true;
  btn.textContent = 'Submitting…';

  try {
    setProgress('Saving your application…');
    const consent = {
      consent_version: CONSENT_VERSION,
      consent_text: consentText(),
      signed_full_name: $('c-name').value.trim(),
      signed_id_number: $('c-id').value.replace(/\s/g, ''),
      user_agent: navigator.userAgent,
      surety: hasSurety ? { signed_full_name: $('c-surety-name').value.trim(), signed_id_number: $('c-surety-id').value.replace(/\s/g, '') } : null,
    };
    // A retry after a failed upload resumes the same application rather
    // than creating a second one (which the duplicate check would refuse).
    if (!uploadSession) {
      const { data, error } = await supabaseClient.rpc('submit_rental_application', {
        p_vacancy_id: vacancy.id, p_application: collectApplication(), p_consent: consent,
      });
      if (error) throw error;
      uploadSession = { created: data, uploaded: new Set() };
    }
    const { created } = uploadSession;

    const all = Object.entries(files).flatMap(([cat, list]) => list.map((f) => ({ cat, f })));
    let done = 0;
    for (const { cat, f } of all) {
      done++;
      if (uploadSession.uploaded.has(f)) continue;
      setProgress(`Uploading documents (${done} of ${all.length}): ${f.name}`);
      const rand = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).slice(0, 8);
      const path = `${created.id}/${cat}/${rand}-${safeName(f.name)}`;
      const { error: upErr } = await supabaseClient.storage.from('rental-applications').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
      if (upErr) throw new Error(`Upload failed for ${f.name}: ${upErr.message}`);
      const { error: regErr } = await supabaseClient.rpc('register_rental_application_document', {
        p_application_id: created.id, p_upload_token: created.upload_token, p_category: cat,
        p_original_filename: f.name, p_storage_path: path, p_size_bytes: f.size,
      });
      if (regErr) throw regErr;
      uploadSession.uploaded.add(f);
    }

    setProgress('Finalising…');
    const { data: finished, error: doneErr } = await supabaseClient.rpc('complete_rental_application', {
      p_application_id: created.id, p_upload_token: created.upload_token,
    });
    if (doneErr) throw doneErr;

    // Send the confirmation email (and the owner's update) now. The
    // database has already queued them, so if this call fails they still
    // go out the next time the queue is processed.
    supabaseClient.functions.invoke('rental-notifications', { body: {} }).catch(() => {});

    $('apply-card').classList.add('hidden');
    $('vacancy-summary').classList.add('hidden');
    $('success-view').classList.remove('hidden');
    $('success-reference').textContent = finished.reference;
    $('success-email').textContent = fieldValue('email');
    $('success-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    showError((err && err.message) || 'Something went wrong. Please try again.');
    $('submit-progress').classList.add('hidden');
    btn.disabled = false; $('btn-back').disabled = false;
    btn.textContent = 'Submit application';
  }
}


/* ---------------- Photos ---------------- */
const PHOTO_BUCKET = 'listing-photos';
const photoUrl = (path) => supabaseClient.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;

function coverImg(v) {
  const photos = v.photos || [];
  if (!photos.length) {
    return `<div class="aspect-[4/3] flex items-center justify-center text-gray-300">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.4"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"/></svg></div>`;
  }
  const more = photos.length > 1 ? `<span class="absolute bottom-3 right-3 pill bg-navy-deep/75 text-white">${photos.length} photos</span>` : '';
  return `<div class="relative"><img src="${esc(photoUrl(photos[0].path))}" alt="${esc(v.title)}" class="w-full aspect-[4/3] object-cover" loading="lazy" decoding="async">${more}</div>`;
}

function renderGallery(v) {
  const photos = v.photos || [];
  if (!photos.length) return;
  const track = $('g-track');
  const n = photos.length;
  track.innerHTML = photos.map((p, i) => `
    <div class="w-full flex-shrink-0 snap-center" role="group" aria-roledescription="slide" aria-label="Photo ${i + 1} of ${n}">
      <img src="${esc(photoUrl(p.path))}" alt="${esc(v.title)}, photo ${i + 1} of ${n}" class="w-full aspect-[4/3] sm:aspect-[16/9] object-cover"
        ${i === 0 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">
    </div>`).join('');
  $('v-gallery').classList.remove('hidden');

  const thumbs = $('g-thumbs');
  if (n > 1) {
    thumbs.innerHTML = photos.map((p, i) => `
      <button type="button" data-go="${i}" class="flex-shrink-0 w-24 rounded-lg overflow-hidden border-2 border-transparent opacity-70 hover:opacity-100 transition" aria-label="Show photo ${i + 1}">
        <img src="${esc(photoUrl(p.path))}" alt="" class="w-full aspect-[4/3] object-cover" loading="lazy" decoding="async">
      </button>`).join('');
    thumbs.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(Number(b.dataset.go))));
  } else {
    thumbs.remove();
    $('g-prev').remove();
    $('g-next').remove();
  }

  const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  function goTo(i) {
    const target = Math.max(0, Math.min(n - 1, i));
    track.scrollTo({ left: target * track.clientWidth, behavior: 'smooth' });
  }
  function update() {
    const i = current();
    $('g-count').textContent = `${i + 1} / ${n}`;
    if ($('g-prev')) { $('g-prev').disabled = i === 0; $('g-next').disabled = i === n - 1; }
    document.querySelectorAll('#g-thumbs [data-go]').forEach((b, k) => {
      b.classList.toggle('border-gold', k === i);
      b.classList.toggle('opacity-100', k === i);
      b.classList.toggle('border-transparent', k !== i);
      b.classList.toggle('opacity-70', k !== i);
    });
  }
  if ($('g-prev')) {
    $('g-prev').addEventListener('click', () => goTo(current() - 1));
    $('g-next').addEventListener('click', () => goTo(current() + 1));
  }
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(current() - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(current() + 1); }
  });
  let t;
  track.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(update, 60); }, { passive: true });
  window.addEventListener('resize', () => goTo(current()));
  update();
}

/* ---------------- Viewings (027_tenancy_lifecycle.sql) ---------------- */
let chosenSlot = null;

function sendTenancyEmails() {
  // Sends the confirmation now instead of waiting for the daily run.
  supabaseClient.functions.invoke('tenancy-automation', { body: { action: 'send' } }).catch(() => {});
}

function slotLabel(s) {
  const d = new Date(s.starts_at);
  return `${d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}, ${d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}`;
}

async function loadViewingSlots() {
  const { data, error } = await supabaseClient.rpc('list_viewing_slots', { p_vacancy_id: vacancy.id });
  if (error || !data || !data.length) return; // no viewings offered: keep the card hidden
  $('viewing-card').classList.remove('hidden');
  // Two cards in the sidebar: the sticky summary would slide over the booking card.
  document.querySelector('#vacancy-summary > div').classList.remove('lg:sticky', 'lg:top-24');
  $('viewing-slots').innerHTML = data.map((s) => `
    <label class="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-4 py-3 cursor-pointer hover:border-gold ${s.spaces_left <= 0 ? 'opacity-50 pointer-events-none' : ''}">
      <span class="flex items-center gap-3"><input type="radio" name="vw-slot" value="${esc(s.id)}" ${s.spaces_left <= 0 ? 'disabled' : ''}>
        <span class="text-sm text-navy font-semibold">${esc(slotLabel(s))}</span></span>
      <span class="text-xs text-gray-500">${s.spaces_left <= 0 ? 'Full' : `${s.spaces_left} space${s.spaces_left === 1 ? '' : 's'}`}</span>
    </label>`).join('');
  document.querySelectorAll('input[name="vw-slot"]').forEach((r) => r.addEventListener('change', () => {
    chosenSlot = data.find((s) => s.id === r.value);
    $('viewing-form').classList.remove('hidden');
  }));
  if (!$('viewing-form').dataset.wired) {
    $('viewing-form').dataset.wired = '1';
    $('viewing-form').addEventListener('submit', bookViewing);
  }
}

async function bookViewing(e) {
  e.preventDefault();
  const err = $('vw-err');
  err.classList.add('hidden');
  const name = $('vw-name').value.trim(), email = $('vw-email').value.trim(), phone = $('vw-phone').value.trim();
  if (!chosenSlot) { err.textContent = 'Choose a viewing time.'; err.classList.remove('hidden'); return; }
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || phone.replace(/\D/g, '').length < 9) {
    err.textContent = 'Please give your name, a valid email address and a phone number.'; err.classList.remove('hidden'); return;
  }
  const btn = e.submitter || $('viewing-form').querySelector('button');
  btn.disabled = true; btn.textContent = 'Booking…';
  const { data, error } = await supabaseClient.rpc('book_viewing', { p_slot_id: chosenSlot.id, p_details: {
    full_name: name, email, phone, occupants: $('vw-occupants').value, move_in_date: $('vw-move').value,
    gross_monthly_income: $('vw-income').value, employment_type: $('vw-employment').value,
  } });
  btn.disabled = false; btn.textContent = 'Book this viewing';
  if (error) { err.textContent = error.message || 'Something went wrong. Please try again.'; err.classList.remove('hidden'); loadViewingSlots(); return; }
  sendTenancyEmails();
  $('viewing-slots').classList.add('hidden');
  $('viewing-form').classList.add('hidden');
  const income = data.meets_income === false
    ? `<p class="mt-3 rounded-lg bg-amber-50 text-amber-800 p-3">Heads up: for this unit we look for a gross household income of at least ${esc(money(data.min_gross_income))} a month. You are welcome to view it; a surety or a co-applicant may help.</p>` : '';
  $('viewing-done').innerHTML = `<p class="rounded-lg bg-green-50 text-green-800 p-3"><strong>You're booked for ${esc(slotLabel(chosenSlot))}.</strong><br>Reference ${esc(data.reference)}. We've emailed the details and the meeting point to ${esc(email)}.</p>${income}`;
  $('viewing-done').classList.remove('hidden');
  // Save them retyping on the application form.
  if ($('f-full_name') && !$('f-full_name').value) $('f-full_name').value = name;
  if ($('f-email') && !$('f-email').value) $('f-email').value = email;
  if ($('f-phone') && !$('f-phone').value) $('f-phone').value = phone;
}

function showCancelViewing(bookingId, token, vacancyId) {
  $('viewing-cancel-view').classList.remove('hidden');
  if (vacancyId) $('vc-keep').href = `apply.html?vacancy=${encodeURIComponent(vacancyId)}`;
  $('vc-confirm').addEventListener('click', async () => {
    $('vc-confirm').disabled = true;
    const { data, error } = await supabaseClient.rpc('cancel_viewing_booking', { p_booking_id: bookingId, p_token: token });
    if (error) {
      $('vc-text').textContent = error.message || 'We could not cancel that booking.';
      $('vc-confirm').classList.add('hidden');
      $('vc-keep').textContent = 'See the unit';
      return;
    }
    sendTenancyEmails();
    $('vc-text').textContent = `Booking ${data.reference} is cancelled. You can book another time on the listing page.`;
    $('vc-confirm').classList.add('hidden');
    $('vc-keep').textContent = 'See other viewing times';
  });
}
