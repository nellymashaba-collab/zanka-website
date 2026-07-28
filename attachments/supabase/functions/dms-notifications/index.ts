// supabase/functions/dms-notifications/index.ts
// Deno runtime. Deploy with: supabase functions deploy dms-notifications
//
// SECRETS REQUIRED (set these via `supabase secrets set`, never in code):
//   RESEND_API_KEY   — your Resend API key
//   SUPABASE_URL     — auto-provided by Supabase at runtime
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase at runtime
//
// This is the one place in the whole DMS where the service role key is
// used, and that's correct: Edge Functions run on Supabase's server,
// never in a user's browser, so the key never leaves a trusted environment.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const FROM_ADDRESS = 'Zanka Group <notifications@zankagroup.co.za>'; // must be a verified domain in Resend
const ADMIN_EMAIL = 'admin@zankagroup.co.za';


// CORS — this function is called directly from the browser (different
// origin than the Edge Function's own domain), so every response needs
// these headers or the browser silently rejects it as "Failed to fetch"
// without ever showing the actual error. This was missing entirely
// before, and had been failing silently everywhere else this function
// is called from — this is just the first place that actually surfaced
// the failure to a user instead of swallowing it in console.error.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// WhatsApp via Twilio — optional. Every call here is wrapped so that
// if these secrets aren't set yet (Twilio/template approval is a
// multi-day external process, not something code alone can finish),
// email notifications keep working unaffected. Nothing throws if
// WhatsApp isn't configured; it just silently skips.
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_WHATSAPP_FROM = Deno.env.get('TWILIO_WHATSAPP_FROM'); // format: whatsapp:+27...
const TWILIO_TEMPLATE_OTP = Deno.env.get('TWILIO_TEMPLATE_OTP');
const TWILIO_TEMPLATE_FICA = Deno.env.get('TWILIO_TEMPLATE_FICA');
const TWILIO_TEMPLATE_EXECUTED = Deno.env.get('TWILIO_TEMPLATE_EXECUTED');
const TWILIO_TEMPLATE_PAYMENT = Deno.env.get('TWILIO_TEMPLATE_PAYMENT');
const TWILIO_TEMPLATE_MAINTENANCE_QUEUED = Deno.env.get('TWILIO_TEMPLATE_MAINTENANCE_QUEUED');
const TWILIO_TEMPLATE_MAINTENANCE_COMPLETE = Deno.env.get('TWILIO_TEMPLATE_MAINTENANCE_COMPLETE');
const TWILIO_TEMPLATE_STATEMENT = Deno.env.get('TWILIO_TEMPLATE_STATEMENT');
const TWILIO_TEMPLATE_NEW_DOCUMENT = Deno.env.get('TWILIO_TEMPLATE_NEW_DOCUMENT');

// Normalizes a South African number in whatever format it was
// entered (074 824 8812, 0748248812, +27748248812, etc.) into the
// E.164 format WhatsApp/Twilio requires (+27748248812).
function formatPhoneForWhatsApp(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('27')) return `whatsapp:+${digits}`;
  if (digits.startsWith('0')) return `whatsapp:+27${digits.slice(1)}`;
  if (digits.length === 9) return `whatsapp:+27${digits}`; // no leading 0 at all
  return null; // unrecognisable format — skip rather than guess wrong
}

async function sendWhatsAppTemplate(phone, contentSid, variables) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !contentSid) {
    return { skipped: true, reason: 'WhatsApp not configured yet' };
  }
  const to = formatPhoneForWhatsApp(phone);
  if (!to) return { skipped: true, reason: 'No usable phone number' };

  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: to,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('WhatsApp send failed:', errText);
      return { ok: false, error: errText };
    }
    return { ok: true };
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return { ok: false, error: err.message };
  }
}

// Resolves who actually counts as "the Owner" for a property —
// either the personal owner_id, or (for entity-owned properties,
// where owner_id is null by design — see the properties table's
// check constraint) the entity's first-linked representative.
// Mirrors get_effective_owner_id() in the database. Needed because
// making owner_id nullable for entity-owned properties would
// otherwise silently break every "notify/sign as Owner" code path
// below, all of which used to assume properties.owner_id was always
// a real person.
async function resolveEffectiveOwnerId(propertyId) {
  if (!propertyId) return null;
  const { data } = await supabaseAdmin.rpc('get_effective_owner_id', { p_property_id: propertyId });
  return data || null;
}

// Shared by both the document-approval flow and the lease-event flow
// below — sends every queued email via Resend and returns the Response.
async function sendEmails(emailsToSend) {
  if (emailsToSend.length === 0) {
    return new Response(JSON.stringify({ skipped: true, reason: 'No matching notification recipients' }), { status: 200, headers: CORS_HEADERS });
  }
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set — cannot send email.');
  }

  const results = [];
  for (const emailPayload of emailsToSend) {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to: emailPayload.to, subject: emailPayload.subject, html: emailPayload.html }),
    });
    if (!resendResponse.ok) {
      const errText = await resendResponse.text();
      results.push({ to: emailPayload.to, ok: false, error: errText });
    } else {
      results.push({ to: emailPayload.to, ok: true });
    }
  }

  const anyFailed = results.some(r => !r.ok);
  return new Response(JSON.stringify({ sent: results }), { status: anyFailed ? 207 : 200, headers: CORS_HEADERS });
}

// Turns the merged template HTML into a flat list of {type, text}
// blocks for direct PDF drawing. Deno's Edge runtime has no
// DOMParser (unlike a browser), so this uses a targeted regex
// instead — safe here specifically because content_html is always
// built by THIS codebase from a known, predictable set of tags
// (h2/h3/p), not arbitrary external HTML.
function htmlToBlocks(html) {
  const blocks = [];
  const stripTags = (s) => s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&#39;/g, "'")
    .trim();
  const tagRegex = /<(h2|h3|p)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const text = stripTags(match[2]);
    if (!text) continue;
    blocks.push({ type: tag === 'h2' ? 'title' : tag === 'h3' ? 'heading' : 'paragraph', text });
  }
  return blocks;
}

// Draws the full executed lease directly as a PDF — Zanka-branded
// header on every page, wrapped/paginated body text, additional
// clauses section, and a signatures page built from real evidence
// (name, timestamp, IP). Mirrors the same direct-drawing approach
// used for tenant invoices (html2canvas proved unreliable there —
// see that code's comments — direct drawing has no such issues).
async function renderExecutedLeasePdf(blocks, clauseBlocks, signatures, meta) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const titleFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  const NAVY = rgb(31 / 255, 42 / 255, 68 / 255);
  const NAVY_DEEP = rgb(20 / 255, 28 / 255, 48 / 255);
  const GOLD = rgb(200 / 255, 155 / 255, 60 / 255);
  const INK = rgb(32 / 255, 36 / 255, 46 / 255);
  const GRAY = rgb(110 / 255, 116 / 255, 130 / 255);
  const BORDER = rgb(0.86, 0.87, 0.89);
  const WHITE = rgb(1, 1, 1);

  const pageW = 595.28, pageH = 841.89; // A4 in points
  const margin = 54;
  const contentW = pageW - margin * 2;
  const bottomLimit = 70;

  let page = pdfDoc.addPage([pageW, pageH]);
  let y = pageH - margin;
  let pageNum = 1;

  const drawHeader = (p) => {
    p.drawRectangle({ x: 0, y: pageH - 46, width: pageW, height: 46, color: NAVY_DEEP });
    p.drawText('ZANKA GROUP', { x: margin, y: pageH - 30, size: 13, font: titleFont, color: WHITE });
    const label = 'EXECUTED LEASE AGREEMENT';
    const w = boldFont.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: pageW - margin - w, y: pageH - 30, size: 8, font: boldFont, color: GOLD });
  };

  const drawFooter = (p, num) => {
    p.drawText(`Zanka Group (Pty) Ltd · ${meta.address || ''}`, { x: margin, y: 30, size: 7.5, font, color: GRAY });
    const pageLabel = `Page ${num}`;
    const w = font.widthOfTextAtSize(pageLabel, 7.5);
    p.drawText(pageLabel, { x: pageW - margin - w, y: 30, size: 7.5, font, color: GRAY });
  };

  const newPage = () => {
    drawFooter(page, pageNum);
    page = pdfDoc.addPage([pageW, pageH]);
    pageNum += 1;
    drawHeader(page);
    y = pageH - 46 - 40;
  };

  const ensureSpace = (needed) => { if (y - needed < bottomLimit) newPage(); };

  const wrapText = (text, useFont, size) => {
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (useFont.widthOfTextAtSize(test, size) > contentW && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  };

  drawHeader(page);
  y = pageH - 46 - 40;

  page.drawText('LEASE AGREEMENT - RESIDENTIAL', { x: margin, y, size: 16, font: titleFont, color: NAVY });
  y -= 22;
  page.drawText('FULLY SIGNED — ACTIVE', { x: margin, y, size: 9, font: boldFont, color: GOLD });
  y -= 26;

  blocks.forEach((block) => {
    if (block.type === 'title') return; // already drew the main title above
    if (block.type === 'heading') {
      ensureSpace(30);
      y -= 6;
      wrapText(block.text.toUpperCase(), boldFont, 11.5).forEach((line) => {
        ensureSpace(16);
        page.drawText(line, { x: margin, y, size: 11.5, font: boldFont, color: NAVY });
        y -= 16;
      });
      y -= 4;
    } else {
      wrapText(block.text, font, 9.5).forEach((line) => {
        ensureSpace(13);
        page.drawText(line, { x: margin, y, size: 9.5, font, color: INK });
        y -= 13;
      });
      y -= 8;
    }
  });

  if (clauseBlocks.length > 0) {
    ensureSpace(30);
    y -= 10;
    page.drawText('ADDITIONAL TERMS', { x: margin, y, size: 12, font: titleFont, color: NAVY });
    y -= 22;
    clauseBlocks.forEach((c) => {
      ensureSpace(18);
      page.drawText(c.title, { x: margin, y, size: 9.5, font: boldFont, color: GOLD });
      y -= 14;
      wrapText(c.text, font, 9.5).forEach((line) => {
        ensureSpace(13);
        page.drawText(line, { x: margin, y, size: 9.5, font, color: INK });
        y -= 13;
      });
      y -= 10;
    });
  }

  // Signatures page — real evidence, own page for clarity.
  newPage();
  page.drawText('SIGNATURES', { x: margin, y, size: 14, font: titleFont, color: NAVY });
  y -= 30;

  signatures.forEach((s) => {
    ensureSpace(70);
    page.drawLine({ start: { x: margin, y }, end: { x: pageW - margin, y }, thickness: 0.5, color: BORDER });
    y -= 18;
    page.drawText(`${s.name} (${s.role})`, { x: margin, y, size: 10.5, font: boldFont, color: NAVY });
    y -= 16;
    page.drawText(`Signed electronically: ${s.signedAt}`, { x: margin, y, size: 9, font, color: INK });
    y -= 14;
    page.drawText(`IP Address: ${s.ip}`, { x: margin, y, size: 8, font, color: GRAY });
    y -= 20;
  });

  drawFooter(page, pageNum);
  return await pdfDoc.save();
}

// Assembles the final executed lease: merged template + enabled
// clauses + a signature block built from the actual verified
// lease_signatures/lease_parties records (name, role, date — the
// real evidentiary data captured during signing, not placeholder
// text). Uploads to the existing private 'documents' bucket and
// returns a long-lived signed URL, same pattern used for tenant
// invoices elsewhere in this build.
//
// Rewritten to produce a real PDF (pdf-lib) instead of an HTML
// string — the HTML version was showing as raw source code rather
// than rendering across devices/apps, the exact problem already
// solved for tenant invoices earlier this session by switching to
// direct PDF generation instead of relying on HTML rendering.
async function generateAndStoreExecutedLease(leaseId, lease, signatures) {
  const { data: template } = lease.template_id
    ? await supabaseAdmin.from('lease_templates').select('content_html').eq('id', lease.template_id).single()
    : { data: null };

  let clauseBlocks = [];
  if (lease.enabled_clause_ids && lease.enabled_clause_ids.length > 0) {
    const { data: clauses } = await supabaseAdmin
      .from('lease_clauses').select('clause_title, clause_text, display_order')
      .in('id', lease.enabled_clause_ids).order('display_order');
    clauseBlocks = (clauses || []).map(c => ({ title: c.clause_title, text: c.clause_text }));
  }

  const mergeValues = {
    TenantName: lease.tenant?.full_name || '',
    OwnerName: '', // resolved below
    PropertyAddress: lease.properties?.address || '',
    MonthlyRental: 'R' + Number(lease.monthly_rent || 0).toLocaleString(),
    DepositRequired: 'R' + Number(lease.deposit_required || 0).toLocaleString(),
    StartDate: lease.start_date, EndDate: lease.end_date,
    LeaseStartDate: lease.start_date, LeaseEndDate: lease.end_date,
  };
  const effectiveOwnerId1 = await resolveEffectiveOwnerId(lease.property_id);
  if (effectiveOwnerId1) {
    const { data: owner } = await supabaseAdmin.from('profiles').select('full_name').eq('id', effectiveOwnerId1).single();
    mergeValues.OwnerName = owner?.full_name || '';
  }

  const mergedTemplate = (template?.content_html || '<p>No template content.</p>').replace(
    /\{\{(\w+)\}\}/g, (m, key) => (key in mergeValues ? String(mergeValues[key]) : m)
  );
  const blocks = htmlToBlocks(mergedTemplate);

  // Real signature evidence — pulled fresh with party names, not
  // reused from the caller's plain lease_signatures rows.
  const { data: sigDetails } = await supabaseAdmin
    .from('lease_signatures')
    .select('party_type, signed_at, ip_address, cryptographic_hash, lease_parties:party_id ( full_name )')
    .eq('lease_id', leaseId)
    .order('signed_at');

  const signatureData = (sigDetails || []).map(s => ({
    name: s.lease_parties?.full_name || s.party_type,
    role: s.party_type,
    signedAt: s.signed_at ? new Date(s.signed_at).toLocaleString() : 'Not recorded',
    ip: s.ip_address || 'Not recorded',
  }));

  const pdfBytes = await renderExecutedLeasePdf(blocks, clauseBlocks, signatureData, {
    address: lease.properties?.address || '',
  });

  const path = `documents/lease-files/${leaseId}/executed-lease.pdf`;
  const { error: uploadError } = await supabaseAdmin.storage.from('documents')
    .upload(path, new Blob([pdfBytes], { type: 'application/pdf' }), { upsert: true, contentType: 'application/pdf' });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: signedUrlData, error: signError } = await supabaseAdmin.storage
    .from('documents').createSignedUrl(path, 60 * 60 * 24 * 365 * 10); // 10 years, same pattern used for other long-lived document links
  if (signError) throw new Error(`Could not sign URL: ${signError.message}`);

  return signedUrlData.signedUrl;
}

// Handles all lease-lifecycle notifications: FICA approval, signature
// requests (including issuing a guarantor's OTP once the tenant has
// signed), full execution, and renewal reminders. Runs with the service
// role client, so it can update `leases`/`lease_signatures` even though
// the caller (a tenant's own browser session, for the signing flow) has
// no direct UPDATE policy on `leases` itself — this function is the
// privileged step that flow delegates to.
async function handleLeaseEvent(eventType, leaseId, payload) {
  if (!leaseId) {
    return new Response(JSON.stringify({ error: 'lease_id is required for lease_event' }), { status: 400, headers: CORS_HEADERS });
  }

  const { data: lease, error: leaseError } = await supabaseAdmin
    .from('leases')
    .select(`
      *,
      properties ( address, owner_id ),
      tenant:tenant_id ( full_name, email, phone ),
      guarantor:guarantor_id ( full_name, email, phone )
    `)
    .eq('id', leaseId)
    .single();

  if (leaseError || !lease) {
    throw new Error(`Could not load lease ${leaseId}: ${leaseError?.message || 'not found'}`);
  }

  const emailsToSend = [];

  if (eventType === 'lease_fica_approved') {
    if (lease.tenant?.email) {
      emailsToSend.push({
        to: lease.tenant.email,
        subject: 'Your FICA documents have been approved',
        html: `
          <p>Hi ${lease.tenant.full_name || 'there'},</p>
          <p>Your FICA documents for ${lease.properties?.address || 'your property'} have been approved. Your lease will be sent for signature shortly.</p>
        `,
      });
    }
    if (lease.tenant?.phone) {
      await sendWhatsAppTemplate(lease.tenant.phone, TWILIO_TEMPLATE_FICA, {
        '1': lease.tenant.full_name || 'there',
        '2': lease.properties?.address || 'your property',
      });
    }
  }

  else if (eventType === 'lease_signature_request') {
    const role = payload.recipient_role; // 'tenant', 'guarantor', or 'owner'
    let party = null;
    if (role === 'guarantor') party = lease.guarantor;
    else if (role === 'tenant') party = lease.tenant;
    else if (role === 'owner') {
      const effectiveOwnerId = await resolveEffectiveOwnerId(lease.property_id);
      if (effectiveOwnerId) {
        const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name, phone').eq('id', effectiveOwnerId).single();
        party = owner;
      }
    }

    let otp = payload.otp;

    // Still generate/store an OTP for Owner too — even though they
    // never have to type it in (lease-sign.js skips that step for
    // them client-side), this value is also the signal the
    // owner-dashboard.js banner check uses to detect "it's genuinely
    // your turn now" (otp_code being set). Removing generation
    // entirely broke that detection — the banner could never appear
    // for Owner since nothing ever set otp_code anymore.
    if (role !== 'tenant' && payload.issue_otp_for_signature_id) {
      otp = String(Math.floor(100000 + Math.random() * 900000));
      const expires = new Date();
      expires.setHours(expires.getHours() + 48);
      const { error: otpError } = await supabaseAdmin.from('lease_signatures').update({
        otp_code: otp,
        otp_expires_at: expires.toISOString(),
      }).eq('id', payload.issue_otp_for_signature_id);
      if (otpError) throw new Error(`Could not issue OTP: ${otpError.message}`);
    }

    // Email and WhatsApp are both best-effort and independent — a
    // missing email no longer skips WhatsApp (and vice versa), unlike
    // the previous version which returned early on !party?.email,
    // silently skipping WhatsApp too even when a phone number existed.
    const roleLabel = role === 'guarantor' ? 'signature as guarantor' : role === 'owner' ? 'signature as owner/landlord' : 'signature';

    if (party?.email) {
      emailsToSend.push({
        to: party.email,
        subject: 'Your lease is ready to sign',
        html: `
          <p>Hi ${party.full_name || 'there'},</p>
          <p>Your lease for ${lease.properties?.address || 'the property'} is ready for your ${roleLabel}.</p>
          ${role === 'owner'
            ? ''
            : `<p><strong>Your verification code:</strong> ${otp || '(see previous email)'}</p>`}
          <p><a href="https://zankagroup.co.za/lease-sign.html?lease=${leaseId}">Sign your lease</a></p>
          ${role === 'owner' ? '' : '<p>This code expires in 48 hours.</p>'}
        `,
      });
    }

    if (party?.phone) {
      await sendWhatsAppTemplate(party.phone, TWILIO_TEMPLATE_OTP, {
        '1': party.full_name || 'there',
        '2': lease.properties?.address || 'the property',
        '3': role === 'owner' ? 'no code needed — just tap the link' : (otp || 'see email'),
      });
    }
  }

  else if (eventType === 'lease_fully_executed') {
    // Verify every REQUIRED party (whichever lease_parties rows exist
    // for this lease) has actually signed before flipping status —
    // don't trust the caller's claim, check the real rows. Generalized
    // beyond the old fixed tenant+guarantor check to cover however
    // many parties this specific lease actually has (owner included).
    const { data: signatures } = await supabaseAdmin.from('lease_signatures').select('*').eq('lease_id', leaseId);
    const allVerified = (signatures || []).length > 0 && (signatures || []).every(s => s.otp_verified);

    if (!allVerified) {
      return new Response(JSON.stringify({ skipped: true, reason: 'Not all required parties have signed yet' }), { status: 200, headers: CORS_HEADERS });
    }

    await supabaseAdmin.from('leases').update({ status: 'Active' }).eq('id', leaseId);
    await supabaseAdmin.from('lease_audit_logs').insert([{
      lease_id: leaseId, user_id: null, action_performed: 'Lease fully executed — all parties signed',
      previous_state: 'Fully Signed', new_state: 'Active',
    }]);

    // Generate the actual downloadable document now — this was the
    // real gap: signature capture existed, but nothing ever assembled
    // the merged template + clauses + signature block into a
    // persistent file. leases.file_url has always existed and the
    // tenant/owner dashboards already render a Download link the
    // moment it's populated — this just finally populates it.
    try {
      const fileUrl = await generateAndStoreExecutedLease(leaseId, lease, signatures);
      await supabaseAdmin.from('leases').update({ file_url: fileUrl }).eq('id', leaseId);
    } catch (docErr) {
      // Don't let document generation block the lease from going
      // Active — the signatures themselves are the legally meaningful
      // part; the rendered document is a convenience artifact on top.
      console.error('Could not generate executed lease document:', docErr.message);
    }

    const recipients = [lease.tenant, lease.guarantor].filter(p => p?.email || p?.phone);
    const effectiveOwnerId2 = await resolveEffectiveOwnerId(lease.property_id);
    if (effectiveOwnerId2) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name, phone').eq('id', effectiveOwnerId2).single();
      if (owner?.email || owner?.phone) recipients.push(owner);
    }
    recipients.forEach(p => {
      if (p.email) {
        emailsToSend.push({
          to: p.email,
          subject: 'Lease fully executed',
          html: `<p>Hi ${p.full_name || 'there'},</p><p>The lease for ${lease.properties?.address || 'the property'} has been signed by all parties and is now Active.</p>`,
        });
      }
    });
    await Promise.all(recipients.filter(p => p.phone).map(p =>
      sendWhatsAppTemplate(p.phone, TWILIO_TEMPLATE_EXECUTED, {
        '1': p.full_name || 'there',
        '2': lease.properties?.address || 'the property',
      })
    ));
  }

  else if (eventType === 'lease_escalation_notice') {
    // 90/60/30-day notices and the "your new rent is effective" email
    // on the day itself — payload.notice_stage tells us which.
    const stage = payload.notice_stage; // '90_day' | '60_day' | '30_day' | 'effective'
    const escalation = payload.escalation || {};
    const subjectMap = {
      '90_day': 'Rent Increase Notice',
      '60_day': 'Reminder: Rent Increase',
      '30_day': 'Official Rent Increase Notice',
      'effective': 'Your New Rent is Effective',
    };
    const recipients = [lease.tenant].filter(p => p?.email);
    const effectiveOwnerId3 = await resolveEffectiveOwnerId(lease.property_id);
    if (effectiveOwnerId3) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', effectiveOwnerId3).single();
      if (owner?.email) recipients.push(owner);
    }
    recipients.forEach(p => emailsToSend.push({
      to: p.email,
      subject: subjectMap[stage] || 'Rent Increase Notice',
      html: `
        <p>Hi ${p.full_name || 'there'},</p>
        <p>${stage === 'effective'
          ? `Your new monthly rent for ${lease.properties?.address || 'the property'} is now R${Number(escalation.new_rental_amount).toLocaleString()}, effective today.`
          : `The rent for ${lease.properties?.address || 'the property'} is scheduled to increase to R${Number(escalation.new_rental_amount).toLocaleString()} on ${escalation.effective_date}.`}</p>
      `,
    }));
  }

  else if (eventType === 'lease_renewal_reminder' || eventType === 'lease_rollover_notice') {
    const isRollover = eventType === 'lease_rollover_notice';
    const recipients = [lease.tenant].filter(p => p?.email);
    const effectiveOwnerId4 = await resolveEffectiveOwnerId(lease.property_id);
    if (effectiveOwnerId4) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', effectiveOwnerId4).single();
      if (owner?.email) recipients.push(owner);
    }
    recipients.forEach(p => emailsToSend.push({
      to: p.email,
      subject: isRollover ? 'Lease moved to month-to-month' : 'Your lease is coming up for renewal',
      html: `
        <p>Hi ${p.full_name || 'there'},</p>
        <p>${isRollover
          ? `The fixed-term lease for ${lease.properties?.address || 'the property'} has now moved to a month-to-month arrangement, as no renewal or termination was recorded before the end date.`
          : `The lease for ${lease.properties?.address || 'the property'} is due to expire on ${lease.end_date}. Please contact Zanka Group regarding renewal.`}</p>
      `,
    }));
  }

  return await sendEmails(emailsToSend);
}

// Handles inspection signing OTP emails. Runs with the service role
// client, same reasoning as handleLeaseEvent — issuing an OTP is a
// privileged write (an admin/partner triggers it on behalf of the
// tenant/owner, not the signer themselves), and confirming an
// inspection genuinely exists before emailing anyone needs to bypass
// RLS from the caller's perspective safely.
async function handleInspectionEvent(eventType, inspectionId, payload) {
  if (!inspectionId) {
    return new Response(JSON.stringify({ error: 'inspection_id is required for inspection_event' }), { status: 400, headers: CORS_HEADERS });
  }

  const { data: inspection, error: inspError } = await supabaseAdmin
    .from('lease_inspections')
    .select(`
      *,
      properties ( address, owner_id ),
      leases ( tenant_id )
    `)
    .eq('id', inspectionId)
    .single();

  if (inspError || !inspection) {
    throw new Error(`Could not load inspection ${inspectionId}: ${inspError?.message || 'not found'}`);
  }

  const emailsToSend = [];

  if (eventType === 'inspection_signature_request') {
    const role = payload.recipient_role; // 'tenant' or 'owner'
    let party = null;
    let otp = null;
    const expires = new Date();
    expires.setHours(expires.getHours() + 48);

    if (role === 'tenant') {
      const tenantId = inspection.leases?.tenant_id;
      if (!tenantId) throw new Error('This inspection has no lease/tenant attached.');
      const { data: tenant } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', tenantId).single();
      party = tenant;
      otp = String(Math.floor(100000 + Math.random() * 900000));
      await supabaseAdmin.from('lease_inspections').update({
        tenant_otp_code: otp, tenant_otp_expires_at: expires.toISOString(),
      }).eq('id', inspectionId);
    } else if (role === 'owner') {
      const ownerId = await resolveEffectiveOwnerId(inspection.property_id);
      if (!ownerId) throw new Error('This inspection has no property owner resolvable.');
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', ownerId).single();
      party = owner;
      otp = String(Math.floor(100000 + Math.random() * 900000));
      await supabaseAdmin.from('lease_inspections').update({
        owner_otp_code: otp, owner_otp_expires_at: expires.toISOString(),
      }).eq('id', inspectionId);
    }

    if (!party?.email) throw new Error(`No email on file for the ${role} on this inspection.`);

    emailsToSend.push({
      to: party.email,
      subject: 'Inspection report ready for your signature',
      html: `
        <p>Hi ${party.full_name || 'there'},</p>
        <p>An inspection report for ${inspection.properties?.address || 'your property'} is ready for your review and signature.</p>
        <p><strong>Your verification code:</strong> ${otp}</p>
        <p><a href="https://zankagroup.co.za/inspection-history.html?id=${inspectionId}">Review and sign</a></p>
        <p>This code expires in 48 hours.</p>
      `,
    });
  }

  return await sendEmails(emailsToSend);
}

// Handles maintenance request lifecycle notifications: request logged
// (tenant confirmation, plus owner/rep heads-up), and work completed.
// Runs with the service role client for the same reason as the other
// handlers — reading the tenant's/owner's contact details needs to
// bypass RLS safely from a privileged server context.
async function handleMaintenanceEvent(eventType, maintenanceRequestId) {
  if (!maintenanceRequestId) {
    return new Response(JSON.stringify({ error: 'maintenance_request_id is required' }), { status: 400, headers: CORS_HEADERS });
  }

  const { data: request, error: reqError } = await supabaseAdmin
    .from('maintenance_requests')
    .select('*, tenant:tenant_id ( full_name, email, phone ), properties:property_id ( address )')
    .eq('id', maintenanceRequestId)
    .single();

  if (reqError || !request) {
    throw new Error(`Could not load maintenance request ${maintenanceRequestId}: ${reqError?.message || 'not found'}`);
  }

  const emailsToSend = [];
  const address = request.properties?.address || 'your property';

  if (eventType === 'maintenance_request_created') {
    if (request.tenant?.email) {
      emailsToSend.push({
        to: request.tenant.email,
        subject: 'Your maintenance request has been logged',
        html: `<p>Hi ${request.tenant.full_name || 'there'},</p><p>Your maintenance request "${request.title}" for ${address} has been logged and is now in the queue. We'll update you once work begins.</p>`,
      });
    }
    if (request.tenant?.phone) {
      await sendWhatsAppTemplate(request.tenant.phone, TWILIO_TEMPLATE_MAINTENANCE_QUEUED, {
        '1': request.tenant.full_name || 'there',
        '2': request.title,
        '3': address,
      });
    }

    // Also notify whoever's responsible for the property — same
    // effective-owner resolution used everywhere else, so this works
    // correctly for entity-owned properties too.
    const effectiveOwnerId = await resolveEffectiveOwnerId(request.property_id);
    if (effectiveOwnerId) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', effectiveOwnerId).single();
      if (owner?.email) {
        emailsToSend.push({
          to: owner.email,
          subject: 'New maintenance request logged',
          html: `<p>Hi ${owner.full_name || 'there'},</p><p>A new maintenance request "${request.title}" has been logged for ${address}.</p>`,
        });
      }
    }
  }

  else if (eventType === 'maintenance_request_completed') {
    if (request.tenant?.email) {
      emailsToSend.push({
        to: request.tenant.email,
        subject: 'Your maintenance request has been completed',
        html: `<p>Hi ${request.tenant.full_name || 'there'},</p><p>The maintenance work for "${request.title}" at ${address} has been completed. Thank you for your patience.</p>`,
      });
    }
    if (request.tenant?.phone) {
      await sendWhatsAppTemplate(request.tenant.phone, TWILIO_TEMPLATE_MAINTENANCE_COMPLETE, {
        '1': request.tenant.full_name || 'there',
        '2': request.title,
        '3': address,
      });
    }
  }

  return await sendEmails(emailsToSend);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS });
  }

  const { document_id, status, recipient_context, meta_notes, lease_event, lease_id, inspection_event, inspection_id, maintenance_event, maintenance_request_id } = payload;

  // ---------------- Lease Management events ----------------
  // Handled entirely separately from the document-approval flow above —
  // no `documents` row is involved, these read/write `leases` and
  // `lease_signatures` directly.
  if (lease_event) {
    try {
      return await handleLeaseEvent(lease_event, lease_id, payload);
    } catch (err) {
      console.error('lease_event error:', err.message);
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // ---------------- Inspection signing events ----------------
  if (inspection_event) {
    try {
      return await handleInspectionEvent(inspection_event, inspection_id, payload);
    } catch (err) {
      console.error('inspection_event error:', err.message);
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }

  // ---------------- Maintenance request events ----------------
  if (maintenance_event) {
    try {
      return await handleMaintenanceEvent(maintenance_event, maintenance_request_id);
    } catch (err) {
      console.error('maintenance_event error:', err.message);
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
    }
  }

  if (!document_id || !status || !recipient_context) {
    return new Response(JSON.stringify({ error: 'document_id, status and recipient_context are required' }), { status: 400, headers: CORS_HEADERS });
  }

  try {
    // Pull the document plus everything we might need to address an email,
    // using the service role client so RLS never gets in the way of a
    // legitimate server-side notification lookup.
    const { data: doc, error: docError } = await supabaseAdmin
      .from('documents')
      .select(`
        *,
        properties ( address, owner_id ),
        uploader:profiles!uploaded_by ( full_name, email )
      `)
      .eq('id', document_id)
      .single();

    if (docError || !doc) {
      throw new Error(`Could not load document ${document_id}: ${docError?.message || 'not found'}`);
    }

    // Build a LIST of emails to send, rather than picking exactly one.
    // This is what lets a single Rent/Utility Invoice approval notify
    // both the tenant and the owner from one Edge Function call, while
    // every other approved category still just notifies the owner.
    const emailsToSend = [];

    // ---------------- Context A: Pending Approval → notify Admin ----------------
    if (status === 'Pending Approval') {
      emailsToSend.push({
        to: ADMIN_EMAIL,
        subject: `New ${doc.category} awaiting approval`,
        html: `
          <p>${doc.uploader?.full_name || 'A partner'} uploaded a new document requiring review.</p>
          <ul>
            <li><strong>Category:</strong> ${doc.category}</li>
            <li><strong>Property:</strong> ${doc.properties?.address || '—'}</li>
            <li><strong>Total:</strong> R${Number(doc.total_amount).toLocaleString()}</li>
          </ul>
          <p>${meta_notes || ''}</p>
          <p><a href="https://zankagroup.co.za/admin-partner-dms.html">Review in the Admin Dashboard</a></p>
        `,
      });
    }

    // ---------------- Context B: Rejected → notify the uploading Partner ----------------
    if (status === 'Rejected') {
      const partnerEmail = doc.uploader?.email;
      if (partnerEmail) {
        emailsToSend.push({
          to: partnerEmail,
          subject: `Your ${doc.category} submission needs changes`,
          html: `
            <p>Hi ${doc.uploader?.full_name || 'there'},</p>
            <p>Your recent ${doc.category} submission was not approved. Feedback from the reviewer:</p>
            <blockquote>${meta_notes || 'No specific notes were provided.'}</blockquote>
            <p>Please make the necessary corrections and resubmit.</p>
          `,
        });
      }
    }

    // Categories that reach both owner and tenant. Kept as a plain list
    // here (rather than importing shared config) since this function
    // runs in Deno, separate from the dashboard JS files.
    const OWNER_TENANT_CATEGORIES = [
      'Lease', 'Rent/Utility Invoice', 'Inspection Report', 'Pictures', 'Bulletin',
    ];

    // ---------------- Approved, owner+tenant category → notify Tenant too ----------------
    if (status === 'Approved' && OWNER_TENANT_CATEGORIES.includes(doc.category)) {
      if (doc.tenant_id) {
        const { data: tenant } = await supabaseAdmin
          .from('profiles').select('email, full_name, phone').eq('id', doc.tenant_id).single();
        const isRentalInvoice = doc.category === 'Rent/Utility Invoice';
        if (tenant?.email) {
          emailsToSend.push({
            to: tenant.email,
            subject: isRentalInvoice ? `Your rental statement is ready` : `A new ${doc.category.toLowerCase()} has been added to your account`,
            html: `
              <p>Hi ${tenant.full_name || 'there'},</p>
              <p>${isRentalInvoice
                ? `Your rental statement for ${doc.properties?.address || 'your property'} is now available in your Tenant Portal, under Rental Breakdown.`
                : `A new ${doc.category} for ${doc.properties?.address || 'your property'} is now available in your Tenant Portal.`}</p>
              ${doc.total_amount ? `<p><strong>Total:</strong> R${Number(doc.total_amount).toLocaleString()}</p>` : ''}
              <p><a href="https://zankagroup.co.za/tenant-dashboard.html">View in your Tenant Portal</a></p>
            `,
          });
        }
        if (tenant?.phone) {
          if (isRentalInvoice) {
            await sendWhatsAppTemplate(tenant.phone, TWILIO_TEMPLATE_STATEMENT, {
              '1': tenant.full_name || 'there',
              '2': doc.statement_month ? new Date(doc.statement_month).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' }) : 'this period',
              '3': Number(doc.total_amount || 0).toLocaleString(),
              '4': 'https://zankagroup.co.za/tenant-dashboard.html',
            });
          } else {
            await sendWhatsAppTemplate(tenant.phone, TWILIO_TEMPLATE_NEW_DOCUMENT, {
              '1': tenant.full_name || 'there',
              '2': doc.category,
              '3': 'https://zankagroup.co.za/tenant-dashboard.html',
            });
          }
        }
      }
      // Owner+tenant categories fall through to the owner notification below too.
    }

    // ---------------- Approved, ANY category → notify Owner ----------------
    // Every approved document notifies the owner. Owner+tenant categories
    // additionally notified the tenant just above.
    if (status === 'Approved') {
      const ownerId = doc.owner_id || await resolveEffectiveOwnerId(doc.property_id);
      if (ownerId) {
        const { data: owner } = await supabaseAdmin
          .from('profiles').select('email, full_name, phone').eq('id', ownerId).single();
        if (owner?.email) {
          emailsToSend.push({
            to: owner.email,
            subject: `A new ${doc.category.toLowerCase()} has been added to your account`,
            html: `
              <p>Hi ${owner.full_name || 'there'},</p>
              <p>A new ${doc.category} for ${doc.properties?.address || 'your property'} is now available in your Owner Portal.</p>
              ${doc.total_amount ? `<p><strong>Total:</strong> R${Number(doc.total_amount).toLocaleString()}</p>` : ''}
              <p><a href="https://zankagroup.co.za/owner-dashboard.html">View in your Owner Portal</a></p>
            `,
          });
        }
        if (owner?.phone) {
          await sendWhatsAppTemplate(owner.phone, TWILIO_TEMPLATE_NEW_DOCUMENT, {
            '1': owner.full_name || 'there',
            '2': doc.category,
            '3': 'https://zankagroup.co.za/owner-dashboard.html',
          });
        }
      }
    }

    return await sendEmails(emailsToSend);
  } catch (err) {
    console.error('dms-notifications error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
});
