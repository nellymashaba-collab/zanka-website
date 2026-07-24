// Zanka Group — Property Inspection Module
// Requires supabase-client.js and auth.js loaded first.
//
// Real, Supabase-backed inspections — not the offline/localStorage
// version. Photos and the signature image both upload to the existing
// private 'documents' bucket. Nothing here is saved until "Complete &
// Submit Inspection" — before that, everything lives in `state` below,
// in memory, same as a normal in-progress form.

let inspCurrentUser = null;
let nextLocalId = 1;

const DEFAULT_ROOMS = ['Kitchen', 'Bedrooms', 'Bathrooms', 'Garage', 'Garden', 'Roof', 'Walls', 'Windows', 'Lighting', 'Plumbing', 'Electrical'];

function freshDefaultItems() {
  return [
    { id: nextLocalId++, name: 'Condition', type: 'Rating', value: {} },
    { id: nextLocalId++, name: 'Notes', type: 'Text', value: {} },
    { id: nextLocalId++, name: 'Photos', type: 'Photo', value: { files: [] } },
  ];
}

function freshDefaultRooms() {
  return DEFAULT_ROOMS.map((name, i) => ({ id: nextLocalId++, name, order: i, collapsed: false, items: freshDefaultItems() }));
}

let state = {
  type: null,
  propertyId: null,
  leaseId: null,
  rooms: freshDefaultRooms(),
  signature: { signed: false, dataUrl: null, fullName: '', title: '', signedAt: null },
};

document.addEventListener('DOMContentLoaded', async () => {
  // Both admins and partners conduct inspections per the spec's persona
  // list — accept either, same multi-role pattern as lease-sign.js.
  inspCurrentUser = await requireEitherSession(['admin', 'partner']);
  if (!inspCurrentUser) return;

  document.getElementById('insp-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('insp-inspector-name').value = inspCurrentUser.full_name || '';
  document.getElementById('signature-full-name').value = inspCurrentUser.full_name || '';

  await populateInspectionSelects();
  wireTypeSelector();
  wireRoomControls();
  wireSignatureCanvas();
  wireSubmit();
  renderRooms();
  updateProgress();
});

async function requireEitherSession(allowedRoles) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'admin-login.html'; return null; }
  const { data: profile, error } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (error || !profile || !allowedRoles.includes(profile.role)) {
    await supabaseClient.auth.signOut();
    window.location.href = 'admin-login.html';
    return null;
  }
  return profile;
}

/* ---------------- Property / lease selects ---------------- */
async function populateInspectionSelects() {
  const { data: properties } = await supabaseClient.from('properties').select('id, address').order('address');
  const propSelect = document.getElementById('insp-property');
  propSelect.innerHTML = '<option value="">Select a property</option>' +
    (properties || []).map(p => `<option value="${p.id}">${p.address}</option>`).join('');

  const leaseSelect = document.getElementById('insp-lease');
  leaseSelect.innerHTML = '<option value="">No lease (vacant unit)</option>';

  propSelect.addEventListener('change', async () => {
    state.propertyId = propSelect.value;
    if (!propSelect.value) { leaseSelect.innerHTML = '<option value="">No lease (vacant unit)</option>'; return; }
    const { data: leases } = await supabaseClient
      .from('leases').select('id, tenant:tenant_id ( full_name )').eq('property_id', propSelect.value).order('start_date', { ascending: false });
    leaseSelect.innerHTML = '<option value="">No lease (vacant unit)</option>' +
      (leases || []).map(l => `<option value="${l.id}">${l.tenant?.full_name || 'Lease #' + l.id}</option>`).join('');
  });
  leaseSelect.addEventListener('change', () => { state.leaseId = leaseSelect.value || null; });
}

function wireTypeSelector() {
  document.querySelectorAll('.type-badge').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-badge').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.type = btn.dataset.type;
      updateProgress();
    });
  });
}

/* ---------------- Room management ---------------- */
function wireRoomControls() {
  document.getElementById('add-room').addEventListener('click', () => {
    state.rooms.push({ id: nextLocalId++, name: 'New Room', order: state.rooms.length, collapsed: false, items: freshDefaultItems() });
    renderRooms();
  });
  document.getElementById('reset-default-rooms').addEventListener('click', () => {
    if (!confirm('Reset to the 11 default rooms? This removes any custom rooms and their data.')) return;
    state.rooms = freshDefaultRooms();
    renderRooms();
  });
  document.getElementById('expand-all').addEventListener('click', () => { state.rooms.forEach(r => r.collapsed = false); renderRooms(); });
  document.getElementById('collapse-all').addEventListener('click', () => { state.rooms.forEach(r => r.collapsed = true); renderRooms(); });
  document.getElementById('room-search').addEventListener('input', renderRooms);
}

function renderRooms() {
  const container = document.getElementById('rooms-container');
  const search = document.getElementById('room-search').value.toLowerCase();
  container.innerHTML = '';

  state.rooms
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter(r => !search || r.name.toLowerCase().includes(search))
    .forEach(room => container.appendChild(buildRoomCard(room)));

  wireDragReorder();
  updateProgress();
}

function buildRoomCard(room) {
  const template = document.getElementById('room-card-template');
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.room-card');
  card.dataset.roomId = room.id;

  const nameInput = card.querySelector('.room-name-input');
  nameInput.value = room.name;
  nameInput.addEventListener('input', () => { room.name = nameInput.value; });

  const content = card.querySelector('.room-content');
  content.classList.toggle('hidden', room.collapsed);
  card.querySelector('.room-collapse-toggle').addEventListener('click', () => {
    room.collapsed = !room.collapsed;
    renderRooms();
  });

  card.querySelector('.room-duplicate').addEventListener('click', () => {
    const clone = {
      id: nextLocalId++, name: room.name + ' (copy)', order: state.rooms.length, collapsed: false,
      items: room.items.map(i => ({ ...i, id: nextLocalId++, value: JSON.parse(JSON.stringify(i.value)) })),
    };
    state.rooms.push(clone);
    renderRooms();
  });

  card.querySelector('.room-delete').addEventListener('click', () => {
    if (!confirm(`Delete "${room.name}" and all its data?`)) return;
    state.rooms = state.rooms.filter(r => r.id !== room.id);
    renderRooms();
  });

  const itemsContainer = card.querySelector('.room-items');
  room.items.forEach(item => itemsContainer.appendChild(buildItemRow(room, item)));

  card.querySelector('.room-add-item').addEventListener('click', () => {
    const picker = document.getElementById('new-item-type-picker-template').content.cloneNode(true);
    const row = picker.querySelector('.item-row');
    itemsContainer.appendChild(row);
    row.querySelector('.new-item-confirm').addEventListener('click', () => {
      const name = row.querySelector('.new-item-name').value.trim() || 'New Item';
      const type = row.querySelector('.new-item-type').value;
      const newItem = { id: nextLocalId++, name, type, value: type === 'Photo' ? { files: [] } : {} };
      room.items.push(newItem);
      renderRooms();
    });
  });

  const statusBadge = card.querySelector('.room-status-badge');
  const filled = room.items.filter(itemHasValue).length;
  const pct = room.items.length ? filled / room.items.length : 0;
  statusBadge.textContent = pct === 1 ? 'Complete' : pct > 0 ? 'Partial' : 'Incomplete';
  statusBadge.className = 'room-status-badge text-xs font-semibold px-2.5 py-1 rounded-full ' +
    (pct === 1 ? 'bg-green-100 text-green-700' : pct > 0 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500');

  return node;
}

function itemHasValue(item) {
  if (item.type === 'Rating') return !!item.value.rating;
  if (item.type === 'Yes_No') return item.value.yesNo !== undefined && item.value.yesNo !== null && item.value.yesNo !== '';
  if (item.type === 'Text') return !!item.value.text;
  if (item.type === 'Photo') return (item.value.files || []).length > 0;
  return false;
}

function buildItemRow(room, item) {
  const templateId = { Rating: 'item-rating-template', Yes_No: 'item-yesno-template', Text: 'item-text-template', Photo: 'item-photo-template' }[item.type];
  const node = document.getElementById(templateId).content.cloneNode(true);
  const row = node.querySelector('.item-row');

  const nameInput = row.querySelector('.item-name-input');
  nameInput.value = item.name;
  nameInput.addEventListener('input', () => { item.name = nameInput.value; });

  if (item.type === 'Rating') {
    const select = row.querySelector('.item-rating-select');
    select.value = item.value.rating || '';
    select.addEventListener('change', () => { item.value.rating = select.value; renderRooms(); });
  } else if (item.type === 'Yes_No') {
    const select = row.querySelector('.item-yesno-select');
    select.value = item.value.yesNo === true ? 'true' : item.value.yesNo === false ? 'false' : '';
    select.addEventListener('change', () => { item.value.yesNo = select.value === '' ? null : select.value === 'true'; renderRooms(); });
  } else if (item.type === 'Text') {
    const textarea = row.querySelector('.item-text-input');
    textarea.value = item.value.text || '';
    textarea.addEventListener('input', () => { item.value.text = textarea.value; });
  } else if (item.type === 'Photo') {
    const fileInput = row.querySelector('.item-photo-input');
    const previews = row.querySelector('.item-photo-previews');
    item.value.files = item.value.files || [];
    fileInput.addEventListener('change', (e) => {
      Array.from(e.target.files).forEach(file => {
        item.value.files.push(file);
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.className = 'w-10 h-10 object-cover rounded';
          previews.appendChild(img);
        };
        reader.readAsDataURL(file);
      });
      renderRooms();
    });
  }

  row.querySelector('.item-delete').addEventListener('click', () => {
    room.items = room.items.filter(i => i.id !== item.id);
    renderRooms();
  });

  return node;
}

/* ---------------- Drag-and-drop room reordering ---------------- */
function wireDragReorder() {
  const container = document.getElementById('rooms-container');
  let draggedId = null;

  container.querySelectorAll('.room-card').forEach(card => {
    card.addEventListener('dragstart', () => { draggedId = Number(card.dataset.roomId); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = Number(card.dataset.roomId);
      if (draggedId === null || draggedId === targetId) return;
      const draggedRoom = state.rooms.find(r => r.id === draggedId);
      const targetIndex = state.rooms.findIndex(r => r.id === targetId);
      state.rooms = state.rooms.filter(r => r.id !== draggedId);
      state.rooms.splice(targetIndex, 0, draggedRoom);
      state.rooms.forEach((r, i) => { r.order = i; });
      renderRooms();
    });
  });
}

/* ---------------- Signature canvas (mouse + touch) ---------------- */
function wireSignatureCanvas() {
  const canvas = document.getElementById('signature-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  ctx.strokeStyle = '#1F2A44';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  let drawing = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const point = e.touches ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  }

  function start(e) {
    if (state.signature.signed) return;
    drawing = true;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    e.preventDefault();
  }
  function move(e) {
    if (!drawing || state.signature.signed) return;
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    e.preventDefault();
  }
  function end() { drawing = false; }

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);

  document.getElementById('signature-clear').addEventListener('click', () => {
    if (state.signature.signed) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  document.getElementById('signature-sign').addEventListener('click', async () => {
    const fullName = document.getElementById('signature-full-name').value.trim();
    if (!fullName) { alert('Enter your full name before signing.'); return; }

    state.signature.dataUrl = canvas.toDataURL('image/png');
    state.signature.fullName = fullName;
    state.signature.title = document.getElementById('signature-title').value.trim();
    state.signature.signedAt = new Date().toISOString();
    state.signature.signed = true;

    document.getElementById('signature-date-display').textContent = `Signed ${new Date(state.signature.signedAt).toLocaleString()}`;
    updateProgress();
  });
}

/* ---------------- Progress calculation ---------------- */
function updateProgress() {
  let pct = 0;
  if (state.propertyId && state.type) pct += 10;

  if (state.rooms.length > 0) {
    const roomCompletionRatios = state.rooms.map(r => {
      const filled = r.items.filter(itemHasValue).length;
      return r.items.length ? filled / r.items.length : 0;
    });
    const atLeastHalf = roomCompletionRatios.filter(r => r >= 0.5).length / state.rooms.length;
    const fullyDone = roomCompletionRatios.filter(r => r === 1).length / state.rooms.length;
    pct += atLeastHalf * 30;
    pct += fullyDone * 40;
  }

  const overallFilled = document.getElementById('overall-condition').value && document.getElementById('recommended-action').value;
  if (overallFilled) pct += 10;
  if (state.signature.signed) pct += 10;

  pct = Math.round(pct);
  document.getElementById('progress-percent').textContent = pct + '%';
  document.getElementById('progress-bar-fill').style.width = pct + '%';
  return pct;
}

document.addEventListener('input', updateProgress);
document.addEventListener('change', updateProgress);

/* ---------------- Submission ---------------- */
function wireSubmit() {
  document.getElementById('submit-inspection').addEventListener('click', handleSubmit);
}

async function handleSubmit() {
  const errorEl = document.getElementById('submit-error');
  const successEl = document.getElementById('submit-success');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const pct = updateProgress();
  if (pct < 80) {
    errorEl.textContent = `At least 80% completion is required before submitting (currently ${pct}%).`;
    errorEl.classList.remove('hidden');
    return;
  }
  if (!state.type) { errorEl.textContent = 'Select an inspection type.'; errorEl.classList.remove('hidden'); return; }
  if (!state.propertyId) { errorEl.textContent = 'Select a property.'; errorEl.classList.remove('hidden'); return; }
  if (!state.signature.signed) { errorEl.textContent = 'Sign before submitting.'; errorEl.classList.remove('hidden'); return; }

  const submitBtn = document.getElementById('submit-inspection');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    // 1. Create the inspection row.
    const { data: inspection, error: inspError } = await supabaseClient.from('lease_inspections').insert([{
      lease_id: state.leaseId,
      property_id: state.propertyId,
      inspection_type: state.type,
      inspection_date: document.getElementById('insp-date').value,
      inspector_id: inspCurrentUser.id,
      overall_condition: document.getElementById('overall-condition').value || null,
      comments: document.getElementById('overall-comments').value.trim() || null,
      recommended_action: document.getElementById('recommended-action').value || null,
      status: 'Completed',
    }]).select().single();
    if (inspError) throw inspError;

    // 2. Upload the signature PNG, then record it on the inspection row.
    const signatureBlob = await (await fetch(state.signature.dataUrl)).blob();
    const signaturePath = `documents/inspections/${inspection.id}/signature.png`;
    await uploadInspectionFile(signatureBlob, signaturePath, 'image/png');
    const signatureHash = await computeHash(state.signature.dataUrl + state.signature.fullName + state.signature.signedAt);

    await supabaseClient.from('lease_inspections').update({
      inspector_signed_at: state.signature.signedAt,
      inspector_signature_name: state.signature.fullName,
      inspector_signature_path: signaturePath,
      inspector_signature_hash: signatureHash,
    }).eq('id', inspection.id);

    // 3. Create each room item row, then upload any photos attached to it.
    for (const room of state.rooms) {
      for (const item of room.items) {
        const row = {
          inspection_id: inspection.id,
          room_name: room.name,
          room_order: room.order,
          item_name: item.name,
          item_type: item.type,
          rating_value: item.type === 'Rating' ? (item.value.rating || null) : null,
          yes_no_value: item.type === 'Yes_No' ? (item.value.yesNo ?? null) : null,
          text_value: item.type === 'Text' ? (item.value.text || null) : null,
        };
        const { data: itemRow, error: itemError } = await supabaseClient.from('inspection_room_items').insert([row]).select().single();
        if (itemError) throw itemError;

        if (item.type === 'Photo' && (item.value.files || []).length > 0) {
          for (const file of item.value.files) {
            const photoPath = `documents/inspections/${inspection.id}/${itemRow.id}/${file.name}`;
            await uploadInspectionFile(file, photoPath, file.type);
            await supabaseClient.from('inspection_photos').insert([{
              inspection_room_item_id: itemRow.id, storage_path: photoPath, uploaded_by: inspCurrentUser.id,
            }]);
          }
        }
      }
    }

    successEl.textContent = 'Inspection submitted successfully.';
    successEl.classList.remove('hidden');
    setTimeout(() => { window.location.href = 'admin-dashboard.html'; }, 1800);
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Complete & Submit Inspection';
  }
}

function uploadInspectionFile(fileOrBlob, path, contentType) {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return reject(new Error('Session expired — log in again.'));
    const url = `${SUPABASE_URL}/storage/v1/object/documents/${path}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', contentType || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Upload failed: ' + xhr.responseText));
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(fileOrBlob);
  });
}

async function computeHash(text) {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
