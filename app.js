const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';

const GITHUB_OWNER = 'mokioonline';
const GITHUB_REPO = 'dev.mokio.online';
const PREVIEW_DIR = 'previews';

const headers = (token) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`
});

let session = null;
let profile = null;

function githubToken() {
  return localStorage.getItem('mokio_github_token') || '';
}

function canOpenDevSite(role) {
  return ['owner', 'dev', 'mod', 'tester'].includes(role);
}

function canSeeTester(role) {
  return ['owner', 'dev', 'tester'].includes(role);
}

function canSeeDevTools(role) {
  return ['owner', 'dev'].includes(role);
}

async function signInHere() {
  const note = document.getElementById('loginNote');
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  note.textContent = 'Signing in...';
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) {
    note.textContent = data.error_description || data.msg || data.error || 'Sign in failed';
    return;
  }
  localStorage.setItem('mokio_session', JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user
  }));
  location.reload();
}

async function boot() {
  try {
    session = JSON.parse(localStorage.getItem('mokio_session') || 'null');
  } catch (_) {}

  const app = document.getElementById('app');
  const who = document.getElementById('who');

  if (!session?.access_token) {
    who.textContent = 'Not signed in';
    app.innerHTML = `
      <div class="card" style="max-width:420px">
        <h3>Sign in</h3>
        <p class="muted">Use the same Mokio account. Testers, devs, and owners can enter.</p>
        <label>Email</label>
        <input id="loginEmail" type="email" placeholder="you@email.com">
        <label>Password</label>
        <input id="loginPassword" type="password" placeholder="Password">
        <div class="row">
          <button class="btn primary" id="loginBtn">Sign In</button>
        </div>
        <p class="muted" id="loginNote"></p>
      </div>`;
    document.getElementById('loginBtn').onclick = signInHere;
    return;
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: headers(session.access_token) });
  const user = userRes.ok ? await userRes.json() : session.user;
  const id = user?.id;
  const email = (user?.email || '').toLowerCase();

  let rows = [];
  if (id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}&select=email,role`, { headers: headers(session.access_token) });
    rows = await r.json();
  }
  if (!Array.isArray(rows) || !rows[0] && email) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=email,role`, { headers: headers(session.access_token) });
    rows = await r.json();
  }
  profile = Array.isArray(rows) ? rows[0] : null;
  const role = profile?.role || 'member';
  who.textContent = `${profile?.email || email || 'account'} · ${role}`;

  if (!canOpenDevSite(role)) {
    app.innerHTML = `<div class="card"><h3>No access</h3><p class="muted">Only tester, dev, mod, and owner can use this site.</p></div>`;
    return;
  }

  renderTabs(role);
  renderRoute(role);
  window.addEventListener('hashchange', () => renderRoute(role));
}

function renderTabs(role) {
  const tabs = document.getElementById('tabs');
  const items = [];
  if (canSeeTester(role)) items.push(['#tester', 'Tester view']);
  if (canSeeDevTools(role)) items.push(['#lab', 'Dev tools']);
  if (canSeeDevTools(role)) items.push(['#settings', 'GitHub']);
  tabs.innerHTML = items.map(([href, label]) => `<a href="${href}">${label}</a>`).join('');
}

function currentHash() {
  return location.hash || '#tester';
}

function renderRoute(role) {
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === currentHash().split('/')[0] || (currentHash().startsWith('#preview') && a.getAttribute('href') === '#tester'));
  });
  const hash = currentHash();
  if (hash.startsWith('#preview/')) return renderPreview(role, hash.replace('#preview/', ''));
  if (hash === '#lab') return renderLab(role);
  if (hash === '#settings') return renderSettings(role);
  return renderTester(role);
}

async function listPreviews() {
  const token = githubToken();
  if (!token) return { files: [], error: 'Add a GitHub token in Dev tools → GitHub.' };
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) return { files: [], error: `GitHub error ${res.status}. Check token, repo name, and access.` };
  const data = await res.json();
  const folders = (Array.isArray(data) ? data : []).filter((x) => x.type === 'dir');
  return { files: folders, error: '' };
}

async function renderTester(role) {
  const app = document.getElementById('app');
  if (!canSeeTester(role)) {
    app.innerHTML = `<p class="muted">No tester access.</p>`;
    return;
  }
  app.innerHTML = `<h1>Tester view</h1><p class="muted">Open uploaded pages as they would appear on a real site.</p><p>Loading...</p>`;
  const { files, error } = await listPreviews();
  if (error && !files.length) {
    app.innerHTML = `<h1>Tester view</h1><p class="warn">${error}</p>`;
    return;
  }
  if (!files.length) {
    app.innerHTML = `<h1>Tester view</h1><p class="muted">No preview pages yet. A dev needs to upload one first.</p>`;
    return;
  }
  app.innerHTML = `
    <h1>Tester view</h1>
    <p class="muted">Each card opens the page like a live website.</p>
    <div class="grid">
      ${files.map((f) => `
        <div class="card">
          <span class="badge">preview</span>
          <h3>${f.name}</h3>
          <div class="row">
            <a class="btn primary" href="#preview/${encodeURIComponent(f.name)}">Open as site</a>
            <a class="btn" href="${PREVIEW_DIR}/${f.name}/index.html" target="_blank" rel="noopener">New tab</a>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderPreview(role, slug) {
  if (!canSeeTester(role)) return;
  const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '');
  document.getElementById('app').innerHTML = `
    <p class="muted"><a href="#tester">← All previews</a></p>
    <h1>${safe}</h1>
    <iframe class="preview" src="${PREVIEW_DIR}/${safe}/index.html" title="${safe} preview"></iframe>`;
}

function renderLab(role) {
  const app = document.getElementById('app');
  if (!canSeeDevTools(role)) {
    app.innerHTML = `<p class="muted">Dev tools are for owner and dev only.</p>`;
    return;
  }
  app.innerHTML = `
    <h1>Dev tools</h1>
    <p class="muted">Upload HTML pages to GitHub. Testers can then open them as a real site.</p>
    <div class="card">
      <label>Page name (letters, numbers, dash)</label>
      <input id="pageName" placeholder="music-beta">
      <label>index.html</label>
      <textarea id="pageHtml"><!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Mokio page</title>
</head>
<body>
  <h1>New page</h1>
  <p>Edit this and upload.</p>
</body>
</html></textarea>
      <div class="row">
        <button class="btn primary" id="uploadBtn">Upload / update</button>
        <button class="btn" id="deleteBtn">Delete page</button>
      </div>
      <p class="muted" id="labNote"></p>
    </div>
    <div id="labList"></div>`;

  document.getElementById('uploadBtn').onclick = uploadPage;
  document.getElementById('deleteBtn').onclick = deletePage;
  refreshLabList();
}

async function refreshLabList() {
  const box = document.getElementById('labList');
  if (!box) return;
  const { files, error } = await listPreviews();
  box.innerHTML = error
    ? `<p class="warn">${error}</p>`
    : `<div class="grid" style="margin-top:20px">${files.map((f) => `<div class="card"><h3>${f.name}</h3><div class="row"><a class="btn" href="#preview/${f.name}">View</a></div></div>`).join('')}</div>`;
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

async function githubFileSha(path) {
  const token = githubToken();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

async function uploadPage() {
  const note = document.getElementById('labNote');
  const name = (document.getElementById('pageName').value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const html = document.getElementById('pageHtml').value;
  if (!githubToken()) { note.textContent = 'Add a GitHub token first.'; return; }
  if (!name) { note.textContent = 'Enter a page name.'; return; }
  note.textContent = 'Uploading to GitHub...';
  const path = `${PREVIEW_DIR}/${name}/index.html`;
  const sha = await githubFileSha(path);
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${githubToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: sha ? `Update preview ${name}` : `Add preview ${name}`,
      content: b64(html),
      sha: sha || undefined
    })
  });
  note.textContent = res.ok ? `Saved ${name}. Testers can open it after GitHub Pages refreshes.` : `Upload failed (${res.status}).`;
  refreshLabList();
}

async function deletePage() {
  const note = document.getElementById('labNote');
  const name = (document.getElementById('pageName').value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!name || !githubToken()) { note.textContent = 'Need a page name and GitHub token.'; return; }
  const path = `${PREVIEW_DIR}/${name}/index.html`;
  const sha = await githubFileSha(path);
  if (!sha) { note.textContent = 'Page not found.'; return; }
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${githubToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete preview ${name}`, sha })
  });
  note.textContent = res.ok ? `Deleted ${name}.` : `Delete failed (${res.status}).`;
  refreshLabList();
}

function renderSettings(role) {
  if (!canSeeDevTools(role)) return;
  document.getElementById('app').innerHTML = `
    <h1>GitHub connection</h1>
    <p class="muted">Devs upload pages into the <code>${GITHUB_OWNER}/${GITHUB_REPO}</code> repository. The token stays in your browser only — do not put it in the website files.</p>
    <div class="card">
      <label>GitHub personal access token (repo contents read/write)</label>
      <input id="ghToken" type="password" placeholder="github_pat_...">
      <div class="row"><button class="btn primary" id="saveToken">Save on this device</button></div>
      <p class="muted" id="tokenNote">${githubToken() ? 'A token is saved on this device.' : 'No token saved yet.'}</p>
    </div>`;
  document.getElementById('saveToken').onclick = () => {
    const value = document.getElementById('ghToken').value.trim();
    if (value) localStorage.setItem('mokio_github_token', value);
    else localStorage.removeItem('mokio_github_token');
    document.getElementById('tokenNote').textContent = value ? 'Saved on this device.' : 'Token removed.';
  };
}

boot();
