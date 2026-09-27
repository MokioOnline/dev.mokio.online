# Mokio Dev (dev.mokio.online)

Upload this whole folder to the GitHub repo that hosts **dev.mokio.online**.

## Structure
- `index.html` — sign-in (owner and tester only)
- `messages/` — the site users see after they sign in
- `CNAME` — `dev.mokio.online`

## After sign-in
Allowed users are sent to `messages/main.html`.

To change the app they land on, replace the files inside `messages/`.
Keep `messages/main.html` as the entry file, or change `NEXT_PAGE` in `app.js`.

## GitHub Pages
Settings → Pages → Deploy from branch `main` → folder `/ (root)`
