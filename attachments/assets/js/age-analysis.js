// Zanka Group — Rent age analysis (age-analysis.html)
// For admin (all properties), owners (their properties) and partners linked
// to a property. Which charges each person may see is decided by the
// database function rent_age_analysis() in 030_rent_age_analysis.sql.
//
// Rental arrears: what is outstanding, aged by days past the due date.
// Rent invoiced:  what was invoiced, aged by days since the invoice date,
//                 with how much of it has been received.

const BUCKETS = [
  { key: 'nyd', label: 'Not yet due', test: (d) => d < 0, cls: 'b0' },
  { key: 'b30', label: '0–30 days', test: (d) => d >= 0 && d <= 30, cls: 'b1' },
  { key: 'b60', label: '31–60 days', test: (d) => d >= 31 && d <= 60, cls: 'b2' },
  { key: 'b90', label: '61–90 days', test: (d) => d >= 61 && d <= 90, cls: 'b3' },
  { key: 'b120', label: '91–120 days', test: (d) => d >= 91 && d <= 120, cls: 'b4' },
  { key: 'b120p', label: '120+ days', test: (d) => d > 120, cls: 'b5' },
];
const AGED = BUCKETS.slice(1); // the five age buckets
const HOME = { admin: ['admin-dashboard.html', 'Admin dashboard'], owner: ['owner-dashboard.html', 'Owner portal'], partner: ['partner-dashboard.html', 'Partner portal'] };
const LOGIN = { admin: 'admin-login.html', owner: 'owner-login.html', partner: 'partner-login.html' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) < 0 ? '−' : '') + 'R' + Math.abs(Number(n || 0)).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const bucketOf = (days) => BUCKETS.find((b) => b.test(days)).key;
const r2 = (n) => Math.round(n * 100) / 100;

let me = null;
let rows = [];
let view = 'arrears';
const open = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  me = await currentUser();
  if (!me) return;
  $('back-link').href = HOME[me.role][0];
  $('back-link').textContent = '← ' + HOME[me.role][1];
  $('scope-line').textContent = me.role === 'admin' ? 'All properties managed by Zanka Group.' : me.role === 'owner' ? 'Your properties.' : 'Properties you are linked to.';
  $('as-at').value = today();
  $('as-at').addEventListener('change', load);
  $('property').addEventListener('change', render);
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    open.clear();
    render();
  }));
  $('btn-print').addEventListener('click', () => window.print());
  $('btn-csv').addEventListener('click', downloadCsv);
  await load();
});

// Any of the three roles may use this page; everyone else goes to a login.
async function currentUser() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { location.href = 'owner-login.html'; return null; }
  const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile || !HOME[profile.role]) { location.href = LOGIN[profile?.role] || 'index.html'; return null; }
  return profile;
}

async function load() {
  $('status').className = 'text-gray-500';
  $('status').textContent = 'Loading…';
  const { data, error } = await supabaseClient.rpc('rent_age_analysis', { p_as_at: $('as-at').value || today() });
  if (error) {
    $('status').className = 'rounded-xl bg-red-50 text-red-700 px-4 py-3 text-sm';
    $('status').textContent = /rent_age_analysis/.test(error.message) ? 'The age analysis is not set up yet (030_rent_age_analysis.sql).' : error.message;
    $('report').classList.add('hidden');
    return;
  }
  rows = (data || []).map((r) => ({ ...r, amount: Number(r.amount), outstanding: Number(r.outstanding) }));
  const props = [...new Map(rows.filter((r) => r.property_id != null).map((r) => [String(r.property_id), r.property_name || r.property_address || `Property ${r.property_id}`])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const sel = $('property');
  const keep = sel.value;
  sel.innerHTML = '<option value="">All properties</option>' + props.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  if (props.some(([id]) => id === keep)) sel.value = keep;
  $('status').className = 'hidden';
  $('report').classList.remove('hidden');
  render();
}

function filtered() {
  const p = $('property').value;
  return p ? rows.filter((r) => String(r.property_id) === p) : rows;
}

function render() {
  const data = filtered();
  const asAt = dt($('as-at').value || today());
  const propName = $('property').selectedOptions[0]?.textContent || 'All properties';
  $('print-heading').textContent = `${propName} · as at ${asAt} · prepared ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}`;
  if (!data.length) {
    $('summary-title').textContent = 'Nothing to show';
    $('summary-total').textContent = '';
    $('buckets').innerHTML = '';
    $('summary-note').textContent = me.role === 'partner' ? 'No properties are linked to your partner account yet. Ask Zanka Group to link the properties you manage.' : 'No rent has been invoiced for these properties up to this date.';
    $('table-title').textContent = ''; $('table-note').textContent = ''; $('table').innerHTML = '';
    return;
  }
  return view === 'arrears' ? renderArrears(data, asAt) : renderInvoiced(data, asAt);
}

function bucketTiles(totals, grand, shownBuckets) {
  $('buckets').className = `grid grid-cols-2 sm:grid-cols-3 ${shownBuckets.length === 6 ? 'lg:grid-cols-6' : 'lg:grid-cols-5'} gap-4`;
  $('buckets').innerHTML = shownBuckets.map((b) => {
    const v = totals[b.key] || 0;
    const pct = grand > 0 ? (v / grand) * 100 : 0;
    return `<div class="min-w-0"><p class="text-xs text-gray-500 mb-1">${esc(b.label)}</p><p class="font-semibold text-navy num !text-left">${money(v)}</p>
      <div class="bucket-bar mt-2" aria-hidden="true"><span class="${b.cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></span></div>
      <p class="text-xs text-gray-400 mt-1 num !text-left">${b.key === 'nyd' ? 'not in arrears' : pct.toFixed(1) + '%'}</p></div>`;
  }).join('');
}

/* ---------------- Rental arrears: outstanding by days overdue ---------------- */
function renderArrears(data, asAt) {
  const open_ = data.filter((r) => r.outstanding > 0.004);
  const groups = new Map();
  for (const r of open_) {
    const k = `${r.tenant_id || 'none'}|${r.property_id || 'none'}`;
    if (!groups.has(k)) groups.set(k, { tenant: r.tenant_name || 'No tenant on record', property: r.property_name || r.property_address || '—', charges: [], b: {} });
    const g = groups.get(k);
    g.charges.push(r);
    const key = bucketOf(r.days_overdue);
    g.b[key] = (g.b[key] || 0) + r.outstanding;
  }
  const list = [...groups.values()].map((g) => ({ ...g, overdue: AGED.reduce((a, b) => a + (g.b[b.key] || 0), 0) }))
    .sort((a, b) => b.overdue - a.overdue || a.tenant.localeCompare(b.tenant));
  const totals = {}; BUCKETS.forEach((b) => { totals[b.key] = r2(list.reduce((a, g) => a + (g.b[b.key] || 0), 0)); });
  const overdue = r2(AGED.reduce((a, b) => a + totals[b.key], 0));

  $('summary-title').textContent = `Rental arrears as at ${asAt}`;
  $('summary-total').textContent = money(overdue);
  bucketTiles(totals, overdue, BUCKETS);
  $('summary-note').textContent = 'Arrears are unpaid rent charges aged by days past their due date (0 = due on the as-at date). Charges not yet due are shown separately and are not counted as arrears.';
  $('table-title').textContent = 'By tenant';
  $('table-note').textContent = list.length ? 'Click a tenant to see the unpaid invoices.' : 'No unpaid rent. Every charge due by this date has been paid.';
  if (!list.length) { $('table').innerHTML = ''; return; }

  const head = `<thead><tr class="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
    <th class="py-3 px-3 sticky-col bg-white">Tenant</th><th class="py-3 px-3">Property</th>${BUCKETS.map((b) => `<th class="py-3 px-3 num">${esc(b.label)}</th>`).join('')}<th class="py-3 px-3 num">Total arrears</th></tr></thead>`;
  const body = list.map((g, i) => {
    const id = `a${i}`;
    const row = `<tr class="border-b border-gray-100 cursor-pointer hover:bg-gray-50 bg-white" data-toggle="${id}" tabindex="0" aria-expanded="${open.has(id)}">
      <td class="py-3 px-3 sticky-col font-semibold text-navy">${esc(g.tenant)}</td><td class="py-3 px-3 text-gray-600">${esc(g.property)}</td>
      ${BUCKETS.map((b) => `<td class="py-3 px-3 num ${b.key === 'nyd' ? 'text-gray-400' : (g.b[b.key] && b.key !== 'b30' ? 'text-red-700' : '')}">${g.b[b.key] ? money(g.b[b.key]) : '–'}</td>`).join('')}
      <td class="py-3 px-3 num font-semibold">${money(g.overdue)}</td></tr>`;
    const detail = open.has(id) ? g.charges.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).map((c) => `<tr class="detail text-xs border-b border-gray-100">
      <td class="py-2 px-3 sticky-col text-gray-500">${esc(c.invoice_number || 'Charge #' + c.charge_id)}</td>
      <td class="py-2 px-3 text-gray-500">Invoiced ${esc(dt(c.invoice_date))} · due ${esc(dt(c.due_date))}</td>
      ${BUCKETS.map((b) => `<td class="py-2 px-3 num">${bucketOf(c.days_overdue) === b.key ? money(c.outstanding) : ''}</td>`).join('')}
      <td class="py-2 px-3 num text-gray-500">${c.days_overdue < 0 ? `due in ${-c.days_overdue} days` : `${c.days_overdue} days`}</td></tr>`).join('') : '';
    return row + detail;
  }).join('');
  const foot = `<tfoot><tr class="border-t-2 border-navy font-semibold"><td class="py-3 px-3 sticky-col bg-white">Total</td><td class="py-3 px-3">${list.length} tenant${list.length === 1 ? '' : 's'}</td>
    ${BUCKETS.map((b) => `<td class="py-3 px-3 num">${money(totals[b.key])}</td>`).join('')}<td class="py-3 px-3 num">${money(overdue)}</td></tr>
    <tr class="text-xs text-gray-500"><td class="py-1 px-3 sticky-col bg-white">% of arrears</td><td></td><td class="py-1 px-3 num">–</td>
    ${AGED.map((b) => `<td class="py-1 px-3 num">${overdue ? ((totals[b.key] / overdue) * 100).toFixed(1) + '%' : '–'}</td>`).join('')}<td class="py-1 px-3 num">100%</td></tr></tfoot>`;
  $('table').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  wireToggles();
}

/* ---------------- Rent invoiced: by invoice age, with what was received ---------------- */
function renderInvoiced(data, asAt) {
  const age = (r) => bucketOf(r.days_since_invoice);
  const totals = {}; const got = {}; const owing = {};
  for (const r of data) {
    const k = age(r);
    totals[k] = (totals[k] || 0) + r.amount;
    owing[k] = (owing[k] || 0) + r.outstanding;
    got[k] = (got[k] || 0) + (r.amount - r.outstanding);
  }
  const invoiced = r2(data.reduce((a, r) => a + r.amount, 0));
  const outstanding = r2(data.reduce((a, r) => a + r.outstanding, 0));

  $('summary-title').textContent = `Rent invoiced up to ${asAt}`;
  $('summary-total').textContent = money(invoiced);
  bucketTiles(totals, invoiced, AGED);
  $('summary-note').textContent = `Every rent invoice, aged by days since the invoice date. ${money(invoiced - outstanding)} received, ${money(outstanding)} still outstanding (${invoiced ? (((invoiced - outstanding) / invoiced) * 100).toFixed(1) : '0'}% collected).`;
  $('table-title').textContent = 'By invoice age';
  $('table-note').textContent = 'Click an age band to see the invoices in it.';

  const head = `<thead><tr class="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
    <th class="py-3 px-3 sticky-col bg-white">Invoice age</th><th class="py-3 px-3 num">Invoices</th><th class="py-3 px-3 num">Invoiced</th><th class="py-3 px-3 num">Received</th><th class="py-3 px-3 num">Outstanding</th><th class="py-3 px-3 num">Collected</th></tr></thead>`;
  const body = AGED.map((b) => {
    const id = `i${b.key}`;
    const items = data.filter((r) => age(r) === b.key);
    const inv = totals[b.key] || 0;
    const row = `<tr class="border-b border-gray-100 ${items.length ? 'cursor-pointer hover:bg-gray-50' : ''} bg-white" ${items.length ? `data-toggle="${id}" tabindex="0" aria-expanded="${open.has(id)}"` : ''}>
      <td class="py-3 px-3 sticky-col font-semibold text-navy">${esc(b.label)}</td><td class="py-3 px-3 num">${items.length}</td><td class="py-3 px-3 num">${money(inv)}</td>
      <td class="py-3 px-3 num">${money(got[b.key] || 0)}</td><td class="py-3 px-3 num ${(owing[b.key] || 0) > 0.004 ? 'text-red-700' : ''}">${money(owing[b.key] || 0)}</td>
      <td class="py-3 px-3 num">${inv ? (((got[b.key] || 0) / inv) * 100).toFixed(1) + '%' : '–'}</td></tr>`;
    const detail = open.has(id) ? items.sort((a, c) => (a.invoice_date || '').localeCompare(c.invoice_date || '')).map((c) => `<tr class="detail text-xs border-b border-gray-100">
      <td class="py-2 px-3 sticky-col text-gray-600">${esc(c.invoice_number || 'Charge #' + c.charge_id)} · ${esc(dt(c.invoice_date))}</td>
      <td class="py-2 px-3 text-gray-500" colspan="1">${esc(c.tenant_name || '—')}</td>
      <td class="py-2 px-3 num">${money(c.amount)}</td><td class="py-2 px-3 num">${money(c.amount - c.outstanding)}</td><td class="py-2 px-3 num">${money(c.outstanding)}</td>
      <td class="py-2 px-3 text-gray-500">${esc(c.property_name || '')}${c.paid_on ? ' · paid ' + esc(dt(c.paid_on)) : ''}</td></tr>`).join('') : '';
    return row + detail;
  }).join('');
  const foot = `<tfoot><tr class="border-t-2 border-navy font-semibold"><td class="py-3 px-3 sticky-col bg-white">Total</td><td class="py-3 px-3 num">${data.length}</td><td class="py-3 px-3 num">${money(invoiced)}</td>
    <td class="py-3 px-3 num">${money(invoiced - outstanding)}</td><td class="py-3 px-3 num">${money(outstanding)}</td><td class="py-3 px-3 num">${invoiced ? (((invoiced - outstanding) / invoiced) * 100).toFixed(1) + '%' : '–'}</td></tr></tfoot>`;
  $('table').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  wireToggles();
}

function wireToggles() {
  document.querySelectorAll('[data-toggle]').forEach((tr) => {
    const go = () => { const id = tr.dataset.toggle; open.has(id) ? open.delete(id) : open.add(id); render(); };
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

/* ---------------- CSV ---------------- */
function downloadCsv() {
  const data = filtered();
  const asAt = $('as-at').value || today();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['As at', 'Property', 'Tenant', 'Invoice', 'Invoice date', 'Due date', 'Amount', 'Received', 'Outstanding', 'Days overdue', 'Arrears bucket', 'Days since invoice', 'Invoice age bucket', 'Paid on'].map(q).join(',')];
  const label = (k) => BUCKETS.find((b) => b.key === k).label;
  for (const r of data) {
    lines.push([asAt, r.property_name || r.property_address || '', r.tenant_name || '', r.invoice_number || `Charge #${r.charge_id}`, r.invoice_date || '', r.due_date || '',
      r.amount.toFixed(2), (r.amount - r.outstanding).toFixed(2), r.outstanding.toFixed(2), r.days_overdue, r.outstanding > 0.004 ? label(bucketOf(r.days_overdue)) : 'Paid',
      r.days_since_invoice, label(bucketOf(r.days_since_invoice)), r.paid_on || ''].map(q).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `zanka-age-analysis-${asAt}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
