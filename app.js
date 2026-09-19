const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const PROJECT_PATH = 'current/dev.html';
const ALLOWED_ROLES = ['tester', 'mod', 'dev', 'owner'];

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
  frame.src = PROJECT_PATH;
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

async function loadRole() {
  const rpc = supabase.rpc('get_my_profile');
  const { data, error } = await withTimeout(rpc, 6000, 'Role check');
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.role) return null;
  return {
    email: row.email || '',
    role: String(row.role).toLowerCase().trim()
  };
}

async function enter() {
  note.textContent = 'Checking role...';
  try {
    const profile = await loadRole();
    if (!profile) {
      showGate('Signed in, but no role was found. In Supabase set your profiles.role to tester, dev, or owner.');
      return;
    }
    if (!ALLOWED_ROLES.includes(profile.role)) {
      showGate('Your role is ' + profile.role + '. Only tester or better can open this site.');
      return;
    }
    const { data: userData } = await supabase.auth.getUser();
    showProject(profile.email || userData.user?.email || '', profile.role);
  } catch (err) {
    showGate(err.message || 'Could not check your role. Run the get_my_profile SQL in Supabase.');
  }
}

document.getElementById('loginBtn').onclick = async () => {
  const email = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  if (!email || !password) {
    note.textContent = 'Enter email and password.';
    return;
  }
  note.textContent = 'Signing in...';
  try {
    const { data, error } = await withTimeout(
      supabase.auth.signInWithPassword({ email, password }),
      10000,
      'Sign in'
    );
    if (error) {
      note.textContent = error.message;
      return;
    }
    localStorage.setItem('mokio_session', JSON.stringify({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user
    }));
    await enter();
  } catch (err) {
    note.textContent = err.message || 'Sign in failed';
  }
};

document.getElementById('signOutBtn').onclick = async () => {
  await supabase.auth.signOut();
  localStorage.removeItem('mokio_session');
  showGate('');
};

(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) enter();
})();
