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

// Assembles the final executed lease: merged template + enabled
// clauses + a signature block built from the actual verified
// lease_signatures/lease_parties records (name, role, date — the
// real evidentiary data captured during signing, not placeholder
// text). Uploads to the existing private 'documents' bucket and
// returns a long-lived signed URL, same pattern used for tenant
// invoices elsewhere in this build.
async function generateAndStoreExecutedLease(leaseId, lease, signatures) {
  const { data: template } = lease.template_id
    ? await supabaseAdmin.from('lease_templates').select('content_html').eq('id', lease.template_id).single()
    : { data: null };

  let clausesHtml = '';
  if (lease.enabled_clause_ids && lease.enabled_clause_ids.length > 0) {
    const { data: clauses } = await supabaseAdmin
      .from('lease_clauses').select('clause_title, clause_text, display_order')
      .in('id', lease.enabled_clause_ids).order('display_order');
    clausesHtml = (clauses || [])
      .map(c => `<div style="margin-bottom:14px;"><p style="font-weight:700;margin:0 0 4px 0;">${c.clause_title}</p><p style="margin:0;">${c.clause_text}</p></div>`)
      .join('');
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
  if (lease.properties?.owner_id) {
    const { data: owner } = await supabaseAdmin.from('profiles').select('full_name').eq('id', lease.properties.owner_id).single();
    mergeValues.OwnerName = owner?.full_name || '';
  }

  const mergedTemplate = (template?.content_html || '<p>No template content.</p>').replace(
    /\{\{(\w+)\}\}/g, (m, key) => (key in mergeValues ? String(mergeValues[key]) : m)
  );

  // Real signature evidence — pulled fresh with party names, not
  // reused from the caller's plain lease_signatures rows.
  const { data: sigDetails } = await supabaseAdmin
    .from('lease_signatures')
    .select('party_type, signed_at, ip_address, cryptographic_hash, lease_parties:party_id ( full_name )')
    .eq('lease_id', leaseId)
    .order('signed_at');

  const signatureBlockHtml = (sigDetails || []).map(s => `
    <div style="border-top:1px solid #ECEDF1; padding-top:12px; margin-top:12px;">
      <p style="margin:0; font-weight:700;">${s.lease_parties?.full_name || s.party_type} <span style="font-weight:400; color:#8A90A0;">(${s.party_type})</span></p>
      <p style="margin:2px 0 0 0; font-size:12px; color:#8A90A0;">Signed electronically ${s.signed_at ? new Date(s.signed_at).toLocaleString() : ''}${s.ip_address ? ' · IP ' + s.ip_address : ''}</p>
    </div>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Executed Lease — ${lease.properties?.address || ''}</title>
<style>
  body{ font-family: Georgia, serif; max-width:800px; margin:40px auto; padding:0 24px; color:#20242E; line-height:1.6; }
  .header{ background:#141C30; color:#fff; padding:24px; border-radius:8px; margin-bottom:24px; }
  .header p{ margin:0; }
  .badge{ display:inline-block; background:#C89B3C; color:#141C30; font-weight:700; font-size:12px; padding:4px 10px; border-radius:999px; margin-top:8px; }
</style></head>
<body>
  <div class="header">
    <p style="font-size:11px; letter-spacing:0.2em; color:#C89B3C; text-transform:uppercase;">Zanka Group</p>
    <p style="font-size:22px; font-weight:700;">Executed Lease Agreement</p>
    <span class="badge">FULLY SIGNED — ACTIVE</span>
  </div>
  <div>${mergedTemplate}</div>
  <hr style="border:none; border-top:1px solid #ECEDF1; margin:24px 0;">
  <div>${clausesHtml}</div>
  <h3 style="margin-top:32px;">Signatures</h3>
  ${signatureBlockHtml}
  <p style="font-size:11px; color:#9AA0AE; margin-top:32px;">Zanka Group (Pty) Ltd · Sandton, Johannesburg, South Africa · zankagroup.co.za</p>
</body></html>`;

  const path = `documents/lease-files/${leaseId}/executed-lease.html`;
  const { error: uploadError } = await supabaseAdmin.storage.from('documents')
    .upload(path, new Blob([html], { type: 'text/html' }), { upsert: true, contentType: 'text/html' });
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
      tenant:tenant_id ( full_name, email ),
      guarantor:guarantor_id ( full_name, email )
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
  }

  else if (eventType === 'lease_signature_request') {
    const role = payload.recipient_role; // 'tenant', 'guarantor', or 'owner'
    let party = null;
    if (role === 'guarantor') party = lease.guarantor;
    else if (role === 'tenant') party = lease.tenant;
    else if (role === 'owner' && lease.properties?.owner_id) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', lease.properties.owner_id).single();
      party = owner;
    }

    let otp = payload.otp;

    // Issuing the next party's OTP happens here, server-side, at the
    // moment the previous signer's signature completes — this is the
    // sequential trigger (Tenant -> Guarantor -> Owner). This write now
    // happens UNCONDITIONALLY, before any email-address check — it
    // used to happen after, which meant a missing email silently
    // blocked the entire signing sequence, not just the notification.
    // The OTP in the database is the real source of truth regardless
    // of whether an email can be sent for it.
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

    // Email is now best-effort — no email on file skips just the
    // notification, not the OTP that was already saved above.
    if (!party?.email) {
      return await sendEmails(emailsToSend); // emailsToSend is empty here — returns { skipped: true }
    }

    const roleLabel = role === 'guarantor' ? 'signature as guarantor' : role === 'owner' ? 'signature as owner/landlord' : 'signature';
    emailsToSend.push({
      to: party.email,
      subject: 'Your lease is ready to sign',
      html: `
        <p>Hi ${party.full_name || 'there'},</p>
        <p>Your lease for ${lease.properties?.address || 'the property'} is ready for your ${roleLabel}.</p>
        <p><strong>Your verification code:</strong> ${otp || '(see previous email)'}</p>
        <p><a href="https://zankagroup.co.za/lease-sign.html?lease=${leaseId}">Sign your lease</a></p>
        <p>This code expires in 48 hours.</p>
      `,
    });
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

    const recipients = [lease.tenant, lease.guarantor].filter(p => p?.email);
    if (lease.properties?.owner_id) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', lease.properties.owner_id).single();
      if (owner?.email) recipients.push(owner);
    }
    recipients.forEach(p => emailsToSend.push({
      to: p.email,
      subject: 'Lease fully executed',
      html: `<p>Hi ${p.full_name || 'there'},</p><p>The lease for ${lease.properties?.address || 'the property'} has been signed by all parties and is now Active.</p>`,
    }));
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
    if (lease.properties?.owner_id) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', lease.properties.owner_id).single();
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
    if (lease.properties?.owner_id) {
      const { data: owner } = await supabaseAdmin.from('profiles').select('email, full_name').eq('id', lease.properties.owner_id).single();
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
      const ownerId = inspection.properties?.owner_id;
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

  const { document_id, status, recipient_context, meta_notes, lease_event, lease_id, inspection_event, inspection_id } = payload;

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
          .from('profiles').select('email, full_name').eq('id', doc.tenant_id).single();
        if (tenant?.email) {
          const isRentalInvoice = doc.category === 'Rent/Utility Invoice';
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
      }
      // Owner+tenant categories fall through to the owner notification below too.
    }

    // ---------------- Approved, ANY category → notify Owner ----------------
    // Every approved document notifies the owner. Owner+tenant categories
    // additionally notified the tenant just above.
    if (status === 'Approved') {
      const ownerId = doc.owner_id || doc.properties?.owner_id;
      if (ownerId) {
        const { data: owner } = await supabaseAdmin
          .from('profiles').select('email, full_name').eq('id', ownerId).single();
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
      }
    }

    return await sendEmails(emailsToSend);
  } catch (err) {
    console.error('dms-notifications error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS_HEADERS });
  }
});
