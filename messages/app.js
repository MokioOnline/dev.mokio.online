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
let cachedServers = [];
let groupState = { room: null, server: null, textCh: null, voiceCh: null, peers: {}, seen: new Set(), incoming: null, startedAt: 0, timer: null };
const SIG_PREFIX = '⟦mokio-call⟧';
const RING_LIMIT_MS = 15000;
const groupLive = {};
let ringLimitTimer = null;
let outgoingRingTimer = null;
const remoteMix = { ctx: null, gain: null, limiter: null, sources: new Map() };

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
function setOpen(el, on) {
  if (!el) return;
  el.classList.toggle('is-open', !!on);
  el.hidden = !on;
  if (on) el.removeAttribute('hidden');
}
function showIncoming(on, text, sub) {
  const box = $('incoming');
  if (!box) return;
  box.hidden = !on;
  if (on) box.removeAttribute('hidden');
  if (text && $('incomingText')) $('incomingText').textContent = text;
  if ($('incomingSub')) $('incomingSub').textContent = sub || (groupState.incoming ? 'Group call' : 'Mokio call');
}
function callIsLive() {
  return !!(callState.call || groupState.room);
}
function liveGroupFor(sv) {
  if (!sv) return null;
  const live = groupLive[sv.id];
  if (!live) return null;
  if (live.ended) return null;
  if (live.members && live.members.size === 0 && Date.now() - (live.lastAt || 0) > 8000) return null;
  return live;
}
function updateCallButtons() {
  const onVoice = $('voicePane') && !$('voicePane').hidden;
  const groupChat = !onVoice && !!(activeServer && currentChannel && $('chatPane') && !$('chatPane').hidden);
  const dmChat = !onVoice && !!(current && !currentChannel && $('chatPane') && !$('chatPane').hidden);
  const live = activeServer && liveGroupFor(activeServer);
  const inThisGroupCall = !!(groupState.room && activeServer && groupState.room === activeServer.id);
  if ($('joinCallBtn')) {
    $('joinCallBtn').hidden = !(groupChat && live && !inThisGroupCall && !callState.call);
  }
  if ($('callBtn')) {
    $('callBtn').hidden = !((dmChat && !callState.call) || (groupChat && !live && !inThisGroupCall));
    $('callBtn').textContent = 'Call';
  }
  if ($('groupBar')) $('groupBar').hidden = !(groupChat);
  updateCallDock();
}
function updateCallDock() {
  const dock = $('callDock');
  if (!dock) return;
  const live = callIsLive();
  const onVoice = $('voicePane') && !$('voicePane').hidden;
  dock.hidden = !(live && !onVoice);
  if (dock.hidden) return;
  const who = groupState.room
    ? ((groupState.server && groupState.server.name) || 'group call')
    : (callState.otherName || 'call');
  if ($('callDockText')) $('callDockText').textContent = groupState.room ? ('Return to ' + who) : ('Return to call with ' + who);
}
function returnToCall() {
  if (!callIsLive()) return;
  const title = groupState.server ? groupState.server.name : (callState.otherName ? ('Call · ' + callState.otherName) : 'Call');
  showPane('voicePane', title);
}
function showPane(name, title) {
  const panes = ['friendsPane', 'notesPane', 'settingsPane', 'appSettingsPane', 'chatPane', 'voicePane'];
  panes.forEach((id) => setOpen($(id), id === name));
  if (title && $('title')) $('title').textContent = title;
  updateCallButtons();
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
  showIncoming(false);
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
  if (notePrefs().sound === false) {
    armRingLimit();
    return;
  }
  const audio = new Audio('ring.mp3');
  audio.loop = true;
  audio.volume = 0.55;
  audio.play().catch(() => {});
  ringCtx = audio;
  armRingLimit();
}
function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
  if (ringLimitTimer) { clearTimeout(ringLimitTimer); ringLimitTimer = null; }
  if (ringCtx && ringCtx.pause) { try { ringCtx.pause(); ringCtx.src = ''; } catch (_) {} }
  ringCtx = null;
}
function armRingLimit() {
  if (ringLimitTimer) clearTimeout(ringLimitTimer);
  ringLimitTimer = setTimeout(() => expireIncomingRing(), RING_LIMIT_MS);
}
function clearOutgoingRingTimer() {
  if (outgoingRingTimer) { clearTimeout(outgoingRingTimer); outgoingRingTimer = null; }
}
async function expireIncomingRing() {
  stopRing();
  if (groupState.incoming && !groupState.room) {
    const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
    dismissed.push('g:' + groupState.incoming.room);
    sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(dismissed.slice(-20)));
    groupState.incoming = null;
    showIncoming(false);
    updateCallButtons();
    return;
  }
  if (callState.incoming && !callState.call) {
    try {
      await request(SUPABASE_URL + '/rest/v1/rpc/end_call', {
        method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.incoming.id })
      });
    } catch (_) {}
    const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
    dismissed.push(callState.incoming.id);
    sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(dismissed.slice(-20)));
    callState.incoming = null;
    showIncoming(false);
    return;
  }
  if (callState.call && callState.pc && !['connected', 'completed'].includes(callState.pc.connectionState)) {
    setCallChrome(callState.otherName || 'Call', 'On a call', 'No answer');
    hangUp();
  }
}
function noiseOn() {
  return localStorage.getItem('mokio_ns') !== '0';
}
function audioConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: noiseOn(),
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000
  };
}

function mediaConstraints(wantVideo) {
  return {
    audio: audioConstraints(),
    video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } } : false
  };
}

function volPct() {
  const raw = Math.max(0, Number($('volSlider')?.value) || 170) / 100;
  return raw * 2.1;
}

async function resumeRemoteAudio() {
  if (remoteMix.ctx && remoteMix.ctx.state === 'suspended') {
    try { await remoteMix.ctx.resume(); } catch (_) {}
  }
}

function ensureMix() {
  if (!remoteMix.ctx || remoteMix.ctx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    remoteMix.ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 });
    remoteMix.gain = remoteMix.ctx.createGain();
    remoteMix.limiter = remoteMix.ctx.createDynamicsCompressor();
    remoteMix.limiter.threshold.value = -24;
    remoteMix.limiter.knee.value = 18;
    remoteMix.limiter.ratio.value = 2.4;
    remoteMix.limiter.attack.value = 0.01;
    remoteMix.limiter.release.value = 0.18;
    remoteMix.make = remoteMix.ctx.createGain();
    remoteMix.make.gain.value = 1.55;
    remoteMix.gain.gain.value = volPct();
    remoteMix.gain.connect(remoteMix.limiter);
    remoteMix.limiter.connect(remoteMix.make);
    remoteMix.make.connect(remoteMix.ctx.destination);
    remoteMix.sources = new Map();
  }
  resumeRemoteAudio();
  return remoteMix;
}

function unhookRemote(id) {
  const src = remoteMix.sources.get(id);
  if (src) { try { src.disconnect(); } catch (_) {} remoteMix.sources.delete(id); }
}

function closeRemoteMix() {
  remoteMix.sources.forEach((src) => { try { src.disconnect(); } catch (_) {} });
  remoteMix.sources.clear();
  if (remoteMix.ctx) { try { remoteMix.ctx.close(); } catch (_) {} }
  remoteMix.ctx = remoteMix.gain = remoteMix.limiter = null;
}

function hookRemoteVolume(videoEl, peerId) {
  if (!videoEl || !videoEl.srcObject) return;
  const stream = videoEl.srcObject;
  const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
  const level = volPct();
  const playEl = () => { try { videoEl.play().catch(() => {}); } catch (_) {} };
  const id = peerId || videoEl.id || 'default';
  if (!audioTracks.length) {
    videoEl.muted = false;
    videoEl.volume = Math.min(1, level);
    playEl();
    return;
  }
  try {
    ensureMix();
    if (remoteMix.gain) remoteMix.gain.gain.value = level;
    if (!remoteMix.sources.has(id)) {
      const src = remoteMix.ctx.createMediaStreamSource(stream);
      src.connect(remoteMix.gain);
      remoteMix.sources.set(id, src);
    }
    videoEl.muted = true;
    videoEl.volume = 0;
    playEl();
  } catch (_) {
    videoEl.muted = false;
    videoEl.volume = Math.min(1, level);
    playEl();
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
  if ($('serverList')) $('serverList').hidden = true;
  $('midTitle').textContent = 'Direct messages';
  markListSelection();
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

async function createGroup(name) {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/create_server', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ sname: name })
  });
  if (!res.ok) { alert((res.data && res.data.message) || 'Could not create group.'); return null; }
  let created = Array.isArray(res.data) ? res.data[0] : res.data;
  await loadServers();
  if (!created || !created.id) created = cachedServers.find((s) => s.name === name) || cachedServers[0];
  if (created) {
    await ensureGroupChannels(created);
    rememberRoster(created.id, me.id, me.displayName || me.username || 'You');
  }
  return created;
}

$('newServerBtn').onclick = async () => {
  const name = prompt('Group name');
  if (!name) return;
  const created = await createGroup(name);
  if (created) openGroup(created);
};
if ($('newGroupBtn')) $('newGroupBtn').onclick = $('newServerBtn').onclick;

function rosterKey(sid) { return 'mokio_roster_' + sid; }
function readRoster(sid) {
  try { return JSON.parse(localStorage.getItem(rosterKey(sid)) || '{}'); } catch (_) { return {}; }
}
function rememberRoster(sid, uid, name) {
  if (!sid || !uid) return;
  const map = readRoster(sid);
  map[uid] = name || map[uid] || uid;
  localStorage.setItem(rosterKey(sid), JSON.stringify(map));
}

async function loadServers() {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/my_servers', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  });
  cachedServers = Array.isArray(res.data) ? res.data : [];
  const box = $('servers');
  if (box) box.innerHTML = '';
  const glist = $('groupList');
  if (glist) glist.innerHTML = '';
  cachedServers.forEach((sv) => {
    if (glist) {
      const row = document.createElement('button');
      row.className = 'mid-item group';
      row.dataset.gid = sv.id;
      row.innerHTML = '<span class="group-orb">' + String(sv.name || 'G').slice(0, 1).toUpperCase() + '</span><span>' + String(sv.name || 'Group').replace(/</g, '&lt;') + '</span>';
      row.onclick = () => openGroup(sv);
      glist.appendChild(row);
    }
  });
  markListSelection();
}

function markListSelection() {
  document.querySelectorAll('#groupList .mid-item, #convos .mid-item').forEach((el) => {
    const on = activeServer && el.dataset.gid === String(activeServer.id);
    el.classList.toggle('on', !!on);
  });
}

const channelCache = {};
async function serverChannels(sv) {
  const sid = sv.id || sv;
  const hit = channelCache[sid];
  if (hit && Date.now() - hit.at < 10000) return hit.list;
  const ch = await request(SUPABASE_URL + '/rest/v1/rpc/server_channels', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ sid })
  });
  const list = Array.isArray(ch.data) ? ch.data : [];
  channelCache[sid] = { at: Date.now(), list };
  return list;
}

async function ensureGroupChannels(sv) {
  let list = await serverChannels(sv);
  if (!list.find((c) => c.kind === 'text')) {
    await request(SUPABASE_URL + '/rest/v1/rpc/add_channel', {
      method: 'POST', headers: headers(session.access_token),
      body: JSON.stringify({ sid: sv.id, cname: 'chat', ckind: 'text' })
    });
  }
  if (!list.find((c) => c.kind === 'voice')) {
    await request(SUPABASE_URL + '/rest/v1/rpc/add_channel', {
      method: 'POST', headers: headers(session.access_token),
      body: JSON.stringify({ sid: sv.id, cname: 'Group call', ckind: 'voice' })
    });
  }
  delete channelCache[sv.id];
  return serverChannels(sv);
}

async function openGroup(sv) {
  activeServer = sv;
  current = null;
  $('dmList').hidden = false;
  if ($('serverList')) $('serverList').hidden = true;
  $('midTitle').textContent = 'Direct messages';
  markListSelection();
  const list = await ensureGroupChannels(sv);
  const firstText = list.find((c) => c.kind === 'text');
  if (firstText) await openChannel(firstText);
  await paintGroupMembers(sv, firstText);
}
function openServer(sv) { return openGroup(sv); }

async function paintGroupMembers(sv, textCh) {
  const names = readRoster(sv.id);
  if (textCh) {
    const msgs = await request(SUPABASE_URL + '/rest/v1/rpc/channel_messages', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: textCh.id })
    }, 4000);
    (Array.isArray(msgs.data) ? msgs.data : []).forEach((m) => {
      if (m.sender_id) names[m.sender_id] = names[m.sender_id] || 'Member';
    });
  }
  names[me.id] = me.displayName || me.username || 'You';
  const labels = [];
  for (const uid of Object.keys(names)) {
    let label = names[uid];
    if (uid !== me.id && (label === 'Member' || label === uid)) {
      const person = await findId(uid);
      label = person?.username ? '@' + person.username : (person?.email || label);
      rememberRoster(sv.id, uid, label);
    }
    labels.push(uid === me.id ? 'You' : label);
  }
  if ($('groupBarPeople')) {
    $('groupBarPeople').textContent = labels.length ? ('With ' + labels.join(', ')) : 'Private group';
  }
}

if ($('inviteForm')) $('inviteForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!activeServer) return;
  const handle = e.target.handle.value.trim().toLowerCase().replace(/^@/, '');
  const other = await findHandle(handle);
  if (!other?.id) { alert('No user found'); return; }
  const invited = await request(SUPABASE_URL + '/rest/v1/rpc/invite_member', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sid: activeServer.id, uid: other.id })
  });
  if (!invited.ok) { alert((invited.data && invited.data.message) || 'Could not add that person.'); return; }
  rememberRoster(activeServer.id, other.id, other.username ? '@' + other.username : (other.email || handle));
  e.target.reset();
  await paintGroupMembers(activeServer, currentChannel && currentChannel.kind !== 'voice' ? currentChannel : null);
};

async function openChannel(ch) {
  current = null;
  currentChannel = ch;
  lastThreadKey = '';
  showPane('chatPane', activeServer ? activeServer.name : ch.name);
  await refreshMessages();
}

async function joinVoice(ch) {
  currentChannel = ch; current = null;
  showPane('voicePane', 'Voice · ' + ch.name);
  $('voiceTitle').textContent = 'Voice · ' + ch.name;
  try { voice.stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(true)); }
  catch { voice.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() }).catch(() => null); }
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
    if ($('nsToggle')) $('nsToggle').checked = noiseOn();
  };
  $('moreMenu').onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => { if ($('moreMenu')) $('moreMenu').hidden = true; });
}
let nsEngine = { ctx: null, src: null, node: null, dest: null };

function stopNsEngine() {
  try { if (nsEngine.src) nsEngine.src.disconnect(); } catch (_) {}
  try { if (nsEngine.node) nsEngine.node.disconnect(); } catch (_) {}
  if (nsEngine.ctx && nsEngine.ctx.state !== 'closed') {
    try { nsEngine.ctx.close(); } catch (_) {}
  }
  nsEngine = { ctx: null, src: null, node: null, dest: null };
}

async function enhanceMicStream(raw) {
  if (!raw) return raw;
  stopNsEngine();
  const audioTracks = raw.getAudioTracks();
  const videoTracks = raw.getVideoTracks();
  const mix = new MediaStream();
  videoTracks.forEach((t) => mix.addTrack(t));
  if (!audioTracks.length) return mix;
  audioTracks.forEach((t) => { try { t.contentHint = 'speech'; } catch (_) {} });
  if (!noiseOn()) {
    audioTracks.forEach((t) => mix.addTrack(t));
    return mix;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('ns-processor.js');
    const src = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
    const node = new AudioWorkletNode(ctx, 'mokio-denoise', { outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    src.connect(node);
    node.connect(dest);
    nsEngine = { ctx, src, node, dest };
    dest.stream.getAudioTracks().forEach((t) => {
      try { t.contentHint = 'speech'; } catch (_) {}
      mix.addTrack(t);
    });
    return mix;
  } catch (err) {
    console.warn(err);
    audioTracks.forEach((t) => mix.addTrack(t));
    return mix;
  }
}

async function publishLocalAudio(stream) {
  const track = stream && stream.getAudioTracks()[0];
  if (!track) return;
  const pcs = [];
  if (callState.pc) pcs.push(callState.pc);
  Object.keys(groupState.peers || {}).forEach((id) => {
    if (groupState.peers[id] && groupState.peers[id].pc) pcs.push(groupState.peers[id].pc);
  });
  for (const pc of pcs) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender) { try { await sender.replaceTrack(track); } catch (_) {} }
  }
}

async function applyNoiseSuppression(on) {
  localStorage.setItem('mokio_ns', on ? '1' : '0');
  const raw = callState.rawStream || voice.rawStream || activeStream();
  if (!raw) return;
  const enhanced = await enhanceMicStream(raw);
  if (callState.rawStream || callState.stream) callState.stream = enhanced;
  if (voice.stream) voice.stream = enhanced;
  await publishLocalAudio(enhanced);
  showLocalVideo();
}
if ($('nsToggle')) {
  $('nsToggle').checked = noiseOn();
  $('nsToggle').onchange = () => applyNoiseSuppression($('nsToggle').checked);
}
if ($('volSlider')) {
  $('volSlider').oninput = () => {
    const pct = Number($('volSlider').value);
    $('volLabel').textContent = String(pct);
    if (remoteMix.gain && remoteMix.ctx && remoteMix.ctx.state !== 'closed') {
      remoteMix.gain.gain.value = pct / 100;
      resumeRemoteAudio();
    }
    document.querySelectorAll('#videos video').forEach((vid) => {
      if (vid.id === 'localVid') return;
      vid.volume = Math.min(1, pct / 100);
    });
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
    card.innerHTML = '<div class="friend-row"><div class="avatar">' + initial(name) + '</div><div class="copy"><div>' + name + '</div><div class="sub">Friend</div></div><div class="friend-actions"><button class="send" type="button">Message</button><button class="ghost" type="button">Call</button></div></div>';
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
  activeServer = null;
  currentChannel = null;
  markListSelection();
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
    if (isCallSignal(msg.body)) return;
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

function tuneAudioSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return sdp;
  let out = sdp.replace(/a=fmtp:(\d+) (.*)/g, (line, id, rest) => {
    if (!/opus/i.test(sdp.split('\n').find((l) => l.includes('rtpmap:' + id)) || '')) return line;
    const parts = rest.split(';').map((p) => p.trim()).filter(Boolean);
    const set = (key, val) => {
      const i = parts.findIndex((p) => p.toLowerCase().startsWith(key + '='));
      if (i >= 0) parts[i] = key + '=' + val;
      else parts.push(key + '=' + val);
    };
    set('minptime', '10');
    set('useinbandfec', '1');
    set('stereo', '0');
    set('sprop-stereo', '0');
    set('maxaveragebitrate', '64000');
    set('maxplaybackrate', '48000');
    return 'a=fmtp:' + id + ' ' + parts.join(';');
  });
  if (!/useinbandfec=1/.test(out)) {
    out = out.replace(/(a=rtpmap:(\d+) opus\/48000\/2.*\r?\n)/gi, (line, _all, id) => {
      return line + 'a=fmtp:' + id + ' minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=64000;maxplaybackrate=48000\r\n';
    });
  }
  return out;
}

async function tuneAudioSender(pc) {
  if (!pc) return;
  try {
    const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('audio');
    if (caps && caps.codecs) {
      const opus = caps.codecs.filter((c) => /opus/i.test(c.mimeType));
      const rest = caps.codecs.filter((c) => !/opus/i.test(c.mimeType) && c.mimeType !== 'audio/CN' && c.mimeType !== 'audio/telephone-event');
      pc.getTransceivers().forEach((t) => {
        if (t.sender && t.sender.track && t.sender.track.kind === 'audio' && t.setCodecPreferences) {
          try { t.setCodecPreferences(opus.concat(rest)); } catch (_) {}
        }
      });
    }
  } catch (_) {}
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 64000;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch (_) {}
  }
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

function layoutCallTiles() {
  const box = $('videos');
  if (!box) return;
  const n = box.querySelectorAll('.tile').length;
  box.className = 'tiles tiles-grid count-' + Math.min(n, 4);
}

function ensureRemoteTile(peerId, name) {
  const box = $('videos');
  if (!box) return null;
  let tile = $('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'tile-' + peerId;
    tile.innerHTML = '<div class="face">' + initial(name || '?') + '</div><video id="vid-' + peerId + '" autoplay playsinline></video><span class="tile-name"></span>';
    box.appendChild(tile);
  }
  const label = tile.querySelector('.tile-name');
  if (label) label.textContent = name || 'Member';
  const face = tile.querySelector('.face');
  if (face) face.textContent = initial(name || '?');
  layoutCallTiles();
  return tile;
}

function removeRemoteTile(peerId) {
  const tile = $('tile-' + peerId);
  if (tile) tile.remove();
  const leftover = $('remoteTile');
  if (leftover && leftover.parentNode) leftover.remove();
  layoutCallTiles();
}

function resetCallTiles() {
  const box = $('videos');
  if (!box) return;
  Array.from(box.querySelectorAll('.tile')).forEach((tile) => {
    if (tile.id !== 'localTile') tile.remove();
  });
  layoutCallTiles();
}

function bindRemoteStream(peerId, name, stream) {
  const tile = ensureRemoteTile(peerId, name);
  const video = $('vid-' + peerId) || (tile && tile.querySelector('video'));
  if (!video) return;
  video.srcObject = stream;
  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().some((t) => t.enabled !== false && t.readyState !== 'ended');
  video.hidden = !hasVideo;
  hookRemoteVolume(video, peerId);
  try { video.play().catch(() => {}); } catch (_) {}
  tile.classList.add('connected');
}

function showLocalVideo() {
  const local = $('localVid');
  const face = $('localFace');
  const stream = activeStream();
  if (local && stream) {
    local.srcObject = stream;
    local.hidden = !stream.getVideoTracks().some((t) => t.enabled);
  }
  if (face) face.textContent = initial(me?.displayName || me?.username || 'You');
  layoutCallTiles();
}

function othersOnCall() {
  if (groupState.room) {
    return Object.keys(groupState.peers).map((id) => groupState.peers[id].name || 'Member');
  }
  if (callState.otherName) return [callState.otherName];
  return [];
}
function updateCallNames() {
  const others = othersOnCall();
  const line = others.length ? ('On call with ' + others.join(', ')) : (groupState.room ? 'Waiting for others to join…' : '');
  if ($('callWith')) $('callWith').textContent = line;
  if ($('voicePeople')) $('voicePeople').textContent = line;
  return line;
}
function setCallChrome(title, kicker, meta) {
  if ($('voiceTitle')) $('voiceTitle').textContent = title || 'Call';
  if ($('voiceKicker')) $('voiceKicker').textContent = kicker || 'Call';
  const who = updateCallNames();
  if ($('voiceMeta')) $('voiceMeta').textContent = meta || who || '';
}

function startCallTimer() {
  stopCallTimer();
  groupState.startedAt = Date.now();
  const tick = () => {
    if (!groupState.startedAt) return;
    const s = Math.floor((Date.now() - groupState.startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const who = updateCallNames();
    const extra = groupState.room ? (Object.keys(groupState.peers).length + 1 + ' in call') : '';
    if ($('voiceMeta')) $('voiceMeta').textContent = (extra ? extra + ' · ' : '') + mm + ':' + ss + (who ? ' · ' + who : '');
  };
  tick();
  groupState.timer = setInterval(tick, 1000);
}
function stopCallTimer() {
  if (groupState.timer) clearInterval(groupState.timer);
  groupState.timer = null;
  groupState.startedAt = 0;
}

async function ensurePC() {
  if (callState.pc) return callState.pc;
  const pc = new RTCPeerConnection(iceServers());
  callState.pc = pc;
  if (callState.stream) callState.stream.getTracks().forEach((tr) => pc.addTrack(tr, callState.stream));
  tuneAudioSender(pc);
  pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal('ice', ev.candidate); };
  pc.ontrack = (ev) => {
    const peerId = callState.otherId || 'remote';
    const name = callState.otherName || ($('title').textContent || 'Them').replace(/^Call · /, '');
    let stream = ev.streams && ev.streams[0];
    if (!stream) {
      const tileVid = $('vid-' + peerId);
      stream = (tileVid && tileVid.srcObject) || new MediaStream();
      if (ev.track && !stream.getTracks().includes(ev.track)) stream.addTrack(ev.track);
    }
    if (ev.track && ev.track.kind === 'audio') ev.track.contentHint = 'speech';
    bindRemoteStream(peerId, name, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      clearOutgoingRingTimer();
      resumeRemoteAudio();
      startCallTimer();
      setCallChrome(callState.otherName || 'In call', 'On a call');
    }
    if (['failed','disconnected','closed'].includes(pc.connectionState) && callState.call) {
      setCallChrome(callState.otherName || 'Call', 'On a call', 'Call ended');
      if (callState.dropTimer) clearTimeout(callState.dropTimer);
      const delay = pc.connectionState === 'disconnected' ? 800 : 0;
      callState.dropTimer = setTimeout(() => {
        if (callState.pc === pc && callState.call) hangUp();
      }, delay);
    }
  };
  return pc;
}

async function attachMedia() {
  let raw = null;
  try { raw = await navigator.mediaDevices.getUserMedia(mediaConstraints(true)); }
  catch {
    try { raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: true }); }
    catch { raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() }).catch(() => null); }
  }
  if (raw) {
    raw.getAudioTracks().forEach((tr) => {
      try { tr.contentHint = 'speech'; } catch (_) {}
      try {
        if (tr.applyConstraints) {
          tr.applyConstraints({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }).catch(() => {});
        }
      } catch (_) {}
    });
  }
  callState.rawStream = raw;
  callState.stream = raw ? await enhanceMicStream(raw) : null;
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
  callState.otherName = name || 'Them';
  await attachMedia();
  paintCallButtons();
  resumeRemoteAudio();
  const pc = await ensurePC();
  await tuneAudioSender(pc);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, voiceActivityDetection: true });
  if (offer.sdp) offer.sdp = tuneAudioSdp(offer.sdp);
  await pc.setLocalDescription(offer);
  await sendSignal('offer', pc.localDescription || offer);
  startRing();
  clearOutgoingRingTimer();
  outgoingRingTimer = setTimeout(() => {
    if (callState.call && callState.pc && !['connected', 'completed'].includes(callState.pc.connectionState)) {
      setCallChrome(callState.otherName || 'Call', 'On a call', 'No answer');
      hangUp();
    }
  }, RING_LIMIT_MS);
  resetCallTiles();
  ensureRemoteTile(otherId, name);
  showPane('voicePane', 'Call · ' + name);
  setCallChrome(name, 'On a call', 'Calling…');
  updateCallNames();
  showLocalVideo();
}

async function acceptCall(call) {
  await request(SUPABASE_URL + '/rest/v1/rpc/answer_call', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: call.id })
  });
  callState.call = call;
  callState.otherId = call.caller === me.id ? call.callee : call.caller;
  callState.otherName = call.caller_name || call.caller_username || call.from_name || 'Them';
  await attachMedia();
  paintCallButtons();
  resumeRemoteAudio();
  const pc = await ensurePC();
  await tuneAudioSender(pc);
  stopRing();
  showIncoming(false);
  resetCallTiles();
  ensureRemoteTile(callState.otherId, callState.otherName);
  showPane('voicePane', 'Call · ' + callState.otherName);
  setCallChrome(callState.otherName, 'On a call', 'Connecting…');
  updateCallNames();
  showLocalVideo();
}

let hangingUp = false;
async function hangUp() {
  if (hangingUp) return;
  hangingUp = true;
  try {
  if (callState.call) {
    await request(SUPABASE_URL + '/rest/v1/rpc/end_call', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.call.id })
    });
  }
  stopRing();
  clearOutgoingRingTimer();
  if (callState.dropTimer) { clearTimeout(callState.dropTimer); callState.dropTimer = null; }
  playHangupTone();
  if (callState.pc) { try { callState.pc.close(); } catch (_) {} }
  stopNsEngine();
  if (callState.rawStream) callState.rawStream.getTracks().forEach((tr) => tr.stop());
  if (callState.stream) callState.stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) {} });
  closeRemoteMix();
  stopCallTimer();
  callState = { pc: null, stream: null, rawStream: null, call: null, otherId: null, otherName: null, incoming: null, incomingAt: null, seenSignals: new Set(), muted: false, camOff: false };
  updateCallDock();
  showIncoming(false);
  resetCallTiles();
  if ($('localVid')) $('localVid').srcObject = null;
  if (voice.stream) voice.stream.getTracks().forEach((tr) => tr.stop());
  voice.stream = null;
  if (groupState.room) { await endGroupCall(false); return; }
  if (activeServer) openServer(activeServer);
  else showPane('friendsPane', 'Friends');
  } finally {
    hangingUp = false;
  }
}

$('callBtn').onclick = () => {
  if (callIsLive() && $('voicePane') && $('voicePane').hidden) { returnToCall(); return; }
  if (activeServer && currentChannel) { startGroupCall(activeServer); return; }
  if (!current) return;
  const otherId = current.user_a === me.id ? current.user_b : current.user_a;
  startCall(otherId, $('title').textContent);
};
if ($('joinCallBtn')) $('joinCallBtn').onclick = () => {
  if (!activeServer) return;
  const live = liveGroupFor(activeServer);
  if (!live) return;
  joinGroupCall({
    room: activeServer.id,
    textChId: live.textChId,
    voiceChId: live.voiceChId,
    from: live.from,
    name: live.name,
    groupName: activeServer.name
  });
};
if ($('callDock')) $('callDock').onclick = returnToCall;
$('acceptCall').onclick = () => {
  if (groupState.incoming) { joinGroupCall(groupState.incoming); return; }
  if (callState.incoming) acceptCall(callState.incoming);
};
$('declineCall').onclick = async () => {
  if (groupState.incoming) {
    const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
    dismissed.push('g:' + groupState.incoming.room);
    sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(dismissed.slice(-20)));
    groupState.incoming = null;
    stopRing();
    showIncoming(false);
    return;
  }
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
  showIncoming(false);
};
$('leaveVoiceBtn').onclick = async () => {
  if (groupState.room) { await endGroupCall(true); return; }
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
        payload.sdp = tuneAudioSdp(payload.sdp);
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        await tuneAudioSender(pc);
        const answer = await pc.createAnswer();
        if (answer.sdp) answer.sdp = tuneAudioSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        await sendSignal('answer', pc.localDescription || answer);
        stopRing();
        resumeRemoteAudio();
        clearOutgoingRingTimer();
        setCallChrome(callState.otherName || 'In call', 'On a call');
        startCallTimer();
      } else if (sig.kind === 'answer' && payload && payload.sdp) {
        payload.sdp = tuneAudioSdp(payload.sdp);
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(new RTCSessionDescription(payload));
        await tuneAudioSender(pc);
        stopRing();
        resumeRemoteAudio();
        clearOutgoingRingTimer();
        setCallChrome(callState.otherName || 'In call', 'On a call');
        startCallTimer();
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
    const started = Date.parse(ringing.created_at || ringing.started_at || '') || callState.incomingAt || Date.now();
    if (Date.now() - started > RING_LIMIT_MS) {
      const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
      if (!dismissed.includes(ringing.id)) {
        dismissed.push(ringing.id);
        sessionStorage.setItem('mokio_dismissed_calls', JSON.stringify(dismissed.slice(-20)));
        request(SUPABASE_URL + '/rest/v1/rpc/end_call', {
          method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: ringing.id })
        }).catch(() => {});
      }
      if (callState.incoming && callState.incoming.id === ringing.id) {
        callState.incoming = null;
        stopRing();
        showIncoming(false);
      }
    } else {
    const wasHidden = !$('incoming') || $('incoming').hidden;
    callState.incoming = ringing;
    if (!callState.incomingAt) callState.incomingAt = started;
    const who = ringing.caller_name || ringing.caller_username || ringing.from_name || 'Incoming call';
    showIncoming(true, who === 'Incoming call' ? 'Incoming call' : who + ' is calling');
    if ($('incomingAv')) $('incomingAv').textContent = String(who).replace('@','').slice(0,1).toUpperCase() || '☎';
    if (wasHidden) {
      startRing();
      notifyCall(who === 'Incoming call' ? 'Incoming Mokio call' : who + ' is calling');
    }
    }
  } else if (!ringing && !callState.call && !groupState.incoming && !groupState.room) {
    callState.incoming = null;
    showIncoming(false);
  }
  if (callState.call) {
    const live = list.find((c) => c.id === callState.call.id);
    if (live && (live.status === 'ended' || live.status === 'missed' || live.status === 'declined')) hangUp();
  }
}

function isCallSignal(body) {
  return String(body || '').startsWith(SIG_PREFIX);
}
function parseCallSignal(body) {
  try { return JSON.parse(String(body).slice(SIG_PREFIX.length)); } catch (_) { return null; }
}
function myName() {
  return me.displayName || me.username || me.email || 'You';
}
async function postGroupSignal(textCh, msg) {
  if (!textCh) return;
  const body = SIG_PREFIX + JSON.stringify(Object.assign({ from: me.id, name: myName(), at: Date.now() }, msg));
  await request(SUPABASE_URL + '/rest/v1/rpc/post_message', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sender_id: me.id, body, conversation_id: null, channel_id: textCh.id })
  }, 4000);
}

async function ensureGroupPeer(peerId, name) {
  if (!peerId || peerId === me.id) return null;
  if (groupState.peers[peerId] && groupState.peers[peerId].pc) {
    groupState.peers[peerId].name = name || groupState.peers[peerId].name;
    return groupState.peers[peerId];
  }
  const stream = activeStream();
  const pc = new RTCPeerConnection(iceServers());
  if (stream) stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
  await tuneAudioSender(pc);
  const peer = { pc, name: name || 'Member', stream: null };
  groupState.peers[peerId] = peer;
  ensureRemoteTile(peerId, peer.name);
  updateCallNames();
  pc.onicecandidate = (ev) => {
    if (ev.candidate) postGroupSignal(groupState.textCh, { t: 'ice', to: peerId, room: groupState.room, payload: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
  };
  pc.ontrack = (ev) => {
    let remoteStream = ev.streams && ev.streams[0];
    if (!remoteStream) {
      remoteStream = peer.stream || new MediaStream();
      if (ev.track && !remoteStream.getTracks().includes(ev.track)) remoteStream.addTrack(ev.track);
    }
    peer.stream = remoteStream;
    bindRemoteStream(peerId, peer.name, remoteStream);
  };
  pc.onconnectionstatechange = () => {
    const tile = $('tile-' + peerId);
    if (tile && pc.connectionState === 'connected') tile.classList.add('connected');
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      unhookRemote('vid-' + peerId);
      unhookRemote(peerId);
      delete groupState.peers[peerId];
      removeRemoteTile(peerId);
      updateCallNames();
      if (groupState.room && !Object.keys(groupState.peers).length) {
        setCallChrome((groupState.server && groupState.server.name) || 'Call', 'Group call', 'Call ended');
        endGroupCall(false);
      }
    }
  };
  return peer;
}

async function offerGroupPeer(peerId) {
  const peer = groupState.peers[peerId];
  if (!peer || !peer.pc) return;
  const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, voiceActivityDetection: true });
  if (offer.sdp) offer.sdp = tuneAudioSdp(offer.sdp);
  await peer.pc.setLocalDescription(offer);
  await postGroupSignal(groupState.textCh, { t: 'offer', to: peerId, room: groupState.room, payload: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } });
}

function trackGroupSignal(sig) {
  const room = sig && sig.room;
  if (!room) return;
  if (!groupLive[room]) groupLive[room] = { members: new Set(), lastAt: Date.now(), startedAt: Date.now(), ended: false };
  const live = groupLive[room];
  live.lastAt = Number(sig.at) || Date.parse(sig.created_at || '') || Date.now();
  if (sig.textChId) live.textChId = sig.textChId;
  if (sig.voiceChId) live.voiceChId = sig.voiceChId;
  if (sig.from) live.from = sig.from;
  if (sig.name) live.name = sig.name;
  if (sig.t === 'ring') {
    live.startedAt = Number(sig.at) || live.lastAt;
    live.ended = false;
    if (sig.from) live.members.add(sig.from);
  } else if (sig.t === 'join') {
    live.ended = false;
    if (sig.from) live.members.add(sig.from);
  } else if (sig.t === 'leave') {
    if (sig.from) live.members.delete(sig.from);
    if (!live.members.size) live.ended = true;
  }
  updateCallButtons();
}

async function handleGroupSignal(sig, msgId) {
  if (!sig || sig.from === me.id) return;
  if (sig.room && groupState.room && sig.room !== groupState.room && sig.t !== 'join' && sig.t !== 'ring') return;
  if (sig.to && sig.to !== me.id && sig.to !== '*') return;
  const key = String(msgId || '') + ':' + sig.t + ':' + sig.from + ':' + (sig.at || '');
  if (groupState.seen.has(key)) return;
  groupState.seen.add(key);
  if (groupState.seen.size > 400) {
    const keep = Array.from(groupState.seen).slice(-200);
    groupState.seen = new Set(keep);
  }
  rememberRoster(sig.room || (activeServer && activeServer.id), sig.from, sig.name);
  trackGroupSignal(sig);

  if ((sig.t === 'ring' || sig.t === 'join') && !groupState.room && !callState.call) {
    const ts = Number(sig.at) || Date.parse(sig.created_at || '') || 0;
    const age = ts ? Date.now() - ts : 0;
    if (age && age > RING_LIMIT_MS) {
      updateCallButtons();
    } else {
      const dismissed = JSON.parse(sessionStorage.getItem('mokio_dismissed_calls') || '[]');
      const room = sig.room;
      if (room && !dismissed.includes('g:' + room) && (!groupState.incoming || groupState.incoming.room !== room)) {
        const sv = cachedServers.find((s) => s.id === room);
        groupState.incoming = { room, textChId: sig.textChId, voiceChId: sig.voiceChId, from: sig.from, name: sig.name, groupName: (sv && sv.name) || 'Group' };
        const wasHidden = !$('incoming') || $('incoming').hidden;
        showIncoming(true, (sig.name || 'Someone') + ' started a group call', (sv && sv.name) || 'Group call');
        if ($('incomingAv')) $('incomingAv').textContent = initial(sig.name || 'G');
        if (wasHidden) {
          startRing();
          notifyCall((sig.name || 'Someone') + ' started a group call');
        }
      }
      updateCallButtons();
    }
  }

  if (!groupState.room) return;
  if (sig.t === 'leave' && sig.from) {
    const peer = groupState.peers[sig.from];
    if (peer && peer.pc) { try { peer.pc.close(); } catch (_) {} }
    delete groupState.peers[sig.from];
    unhookRemote(sig.from);
    removeRemoteTile(sig.from);
    updateCallNames();
    if (!Object.keys(groupState.peers).length) {
      setCallChrome((groupState.server && groupState.server.name) || 'Call', 'Group call', 'Call ended');
      endGroupCall(false);
    }
    return;
  }
  if (sig.t === 'join' && sig.from) {
    const peer = await ensureGroupPeer(sig.from, sig.name);
    if (peer && me.id < sig.from) await offerGroupPeer(sig.from);
    return;
  }
  if (sig.t === 'offer' && sig.payload && sig.payload.sdp) {
    const peer = await ensureGroupPeer(sig.from, sig.name);
    if (!peer) return;
    const desc = { type: sig.payload.type, sdp: tuneAudioSdp(sig.payload.sdp) };
    await peer.pc.setRemoteDescription(new RTCSessionDescription(desc));
    const answer = await peer.pc.createAnswer();
    if (answer.sdp) answer.sdp = tuneAudioSdp(answer.sdp);
    await peer.pc.setLocalDescription(answer);
    await postGroupSignal(groupState.textCh, { t: 'answer', to: sig.from, room: groupState.room, payload: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } });
    return;
  }
  if (sig.t === 'answer' && sig.payload && sig.payload.sdp) {
    const peer = groupState.peers[sig.from];
    if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
      const desc = { type: sig.payload.type, sdp: tuneAudioSdp(sig.payload.sdp) };
      await peer.pc.setRemoteDescription(new RTCSessionDescription(desc));
    }
    return;
  }
  if (sig.t === 'ice' && sig.payload) {
    const peer = groupState.peers[sig.from];
    if (peer && peer.pc) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(sig.payload)); } catch (_) {}
    }
  }
}

async function startGroupCall(sv, voiceCh) {
  if (!sv) return;
  if (callState.call) await hangUp();
  const list = await ensureGroupChannels(sv);
  const textCh = list.find((c) => c.kind === 'text');
  voiceCh = voiceCh || list.find((c) => c.kind === 'voice');
  if (!textCh) { alert('This group needs a private chat channel first.'); return; }
  activeServer = sv;
  current = null;
  currentChannel = textCh;
  await attachMedia();
  voice.stream = callState.stream;
  if (voiceCh) {
    await request(SUPABASE_URL + '/rest/v1/rpc/join_voice', {
      method: 'POST', headers: headers(session.access_token),
      body: JSON.stringify({ cid: voiceCh.id, uname: myName() })
    });
    voice.channel = voiceCh;
  }
  groupState.room = sv.id;
  groupState.server = sv;
  groupState.textCh = textCh;
  groupState.voiceCh = voiceCh || null;
  groupState.incoming = null;
  trackGroupSignal({ t: 'ring', room: sv.id, from: me.id, name: myName(), textChId: textCh.id, voiceChId: voiceCh && voiceCh.id, at: Date.now() });
  resetCallTiles();
  showPane('voicePane', sv.name);
  setCallChrome(sv.name, 'Group call', 'Connecting…');
  updateCallNames();
  showLocalVideo();
  paintCallButtons();
  startCallTimer();
  await postGroupSignal(textCh, { t: 'ring', to: '*', room: sv.id, textChId: textCh.id, voiceChId: voiceCh && voiceCh.id });
  await postGroupSignal(textCh, { t: 'join', to: '*', room: sv.id, textChId: textCh.id, voiceChId: voiceCh && voiceCh.id });
}

async function joinGroupCall(incoming) {
  const sv = cachedServers.find((s) => s.id === incoming.room) || { id: incoming.room, name: incoming.groupName || 'Group' };
  activeServer = cachedServers.find((s) => s.id === incoming.room) || sv;
  stopRing();
  showIncoming(false);
  groupState.incoming = null;
  let voiceCh = null;
  const list = await ensureGroupChannels(sv).catch(() => []);
  const textCh = (list && list.find((c) => c.id === incoming.textChId)) || (list && list.find((c) => c.kind === 'text')) || { id: incoming.textChId };
  voiceCh = (list && list.find((c) => c.id === incoming.voiceChId)) || (list && list.find((c) => c.kind === 'voice')) || (incoming.voiceChId ? { id: incoming.voiceChId } : null);
  if (callState.call) await hangUp();
  current = null;
  currentChannel = textCh;
  await attachMedia();
  voice.stream = callState.stream;
  if (voiceCh && voiceCh.id) {
    await request(SUPABASE_URL + '/rest/v1/rpc/join_voice', {
      method: 'POST', headers: headers(session.access_token),
      body: JSON.stringify({ cid: voiceCh.id, uname: myName() })
    });
    voice.channel = voiceCh;
  }
  groupState.room = sv.id;
  groupState.server = sv;
  groupState.textCh = textCh;
  groupState.voiceCh = voiceCh;
  trackGroupSignal({ t: 'join', room: sv.id, from: me.id, name: myName(), textChId: textCh && textCh.id, voiceChId: voiceCh && voiceCh.id, at: Date.now() });
  resetCallTiles();
  showPane('voicePane', sv.name);
  setCallChrome(sv.name, 'Group call', 'Joining…');
  updateCallNames();
  showLocalVideo();
  paintCallButtons();
  startCallTimer();
  await postGroupSignal(textCh, { t: 'join', to: '*', room: sv.id, textChId: textCh.id, voiceChId: voiceCh && voiceCh.id });
}

let endingGroup = false;
async function endGroupCall(notify) {
  if (endingGroup) return;
  endingGroup = true;
  const sv = groupState.server || activeServer;
  const textCh = groupState.textCh;
  const voiceCh = groupState.voiceCh || voice.channel;
  const roomId = groupState.room;
  if (notify && textCh) await postGroupSignal(textCh, { t: 'leave', to: '*', room: roomId });
  if (roomId) trackGroupSignal({ t: 'leave', room: roomId, from: me.id, at: Date.now() });
  Object.keys(groupState.peers).forEach((id) => {
    try { groupState.peers[id].pc && groupState.peers[id].pc.close(); } catch (_) {}
    unhookRemote(id);
  });
  groupState.peers = {};
  groupState.room = null;
  groupState.server = null;
  groupState.textCh = null;
  groupState.voiceCh = null;
  stopCallTimer();
  stopRing();
  closeRemoteMix();
  stopNsEngine();
  if (callState.rawStream) callState.rawStream.getTracks().forEach((tr) => tr.stop());
  if (callState.stream) callState.stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) {} });
  callState.stream = null;
  callState.rawStream = null;
  if (voice.stream) voice.stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) {} });
  voice.stream = null;
  if (voiceCh && voiceCh.id) {
    await request(SUPABASE_URL + '/rest/v1/rpc/leave_voice', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: voiceCh.id })
    });
  }
  voice.channel = null;
  resetCallTiles();
  if ($('localVid')) $('localVid').srcObject = null;
  if (sv) openServer(sv);
  else showPane('friendsPane', 'Friends');
  endingGroup = false;
}

async function refreshVoicePeople() {
  const box = $('voicePeople');
  if (groupState.room || callState.call) {
    updateCallNames();
    return;
  }
  if (!box) return;
  if (!voice.channel) { box.textContent = ''; return; }
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/voice_people', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: voice.channel.id })
  }, 4000);
  const list = Array.isArray(res.data) ? res.data : [];
  box.textContent = list.map((p) => p.uname || p.username || p.name || 'Member').join(' · ');
}

async function pollGroupSignals() {
  if (!me) return;
  const targets = [];
  if (groupState.textCh && groupState.textCh.id) targets.push({ ch: groupState.textCh, serverId: groupState.room });
  if (!groupState.room) {
    for (const sv of cachedServers.slice(0, 8)) {
      try {
        const list = await serverChannels(sv);
        const text = list.find((c) => c.kind === 'text');
        if (text) targets.push({ ch: text, serverId: sv.id });
      } catch (_) {}
    }
  }
  const seenIds = new Set();
  for (const t of targets) {
    if (!t.ch || !t.ch.id || seenIds.has(t.ch.id)) continue;
    seenIds.add(t.ch.id);
    const msgs = await request(SUPABASE_URL + '/rest/v1/rpc/channel_messages', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: t.ch.id })
    }, 4000);
    const list = Array.isArray(msgs.data) ? msgs.data : [];
    const recent = list.slice(-30);
    for (const msg of recent) {
      if (!isCallSignal(msg.body)) continue;
      const sig = parseCallSignal(msg.body);
      if (!sig) continue;
      if (!sig.room) sig.room = t.serverId;
      if (msg.created_at) sig.created_at = msg.created_at;
      try { await handleGroupSignal(sig, msg.id); } catch (err) { console.warn(err); }
    }
  }
}

setInterval(refreshMessages, 600);
setInterval(pollCalls, 1000);
setInterval(pullSignals, 500);
setInterval(() => { if (voice.channel || groupState.room) refreshVoicePeople(); }, 2500);
setInterval(pollGroupSignals, 1200);

boot();
