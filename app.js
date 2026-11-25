/* Mark Box — streams public-domain films from the Internet Archive. No build step, no API keys. */
(() => {
  "use strict";

  const IA = "https://archive.org";
  const BASE = "mediatype:(movies) AND -subject:(trailer) AND -title:(trailer)";

  // Row definitions. `q` is an Internet Archive advanced-search query.
  const ROWS = {
    trending:  { title: "Trending on Mark Box", q: "collection:(feature_films)" },
    scifi:     { title: "Sci-Fi & Monsters",     q: "collection:(feature_films) AND subject:(\"sci-fi\" OR \"science fiction\" OR scifi OR monster)" },
    horror:    { title: "Horror Nights",         q: "collection:(feature_films) AND subject:(horror)" },
    noir:      { title: "Film Noir",             q: "collection:(film_noir) OR (collection:(feature_films) AND subject:(\"film noir\" OR noir))" },
    comedy:    { title: "Comedy",                q: "collection:(feature_films) AND subject:(comedy)" },
    action:    { title: "Action & Adventure",    q: "collection:(feature_films) AND subject:(action OR adventure OR war)" },
    western:   { title: "Westerns",              q: "collection:(feature_films) AND subject:(western OR westerns)" },
    mystery:   { title: "Mystery & Crime",       q: "collection:(feature_films) AND subject:(mystery OR crime OR detective)" },
    silent:    { title: "Silent Era Classics",   q: "collection:(silent_films)" },
    cartoons:  { title: "Classic Cartoons",      q: "collection:(classic_cartoons)", wide: true },
    tv:        { title: "Classic TV",            q: "collection:(classic_tv)", wide: true },
    sitcoms:   { title: "Sitcoms",               q: "collection:(classic_tv) AND subject:(sitcom OR comedy)", wide: true },
    tvdrama:   { title: "TV Westerns & Drama",   q: "collection:(classic_tv) AND subject:(western OR drama OR crime)", wide: true },
    anime:     { title: "Animation",             q: "collection:(animationandcartoons) AND -collection:(classic_cartoons)", wide: true },
  };

  const VIEWS = {
    home:   ["continue", "trending", "scifi", "horror", "cartoons", "noir", "comedy", "tv", "action", "western", "mystery", "silent"],
    movies: ["trending", "scifi", "horror", "noir", "comedy", "action", "western", "mystery", "silent"],
    tv:     ["continue", "tv", "cartoons", "sitcoms", "tvdrama", "anime"],
  };

  // ---------- Helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const thumb = (id) => `${IA}/services/img/${encodeURIComponent(id)}`;
  const toText = (html) => {
    const d = new DOMParser().parseFromString(String(first(html) || "").replace(/<br\s*\/?>/gi, "\n"), "text/html");
    return (d.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  };
  const fmtTime = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("markbox:" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("markbox:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  let toastTimer;
  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2200); };

  // ---------- Data ----------
  const searchCache = new Map();
  async function search(q, { rows = 30, page = 1, sort = "downloads desc" } = {}) {
    const p = new URLSearchParams({ q: `(${q}) AND ${BASE}`, rows, page, output: "json" });
    ["identifier", "title", "year", "description", "downloads", "creator", "subject", "runtime"].forEach((f) => p.append("fl[]", f));
    if (sort) p.append("sort[]", sort);
    const url = `${IA}/advancedsearch.php?${p}`;
    if (searchCache.has(url)) return searchCache.get(url);
    const job = fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((j) => ({ total: j.response?.numFound || 0, docs: (j.response?.docs || []).map(normalize) }));
    searchCache.set(url, job);
    job.catch(() => searchCache.delete(url));
    return job;
  }
  const normalize = (d) => ({
    id: d.identifier,
    title: first(d.title) || d.identifier,
    year: first(d.year) || "",
    desc: d.description,
    creator: first(d.creator) || "",
    runtime: first(d.runtime) || "",
    subject: [].concat(d.subject || []).slice(0, 4),
  });

  const metaCache = new Map();
  function metadata(id) {
    if (!metaCache.has(id)) {
      const job = fetch(`${IA}/metadata/${encodeURIComponent(id)}`).then((r) => r.json());
      metaCache.set(id, job);
      job.catch(() => metaCache.delete(id));
    }
    return metaCache.get(id);
  }

  const FORMAT_SCORE = (f) => {
    const fmt = (f.format || "").toLowerCase();
    if (fmt === "h.264") return 9;
    if (fmt === "h.264 ia") return 8;
    if (fmt === "mpeg4") return 7;
    if (fmt === "h.264 hd") return 6;
    if (fmt === "512kb mpeg4") return 5;
    if (/\.mp4$|\.m4v$/i.test(f.name)) return 4;
    if (/\.webm$/i.test(f.name)) return 3;
    if (/\.ogv$/i.test(f.name)) return 2;
    return 0;
  };
  function pickVideos(meta) {
    const best = new Map();
    for (const f of meta.files || []) {
      const s = FORMAT_SCORE(f);
      if (!s || /(^|\/)\.|__ia_thumb|sample/i.test(f.name)) continue;
      const key = (f.source === "derivative" && f.original) ? f.original : f.name;
      const cur = best.get(key);
      if (!cur || s > cur.s) best.set(key, { s, f, key });
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    return [...best.values()].sort((a, b) => coll.compare(a.key, b.key)).map(({ f, key }) => ({
      name: f.name,
      url: `${IA}/download/${encodeURIComponent(meta.metadata.identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
      label: f.title || key.split("/").pop().replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim(),
      length: parseFloat(f.length) || 0,
    }));
  }
  function bigImage(meta) {
    const imgs = (meta.files || []).filter((f) => f.source === "original" && /\.(jpe?g|png)$/i.test(f.name) && !/thumb/i.test(f.name));
    imgs.sort((a, b) => (+b.size || 0) - (+a.size || 0));
    const f = imgs[0];
    return f ? `${IA}/download/${encodeURIComponent(meta.metadata.identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}` : null;
  }

  // ---------- Personal state ----------
  const myList = () => store.get("list", []);
  const inList = (id) => myList().some((x) => x.id === id);
  function toggleList(item) {
    let l = myList();
    if (inList(item.id)) { l = l.filter((x) => x.id !== item.id); toast("Removed from My List"); }
    else { l.unshift({ id: item.id, title: item.title, year: item.year }); toast("Added to My List"); }
    store.set("list", l);
    if (state.view === "mylist") showMyList();
  }
  const progress = () => store.get("progress", {});
  function saveProgress(item, file, t, d) {
    const p = progress();
    p[item.id] = { id: item.id, title: item.title, year: item.year, file, t, d, ts: Date.now() };
    const entries = Object.values(p).sort((a, b) => b.ts - a.ts).slice(0, 40);
    store.set("progress", Object.fromEntries(entries.map((e) => [e.id, e])));
  }
  const continueItems = () => Object.values(progress()).filter((e) => e.d && e.t / e.d > 0.02 && e.t / e.d < 0.95).sort((a, b) => b.ts - a.ts);

  // ---------- Cards & rows ----------
  function card(item, { wide = false } = {}) {
    const b = el("button", "card");
    b.type = "button";
    b.setAttribute("aria-label", `${item.title}${item.year ? ", " + item.year : ""}`);
    b.innerHTML = `<div class="ph">${esc(item.title)}</div>`;
    const img = new Image();
    img.loading = "lazy"; img.alt = ""; img.decoding = "async";
    img.onload = () => b.querySelector(".ph")?.remove();
    img.onerror = () => img.remove();
    img.src = thumb(item.id);
    b.prepend(img);
    b.insertAdjacentHTML("beforeend", `<div class="cap">${esc(item.title)}${item.year ? `<small>${esc(item.year)}</small>` : ""}</div>`);
    const pr = progress()[item.id];
    if (pr && pr.d) b.insertAdjacentHTML("beforeend", `<div class="bar" style="width:${Math.min(100, (pr.t / pr.d) * 100).toFixed(1)}%"></div>`);
    b.addEventListener("click", () => openDetails(item));
    if (wide) b.dataset.wide = "1";
    return b;
  }

  function rowShell(title, { wide, onMore } = {}) {
    const sec = el("section", "row");
    const h = el("h2", null, esc(title));
    if (onMore) { const m = el("button", null, "See all ›"); m.type = "button"; m.onclick = onMore; h.append(m); }
    const wrap = el("div", "rail-wrap");
    const rail = el("div", "rail" + (wide ? " wide" : ""));
    for (let i = 0; i < 8; i++) rail.append(el("div", "card skeleton"));
    const l = el("button", "rail-btn l", "‹"), r = el("button", "rail-btn r", "›");
    l.setAttribute("aria-label", "Scroll left"); r.setAttribute("aria-label", "Scroll right");
    l.onclick = () => rail.scrollBy({ left: -rail.clientWidth * 0.85, behavior: "smooth" });
    r.onclick = () => rail.scrollBy({ left: rail.clientWidth * 0.85, behavior: "smooth" });
    wrap.append(l, rail, r);
    sec.append(h, wrap);
    return { sec, rail };
  }

  function renderRows(keys) {
    const host = $("#rows");
    host.innerHTML = "";
    const token = (state.renderToken = Symbol());
    keys.forEach((key) => {
      if (key === "continue") {
        const items = continueItems();
        if (!items.length) return;
        const { sec, rail } = rowShell("Continue Watching", { wide: true });
        rail.innerHTML = "";
        items.forEach((it) => rail.append(card(it, { wide: true })));
        host.append(sec);
        return;
      }
      const def = ROWS[key];
      const { sec, rail } = rowShell(def.title, { wide: def.wide, onMore: () => showGrid(def.title, def.q) });
      host.append(sec);
      search(def.q, { rows: 30 }).then(({ docs }) => {
        if (token !== state.renderToken) return;
        rail.innerHTML = "";
        if (!docs.length) { sec.remove(); return; }
        docs.forEach((d) => rail.append(card(d, { wide: def.wide })));
        if (key === "trending" || (!state.heroSet && key === keys.find((k) => k !== "continue"))) setHero(docs);
      }).catch(() => {
        if (token !== state.renderToken) return;
        rail.innerHTML = `<p style="color:var(--muted);padding:20px 0">Couldn't reach the film library. Check your connection and refresh.</p>`;
      });
    });
  }

  // ---------- Hero ----------
  async function setHero(docs) {
    if (state.heroSet) return;
    state.heroSet = true;
    const pick = docs[Math.floor(Math.random() * Math.min(12, docs.length))];
    if (!pick) return;
    $("#heroTitle").textContent = pick.title;
    $("#heroMeta").innerHTML = [pick.year && `<span>${esc(pick.year)}</span>`, pick.runtime && `<span>${esc(pick.runtime)}</span>`, pick.subject[0] && `<span>${esc(pick.subject[0])}</span>`].filter(Boolean).join("");
    $("#heroDesc").textContent = toText(pick.desc).slice(0, 400);
    const bg = $("#heroBg");
    bg.style.backgroundImage = `url("${thumb(pick.id)}")`;
    bg.style.filter = "blur(8px) saturate(1.2)";
    $("#heroPlay").disabled = $("#heroInfo").disabled = false;
    $("#heroPlay").onclick = () => play(pick);
    $("#heroInfo").onclick = () => openDetails(pick);
    try {
      const big = bigImage(await metadata(pick.id));
      if (big) { const i = new Image(); i.onload = () => { bg.style.backgroundImage = `url("${big}")`; bg.style.filter = ""; }; i.src = big; }
    } catch { /* keep thumbnail */ }
  }

  // ---------- Grid views ----------
  async function showGrid(title, q, { sort = "downloads desc" } = {}) {
    setViewMode("grid");
    $("#gridTitle").textContent = title;
    const body = $("#gridBody"), more = $("#gridMore");
    body.innerHTML = "";
    for (let i = 0; i < 18; i++) body.append(el("div", "card skeleton"));
    let page = 1;
    const token = (state.renderToken = Symbol());
    const load = async () => {
      more.hidden = true;
      try {
        const { docs, total } = await search(q, { rows: 48, page, sort });
        if (token !== state.renderToken) return;
        if (page === 1) body.innerHTML = "";
        docs.forEach((d) => body.append(card(d)));
        if (!body.children.length) body.innerHTML = `<p class="empty">Nothing found. Try another title, actor or genre.</p>`;
        more.hidden = page * 48 >= total;
      } catch {
        if (token === state.renderToken) body.innerHTML = `<p class="empty">Couldn't reach the film library. Check your connection and try again.</p>`;
      }
    };
    more.onclick = () => { page++; load(); };
    window.scrollTo({ top: 0 });
    load();
  }

  function showMyList() {
    setViewMode("grid");
    state.renderToken = Symbol();
    $("#gridTitle").textContent = "My List";
    $("#gridMore").hidden = true;
    const body = $("#gridBody");
    body.innerHTML = "";
    const l = myList();
    if (!l.length) body.innerHTML = `<p class="empty">Your list is empty. Open any title and choose “+ My List” to save it here.</p>`;
    l.forEach((it) => body.append(card(it)));
  }

  function setViewMode(mode) {
    const grid = mode === "grid";
    $("#hero").hidden = grid;
    $("#rows").hidden = grid;
    $("#grid").hidden = !grid;
  }

  // ---------- Details ----------
  let current = null;
  async function openDetails(item) {
    current = item;
    const m = $("#modal");
    $("#mTitle").textContent = item.title;
    $("#mMeta").innerHTML = [item.year && `<span>${esc(item.year)}</span>`, item.runtime && `<span>${esc(item.runtime)}</span>`, item.creator && `<span>${esc(item.creator)}</span>`].filter(Boolean).join("");
    $("#mDesc").textContent = item.desc ? toText(item.desc) : "Loading details…";
    $("#mHero").style.backgroundImage = `url("${thumb(item.id)}")`;
    $("#mEpisodes").innerHTML = "";
    const listBtn = $("#mList");
    const syncList = () => (listBtn.textContent = inList(item.id) ? "✓ In My List" : "+ My List");
    syncList();
    listBtn.onclick = () => { toggleList(item); syncList(); };
    const pr = progress()[item.id];
    $("#mPlay").lastChild.textContent = pr && pr.d && pr.t / pr.d < 0.95 && pr.t > 30 ? `Resume ${fmtTime(pr.t)}` : "Play";
    $("#mPlay").onclick = () => play(item);
    m.hidden = false;
    document.body.style.overflow = "hidden";
    $(".modal-x").focus();

    try {
      const meta = await metadata(item.id);
      if (current !== item) return;
      const md = meta.metadata || {};
      Object.assign(item, { title: first(md.title) || item.title, year: item.year || first(md.year) || (first(md.date) || "").slice(0, 4), creator: item.creator || first(md.creator) || "", runtime: item.runtime || first(md.runtime) || "" });
      $("#mTitle").textContent = item.title;
      $("#mMeta").innerHTML = [item.year && `<span>${esc(item.year)}</span>`, item.runtime && `<span>${esc(item.runtime)}</span>`, item.creator && `<span>${esc(item.creator)}</span>`, first(md.language) && `<span class="pill">${esc(first(md.language))}</span>`].filter(Boolean).join("");
      $("#mDesc").textContent = toText(md.description) || "No description available.";
      const big = bigImage(meta);
      if (big) $("#mHero").style.backgroundImage = `url("${big}")`;
      const vids = pickVideos(meta);
      if (vids.length > 1) {
        const list = el("div", "ep-list", `<h3>Episodes &amp; parts (${vids.length})</h3>`);
        vids.forEach((v, i) => {
          const b = el("button", "ep", `<b>${i + 1}</b><span>${esc(v.label)}${v.length ? ` · ${fmtTime(v.length)}` : ""}</span>`);
          b.onclick = () => play(item, i);
          list.append(b);
        });
        $("#mEpisodes").append(list);
      }
      $("#mPlay").disabled = !vids.length;
      if (!vids.length) $("#mEpisodes").innerHTML = `<p style="color:var(--muted)">This title has no streamable video file. <a style="color:var(--accent)" href="${IA}/details/${encodeURIComponent(item.id)}" target="_blank" rel="noopener">View on archive.org</a></p>`;
    } catch {
      if (current === item && !item.desc) $("#mDesc").textContent = "Couldn't load details right now.";
    }
  }
  function closeDetails() { $("#modal").hidden = true; document.body.style.overflow = ""; current = null; }

  // ---------- Player ----------
  const video = $("#video");
  let playing = null; // { item, vids, idx }
  let lastSave = 0;

  async function play(item, idx) {
    closeDetails();
    const p = $("#player");
    p.hidden = false;
    document.body.style.overflow = "hidden";
    $("#pTitle").textContent = item.title;
    $("#pSub").textContent = "";
    $("#pEpisodes").hidden = true;
    $("#pEpisodesBtn").hidden = true;
    status("Loading…");
    video.removeAttribute("src"); video.load();
    try {
      const meta = await metadata(item.id);
      const vids = pickVideos(meta);
      if (!vids.length) throw new Error("no video");
      const pr = progress()[item.id];
      if (idx == null) idx = Math.max(0, pr ? vids.findIndex((v) => v.name === pr.file) : 0);
      playing = { item, vids, idx };
      buildEpisodePanel();
      loadVideo(pr && pr.file === vids[idx].name && pr.t / (pr.d || 1) < 0.95 ? pr.t : 0);
    } catch {
      status(`This title can't be streamed here. <a href="${IA}/details/${encodeURIComponent(item.id)}" target="_blank" rel="noopener">Watch on archive.org</a>`);
    }
  }

  function loadVideo(startAt = 0) {
    const { item, vids, idx } = playing;
    const v = vids[idx];
    $("#pSub").textContent = vids.length > 1 ? `${idx + 1} / ${vids.length} · ${v.label}` : (item.year ? String(item.year) : "");
    status("Loading…");
    video.src = v.url;
    video.onloadedmetadata = () => { if (startAt > 5 && startAt < video.duration - 10) video.currentTime = startAt; };
    video.play().catch(() => status(""));
    document.querySelectorAll(".p-episodes .ep").forEach((b, i) => b.classList.toggle("on", i === idx));
  }

  function buildEpisodePanel() {
    const panel = $("#pEpisodes");
    panel.innerHTML = "";
    const { vids } = playing;
    if (vids.length < 2) return;
    $("#pEpisodesBtn").hidden = false;
    vids.forEach((v, i) => {
      const b = el("button", "ep", `<b>${i + 1}</b><span>${esc(v.label)}</span>`);
      b.onclick = () => { playing.idx = i; loadVideo(0); panel.hidden = true; };
      panel.append(b);
    });
  }

  function status(html) { const s = $("#pStatus"); s.innerHTML = html; s.hidden = !html; }

  video.addEventListener("playing", () => status(""));
  video.addEventListener("waiting", () => status("Buffering…"));
  video.addEventListener("error", () => {
    if (!playing) return;
    status(`This video won't play in your browser. <a href="${IA}/details/${encodeURIComponent(playing.item.id)}" target="_blank" rel="noopener">Watch on archive.org</a>`);
  });
  video.addEventListener("timeupdate", () => {
    if (!playing || !video.duration) return;
    const now = Date.now();
    if (now - lastSave > 4000) { lastSave = now; saveProgress(playing.item, playing.vids[playing.idx].name, video.currentTime, video.duration); }
  });
  video.addEventListener("ended", () => {
    if (!playing) return;
    saveProgress(playing.item, playing.vids[playing.idx].name, video.duration, video.duration);
    if (playing.idx < playing.vids.length - 1) { playing.idx++; loadVideo(0); toast("Playing next"); }
  });

  function closePlayer() {
    if (playing && video.duration) saveProgress(playing.item, playing.vids[playing.idx].name, video.currentTime, video.duration);
    video.pause(); video.removeAttribute("src"); video.load();
    playing = null;
    $("#player").hidden = true;
    document.body.style.overflow = "";
    if (state.view === "home" || state.view === "tv") renderRows(VIEWS[state.view]);
  }

  // ---------- Navigation ----------
  const state = { view: "home", heroSet: false, renderToken: null };

  function route() {
    const h = location.hash.replace(/^#/, "");
    const view = ["movies", "tv", "mylist"].includes(h) ? h : h.startsWith("search-") ? "search" : "home";
    state.view = view;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === view));
    if (view === "mylist") return showMyList();
    if (view === "search") {
      const term = decodeURIComponent(h.slice(7)).replace(/-/g, " ");
      $("#searchInput").value = term;
      const safe = term.replace(/[^\p{L}\p{N}\s'.]/gu, " ").trim();
      if (!safe) return;
      return showGrid(`Results for “${term}”`, `(title:(${safe}) OR creator:(${safe}) OR subject:(${safe}) OR description:(${safe})) AND (collection:(feature_films) OR collection:(classic_tv) OR collection:(classic_cartoons) OR collection:(silent_films) OR collection:(film_noir) OR collection:(animationandcartoons) OR collection:(moviesandfilms))`);
    }
    setViewMode("rows");
    renderRows(VIEWS[view]);
    window.scrollTo({ top: 0 });
  }

  $("#searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const term = $("#searchInput").value.trim();
    if (!term) return;
    const slug = "search-" + encodeURIComponent(term.replace(/\s+/g, "-"));
    if (location.hash === "#" + slug) route(); else location.hash = slug;
    $("#searchInput").blur();
  });
  document.querySelectorAll("[data-nav]").forEach((a) => a.addEventListener("click", (e) => {
    if (a.dataset.nav === "home") { e.preventDefault(); history.pushState(null, "", location.pathname); route(); }
  }));
  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);
  window.addEventListener("scroll", () => $("#topbar").classList.toggle("solid", window.scrollY > 40), { passive: true });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeDetails));
  $("#pBack").onclick = closePlayer;
  $("#pEpisodesBtn").onclick = () => { $("#pEpisodes").hidden = !$("#pEpisodes").hidden; };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#player").hidden) closePlayer();
      else if (!$("#modal").hidden) closeDetails();
    }
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  route();
})();
