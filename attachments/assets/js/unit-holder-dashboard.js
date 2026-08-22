// Zanka Group — Unit Holder Portal 15h40
// Requires supabase-client.js and auth.js loaded first.
//
// No separate Unit Holder login exists — same shared login as the Owner/
// Investor portals (owner-login.html). Access is governed by actually
// having a unit_holdings or unit_holder_kyc row, not by a profiles.role
// value, same precedent as investor_representatives on the Investor
// Portal. Deliberately a fully separate page/dashboard from
// investor-dashboard.html — "Unit Holder" here is a distinct population
// from "Investor" (a company/trust owning a whole property outright).

let currentHolderProfile = null;

document.addEventListener('DOMContentLoaded', async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'owner-login.html'; return; }

  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile) { await supabaseClient.auth.signOut(); window.location.href = 'owner-login.html'; return; }

  const { data: holdings } = await supabaseClient.from('unit_holdings').select('id').eq('holder_profile_id', profile.id).limit(1);
  const { data: kyc } = await supabaseClient.from('unit_holder_kyc').select('id').eq('profile_id', profile.id).limit(1);
  if ((!holdings || holdings.length === 0) && (!kyc || kyc.length === 0)) {
    // Not actually a Unit Holder (yet) — send back to whichever portal
    // makes sense rather than showing an empty shell.
    window.location.href = profile.role === 'owner' ? 'owner-dashboard.html' : 'index.html';
    return;
  }

  currentHolderProfile = profile;
  document.querySelectorAll('[data-holder-name]').forEach(el => { el.textContent = profile.full_name || profile.email; });

  await handleLogout('owner-login.html');
  await loadKycStatus();
  wireKycSubmitForm();
  await loadHoldings();
  await loadDistributions();
  await loadDocuments();
});

async function loadKycStatus() {
  const banner = document.getElementById('kyc-banner');
  const bannerText = document.getElementById('kyc-banner-text');
  const bannerSubtext = document.getElementById('kyc-banner-subtext');
  const submitCard = document.getElementById('kyc-submit-card');

  const { data: kyc } = await supabaseClient.from('unit_holder_kyc').select('*').eq('profile_id', currentHolderProfile.id).maybeSingle();

  if (!kyc) {
    banner.classList.add('hidden');
    submitCard.classList.remove('hidden');
    return;
  }

  if (kyc.status === 'pending') {
    bannerText.textContent = 'Your KYC documents are under review.';
    bannerSubtext.textContent = 'An admin will approve or reject your submission shortly.';
    banner.classList.remove('hidden');
    submitCard.classList.add('hidden');
  } else if (kyc.status === 'approved') {
    banner.classList.add('hidden');
    submitCard.classList.add('hidden');
  } else if (kyc.status === 'rejected') {
    bannerText.textContent = 'Your KYC submission was not approved.';
    bannerSubtext.textContent = kyc.notes ? `Reason: ${kyc.notes}. Please resubmit below.` : 'Please resubmit your documents below.';
    banner.classList.remove('hidden');
    submitCard.classList.remove('hidden');
  }
}

function wireKycSubmitForm() {
  const form = document.getElementById('kyc-submit-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('kyc-submit-error');
    const successEl = document.getElementById('kyc-submit-success');
    const btn = document.getElementById('kyc-submit-btn');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const idFile = document.getElementById('kyc-id-file').files[0];
    const addressFile = document.getElementById('kyc-address-file').files[0];
    if (!idFile || !addressFile) {
      errorEl.textContent = 'Both documents are required.';
      errorEl.classList.remove('hidden');
      return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + '-01';
      const stamp = Date.now();

      const uploadOne = async (file, category) => {
        const path = `documents/unit-holder-kyc/${currentHolderProfile.id}/${stamp}-${file.name}`;
        const { error: uploadError } = await supabaseClient.storage.from('documents').upload(path, file);
        if (uploadError) throw uploadError;
        const { error: docError } = await supabaseClient.from('documents').insert([{
          category,
          holder_profile_id: currentHolderProfile.id,
          statement_month: monthStart,
          document_date: today,
          original_filename: file.name,
          generated_filename: file.name,
          storage_path: path,
          subtotal: 0, discount: 0, vat: 0, total_amount: 0,
          status: 'Approved',
          uploaded_by: currentHolderProfile.id,
        }]);
        if (docError) throw docError;
      };

      await uploadOne(idFile, 'KYC ID Document');
      await uploadOne(addressFile, 'Proof of Address');

      // upsert-by-hand: a rejected resubmission updates the existing row
      // back to pending rather than violating the unique profile_id constraint.
      const { data: existing } = await supabaseClient.from('unit_holder_kyc').select('id').eq('profile_id', currentHolderProfile.id).maybeSingle();
      if (existing) {
        const { error } = await supabaseClient.from('unit_holder_kyc').update({
          status: 'pending', reviewed_by: null, reviewed_at: null, notes: null,
        }).eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseClient.from('unit_holder_kyc').insert([{
          profile_id: currentHolderProfile.id, status: 'pending',
        }]);
        if (error) throw error;
      }

      successEl.textContent = 'Submitted for review.';
      successEl.classList.remove('hidden');
      form.reset();
      await loadKycStatus();
      await loadDocuments();
    } catch (err) {
      errorEl.textContent = err.message || 'Something went wrong.';
      errorEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

async function loadHoldings() {
  const tbody = document.getElementById('holdings-tbody');
  const { data, error } = await supabaseClient
    .from('unit_holdings')
    .select('units_held, purchase_amount, purchase_date, unit_offerings:offering_id ( total_units, properties:property_id ( address ) )')
    .eq('holder_profile_id', currentHolderProfile.id)
    .eq('status', 'active')
    .order('purchase_date', { ascending: false });

  if (error || !data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-4 px-3 text-sm text-gray-400">No units held yet.</td></tr>';
    document.getElementById('stat-total-units').textContent = '0';
    document.getElementById('stat-total-invested').textContent = 'R0.00';
    document.getElementById('stat-properties-held').textContent = '0';
    return;
  }

  let totalUnits = 0, totalInvested = 0;
  const properties = new Set();

  tbody.innerHTML = data.map(h => {
    totalUnits += h.units_held;
    totalInvested += Number(h.purchase_amount);
    const address = h.unit_offerings?.properties?.address || '—';
    properties.add(address);
    const pct = h.unit_offerings?.total_units ? ((h.units_held / h.unit_offerings.total_units) * 100).toFixed(2) : '—';
    return `
      <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition text-sm">
        <td class="py-3 px-3">${address}</td>
        <td class="py-3 px-3">${h.units_held}</td>
        <td class="py-3 px-3">${pct}%</td>
        <td class="py-3 px-3">R${Number(h.purchase_amount).toLocaleString()}</td>
        <td class="py-3 px-3">${h.purchase_date}</td>
      </tr>`;
  }).join('');

  document.getElementById('stat-total-units').textContent = totalUnits.toLocaleString();
  document.getElementById('stat-total-invested').textContent = 'R' + totalInvested.toLocaleString(undefined, { minimumFractionDigits: 2 });
  document.getElementById('stat-properties-held').textContent = properties.size;
}

async function loadDistributions() {
  const tbody = document.getElementById('distributions-tbody');
  const { data, error } = await supabaseClient
    .from('distribution_payouts')
    .select('units_held_snapshot, amount, status, paid_date, distribution_runs:distribution_run_id ( period_label, unit_offerings:offering_id ( properties:property_id ( address ) ) )')
    .eq('holder_profile_id', currentHolderProfile.id)
    .order('paid_date', { ascending: false, nullsFirst: true });

  if (error || !data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="py-4 px-3 text-sm text-gray-400">No distributions yet.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(p => `
    <tr class="border-b border-gray-100 hover:bg-gray-50/50 transition text-sm">
      <td class="py-3 px-3">${p.distribution_runs?.unit_offerings?.properties?.address || '—'}</td>
      <td class="py-3 px-3">${p.distribution_runs?.period_label || '—'}</td>
      <td class="py-3 px-3">${p.units_held_snapshot}</td>
      <td class="py-3 px-3">R${Number(p.amount).toLocaleString()}</td>
      <td class="py-3 px-3"><span class="text-xs font-semibold px-2.5 py-0.5 rounded-full ${p.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${p.status}</span></td>
      <td class="py-3 px-3">${p.paid_date || '—'}</td>
    </tr>`).join('');
}

async function loadDocuments() {
  const container = document.getElementById('documents-list');
  const emptyEl = document.getElementById('documents-empty');
  const { data, error } = await supabaseClient
    .from('documents')
    .select('id, category, original_filename, storage_path, created_at')
    .eq('holder_profile_id', currentHolderProfile.id)
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) {
    container.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  container.innerHTML = data.map(d => `
    <div class="flex items-center justify-between border-b border-gray-100 py-2.5">
      <div>
        <p class="text-sm font-semibold text-navy">${d.category}</p>
        <p class="text-xs text-gray-400">${d.original_filename} &middot; ${new Date(d.created_at).toLocaleDateString('en-ZA')}</p>
      </div>
      <button data-doc-download="${d.id}" data-doc-path="${d.storage_path}" class="text-sm font-semibold text-gold hover:text-gold-light transition">Download &rarr;</button>
    </div>`).join('');

  wireDocDownloadButtons(container);
}

// Same proven pattern used on tenant-dashboard.js / investor-dashboard.js —
// storage_path is a raw private-bucket path, never usable as a direct
// href. window.open('', '_blank') runs synchronously on the click to
// survive mobile Safari's popup-blocker timing before the async
// createSignedUrl call resolves.
function wireDocDownloadButtons(container) {
  if (!container) return;
  container.querySelectorAll('[data-doc-download]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newTab = window.open('', '_blank');
      const { data, error } = await supabaseClient
        .storage.from('documents').createSignedUrl(btn.dataset.docPath, 300);
      if (error) { if (newTab) newTab.close(); alert('Could not open file: ' + error.message); return; }
      if (newTab) newTab.location.href = data.signedUrl;
      else window.location.href = data.signedUrl;
    });
  });
}
