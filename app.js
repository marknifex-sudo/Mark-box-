/* Mark Box — discover movies, series and anime; stream free public-domain and Creative Commons titles.
   Data sources (no API keys): Internet Archive (free streams), Apple iTunes (movies + trailers),
   TVmaze (series), Jikan / MyAnimeList (anime + trailers). */
(() => {
  "use strict";

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uniqBy = (arr, f) => { const s = new Set(); return arr.filter((x) => { const k = f(x); if (s.has(k)) return false; s.add(k); return true; }); };
  const toText = (html) => {
    const d = new DOMParser().parseFromString(String(first(html) || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n"), "text/html");
    return (d.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  };
  const fmtTime = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("markbox:" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("markbox:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  let toastTimer;
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200); };

  const memo = new Map();
  function cached(key, fn) {
    if (!memo.has(key)) { const p = fn(); memo.set(key, p); p.catch(() => memo.delete(key)); }
    return memo.get(key);
  }
  async function getJSON(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) { await sleep(900 * (i + 1)); continue; }
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }
    throw new Error("busy");
  }
  let jsonpN = 0;
  function jsonp(url, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const cb = "__mb" + ++jsonpN, s = document.createElement("script");
      const done = () => { delete window[cb]; s.remove(); clearTimeout(t); };
      const t = setTimeout(() => { done(); reject(new Error("timeout")); }, timeout);
      window[cb] = (d) => { done(); resolve(d); };
      s.onerror = () => { done(); reject(new Error("jsonp")); };
      s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
      document.head.append(s);
    });
  }
  const justWatch = (title) => ({ name: "Find where to stream", url: `https://www.justwatch.com/us/search?q=${encodeURIComponent(title)}` });
  const ytSearch = (title) => `https://www.youtube.com/results?search_query=${encodeURIComponent(title + " official trailer")}`;

  // ================= Providers =================
  // Each item: { key, src, id, title, year, poster, desc, genres[], rating, free, sub[], ... }

  // ---------- Internet Archive: free full-length streams ----------
  const IA = "https://archive.org";
  const IA_BASE = "mediatype:(movies) AND -subject:(trailer) AND -title:(trailer)";
  const ia = {
    thumb: (id) => `${IA}/services/img/${encodeURIComponent(id)}`,
    file: (id, name) => `${IA}/download/${encodeURIComponent(id)}/${name.split("/").map(encodeURIComponent).join("/")}`,
    item(d) {
      return { key: "ia:" + d.identifier, src: "ia", id: d.identifier, title: first(d.title) || d.identifier, year: first(d.year) || "",
        poster: ia.posterFor(d.identifier), desc: d.description, genres: [].concat(d.subject || []).slice(0, 5), free: true,
        sub: [first(d.year), "Free"].filter(Boolean) };
    },
    async list(q, page = 1, rows = 30, sort = "downloads desc") {
      const p = new URLSearchParams({ q: `(${q}) AND ${IA_BASE}`, rows, page, output: "json" });
      ["identifier", "title", "year", "description", "subject"].forEach((f) => p.append("fl[]", f));
      if (sort) p.append("sort[]", sort);
      const j = await cached("ia:" + p, () => getJSON(`${IA}/advancedsearch.php?${p}`));
      const docs = j.response?.docs || [];
      return { items: docs.map(ia.item), more: page * rows < (j.response?.numFound || 0) };
    },
    meta: (id) => cached("iam:" + id, () => getJSON(`${IA}/metadata/${encodeURIComponent(id)}`)),
    // Real posters: many items ship a cover image; fall back to the archive's auto thumbnail.
    posters: store.get("posters", {}),
    posterFor(id) { return ia.posters[id] || ia.thumb(id); },
    bigImage(meta) {
      const imgs = (meta.files || []).filter((f) => f.source === "original" && /\.(jpe?g|png|webp)$/i.test(f.name) && !/thumb|__ia|screenshot/i.test(f.name) && +f.size > 15000);
      const score = (f) => (/poster|cover|folder|one.?sheet/i.test(f.name) ? 1e9 : 0) + (+f.size || 0);
      imgs.sort((a, b) => score(b) - score(a));
      return imgs[0] ? ia.file(meta.metadata.identifier, imgs[0].name) : null;
    },
    videos(meta) {
      const score = (f) => {
        const fmt = (f.format || "").toLowerCase();
        if (fmt === "h.264") return 9; if (fmt === "h.264 ia") return 8; if (fmt === "mpeg4") return 7;
        if (fmt === "h.264 hd") return 6; if (fmt === "512kb mpeg4") return 5;
        if (/\.(mp4|m4v)$/i.test(f.name)) return 4; if (/\.webm$/i.test(f.name)) return 3; if (/\.ogv$/i.test(f.name)) return 2;
        return 0;
      };
      const best = new Map();
      for (const f of meta.files || []) {
        const s = score(f);
        if (!s || /(^|\/)\.|__ia_thumb|sample/i.test(f.name)) continue;
        const key = f.source === "derivative" && f.original ? f.original : f.name;
        const cur = best.get(key);
        if (!cur || s > cur.s) best.set(key, { s, f, key });
      }
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      return [...best.values()].sort((a, b) => coll.compare(a.key, b.key)).map(({ f, key }) => ({
        name: f.name, url: ia.file(meta.metadata.identifier, f.name),
        label: f.title || key.split("/").pop().replace(/\.[a-z0-9]+$/i, "").replace(/_+/g, " ").trim(),
        length: parseFloat(f.length) || 0,
      }));
    },
    async details(it) {
      const meta = await ia.meta(it.id);
      const md = meta.metadata || {};
      const big = ia.bigImage(meta);
      if (big) ia.savePoster(it.id, big);
      const vids = ia.videos(meta);
      Object.assign(it, {
        title: first(md.title) || it.title, year: it.year || first(md.year) || String(first(md.date) || "").slice(0, 4),
        desc: toText(md.description) || "No description available.", poster: big || it.poster,
        genres: [].concat(md.subject || []).flatMap((s) => String(s).split(/[;,]/)).map((s) => s.trim()).filter(Boolean).slice(0, 6),
        runtime: first(md.runtime) || "", creator: first(md.creator) || "", language: first(md.language) || "",
        videos: vids, free: true,
        links: [{ name: "Internet Archive page", url: `${IA}/details/${encodeURIComponent(it.id)}` }],
      });
      return it;
    },
    savePoster(id, url) {
      if (ia.posters[id] === url) return;
      ia.posters[id] = url;
      const keys = Object.keys(ia.posters);
      if (keys.length > 600) keys.slice(0, keys.length - 600).forEach((k) => delete ia.posters[k]);
      store.set("posters", ia.posters);
    },
  };
  // Upgrade archive thumbnails to real cover art for cards as they scroll into view.
  const posterQueue = []; let posterActive = 0;
  function pumpPosters() {
    while (posterActive < 4 && posterQueue.length) {
      const { id, img } = posterQueue.shift();
      posterActive++;
      ia.meta(id).then((m) => { const big = ia.bigImage(m); if (big) { ia.savePoster(id, big); swapImg(img, big); } })
        .catch(() => {}).finally(() => { posterActive--; pumpPosters(); });
    }
  }
  const posterObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      posterObserver.unobserve(e.target);
      const id = e.target.dataset.ia;
      if (!ia.posters[id]) { posterQueue.push({ id, img: e.target.querySelector("img") }); pumpPosters(); }
    });
  }, { rootMargin: "200px" }) : null;
  function swapImg(img, url) {
    if (!img) return;
    const pre = new Image();
    pre.onload = () => { img.src = url; img.classList.add("ok"); };
    pre.src = url;
  }

  // ---------- Apple iTunes: current movies, artwork and trailers ----------
  const MV_GENRES = { action: 4401, anime: 4402, comedy: 4404, documentary: 4405, drama: 4406, horror: 4408, kids: 4410, romance: 4412, scifi: 4413, thriller: 4416 };
  const MV_TERMS = { action: "action", comedy: "comedy", documentary: "documentary", drama: "drama", horror: "horror", kids: "animated family", romance: "romance", scifi: "science fiction", thriller: "thriller", anime: "anime" };
  const upscale = (u, size = "600x900") => (u ? u.replace(/\/\d+x\d+[a-z]*(-\d+)?\.(jpg|png|webp)$/i, `/${size}bb.jpg`) : "");
  const mv = {
    fromEntry(e) {
      const links = [].concat(e.link || []);
      const prev = links.find((l) => l.attributes?.["im:assetType"] === "preview");
      const imgs = [].concat(e["im:image"] || []);
      const id = e.id?.attributes?.["im:id"];
      const genre = e.category?.attributes?.label || "";
      const year = (e["im:releaseDate"]?.label || "").slice(0, 4);
      return { key: "mv:" + id, src: "mv", id, title: e["im:name"]?.label || "", year, poster: upscale(imgs.at(-1)?.label),
        desc: e.summary?.label || "", genres: genre ? [genre] : [], preview: prev?.attributes?.href || "", url: e.id?.label || "",
        sub: [year, genre].filter(Boolean) };
    },
    fromResult(r) {
      const year = (r.releaseDate || "").slice(0, 4);
      return { key: "mv:" + r.trackId, src: "mv", id: String(r.trackId), title: r.trackName, year, poster: upscale(r.artworkUrl100),
        desc: r.longDescription || r.shortDescription || "", genres: r.primaryGenreName ? [r.primaryGenreName] : [], preview: r.previewUrl || "",
        url: r.trackViewUrl || "", rated: r.contentAdvisoryRating || "", runtime: r.trackTimeMillis ? fmtTime(r.trackTimeMillis / 1000) : "",
        director: r.artistName || "", release: r.releaseDate || "", sub: [year, r.primaryGenreName].filter(Boolean) };
    },
    top(genre) {
      return cached("mvtop:" + (genre || ""), async () => {
        const url = `https://itunes.apple.com/us/rss/topmovies/limit=50${genre ? `/genre=${MV_GENRES[genre]}` : ""}/json`;
        let entries = null;
        try { entries = (await getJSON(url, 1)).feed?.entry; } catch {
          try { entries = (await jsonp(url, 6000)).feed?.entry; } catch { /* fall through */ }
        }
        if (entries && [].concat(entries).length) return [].concat(entries).map(mv.fromEntry).filter((x) => x.id && x.title);
        // Fallback: search by genre term, newest first.
        const res = await mv.search(genre ? MV_TERMS[genre] : "new movie");
        return res.sort((a, b) => (b.release || "").localeCompare(a.release || ""));
      });
    },
    async search(term) {
      const j = await cached("mvs:" + term, () => jsonp(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=movie&entity=movie&limit=50&country=us`));
      return uniqBy((j.results || []).filter((r) => r.trackId && r.artworkUrl100).map(mv.fromResult), (x) => x.id);
    },
    async details(it) {
      try {
        const j = await cached("mvl:" + it.id, () => jsonp(`https://itunes.apple.com/lookup?id=${it.id}&country=us`));
        const r = (j.results || [])[0];
        if (r) { const full = mv.fromResult(r); Object.keys(full).forEach((k) => { if (full[k] && (!it[k] || (Array.isArray(it[k]) && !it[k].length))) it[k] = full[k]; }); if (full.desc.length > (it.desc || "").length) it.desc = full.desc; }
      } catch { /* keep feed data */ }
      it.links = [it.url && { name: "Rent or buy on Apple TV", url: it.url }, justWatch(it.title)].filter(Boolean);
      return it;
    },
  };

  // ---------- TVmaze: series ----------
  const TVM = "https://api.tvmaze.com";
  const tv = {
    item(s) {
      const net = (s.webChannel || s.network)?.name || "";
      return { key: "tv:" + s.id, src: "tv", id: String(s.id), title: s.name, year: (s.premiered || "").slice(0, 4), poster: s.image?.original || s.image?.medium || "",
        desc: toText(s.summary), genres: s.genres || [], rating: s.rating?.average || null, weight: s.weight || 0, type: s.type,
        network: net, site: s.officialSite || "", url: s.url, status: s.status, sub: [(s.premiered || "").slice(0, 4), net].filter(Boolean) };
    },
    ok: (s) => s && s.image && ["Scripted", "Animation", "Documentary", "Reality"].includes(s.type),
    pool() {
      return cached("tvpool", async () => {
        const day = (n) => { const d = new Date(Date.now() - n * 864e5); return d.toLocaleDateString("en-CA"); };
        const urls = [0, 1, 2, 3].map((n) => `${TVM}/schedule/web?date=${day(n)}`).concat([`${TVM}/schedule?country=US&date=${day(0)}`, `${TVM}/schedule?country=GB&date=${day(0)}`]);
        const res = await Promise.allSettled(urls.map((u) => getJSON(u)));
        const shows = res.flatMap((r, i) => (r.status === "fulfilled" ? r.value : []).map((ep) => ({ show: ep._embedded?.show || ep.show, web: i < 4 })));
        const map = new Map();
        shows.forEach(({ show, web }) => { if (tv.ok(show) && !map.has(show.id)) map.set(show.id, { ...tv.item(show), web }); });
        if (!map.size) throw new Error("no shows");
        return [...map.values()].sort((a, b) => b.weight - a.weight || (b.rating || 0) - (a.rating || 0));
      });
    },
    favorites() {
      return cached("tvfav", async () => {
        const pages = await Promise.allSettled([0, 1, 2].map((p) => getJSON(`${TVM}/shows?page=${p}`)));
        return pages.flatMap((p) => (p.status === "fulfilled" ? p.value : [])).filter(tv.ok).map(tv.item)
          .filter((s) => (s.rating || 0) >= 7.6).sort((a, b) => b.weight - a.weight || b.rating - a.rating);
      });
    },
    async search(q) { return (await getJSON(`${TVM}/search/shows?q=${encodeURIComponent(q)}`)).map((r) => r.show).filter((s) => s.image).map(tv.item); },
    async details(it) {
      const s = await cached("tvd:" + it.id, () => getJSON(`${TVM}/shows/${it.id}?embed[]=seasons&embed[]=cast`));
      Object.assign(it, tv.item(s));
      it.seasons = (s._embedded?.seasons || []).filter((x) => x.episodeOrder || x.premiereDate);
      it.cast = (s._embedded?.cast || []).slice(0, 12).map((c) => ({ name: c.person?.name, role: c.character?.name, img: c.character?.image?.medium || c.person?.image?.medium }));
      it.links = [it.site && { name: it.network ? `Watch on ${it.network}` : "Official site", url: it.site }, justWatch(it.title), { name: "TVmaze page", url: it.url }].filter(Boolean);
      return it;
    },
  };

  // ---------- Jikan (MyAnimeList): anime ----------
  const JK = "https://api.jikan.moe/v4";
  let jkChain = Promise.resolve();
  function jk(path) { // Jikan allows ~3 requests/second; serialize calls.
    return cached("jk:" + path, () => {
      const p = jkChain.then(() => getJSON(JK + path, 4));
      jkChain = p.catch(() => {}).then(() => sleep(420));
      return p;
    });
  }
  const ytId = (t) => t && (t.youtube_id || (t.embed_url || "").match(/embed\/([\w-]{11})/)?.[1] || (t.url || "").match(/v=([\w-]{11})/)?.[1]) || "";
  const an = {
    item(a) {
      const year = a.year || a.aired?.prop?.from?.year || "";
      return { key: "anime:" + a.mal_id, src: "anime", id: String(a.mal_id), title: a.title_english || a.title, alt: a.title_english ? a.title : "", year,
        poster: a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "",
        desc: (a.synopsis || "").replace(/\[Written by MAL Rewrite\]/g, "").trim(), genres: [...(a.genres || []), ...(a.themes || [])].map((g) => g.name),
        rating: a.score || null, trailer: ytId(a.trailer), url: a.url, type: a.type, episodes: a.episodes, status: a.status,
        studios: (a.studios || []).map((s) => s.name).join(", "), sub: [year, a.type, a.episodes ? `${a.episodes} eps` : ""].filter(Boolean) };
    },
    async list(path, page = 1) {
      const j = await jk(`${path}${path.includes("?") ? "&" : "?"}page=${page}`);
      return { items: uniqBy((j.data || []).map(an.item), (x) => x.id).filter((x) => x.poster), more: !!j.pagination?.has_next_page };
    },
    async details(it) {
      const a = (await jk(`/anime/${it.id}/full`)).data;
      Object.assign(it, an.item(a));
      it.links = [...(a.streaming || []).map((s) => ({ name: `Watch on ${s.name}`, url: s.url })), justWatch(it.title), { name: "MyAnimeList page", url: a.url }];
      return it;
    },
  };

  const PROVIDERS = { ia, mv, tv, anime: an };

  // ================= Rows =================
  const fromList = (p) => p.then((items) => ({ items, more: false }));
  const tvGenre = (g) => () => fromList(tv.pool().then((l) => l.filter((s) => s.genres.includes(g))));
  const IA_Q = {
    trending: "collection:(feature_films)",
    noir: "collection:(film_noir) OR (collection:(feature_films) AND subject:(\"film noir\" OR noir))",
    scifi: "collection:(feature_films) AND subject:(\"sci-fi\" OR \"science fiction\" OR monster)",
    horror: "collection:(feature_films) AND subject:(horror)",
    comedy: "collection:(feature_films) AND subject:(comedy)",
    silent: "collection:(silent_films)",
    cartoons: "collection:(classic_cartoons)",
    animation: "collection:(animationandcartoons) AND -collection:(classic_cartoons)",
    tv: "collection:(classic_tv)",
    open: "(title:(sintel OR \"big buck bunny\" OR \"tears of steel\" OR \"elephants dream\" OR \"cosmos laundromat\" OR \"sprite fright\" OR caminandes OR \"agent 327\" OR \"coffee run\" OR \"charge\") AND (subject:(blender) OR creator:(blender) OR description:(blender)))",
  };
  const iaRow = (q, sort) => (page = 1) => ia.list(q, page, 30, sort);
  const anRow = (path) => (page = 1) => an.list(path, page);
  const mvRow = (g) => () => fromList(mv.top(g));

  const ROWS = {
    top10:      { title: "Top 10 Movies Today", top10: true, load: () => fromList(mv.top().then((l) => l.slice(0, 10))) },
    mvPopular:  { title: "Popular Movies", load: () => fromList(mv.top().then((l) => l.slice(10))) },
    mvAction:   { title: "Action & Adventure", load: mvRow("action"), chip: "Action" },
    mvComedy:   { title: "Comedy Movies", load: mvRow("comedy"), chip: "Comedy" },
    mvDrama:    { title: "Drama", load: mvRow("drama"), chip: "Drama" },
    mvThriller: { title: "Thrillers", load: mvRow("thriller"), chip: "Thriller" },
    mvHorror:   { title: "Horror", load: mvRow("horror"), chip: "Horror" },
    mvScifi:    { title: "Sci-Fi & Fantasy", load: mvRow("scifi"), chip: "Sci-Fi" },
    mvKids:     { title: "Kids & Family", load: mvRow("kids"), chip: "Kids & Family" },
    mvRomance:  { title: "Romance", load: mvRow("romance"), chip: "Romance" },
    mvDocs:     { title: "Documentaries", load: mvRow("documentary"), chip: "Documentary" },
    mvAnime:    { title: "Anime Films", load: mvRow("anime") },

    tvTrending: { title: "Trending Series", load: () => fromList(tv.pool().then((l) => l.slice(0, 40))) },
    tvWeb:      { title: "New Episodes on Streaming", load: () => fromList(tv.pool().then((l) => l.filter((s) => s.web).slice(0, 40))) },
    tvDrama:    { title: "Drama Series", load: tvGenre("Drama") },
    tvComedy:   { title: "Comedy Series", load: tvGenre("Comedy") },
    tvCrime:    { title: "Crime Series", load: tvGenre("Crime"), chip: "Crime Series" },
    tvScifi:    { title: "Sci-Fi Series", load: tvGenre("Science-Fiction") },
    tvToons:    { title: "Animated Series", load: () => fromList(tv.pool().then((l) => l.filter((s) => s.type === "Animation" || s.genres.includes("Anime") || s.genres.includes("Children")))) },
    tvFav:      { title: "All-Time Favorite Series", load: () => fromList(tv.favorites()) },

    anAiring:   { title: "Airing Anime This Season", load: anRow("/seasons/now?sfw=true&limit=24"), chip: "Anime" },
    anTop:      { title: "Top Rated Anime", load: anRow("/top/anime?limit=24") },
    anPopular:  { title: "Most Popular Anime", load: anRow("/top/anime?filter=bypopularity&limit=24") },
    anMovies:   { title: "Anime Movies", load: anRow("/top/anime?type=movie&limit=24") },
    anUpcoming: { title: "Coming Soon", load: anRow("/seasons/upcoming?sfw=true&limit=24") },
    anAction:   { title: "Action Anime", load: anRow("/anime?genres=1&order_by=members&sort=desc&sfw=true&limit=24") },
    anRomance:  { title: "Romance Anime", load: anRow("/anime?genres=22&order_by=members&sort=desc&sfw=true&limit=24") },
    anFantasy:  { title: "Fantasy Worlds", load: anRow("/anime?genres=10&order_by=members&sort=desc&sfw=true&limit=24") },

    freeMovies: { title: "Free Movies: Stream Full Length", load: iaRow(IA_Q.trending), chip: "Free Movies", free: true },
    freeOpen:   { title: "Free Modern Animated Shorts", load: iaRow(IA_Q.open), free: true },
    freeToons:  { title: "Free Classic Cartoons", load: iaRow(IA_Q.cartoons), chip: "Classic Cartoons", free: true },
    freeAnim:   { title: "Free Animation", load: iaRow(IA_Q.animation), free: true },
    freeNoir:   { title: "Free Film Noir", load: iaRow(IA_Q.noir), free: true },
    freeScifi:  { title: "Free Sci-Fi & Monster Movies", load: iaRow(IA_Q.scifi), free: true },
    freeHorror: { title: "Free Horror Classics", load: iaRow(IA_Q.horror), free: true },
    freeComedy: { title: "Free Comedy Classics", load: iaRow(IA_Q.comedy), free: true },
    freeSilent: { title: "Free Silent Films", load: iaRow(IA_Q.silent), free: true },
    freeTV:     { title: "Free Classic TV", load: iaRow(IA_Q.tv), free: true },
  };

  const VIEWS = {
    home:      ["continue", "top10", "tvTrending", "anAiring", "freeMovies", "mvAction", "anPopular", "tvWeb", "freeToons", "mvComedy", "anTop", "tvCrime", "mvKids", "freeOpen", "mvHorror", "anMovies", "mvScifi", "tvFav", "freeNoir"],
    movies:    ["top10", "mvPopular", "mvAction", "mvComedy", "mvThriller", "mvDrama", "mvScifi", "mvHorror", "mvKids", "mvRomance", "mvDocs", "freeMovies", "freeNoir", "freeSilent"],
    series:    ["continue", "tvTrending", "tvWeb", "tvDrama", "tvComedy", "tvCrime", "tvScifi", "tvToons", "tvFav", "freeTV"],
    anime:     ["anAiring", "anPopular", "anTop", "anAction", "anFantasy", "anRomance", "anMovies", "anUpcoming", "mvAnime"],
    animation: ["mvKids", "tvToons", "anMovies", "freeOpen", "freeToons", "freeAnim", "mvAnime"],
    free:      ["continue", "freeMovies", "freeOpen", "freeToons", "freeScifi", "freeHorror", "freeNoir", "freeComedy", "freeAnim", "freeTV", "freeSilent"],
  };
  const HERO_FROM = { home: ["top10", "anAiring", "tvTrending", "freeMovies"], movies: ["top10"], series: ["tvTrending"], anime: ["anAiring", "anPopular"], animation: ["mvKids", "anMovies"], free: ["freeMovies", "freeToons"] };
  const CHIPS = ["mvAction", "mvComedy", "anAiring", "mvHorror", "mvScifi", "mvKids", "tvCrime", "mvDrama", "mvRomance", "freeMovies", "freeToons", "mvDocs", "mvThriller"];

  // ================= Personal state =================
  const slim = (it) => ({ key: it.key, src: it.src, id: it.id, title: it.title, year: it.year, poster: it.poster, free: !!it.free, rating: it.rating || null, sub: it.sub || [] });
  const legacy = (x) => (x.key ? x : { ...x, key: "ia:" + x.id, src: "ia", poster: ia.posterFor(x.id), free: true });
  const myList = () => store.get("list", []).map(legacy);
  const inList = (key) => myList().some((x) => x.key === key);
  function toggleList(it) {
    let l = myList();
    if (inList(it.key)) { l = l.filter((x) => x.key !== it.key); toast("Removed from My List"); }
    else { l.unshift(slim(it)); toast("Added to My List"); }
    store.set("list", l);
    if (state.view === "mylist") showMyList();
  }
  const progress = () => Object.fromEntries(Object.values(store.get("progress", {})).map((e) => { const x = legacy(e); return [x.key, x]; }));
  function saveProgress(it, file, t, d) {
    const p = progress();
    p[it.key] = { ...slim(it), file, t, d, ts: Date.now() };
    store.set("progress", Object.fromEntries(Object.values(p).sort((a, b) => b.ts - a.ts).slice(0, 40).map((e) => [e.key, e])));
  }
  const continueItems = () => Object.values(progress()).filter((e) => e.d && e.t / e.d > 0.02 && e.t / e.d < 0.95).sort((a, b) => b.ts - a.ts);

  // ================= Cards =================
  function genPoster(it) {
    const h = hash(it.title) % 360;
    return `<div class="gen" style="background:linear-gradient(160deg,hsl(${h} 48% 34%),hsl(${(h + 50) % 360} 52% 12%))">${esc(it.title)}${it.year ? `<small>${esc(it.year)}</small>` : ""}</div>`;
  }
  function card(it, { rank } = {}) {
    const b = el("button", "card");
    b.type = "button";
    b.setAttribute("aria-label", `${it.title}${it.year ? ", " + it.year : ""}${it.free ? ", free to watch" : ""}`);
    const pr = progress()[it.key];
    const poster = `<div class="poster">${genPoster(it)}${it.poster ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}${it.free ? `<span class="chip free badge">Free</span>` : ""}${it.rating ? `<span class="rate">${Number(it.rating).toFixed(1)}</span>` : ""}${pr && pr.d ? `<div class="bar" style="width:${Math.min(100, (pr.t / pr.d) * 100).toFixed(1)}%"></div>` : ""}</div>`;
    const text = `<div class="t">${esc(it.title)}</div><div class="s">${esc((it.sub || []).filter(Boolean).join(" · "))}</div>`;
    b.innerHTML = rank ? `<span class="num" aria-hidden="true">${rank}</span><div class="stack">${poster}${text}</div>` : poster + text;
    const img = b.querySelector("img");
    if (img) {
      img.onload = () => img.classList.add("ok");
      img.onerror = () => img.remove();
      img.src = it.poster;
    }
    if (it.src === "ia" && posterObserver && !ia.posters[it.id]) { b.dataset.ia = it.id; posterObserver.observe(b); }
    b.addEventListener("click", () => openDetails(it));
    return b;
  }

  // ================= Rows rendering =================
  const state = { view: "home", token: null, hero: [], heroIdx: 0, heroTimer: null };

  const rowObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { rowObserver.unobserve(e.target); e.target._load?.(); } });
  }, { rootMargin: "700px 0px" }) : null;

  function rowShell(def) {
    const sec = el("section", "row");
    const head = el("div", "row-head", `<h2>${esc(def.title)}${def.small ? `<small>${esc(def.small)}</small>` : ""}</h2>`);
    if (def.more) { const m = el("button", null, "See all ›"); m.type = "button"; m.onclick = def.more; head.append(m); }
    const wrap = el("div", "rail-wrap");
    const rail = el("div", "rail" + (def.top10 ? " top10" : ""));
    for (let i = 0; i < 8; i++) rail.append(el("div", "skel"));
    const l = el("button", "rail-btn l", "‹"), r = el("button", "rail-btn r", "›");
    l.setAttribute("aria-label", "Scroll left"); r.setAttribute("aria-label", "Scroll right");
    l.onclick = () => rail.scrollBy({ left: -rail.clientWidth * 0.85, behavior: "smooth" });
    r.onclick = () => rail.scrollBy({ left: rail.clientWidth * 0.85, behavior: "smooth" });
    wrap.append(l, rail, r);
    sec.append(head, wrap);
    return { sec, rail };
  }

  function renderRows(keys, { heroFrom = [] } = {}) {
    const host = $("#rows");
    host.innerHTML = "";
    const token = (state.token = Symbol());
    keys.forEach((key, i) => {
      if (key === "continue") {
        const items = continueItems();
        if (!items.length) return;
        const { sec, rail } = rowShell({ title: "Continue Watching" });
        rail.innerHTML = "";
        items.forEach((it) => rail.append(card(it)));
        host.append(sec);
        return;
      }
      const def = typeof key === "string" ? ROWS[key] : key;
      if (!def) return;
      const { sec, rail } = rowShell({ ...def, more: def.top10 || def.noMore ? null : () => showGrid(def) });
      host.append(sec);
      sec._load = () => def.load(1).then(({ items }) => {
        if (token !== state.token) return;
        if (!items.length) { sec.remove(); return; }
        rail.innerHTML = "";
        items.forEach((it, n) => rail.append(card(it, { rank: def.top10 ? n + 1 : 0 })));
        if (heroFrom.includes(key)) addHero(items.filter((x) => x.poster).slice(0, key === "top10" ? 3 : 2));
      }).catch(() => { if (token === state.token) sec.remove(); });
      // Load the first rows (and hero sources) right away; the rest as they approach the viewport.
      if (i < 4 || heroFrom.includes(key) || !rowObserver) sec._load(); else rowObserver.observe(sec);
    });
  }

  // ================= Hero carousel =================
  function resetHero() {
    clearInterval(state.heroTimer);
    state.hero = []; state.heroIdx = 0;
    $("#heroDots").innerHTML = "";
    $("#heroTitle").textContent = "Finding something great…";
    $("#heroMeta").textContent = ""; $("#heroDesc").textContent = "";
    $("#heroBadges").innerHTML = `<span class="chip skeleton-text">Loading</span>`;
    $("#heroBg").style.backgroundImage = ""; $("#heroPoster").style.backgroundImage = "";
    $("#heroPlay").disabled = $("#heroInfo").disabled = true;
  }
  function addHero(items) {
    const had = state.hero.length;
    state.hero = uniqBy(state.hero.concat(items), (x) => x.key).slice(0, 8);
    renderDots();
    if (!had && state.hero.length) showHero(0);
    if (!state.heroTimer && state.hero.length > 1) state.heroTimer = setInterval(() => { if (!document.hidden && $("#modal").hidden && $("#player").hidden) showHero((state.heroIdx + 1) % state.hero.length); }, 8000);
  }
  function renderDots() {
    const d = $("#heroDots");
    d.innerHTML = "";
    if (state.hero.length < 2) return;
    state.hero.forEach((it, i) => {
      const b = el("button"); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-label", it.title);
      b.className = i === state.heroIdx ? "on" : "";
      b.onclick = () => { showHero(i); clearInterval(state.heroTimer); state.heroTimer = null; };
      d.append(b);
    });
  }
  function badgesFor(it) {
    const b = [];
    if (it.free) b.push(`<span class="chip free">Free · Full length</span>`);
    else if (it.src === "anime") b.push(`<span class="chip hot">Anime</span>`);
    else if (it.src === "tv") b.push(`<span class="chip hot">Series</span>`);
    else if (it.src === "mv") b.push(`<span class="chip hot">Movie</span>`);
    if (it.rating) b.push(`<span class="chip">★ ${Number(it.rating).toFixed(1)}</span>`);
    if (it.rated) b.push(`<span class="chip">${esc(it.rated)}</span>`);
    return b.join("");
  }
  const metaLine = (it) => [it.year, it.runtime, it.type && it.src === "anime" ? it.type : "", it.episodes ? `${it.episodes} episodes` : "", it.network, ...(it.genres || []).slice(0, 2)]
    .filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("");
  function primaryAction(it) {
    if (it.free) return { label: "Play", fn: () => play(it) };
    if (it.trailer || it.preview) return { label: "Trailer", fn: () => playTrailer(it) };
    return { label: "Details", fn: () => openDetails(it) };
  }
  function showHero(i) {
    const it = state.hero[i];
    if (!it) return;
    state.heroIdx = i;
    const c = $("#heroContent");
    c.classList.add("swap"); void c.offsetWidth; c.classList.remove("swap");
    $("#heroBadges").innerHTML = badgesFor(it);
    $("#heroTitle").textContent = it.title;
    $("#heroMeta").innerHTML = metaLine(it);
    $("#heroDesc").textContent = toText(it.desc).slice(0, 360);
    const bg = `url("${it.poster}")`;
    $("#heroBg").style.backgroundImage = bg;
    $("#heroPoster").style.backgroundImage = bg;
    const act = primaryAction(it);
    $("#heroPlay").disabled = $("#heroInfo").disabled = false;
    $("#heroPlay").className = "btn " + (it.free ? "btn-free" : "btn-primary");
    $("#heroPlay span").textContent = act.label;
    $("#heroPlay").onclick = act.fn;
    $("#heroInfo").onclick = () => openDetails(it);
    [...$("#heroDots").children].forEach((d, n) => d.classList.toggle("on", n === i));
  }

  // ================= Grid views =================
  function showGrid(def) {
    setMode("grid");
    $("#gridTitle").textContent = def.title;
    const body = $("#gridBody"), more = $("#gridMore");
    body.innerHTML = "";
    for (let i = 0; i < 18; i++) body.append(el("div", "skel"));
    let page = 1;
    const token = (state.token = Symbol());
    const seen = new Set();
    const load = async () => {
      more.hidden = true;
      try {
        const { items, more: hasMore } = await def.load(page);
        if (token !== state.token) return;
        if (page === 1) body.innerHTML = "";
        items.filter((x) => !seen.has(x.key)).forEach((x) => { seen.add(x.key); body.append(card(x)); });
        if (!body.children.length) body.innerHTML = `<p class="empty">Nothing here yet. Try another category.</p>`;
        more.hidden = !hasMore;
      } catch {
        if (token === state.token && page === 1) body.innerHTML = `<p class="empty">Couldn't load this list. Check your connection and try again.</p>`;
      }
    };
    more.onclick = () => { page++; load(); };
    window.scrollTo({ top: 0 });
    load();
  }
  function showMyList() {
    setMode("grid");
    state.token = Symbol();
    $("#gridTitle").textContent = "My List";
    $("#gridMore").hidden = true;
    const body = $("#gridBody");
    body.innerHTML = "";
    const l = myList();
    if (!l.length) body.innerHTML = `<p class="empty">Your list is empty. Open any title and tap “My List” to save it here.</p>`;
    l.forEach((it) => body.append(card(it)));
  }
  function setMode(mode) {
    $("#hero").hidden = mode !== "rows";
    $("#chipsBar").hidden = mode !== "rows";
    $("#rows").hidden = mode === "grid";
    $("#rows").style.paddingTop = mode === "search" ? "calc(env(safe-area-inset-top, 0px) + 96px)" : "";
    $("#grid").hidden = mode !== "grid";
    if (mode !== "rows") clearInterval(state.heroTimer), (state.heroTimer = null);
  }

  // ================= Details =================
  let current = null;
  async function openDetails(base) {
    const it = { ...base };
    current = it;
    fillDetails(it, true);
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
    $(".modal-x").focus();
    try {
      await PROVIDERS[it.src].details(it);
      if (current === it) fillDetails(it, false);
    } catch {
      if (current === it) { if (!it.desc) $("#mDesc").textContent = "Couldn't load full details right now."; fillWhere(it); }
    }
  }
  function fillDetails(it, loading) {
    $("#mTitle").textContent = it.title;
    $("#mBadges").innerHTML = badgesFor(it);
    $("#mMeta").innerHTML = metaLine(it) + (it.alt && it.alt !== it.title ? `<span>${esc(it.alt)}</span>` : "");
    $("#mDesc").textContent = toText(it.desc) || (loading ? "Loading details…" : "No description available.");
    const bg = it.poster ? `url("${it.poster}")` : "";
    $("#mBg").style.backgroundImage = bg; $("#mPoster").style.backgroundImage = bg;
    $("#mGenres").innerHTML = (it.genres || []).slice(0, 8).map((g) => `<span>${esc(g)}</span>`).join("");

    const acts = $("#mActions");
    acts.innerHTML = "";
    const add = (cls, html, fn) => { const b = el("button", "btn " + cls, html); b.type = "button"; b.onclick = fn; acts.append(b); return b; };
    const playIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>`;
    if (it.free) {
      const pr = progress()[it.key];
      const resume = pr && pr.d && pr.t > 30 && pr.t / pr.d < 0.95;
      const b = add("btn-free", `${playIcon}<span>${resume ? `Resume ${fmtTime(pr.t)}` : "Play free"}</span>`, () => play(it));
      if (!loading && it.videos && !it.videos.length) b.disabled = true;
    } else if (it.trailer || it.preview) {
      add("btn-primary", `${playIcon}<span>Watch trailer</span>`, () => playTrailer(it));
    } else if (!loading) {
      const a = el("a", "btn btn-primary", `${playIcon}<span>Find trailer</span>`); a.href = ytSearch(it.title); a.target = "_blank"; a.rel = "noopener"; acts.append(a);
    }
    const lb = add("btn-glass", "", () => { toggleList(it); syncList(); });
    const syncList = () => (lb.innerHTML = inList(it.key) ? "✓ In My List" : "+ My List");
    syncList();
    add("btn-glass", "Share", () => shareItem(it));

    $("#mExtra").innerHTML = "";
    $("#mWhere").innerHTML = "";
    if (loading) return;
    fillWhere(it);
    const extra = $("#mExtra");
    if (it.src === "ia" && it.videos?.length > 1) {
      extra.append(el("h3", "section-t", `Episodes &amp; parts · ${it.videos.length}`));
      const list = el("div", "ep-list");
      it.videos.forEach((v, i) => {
        const b = el("button", "ep", `<b>${i + 1}</b><span>${esc(v.label)}</span>${v.length ? `<small>${fmtTime(v.length)}</small>` : ""}`);
        b.onclick = () => play(it, i);
        list.append(b);
      });
      extra.append(list);
    }
    if (it.src === "ia" && it.videos && !it.videos.length) extra.append(el("p", "note", "This title has no video file that plays in the browser. Open its Internet Archive page above to see what's available."));
    if (it.src === "tv" && it.seasons?.length) {
      extra.append(el("h3", "section-t", `Seasons · ${it.seasons.length}`));
      const list = el("div", "ep-list");
      it.seasons.forEach((s) => list.append(el("div", "ep", `<b>${s.number}</b><span>Season ${s.number}${s.name ? ` · ${esc(s.name)}` : ""}</span><small>${s.episodeOrder ? `${s.episodeOrder} eps` : ""}${s.premiereDate ? ` · ${s.premiereDate.slice(0, 4)}` : ""}</small>`)));
      extra.append(list);
    }
    if (it.cast?.length) {
      extra.append(el("h3", "section-t", "Cast"));
      extra.append(el("div", "cast", it.cast.map((c) => `<div><i style="${c.img ? `background-image:url('${esc(c.img)}')` : ""}"></i>${esc(c.name)}<small>${esc(c.role || "")}</small></div>`).join("")));
    }
    if (it.src === "anime" && it.studios) extra.append(el("p", "note", `Studio: ${esc(it.studios)}${it.status ? ` · ${esc(it.status)}` : ""}`));
    if (it.src === "mv" && it.director) extra.append(el("p", "note", `Directed by ${esc(it.director)}${it.release ? ` · Released ${new Date(it.release).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}` : ""}`));
  }
  function fillWhere(it) {
    const links = it.links || (it.src === "ia" ? [] : [justWatch(it.title)]);
    if (!links.length) return;
    const w = $("#mWhere");
    w.innerHTML = "";
    w.append(el("h3", "section-t", it.free ? "More info" : "Where to watch"));
    const box = el("div", "where");
    links.forEach((l) => { const a = el("a", "btn btn-glass btn-sm", esc(l.name)); a.href = l.url; a.target = "_blank"; a.rel = "noopener"; box.append(a); });
    w.append(box);
  }
  function shareItem(it) {
    const url = `${location.origin}${location.pathname}#title-${it.src}-${encodeURIComponent(it.id)}`;
    const done = () => toast("Link copied");
    if (navigator.share) { navigator.share({ title: it.title, url }).catch(() => {}); return; }
    navigator.clipboard?.writeText(url).then(done, () => toast(url));
  }
  function closeDetails() {
    $("#modal").hidden = true; document.body.style.overflow = ""; current = null;
    if (location.hash.startsWith("#title-")) history.replaceState(null, "", "#" + state.view);
  }

  // ================= Player =================
  const video = $("#video"), yt = $("#yt");
  let playing = null; // { it, vids, idx }
  let lastSave = 0;
  function openPlayer(title, sub) {
    closeDetails();
    $("#player").hidden = false;
    document.body.style.overflow = "hidden";
    $("#pTitle").textContent = title; $("#pSub").textContent = sub || "";
    $("#pEpisodes").hidden = true; $("#pEpisodesBtn").hidden = true;
    video.hidden = false; yt.hidden = true; yt.removeAttribute("src");
    video.removeAttribute("src"); video.load();
    status("Loading…");
  }
  async function play(base, idx) {
    const it = { ...base };
    openPlayer(it.title, "");
    try {
      if (!it.videos) await ia.details(it);
      const vids = it.videos;
      if (!vids.length) throw new Error("no video");
      const pr = progress()[it.key];
      if (idx == null) idx = Math.max(0, pr ? vids.findIndex((v) => v.name === pr.file) : 0);
      playing = { it, vids, idx };
      buildEpisodePanel();
      loadVideo(pr && pr.file === vids[idx].name && pr.t / (pr.d || 1) < 0.95 ? pr.t : 0);
    } catch {
      status(`This title can't be streamed here. <a href="${IA}/details/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Open on archive.org</a>`);
    }
  }
  function playTrailer(it) {
    openPlayer(it.title, "Official trailer");
    playing = null;
    if (it.trailer) {
      video.hidden = true; yt.hidden = false; status("");
      yt.src = `https://www.youtube-nocookie.com/embed/${it.trailer}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
    } else if (it.preview) {
      video.src = it.preview;
      video.play().catch(() => status(""));
    } else status(`No trailer available. <a href="${ytSearch(it.title)}" target="_blank" rel="noopener">Search YouTube</a>`);
  }
  function loadVideo(startAt = 0) {
    const { it, vids, idx } = playing;
    const v = vids[idx];
    $("#pSub").textContent = vids.length > 1 ? `${idx + 1} / ${vids.length} · ${v.label}` : (it.year ? String(it.year) : "");
    status("Loading…");
    video.src = v.url;
    video.onloadedmetadata = () => { if (startAt > 5 && startAt < video.duration - 10) video.currentTime = startAt; };
    video.play().catch(() => status(""));
    document.querySelectorAll(".p-episodes .ep").forEach((b, i) => b.classList.toggle("on", i === idx));
  }
  function buildEpisodePanel() {
    const panel = $("#pEpisodes");
    panel.innerHTML = "";
    if (playing.vids.length < 2) return;
    $("#pEpisodesBtn").hidden = false;
    playing.vids.forEach((v, i) => {
      const b = el("button", "ep", `<b>${i + 1}</b><span>${esc(v.label)}</span>`);
      b.onclick = () => { playing.idx = i; loadVideo(0); panel.hidden = true; };
      panel.append(b);
    });
  }
  function status(html) { const s = $("#pStatus"); s.innerHTML = html; s.hidden = !html; }
  video.addEventListener("playing", () => status(""));
  video.addEventListener("waiting", () => status("Buffering…"));
  video.addEventListener("error", () => {
    if (!video.getAttribute("src")) return;
    status(playing ? `This video won't play in your browser. <a href="${IA}/details/${encodeURIComponent(playing.it.id)}" target="_blank" rel="noopener">Open on archive.org</a>` : "This trailer isn't available right now.");
  });
  video.addEventListener("timeupdate", () => {
    if (!playing || !video.duration) return;
    const now = Date.now();
    if (now - lastSave > 4000) { lastSave = now; saveProgress(playing.it, playing.vids[playing.idx].name, video.currentTime, video.duration); }
  });
  video.addEventListener("ended", () => {
    if (!playing) return;
    saveProgress(playing.it, playing.vids[playing.idx].name, video.duration, video.duration);
    if (playing.idx < playing.vids.length - 1) { playing.idx++; loadVideo(0); toast("Playing next"); }
  });
  let idleTimer;
  $("#player").addEventListener("pointermove", () => { $("#player").classList.remove("idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => $("#player").classList.add("idle"), 2800); });
  function closePlayer() {
    if (playing && video.duration) saveProgress(playing.it, playing.vids[playing.idx].name, video.currentTime, video.duration);
    video.pause(); video.removeAttribute("src"); video.load();
    yt.removeAttribute("src");
    const wasFree = !!playing;
    playing = null;
    $("#player").hidden = true;
    document.body.style.overflow = "";
    if (wasFree && VIEWS[state.view]?.includes("continue")) route();
  }

  // ================= Search =================
  function runSearch(term) {
    setMode("search");
    const q = term.replace(/[^\p{L}\p{N}\s'.:-]/gu, " ").trim();
    if (!q) return;
    const iaQ = `(title:(${q}) OR creator:(${q}) OR subject:(${q})) AND (collection:(feature_films) OR collection:(classic_tv) OR collection:(classic_cartoons) OR collection:(silent_films) OR collection:(film_noir) OR collection:(animationandcartoons))`;
    const rows = [
      { title: `Movies matching “${term}”`, load: () => fromList(mv.search(q)) },
      { title: "Series", load: () => fromList(tv.search(q)) },
      { title: "Anime", load: (page = 1) => an.list(`/anime?q=${encodeURIComponent(q)}&sfw=true&limit=24&order_by=members&sort=desc`, page) },
      { title: "Free to watch now", load: (page = 1) => ia.list(iaQ, page, 30) },
    ];
    renderRows(rows);
    // Tell the viewer if nothing came back anywhere.
    const token = state.token;
    setTimeout(() => { if (token === state.token && !$("#rows").children.length) $("#rows").innerHTML = `<p class="note" style="text-align:center;padding:40px 16px">No results for “${esc(term)}”. Check the spelling or try a different title.</p>`; }, 9000);
  }

  // ================= Navigation =================
  function renderChips() {
    const bar = $("#chipsBar");
    bar.innerHTML = "";
    CHIPS.forEach((k) => { const d = ROWS[k]; const b = el("button", null, esc(d.chip)); b.type = "button"; b.onclick = () => showGrid(d); bar.append(b); });
  }
  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (h.startsWith("title-")) {
      const [, src, ...rest] = h.split("-");
      const id = rest.join("-");
      if (!$("#rows").children.length) renderView("home");
      if (PROVIDERS[src] && id) openDetails({ key: `${src}:${id}`, src, id, title: "Loading…", genres: [], free: src === "ia" });
      return;
    }
    if (h.startsWith("search-")) {
      state.view = "search";
      const term = h.slice(7).replace(/-/g, " ");
      $("#searchInput").value = term;
      markNav();
      return runSearch(term);
    }
    renderView(VIEWS[h] || h === "mylist" ? h : "home");
  }
  function renderView(view) {
    state.view = view;
    markNav();
    closeDetails();
    if (view === "mylist") return showMyList();
    setMode("rows");
    resetHero();
    renderRows(VIEWS[view], { heroFrom: HERO_FROM[view] });
    window.scrollTo({ top: 0 });
  }
  function markNav() { document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === state.view)); }

  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const term = $("#searchInput").value.trim();
    if (!term) return;
    const slug = "#search-" + encodeURIComponent(term.replace(/\s+/g, "-"));
    if (location.hash === slug) route(); else location.hash = slug;
    $("#searchInput").blur();
  });
  document.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", (e) => {
    if (location.hash === a.getAttribute("href")) { e.preventDefault(); renderView(a.dataset.nav); }
  }));
  $("#gridBack").onclick = () => route();
  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", () => $("#topbar").classList.toggle("solid", window.scrollY > 30), { passive: true });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDetails));
  $("#pBack").onclick = closePlayer;
  $("#pEpisodesBtn").onclick = () => { $("#pEpisodes").hidden = !$("#pEpisodes").hidden; };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("#player").hidden) closePlayer(); else if (!$("#modal").hidden) closeDetails(); }
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); $("#searchInput").focus(); }
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

  renderChips();
  route();
})();
