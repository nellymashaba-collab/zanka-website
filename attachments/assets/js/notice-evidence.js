// Zanka Group — Evidence of service (notice-evidence.html)
// Shows formal notices exactly as they were emailed, with the email
// provider's message ID, delivery events and a SHA-256 fingerprint that the
// browser re-checks independently. Data: 029_notice_evidence.sql.
//
//   notice-evidence.html               register of all evidence records
//   notice-evidence.html?id=12         one record
//   notice-evidence.html?letter=<uuid> everything sent for a letter of demand
//   notice-evidence.html?notification=<id>  everything sent for one email event

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sast = (d) => (d ? new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' SAST' : '—');
const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ', ');

const EVENT_LABELS = {
  letter_of_demand: 'Letter of demand', arrears_reminder: 'Rent reminder', notice_received: 'Notice received (acknowledgement)',
  ending_confirmed: 'Tenancy end date confirmed', move_out_inspection_scheduled: 'Move-out inspection notice', deposit_refund_statement: 'Deposit refund statement',
  tenancy_closed: 'Tenancy closed', lease_expiry_notice: 'Lease expiry notice (CPA s14)', lease_rolled_over: 'Lease continues month to month', escalation_notice: 'Rent escalation notice',
};
const DELIVERY_LABELS = {
  'email.sent': ['Accepted for delivery by Resend', 'bg-blue-100 text-blue-700'],
  'email.delivered': ["Delivered to the recipient's mail server", 'bg-green-100 text-green-700'],
  'email.delivery_delayed': ['Delivery delayed (still retrying)', 'bg-amber-100 text-amber-800'],
  'email.bounced': ['Bounced: not delivered', 'bg-red-100 text-red-700'],
  'email.complained': ['Recipient marked it as spam', 'bg-red-100 text-red-700'],
  'email.opened': ['Opened', 'bg-green-100 text-green-700'],
  'email.clicked': ['Link clicked', 'bg-green-100 text-green-700'],
};

// Must match public.notice_evidence_canonical() in 029_notice_evidence.sql.
function canonical(r) {
  return `from:${r.from_address || ''}\nto:${(r.to_addresses || []).join(',')}\ncc:${(r.cc_addresses || []).join(',')}\nreply-to:${r.reply_to || ''}\nsubject:${r.subject || ''}\n\n${r.html_body || ''}\n\n${r.text_body || ''}`;
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let me = null;

document.addEventListener('DOMContentLoaded', async () => {
  me = await requireSession('admin', 'admin-login.html');
  if (!me) return;
  $('btn-print').addEventListener('click', () => window.print());
  const qs = new URLSearchParams(location.search);
  let query = supabaseClient.from('notice_evidence').select('*').order('id', { ascending: true });
  if (qs.get('id')) query = query.eq('id', qs.get('id'));
  else if (qs.get('letter')) query = query.eq('letter_id', qs.get('letter'));
  else if (qs.get('notification')) query = query.eq('notification_id', qs.get('notification'));
  else return showRegister();

  const { data: rows, error } = await query;
  if (error) return fail(error.message);
  if (!rows.length) return fail('No evidence record was found. Evidence is kept for notices sent after the evidence trail was switched on.');
  await showRecords(rows);
});

function fail(msg) {
  $('ev-status').className = 'rounded-xl bg-red-50 text-red-700 px-4 py-3 text-sm';
  $('ev-status').textContent = /notice_evidence/.test(msg) ? `${msg}. Has 029_notice_evidence.sql been run?` : msg;
}

async function context(rows) {
  const leaseIds = [...new Set(rows.map((r) => r.lease_id).filter(Boolean))];
  if (!leaseIds.length) return {};
  const { data } = await supabaseClient.from('leases').select('id, tenant_id, start_date, end_date, properties:property_id ( address )').in('id', leaseIds);
  const tenantIds = [...new Set((data || []).map((l) => l.tenant_id).filter(Boolean))];
  const { data: people } = tenantIds.length ? await supabaseClient.from('profiles').select('id, full_name').in('id', tenantIds) : { data: [] };
  const names = Object.fromEntries((people || []).map((p) => [p.id, p.full_name]));
  return Object.fromEntries((data || []).map((l) => [l.id, { ...l, tenant_name: names[l.tenant_id] }]));
}

/* ---------------- register ---------------- */
async function showRegister() {
  const { data: rows, error } = await supabaseClient.from('notice_evidence').select('id, event_type, audience, lease_id, to_addresses, subject, accepted_at, provider_message_id').order('id', { ascending: false }).limit(500);
  if (error) return fail(error.message);
  const { data: events } = await supabaseClient.from('notice_evidence_events').select('evidence_id, event_type, occurred_at');
  const latest = {};
  (events || []).forEach((e) => { const rank = ['email.sent', 'email.delivery_delayed', 'email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'].indexOf(e.event_type); if (!latest[e.evidence_id] || rank > latest[e.evidence_id].rank) latest[e.evidence_id] = { ...e, rank }; });
  const ctx = await context(rows);
  const check = await supabaseClient.rpc('verify_notice_evidence');
  $('ev-status').className = 'mb-6 rounded-xl px-4 py-3 text-sm ' + (check.error ? 'bg-red-50 text-red-700' : check.data.length ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800');
  $('ev-status').textContent = check.error ? `Could not verify the trail: ${check.error.message}`
    : check.data.length ? `Integrity check FAILED for ${check.data.length} record(s): ${check.data.map((p) => `#${p.evidence_id} ${p.problem}`).join('; ')}`
    : !rows.length ? 'The evidence trail is set up and empty. Records appear here as formal notices are sent.'
    : `Integrity check passed: all ${rows.length} record${rows.length === 1 ? '' : 's'} match their fingerprints and the chain is unbroken (${sast(new Date())}).`;
  $('ev-register').classList.remove('hidden');
  $('ev-register').innerHTML = rows.length ? `<div class="panel overflow-x-auto"><table class="w-full text-sm min-w-[640px]">
    <thead><tr class="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-100">
      <th class="py-3 px-4">#</th><th class="py-3 px-4">Sent</th><th class="py-3 px-4">Notice</th><th class="py-3 px-4">To</th><th class="py-3 px-4">Delivery</th><th></th></tr></thead>
    <tbody>${rows.map((r) => { const l = ctx[r.lease_id]; const d = latest[r.id]; const dl = d && DELIVERY_LABELS[d.event_type];
      return `<tr class="border-b border-gray-100 last:border-0 align-top">
        <td class="py-3 px-4 text-gray-500">${r.id}</td>
        <td class="py-3 px-4 whitespace-nowrap">${esc(sast(r.accepted_at))}</td>
        <td class="py-3 px-4"><p class="text-navy font-semibold">${esc(EVENT_LABELS[r.event_type] || r.event_type)}</p><p class="text-xs text-gray-500">${l ? esc(`${l.tenant_name || ''} · ${oneLine(l.properties?.address)}`) : ''}</p></td>
        <td class="py-3 px-4 text-gray-600">${esc((r.to_addresses || []).join(', '))}<p class="text-xs text-gray-400">${esc(r.audience)}</p></td>
        <td class="py-3 px-4">${dl ? `<span class="pill ${dl[1]}">${esc(dl[0])}</span>` : '<span class="text-xs text-gray-400">No confirmation yet</span>'}</td>
        <td class="py-3 px-4 text-right"><a class="text-gold font-semibold hover:underline" href="notice-evidence.html?id=${r.id}">Open</a></td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="panel p-6 text-gray-500">No formal notices have been sent since the evidence trail was switched on.</div>';
}

/* ---------------- records ---------------- */
async function showRecords(rows) {
  const ids = rows.map((r) => r.id);
  const [{ data: events }, ctx, check] = await Promise.all([
    supabaseClient.from('notice_evidence_events').select('*').in('evidence_id', ids).order('occurred_at', { ascending: true }),
    context(rows),
    supabaseClient.rpc('verify_notice_evidence'),
  ]);
  const chainProblems = check.error ? null : check.data;
  $('ev-status').className = 'hidden';
  $('btn-print').classList.remove('hidden');
  const html = [];
  for (const r of rows) {
    const recomputed = await sha256(canonical(r));
    const contentOk = recomputed === r.content_sha256;
    const recordOk = (await sha256(`${r.prev_hash || ''}|${r.content_sha256}|${r.id}`)) === r.record_hash;
    const mine = (events || []).filter((e) => e.evidence_id === r.id);
    const l = ctx[r.lease_id];
    const myProblems = chainProblems ? chainProblems.filter((p) => Number(p.evidence_id) === Number(r.id)) : null;
    html.push(`<section class="record mb-10">
      <div class="panel p-6 sm:p-8 mb-6">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div><p class="eyebrow mb-1">Zanka Group (Pty) Ltd · evidence record #${r.id}</p>
            <h2 class="font-display font-bold text-navy text-2xl">${esc(EVENT_LABELS[r.event_type] || r.event_type)}</h2></div>
          <span class="pill ${contentOk && recordOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">${contentOk && recordOk ? 'Integrity verified' : 'Integrity check failed'}</span>
        </div>
        <dl class="kv text-sm mb-6 avoid-break">
          ${l ? `<dt>Tenant</dt><dd>${esc(l.tenant_name || '—')}</dd><dt>Property</dt><dd>${esc(oneLine(l.properties?.address) || '—')}</dd><dt>Lease</dt><dd>#${esc(l.id)} · ${esc(l.start_date || '')} to ${esc(l.end_date || '')}</dd>` : ''}
          <dt>Sent to</dt><dd>${esc((r.to_addresses || []).join(', '))} <span class="text-gray-400">(${esc(r.audience)})</span></dd>
          <dt>Copied to</dt><dd>${esc((r.cc_addresses || []).join(', ') || '—')}</dd>
          <dt>From</dt><dd>${esc(r.from_address)}</dd>
          <dt>Reply-to</dt><dd>${esc(r.reply_to || '—')}</dd>
          <dt>Subject</dt><dd>${esc(r.subject)}</dd>
          <dt>Sent</dt><dd>${esc(sast(r.accepted_at))} <span class="text-gray-400">(accepted by the email provider)</span></dd>
          <dt>Email provider</dt><dd>Resend · message ID <span class="mono">${esc(r.provider_message_id || '—')}</span></dd>
        </dl>

        <h3 class="font-semibold text-navy mb-2">Delivery record</h3>
        <div class="mb-6 text-sm avoid-break">${mine.length ? `<ol class="space-y-1.5">${mine.map((e) => { const d = DELIVERY_LABELS[e.event_type] || [e.event_type, 'bg-gray-100 text-gray-600'];
            return `<li class="flex flex-wrap items-center gap-2"><span class="pill ${d[1]}">${esc(d[0])}</span><span class="text-gray-600">${esc(sast(e.occurred_at || e.received_at))}</span>${e.payload?.bounce ? `<span class="text-xs text-red-700">${esc(JSON.stringify(e.payload.bounce))}</span>` : ''}</li>`; }).join('')}</ol>
            <p class="text-xs text-gray-500 mt-2">Reported to us by Resend through signed webhooks; times are Resend's.</p>`
          : '<p class="text-gray-500">No delivery confirmation has been received for this email yet. Confirmations are recorded once Resend delivery webhooks are connected.</p>'}</div>

        <h3 class="font-semibold text-navy mb-2">Integrity</h3>
        <dl class="kv text-sm avoid-break">
          <dt>Content fingerprint (SHA-256)</dt><dd class="mono">${esc(r.content_sha256)}</dd>
          <dt>Re-calculated now</dt><dd>${contentOk ? '<span class="text-green-700 font-semibold">Matches: the content below is exactly what was sent.</span>' : `<span class="text-red-700 font-semibold">Does not match (${esc(recomputed)}).</span>`}</dd>
          <dt>Record hash</dt><dd class="mono">${esc(r.record_hash)}</dd>
          <dt>Previous record hash</dt><dd class="mono">${esc(r.prev_hash || '(first record)')}</dd>
          <dt>Evidence trail</dt><dd>${myProblems === null ? '<span class="text-amber-700">Could not run the full-trail check.</span>' : myProblems.length ? `<span class="text-red-700 font-semibold">${esc(myProblems.map((p) => p.problem).join('; '))}</span>` : `<span class="text-green-700 font-semibold">Unbroken: every record in the trail was re-checked (${esc(sast(new Date()))}).</span>`}</dd>
        </dl>
        <p class="text-xs text-gray-500 mt-3">Records are append-only: the database refuses any change or deletion. Each record's hash includes the hash of the record before it, so removing or altering any earlier notice would break the chain. The fingerprint is the SHA-256 of the sender, recipients, reply-to, subject and the email body (HTML and plain text) exactly as sent, and can be re-calculated independently.</p>
      </div>

      <div class="panel p-6 sm:p-8 mb-6">
        <h3 class="font-semibold text-navy mb-3">The email as sent</h3>
        <iframe class="w-full border border-gray-200 rounded-lg bg-white" sandbox="allow-same-origin" referrerpolicy="no-referrer" title="Email as sent" data-email="${r.id}" style="height:600px"></iframe>
      </div>
      <div class="panel p-6 sm:p-8 avoid-break">
        <h3 class="font-semibold text-navy mb-3">Plain-text version as sent</h3>
        <pre class="whitespace-pre-wrap text-sm text-gray-700 font-sans">${esc(r.text_body || '')}</pre>
      </div>
      <p class="text-xs text-gray-400 mt-4">Generated ${esc(sast(new Date()))} by ${esc(me.full_name || me.email)} from the Zanka Group evidence register.</p>
    </section>`);
  }
  $('ev-records').innerHTML = html.join('');
  // Load each email into a sandboxed frame (scripts never run) and size it to its content.
  rows.forEach((r) => {
    const frame = document.querySelector(`iframe[data-email="${r.id}"]`);
    frame.addEventListener('load', () => {
      try { frame.style.height = Math.max(200, frame.contentDocument.body.scrollHeight + 40) + 'px'; } catch { /* keep default height */ }
    });
    frame.srcdoc = r.html_body;
  });
  document.title = rows.length === 1 ? `Evidence #${rows[0].id}: ${EVENT_LABELS[rows[0].event_type] || rows[0].event_type} | Zanka Group` : 'Evidence of service | Zanka Group';
}
