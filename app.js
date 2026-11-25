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
        name: "ia:" + meta.metadata.identifier + "/" + f.name, url: ia.file(meta.metadata.identifier, f.name), direct: true,
        label: f.title || key.split("/").pop().replace(/\.[a-z0-9]+$/i, "").replace(/_+/g, " ").trim(),
        length: parseFloat(f.length) || 0,
      })).map((v) => ({ ...v, offlineUrl: v.url, download: v.url }));
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

  // ---------- Jellyfin: the viewer's own library ----------
  const deviceId = store.get("device", null) || (() => { const id = "mb-" + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("device", id); return id; })();
  const jf = {
    cfg: store.get("jellyfin", null), // { server, token, userId, user, serverName }
    on: () => !!(jf.cfg && jf.cfg.token),
    authHeader(token) {
      return `MediaBrowser Client="Mark Box", Device="${(navigator.userAgentData?.platform || "Browser").replace(/"/g, "")}", DeviceId="${deviceId}", Version="3.0"${token ? `, Token="${token}"` : ""}`;
    },
    async api(path, opts = {}) {
      const r = await fetch(jf.cfg.server + path, { ...opts, headers: { Authorization: jf.authHeader(jf.cfg.token), "Content-Type": "application/json", ...(opts.headers || {}) } });
      if (r.status === 401) { jf.signOut(); toast("Your library sign-in expired. Connect again in Settings."); throw new Error("401"); }
      if (!r.ok) throw new Error(r.status);
      return r.status === 204 ? null : r.json().catch(() => null);
    },
    async login(server, username, pw) {
      server = server.trim().replace(/\/+$/, "").replace(/\/web(\/.*)?$/, "");
      if (!/^https?:\/\//i.test(server)) server = "https://" + server;
      if (location.protocol === "https:" && /^http:\/\//i.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(server))
        throw new Error("This address starts with http://, which browsers block on a secure page. Use an https address, for example from Tailscale (see the steps below).");
      let r;
      try {
        r = await fetch(server + "/Users/AuthenticateByName", { method: "POST", headers: { Authorization: jf.authHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ Username: username, Pw: pw || "" }) });
      } catch { throw new Error("Couldn't reach that server. Check the address, make sure Jellyfin is running, and that this device is connected (for Tailscale, the app must be on)."); }
      if (r.status === 401) throw new Error("Wrong username or password.");
      if (!r.ok) throw new Error(`The server answered with an error (${r.status}). Check the address points at Jellyfin.`);
      const j = await r.json();
      let serverName = "";
      try { serverName = (await (await fetch(server + "/System/Info/Public")).json()).ServerName || ""; } catch { /* optional */ }
      jf.cfg = { server, token: j.AccessToken, userId: j.User.Id, user: j.User.Name, serverName: serverName || new URL(server).hostname };
      store.set("jellyfin", jf.cfg);
      memo.forEach((_, k) => { if (k.startsWith("jf")) memo.delete(k); });
    },
    signOut() {
      if (jf.cfg?.token) fetch(jf.cfg.server + "/Sessions/Logout", { method: "POST", headers: { Authorization: jf.authHeader(jf.cfg.token) } }).catch(() => {});
      jf.cfg = null; store.set("jellyfin", null);
    },
    img(id, type = "Primary", h = 600) { return `${jf.cfg.server}/Items/${id}/Images/${type}?fillHeight=${h}&quality=90`; },
    FIELDS: "Overview,Genres,ProductionYear,MediaSources,CommunityRating,OfficialRating,UserData",
    item(x) {
      const img = x.ImageTags?.Primary ? jf.img(x.Id) : x.SeriesPrimaryImageTag && x.SeriesId ? jf.img(x.SeriesId) : x.AlbumPrimaryImageTag ? jf.img(x.AlbumId) : "";
      const ep = x.Type === "Episode" ? `S${x.ParentIndexNumber ?? "?"} · E${x.IndexNumber ?? "?"}` : "";
      return { key: "jf:" + x.Id, src: "jf", id: x.Id, title: x.Type === "Episode" && x.SeriesName ? `${x.SeriesName}` : x.Name, epName: x.Type === "Episode" ? x.Name : "",
        year: x.ProductionYear || "", poster: img, desc: x.Overview || "", genres: x.Genres || [], rating: x.CommunityRating ? +x.CommunityRating.toFixed(1) : null,
        rated: x.OfficialRating || "", type: x.Type,
        backdrop: x.BackdropImageTags?.length ? jf.img(x.Id, "Backdrop", 900) : x.ParentBackdropImageTags?.length && x.ParentBackdropItemId ? jf.img(x.ParentBackdropItemId, "Backdrop", 900) : "", runtime: x.RunTimeTicks ? fmtTime(x.RunTimeTicks / 1e7) : "", seriesId: x.SeriesId,
        sub: [ep || x.ProductionYear, x.Type === "Series" ? "Series" : x.RunTimeTicks ? fmtTime(x.RunTimeTicks / 1e7) : ""].filter(Boolean) };
    },
    async list(params, page = 1, size = 60) {
      const j = await cached(`jf:list:${params}:${page}`, () => jf.api(`/Users/${jf.cfg.userId}/Items?Recursive=true&Fields=${jf.FIELDS}&EnableImageTypes=Primary,Backdrop&StartIndex=${(page - 1) * size}&Limit=${size}&${params}`));
      return { items: (j.Items || []).map(jf.item), more: (j.TotalRecordCount || 0) > page * size };
    },
    async latest(type) {
      const j = await cached("jf:latest:" + type, () => jf.api(`/Users/${jf.cfg.userId}/Items/Latest?IncludeItemTypes=${type}&Limit=40&Fields=${jf.FIELDS}`));
      return { items: (j || []).map(jf.item), more: false };
    },
    async resume() {
      const j = await jf.api(`/Users/${jf.cfg.userId}/Items/Resume?MediaTypes=Video&Limit=30&Fields=${jf.FIELDS}`);
      return { items: (j.Items || []).map((x) => ({ ...jf.item(x), resumeId: x.Id, pct: x.UserData?.PlayedPercentage || 0 })), more: false };
    },
    video(x) { // one playable file
      const ms = (x.MediaSources || [])[0] || {};
      const ep = x.Type === "Episode" ? `S${x.ParentIndexNumber ?? "?"}·E${x.IndexNumber ?? "?"} ${x.Name}` : x.Name;
      return { name: "jf:" + x.Id, jfId: x.Id, ms, label: ep, length: x.RunTimeTicks ? x.RunTimeTicks / 1e7 : 0,
        pos: x.UserData?.PlaybackPositionTicks ? x.UserData.PlaybackPositionTicks / 1e7 : 0, played: !!x.UserData?.Played,
        direct: jf.canDirect(ms), get offlineUrl() { return this.direct ? this.url : null; }, download: `${jf.cfg.server}/Items/${x.Id}/Download?api_key=${jf.cfg.token}`,
        url: `${jf.cfg.server}/Videos/${x.Id}/stream?static=true&MediaSourceId=${ms.Id || x.Id}&api_key=${jf.cfg.token}` };
    },
    canDirect(ms) {
      const v = document.createElement("video");
      const container = (ms.Container || "").toLowerCase();
      const vs = (ms.MediaStreams || []).find((s) => s.Type === "Video");
      const as = (ms.MediaStreams || []).filter((s) => s.Type === "Audio");
      const vOk = !vs || ["h264", "vp8", "vp9", "av1"].includes((vs.Codec || "").toLowerCase()) || ((vs.Codec || "").toLowerCase() === "hevc" && v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'));
      const aOk = !as.length || as.some((a) => ["aac", "mp3", "opus", "vorbis", "flac"].includes((a.Codec || "").toLowerCase()));
      return /^(mp4|m4v|mov|webm)(,|$)/.test(container) && vOk && aOk;
    },
    hls(v) {
      const ps = Math.random().toString(36).slice(2);
      return `${jf.cfg.server}/Videos/${v.jfId}/master.m3u8?MediaSourceId=${v.ms.Id || v.jfId}&DeviceId=${deviceId}&api_key=${jf.cfg.token}&PlaySessionId=${ps}` +
        "&VideoCodec=h264&AudioCodec=aac,mp3&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MinSegments=1&BreakOnNonKeyFrames=True&VideoBitrate=10000000&AudioBitrate=192000&MaxWidth=1920";
    },
    async details(it) {
      const x = await jf.api(`/Users/${jf.cfg.userId}/Items/${it.id}?Fields=${jf.FIELDS},People`);
      if (x.Type === "Episode" && x.SeriesId && !it.keepEpisode) { // open the whole series, starting at this episode
        it.startEpisode = x.Id; it.id = x.SeriesId; it.key = "jf:" + x.SeriesId;
        return jf.details(it);
      }
      Object.assign(it, jf.item(x));
      it.backdrop = x.BackdropImageTags?.length ? jf.img(x.Id, "Backdrop", 900) : "";
      it.cast = (x.People || []).filter((p) => p.Type === "Actor").slice(0, 12).map((p) => ({ name: p.Name, role: p.Role, img: p.PrimaryImageTag ? jf.img(p.Id, "Primary", 200) : "" }));
      if (x.Type === "Series") {
        const eps = await jf.api(`/Shows/${x.Id}/Episodes?UserId=${jf.cfg.userId}&Fields=${jf.FIELDS}`);
        it.videos = (eps.Items || []).filter((e) => e.LocationType !== "Virtual").map(jf.video);
        it.seasons = null;
      } else if (x.Type === "BoxSet" || x.IsFolder) {
        const kids = await jf.api(`/Users/${jf.cfg.userId}/Items?ParentId=${x.Id}&Fields=${jf.FIELDS}&SortBy=ProductionYear,SortName`);
        it.videos = (kids.Items || []).filter((k) => k.MediaType === "Video").map(jf.video);
      } else it.videos = [jf.video(x)];
      if (it.startEpisode) { const i = it.videos.findIndex((v) => v.jfId === it.startEpisode); if (i >= 0) it.startIdx = i; }
      it.links = [];
      return it;
    },
    report(kind, v, sec, paused = false) {
      if (!jf.on() || !v?.jfId) return;
      jf.api(`/Sessions/Playing${kind}`, { method: "POST", body: JSON.stringify({ ItemId: v.jfId, MediaSourceId: v.ms?.Id || v.jfId, PositionTicks: Math.round((sec || 0) * 1e7), IsPaused: paused, PlayMethod: v.direct ? "DirectStream" : "Transcode" }) }).catch(() => {});
    },
  };

  const PROVIDERS = { ia, mv, tv, anime: an, jf };
  const settings = Object.assign({ playableOnly: true }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);
  const canPlay = (it) => !!(it.free || it.src === "jf");

  // ---------- Offline downloads (saved inside the app with the Cache API) ----------
  const OFF_CACHE = "markbox-offline";
  const offKey = (name) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}__offline/${encodeURIComponent(name)}`;
  const offline = {
    index: store.get("offline", {}), // name -> { name, key, src, id, title, label, poster, size, ts, done }
    active: new Map(), // name -> { pct, ctrl }
    supported: "caches" in window && "ReadableStream" in window,
    has: (name) => !!offline.index[name]?.done,
    save() { store.set("offline", offline.index); },
    async start(it, v) {
      if (!offline.supported) { toast("This browser can't save videos for offline viewing."); return; }
      if (offline.has(v.name) || offline.active.has(v.name)) return;
      if (!v.offlineUrl) { toast("This file's format can't be played offline. Use Download file instead."); return; }
      navigator.storage?.persist?.().catch(() => {});
      const ctrl = new AbortController();
      const job = { pct: 0, ctrl, got: 0, total: 0 };
      offline.active.set(v.name, job);
      offline.index[v.name] = { name: v.name, key: it.key, src: it.src, id: it.id, title: it.title, label: v.label && v.label !== it.title ? v.label : "", poster: it.poster, size: 0, ts: Date.now(), done: false };
      offline.save(); emitDl();
      toast("Downloading in Mark Box…");
      try {
        const res = await fetch(v.offlineUrl, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(res.status);
        job.total = +res.headers.get("Content-Length") || 0;
        const [a, b] = res.body.tee();
        const cache = await caches.open(OFF_CACHE);
        const put = cache.put(offKey(v.name), new Response(a, { headers: { "Content-Type": res.headers.get("Content-Type") || "video/mp4" } }));
        const reader = b.getReader();
        let last = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          job.got += value.length;
          job.pct = job.total ? job.got / job.total : 0;
          if (Date.now() - last > 400) { last = Date.now(); emitDl(); }
        }
        await put;
        Object.assign(offline.index[v.name], { done: true, size: job.got, ts: Date.now() });
        offline.save();
        toast(`Saved “${it.title}” for offline`);
      } catch (e) {
        delete offline.index[v.name]; offline.save();
        caches.open(OFF_CACHE).then((c) => c.delete(offKey(v.name))).catch(() => {});
        if (e.name !== "AbortError") toast(/QuotaExceeded/i.test(e.name + e.message) ? "Not enough storage on this device for that download." : "Download failed. This source may not allow saving; try Download file instead.");
      } finally { offline.active.delete(v.name); emitDl(); }
    },
    cancel(name) { offline.active.get(name)?.ctrl.abort(); },
    async remove(name) {
      offline.cancel(name);
      delete offline.index[name]; offline.save();
      try { await (await caches.open(OFF_CACHE)).delete(offKey(name)); } catch { /* ignore */ }
      emitDl();
    },
    async blobUrl(name) {
      const r = await (await caches.open(OFF_CACHE)).match(offKey(name));
      if (!r) throw new Error("missing");
      return URL.createObjectURL(await r.blob());
    },
    async exportFile(name) {
      const e = offline.index[name];
      try {
        const url = await offline.blobUrl(name);
        const a = el("a"); a.href = url; a.download = `${(e.title + (e.label ? " - " + e.label : "")).replace(/[\\/:*?"<>|]+/g, " ").trim()}.mp4`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch { toast("Couldn't find that file. Download it again."); }
    },
  };
  const dlListeners = new Set();
  function emitDl() { dlListeners.forEach((f) => f()); }
  const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(0) + " MB");

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
    kungfu: "collection:(feature_films) AND subject:(\"kung fu\" OR \"martial arts\" OR karate)",
    western: "collection:(feature_films) AND subject:(western OR westerns)",
    action: "collection:(feature_films) AND subject:(action OR adventure OR war)",
    mystery: "collection:(feature_films) AND subject:(mystery OR crime OR detective OR thriller)",
    docs: "(collection:(feature_films) OR collection:(prelinger) OR collection:(documentaryfilms)) AND subject:(documentary)",
    cc: "collection:(opensource_movies) AND licenseurl:(*creativecommons*) AND subject:(film OR movie OR short OR animation)",
    anime: "collection:(animationandcartoons) AND subject:(anime)",
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
    freeKungfu: { title: "Free Kung Fu & Martial Arts", load: iaRow(IA_Q.kungfu), free: true, chip: "Kung Fu" },
    freeWestern:{ title: "Free Westerns", load: iaRow(IA_Q.western), free: true },
    freeAction: { title: "Free Action & War", load: iaRow(IA_Q.action), free: true },
    freeMystery:{ title: "Free Mystery & Crime", load: iaRow(IA_Q.mystery), free: true },
    freeDocs:   { title: "Free Documentaries", load: iaRow(IA_Q.docs), free: true },
    freeCC:     { title: "Free Creative Commons Films", load: iaRow(IA_Q.cc), free: true },
    freeAnime:  { title: "Free Anime & Animation Shorts", load: iaRow(IA_Q.anime), free: true },
    freeNew:    { title: "Recently Added Free Movies", load: iaRow(IA_Q.trending, "addeddate desc"), free: true },

    // The viewer's own Jellyfin library
    jfResume:   { title: "Continue Watching · My Library", jf: true, noMore: true, load: () => jf.resume() },
    jfMovies:   { title: "My Movies · Recently Added", jf: true, load: () => jf.latest("Movie"), more: "jfAllMovies" },
    jfSeries:   { title: "My Series · New Episodes", jf: true, load: () => jf.latest("Episode"), more: "jfAllSeries" },
    jfAllMovies:{ title: "All My Movies", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie&SortBy=SortName", p) },
    jfAllSeries:{ title: "All My Series", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Series&SortBy=SortName", p) },
    jfTopRated: { title: "My Top Rated", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie,Series&SortBy=CommunityRating&SortOrder=Descending", p) },
    jfAnime:    { title: "My Anime", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie,Series&Genres=Anime&SortBy=DateCreated&SortOrder=Descending", p) },
    jfFamily:   { title: "My Animation & Family", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie,Series&Genres=Animation|Family&SortBy=DateCreated&SortOrder=Descending", p) },
    jfAction:   { title: "My Action", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie&Genres=Action&SortBy=DateCreated&SortOrder=Descending", p) },
    jfFavs:     { title: "My Favorites", jf: true, load: (p = 1) => jf.list("IncludeItemTypes=Movie,Series&Filters=IsFavorite&SortBy=SortName", p) },
  };
  // Rows that only show trailers and links (hidden when "Only show titles I can play" is on).
  const isDiscovery = (k) => /^(top10|mv|tv|an)[A-Z0-9]/.test(k) || k === "top10";
  const rowVisible = (k) => {
    if (k === "continue") return true;
    const d = ROWS[k];
    if (!d) return false;
    if (d.jf) return jf.on();
    return !(settings.playableOnly && isDiscovery(k));
  };

  const VIEWS = {
    home:      ["continue", "jfResume", "jfMovies", "jfSeries", "top10", "freeMovies", "tvTrending", "anAiring", "freeNew", "jfAnime", "freeOpen", "mvAction", "freeToons", "anPopular", "jfFamily", "freeAction", "tvWeb", "freeKungfu", "mvComedy", "freeScifi", "anTop", "freeCC", "tvCrime", "freeMystery", "mvKids", "freeHorror", "anMovies", "freeWestern", "mvScifi", "freeNoir", "tvFav", "freeDocs"],
    movies:    ["jfMovies", "jfAllMovies", "jfAction", "jfTopRated", "top10", "mvPopular", "freeMovies", "freeNew", "mvAction", "freeAction", "mvComedy", "freeComedy", "mvThriller", "freeMystery", "mvDrama", "mvScifi", "freeScifi", "mvHorror", "freeHorror", "freeKungfu", "freeWestern", "mvKids", "mvRomance", "freeCC", "mvDocs", "freeDocs", "freeNoir", "freeSilent"],
    series:    ["continue", "jfResume", "jfSeries", "jfAllSeries", "tvTrending", "tvWeb", "tvDrama", "tvComedy", "tvCrime", "tvScifi", "tvToons", "tvFav", "freeTV"],
    anime:     ["jfAnime", "anAiring", "anPopular", "anTop", "anAction", "anFantasy", "anRomance", "anMovies", "anUpcoming", "mvAnime", "freeAnime", "freeOpen", "freeAnim"],
    animation: ["jfFamily", "mvKids", "tvToons", "anMovies", "freeOpen", "freeToons", "freeAnime", "freeAnim", "mvAnime"],
    free:      ["continue", "freeMovies", "freeNew", "freeOpen", "freeToons", "freeAction", "freeKungfu", "freeScifi", "freeHorror", "freeMystery", "freeWestern", "freeNoir", "freeComedy", "freeCC", "freeDocs", "freeAnime", "freeAnim", "freeTV", "freeSilent"],
  };
  const HERO_FROM = {
    home: ["jfMovies", "top10", "anAiring", "tvTrending", "freeMovies", "freeOpen"], movies: ["jfMovies", "top10", "freeMovies"], series: ["jfSeries", "tvTrending", "freeTV"],
    anime: ["jfAnime", "anAiring", "anPopular", "freeAnime", "freeOpen"], animation: ["jfFamily", "mvKids", "anMovies", "freeOpen", "freeToons"], free: ["freeMovies", "freeOpen", "freeToons"],
  };
  const CHIPS = ["jfAllMovies", "jfAllSeries", "mvAction", "freeAction", "mvComedy", "anAiring", "mvHorror", "freeHorror", "mvScifi", "freeScifi", "mvKids", "freeKungfu", "tvCrime", "mvDrama", "freeMovies", "freeToons", "freeWestern", "freeDocs", "mvRomance", "mvThriller"];
  const CHIP_LABEL = { jfAllMovies: "My Movies", jfAllSeries: "My Series", freeAction: "Free Action", freeHorror: "Free Horror", freeScifi: "Free Sci-Fi", freeWestern: "Westerns", freeDocs: "Documentaries" };

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
  const continueItems = () => Object.values(progress()).filter((e) => !(e.src === "jf" && jf.on()) && e.src !== "jf").filter((e) => e.d && e.t / e.d > 0.02 && e.t / e.d < 0.95).sort((a, b) => b.ts - a.ts);

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
    const poster = `<div class="poster">${genPoster(it)}${it.poster ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ""}${it.free ? `<span class="chip free badge">Free</span>` : ""}${it.rating ? `<span class="rate">${Number(it.rating).toFixed(1)}</span>` : ""}${it.pct ? `<div class="bar" style="width:${Math.min(100, it.pct).toFixed(1)}%"></div>` : pr && pr.d ? `<div class="bar" style="width:${Math.min(100, (pr.t / pr.d) * 100).toFixed(1)}%"></div>` : ""}</div>`;
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
    keys = keys.filter((k) => typeof k !== "string" || rowVisible(k));
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
      const moreDef = typeof def.more === "string" ? ROWS[def.more] : def;
      const { sec, rail } = rowShell({ ...def, more: def.top10 || def.noMore ? null : () => showGrid(moreDef) });
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
    if (it.src === "jf") b.push(`<span class="chip mine">My Library</span>`);
    else if (it.free) b.push(`<span class="chip free">Free · Full length</span>`);
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
    if (canPlay(it)) return { label: "Play", fn: () => play(it) };
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
    $("#heroBg").style.backgroundImage = it.backdrop ? `url("${it.backdrop}")` : bg;
    $("#heroPoster").style.backgroundImage = bg;
    const act = primaryAction(it);
    $("#heroPlay").disabled = $("#heroInfo").disabled = false;
    $("#heroPlay").className = "btn " + (canPlay(it) ? "btn-free" : "btn-primary");
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
    body.className = "grid";
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
    body.className = "grid";
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
    if (canPlay(it)) {
      let label = it.src === "jf" ? "Play" : "Play free";
      const vids = it.videos;
      if (it.src === "jf" && vids?.length) {
        const i = startIndex(it), v = vids[i];
        if (v.pos > 30 && !v.played) label = vids.length > 1 ? `Resume ${v.label.split(" ")[0]}` : `Resume ${fmtTime(v.pos)}`;
        else if (vids.length > 1 && i > 0) label = `Play ${v.label.split(" ")[0]}`;
      } else {
        const pr = progress()[it.key];
        if (pr && pr.d && pr.t > 30 && pr.t / pr.d < 0.95) label = `Resume ${fmtTime(pr.t)}`;
      }
      const b = add("btn-free", `${playIcon}<span>${label}</span>`, () => play(it));
      if (!loading && vids && !vids.length) b.disabled = true;
      if (!loading && vids?.length === 1) dlButtons(it, vids[0], "btn btn-glass").forEach((x) => acts.append(x));
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
    if (canPlay(it) && it.videos?.length > 1) {
      extra.append(el("h3", "section-t", `${it.type === "Series" ? "Episodes" : "Episodes &amp; parts"} · ${it.videos.length}`));
      const list = el("div", "ep-list");
      it.videos.forEach((v, i) => {
        const row = el("div", "ep-row");
        const b = el("button", "ep", `<b>${v.played ? "✓" : i + 1}</b><span>${esc(v.label)}</span>${v.length ? `<small>${fmtTime(v.length)}</small>` : ""}`);
        b.type = "button";
        b.onclick = () => play(it, i);
        const a = el("div", "ep-acts");
        dlButtons(it, v, "mini").forEach((x) => a.append(x));
        row.append(b, a);
        list.append(row);
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
  // "Download" saves inside Mark Box for offline viewing; "File" saves the original file through the browser.
  function dlButtons(it, v, cls) {
    const out = [];
    if (v.offlineUrl && offline.supported) {
      const b = el("button", cls); b.type = "button"; b.dataset.dl = v.name;
      b.onclick = () => {
        if (offline.has(v.name)) location.hash = "#downloads";
        else if (offline.active.has(v.name)) offline.cancel(v.name);
        else offline.start(it, v);
      };
      out.push(b);
    }
    if (v.download) {
      const a = el("a", cls, cls === "mini" ? "File" : "Save file"); a.href = v.download; a.target = "_blank"; a.rel = "noopener"; a.download = "";
      a.title = "Save the original video file to this device";
      out.push(a);
    }
    refreshDlButtons(out);
    return out;
  }
  function refreshDlButtons(list = document.querySelectorAll("[data-dl]")) {
    list.forEach((b) => {
      const name = b.dataset?.dl;
      if (!name) return;
      const job = offline.active.get(name);
      const mini = b.classList.contains("mini");
      b.classList.toggle("done", offline.has(name));
      b.textContent = offline.has(name) ? "✓ Downloaded" : job ? `${job.total ? Math.round(job.pct * 100) + "%" : fmtSize(job.got)} · Cancel` : mini ? "Download" : "⬇ Download";
    });
  }
  dlListeners.add(() => refreshDlButtons());
  function startIndex(it) {
    const vids = it.videos || [];
    if (it.startIdx != null) return it.startIdx;
    if (it.src !== "jf" || vids.length < 2) return 0;
    const inProgress = vids.findIndex((v) => v.pos > 30 && !v.played);
    if (inProgress >= 0) return inProgress;
    const lastPlayed = vids.map((v) => v.played).lastIndexOf(true);
    return lastPlayed >= 0 && lastPlayed < vids.length - 1 ? lastPlayed + 1 : 0;
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
  let playing = null; // { it, vids, idx, offline }
  let lastSave = 0, hlsInst = null, triedHls = false;
  function openPlayer(title, sub) {
    closeDetails();
    $("#player").hidden = false;
    document.body.style.overflow = "hidden";
    $("#pTitle").textContent = title; $("#pSub").textContent = sub || "";
    $("#pEpisodes").hidden = true; $("#pEpisodesBtn").hidden = true;
    video.hidden = false; yt.hidden = true; yt.removeAttribute("src");
    resetVideo();
    status("Loading…");
  }
  function resetVideo() {
    if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
    if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
    video.pause(); video.removeAttribute("src"); video.load();
  }
  async function play(base, idx) {
    const it = { ...base };
    openPlayer(it.title, "");
    try {
      if (!it.videos) await PROVIDERS[it.src].details(it);
      const vids = it.videos;
      if (!vids?.length) throw new Error("no video");
      const pr = progress()[it.key];
      if (idx == null) idx = it.src === "jf" ? startIndex(it) : Math.max(0, pr ? vids.findIndex((v) => v.name === pr.file) : 0);
      playing = { it, vids, idx };
      buildEpisodePanel();
      loadVideo(resumeAt(it, vids[idx]));
    } catch (e) {
      const link = it.src === "ia" ? ` <a href="${IA}/details/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Open on archive.org</a>` : "";
      status(it.src === "jf" && !jf.on() ? "Connect your library in Settings to play this." : `This title can't be played right now.${link}`);
    }
  }
  function resumeAt(it, v) {
    if (it.src === "jf") return v.pos > 30 && !v.played ? v.pos : 0;
    const pr = progress()[it.key];
    return pr && pr.file === v.name && pr.t / (pr.d || 1) < 0.95 ? pr.t : 0;
  }
  // Play straight from the Downloads tab (works offline).
  async function playOffline(entry) {
    openPlayer(entry.title, entry.label || "Downloaded");
    try {
      const url = await offline.blobUrl(entry.name);
      const it = { key: entry.key, src: entry.src, id: entry.id, title: entry.title, poster: entry.poster, free: entry.src === "ia" };
      const v = { name: entry.name, label: entry.label || entry.title, jfId: entry.name.startsWith("jf:") ? entry.name.slice(3) : null, direct: true, local: url };
      playing = { it, vids: [v], idx: 0, offline: true };
      loadVideo(it.src === "ia" ? resumeAt(it, v) : (progress()[it.key]?.file === v.name ? progress()[it.key].t : 0));
    } catch { status("That download is missing. Remove it and download it again."); }
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
  let hlsLib = null;
  const loadHls = () => hlsLib || (hlsLib = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
    sc.onload = () => res(window.Hls); sc.onerror = () => { hlsLib = null; rej(new Error("hls")); };
    document.head.append(sc);
  }));
  async function attachHls(url, startAt) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) { video.src = url; return; }
    const Hls = await loadHls();
    if (!Hls.isSupported()) throw new Error("no hls");
    hlsInst = new Hls({ startPosition: startAt > 5 ? startAt : -1 });
    hlsInst.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) status("The server couldn't convert this video. Check that Jellyfin transcoding is enabled."); });
    hlsInst.loadSource(url);
    hlsInst.attachMedia(video);
  }
  async function loadVideo(startAt = 0, forceHls = false) {
    const { it, vids, idx } = playing;
    const v = vids[idx];
    $("#pSub").textContent = vids.length > 1 ? `${idx + 1} / ${vids.length} · ${v.label}` : (v.label !== it.title ? v.label : it.year ? String(it.year) : "");
    status("Loading…");
    resetVideo();
    triedHls = forceHls;
    video.onloadedmetadata = () => { if (startAt > 5 && startAt < video.duration - 10 && Math.abs(video.currentTime - startAt) > 3) video.currentTime = startAt; };
    try {
      let local = v.local;
      if (!local && offline.has(v.name)) { try { local = await offline.blobUrl(v.name); } catch { /* stream instead */ } }
      if (local) video.src = local;
      else if (v.jfId && (!v.direct || forceHls)) await attachHls(jf.hls(v), startAt);
      else video.src = v.url;
      video.play().catch(() => status(""));
    } catch { status("This video can't play in this browser."); }
    document.querySelectorAll(".p-episodes .ep").forEach((b, i) => b.classList.toggle("on", i === idx));
    if (v.jfId) jf.report("", v, startAt);
  }
  function buildEpisodePanel() {
    const panel = $("#pEpisodes");
    panel.innerHTML = "";
    if (playing.vids.length < 2) return;
    $("#pEpisodesBtn").hidden = false;
    playing.vids.forEach((v, i) => {
      const b = el("button", "ep", `<b>${i + 1}</b><span>${esc(v.label)}</span>${offline.has(v.name) ? "<small>⬇</small>" : ""}`);
      b.onclick = () => { playing.idx = i; loadVideo(resumeAt(playing.it, v)); panel.hidden = true; };
      panel.append(b);
    });
  }
  function status(html) { const st = $("#pStatus"); st.innerHTML = html; st.hidden = !html; }
  const curVid = () => playing && playing.vids[playing.idx];
  video.addEventListener("playing", () => status(""));
  video.addEventListener("waiting", () => status("Buffering…"));
  video.addEventListener("pause", () => { const v = curVid(); if (v?.jfId && !video.ended) jf.report("/Progress", v, video.currentTime, true); });
  video.addEventListener("error", () => {
    if (!video.getAttribute("src") && !hlsInst) return;
    const v = curVid();
    if (v?.jfId && !triedHls && !v.local) { loadVideo(video.currentTime || resumeAt(playing.it, v), true); return; } // fall back to server conversion
    status(playing ? (playing.it.src === "ia" ? `This video won't play in your browser. <a href="${IA}/details/${encodeURIComponent(playing.it.id)}" target="_blank" rel="noopener">Open on archive.org</a>` : "This video won't play in your browser.") : "This trailer isn't available right now.");
  });
  video.addEventListener("timeupdate", () => {
    if (!playing || !video.duration) return;
    const now = Date.now();
    if (now - lastSave > 5000) {
      lastSave = now;
      const v = curVid();
      saveProgress(playing.it, v.name, video.currentTime, video.duration);
      if (v.jfId) { jf.report("/Progress", v, video.currentTime); v.pos = video.currentTime; }
    }
  });
  video.addEventListener("ended", () => {
    if (!playing) return;
    const v = curVid();
    saveProgress(playing.it, v.name, video.duration, video.duration);
    if (v.jfId) { jf.report("/Stopped", v, video.duration); v.played = true; }
    if (playing.idx < playing.vids.length - 1) { playing.idx++; loadVideo(resumeAt(playing.it, curVid())); toast("Playing next"); }
  });
  let idleTimer;
  $("#player").addEventListener("pointermove", () => { $("#player").classList.remove("idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => $("#player").classList.add("idle"), 2800); });
  function closePlayer() {
    const v = curVid();
    if (playing && video.duration) {
      saveProgress(playing.it, v.name, video.currentTime, video.duration);
      if (v.jfId) jf.report("/Stopped", v, video.currentTime);
    }
    resetVideo();
    yt.removeAttribute("src");
    const wasPlaying = !!playing;
    playing = null;
    $("#player").hidden = true;
    document.body.style.overflow = "";
    if (wasPlaying && state.view !== "search" && state.view !== "downloads" && state.view !== "mylist") { memo.forEach((_, k) => { if (k.startsWith("jf:latest") ) memo.delete(k); }); route(); }
  }

  // ================= Search =================
  function runSearch(term) {
    setMode("search");
    const q = term.replace(/[^\p{L}\p{N}\s'.:-]/gu, " ").trim();
    if (!q) return;
    const iaQ = `(title:(${q}) OR creator:(${q}) OR subject:(${q})) AND (collection:(feature_films) OR collection:(classic_tv) OR collection:(classic_cartoons) OR collection:(silent_films) OR collection:(film_noir) OR collection:(animationandcartoons))`;
    const rows = [
      jf.on() && { title: `In my library: “${term}”`, load: (page = 1) => jf.list(`IncludeItemTypes=Movie,Series,Episode&SearchTerm=${encodeURIComponent(q)}`, page, 40) },
      { title: jf.on() ? "Free to watch now" : `Free to watch: “${term}”`, load: (page = 1) => ia.list(iaQ, page, 30) },
      !settings.playableOnly && { title: "Movies (trailers)", load: () => fromList(mv.search(q)) },
      !settings.playableOnly && { title: "Series (info)", load: () => fromList(tv.search(q)) },
      !settings.playableOnly && { title: "Anime (trailers)", load: (page = 1) => an.list(`/anime?q=${encodeURIComponent(q)}&sfw=true&limit=24&order_by=members&sort=desc`, page) },
    ].filter(Boolean);
    renderRows(rows);
    // Tell the viewer if nothing came back anywhere.
    const token = state.token;
    setTimeout(() => { if (token === state.token && !$("#rows").children.length) $("#rows").innerHTML = `<p class="note" style="text-align:center;padding:40px 16px">No results for “${esc(term)}”. Check the spelling or try a different title.</p>`; }, 9000);
  }

  // ================= Navigation =================
  function renderChips() {
    const bar = $("#chipsBar");
    bar.innerHTML = "";
    CHIPS.filter(rowVisible).forEach((k) => { const d = ROWS[k]; const b = el("button", null, esc(CHIP_LABEL[k] || d.chip || d.title)); b.type = "button"; b.onclick = () => showGrid(d); bar.append(b); });
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
    renderView(VIEWS[h] || h === "mylist" || h === "downloads" ? h : "home");
  }
  function renderView(view) {
    state.view = view;
    markNav();
    closeDetails();
    if (view === "mylist") return showMyList();
    if (view === "downloads") return showDownloads();
    setMode("rows");
    resetHero();
    renderChips();
    renderRows(VIEWS[view], { heroFrom: HERO_FROM[view] });
    if (!jf.on() && ["home", "movies", "series", "anime", "animation"].includes(view)) {
      const c = el("div", "callout", `<div><b>Watch your own movies and shows here</b><p>Connect your Jellyfin library to stream and download everything you own inside Mark Box.</p></div>`);
      const b = el("button", "btn btn-primary btn-sm", "Connect my library"); b.type = "button"; b.onclick = openSettings;
      c.append(b);
      const host = $("#rows"), at = host.children[view === "home" ? Math.min(1, host.children.length) : 0];
      host.insertBefore(c, at || null);
    }
    if (settings.playableOnly && !jf.on() && ["series", "anime"].includes(view) && $("#rows").querySelectorAll(".row").length < 2)
      $("#rows").insertAdjacentHTML("beforeend", `<p class="note" style="padding:0 var(--gr) 0 var(--gl)">Want to browse new releases too? Turn off “Only show titles I can play” in Settings to see them with trailers.</p>`);
    window.scrollTo({ top: 0 });
  }

  // ================= Downloads view =================
  function showDownloads() {
    setMode("grid");
    state.token = Symbol();
    $("#gridTitle").textContent = "Downloads";
    $("#gridMore").hidden = true;
    const body = $("#gridBody");
    body.className = "";
    const render = () => {
      if (state.view !== "downloads") return;
      const entries = Object.values(offline.index).sort((a, b) => b.ts - a.ts);
      body.innerHTML = "";
      if (!offline.supported) { body.innerHTML = `<p class="empty">This browser can't save videos inside apps. Use “Save file” on a title instead.</p>`; return; }
      if (!entries.length) { body.innerHTML = `<p class="empty">No downloads yet. Open any title you can play and tap “Download” to watch it offline, even without internet.</p>`; return; }
      const list = el("div", "dl-list");
      entries.forEach((e) => {
        const job = offline.active.get(e.name);
        const row = el("div", "dl", `<div class="thumb" style="${e.poster ? `background-image:url('${esc(e.poster)}')` : ""}"></div>
          <div class="info"><b>${esc(e.title)}</b><small>${esc(e.label || "")}</small>
          <small>${e.done ? `${fmtSize(e.size)} · Saved ${new Date(e.ts).toLocaleDateString()}` : job ? `Downloading… ${job.total ? Math.round(job.pct * 100) + "% of " + fmtSize(job.total) : fmtSize(job.got)}` : "Interrupted"}</small>
          ${!e.done ? `<div class="prog"><i style="width:${job ? Math.round(job.pct * 100) : 0}%"></i></div>` : ""}</div>`);
        const acts = el("div", "acts");
        const mk = (label, cls, fn) => { const b = el("button", "btn btn-sm " + cls, label); b.type = "button"; b.onclick = fn; acts.append(b); };
        if (e.done) {
          mk("▶ Play", "btn-free", () => playOffline(e));
          mk("Save to device", "btn-glass", () => offline.exportFile(e.name));
          mk("Delete", "btn-glass", () => offline.remove(e.name));
        } else if (job) mk("Cancel", "btn-glass", () => offline.remove(e.name));
        else mk("Remove", "btn-glass", () => offline.remove(e.name));
        row.append(acts);
        list.append(row);
      });
      body.append(list);
      if (navigator.storage?.estimate) navigator.storage.estimate().then(({ usage, quota }) => {
        if (state.view === "downloads" && usage != null) body.insertAdjacentHTML("beforeend", `<p class="note" style="padding:0 var(--gr) 0 var(--gl)">Using ${fmtSize(usage)} of about ${fmtSize(quota)} available to Mark Box on this device.</p>`);
      });
    };
    dlView = render;
    render();
  }
  let dlView = null;
  dlListeners.add(() => dlView && state.view === "downloads" && dlView());

  // ================= Settings =================
  function openSettings() {
    const m = $("#settings");
    m.hidden = false;
    document.body.style.overflow = "hidden";
    syncSettings();
    if (navigator.storage?.estimate) navigator.storage.estimate().then(({ usage, quota }) => {
      const n = Object.values(offline.index).filter((e) => e.done).length;
      $("#storageInfo").textContent = `${n} video${n === 1 ? "" : "s"} saved for offline. Using ${fmtSize(usage || 0)} of about ${fmtSize(quota || 0)} this browser allows.`;
    }); else $("#storageInfo").textContent = "Storage details aren't available in this browser.";
  }
  function closeSettings() { $("#settings").hidden = true; document.body.style.overflow = ""; }
  function syncSettings() {
    $("#jfConnected").hidden = !jf.on();
    $("#jfForm").hidden = jf.on();
    if (jf.on()) { $("#jfServerName").textContent = jf.cfg.serverName; $("#jfUserName").textContent = jf.cfg.user; }
    else { const last = store.get("jfLast", {}); if (last.server && !$("#jfServer").value) { $("#jfServer").value = last.server; $("#jfUser").value = last.user || ""; } }
    $("#playableOnly").checked = settings.playableOnly;
  }
  $("#settingsBtn").onclick = openSettings;
  document.querySelectorAll("[data-close-settings]").forEach((b) => b.addEventListener("click", closeSettings));
  $("#jfForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#jfError"), btn = $("#jfConnect");
    err.hidden = true; btn.disabled = true; btn.textContent = "Connecting…";
    try {
      await jf.login($("#jfServer").value, $("#jfUser").value.trim(), $("#jfPass").value);
      store.set("jfLast", { server: jf.cfg.server, user: jf.cfg.user });
      $("#jfPass").value = "";
      toast(`Connected to ${jf.cfg.serverName}`);
      syncSettings();
      closeSettings();
      renderView(state.view === "mylist" || state.view === "downloads" || state.view === "search" ? "home" : state.view);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "Connect library"; }
  });
  $("#jfDisconnect").onclick = () => { jf.signOut(); syncSettings(); toast("Library disconnected"); if (state.view !== "downloads") route(); };
  $("#playableOnly").addEventListener("change", (e) => { settings.playableOnly = e.target.checked; saveSettings(); if (state.view !== "downloads" && state.view !== "mylist") route(); });
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
    if (e.key === "Escape") { if (!$("#player").hidden) closePlayer(); else if (!$("#modal").hidden) closeDetails(); else if (!$("#settings").hidden) closeSettings(); }
    if (e.key === "/" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); $("#searchInput").focus(); }
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

  renderChips();
  route();
})();
