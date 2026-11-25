# Mark Box

A modern streaming-style web app for movies, series, anime and cartoons.

- **Movies**: today's top 10 and genre rows from Apple's catalog, with posters and official trailers that play in the app.
- **Series**: trending shows and new episodes on streaming services from TVmaze, with seasons, cast and links to the service that carries each show.
- **Anime**: this season's anime, top rated, most popular, anime movies and upcoming titles from MyAnimeList (via the Jikan API), with YouTube trailers and links to Crunchyroll, Netflix and others.
- **Free to watch**: full-length public-domain and Creative Commons films, cartoons and classic TV from the Internet Archive, streamed right in the app with resume, episode lists and auto-play next.

Also: hero carousel, category chips, search across every source, My List, Continue Watching, share links, a bottom tab bar on phones, and install-to-home-screen (PWA). No API keys, servers or build step needed.

Copyrighted titles are never streamed by the app; their detail pages link to legal services where you can watch them.

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
