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
  getJSON("updated.json").then((u) => {
    $("#updated").innerHTML = `Data updated ${esc(u.updated.replace("T", " ").replace("Z", " UTC"))}<br>` +
      `Source: <a href="${esc(S.index.source)}" target="_blank" rel="noopener">fia.com</a>`;
  }).catch(() => {});
  window.addEventListener("hashchange", render);
  render();
}

function renderSidebar(activeSlug) {
  const pens = (e) => e.counts?.stewards || 0;
  $("#eventList").innerHTML = S.index.events.slice().reverse().map((e) => `
    <li><a href="#/event/${esc(e.slug)}" class="${e.slug === activeSlug ? "active" : ""}" title="${esc(fmtRange(e.first_published, e.last_published))}">
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
    return renderPenalties(params);
  }
  const latest = S.index.events[S.index.events.length - 1];
  const slug = parts[1] || latest?.slug;
  renderSidebar(slug);
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
        <div class="meta">${ev.doc_count} documents · ${esc(fmtRange(ev.first_published, ev.last_published))}</div>
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
        <h3 class="section-h" style="${catVar(c.id)}"><span class="dot"></span>${esc(c.label)} <span class="c">${list.length}</span></h3>
        <div class="card">${list.map((d) => docHTML(d, false)).join("")}</div></section>`;
    }
  } else {
    html += `<div class="card">${docs.map((d) => docHTML(d, true)).join("")}</div>`;
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
  const pills = [];
  if (showCat) pills.push(`<span class="pill cat-pill" style="${catVar(d.category)}">${esc(cat.label)}</span>`);
  if (d.recalled) pills.push(`<span class="pill">Recalled</span>`);
  if (d.superseded_by) pills.push(`<span class="pill">Superseded by Doc ${d.superseded_by}</span>`);
  for (const x of docDrivers(d)) pills.push(`<span class="pill">${esc(driverLabel(x.car))}</span>`);
  return `<div class="doc ${d.recalled ? "recalled" : ""} ${d.superseded_by ? "superseded" : ""}" id="doc-${d.num}">
    <div class="num">${d.num != null ? "Doc " + d.num : ""}</div>
    <div class="t">${titleLink(d, d.subject)}${pills.length ? `<div class="tagline">${pills.join("")}</div>` : ""}</div>
    <div class="when" title="Published (CET)">${esc(fmtWhen(d.published))}</div>
  </div>`;
}

function rulingHTML(d, { showCat = false, event = null } = {}) {
  const det = d.details || {};
  const drivers = docDrivers(d);
  const typeKey = (d.type || "").split(" ")[0];
  const isTable = !!det.table_rows;
  const who = isTable ? "" : drivers.length
    ? drivers.map((x) => `#${x.car} ${esc(x.name || S.index.drivers[String(x.car)]?.name || "")}`).join(", ")
    : esc(det.competitor || "");
  const team = drivers.length && det.competitor ? ` <span class="team">· ${esc(det.competitor)}</span>` : "";
  const headBits = [d.type, det.session].filter(Boolean).map(esc).join(" · ");
  const subject = stripTypePrefix(d.subject, d.type);
  const isSummons = d.type === "Summons";
  const pills = [];
  if (showCat) pills.push(`<span class="pill cat-pill" style="${catVar("stewards")}">Stewards</span>`);
  if (d.recalled) pills.push(`<span class="pill">Recalled</span>`);
  if (isTable) {
    for (const [car, n] of Object.entries(det.table_rows).sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
      pills.push(`<span class="pill">${esc(driverLabel(car))}${n > 1 ? " ×" + n : ""}</span>`);
    }
  }

  let body = "";
  if (det.fact && det.fact.toLowerCase() !== subject.toLowerCase()) body += `<div class="fact muted">${esc(det.fact)}</div>`;
  if (isSummons && det.reason) body += `<div class="fact muted">${esc(det.reason)}</div>`;
  if (det.infringement) body += `<div class="fact muted" style="font-size:12px">${esc(det.infringement)}</div>`;
  if (det.decision) {
    const oc = `var(--o-${det.outcome || "other"})`;
    body += `<div class="outcome" style="--oc:${oc}"><b>Decision</b>${esc(det.decision)}
      ${det.tags?.length ? `<div class="tagline">${det.tags.map((t) =>
        `<span class="pill o-${det.outcome || "other"}">${esc(t)}</span>`).join("")}</div>` : ""}</div>`;
  }
  if (!isSummons && det.reason) body += `<details><summary>Stewards' reasoning</summary><p>${esc(det.reason)}</p></details>`;
  if (det.summary) {
    const short = det.summary.length > 320 ? det.summary.slice(0, 300).replace(/\s+\S*$/, "") + "…" : det.summary;
    body += `<div class="fact muted">${esc(short)}</div>`;
    if (short !== det.summary) body += `<details><summary>Full text</summary><p>${esc(det.summary)}</p></details>`;
  }
  if (det.from && !/stewards/i.test(det.from)) body += `<div class="rel">From: ${esc(det.from)}</div>`;
  if (d.related?.length) {
    body += `<div class="rel">Related: ${d.related.map((n) =>
      `<a href="#" data-goto="doc-${n}">Doc ${n}</a>`).join("")}</div>`;
  }
  const evLink = event ? `<div class="ev-link"><a href="#/event/${esc(d.event_slug)}">${esc(event)}</a></div>` : "";

  return `<div class="ruling ${d.recalled ? "recalled" : ""}" id="${event ? "" : "doc-" + d.num}">
    <div class="num muted" style="font-size:12px">${d.num != null ? "Doc " + d.num : ""}</div>
    <div style="min-width:0">
      ${evLink}
      <div class="type type-${esc(typeKey)}">${headBits}</div>
      ${who ? `<div class="who">${who}${team}</div>` : ""}
      <div class="fact">${titleLink(d, subject)}</div>
      ${pills.length ? `<div class="tagline">${pills.join("")}</div>` : ""}
      ${body}
    </div>
    <div class="when muted" style="font-size:12px" title="Published (CET)">${esc(fmtWhen(d.published))}</div>
  </div>`;
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
      <h3 class="section-h" style="${catVar("stewards")}"><span class="dot"></span>Rulings${whoLabel ? " · " + esc(whoLabel) : ""} <span class="c">${rows.length}</span></h3>
      <div class="card">${rows.length ? rows.slice().sort((a, b) => (b.published || "").localeCompare(a.published || ""))
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
