"use strict";

// Standalone, phone-friendly session times page. Reads the same data/index.json as the main viewer.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");

let INDEX = null, EV = null;

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

function render() {
  const now = Date.now();
  const list = EV.sessions || [];
  $("#round").textContent = `Round ${EV.round} · ${INDEX.season}`;
  $("#evName").textContent = EV.name;
  document.title = `${EV.name.replace(/ Grand Prix$/, " GP")} · Sessions`;

  const live = list.find((s) => state(s, now) === "live");
  const nextS = list.find((s) => state(s, now) === "next");
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
      times = `<div class="m-t"><span class="m-tag">Track</span><span>${esc(c.day)}</span></div>
        <div class="m-sub">Results published ${esc(c.time)} track time</div>`;
    } else {
      const a = trackParts(s.start_local), b = trackParts(s.end_local);
      const ya = youParts(s.start_utc), yb = youParts(s.end_utc);
      const you = `<div class="m-t m-you"><span class="m-tag">You</span><span>${esc(ya.day)}</span><b>${esc(ya.time)}–${esc(yb.time)}</b></div>`;
      const track = `<div class="m-t"><span class="m-tag">Track</span><span>${esc(a.day)}</span><b>${esc(a.time)}–${esc(b.time)}</b></div>`;
      times = st === "next" ? you + track : track;
    }
    return `<li class="m-card ${st}">
      <div class="m-card-head"><span class="m-name">${esc(s.name)}</span>${badge}</div>
      ${times}
    </li>`;
  }).join("") || `<li class="m-empty">Session times appear once the FIA publishes this event's timetable.</li>`;

  $("#note").textContent = list.length ? sourceNote(list) : "";
  tickClocks();
}

function selectEvent(slug, push) {
  EV = INDEX.events.find((e) => e.slug === slug) || pickDefault(INDEX.events);
  $("#evSelect").value = EV.slug;
  $(".m-back").href = `./#/event/${EV.slug}`;
  if (push) history.replaceState(null, "", `?event=${encodeURIComponent(EV.slug)}`);
  render();
}

async function load() {
  const r = await fetch("data/index.json", { cache: "no-cache" });
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
