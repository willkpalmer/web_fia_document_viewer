"use strict";

// Standalone, phone-friendly session times page. Reads the same data/index.json as the main viewer.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");

let INDEX = null, EV = null;
const SERIES = ["f1", "f2", "f3"].includes(new URLSearchParams(location.search).get("series"))
  ? new URLSearchParams(location.search).get("series") : "f1";
const DATA_DIR = SERIES === "f1" ? "data/" : `data/${SERIES}/`;
const SERIES_QS = SERIES === "f1" ? "" : `series=${SERIES}&`;
document.documentElement.dataset.series = SERIES;
const SERIES_COLOUR = { f2: "#089be2", f3: "#f77331" }[SERIES];
if (SERIES_COLOUR) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", SERIES_COLOUR);

function fmtOffset(min) {
  if (min == null) return "";
  const sign = min < 0 ? "−" : "+", a = Math.abs(min);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + p2(a % 60) : ""}`;
}
function viewerTz(d = new Date()) {
  return (Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d)
    .find((x) => x.type === "timeZoneName") || {}).value || "";
}
// track-local ISO string "2026-11-06T12:30" -> {day, time}
function trackParts(iso) {
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-").map(Number);
  return { day: `${DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]} ${day} ${MONTHS[m - 1]}`, time: t.slice(0, 5) };
}
function youParts(utc) {
  const dt = new Date(utc);
  return { day: `${DAYS[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}`, time: `${p2(dt.getHours())}:${p2(dt.getMinutes())}` };
}
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function state(s, now) {
  if (s.inferred) return "done";
  const st = Date.parse(s.start_utc), en = Date.parse(s.end_utc);
  return now >= en ? "done" : now >= st ? "live" : "next";
}

function pickDefault(events) {
  const now = Date.now();
  // the event with a live or upcoming session soonest; otherwise the latest event
  const upcoming = events.filter((e) => (e.sessions || []).some((s) => !s.inferred && Date.parse(s.end_utc) > now));
  return upcoming[0] || events[events.length - 1];
}

function tickClocks() {
  if (!EV) return;
  const now = new Date();
  $("#youTime").textContent = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  $("#youDay").textContent = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  $("#youTz").textContent = viewerTz(now);
  if (EV.utc_offset_min != null) {
    const t = new Date(now.getTime() + EV.utc_offset_min * 60000);
    $("#trackTime").textContent = `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}`;
    $("#trackDay").textContent = `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
    $("#trackTz").textContent = fmtOffset(EV.utc_offset_min);
  }
}

function sourceNote(list) {
  const fia = list.some((s) => s.source === "fia"), f1 = list.some((s) => s.source === "f1");
  const parts = [];
  if (fia && f1) parts.push("From the FIA event timetable; sessions it doesn't cover are from formula1.com.");
  else if (fia) parts.push("From the FIA event timetable.");
  else if (f1) parts.push("From the formula1.com schedule (no FIA timetable available).");
  if (list.some((s) => s.inferred)) parts.push("Sessions without a published time are shown from their results.");
  if (fia || f1) parts.push("Race end times are approximate.");
  return parts.join(" ");
}

/* forecast rain per session (Open-Meteo hourly), shown once the weekend has started at the track */
const WX = {};   // slug -> { hourly, fetched }
const timed = (ev) => (ev?.sessions || []).filter((s) => !s.inferred);
function isPast(ev, now = Date.now()) {
  const ts = timed(ev);
  return ts.length ? now > Math.max(...ts.map((s) => Date.parse(s.end_utc))) + 3 * 3600000 : true;
}
function weekendStarted(ev, now = Date.now()) {
  const ts = timed(ev);
  if (!ts.length || ev.utc_offset_min == null) return false;
  return now >= Date.parse(ts[0].start_local.slice(0, 10) + "T00:00:00Z") - ev.utc_offset_min * 60000;
}
async function loadRain(ev) {
  if (!ev.location) return;
  const cur = WX[ev.slug];
  if (cur && (cur.loading || Date.now() - cur.fetched < 10 * 60000)) return;
  WX[ev.slug] = { ...(cur || {}), loading: true };
  const ts = timed(ev);
  const hours = Math.min(384, Math.max(3, Math.ceil((Math.max(...ts.map((s) => Date.parse(s.end_utc))) - Date.now()) / 3600000) + 2));
  try {
    const r = await fetch("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: ev.location.lat, longitude: ev.location.lon, timezone: "GMT",
      hourly: "precipitation_probability,precipitation", forecast_hours: String(hours) }));
    if (!r.ok) throw new Error(r.status);
    WX[ev.slug] = { hourly: (await r.json()).hourly, fetched: Date.now() };
  } catch {
    WX[ev.slug] = { ...(cur || {}), fetched: Date.now() - 8 * 60000 };   // retry in ~2 minutes
  }
  if (EV && EV.slug === ev.slug) render();
}
function sessionRain(ev, s) {
  const d = WX[ev.slug]?.hourly;
  if (!d?.time) return null;
  const start = Date.parse(s.start_utc), end = Date.parse(s.end_utc);
  const hours = d.time.map((t) => Date.parse(t + "Z"));
  const idx = hours.map((t, i) => (t + 3600000 > start && t < end ? i : -1)).filter((i) => i >= 0);
  if (!idx.length || hours[hours.length - 1] + 3600000 < end) return null;
  const probs = idx.map((i) => d.precipitation_probability?.[i]).filter((v) => v != null);
  if (probs.length < idx.length) return null;
  return { prob: Math.max(...probs), mm: idx.reduce((a, i) => a + (d.precipitation?.[i] || 0), 0) };
}

function render() {
  const now = Date.now();
  const list = EV.sessions || [];
  $("#evName").textContent = EV.name;
  document.title = `${SERIES.toUpperCase()} ${EV.name.replace(/ Grand Prix$/, " GP")} · Sessions`;
  $("#round").textContent = `${INDEX.series_label || SERIES.toUpperCase()} · Round ${EV.round} · ${INDEX.season}`;

  const live = list.find((s) => state(s, now) === "live");
  const nextS = list.find((s) => state(s, now) === "next");
  const showRain = !isPast(EV, now) && weekendStarted(EV, now);
  if (showRain) loadRain(EV);
  if (!isPast(EV, now)) SkyTV.load(list);
  const nx = $("#next");
  if (live) {
    nx.hidden = false;
    nx.className = "m-next live";
    nx.innerHTML = `<i></i><b>${esc(live.name)}</b> in progress · ${fmtDur(Date.parse(live.end_utc) - now)} left`;
  } else if (nextS) {
    nx.hidden = false;
    nx.className = "m-next";
    nx.innerHTML = `Next: <b>${esc(nextS.name)}</b> in <b>${fmtDur(Date.parse(nextS.start_utc) - now)}</b>`;
  } else nx.hidden = true;

  $("#list").innerHTML = list.map((s) => {
    const st = state(s, now);
    let badge;
    if (st === "done") badge = `<span class="s-badge done">✓ Complete</span>`;
    else if (st === "live") badge = `<span class="s-badge live"><i></i>Live · ${fmtDur(Date.parse(s.end_utc) - now)} left</span>`;
    else badge = `<span class="s-badge next">in ${fmtDur(Date.parse(s.start_utc) - now)}</span>`;

    let times;
    if (s.inferred) {
      const c = trackParts(s.classified_local);
      times = `<div class="m-t"><span class="m-tag">Track</span><span>${esc(c.day.split(" ")[0])}</span></div>
        <div class="m-sub">Results published ${esc(c.time)} track time</div>`;
    } else {
      const a = trackParts(s.start_local), b = trackParts(s.end_local);
      const ya = youParts(s.start_utc), yb = youParts(s.end_utc);
      const you = `<div class="m-t m-you"><span class="m-tag">You</span><span>${esc(ya.day.split(" ")[0])}</span><b>${esc(ya.time)}–${esc(yb.time)}</b></div>`;
      const track = `<div class="m-t"><span class="m-tag">Track</span><span>${esc(a.day.split(" ")[0])}</span><b>${esc(a.time)}–${esc(b.time)}</b></div>`;
      times = st === "next" ? you + track : track;
    }
    let rain = "";
    const rr = st !== "done" && !s.inferred && showRain ? sessionRain(EV, s) : null;
    if (rr) {
      const level = rr.prob >= 60 ? "high" : rr.prob >= 30 ? "mid" : "low";
      rain = `<div class="s-rain ${level}"><span>☂</span> ${Math.round(rr.prob)}% chance of rain${rr.mm >= 0.1 ? ` · ~${rr.mm < 10 ? rr.mm.toFixed(1) : Math.round(rr.mm)} mm` : ""}</div>`;
    }
    const tv = st !== "done" && !isPast(EV, now) ? SkyTV.forSession(s, SERIES) : null;
    if (tv) {
      const t = new Date(tv.from);
      const title = esc(tv.channel + ": " + tv.titles.join(" → "));
      rain = (now >= tv.from && now < Date.parse(s.end_utc)
        ? `<div class="s-tv on-air" title="${title}">${SkyTV.ICON} <i></i><b>Live Now</b></div>`
        : `<div class="s-tv" title="${title}">${SkyTV.ICON} Live from <b>${p2(t.getHours())}:${p2(t.getMinutes())}</b> ${esc(viewerTz(t))}</div>`) + rain;
    }
    return `<li class="m-card ${st}">
      <div class="m-card-head"><span class="m-name">${esc(s.name)}</span>${badge}</div>
      ${times}
      ${rain}
    </li>`;
  }).join("") || `<li class="m-empty">Session times appear once the FIA publishes this event's timetable.</li>`;

  $("#note").textContent = list.length ? sourceNote(list) : "";
  tickClocks();
}

function selectEvent(slug, push) {
  EV = INDEX.events.find((e) => e.slug === slug) || pickDefault(INDEX.events);
  $("#evSelect").value = EV.slug;
  $(".m-back").href = `./${SERIES === "f1" ? "" : "?series=" + SERIES}#/event/${EV.slug}`;
  if (push) history.replaceState(null, "", `?${SERIES_QS}event=${encodeURIComponent(EV.slug)}`);
  render();
}

async function load() {
  const r = await fetch(`${DATA_DIR}index.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function boot() {
  try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("#themeBtn").onclick = () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  };
  try { INDEX = await load(); }
  catch (e) { $("#evName").textContent = "Could not load data"; return; }

  $("#evSelect").innerHTML = INDEX.events.slice().reverse()
    .map((e) => `<option value="${esc(e.slug)}">R${e.round} ${esc(e.name.replace(/ Grand Prix$/, " GP"))}</option>`).join("");
  $("#evSelect").onchange = (e) => selectEvent(e.target.value, true);
  selectEvent(new URLSearchParams(location.search).get("event"), false);

  SkyTV.onUpdate(render);
  setInterval(tickClocks, 1000);
  setInterval(render, 30000);
  // pick up new timetables published by a sync
  setInterval(async () => {
    try {
      INDEX = await load();
      EV = INDEX.events.find((e) => e.slug === EV.slug) || EV;
      render();
    } catch {}
  }, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") render(); });
}

boot();
