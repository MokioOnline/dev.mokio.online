const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let me = null;
let currentConvo = null;

async function boot() {
  const { data: { user } } = await db.auth.getUser();
  me = user;
  if (!me) return;
  $('gate').hidden = true;
  $('composer').hidden = false;
  $('me').textContent = me.email;
  loadConvos();
}

$('loginBtn').onclick = async () => {
  $('loginNote').textContent = 'Signing in...';
  const { data, error } = await db.auth.signInWithPassword({
    email: $('loginEmail').value.trim(),
    password: $('loginPassword').value
  });
  if (error) {
    $('loginNote').textContent = error.message;
    return;
  }
  if (!data.user) {
    $('loginNote').textContent = 'Sign in failed';
    return;
  }
  location.reload();
};

$('startChat').onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return;
  const email = e.target.email.value.trim().toLowerCase();
  const { data: other } = await db.from('profiles').select('id,email').eq('email', email).maybeSingle();
  if (!other) {
    alert('No Mokio account with that email.');
    return;
  }
  const { data: existing } = await db.from('conversations')
    .select('*')
    .or(`and(user_a.eq.${me.id},user_b.eq.${other.id}),and(user_a.eq.${other.id},user_b.eq.${me.id})`)
    .maybeSingle();
  let convo = existing;
  if (!convo) {
    const { data, error } = await db.from('conversations').insert({ user_a: me.id, user_b: other.id }).select().single();
    if (error) { alert(error.message); return; }
    convo = data;
  }
  e.target.reset();
  await loadConvos();
  openConvo(convo, other.email);
};

async function loadConvos() {
  const { data } = await db.from('conversations').select('*').or(`user_a.eq.${me.id},user_b.eq.${me.id}`).order('created_at', { ascending: false });
  $('convos').innerHTML = '';
  for (const convo of data || []) {
    const otherId = convo.user_a === me.id ? convo.user_b : convo.user_a;
    const { data: other } = await db.from('profiles').select('email').eq('id', otherId).maybeSingle();
    const item = document.createElement('div');
    item.className = 'convo';
    item.textContent = other?.email || 'Chat';
    item.onclick = () => openConvo(convo, item.textContent);
    $('convos').appendChild(item);
  }
}

async function openConvo(convo, title) {
  currentConvo = convo;
  $('chatTop').textContent = title;
  const { data } = await db.from('messages').select('*').eq('conversation_id', convo.id).order('created_at');
  const thread = $('thread');
  thread.innerHTML = '';
  (data || []).forEach((msg) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (msg.sender_id === me.id ? ' mine' : '');
    bubble.textContent = msg.body;
    thread.appendChild(bubble);
  });
  thread.scrollTop = thread.scrollHeight;
}

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentConvo) return;
  const body = e.target.body.value.trim();
  if (!body) return;
  const { error } = await db.from('messages').insert({
    conversation_id: currentConvo.id,
    sender_id: me.id,
    body
  });
  if (error) { alert(error.message); return; }
  e.target.reset();
  openConvo(currentConvo, $('chatTop').textContent);
};

boot();
