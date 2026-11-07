"use strict";

// Sky Sports F1 (UK channel 407) live coverage start times, from the public feed behind sky.com's TV guide.
// The feed sends Access-Control-Allow-Origin: *, so the browser reads it directly and it is always current.
const SkyTV = (() => {
  const SID = "3835";            // Sky's service id for "SkySp F1 HD", channel 407
  const CHANNEL = "Sky Sports F1 (407)";
  const REFRESH_MS = 30 * 60000;
  const days = {};               // "YYYYMMDD" -> { events, fetched, loading }
  const listeners = new Set();

  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

  async function loadDay(day) {
    const cur = days[day];
    if (cur && (cur.loading || Date.now() - cur.fetched < REFRESH_MS)) return;
    days[day] = { ...(cur || {}), loading: true };
    try {
      const r = await fetch(`https://awk.epgsky.com/hawk/linear/schedule/${day}/${SID}`);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      const events = (j.schedule || []).flatMap((x) => x.events || [])
        .map((e) => ({ title: e.t || "", start: e.st * 1000, end: (e.st + e.d) * 1000, synopsis: e.sy || "" }));
      days[day] = { events, fetched: Date.now() };
    } catch {
      days[day] = { ...(cur || {}), events: cur?.events || [], fetched: Date.now() - REFRESH_MS + 5 * 60000 };
    }
    listeners.forEach((f) => f());
  }

  // Fetch the guide days covering an event's live/upcoming sessions (the guide only runs ~a week ahead).
  function load(sessions) {
    const now = Date.now();
    const wanted = new Set();
    for (const s of sessions) {
      if (s.inferred) continue;
      const st = Date.parse(s.start_utc), en = Date.parse(s.end_utc);
      if (en < now || st > now + 8 * 86400000) continue;
      [st - 4 * 3600000, st, en].forEach((t) => wanted.add(ymd(t)));
    }
    wanted.forEach(loadDay);
  }

  function onUpdate(fn) { listeners.add(fn); }

  const SERIES_RX = { f1: null, f2: /\b(f2|formula 2)\b/i, f3: /\b(f3|formula 3)\b/i };
  const AFTER_RX = /chequered flag|notebook|highlights|replay|reaction|press conference/i;

  // Live programme covering the session start, plus any live build-up that runs straight into it.
  function forSession(s, series = "f1") {
    if (s.inferred) return null;
    const start = Date.parse(s.start_utc);
    const evs = Object.values(days).flatMap((d) => d.events || [])
      .filter((e, i, a) => a.findIndex((x) => x.start === e.start && x.title === e.title) === i)
      .sort((a, b) => a.start - b.start);
    const relevant = (e) => {
      if (!/^live\b/i.test(e.title)) return false;
      const other = series === "f1" ? /\b(f2|f3|formula 2|formula 3)\b/i.test(e.title) : !SERIES_RX[series].test(e.title);
      return !other;
    };
    const main = evs.find((e) => relevant(e) && !AFTER_RX.test(e.title) && e.start <= start + 10 * 60000 && e.end > start);
    if (!main) return null;
    let first = main;
    for (;;) {
      const prev = evs.find((e) => relevant(e) && !AFTER_RX.test(e.title) && e.end === first.start && e !== first);
      if (!prev) break;
      first = prev;
    }
    const clean = (t) => t.replace(/^live\s+/i, "");
    return { channel: CHANNEL, from: first.start, mainStart: main.start,
      titles: [...new Set([first, main].map((e) => clean(e.title)))] };
  }

  // Material Design Icons "monitor" (mdi:monitor), drawn in the current text colour
  const ICON = '<svg class="tv-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" ' +
    'd="M21,16H3V4H21M21,2H3C1.89,2 1,2.89 1,4V16A2,2 0 0,0 3,18H10V20H8V22H16V20H14V18H21A2,2 0 0,0 23,16V4C23,2.89 22.1,2 21,2Z"/></svg>';

  return { load, forSession, onUpdate, CHANNEL, ICON };
})();
