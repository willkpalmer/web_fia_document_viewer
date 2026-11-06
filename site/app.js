"use strict";

const S = { index: null, events: {}, penalties: null, catById: {} };
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function getJSON(path) {
  const r = await fetch(`data/${path}`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------------ routing */

function route() {
  const [path, qs] = location.hash.replace(/^#/, "").split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(qs || "") };
}
function hrefFor(parts, params) {
  const qs = params && [...params].length ? "?" + params.toString() : "";
  return "#/" + parts.join("/") + qs;
}
function updateParams(mutator) {
  const { parts, params } = route();
  mutator(params);
  for (const [k, v] of [...params]) if (v === "" || v == null) params.delete(k);
  history.replaceState(null, "", hrefFor(parts, params));
  render();
}

/* ------------------------------------------------------------------ helpers */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtWhen(iso, withTime = true) {
  if (!iso) return "";
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${wd} ${day} ${MONTHS[m - 1]}` + (withTime && t ? ` · ${t}` : "");
}
function fmtRange(a, b) {
  if (!a) return "";
  return a.slice(0, 10) === (b || "").slice(0, 10) ? fmtWhen(a, false) : `${fmtWhen(a, false)} – ${fmtWhen(b, false)}`;
}
function eventFor(d) {
  return S.index.events.find((e) => e.slug === (d.event_slug || S.currentSlug));
}
function localTime(d) { return d.published_local || d.published; }
function fmtOffset(min) {
  if (min == null) return "";
  const sign = min < 0 ? "−" : "+", a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`;
}
function whenTitle(d) {
  const ev = eventFor(d);
  return `Published ${fmtWhen(localTime(d))} track time (${fmtOffset(ev?.utc_offset_min)}) · ${fmtWhen(d.published)} Paris`;
}
const euro = (n) => "€" + n.toLocaleString("en-GB");

function driverLabel(car) {
  const d = S.index.drivers[String(car)];
  return d ? `#${car} ${d.name}` : `Car ${car}`;
}
function docDrivers(doc) {
  const ds = doc.details?.drivers;
  if (ds && ds.length) return ds;
  return (doc.cars || []).map((c) => ({ car: c, name: S.index.drivers[String(c)]?.name || "" }));
}
function catVar(id) { return `--cc: var(--c-${id})`; }
function searchText(doc) {
  const d = doc.details || {};
  return [doc.title, d.no_driver, d.competitor, d.session, d.fact, d.infringement, d.decision, d.reason, d.summary,
    ...(d.tags || []), ...docDrivers(doc).map((x) => x.name)].join(" ").toLowerCase();
}
function stripTypePrefix(subject, type) {
  return subject.replace(/^\(?(corrected\s+)?(infringe?ment|infringment|summons|decision)\)?\s*[-–]?\s*/i, "")
    .replace(/^car\s+\d+\s*[-–;:]\s*/i, "") || subject;
}

/* ------------------------------------------------------------------ sessions panel */

let sessionsEvent = null;
function setSessions(ev) {
  sessionsEvent = ev || null;
  renderSessions();
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
const p2 = (n) => String(n).padStart(2, "0");
function trackDayTime(iso) {               // "2026-11-06T12:30" (track local) -> "Fri 12:30"
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  return { day: `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]} ${day} ${MONTHS[m - 1]}`, time: t.slice(0, 5) };
}
function viewerDayTime(utcIso) {
  const dt = new Date(utcIso);
  return {
    day: `${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`,
    time: `${p2(dt.getHours())}:${p2(dt.getMinutes())}`,
    tz: (Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(dt)
      .find((x) => x.type === "timeZoneName") || {}).value || "",
  };
}

function sessionState(s, now) {
  if (s.inferred) return "done";
  const st = Date.parse(s.start_utc), en = Date.parse(s.end_utc);
  return now >= en ? "done" : now >= st ? "live" : "next";
}

function renderSessions() {
  const box = $("#sessions");
  const ev = sessionsEvent;
  if (!ev) { box.hidden = true; document.body.classList.remove("has-sessions"); return; }
  box.hidden = false;
  document.body.classList.add("has-sessions");
  const now = Date.now();
  const list = ev.sessions || [];
  const firstNext = list.find((s) => sessionState(s, now) === "next");

  const rows = list.map((s) => {
    const state = sessionState(s, now);
    let when = "", badge = "";
    if (s.inferred) {
      const c = trackDayTime(s.classified_local);
      when = `<div class="s-when s-plain">${esc(c.day)}</div>
        <div class="s-sub" title="No timetable on fia.com covers this session; time is when its classification was published">Results published ${esc(c.time)} track time</div>`;
    } else {
      const a = trackDayTime(s.start_local), b = trackDayTime(s.end_local);
      when = `<div class="s-when"><span class="s-tag">Track</span><span>${esc(a.day)} · <b>${esc(a.time)}–${esc(b.time)}</b></span></div>`;
      if (state === "next") {
        const va = viewerDayTime(s.start_utc), vb = viewerDayTime(s.end_utc);
        when += `<div class="s-when s-mine" title="Your time zone${va.tz ? ": " + esc(va.tz) : ""}"><span class="s-tag">You${va.tz ? " · " + esc(va.tz) : ""}</span><span>${esc(va.day)} · <b>${esc(va.time)}–${esc(vb.time)}</b></span></div>`;
      }
    }
    if (state === "done") badge = `<span class="s-badge done">✓ Complete</span>`;
    else if (state === "live") badge = `<span class="s-badge live"><i></i>In progress · ${fmtDur(Date.parse(s.end_utc) - now)} left</span>`;
    else badge = `<span class="s-badge next">${s === firstNext ? "Next · " : ""}in ${fmtDur(Date.parse(s.start_utc) - now)}</span>`;
    return `<li class="s-row ${state}">
      <div class="s-head"><span class="s-name">${esc(s.name)}</span>${badge}</div>
      ${when}
    </li>`;
  }).join("");

  box.innerHTML = `
    <div class="s-title">Sessions <span>${esc(ev.name.replace(/ Grand Prix$/, " GP"))} · ${fmtOffset(ev.utc_offset_min)}</span></div>
    ${list.length ? `<ol class="s-list">${rows}</ol>` : `<p class="muted s-empty">Session times appear once the FIA publishes this event's timetable.</p>`}
    ${list.some((s) => s.inferred) ? `<p class="s-note">Some sessions aren't covered by a timetable on fia.com, so they're shown from their published results.</p>` : ""}
    ${list.some((s) => !s.inferred) ? `<p class="s-note">From the FIA event timetable. Race end times are approximate.</p>` : ""}`;
}

/* ------------------------------------------------------------------ track clock */

let clockEvent = null, clockTimer = null;
function setClock(ev) {
  clockEvent = ev || null;
  $("#clock").hidden = !clockEvent || clockEvent.utc_offset_min == null;
  tickClock();
  if (!clockTimer) clockTimer = setInterval(tickClock, 1000);
}
let tickCount = 0;
function tickClock() {
  if (++tickCount % 30 === 0) renderSessions();
  if (!clockEvent || clockEvent.utc_offset_min == null) return;
  const t = new Date(Date.now() + clockEvent.utc_offset_min * 60000);
  const p2 = (n) => String(n).padStart(2, "0");
  $("#clockTime").textContent = `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}`;
  $("#clockDay").textContent = `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  $("#clockWhere").textContent = `${clockEvent.name.replace(/ Grand Prix$/, " GP")} · ${fmtOffset(clockEvent.utc_offset_min)}`;
}

/* ------------------------------------------------------------------ sync */

// Repository that hosts this site: <owner>.github.io/<repo>/ ; fallback for local preview.
const REPO = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : "willkpalmer/web_fia_document_viewer";
})();
const WORKFLOW = "update.yml";
const TOKEN_KEY = `ghToken:${REPO}`;
const API = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}`;

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function localClock(iso) {
  const dt = new Date(iso);
  return `${DAYS[dt.getDay()]} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

async function reloadData() {
  S.index = await getJSON("index.json");
  for (const c of S.index.categories) S.catById[c.id] = c;
  S.events = {};
  S.penalties = null;
  await render();
  await showUpdated();
}

async function showUpdated() {
  let html = "";
  try {
    const u = await getJSON("updated.json");
    S.dataVersion = u.updated;
    html += `<div title="${esc(u.updated)}">Data last changed ${esc(localClock(u.updated))} (${ago(u.updated)})</div>`;
  } catch {}
  html += `<div>Source: <a href="${esc(S.index.source)}" target="_blank" rel="noopener">fia.com</a> ·
    <a href="https://github.com/${REPO}/actions/workflows/${WORKFLOW}" target="_blank" rel="noopener">sync history</a></div>`;
  $("#updated").innerHTML = html;
}

async function latestRun(auth) {
  const r = await fetch(`${API}/runs?per_page=10&_=${Date.now()}`, {
    headers: auth ? { Authorization: `Bearer ${auth}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  // push-triggered runs only redeploy the site; they don't fetch from fia.com
  return (await r.json()).workflow_runs?.find((w) => w.event !== "push") || null;
}

function runLabel(run) {
  if (!run) return "No sync runs yet";
  const how = { schedule: "scheduled", workflow_dispatch: "manual" }[run.event] || run.event;
  if (run.status !== "completed") return `Sync running (${how}, started ${ago(run.run_started_at || run.created_at)})…`;
  const ok = run.conclusion === "success";
  return `Last check ${ago(run.updated_at)} · ${how}${ok ? "" : ` · <span class="bad">${esc(run.conclusion)}</span>`}`;
}

async function refreshSyncStatus() {
  try {
    const run = await latestRun(getToken());
    $("#syncStatus").innerHTML = runLabel(run);
    return run;
  } catch (e) {
    $("#syncStatus").textContent = "";
    return null;
  }
}

function initSync() {
  $("#tokenLink").href = "https://github.com/settings/personal-access-tokens/new";
  $("#runOnGithub").href = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
  $("#syncBtn").onclick = () => (getToken() ? runSync() : ($("#syncToken").hidden = false));
  $("#tokenCancel").onclick = () => { $("#syncToken").hidden = true; };
  $("#syncToken").onsubmit = (e) => {
    e.preventDefault();
    const t = $("#tokenInput").value.trim();
    if (!t) return;
    setToken(t);
    $("#tokenInput").value = "";
    $("#syncToken").hidden = true;
    runSync();
  };
  const auto = $("#autoSync");
  auto.checked = getAuto();
  auto.onchange = () => { setAuto(auto.checked); autoTick(); };
  refreshSyncStatus();
  setInterval(autoTick, 60000);
}

function getAuto() { try { return localStorage.getItem("autoSync") !== "0"; } catch { return true; } }
function setAuto(v) { try { localStorage.setItem("autoSync", v ? "1" : "0"); } catch {} }

// Race weekends (Fri-Sun UTC): sync every 10 min; otherwise hourly.
function syncInterval() { return [5, 6, 0].includes(new Date().getUTCDay()) ? 10 : 60; }

async function autoTick() {
  if (S.syncing) return;
  // 1. pick up new data published by any run (scheduled, manual, another browser)
  try {
    const u = await getJSON("updated.json");
    if (S.dataVersion && u.updated !== S.dataVersion) await reloadData();
  } catch {}
  // 2. start a sync ourselves if allowed and the last one is stale
  const run = await refreshSyncStatus();
  if (!getAuto() || !getToken() || document.visibilityState !== "visible") return;
  if (run && run.status !== "completed") return;
  const last = run ? new Date(run.updated_at).getTime() : 0;
  if (Date.now() - last >= syncInterval() * 60000) runSync();
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") autoTick(); });

async function runSync() {
  if (S.syncing) return;
  S.syncing = true;
  const btn = $("#syncBtn"), status = $("#syncStatus");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const before = await latestRun(getToken()).catch(() => null);
    const r = await fetch(`${API}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      setToken("");
      $("#syncToken").hidden = false;
      throw new Error(r.status === 401 ? "Token rejected — please add a new one" : "Token lacks Actions: write on this repo");
    }
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    status.textContent = "Sync started — fetching from fia.com…";

    // wait for the new run to appear and finish (scrape + deploy, typically ~1 min)
    const t0 = Date.now();
    let run = null;
    while (Date.now() - t0 < 6 * 60000) {
      await new Promise((res) => setTimeout(res, 5000));
      run = await latestRun(getToken()).catch(() => null);
      if (!run || (before && run.id === before.id)) continue;
      status.innerHTML = runLabel(run);
      if (run.status === "completed") break;
    }
    if (!run || run.status !== "completed") throw new Error("Still running — check sync history");
    if (run.conclusion !== "success") throw new Error(`Sync ${run.conclusion}`);

    // reload data (Pages can take a few seconds to serve the new deploy)
    status.textContent = "Loading new data…";
    await new Promise((res) => setTimeout(res, 8000));
    await reloadData();
    status.innerHTML = runLabel(run);
  } catch (e) {
    status.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    S.syncing = false;
    btn.disabled = false;
    btn.textContent = "↻ Sync now";
  }
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  };
  $("#menuBtn").onclick = () => document.body.classList.toggle("nav-open");
  $("#scrim").onclick = () => document.body.classList.remove("nav-open");

  try {
    S.index = await getJSON("index.json");
  } catch (e) {
    $("#main").innerHTML = `<p class="empty">Could not load data (${esc(e.message)}).</p>`;
    return;
  }
  for (const c of S.index.categories) S.catById[c.id] = c;
  $("#seasonLabel").textContent = `${S.index.championship} · ${S.index.season}`;
  showUpdated();
  initSync();
  window.addEventListener("hashchange", render);
  render();
}

function renderSidebar(activeSlug) {
  const pens = (e) => e.counts?.stewards || 0;
  $("#eventList").innerHTML = S.index.events.slice().reverse().map((e) => `
    <li><a href="#/event/${esc(e.slug)}" class="${e.slug === activeSlug ? "active" : ""}" title="${esc(fmtRange(e.first_local, e.last_local))}">
      <span class="rnd">R${e.round}</span>
      <span>${esc(e.name.replace(/ Grand Prix$/, " GP"))}</span>
      <span class="cnt" title="${e.doc_count} documents, ${pens(e)} stewards documents">${e.doc_count}</span>
    </a></li>`).join("");
}

async function render() {
  document.body.classList.remove("nav-open");
  const { parts, params } = route();
  const view = parts[0] || "event";
  $("#navEvent").classList.toggle("active", view === "event");
  $("#navPen").classList.toggle("active", view === "penalties");
  if (view === "penalties") {
    renderSidebar(null);
    setClock(S.index.events[S.index.events.length - 1]);
    setSessions(null);
    return renderPenalties(params);
  }
  const latest = S.index.events[S.index.events.length - 1];
  const slug = S.index.events.some((e) => e.slug === parts[1]) ? parts[1] : latest?.slug;
  renderSidebar(slug);
  S.currentSlug = slug;
  setClock(S.index.events.find((e) => e.slug === slug));
  setSessions(S.index.events.find((e) => e.slug === slug));
  if (!slug) { $("#main").innerHTML = `<p class="empty">No events yet.</p>`; return; }
  if (!S.events[slug]) {
    $("#main").innerHTML = `<p class="muted">Loading…</p>`;
    try { S.events[slug] = await getJSON(`events/${slug}.json`); }
    catch (e) { $("#main").innerHTML = `<p class="empty">Could not load event (${esc(e.message)}).</p>`; return; }
  }
  renderEvent(S.events[slug], params);
}

/* ------------------------------------------------------------------ event view */

const SORTS = {
  "num-desc": ["Newest document first", (a, b) => (b.num ?? -1) - (a.num ?? -1)],
  "num-asc": ["Oldest document first", (a, b) => (a.num ?? 1e9) - (b.num ?? 1e9)],
  "car": ["Car number", (a, b) => (docDrivers(a)[0]?.car ?? 999) - (docDrivers(b)[0]?.car ?? 999) || (a.num - b.num)],
  "title": ["Title A–Z", (a, b) => a.subject.localeCompare(b.subject)],
};

function renderEvent(data, params) {
  const ev = { ...data.event, ...(S.index.events.find((e) => e.slug === data.event.slug) || {}) };
  const all = data.documents;
  const cats = new Set((params.get("cat") || "").split(",").filter(Boolean));
  const q = (params.get("q") || "").trim().toLowerCase();
  const car = params.get("car") || "";
  const sort = SORTS[params.get("sort")] ? params.get("sort") : "num-desc";
  const showSup = params.get("sup") === "1";
  const group = params.get("group") !== "0";
  const stype = params.get("stype") || "";

  const visibleBase = all.filter((d) => showSup || !d.superseded_by);
  const matchesNonCat = (d) =>
    (!q || searchText(d).includes(q)) &&
    (!car || docDrivers(d).some((x) => String(x.car) === car)) &&
    (!stype || d.type === stype || (stype === "Infringement" && d.type === "Corrected Infringement"));
  const docs = visibleBase.filter((d) => matchesNonCat(d) && (!cats.size || cats.has(d.category)))
    .sort(SORTS[sort][1]);

  const catCounts = {};
  for (const d of visibleBase) if (matchesNonCat(d)) catCounts[d.category] = (catCounts[d.category] || 0) + 1;

  const carSet = new Map();
  for (const d of all) for (const x of docDrivers(d)) carSet.set(x.car, x.name);
  const carOpts = [...carSet.keys()].sort((a, b) => a - b)
    .map((c) => `<option value="${c}" ${String(c) === car ? "selected" : ""}>${esc(driverLabel(c))}</option>`).join("");

  const stewardsDocs = visibleBase.filter((d) => d.category === "stewards");
  const typeCounts = {};
  for (const d of stewardsDocs) {
    const t = d.type === "Corrected Infringement" ? "Infringement" : d.type;
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  const pdfLink = `<a href="${esc(ev.fia_url)}" target="_blank" rel="noopener">View on fia.com ↗</a>`;
  let html = `
    <div class="ev-head">
      <div>
        <div class="meta">Round ${ev.round} · ${esc(data.season)}</div>
        <h2>${esc(ev.name)}</h2>
        <div class="meta">${ev.doc_count} documents · ${esc(fmtRange(ev.first_local, ev.last_local))} · times shown in track time (${fmtOffset(ev.utc_offset_min)})</div>
      </div>
      <div class="src">${pdfLink}</div>
    </div>
    <div class="cats">
      ${S.index.categories.map((c) => {
        const n = catCounts[c.id] || 0;
        const pressed = cats.has(c.id);
        if (c.id === "other" && !n && !pressed) return "";
        return `<button class="cat ${cats.size && !pressed ? "dim" : ""}" style="${catVar(c.id)}" data-cat="${c.id}"
          aria-pressed="${pressed}" ${n || pressed ? "" : "disabled"} title="${esc(c.description)}">
          <div class="n">${n}</div><div class="l">${esc(c.label)}</div></button>`;
      }).join("")}
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search titles, drivers, teams, decisions…" value="${esc(params.get("q") || "")}">
      <select id="car"><option value="">All cars</option>${carOpts}</select>
      <select id="stype" title="Stewards document type">
        <option value="">All stewards types</option>
        ${Object.entries(typeCounts).sort().map(([t, n]) =>
          `<option value="${esc(t)}" ${t === stype ? "selected" : ""}>${esc(t)} (${n})</option>`).join("")}
      </select>
      <select id="sort">${Object.entries(SORTS).map(([k, [l]]) =>
        `<option value="${k}" ${k === sort ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label class="chk"><input type="checkbox" id="group" ${group ? "checked" : ""}> Group by type</label>
      <label class="chk"><input type="checkbox" id="sup" ${showSup ? "checked" : ""}> Show superseded</label>
      ${cats.size || q || car || stype ? `<button class="btn" id="clear">Clear filters</button>` : ""}
    </div>`;

  if (!docs.length) {
    html += `<div class="card"><div class="empty">No documents match these filters.</div></div>`;
  } else if (group) {
    for (const c of S.index.categories) {
      const list = docs.filter((d) => d.category === c.id);
      if (!list.length) continue;
      html += `<section class="section">
        <h3 class="section-h" style="${catVar(c.id)}"><span class="dot"></span>${esc(c.label)} <span class="c">${list.length}</span>
          ${c.id === "stewards" ? `<span class="spacer"></span>${expandToggle("#sec-stewards")}` : ""}</h3>
        <div class="card" id="sec-${c.id}">${list.map((d) => docHTML(d, false)).join("")}</div></section>`;
    }
  } else {
    html += `<div class="section-h"><span class="spacer"></span>${expandToggle("#flat")}</div>
      <div class="card" id="flat">${docs.map((d) => docHTML(d, true)).join("")}</div>`;
  }
  $("#main").innerHTML = html;

  // wiring
  for (const b of document.querySelectorAll(".cat")) {
    b.onclick = () => updateParams((p) => {
      const s = new Set((p.get("cat") || "").split(",").filter(Boolean));
      s.has(b.dataset.cat) ? s.delete(b.dataset.cat) : s.add(b.dataset.cat);
      p.set("cat", [...s].join(","));
    });
  }
  let t;
  $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => updateParams((p) => p.set("q", e.target.value)), 200); };
  $("#car").onchange = (e) => updateParams((p) => p.set("car", e.target.value));
  $("#stype").onchange = (e) => updateParams((p) => {
    p.set("stype", e.target.value);
    if (e.target.value) p.set("cat", "stewards");
  });
  $("#sort").onchange = (e) => updateParams((p) => p.set("sort", e.target.value === "num-desc" ? "" : e.target.value));
  $("#group").onchange = (e) => updateParams((p) => p.set("group", e.target.checked ? "" : "0"));
  $("#sup").onchange = (e) => updateParams((p) => p.set("sup", e.target.checked ? "1" : ""));
  const clr = $("#clear");
  if (clr) clr.onclick = () => updateParams((p) => { for (const k of ["cat", "q", "car", "stype"]) p.delete(k); });
  wireRelated();
  wireExpand();
  const qi = $("#q");
  if (sessionStorageGet("focusQ")) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  qi.onfocus = () => sessionStorageSet("focusQ", "1");
  qi.onblur = () => sessionStorageSet("focusQ", "");
}

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} }

function wireRelated() {
  for (const a of document.querySelectorAll("a[data-goto]")) {
    a.onclick = (e) => {
      const el = document.getElementById(a.dataset.goto);
      if (!el) return; // not visible under current filters: let the PDF link open instead
      e.preventDefault();
      if (el.tagName === "DETAILS") el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    };
  }
}

function titleLink(d, text) {
  if (d.url) return `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  return `<span>${esc(text)}</span>`;
}

function docHTML(d, showCat) {
  if (d.category === "stewards") return rulingHTML(d, { showCat });
  const cat = S.catById[d.category];
  const lead = showCat ? `<span class="pill cat-pill" style="${catVar(d.category)}">${esc(cat.label)}</span>` : "";
  const pills = [];
  if (d.recalled) pills.push(`<span class="pill">Recalled</span>`);
  if (d.superseded_by) pills.push(`<span class="pill">Superseded by Doc ${d.superseded_by}</span>`);
  for (const x of docDrivers(d)) pills.push(`<span class="pill">${esc(driverLabel(x.car))}</span>`);
  return `<div class="doc ${d.recalled ? "recalled" : ""} ${d.superseded_by ? "superseded" : ""}" id="doc-${d.num}">
    <div class="num">${d.num != null ? "Doc " + d.num : ""}</div>
    <div class="t line">${lead}<span class="subj">${titleLink(d, d.subject)}</span>${pills.join("")}</div>
    <div class="when" title="${esc(whenTitle(d))}">${esc(fmtWhen(localTime(d)))}</div>
  </div>`;
}

function shortName(full) {
  const parts = (full || "").trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : parts[0] || "";
}

function rulingHTML(d, { showCat = false, event = null } = {}) {
  const det = d.details || {};
  const drivers = docDrivers(d);
  const typeKey = (d.type || "").split(" ")[0];
  const isTable = !!det.table_rows;
  const isSummons = d.type === "Summons";
  const subject = stripTypePrefix(d.subject, d.type);
  const nameOf = (x) => x.name || S.index.drivers[String(x.car)]?.name || "";

  // ---- one-line summary
  let whoShort = "";
  if (isTable) whoShort = `${Object.keys(det.table_rows).length} cars`;
  else if (drivers.length) whoShort = drivers.map((x) => `#${x.car} ${esc(shortName(nameOf(x)))}`).join(", ");
  else if (det.competitor) whoShort = esc(det.competitor);
  const linePills = [];
  if (showCat) linePills.push(`<span class="pill cat-pill" style="${catVar("stewards")}">${esc(S.catById.stewards?.label || "Stewards")}</span>`);
  if (event) {
    const ev = S.index.events.find((e) => e.slug === d.event_slug);
    linePills.push(`<span class="pill ev-pill">R${ev?.round ?? ""} ${esc(event.replace(/ Grand Prix$/, ""))}</span>`);
  }
  if (d.recalled) linePills.push(`<span class="pill">Recalled</span>`);
  const outcomeTags = (det.tags || []).filter((t) => t !== "Fine" || !det.fine_eur);
  if (det.fine_eur) outcomeTags.push(euro(det.fine_eur) + " fine");
  const outPills = outcomeTags.map((t) => `<span class="pill o-${det.outcome || "other"}">${esc(t)}</span>`).join("");

  // ---- expanded detail
  let body = "";
  const who = isTable ? "" : drivers.length
    ? drivers.map((x) => `#${x.car} ${esc(nameOf(x))}`).join(", ") : esc(det.competitor || "");
  const meta = [who && `<b>${who}</b>`, drivers.length && det.competitor && esc(det.competitor), det.session && esc(det.session),
    det.time && `Incident ${esc(det.time)}`].filter(Boolean);
  if (meta.length) body += `<div class="meta-line">${meta.join(" · ")}</div>`;
  if (isTable) {
    body += `<div class="tagline">${Object.entries(det.table_rows).sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([car, n]) => `<span class="pill">${esc(driverLabel(car))}${n > 1 ? " ×" + n : ""}</span>`).join("")}</div>`;
  }
  if (det.fact && det.fact.toLowerCase() !== subject.toLowerCase()) body += `<div class="fact">${esc(det.fact)}</div>`;
  if (isSummons && det.reason) body += `<div class="fact">${esc(det.reason)}</div>`;
  if (det.infringement) body += `<div class="fact muted small">${esc(det.infringement)}</div>`;
  if (det.decision) {
    body += `<div class="outcome" style="--oc:var(--o-${det.outcome || "other"})"><b>Decision</b>${esc(det.decision)}</div>`;
  }
  if (!isSummons && det.reason) body += `<details class="sub"><summary>Stewards' reasoning</summary><p>${esc(det.reason)}</p></details>`;
  if (det.summary) {
    const short = det.summary.length > 320 ? det.summary.slice(0, 300).replace(/\s+\S*$/, "") + "…" : det.summary;
    body += `<div class="fact">${esc(short)}</div>`;
    if (short !== det.summary) body += `<details class="sub"><summary>Full text</summary><p>${esc(det.summary)}</p></details>`;
  }
  const foot = [];
  if (d.url) foot.push(`<a href="${esc(d.url)}" target="_blank" rel="noopener">Open PDF ↗</a>`);
  if (event) foot.push(`<a href="#/event/${esc(d.event_slug)}">Go to ${esc(event)}</a>`);
  if (det.from && !/stewards/i.test(det.from)) foot.push(`From: ${esc(det.from)}`);
  if (d.related?.length) foot.push(`Related: ${d.related.map((n) => `<a href="#" data-goto="doc-${n}">Doc ${n}</a>`).join(" ")}`);
  if (foot.length) body += `<div class="rel">${foot.join('<span class="sep">·</span>')}</div>`;

  return `<details class="ruling ${d.recalled ? "recalled" : ""}" ${event ? "" : `id="doc-${d.num}"`}>
    <summary>
      <span class="num">${d.num != null ? "Doc " + d.num : ""}</span>
      <span class="line">
        ${linePills.join("")}
        <span class="type type-${esc(typeKey)}">${esc(d.type || "")}</span>
        ${whoShort ? `<span class="who">${whoShort}</span>` : ""}
        <span class="subj">${esc(subject)}</span>
        ${outPills}
      </span>
      <span class="when" title="${esc(whenTitle(d))}">${esc(fmtWhen(localTime(d)))}</span>
    </summary>
    <div class="ruling-body">${body || `<div class="muted">No further detail parsed from this document.</div>`}</div>
  </details>`;
}

function expandToggle(scopeSel) {
  return `<button class="btn btn-sm" data-expand="${scopeSel}">Expand all</button>`;
}
function wireExpand() {
  for (const b of document.querySelectorAll("[data-expand]")) {
    b.onclick = () => {
      const items = document.querySelectorAll(`${b.dataset.expand} details.ruling`);
      const open = b.textContent === "Expand all";
      items.forEach((d) => { d.open = open; });
      b.textContent = open ? "Collapse all" : "Expand all";
    };
  }
}

/* ------------------------------------------------------------------ penalties view */

const OUTCOMES = [["penalty", "Penalties"], ["reprimand", "Reprimands"], ["warning", "Warnings"], ["nfa", "No further action"],
  ["deleted", "Lap times deleted"], ["other", "Other"]];

function penaltyKeys(d) {
  const ds = docDrivers(d);
  if (ds.length) return ds.map((x) => ({ key: "car:" + x.car, car: x.car, name: x.name || S.index.drivers[String(x.car)]?.name || "", team: d.details?.competitor || S.index.drivers[String(x.car)]?.team || "" }));
  const team = d.details?.competitor;
  return team ? [{ key: "team:" + team, car: null, name: "(team)", team }] : [];
}

async function renderPenalties(params) {
  if (!S.penalties) {
    $("#main").innerHTML = `<p class="muted">Loading…</p>`;
    try { S.penalties = await getJSON("penalties.json"); }
    catch (e) { $("#main").innerHTML = `<p class="empty">Could not load penalties (${esc(e.message)}).</p>`; return; }
  }
  const all = S.penalties.documents.filter((d) => !d.recalled);
  const who = params.get("who") || "";
  const outcome = params.get("outcome") || "";
  const evf = params.get("event") || "";
  const q = (params.get("q") || "").trim().toLowerCase();
  const sortKey = params.get("sort") || "penalty";
  const asc = params.get("dir") === "asc";

  const base = all.filter((d) => (!evf || d.event_slug === evf) && (!q || searchText(d).includes(q)));
  const rows = base.filter((d) =>
    (!outcome || (d.details?.outcome || "other") === outcome) &&
    (!who || penaltyKeys(d).some((k) => k.key === who)));

  // per-driver summary (over `base`, so the table stays useful while a row is selected)
  const agg = new Map();
  for (const d of base) {
    const det = d.details || {};
    for (const k of penaltyKeys(d)) {
      if (!agg.has(k.key)) agg.set(k.key, { ...k, total: 0, penalty: 0, reprimand: 0, warning: 0, nfa: 0, other: 0, deleted: 0, laps: 0, points: 0, fines: 0 });
      const a = agg.get(k.key);
      if (k.team && !a.team) a.team = k.team;
      if (det.outcome === "deleted") {
        a.deleted++;
        a.laps += det.table_rows?.[String(k.car)] || 1;
        continue;
      }
      a.total++;
      a[det.outcome || "other"]++;
      a.points += det.penalty_points || 0;
      if (!k.car || penaltyKeys(d).length === 1) a.fines += det.fine_eur || 0;
    }
  }
  const cols = [
    ["car", "Car", (a) => a.car ?? 999, true], ["name", "Driver", (a) => a.name, false], ["team", "Team", (a) => a.team, false],
    ["total", "Rulings", (a) => a.total, true], ["penalty", "Penalties", (a) => a.penalty, true],
    ["reprimand", "Reprimands", (a) => a.reprimand, true], ["warning", "Warnings", (a) => a.warning, true],
    ["nfa", "NFA", (a) => a.nfa, true], ["points", "Pen. points", (a) => a.points, true], ["fines", "Fines", (a) => a.fines, true],
    ["laps", "Laps deleted", (a) => a.laps, true],
  ];
  const col = cols.find((c) => c[0] === sortKey) || cols[4];
  const summary = [...agg.values()].sort((x, y) => {
    const a = col[2](x), b = col[2](y);
    const r = typeof a === "string" ? a.localeCompare(b) : a - b;
    return (asc ? r : -r) || (y.total - x.total);
  });

  const tot = { penalty: 0, reprimand: 0, warning: 0, nfa: 0, deleted: 0, fines: 0, points: 0 };
  for (const d of base) {
    const det = d.details || {};
    if (tot[det.outcome] != null) tot[det.outcome]++;
    tot.fines += det.fine_eur || 0;
    tot.points += det.penalty_points || 0;
  }

  const evOpts = S.index.events.map((e) =>
    `<option value="${esc(e.slug)}" ${e.slug === evf ? "selected" : ""}>R${e.round} ${esc(e.name)}</option>`).join("");
  const whoLabel = who ? (agg.get(who) ? (agg.get(who).car ? driverLabel(agg.get(who).car) : agg.get(who).team) : who) : "";

  $("#main").innerHTML = `
    <div class="ev-head"><div>
      <div class="meta">${esc(S.index.season)}</div>
      <h2>Season penalties</h2>
      <div class="meta">Every stewards' Infringement and Decision document, parsed from the PDFs. Deleted lap times (track limits) are counted separately.</div>
    </div></div>
    <div class="stat-row">
      <div class="stat"><div class="n">${base.length - tot.deleted}</div><div class="l">Rulings</div></div>
      <div class="stat"><div class="n" style="color:var(--o-penalty)">${tot.penalty}</div><div class="l">Penalties</div></div>
      <div class="stat"><div class="n" style="color:var(--o-reprimand)">${tot.reprimand}</div><div class="l">Reprimands</div></div>
      <div class="stat"><div class="n" style="color:var(--o-warning)">${tot.warning}</div><div class="l">Warnings</div></div>
      <div class="stat"><div class="n" style="color:var(--o-nfa)">${tot.nfa}</div><div class="l">No further action</div></div>
      <div class="stat"><div class="n">${tot.points}</div><div class="l">Penalty points</div></div>
      <div class="stat"><div class="n">${euro(tot.fines)}</div><div class="l">Fines</div></div>
      <div class="stat"><div class="n">${tot.deleted}</div><div class="l">Deleted-lap rulings</div></div>
    </div>
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search offences, decisions, drivers…" value="${esc(params.get("q") || "")}">
      <select id="event"><option value="">All rounds</option>${evOpts}</select>
      <select id="outcome"><option value="">All outcomes</option>${OUTCOMES.map(([k, l]) =>
        `<option value="${k}" ${k === outcome ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${who || outcome || evf || q ? `<button class="btn" id="clear">Clear filters</button>` : ""}
    </div>
    <section class="section">
      <h3 class="section-h" style="${catVar("stewards")}"><span class="dot"></span>By driver / team <span class="c">click a row to filter</span></h3>
      <div class="card tbl-wrap"><table>
        <thead><tr>${cols.map(([k, l, , num]) =>
          `<th data-sort="${k}" class="${num ? "num" : ""} ${k === col[0] ? "sorted" + (asc ? " asc" : "") : ""}">${l}</th>`).join("")}</tr></thead>
        <tbody>${summary.map((a) => `<tr data-who="${esc(a.key)}" class="${a.key === who ? "sel" : ""}">
          <td class="num">${a.car ?? ""}</td><td>${esc(a.name)}</td><td class="muted">${esc(a.team)}</td>
          <td class="num">${a.total}</td><td class="num">${a.penalty || ""}</td><td class="num">${a.reprimand || ""}</td>
          <td class="num">${a.warning || ""}</td><td class="num">${a.nfa || ""}</td><td class="num">${a.points || ""}</td>
          <td class="num">${a.fines ? euro(a.fines) : ""}</td><td class="num">${a.laps || ""}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>
    <section class="section">
      <h3 class="section-h" style="${catVar("stewards")}"><span class="dot"></span>Rulings${whoLabel ? " · " + esc(whoLabel) : ""} <span class="c">${rows.length}</span>
        <span class="spacer"></span>${expandToggle("#pen-rulings")}</h3>
      <div class="card" id="pen-rulings">${rows.length ? rows.slice().sort((a, b) => (b.published || "").localeCompare(a.published || ""))
        .map((d) => rulingHTML(d, { event: d.event })).join("") : `<div class="empty">No rulings match.</div>`}</div>
    </section>`;

  let t;
  $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => updateParams((p) => p.set("q", e.target.value)), 200); };
  const qi = $("#q");
  if (sessionStorageGet("focusQ")) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  qi.onfocus = () => sessionStorageSet("focusQ", "1");
  qi.onblur = () => sessionStorageSet("focusQ", "");
  $("#event").onchange = (e) => updateParams((p) => p.set("event", e.target.value));
  $("#outcome").onchange = (e) => updateParams((p) => p.set("outcome", e.target.value));
  const clr = $("#clear");
  if (clr) clr.onclick = () => updateParams((p) => { for (const k of ["who", "outcome", "event", "q"]) p.delete(k); });
  wireExpand();
  for (const tr of document.querySelectorAll("tbody tr[data-who]")) {
    tr.onclick = () => updateParams((p) => p.set("who", p.get("who") === tr.dataset.who ? "" : tr.dataset.who));
  }
  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.onclick = () => updateParams((p) => {
      if (p.get("sort") === th.dataset.sort || (!p.get("sort") && th.dataset.sort === "penalty")) {
        p.set("dir", p.get("dir") === "asc" ? "" : "asc");
      } else { p.set("sort", th.dataset.sort); p.set("dir", ""); }
    });
  }
}

boot();
