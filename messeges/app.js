const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const ALLOWED_ROLES = ['owner', 'tester'];
const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + token
});
const $ = (id) => document.getElementById(id);
let session = null, me = null, current = null;

async function request(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { ok: res.ok, data };
  } finally { clearTimeout(timer); }
}

function kick() {
  localStorage.removeItem('mokio_session');
  location.replace('../index.html');
}

function initial(name) {
  return String(name || 'M').replace('@', '').slice(0, 1).toUpperCase();
}

async function boot() {
  try { session = JSON.parse(localStorage.getItem('mokio_session') || 'null'); } catch (_) { session = null; }
  if (!session?.access_token || !session.user) { kick(); return; }
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/get_my_profile', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  });
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  const role = String(row?.role || session.profile?.role || '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) { kick(); return; }
  const extra = await request(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + session.user.id + '&select=display_name,bio,pronouns,color,banner_color,status,hide_online', { headers: headers(session.access_token) });
  const extraRow = Array.isArray(extra.data) ? extra.data[0] : extra.data || {};
  me = {
    id: session.user.id,
    email: (row?.email || session.user.email || '').toLowerCase(),
    username: row?.username || session.profile?.username || '',
    role,
    displayName: extraRow?.display_name || row?.username || '',
    bio: extraRow?.bio || '',
    pronouns: extraRow?.pronouns || '',
    color: extraRow?.color || '#4fc3f7',
    bannerColor: extraRow?.banner_color || '#12141c',
    status: extraRow?.status || 'online',
    hideOnline: !!extraRow?.hide_online
  };
  paintMe();
  await loadFriends();
  await loadConvos();
  loadServers();
}

function paintMe() {
  const label = me.displayName || me.username || me.email;
  $('meName').textContent = label;
  $('meSub').textContent = me.status + ' · ' + me.role;
  $('meAv').textContent = initial(label);
  $('meAv').style.background = me.color;
  $('displayName').value = me.displayName || '';
  $('bio').value = me.bio || '';
  $('pronouns').value = me.pronouns || '';
  $('color').value = me.color || '#4fc3f7';
  $('bannerColor').value = me.bannerColor || '#12141c';
  $('status').value = me.status || 'online';
  $('hideOnline').checked = !!me.hideOnline;
  $('prevName').textContent = label;
  $('prevUser').textContent = me.username ? '@' + me.username : me.email;
  $('prevAv').textContent = initial(label);
  $('prevAv').style.background = me.color;
  $('banner').style.background = me.bannerColor;
}

function showPane(name, title) {
  ['friendsPane','notesPane','settingsPane','chatPane'].forEach((id) => { $(id).hidden = id !== name; });
  $('title').textContent = title;
}

$('homeBtn').onclick = $('friendsBtn').onclick = () => {
  current = null;
  showPane('friendsPane', 'Friends');
};
$('notesBtn').onclick = () => showPane('notesPane', 'Notifications');
$('settingsBtn').onclick = $('meBtn').onclick = () => showPane('settingsPane', 'Settings');
$('saveProfile').onclick = saveProfile;
$('color').oninput = $('bannerColor').oninput = $('displayName').oninput = () => {
  me.displayName = $('displayName').value;
  me.color = $('color').value;
  me.bannerColor = $('bannerColor').value;
  paintMe();
};
$('emojiBtn').onclick = () => {
  const bar = $('emojiBar');
  if (!bar.dataset.ready) {
    '😀😂😍🥰😎🤔😭😡👍👎👏🙌🔥✨💯❤️💜💙🎉🙏👀💀✅⭐🌙☀️🌈🐶🐱🍕☕'.split(/(.{1})/u).filter(Boolean).forEach((e) => {
      if (!e.trim()) return;
    });
    ['😀','😂','😍','🥰','😎','🤔','😭','😡','👍','👎','👏','🙌','🔥','✨','💯','❤️','💜','💙','🎉','🙏','👀','💀','✅','⭐'].forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = () => { const input = $('composer').body; input.value += e; input.focus(); };
      bar.appendChild(b);
    });
    bar.dataset.ready = '1';
  }
  bar.hidden = !bar.hidden;
};
$('newServerBtn').onclick = () => {
  const name = prompt('Server name');
  if (!name) return;
  const list = JSON.parse(localStorage.getItem('mokio_servers') || '[]');
  list.push({ id: Date.now().toString(), name });
  localStorage.setItem('mokio_servers', JSON.stringify(list));
  loadServers();
};
function loadServers() {
  const list = JSON.parse(localStorage.getItem('mokio_servers') || '[]');
  const box = $('servers');
  box.innerHTML = '';
  list.forEach((sv) => {
    const b = document.createElement('button');
    b.className = 'orb';
    b.title = sv.name;
    b.textContent = sv.name.slice(0, 1).toUpperCase();
    b.onclick = () => { $('midTitle').textContent = sv.name; showPane('friendsPane', sv.name); };
    box.appendChild(b);
  });
}
async function saveProfile() {
  const payload = {
    display_name: $('displayName').value.trim(),
    bio: $('bio').value.trim(),
    pronouns: $('pronouns').value.trim(),
    color: $('color').value,
    banner_color: $('bannerColor').value,
    status: $('status').value,
    hide_online: $('hideOnline').checked
  };
  $('saveNote').textContent = 'Saving...';
  const res = await request(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + me.id, {
    method: 'PATCH',
    headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    $('saveNote').textContent = (res.data && res.data.message) || 'Run the profile SQL first.';
    return;
  }
  Object.assign(me, {
    displayName: payload.display_name,
    bio: payload.bio,
    pronouns: payload.pronouns,
    color: payload.color,
    bannerColor: payload.banner_color,
    status: payload.status,
    hideOnline: payload.hide_online
  });
  paintMe();
  $('saveNote').textContent = 'Saved.';
}

$('addFriend').onsubmit = async (e) => {
  e.preventDefault();
  const handle = e.target.handle.value.trim().toLowerCase().replace(/^@/, '');
  const found = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_handle', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ handle })
  });
  const other = Array.isArray(found.data) ? found.data[0] : found.data;
  if (!other?.id) { alert('No Mokio user found.'); return; }
  if (other.id === me.id) { alert('That is you.'); return; }
  const res = await request(SUPABASE_URL + '/rest/v1/friends', {
    method: 'POST',
    headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify({ requester: me.id, addressee: other.id, status: 'accepted' })
  });
  if (!res.ok) alert((res.data && res.data.message) || 'Could not add friend. Run the friends SQL.');
  e.target.reset();
  loadFriends();
};

async function loadFriends() {
  const res = await request(
    SUPABASE_URL + '/rest/v1/friends?or=(requester.eq.' + me.id + ',addressee.eq.' + me.id + ')&select=*',
    { headers: headers(session.access_token) }
  );
  const box = $('friends');
  box.innerHTML = '';
  for (const row of res.data || []) {
    const otherId = row.requester === me.id ? row.addressee : row.requester;
    const personRes = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_id', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ uid: otherId })
    });
    const person = Array.isArray(personRes.data) ? personRes.data[0] : personRes.data;
    const name = person?.username ? '@' + person.username : (person?.email || 'Friend');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><div class="avatar">' + initial(name) + '</div><div style="flex:1"><div>' + name + '</div><div class="sub">Friend</div></div><button class="send" type="button">Message</button></div>';
    card.querySelector('button').onclick = () => openChat(otherId, name);
    box.appendChild(card);
  }
  if (!box.children.length) box.innerHTML = '<p class="sub">No friends yet. Add one by username.</p>';
}

async function loadConvos() {
  const res = await request(
    SUPABASE_URL + '/rest/v1/conversations?or=(user_a.eq.' + me.id + ',user_b.eq.' + me.id + ')&select=*&order=created_at.desc',
    { headers: headers(session.access_token) }
  );
  const box = $('convos');
  box.innerHTML = '';
  for (const convo of res.data || []) {
    const otherId = convo.user_a === me.id ? convo.user_b : convo.user_a;
    const personRes = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_id', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ uid: otherId })
    });
    const person = Array.isArray(personRes.data) ? personRes.data[0] : personRes.data;
    const label = person?.username ? '@' + person.username : (person?.email || 'Chat');
    const btn = document.createElement('button');
    btn.className = 'mid-item';
    btn.textContent = label;
    btn.onclick = () => openChat(otherId, label, convo);
    box.appendChild(btn);
  }
}

async function openChat(otherId, title, existing) {
  let convo = existing;
  if (!convo) {
    const look = await request(
      SUPABASE_URL + '/rest/v1/conversations?or=(and(user_a.eq.' + me.id + ',user_b.eq.' + otherId + '),and(user_a.eq.' + otherId + ',user_b.eq.' + me.id + '))&select=*',
      { headers: headers(session.access_token) }
    );
    convo = Array.isArray(look.data) ? look.data[0] : null;
    if (!convo) {
      const created = await request(SUPABASE_URL + '/rest/v1/conversations', {
        method: 'POST',
        headers: { ...headers(session.access_token), Prefer: 'return=representation' },
        body: JSON.stringify({ user_a: me.id, user_b: otherId })
      });
      convo = Array.isArray(created.data) ? created.data[0] : created.data;
    }
  }
  if (!convo) { alert('Could not open chat'); return; }
  current = convo;
  $('title').textContent = title;
  $('friendsPane').hidden = true;
  $('chatPane').hidden = false;
  await loadConvos();
  const msgs = await request(
    SUPABASE_URL + '/rest/v1/messages?conversation_id=eq.' + convo.id + '&select=*&order=created_at.asc',
    { headers: headers(session.access_token) }
  );
  const thread = $('thread');
  thread.innerHTML = '';
  (msgs.data || []).forEach((msg) => {
    const mine = msg.sender_id === me.id;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = mine ? 'flex-end' : 'flex-start';
    row.innerHTML = '<div class="bubble"><div class="meta">' + (mine ? 'You' : title) + '</div><div class="msg">' + String(msg.body || '').replace(/</g, '&lt;') + '</div></div>';
    thread.appendChild(row);
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
  openChat(current.user_a === me.id ? current.user_b : current.user_a, $('title').textContent, current);
};

boot();
