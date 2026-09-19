const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null;
let currentConvo = null;

const $ = (id) => document.getElementById(id);

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const saved = localStorage.getItem('mokio_session');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed?.refresh_token) {
        await supabase.auth.setSession({
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token
        });
      }
    }
  }
  const { data: { user } } = await supabase.auth.getUser();
  me = user;
  if (!me) return;

  $('gate').hidden = true;
  $('composer').hidden = false;
  $('me').textContent = me.email;
  await loadConvos();
}

$('loginBtn').onclick = async () => {
  $('loginNote').textContent = 'Signing in...';
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $('loginEmail').value.trim(),
    password: $('loginPassword').value
  });
  if (error) {
    $('loginNote').textContent = error.message;
    return;
  }
  localStorage.setItem('mokio_session', JSON.stringify({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: data.user
  }));
  location.reload();
};

$('startChat').onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return;
  const email = e.target.email.value.trim().toLowerCase();
  const { data: other } = await supabase.from('profiles').select('id,email').eq('email', email).maybeSingle();
  if (!other) {
    alert('No Mokio account with that email.');
    return;
  }
  if (other.id === me.id) return;

  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .or(`and(user_a.eq.${me.id},user_b.eq.${other.id}),and(user_a.eq.${other.id},user_b.eq.${me.id})`)
    .maybeSingle();

  let convo = existing;
  if (!convo) {
    const { data, error } = await supabase.from('conversations').insert({
      user_a: me.id,
      user_b: other.id
    }).select().single();
    if (error) {
      alert(error.message);
      return;
    }
    convo = data;
  }
  e.target.reset();
  await loadConvos();
  openConvo(convo, other.email);
};

async function loadConvos() {
  const { data } = await supabase
    .from('conversations')
    .select('*')
    .or(`user_a.eq.${me.id},user_b.eq.${me.id}`)
    .order('created_at', { ascending: false });

  const box = $('convos');
  box.innerHTML = '';
  for (const convo of data || []) {
    const otherId = convo.user_a === me.id ? convo.user_b : convo.user_a;
    const { data: other } = await supabase.from('profiles').select('email').eq('id', otherId).maybeSingle();
    const item = document.createElement('div');
    item.className = 'convo';
    item.textContent = other?.email || 'Unknown';
    item.onclick = () => openConvo(convo, other?.email || 'Chat');
    box.appendChild(item);
  }
}

async function openConvo(convo, title) {
  currentConvo = convo;
  $('chatTop').textContent = title;
  document.querySelectorAll('.convo').forEach((el) => {
    el.classList.toggle('active', el.textContent === title);
  });
  await loadMessages();
}

async function loadMessages() {
  if (!currentConvo) return;
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', currentConvo.id)
    .order('created_at', { ascending: true });
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
  const { error } = await supabase.from('messages').insert({
    conversation_id: currentConvo.id,
    sender_id: me.id,
    body
  });
  if (error) {
    alert(error.message);
    return;
  }
  e.target.reset();
  await loadMessages();
};

boot();
