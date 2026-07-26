// Zanka Group — Lease electronic signing page 9h55
// Requires supabase-client.js and auth.js loaded first.
// Reached via ?lease=<lease_id> from the emailed signature request.

let signCurrentUser = null;
let signLeaseId = null;
let signatureRow = null;

// auth.js's requireSession() only checks a single expected role. This
// page needs to accept several (tenant, guarantor-as-tenant, or owner)
// without touching that shared file, since it's used everywhere else
// with the single-role assumption baked in.
async function requireEitherSession(allowedRoles) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = 'tenant-login.html';
    return null;
  }
  const { data: profile, error } = await supabaseClient
    .from('profiles').select('*').eq('id', session.user.id).single();

  if (error || !profile || !allowedRoles.includes(profile.role)) {
    await supabaseClient.auth.signOut();
    window.location.href = 'tenant-login.html';
    return null;
  }
  return profile;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Owners now sign too (v2), alongside tenants and guarantors (who
  // are tenant-role in this system). requireSession only checks a
  // single role, so this does its own check accepting either.
  signCurrentUser = await requireEitherSession(['tenant', 'owner']);
  if (!signCurrentUser) return;

  const params = new URLSearchParams(window.location.search);
  signLeaseId = params.get('lease');
  if (!signLeaseId) {
    showUnavailable('No lease specified in the link.');
    return;
  }

  await loadSignatureState();
});

async function loadSignatureState() {
  // RLS ("Signers can view their own signature row") means this only
  // ever returns THIS person's own row — a tenant can't fetch someone
  // else's signature record by guessing a lease id.
  const { data, error } = await supabaseClient
    .from('lease_signatures')
    .select('*')
    .eq('lease_id', signLeaseId)
    .eq('signed_by', signCurrentUser.id)
    .maybeSingle();

  document.getElementById('sign-loading').classList.add('hidden');

  if (error || !data) {
    showUnavailable("We couldn't find a signature request for you on this lease.");
    return;
  }

  signatureRow = data;

  if (signatureRow.otp_verified && signatureRow.signed_at) {
    showComplete('You already signed this lease on ' + new Date(signatureRow.signed_at).toLocaleDateString() + '.');
    return;
  }

  // Owner skips the OTP step entirely — they're already authenticated
  // via their normal platform login (not an anonymous emailed link
  // like Tenant/Guarantor), so a second one-time code is redundant
  // friction rather than meaningful extra verification. Their
  // signature event still gets recorded with the same typed-name +
  // consent + IP/hash evidence as everyone else in submitSignature() —
  // only the OTP gate itself is skipped, not the signing evidence.
  if (signatureRow.party_type === 'Owner') {
    showSigningForm();
    return;
  }

  if (!signatureRow.otp_code) {
    // Guarantor row exists but no OTP issued yet — tenant hasn't signed.
    showUnavailable("You'll receive your verification code once the primary tenant has signed.");
    return;
  }

  showOtpEntry();
}

function showUnavailable(text) {
  document.getElementById('sign-unavailable-text').textContent = text;
  document.getElementById('sign-unavailable').classList.remove('hidden');
}

function showComplete(text) {
  document.getElementById('sign-complete-text').textContent = text;
  document.getElementById('sign-complete').classList.remove('hidden');
}

function showOtpEntry() {
  document.getElementById('sign-otp-wrap').classList.remove('hidden');
  document.getElementById('sign-otp-verify').addEventListener('click', verifyOtp);
}

function verifyOtp() {
  const errorEl = document.getElementById('sign-otp-error');
  errorEl.classList.add('hidden');

  const entered = document.getElementById('sign-otp-input').value.trim();
  if (new Date(signatureRow.otp_expires_at) < new Date()) {
    errorEl.textContent = 'This code has expired. Contact Zanka Group for a new link.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (entered !== signatureRow.otp_code) {
    errorEl.textContent = 'Incorrect code. Please try again.';
    errorEl.classList.remove('hidden');
    return;
  }

  document.getElementById('sign-otp-wrap').classList.add('hidden');
  showSigningForm();
}

async function showSigningForm() {
  const { data: lease } = await supabaseClient
    .from('leases').select('template_id, enabled_clause_ids').eq('id', signLeaseId).single();

  if (lease?.template_id) {
    const { data: template } = await supabaseClient.from('lease_templates').select('content_html').eq('id', lease.template_id).single();
    document.getElementById('sign-document-preview').innerHTML = template?.content_html || '<p>Document preview unavailable.</p>';
  }

  document.getElementById('sign-form-wrap').classList.remove('hidden');
  document.getElementById('sign-submit').addEventListener('click', submitSignature);
}

async function submitSignature() {
  const errorEl = document.getElementById('sign-form-error');
  errorEl.classList.add('hidden');

  const typedName = document.getElementById('sign-typed-name').value.trim();
  const consent = document.getElementById('sign-consent').checked;

  if (!typedName) { errorEl.textContent = 'Type your full name to sign.'; errorEl.classList.remove('hidden'); return; }
  if (!consent) { errorEl.textContent = 'You must confirm the consent checkbox to sign.'; errorEl.classList.remove('hidden'); return; }

  const submitBtn = document.getElementById('sign-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing…';

  try {
    const ipAddress = await fetchClientIp();
    const userAgent = navigator.userAgent;
    const signedAt = new Date().toISOString();
    const hash = await computeSignatureHash({ typedName, leaseId: signLeaseId, partyType: signatureRow.party_type, signedAt });

    const { error } = await supabaseClient.from('lease_signatures').update({
      signature_method: 'Typed Name + OTP',
      ip_address: ipAddress,
      user_agent: userAgent,
      otp_verified: true,
      cryptographic_hash: hash,
      signed_at: signedAt,
    }).eq('id', signatureRow.id);
    if (error) throw error;

    await supabaseClient.from('lease_audit_logs').insert([{
      lease_id: signLeaseId,
      user_id: signCurrentUser.id,
      action_performed: `${signatureRow.party_type} signed electronically`,
      new_state: signatureRow.party_type === 'Tenant' ? 'Partially Signed' : 'Fully Signed',
    }]);

    await advanceLeaseAfterSignature();

    document.getElementById('sign-form-wrap').classList.add('hidden');
    showComplete('Thank you — your signature has been recorded.');
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign Lease';
  }
}

// Handles the sequential guarantor trigger and the final Active flip.
// Runs with the SIGNER's own session (not admin) — every write here is
// covered by the "Signers can complete their own signature" / "Signers
// can log their own signing action" RLS policies, except the final
// lease.status update, which needs an admin-privileged path since a
// tenant/guarantor has no UPDATE policy on `leases` itself. That final
// step is delegated to the Edge Function via notifyLeaseEvent below,
// using its service-role client — same pattern as everywhere else in
// this build where a privileged write is needed from a non-admin session.
async function advanceLeaseAfterSignature() {
  const { data: allSignatures } = await supabaseClient
    .from('lease_signatures').select('*, lease_parties:party_id ( party_type )').eq('lease_id', signLeaseId).order('created_at', { ascending: true });

  // Fixed sequence: Tenant, then Guarantor (if one exists on this
  // lease), then Owner. Only rows that actually exist for this lease
  // are in allSignatures — a lease with no guarantor simply never had
  // a Guarantor row created, so the sequence naturally skips it.
  const order = ['Tenant', 'Guarantor', 'Owner'];
  const byType = {};
  (allSignatures || []).forEach(s => { byType[s.party_type || s.lease_parties?.party_type] = s; });

  const sequence = order.filter(type => byType[type]);
  const doneUpToIndex = sequence.findIndex(type => !byType[type].otp_verified);

  if (doneUpToIndex === -1) {
    // Everyone in the sequence has signed. The Edge Function's own
    // 'lease_fully_executed' handler already generates the executed
    // lease document (with real signature evidence pulled fresh from
    // the database) and sets leases.file_url itself, via its
    // service-role client — confirmed by reading dms-notifications'
    // actual source. No client-side document generation needed here;
    // an earlier version of this code duplicated that work
    // unnecessarily. Only the first invoice is genuinely this file's
    // responsibility — nothing server-side creates that.
    try {
      await generateFirstRentalInvoice(signLeaseId);
    } catch (err) {
      console.error('First invoice generation failed (lease will still activate):', err);
    }
    await notifyLeaseEvent('lease_fully_executed', {});
    return;
  }

  const nextParty = byType[sequence[doneUpToIndex]];
  if (nextParty && !nextParty.otp_code) {
    // The Edge Function's 'lease_signature_request' handler already
    // generates and writes the next party's OTP itself (server-side,
    // confirmed by reading its source) whenever issue_otp_for_signature_id
    // is present and the role isn't 'tenant'. Writing one client-side
    // first (an earlier version of this code did) was pure duplicated
    // work — the server ignores it and overwrites it with its own
    // value anyway, so it added a moment of inconsistent DB state for
    // no benefit. Just ask the server to issue it.
    await notifyLeaseEvent('lease_signature_request', {
      recipient_role: sequence[doneUpToIndex].toLowerCase(),
      issue_otp_for_signature_id: nextParty.id,
    });
  }
}

async function fetchClientIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    return data.ip || 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function computeSignatureHash({ typedName, leaseId, partyType, signedAt }) {
  const payload = `${leaseId}|${partyType}|${typedName}|${signedAt}`;
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function notifyLeaseEvent(eventType, extra) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ lease_event: eventType, lease_id: signLeaseId, ...extra }),
    });
  } catch (err) {
    console.error('Lease notification failed:', err);
  }
}


/* ================================================================
   FIRST RENTAL INVOICE — generated once the lease is fully signed.
   1st month's rent, plus the deposit IF it was still unpaid at
   signing (deposit_status !== 'Fully_Paid'). Reuses the same direct-
   jsPDF drawing approach as the admin invoice generator (html2canvas
   proved unreliable earlier this session — see that code's comments).
   ================================================================ */

async function generateFirstRentalInvoice(leaseId) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (typeof jsPDFCtor !== 'function') throw new Error('PDF library failed to load.');

  const { data: lease, error: leaseErr } = await supabaseClient
    .from('leases').select('*').eq('id', leaseId).single();
  if (leaseErr) throw leaseErr;

  const { data: property } = await supabaseClient
    .from('properties').select('address').eq('id', lease.property_id).single();
  const { data: tenantProfile } = await supabaseClient
    .from('profiles').select('full_name, phone').eq('id', lease.tenant_id).single();

  const includeDeposit = lease.deposit_status !== 'Fully_Paid';
  const netRental = Number(lease.monthly_rent) || 0;
  const deposit = includeDeposit ? (Number(lease.deposit_required) || 0) : 0;
  const totalDue = netRental + deposit;

  const invoiceDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  // 1. Create the invoice row (trigger assigns invoice_number, same
  // as the admin-generated recurring invoices).
  const { data: invoice, error: invError } = await supabaseClient.from('tenant_invoices').insert([{
    property_id: lease.property_id,
    tenant_id: lease.tenant_id,
    invoice_date: invoiceDate,
    due_date: dueDateStr,
    net_rental: netRental,
    electricity: 0, water: 0, sewerage: 0, refuse: 0,
    deposit: deposit,
    total_due: totalDue,
    status: 'Sent',
    created_by: signCurrentUser.id, // whoever actually completes the signing sequence — often the Owner, not the Tenant
  }]).select().single();
  if (invError) throw invError;

  try {
    // 2. Render as PDF directly.
    const pdfBlob = renderFirstInvoicePdf(jsPDFCtor, {
      invoiceNumber: invoice.invoice_number,
      invoiceDate, dueDate: dueDateStr,
      tenantName: tenantProfile?.full_name || '',
      propertyAddress: property?.address || '',
      netRental, deposit, includeDeposit, totalDue,
    });

    // 3. Upload it.
    const storagePath = `documents/tenant-invoices/${invoice.id}/${invoice.invoice_number}.pdf`;
    const { data: { session } } = await supabaseClient.auth.getSession();
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, true);
      xhr.setRequestHeader('Authorization', `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Invoice upload failed: ' + xhr.status));
      xhr.onerror = () => reject(new Error('Network error uploading invoice.'));
      xhr.send(pdfBlob);
    });

    await supabaseClient.from('tenant_invoices').update({ storage_path: storagePath }).eq('id', invoice.id);

    // 4. documents row, so it shows in the tenant's Invoices card.
    await supabaseClient.from('documents').insert([{
      category: 'Rent/Utility Invoice',
      property_id: lease.property_id,
      tenant_id: lease.tenant_id,
      statement_month: invoiceDate.slice(0, 7) + '-01',
      document_date: invoiceDate,
      due_date: dueDateStr,
      original_filename: `${invoice.invoice_number}.pdf`,
      generated_filename: `${invoice.invoice_number}.pdf`,
      storage_path: storagePath,
      subtotal: totalDue, discount: 0, vat: 0, total_amount: totalDue,
      status: 'Approved',
      uploaded_by: signCurrentUser.id,
      operational_table: 'tenant_invoices',
      operational_id: String(invoice.id),
    }]);

    // 5. The actual payable record — linked to this specific invoice
    // (tenant_invoice_id), which is what "Pay Now" reads.
    await supabaseClient.from('payments').insert([{
      tenant_id: lease.tenant_id,
      tenant_invoice_id: invoice.id,
      amount: totalDue,
      due_date: dueDateStr,
      status: 'Pending',
    }]);
  } catch (innerErr) {
    // Same rollback pattern as the admin invoice generator — don't
    // leave an orphaned invoice with no matching document/payment.
    await supabaseClient.from('tenant_invoices').delete().eq('id', invoice.id);
    throw innerErr;
  }

  return invoice.id;
}

function renderFirstInvoicePdf(jsPDFCtor, d) {
  const NAVY = [31, 42, 68];
  const NAVY_DEEP = [20, 28, 48];
  const GOLD = [200, 155, 60];
  const GOLD_LIGHT = [228, 199, 122];
  const fmtMoney = (n) => 'R ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  const doc = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  const contentW = pageW - margin * 2;

  doc.setFillColor(...NAVY_DEEP);
  doc.rect(0, 0, pageW, 92, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  doc.text('ZANKA GROUP', margin, 42);
  doc.setFont('times', 'bold');
  doc.setFontSize(20);
  doc.text('FIRST INVOICE', pageW - margin, 42, { align: 'right' });
  doc.setTextColor(...GOLD_LIGHT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Ref: ' + d.invoiceNumber, pageW - margin, 56, { align: 'right' });
  doc.setFillColor(...GOLD);
  doc.rect(0, 92, pageW, 3, 'F');

  let y = 128;
  doc.setTextColor(...NAVY);
  doc.setFont('times', 'bold');
  doc.setFontSize(13);
  doc.text(d.tenantName, margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(75, 81, 99);
  doc.text(d.propertyAddress, margin, y + 16);

  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(`Invoice Date: ${fmtDate(d.invoiceDate)}`, pageW - margin, y, { align: 'right' });
  doc.text(`Due Date: ${fmtDate(d.dueDate)}`, pageW - margin, y + 14, { align: 'right' });

  y += 50;
  const rows = [['First Month\'s Rent', d.netRental]];
  if (d.includeDeposit) rows.push(['Security Deposit (equivalent to 1 month\'s rent)', d.deposit]);

  doc.setFillColor(...NAVY);
  doc.rect(margin, y, contentW, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('DESCRIPTION', margin + 10, y + 17);
  doc.text('AMOUNT', pageW - margin - 10, y + 17, { align: 'right' });
  y += 26;

  rows.forEach((row, i) => {
    if (i % 2 === 1) { doc.setFillColor(250, 250, 251); doc.rect(margin, y, contentW, 26, 'F'); }
    doc.setTextColor(51, 56, 70);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text(row[0], margin + 10, y + 17);
    doc.setFont('helvetica', 'bold');
    doc.text(fmtMoney(row[1]), pageW - margin - 10, y + 17, { align: 'right' });
    doc.setDrawColor(236, 237, 241);
    doc.line(margin, y + 26, margin + contentW, y + 26);
    y += 26;
  });

  y += 20;
  doc.setFillColor(...NAVY);
  doc.roundedRect(pageW - margin - 220, y, 220, 44, 8, 8, 'F');
  doc.setTextColor(185, 192, 207);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('TOTAL DUE', pageW - margin - 16, y + 17, { align: 'right' });
  doc.setTextColor(...GOLD_LIGHT);
  doc.setFont('times', 'bold');
  doc.setFontSize(18);
  doc.text(fmtMoney(d.totalDue), pageW - margin - 16, y + 36, { align: 'right' });

  if (d.includeDeposit) {
    y += 70;
    doc.setTextColor(110, 116, 130);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.text('This invoice includes your security deposit, which was outstanding at lease signing.', margin, y);
  }

  return doc.output('blob');
}
