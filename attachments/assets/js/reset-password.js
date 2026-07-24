// Zanka Group — password reset
// Requires supabase-client.js loaded first.

/* ---------------- FORGOT PASSWORD (request reset email) ---------------- */
function handleForgotPassword() {
  const form = document.getElementById('forgot-form');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('forgot-submit');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    errorEl.classList.remove('text-green-700');
    errorEl.classList.add('text-red-600');

    const email = document.getElementById('email').value.trim();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    // redirectTo must be an absolute URL that's allow-listed in
    // Supabase → Authentication → URL Configuration → Redirect URLs
    const redirectTo = new URL('update-password.html', window.location.href).toString();

    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Send reset link';

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden', 'text-green-700');
      errorEl.classList.add('text-red-600');
      return;
    }

    // Always show the same success message whether or not the email exists,
    // so this form can't be used to check which addresses have accounts.
    errorEl.textContent = "If an account exists for that email, we've sent a password reset link. Check your inbox (and spam folder).";
    errorEl.classList.remove('hidden', 'text-red-600');
    errorEl.classList.add('text-green-700');
    form.reset();
  });
}

/* ---------------- UPDATE PASSWORD (after clicking the email link) ---------------- */
function handleUpdatePassword() {
  const form = document.getElementById('update-password-form');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('update-password-submit');
  const gate = document.getElementById('update-password-gate');
  const formWrap = document.getElementById('update-password-wrap');
  if (!form) return;

  // supabase-js v2 automatically parses the recovery token out of the URL
  // and fires a PASSWORD_RECOVERY auth event once the session is ready.
  let ready = false;

  function unlockForm() {
    if (ready) return;
    ready = true;
    if (gate) gate.classList.add('hidden');
    if (formWrap) formWrap.classList.remove('hidden');
  }

  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') unlockForm();
  });

  // Fallback: if a session already exists by the time this script runs
  // (e.g. on a fast reload of the link), unlock immediately too.
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) unlockForm();
  });

  // If nothing unlocks the form after a few seconds, the link was likely
  // invalid or expired — tell the person instead of leaving a dead form.
  setTimeout(() => {
    if (!ready && gate) {
      gate.innerHTML = '<p class="text-sm text-red-600 bg-red-50 rounded-lg py-2.5 px-3.5">This reset link is invalid or has expired. Please request a new one.</p><a href="forgot-password.html" class="learn-more mt-4 inline-flex">Request a new link &rarr;</a>';
    }
  }, 6000);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirm_password').value;

    if (password !== confirmPassword) {
      errorEl.textContent = "Passwords don't match.";
      errorEl.classList.remove('hidden', 'text-green-700');
      errorEl.classList.add('text-red-600');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating…';

    const { error } = await supabaseClient.auth.updateUser({ password });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Update password';

    if (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('hidden', 'text-green-700');
      errorEl.classList.add('text-red-600');
      return;
    }

    formWrap.innerHTML = '<p class="text-sm text-green-700 bg-green-50 rounded-lg py-2.5 px-3.5">Your password has been updated.</p><div class="flex flex-col sm:flex-row gap-3 mt-5"><a href="owner-login.html" class="btn btn-outline-navy flex-1">Owner Log In</a><a href="tenant-login.html" class="btn btn-outline-navy flex-1">Tenant Log In</a><a href="partner-login.html" class="btn btn-outline-navy flex-1">Partner Log In</a></div>';
  });
}
