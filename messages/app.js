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
  ['friendsPane','notesPane','settingsPane','chatPane','voicePane'].forEach((id) => { $(id).hidden = id !== name; });
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
  await loadFriends();
  await loadConvos();
  await loadServers();
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

$('homeBtn').onclick = $('friendsBtn').onclick = () => {
  current = null; currentChannel = null; activeServer = null;
  $('dmList').hidden = false;
  $('serverList').hidden = true;
  $('midTitle').textContent = 'Direct messages';
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
  $('saveNote').textContent = res.ok ? 'Saved.' : ((res.data && res.data.message) || 'Run the profile SQL first.');
  if (res.ok) {
    Object.assign(me, { displayName: payload.display_name, bio: payload.bio, pronouns: payload.pronouns, color: payload.color, bannerColor: payload.banner_color, status: payload.status, hideOnline: payload.hide_online });
    paintMe();
  }
}

$('addFriend').onsubmit = async (e) => {
  e.preventDefault();
  const handle = e.target.handle.value.trim().toLowerCase().replace(/^@/, '');
  const other = await findHandle(handle);
  if (!other?.id) { alert('No Mokio user found.'); return; }
  if (other.id === me.id) { alert('That is you.'); return; }
  const res = await request(SUPABASE_URL + '/rest/v1/friends', {
    method: 'POST', headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify({ requester: me.id, addressee: other.id, status: 'accepted' })
  });
  if (!res.ok) alert((res.data && res.data.message) || 'Could not add friend.');
  e.target.reset();
  loadFriends();
};

async function findHandle(handle) {
  const found = await request(SUPABASE_URL + '/rest/v1/rpc/find_user_handle', {
    method: 'POST', headers: headers(session.access_token), body: JSON.stringify({ handle })
  });
  return Array.isArray(found.data) ? found.data[0] : found.data;
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
  if (!convo) {
    const look = await request(SUPABASE_URL + '/rest/v1/conversations?or=(and(user_a.eq.' + me.id + ',user_b.eq.' + otherId + '),and(user_a.eq.' + otherId + ',user_b.eq.' + me.id + '))&select=*', { headers: headers(session.access_token) });
    convo = Array.isArray(look.data) ? look.data[0] : null;
    if (!convo) {
      const created = await request(SUPABASE_URL + '/rest/v1/conversations', {
        method: 'POST', headers: { ...headers(session.access_token), Prefer: 'return=representation' },
        body: JSON.stringify({ user_a: me.id, user_b: otherId })
      });
      convo = Array.isArray(created.data) ? created.data[0] : created.data;
    }
  }
  if (!convo) { alert('Could not open chat'); return; }
  current = convo;
  lastThreadKey = '';
  showPane('chatPane', title);
  await loadConvos();
  await refreshMessages();
}

function renderThread(list, title) {
  const key = list.map((m) => m.id).join(',');
  if (key === lastThreadKey) return;
  lastThreadKey = key;
  const thread = $('thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  thread.innerHTML = '';
  list.forEach((msg) => {
    const mine = msg.sender_id === me.id;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = mine ? 'flex-end' : 'flex-start';
    row.innerHTML = '<div class="bubble"><div class="meta">' + (mine ? 'You' : title) + '</div><div class="msg">' + String(msg.body || '').replace(/</g, '&lt;') + '</div></div>';
    thread.appendChild(row);
  });
  if (atBottom || !key) thread.scrollTop = thread.scrollHeight;
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

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const body = e.target.body.value.trim();
  if (!body) return;
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
  let res = await request(SUPABASE_URL + '/rest/v1/messages', {
    method: 'POST',
    headers: { ...headers(session.access_token), Prefer: 'return=minimal' },
    body: JSON.stringify(payload)
  }, 4000);
  if (!res.ok) {
    res = await request(SUPABASE_URL + '/rest/v1/rpc/post_message', {
      method: 'POST', headers: headers(session.access_token), body: JSON.stringify(payload)
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
    { urls: 'stun:stun.cloudflare.com:3478' }
  ] };
}

async function sendSignal(kind, payload) {
  if (!callState.call) return;
  await request(SUPABASE_URL + '/rest/v1/rpc/send_signal', {
    method: 'POST', headers: headers(session.access_token),
    body: JSON.stringify({ cid: callState.call.id, kind, payload })
  }, 4000);
}

function showLocalVideo() {
  $('videos').innerHTML = '';
  if (callState.stream) {
    const v = document.createElement('video');
    v.id = 'localVid'; v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = callState.stream;
    $('videos').appendChild(v);
  }
  let remote = $('remoteVid');
  if (!remote) {
    remote = document.createElement('video');
    remote.id = 'remoteVid'; remote.autoplay = true; remote.playsInline = true;
    $('videos').appendChild(remote);
  }
}

async function ensurePC() {
  if (callState.pc) return callState.pc;
  const pc = new RTCPeerConnection(iceServers());
  callState.pc = pc;
  if (callState.stream) callState.stream.getTracks().forEach((tr) => pc.addTrack(tr, callState.stream));
  pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal('ice', ev.candidate); };
  pc.ontrack = (ev) => {
    let remote = $('remoteVid');
    if (!remote) {
      remote = document.createElement('video');
      remote.id = 'remoteVid'; remote.autoplay = true; remote.playsInline = true;
      $('videos').appendChild(remote);
    }
    remote.srcObject = ev.streams[0];
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
  const pc = await ensurePC();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal('offer', offer);
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
  await ensurePC();
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
  if (callState.pc) { try { callState.pc.close(); } catch (_) {} }
  if (callState.stream) callState.stream.getTracks().forEach((tr) => tr.stop());
  callState = { pc: null, stream: null, call: null, otherId: null, incoming: null, seenSignals: new Set() };
  $('incoming').hidden = true;
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
  callState.incoming = null;
  $('incoming').hidden = true;
};
$('leaveVoiceBtn').addEventListener('click', () => { if (callState.call) hangUp(); });

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
      if (sig.kind === 'offer') {
        await pc.setRemoteDescription(sig.payload);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal('answer', answer);
        $('voiceTitle').textContent = 'In call';
      } else if (sig.kind === 'answer') {
        await pc.setRemoteDescription(sig.payload);
        $('voiceTitle').textContent = 'In call';
      } else if (sig.kind === 'ice' && sig.payload) {
        await pc.addIceCandidate(sig.payload);
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
  const ringing = list.find((c) => c.status === 'ringing' && c.callee === me.id);
  if (ringing && !callState.call) {
    callState.incoming = ringing;
    $('incomingText').textContent = 'Incoming call';
    $('incoming').hidden = false;
  }
  if (callState.call) {
    const live = list.find((c) => c.id === callState.call.id);
    if (live && live.status === 'ended') hangUp();
  }
}

setInterval(refreshMessages, 600);
setInterval(pollCalls, 1000);
setInterval(pullSignals, 500);
setInterval(() => { if (voice.channel) refreshVoicePeople(); }, 2500);

boot();
