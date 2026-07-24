// Zanka Group — Inspection History & Detail Viewer
// Requires supabase-client.js and auth.js loaded first.
// Reachable by admin, partner, owner, and tenant — RLS scopes what
// each of them actually sees; this page doesn't filter by role itself.

let historyCurrentUser = null;
let currentInspection = null;

document.addEventListener('DOMContentLoaded', async () => {
  historyCurrentUser = await requireAnySession(['admin', 'partner', 'owner', 'tenant']);
  if (!historyCurrentUser) return;

  if (['admin', 'partner'].includes(historyCurrentUser.role)) {
    document.getElementById('new-inspection-link').classList.remove('hidden');
  }

  // Tenants/owners land here from a link on their own dashboard, not
  // from browsing a list — "Back to History" isn't meaningful for
  // them (RLS would only ever show their own 1-2 inspections anyway),
  // and they had no way back to their actual dashboard at all before.
  const dashboardByRole = { admin: 'admin-dashboard.html', partner: 'partner-dashboard.html', owner: 'owner-dashboard.html', tenant: 'tenant-dashboard.html' };
  const backToDashboard = document.getElementById('back-to-dashboard');
  backToDashboard.href = dashboardByRole[historyCurrentUser.role] || 'index.html';

  const backToList = document.getElementById('back-to-list');
  if (['owner', 'tenant'].includes(historyCurrentUser.role)) {
    backToList.classList.add('hidden');
  } else {
    backToList.addEventListener('click', showListView);
  }

  const params = new URLSearchParams(window.location.search);
  const inspectionId = params.get('id');
  if (inspectionId) {
    await loadDetail(inspectionId);
  } else {
    await loadList();
  }
});

async function requireAnySession(allowedRoles) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'tenant-login.html'; return null; }
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (error || !profile || !allowedRoles.includes(profile.role)) {
    await supabaseClient.auth.signOut();
    window.location.href = 'tenant-login.html';
    return null;
  }
  return profile;
}

/* ---------------- List view ---------------- */
async function loadList() {
  const { data: inspections, error } = await supabaseClient
    .from('lease_inspections')
    .select('*, properties ( address )')
    .order('inspection_date', { ascending: false });

  const tbody = document.getElementById('inspections-tbody');
  if (error) { tbody.innerHTML = `<tr><td colspan="6" class="py-4 text-sm text-red-500 text-center">${error.message}</td></tr>`; return; }

  if (!inspections || inspections.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-4 text-sm text-gray-400 text-center">No inspections recorded yet.</td></tr>`;
    return;
  }

  const typeLabels = { Move_In: 'Move-In', Routine: 'Routine', Move_Out: 'Move-Out' };
  tbody.innerHTML = inspections.map(i => {
    const signedCount = [i.inspector_signed_at, i.tenant_signed_at, i.owner_signed_at].filter(Boolean).length;
    return `
      <tr class="border-b border-gray-100 text-sm hover:bg-offwhite cursor-pointer" data-inspection-row="${i.id}">
        <td class="py-3 px-3 text-navy font-medium">${i.properties?.address || '—'}</td>
        <td class="py-3 px-3 text-gray-600">${typeLabels[i.inspection_type] || i.inspection_type}</td>
        <td class="py-3 px-3 text-gray-600">${new Date(i.inspection_date).toLocaleDateString()}</td>
        <td class="py-3 px-3 text-gray-600">${i.overall_condition || '—'}</td>
        <td class="py-3 px-3 text-gray-600">${signedCount}/3 signed</td>
        <td class="py-3 px-3"><span class="learn-more text-xs">View &rarr;</span></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-inspection-row]').forEach(row => {
    row.addEventListener('click', () => {
      window.history.pushState({}, '', `inspection-history.html?id=${row.dataset.inspectionRow}`);
      loadDetail(row.dataset.inspectionRow);
    });
  });
}

function showListView() {
  window.history.pushState({}, '', 'inspection-history.html');
  document.getElementById('detail-view').classList.add('hidden');
  document.getElementById('list-view').classList.remove('hidden');
  loadList();
}

/* ---------------- Detail view ---------------- */
async function loadDetail(inspectionId) {
  const { data: inspection, error } = await supabaseClient
    .from('lease_inspections')
    .select('*, properties ( address )')
    .eq('id', inspectionId)
    .single();

  if (error || !inspection) {
    alert('Could not load this inspection: ' + (error?.message || 'not found'));
    showListView();
    return;
  }
  currentInspection = inspection;

  document.getElementById('list-view').classList.add('hidden');
  document.getElementById('detail-view').classList.remove('hidden');

  const typeLabels = { Move_In: 'Move-In Inspection', Routine: 'Routine Inspection', Move_Out: 'Move-Out Inspection' };
  document.getElementById('detail-type').textContent = typeLabels[inspection.inspection_type] || inspection.inspection_type;
  document.getElementById('detail-address').textContent = inspection.properties?.address || 'Inspection';
  document.getElementById('detail-date').textContent = new Date(inspection.inspection_date).toLocaleDateString();
  document.getElementById('detail-condition').textContent = inspection.overall_condition || '—';
  document.getElementById('detail-action').textContent = (inspection.recommended_action || '').replace(/_/g, ' ') || '—';
  document.getElementById('detail-comments').textContent = inspection.comments || '';

  const statusEl = document.getElementById('detail-status');
  statusEl.textContent = inspection.status;
  statusEl.className = 'text-xs font-semibold px-3 py-1 rounded-full ' +
    (inspection.status === 'Completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700');

  await loadRoomsAndPhotos(inspectionId);
  renderSignatureStatus(inspection);
  await maybeShowSignHere(inspection);

  const downloadBtn = document.getElementById('download-report-btn');
  if (downloadBtn) downloadBtn.onclick = () => downloadInspectionReport(inspection);
}

// This is the actual fix for "doesn't load the pictures" — the create
// flow never had a way to look back at what was submitted. This
// queries the real room items and their photos, generating a signed
// URL per photo since the bucket is private (same pattern used
// everywhere else in this build).
async function loadRoomsAndPhotos(inspectionId) {
  const { data: items, error } = await supabaseClient
    .from('inspection_room_items')
    .select('*, inspection_photos ( id, storage_path, caption )')
    .eq('inspection_id', inspectionId)
    .order('room_order', { ascending: true })
    .order('item_order', { ascending: true });

  const container = document.getElementById('detail-rooms');
  if (error) { container.innerHTML = `<p class="text-sm text-red-500">${error.message}</p>`; return; }
  if (!items || items.length === 0) { container.innerHTML = `<p class="text-sm text-gray-400">No room detail recorded.</p>`; return; }

  // Batch EVERY photo across the whole inspection into a single
  // createSignedUrls() call, instead of one createSignedUrl() call
  // per photo. This was the main cause of slow loads on inspections
  // with several photos — 20+ photos meant 20+ separate network
  // round-trips before, now it's exactly one regardless of count.
  const allPaths = items.flatMap(item => (item.inspection_photos || []).map(p => p.storage_path));
  const urlMap = {};
  if (allPaths.length > 0) {
    const { data: signedUrls, error: urlError } = await supabaseClient.storage.from('documents').createSignedUrls(allPaths, 300);
    if (!urlError && signedUrls) {
      signedUrls.forEach(u => { if (u.signedUrl) urlMap[u.path] = u.signedUrl; });
    }
  }

  // Group flat item rows back into rooms for display.
  const rooms = {};
  items.forEach(item => {
    if (!rooms[item.room_name]) rooms[item.room_name] = [];
    rooms[item.room_name].push(item);
  });

  const roomCards = Object.entries(rooms).map(([roomName, roomItems]) => {
    const itemsHtml = roomItems.map((item) => {
      let valueHtml = '';
      if (item.item_type === 'Rating') valueHtml = `<span class="font-semibold text-navy">${item.rating_value || '—'}</span>`;
      else if (item.item_type === 'Yes_No') valueHtml = `<span class="font-semibold text-navy">${item.yes_no_value === true ? 'Yes' : item.yes_no_value === false ? 'No' : '—'}</span>`;
      else if (item.item_type === 'Text') valueHtml = `<span class="text-gray-600">${item.text_value || '—'}</span>`;
      else if (item.item_type === 'Photo') {
        const photos = item.inspection_photos || [];
        if (photos.length === 0) return `<div class="flex items-center justify-between text-sm py-1"><span class="text-gray-500">${item.item_name}</span><span class="text-gray-400 text-xs">No photos</span></div>`;
        const thumbs = photos.map((p) => {
          const url = urlMap[p.storage_path];
          return url
            ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="w-16 h-16 object-cover rounded-lg border border-gray-200" loading="lazy"></a>`
            : '';
        });
        return `<div class="py-1"><span class="text-gray-500 text-sm block mb-2">${item.item_name}</span><div class="flex flex-wrap gap-2">${thumbs.join('')}</div></div>`;
      }
      return `<div class="flex items-center justify-between text-sm py-1"><span class="text-gray-500">${item.item_name}</span>${valueHtml}</div>`;
    });

    return `
      <div class="room-detail-card border border-gray-200 rounded-xl p-4 bg-white">
        <h3 class="font-semibold text-navy text-sm mb-3">${roomName}</h3>
        <div class="space-y-1">${itemsHtml.join('')}</div>
      </div>`;
  });

  container.innerHTML = roomCards.join('');
}

function renderSignatureStatus(inspection) {
  const parties = [
    { label: 'Inspector', signedAt: inspection.inspector_signed_at, name: inspection.inspector_signature_name },
    { label: 'Tenant', signedAt: inspection.tenant_signed_at, name: inspection.tenant_signature_name },
    { label: 'Owner', signedAt: inspection.owner_signed_at, name: inspection.owner_signature_name },
  ];

  document.getElementById('signature-status-list').innerHTML = parties.map(p => `
    <div class="flex items-center justify-between text-sm py-2 border-b border-gray-50 last:border-0">
      <span class="text-gray-600">${p.label}</span>
      ${p.signedAt
        ? `<span class="text-green-700 font-medium">Signed by ${p.name || 'them'} on ${new Date(p.signedAt).toLocaleDateString()}</span>`
        : `<span class="text-gray-400 italic">Not yet signed</span>`}
    </div>
  `).join('');
}

async function maybeShowSignHere(inspection) {
  const role = historyCurrentUser.role;

  // Admin/partner: show the Request Signatures trigger, one button
  // per party not yet signed.
  if (['admin', 'partner'].includes(role)) {
    wireRequestSignaturesPanel(inspection);
    return;
  }

  let alreadySigned = false;
  let signRole = null;
  let otpCode = null;
  let otpExpiresAt = null;

  if (role === 'tenant' && inspection.lease_id) {
    const { data: lease } = await supabaseClient.from('leases').select('tenant_id').eq('id', inspection.lease_id).single();
    if (lease?.tenant_id === historyCurrentUser.id) {
      signRole = 'tenant';
      alreadySigned = !!inspection.tenant_signed_at;
      otpCode = inspection.tenant_otp_code;
      otpExpiresAt = inspection.tenant_otp_expires_at;
    }
  } else if (role === 'owner') {
    const { data: property } = await supabaseClient.from('properties').select('owner_id').eq('id', inspection.property_id).single();
    if (property?.owner_id === historyCurrentUser.id) {
      signRole = 'owner';
      alreadySigned = !!inspection.owner_signed_at;
      otpCode = inspection.owner_otp_code;
      otpExpiresAt = inspection.owner_otp_expires_at;
    }
  }

  if (!signRole || alreadySigned) return;

  if (!otpCode) {
    // No signature request has been issued yet. Previously this showed
    // nothing at all, leaving the tenant/owner with no explanation for
    // why they couldn't sign despite the list saying "Needs your
    // signature" — show a clear waiting message instead.
    const waitingEl = document.getElementById('sign-waiting-message');
    if (waitingEl) waitingEl.classList.remove('hidden');
    return;
  }

  document.getElementById('sign-otp-panel').classList.remove('hidden');
  wireOtpVerification(signRole, otpCode, otpExpiresAt);
}

/* ---------------- Admin: request an OTP-verified signature ---------------- */
function wireRequestSignaturesPanel(inspection) {
  const panel = document.getElementById('request-signatures-panel');
  panel.classList.remove('hidden');

  const tenantBtn = document.getElementById('request-tenant-signature');
  const ownerBtn = document.getElementById('request-owner-signature');
  tenantBtn.classList.toggle('hidden', !inspection.lease_id || !!inspection.tenant_signed_at);
  ownerBtn.classList.toggle('hidden', !!inspection.owner_signed_at);

  tenantBtn.addEventListener('click', () => sendInspectionSignatureRequest('tenant'));
  ownerBtn.addEventListener('click', () => sendInspectionSignatureRequest('owner'));
}

async function sendInspectionSignatureRequest(role) {
  const note = document.getElementById('request-signatures-note');
  note.classList.add('hidden');

  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ inspection_event: 'inspection_signature_request', inspection_id: currentInspection.id, recipient_role: role }),
    });
    if (!res.ok) throw new Error(await res.text());
    note.textContent = `Verification code sent to the ${role}.`;
    note.className = 'text-sm mt-3 text-green-700';
    note.classList.remove('hidden');
  } catch (err) {
    note.textContent = 'Could not send request: ' + err.message;
    note.className = 'text-sm mt-3 text-red-600';
    note.classList.remove('hidden');
  }
}

/* ---------------- Tenant/Owner: verify OTP, then unlock the canvas ---------------- */
function wireOtpVerification(signRole, otpCode, otpExpiresAt) {
  document.getElementById('sign-otp-verify').addEventListener('click', () => {
    const errorEl = document.getElementById('sign-otp-error');
    errorEl.classList.add('hidden');

    const entered = document.getElementById('sign-otp-input').value.trim();
    if (new Date(otpExpiresAt) < new Date()) {
      errorEl.textContent = 'This code has expired. Ask for a new signature request.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (entered !== otpCode) {
      errorEl.textContent = 'Incorrect code. Please try again.';
      errorEl.classList.remove('hidden');
      return;
    }

    document.getElementById('sign-otp-panel').classList.add('hidden');
    document.getElementById('sign-here-panel').classList.remove('hidden');
    document.getElementById('sign-full-name').value = historyCurrentUser.full_name || '';
    wireSignCanvas(signRole);
  });
}

function wireSignCanvas(signRole) {
  const canvas = document.getElementById('sign-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  ctx.strokeStyle = '#1F2A44';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  let drawing = false;
  let hasDrawn = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }
  function start(e) { drawing = true; hasDrawn = true; const pos = getPos(e); ctx.beginPath(); ctx.moveTo(pos.x, pos.y); e.preventDefault(); }
  function move(e) { if (!drawing) return; const pos = getPos(e); ctx.lineTo(pos.x, pos.y); ctx.stroke(); e.preventDefault(); }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  document.getElementById('sign-clear').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn = false;
  });

  document.getElementById('sign-submit').addEventListener('click', async () => {
    const errorEl = document.getElementById('sign-error');
    errorEl.classList.add('hidden');

    const fullName = document.getElementById('sign-full-name').value.trim();
    const consent = document.getElementById('sign-consent').checked;
    if (!fullName) { errorEl.textContent = 'Enter your full name.'; errorEl.classList.remove('hidden'); return; }
    if (!hasDrawn) { errorEl.textContent = 'Draw your signature above.'; errorEl.classList.remove('hidden'); return; }
    if (!consent) { errorEl.textContent = 'You must confirm the consent checkbox.'; errorEl.classList.remove('hidden'); return; }

    const submitBtn = document.getElementById('sign-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing…';

    try {
      const dataUrl = canvas.toDataURL('image/png');
      const blob = await (await fetch(dataUrl)).blob();
      const signaturePath = `documents/inspections/${currentInspection.id}/${signRole}-signature.png`;
      await uploadHistoryFile(blob, signaturePath, 'image/png');

      const signedAt = new Date().toISOString();
      const hash = await computeSignatureHash(dataUrl + fullName + signedAt);

      const updatePayload = signRole === 'tenant'
        ? { tenant_signed_at: signedAt, tenant_signature_name: fullName, tenant_signature_path: signaturePath, tenant_signature_hash: hash }
        : { owner_signed_at: signedAt, owner_signature_name: fullName, owner_signature_path: signaturePath, owner_signature_hash: hash };

      const { error } = await supabaseClient.from('lease_inspections').update(updatePayload).eq('id', currentInspection.id);
      if (error) throw error;

      document.getElementById('sign-here-panel').classList.add('hidden');
      await loadDetail(currentInspection.id);
    } catch (err) {
      errorEl.textContent = err.message || 'Something went wrong.';
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign Inspection';
    }
  });
}

function uploadHistoryFile(blob, path, contentType) {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Session expired — log in again.'));
    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Upload failed: ' + xhr.responseText));
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(blob);
  });
}

async function computeSignatureHash(text) {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Download Report ----------------
   Nothing previously let anyone save/share an inspection as a
   standalone file — the only way to see it was logging in and
   navigating here. Builds a self-contained snapshot with long-lived
   (10-year) photo links, since the normal in-app viewing links only
   last 5 minutes and would go dead almost immediately in a downloaded
   file. */
async function downloadInspectionReport(inspection) {
  const btn = document.getElementById('download-report-btn');
  btn.disabled = true;
  btn.textContent = 'Preparing…';

  try {
    const { data: items } = await supabaseClient
      .from('inspection_room_items')
      .select('*, inspection_photos ( id, storage_path, caption )')
      .eq('inspection_id', inspection.id)
      .order('room_order', { ascending: true })
      .order('item_order', { ascending: true });

    const allPaths = (items || []).flatMap(item => (item.inspection_photos || []).map(p => p.storage_path));
    const urlMap = {};
    if (allPaths.length > 0) {
      const { data: signedUrls } = await supabaseClient.storage.from('documents')
        .createSignedUrls(allPaths, 60 * 60 * 24 * 365 * 10); // 10 years, not the normal 5-minute viewing link
      (signedUrls || []).forEach(u => { if (u.signedUrl) urlMap[u.path] = u.signedUrl; });
    }

    const rooms = {};
    (items || []).forEach(item => {
      if (!rooms[item.room_name]) rooms[item.room_name] = [];
      rooms[item.room_name].push(item);
    });

    const typeLabels = { Move_In: 'Move-In Inspection', Routine: 'Routine Inspection', Move_Out: 'Move-Out Inspection' };
    const roomsHtml = Object.entries(rooms).map(([roomName, roomItems]) => {
      const itemsHtml = roomItems.map(item => {
        let valueHtml = '—';
        if (item.item_type === 'Rating') valueHtml = item.rating_value || '—';
        else if (item.item_type === 'Yes_No') valueHtml = item.yes_no_value === true ? 'Yes' : item.yes_no_value === false ? 'No' : '—';
        else if (item.item_type === 'Text') valueHtml = item.text_value || '—';
        else if (item.item_type === 'Photo') {
          const photos = (item.inspection_photos || []).map(p => urlMap[p.storage_path]).filter(Boolean);
          valueHtml = photos.length
            ? photos.map(url => `<img src="${url}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;margin-right:6px;">`).join('')
            : 'No photos';
        }
        return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F4F4F4;"><span style="color:#8A90A0;">${item.item_name}</span><span style="text-align:right;">${valueHtml}</span></div>`;
      }).join('');
      return `<div style="border:1px solid #E4E6EC;border-radius:10px;padding:16px;margin-bottom:14px;"><p style="font-weight:700;color:#1F2A44;margin:0 0 10px 0;">${roomName}</p>${itemsHtml}</div>`;
    }).join('');

    const signersHtml = [
      { label: 'Inspector', signedAt: inspection.inspector_signed_at, name: inspection.inspector_signature_name },
      { label: 'Tenant', signedAt: inspection.tenant_signed_at, name: inspection.tenant_signature_name },
      { label: 'Owner', signedAt: inspection.owner_signed_at, name: inspection.owner_signature_name },
    ].map(s => `<p style="margin:4px 0;font-size:13px;"><strong>${s.label}:</strong> ${s.signedAt ? `Signed by ${s.name || 'them'} on ${new Date(s.signedAt).toLocaleString()}` : 'Not signed'}</p>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Inspection Report — ${inspection.properties?.address || ''}</title>
<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:0 24px;color:#20242E;line-height:1.6;}
.header{background:#141C30;color:#fff;padding:24px;border-radius:8px;margin-bottom:24px;}
.header p{margin:0;}</style></head>
<body>
  <div class="header">
    <p style="font-size:11px;letter-spacing:0.2em;color:#C89B3C;text-transform:uppercase;">Zanka Group</p>
    <p style="font-size:22px;font-weight:700;">${typeLabels[inspection.inspection_type] || inspection.inspection_type}</p>
    <p style="font-size:14px;margin-top:6px;">${inspection.properties?.address || ''} &middot; ${new Date(inspection.inspection_date).toLocaleDateString()}</p>
  </div>
  <p><strong>Overall Condition:</strong> ${inspection.overall_condition || '—'} &nbsp; <strong>Recommended Action:</strong> ${(inspection.recommended_action || '').replace(/_/g, ' ') || '—'}</p>
  ${inspection.comments ? `<p>${inspection.comments}</p>` : ''}
  <h3 style="margin-top:24px;">Room-by-Room Detail</h3>
  ${roomsHtml}
  <h3 style="margin-top:24px;">Signatures</h3>
  ${signersHtml}
  <p style="font-size:11px;color:#9AA0AE;margin-top:32px;">Zanka Group (Pty) Ltd &middot; Sandton, Johannesburg, South Africa &middot; zankagroup.co.za</p>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspection-${inspection.id}.html`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Could not prepare the report: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download Report';
  }
}
