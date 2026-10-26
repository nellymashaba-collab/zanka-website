// supabase/functions/tenancy-automation/index.ts
// Deno runtime. Deploy: Supabase dashboard → Edge Functions → Deploy a new
// function → Via editor → name it `tenancy-automation` → paste this file.
//
// One function, three jobs (POST body `{ "action": ... }`):
//   "send"   (default) Send every queued tenancy email (tenancy_notifications).
//                      Safe for anyone to trigger: who gets what is decided
//                      by the database, never by the caller.
//   "daily"            Run the daily checks (run_tenancy_automation: lease-
//                      expiry notices, month-to-month rollover, escalations,
//                      arrears reminders, deadlines, viewing reminders), then
//                      send. Idempotent: running it twice sends nothing twice.
//                      Schedule it once a day with Supabase Cron.
//   "create_tenant_account" { application_id } — ADMIN ONLY. Creates the
//                      tenant login for an accepted applicant and emails them
//                      a branded "set your password" link.
//
// Secrets: RESEND_API_KEY (already set). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Optional SITE_URL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const resendKey = () => Deno.env.get('RESEND_API_KEY');
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://zankagroup.co.za').replace(/\/+$/, '');
const FROM_ADDRESS = 'Zanka Group <notifications@zankagroup.co.za>';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
export function money(n: unknown): string {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return 'R0';
  const v = Number(n);
  const [whole, cents] = Math.abs(v).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${v < 0 ? '−' : ''}R${grouped}${cents === '00' ? '' : ',' + cents}`;
}
export function dateLong(value: unknown): string {
  if (!value) return 'to be confirmed';
  const s = String(value);
  const d = new Date(s.length === 10 ? `${s}T12:00:00+02:00` : s);
  if (Number.isNaN(d.getTime())) return 'to be confirmed';
  return d.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
}
export function dateTimeLong(value: unknown): string {
  if (!value) return 'to be confirmed';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return 'to be confirmed';
  const time = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
  return `${dateLong(value)} at ${time}`;
}
const firstName = (name: unknown) => String(name || '').trim().split(/\s+/)[0] || 'there';
const oneLine = (s: unknown) => String(s || '').replace(/\s*\n\s*/g, ', ');

type Block = { p?: string; html?: string; rows?: [string, string][]; list?: string[]; button?: { label: string; url: string }; note?: string };

export function layout(heading: string, blocks: Block[]): { html: string; text: string } {
  const h: string[] = [];
  const t: string[] = [];
  for (const b of blocks) {
    if (b.p !== undefined) { h.push(`<p style="margin:0 0 14px;line-height:1.55">${esc(b.p)}</p>`); t.push(b.p); }
    if (b.html !== undefined) {
      h.push(`<p style="margin:0 0 14px;line-height:1.55">${b.html}</p>`);
      t.push(b.html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    if (b.rows) {
      h.push(`<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;width:100%;max-width:520px">${b.rows.map(([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#1F2A44;font-weight:600;text-align:right">${esc(v)}</td></tr>`).join('')}</table>`);
      t.push(b.rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
    if (b.list) { h.push(`<ul style="margin:0 0 16px;padding-left:20px;line-height:1.6">${b.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`); t.push(b.list.map((li) => `- ${li}`).join('\n')); }
    if (b.button) {
      h.push(`<p style="margin:20px 0"><a href="${esc(b.button.url)}" style="background:#C89B3C;color:#141C30;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;display:inline-block">${esc(b.button.label)}</a></p>`);
      t.push(`${b.button.label}: ${b.button.url}`);
    }
    if (b.note) { h.push(`<p style="margin:0 0 14px;line-height:1.5;color:#6b7280;font-size:13px">${esc(b.note)}</p>`); t.push(b.note); }
  }
  const html = `<!doctype html><html><body style="margin:0;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif;color:#1F2A44">
<table role="presentation" width="100%" style="background:#F4F4F4;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#141C30;padding:18px 28px;color:#ffffff;font-weight:700;letter-spacing:2px;font-size:15px">ZANKA <span style="color:#C89B3C">GROUP</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:22px;color:#1F2A44">${esc(heading)}</h1>
${h.join('\n')}
<p style="margin:24px 0 0;line-height:1.5">Kind regards,<br>Zanka Group (Pty) Ltd</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#F4F4F4;color:#6b7280;font-size:12px;line-height:1.5">Zanka Group (Pty) Ltd · Sandton, Johannesburg · <a href="${esc(SITE_URL)}" style="color:#6b7280">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a><br>Reply to this email to reach our team.</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text: `${heading}\n\n${t.join('\n\n')}\n\nKind regards,\nZanka Group (Pty) Ltd\n${SITE_URL}` };
}

/* ------------------------------------------------------------------ */
/* Emails per event                                                    */
/* ------------------------------------------------------------------ */

export type Email = { audience: 'tenant' | 'owner' | 'admin' | 'applicant'; to: string[]; cc: string[]; subject: string; html: string; text: string };

// deno-lint-ignore no-explicit-any
export function buildEmails(event: string, detail: any, ctx: any, siteUrl = SITE_URL): Email[] {
  const admin: string = ctx.admin_email;
  const tenant = ctx.tenant;
  const owner = ctx.owner;
  const lease = ctx.lease || {};
  const where = ctx.property_address ? oneLine(ctx.property_address) : 'the property';
  const adminUrl = `${siteUrl}/tenancies.html`;
  const out: Email[] = [];

  const send = (audience: Email['audience'], to: string | undefined | null, greetName: string | null, subject: string, heading: string, blocks: Block[], ccAdmin = true) => {
    if (!to) return;
    const { html, text } = layout(heading, [...(greetName === null ? [] : [{ p: `Hi ${firstName(greetName)},` }]), ...blocks]);
    out.push({ audience, to: [to], cc: ccAdmin ? [admin] : [], subject, html, text });
  };
  const toTenant = (subject: string, heading: string, blocks: Block[]) => send('tenant', tenant?.email, tenant?.name, subject, heading, blocks);
  const toOwner = (subject: string, heading: string, blocks: Block[]) => send('owner', owner?.email, owner?.name, subject, heading, blocks);
  const toAdmin = (subject: string, heading: string, blocks: Block[]) => send('admin', admin, null, subject, heading, blocks, false);

  switch (event) {
    /* ---------- notices and move-out ---------- */
    case 'notice_received': {
      const n = ctx.notice || {};
      const vacate = n.type === 'Notice to Vacate';
      toTenant(`We received your notice${vacate ? ' to vacate' : ''}`, 'Your notice has been received', [
        { p: `Thank you. We have received your ${String(n.type || 'notice').toLowerCase()} for ${where}, submitted ${dateLong(n.submitted_at)}.` },
        ...(vacate ? [
          { rows: [['Move-out date you asked for', dateLong(n.move_out_date)], ['Earliest end date allowed', dateLong(n.earliest_end_date)]] as [string, string][] },
          ...(n.short_notice ? [{ p: 'The date you asked for is earlier than the notice period allows (20 business days for a fixed-term lease under the Consumer Protection Act, or one calendar month on a month-to-month lease). We will contact you to agree the end date.' }] : []),
          { p: 'We will confirm your end date in writing, and arrange a joint move-out inspection in the last three days of your lease.' },
        ] : [{ p: 'We will come back to you shortly.' }]),
      ]);
      toAdmin(`New ${n.type || 'notice'} from ${tenant?.name || 'a tenant'}${n.short_notice ? ' (short notice)' : ''}`, `New ${String(n.type || 'notice').toLowerCase()}`, [
        { rows: [['Tenant', tenant?.name || 'unknown'], ['Property', where], ...(vacate ? [['Requested move-out', dateLong(n.move_out_date)], ['Earliest legal end', dateLong(n.earliest_end_date)]] as [string, string][] : [])] },
        ...(n.message ? [{ p: `Message: ${n.message}` }] : []),
        { button: { label: 'Review the notice', url: adminUrl } },
      ]);
      if (vacate) toOwner(`Your tenant has given notice: ${where}`, 'Your tenant has given notice', [
        { p: `The tenant at ${where} has given notice to vacate, asking to leave on ${dateLong(n.move_out_date)}. We will confirm the end date, carry out the move-out inspection and get the unit ready to let again.` },
      ]);
      break;
    }

    case 'ending_confirmed': {
      const e = ctx.ending || {};
      const notRenewing = detail?.source === 'not_renewing';
      toTenant(`Your lease end date is confirmed: ${dateLong(e.end_date)}`, 'Your move-out date is confirmed', [
        { p: notRenewing ? `This confirms that your lease for ${where} will not be renewed, and ends on ${dateLong(e.end_date)}.` : `This confirms that your tenancy at ${where} ends on ${dateLong(e.end_date)}.` },
        { p: 'What happens next:' },
        { list: [
          'We will arrange a joint move-out inspection with you during the last three days of your lease. Please attend: it protects your deposit.',
          'Please return all keys, remotes and access cards at the inspection.',
          'Your deposit plus interest is refunded within 7 days if there is no damage. If repairs are needed, the balance is refunded within 14 days of the repairs, with receipts for every deduction.',
          'Rent remains payable up to and including your last day.',
        ] },
      ]);
      toOwner(`Tenancy ending on ${dateLong(e.end_date)}: ${where}`, 'A tenancy is ending', [
        { p: `The tenancy at ${where} ends on ${dateLong(e.end_date)}. We will carry out the move-out inspection, settle the deposit and re-list the unit.` },
      ]);
      break;
    }

    case 'move_out_inspection_scheduled': {
      const e = ctx.ending || {};
      toTenant(`Move-out inspection: ${dateTimeLong(e.inspection_at)}`, 'Your move-out inspection', [
        { p: `Your joint move-out inspection at ${where} is booked for:` },
        { rows: [['Date and time', dateTimeLong(e.inspection_at)], ['Lease ends', dateLong(e.end_date)]] },
        { p: 'Please be there. We will go through the unit together against the move-in inspection, and note anything beyond fair wear and tear. If you cannot attend, the Rental Housing Act lets us inspect on our own, and the deposit refund then follows within 21 days.' },
        { p: 'Reply to this email if you need a different time within the last three days of your lease.' },
      ]);
      break;
    }

    case 'deposit_refund_statement': {
      const d = ctx.deposit || {};
      const lines = (d.deduction_lines || []).map((x: { description: string; amount: number }) => `${x.description}: ${money(x.amount)}`);
      toTenant(`Your deposit refund statement: ${where}`, 'Your deposit refund', [
        { p: `Here is how your deposit for ${where} has been settled.` },
        { rows: [['Deposit received', money(d.received)], ['Interest earned', money(d.interest)], ['Deductions', money(d.deductions)], ['Refunded to you', money(d.refunded)]] },
        ...(lines.length ? [{ p: 'Deductions:' }, { list: lines }, { note: 'Receipts for every deduction are available for you to inspect. Reply to this email to request copies.' }] : [{ p: 'No deductions were made.' }]),
        ...(Number(d.held) > 0.009 ? [{ p: `A balance of ${money(d.held)} is still held. We will contact you about it.` }] : []),
      ]);
      break;
    }

    case 'tenancy_closed': {
      const e = ctx.ending || {};
      toOwner(`Tenancy closed: ${where}`, 'The tenancy has been closed', [
        { p: `The tenancy at ${where} has ended (last day ${dateLong(e.end_date)}), the move-out inspection is done and the deposit has been settled.` },
        { p: e.relisted ? 'The unit has been re-listed and we are finding the next tenant.' : 'The unit is now marked vacant. We will let you know when it is listed.' },
      ]);
      break;
    }

    /* ---------- lease terms ---------- */
    case 'lease_expiry_notice': {
      toTenant(`Your lease ends on ${dateLong(lease.end_date)}`, 'Your lease is coming to an end', [
        { p: `Your fixed-term lease for ${where} ends on ${dateLong(lease.end_date)}. Please let us know which of these you would like:` },
        { list: [
          'Renew: sign a new fixed-term lease. Reply to this email and we will send it to you.',
          'Move out: give us written notice through your tenant portal, and we will arrange the move-out inspection.',
          'Do nothing: the lease continues month to month on the same terms, unless either of us gives one calendar month\'s notice.',
        ] },
        { note: 'This notice is sent to you in terms of section 14 of the Consumer Protection Act.' },
        { button: { label: 'Open your tenant portal', url: `${siteUrl}/tenant-dashboard.html` } },
      ]);
      toOwner(`Lease ending ${dateLong(lease.end_date)}: ${where}`, 'A lease is coming up for renewal', [
        { p: `The lease at ${where} ends on ${dateLong(lease.end_date)}. We have sent the tenant their expiry notice and asked whether they want to renew. We will keep you posted.` },
      ]);
      break;
    }

    case 'lease_rolled_over': {
      const blocks = (who: string): Block[] => [
        { p: `The fixed term of the lease for ${where} ended on ${dateLong(detail?.end_date || lease.end_date)}. As no renewal or notice was recorded, the lease now continues month to month on the same terms.` },
        { p: who === 'tenant' ? 'Either you or we may end it with one calendar month\'s written notice. Reply to this email if you would like to sign a new fixed-term lease.' : 'Either party may now end it with one calendar month\'s written notice. Let us know if you would like us to offer the tenant a new fixed-term lease.' },
      ];
      toTenant('Your lease now continues month to month', 'Your lease is now month to month', blocks('tenant'));
      toOwner(`Lease now month to month: ${where}`, 'A lease is now month to month', blocks('owner'));
      break;
    }

    case 'escalation_notice': {
      const e = ctx.escalation || {};
      const effective = detail?.stage === 'effective';
      const days = { '90_day': 'in about 90 days', '60_day': 'in about 60 days', '30_day': 'in about 30 days' }[detail?.stage as string] || '';
      const body: Block[] = effective
        ? [{ p: `As set out in your lease, the rent for ${where} increased by ${Number(e.percentage)}% from ${dateLong(e.effective_date)}.` },
           { rows: [['Previous rent', money(e.previous_rental_amount)], ['New monthly rent', money(e.new_rental_amount)]] },
           { p: 'Your next invoice will show the new amount. Please update any debit order or scheduled payment.' }]
        : [{ p: `As set out in your lease, the rent for ${where} increases by ${Number(e.percentage)}% on ${dateLong(e.effective_date)} (${days}).` },
           { rows: [['Current rent', money(e.previous_rental_amount)], ['New monthly rent', money(e.new_rental_amount)], ['From', dateLong(e.effective_date)]] }];
      toTenant(effective ? 'Your new rent is now in effect' : `Rent increase on ${dateLong(e.effective_date)}`, effective ? 'Your new rent' : 'Upcoming rent increase', body);
      toOwner(effective ? `Rent escalation applied: ${where}` : `Rent escalation on ${dateLong(e.effective_date)}: ${where}`, effective ? 'Rent escalation applied' : 'Upcoming rent escalation', body);
      break;
    }

    /* ---------- arrears ---------- */
    case 'arrears_reminder': {
      const p = ctx.payment || {};
      if (p.status && p.status !== 'Pending') break; // paid since it was queued: send nothing
      const second = Number(detail?.level) >= 2;
      toTenant(second ? `Second reminder: rent overdue for ${where}` : `Reminder: rent overdue for ${where}`, second ? 'Your rent is still overdue' : 'A friendly reminder', [
        { p: second
          ? `Our records show that the payment below is still outstanding. Please pay it as soon as possible, or contact us today if you are having difficulty, so we can agree a way forward.`
          : `Our records show that the payment below has not yet been received. If you have already paid, thank you, and please send us your proof of payment so we can update our records.` },
        { rows: [['Amount', money(p.amount)], ['Was due', dateLong(p.due_date)], ['Days overdue', String(p.days_overdue ?? '')]] },
        ...(second ? [{ note: 'If the amount remains unpaid we will have to send a formal letter of demand.' }] : []),
        { button: { label: 'Pay in your tenant portal', url: `${siteUrl}/tenant-dashboard.html` } },
      ]);
      break;
    }

    case 'letter_of_demand': {
      const l = ctx.letter || {};
      const p = ctx.payment || {};
      if (p.status && p.status !== 'Pending') break;
      toTenant(`Letter of demand: ${where}`, 'Letter of demand', [
        { p: `Dear ${tenant?.name || 'Tenant'},` },
        { p: `This letter concerns your lease of ${where}${lease.lease_number ? ` (lease ${lease.lease_number})` : ''}.` },
        { p: 'You are in breach of the lease because the following amount, which was due, has not been paid:' },
        { rows: [['Amount outstanding', money(l.amount)], ['Due date', dateLong(l.due_date)], ['Pay by', dateLong(l.remedy_by)]] },
        { html: `We hereby demand payment of <strong>${esc(money(l.amount))}</strong> by <strong>${esc(dateLong(l.remedy_by))}</strong>, being 20 business days from the date of this letter, as required by section 14 of the Consumer Protection Act.` },
        { p: 'If the amount is not paid in full by that date, we reserve our right to cancel the lease and to take any further steps available to us in law to recover the amount owed, including legal costs where the lease allows.' },
        { p: 'If you have already paid, please send us your proof of payment. If you are unable to pay, contact us before the date above to discuss an arrangement.' },
        { note: 'Issued by Zanka Group (Pty) Ltd. Please keep this letter for your records.' },
      ]);
      break;
    }

    /* ---------- viewings ---------- */
    case 'viewing_booked':
    case 'viewing_reminder': {
      const b = ctx.booking || {}; const s = ctx.slot || {}; const v = ctx.vacancy || {};
      if (event === 'viewing_reminder' && b.status !== 'Booked') break;
      const cancelUrl = `${siteUrl}/apply.html?vacancy=${encodeURIComponent(v.id || '')}&cancel_viewing=${encodeURIComponent(b.id || '')}&t=${encodeURIComponent(b.cancel_token || '')}`;
      send('applicant', b.email, b.full_name, event === 'viewing_booked' ? `Viewing booked: ${v.title} (${b.reference})` : `Reminder: viewing tomorrow, ${v.title}`,
        event === 'viewing_booked' ? 'Your viewing is booked' : 'Your viewing is tomorrow', [
          { p: event === 'viewing_booked' ? `Thank you for booking a viewing of ${v.title} (${v.area}).` : `This is a reminder of your viewing of ${v.title} (${v.area}).` },
          { rows: [['When', dateTimeLong(s.starts_at)], ['Duration', `${s.duration_minutes || 30} minutes`], ...(s.meeting_point ? [['Where to meet', s.meeting_point]] as [string, string][] : []), ['Reference', b.reference]] },
          { p: 'Please bring your ID. If you like the unit, you can apply online straight after the viewing.' },
          ...(b.meets_income === false ? [{ note: 'Based on the income you gave, the rent may be more than a third of your household income. You are still welcome to view; a co-applicant\'s income or a surety can help an application.' }] : []),
          { button: { label: "Can't make it? Cancel the booking", url: cancelUrl } },
        ]);
      break;
    }
    case 'viewing_cancelled': {
      const b = ctx.booking || {}; const s = ctx.slot || {}; const v = ctx.vacancy || {};
      const byUs = detail?.by === 'zanka';
      send('applicant', b.email, b.full_name, `Viewing cancelled: ${v.title}`, 'Your viewing has been cancelled', [
        { p: byUs ? `Unfortunately we have had to cancel the viewing of ${v.title} on ${dateTimeLong(s.starts_at)}. We are sorry for the inconvenience.` : `As you asked, your viewing of ${v.title} on ${dateTimeLong(s.starts_at)} has been cancelled.` },
        { button: { label: 'See other viewing times', url: `${siteUrl}/apply.html?vacancy=${encodeURIComponent(v.id || '')}` } },
      ]);
      break;
    }
    case 'viewing_followup': {
      const b = ctx.booking || {}; const v = ctx.vacancy || {};
      send('applicant', b.email, b.full_name, `Thanks for viewing ${v.title}`, 'Thanks for coming to the viewing', [
        { p: `Thank you for viewing ${v.title} (${v.area}). If you would like to rent it, you can apply online now; it takes about 15 minutes.` },
        { p: 'Have your ID, your 3 most recent payslips and 3 months\' bank statements ready as PDFs or photos.' },
        { button: { label: 'Apply now', url: `${siteUrl}/apply.html?vacancy=${encodeURIComponent(v.id || '')}` } },
      ]);
      break;
    }

    /* ---------- admin alerts ---------- */
    case 'admin_alert': {
      const k = detail?.kind;
      const msg: Record<string, [string, string]> = {
        expiry_notice_late: [`Late lease-expiry notice: ${where}`, `The lease at ${where} ends on ${dateLong(detail?.end_date)}, only ${detail?.business_days_left} business days away. The Consumer Protection Act requires 40–80 business days' notice. The tenant has now been sent their notice; consider agreeing a later end date if they need it.`],
        renewal_overdue: [`Renewal agreed but no new lease: ${where}`, `The lease at ${where} ended on ${dateLong(detail?.end_date)}. A renewal was recorded, but no new lease has been created. Create the renewed lease in the Lease Wizard, or change the decision so the tenancy can roll over or end properly.`],
        demand_drafts: ['Letters of demand ready for review', `${detail?.count} letter${Number(detail?.count) === 1 ? '' : 's'} of demand ${Number(detail?.count) === 1 ? 'has' : 'have'} been prepared for rent unpaid for 14 days or more. Nothing has been sent: review and approve them in Tenancies → Arrears.`],
        inspection_not_scheduled: [`Move-out inspection not booked: ${where}`, `The tenancy at ${where} ends on ${dateLong(detail?.end_date)} and no move-out inspection is booked. The Rental Housing Act requires it within the last three days of the lease.`],
        refund_due_soon: [`Deposit refund due ${dateLong(detail?.refund_due_by)}: ${where}`, `The deposit refund for ${where} is due by ${dateLong(detail?.refund_due_by)} under the Rental Housing Act.`],
        refund_overdue: [`OVERDUE deposit refund: ${where}`, `The deposit refund for ${where} was due by ${dateLong(detail?.refund_due_by)} and has not been recorded as paid. Late refunds are the most common complaint to the Rental Housing Tribunal.`],
      };
      const m = msg[k];
      if (m) toAdmin(m[0], m[0].replace(/:.*$/, ''), [{ p: m[1] }, { button: { label: 'Open Tenancies', url: adminUrl } }]);
      break;
    }
  }

  for (const e of out) {
    const toSet = new Set(e.to.map((x) => x.toLowerCase()));
    e.cc = [...new Set(e.cc.filter((x) => x && !toSet.has(x.toLowerCase())))];
  }
  return out;
}

export function accountEmail(c: { full_name: string; vacancy_title: string; email: string }, link: string) {
  return layout('Set up your tenant account', [
    { p: `Hi ${firstName(c.full_name)},` },
    { p: `Welcome to Zanka Group. We have created your tenant account for ${c.vacancy_title}. Choose a password to finish setting it up; you will then receive your lease to sign online.` },
    { rows: [['Your login email', c.email]] },
    { button: { label: 'Choose my password', url: link } },
    { note: 'This link works once and expires after a short time. If it has expired, use "Forgot password" on the tenant login page.' },
  ]);
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

async function sendViaResend(e: Email, replyTo: string): Promise<{ ok: boolean; error?: string; id?: string | null }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: e.to, cc: e.cc.length ? e.cc : undefined, reply_to: replyTo, subject: e.subject, html: e.html, text: e.text }),
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
  let id: string | null = null;
  try { id = (await res.json())?.id || null; } catch { /* body is optional */ }
  return { ok: true, id };
}

// Formal notices to tenants and owners are kept as permanent evidence
// (029_notice_evidence.sql). Viewing emails go to applicants and carry
// cancel links, so they are not kept.
export const keepsEvidence = (event: string, audience: string) =>
  (audience === 'tenant' || audience === 'owner') && !event.startsWith('viewing_') && event !== 'tenant_account_created';

// deno-lint-ignore no-explicit-any
async function recordEvidence(db: any, notificationId: number, e: Email, replyTo: string, messageId: string | null) {
  const { data, error } = await db.rpc('record_notice_evidence', {
    p_notification_id: notificationId, p_audience: e.audience, p_from: FROM_ADDRESS, p_to: e.to, p_cc: e.cc, p_reply_to: replyTo || null,
    p_subject: e.subject, p_html: e.html, p_text: e.text, p_message_id: messageId,
  });
  return error ? { evidence_id: null, evidence_error: error.message } : { evidence_id: data, evidence_error: null };
}

// deno-lint-ignore no-explicit-any
export async function processQueue(db: any, limit = 20) {
  const { data: rows, error } = await db.rpc('claim_tenancy_notifications', { p_limit: limit });
  if (error) throw new Error(`claim_tenancy_notifications: ${error.message}`);
  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows || []) {
    summary.processed++;
    let status = 'sent';
    let lastError: string | null = null;
    const recipients: unknown[] = [];
    try {
      const emails = buildEmails(row.n_event, row.n_detail, row.n_context);
      if (!emails.length) { status = 'skipped'; lastError = 'Nothing to send (e.g. already paid, cancelled, or no email on file)'; }
      else if (!resendKey()) { status = 'failed'; lastError = 'RESEND_API_KEY is not set for Edge Functions'; }
      else {
        const errors: string[] = [];
        for (const e of emails) {
          const r = await sendViaResend(e, row.n_context.admin_email);
          // The email has gone out; a failure to store evidence is reported but does not fail the send.
          const ev = r.ok && keepsEvidence(row.n_event, e.audience) ? await recordEvidence(db, row.n_id, e, row.n_context.admin_email, r.id || null) : {};
          recipients.push({ audience: e.audience, to: e.to, cc: e.cc, subject: e.subject, ok: r.ok, error: r.error || null, message_id: r.id || null, ...ev });
          if (!r.ok) errors.push(`${e.audience}: ${r.error}`);
        }
        if (errors.length) { status = 'failed'; lastError = errors.join(' | '); }
      }
    } catch (err) { status = 'failed'; lastError = (err as Error).message; }
    summary[status as 'sent' | 'failed' | 'skipped']++;
    await db.rpc('complete_tenancy_notification', { p_id: row.n_id, p_status: status, p_recipients: recipients.length ? recipients : null, p_error: lastError });
  }
  return summary;
}

async function sendAll(db: unknown) {
  const total = { processed: 0, sent: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < 5; i++) {
    const s = await processQueue(db, 20);
    total.processed += s.processed; total.sent += s.sent; total.failed += s.failed; total.skipped += s.skipped;
    if (s.processed < 20) break;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Tenant account creation (admin only)                                */
/* ------------------------------------------------------------------ */

// deno-lint-ignore no-explicit-any
async function callerIsAdmin(db: any, req: Request) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await db.from('profiles').select('role').eq('id', data.user.id).single();
  return profile?.role === 'admin' ? data.user.id : null;
}

// deno-lint-ignore no-explicit-any
export async function createTenantAccount(db: any, adminId: string, applicationId: string) {
  const { data: c, error } = await db.rpc('tenant_account_candidate', { p_application_id: applicationId });
  if (error) throw new Error(error.message);
  if (!c) return json({ error: 'Application not found.' }, 404);
  if (c.status !== 'Accepted') return json({ error: `The application is "${c.status}". Accounts are created once the offer is accepted.` }, 409);

  const { data: existing } = await db.from('profiles').select('id, role').ilike('email', c.email.replace(/[\\%_]/g, '\\$&')).limit(1).maybeSingle();
  if (existing) {
    if (existing.role !== 'tenant') return json({ error: `An account for ${c.email} already exists as "${existing.role}", not a tenant.` }, 409);
    await db.from('rental_applications').update({ tenant_profile_id: existing.id }).eq('id', applicationId);
    return json({ ok: true, existing: true, tenant_id: existing.id });
  }

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: c.email, email_confirm: true, user_metadata: { full_name: c.full_name, role: 'tenant' },
  });
  if (createErr || !created?.user) return json({ error: `Could not create the login: ${createErr?.message || 'unknown error'}` }, 400);
  const userId = created.user.id;

  const { error: profileErr } = await db.from('profiles').upsert([{
    id: userId, email: c.email, role: 'tenant', full_name: c.full_name, phone: c.phone || null,
    id_number: c.id_number || null, address_line1: c.current_address || null,
  }]);
  if (profileErr) {
    await db.auth.admin.deleteUser(userId);
    return json({ error: `Could not create the tenant profile: ${profileErr.message}` }, 400);
  }
  await db.from('rental_applications').update({ tenant_profile_id: userId }).eq('id', applicationId);

  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: 'recovery', email: c.email, options: { redirectTo: `${SITE_URL}/update-password.html` } });
  const actionLink = link?.properties?.action_link;
  if (linkErr || !actionLink) return json({ ok: true, tenant_id: userId, warning: 'Account created, but the set-password email could not be prepared. Ask the tenant to use "Forgot password".' });

  const { data: settings } = await db.from('rental_recruitment_settings').select('notification_admin_email').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  const adminEmail = settings?.notification_admin_email || 'admin@zankagroup.co.za';
  const { html, text } = accountEmail(c, actionLink);
  // The set-password link is a secret: sent to the tenant only, never cc'd.
  const r = resendKey() ? await sendViaResend({ audience: 'applicant', to: [c.email], cc: [], subject: 'Set up your Zanka Group tenant account', html, text }, adminEmail) : { ok: false, error: 'RESEND_API_KEY missing' };
  await db.rpc('log_tenancy_email_sent', { p_event: 'tenant_account_created', p_application_id: applicationId,
    p_recipients: [{ audience: 'applicant', to: [c.email], cc: [], subject: 'Set up your Zanka Group tenant account', ok: r.ok, error: r.error || null }], p_requested_by: adminId });
  return json({ ok: true, tenant_id: userId, emailed: r.ok, ...(r.ok ? {} : { warning: `Account created, but the email failed (${r.error}). Ask the tenant to use "Forgot password".` }) });
}

/* ------------------------------------------------------------------ */

if (typeof Deno !== 'undefined' && Deno.serve) {
  const db = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let body: { action?: string; application_id?: string } = {};
    try { body = await req.json(); } catch { body = {}; }
    try {
      const action = body.action || 'send';
      if (action === 'create_tenant_account') {
        const adminId = await callerIsAdmin(db, req);
        if (!adminId) return json({ error: 'Only admins can create tenant accounts.' }, 403);
        if (!body.application_id) return json({ error: 'application_id is required' }, 400);
        return await createTenantAccount(db, adminId, body.application_id);
      }
      if (action === 'daily') {
        const { data: summary, error } = await db.rpc('run_tenancy_automation', {});
        if (error) throw new Error(`run_tenancy_automation: ${error.message}`);
        return json({ checks: summary, emails: await sendAll(db) });
      }
      if (action === 'send') return json(await sendAll(db));
      return json({ error: `Unknown action ${action}` }, 400);
    } catch (err) {
      console.error('tenancy-automation error:', (err as Error).message);
      return json({ error: (err as Error).message }, 500);
    }
  });
}
