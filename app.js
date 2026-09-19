const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const PROJECT_PATH = 'current/dev.html';
const ALLOWED_ROLES = ['tester', 'mod', 'dev', 'owner'];

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

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pickProfile(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.role) return null;
  return {
    email: row.email || '',
    role: String(row.role).toLowerCase().trim()
  };
}

async function loadRole(user) {
  try {
    const rpc = await withTimeout(db.rpc('get_my_profile'), 5000, 'Role check');
    if (!rpc.error) {
      const profile = pickProfile(rpc.data);
      if (profile) return profile;
    }
  } catch (_) {}

  if (user?.id) {
    const byId = await withTimeout(
      db.from('profiles').select('email,role').eq('id', user.id).limit(1),
      5000,
      'Role check'
    );
    if (!byId.error) {
      const profile = pickProfile(byId.data);
      if (profile) return profile;
    }
  }

  if (user?.email) {
    const byEmail = await withTimeout(
      db.from('profiles').select('email,role').eq('email', user.email.toLowerCase()).limit(1),
      5000,
      'Role check'
    );
    if (!byEmail.error) {
      const profile = pickProfile(byEmail.data);
      if (profile) return profile;
    }
  }

  return null;
}

async function enter() {
  note.textContent = 'Checking role...';
  try {
    const { data: userData, error } = await db.auth.getUser();
    if (error || !userData.user) {
      showGate('Sign in failed.');
      return;
    }
    const profile = await loadRole(userData.user);
    const email = profile?.email || userData.user.email || '';
    if (!profile) {
      showGate('Logged in as ' + email + ', but no role was found in profiles. Set that email to tester, dev, or owner.');
      return;
    }
    if (!ALLOWED_ROLES.includes(profile.role)) {
      showGate('Logged in as ' + email + '. Role is ' + profile.role + '. Only tester or better can open this site.');
      return;
    }
    showProject(email, profile.role);
  } catch (err) {
    showGate(err.message || 'Could not check your role.');
  }
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
    const { data, error } = await withTimeout(
      db.auth.signInWithPassword({ email, password }),
      10000,
      'Sign in'
    );
    if (error) {
      note.textContent = error.message;
      return;
    }
    if (!data?.session) {
      note.textContent = 'Sign in did not return a session. Check that Email login is enabled.';
      return;
    }
    await enter();
  } catch (err) {
    note.textContent = err.message || 'Sign in failed';
  }
}

document.getElementById('loginBtn').onclick = handleLogin;
document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});
document.getElementById('signOutBtn').onclick = async () => {
  await db.auth.signOut();
  showGate('');
};

db.auth.getSession().then(({ data }) => {
  if (data.session) enter();
});
