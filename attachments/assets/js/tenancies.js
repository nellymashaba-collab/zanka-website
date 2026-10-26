// Zanka Group — Tenancies (admin): notices, move-outs, deposits, arrears,
// tenancy emails and the daily automation.
// Database: 027_tenancy_lifecycle.sql. Emails: Edge Function `tenancy-automation`.
// Everything typed by tenants is untrusted: always esc() before innerHTML.

let me = null;
let S = {};                // loaded data
let settings = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'R' + Number(n || 0).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dt = (d) => (d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dtt = (d) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('en-CA'); };
const pill = (text, cls) => `<span class="pill ${cls || 'bg-gray-100 text-gray-600'}">${esc(text)}</span>`;
const STATUS_CLS = { New: 'bg-blue-100 text-blue-700', Acknowledged: 'bg-green-100 text-green-700', Open: 'bg-blue-100 text-blue-700', Inspected: 'bg-amber-100 text-amber-800',
  'Deposit settled': 'bg-green-100 text-green-700', Closed: 'bg-gray-200 text-gray-700', Cancelled: 'bg-gray-100 text-gray-500', Draft: 'bg-amber-100 text-amber-800', Sent: 'bg-red-100 text-red-700',
  pending: 'bg-blue-100 text-blue-700', sending: 'bg-blue-100 text-blue-700', sent: 'bg-green-100 text-green-700', failed: 'bg-red-100 text-red-700', skipped: 'bg-gray-100 text-gray-500' };

document.addEventListener('DOMContentLoaded', async () => {
  me = await requireSession('admin', 'admin-login.html');
  if (!me) return;
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModal));
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('btn-start-moveout').addEventListener('click', openStartMoveout);
  $('btn-run-daily').addEventListener('click', () => runAutomation('daily'));
  $('btn-send-waiting').addEventListener('click', () => runAutomation('send'));
  $('auto-settings').addEventListener('submit', saveAutoSettings);
  showTab((location.hash || '#overview').slice(1));
  await loadAll();
  runAutomation('send', { quiet: true }); // anything left waiting
});

function showTab(name) {
  if (!document.querySelector(`[data-panel="${name}"]`)) name = 'overview';
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  history.replaceState(null, '', '#' + name);
}

/* ================================================================ LOAD */
async function loadAll() {
  const sb = supabaseClient;
  const res = await Promise.all([
    sb.from('rental_recruitment_settings').select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('leases').select('*, properties:property_id ( address )').order('start_date', { ascending: false }),
    sb.from('profiles').select('id, full_name, email, role'),
    sb.from('notices').select('*').order('created_at', { ascending: false }),
    sb.from('tenancy_endings').select('*').order('end_date', { ascending: true }),
    sb.from('deposit_movements').select('*').order('movement_date', { ascending: true }),
    sb.from('lease_deposits').select('*'),
    sb.rpc('arrears_overview'),
    sb.from('arrears_letters').select('*').order('created_at', { ascending: false }),
    sb.from('tenancy_notifications').select('*').order('id', { ascending: false }).limit(60),
    sb.from('tenancy_automation_runs').select('*').order('id', { ascending: false }).limit(7),
    sb.from('lease_escalations').select('*').or('applied.is.null,applied.eq.false'),
    sb.from('rental_vacancies').select('id, property_id, title, area, description, bedrooms, bathrooms, parking_bays, max_occupants, pets_policy, features, monthly_rent, deposit, photos, created_at').order('created_at', { ascending: false }),
  ]);
  const firstErr = res.find((r) => r.error);
  if (firstErr) {
    $('automation-banner').className = 'mb-6 rounded-xl px-4 py-3 text-sm bg-red-50 text-red-700';
    $('automation-banner').textContent = `Could not load tenancy data: ${firstErr.error.message}. Has 027_tenancy_lifecycle.sql been run?`;
    return;
  }
  const [st, leases, profiles, notices, endings, moves, accounts, arrears, letters, emails, runs, escalations, vacancies] = res.map((r) => r.data);
  settings = st;
  const prof = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  S = { leases: leases || [], prof, notices: notices || [], endings: endings || [], moves: moves || [], accounts: Object.fromEntries((accounts || []).map((a) => [a.lease_id, a])),
        arrears: arrears || [], letters: letters || [], emails: emails || [], runs: runs || [], escalations: escalations || [], vacancies: vacancies || [] };
  S.leaseById = Object.fromEntries(S.leases.map((l) => [String(l.id), l]));
  renderAll();
}

const leaseLabel = (l) => (l ? `${esc(S.prof[l.tenant_id]?.full_name || 'Tenant')} · ${esc(oneLine(l.properties?.address || ''))}` : 'Unknown lease');
const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ', ');

function depositPosition(leaseId) {
  const rows = S.moves.filter((m) => String(m.lease_id) === String(leaseId));
  const sum = (t) => rows.filter((m) => m.movement_type === t).reduce((a, m) => a + Number(m.amount), 0);
  const received = sum('received'), interest = sum('interest'), deductions = sum('deduction'), refunded = sum('refund');
  return { rows, received, interest, deductions, refunded, held: Math.round((received + interest - deductions - refunded) * 100) / 100 };
}

function renderAll() {
  const newNotices = S.notices.filter((n) => n.status === 'New');
  const open = S.endings.filter((e) => !['Closed', 'Cancelled'].includes(e.status));
  const drafts = S.letters.filter((l) => l.status === 'Draft');
  const heldTotal = S.leases.reduce((a, l) => a + Math.max(0, depositPosition(l.id).held), 0);
  const arrearsTotal = S.arrears.reduce((a, r) => a + Number(r.amount), 0);
  $('kpi-notices').textContent = newNotices.length;
  $('kpi-moveouts').textContent = open.length;
  $('kpi-deposits').textContent = money(heldTotal);
  $('kpi-arrears').textContent = S.arrears.length ? `${money(arrearsTotal)} (${S.arrears.length})` : 'R0';
  $('kpi-letters').textContent = drafts.length;
  const badge = (key, n, cls) => { const el = document.querySelector(`[data-count="${key}"]`); if (el) el.innerHTML = n ? pill(String(n), cls) : ''; };
  badge('notices', newNotices.length, 'bg-blue-600 text-white');
  badge('moveouts', open.length, 'bg-gold text-navy-deep');
  badge('arrears', S.arrears.length, 'bg-red-600 text-white');
  document.querySelectorAll('[data-setting]').forEach((el) => { const v = settings?.[el.dataset.setting]; if (v !== undefined && v !== null) el.textContent = el.dataset.setting.endsWith('start') ? dt(v) : v; });
  renderBanner();
  renderAttention(newNotices, open, drafts);
  renderUpcoming();
  renderNotices();
  renderMoveouts();
  renderDeposits();
  renderArrears();
  renderEmails();
  fillAutoSettings();
}

function renderBanner() {
  const el = $('automation-banner');
  const last = S.runs[0];
  const hours = last ? (Date.now() - new Date(last.ran_at)) / 3600000 : Infinity;
  if (settings && settings.notifications_enabled === false) {
    el.className = 'mb-6 rounded-xl px-4 py-3 text-sm bg-red-50 text-red-700';
    el.textContent = 'Automatic emails are switched off (Tenant Recruitment → Screening settings). Tenants and owners are not being notified.';
  } else if (settings && settings.lease_automation_enabled === false) {
    el.className = 'mb-6 rounded-xl px-4 py-3 text-sm bg-amber-50 text-amber-800';
    el.textContent = 'The daily lease automation is switched off (Emails & automation tab). Expiry notices, rollovers, escalations and arrears reminders will not happen.';
  } else if (hours > 36) {
    el.className = 'mb-6 rounded-xl px-4 py-3 text-sm bg-amber-50 text-amber-800';
    el.innerHTML = last
      ? `The daily automation last ran ${esc(dtt(last.ran_at))}. Check the Supabase Cron schedule for <strong>tenancy-automation</strong>, or use “Run daily checks now”.`
      : 'The daily automation has not run yet. Set up the Supabase Cron schedule for <strong>tenancy-automation</strong> (see the deployment notes), or use “Run daily checks now” in the Emails &amp; automation tab.';
  } else el.className = 'hidden';
}

function renderAttention(newNotices, open, drafts) {
  const items = [];
  const today = todayStr();
  newNotices.forEach((n) => items.push([0, `${n.short_notice ? '<span class="text-red-700 font-semibold">Short notice · </span>' : ''}New ${esc(n.type || 'notice')} from ${esc(S.prof[n.tenant_id]?.full_name || 'a tenant')}`, 'notices']));
  open.forEach((e) => {
    const l = S.leaseById[String(e.lease_id)];
    const dLeft = daysBetween(today, e.end_date);
    if (!e.inspection_at && dLeft <= 7) items.push([1, `Book the move-out inspection: ${leaseLabel(l)} (ends ${esc(dt(e.end_date))})`, 'moveouts']);
    if (e.refund_due_by && !e.refund_paid_on) {
      const d = daysBetween(today, e.refund_due_by);
      if (d < 0) items.push([0, `<span class="text-red-700 font-semibold">Deposit refund overdue</span> since ${esc(dt(e.refund_due_by))}: ${leaseLabel(l)}`, 'moveouts']);
      else if (d <= 3) items.push([1, `Deposit refund due ${esc(dt(e.refund_due_by))}: ${leaseLabel(l)}`, 'moveouts']);
    }
    if (e.inspection_outcome === 'damage' && !e.restoration_completed_on) items.push([2, `Record when repairs are done (starts the 14-day refund clock): ${leaseLabel(l)}`, 'moveouts']);
    if (e.status === 'Deposit settled') items.push([3, `Ready to close and re-list: ${leaseLabel(l)}`, 'moveouts']);
  });
  if (drafts.length) items.push([1, `${drafts.length} letter${drafts.length === 1 ? '' : 's'} of demand to review`, 'arrears']);
  const manual = S.arrears.filter((a) => !a.automated);
  if (manual.length) items.push([2, `${manual.length} older overdue payment${manual.length === 1 ? '' : 's'} (before automation) need your follow-up or marking as paid`, 'arrears']);
  S.leases.filter((l) => l.status === 'Active' && l.end_date && l.end_date < today).forEach((l) => items.push([1, `Lease past its end date but still Active: ${leaseLabel(l)}. Create the renewal or start a move-out.`, 'overview']));
  const noDeposit = S.leases.filter((l) => ['Active', 'Active_Month_to_Month'].includes(l.status) && Number(l.deposit_required) > 0 && depositPosition(l.id).received === 0);
  if (noDeposit.length) items.push([3, `${noDeposit.length} active lease${noDeposit.length === 1 ? ' has' : 's have'} no deposit receipt recorded yet`, 'deposits']);
  items.sort((a, b) => a[0] - b[0]);
  $('attention-list').innerHTML = items.length
    ? items.map(([, html, tab]) => `<li class="flex items-start justify-between gap-3"><span>${html}</span><button class="text-gold font-semibold hover:underline flex-shrink-0" data-go="${tab}">Open</button></li>`).join('')
    : '<li class="text-gray-500">Nothing needs attention right now.</li>';
  $('attention-list').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
}

function renderUpcoming() {
  const today = todayStr();
  const horizon = addDays(today, 183);
  const items = [];
  S.leases.filter((l) => l.status === 'Active' && l.end_date && l.end_date >= today && l.end_date <= horizon).forEach((l) => {
    const sent = S.emails.some((n) => n.event_type === 'lease_expiry_notice' && String(n.lease_id) === String(l.id));
    items.push([l.end_date, `Lease ends ${esc(dt(l.end_date))}: ${leaseLabel(l)} ${sent ? pill('expiry notice sent', 'bg-green-100 text-green-700') : pill('notice due 40–80 business days before', 'bg-gray-100 text-gray-600')}`]);
  });
  S.escalations.filter((e) => e.effective_date >= today && e.effective_date <= horizon).forEach((e) => {
    const l = S.leaseById[String(e.lease_id)];
    items.push([e.effective_date, `Rent +${Number(e.percentage)}% to ${money(e.new_rental_amount)} on ${esc(dt(e.effective_date))}: ${leaseLabel(l)}`]);
  });
  items.sort((a, b) => a[0].localeCompare(b[0]));
  $('upcoming-list').innerHTML = items.length ? items.map(([, h]) => `<li>${h}</li>`).join('') : '<li class="text-gray-500">No lease ends or escalations in the next 6 months.</li>';
}

/* ================================================================ NOTICES */
function renderNotices() {
  const body = $('notices-tbody');
  if (!S.notices.length) { body.innerHTML = '<tr><td colspan="6" class="py-6 px-3 text-gray-400">No notices yet. Tenants submit them from their portal.</td></tr>'; return; }
  body.innerHTML = S.notices.map((n) => {
    const l = S.leaseById[String(n.lease_id)];
    const vacate = n.type === 'Notice to Vacate';
    return `<tr class="border-b border-gray-100 last:border-0 align-top">
      <td class="py-3 px-3 whitespace-nowrap text-gray-600">${esc(dtt(n.created_at))}</td>
      <td class="py-3 px-3"><p class="font-semibold text-navy">${esc(S.prof[n.tenant_id]?.full_name || 'Tenant')}</p><p class="text-xs text-gray-500">${l ? esc(oneLine(l.properties?.address || '')) : '<span class="text-red-600">No active lease found</span>'}</p></td>
      <td class="py-3 px-3"><p class="text-navy">${esc(n.type || 'Notice')}</p>${n.message ? `<p class="text-xs text-gray-500 max-w-xs whitespace-pre-line">${esc(n.message)}</p>` : ''}</td>
      <td class="py-3 px-3">${vacate ? `${esc(dt(n.move_out_date))}<p class="text-xs ${n.short_notice ? 'text-red-700 font-semibold' : 'text-gray-400'}">Earliest allowed ${esc(dt(n.earliest_end_date))}${n.short_notice ? ' · short notice' : ''}</p>` : '—'}
        ${n.confirmed_end_date ? `<p class="text-xs text-green-700">Confirmed ${esc(dt(n.confirmed_end_date))}</p>` : ''}</td>
      <td class="py-3 px-3">${pill(n.status || 'New', STATUS_CLS[n.status || 'New'])}</td>
      <td class="py-3 px-3 text-right">${(n.status || 'New') === 'New' ? `<button class="text-gold font-semibold hover:underline" data-ack="${esc(String(n.id))}">${vacate ? 'Acknowledge' : 'Mark handled'}</button>` : ''}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', () => openAck(S.notices.find((n) => String(n.id) === b.dataset.ack))));
}

function openAck(n) {
  const vacate = n.type === 'Notice to Vacate';
  const suggested = [n.move_out_date, n.earliest_end_date].filter(Boolean).sort().pop() || '';
  openModal(vacate ? 'Acknowledge notice to vacate' : 'Mark notice handled', `
    <form id="ack-form" class="space-y-4 text-sm">
      <p class="text-gray-600">${esc(S.prof[n.tenant_id]?.full_name || 'Tenant')} · ${esc(n.type)}</p>
      ${vacate ? `<div><label class="field-label" for="ack-date">Tenancy ends on (last day) *</label><input id="ack-date" type="date" class="field" required value="${esc(suggested)}">
        <p class="text-xs text-gray-500 mt-1">They asked for ${esc(dt(n.move_out_date))}. The earliest the law requires you to accept is ${esc(dt(n.earliest_end_date))}; you may agree to an earlier date.</p></div>` : ''}
      <div><label class="field-label" for="ack-note">Internal note (optional)</label><textarea id="ack-note" rows="2" class="field"></textarea></div>
      ${vacate ? '<p class="text-xs text-gray-500">The tenant is emailed the confirmed end date and what happens next; the owner is told. A move-out case opens.</p>' : ''}
      <p id="ack-err" class="hidden text-red-600"></p>
      <button class="btn btn-primary !py-2.5 text-sm">${vacate ? 'Confirm end date' : 'Mark handled'}</button>
    </form>`);
  $('ack-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await supabaseClient.rpc('acknowledge_notice', { p_notice_ref: String(n.id), p_end_date: vacate ? $('ack-date').value : null, p_note: $('ack-note').value.trim() || null });
    if (error) { $('ack-err').textContent = error.message; $('ack-err').classList.remove('hidden'); return; }
    closeModal(); await afterChange(vacate ? 'Notice acknowledged. The tenant and owner are being emailed.' : 'Notice marked as handled.');
    if (vacate) showTab('moveouts');
  });
}

/* ================================================================ MOVE-OUTS */
function renderMoveouts() {
  const open = S.endings.filter((e) => !['Closed', 'Cancelled'].includes(e.status));
  const done = S.endings.filter((e) => ['Closed', 'Cancelled'].includes(e.status));
  $('moveouts-closed').innerHTML = done.length ? done.map((e) => `<p>${pill(e.status, STATUS_CLS[e.status])} ${leaseLabel(S.leaseById[String(e.lease_id)])} · ended ${esc(dt(e.end_date))}</p>`).join('') : '<p class="text-gray-400">None.</p>';
  if (!open.length) { $('moveouts-list').innerHTML = '<div class="panel p-6 text-gray-500">No tenancies are ending. Acknowledged notices, and leases you choose not to renew, appear here.</div>'; return; }
  const today = todayStr();
  $('moveouts-list').innerHTML = open.map((e) => {
    const l = S.leaseById[String(e.lease_id)];
    const pos = depositPosition(e.lease_id);
    const dLeft = daysBetween(today, e.end_date);
    const inWindow = e.inspection_at && (() => { const d = new Date(e.inspection_at).toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); return d >= addDays(e.end_date, -3) && d <= e.end_date; })();
    const refundState = e.refund_paid_on ? `<span class="text-green-700 font-semibold">Refunded ${esc(dt(e.refund_paid_on))}</span>`
      : e.refund_due_by ? (daysBetween(today, e.refund_due_by) < 0 ? `<span class="text-red-700 font-semibold">Overdue since ${esc(dt(e.refund_due_by))}</span>` : `Due by <strong>${esc(dt(e.refund_due_by))}</strong> (${daysBetween(today, e.refund_due_by)} days)`)
      : (e.inspection_outcome === 'damage' ? 'Due 14 days after repairs are finished' : 'Set once the inspection outcome is recorded');
    const listing = e.relisted_vacancy_id ? S.vacancies.find((v) => v.id === e.relisted_vacancy_id) : null;
    const canClose = !!e.refund_paid_on || (pos.held <= 0.009 && !!e.inspection_outcome);
    return `<article class="panel p-6" data-ending="${e.id}">
      <div class="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div><p class="font-display font-semibold text-navy text-lg">${leaseLabel(l)}</p>
          <p class="text-sm text-gray-500">Lease ${'#' + esc(e.lease_id)} · ${e.source === 'tenant_notice' ? 'tenant gave notice' : e.source === 'not_renewing' ? 'not renewing' : 'mutual agreement'} · last day <strong>${esc(dt(e.end_date))}</strong> ${dLeft >= 0 ? `(${dLeft} days)` : `(${-dLeft} days ago)`}</p></div>
        ${pill(e.status, STATUS_CLS[e.status])}
      </div>
      <div class="grid lg:grid-cols-2 gap-6 text-sm min-w-0">
        <div class="space-y-5 min-w-0">
          <div class="step ${e.inspection_at ? 'done' : 'now'}">
            <p class="font-semibold text-navy">1. Move-out inspection</p>
            <p class="text-xs text-gray-500 mb-2">Jointly with the tenant, in the last 3 days of the lease (${esc(dt(addDays(e.end_date, -3)))} – ${esc(dt(e.end_date))}).</p>
            ${e.inspection_at ? `<p>Booked: <strong>${esc(dtt(e.inspection_at))}</strong> ${inWindow ? '' : '<span class="text-red-700 font-semibold">· outside the last 3 days</span>'}</p>` : ''}
            <div class="flex flex-wrap items-end gap-2 mt-2"><input type="datetime-local" class="field !w-auto max-w-full !py-2" data-insp-input value="${e.inspection_at ? esc(toLocalInput(e.inspection_at)) : esc(addDays(e.end_date, -1) + 'T10:00')}">
              <button class="btn btn-outline-navy !py-2 !px-4 text-sm" data-act="inspection">${e.inspection_at ? 'Change' : 'Book & email tenant'}</button>
              <a class="text-gold font-semibold hover:underline" href="inspection.html">Open the inspection form</a></div>
          </div>
          <div class="step ${e.inspection_outcome ? 'done' : e.inspection_at ? 'now' : ''}">
            <p class="font-semibold text-navy">2. Outcome</p>
            <div class="flex flex-wrap items-end gap-2 mt-2">
              <select class="field !w-auto max-w-full !py-2" data-outcome>
                <option value="">Choose…</option>
                <option value="no_damage" ${e.inspection_outcome === 'no_damage' ? 'selected' : ''}>No damage (refund within 7 days)</option>
                <option value="damage" ${e.inspection_outcome === 'damage' ? 'selected' : ''}>Damage to repair (refund 14 days after repairs)</option>
                <option value="tenant_absent" ${e.inspection_outcome === 'tenant_absent' ? 'selected' : ''}>Tenant didn't attend (refund within 21 days)</option>
              </select>
              <button class="btn btn-outline-navy !py-2 !px-4 text-sm" data-act="outcome">Save</button></div>
            ${e.inspection_outcome === 'damage' ? `<div class="flex flex-wrap items-end gap-2 mt-2"><label class="text-xs text-gray-500">Repairs finished on<input type="date" class="field !w-auto max-w-full !py-2 mt-1" data-restored value="${esc(e.restoration_completed_on || '')}"></label>
              <button class="btn btn-outline-navy !py-2 !px-4 text-sm" data-act="restored">Save</button></div>` : ''}
            <p class="mt-2">Refund: ${refundState}</p>
          </div>
        </div>
        <div class="space-y-5 min-w-0">
          <div class="step ${e.refund_paid_on ? 'done' : e.inspection_outcome ? 'now' : ''}">
            <p class="font-semibold text-navy">3. Deposit</p>
            <table class="w-full mt-2"><tbody>
              <tr><td class="text-gray-500 py-0.5">Received</td><td class="text-right">${money(pos.received)}</td></tr>
              <tr><td class="text-gray-500 py-0.5">Interest</td><td class="text-right">${money(pos.interest)}</td></tr>
              ${pos.rows.filter((m) => m.movement_type === 'deduction').map((m) => `<tr><td class="text-gray-500 py-0.5">− ${esc(m.description)} ${m.receipt_path ? `<button class="text-gold text-xs hover:underline" data-receipt="${esc(m.receipt_path)}">receipt</button>` : ''}</td><td class="text-right">−${money(m.amount)}</td></tr>`).join('')}
              <tr><td class="text-gray-500 py-0.5">Refunded</td><td class="text-right">−${money(pos.refunded)}</td></tr>
              <tr class="border-t border-gray-200 font-semibold"><td class="py-1">Held now</td><td class="text-right">${money(pos.held)}</td></tr>
            </tbody></table>
            ${pos.received === 0 && Number(l?.deposit_required) > 0 ? `<p class="text-xs text-amber-700 mt-1">No deposit receipt recorded (lease requires ${money(l.deposit_required)}). Record it first.</p>` : ''}
            <div class="flex flex-wrap gap-2 mt-2">
              <button class="btn btn-outline-navy !py-1.5 !px-3 text-xs" data-act="mv-received">Deposit received</button>
              <button class="btn btn-outline-navy !py-1.5 !px-3 text-xs" data-act="mv-interest">Add interest</button>
              <button class="btn btn-outline-navy !py-1.5 !px-3 text-xs" data-act="mv-deduction">Add deduction</button>
              <button class="btn btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed" data-act="mv-refund" ${pos.held > 0.009 ? '' : 'disabled'}>Record refund</button>
              <button class="btn btn-outline-navy !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed" data-act="statement" ${pos.refunded > 0 ? '' : 'disabled'}>Email refund statement</button>
            </div>
          </div>
          <div class="step ${e.status === 'Closed' ? 'done' : canClose ? 'now' : ''}">
            <p class="font-semibold text-navy">4. Re-let and close</p>
            <div class="flex flex-wrap gap-2 mt-2">
              ${listing ? `<a class="btn btn-outline-navy !py-1.5 !px-3 text-xs" href="tenant-recruitment.html">Listing: ${esc(listing.title)}</a>` : '<button class="btn btn-outline-navy !py-1.5 !px-3 text-xs" data-act="relist">Create new listing (draft)</button>'}
              <button class="btn btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed" data-act="close" ${canClose ? '' : 'disabled title="Record the refund first"'}>Close tenancy</button>
              <button class="text-xs text-gray-500 hover:text-red-700" data-act="cancel">Cancel move-out</button>
            </div>
          </div>
        </div>
      </div>
    </article>`;
  }).join('');
  $('moveouts-list').querySelectorAll('[data-ending]').forEach((card) => {
    const e = S.endings.find((x) => x.id === card.dataset.ending);
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => moveoutAction(e, b.dataset.act, card)));
    card.querySelectorAll('[data-receipt]').forEach((b) => b.addEventListener('click', () => openReceipt(b.dataset.receipt)));
  });
}

function toLocalInput(iso) {
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function updateEnding(e, patch, message) {
  const { error } = await supabaseClient.from('tenancy_endings').update(patch).eq('id', e.id);
  if (error) return toast(error.message, true);
  await afterChange(message);
}

async function moveoutAction(e, act, card) {
  const l = S.leaseById[String(e.lease_id)];
  if (act === 'inspection') {
    const v = card.querySelector('[data-insp-input]').value;
    if (!v) return toast('Choose a date and time.', true);
    const day = v.slice(0, 10);
    if ((day < addDays(e.end_date, -3) || day > e.end_date) && !confirm('The Rental Housing Act expects the joint inspection in the last 3 days of the lease. Book this time anyway?')) return;
    return updateEnding(e, { inspection_at: new Date(v).toISOString() }, 'Inspection booked. The tenant is being emailed.');
  }
  if (act === 'outcome') {
    const v = card.querySelector('[data-outcome]').value;
    if (!v) return toast('Choose the outcome.', true);
    return updateEnding(e, { inspection_outcome: v, outcome_recorded_on: todayStr() }, 'Outcome saved. The refund deadline is now set.');
  }
  if (act === 'restored') {
    const v = card.querySelector('[data-restored]').value;
    if (!v) return toast('Enter the date the repairs were finished.', true);
    return updateEnding(e, { restoration_completed_on: v }, 'Saved. The refund is due 14 days from that date.');
  }
  if (act.startsWith('mv-')) return openMovement(e.lease_id, act.slice(3), e);
  if (act === 'statement') {
    const { error } = await supabaseClient.from('tenancy_notifications').insert([{ event_type: 'deposit_refund_statement', lease_id: e.lease_id, ending_id: e.id, requested_by: me.id }]);
    if (error) return toast(error.message, true);
    return afterChange('Refund statement queued to the tenant (admin cc\'d).');
  }
  if (act === 'relist') return relist(e, l);
  if (act === 'close') {
    if (!confirm(`Close the tenancy for ${S.prof[l?.tenant_id]?.full_name || 'this tenant'}? The lease is marked Expired, the unit Vacant, and the owner is told.`)) return;
    return updateEnding(e, { status: 'Closed' }, 'Tenancy closed. The owner is being told.');
  }
  if (act === 'cancel') {
    if (!confirm('Cancel this move-out (for example, the tenant withdrew their notice)? The lease carries on as before.')) return;
    return updateEnding(e, { status: 'Cancelled' }, 'Move-out cancelled.');
  }
}

async function relist(e, l) {
  const last = S.vacancies.find((v) => String(v.property_id) === String(l?.property_id));
  const row = last
    ? { property_id: last.property_id, title: last.title, area: last.area, description: last.description, bedrooms: last.bedrooms, bathrooms: last.bathrooms, parking_bays: last.parking_bays,
        max_occupants: last.max_occupants, pets_policy: last.pets_policy, features: last.features, monthly_rent: l?.monthly_rent || last.monthly_rent, deposit: last.deposit }
    : { property_id: l.property_id, title: 'Apartment to let', area: 'Kensington, Johannesburg', monthly_rent: l?.monthly_rent || 1 };
  const { data, error } = await supabaseClient.from('rental_vacancies').insert([{ ...row, status: 'Draft', available_from: addDays(e.end_date, 1), created_by: me.id }]).select().single();
  if (error) return toast(error.message, true);
  await supabaseClient.from('tenancy_endings').update({ relisted_vacancy_id: data.id }).eq('id', e.id);
  await afterChange(last ? 'Draft listing created from the previous one (add fresh photos, then Open it in Tenant Recruitment).' : 'Draft listing created. Complete it in Tenant Recruitment.');
  supabaseClient.functions.invoke('rental-notifications', { body: {} }).catch(() => {});
}

function openStartMoveout() {
  const busy = new Set(S.endings.filter((e) => !['Closed', 'Cancelled'].includes(e.status)).map((e) => String(e.lease_id)));
  const leases = S.leases.filter((l) => ['Active', 'Active_Month_to_Month'].includes(l.status) && !busy.has(String(l.id)));
  openModal('Start a move-out', `
    <form id="start-form" class="space-y-4 text-sm">
      <div><label class="field-label" for="sm-lease">Lease *</label><select id="sm-lease" class="field" required><option value="">Choose…</option>
        ${leases.map((l) => `<option value="${l.id}" data-end="${esc(l.end_date || '')}">${leaseLabel(l)} (ends ${esc(dt(l.end_date))})</option>`).join('')}</select></div>
      <div><label class="field-label" for="sm-source">Why is it ending? *</label><select id="sm-source" class="field">
        <option value="not_renewing">We are not renewing at the end of the term</option><option value="mutual">Agreed with the tenant</option></select></div>
      <div><label class="field-label" for="sm-end">Last day of the tenancy *</label><input id="sm-end" type="date" class="field" required></div>
      <p class="text-xs text-gray-500">For a tenant's own notice, use the Notices tab instead. The tenant is emailed the end date and the move-out steps; the owner is told.</p>
      <p id="sm-err" class="hidden text-red-600"></p>
      <button class="btn btn-primary !py-2.5 text-sm">Start move-out</button>
    </form>`);
  $('sm-lease').addEventListener('change', (ev) => { const end = ev.target.selectedOptions[0]?.dataset.end; if (end) $('sm-end').value = end; });
  $('start-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { error } = await supabaseClient.from('tenancy_endings').insert([{ lease_id: Number($('sm-lease').value), source: $('sm-source').value, end_date: $('sm-end').value, created_by: me.id }]);
    if (error) { $('sm-err').textContent = error.message; $('sm-err').classList.remove('hidden'); return; }
    closeModal(); await afterChange('Move-out started. The tenant and owner are being emailed.'); showTab('moveouts');
  });
}

/* ================================================================ DEPOSITS */
function renderDeposits() {
  const leases = S.leases.filter((l) => Number(l.deposit_required) > 0 || depositPosition(l.id).rows.length);
  if (!leases.length) { $('deposits-tbody').innerHTML = '<tr><td colspan="9" class="py-6 px-3 text-gray-400">No deposits yet.</td></tr>'; return; }
  $('deposits-tbody').innerHTML = leases.map((l) => {
    const p = depositPosition(l.id);
    const acc = S.accounts[l.id];
    return `<tr class="border-b border-gray-100 last:border-0 align-top">
      <td class="py-3 px-3"><p class="font-semibold text-navy">${esc(S.prof[l.tenant_id]?.full_name || 'Tenant')}</p><p class="text-xs text-gray-500">${esc(oneLine(l.properties?.address || ''))} · ${esc(l.status)}</p></td>
      <td class="py-3 px-3 text-xs">${acc?.bank_name ? `${esc(acc.bank_name)}${acc.account_reference ? ' · ' + esc(acc.account_reference) : ''}${acc.interest_rate_annual ? `<br>${Number(acc.interest_rate_annual)}% p.a.` : ''}` : '<span class="text-amber-700">Not recorded</span>'}</td>
      <td class="py-3 px-3 text-right">${money(l.deposit_required)}</td>
      <td class="py-3 px-3 text-right ${p.received === 0 && Number(l.deposit_required) > 0 ? 'text-amber-700' : ''}">${money(p.received)}</td>
      <td class="py-3 px-3 text-right">${money(p.interest)}</td><td class="py-3 px-3 text-right">${money(p.deductions)}</td><td class="py-3 px-3 text-right">${money(p.refunded)}</td>
      <td class="py-3 px-3 text-right font-semibold">${money(p.held)}</td>
      <td class="py-3 px-3 text-right whitespace-nowrap"><button class="text-gold font-semibold hover:underline" data-dep-acc="${l.id}">Account</button> · <button class="text-gold font-semibold hover:underline" data-dep-add="${l.id}">Add entry</button></td>
    </tr>`;
  }).join('');
  $('deposits-tbody').querySelectorAll('[data-dep-acc]').forEach((b) => b.addEventListener('click', () => openAccount(b.dataset.depAcc)));
  $('deposits-tbody').querySelectorAll('[data-dep-add]').forEach((b) => b.addEventListener('click', () => openMovement(b.dataset.depAdd, null, null)));
}

function openAccount(leaseId) {
  const a = S.accounts[leaseId] || {};
  openModal('Where this deposit is held', `
    <form id="acc-form" class="grid sm:grid-cols-2 gap-4 text-sm">
      <div><label class="field-label" for="acc-bank">Bank</label><input id="acc-bank" class="field" value="${esc(a.bank_name || '')}"></div>
      <div><label class="field-label" for="acc-name">Account name</label><input id="acc-name" class="field" value="${esc(a.account_name || '')}" placeholder="Zanka Group Deposit Account"></div>
      <div><label class="field-label" for="acc-ref">Reference / sub-account</label><input id="acc-ref" class="field" value="${esc(a.account_reference || '')}"></div>
      <div><label class="field-label" for="acc-rate">Interest rate (% a year)</label><input id="acc-rate" type="number" step="0.01" min="0" max="30" class="field" value="${esc(a.interest_rate_annual ?? '')}"></div>
      <div class="sm:col-span-2"><label class="field-label" for="acc-notes">Notes</label><textarea id="acc-notes" rows="2" class="field">${esc(a.notes || '')}</textarea></div>
      <p class="sm:col-span-2 text-xs text-gray-500">Must be an interest-bearing account at no less than a savings rate, with interest for the tenant (Rental Housing Act). Don't store full account numbers here.</p>
      <p id="acc-err" class="hidden sm:col-span-2 text-red-600"></p>
      <div class="sm:col-span-2"><button class="btn btn-primary !py-2.5 text-sm">Save</button></div>
    </form>`);
  $('acc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await supabaseClient.from('lease_deposits').upsert([{ lease_id: Number(leaseId), bank_name: $('acc-bank').value.trim() || null, account_name: $('acc-name').value.trim() || null,
      account_reference: $('acc-ref').value.trim() || null, interest_rate_annual: $('acc-rate').value === '' ? null : Number($('acc-rate').value), notes: $('acc-notes').value.trim() || null, updated_by: me.id, updated_at: new Date().toISOString() }]);
    if (error) { $('acc-err').textContent = error.message; $('acc-err').classList.remove('hidden'); return; }
    closeModal(); await afterChange('Deposit account saved.', { noSend: true });
  });
}

function openMovement(leaseId, type, ending) {
  const l = S.leaseById[String(leaseId)];
  const pos = depositPosition(leaseId);
  const labels = { received: 'Deposit received', interest: 'Interest earned', deduction: 'Deduction', refund: 'Refund paid to tenant' };
  const defAmount = type === 'refund' ? pos.held : type === 'received' ? (Number(l?.deposit_required) || '') : '';
  openModal(type ? labels[type] : 'Add deposit entry', `
    <form id="mv-form" class="space-y-4 text-sm">
      <p class="text-gray-600">${leaseLabel(l)} · held now ${money(pos.held)}</p>
      <div><label class="field-label" for="mv-type">Type</label><select id="mv-type" class="field">${Object.entries(labels).map(([k, v]) => `<option value="${k}" ${k === type ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="grid grid-cols-2 gap-4">
        <div><label class="field-label" for="mv-amount">Amount (R) *</label><input id="mv-amount" type="number" step="0.01" min="0.01" class="field" required value="${esc(defAmount)}"></div>
        <div><label class="field-label" for="mv-date">Date *</label><input id="mv-date" type="date" class="field" required value="${esc(todayStr())}"></div>
      </div>
      <div><label class="field-label" for="mv-desc">Description <span data-desc-req class="text-red-600">*</span></label><input id="mv-desc" class="field" placeholder="e.g. Replace broken blind in bedroom 2"></div>
      <div data-receipt-wrap><label class="field-label" for="mv-file">Receipt or invoice *</label><input id="mv-file" type="file" accept=".pdf,image/*" class="block w-full text-sm">
        <p class="text-xs text-gray-500 mt-1">Required for deductions. Only damage beyond fair wear and tear, unpaid amounts, or extra cleaning may be deducted.</p></div>
      <p id="mv-err" class="hidden text-red-600"></p>
      <button class="btn btn-primary !py-2.5 text-sm">Save</button>
    </form>`);
  const sync = () => { const t = $('mv-type').value; document.querySelector('[data-receipt-wrap]').classList.toggle('hidden', t !== 'deduction'); document.querySelector('[data-desc-req]').classList.toggle('hidden', t !== 'deduction'); };
  $('mv-type').addEventListener('change', sync); sync();
  $('mv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = (m) => { $('mv-err').textContent = m; $('mv-err').classList.remove('hidden'); };
    const t = $('mv-type').value; const amount = Number($('mv-amount').value);
    if (!(amount > 0)) return err('Enter an amount.');
    if (t === 'refund' && amount > pos.held + 0.009 && !confirm(`That is more than the ${money(pos.held)} held. Save anyway?`)) return;
    let receiptPath = null;
    if (t === 'deduction') {
      const f = $('mv-file').files[0];
      if (!$('mv-desc').value.trim()) return err('Describe what the deduction is for.');
      if (!f) return err('Attach the receipt or invoice.');
      receiptPath = `${leaseId}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\-]+/g, '_').slice(-80)}`;
      const up = await supabaseClient.storage.from('deposit-receipts').upload(receiptPath, f, { contentType: f.type || 'application/octet-stream' });
      if (up.error) return err('Receipt upload failed: ' + up.error.message);
    }
    const { error } = await supabaseClient.from('deposit_movements').insert([{ lease_id: Number(leaseId), movement_type: t, amount, movement_date: $('mv-date').value,
      description: $('mv-desc').value.trim() || null, receipt_path: receiptPath, ending_id: ending?.id || null, created_by: me.id }]);
    if (error) return err(error.message);
    if (t === 'refund' && ending && !ending.refund_paid_on) await supabaseClient.from('tenancy_endings').update({ refund_paid_on: $('mv-date').value }).eq('id', ending.id);
    closeModal(); await afterChange(t === 'refund' ? 'Refund recorded. Email the refund statement next.' : 'Saved.', { noSend: true });
  });
}

async function openReceipt(path) {
  const w = window.open('', '_blank');
  const { data, error } = await supabaseClient.storage.from('deposit-receipts').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) { w && w.close(); return toast('Could not open the receipt.', true); }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}

/* ================================================================ ARREARS */
function renderArrears() {
  if (!S.arrears.length) $('arrears-tbody').innerHTML = '<tr><td colspan="6" class="py-6 px-3 text-gray-400">No overdue rent.</td></tr>';
  else $('arrears-tbody').innerHTML = S.arrears.map((a) => `<tr class="border-b border-gray-100 last:border-0 align-top">
      <td class="py-3 px-3"><p class="font-semibold text-navy">${esc(a.tenant_name || 'Tenant')}</p><p class="text-xs text-gray-500">${esc(oneLine(a.property_address || ''))}</p></td>
      <td class="py-3 px-3 text-right font-semibold">${money(a.amount)}</td>
      <td class="py-3 px-3">${esc(dt(a.due_date))}</td>
      <td class="py-3 px-3 text-right ${a.days_overdue >= 14 ? 'text-red-700 font-semibold' : ''}">${a.days_overdue}</td>
      <td class="py-3 px-3">${a.automated ? `${a.reminders_sent} sent` : pill('manual (older balance)', 'bg-gray-100 text-gray-600')}</td>
      <td class="py-3 px-3">${a.letter_status ? pill(a.letter_status, STATUS_CLS[a.letter_status]) : (a.automated ? '<span class="text-gray-400 text-xs">at day ' + esc(settings?.arrears_demand_days ?? 14) + '</span>' : `<button class="text-gold font-semibold hover:underline" data-draft-letter="${esc(a.payment_ref)}">Prepare letter</button>`)}</td>
    </tr>`).join('');
  $('arrears-tbody').querySelectorAll('[data-draft-letter]').forEach((b) => b.addEventListener('click', async () => {
    const a = S.arrears.find((x) => x.payment_ref === b.dataset.draftLetter);
    if (!confirm(`Prepare a letter of demand for ${money(a.amount)} owed by ${a.tenant_name}? Nothing is sent until you approve it below. First make sure this payment is genuinely unpaid.`)) return;
    const { error } = await supabaseClient.from('arrears_letters').insert([{ payment_ref: a.payment_ref, tenant_id: a.tenant_id, lease_id: a.lease_id, amount: a.amount, due_date: a.due_date }]);
    if (error) return toast(error.message, true);
    await afterChange('Draft letter prepared. Review it below.', { noSend: true });
  }));

  const list = S.letters.filter((l) => l.status !== 'Cancelled');
  $('letters-list').innerHTML = list.length ? list.map((l) => {
    const lease = S.leaseById[String(l.lease_id)];
    return `<div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 p-4">
      <div><p class="font-semibold text-navy">${esc(S.prof[l.tenant_id]?.full_name || 'Tenant')} · ${money(l.amount)}</p>
        <p class="text-xs text-gray-500">${esc(oneLine(lease?.properties?.address || ''))} · was due ${esc(dt(l.due_date))}${l.status === 'Sent' ? ` · sent ${esc(dtt(l.sent_at))} · pay by ${esc(dt(l.remedy_by))}` : ''}</p></div>
      <div class="flex items-center gap-3">${pill(l.status, STATUS_CLS[l.status])}
        ${l.status === 'Draft' ? `<button class="btn btn-primary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed" data-letter-send="${l.id}">Approve &amp; send</button><button class="text-xs text-gray-500 hover:text-red-700" data-letter-cancel="${l.id}">Cancel</button>` : ''}
        ${l.status === 'Sent' ? `<a class="btn btn-outline-navy !py-1.5 !px-3 text-xs" href="notice-evidence.html?letter=${encodeURIComponent(l.id)}">Evidence</a>` : ''}</div>
    </div>`;
  }).join('') : '<p class="text-gray-400">No letters.</p>';
  $('letters-list').querySelectorAll('[data-letter-send]').forEach((b) => b.addEventListener('click', async () => {
    const l = S.letters.find((x) => x.id === b.dataset.letterSend);
    if (!confirm(`Send a formal letter of demand for ${money(l.amount)} to ${S.prof[l.tenant_id]?.full_name || 'the tenant'}?\n\nIt demands payment within 20 business days. Only send it if the amount is genuinely unpaid.`)) return;
    const { error } = await supabaseClient.from('arrears_letters').update({ status: 'Sent', sent_by: me.id }).eq('id', l.id);
    if (error) return toast(error.message, true);
    await afterChange('Letter of demand sent (admin cc\'d).');
  }));
  $('letters-list').querySelectorAll('[data-letter-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const { error } = await supabaseClient.from('arrears_letters').update({ status: 'Cancelled' }).eq('id', b.dataset.letterCancel);
    if (error) return toast(error.message, true);
    await afterChange('Letter cancelled.', { noSend: true });
  }));
}

/* ================================================================ EMAILS & AUTOMATION */
const EMAIL_LABELS = {
  notice_received: 'Notice received → tenant, admin, owner', ending_confirmed: 'End date confirmed → tenant + owner', move_out_inspection_scheduled: 'Move-out inspection → tenant',
  deposit_refund_statement: 'Deposit refund statement → tenant', tenancy_closed: 'Tenancy closed → owner', lease_expiry_notice: 'Lease expiry notice (CPA) → tenant + owner',
  lease_rolled_over: 'Now month to month → tenant + owner', escalation_notice: 'Rent escalation → tenant + owner', arrears_reminder: 'Rent reminder → tenant',
  letter_of_demand: 'Letter of demand → tenant', viewing_booked: 'Viewing booked → applicant', viewing_reminder: 'Viewing reminder → applicant',
  viewing_cancelled: 'Viewing cancelled → applicant', viewing_followup: 'After viewing: apply → applicant', tenant_account_created: 'Tenant account set-up → tenant', admin_alert: 'Alert → admin',
};
function renderEmails() {
  const waiting = S.emails.filter((m) => m.status === 'pending' || m.status === 'failed').length;
  $('tn-waiting').textContent = waiting ? `${waiting} waiting or failed` : '';
  $('tn-tbody').innerHTML = S.emails.length ? S.emails.map((m) => `<tr class="border-b border-gray-100 last:border-0 align-top">
      <td class="py-3 px-3 whitespace-nowrap text-gray-600">${esc(dtt(m.processed_at || m.created_at))}</td>
      <td class="py-3 px-3"><p class="text-navy">${esc(EMAIL_LABELS[m.event_type] || m.event_type)}</p>${m.detail?.kind ? `<p class="text-xs text-gray-500">${esc(String(m.detail.kind).replace(/_/g, ' '))}</p>` : m.detail?.stage ? `<p class="text-xs text-gray-500">${esc(String(m.detail.stage).replace('_', ' '))}</p>` : m.detail?.level ? `<p class="text-xs text-gray-500">reminder ${esc(m.detail.level)}</p>` : ''}</td>
      <td class="py-3 px-3 text-gray-600">${Array.isArray(m.recipients) && m.recipients.length ? m.recipients.map((r) => `<span class="block mb-1"><span class="text-navy">${esc((r.to || []).join(', '))}</span>${(r.cc || []).length ? `<span class="block text-xs text-gray-400">cc ${esc(r.cc.join(', '))}</span>` : ''}${r.evidence_id ? `<a class="text-xs text-gold font-semibold hover:underline" href="notice-evidence.html?id=${encodeURIComponent(r.evidence_id)}">Evidence #${esc(r.evidence_id)}</a>` : ''}${r.evidence_error ? `<span class="block text-xs text-red-600">Evidence not stored: ${esc(r.evidence_error)}</span>` : ''}</span>`).join('') : `<span class="text-gray-400">${esc(m.status === 'pending' || m.status === 'sending' ? 'Not sent yet' : (m.last_error || '—'))}</span>`}
        ${m.status === 'failed' && m.last_error ? `<p class="text-xs text-red-600 mt-1 break-words">${esc(m.last_error)}</p>` : ''}</td>
      <td class="py-3 px-3">${pill({ pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Not sent' }[m.status] || m.status, STATUS_CLS[m.status])}</td>
      <td class="py-3 px-3 text-right">${m.status === 'failed' || m.status === 'skipped' ? `<button class="text-gold font-semibold hover:underline" data-retry="${m.id}">Retry</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="py-6 px-3 text-gray-400">No tenancy emails yet.</td></tr>';
  $('tn-tbody').querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    const { error } = await supabaseClient.from('tenancy_notifications').update({ status: 'pending', attempts: 0, last_error: null }).eq('id', b.dataset.retry);
    if (error) return toast(error.message, true);
    runAutomation('send');
  }));
  $('runs-list').innerHTML = S.runs.length ? `<ul class="space-y-1">${S.runs.map((r) => {
    const s = r.summary || {};
    const parts = s.skipped ? [esc(s.skipped)] : Object.entries(s).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${esc(k.replace(/_/g, ' '))}`);
    return `<li><span class="text-gray-500">${esc(dtt(r.ran_at))}</span> · ${parts.length ? parts.join(', ') : 'nothing due'}</li>`;
  }).join('')}</ul>` : '<p class="text-gray-400">Not run yet.</p>';
}

function fillAutoSettings() {
  if (!settings) return;
  $('as-enabled').checked = settings.lease_automation_enabled !== false;
  $('as-r1').value = settings.arrears_reminder_1_days ?? 3;
  $('as-r2').value = settings.arrears_reminder_2_days ?? 7;
  $('as-demand').value = settings.arrears_demand_days ?? 14;
  $('as-start').value = settings.arrears_automation_start || '';
}
async function saveAutoSettings(e) {
  e.preventDefault();
  const msg = $('as-msg');
  const row = { lease_automation_enabled: $('as-enabled').checked, arrears_reminder_1_days: Number($('as-r1').value), arrears_reminder_2_days: Number($('as-r2').value),
    arrears_demand_days: Number($('as-demand').value), arrears_automation_start: $('as-start').value || todayStr(), updated_by: me.id };
  msg.classList.remove('hidden', 'text-red-600', 'text-green-700');
  if (!(row.arrears_reminder_1_days < row.arrears_reminder_2_days && row.arrears_reminder_2_days < row.arrears_demand_days)) { msg.textContent = 'The days must increase: first reminder < second reminder < letter of demand.'; msg.classList.add('text-red-600'); return; }
  const { error } = await supabaseClient.from('rental_recruitment_settings').update(row).eq('id', settings.id);
  if (error) { msg.textContent = error.message; msg.classList.add('text-red-600'); return; }
  msg.textContent = 'Saved.'; msg.classList.add('text-green-700');
  await loadAll();
}

let running = null;
async function runAutomation(action, opts = {}) {
  if (running) return running;
  const btn = action === 'daily' ? $('btn-run-daily') : $('btn-send-waiting');
  if (!opts.quiet) { btn.disabled = true; btn.textContent = action === 'daily' ? 'Running…' : 'Sending…'; }
  running = (async () => {
    try {
      const { data, error } = await supabaseClient.functions.invoke('tenancy-automation', { body: { action } });
      if (error) throw error;
      const em = action === 'daily' ? data.emails : data;
      if (!opts.quiet) toast(action === 'daily' ? `Checks done. ${em.sent} email${em.sent === 1 ? '' : 's'} sent${em.failed ? `, ${em.failed} failed` : ''}.` : em.processed ? `${em.sent} sent, ${em.failed} failed.` : 'No emails were waiting.', !!em.failed);
      else if (em && em.failed) toast(`${em.failed} tenancy email${em.failed === 1 ? '' : 's'} could not be sent. See Emails & automation.`, true);
    } catch (err) {
      if (!opts.quiet) toast(`Could not reach the tenancy-automation function (${err.message || 'connection problem'}). Is it deployed?`, true);
    } finally {
      running = null;
      if (!opts.quiet) { btn.disabled = false; btn.textContent = action === 'daily' ? 'Run daily checks now' : 'Send waiting emails now'; }
      await loadAll();
    }
  })();
  return running;
}

async function afterChange(message, opts = {}) {
  toast(message);
  await loadAll();
  if (!opts.noSend) runAutomation('send', { quiet: true });
}

/* ================================================================ UI helpers */
function openModal(title, html) { $('modal-title').textContent = title; $('modal-body').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); $('modal-body').innerHTML = ''; }
function toast(message, isError) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status');
    el.className = 'fixed bottom-5 right-5 left-5 sm:left-auto sm:max-w-md z-[60] rounded-xl px-4 py-3 text-sm shadow-lg transition-opacity';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `fixed bottom-5 right-5 left-5 sm:left-auto sm:max-w-md z-[60] rounded-xl px-4 py-3 text-sm shadow-lg transition-opacity ${isError ? 'bg-red-600' : 'bg-navy'} text-white`;
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('opacity-0'), isError ? 9000 : 5000);
}
