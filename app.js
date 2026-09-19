const SUPABASE_URL = 'https://gmncuelonmicdbpuacqi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_u09NHV7z9E-2CJ0tvQ8IvQ_xcSXfs0F';
const GITHUB_OWNER = 'mokioonline';
const GITHUB_REPO = 'dev.mokio.online';
const PREVIEW_DIR = 'previews';

const apiHeaders = (token) => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`
});

let session = null;
let profile = null;

const ghToken = () => localStorage.getItem('mokio_github_token') || '';
const canSeeApp = (role) => ['owner', 'dev', 'tester'].includes(role);
const isDev = (role) => ['owner', 'dev'].includes(role);
const CURRENT_APP = 'current';

async function signInHere() {
  const note = document.getElementById('loginNote');
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  note.textContent = 'Signing in...';
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) {
    note.textContent = data.error_description || data.error || 'Sign in failed';
    return;
  }
  localStorage.setItem('mokio_session', JSON.stringify({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user
  }));
  location.reload();
}

function loginScreen() {
  document.getElementById('who').textContent = 'Not signed in';
  document.getElementById('app').innerHTML = `
    <h1>Mokio Dev Lab</h1>
    <p class="muted">Sign in to import projects, store them on GitHub, and preview them like a live site.</p>
    <div class="card" style="max-width:440px">
      <label>Email</label>
      <input id="loginEmail" type="email" placeholder="you@email.com">
      <label>Password</label>
      <input id="loginPassword" type="password">
      <div class="row"><button class="btn primary" id="loginBtn">Sign In</button></div>
      <p class="muted" id="loginNote"></p>
    </div>`;
  document.getElementById('loginBtn').onclick = signInHere;
}

async function boot() {
  try { session = JSON.parse(localStorage.getItem('mokio_session') || 'null'); } catch (_) {}
  if (!session?.access_token) return loginScreen();

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: apiHeaders(session.access_token) });
  const user = userRes.ok ? await userRes.json() : session.user;
  const email = (user?.email || '').toLowerCase();

  let profileRes = null;
  if (user?.id) {
    profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=email,role`, { headers: apiHeaders(session.access_token) });
  }
  let rows = profileRes && profileRes.ok ? await profileRes.json() : [];
  if (!Array.isArray(rows) || !rows[0]) {
    profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=email,role`, { headers: apiHeaders(session.access_token) });
    rows = profileRes.ok ? await profileRes.json() : [];
  }

  profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile?.role) {
    document.getElementById('who').textContent = email || 'signed in';
    document.getElementById('app').innerHTML = `
      <div class="card">
        <h3>Role not found in database</h3>
        <p class="muted">This site uses the <code>profiles.role</code> column in Supabase. No role row was found for ${email || 'this account'}.</p>
        <p class="muted">In Supabase → Table Editor → profiles, set this email to owner, dev, or tester.</p>
      </div>`;
    return;
  }

  const role = String(profile.role).toLowerCase().trim();
  document.getElementById('who').textContent = `${profile.email || email} · ${role}`;

  if (!canSeeApp(role)) {
    document.getElementById('app').innerHTML = `
      <div class="card">
        <h3>No access</h3>
        <p class="muted">Database role is <strong>${role}</strong>. Only owner, dev, and tester can open the app in development.</p>
      </div>`;
    return;
  }

  const tabs = [];
  tabs.push(['#preview/current', 'Current app']);
  if (isDev(role)) tabs.push(['#lab', 'Import / edit']);
  if (isDev(role)) tabs.push(['#settings', 'GitHub token']);
  document.getElementById('tabs').innerHTML = tabs.map(([h, l]) => `<a href="${h}">${l}</a>`).join('');

  const go = () => {
    const hash = location.hash || '#preview/current';
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', hash.startsWith(a.getAttribute('href'))));
    if (hash.startsWith('#preview/')) return showPreview(role, hash.replace('#preview/', ''));
    if (hash.startsWith('#edit/')) return showEditor(role, hash.replace('#edit/', ''));
    if (hash === '#settings') return showSettings();
    if (hash === '#lab') return showLab(role);
    return showTester(role);
  };
  window.onhashchange = go;
  if (!location.hash) location.hash = '#preview/current';
  go();
}

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json' };
  if (ghToken()) h.Authorization = `Bearer ${ghToken()}`;
  return h;
}

async function listProjects() {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}`, { headers: ghHeaders() });
  if (!res.ok) return { items: [], error: `GitHub ${res.status}. If this repo is private, save a GitHub token.` };
  const data = await res.json();
  return { items: (Array.isArray(data) ? data : []).filter((x) => x.type === 'dir'), error: '' };
}

async function showTester(role) {
  if (!canSeeApp(role)) return;
  const app = document.getElementById('app');
  app.innerHTML = `<h1>Tester view</h1><p class="muted">Open imported projects as a real site.</p><p>Loading...</p>`;
  const { items, error } = await listProjects();
  if (error) { app.innerHTML = `<h1>Tester view</h1><p class="warn">${error}</p>`; return; }
  if (!items.length) { app.innerHTML = `<h1>Tester view</h1><p class="muted">No projects yet. A dev needs to import one.</p>`; return; }
  app.innerHTML = `<h1>Tester view</h1>
    <p class="muted">Only signed-in testers, devs, and owners can open these previews.</p>
    <div class="grid">${items.map((p) => `<div class="card"><span class="badge">project</span><h3>${p.name}</h3>
      <div class="row">
        <a class="btn primary" href="#preview/${p.name}">Open preview</a>
      </div></div>`).join('')}</div>`;
}

async function showPreview(role, name) {
  if (!canSeeApp(role)) {
    document.getElementById('app').innerHTML = `<div class="card"><h3>No access</h3><p class="muted">Only owner, dev, and tester can view the app in development.</p></div>`;
    return;
  }
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  document.getElementById('app').innerHTML = `<p class="muted"><a href="#tester">← Projects</a></p><h1>${safe}</h1><p>Loading preview...</p>`;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}/${safe}/index.html`, { headers: ghHeaders() });
  if (!res.ok) {
    document.getElementById('app').innerHTML = `<p class="muted"><a href="#tester">← Projects</a></p><p class="warn">Could not load preview (${res.status}).</p>`;
    return;
  }
  const data = await res.json();
  const html = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  const framed = html.replace(/<head[^>]*>/i, (m) => `${m}<base href="./">`);
  document.getElementById('app').innerHTML = `
    <p class="muted"><a href="#tester">← Projects</a></p>
    <h1>${safe}</h1>
    <iframe class="preview" id="previewFrame" title="${safe}"></iframe>`;
  const iframe = document.getElementById('previewFrame');
  iframe.srcdoc = framed;
}

function showLab(role) {
  if (!isDev(role)) return;
  document.getElementById('app').innerHTML = `
    <h1>Import a project</h1>
    <p class="muted">Choose a project name, then import HTML/CSS/JS files. They are saved to GitHub in <code>${PREVIEW_DIR}/your-project/</code>.</p>
    <div class="card">
      <label>Project name</label>
      <input id="projectName" placeholder="music-beta">
      <label>Import files (index.html, styles.css, script.js, images...)</label>
      <input id="projectFiles" type="file" multiple>
      <p class="muted">Include an <code>index.html</code> so testers can open it like a website.</p>
      <div class="row">
        <button class="btn primary" id="importBtn">Import to GitHub</button>
        <button class="btn" id="deleteBtn">Delete project</button>
      </div>
      <p id="labNote" class="muted"></p>
    </div>
    <h2 style="margin:28px 0 12px">Projects on GitHub</h2>
    <div id="projectList">Loading...</div>`;
  document.getElementById('importBtn').onclick = importProject;
  document.getElementById('deleteBtn').onclick = deleteProject;
  refreshProjects();
}

async function refreshProjects() {
  const box = document.getElementById('projectList');
  if (!box) return;
  const { items, error } = await listProjects();
  if (error) { box.innerHTML = `<p class="warn">${error}</p>`; return; }
  if (!items.length) { box.innerHTML = `<p class="muted">Nothing uploaded yet.</p>`; return; }
  box.innerHTML = `<div class="grid">${items.map((p) => `<div class="card"><h3>${p.name}</h3>
    <div class="row">
      <a class="btn primary" href="#edit/${p.name}">Edit files</a>
      <a class="btn" href="#preview/${p.name}">Preview</a>
    </div></div>`).join('')}</div>`;
}

async function showEditor(role, name) {
  if (!isDev(role)) {
    document.getElementById('app').innerHTML = `<p class="warn">Only owners and devs can edit files.</p>`;
    return;
  }
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '');
  const app = document.getElementById('app');
  app.innerHTML = `<p class="muted"><a href="#lab">← Projects</a></p><h1>Edit ${safe}</h1><p>Loading files...</p>`;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}/${safe}`, { headers: ghHeaders() });
  if (!res.ok) {
    app.innerHTML = `<p class="muted"><a href="#lab">← Projects</a></p><p class="warn">Could not load files (${res.status}). You need a GitHub token.</p>`;
    return;
  }
  const files = (await res.json()).filter((f) => f.type === 'file');
  app.innerHTML = `
    <p class="muted"><a href="#lab">← Projects</a></p>
    <h1>Edit ${safe}</h1>
    <div class="card">
      <label>File</label>
      <select id="filePick">${files.map((f) => `<option value="${f.name}">${f.name}</option>`).join('')}</select>
      <label>File contents</label>
      <textarea id="fileEditor"></textarea>
      <div class="row">
        <button class="btn primary" id="saveFile">Save to GitHub</button>
        <button class="btn" id="deleteFile">Delete this file</button>
      </div>
      <p class="muted" id="editNote"></p>
    </div>`;

  async function loadSelected() {
    const fileName = document.getElementById('filePick').value;
    const fileRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}/${safe}/${fileName}`, { headers: ghHeaders() });
    const data = await fileRes.json();
    try {
      document.getElementById('fileEditor').value = decodeURIComponent(escape(atob((data.content || '').replace(/\n/g, ''))));
    } catch (_) {
      document.getElementById('fileEditor').value = '';
      document.getElementById('editNote').textContent = 'This file is not plain text.';
    }
  }

  document.getElementById('filePick').onchange = loadSelected;
  if (files.length) loadSelected();

  document.getElementById('saveFile').onclick = async () => {
    const fileName = document.getElementById('filePick').value;
    const text = document.getElementById('fileEditor').value;
    document.getElementById('editNote').textContent = 'Saving...';
    const resSave = await putFile(`${PREVIEW_DIR}/${safe}/${fileName}`, b64(text), `Edit ${fileName} in ${safe}`);
    document.getElementById('editNote').textContent = resSave.ok ? 'Saved to GitHub.' : `Save failed (${resSave.status}).`;
  };

  document.getElementById('deleteFile').onclick = async () => {
    const fileName = document.getElementById('filePick').value;
    const path = `${PREVIEW_DIR}/${safe}/${fileName}`;
    const sha = await githubSha(path);
    if (!sha) return;
    const del = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete ${fileName} from ${safe}`, sha })
    });
    document.getElementById('editNote').textContent = del.ok ? 'File deleted.' : `Delete failed (${del.status}).`;
    if (del.ok) showEditor(role, safe);
  };
}

function b64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function githubSha(path) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

async function putFile(path, contentB64, message) {
  const sha = await githubSha(path);
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, content: contentB64, sha: sha || undefined })
  });
  return res;
}

async function importProject() {
  const note = document.getElementById('labNote');
  const name = (document.getElementById('projectName').value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const files = [...(document.getElementById('projectFiles').files || [])];
  if (!ghToken()) { note.textContent = 'Save a GitHub token first.'; return; }
  if (!name) { note.textContent = 'Enter a project name.'; return; }
  if (!files.length) { note.textContent = 'Choose at least one file.'; return; }
  note.textContent = `Uploading ${files.length} file(s) to GitHub...`;
  let ok = 0;
  for (const file of files) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '');
    const path = `${PREVIEW_DIR}/${name}/${safeName}`;
    const content = await fileToB64(file);
    const res = await putFile(path, content, `Import ${safeName} into ${name}`);
    if (res.ok) ok += 1;
    else note.textContent = `Failed on ${file.name} (${res.status}).`;
  }
  if (ok) note.textContent = `Saved ${ok} file(s) to previews/${name}/ on GitHub. Testers can open it after Pages refreshes.`;
  refreshProjects();
}

async function deleteProject() {
  const note = document.getElementById('labNote');
  const name = (document.getElementById('projectName').value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!name || !ghToken()) { note.textContent = 'Need a project name and GitHub token.'; return; }
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${PREVIEW_DIR}/${name}`, {
    headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json' }
  });
  if (!res.ok) { note.textContent = 'Project folder not found.'; return; }
  const files = await res.json();
  for (const file of (Array.isArray(files) ? files : [])) {
    if (file.type !== 'file') continue;
    await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${file.path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete ${file.path}`, sha: file.sha })
    });
  }
  note.textContent = `Deleted ${name}.`;
  refreshProjects();
}

function showSettings() {
  document.getElementById('app').innerHTML = `
    <h1>GitHub token</h1>
    <p class="muted">Needed so this site can write files into <code>${GITHUB_OWNER}/${GITHUB_REPO}</code>. The token stays in your browser only.</p>
    <div class="card">
      <label>Personal access token (Contents: Read and write)</label>
      <input id="ghTokenInput" type="password" placeholder="github_pat_...">
      <div class="row"><button class="btn primary" id="saveToken">Save on this device</button></div>
      <p class="muted" id="tokenNote">${ghToken() ? 'A token is already saved on this device.' : 'No token saved yet.'}</p>
    </div>`;
  document.getElementById('saveToken').onclick = () => {
    const value = document.getElementById('ghTokenInput').value.trim();
    if (value) localStorage.setItem('mokio_github_token', value);
    else localStorage.removeItem('mokio_github_token');
    document.getElementById('tokenNote').textContent = value ? 'Saved.' : 'Removed.';
  };
}

boot();
