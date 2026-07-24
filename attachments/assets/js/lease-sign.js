// Zanka Group — Lease electronic signing page
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
    // No session yet — we don't know if this is a tenant or an owner
    // clicking the link, so land on tenant login with a way across to
    // owner login from there, rather than guessing wrong for owners.
    window.location.href = 'tenant-login.html';
    return null;
  }
  const { data: profile, error } = await supabaseClient
    .from('profiles').select('*').eq('id', session.user.id).single();

  if (error || !profile || !allowedRoles.includes(profile.role)) {
    await supabaseClient.auth.signOut();
    // Now we DO know their actual role (if the profile loaded at all) —
    // send them to the login page that actually matches, instead of
    // always bouncing owners to the tenant login by mistake.
    window.location.href = profile?.role === 'owner' ? 'owner-login.html' : 'tenant-login.html';
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
  // ever returns THIS person's own row(s) — a tenant can't fetch
  // someone else's signature record by guessing a lease id.
  // Deliberately not .maybeSingle() — that throws outright if a
  // duplicate row exists (from an old "Send for Signature" double-
  // click, now prevented at the source but not retroactively cleaned
  // up everywhere). Taking the most recent row instead means a
  // leftover duplicate degrades gracefully rather than blocking
  // signing entirely.
  const { data: rows, error } = await supabaseClient
    .from('lease_signatures')
    .select('*')
    .eq('lease_id', signLeaseId)
    .eq('signed_by', signCurrentUser.id)
    .order('created_at', { ascending: false });

  const data = rows && rows.length > 0 ? rows[0] : null;

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

    // The signature above is already saved at this point — anything
    // that goes wrong from here on is about the NEXT party in the
    // sequence, not this person's own signing. Isolated in its own
    // try/catch so a failure here shows a distinct, less alarming
    // message instead of implying their own signature didn't go through.
    document.getElementById('sign-form-wrap').classList.add('hidden');
    showComplete('Thank you — your signature has been recorded.');

    try {
      await advanceLeaseAfterSignature();
    } catch (sequenceErr) {
      console.error('Could not advance to the next signer:', sequenceErr);
      const note = document.createElement('p');
      note.className = 'text-sm text-yellow-700 bg-yellow-50 rounded-lg py-2.5 px-3.5 mt-4';
      note.textContent = 'Your signature was recorded, but there was an issue notifying the next signer. Please contact Zanka Group to confirm the lease moves forward.';
      document.getElementById('sign-complete').appendChild(note);
    }
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
    // Everyone in the sequence has signed — flip to Active.
    await notifyLeaseEvent('lease_fully_executed', {});
    return;
  }

  const nextParty = byType[sequence[doneUpToIndex]];
  if (nextParty && !nextParty.otp_code) {
    // This party hasn't been issued an OTP yet, and it's their turn —
    // issue it now. This is the sequential trigger, generalized to
    // whichever party is next rather than hardcoded to "guarantor."
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
  const res = await fetch(`${SUPABASE_URL}/functions/v1/dms-notifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ lease_event: eventType, lease_id: signLeaseId, ...extra }),
  });
  // fetch() only rejects on true network failures — a 4xx/5xx response
  // from the Edge Function still resolves "successfully" as far as
  // fetch is concerned. Without this check, a server-side failure here
  // (which used to include the OTP-issuance write itself) was
  // completely invisible — this call could fail every time and no one
  // would ever see an error.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Could not process ${eventType}: ${res.status} ${body}`.slice(0, 300));
  }
}
