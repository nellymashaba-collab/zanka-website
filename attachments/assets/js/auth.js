// Zanka Group — authentication (Supabase)
// Requires assets/js/supabase-client.js to be loaded first.

function showAuthError(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function showAuthSuccess(el, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.remove('text-red-600');
  el.classList.add('text-green-700');
}

/* ---------------- SIGN UP ---------------- */
async function handleSignup(role) {
  const form = document.getElementById('signup-form');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('signup-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const fullName = document.getElementById('full_name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, role }
      }
    });

    if (error) {
      showAuthError(errorEl, error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
      return;
    }

    // Create the matching profile row (id must equal auth.users.id)
    if (data.user) {
      const { error: profileError } = await supabaseClient
        .from('profiles')
        .insert([{ id: data.user.id, full_name: fullName, email, role }]);

      if (profileError) {
        showAuthError(errorEl, 'Account created, but profile setup failed: ' + profileError.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }
    }

    showAuthSuccess(errorEl, 'Account created! Check your email to confirm, then log in.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create account';
    form.reset();
  });
}

/* ---------------- PARTNER SIGN UP (profiles + partner_profiles) ---------------- */
// Maps the flat partner_type choices on the signup form to the five
// partner categories used to route the dashboard workspace.
const PARTNER_TYPE_CATEGORY_MAP = {
  'Estate Agent': 'Sales & Leasing',
  'Contractor': 'Maintenance & Trades',
  'Plumber': 'Maintenance & Trades',
  'Electrician': 'Maintenance & Trades',
  'Painter': 'Maintenance & Trades',
  'Security Company': 'Maintenance & Trades',
  'Cleaning Company': 'Maintenance & Trades',
  'Architect': 'Professional Services',
  'Engineer': 'Professional Services',
  'Conveyancer': 'Professional Services',
  'Attorney': 'Professional Services',
  'Valuer': 'Professional Services',
  'Accountant': 'Professional Services',
  'Inspector': 'Compliance & Inspections',
  'Insurance Assessor': 'Compliance & Inspections',
  'Photographer': 'Media & Marketing',
};

async function handlePartnerSignup() {
  const form = document.getElementById('signup-form');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('signup-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const fullName = document.getElementById('full_name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const partnerType = document.getElementById('partner_type').value;
    const companyName = document.getElementById('company_name').value.trim();

    if (!partnerType) {
      showAuthError(errorEl, 'Please select a partner type.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';

    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, role: 'partner' } }
    });

    if (error) {
      showAuthError(errorEl, error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
      return;
    }

    if (data.user) {
      const { error: profileError } = await supabaseClient
        .from('profiles')
        .insert([{ id: data.user.id, full_name: fullName, email, role: 'partner' }]);

      if (profileError) {
        showAuthError(errorEl, 'Account created, but profile setup failed: ' + profileError.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }

      const partnerCategory = PARTNER_TYPE_CATEGORY_MAP[partnerType] || null;

      const { error: partnerProfileError } = await supabaseClient
        .from('partner_profiles')
        .insert([{ id: data.user.id, partner_type: partnerType, partner_category: partnerCategory, company_name: companyName }]);

      if (partnerProfileError) {
        showAuthError(errorEl, 'Account created, but partner details failed to save: ' + partnerProfileError.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
        return;
      }
    }

    showAuthSuccess(errorEl, 'Account created! Check your email to confirm, then log in.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create account';
    form.reset();
  });
}

/* ---------------- LOG IN ---------------- */
async function handleLogin(expectedRole, dashboardUrl) {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('auth-error');
  const submitBtn = document.getElementById('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      showAuthError(errorEl, error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
      return;
    }

    // Confirm this user has the expected role before letting them into the dashboard
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select('role, full_name')
      .eq('id', data.user.id)
      .single();

    if (profileError || !profile) {
      showAuthError(errorEl, 'Could not load your profile. Please contact support.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
      return;
    }

    if (profile.role !== expectedRole) {
      showAuthError(errorEl, `This login is for ${expectedRole}s. Your account is registered as a ${profile.role}.`);
      await supabaseClient.auth.signOut();
      submitBtn.disabled = false;
      submitBtn.textContent = 'Log in';
      return;
    }

    window.location.href = dashboardUrl;
  });
}

/* ---------------- SESSION GUARD (for dashboard pages) ---------------- */
async function requireSession(expectedRole, loginUrl) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = loginUrl;
    return null;
  }
  const { data: profile, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();

  if (error || !profile || profile.role !== expectedRole) {
    await supabaseClient.auth.signOut();
    window.location.href = loginUrl;
    return null;
  }
  return profile;
}

async function handleLogout(redirectUrl) {
  document.querySelectorAll('[data-logout]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      window.location.href = redirectUrl;
    });
  });
}
