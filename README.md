# Mark Box

A movie and TV streaming web app. Browse rows by genre, search, open a title for details, and watch in a full-screen player with **My List**, **Continue Watching** (resumes where you stopped) and episode lists for series.

All content streams from the Internet Archive's public-domain and freely licensed collections (feature films, film noir, silent films, classic cartoons, classic TV), so it is free and legal to watch. No API keys, servers or build step needed.

It can also be installed on a phone's home screen like an app (it's a PWA).

## Go live with GitHub Pages

1. Open the repository on GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
3. Pick the branch that holds these files (for example `main`) and the `/ (root)` folder, then **Save**.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` – page structure
- `styles.css` – design
- `app.js` – library browsing, search, details, player, My List, progress
- `sw.js`, `manifest.json`, `icon.svg` – install-as-app support
