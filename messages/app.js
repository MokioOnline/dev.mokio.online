const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const ALLOWED_ROLES = ['owner', 'tester'];
const headers = (token = SUPABASE_ANON_KEY) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: 'Bearer ' + token
});
const $ = (id) => document.getElementById(id);
let session = null, me = null, current = null, currentChannel = null, activeServer = null;
let voice = { stream: null, channel: null };
let callState = { pc: null, stream: null, call: null, otherId: null, incoming: null, seenSignals: new Set() };
let lastThreadKey = "";
let ringTimer = null;
let ringCtx = null;

async function request(url, options = {}, ms = 5000) {
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
function showPane(name, title) {
  const inCall = !!(callState && callState.call);
  ['friendsPane','notesPane','settingsPane','appSettingsPane','chatPane','voicePane'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (id === 'voicePane') el.hidden = !inCall || name !== 'voicePane';
    else el.hidden = id !== name;
  });
  if (!inCall && $('voicePane')) $('voicePane').hidden = true;
  $('title').textContent = title;
  $('callBtn').hidden = !(name === 'chatPane' && current && !currentChannel);
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
  document.body.classList.toggle('compact', localStorage.getItem('mokio_compact') === '1');
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  $('incoming').hidden = true;
  await loadFriends();
  await loadConvos();
  await loadServers();
  const existing = await request(SUPABASE_URL + '/rest/v1/rpc/my_calls', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  });
  const old = (Array.isArray(existing.data) ? existing.data : []).filter((c) => c.status === 'ringing').map((c) => c.id);
  if (old.length) sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(old));
}

function startRing() {
  stopRing();
  if (notePrefs().sound === false) return;
  const audio = new Audio('ring.mp3');
  audio.loop = true;
  audio.volume = 0.55;
  audio.play().catch(() => {});
  ringCtx = audio;
}
function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
  if (ringCtx && ringCtx.pause) { try { ringCtx.pause(); ringCtx.src = ''; } catch (_) {} }
  ringCtx = null;
}
let remoteGain = null;
let remoteAudioCtx = null;
function hookRemoteVolume(videoEl) {
  if (!videoEl || !videoEl.srcObject) return;
  try {
    if (remoteAudioCtx) { try { remoteAudioCtx.close(); } catch (_) {} }
    remoteAudioCtx = new AudioContext();
    const src = remoteAudioCtx.createMediaStreamSource(videoEl.srcObject);
    remoteGain = remoteAudioCtx.createGain();
    remoteGain.gain.value = (Number($('volSlider')?.value) || 100) / 100;
    src.connect(remoteGain);
    remoteGain.connect(remoteAudioCtx.destination);
    videoEl.muted = true;
  } catch (_) {
    videoEl.muted = false;
    videoEl.volume = Math.min(1, (Number($('volSlider')?.value) || 100) / 100);
  }
}
function playHangupTone() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 420;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.09, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    o.start();
    o.stop(ctx.currentTime + 0.45);
    setTimeout(() => ctx.close(), 600);
  } catch (_) {}
}
function notifyCall(title) {
  const p = notePrefs();
  if (p.calls === false) return;
  try {
    if (p.push && window.Notification && Notification.permission === 'granted') {
      new Notification(title || 'Incoming Mokio call', { body: 'Tap the app to accept or decline.', icon: 'icon.png' });
    }
  } catch (_) {}
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
  if ($('settingsUsername')) $('settingsUsername').value = me.username || '';
  $('prevAv').textContent = initial(label);
  $('prevAv').style.background = me.color;
  $('banner').style.background = me.bannerColor;
}

$('homeBtn').onclick = $('friendsBtn').onclick = () => {
  current = null; currentChannel = null; activeServer = null;
  $('dmList').hidden = false;
  $('serverList').hidden = true;
  $('midTitle').textContent = 'Direct messages';
  showPane('friendsPane', 'Friends');
};
function notePrefs() {
  try { return JSON.parse(localStorage.getItem('mokio_notes') || '{}'); } catch (_) { return {}; }
}
function loadNotePrefs() {
  const p = notePrefs();
  if ($('noteCalls')) $('noteCalls').checked = p.calls !== false;
  if ($('noteMsgs')) $('noteMsgs').checked = p.msgs !== false;
  if ($('noteSound')) $('noteSound').checked = p.sound !== false;
  if ($('notePush')) $('notePush').checked = !!p.push;
}
$('notesBtn').onclick = () => { loadNotePrefs(); showPane('notesPane', 'Notifications'); };
if ($('bellBtn')) $('bellBtn').onclick = () => { loadNotePrefs(); showPane('notesPane', 'Notifications'); };
$('settingsBtn').onclick = $('meBtn').onclick = () => showPane('settingsPane', 'Account');
if ($('cogBtn')) $('cogBtn').onclick = () => {
  if ($('appCompact')) $('appCompact').checked = localStorage.getItem('mokio_compact') === '1';
  if ($('appTime24')) $('appTime24').checked = localStorage.getItem('mokio_time24') === '1';
  showPane('appSettingsPane', 'Settings');
};
if ($('saveAppSettings')) $('saveAppSettings').onclick = () => {
  localStorage.setItem('mokio_compact', $('appCompact').checked ? '1' : '0');
  localStorage.setItem('mokio_time24', $('appTime24').checked ? '1' : '0');
  document.body.classList.toggle('compact', $('appCompact').checked);
  $('appSaveMsg').textContent = 'Saved.';
};
if ($('saveNotes')) $('saveNotes').onclick = () => {
  localStorage.setItem('mokio_notes', JSON.stringify({
    calls: $('noteCalls').checked,
    msgs: $('noteMsgs').checked,
    sound: $('noteSound').checked,
    push: $('notePush').checked
  }));
  if ($('notePush').checked && window.Notification && Notification.permission === 'default') Notification.requestPermission();
  $('noteSaveMsg').textContent = 'Saved on this device.';
};
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

$('newServerBtn').onclick = async () => {
  const name = prompt('Server name');
  if (!name) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/create_server', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ sname: name })
  });
  if (!res.ok) { alert((res.data && res.data.message) || 'Could not create server.'); return; }
  await loadServers();
};

async function loadServers() {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/my_servers', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  });
  const box = $('servers');
  box.innerHTML = '';
  (Array.isArray(res.data) ? res.data : []).forEach((sv) => {
    const b = document.createElement('button');
    b.className = 'orb';
    b.title = sv.name;
    b.textContent = String(sv.name || 'S').slice(0, 1).toUpperCase();
    b.onclick = () => openServer(sv);
    box.appendChild(b);
  });
}

async function openServer(sv) {
  activeServer = sv;
  current = null;
  $('dmList').hidden = true;
  $('serverList').hidden = false;
  $('midTitle').textContent = sv.name;
  const ch = await request(SUPABASE_URL + '/rest/v1/rpc/server_channels', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ sid: sv.id })
  });
  const list = Array.isArray(ch.data) ? ch.data : [];
  $('textChannels').innerHTML = '';
  $('voiceChannels').innerHTML = '';
  list.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'mid-item chan';
    b.textContent = (c.kind === 'voice' ? '🔊 ' : '# ') + c.name;
    b.onclick = () => c.kind === 'voice' ? joinVoice(c) : openChannel(c);
    (c.kind === 'voice' ? $('voiceChannels') : $('textChannels')).appendChild(b);
  });
  const firstText = list.find((c) => c.kind === 'text');
  if (firstText) openChannel(firstText);
}

async function addChannel(kind) {
  if (!activeServer) return;
  const name = prompt(kind === 'voice' ? 'Voice channel name' : 'Text channel name');
  if (!name) return;
  await request(SUPABASE_URL + '/rest/v1/rpc/add_channel', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sid: activeServer.id, cname: name, ckind: kind })
  });
  openServer(activeServer);
}
$('addTextBtn').onclick = () => addChannel('text');
$('addVoiceBtn').onclick = () => addChannel('voice');
$('inviteForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!activeServer) return;
  const handle = e.target.handle.value.trim().toLowerCase().replace(/^@/, '');
  const other = await findHandle(handle);
  if (!other?.id) { alert('No user found'); return; }
  await request(SUPABASE_URL + '/rest/v1/rpc/invite_member', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sid: activeServer.id, uid: other.id })
  });
  e.target.reset();
};

async function openChannel(ch) {
  current = null;
  currentChannel = ch;
  lastThreadKey = '';
  showPane('chatPane', '# ' + ch.name);
  await refreshMessages();
}

async function joinVoice(ch) {
  currentChannel = ch; current = null;
  if (callState.call) showPane('voicePane', 'Call');
  $('voiceTitle').textContent = 'Voice · ' + ch.name;
  try { voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
  catch { voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null); }
  if (voice.stream && $('localVid')) $('localVid').srcObject = voice.stream;
  if ($('localFace')) $('localFace').textContent = initial(me.displayName || me.username || 'You');
  await request(SUPABASE_URL + '/rest/v1/rpc/join_voice', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ cid: ch.id, uname: me.displayName || me.username || me.email })
  });
  voice.channel = ch;
  paintCallButtons();
}

function activeStream() { return callState.stream || voice.stream; }
const ICO_MIC = '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0"/><path d="M12 18v3"/></svg>';
const ICO_MIC_OFF = '<svg viewBox="0 0 24 24"><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M12 3a3 3 0 0 1 3 3v4"/><path d="M19 11a7 7 0 0 1-9.2 6.6"/><path d="M5 11a7 7 0 0 0 2.1 5"/><path d="M12 18v3"/><path d="M4 4l16 16"/></svg>';
const ICO_CAM = '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>';
const ICO_CAM_OFF = '<svg viewBox="0 0 24 24"><path d="M16 10l5-3v10l-5-3z"/><path d="M3 7h8"/><path d="M3 17h10l3-3"/><path d="M4 4l16 16"/></svg>';
function paintCallButtons() {
  const stream = activeStream();
  const audioOn = !!(stream && stream.getAudioTracks().some((tr) => tr.enabled));
  const videoOn = !!(stream && stream.getVideoTracks().some((tr) => tr.enabled));
  if ($('muteBtn')) {
    $('muteBtn').innerHTML = audioOn ? ICO_MIC : ICO_MIC_OFF;
    $('muteBtn').title = audioOn ? 'Mute' : 'Unmute';
    $('muteBtn').classList.toggle('off', !audioOn);
  }
  if ($('camBtn')) {
    $('camBtn').innerHTML = videoOn ? ICO_CAM : ICO_CAM_OFF;
    $('camBtn').title = videoOn ? 'Camera off' : 'Camera on';
    $('camBtn').classList.toggle('off', !videoOn);
  }
}
$('muteBtn').onclick = () => {
  const stream = activeStream();
  if (!stream) return;
  stream.getAudioTracks().forEach((tr) => { tr.enabled = !tr.enabled; });
  paintCallButtons();
};
$('camBtn').onclick = () => {
  const stream = activeStream();
  if (!stream) return;
  stream.getVideoTracks().forEach((tr) => { tr.enabled = !tr.enabled; });
  if ($('localVid')) $('localVid').hidden = !stream.getVideoTracks().some((tr) => tr.enabled);
  paintCallButtons();
};
if ($('moreBtn') && $('moreMenu')) {
  $('moreBtn').onclick = (e) => {
    e.stopPropagation();
    $('moreMenu').hidden = !$('moreMenu').hidden;
  };
  document.addEventListener('click', () => { if ($('moreMenu')) $('moreMenu').hidden = true; });
}
if ($('volSlider')) {
  $('volSlider').oninput = () => {
    const pct = Number($('volSlider').value);
    $('volLabel').textContent = String(pct);
    if (remoteGain) remoteGain.gain.value = pct / 100;
    else if ($('remoteVid')) $('remoteVid').volume = Math.min(1, pct / 100);
  };
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
  const uname = ($('settingsUsername') && $('settingsUsername').value.trim().toLowerCase()) || '';
  if (uname && uname !== me.username) {
    await request(SUPABASE_URL + '/rest/v1/rpc/set_my_username', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ new_username: uname })
    });
    me.username = uname;
  }
  $('saveNote').textContent = res.ok ? 'Saved.' : ((res.data && res.data.message) || 'Run the profile SQL first.');
  if (res.ok) {
    Object.assign(me, { displayName: payload.display_name, bio: payload.bio, pronouns: payload.pronouns, color: payload.color, bannerColor: payload.banner_color, status: payload.status, hideOnline: payload.hide_online });
    paintMe();
  }
}

$('addFriend').onsubmit = async (e) => {
  e.preventDefault();
  const handle = e.target.handle.value.trim().toLowerCase().replace(/^@/, '');
  if (!handle) return;
  const other = await findHandle(handle);
  if (!other?.id) { alert('No Mokio user found for ' + handle); return; }
  if (other.id === me.id) { alert('That is you.'); return; }
  await request(SUPABASE_URL + '/rest/v1/rpc/add_friend', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ target: other.id })
  });
  await request(SUPABASE_URL + '/rest/v1/friends', {
    method: 'POST', headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify({ requester: me.id, addressee: other.id, status: 'accepted' })
  });
  e.target.reset();
  await loadFriends();
  openChat(other.id, other.username ? '@' + other.username : (other.email || handle));
};

async function findHandle(handle) {
  let found = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_handle', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ handle })
  });
  let row = Array.isArray(found.data) ? found.data[0] : found.data;
  if (row && row.id) return row;
  found = await request(SUPABASE_URL + '/rest/v1/rpc/email_for_username', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ lookup: handle })
  });
  const email = typeof found.data === 'string' ? found.data : (found.data && found.data.email);
  if (email) {
    found = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_handle', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ handle: email })
    });
    row = Array.isArray(found.data) ? found.data[0] : found.data;
    if (row && row.id) return row;
  }
  return null;
}
async function findId(uid) {
  const personRes = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_id', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ uid })
  });
  return Array.isArray(personRes.data) ? personRes.data[0] : personRes.data;
}

async function loadFriends() {
  const res = await request(SUPABASE_URL + '/rest/v1/friends?or=(requester.eq.' + me.id + ',addressee.eq.' + me.id + ')&select=*', { headers: headers(session.access_token) });
  const box = $('friends');
  box.innerHTML = '';
  for (const row of res.data || []) {
    const otherId = row.requester === me.id ? row.addressee : row.requester;
    const person = await findId(otherId);
    const name = person?.username ? '@' + person.username : (person?.email || 'Friend');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div style="display:flex;align-items:center;gap:10px"><div class="avatar">' + initial(name) + '</div><div style="flex:1"><div>' + name + '</div><div class="sub">Friend</div></div><button class="send" type="button">Message</button><button class="ghost" type="button">Call</button></div>';
    const buttons = card.querySelectorAll('button');
    buttons[0].onclick = () => openChat(otherId, name);
    buttons[1].onclick = () => startCall(otherId, name);
    box.appendChild(card);
  }
  if (!box.children.length) box.innerHTML = '<p class="sub">No friends yet. Add one by username.</p>';
}

async function loadConvos() {
  const res = await request(SUPABASE_URL + '/rest/v1/conversations?or=(user_a.eq.' + me.id + ',user_b.eq.' + me.id + ')&select=*&order=created_at.desc', { headers: headers(session.access_token) });
  const box = $('convos');
  box.innerHTML = '';
  for (const convo of res.data || []) {
    const otherId = convo.user_a === me.id ? convo.user_b : convo.user_a;
    const person = await findId(otherId);
    const label = person?.username ? '@' + person.username : (person?.email || 'Chat');
    const btn = document.createElement('button');
    btn.className = 'mid-item';
    btn.textContent = label;
    btn.onclick = () => openChat(otherId, label, convo);
    box.appendChild(btn);
  }
}

async function openChat(otherId, title, existing) {
  currentChannel = null;
  let convo = existing;
  const opened = await request(SUPABASE_URL + '/rest/v1/rpc/open_dm', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ target: otherId })
  });
  if (opened.ok && opened.data) {
    convo = Array.isArray(opened.data) ? opened.data[0] : opened.data;
  }
  if (!convo || !convo.id) {
    const look = await request(SUPABASE_URL + '/rest/v1/conversations?or=(and(user_a.eq.' + me.id + ',user_b.eq.' + otherId + '),and(user_a.eq.' + otherId + ',user_b.eq.' + me.id + '))&select=*', { headers: headers(session.access_token) });
    convo = Array.isArray(look.data) ? look.data[0] : null;
  }
  if (!convo || !convo.id) {
    const created = await request(SUPABASE_URL + '/rest/v1/conversations', {
      method: 'POST', headers: { ...headers(session.access_token), Prefer: 'return=representation' },
      body: JSON.stringify({ user_a: me.id, user_b: otherId })
    });
    convo = Array.isArray(created.data) ? created.data[0] : created.data;
  }
  if (!convo || !convo.id) { alert((opened.data && opened.data.message) || 'Could not open chat. Run the open_dm SQL.'); return; }
  current = convo;
  lastThreadKey = '';
  showPane('chatPane', title);
  await loadConvos();
  await refreshMessages();
}

function localTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: localStorage.getItem('mokio_time24') !== '1'
    });
  } catch (_) { return ''; }
}
function renderThread(list, title) {
  const key = list.map((m) => m.id + ':' + (m.updated_at || '') + ':' + (m.body || '')).join('|');
  if (key === lastThreadKey) return;
  lastThreadKey = key;
  const thread = $('thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  thread.innerHTML = '';
  list.forEach((msg) => {
    const mine = msg.sender_id === me.id;
    const edited = msg.updated_at && msg.created_at && msg.updated_at !== msg.created_at;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = mine ? 'flex-end' : 'flex-start';
    row.innerHTML = '<div class="bubble" data-id="' + msg.id + '"><div class="meta">' + (mine ? 'You' : title) + ' · ' + localTime(msg.created_at) + (edited ? ' · edited' : '') + '</div><div class="msg">' + String(msg.body || '').replace(/</g, '&lt;') + '</div>' + (mine ? '<div class="msg-actions"><button type="button" class="ed">Edit</button><button type="button" class="del">Delete</button></div>' : '') + '</div>';
    if (mine) {
      row.querySelector('.ed').onclick = () => editMessage(msg);
      row.querySelector('.del').onclick = () => deleteMessage(msg.id);
    }
    thread.appendChild(row);
  });
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'sub';
    empty.textContent = 'No messages yet. Type below to send one.';
    thread.appendChild(empty);
  }
  if (atBottom || !key) thread.scrollTop = thread.scrollHeight;
}
async function editMessage(msg) {
  const next = prompt('Edit message', msg.body || '');
  if (next == null) return;
  const body = String(next).trim().slice(0, 2000);
  if (!body) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/edit_message', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ mid: msg.id, new_body: body })
  });
  if (!res.ok) alert((res.data && res.data.message) || 'Could not edit');
  lastThreadKey = '';
  refreshMessages();
}
async function deleteMessage(id) {
  if (!confirm('Delete this message?')) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/delete_message', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ mid: id })
  });
  if (!res.ok) alert((res.data && res.data.message) || 'Could not delete');
  lastThreadKey = '';
  refreshMessages();
}

async function refreshMessages() {
  if (!$('chatPane') || $('chatPane').hidden) return;
  let list = [];
  let title = $('title').textContent;
  if (currentChannel) {
    const msgs = await request(SUPABASE_URL + '/rest/v1/rpc/channel_messages', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: currentChannel.id })
    }, 4000);
    list = Array.isArray(msgs.data) ? msgs.data : [];
    title = '# ' + currentChannel.name;
  } else if (current) {
    const msgs = await request(SUPABASE_URL + '/rest/v1/messages?conversation_id=eq.' + current.id + '&select=*&order=created_at.asc', { headers: headers(session.access_token) }, 4000);
    list = Array.isArray(msgs.data) ? msgs.data : [];
  } else return;
  renderThread(list, title);
}

let lastSendAt = 0;
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const body = e.target.body.value.trim().slice(0, 2000);
  if (!body) return;
  if (Date.now() - lastSendAt < 400) return;
  lastSendAt = Date.now();
  const payload = { sender_id: me.id, body };
  if (currentChannel) payload.channel_id = currentChannel.id;
  else if (current) payload.conversation_id = current.id;
  else return;
  e.target.body.value = '';
  const thread = $('thread');
  const row = document.createElement('div');
  row.className = 'row';
  row.style.justifyContent = 'flex-end';
  row.innerHTML = '<div class="bubble"><div class="meta">You</div><div class="msg">' + body.replace(/</g, '&lt;') + '</div></div>';
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  lastThreadKey = '';
  let res = await request(SUPABASE_URL + '/rest/v1/rpc/post_message', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({
      sender_id: me.id,
      body,
      conversation_id: current && !currentChannel ? current.id : null,
      channel_id: currentChannel ? currentChannel.id : null
    })
  }, 4000);
  if (!res.ok) {
    res = await request(SUPABASE_URL + '/rest/v1/messages', {
      method: 'POST',
      headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    }, 4000);
  }
  if (!res.ok) alert((res.data && (res.data.message || res.data.hint)) || 'Message failed');
  lastThreadKey = '';
  refreshMessages();
};

function iceServers() {
  return { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ] };
}

async function sendSignal(kind, payload) {
  if (!callState.call) return;
  const body = kind === 'ice' ? (payload && payload.toJSON ? payload.toJSON() : payload) : { type: payload.type, sdp: payload.sdp };
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/send_signal', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ cid: callState.call.id, kind, payload: body })
  }, 4000);
  if (!res.ok) {
    await request(SUPABASE_URL + '/rest/v1/call_signals', {
      method: 'POST', headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
      body: JSON.stringify({ call_id: callState.call.id, from_id: me.id, kind, payload: body })
    }, 4000);
  }
}

function showLocalVideo() {
  const local = $('localVid');
  const face = $('localFace');
  if (local && callState.stream) {
    local.srcObject = callState.stream;
    local.hidden = !callState.stream.getVideoTracks().some((t) => t.enabled);
  }
  if (face) face.textContent = initial(me?.displayName || me?.username || 'You');
  if ($('remoteFace') && !$('remoteVid').srcObject) $('remoteFace').textContent = initial($('title').textContent || '?');
  if ($('remoteName')) $('remoteName').textContent = ($('title').textContent || 'Them').replace(/^Call · /, '');
}

async function ensurePC() {
  if (callState.pc) return callState.pc;
  const pc = new RTCPeerConnection(iceServers());
  callState.pc = pc;
  if (callState.stream) callState.stream.getTracks().forEach((tr) => pc.addTrack(tr, callState.stream));
  pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal('ice', ev.candidate); };
  pc.ontrack = (ev) => {
    const remote = $('remoteVid');
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    if (remote) {
      remote.srcObject = stream;
      hookRemoteVolume(remote);
    }
  };
  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState) && callState.call) {
      $('voiceTitle').textContent = 'Call ' + pc.connectionState;
    }
  };
  return pc;
}

async function attachMedia() {
  try { callState.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
  catch { callState.stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null); }
  showLocalVideo();
  paintCallButtons();
}

async function startCall(otherId, name) {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/start_call', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ target: otherId })
  });
  const call = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!res.ok || !call || !call.id) { alert((res.data && res.data.message) || 'Could not start call. Run the call SQL.'); return; }
  callState.call = call;
  callState.otherId = otherId;
  await attachMedia();
  paintCallButtons();
  const pc = await ensurePC();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal('offer', offer);
  startRing();
  showPane('voicePane', 'Call · ' + name);
  $('voiceTitle').textContent = 'Calling ' + name + '…';
}

async function acceptCall(call) {
  await request(SUPABASE_URL + '/rest/v1/rpc/answer_call', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: call.id })
  });
  callState.call = call;
  callState.otherId = call.caller === me.id ? call.callee : call.caller;
  await attachMedia();
  paintCallButtons();
  await ensurePC();
  stopRing();
  $('incoming').hidden = true;
  showPane('voicePane', 'Call');
  $('voiceTitle').textContent = 'Connecting…';
}

async function hangUp() {
  if (callState.call) {
    await request(SUPABASE_URL + '/rest/v1/rpc/end_call', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.call.id })
    });
  }
  stopRing();
  playHangupTone();
  if (callState.pc) { try { callState.pc.close(); } catch (_) {} }
  if (callState.stream) callState.stream.getTracks().forEach((tr) => tr.stop());
  if (remoteAudioCtx) { try { remoteAudioCtx.close(); } catch (_) {} remoteAudioCtx = null; remoteGain = null; }
  callState = { pc: null, stream: null, call: null, otherId: null, incoming: null, seenSignals: new Set(), muted: false, camOff: false };
  $('incoming').hidden = true;
  if ($('remoteVid')) $('remoteVid').srcObject = null;
  if ($('localVid')) $('localVid').srcObject = null;
  if (voice.stream) voice.stream.getTracks().forEach((tr) => tr.stop());
  voice.stream = null;
  if (activeServer) openServer(activeServer);
  else showPane('friendsPane', 'Friends');
}

$('callBtn').onclick = () => {
  if (!current) return;
  const otherId = current.user_a === me.id ? current.user_b : current.user_a;
  startCall(otherId, $('title').textContent);
};
$('acceptCall').onclick = () => { if (callState.incoming) acceptCall(callState.incoming); };
$('declineCall').onclick = async () => {
  if (callState.incoming) {
    await request(SUPABASE_URL + '/rest/v1/rpc/end_call', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.incoming.id })
    });
  }
  if (callState.incoming) {
    const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
    dismissed.push(callState.incoming.id);
    sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(dismissed.slice(-20)));
  }
  callState.incoming = null;
  stopRing();
  $('incoming').hidden = true;
};
$('leaveVoiceBtn').onclick = async () => {
  if (callState.call) { hangUp(); return; }
  if (voice.stream) voice.stream.getTracks().forEach((tr) => tr.stop());
  voice.stream = null;
  if (voice.channel) {
    await request(SUPABASE_URL + '/rest/v1/rpc/leave_voice', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: voice.channel.id })
    });
  }
  voice.channel = null;
  if (activeServer) openServer(activeServer);
  else showPane('friendsPane', 'Friends');
};

async function pullSignals() {
  if (!callState.call) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/pull_signals', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.call.id })
  }, 4000);
  const list = Array.isArray(res.data) ? res.data : [];
  const pc = await ensurePC();
  for (const sig of list) {
    const key = String(sig.id);
    if (callState.seenSignals.has(key)) continue;
    callState.seenSignals.add(key);
    if (sig.from_id === me.id) continue;
    try {
      let payload = sig.payload;
      if (typeof payload === 'string') payload = JSON.parse(payload);
      if (sig.kind === 'offer' && payload && payload.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal('answer', answer);
        stopRing();
        $('voiceTitle').textContent = 'In call';
      } else if (sig.kind === 'answer' && payload && payload.sdp) {
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(new RTCSessionDescription(payload));
        stopRing();
        $('voiceTitle').textContent = 'In call';
      } else if (sig.kind === 'ice' && payload) {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      }
    } catch (err) {
      console.warn(err);
    }
  }
}

async function pollCalls() {
  if (!me) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/my_calls', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  }, 4000);
  const list = Array.isArray(res.data) ? res.data : [];
  const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
  const ringing = list.find((c) => c.status === 'ringing' && c.callee === me.id && !dismissed.includes(c.id));
  if (ringing && !callState.call) {
    const wasHidden = $('incoming').hidden;
    callState.incoming = ringing;
    $('incomingText').textContent = 'Incoming call';
    $('incoming').hidden = false;
    if (wasHidden) {
      startRing();
      notifyCall('Incoming Mokio call');
    }
  } else if (!callState.call) {
    $('incoming').hidden = true;
  }
  if (callState.call) {
    const live = list.find((c) => c.id === callState.call.id);
    if (live && live.status === 'ended' && callState.pc && callState.pc.connectionState !== 'new') hangUp();
  }
}

setInterval(refreshMessages, 600);
setInterval(pollCalls, 1000);
setInterval(pullSignals, 500);
setInterval(() => { if (voice.channel) refreshVoicePeople(); }, 2500);

boot();
