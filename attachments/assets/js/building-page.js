// Zanka Group — public building issues page (ram.html, and any future building page)
// The building is set by <body data-building="ram">. Everything goes through
// the access-code-gated database functions in 032_building_issues.sql:
//   building_public_info, building_check_access, building_log_issue,
//   building_issue_board, register_building_issue_photo.

const BUILDING = document.body.dataset.building;
const PHOTO_BUCKET = 'building-issues';
const MAX_PHOTOS = 5;
const STORE_KEY = 'zanka-building-access-' + BUILDING;

const AGE_BUCKETS = [
  { label: '0–2 days', min: 0, max: 2, cls: 'b1' },
  { label: '3–7 days', min: 3, max: 7, cls: 'b2' },
  { label: '8–14 days', min: 8, max: 14, cls: 'b3' },
  { label: '15–30 days', min: 15, max: 30, cls: 'b4' },
  { label: 'Over 30 days', min: 31, max: Infinity, cls: 'b5' },
];

const STATUS_STYLE = {
  'Logged': 'bg-red-100 text-red-700',
  'Assigned': 'bg-yellow-100 text-yellow-800',
  'Awaiting approval': 'bg-orange-100 text-orange-700',
  'Approved': 'bg-blue-100 text-blue-700',
  'In progress': 'bg-blue-100 text-blue-700',
  'Completed': 'bg-green-100 text-green-700',
  'Closed': 'bg-green-100 text-green-700',
  'Rejected': 'bg-gray-200 text-gray-600',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
const dateLabel = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const hoursLabel = (h) => (h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`);

let info = null;
let accessCode = null;
let issues = [];
let filter = 'open';

function storeGet() { try { return sessionStorage.getItem(STORE_KEY); } catch (e) { return null; } }
function storeSet(v) { try { v ? sessionStorage.setItem(STORE_KEY, v) : sessionStorage.removeItem(STORE_KEY); } catch (e) { /* storage unavailable */ } }

document.addEventListener('DOMContentLoaded', async () => {
  const { data, error } = await supabaseClient.rpc('building_public_info', { p_building: BUILDING });
  if (error || !data) { $('status').textContent = 'This building page is not available.'; return; }
  info = data;
  $('building-name').textContent = info.name;
  document.title = `${info.name} · Building issues | Zanka Group`;
  if (!info.is_open) { $('status').textContent = 'This building page is not open yet. Please check back soon.'; return; }

  wireGate();
  wireForm();
  wireBoard();

  const saved = storeGet();
  if (saved && await tryAccess(saved)) return;
  $('status').classList.add('hidden');
  $('gate').classList.remove('hidden');
});

/* ---------------- Access code ---------------- */
function wireGate() {
  $('gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('gate-error').classList.add('hidden');
    $('gate-submit').disabled = true;
    const ok = await tryAccess($('access-code').value);
    $('gate-submit').disabled = false;
    if (!ok) { $('gate-error').textContent = 'That code is not right. Ask your trustees or Zanka Group for it.'; $('gate-error').classList.remove('hidden'); }
  });
  $('btn-lock').addEventListener('click', () => { storeSet(null); location.reload(); });
}

async function tryAccess(code) {
  const { data, error } = await supabaseClient.rpc('building_check_access', { p_building: BUILDING, p_access: code });
  if (error || !data) { storeSet(null); return false; }
  accessCode = code;
  storeSet(code);
  $('status').classList.add('hidden');
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('btn-lock').classList.remove('hidden');
  updateSlaNote();
  await loadBoard();
  return true;
}

/* ---------------- Log form ---------------- */
function wireForm() {
  document.querySelectorAll('input[name="location_type"]').forEach((r) => r.addEventListener('change', () => {
    $('unit-wrap').classList.toggle('hidden', locationType() !== 'Unit');
  }));
  $('urgency').addEventListener('change', updateSlaNote);
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('issue-form').addEventListener('submit', submitIssue);
}

const locationType = () => document.querySelector('input[name="location_type"]:checked').value;

function showTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tab === tab)));
  $('tab-log').classList.toggle('hidden', tab !== 'log');
  $('tab-board').classList.toggle('hidden', tab !== 'board');
}

function updateSlaNote() {
  if (!info) return;
  const h = { Emergency: info.sla_emergency_hours, Urgent: info.sla_urgent_hours, Routine: info.sla_routine_hours }[$('urgency').value];
  $('sla-note').textContent = `Response deadline: ${hoursLabel(h)}.`;
}

function formMsg(text, ok) {
  const el = $('form-msg');
  el.innerHTML = text;
  el.className = 'text-sm ' + (ok ? 'text-green-700' : 'text-red-600');
}

async function submitIssue(e) {
  e.preventDefault();
  const loc = locationType();
  const files = Array.from($('photos').files || []);
  const issue = {
    location_type: loc,
    unit_label: $('unit_label').value.trim(),
    location_detail: $('location_detail').value.trim(),
    category: $('category').value,
    urgency: $('urgency').value,
    title: $('title').value.trim(),
    description: $('description').value.trim(),
    reporter_name: $('reporter_name').value.trim(),
    reporter_contact: $('reporter_contact').value.trim(),
    reporter_role: $('reporter_role').value,
  };

  if (!issue.category) return formMsg('Please choose the type of problem.');
  if (issue.title.length < 3) return formMsg('Please give the issue a short title.');
  if (loc === 'Unit' && !issue.unit_label) return formMsg('Please enter your unit number.');
  if (!issue.reporter_name || !issue.reporter_contact) return formMsg('Please enter your name and a phone number or email.');
  if (!$('consent').checked) return formMsg('Please tick the box to agree to how we use your details.');
  if (files.length > MAX_PHOTOS) return formMsg(`Please choose at most ${MAX_PHOTOS} photos.`);
  const big = files.find((f) => f.size > 10 * 1024 * 1024);
  if (big) return formMsg(`${esc(big.name)} is larger than 10 MB.`);

  const btn = $('issue-submit');
  btn.disabled = true;
  btn.textContent = 'Logging…';
  formMsg('', true);

  const { data, error } = await supabaseClient.rpc('building_log_issue', {
    p_building: BUILDING, p_access: accessCode, p_issue: issue, p_consent: true,
  });
  if (error) {
    btn.disabled = false;
    btn.textContent = 'Log issue';
    return formMsg(esc(error.message));
  }

  let photoProblem = '';
  for (const f of files) {
    const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
    const path = `${data.id}/${crypto.randomUUID()}-${safe}`;
    const up = await supabaseClient.storage.from(PHOTO_BUCKET).upload(path, f, { contentType: f.type || 'image/jpeg', upsert: false });
    if (up.error) { photoProblem = ' Some photos could not be uploaded.'; continue; }
    const reg = await supabaseClient.rpc('register_building_issue_photo', {
      p_issue_id: data.id, p_upload_token: data.upload_token, p_storage_path: path, p_original_filename: f.name, p_size_bytes: f.size,
    });
    if (reg.error) photoProblem = ' Some photos could not be attached.';
  }

  btn.disabled = false;
  btn.textContent = 'Log issue';
  $('issue-form').reset();
  $('unit-wrap').classList.add('hidden');
  updateSlaNote();
  formMsg(`Logged. Your reference is <strong>${esc(data.reference)}</strong> — you can follow it on the issue board.${photoProblem}`, true);
  await loadBoard();
}

/* ---------------- Board ---------------- */
function wireBoard() {
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderBoard();
  }));
  $('board-category').addEventListener('change', renderBoard);
}

async function loadBoard() {
  const { data, error } = await supabaseClient.rpc('building_issue_board', { p_building: BUILDING, p_access: accessCode });
  if (error) { $('board').innerHTML = `<p class="text-sm text-red-600">${esc(error.message)}</p>`; return; }
  issues = data || [];

  const cats = [...new Set(issues.map((i) => i.category))].sort();
  const sel = $('board-category');
  const current = sel.value;
  sel.innerHTML = '<option value="">All types</option>' + cats.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');

  renderSummary();
  renderBoard();
}

function renderSummary() {
  const open = issues.filter((i) => i.is_open);
  const ages = open.map((i) => daysSince(i.logged_at));
  $('k-open').textContent = open.length;
  $('k-overdue').textContent = open.filter((i) => i.is_overdue).length;
  $('k-avg').textContent = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
  $('k-fixed').textContent = issues.filter((i) => i.completed_at && daysSince(i.completed_at) <= 30 && i.status !== 'Rejected').length;

  const max = Math.max(1, ...AGE_BUCKETS.map((b) => ages.filter((d) => d >= b.min && d <= b.max).length));
  $('buckets').innerHTML = AGE_BUCKETS.map((b) => {
    const n = ages.filter((d) => d >= b.min && d <= b.max).length;
    return `<div><p class="text-xs text-gray-500">${b.label}</p><p class="font-display font-bold text-navy text-xl num">${n}</p>
      <div class="bucket-bar mt-1"><span class="${b.cls}" style="width:${(n / max) * 100}%"></span></div></div>`;
  }).join('');
}

function renderBoard() {
  const cat = $('board-category').value;
  let list = issues.filter((i) => (filter === 'open' ? i.is_open : filter === 'overdue' ? i.is_overdue : !i.is_open));
  if (cat) list = list.filter((i) => i.category === cat);
  if (filter !== 'closed') list.sort((a, b) => new Date(a.logged_at) - new Date(b.logged_at)); // oldest first

  if (!list.length) {
    const empty = { open: 'No open issues.', overdue: 'Nothing is past its deadline.', closed: 'Nothing fixed in the last 90 days.' }[filter];
    $('board').innerHTML = `<div class="panel p-6 text-sm text-gray-500">${empty}</div>`;
    return;
  }

  $('board').innerHTML = list.map((i) => {
    const age = daysSince(i.logged_at);
    const where = i.location_type === 'Unit' ? `Unit ${esc(i.unit_label)}` : 'Common property';
    const quiet = i.is_open && i.last_update_at ? daysSince(i.last_update_at) : null;
    return `
    <article class="panel p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-xs text-gray-400">${esc(i.reference)} · ${esc(i.category)} · ${where}${i.location_detail ? ' — ' + esc(i.location_detail) : ''}</p>
          <h3 class="font-semibold text-navy mt-0.5">${esc(i.title)}</h3>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${i.urgency !== 'Routine' ? `<span class="pill ${i.urgency === 'Emergency' ? 'bg-red-600 text-white' : 'bg-orange-100 text-orange-700'}">${esc(i.urgency)}</span>` : ''}
          ${i.is_overdue ? '<span class="pill bg-red-100 text-red-700">Past deadline</span>' : ''}
          <span class="pill ${STATUS_STYLE[i.status] || 'bg-gray-100 text-gray-600'}">${esc(i.status)}</span>
        </div>
      </div>
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 mt-3 text-sm">
        <div><dt class="text-xs text-gray-500">Logged</dt><dd class="text-navy">${dateLabel(i.logged_at)}</dd></div>
        <div><dt class="text-xs text-gray-500">${i.is_open ? 'Open for' : 'Fixed'}</dt><dd class="text-navy num">${i.is_open ? `${age} day${age === 1 ? '' : 's'}` : dateLabel(i.completed_at || i.closed_at)}</dd></div>
        <div><dt class="text-xs text-gray-500">With</dt><dd class="text-navy">${i.assigned_to ? esc(i.assigned_to) : '<span class="text-red-600">Not assigned yet</span>'}</dd></div>
        <div><dt class="text-xs text-gray-500">${i.is_open ? 'Deadline' : 'Last update'}</dt><dd class="text-navy">${i.is_open ? dateLabel(i.due_at) : dateLabel(i.last_update_at)}</dd></div>
      </dl>
      ${i.last_note ? `<p class="text-sm text-gray-600 mt-3 border-l-2 border-gold pl-3">${esc(i.last_note)}</p>` : ''}
      ${quiet !== null && quiet >= 7 ? `<p class="text-xs text-orange-700 mt-2">No update for ${quiet} days.</p>` : ''}
    </article>`;
  }).join('');
}
