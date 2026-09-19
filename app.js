const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const PROJECT_PATH = 'current/index.html';
const ALLOWED_ROLES = ['tester', 'mod', 'dev', 'owner'];

const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token}`
});

const gate = document.getElementById('gate');
const shell = document.getElementById('shell');
const note = document.getElementById('note');
const who = document.getElementById('who');
const frame = document.getElementById('project');

function saveSession(data) {
  localStorage.setItem('mokio_session', JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user
  }));
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem('mokio_session') || 'null');
  } catch (_) {
    return null;
  }
}

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

async function fetchRole(session) {
  const token = session.access_token;
  let email = (session.user && session.user.email || '').toLowerCase();
  let userId = session.user && session.user.id;

  if (!userId || !email) {
    const userRes = await request(`${SUPABASE_URL}/auth/v1/user`, { headers: headers(token) });
    if (userRes.ok && userRes.data) {
      userId = userRes.data.id;
      email = (userRes.data.email || email).toLowerCase();
    }
  }

  // Preferred: security-definer function (avoids profiles RLS hanging)
  const rpc = await request(`${SUPABASE_URL}/rest/v1/rpc/get_my_profile`, {
    method: 'POST',
    headers: headers(token),
    body: '{}'
  });
  if (rpc.ok && rpc.data) {
    const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
    if (row && row.role) {
      return { email: row.email || email, role: String(row.role).toLowerCase().trim() };
    }
  }

  if (userId) {
    const byId = await request(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=email,role`,
      { headers: headers(token) }
    );
    if (byId.ok && Array.isArray(byId.data) && byId.data[0]?.role) {
      return {
        email: byId.data[0].email || email,
        role: String(byId.data[0].role).toLowerCase().trim()
      };
    }
  }

  if (email) {
    const byEmail = await request(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=email,role`,
      { headers: headers(token) }
    );
    if (byEmail.ok && Array.isArray(byEmail.data) && byEmail.data[0]?.role) {
      return {
        email: byEmail.data[0].email || email,
        role: String(byEmail.data[0].role).toLowerCase().trim()
      };
    }
  }

  return { email, role: null, error: rpc.status || 'no-profile' };
}

function showProject(profile) {
  gate.hidden = true;
  shell.hidden = false;
  who.textContent = `${profile.email} · ${profile.role}`;
  frame.src = PROJECT_PATH;
}

function showGate(message) {
  gate.hidden = false;
  shell.hidden = true;
  frame.removeAttribute('src');
  note.textContent = message || '';
}

async function enter(session) {
  note.textContent = 'Checking role...';
  try {
    const profile = await fetchRole(session);
    if (!profile?.role) {
      showGate('Could not read your role from the database. Run the get_my_profile SQL in Supabase, then try again.');
      return;
    }
    if (!ALLOWED_ROLES.includes(profile.role)) {
      showGate('Your role is ' + profile.role + '. Only tester or better can open this site.');
      return;
    }
    showProject(profile);
  } catch (err) {
    showGate('Role check failed: ' + (err.message || 'network error'));
  }
}

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  note.textContent = 'Signing in...';
  try {
    const res = await request(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const data = res.data || {};
      note.textContent = data.error_description || data.error || data.msg || ('Sign in failed (' + res.status + ')');
      return;
    }
    saveSession(res.data);
    await enter({
      access_token: res.data.access_token,
      user: res.data.user
    });
  } catch (err) {
    note.textContent = 'Sign in failed: ' + (err.message || 'network error');
  }
};

document.getElementById('signOutBtn').onclick = () => {
  localStorage.removeItem('mokio_session');
  showGate('');
};

const existing = getSession();
if (existing?.access_token) enter(existing);
