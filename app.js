const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const ALLOWED_ROLES = ['owner', 'tester'];
const NEXT_PAGE = 'messeges/main.html';

const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + token
});

const note = document.getElementById('loginNote');

async function request(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function pickProfile(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const role = String(row.role || '').toLowerCase().trim();
  return {
    email: (row.email || '').toLowerCase(),
    username: row.username || '',
    role
  };
}

async function loadProfile(token, user) {
  const rpc = await request(SUPABASE_URL + '/rest/v1/rpc/get_my_profile', {
    method: 'POST',
    headers: headers(token),
    body: '{}'
  });
  let profile = pickProfile(rpc.data);
  if (profile?.role) return profile;

  if (user?.id) {
    const byId = await request(
      SUPABASE_URL + '/rest/v1/profiles?id=eq.' + user.id + '&select=email,role,username',
      { headers: headers(token) }
    );
    profile = pickProfile(byId.data);
    if (profile?.role) return profile;
  }

  const email = (user?.email || '').toLowerCase();
  if (email) {
    const byEmail = await request(
      SUPABASE_URL + '/rest/v1/profiles?email=eq.' + encodeURIComponent(email) + '&select=email,role,username',
      { headers: headers(token) }
    );
    profile = pickProfile(byEmail.data);
    if (profile?.role) return profile;
  }
  return { email, username: '', role: '' };
}

async function emailFromUsername(username) {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/email_for_username', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ uname: username })
  });
  return typeof res.data === 'string' && res.data.includes('@') ? res.data.toLowerCase() : null;
}

function enter(authData, profile) {
  localStorage.setItem('mokio_session', JSON.stringify({
    access_token: authData.access_token,
    refresh_token: authData.refresh_token,
    user: authData.user,
    profile
  }));
  location.href = NEXT_PAGE;
}

document.getElementById('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const id = document.getElementById('loginId').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  note.textContent = 'Signing in...';
  try {
    let email = id;
    if (!email.includes('@')) {
      email = await emailFromUsername(id);
      if (!email) {
        note.textContent = 'No account found with that username.';
        return;
      }
    }

    const res = await request(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const data = res.data || {};
      note.textContent = data.error_description || data.msg || data.error || 'Sign in failed';
      return;
    }

    const profile = await loadProfile(res.data.access_token, res.data.user);
    if (!ALLOWED_ROLES.includes(profile.role)) {
      note.textContent = 'Only owner and tester accounts can enter. This account is ' + (profile.role || 'unknown') + '.';
      return;
    }
    enter(res.data, profile);
  } catch (err) {
    note.textContent = err.name === 'AbortError' ? 'Sign in timed out' : (err.message || 'Sign in failed');
  }
};

(async () => {
  try {
    const saved = JSON.parse(localStorage.getItem('mokio_session') || 'null');
    if (!saved?.access_token) return;
    const profile = await loadProfile(saved.access_token, saved.user);
    if (ALLOWED_ROLES.includes(profile.role)) location.href = NEXT_PAGE;
    else localStorage.removeItem('mokio_session');
  } catch (_) {}
})();
