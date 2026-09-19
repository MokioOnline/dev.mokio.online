const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const PROJECT_PATH = 'current/dev.html';
const ALLOWED_ROLES = ['tester', 'mod', 'dev', 'owner'];
const KNOWN_ROLES = {
  'mokiobusiness@gmail.com': 'owner',
  'cocomokioyt@gmail.com': 'tester'
};

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const gate = document.getElementById('gate');
const shell = document.getElementById('shell');
const note = document.getElementById('note');
const who = document.getElementById('who');
const frame = document.getElementById('project');

function showGate(message) {
  gate.hidden = false;
  shell.hidden = true;
  frame.removeAttribute('src');
  note.textContent = message || '';
}

function showProject(email, role) {
  gate.hidden = true;
  shell.hidden = false;
  who.textContent = email + ' · ' + role;
  frame.src = PROJECT_PATH + '?t=' + Date.now();
}

function knownRole(email) {
  return KNOWN_ROLES[(email || '').toLowerCase()] || null;
}

async function handleLogin() {
  const email = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    note.textContent = 'Enter email and password.';
    return;
  }
  note.textContent = 'Signing in...';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ email, password }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json();
    if (!res.ok) {
      note.textContent = data.error_description || data.msg || data.error || 'Sign in failed';
      return;
    }

    const userEmail = (data.user && data.user.email || email).toLowerCase();
    let role = knownRole(userEmail);

    if (!role && data.access_token) {
      try {
        const roleCtrl = new AbortController();
        const roleTimer = setTimeout(() => roleCtrl.abort(), 4000);
        const roleRes = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_my_profile', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + data.access_token
          },
          body: '{}',
          signal: roleCtrl.signal
        });
        clearTimeout(roleTimer);
        if (roleRes.ok) {
          const rows = await roleRes.json();
          const row = Array.isArray(rows) ? rows[0] : rows;
          if (row && row.role) role = String(row.role).toLowerCase().trim();
        }
      } catch (_) {}
    }

    if (!role) role = knownRole(userEmail);
    if (!role || !ALLOWED_ROLES.includes(role)) {
      showGate('Signed in as ' + userEmail + ', but this account cannot open the Dev site.');
      return;
    }

    try {
      await db.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token
      });
    } catch (_) {}

    showProject(userEmail, role);
  } catch (err) {
    note.textContent = err.name === 'AbortError' ? 'Sign in timed out' : (err.message || 'Sign in failed');
  }
}

document.getElementById('loginBtn').onclick = handleLogin;
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});
document.getElementById('signOutBtn').onclick = () => {
  db.auth.signOut().catch(() => {});
  showGate('');
};
