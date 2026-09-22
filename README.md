# Mokio — GitHub Pages site

Upload this folder to GitHub. Database is Supabase (not in this repo).

## Upload

1. Create a repo (or use an existing one).
2. Upload every file **except** you may not be able to drag `.github` (GitHub blocks hidden folders).
3. On GitHub: **Add file → Create new file**
4. Name it exactly: `.github/workflows/pages.yml`
5. Paste the contents of `pages.yml` from this folder (same file is also at `.github/workflows/pages.yml` if you use git).
6. Commit.

## Secrets

Repo → **Settings → Secrets and variables → Actions** — add all four:

| Secret | From |
|---|---|
| `VITE_USER_SUPABASE_URL` | Users Supabase → Settings → API → Project URL |
| `VITE_USER_SUPABASE_ANON_KEY` | Users project → anon public |
| `VITE_MOKIO_SUPABASE_URL` | Messaging Supabase → Project URL |
| `VITE_MOKIO_SUPABASE_ANON_KEY` | Messaging project → anon public |

## Pages

**Settings → Pages → Source: GitHub Actions**

Then **Actions** → wait for **Deploy to GitHub Pages** (green).

Site: `https://YOUR_USER.github.io/YOUR_REPO/`

Put that URL in **both** Supabase projects → Authentication → URL configuration (Site URL + Redirect URLs).
