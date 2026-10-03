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
let groupState = { room: null, server: null, textCh: null, voiceCh: null, peers: {}, seen: new Set(), incoming: null, startedAt: 0, timer: null, hadPeer: false, sid: null, joinRef: null, leaving: false };
const SIG_PREFIX = '⟦mokio-call⟧';
const GROUP_META_PREFIX = '⟦mokio-group⟧';
let selectedFriendId = null;
let pendingGroupPhoto = null;
const RING_LIMIT_MS = 15000;
let soloTimer = 0;
const screenShare = { active: false, starting: false, stream: null, video: null, audio: null, seen: new Set(), timer: 0 };
const remoteScreenAt = {};
// Every call connection has the same four media lines, in this order, so both sides always agree which one is the screen.
const SLOT_ROLES = ['mic', 'cam', 'screenV', 'screenA'];
const SLOT_KINDS = ['audio', 'video', 'video', 'audio'];
const levelMeter = { ctx: null, nodes: new Map(), raf: 0 };
let userMenuEl = null;
let userMenuFor = null;
// Calls between people on strict networks (mobile data, school/work Wi-Fi, some home routers) need a TURN relay.
// Add one here, e.g. { urls: 'turn:your-host:3478', username: '...', credential: '...' }
const TURN_SERVERS = [];
const groupLive = {};
let ringLimitTimer = null;
let outgoingRingTimer = null;
const remoteMix = { ctx: null, limiter: null, sources: new Map(), broken: false, suspect: 0, probeTimer: 0, checkTimer: 0, probeEnergy: 0, lastStats: null };
const VOL_MAX = 300;        // speaker slider limit (%)
const VOL_DEFAULT = 150;    // speaker slider default (%)
const USER_VOL_MAX = 200;   // per-person slider limit (%)
const GAIN_CAP = 5;         // never amplify more than 5x in total
try { remoteMix.broken = localStorage.getItem('mokio_noboost') === '1'; } catch (_) {}

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
  if (!live || live.ended) return null;
  const members = live.members ? live.members.size : 0;
  const age = Date.now() - (live.lastAt || 0);
  if (age > 12000) return null; // heartbeats arrive every 3s while anyone is in the call
  if (members === 0 && age > 8000) return null;
  if (live.hadMultiple && members <= 1 && age > 2000) return null;
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
function savedMicId() { return localStorage.getItem('mokio_mic_id') || ''; }
function savedCamId() { return localStorage.getItem('mokio_cam_id') || ''; }

function rnnoiseCapable() {
  return !nsFailed && !!(window.AudioWorkletNode && (window.AudioContext || window.webkitAudioContext));
}

function audioConstraints(exactId) {
  // When the RNNoise engine is available it does the noise removal, so the browser's own
  // suppressor is left off to avoid double-processing (which sounds muffled/robotic).
  const nativeNs = !!noiseOn() && !rnnoiseCapable();
  const constraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: nativeNs },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 }
  };
  const id = exactId || savedMicId();
  if (id) constraints.deviceId = exactId ? { exact: exactId } : { ideal: id };
  return constraints;
}

function videoConstraints() {
  const constraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 }
  };
  if (savedCamId()) constraints.deviceId = { ideal: savedCamId() };
  return constraints;
}

function mediaConstraints(wantVideo) {
  return {
    audio: audioConstraints(),
    video: wantVideo ? videoConstraints() : false
  };
}

function sliderVol() {
  const el = $('volSlider');
  const v = el ? Number(el.value) : VOL_DEFAULT;
  return Number.isFinite(v) ? Math.min(VOL_MAX, Math.max(0, v)) : VOL_DEFAULT;
}

function userVolGet(id) {
  try {
    const raw = localStorage.getItem('mokio_uvol_' + id);
    const n = raw == null ? 100 : Number(raw);
    return Number.isFinite(n) ? Math.min(USER_VOL_MAX, Math.max(0, n)) : 100;
  } catch (_) { return 100; }
}
function userVolSet(id, pct) {
  try { localStorage.setItem('mokio_uvol_' + id, String(Math.round(pct))); } catch (_) {}
}
// Final loudness for one person = master slider x that person's own slider. Can be above 1 (a boost).
function remoteGainFor(peerId) {
  return Math.min(GAIN_CAP, (sliderVol() / 100) * (userVolGet(peerId) / 100));
}
function remoteVolFor(peerId) {
  return Math.min(1, remoteGainFor(peerId));
}

function volPct() {
  return sliderVol() / 100;
}

async function resumeRemoteAudio() {
  if (remoteMix.ctx && remoteMix.ctx.state === 'suspended') {
    try { await remoteMix.ctx.resume(); } catch (_) {}
  }
}

// Playback above 100% can't be done by an <audio> element (its volume stops at 1), so loud settings go
// element(muted) -> gain -> shared limiter -> speakers. At 100% or below the plain element is used.
function ensureMix() {
  if (remoteMix.broken) return null;
  if (!remoteMix.ctx || remoteMix.ctx.state === 'closed') {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    let ctx = null;
    try { ctx = new Ctx({ latencyHint: 'interactive', sampleRate: 48000 }); }
    catch (_) { try { ctx = new Ctx({ latencyHint: 'interactive' }); } catch (_) { return null; } }
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 3;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    lim.connect(ctx.destination);
    ctx.onstatechange = () => { if (ctx.state === 'running') setAllRemoteVolumes(); };
    remoteMix.ctx = ctx;
    remoteMix.limiter = lim;
    remoteMix.sources = new Map();
  }
  if (remoteMix.ctx.state === 'suspended') remoteMix.ctx.resume().catch(() => {});
  return remoteMix;
}

function disposeBoost(id) {
  const entry = remoteMix.sources.get(id);
  if (!entry) return;
  try { entry.src.disconnect(); } catch (_) {}
  try { entry.gain.disconnect(); } catch (_) {}
  try { entry.an.disconnect(); } catch (_) {}
  remoteMix.sources.delete(id);
}

function unhookRemote(id) { disposeBoost(id); }

// True when this person's audio is now being played through the boost chain (so the element must stay muted).
function setBoost(audio, id, want) {
  const entry = remoteMix.sources.get(id);
  if (want <= 1) {
    if (entry) entry.gain.gain.value = 0;
    return false;
  }
  const mix = ensureMix();
  if (!mix || mix.ctx.state !== 'running') return false; // not allowed to start yet: stay on the plain element
  const stream = audio.srcObject;
  if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return false;
  let e = entry;
  if (e && e.stream !== stream) { disposeBoost(id); e = null; }
  if (!e) {
    try {
      const src = mix.ctx.createMediaStreamSource(stream);
      const gain = mix.ctx.createGain();
      const an = mix.ctx.createAnalyser();
      an.fftSize = 256;
      gain.gain.value = 0;
      src.connect(gain);
      src.connect(an); // listening tap for the self-check below
      gain.connect(mix.limiter);
      e = { src, gain, an, stream, buf: new Uint8Array(an.fftSize) };
      mix.sources.set(id, e);
      startBoostWatch();
    } catch (_) { return false; }
  }
  try { e.gain.gain.setTargetAtTime(want, mix.ctx.currentTime, 0.03); } catch (_) { e.gain.gain.value = want; }
  return true;
}

function applyRemoteVolume(audio, id) {
  if (!audio) return;
  const want = remoteGainFor(id);
  if (setBoost(audio, id, want)) {
    audio.muted = true;
  } else {
    audio.muted = false;
    audio.volume = Math.min(1, want);
  }
}

// Safety net: if the browser ever hands the boost chain silence while the network is clearly delivering speech,
// switch boosting off so nobody is left unable to hear.
function boostProbeCheck(statsDelta, probeEnergy) {
  if (statsDelta > 0.002 && probeEnergy < 0.00001) remoteMix.suspect += 1;
  else if (statsDelta > 0.002) remoteMix.suspect = 0;
  if (remoteMix.suspect >= 2 && !remoteMix.broken) {
    remoteMix.broken = true;
    try { localStorage.setItem('mokio_noboost', '1'); } catch (_) {}
    Array.from(remoteMix.sources.keys()).forEach(disposeBoost);
    setAllRemoteVolumes();
    if (typeof screenNotice === 'function') screenNotice('Volume boost isn\u2019t supported in this browser, so the speaker is limited to 100%.', 9000);
  }
}

async function inboundAudioEnergy() {
  let total = 0;
  let seen = false;
  for (const pc of allPcs()) {
    let report = null;
    try { report = await pc.getStats(); } catch (_) { continue; }
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio') && typeof r.totalAudioEnergy === 'number') { total += r.totalAudioEnergy; seen = true; }
    });
  }
  return seen ? total : null;
}

function startBoostWatch() {
  if (remoteMix.probeTimer || remoteMix.broken) return;
  remoteMix.probeTimer = setInterval(() => {
    remoteMix.sources.forEach((e) => {
      try {
        e.an.getByteTimeDomainData(e.buf);
        let sum = 0;
        for (let i = 0; i < e.buf.length; i++) { const v = (e.buf[i] - 128) / 128; sum += v * v; }
        remoteMix.probeEnergy += sum / e.buf.length;
      } catch (_) {}
    });
  }, 250);
  remoteMix.checkTimer = setInterval(async () => {
    if (!remoteMix.sources.size) return;
    const now = await inboundAudioEnergy();
    if (now == null) { remoteMix.lastStats = null; remoteMix.probeEnergy = 0; return; }
    const prev = remoteMix.lastStats;
    remoteMix.lastStats = now;
    const probe = remoteMix.probeEnergy;
    remoteMix.probeEnergy = 0;
    if (prev != null) boostProbeCheck(now - prev, probe);
  }, 4000);
}

function stopBoostWatch() {
  if (remoteMix.probeTimer) clearInterval(remoteMix.probeTimer);
  if (remoteMix.checkTimer) clearInterval(remoteMix.checkTimer);
  remoteMix.probeTimer = remoteMix.checkTimer = 0;
  remoteMix.probeEnergy = 0;
  remoteMix.lastStats = null;
  remoteMix.suspect = 0;
}

function closeRemoteMix() {
  stopBoostWatch();
  Array.from(remoteMix.sources.keys()).forEach(disposeBoost);
  if (remoteMix.ctx) { try { remoteMix.ctx.close(); } catch (_) {} }
  remoteMix.ctx = remoteMix.limiter = null;
  remoteMix.sources = new Map();
}

function hookRemoteVolume(_videoEl, peerId) {
  const id = peerId || 'remote';
  const audio = ensureRemoteAudio(id);
  const stream = _videoEl && _videoEl.srcObject;
  if (_videoEl) { _videoEl.muted = true; _videoEl.volume = 0; }
  if (!stream) return;
  const tracks = stream.getAudioTracks();
  const current = audio.srcObject;
  const same = current && tracks.length && current.getAudioTracks()[0] === tracks[0];
  if (!same) { disposeBoost(id); audio.srcObject = new MediaStream(tracks); }
  applyRemoteVolume(audio, id);
  playRemote(audio);
  tracks.forEach((tr) => { tr.onunmute = () => playRemote(audio); });
}

function playRemote(audio) {
  if (!audio) return;
  try {
    const pending = audio.play();
    if (pending && pending.catch) pending.catch(() => {});
  } catch (_) {}
}

function ensureRemoteAudio(peerId) {
  const id = 'aud-' + peerId;
  let audio = document.getElementById(id);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = id;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
    document.body.appendChild(audio);
  }
  return audio;
}

function removeRemoteAudio(peerId) {
  disposeBoost(peerId);
  const audio = document.getElementById('aud-' + peerId);
  if (!audio) return;
  try { audio.pause(); audio.srcObject = null; } catch (_) {}
  audio.remove();
}

function setAllRemoteVolumes() {
  document.querySelectorAll('audio[id^="aud-"]').forEach((audio) => {
    if (audio.id === 'aud-unlock') return;
    applyRemoteVolume(audio, audio.id.slice(4));
    playRemote(audio);
  });
}

function unlockCallAudio() {
  ensureMix(); // created inside the click that starts/accepts the call, so the browser lets it run
  const audio = ensureRemoteAudio('unlock');
  audio.muted = true;
  playRemote(audio);
}

function queueOrAddIce(pc, list, init) {
  let cand;
  try { cand = init instanceof RTCIceCandidate ? init : new RTCIceCandidate(init); }
  catch (_) { return; }
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    list.push(cand);
    return;
  }
  pc.addIceCandidate(cand).catch(() => {});
}

async function flushIce(pc, list) {
  if (!pc || !list || !list.length) return;
  const pending = list.splice(0, list.length);
  for (const cand of pending) {
    try { await pc.addIceCandidate(cand); } catch (_) {}
  }
}

function watchConnection(pc, opts) {
  const clear = () => {
    if (pc._recoverTimer) clearTimeout(pc._recoverTimer);
    if (pc._deadTimer) clearTimeout(pc._deadTimer);
    pc._recoverTimer = pc._deadTimer = null;
  };
  const restartOnce = () => {
    if (pc._restarted) return;
    pc._restarted = true;
    try { pc.restartIce(); } catch (_) {}
    if (opts.renegotiate) Promise.resolve(opts.renegotiate()).catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      clear();
      pc._restarted = false;
      if (opts.onConnected) opts.onConnected();
    } else if (pc.connectionState === 'disconnected') {
      if (opts.onStatus) opts.onStatus('disconnected');
    } else if (pc.connectionState === 'failed') {
      if (opts.onStatus) opts.onStatus('failed');
      restartOnce();
      if (pc._deadTimer) clearTimeout(pc._deadTimer);
      pc._deadTimer = setTimeout(() => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (opts.onDead) opts.onDead();
        }
      }, 20000);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      clear();
      if (opts.onConnected) opts.onConnected();
    } else if (pc.iceConnectionState === 'disconnected') {
      if (opts.onStatus) opts.onStatus('disconnected');
    } else if (pc.iceConnectionState === 'failed') {
      if (opts.onStatus) opts.onStatus('failed');
      restartOnce();
    }
  };
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
    writeGroupMeta(created.id, { name: created.name || name, ownerId: me.id });
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
function groupMetaKey(sid) { return 'mokio_group_meta_' + sid; }
function readGroupMeta(sid) {
  try { return JSON.parse(localStorage.getItem(groupMetaKey(sid)) || '{}'); } catch (_) { return {}; }
}
function writeGroupMeta(sid, meta) {
  if (!sid) return;
  const next = Object.assign(readGroupMeta(sid), meta || {});
  localStorage.setItem(groupMetaKey(sid), JSON.stringify(next));
  const sv = cachedServers.find((s) => s.id === sid);
  if (sv) {
    if (next.name) sv.name = next.name;
    if (next.photo) sv.photo = next.photo;
    if (next.color) sv.color = next.color;
    if (next.topic) sv.topic = next.topic;
    if (next.ownerId) sv.ownerId = next.ownerId;
    if (next.deleted) sv.deleted = true;
  }
  if (activeServer && activeServer.id === sid) {
    if (next.name) activeServer.name = next.name;
    if (next.photo) activeServer.photo = next.photo;
    if (next.color) activeServer.color = next.color;
    if (next.topic) activeServer.topic = next.topic;
    if (next.ownerId) activeServer.ownerId = next.ownerId;
    if (next.deleted) activeServer.deleted = true;
  }
  return next;
}
function applyGroupMeta(sv) {
  if (!sv || !sv.id) return sv;
  const meta = readGroupMeta(sv.id);
  if (meta.name) sv.name = meta.name;
  if (meta.photo) sv.photo = meta.photo;
  if (meta.color) sv.color = meta.color;
  if (meta.topic) sv.topic = meta.topic;
  if (meta.ownerId) sv.ownerId = meta.ownerId;
  if (meta.deleted) sv.deleted = true;
  return sv;
}
function groupPrefsKey(sid) { return 'mokio_group_prefs_' + sid; }
function readGroupPrefs(sid) {
  try { return JSON.parse(localStorage.getItem(groupPrefsKey(sid)) || '{}'); } catch (_) { return {}; }
}
function writeGroupPrefs(sid, patch) {
  const next = Object.assign(readGroupPrefs(sid), patch || {});
  localStorage.setItem(groupPrefsKey(sid), JSON.stringify(next));
  return next;
}
function isGroupMeta(body) {
  return String(body || '').startsWith(GROUP_META_PREFIX);
}
function parseGroupMeta(body) {
  try { return JSON.parse(String(body).slice(GROUP_META_PREFIX.length)); } catch (_) { return null; }
}
function paintGroupIcon(el, sv, sizeText) {
  if (!el || !sv) return;
  const name = sv.name || 'Group';
  if (sv.photo) el.innerHTML = '<img alt="" src="' + sv.photo + '">';
  else el.textContent = String(sizeText || name).slice(0, 1).toUpperCase();
}
async function pullGroupMeta(sv, textCh) {
  if (!sv || !textCh) return;
  const msgs = await request(SUPABASE_URL + '/rest/v1/rpc/channel_messages', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: textCh.id })
  }, 4000);
  const list = Array.isArray(msgs.data) ? msgs.data : [];
  let latest = null;
  list.forEach((m) => {
    if (!isGroupMeta(m.body)) return;
    const parsed = parseGroupMeta(m.body);
    if (!parsed) return;
    const at = Number(parsed.at) || Date.parse(m.created_at || '') || 0;
    if (!latest || at >= latest.at) latest = Object.assign({ at }, parsed);
  });
  if (latest) {
    writeGroupMeta(sv.id, { name: latest.name, photo: latest.photo, color: latest.color, topic: latest.topic, ownerId: latest.ownerId, deleted: latest.deleted });
    applyGroupMeta(sv);
    if (latest.deleted) {
      cachedServers = cachedServers.filter((s) => s.id !== sv.id);
      if (activeServer && activeServer.id === sv.id) {
        activeServer = null;
        showPane('friendsPane', 'Friends');
      }
      loadServers();
    }
  }
}
function readRoster(sid) {
  try { return JSON.parse(localStorage.getItem(rosterKey(sid)) || '{}'); } catch (_) { return {}; }
}
function rememberRoster(sid, uid, name) {
  if (!sid || !uid) return;
  const map = readRoster(sid);
  map[uid] = name || map[uid] || uid;
  localStorage.setItem(rosterKey(sid), JSON.stringify(map));
}
const nameCache = {};
let friendsCache = [];
function prettyPerson(person, fallback) {
  if (!person) return fallback || 'Member';
  if (person.display_name) return person.display_name;
  if (person.username) return '@' + person.username;
  return person.email || fallback || 'Member';
}
async function nameFor(uid) {
  if (!uid) return 'Someone';
  if (uid === me.id) return 'You';
  if (nameCache[uid]) return nameCache[uid];
  if (activeServer) {
    const roster = readRoster(activeServer.id);
    if (roster[uid] && roster[uid] !== 'Member' && roster[uid] !== uid) {
      nameCache[uid] = roster[uid];
      return roster[uid];
    }
  }
  const person = await findId(uid);
  const label = prettyPerson(person, 'Member');
  nameCache[uid] = label;
  if (activeServer) rememberRoster(activeServer.id, uid, label);
  return label;
}
async function getFriends() {
  const res = await request(SUPABASE_URL + '/rest/v1/friends?or=(requester.eq.' + me.id + ',addressee.eq.' + me.id + ')&select=*', { headers: headers(session.access_token) });
  const out = [];
  for (const row of res.data || []) {
    const otherId = row.requester === me.id ? row.addressee : row.requester;
    const person = await findId(otherId);
    const name = prettyPerson(person, 'Friend');
    nameCache[otherId] = name;
    out.push({
      id: otherId,
      name,
      username: person?.username || '',
      email: person?.email || '',
      handle: String(person?.username || person?.email || name).toLowerCase()
    });
  }
  friendsCache = out;
  return out;
}

async function loadServers() {
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/my_servers', {
    method: 'POST', headers: headers(session.access_token), body: '{}'
  });
  cachedServers = (Array.isArray(res.data) ? res.data : []).map(applyGroupMeta).filter((sv) => !sv.deleted && !readGroupMeta(sv.id).deleted);
  cachedServers.sort((a, b) => Number(!!readGroupPrefs(b.id).pinned) - Number(!!readGroupPrefs(a.id).pinned));
  const box = $('servers');
  if (box) box.innerHTML = '';
  const glist = $('groupList');
  if (glist) glist.innerHTML = '';
  cachedServers.forEach((sv) => {
    if (glist) {
      const row = document.createElement('button');
      row.className = 'mid-item group';
      row.dataset.gid = sv.id;
      const prefs = readGroupPrefs(sv.id);
      const orb = sv.photo
        ? '<span class="group-orb"><img alt="" src="' + sv.photo + '"></span>'
        : '<span class="group-orb">' + String(sv.name || 'G').slice(0, 1).toUpperCase() + '</span>';
      row.innerHTML = orb + '<span>' + String(sv.name || 'Group').replace(/</g, '&lt;') + '</span>' + (prefs.pinned ? '<span class="pin-mark">Pinned</span>' : '');
      if (sv.color) row.querySelector('.group-orb').style.boxShadow = '0 0 0 2px ' + sv.color;
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
  if (firstText) await pullGroupMeta(sv, firstText);
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
  const members = [];
  for (const uid of Object.keys(names)) {
    let label = names[uid];
    if (uid !== me.id && (label === 'Member' || label === uid)) label = await nameFor(uid);
    else if (uid === me.id) label = 'You';
    members.push({ id: uid, name: label });
  }
  const labels = members.map((m) => m.name);
  applyGroupMeta(sv);
  const prefs = readGroupPrefs(sv.id);
  if ($('groupBarPeople')) $('groupBarPeople').textContent = sv.name || 'Group';
  const bits = [members.length + (members.length === 1 ? ' member' : ' members')];
  if (sv.topic) bits.push(sv.topic);
  else if (labels.length) bits.push(labels.join(', '));
  if (prefs.muted) bits.push('Muted');
  if ($('groupBarCount')) $('groupBarCount').textContent = bits.join(' · ');
  paintGroupIcon($('groupIcon'), sv);
  if ($('groupBar')) $('groupBar').style.boxShadow = sv.color ? ('inset 3px 0 0 ' + sv.color) : '';
  if ($('title') && activeServer && activeServer.id === sv.id) $('title').textContent = sv.name || 'Group';
}

async function inviteUserToGroup(other) {
  if (!activeServer || !other || !other.id) return false;
  if (other.id === me.id) return false;
  const invited = await request(SUPABASE_URL + '/rest/v1/rpc/invite_member', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sid: activeServer.id, uid: other.id })
  });
  if (!invited.ok) { alert((invited.data && invited.data.message) || 'Could not add that person.'); return false; }
  rememberRoster(activeServer.id, other.id, prettyPerson(other, other.name || 'Member'));
  nameCache[other.id] = prettyPerson(other, other.name || 'Member');
  await paintGroupMembers(activeServer, currentChannel && currentChannel.kind !== 'voice' ? currentChannel : null);
  return true;
}

function groupMemberIds() {
  if (!activeServer) return new Set();
  return new Set(Object.keys(readRoster(activeServer.id)).concat([me.id]));
}

function renderFriendPicker(filter) {
  const box = $('friendPickList');
  if (!box) return;
  box.innerHTML = '';
  const q = String(filter || '').trim().toLowerCase().replace(/^@/, '');
  const inGroup = groupMemberIds();
  const rows = friendsCache.filter((f) => {
    if (inGroup.has(f.id)) return false;
    if (!q) return true;
    return f.handle.includes(q) || f.name.toLowerCase().includes(q) || (f.email && f.email.toLowerCase().includes(q));
  });
  if (!rows.length) {
    box.innerHTML = '<p class="sub">' + (friendsCache.some((f) => !inGroup.has(f.id)) ? 'No friends match that search.' : 'Every friend is already in this group.') + '</p>';
    if ($('confirmAddMember')) $('confirmAddMember').disabled = true;
    selectedFriendId = null;
    return;
  }
  rows.forEach((f) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pick-row' + (selectedFriendId === f.id ? ' selected' : '');
    row.innerHTML = '<div class="avatar">' + initial(f.name) + '</div><div class="copy"><div class="name">' + String(f.name).replace(/</g, '&lt;') + '</div><div class="sub">' + (f.username ? '@' + f.username : (f.email || 'Friend')) + '</div></div>';
    row.onclick = () => {
      selectedFriendId = f.id;
      renderFriendPicker($('friendSearch') && $('friendSearch').value);
      if ($('confirmAddMember')) $('confirmAddMember').disabled = false;
    };
    box.appendChild(row);
  });
  if ($('confirmAddMember')) $('confirmAddMember').disabled = !rows.some((f) => f.id === selectedFriendId);
}

async function openAddMemberModal() {
  if (!activeServer) return;
  const modal = $('addMemberModal');
  if (!modal) return;
  selectedFriendId = null;
  if ($('addMemberTitle')) $('addMemberTitle').textContent = 'Add to ' + (activeServer.name || 'group');
  if ($('addMemberSub')) $('addMemberSub').textContent = 'Select a friend, then add them';
  if ($('friendSearch')) $('friendSearch').value = '';
  if ($('confirmAddMember')) $('confirmAddMember').disabled = true;
  modal.hidden = false;
  await getFriends();
  renderFriendPicker('');
}
function closeAddMemberModal() {
  selectedFriendId = null;
  if ($('addMemberModal')) $('addMemberModal').hidden = true;
}
if ($('addMemberBtn')) $('addMemberBtn').onclick = (e) => { e.stopPropagation(); openAddMemberModal(); };
if ($('closeAddMember')) $('closeAddMember').onclick = closeAddMemberModal;
if ($('addMemberModal')) $('addMemberModal').onclick = (e) => { if (e.target.id === 'addMemberModal') closeAddMemberModal(); };
if ($('friendSearch')) $('friendSearch').oninput = () => {
  selectedFriendId = null;
  renderFriendPicker($('friendSearch').value);
};
if ($('confirmAddMember')) $('confirmAddMember').onclick = async () => {
  if (!selectedFriendId) return;
  const friend = friendsCache.find((f) => f.id === selectedFriendId);
  if (!friend) return;
  const ok = await inviteUserToGroup(friend);
  if (ok) {
    selectedFriendId = null;
    renderFriendPicker($('friendSearch') && $('friendSearch').value);
  }
};

function setGroupPhotoPreview(photo, name) {
  const box = $('groupPhotoPreview');
  if (!box) return;
  if (photo) box.innerHTML = '<img alt="" src="' + photo + '">';
  else box.textContent = String(name || 'G').slice(0, 1).toUpperCase();
}
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read photo'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const max = 192;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => reject(new Error('Could not load photo'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function openEditGroupModal() {
  if (!activeServer) return;
  applyGroupMeta(activeServer);
  pendingGroupPhoto = activeServer.photo || readGroupMeta(activeServer.id).photo || null;
  if ($('groupNameInput')) $('groupNameInput').value = activeServer.name || '';
  if ($('groupColorInput')) $('groupColorInput').value = activeServer.color || readGroupMeta(activeServer.id).color || '#7d8cff';
  if ($('groupTopicInput')) $('groupTopicInput').value = activeServer.topic || readGroupMeta(activeServer.id).topic || '';
  if ($('editGroupNote')) $('editGroupNote').textContent = '';
  setGroupPhotoPreview(pendingGroupPhoto, activeServer.name);
  if ($('editGroupModal')) $('editGroupModal').hidden = false;
}
function closeEditGroupModal() {
  if ($('editGroupModal')) $('editGroupModal').hidden = true;
}
async function publishGroupMeta(sv, meta) {
  if (!sv) return;
  writeGroupMeta(sv.id, meta);
  try {
    await request(SUPABASE_URL + '/rest/v1/servers?id=eq.' + sv.id, {
      method: 'PATCH',
      headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
      body: JSON.stringify({ name: meta.name || sv.name })
    });
  } catch (_) {}
  const list = await ensureGroupChannels(sv).catch(() => []);
  const textCh = list.find((c) => c.kind === 'text');
  if (textCh) {
    const body = GROUP_META_PREFIX + JSON.stringify({
      name: meta.name || sv.name,
      photo: meta.photo || '',
      color: meta.color || sv.color || '',
      topic: meta.topic || sv.topic || '',
      ownerId: meta.ownerId || sv.ownerId || readGroupMeta(sv.id).ownerId || '',
      deleted: !!meta.deleted,
      from: me.id,
      at: Date.now()
    });
    await request(SUPABASE_URL + '/rest/v1/rpc/post_message', {
      method: 'POST', headers: headers(session.access_token),
      body: JSON.stringify({ sender_id: me.id, body, conversation_id: null, channel_id: textCh.id })
    }, 8000);
  }
}
if ($('editGroupBtn')) $('editGroupBtn').onclick = (e) => { e.stopPropagation(); openEditGroupModal(); };
if ($('closeEditGroup')) $('closeEditGroup').onclick = closeEditGroupModal;
if ($('editGroupModal')) $('editGroupModal').onclick = (e) => { if (e.target.id === 'editGroupModal') closeEditGroupModal(); };
if ($('groupPhotoPreview')) $('groupPhotoPreview').onclick = () => { if ($('groupPhotoInput')) $('groupPhotoInput').click(); };
if ($('groupPhotoInput')) $('groupPhotoInput').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    pendingGroupPhoto = await compressImageFile(file);
    setGroupPhotoPreview(pendingGroupPhoto, ($('groupNameInput') && $('groupNameInput').value) || 'G');
  } catch (err) {
    if ($('editGroupNote')) $('editGroupNote').textContent = err.message || 'Could not use that photo.';
  }
};
if ($('saveGroupBtn')) $('saveGroupBtn').onclick = async () => {
  if (!activeServer) return;
  const name = (($('groupNameInput') && $('groupNameInput').value) || '').trim().slice(0, 40);
  if (!name) { if ($('editGroupNote')) $('editGroupNote').textContent = 'Enter a group name.'; return; }
  if ($('editGroupNote')) $('editGroupNote').textContent = 'Saving...';
  const meta = {
    name,
    photo: pendingGroupPhoto || readGroupMeta(activeServer.id).photo || '',
    color: ($('groupColorInput') && $('groupColorInput').value) || '',
    topic: (($('groupTopicInput') && $('groupTopicInput').value) || '').trim().slice(0, 80),
    ownerId: activeServer.ownerId || readGroupMeta(activeServer.id).ownerId || me.id
  };
  await publishGroupMeta(activeServer, meta);
  applyGroupMeta(activeServer);
  await loadServers();
  await paintGroupMembers(activeServer, currentChannel && currentChannel.kind !== 'voice' ? currentChannel : null);
  if ($('title')) $('title').textContent = activeServer.name;
  if ($('editGroupNote')) $('editGroupNote').textContent = 'Saved.';
  closeEditGroupModal();
};

async function tryGroupRpc(names, body) {
  for (const name of names) {
    const res = await request(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify(body)
    }).catch(() => ({ ok: false }));
    if (res && res.ok) return res;
  }
  return { ok: false };
}

async function renderGroupMemberManage() {
  const box = $('groupMemberManage');
  if (!box || !activeServer) return;
  box.innerHTML = '';
  const names = readRoster(activeServer.id);
  names[me.id] = names[me.id] || 'You';
  const ownerId = activeServer.ownerId || readGroupMeta(activeServer.id).ownerId;
  for (const uid of Object.keys(names)) {
    const label = uid === me.id ? 'You' : await nameFor(uid);
    const row = document.createElement('div');
    row.className = 'pick-row';
    const role = uid === ownerId ? 'Owner' : (uid === me.id ? 'You' : 'Member');
    row.innerHTML = '<div class="avatar">' + initial(label) + '</div><div class="copy"><div class="name">' + String(label).replace(/</g, '&lt;') + '</div><div class="sub">' + role + '</div></div>';
    if (uid !== me.id) {
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.className = 'kick-btn';
      kickBtn.textContent = 'Kick';
      kickBtn.onclick = () => kickGroupMember(uid, label);
      row.appendChild(kickBtn);
    }
    box.appendChild(row);
  }
}

async function openGroupSettings() {
  if (!activeServer) return;
  const prefs = readGroupPrefs(activeServer.id);
  if ($('groupSettingsSub')) $('groupSettingsSub').textContent = activeServer.name || 'Group';
  if ($('groupMute')) $('groupMute').checked = !!prefs.muted;
  if ($('groupPin')) $('groupPin').checked = !!prefs.pinned;
  if ($('groupNickInput')) $('groupNickInput').value = prefs.nickname || '';
  if ($('groupSettingsNote')) $('groupSettingsNote').textContent = '';
  if ($('groupSettingsModal')) $('groupSettingsModal').hidden = false;
  await renderGroupMemberManage();
}
function closeGroupSettings() {
  if ($('groupSettingsModal')) $('groupSettingsModal').hidden = true;
}

async function kickGroupMember(uid, label) {
  if (!activeServer || !uid) return;
  if (!confirm('Kick ' + (label || 'this member') + ' from the group?')) return;
  await tryGroupRpc(['kick_member', 'remove_member', 'leave_server'], { sid: activeServer.id, uid });
  await request(SUPABASE_URL + '/rest/v1/server_members?server_id=eq.' + activeServer.id + '&user_id=eq.' + uid, {
    method: 'DELETE', headers: headers(session.access_token)
  }).catch(() => {});
  const map = readRoster(activeServer.id);
  delete map[uid];
  localStorage.setItem(rosterKey(activeServer.id), JSON.stringify(map));
  await paintGroupMembers(activeServer, currentChannel && currentChannel.kind !== 'voice' ? currentChannel : null);
  await renderGroupMemberManage();
  if ($('groupSettingsNote')) $('groupSettingsNote').textContent = (label || 'Member') + ' was removed.';
}

async function leaveCurrentGroup() {
  if (!activeServer) return;
  if (!confirm('Leave this group?')) return;
  const sv = activeServer;
  await tryGroupRpc(['leave_server', 'remove_member'], { sid: sv.id, uid: me.id });
  await request(SUPABASE_URL + '/rest/v1/server_members?server_id=eq.' + sv.id + '&user_id=eq.' + me.id, {
    method: 'DELETE', headers: headers(session.access_token)
  }).catch(() => {});
  const map = readRoster(sv.id);
  delete map[me.id];
  localStorage.setItem(rosterKey(sv.id), JSON.stringify(map));
  closeGroupSettings();
  activeServer = null;
  currentChannel = null;
  await loadServers();
  showPane('friendsPane', 'Friends');
}

async function deleteCurrentGroup() {
  if (!activeServer) return;
  if (!confirm('Delete "' + (activeServer.name || 'this group') + '" for everyone?')) return;
  const sv = activeServer;
  await publishGroupMeta(sv, Object.assign(readGroupMeta(sv.id), { deleted: true, name: sv.name }));
  await tryGroupRpc(['delete_server', 'remove_server'], { sid: sv.id });
  await request(SUPABASE_URL + '/rest/v1/servers?id=eq.' + sv.id, {
    method: 'DELETE', headers: headers(session.access_token)
  }).catch(() => {});
  writeGroupMeta(sv.id, { deleted: true });
  closeGroupSettings();
  activeServer = null;
  currentChannel = null;
  await loadServers();
  showPane('friendsPane', 'Friends');
}

if ($('groupSettingsBtn')) $('groupSettingsBtn').onclick = (e) => { e.stopPropagation(); openGroupSettings(); };
if ($('closeGroupSettings')) $('closeGroupSettings').onclick = closeGroupSettings;
if ($('groupSettingsModal')) $('groupSettingsModal').onclick = (e) => { if (e.target.id === 'groupSettingsModal') closeGroupSettings(); };
if ($('saveGroupPrefs')) $('saveGroupPrefs').onclick = async () => {
  if (!activeServer) return;
  writeGroupPrefs(activeServer.id, {
    muted: !!( $('groupMute') && $('groupMute').checked ),
    pinned: !!( $('groupPin') && $('groupPin').checked ),
    nickname: (($('groupNickInput') && $('groupNickInput').value) || '').trim()
  });
  if ($('groupSettingsNote')) $('groupSettingsNote').textContent = 'Preferences saved.';
  await loadServers();
  await paintGroupMembers(activeServer, currentChannel && currentChannel.kind !== 'voice' ? currentChannel : null);
};
if ($('leaveGroupBtn')) $('leaveGroupBtn').onclick = leaveCurrentGroup;
if ($('deleteGroupBtn')) $('deleteGroupBtn').onclick = deleteCurrentGroup;

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
  setOrbText($('localFace'), initial(me.displayName || me.username || 'You'));
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
const ICO_SCREEN = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/><path d="M12 12V8"/><path d="M9.5 10.5L12 8l2.5 2.5"/></svg>';
function paintCallButtons() {
  const stream = activeStream();
  const audioOn = !!(stream && stream.getAudioTracks().some((tr) => tr.enabled));
  const videoOn = !!(stream && stream.getVideoTracks().some((tr) => tr.enabled));
  if ($('muteBtn')) {
    $('muteBtn').innerHTML = audioOn ? ICO_MIC : ICO_MIC_OFF;
    $('muteBtn').title = audioOn ? 'Mute' : 'Unmute';
    $('muteBtn').classList.toggle('off', !audioOn);
  }
  if ($('shareBtn')) {
    const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $('shareBtn').innerHTML = ICO_SCREEN;
    $('shareBtn').disabled = !canShare;
    $('shareBtn').classList.toggle('on', screenShare.active);
    $('shareBtn').title = !canShare ? 'Screen sharing isn\u2019t available on this device' : (screenShare.active ? 'Stop presenting' : 'Present your screen');
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
  const raw = callState.rawStream;
  if (raw) raw.getAudioTracks().forEach((tr) => { tr.enabled = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].enabled : tr.enabled; });
  paintCallButtons();
};
$('camBtn').onclick = () => {
  const stream = activeStream();
  if (!stream) return;
  stream.getVideoTracks().forEach((tr) => { tr.enabled = !tr.enabled; });
  const raw = callState.rawStream;
  if (raw) raw.getVideoTracks().forEach((tr) => { tr.enabled = stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].enabled : tr.enabled; });
  if ($('localVid')) $('localVid').hidden = !stream.getVideoTracks().some((tr) => tr.enabled);
  paintCallButtons();
};

function closeDeviceMenus() {
  if ($('micMenu')) $('micMenu').hidden = true;
  if ($('camMenu')) $('camMenu').hidden = true;
}

async function listMediaDevices(kind) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === kind);
  } catch (_) { return []; }
}

function fillDeviceMenu(menu, devices, selectedId, onPick) {
  if (!menu) return;
  menu.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'dev-label';
  label.textContent = menu.id === 'micMenu' ? 'Microphone' : 'Camera';
  menu.appendChild(label);
  if (!devices.length) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.textContent = 'No devices found';
    empty.disabled = true;
    menu.appendChild(empty);
    return;
  }
  devices.forEach((d, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const name = d.label || ((menu.id === 'micMenu' ? 'Microphone ' : 'Camera ') + (i + 1));
    btn.textContent = name;
    btn.title = name;
    if (d.deviceId && d.deviceId === selectedId) btn.classList.add('active');
    if (!selectedId && i === 0) btn.classList.add('active');
    btn.onclick = (e) => { e.stopPropagation(); onPick(d.deviceId, name); };
    menu.appendChild(btn);
  });
}

async function publishLocalTrack(kind, track) {
  if (!track) return;
  const pcs = [];
  if (callState.pc) pcs.push(callState.pc);
  Object.keys(groupState.peers || {}).forEach((id) => {
    if (groupState.peers[id] && groupState.peers[id].pc) pcs.push(groupState.peers[id].pc);
  });
  for (const pc of pcs) {
    const tx = pcSlot(pc, kind === 'audio' ? 'mic' : 'cam') || pc.getTransceivers().find((t) => t.sender && ((t.sender.track && t.sender.track.kind === kind) || (!t.sender.track && t.receiver && t.receiver.track && t.receiver.track.kind === kind)));
    if (tx) {
      try { await tx.sender.replaceTrack(track); } catch (_) {}
      try { if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv'; } catch (_) {}
    }
  }
}

async function switchInputDevice(kind, deviceId) {
  if (kind === 'audioinput') localStorage.setItem('mokio_mic_id', deviceId || '');
  if (kind === 'videoinput') localStorage.setItem('mokio_cam_id', deviceId || '');
  const raw = callState.rawStream;
  if (!raw) return;
  try {
    if (kind === 'audioinput') {
      let fresh;
      try { fresh = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId || ''), video: false }); }
      catch (_) { fresh = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false }); }
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) return;
      const wasOn = raw.getAudioTracks().every((tr) => tr.enabled);
      raw.getAudioTracks().forEach((tr) => { raw.removeTrack(tr); tr.stop(); });
      newTrack.enabled = wasOn;
      raw.addTrack(newTrack);
      await queueAudioRebuild();
    } else {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints() });
      const newTrack = fresh.getVideoTracks()[0];
      if (!newTrack) return;
      raw.getVideoTracks().forEach((tr) => { raw.removeTrack(tr); tr.stop(); });
      raw.addTrack(newTrack);
      const live = activeStream();
      if (live && live !== raw) {
        live.getVideoTracks().forEach((tr) => live.removeTrack(tr));
        live.addTrack(newTrack);
      }
      await publishLocalTrack('video', newTrack);
      showLocalVideo();
    }
    paintCallButtons();
  } catch (err) {
    console.warn(err);
  }
}

async function openDeviceMenu(kind) {
  const isMic = kind === 'audioinput';
  const menu = $(isMic ? 'micMenu' : 'camMenu');
  const other = $(isMic ? 'camMenu' : 'micMenu');
  if (other) other.hidden = true;
  if ($('moreMenu')) $('moreMenu').hidden = true;
  if (!menu) return;
  if (!menu.hidden) { menu.hidden = true; return; }
  const devices = await listMediaDevices(kind);
  fillDeviceMenu(menu, devices, isMic ? savedMicId() : savedCamId(), async (id) => {
    menu.hidden = true;
    await switchInputDevice(kind, id);
  });
  menu.hidden = false;
}

if ($('micPickBtn')) {
  $('micPickBtn').onclick = (e) => { e.stopPropagation(); openDeviceMenu('audioinput'); };
}
if ($('camPickBtn')) {
  $('camPickBtn').onclick = (e) => { e.stopPropagation(); openDeviceMenu('videoinput'); };
}
if ($('micMenu')) $('micMenu').onclick = (e) => e.stopPropagation();
if ($('camMenu')) $('camMenu').onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeDeviceMenus);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if ($('micMenu') && !$('micMenu').hidden) openDeviceMenu('audioinput');
    if ($('camMenu') && !$('camMenu').hidden) openDeviceMenu('videoinput');
  });
}
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
let pendingRetire = null;
let nsFailed = false;
let nsQueue = Promise.resolve();
const NS_WORKLET_URL = 'rnnoise/NoiseSuppressorWorklet.js';
const NS_WORKLET_NAME = 'NoiseSuppressorWorklet';

function stopNsEngine(engine) {
  const eng = engine || nsEngine;
  try { if (eng.src) eng.src.disconnect(); } catch (_) {}
  try { if (eng.node) eng.node.disconnect(); } catch (_) {}
  if (eng.ctx && eng.ctx.state !== 'closed') {
    try { eng.ctx.close(); } catch (_) {}
  }
  if (!engine || engine === nsEngine) nsEngine = { ctx: null, src: null, node: null, dest: null };
}

function retireNs() {
  if (!pendingRetire) return;
  const old = pendingRetire;
  pendingRetire = null;
  if (old !== nsEngine) stopNsEngine(old);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Mic -> RNNoise worklet -> processed track. Returns null if the browser can't run it.
async function buildNsEngine(audioTrack) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.AudioWorkletNode || !audioTrack) return null;
  // Try a 48 kHz context first (what RNNoise wants); some browsers need the device's own rate.
  for (const rate of [48000, 0]) {
    let ctx = null;
    try {
      ctx = rate ? new Ctx({ latencyHint: 'interactive', sampleRate: rate }) : new Ctx({ latencyHint: 'interactive' });
      await withTimeout(ctx.audioWorklet.addModule(NS_WORKLET_URL), 8000);
      const src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
      const node = new AudioWorkletNode(ctx, NS_WORKLET_NAME, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit'
      });
      const dest = ctx.createMediaStreamDestination();
      try { dest.channelCount = 1; } catch (_) {}
      const engine = { ctx, src, node, dest };
      src.connect(node);
      node.connect(dest);
      if (ctx.state !== 'running') await withTimeout(ctx.resume(), 1500).catch(() => {});
      return engine;
    } catch (err) {
      console.warn('Noise suppression engine unavailable', err);
      if (ctx && ctx.state !== 'closed') { try { ctx.close(); } catch (_) {} }
    }
  }
  return null;
}

function setNativeProcessing(track, noiseSuppression) {
  if (!track || !track.applyConstraints) return Promise.resolve();
  return withTimeout(track.applyConstraints({
    echoCancellation: true,
    noiseSuppression: !!noiseSuppression,
    autoGainControl: true
  }), 1500).catch(() => {});
}

function carryMute(raw, processed) {
  if (!raw || !processed || raw === processed) return;
  const on = raw.getAudioTracks().every((tr) => tr.enabled);
  processed.getAudioTracks().forEach((tr) => { tr.enabled = on; });
}

function queueAudioRebuild() {
  nsQueue = nsQueue.then(() => rebuildLocalAudio()).catch((err) => console.warn(err));
  return nsQueue;
}

// If the worklet dies, never leaves the other person hearing silence: drop back to the browser's own suppressor.
function watchNsEngine(engine) {
  const giveUp = () => {
    if (nsEngine !== engine || nsFailed) return;
    nsFailed = true;
    queueAudioRebuild();
  };
  engine.ctx.onstatechange = () => {
    if (engine.ctx.state === 'suspended') engine.ctx.resume().catch(() => {});
  };
  engine.node.port.onmessage = (ev) => { if (ev.data && ev.data.ready === false) giveUp(); };
  engine.node.onprocessorerror = giveUp;
  setTimeout(() => {
    if (nsEngine !== engine || engine.ctx.state === 'running') return;
    engine.ctx.resume().catch(() => {});
    setTimeout(() => { if (nsEngine === engine && engine.ctx.state !== 'running') giveUp(); }, 2000);
  }, 1500);
}

async function enhanceMicStream(raw) {
  if (!raw) return raw;
  if (nsEngine.ctx) pendingRetire = nsEngine;
  nsEngine = { ctx: null, src: null, node: null, dest: null };
  const rawAudio = raw.getAudioTracks()[0];
  if (!rawAudio) return raw;
  try { rawAudio.contentHint = 'speech'; } catch (_) {}
  const wantNs = !!noiseOn();
  if (wantNs && !nsFailed) {
    await setNativeProcessing(rawAudio, false);
    const engine = await buildNsEngine(rawAudio);
    if (engine) {
      nsEngine = engine;
      watchNsEngine(engine);
      const out = new MediaStream();
      out.addTrack(engine.dest.stream.getAudioTracks()[0]);
      raw.getVideoTracks().forEach((tr) => out.addTrack(tr));
      return out;
    }
    nsFailed = true;
  }
  await setNativeProcessing(rawAudio, wantNs);
  return raw;
}

async function rebuildLocalAudio() {
  const raw = callState.rawStream;
  if (!raw || !raw.getAudioTracks().length) return;
  const enhanced = await enhanceMicStream(raw);
  carryMute(raw, enhanced);
  callState.stream = enhanced;
  if (voice.stream) voice.stream = enhanced;
  await publishLocalTrack('audio', enhanced.getAudioTracks()[0]);
  retireNs();
  showLocalVideo();
  paintCallButtons();
}

async function publishLocalAudio(stream) {
  const track = stream && stream.getAudioTracks()[0];
  if (!track) return;
  await publishLocalTrack('audio', track);
}

async function applyNoiseSuppression(on) {
  localStorage.setItem('mokio_ns', on ? '1' : '0');
  if (!callState.rawStream) return;
  await queueAudioRebuild();
}
if ($('nsToggle')) {
  $('nsToggle').checked = noiseOn();
  $('nsToggle').onchange = () => applyNoiseSuppression($('nsToggle').checked);
}
// Browsers only let audio start after a tap/click; retry on any interaction so nobody is stuck in silence.
['pointerdown', 'touchend', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, () => {
    if (nsEngine.ctx && nsEngine.ctx.state === 'suspended') nsEngine.ctx.resume().catch(() => {});
    if (callState.call || groupState.room) { resumeRemoteAudio(); setAllRemoteVolumes(); }
  }, { passive: true });
});
if ($('volSlider')) {
  let savedVol = null;
  try { savedVol = localStorage.getItem('mokio_vol2'); } catch (_) {}
  $('volSlider').max = String(VOL_MAX);
  $('volSlider').value = String(savedVol != null && Number.isFinite(Number(savedVol)) ? Math.min(VOL_MAX, Math.max(0, Number(savedVol))) : VOL_DEFAULT);
  $('volLabel').textContent = $('volSlider').value + '%';
  $('volSlider').oninput = () => {
    const pct = Number($('volSlider').value);
    $('volLabel').textContent = pct + '%';
    try { localStorage.setItem('mokio_vol2', String(pct)); } catch (_) {}
    resumeRemoteAudio();
    setAllRemoteVolumes();
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
  const box = $('friends');
  box.innerHTML = '';
  const list = await getFriends();
  for (const friend of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="friend-row"><div class="avatar">' + initial(friend.name) + '</div><div class="copy"><div>' + String(friend.name).replace(/</g, '&lt;') + '</div><div class="sub">' + (friend.username ? '@' + friend.username : 'Friend') + '</div></div><div class="friend-actions"><button class="send" type="button">Message</button><button class="ghost" type="button">Call</button></div></div>';
    const buttons = card.querySelectorAll('button');
    buttons[0].onclick = () => openChat(friend.id, friend.name);
    buttons[1].onclick = () => startCall(friend.id, friend.name);
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
function dayKey(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString();
}
function renderThread(list, title, senderNames) {
  const visible = list.filter((m) => !isCallSignal(m.body) && !isGroupMeta(m.body));
  const names = senderNames || {};
  const key = visible.map((m) => m.id + ':' + (m.updated_at || '') + ':' + (m.body || '') + ':' + (names[m.sender_id] || '')).join('|');
  if (key === lastThreadKey) return;
  lastThreadKey = key;
  const thread = $('thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  thread.innerHTML = '';
  let lastDay = '';
  let lastSender = '';
  let lastAt = 0;
  visible.forEach((msg) => {
    const mine = msg.sender_id === me.id;
    const edited = msg.updated_at && msg.created_at && msg.updated_at !== msg.created_at;
    const who = mine ? 'You' : (names[msg.sender_id] || title || 'Member');
    const day = dayKey(msg.created_at);
    if (day && day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      thread.appendChild(sep);
      lastDay = day;
      lastSender = '';
    }
    const ts = Date.parse(msg.created_at || '') || 0;
    const cont = lastSender === msg.sender_id && ts && lastAt && (ts - lastAt) < 5 * 60 * 1000;
    lastSender = msg.sender_id;
    lastAt = ts;
    const row = document.createElement('div');
    row.className = 'row msg-row' + (mine ? ' mine' : '');
    const avatar = (!mine && !cont) ? '<div class="avatar" title="' + String(who).replace(/"/g, '') + '">' + initial(who) + '</div>' : (!mine ? '<div style="width:28px;flex-shrink:0"></div>' : '');
    row.innerHTML = avatar + '<div class="bubble' + (mine ? ' mine' : '') + (cont ? ' cont' : '') + '" data-id="' + msg.id + '"><div class="meta">' + String(who).replace(/</g, '&lt;') + ' · ' + localTime(msg.created_at) + (edited ? ' · edited' : '') + '</div><div class="msg">' + String(msg.body || '').replace(/</g, '&lt;') + '</div>' + (mine ? '<div class="msg-actions"><button type="button" class="ed">Edit</button><button type="button" class="del">Delete</button></div>' : '') + '</div>';
    if (mine) {
      row.querySelector('.ed').onclick = () => editMessage(msg);
      row.querySelector('.del').onclick = () => deleteMessage(msg.id);
    }
    thread.appendChild(row);
  });
  if (!visible.length) {
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
    title = (activeServer && activeServer.name) || currentChannel.name;
    if (activeServer) {
      let latest = null;
      list.forEach((m) => {
        if (!isGroupMeta(m.body)) return;
        const parsed = parseGroupMeta(m.body);
        if (!parsed) return;
        const at = Number(parsed.at) || Date.parse(m.created_at || '') || 0;
        if (!latest || at >= latest.at) latest = Object.assign({ at }, parsed);
      });
      if (latest) {
        const before = (activeServer.name || '') + '|' + (activeServer.photo || '');
        writeGroupMeta(activeServer.id, { name: latest.name, photo: latest.photo, color: latest.color, topic: latest.topic, ownerId: latest.ownerId, deleted: latest.deleted });
        applyGroupMeta(activeServer);
        title = activeServer.name || title;
        const after = (activeServer.name || '') + '|' + (activeServer.photo || '');
        if (before !== after) {
          loadServers();
          paintGroupMembers(activeServer, currentChannel);
        }
      }
    }
  } else if (current) {
    const msgs = await request(SUPABASE_URL + '/rest/v1/messages?conversation_id=eq.' + current.id + '&select=*&order=created_at.asc', { headers: headers(session.access_token) }, 4000);
    list = Array.isArray(msgs.data) ? msgs.data : [];
  } else return;
  const senderNames = {};
  const ids = Array.from(new Set(list.map((m) => m.sender_id).filter(Boolean)));
  for (const id of ids) senderNames[id] = await nameFor(id);
  if (current && !currentChannel) {
    const otherId = current.user_a === me.id ? current.user_b : current.user_a;
    if (otherId) senderNames[otherId] = senderNames[otherId] || title;
  }
  renderThread(list, title, senderNames);
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
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ].concat(TURN_SERVERS), iceCandidatePoolSize: 4 };
}

function tuneAudioSdp(sdp) {
  // Voice stays as-is. Only the 4th media line (shared screen audio) gets stereo and a higher bitrate.
  try {
    const lines = String(sdp || '').split(/\r?\n/);
    const starts = [];
    lines.forEach((l, i) => { if (l.startsWith('m=')) starts.push(i); });
    if (starts.length < 4) return sdp;
    const kinds = starts.map((i) => lines[i].slice(2).split(' ')[0]);
    if (kinds[0] !== 'audio' || kinds[1] !== 'video' || kinds[2] !== 'video' || kinds[3] !== 'audio') return sdp;
    const from = starts[3];
    const to = starts[4] !== undefined ? starts[4] : lines.length;
    let pt = null;
    for (let i = from; i < to; i++) {
      const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(lines[i]);
      if (m) { pt = m[1]; break; }
    }
    if (!pt) return sdp;
    const extra = ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000', 'usedtx=0'];
    let done = false;
    for (let i = from; i < to; i++) {
      if (lines[i].startsWith('a=fmtp:' + pt + ' ')) {
        const add = extra.filter((e) => !lines[i].includes(e.split('=')[0] + '='));
        if (add.length) lines[i] = lines[i].replace(/\s+$/, '') + ';' + add.join(';');
        done = true;
        break;
      }
    }
    if (!done) {
      for (let i = from; i < to; i++) {
        if (lines[i].startsWith('a=rtpmap:' + pt + ' ')) { lines.splice(i + 1, 0, 'a=fmtp:' + pt + ' ' + extra.join(';')); break; }
      }
    }
    return lines.join('\r\n');
  } catch (_) { return sdp; }
}

// Applies the SDP tweak, but falls back to the untouched description if the browser objects.
async function setLocalTuned(pc, desc) {
  const tuned = desc && desc.sdp ? tuneAudioSdp(desc.sdp) : null;
  if (tuned && tuned !== desc.sdp) {
    try { await pc.setLocalDescription({ type: desc.type, sdp: tuned }); return; }
    catch (err) { console.warn('SDP tweak rejected, using the original', err); }
  }
  await pc.setLocalDescription(desc);
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
  const screenAudioTx = pcSlot(pc, 'screenA');
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    if (screenAudioTx && sender === screenAudioTx.sender) continue;
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
  const screens = box.querySelectorAll('.tile.screen-tile').length;
  const n = Math.max(1, box.querySelectorAll('.tile').length - screens);
  box.className = 'tiles tiles-grid count-' + Math.min(n, 4) + (screens ? ' has-screen' : '');
}

const TILE_MORE_HTML = '<button class="tile-more" type="button" title="Options" aria-label="User options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg></button>';

function setOrbText(faceEl, text) {
  const orb = faceEl && faceEl.querySelector('.orb');
  if (orb) orb.textContent = text;
}

function ensureRemoteTile(peerId, name) {
  const box = $('videos');
  if (!box) return null;
  let tile = $('tile-' + peerId);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'tile-' + peerId;
    tile.innerHTML = '<div class="face"><span class="orb-ring"></span><span class="orb">' + initial(name || '?') + '</span></div><video id="vid-' + peerId + '" autoplay playsinline></video><span class="tile-name"></span>' + TILE_MORE_HTML;
    box.appendChild(tile);
  }
  const label = tile.querySelector('.tile-name');
  if (label) label.textContent = name || 'Member';
  setOrbText(tile.querySelector('.face'), initial(name || '?'));
  layoutCallTiles();
  startLevelMeter();
  return tile;
}

function removeRemoteTile(peerId) {
  const tile = $('tile-' + peerId);
  if (tile) tile.remove();
  closeUserMenu();
  const leftover = $('remoteTile');
  if (leftover && leftover.parentNode) leftover.remove();
  removeRemoteAudio(peerId);
  layoutCallTiles();
}

function resetCallTiles() {
  const box = $('videos');
  if (!box) return;
  closeUserMenu();
  Array.from(box.querySelectorAll('.tile')).forEach((tile) => {
    if (tile.id !== 'localTile') tile.remove();
  });
  layoutCallTiles();
}

function addRemoteTrack(stream, track) {
  if (!stream || !track) return stream;
  stream.getTracks().filter((t) => t !== track && t.kind === track.kind).forEach((t) => {
    try { stream.removeTrack(t); } catch (_) {}
  });
  if (!stream.getTracks().includes(track)) stream.addTrack(track);
  return stream;
}

function peerMedia(peerId) {
  if (!callState.remoteStreams) callState.remoteStreams = {};
  if (!callState.remoteStreams[peerId]) callState.remoteStreams[peerId] = new MediaStream();
  return callState.remoteStreams[peerId];
}

function bindRemoteStream(peerId, name, stream) {
  const tile = ensureRemoteTile(peerId, name);
  const video = $('vid-' + peerId) || (tile && tile.querySelector('video'));
  if (!video) return;
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = true;
  video.volume = 0;
  const hasVideo = stream.getVideoTracks && stream.getVideoTracks().some((t) => t.readyState !== 'ended' && t.enabled);
  video.hidden = !hasVideo;
  hookRemoteVolume(video, peerId);
  try { video.play().catch(() => {}); } catch (_) {}
  if (stream.getAudioTracks().length) stopRing();
  tile.classList.add('connected');
}

function showLocalVideo() {
  const local = $('localVid');
  const face = $('localFace');
  const stream = activeStream();
  if (local) {
    local.muted = true;
    local.volume = 0;
    if (stream && local.srcObject !== stream) local.srcObject = stream;
    if (stream) local.hidden = !stream.getVideoTracks().some((t) => t.enabled);
  }
  setOrbText(face, initial(me?.displayName || me?.username || 'You'));
  layoutCallTiles();
  startLevelMeter();
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
  if (groupState.timer) return;
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

async function renegotiateCaller() {
  const pc = callState.pc;
  if (!callState.iAmCaller || !pc || !callState.call) return;
  if (pc.signalingState !== 'stable') return;
  try { pc.restartIce(); } catch (_) {}
  const offer = await pc.createOffer({ iceRestart: true });
  await setLocalTuned(pc, offer);
  await sendSignal('offer', pc.localDescription || offer);
}

function syncLocalSenders(pc) {
  const stream = callState.stream;
  if (!pc || !stream) return;
  stream.getTracks().forEach((track) => {
    if (pc.getSenders().some((s) => s.track === track)) return;
    const tx = pcSlot(pc, track.kind === 'audio' ? 'mic' : 'cam') || pc.getTransceivers().find((t) => t.sender && !t.sender.track && t.receiver && t.receiver.track && t.receiver.track.kind === track.kind && !t.stopped);
    if (tx) {
      tx.sender.replaceTrack(track).catch(() => {});
      try { tx.direction = 'sendrecv'; } catch (_) {}
    } else {
      try { pc.addTrack(track, stream); } catch (_) {}
    }
  });
}

async function ensurePC() {
  if (callState.pc) { syncLocalSenders(callState.pc); return callState.pc; }
  const pc = new RTCPeerConnection(iceServers());
  callState.pc = pc;
  if (!callState.iceQueue) callState.iceQueue = [];
  const onScreen = (on) => setRemoteScreen(callState.otherId || 'remote', callState.otherName || 'Them', on);
  pc._peerId = callState.otherId || 'remote';
  if (callState.iAmCaller) buildOffererSlots(pc, callState.stream, onScreen);
  else buildAnswererSlots(pc, callState.stream, onScreen);
  tuneAudioSender(pc);
  pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal('ice', ev.candidate); };
  pc.ontrack = (ev) => {
    const peerId = callState.otherId || 'remote';
    const name = callState.otherName || ($('title').textContent || 'Them').replace(/^Call · /, '');
    const role = trackRole(pc, ev);
    if (role === 'screenV' || role === 'screenA') {
      addRemoteTrack(peerMedia('s-' + peerId), ev.track);
      watchScreenTrack(peerId, name, ev.track);
      refreshRemoteScreen(peerId);
      return;
    }
    const stream = peerMedia(peerId);
    addRemoteTrack(stream, ev.track);
    if (ev.track && ev.track.kind === 'audio') {
      try { ev.track.contentHint = 'speech'; } catch (_) {}
    }
    bindRemoteStream(peerId, name, stream);
    setCallChrome(name, 'On a call', 'Connected');
  };
  watchConnection(pc, {
    renegotiate: renegotiateCaller,
    onConnected: () => {
      clearOutgoingRingTimer();
      if (screenShare.active) applyScreenToPc(pc);
      setAllRemoteVolumes();
      startCallTimer();
      setCallChrome(callState.otherName || 'In call', 'On a call', 'Connected');
    },
    onStatus: () => setCallChrome(callState.otherName || 'Call', 'On a call', 'Reconnecting…'),
    onDead: () => {
      if (callState.pc === pc && callState.call) hangUp();
    }
  });
  return pc;
}

function micErrorText(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone is blocked. Allow it in your browser\u2019s site settings, then rejoin. Others can\u2019t hear you right now.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Plug one in or pick one with the \u25BE button. Others can\u2019t hear you right now.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Your microphone is in use by another app. Close it and rejoin. Others can\u2019t hear you right now.';
  return 'Couldn\u2019t start your microphone. Others can\u2019t hear you right now.';
}
function showCallNotice(text) {
  const el = $('callNotice');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

async function attachMedia() {
  const token = callState;
  token.mediaReady = false;
  showCallNotice('');
  let raw = null;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    showCallNotice('This page can\u2019t use the microphone (it needs to be opened over https). Others can\u2019t hear you.');
  } else {
    try { raw = await md.getUserMedia({ audio: audioConstraints(), video: false }); }
    catch (firstErr) {
      raw = await md.getUserMedia({ audio: true, video: false }).catch((err) => { showCallNotice(micErrorText(err || firstErr)); return null; });
    }
    if (raw) {
      try {
        const cam = await md.getUserMedia({ audio: false, video: videoConstraints() });
        cam.getVideoTracks().forEach((tr) => raw.addTrack(tr));
      } catch (_) {}
    }
  }
  if (callState !== token) {
    // The call ended while the browser was still asking for the mic.
    if (raw) raw.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) {} });
    return;
  }
  callState.rawStream = raw;
  callState.stream = raw ? await enhanceMicStream(raw) : null;
  retireNs();
  callState.mediaReady = true;
  syncLocalSenders(callState.pc);
  showLocalVideo();
  paintCallButtons();
}

async function startCall(otherId, name) {
  unlockCallAudio();
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/start_call', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ target: otherId })
  });
  const call = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!res.ok || !call || !call.id) { alert((res.data && res.data.message) || 'Could not start call. Run the call SQL.'); return; }
  callState.call = call;
  callState.otherId = otherId;
  callState.otherName = name || 'Them';
  callState.iAmCaller = true;
  callState.iceQueue = [];
  setAllRemoteVolumes();
  await attachMedia();
  if (!callState.call) return;
  paintCallButtons();
  resumeRemoteAudio();
  const pc = await ensurePC();
  await tuneAudioSender(pc);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, voiceActivityDetection: false });
  await setLocalTuned(pc, offer);
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
  unlockCallAudio();
  await request(SUPABASE_URL + '/rest/v1/rpc/answer_call', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: call.id })
  });
  callState.call = call;
  callState.otherId = call.caller === me.id ? call.callee : call.caller;
  callState.otherName = call.caller_name || call.caller_username || call.from_name || 'Them';
  callState.iAmCaller = false;
  callState.iceQueue = [];
  setAllRemoteVolumes();
  await attachMedia();
  if (!callState.call) return;
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
  stopScreenShare(false);
  if (callState.pc) { try { callState.pc.close(); } catch (_) {} }
  stopNsEngine();
  if (callState.rawStream) callState.rawStream.getTracks().forEach((tr) => tr.stop());
  if (callState.stream) callState.stream.getTracks().forEach((tr) => { try { tr.stop(); } catch (_) {} });
  closeRemoteMix();
  document.querySelectorAll('audio[id^="aud-"]').forEach((audio) => {
    try { audio.pause(); audio.srcObject = null; } catch (_) {}
    audio.remove();
  });
  stopCallTimer();
  callState = { pc: null, stream: null, rawStream: null, call: null, otherId: null, otherName: null, incoming: null, incomingAt: null, seenSignals: new Set(), iceQueue: [], remoteStreams: {}, iAmCaller: false, muted: false, camOff: false };
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
  if (activeServer && currentChannel) { enterGroupCall(activeServer); return; }
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

let pullingSignals = false;
async function pullSignals() {
  // Wait until the mic is attached, otherwise the connection is built without your audio track.
  if (pullingSignals || !callState.call || !callState.mediaReady) return;
  pullingSignals = true;
  try { await pullSignalsOnce(); }
  catch (err) { console.warn(err); }
  finally { pullingSignals = false; }
}
async function pullSignalsOnce() {
  if (!callState.call) return;
  const res = await request(SUPABASE_URL + '/rest/v1/rpc/pull_signals', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ cid: callState.call.id })
  }, 4000);
  const list = Array.isArray(res.data) ? res.data : [];
  const pc = await ensurePC();
  if (!callState.iceQueue) callState.iceQueue = [];
  for (const sig of list) {
    const key = String(sig.id);
    if (callState.seenSignals.has(key)) continue;
    if (sig.from_id === me.id) { callState.seenSignals.add(key); continue; }
    try {
      let payload = sig.payload;
      if (typeof payload === 'string') payload = JSON.parse(payload);
      if (sig.kind === 'offer' && payload && payload.sdp) {
        if (pc.signalingState === 'have-local-offer') {
          try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) {}
        }
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        adoptScreenSlots(pc);
        await flushIce(pc, callState.iceQueue);
        await tuneAudioSender(pc);
        if (pc.signalingState === 'have-remote-offer') {
          const answer = await pc.createAnswer();
          await setLocalTuned(pc, answer);
          await sendSignal('answer', pc.localDescription || answer);
        }
        stopRing();
        clearOutgoingRingTimer();
        setAllRemoteVolumes();
        setCallChrome(callState.otherName || 'In call', 'On a call', 'Connected');
        startCallTimer();
      } else if (sig.kind === 'answer' && payload && payload.sdp) {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
          await flushIce(pc, callState.iceQueue);
        }
        await tuneAudioSender(pc);
        stopRing();
        clearOutgoingRingTimer();
        setAllRemoteVolumes();
        setCallChrome(callState.otherName || 'In call', 'On a call', 'Connected');
        startCallTimer();
      } else if (sig.kind === 'ice' && payload) {
        queueOrAddIce(pc, callState.iceQueue, payload);
      }
      callState.seenSignals.add(key);
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
  const body = SIG_PREFIX + JSON.stringify(Object.assign({ from: me.id, name: myName(), at: Date.now(), sid: groupState.sid || undefined }, msg));
  await request(SUPABASE_URL + '/rest/v1/rpc/post_message', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ sender_id: me.id, body, conversation_id: null, channel_id: textCh.id })
  }, 4000);
}

function newSessionId() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(36) + a[1].toString(36);
  } catch (_) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

function sigTime(sig) {
  // Prefer the server's timestamp so differing device clocks can't make fresh signals look old (or old ones fresh).
  const t = Date.parse((sig && sig.created_at) || '');
  return Number.isFinite(t) ? t : (Number(sig && sig.at) || 0);
}

function dropGroupPeer(peerId) {
  const peer = groupState.peers[peerId];
  if (peer && peer.pc) { try { peer.pc.close(); } catch (_) {} }
  delete groupState.peers[peerId];
  if (callState.remoteStreams) { delete callState.remoteStreams['g-' + peerId]; delete callState.remoteStreams['s-' + peerId]; }
  unhookRemote(peerId);
  removeRemoteTile('screen-' + peerId);
  removeRemoteTile(peerId);
  updateCallNames();
}

async function ensureGroupPeer(peerId, name, sid) {
  if (!peerId || peerId === me.id) return null;
  const existing = groupState.peers[peerId];
  if (existing && existing.pc) {
    existing.name = name || existing.name;
    if (sid && !existing.sid) existing.sid = sid;
    return existing;
  }
  const stream = activeStream();
  const pc = new RTCPeerConnection(iceServers());
  const onScreen = (on) => setRemoteScreen(peerId, (groupState.peers[peerId] && groupState.peers[peerId].name) || 'Member', on);
  pc._peerId = peerId;
  if (me.id < peerId) buildOffererSlots(pc, stream, onScreen); // the lower id always makes the offer
  else buildAnswererSlots(pc, stream, onScreen);
  const peer = { pc, name: name || 'Member', stream: peerMedia('g-' + peerId), iceQueue: [], sid: sid || null, createdAt: Date.now(), lastSeen: Date.now(), offerAt: 0, helloAt: 0 };
  groupState.peers[peerId] = peer;
  groupState.hadPeer = true;
  tuneAudioSender(pc);
  ensureRemoteTile(peerId, peer.name);
  updateCallNames();
  pc.onicecandidate = (ev) => {
    if (ev.candidate) postGroupSignal(groupState.textCh, { t: 'ice', to: peerId, room: groupState.room, payload: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
  };
  pc.ontrack = (ev) => {
    const role = trackRole(pc, ev);
    if (role === 'screenV' || role === 'screenA') {
      addRemoteTrack(peerMedia('s-' + peerId), ev.track);
      watchScreenTrack(peerId, peer.name, ev.track);
      refreshRemoteScreen(peerId);
      return;
    }
    if (ev.track) addRemoteTrack(peer.stream, ev.track);
    if (ev.track && ev.track.kind === 'audio') {
      try { ev.track.contentHint = 'speech'; } catch (_) {}
    }
    bindRemoteStream(peerId, peer.name, peer.stream);
  };
  watchConnection(pc, {
    renegotiate: async () => {
      if (groupState.peers[peerId] === peer && me.id < peerId && pc.signalingState === 'stable') await offerGroupPeer(peerId, true);
    },
    onConnected: () => {
      if (groupState.peers[peerId] !== peer) return;
      groupState.hadPeer = true;
      const tile = $('tile-' + peerId);
      if (tile) tile.classList.add('connected');
      if (screenShare.active) applyScreenToPc(pc);
      setAllRemoteVolumes();
    },
    onDead: () => {
      if (groupState.peers[peerId] !== peer) return;
      dropGroupPeer(peerId);
      maybeEndSoloGroupCall();
    }
  });
  return peer;
}

async function offerGroupPeer(peerId, force) {
  const peer = groupState.peers[peerId];
  if (!peer || !peer.pc) return;
  const pc = peer.pc;
  peer.offerAt = Date.now();
  if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
    // Offer already made but no answer yet (it may have been missed): send the same one again.
    await postGroupSignal(groupState.textCh, { t: 'offer', to: peerId, room: groupState.room, payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    return;
  }
  if (pc.signalingState !== 'stable') return;
  if (pc.remoteDescription && !force) return; // already negotiated
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, voiceActivityDetection: false });
  await setLocalTuned(pc, offer);
  await postGroupSignal(groupState.textCh, { t: 'offer', to: peerId, room: groupState.room, payload: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
}

function trackGroupSignal(sig) {
  const room = sig && sig.room;
  if (!room) return;
  if (!groupLive[room]) groupLive[room] = { members: new Set(), lastAt: Date.now(), startedAt: Date.now(), ended: false, hadMultiple: false };
  const live = groupLive[room];
  live.lastAt = Number(sig.at) || Date.parse(sig.created_at || '') || Date.now();
  if (sig.textChId) live.textChId = sig.textChId;
  if (sig.voiceChId) live.voiceChId = sig.voiceChId;
  if (sig.from) live.from = sig.from;
  if (sig.name) live.name = sig.name;
  if (sig.t === 'ring' || sig.t === 'join' || sig.t === 'here') {
    live.ended = false;
    if (sig.from) live.members.add(sig.from);
  } else if (sig.t === 'leave') {
    if (sig.from) live.members.delete(sig.from);
    if (live.members.size <= 1 && live.hadMultiple) live.ended = true;
    if (!live.members.size) live.ended = true;
  } else if (sig.t === 'end') {
    live.ended = true;
    live.members = new Set();
  }
  if (live.members.size >= 2) live.hadMultiple = true;
  updateCallButtons();
}

function maybeEndSoloGroupCall() {
  if (!groupState.room || endingGroup || !groupState.hadPeer) return;
  if (Object.keys(groupState.peers).length) {
    if (soloTimer) { clearTimeout(soloTimer); soloTimer = 0; }
    return;
  }
  if (soloTimer) return;
  // Short grace period so a brief reconnect doesn't kick anyone.
  soloTimer = setTimeout(() => {
    soloTimer = 0;
    if (!groupState.room || endingGroup || Object.keys(groupState.peers).length) return;
    setCallChrome((groupState.server && groupState.server.name) || 'Call', 'Group call', 'Everyone else left');
    setTimeout(() => {
      if (groupState.room && !endingGroup && !Object.keys(groupState.peers).length) endGroupCall(true);
    }, 1200);
  }, 2500);
}

// Runs every few seconds while in a group call.
function groupMaintenance() {
  if (!groupState.room || endingGroup) return;
  const now = Date.now();
  Object.keys(groupState.peers).forEach((id) => {
    const peer = groupState.peers[id];
    if (!peer || !peer.pc) return;
    if (now - (peer.lastSeen || peer.createdAt || now) > 25000) { dropGroupPeer(id); return; } // went silent without leaving
    if (peer.pc.connectionState === 'connected' || now - peer.createdAt < 4000) return;
    // Not connected yet: the lower id keeps (re)sending the offer, the higher id keeps saying hello.
    if (me.id < id) { if (now - peer.offerAt > 5000) offerGroupPeer(id).catch(() => {}); }
    else if (now - peer.helloAt > 4000) {
      peer.helloAt = now;
      postGroupSignal(groupState.textCh, { t: 'hello', to: id, room: groupState.room });
    }
  });
  maybeEndSoloGroupCall();
  if (!groupState.hadPeer && groupState.startedAt && now - groupState.startedAt > 60000 && !groupState.leaving) {
    groupState.leaving = true;
    setCallChrome((groupState.server && groupState.server.name) || 'Call', 'Group call', 'No one joined');
    setTimeout(() => { if (groupState.room && !endingGroup) endGroupCall(true); }, 1200);
  }
}

async function enterGroupCall(sv) {
  if (!sv) return;
  if (groupState.room === sv.id) { returnToCall(); return; }
  const live = liveGroupFor(sv);
  if (live) {
    await joinGroupCall({
      room: sv.id,
      textChId: live.textChId,
      voiceChId: live.voiceChId,
      from: live.from,
      name: live.name,
      groupName: sv.name
    });
    return;
  }
  await startGroupCall(sv);
}

async function handleGroupSignal(sig, msgId) {
  if (!sig) return;
  const key = String(msgId || '') + ':' + sig.t + ':' + sig.from + ':' + (sig.at || '');
  if (groupState.seen.has(key)) return;
  groupState.seen.add(key);
  if (groupState.seen.size > 400) {
    const keep = Array.from(groupState.seen).slice(-200);
    groupState.seen = new Set(keep);
  }
  rememberRoster(sig.room || (activeServer && activeServer.id), sig.from, sig.name);
  trackGroupSignal(sig);
  if (sig.from === me.id) {
    // Our own first message of this call marks the moment we joined; anything older than it is left over from earlier calls.
    if (groupState.room && sig.room === groupState.room && sig.sid && sig.sid === groupState.sid && groupState.joinRef == null) groupState.joinRef = sigTime(sig);
    return;
  }
  if (sig.room && groupState.room && sig.room !== groupState.room) return;
  if (sig.to && sig.to !== me.id && sig.to !== '*') return;

  if ((sig.t === 'ring') && !groupState.room && !callState.call) {
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
  if (groupState.joinRef == null) return;           // haven't seen our own join yet
  if (sigTime(sig) < groupState.joinRef) return;    // sent before we joined: stale
  const from = sig.from;
  if (!from) return;

  if (sig.t === 'leave' || sig.t === 'end') {
    const peer = groupState.peers[from];
    if (peer && (!sig.sid || !peer.sid || sig.sid === peer.sid)) dropGroupPeer(from);
    maybeEndSoloGroupCall();
    return;
  }
  if (sig.t === 'screen') {
    setRemoteScreen(from, sig.name || (groupState.peers[from] && groupState.peers[from].name) || 'Member', !!sig.on);
    return;
  }
  if (sig.t === 'here' && typeof sig.screen === 'boolean') {
    // Safety net for missed messages and late joiners, ignored right after any direct start/stop notice.
    const has = !!$('tile-screen-' + from);
    if (sig.screen !== has && Date.now() - (remoteScreenAt[from] || 0) > 6000) {
      setRemoteScreen(from, sig.name || (groupState.peers[from] && groupState.peers[from].name) || 'Member', sig.screen);
    }
  }
  if (!['join', 'hello', 'here', 'offer', 'answer', 'ice'].includes(sig.t)) return;

  // Someone who left and came back has a new session id: start fresh with them.
  const known = groupState.peers[from];
  if (known && sig.sid && known.sid && sig.sid !== known.sid) dropGroupPeer(from);
  if (groupState.peers[from]) groupState.peers[from].lastSeen = Date.now();

  if (sig.t === 'join' || sig.t === 'hello' || sig.t === 'here') {
    const had = !!groupState.peers[from];
    const peer = await ensureGroupPeer(from, sig.name, sig.sid);
    if (!peer) return;
    if (sig.t === 'here' && had) return;
    if (me.id < from) await offerGroupPeer(from);
    else if (sig.t === 'join') await postGroupSignal(groupState.textCh, { t: 'hello', to: from, room: groupState.room });
    return;
  }
  if (sig.t === 'offer' && sig.payload && sig.payload.sdp) {
    const peer = await ensureGroupPeer(from, sig.name, sig.sid);
    if (!peer) return;
    if (peer.pc.signalingState === 'have-local-offer') {
      try { await peer.pc.setLocalDescription({ type: 'rollback' }); } catch (_) {}
    }
    const desc = { type: sig.payload.type, sdp: sig.payload.sdp };
    await peer.pc.setRemoteDescription(new RTCSessionDescription(desc));
    adoptScreenSlots(peer.pc);
    await flushIce(peer.pc, peer.iceQueue);
    if (peer.pc.signalingState === 'have-remote-offer') {
      const answer = await peer.pc.createAnswer();
      await setLocalTuned(peer.pc, answer);
      await postGroupSignal(groupState.textCh, { t: 'answer', to: from, room: groupState.room, payload: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } });
    }
    return;
  }
  if (sig.t === 'answer' && sig.payload && sig.payload.sdp) {
    const peer = groupState.peers[from];
    if (peer && peer.pc && peer.pc.signalingState === 'have-local-offer') {
      const desc = { type: sig.payload.type, sdp: sig.payload.sdp };
      await peer.pc.setRemoteDescription(new RTCSessionDescription(desc));
      await flushIce(peer.pc, peer.iceQueue);
    }
    return;
  }
  if (sig.t === 'ice' && sig.payload) {
    const peer = await ensureGroupPeer(from, sig.name, sig.sid);
    if (peer && peer.pc) queueOrAddIce(peer.pc, peer.iceQueue, sig.payload);
  }
}

async function startGroupCall(sv, voiceCh) {
  if (!sv) return;
  unlockCallAudio();
  const existing = liveGroupFor(sv);
  if (existing && groupState.room !== sv.id) {
    await joinGroupCall({
      room: sv.id,
      textChId: existing.textChId,
      voiceChId: existing.voiceChId,
      from: existing.from,
      name: existing.name,
      groupName: sv.name
    });
    return;
  }
  if (groupState.room === sv.id) { returnToCall(); return; }
  groupState.hadPeer = false;
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
  groupState.sid = newSessionId();
  groupState.joinRef = null;
  groupState.startedAt = Date.now();
  groupState.leaving = false;
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
  const sv = cachedServers.find((s) => s.id === incoming.room);
  if (!sv) { alert('You can only join calls in groups you are a member of.'); return; }
  unlockCallAudio();
  activeServer = sv;
  stopRing();
  showIncoming(false);
  groupState.incoming = null;
  let voiceCh = null;
  const list = await ensureGroupChannels(sv).catch(() => []);
  const textCh = (list && list.find((c) => c.id === incoming.textChId)) || (list && list.find((c) => c.kind === 'text')) || { id: incoming.textChId };
  voiceCh = (list && list.find((c) => c.id === incoming.voiceChId)) || (list && list.find((c) => c.kind === 'voice')) || (incoming.voiceChId ? { id: incoming.voiceChId } : null);
  if (callState.call) await hangUp();
  groupState.hadPeer = false;
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
  groupState.sid = newSessionId();
  groupState.joinRef = null;
  groupState.startedAt = Date.now();
  groupState.leaving = false;
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
  const others = Object.keys(groupState.peers).length;
  if (notify && textCh) {
    await postGroupSignal(textCh, { t: 'leave', to: '*', room: roomId });
    if (others === 0) await postGroupSignal(textCh, { t: 'end', to: '*', room: roomId });
  }
  if (roomId) {
    trackGroupSignal({ t: 'leave', room: roomId, from: me.id, at: Date.now() });
    if (others === 0) trackGroupSignal({ t: 'end', room: roomId, from: me.id, at: Date.now() });
  }
  stopScreenShare(false);
  Object.keys(groupState.peers).forEach((id) => {
    try { groupState.peers[id].pc && groupState.peers[id].pc.close(); } catch (_) {}
    unhookRemote(id);
  });
  groupState.peers = {};
  groupState.room = null;
  groupState.server = null;
  groupState.textCh = null;
  groupState.voiceCh = null;
  groupState.hadPeer = false;
  groupState.sid = null;
  groupState.joinRef = null;
  groupState.startedAt = 0;
  groupState.leaving = false;
  if (soloTimer) { clearTimeout(soloTimer); soloTimer = 0; }
  if (callState.remoteStreams) Object.keys(callState.remoteStreams).forEach((k) => { if (k.startsWith('g-')) delete callState.remoteStreams[k]; });
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

let pollingGroup = false;
async function pollGroupSignals() {
  if (pollingGroup) return;
  pollingGroup = true;
  try { await pollGroupSignalsOnce(); }
  catch (err) { console.warn(err); }
  finally { pollingGroup = false; }
}
async function pollGroupSignalsOnce() {
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
    const recent = list.slice(-80);
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
setInterval(() => {
  if (!callState.call && !groupState.room) return;
  document.querySelectorAll('audio[id^="aud-"]').forEach((audio) => {
    if (audio.id === 'aud-unlock') return;
    if (audio.srcObject && audio.paused) playRemote(audio);
  });
}, 1200);
setInterval(() => {
  if (!groupState.room || !groupState.textCh) return;
  groupMaintenance();
  const payload = {
    t: 'here',
    to: '*',
    room: groupState.room,
    screen: !!screenShare.active,
    textChId: groupState.textCh.id,
    voiceChId: groupState.voiceCh && groupState.voiceCh.id
  };
  trackGroupSignal({ ...payload, from: me.id, name: myName(), at: Date.now() });
  postGroupSignal(groupState.textCh, payload);
}, 3000);

boot();


/* ---------- Speaking rings (audio level) ---------- */

function levelContext() {
  if (!levelMeter.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try { levelMeter.ctx = new Ctx(); } catch (_) { return null; }
  }
  return levelMeter.ctx;
}

function meterTrackFor(key) {
  let stream = null;
  if (key === 'local') stream = activeStream();
  else {
    const audio = document.getElementById('aud-' + key);
    stream = audio && audio.srcObject;
  }
  const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
  return track && track.readyState === 'live' ? track : null;
}

function detachMeter(key) {
  const m = levelMeter.nodes.get(key);
  if (!m) return;
  try { m.src.disconnect(); } catch (_) {}
  levelMeter.nodes.delete(key);
}

function attachMeter(key, track) {
  const existing = levelMeter.nodes.get(key);
  if (existing && existing.track === track) return existing;
  if (existing) detachMeter(key);
  const ctx = levelContext();
  if (!ctx) return null;
  try {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.3;
    src.connect(an); // analysed only, never routed to the speakers (the <audio> element does playback)
    const m = { track, src, an, buf: new Uint8Array(an.fftSize), level: 0 };
    levelMeter.nodes.set(key, m);
    return m;
  } catch (_) { return null; }
}

function readLevel(m) {
  m.an.getByteTimeDomainData(m.buf);
  let sum = 0;
  for (let i = 0; i < m.buf.length; i++) {
    const v = (m.buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / m.buf.length);
  const raw = Math.pow(Math.min(1, Math.max(0, (rms - 0.012) / 0.18)), 0.75);
  m.level += (raw - m.level) * (raw > m.level ? 0.6 : 0.14); // quick rise, gentle fall
  return m.level < 0.01 ? 0 : m.level;
}

function stopLevelMeter() {
  Array.from(levelMeter.nodes.keys()).forEach(detachMeter);
  if (levelMeter.ctx) { try { levelMeter.ctx.close(); } catch (_) {} levelMeter.ctx = null; }
  document.querySelectorAll('#videos .tile').forEach((t) => t.style.setProperty('--lvl', '0'));
}

function startLevelMeter() {
  if (levelMeter.raf) return;
  const tick = () => {
    levelMeter.raf = 0;
    if (!(callState.call || groupState.room)) { stopLevelMeter(); return; }
    const pane = $('voicePane');
    if (!document.hidden && pane && !pane.hidden) {
      const ctx = levelMeter.ctx;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      const seen = new Set();
      document.querySelectorAll('#videos .tile').forEach((tile) => {
        const key = tile.id === 'localTile' ? 'local' : tile.id.replace(/^tile-/, '');
        seen.add(key);
        const track = meterTrackFor(key);
        const m = track ? attachMeter(key, track) : null;
        if (!track) detachMeter(key);
        const lvl = m ? readLevel(m) : 0;
        tile.style.setProperty('--lvl', lvl.toFixed(3));
        const v = tile.querySelector('video');
        tile.classList.toggle('has-video', !!(v && !v.hidden));
      });
      Array.from(levelMeter.nodes.keys()).forEach((k) => { if (!seen.has(k)) detachMeter(k); });
    }
    levelMeter.raf = requestAnimationFrame(tick);
  };
  levelMeter.raf = requestAnimationFrame(tick);
}

/* ---------- Per-user options menu (the ⋯ button on each tile) ---------- */

function closeUserMenu() {
  if (userMenuEl) userMenuEl.hidden = true;
  userMenuFor = null;
}

function menuRow(label, valueText) {
  const row = document.createElement('div');
  row.className = 'um-row';
  const a = document.createElement('span');
  a.textContent = label;
  row.appendChild(a);
  if (valueText != null) {
    const b = document.createElement('span');
    b.className = 'um-val';
    b.textContent = valueText;
    row.appendChild(b);
  }
  return row;
}

function openUserMenu(tile, btn) {
  if (!tile || !btn) return;
  const isLocal = tile.id === 'localTile';
  const key = isLocal ? 'local' : tile.id.replace(/^tile-/, '');
  if (userMenuEl && !userMenuEl.hidden && userMenuFor === key) { closeUserMenu(); return; }
  if (!userMenuEl) {
    userMenuEl = document.createElement('div');
    userMenuEl.className = 'user-menu';
    userMenuEl.hidden = true;
    document.body.appendChild(userMenuEl);
  }
  const menu = userMenuEl;
  menu.textContent = '';
  const title = document.createElement('div');
  title.className = 'um-title';
  const label = tile.querySelector('.tile-name');
  title.textContent = isLocal ? 'You' : ((label && label.textContent) || 'Member');
  menu.appendChild(title);

  if (isLocal) {
    const row = document.createElement('label');
    row.className = 'um-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = noiseOn();
    box.onchange = () => {
      if ($('nsToggle')) $('nsToggle').checked = box.checked;
      applyNoiseSuppression(box.checked);
    };
    const txt = document.createElement('span');
    txt.textContent = 'Noise suppression';
    row.appendChild(box);
    row.appendChild(txt);
    menu.appendChild(row);
  } else {
    const pct = userVolGet(key);
    const row = menuRow('Volume', pct + '%');
    const val = row.querySelector('.um-val');
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(USER_VOL_MAX);
    range.step = '1';
    range.value = String(pct);
    const apply = () => {
      const n = Number(range.value);
      userVolSet(key, n);
      val.textContent = n + '%';
      const audio = document.getElementById('aud-' + key);
      if (audio) applyRemoteVolume(audio, key);
    };
    range.oninput = apply;
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'um-reset';
    reset.textContent = 'Reset to 100%';
    reset.onclick = () => { range.value = '100'; apply(); };
    menu.appendChild(row);
    menu.appendChild(range);
    menu.appendChild(reset);
    if (key.startsWith('screen-')) {
      const fs = document.createElement('button');
      fs.type = 'button';
      fs.className = 'um-reset';
      fs.textContent = 'Full screen';
      fs.onclick = () => { closeUserMenu(); toggleTileFullscreen(tile); };
      menu.appendChild(fs);
    }
  }

  userMenuFor = key;
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  let top = r.top - mh - 8;
  if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - mh - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}

if ($('videos')) {
  $('videos').addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('.tile-more');
    if (!btn) return;
    ev.stopPropagation();
    openUserMenu(btn.closest('.tile'), btn);
  });
  $('videos').addEventListener('scroll', closeUserMenu, { passive: true });
}
document.addEventListener('pointerdown', (ev) => {
  if (!userMenuEl || userMenuEl.hidden) return;
  if (userMenuEl.contains(ev.target) || (ev.target.closest && ev.target.closest('.tile-more'))) return;
  closeUserMenu();
}, true);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeUserMenu(); });
window.addEventListener('resize', closeUserMenu);


/* ---------- Screen sharing ---------- */
function sdpSections(sdp) {
  const out = [];
  String(sdp || '').split(/\r?\n/).forEach((line) => {
    if (line.startsWith('m=')) out.push({ kind: line.slice(2).split(' ')[0], mid: null });
    else if (line.startsWith('a=mid:') && out.length) out[out.length - 1].mid = line.slice(6).trim();
  });
  return out;
}

// The media lines of this connection, or null if the other side isn't using the 4-line layout.
function slotLayout(pc) {
  if (!pc) return null;
  const desc = pc.localDescription || pc.remoteDescription;
  if (!desc || !desc.sdp) return null;
  const secs = sdpSections(desc.sdp);
  for (let i = 0; i < SLOT_KINDS.length; i++) {
    if (!secs[i] || secs[i].kind !== SLOT_KINDS[i] || secs[i].mid == null) return null;
  }
  return secs;
}

function pcSlot(pc, role) {
  const i = SLOT_ROLES.indexOf(role);
  if (!pc || i < 0) return null;
  const secs = slotLayout(pc);
  if (secs && typeof pc.getTransceivers === 'function') {
    const tx = pc.getTransceivers().find((t) => t.mid === secs[i].mid);
    if (tx) return tx;
  }
  return (pc._slots && pc._slots[role]) || null;
}

function trackRole(pc, ev) {
  const secs = slotLayout(pc);
  if (!secs || !ev || !ev.transceiver || ev.transceiver.mid == null) return null;
  const i = secs.findIndex((x) => x.mid === ev.transceiver.mid);
  return i >= 0 && i < SLOT_ROLES.length ? SLOT_ROLES[i] : null;
}

// Side that makes the offer: creates all four lines up front (mic, camera, screen video, screen audio).
function buildOffererSlots(pc, stream, onScreen) {
  const audioTrack = stream && stream.getAudioTracks()[0];
  const videoTrack = stream && stream.getVideoTracks()[0];
  const mic = audioTrack ? pc.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [stream] }) : pc.addTransceiver('audio', { direction: 'sendrecv' });
  const cam = videoTrack ? pc.addTransceiver(videoTrack, { direction: 'sendrecv', streams: [stream] }) : pc.addTransceiver('video', { direction: 'sendrecv' });
  const screenV = pc.addTransceiver('video', { direction: 'sendrecv' });
  const screenA = pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc._slots = { mic, cam, screenV, screenA };
  pc._screen = { v: screenV, a: screenA };
  pc._isOfferer = true;
  try { wireControlChannel(pc, pc.createDataChannel('mokio-ctl'), onScreen); } catch (_) {}
  if (screenShare.active) applyScreenToPc(pc);
}

// Side that answers: sends mic/camera on the offer's first lines, then takes over the screen lines once the offer arrives.
function buildAnswererSlots(pc, stream, onScreen) {
  pc._isOfferer = false;
  if (stream) stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
  pc.ondatachannel = (ev) => wireControlChannel(pc, ev.channel, onScreen);
}

function adoptScreenSlots(pc) {
  const v = pcSlot(pc, 'screenV');
  const a = pcSlot(pc, 'screenA');
  if (!v || !a) return;
  pc._screen = { v, a };
  [v, a].forEach((tx) => { try { if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv'; } catch (_) {} });
  if (screenShare.active) applyScreenToPc(pc);
}

function wireControlChannel(pc, dc, onScreen) {
  if (!dc) return;
  pc._dc = dc;
  dc.onopen = () => sendCtl(pc, { k: 'screen', on: screenShare.active });
  dc.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (_) {}
    if (!msg) return;
    if (msg.k === 'screen') onScreen(!!msg.on);
    else if (msg.k === 'seen') {
      if (screenShare.active && pc._peerId) { screenShare.seen.add(pc._peerId); updateScreenStatus(); }
    } else if (msg.k === 'reneg') {
      // The person presenting asks the side that makes offers to renegotiate so their screen line is fully announced.
      if (pc._isOfferer) renegotiateForScreen(pc).catch(() => {});
    }
  };
  dc.onclose = () => onScreen(false);
  if (dc.readyState === 'open') dc.onopen();
}

function sendCtl(pc, msg) {
  try { if (pc && pc._dc && pc._dc.readyState === 'open') pc._dc.send(JSON.stringify(msg)); } catch (_) {}
}

function allPcs() {
  const out = [];
  if (callState.pc) out.push(callState.pc);
  Object.keys(groupState.peers || {}).forEach((id) => {
    const peer = groupState.peers[id];
    if (peer && peer.pc) out.push(peer.pc);
  });
  return out;
}

function broadcastScreenState() {
  allPcs().forEach((pc) => sendCtl(pc, { k: 'screen', on: screenShare.active }));
}

async function tuneScreenSender(pc) {
  const slots = pc && pc._screen;
  if (!slots) return;
  const peers = Math.max(1, Object.keys(groupState.peers || {}).length);
  try {
    const sender = slots.v.sender;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = peers > 2 ? 1500000 : 2500000;
    params.encodings[0].maxFramerate = 30;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (_) {}
  try {
    const sender = slots.a.sender;
    if (!sender.track) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 128000;
    await sender.setParameters(params);
  } catch (_) {}
}

async function applyScreenToPc(pc) {
  const slots = pc && pc._screen;
  if (!slots) return;
  const video = screenShare.active ? screenShare.video : null;
  const audio = screenShare.active ? screenShare.audio : null;
  try { await slots.v.sender.replaceTrack(video); } catch (_) {}
  try { await slots.a.sender.replaceTrack(audio); } catch (_) {}
  if (video) { if (!pc._shareSince) pc._shareSince = Date.now(); tuneScreenSender(pc); }
  else { pc._shareSince = 0; pc._screenRetry = false; }
}

function showLocalScreenTile(on) {
  const box = $('videos');
  if (!box) return;
  let tile = $('tile-screen-local');
  if (!on) {
    if (tile) tile.remove();
    closeUserMenu();
    layoutCallTiles();
    return;
  }
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile screen-tile local-screen connected';
    tile.id = 'tile-screen-local';
    tile.innerHTML = '<div class="screen-card">' + ICO_SCREEN + '<div class="screen-card-title">You\u2019re presenting your screen</div><div class="screen-card-sub" id="screenSeen"></div><button type="button" class="stop-share">Stop presenting</button></div><span class="tile-name">Your screen</span>';
    tile.querySelector('.stop-share').onclick = () => stopScreenShare(true);
    box.appendChild(tile);
  }
  layoutCallTiles();
}

function reportScreenSeen(peerId) {
  const peer = groupState.peers && groupState.peers[peerId];
  const pc = (peer && peer.pc) || (peerId === (callState.otherId || 'remote') ? callState.pc : null);
  sendCtl(pc, { k: 'seen' });
}

function refreshRemoteScreen(peerId) {
  const key = 'screen-' + peerId;
  const tile = $('tile-' + key);
  if (!tile) return;
  const video = tile.querySelector('video');
  const stream = peerMedia('s-' + peerId);
  if (!video) return;
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = true;
  video.volume = 0;
  video.hidden = false;
  video.onplaying = () => reportScreenSeen(peerId); // tells the presenter this person can see the screen
  try { video.play().catch(() => {}); } catch (_) {}
  hookRemoteVolume(video, key);
}

// If picture is arriving for a screen we weren't told about, show it anyway.
function watchScreenTrack(peerId, name, track) {
  if (!track || track.kind !== 'video') return;
  track.onunmute = () => {
    if (!$('tile-screen-' + peerId)) setRemoteScreen(peerId, name, true);
    reportScreenSeen(peerId);
  };
}

// Someone else started or stopped presenting.
function setRemoteScreen(peerId, name, on) {
  const key = 'screen-' + peerId;
  remoteScreenAt[peerId] = Date.now();
  if (!on) {
    if ($('tile-' + key)) removeRemoteTile(key);
    return;
  }
  const tile = ensureRemoteTile(key, (name || 'Member') + '\u2019s screen');
  if (!tile) return;
  tile.classList.add('screen-tile', 'connected');
  const face = tile.querySelector('.face');
  if (face) face.remove();
  layoutCallTiles();
  refreshRemoteScreen(peerId);
}

function toggleTileFullscreen(tile) {
  if (!tile) return;
  try {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const req = tile.requestFullscreen || tile.webkitRequestFullscreen;
    if (req) req.call(tile);
  } catch (_) {}
}

function screenNotice(text, ms) {
  showCallNotice(text);
  if (text) setTimeout(() => { const el = $('callNotice'); if (el && el.textContent === text) showCallNotice(''); }, ms || 7000);
}

async function startScreenShare() {
  if (screenShare.active || screenShare.starting) return;
  if (!(callState.call || groupState.room)) return;
  const md = navigator.mediaDevices;
  if (!md || !md.getDisplayMedia) { screenNotice('Screen sharing isn\u2019t supported in this browser or device.'); return; }
  screenShare.starting = true;
  try {
    const attempts = [
      {
        video: { width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 1440 }, frameRate: { ideal: 30, max: 30 } },
        // suppressLocalAudioPlayback:false keeps the shared site/window/device audio playing for the person sharing.
        // restrictOwnAudio:true keeps this page's own sound (the other people's voices) out of the shared audio, which avoids echo.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true },
        systemAudio: 'include', surfaceSwitching: 'include', selfBrowserSurface: 'exclude'
      },
      { video: true, audio: true },
      { video: true }
    ];
    let stream = null;
    let lastErr = null;
    for (const opts of attempts) {
      try { stream = await md.getDisplayMedia(opts); break; }
      catch (err) {
        lastErr = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) break; // picker closed
      }
    }
    if (!stream) {
      if (lastErr && lastErr.name !== 'NotAllowedError' && lastErr.name !== 'AbortError') screenNotice('Couldn\u2019t start screen sharing.');
      return;
    }
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    if (!video || !(callState.call || groupState.room)) { stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); return; }
    try { video.contentHint = 'detail'; } catch (_) {}
    screenShare.stream = stream;
    screenShare.video = video;
    screenShare.audio = audio;
    screenShare.active = true;
    video.addEventListener('ended', () => { if (screenShare.video === video) stopScreenShare(true); }); // browser's own "Stop sharing" bar
    screenShare.seen = new Set();
    await Promise.all(allPcs().map((pc) => applyScreenToPc(pc)));
    broadcastScreenState();
    announceScreenGroup(true);
    allPcs().forEach((pc) => { // make sure the new screen line is fully announced to every viewer
      if (pc._isOfferer) renegotiateForScreen(pc).catch(() => {});
      else sendCtl(pc, { k: 'reneg' });
    });
    if (screenShare.timer) clearInterval(screenShare.timer);
    screenShare.timer = setInterval(screenShareTick, 3000);
    showLocalScreenTile(true);
    updateScreenStatus();
    paintCallButtons();
    if (!audio) {
      screenNotice(/Chrome|Edg\//.test(navigator.userAgent)
        ? 'Sharing without sound. To share sound, pick a tab (or, on Windows, the whole screen) and tick the audio box in the picker next time.'
        : 'Sharing without sound \u2014 this browser can\u2019t share audio.');
    }
  } finally {
    screenShare.starting = false;
  }
}

function stopScreenShare(notify) {
  if (!screenShare.active && !screenShare.stream) return;
  const pcs = allPcs();
  const stream = screenShare.stream;
  screenShare.active = false;
  if (screenShare.timer) { clearInterval(screenShare.timer); screenShare.timer = 0; }
  screenShare.seen = new Set();
  screenShare.stream = screenShare.video = screenShare.audio = null;
  if (stream) stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  if (notify !== false) {
    pcs.forEach((pc) => applyScreenToPc(pc));
    broadcastScreenState();
    announceScreenGroup(false);
  }
  showLocalScreenTile(false);
  paintCallButtons();
}

function announceScreenGroup(on) {
  if (!groupState.room || !groupState.textCh) return;
  postGroupSignal(groupState.textCh, { t: 'screen', to: '*', room: groupState.room, on: !!on }).catch(() => {});
}

async function renegotiateForScreen(pc) {
  if (!pc || pc.signalingState !== 'stable' || !pc.remoteDescription) return;
  if (pc === callState.pc) {
    if (!callState.iAmCaller || !callState.call) return;
    const offer = await pc.createOffer();
    await setLocalTuned(pc, offer);
    await sendSignal('offer', pc.localDescription || offer);
    return;
  }
  const id = pc._peerId;
  if (id && groupState.peers[id] && groupState.peers[id].pc === pc && me.id < id) await offerGroupPeer(id, true);
}

function updateScreenStatus() {
  const el = $('screenSeen');
  if (!el) return;
  const total = allPcs().length;
  el.textContent = total ? ('Seen by ' + screenShare.seen.size + ' of ' + total) : 'Waiting for others to join';
}

// While presenting: keep telling everyone, and give anyone who still can't see it one more nudge.
function screenShareTick() {
  if (!screenShare.active) return;
  const now = Date.now();
  allPcs().forEach((pc) => {
    sendCtl(pc, { k: 'screen', on: true });
    if (!pc._shareSince) pc._shareSince = now;
    if (!screenShare.seen.has(pc._peerId) && !pc._screenRetry && now - pc._shareSince > 6000) {
      pc._screenRetry = true;
      if (pc._isOfferer) renegotiateForScreen(pc).catch(() => {});
      else sendCtl(pc, { k: 'reneg' });
    }
  });
  updateScreenStatus();
}

if ($('shareBtn')) $('shareBtn').onclick = () => { if (screenShare.active) stopScreenShare(true); else startScreenShare(); };
if ($('videos')) {
  $('videos').addEventListener('dblclick', (ev) => {
    const tile = ev.target.closest && ev.target.closest('.screen-tile');
    if (tile && !tile.classList.contains('local-screen')) toggleTileFullscreen(tile);
  });
}
paintCallButtons();
