const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const ALLOWED_ROLES = ['owner', 'tester'];

const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + token
});

const $ = (id) => document.getElementById(id);
let session = null;
let me = null;
let current = null;

async function request(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

function kick() {
  localStorage.removeItem('mokio_session');
  location.replace('../index.html');
}

async function boot() {
  try {
    session = JSON.parse(localStorage.getItem('mokio_session') || 'null');
  } catch (_) {
    session = null;
  }
  if (!session?.access_token || !session.user) {
    kick();
    return;
  }
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/get_my_profile', {
    method: 'POST',
    headers: headers(session.access_token),
    body: '{}'
  });
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  const role = String(row?.role || session.profile?.role || '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    kick();
    return;
  }
  me = {
    id: session.user.id,
    email: (row?.email || session.user.email || '').toLowerCase(),
    username: row?.username || session.profile?.username || '',
    role
  };
  $('me').textContent = (me.username ? '@' + me.username : me.email) + ' · ' + me.role;
  loadConvos();
}

$('signOutBtn').onclick = () => kick();

async function findUser(handle) {
  const value = handle.trim().toLowerCase().replace(/^@/, '');
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_handle', {
    method: 'POST',
    headers: headers(session.access_token),
    body: JSON.stringify({ handle: value })
  });
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  return row && row.id ? row : null;
}

$('startChat').onsubmit = async (e) => {
  e.preventDefault();
  const other = await findUser(e.target.handle.value);
  if (!other?.id) { alert('No Mokio user found.'); return; }
  if (other.id === me.id) { alert('That is your own account.'); return; }
  const existing = await request(
    SUPABASE_URL + '/rest/v1/conversations?or=(and(user_a.eq.' + me.id + ',user_b.eq.' + other.id + '),and(user_a.eq.' + other.id + ',user_b.eq.' + me.id + '))&select=*',
    { headers: headers(session.access_token) }
  );
  let convo = Array.isArray(existing.data) ? existing.data[0] : null;
  if (!convo) {
    const created = await request(SUPABASE_URL + '/rest/v1/conversations', {
      method: 'POST',
      headers: { ...headers(session.access_token), Prefer: 'return=representation' },
      body: JSON.stringify({ user_a: me.id, user_b: other.id })
    });
    convo = Array.isArray(created.data) ? created.data[0] : created.data;
    if (!created.ok || !convo) { alert((created.data && created.data.message) || 'Could not start chat'); return; }
  }
  e.target.reset();
  await loadConvos();
  openConvo(convo, other.username ? '@' + other.username : other.email);
};

async function loadConvos() {
  const res = await request(
    SUPABASE_URL + '/rest/v1/conversations?or=(user_a.eq.' + me.id + ',user_b.eq.' + me.id + ')&select=*&order=created_at.desc',
    { headers: headers(session.access_token) }
  );
  $('convos').innerHTML = '';
  for (const convo of res.data || []) {
    const otherId = convo.user_a === me.id ? convo.user_b : convo.user_a;
    const personRes = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_id', {
      method: 'POST',
      headers: headers(session.access_token),
      body: JSON.stringify({ uid: otherId })
    });
    const person = Array.isArray(personRes.data) ? personRes.data[0] : personRes.data;
    const label = person?.username ? '@' + person.username : (person?.email || 'Chat');
    const item = document.createElement('div');
    item.className = 'convo';
    item.textContent = label;
    item.onclick = () => openConvo(convo, label);
    $('convos').appendChild(item);
  }
}

async function openConvo(convo, title) {
  current = convo;
  $('chatTop').textContent = title;
  $('composer').hidden = false;
  const res = await request(
    SUPABASE_URL + '/rest/v1/messages?conversation_id=eq.' + convo.id + '&select=*&order=created_at.asc',
    { headers: headers(session.access_token) }
  );
  const thread = $('thread');
  thread.innerHTML = '';
  (res.data || []).forEach((msg) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (msg.sender_id === me.id ? ' mine' : '');
    bubble.textContent = msg.body;
    thread.appendChild(bubble);
  });
  thread.scrollTop = thread.scrollHeight;
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  if (!current) return;
  const body = e.target.body.value.trim();
  if (!body) return;
  const res = await request(SUPABASE_URL + '/rest/v1/messages', {
    method: 'POST',
    headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify({ conversation_id: current.id, sender_id: me.id, body })
  });
  if (!res.ok) { alert((res.data && res.data.message) || 'Could not send'); return; }
  e.target.reset();
  openConvo(current, $('chatTop').textContent);
};

boot();
