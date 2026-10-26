// supabase/functions/rental-notifications/index.ts
// Deno runtime. Deploy with: supabase functions deploy rental-notifications
// (or Supabase dashboard → Edge Functions → Deploy a new function → paste this file).
//
// Sends the tenant-recruitment emails queued by 026_rental_notifications.sql.
// Every call simply works through the queue: it takes no instructions from
// the caller about who to email or what to say — all of that comes from the
// database via claim_rental_notifications(). That's why it is safe for the
// public application page to call it.
//
// SECRETS (already set for dms-notifications; Supabase secrets are shared by
// every function in the project):
//   RESEND_API_KEY            — Resend API key
//   SUPABASE_URL              — provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — provided by Supabase
// Optional:
//   SITE_URL                  — defaults to https://zankagroup.co.za

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Read on every send, so a newly set secret is picked up without a redeploy.
const resendKey = () => Deno.env.get('RESEND_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const SITE_URL = (Deno.env.get('SITE_URL') || 'https://zankagroup.co.za').replace(/\/+$/, '');
const FROM_ADDRESS = 'Zanka Group <notifications@zankagroup.co.za>'; // same verified Resend domain as dms-notifications

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

// Everything that reaches an email body is escaped: applicants type their
// own names, and listing titles are free text.
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function money(n: unknown): string {
  if (n === null || n === undefined || n === '') return 'not set';
  const v = Number(n);
  if (Number.isNaN(v)) return 'not set';
  return 'R' + Math.round(v).toLocaleString('en-ZA').replace(/ | |,/g, ' ');
}

export function dateLong(value: unknown): string {
  if (!value) return 'not set';
  const s = String(value);
  const d = new Date(s.length === 10 ? `${s}T12:00:00+02:00` : s);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
}

export function dateTimeLong(value: unknown): string {
  if (!value) return 'not set';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return 'not set';
  const date = d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
  const time = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
  return `${date} at ${time}`;
}

const firstName = (name: unknown) => String(name || '').trim().split(/\s+/)[0] || 'there';

const FIELD_LABELS: Record<string, [string, (v: unknown) => string]> = {
  title: ['Listing title', (v) => String(v ?? 'not set')],
  monthly_rent: ['Monthly rent', money],
  deposit: ['Deposit', money],
  available_from: ['Available from', dateLong],
  applications_close_at: ['Applications close', (v) => (v ? dateTimeLong(v) : 'no closing date')],
};

/* ------------------------------------------------------------------ */
/* Email layout                                                        */
/* ------------------------------------------------------------------ */

type Block = { p?: string; html?: string; rows?: [string, string][]; list?: string[]; button?: { label: string; url: string }; note?: string };

// Blocks hold PLAIN text (escaped here) except `html`, which callers build
// from already-escaped pieces.
export function layout(heading: string, blocks: Block[]): { html: string; text: string } {
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  for (const b of blocks) {
    if (b.p !== undefined) {
      htmlParts.push(`<p style="margin:0 0 14px;line-height:1.55">${esc(b.p)}</p>`);
      textParts.push(b.p);
    }
    if (b.html !== undefined) {
      htmlParts.push(`<p style="margin:0 0 14px;line-height:1.55">${b.html}</p>`);
      textParts.push(b.html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    if (b.rows) {
      htmlParts.push(`<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;width:100%;max-width:480px">${b.rows.map(([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#1F2A44;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>`);
      textParts.push(b.rows.map(([k, v]) => `${k}: ${v}`).join('\n'));
    }
    if (b.list) {
      htmlParts.push(`<ul style="margin:0 0 16px;padding-left:20px;line-height:1.6">${b.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`);
      textParts.push(b.list.map((li) => `- ${li}`).join('\n'));
    }
    if (b.button) {
      htmlParts.push(`<p style="margin:20px 0"><a href="${esc(b.button.url)}" style="background:#C89B3C;color:#141C30;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;display:inline-block">${esc(b.button.label)}</a></p>`);
      textParts.push(`${b.button.label}: ${b.button.url}`);
    }
    if (b.note) {
      htmlParts.push(`<p style="margin:0 0 14px;line-height:1.5;color:#6b7280;font-size:13px">${esc(b.note)}</p>`);
      textParts.push(b.note);
    }
  }
  const html = `<!doctype html><html><body style="margin:0;background:#F4F4F4;font-family:Arial,Helvetica,sans-serif;color:#1F2A44">
<table role="presentation" width="100%" style="background:#F4F4F4;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#141C30;padding:18px 28px;color:#ffffff;font-weight:700;letter-spacing:2px;font-size:15px">ZANKA <span style="color:#C89B3C">GROUP</span></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:22px;color:#1F2A44">${esc(heading)}</h1>
${htmlParts.join('\n')}
<p style="margin:24px 0 0;line-height:1.5">Kind regards,<br>Zanka Group (Pty) Ltd</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#F4F4F4;color:#6b7280;font-size:12px;line-height:1.5">Zanka Group (Pty) Ltd · Sandton, Johannesburg · <a href="${esc(SITE_URL)}" style="color:#6b7280">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a><br>Reply to this email to reach our team.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${textParts.join('\n\n')}\n\nKind regards,\nZanka Group (Pty) Ltd\n${SITE_URL}`;
  return { html, text };
}

/* ------------------------------------------------------------------ */
/* What to send for each event                                          */
/* ------------------------------------------------------------------ */

export type Email = { audience: 'owner' | 'applicant' | 'admin'; to: string[]; cc: string[]; subject: string; html: string; text: string };

// deno-lint-ignore no-explicit-any
export function buildEmails(event: string, detail: any, ctx: any, siteUrl = SITE_URL): Email[] {
  const admin: string = ctx.admin_email;
  const v = ctx.vacancy || {};
  const a = ctx.application;
  const owner = ctx.owner;
  const listingUrl = v.id ? `${siteUrl}/apply.html?vacancy=${encodeURIComponent(v.id)}` : `${siteUrl}/apply.html`;
  const listingName = v.title || 'your listing';
  const where = v.property_address ? String(v.property_address).replace(/\s*\n\s*/g, ', ') : '';
  const out: Email[] = [];

  // Owner emails go to the owner with admin cc'd. If no owner is on file,
  // they go to admin with a note, so nothing is silently dropped.
  const toOwner = (subject: string, heading: string, blocks: Block[]) => {
    const greeting: Block = owner ? { p: `Hi ${firstName(owner.name)},` } : { note: 'No owner email is on file for this property, so this owner update was sent to you instead. Add the owner in the admin dashboard to keep them informed.' };
    const { html, text } = layout(heading, [greeting, ...blocks]);
    out.push({ audience: owner ? 'owner' : 'admin', to: [owner ? owner.email : admin], cc: owner ? [admin] : [], subject, html, text });
  };
  const toApplicant = (subject: string, heading: string, blocks: Block[]) => {
    if (!a?.email) return;
    const { html, text } = layout(heading, [{ p: `Hi ${firstName(a.full_name)},` }, ...blocks]);
    out.push({ audience: 'applicant', to: [a.email], cc: [admin], subject, html, text });
  };
  const listingRows = (): [string, string][] => {
    const rows: [string, string][] = [['Listing', listingName]];
    if (where) rows.push(['Property', where]);
    rows.push(['Monthly rent', money(v.monthly_rent)], ['Deposit', money(v.deposit)], ['Available from', v.available_from ? dateLong(v.available_from) : 'now']);
    return rows;
  };

  switch (event) {
    case 'listing_created': {
      const live = v.status === 'Open';
      toOwner(`New listing created: ${listingName}`, 'Your property has been listed', [
        { p: live
          ? 'We have created a rental listing for your property, and it is now live on our website and accepting applications.'
          : 'We have created a rental listing for your property. It is being finalised and is not yet advertised; we will let you know when it goes live.' },
        { rows: [...listingRows(), ['Status', live ? 'Live' : 'Being prepared']] },
        ...(live ? [{ button: { label: 'View the listing', url: listingUrl } }] : []),
        { p: 'We will keep you updated as applications come in, and when an offer is made.' },
      ]);
      break;
    }

    case 'listing_status_changed': {
      const to = detail?.to;
      const messages: Record<string, [string, string, string]> = {
        Open: [`Your listing is live: ${listingName}`, 'Your listing is now live', 'Your rental listing is now live on our website and accepting applications.'],
        Closed: [`Listing closed: ${listingName}`, 'Your listing has been closed', 'Your rental listing has been taken off the market for now, and is no longer accepting applications. The unit has not been let. We will be in touch about next steps.'],
        Let: [`Let: ${listingName}`, 'Your property has been let', 'A lease is being prepared for the successful applicant, and the listing has been removed from our website. We will confirm once the lease is signed.'],
        Draft: [`Listing unpublished: ${listingName}`, 'Your listing has been unpublished', 'Your rental listing has been taken back into preparation and is no longer advertised.'],
      };
      const m = messages[to];
      if (!m) break;
      toOwner(m[0], m[1], [{ p: m[2] }, { rows: listingRows() }, ...(to === 'Open' ? [{ button: { label: 'View the listing', url: listingUrl } }] : [])]);
      break;
    }

    case 'listing_updated': {
      const changes = detail?.changes || {};
      const lines = Object.keys(changes).filter((k) => FIELD_LABELS[k]).map((k) => {
        const [label, fmt] = FIELD_LABELS[k];
        return `${label}: ${fmt(changes[k].from)} → ${fmt(changes[k].to)}`;
      });
      if (!lines.length) break;
      toOwner(`Listing updated: ${listingName}`, 'Your listing has been updated', [
        { p: 'We have made the following changes to your rental listing:' },
        { list: lines },
        ...(v.status === 'Open' ? [{ button: { label: 'View the listing', url: listingUrl } }] : []),
      ]);
      break;
    }

    case 'application_received': {
      toApplicant(`Application received – ref ${a?.reference}`, 'We have received your application', [
        { p: `Thank you for applying to rent ${listingName} (${v.area || 'Johannesburg'}).` },
        { rows: [['Reference', a?.reference || ''], ['Monthly rent', money(v.monthly_rent)]] },
        { p: 'We will now verify your details. As set out in the consent you signed, this includes a credit check and contacting your employer and current landlord.' },
        { p: 'Every applicant hears back from us in writing, usually within a few working days. Please quote your reference if you contact us.' },
      ]);
      // Owners are told an application arrived — never who applied.
      toOwner(`New application for ${listingName}`, 'A new application has been received', [
        { p: `A new application has been received for your listing ${listingName}. Applications received so far: ${ctx.application_count}.` },
        { p: 'Our team will verify and score each applicant. We will let you know when an offer is made.' },
        { note: "Applicants' personal details are kept confidential under POPIA and are not shared in these updates." },
      ]);
      break;
    }

    case 'application_offered': {
      const deadline = dateTimeLong(a?.offer_expires_at);
      const start = a?.move_in_date || v.available_from;
      toApplicant(`Your application for ${listingName} – approved (ref ${a?.reference})`, a?.conditional ? 'Your application has been conditionally approved' : 'Your application has been approved', [
        { p: `Good news: your application to rent ${listingName} (${v.area || 'Johannesburg'}) has been approved${a?.conditional ? ', subject to the condition below' : ''}.` },
        { rows: [
          ['Monthly rent', `${money(v.monthly_rent)}, due on the 1st`],
          ['Deposit', money(v.deposit)],
          ['Lease start', start ? dateLong(start) : 'to be agreed'],
          ['Lease term', `${a?.lease_term_months || 12} months`],
        ] },
        ...(a?.conditional ? [{ p: 'Condition: we require either a surety who meets our screening requirements, or an additional deposit. Please reply to let us know which you prefer.' }] : []),
        { html: `<strong>Please reply to this email by ${esc(deadline)} to confirm that you accept.</strong> Once you do, you will receive the lease to sign through our platform, together with deposit payment details.` },
        { p: 'The unit remains available to other applicants until we receive your confirmation.' },
      ]);
      toOwner(`Offer made on ${listingName}`, 'We have made an offer', [
        { p: `We have offered your property to a screened applicant${a?.total_score !== null && a?.total_score !== undefined ? ` (screening score ${Number(a.total_score)}/100)` : ''}${a?.conditional ? ', on condition of a surety or additional deposit' : ''}.` },
        { p: `They have until ${deadline} to accept. We will confirm as soon as they do.` },
        { note: "Applicants' personal details are kept confidential under POPIA and are not shared in these updates." },
      ]);
      break;
    }

    case 'application_accepted': {
      const start = a?.move_in_date || v.available_from;
      toOwner(`Offer accepted on ${listingName}`, 'The applicant has accepted', [
        { p: `The applicant has accepted our offer for ${listingName}. We are now preparing the lease.` },
        { rows: [['Monthly rent', money(v.monthly_rent)], ['Planned lease start', start ? dateLong(start) : 'to be agreed'], ['Lease term', `${a?.lease_term_months || 12} months`]] },
        { p: 'You will receive the lease for signature once it is ready.' },
      ]);
      break;
    }

    case 'application_declined': {
      toApplicant(`Your application for ${listingName} (ref ${a?.reference})`, 'An update on your application', [
        { p: `Thank you for applying for ${listingName} (${v.area || 'Johannesburg'}). After assessing all applications against our standard criteria, we are unable to offer you this unit.` },
        ...(a?.credit_checked ? [{ p: `If our decision was influenced by your credit report, you are entitled to a free copy of it from ${a.credit_bureau || 'the credit bureau'}, and may dispute anything inaccurate.` }] : []),
        { p: `Your documents will be destroyed within ${ctx.retention_days} days, as set out in the consent you signed.` },
        { p: 'We wish you well in your search, and you are welcome to apply for our other listings.' },
        { button: { label: 'See available rentals', url: `${siteUrl}/apply.html` } },
      ]);
      break;
    }

    case 'tenant_account_invite': {
      toApplicant(`Next step for your lease at ${listingName}`, 'Create your tenant account', [
        { p: 'Thank you for accepting our offer. To receive and sign your lease online, please create your tenant account using this email address:' },
        { rows: [['Email address to use', a?.email || '']] },
        { button: { label: 'Create my tenant account', url: `${siteUrl}/tenant-signup.html` } },
        { p: 'Let us know once you have signed up, and we will send you the lease.' },
      ]);
      break;
    }
  }

  // Never cc someone who is already a recipient.
  for (const e of out) {
    const toSet = new Set(e.to.map((x) => x.toLowerCase()));
    e.cc = [...new Set(e.cc.filter((x) => x && !toSet.has(x.toLowerCase())))];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

async function sendViaResend(email: Email, replyTo: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: email.to, cc: email.cc.length ? email.cc : undefined, reply_to: replyTo, subject: email.subject, html: email.html, text: email.text }),
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const body = await res.json().catch(() => ({}));
  return { ok: true, id: body?.id };
}

// deno-lint-ignore no-explicit-any
export async function processQueue(supabaseAdmin: any, limit = 20) {
  const { data: rows, error } = await supabaseAdmin.rpc('claim_rental_notifications', { p_limit: limit });
  if (error) throw new Error(`claim_rental_notifications: ${error.message}`);
  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  for (const row of rows || []) {
    summary.processed++;
    let status = 'sent';
    let lastError: string | null = null;
    const recipients: unknown[] = [];
    try {
      const emails = buildEmails(row.n_event, row.n_detail, row.n_context);
      if (!emails.length) {
        status = 'skipped';
        lastError = 'Nothing to send for this change';
      } else if (!resendKey()) {
        status = 'failed';
        lastError = 'RESEND_API_KEY is not set for Edge Functions';
      } else {
        const errors: string[] = [];
        for (const e of emails) {
          const r = await sendViaResend(e, row.n_context.admin_email);
          recipients.push({ audience: e.audience, to: e.to, cc: e.cc, subject: e.subject, ok: r.ok, error: r.error || null });
          if (!r.ok) errors.push(`${e.audience}: ${r.error}`);
        }
        if (errors.length) { status = 'failed'; lastError = errors.join(' | '); }
      }
    } catch (err) {
      status = 'failed';
      lastError = (err as Error).message;
    }
    summary[status as 'sent' | 'failed' | 'skipped']++;
    const { error: doneErr } = await supabaseAdmin.rpc('complete_rental_notification', {
      p_id: row.n_id, p_status: status, p_recipients: recipients.length ? recipients : null, p_error: lastError,
    });
    if (doneErr) console.error('complete_rental_notification failed:', doneErr.message);
  }
  return summary;
}

if (typeof Deno !== 'undefined' && Deno.serve) {
  const supabaseAdmin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS_HEADERS });
    try {
      // Work through the queue in batches (max ~100 emails per call).
      const total = { processed: 0, sent: 0, failed: 0, skipped: 0 };
      for (let i = 0; i < 5; i++) {
        const s = await processQueue(supabaseAdmin, 20);
        total.processed += s.processed; total.sent += s.sent; total.failed += s.failed; total.skipped += s.skipped;
        if (s.processed < 20) break;
      }
      return new Response(JSON.stringify(total), { status: 200, headers: CORS_HEADERS });
    } catch (err) {
      console.error('rental-notifications error:', (err as Error).message);
      return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS_HEADERS });
    }
  });
}
