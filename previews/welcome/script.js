// ======================
// CONFIG – keep your real Supabase values here
// ======================
const SUPABASE_URL = 'https://YOUR-PROJECT-ID.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token}`
});

let currentSession = null;
let currentProfile = null;
let turnstileToken = null;
let authMode = 'signin'; // signin | signup

window.onTurnstileSuccess = function (token) {
  turnstileToken = token;
};

// ======================
// Mobile menu
// ======================
const menuBtn = document.querySelector('.mobile-menu-btn');
const navLinks = document.querySelector('.nav-links');
if (menuBtn && navLinks) {
  menuBtn.addEventListener('click', () => navLinks.classList.toggle('open'));
  navLinks.querySelectorAll('a,button').forEach((el) => {
    el.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}

// ======================
// Waitlist
// ======================
const form = document.getElementById('waitlistForm');
const successMessage = document.getElementById('successMessage');

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input[name="email"]').value.trim().toLowerCase();
    const submitBtn = form.querySelector('button[type="submit"]');
    if (!email) return;
    if (!turnstileToken) {
      alert('Please complete the security check first.');
      return;
    }

    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Joining...';
    submitBtn.disabled = true;

    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
        method: 'POST',
        headers: { ...headers(), Prefer: 'return=minimal' },
        body: JSON.stringify({ email })
      });

      if (response.ok || response.status === 201 || response.status === 409) {
        form.hidden = true;
        successMessage.hidden = false;
        if (response.status === 409) {
          successMessage.querySelector('h3').textContent = "You're already on the list!";
        }
      } else {
        alert('Something went wrong. Please try again.');
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        window.turnstile && window.turnstile.reset();
        turnstileToken = null;
      }
    } catch (err) {
      console.error(err);
      alert('Network error. Please try again.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });
}

// ======================
// Auth UI
// ======================
const authModal = document.getElementById('authModal');
const accountBtn = document.getElementById('accountBtn');
const staffNavLink = document.getElementById('staffNavLink');
const staffSection = document.getElementById('staff');
const authForm = document.getElementById('authForm');
const authTitle = document.getElementById('authTitle');
const authSub = document.getElementById('authSub');
const authNote = document.getElementById('authNote');
const authSubmit = document.getElementById('authSubmit');
const authGuest = document.getElementById('authGuest');
const authSignedIn = document.getElementById('authSignedIn');

accountBtn?.addEventListener('click', () => {
  if (authModal) authModal.hidden = false;
});
document.getElementById('authClose')?.addEventListener('click', () => {
  if (authModal) authModal.hidden = true;
});
authModal?.addEventListener('click', (e) => {
  if (e.target === authModal) authModal.hidden = true;
});

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    setAuthMode(tab.dataset.mode);
  });
});

function setAuthMode(mode) {
  authMode = mode;
  if (authTitle) authTitle.textContent = mode === 'signin' ? 'Welcome back' : 'Create your account';
  if (authSub) authSub.textContent = mode === 'signin'
    ? 'Sign in to your Mokio account.'
    : 'Anyone can join. Passwords stay private.';
  if (authSubmit) authSubmit.textContent = mode === 'signin' ? 'Sign In' : 'Create account';
}

authForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = authForm.email.value.trim().toLowerCase();
  const password = authForm.password.value;
  authNote.textContent = 'Working...';

  try {
    if (authMode === 'signup') {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || data.message || 'Sign up failed');
      authNote.textContent = 'Account created. You can sign in now.';
      setAuthMode('signin');
      document.querySelectorAll('.auth-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.mode === 'signin');
      });
      return;
    }

    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || data.error || 'Sign in failed');

    saveSession(data);
    authModal.hidden = true;
    await loadProfile();
  } catch (err) {
    authNote.textContent = err.message;
  }
});

document.getElementById('authSignOutLink')?.addEventListener('click', async () => {
  if (currentSession?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: headers(currentSession.access_token)
    }).catch(() => {});
  }
  localStorage.removeItem('mokio_session');
  currentSession = null;
  currentProfile = null;
  if (window.MOKIO_REQUIRED_ROLES) {
    location.replace(homePath());
    return;
  }
  updateStaffUI();
});

function saveSession(data) {
  currentSession = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user
  };
  localStorage.setItem('mokio_session', JSON.stringify(currentSession));
}

async function loadProfile() {
  if (!currentSession?.access_token) {
    updateStaffUI();
    return;
  }

  if (!currentSession.user?.id) {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: headers(currentSession.access_token)
    });
    if (userRes.ok) currentSession.user = await userRes.json();
  }

  if (!currentSession.user?.id) {
    updateStaffUI();
    return;
  }

  const userId = currentSession.user.id;
  const email = (currentSession.user.email || '').toLowerCase();
  let res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id,email,role`,
    { headers: headers(currentSession.access_token) }
  );
  let rows = await res.json();
  if (!Array.isArray(rows) || !rows[0]) {
    res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,email,role`,
      { headers: headers(currentSession.access_token) }
    );
    rows = await res.json();
  }
  currentProfile = Array.isArray(rows) ? rows[0] : null;
  updateStaffUI();
  if (document.getElementById('accountsBody')) loadAccounts();
}

function hasRole(...roles) {
  return currentProfile && roles.includes(currentProfile.role);
}

function homePath() {
  return location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
}

function updateStaffUI() {
  const signedIn = Boolean(currentSession?.access_token);
  const btnText = document.getElementById('accountBtnText');
  const email = currentProfile?.email || currentSession?.user?.email || '';
  if (btnText) btnText.textContent = signedIn ? 'Account' : 'Sign In';
  if (authGuest) authGuest.hidden = signedIn;
  if (authSignedIn) authSignedIn.hidden = !signedIn;
  if (document.getElementById('authUserEmail')) {
    document.getElementById('authUserEmail').textContent = email;
  }
  if (document.getElementById('authUserRole')) {
    document.getElementById('authUserRole').textContent = currentProfile?.role || 'member';
  }
  const initial = (email[0] || 'M').toUpperCase();
  document.querySelectorAll('.account-btn-icon, #authAvatar').forEach((el) => {
    el.textContent = initial;
  });

  const allowed = Boolean(currentProfile && ['owner', 'dev', 'tester'].includes(String(currentProfile.role).toLowerCase()));
  if (staffNavLink) staffNavLink.hidden = !allowed;
  if (staffSection) staffSection.hidden = !allowed;

  const welcome = document.getElementById('staffWelcome');
  if (welcome) {
    if (allowed) {
      welcome.textContent = `Signed in as ${currentProfile.email || currentSession.user.email} — role: ${currentProfile.role}`;
    } else if (signedIn) {
      welcome.textContent = 'Your account is pending. An owner must assign you a role.';
    }
  }

  document.querySelectorAll('[data-roles]').forEach((el) => {
    const needed = el.dataset.roles.split(',').map((r) => r.trim());
    el.hidden = !hasRole(...needed);
  });

  const required = window.MOKIO_REQUIRED_ROLES;
  if (required && required.length && !hasRole(...required)) {
    location.replace(homePath());
  }
}

async function loadAccounts() {
  const body = document.getElementById('accountsBody');
  const note = document.getElementById('accountsNote');
  if (!body || !hasRole('owner')) return;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=email,role,created_at&order=created_at.desc`,
    { headers: headers(currentSession.access_token) }
  );

  if (!res.ok) {
    note.textContent = 'Could not load accounts. Check the owner SQL policies.';
    return;
  }

  const rows = await res.json();
  note.textContent = `${rows.length} account${rows.length === 1 ? '' : 's'}`;
  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${row.email || ''}</td>
      <td>
        <select class="role-select" data-email="${row.email}">
          ${['member','tester','mod','dev','owner'].map((role) =>
            `<option value="${role}" ${row.role === role ? 'selected' : ''}>${role}</option>`
          ).join('')}
        </select>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('.role-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const email = select.dataset.email;
      const role = select.value;
      note.textContent = `Updating ${email}...`;
      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { ...headers(currentSession.access_token), Prefer: 'return=minimal' },
          body: JSON.stringify({ role })
        }
      );
      note.textContent = updateRes.ok ? `Updated ${email} to ${role}.` : 'Could not update role.';
    });
  });
}

// Restore session
try {
  const saved = JSON.parse(localStorage.getItem('mokio_session') || 'null');
  if (saved?.access_token) {
    currentSession = saved;
    loadProfile();
  } else if (window.MOKIO_REQUIRED_ROLES) {
    location.replace(homePath());
  }
} catch (_) {}
