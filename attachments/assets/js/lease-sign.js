// Zanka Group — Lease electronic signing page 20h15
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
  (allSignatures || []).forEach(s => { byType[s.party_type] = s; });

  const sequence = order.filter(type => byType[type]);
  const doneUpToIndex = sequence.findIndex(type => !byType[type].otp_verified);

  if (doneUpToIndex === -1) {
    // Everyone in the sequence has signed. Generate the actual signed
    // lease PDF now, before flipping the lease Active — this is the
    // gap that meant NO lease on this platform ever produced a real
    // downloadable document (see generateAndAttachSignedLeasePdf).
    // Wrapped so a PDF failure never blocks the legally-important part
    // (activating the lease) — worst case, an admin regenerates it later.
    let signedLeaseStoragePath = null;
    try {
      signedLeaseStoragePath = await generateAndAttachSignedLeasePdf(signLeaseId);
    } catch (err) {
      console.error('Signed lease PDF generation failed (lease will still activate):', err);
    }
    try {
      await generateFirstRentalInvoice(signLeaseId);
    } catch (err) {
      console.error('First invoice generation failed (lease will still activate):', err);
    }
    await notifyLeaseEvent('lease_fully_executed', { signed_lease_storage_path: signedLeaseStoragePath });
    return;
  }

  const nextParty = byType[sequence[doneUpToIndex]];
  if (nextParty && !nextParty.otp_code) {
    // Matches sendForSignature()'s proven working pattern: generate
    // and WRITE the OTP client-side ourselves, rather than delegating
    // that to the Edge Function (which is what the previous version
    // of this code did — the same mistake that made FICA-approval's
    // OTP checking fail earlier, just here instead). The Edge Function
    // call afterward is only for the email/notification, same as
    // sendForSignature — if that delivery fails, the OTP still exists
    // and can be relayed manually.
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(); expires.setHours(expires.getHours() + 48);

    const { error: otpError } = await supabaseClient
      .from('lease_signatures')
      .update({ otp_code: otp, otp_expires_at: expires.toISOString() })
      .eq('id', nextParty.id);

    if (otpError) {
      console.error('Failed to issue next party\'s OTP:', otpError.message);
      return;
    }

    await notifyLeaseEvent('lease_signature_request', {
      recipient_role: sequence[doneUpToIndex].toLowerCase(),
      otp,
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
   SIGNED LEASE PDF GENERATION
   Runs once every required party (Tenant, Guarantor if present,
   Owner) has completed their signature. Pulls the lease's chosen
   master template + any admin-enabled additional clauses, merges in
   real lease data using the exact same {{Placeholder}} syntax the
   Wizard's own preview uses, then renders the whole thing as a real
   PDF via direct jsPDF drawing (not html2canvas — see the invoice
   generator's comments for why that approach proved unreliable).

   Runs in the SIGNER's own browser session. The Storage upload works
   under the existing "Partners can upload documents" policy (any
   authenticated user, despite its name). Writing leases.file_url does
   NOT work from here — leases has no UPDATE policy for non-admins —
   so this function returns the storage path, and the actual
   leases.file_url write happens in the dms-notifications Edge
   Function (service-role), triggered by the lease_fully_executed
   event this file already sends. That Edge Function needs a small
   addition to read signed_lease_storage_path from the payload,
   create a long-lived signed URL for it, and set leases.file_url —
   see the note at the bottom of this file for the exact snippet.
   ================================================================ */

function mergeTemplate(html, values) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

// Same placeholder set/format as the Wizard's buildPreviewValues(),
// but pulling from the SAVED lease record instead of live form
// inputs, since signing happens well after the lease was created.
async function buildSignedLeaseValues(lease, property, tenantProfile, ownerProfile) {
  const fmtR = (n) => 'R' + Number(n || 0).toLocaleString();
  const joinAddress = (p) => [p?.address_line1, p?.address_line2, p?.address_line3].filter(Boolean).join(', ');
  return {
    TenantName: tenantProfile?.full_name || '',
    TenantID: lease.tenant_id || '',
    TenantIDNumber: tenantProfile?.id_number || '',
    TenantAddress: joinAddress(tenantProfile),
    TenantEmail: tenantProfile?.email || '',
    TenantPhone: tenantProfile?.phone || '',
    OwnerName: ownerProfile?.full_name || '',
    OwnerIDNumber: ownerProfile?.id_number || '',
    OwnerAddress: joinAddress(ownerProfile),
    OwnerEmail: ownerProfile?.email || '',
    OwnerPhone: ownerProfile?.phone || '',
    PropertyAddress: property?.address || '',
    UnitNumber: '',
    GarageParking: Number(lease.parking) > 0 ? `Included, ${fmtR(lease.parking)}/month` : 'None',
    LeaseStartDate: lease.start_date,
    LeaseEndDate: lease.end_date,
    MonthlyRental: fmtR(lease.monthly_rent),
    Deposit: fmtR(lease.deposit_required),
    Parking: fmtR(lease.parking),
    Electricity: fmtR(lease.electricity),
    Water: fmtR(lease.water),
    Fibre: fmtR(lease.fibre),
    LateInterest: '',
    PropertyManager: 'Zanka Group',
    EmergencyContact: '',
    InspectionDate: '',
    RenewalDate: '',
    CurrentDate: new Date().toLocaleDateString(),
    StartDate: lease.start_date,
    EndDate: lease.end_date,
    DepositRequired: fmtR(lease.deposit_required),
  };
}

// Turns the template's HTML into a flat list of {type, text} blocks
// jsPDF can draw directly, without any HTML rendering engine —
// heading tags become bold section headers, everything else becomes
// a normal wrapped paragraph.
function htmlToTextBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blocks = [];
  const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4']);

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (HEADING_TAGS.has(node.tagName)) {
      const text = node.textContent.trim();
      if (text) blocks.push({ type: 'heading', text });
      return; // don't also descend into heading children
    }
    if (node.tagName === 'P' || node.tagName === 'LI' || node.tagName === 'DIV') {
      const text = node.textContent.trim();
      // Only treat as a leaf paragraph if it has no block-level
      // children of its own (avoids duplicating nested content).
      const hasBlockChildren = Array.from(node.children).some(
        (c) => HEADING_TAGS.has(c.tagName) || ['P', 'LI', 'DIV', 'UL', 'OL'].includes(c.tagName)
      );
      if (text && !hasBlockChildren) {
        blocks.push({ type: 'paragraph', text });
        return;
      }
    }
    Array.from(node.children).forEach(walk);
  };

  walk(doc.body);
  return blocks;
}

async function generateAndAttachSignedLeasePdf(leaseId) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (typeof jsPDFCtor !== 'function') {
    throw new Error('PDF library failed to load.');
  }

  // 1. Gather everything needed.
  const { data: lease, error: leaseErr } = await supabaseClient
    .from('leases').select('*').eq('id', leaseId).single();
  if (leaseErr) throw leaseErr;

  const { data: property } = await supabaseClient
    .from('properties').select('address, owner_id').eq('id', lease.property_id).single();

  const [{ data: tenantProfile }, { data: ownerProfile }] = await Promise.all([
    supabaseClient.from('profiles').select('full_name, email, phone, id_number, address_line1, address_line2, address_line3').eq('id', lease.tenant_id).single(),
    supabaseClient.from('profiles').select('full_name, email, phone, id_number, address_line1, address_line2, address_line3').eq('id', property?.owner_id).single(),
  ]);

  const { data: template } = lease.template_id
    ? await supabaseClient.from('lease_templates').select('content_html').eq('id', lease.template_id).single()
    : { data: null };

  let enabledClauses = [];
  if (Array.isArray(lease.enabled_clause_ids) && lease.enabled_clause_ids.length > 0) {
    const { data: clauses } = await supabaseClient
      .from('lease_clauses').select('clause_title, clause_text, display_order')
      .in('id', lease.enabled_clause_ids).order('display_order');
    enabledClauses = clauses || [];
  }

  const { data: signatures } = await supabaseClient
    .from('lease_signatures')
    .select('party_type, signed_at, ip_address, cryptographic_hash, lease_parties:party_id ( full_name, party_type )')
    .eq('lease_id', leaseId)
    .order('signed_at', { ascending: true });

  // 2. Merge the master template with real lease data.
  const values = await buildSignedLeaseValues(lease, property, tenantProfile, ownerProfile);
  const mergedHtml = mergeTemplate(template?.content_html || '', values);
  const blocks = htmlToTextBlocks(mergedHtml);

  // 3. Append the admin-enabled additional clauses as their own
  // section, in the same place the Wizard's own preview puts them —
  // after the main body, as a clearly-labeled additional terms block.
  if (enabledClauses.length > 0) {
    blocks.push({ type: 'heading', text: 'ADDITIONAL TERMS' });
    enabledClauses.forEach((c) => {
      blocks.push({ type: 'subheading', text: c.clause_title });
      blocks.push({ type: 'paragraph', text: c.clause_text });
    });
  }

  // 4. Render as a real PDF.
  const pdfBlob = renderSignedLeasePdf(jsPDFCtor, blocks, signatures || [], {
    leaseNumber: lease.lease_number,
    propertyAddress: property?.address || '',
    tenantName: tenantProfile?.full_name || '',
  });

  // 5. Upload it.
  const storagePath = `documents/leases/${leaseId}/signed-lease-${lease.lease_number || leaseId}.pdf`;
  const { data: { session } } = await supabaseClient.auth.getSession();
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, true);
    xhr.setRequestHeader('Authorization', `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error('Signed lease upload failed: ' + xhr.status));
    xhr.onerror = () => reject(new Error('Network error uploading signed lease.'));
    xhr.send(pdfBlob);
  });

  // 6. Log it in lease_documents for the audit trail (Signed_Lease is
  // one of the widened category options in the v2 schema).
  await supabaseClient.from('lease_documents').insert([{
    lease_id: leaseId,
    category: 'Signed_Lease',
    storage_path: storagePath,
  }]).select().maybeSingle().catch(() => {}); // best-effort — don't fail the whole flow if this table's shape differs

  return storagePath;
}

// Draws the merged lease content directly with jsPDF — headings,
// paragraphs, additional clauses, then a signatures page summarizing
// each party's e-signature (name, timestamp, IP, verification hash).
// Multi-page with automatic page breaks, since a full lease easily
// runs several pages.
function renderSignedLeasePdf(jsPDFCtor, blocks, signatures, meta) {
  const NAVY = [31, 42, 68];
  const NAVY_DEEP = [20, 28, 48];
  const GOLD = [200, 155, 60];
  const INK = [32, 36, 46];
  const GRAY = [110, 116, 130];

  const doc = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 54;
  const contentW = pageW - margin * 2;
  const bottomLimit = pageH - 60;
  let y = margin;
  let pageNum = 1;

  const drawHeader = () => {
    doc.setFillColor(...NAVY_DEEP);
    doc.rect(0, 0, pageW, 46, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.text('ZANKA GROUP', margin, 29);
    doc.setTextColor(...GOLD);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('LEASE AGREEMENT — RESIDENTIAL', pageW - margin, 29, { align: 'right' });
  };

  const drawFooter = () => {
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(
      `Zanka Group (Pty) Ltd · Lease ${meta.leaseNumber || ''} · ${meta.propertyAddress}`,
      margin, pageH - 30
    );
    doc.text(`Page ${pageNum}`, pageW - margin, pageH - 30, { align: 'right' });
  };

  const newPage = () => {
    drawFooter();
    doc.addPage();
    pageNum += 1;
    y = margin + 60;
    drawHeader();
  };

  const ensureSpace = (needed) => {
    if (y + needed > bottomLimit) newPage();
  };

  drawHeader();
  y = margin + 60;

  doc.setTextColor(...NAVY);
  doc.setFont('times', 'bold');
  doc.setFontSize(16);
  doc.text('LEASE AGREEMENT - RESIDENTIAL', margin, y);
  y += 26;

  blocks.forEach((block) => {
    if (block.type === 'heading') {
      ensureSpace(30);
      y += 10;
      doc.setTextColor(...NAVY);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11.5);
      const lines = doc.splitTextToSize(block.text.toUpperCase(), contentW);
      lines.forEach((line) => { ensureSpace(16); doc.text(line, margin, y); y += 16; });
      y += 4;
    } else if (block.type === 'subheading') {
      ensureSpace(20);
      doc.setTextColor(...GOLD);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      const lines = doc.splitTextToSize(block.text, contentW);
      lines.forEach((line) => { ensureSpace(14); doc.text(line, margin, y); y += 14; });
    } else {
      doc.setTextColor(...INK);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      const lines = doc.splitTextToSize(block.text, contentW);
      lines.forEach((line) => { ensureSpace(13); doc.text(line, margin, y); y += 13; });
      y += 8;
    }
  });

  // ---------- Signatures page ----------
  newPage();
  doc.setTextColor(...NAVY);
  doc.setFont('times', 'bold');
  doc.setFontSize(14);
  doc.text('SIGNATURES', margin, y);
  y += 28;

  if (signatures.length === 0) {
    doc.setTextColor(...GRAY);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9.5);
    doc.text('No signature records found.', margin, y);
  }

  signatures.forEach((s) => {
    ensureSpace(80);
    const partyName = s.lease_parties?.full_name || s.party_type;
    const partyType = s.lease_parties?.party_type || s.party_type;
    doc.setDrawColor(220, 222, 228);
    doc.line(margin, y, pageW - margin, y);
    y += 18;
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(`${partyType}: ${partyName}`, margin, y);
    y += 16;
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Signed electronically: ${s.signed_at ? new Date(s.signed_at).toLocaleString('en-ZA') : 'Not recorded'}`, margin, y);
    y += 14;
    doc.setTextColor(...GRAY);
    doc.setFontSize(8);
    doc.text(`IP Address: ${s.ip_address || 'Not recorded'}`, margin, y);
    y += 12;
    doc.text(`Verification Hash: ${(s.cryptographic_hash || '').slice(0, 32)}${s.cryptographic_hash ? '…' : 'Not recorded'}`, margin, y);
    y += 20;
  });

  drawFooter();
  return doc.output('blob');
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
