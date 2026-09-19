const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';

// Upload your in-progress website files to this folder in the GitHub repo:
// current/index.html  (+ css, js, images, etc.)
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

async function fetchRole(session) {
  let user = session.user;
  if (!user?.id || !user?.email) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: headers(session.access_token)
    });
    if (!res.ok) return null;
    user = await res.json();
  }

  const email = (user.email || '').toLowerCase();
  let rows = [];

  if (user.id) {
    const byId = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=email,role`,
      { headers: headers(session.access_token) }
    );
    if (byId.ok) rows = await byId.json();
  }

  if (!Array.isArray(rows) || !rows[0]) {
    const byEmail = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=email,role`,
      { headers: headers(session.access_token) }
    );
    if (byEmail.ok) rows = await byEmail.json();
  }

  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile?.role) return { email, role: null };
  return {
    email: profile.email || email,
    role: String(profile.role).toLowerCase().trim()
  };
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
  if (message) note.textContent = message;
}

async function enter(session) {
  note.textContent = 'Checking role...';
  const profile = await fetchRole(session);
  if (!profile?.role) {
    showGate('Signed in, but no role was found in the database.');
    return;
  }
  if (!ALLOWED_ROLES.includes(profile.role)) {
    showGate('Your role is ' + profile.role + '. Only tester or better can open this site.');
    return;
  }
  showProject(profile);
}

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  note.textContent = 'Signing in...';

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) {
    note.textContent = data.error_description || data.error || 'Sign in failed';
    return;
  }
  saveSession(data);
  enter({
    access_token: data.access_token,
    user: data.user
  });
};

document.getElementById('signOutBtn').onclick = () => {
  localStorage.removeItem('mokio_session');
  showGate('');
};

const existing = getSession();
if (existing?.access_token) enter(existing);
