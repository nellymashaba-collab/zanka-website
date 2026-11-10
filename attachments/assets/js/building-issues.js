// Zanka Group — Building issues back end (building-issues.html), admin only.
// Allocates issues logged on the public building page (ram.html), records
// quotes and trustee approval, and shows the age analysis of open issues.
// The rules (deadlines, approval control, audit trail) are enforced in the
// database by 032_building_issues.sql — this page only displays their errors.

const OPEN_STATUSES = ['Logged', 'Assigned', 'Awaiting approval', 'Approved', 'In progress'];
const AGE_BUCKETS = [
  { label: '0–2 days', min: 0, max: 2, cls: 'hm1' },
  { label: '3–7 days', min: 3, max: 7, cls: 'hm2' },
  { label: '8–14 days', min: 8, max: 14, cls: 'hm3' },
  { label: '15–30 days', min: 15, max: 30, cls: 'hm4' },
  { label: 'Over 30', min: 31, max: Infinity, cls: 'hm5' },
];
const STATUS_STYLE = {
  'Logged': 'bg-red-100 text-red-700', 'Assigned': 'bg-yellow-100 text-yellow-800',
  'Awaiting approval': 'bg-orange-100 text-orange-700', 'Approved': 'bg-blue-100 text-blue-700',
  'In progress': 'bg-blue-100 text-blue-700', 'Completed': 'bg-green-100 text-green-700',
  'Closed': 'bg-green-100 text-green-700', 'Rejected': 'bg-gray-200 text-gray-600',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysBetween = (a, b = Date.now()) => Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
const dateLabel = (iso) => (iso ? new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dateTimeLabel = (iso) => new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const money = (n) => (n == null ? '—' : 'R' + Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 0 }));
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));
const isOpen = (i) => OPEN_STATUSES.includes(i.status);
const isOverdue = (i) => isOpen(i) && new Date(i.due_at) < new Date();

let buildings = [];
let building = null;
let issues = [];
let groupBy = 'assigned_to';
let filter = 'open';
let current = null;

document.addEventListener('DOMContentLoaded', async () => {
  if (!(await requireAdmin())) return;

  const { data, error } = await supabaseClient.from('buildings').select('*').order('name');
  if (error) { $('status').textContent = 'Could not load buildings: ' + error.message; return; }
  buildings = data || [];
  if (!buildings.length) { $('status').textContent = 'No buildings set up yet. Run migration 032.'; return; }

  $('building').innerHTML = buildings.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  $('building').addEventListener('change', () => selectBuilding($('building').value));

  document.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    groupBy = b.dataset.group;
    document.querySelectorAll('[data-group]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderAge();
  }));
  document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderIssues();
  }));
  $('search').addEventListener('input', renderIssues);
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-settings').addEventListener('click', openSettings);
  $('issue-edit').addEventListener('submit', saveIssue);
  $('settings-form').addEventListener('submit', saveSettings);
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  await loadAssignees();
  await selectBuilding(buildings[0].id);
});

async function requireAdmin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { location.href = 'admin-login.html'; return false; }
  const { data: profile } = await supabaseClient.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') { location.href = 'admin-login.html'; return false; }
  return true;
}

async function selectBuilding(id) {
  building = buildings.find((b) => b.id === id);
  $('public-link').href = `${building.code}.html`;
  $('scope-line').textContent = `${building.name}${building.access_code_hash ? '' : ' — public page not open yet: set an access code in Settings.'}`;
  await loadIssues();
}

async function loadIssues() {
  const { data, error } = await supabaseClient.from('building_issues').select('*')
    .eq('building_id', building.id).order('created_at', { ascending: false });
  if (error) { $('status').textContent = 'Could not load issues: ' + error.message; $('status').classList.remove('hidden'); return; }
  issues = data || [];
  $('status').classList.add('hidden');
  $('report').classList.remove('hidden');
  renderKpis();
  renderAge();
  renderIssues();
  refreshAssigneeList();
}

/* ---------------- Summary ---------------- */
function renderKpis() {
  const open = issues.filter(isOpen);
  const fixed = issues.filter((i) => i.completed_at && i.status !== 'Rejected' && daysBetween(i.completed_at) <= 90);
  $('k-open').textContent = open.length;
  $('k-overdue').textContent = open.filter(isOverdue).length;
  $('k-unassigned').textContent = open.filter((i) => !i.assigned_to).length;
  $('k-approval').textContent = open.filter((i) => i.status === 'Awaiting approval').length;
  $('k-fix').textContent = fixed.length ? (fixed.reduce((s, i) => s + daysBetween(i.created_at, i.completed_at), 0) / fixed.length).toFixed(1) : '—';
  $('k-value').textContent = money(open.reduce((s, i) => s + Number(i.estimated_cost || 0), 0));
}

/* ---------------- Age analysis ---------------- */
function renderAge() {
  const open = issues.filter(isOpen);
  const keyOf = (i) => (groupBy === 'assigned_to' ? (i.assigned_to || 'Not assigned') : i[groupBy]);
  const groups = {};
  for (const i of open) {
    const k = keyOf(i);
    const g = (groups[k] = groups[k] || { counts: AGE_BUCKETS.map(() => 0), total: 0, overdue: 0, oldest: 0 });
    const d = daysBetween(i.created_at);
    g.counts[AGE_BUCKETS.findIndex((b) => d >= b.min && d <= b.max)]++;
    g.total++;
    if (isOverdue(i)) g.overdue++;
    g.oldest = Math.max(g.oldest, d);
  }
  const rows = Object.entries(groups).sort((a, b) => b[1].oldest - a[1].oldest);
  const head = { assigned_to: 'Contractor', category: 'Type', status: 'Status' }[groupBy];

  if (!rows.length) { $('age-table').innerHTML = '<tbody><tr><td class="py-4 text-gray-500">No open issues.</td></tr></tbody>'; return; }

  const totals = AGE_BUCKETS.map((_, idx) => rows.reduce((s, [, g]) => s + g.counts[idx], 0));
  const cell = (n, cls) => `<td class="num py-2.5 px-3 ${n ? cls : ''}">${n || '<span class="text-gray-300">–</span>'}</td>`;
  $('age-table').innerHTML = `
    <thead><tr class="text-xs text-gray-500 border-b border-gray-200">
      <th class="text-left py-2 pr-3">${head}</th>${AGE_BUCKETS.map((b) => `<th class="num px-3">${b.label}</th>`).join('')}
      <th class="num px-3">Total</th><th class="num px-3">Past deadline</th><th class="num px-3">Oldest (days)</th></tr></thead>
    <tbody>${rows.map(([k, g]) => `
      <tr class="border-b border-gray-100"><td class="py-2.5 pr-3 font-medium text-navy">${esc(k)}</td>
        ${g.counts.map((n, idx) => cell(n, AGE_BUCKETS[idx].cls)).join('')}
        <td class="num px-3 font-semibold">${g.total}</td>
        <td class="num px-3 ${g.overdue ? 'text-red-600 font-semibold' : 'text-gray-400'}">${g.overdue}</td>
        <td class="num px-3">${g.oldest}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr class="font-semibold text-navy border-t border-gray-300"><td class="py-2.5 pr-3">Total</td>
      ${totals.map((n) => `<td class="num px-3">${n}</td>`).join('')}
      <td class="num px-3">${open.length}</td><td class="num px-3 text-red-600">${open.filter(isOverdue).length}</td><td></td></tr></tfoot>`;
}

/* ---------------- Issue list ---------------- */
function filteredIssues() {
  const q = $('search').value.trim().toLowerCase();
  return issues.filter((i) => {
    if (filter === 'open' && !isOpen(i)) return false;
    if (filter === 'overdue' && !isOverdue(i)) return false;
    if (filter === 'closed' && isOpen(i)) return false;
    if (!q) return true;
    return [i.reference, i.title, i.category, i.assigned_to, i.unit_label, i.reporter_name, i.location_detail]
      .some((v) => String(v || '').toLowerCase().includes(q));
  });
}

function renderIssues() {
  const list = filteredIssues();
  if (!list.length) { $('issues-table').innerHTML = '<tbody><tr><td class="py-4 text-gray-500">Nothing here.</td></tr></tbody>'; return; }
  $('issues-table').innerHTML = `
    <thead><tr class="text-xs text-gray-500 border-b border-gray-200 text-left">
      <th class="py-2 pr-3">Ref</th><th class="pr-3">Logged</th><th class="pr-3">Issue</th><th class="pr-3">Where</th>
      <th class="pr-3">Status</th><th class="pr-3">With</th><th class="num pr-3">Days open</th><th class="pr-3">Deadline</th><th class="num">Estimate</th></tr></thead>
    <tbody>${list.map((i) => {
      const days = daysBetween(i.created_at, isOpen(i) ? Date.now() : (i.completed_at || i.closed_at));
      return `<tr class="row border-b border-gray-100" data-id="${i.id}">
        <td class="py-2.5 pr-3 text-gray-500 whitespace-nowrap">${esc(i.reference)}</td>
        <td class="pr-3 whitespace-nowrap">${dateLabel(i.created_at)}</td>
        <td class="pr-3"><span class="font-medium text-navy">${esc(i.title)}</span><span class="block text-xs text-gray-500">${esc(i.category)}${i.urgency !== 'Routine' ? ' · <span class="text-red-600">' + esc(i.urgency) + '</span>' : ''}</span></td>
        <td class="pr-3 whitespace-nowrap">${i.location_type === 'Unit' ? 'Unit ' + esc(i.unit_label) : 'Common'}</td>
        <td class="pr-3"><span class="pill ${STATUS_STYLE[i.status]}">${esc(i.status)}</span></td>
        <td class="pr-3">${i.assigned_to ? esc(i.assigned_to) : '<span class="text-red-600">—</span>'}</td>
        <td class="num pr-3">${days}</td>
        <td class="pr-3 whitespace-nowrap ${isOverdue(i) ? 'text-red-600 font-semibold' : ''}">${isOpen(i) ? dateLabel(i.due_at) : '—'}</td>
        <td class="num">${money(i.estimated_cost)}</td></tr>`;
    }).join('')}</tbody>`;
  document.querySelectorAll('#issues-table tr.row').forEach((tr) => tr.addEventListener('click', () => openIssue(tr.dataset.id)));
}

/* ---------------- Issue detail ---------------- */
async function openIssue(id) {
  current = issues.find((i) => i.id === id);
  const i = current;
  $('d-ref').textContent = `${i.reference} · logged ${dateTimeLabel(i.created_at)}`;
  $('d-title').textContent = i.title;
  $('d-info').innerHTML = `
    <div><p class="text-xs text-gray-500">Where</p><p class="text-navy">${i.location_type === 'Unit' ? 'Unit ' + esc(i.unit_label) : 'Common property'}${i.location_detail ? ' — ' + esc(i.location_detail) : ''}</p></div>
    <div><p class="text-xs text-gray-500">Type</p><p class="text-navy">${esc(i.category)}</p></div>
    <div><p class="text-xs text-gray-500">Reported by</p><p class="text-navy">${esc(i.reporter_name)} (${esc(i.reporter_role)})</p></div>
    <div><p class="text-xs text-gray-500">Contact</p><p class="text-navy">${esc(i.reporter_contact)}</p></div>
    <div class="sm:col-span-2"><p class="text-xs text-gray-500">Description</p><p class="text-navy whitespace-pre-line">${esc(i.description || 'No detail given.')}</p></div>`;

  $('e-status').value = i.status;
  $('e-urgency').value = i.urgency;
  $('e-assigned').value = i.assigned_to || '';
  $('e-estimate').value = i.estimated_cost ?? '';
  $('e-quotes').value = i.quotes_received ?? 0;
  $('e-final').value = i.final_cost ?? '';
  $('e-approved').value = i.approved_by || '';
  $('e-note').value = '';
  $('e-public').checked = true;
  $('e-msg').classList.add('hidden');
  $('approval-rule').textContent = `Jobs estimated above ${money(building.approval_threshold)} need ${building.required_quotes} quotes and a named trustee before they can be approved or started.`;

  $('d-photos').innerHTML = '';
  $('d-history').innerHTML = '<li class="text-gray-400">Loading…</li>';
  $('issue-dialog').showModal();

  const [{ data: events }, { data: photos }] = await Promise.all([
    supabaseClient.from('building_issue_events').select('*').eq('issue_id', id).order('created_at', { ascending: false }),
    supabaseClient.from('building_issue_photos').select('*').eq('issue_id', id).order('uploaded_at'),
  ]);

  $('d-history').innerHTML = (events || []).map((e) => {
    const text = e.event_type === 'Status' ? `Status: ${esc(e.from_status)} → <strong>${esc(e.to_status)}</strong>` : esc(e.note || e.event_type);
    return `<li class="flex gap-3"><span class="text-xs text-gray-400 w-28 flex-shrink-0">${dateTimeLabel(e.created_at)}</span>
      <span class="text-navy">${text}${e.is_public ? '' : ' <span class="pill bg-gray-100 text-gray-500">internal</span>'}</span></li>`;
  }).join('') || '<li class="text-gray-400">No history.</li>';

  if (photos && photos.length) {
    const { data: signed } = await supabaseClient.storage.from('building-issues').createSignedUrls(photos.map((p) => p.storage_path), 3600);
    $('d-photos').innerHTML = (signed || []).filter((s) => s.signedUrl).map((s) =>
      `<a href="${esc(s.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(s.signedUrl)}" alt="Issue photo" class="w-24 h-24 object-cover rounded-lg border border-gray-200"></a>`).join('');
  }
}

async function saveIssue(e) {
  e.preventDefault();
  const i = current;
  const patch = {};
  const next = {
    status: $('e-status').value,
    urgency: $('e-urgency').value,
    assigned_to: $('e-assigned').value.trim() || null,
    estimated_cost: numOrNull($('e-estimate').value),
    quotes_received: Number($('e-quotes').value || 0),
    final_cost: numOrNull($('e-final').value),
    approved_by: $('e-approved').value.trim() || null,
  };
  for (const [k, v] of Object.entries(next)) {
    const before = ['estimated_cost', 'final_cost'].includes(k) ? numOrNull(i[k]) : i[k];
    if (v !== before) patch[k] = v;
  }
  const note = $('e-note').value.trim();
  if (!Object.keys(patch).length && !note) { $('issue-dialog').close(); return; }

  $('e-save').disabled = true;
  const msg = $('e-msg');
  if (Object.keys(patch).length) {
    const { error } = await supabaseClient.from('building_issues').update(patch).eq('id', i.id);
    if (error) {
      $('e-save').disabled = false;
      msg.textContent = error.message;
      msg.className = 'text-sm text-red-600';
      return;
    }
  }
  if (note) {
    const { error } = await supabaseClient.from('building_issue_events')
      .insert([{ issue_id: i.id, event_type: 'Note', note, is_public: $('e-public').checked, actor_label: 'Zanka Group' }]);
    if (error) {
      $('e-save').disabled = false;
      msg.textContent = 'Saved, but the update note failed: ' + error.message;
      msg.className = 'text-sm text-red-600';
      await loadIssues();
      return;
    }
  }
  $('e-save').disabled = false;
  $('issue-dialog').close();
  await loadIssues();
}

/* ---------------- Assignee suggestions ---------------- */
let partnerNames = [];
async function loadAssignees() {
  const { data } = await supabaseClient.from('partner_profiles').select('company_name, partner_category')
    .eq('partner_category', 'Maintenance & Trades');
  partnerNames = (data || []).map((p) => p.company_name).filter(Boolean);
}
function refreshAssigneeList() {
  const names = [...new Set([...partnerNames, ...issues.map((i) => i.assigned_to).filter(Boolean)])].sort();
  $('assignees').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

/* ---------------- Settings ---------------- */
function openSettings() {
  $('s-threshold').value = building.approval_threshold;
  $('s-quotes').value = building.required_quotes;
  $('s-emergency').value = building.sla_emergency_hours;
  $('s-urgent').value = building.sla_urgent_hours;
  $('s-routine').value = building.sla_routine_hours;
  $('s-access').value = '';
  $('s-msg').classList.add('hidden');
  $('settings-dialog').showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const msg = $('s-msg');
  const fail = (text) => { msg.textContent = text; msg.className = 'text-sm text-red-600'; $('s-save').disabled = false; };
  $('s-save').disabled = true;

  const patch = {
    approval_threshold: Number($('s-threshold').value),
    required_quotes: Number($('s-quotes').value),
    sla_emergency_hours: Number($('s-emergency').value),
    sla_urgent_hours: Number($('s-urgent').value),
    sla_routine_hours: Number($('s-routine').value),
  };
  const { data, error } = await supabaseClient.from('buildings').update(patch).eq('id', building.id).select('*').single();
  if (error) return fail(error.message);

  const code = $('s-access').value.trim();
  let updated = data;
  if (code) {
    const { error: codeErr } = await supabaseClient.rpc('admin_set_building_access_code', { p_building_id: building.id, p_access: code });
    if (codeErr) return fail(codeErr.message);
    const { data: fresh } = await supabaseClient.from('buildings').select('*').eq('id', building.id).single();
    updated = fresh || data;
  }
  buildings = buildings.map((b) => (b.id === building.id ? updated : b));
  $('s-save').disabled = false;
  $('settings-dialog').close();
  await selectBuilding(building.id);
}

/* ---------------- CSV ---------------- */
function downloadCsv() {
  const cols = ['Reference', 'Logged', 'Title', 'Category', 'Location', 'Unit', 'Urgency', 'Status', 'Assigned to',
    'Days open', 'Deadline', 'Past deadline', 'Estimate', 'Quotes', 'Approved by', 'Final cost', 'Completed', 'Reported by', 'Contact'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = filteredIssues().map((i) => [
    i.reference, i.created_at.slice(0, 10), i.title, i.category, i.location_type, i.unit_label, i.urgency, i.status, i.assigned_to,
    daysBetween(i.created_at, isOpen(i) ? Date.now() : (i.completed_at || i.closed_at)), i.due_at?.slice(0, 10),
    isOverdue(i) ? 'Yes' : 'No', i.estimated_cost, i.quotes_received, i.approved_by, i.final_cost, i.completed_at?.slice(0, 10),
    i.reporter_name, i.reporter_contact,
  ].map(q).join(','));
  const blob = new Blob([[cols.map(q).join(','), ...lines].join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${building.code}-issues-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
