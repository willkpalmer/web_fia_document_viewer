#!/usr/bin/env python3
"""Scrape FIA Formula One decision documents for the current season.

Writes JSON consumed by the static site:
  site/data/index.json          season + event list, categories, drivers
  site/data/events/<slug>.json  documents for one event
  site/data/penalties.json      every parsed stewards document of the season

Stewards PDFs are downloaded once and parsed with `pdftotext -layout`
(poppler-utils); parsed results are cached in scraper/cache/pdf_details.json.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections import Counter
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from urllib.parse import unquote, urljoin

import requests
from bs4 import BeautifulSoup

from categories import CATEGORIES, categorise, stewards_type

BASE = "https://www.fia.com"
CHAMPIONSHIP_URL = BASE + "/documents/championships/fia-formula-one-world-championship-14"
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "site" / "data"
CACHE_FILE = Path(__file__).resolve().parent / "cache" / "pdf_details.json"
F1_CACHE_FILE = Path(__file__).resolve().parent / "cache" / "f1_schedule.json"
F1_BASE = "https://www.formula1.com"

# Championships scraped on every run. F1 data stays at site/data/ so existing links keep working.
SERIES = [
    {"id": "f1", "label": "Formula 1", "championship": "FIA Formula One World Championship",
     "url": BASE + "/documents/championships/fia-formula-one-world-championship-14",
     "data": DATA_DIR, "timetable_label": "FORMULA 1"},
    {"id": "f2", "label": "Formula 2", "championship": "FIA Formula 2 Championship",
     "url": BASE + "/documents/championships/formula-2-championship-44",
     "data": DATA_DIR / "f2", "timetable_label": "FIA FORMULA 2"},
]
CACHE_VERSION = 2  # cache stores raw PDF text; parsing reruns every time

session = requests.Session()
session.headers["User-Agent"] = (
    "Mozilla/5.0 (compatible; fia-document-viewer/1.0; "
    "+https://github.com/willkpalmer/web_fia_document_viewer)"
)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url: str, binary=False, tries=4):
    delay = 2
    for attempt in range(tries):
        try:
            r = session.get(url, timeout=60)
            if r.status_code == 200:
                return r.content if binary else r.text
            log(f"  HTTP {r.status_code} for {url}")
            if r.status_code in (403, 404):
                return None
        except requests.RequestException as e:
            log(f"  error {e} for {url}")
        time.sleep(delay)
        delay *= 2
    return None


# --------------------------------------------------------------------------- listing pages

def select_options(soup: BeautifulSoup, select_id: str):
    sel = soup.find("select", id=select_id)
    if not sel:
        return []
    out = []
    for o in sel.find_all("option"):
        v = o.get("value", "0")
        if v and v != "0":
            out.append((urljoin(BASE, v), o.get_text(strip=True)))
    return out


def find_select(soup, placeholder):
    """Facet <select> ids aren't stable; identify them by their placeholder option."""
    for sel in soup.find_all("select"):
        first = sel.find("option")
        if first and first.get_text(strip=True).lower() == placeholder:
            return sel.get("id")
    return None


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


DOC_PREFIX = re.compile(r"^(?:doc|document)\s*(\d+)\s*[-–:]?\s*", re.I)
RECALLED = re.compile(r"^recalled\s*[-–:]?\s*", re.I)
VERSION = re.compile(r"\s*\b(v\d+|amended|revised following ica judgement\s*-?)\b\s*", re.I)


PARIS = ZoneInfo("Europe/Paris")  # fia.com labels times "CET" but they follow Paris summer time

# Fallback only, used before an event has any stewards PDFs to infer the offset from.
# Matched against the event name; the venue can differ from the name (e.g. 2026
# "Bahrain Grand Prix in Malaysia"), so the PDF-derived offset always wins.
EVENT_TZ = [
    ("australia", "Australia/Melbourne"), ("chin", "Asia/Shanghai"), ("japan", "Asia/Tokyo"),
    ("bahrain", "Asia/Bahrain"), ("saudi", "Asia/Riyadh"), ("miami", "America/New_York"),
    ("emilia", "Europe/Rome"), ("monaco", "Europe/Monaco"), ("spanish", "Europe/Madrid"),
    ("barcelona", "Europe/Madrid"), ("madrid", "Europe/Madrid"), ("canad", "America/Toronto"),
    ("austria", "Europe/Vienna"), ("british", "Europe/London"), ("belgi", "Europe/Brussels"),
    ("hungar", "Europe/Budapest"), ("dutch", "Europe/Amsterdam"), ("ital", "Europe/Rome"),
    ("azerbaijan", "Asia/Baku"), ("singapore", "Asia/Singapore"), ("united states", "America/Chicago"),
    ("mexic", "America/Mexico_City"), ("sao paulo", "America/Sao_Paulo"), ("são paulo", "America/Sao_Paulo"), ("brazil", "America/Sao_Paulo"),
    ("las vegas", "America/Los_Angeles"), ("qatar", "Asia/Qatar"), ("abu dhabi", "Asia/Dubai"),
    ("malaysia", "Asia/Kuala_Lumpur"), ("melbourne", "Australia/Melbourne"), ("shanghai", "Asia/Shanghai"),
    ("suzuka", "Asia/Tokyo"), ("sakhir", "Asia/Bahrain"), ("jeddah", "Asia/Riyadh"), ("imola", "Europe/Rome"),
    ("montr", "America/Toronto"), ("spielberg", "Europe/Vienna"), ("silverstone", "Europe/London"),
    ("spa", "Europe/Brussels"), ("budapest", "Europe/Budapest"), ("zandvoort", "Europe/Amsterdam"),
    ("monza", "Europe/Rome"), ("baku", "Asia/Baku"), ("lusail", "Asia/Qatar"), ("yas", "Asia/Dubai"), ("portug", "Europe/Lisbon"), ("turk", "Europe/Istanbul"),
]


# Circuit coordinates for the weather panel. Matched (first hit wins) against the FIA event name, the
# formula1.com race name and the heading of the event's FIA documents, so venue moves such as the
# 2026 "Bahrain Grand Prix in Malaysia" resolve to the right track. Order matters: specific before general.
CIRCUITS = [
    (r"malaysia|kuala lumpur|sepang", "Sepang International Circuit", 2.7608, 101.7382),
    (r"las vegas", "Las Vegas Strip Circuit", 36.1147, -115.1728),
    (r"miami", "Miami International Autodrome", 25.9581, -80.2389),
    (r"madrid|madring|spanish|spain|españa", "Madring, Madrid", 40.4637, -3.6164),
    (r"barcelona|catalunya", "Circuit de Barcelona-Catalunya", 41.5700, 2.2611),
    (r"são paulo|sao paulo|interlagos|brazil", "Interlagos, São Paulo", -23.7036, -46.6997),
    (r"mexic", "Autódromo Hermanos Rodríguez", 19.4042, -99.0907),
    (r"united states|austin|cota", "Circuit of the Americas", 30.1328, -97.6411),
    (r"australia|melbourne", "Albert Park, Melbourne", -37.8497, 144.9680),
    (r"chin|shanghai", "Shanghai International Circuit", 31.3389, 121.2197),
    (r"japan|suzuka", "Suzuka", 34.8431, 136.5410),
    (r"bahrain|sakhir", "Bahrain International Circuit", 26.0325, 50.5106),
    (r"saudi|jeddah", "Jeddah Corniche Circuit", 21.6319, 39.1044),
    (r"emilia|imola", "Imola", 44.3439, 11.7167),
    (r"canad|montr", "Circuit Gilles Villeneuve, Montréal", 45.5000, -73.5228),
    (r"monaco", "Circuit de Monaco", 43.7347, 7.4206),
    (r"austria|spielberg", "Red Bull Ring, Spielberg", 47.2197, 14.7647),
    (r"british|britain|silverstone", "Silverstone", 52.0786, -1.0169),
    (r"belgi|spa\b|spa-francorchamps", "Spa-Francorchamps", 50.4372, 5.9714),
    (r"hungar|budapest", "Hungaroring, Budapest", 47.5789, 19.2486),
    (r"dutch|netherlands|zandvoort", "Zandvoort", 52.3888, 4.5409),
    (r"ital|monza", "Monza", 45.6156, 9.2811),
    (r"azerbaijan|baku", "Baku City Circuit", 40.3725, 49.8533),
    (r"singapore|marina bay", "Marina Bay, Singapore", 1.2914, 103.8640),
    (r"qatar|lusail", "Lusail International Circuit", 25.4900, 51.4542),
    (r"abu dhabi|yas|emirates", "Yas Marina", 24.4672, 54.6031),
]


def find_circuit(*texts):
    for text in texts:
        if not text:
            continue
        for rx, name, lat, lon in CIRCUITS:
            if re.search(rf"\b(?:{rx})", text, re.I):
                return {"circuit": name, "lat": lat, "lon": lon}
    return None


def paris_to_utc(iso: str) -> datetime:
    return datetime.fromisoformat(iso).replace(tzinfo=PARIS).astimezone(timezone.utc)


def infer_offset(samples) -> int | None:
    """samples: (published Paris ISO, local 'HH:MM' from the PDF). Returns UTC offset in minutes."""
    votes = Counter()
    for pub, hhmm in samples:
        utc = paris_to_utc(pub)
        h, m = map(int, hhmm.split(":"))
        utc_min = utc.hour * 60 + utc.minute
        # documents are published a few minutes after the time printed on them
        diff = (h * 60 + m - utc_min + 5) % 1440
        if diff > 840:
            diff -= 1440
        votes[round(diff / 30) * 30] += 1
    if not votes:
        return None
    off, n = votes.most_common(1)[0]
    return off if n >= 2 or len(votes) == 1 else None


def fallback_offset(name: str, when: str | None) -> int:
    at = paris_to_utc(when) if when else datetime.now(timezone.utc)
    for key, tz in EVENT_TZ:
        if key in name.lower():
            return int(at.astimezone(ZoneInfo(tz)).utcoffset().total_seconds() // 60)
    return int(at.astimezone(PARIS).utcoffset().total_seconds() // 60)


def to_local(pub: str | None, offset_min: int) -> str | None:
    if not pub:
        return None
    return (paris_to_utc(pub) + timedelta(minutes=offset_min)).strftime("%Y-%m-%dT%H:%M")


def parse_published(s: str | None):
    if not s:
        return None
    try:
        return datetime.strptime(s.strip(), "%d.%m.%y %H:%M").strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def parse_event_page(page: str, event_name: str):
    soup = BeautifulSoup(page, "html.parser")
    docs = []
    for li in soup.select("li.document-row"):
        title_el = li.select_one(".title")
        if not title_el:
            continue
        raw_title = " ".join(title_el.get_text(" ").split())
        recalled = bool(li.select_one(".recalled-document")) or bool(RECALLED.match(raw_title))
        title = RECALLED.sub("", raw_title)

        link = None
        if not recalled:
            a = li.find("a", href=True)
            if a and a["href"].lower().endswith(".pdf"):
                link = urljoin(BASE, a["href"])

        pub_el = li.select_one(".date-display-single")
        published = parse_published(pub_el.get_text() if pub_el else None)

        m = DOC_PREFIX.match(title)
        num = int(m.group(1)) if m else None
        subject = DOC_PREFIX.sub("", title) if m else title
        # "2026 Dutch Grand Prix - Power Unit Information" -> "Power Unit Information"
        subject = re.sub(r"^\d{4}\s+[^-]*?(grand prix|gp|test[s]?|event)[^-]*-\s*", "", subject, flags=re.I)

        cat = categorise(subject)
        cars = sorted({int(c) for c in re.findall(r"\bcars?\s*(?:numbers?\s*)?(\d{1,2})\b", subject, re.I)})
        # also "Cars 3 and 30" / "Car Numbers 4 and 81"
        for grp in re.findall(r"\bcars?\s*(?:numbers?\s*)?((?:\d{1,2}\b\s*(?:,|and|&)\s*)+\d{1,2}\b)", subject, re.I):
            cars = sorted(set(cars) | {int(x) for x in re.findall(r"\d+", grp)})

        doc = {
            "num": num,
            "title": title,
            "subject": subject,
            "category": cat,
            "url": link,
            "published": published,
            "recalled": recalled,
            "cars": cars,
        }
        if cat == "stewards":
            doc["type"] = stewards_type(subject)
        docs.append(doc)

    mark_superseded(docs)
    docs.sort(key=lambda d: (d["num"] is None, -(d["num"] or 0), d["published"] or ""))
    return docs


def mark_superseded(docs):
    """When a title carries a version marker (V2, amended, Revised following ICA),
    mark the older documents with the same base title as superseded."""
    groups = {}
    for d in docs:
        if d["category"] == "stewards":
            continue
        key = VERSION.sub(" ", d["subject"]).strip(" -").lower()
        key = re.sub(r"\s+", " ", key)
        groups.setdefault(key, []).append(d)
    for items in groups.values():
        if len(items) < 2:
            continue
        if not any(VERSION.search(d["subject"]) for d in items):
            continue
        items.sort(key=lambda d: (d["num"] or 0, d["published"] or ""))
        latest = items[-1]
        for d in items[:-1]:
            d["superseded_by"] = latest["num"]


# --------------------------------------------------------------------------- timetables

TIMETABLE_RX = re.compile(r"^timetable\b", re.I)
DAY_RX = re.compile(r"^\s*(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+(\d{1,2})\s+([A-Z]+)\s+(\d{4})\s*$")
# "12:30        13:301   FORMULA 1      TRACK      FIRST PRACTICE SESSION"  (trailing digit = footnote marker)
def row_rx(label: str):
    return re.compile(r"^\s*(\d{1,2}:\d{2})\d?\*?\s+(\d{1,2}:\d{2})\d?\s+" + re.escape(label)
                      + r"\s{2,}TRACK\s{2,}(.+?)\s*$")


SESSION_NAMES = {
    "FORMULA 1": [
        (r"^FIRST PRACTICE", "Practice 1"), (r"^SECOND PRACTICE", "Practice 2"), (r"^THIRD PRACTICE", "Practice 3"),
        (r"^SPRINT QUALIFYING", "Sprint Qualifying"), (r"^SPRINT\b", "Sprint"),
        (r"^QUALIFYING", "Qualifying"), (r"^GRAND PRIX\b", "Race"),
    ],
    "FIA FORMULA 2": [
        (r"^PRACTICE", "Practice"), (r"^QUALIFYING.*GROUP A", "Qualifying (Group A)"),
        (r"^QUALIFYING.*GROUP B", "Qualifying (Group B)"), (r"^QUALIFYING", "Qualifying"),
        (r"^SPRINT RACE", "Sprint Race"), (r"^FEATURE RACE", "Feature Race"),
    ],
}
MONTHS = {m: i for i, m in enumerate(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
                                       "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"], 1)}


def parse_timetable(text: str, label: str = "FORMULA 1") -> dict:
    """One series' track sessions in a timetable PDF -> {name: (start_local, end_local)}."""
    rx_row, names = row_rx(label), SESSION_NAMES[label]
    out, day = {}, None
    for line in text.splitlines():
        m = DAY_RX.match(line)
        if m and m.group(3) in MONTHS:
            day = f"{m.group(4)}-{MONTHS[m.group(3)]:02d}-{int(m.group(2)):02d}"
            continue
        m = rx_row.match(line)
        if not (m and day):
            continue
        desc = m.group(3).upper()
        for rx, name in names:
            if re.match(rx, desc):
                start, end = (f"{int(t.split(':')[0]):02d}:{t.split(':')[1]}" for t in m.group(1, 2))
                end_day = day
                if end < start:  # runs past midnight
                    end_day = (datetime.fromisoformat(day) + timedelta(days=1)).strftime("%Y-%m-%d")
                out[name] = (f"{day}T{start}", f"{end_day}T{end}")
                break
    return out


# classification titles -> session, used when no timetable covers a session
CLASSIFICATION_RX = [
    (r"free practice 1 classification", "Practice 1"), (r"free practice 2 classification", "Practice 2"),
    (r"free practice 3 classification", "Practice 3"), (r"sprint qualifying classification", "Sprint Qualifying"),
    (r"(?<!qualifying )sprint classification", "Sprint"), (r"(?<!sprint )qualifying classification", "Qualifying"),
    (r"race classification", "Race"),
]
def f2_classified_sessions(docs):
    """F2 results titles -> {session: first classification published (local)}. Race names come from
    whichever title in the event spells them out ("Race 1 (Sprint)", "Race 3 (Feature 2)"), so a
    bare "F2 Race 2 - provisional classification" still maps to the right race."""
    race_names = {}
    for d in docs:
        m = re.search(r"\brace\s*(\d)\s*\(\s*(sprint|feature)\s*(\d?)\s*\)", d["subject"], re.I)
        if m:
            kind = "Sprint Race" if m.group(2).lower() == "sprint" else "Feature Race"
            race_names[m.group(1)] = f"{kind} {m.group(3)}".strip()
    out = {}
    for d in docs:
        subj = d["subject"]
        if not re.search(r"classification", subj, re.I) or not d.get("published_local"):
            continue
        name = None
        if re.search(r"\bpractice\b", subj, re.I):
            name = "Practice"
        elif m := re.search(r"\bqualifying\s*(\d)?", subj, re.I):
            name = f"Qualifying {m.group(1)}" if m.group(1) else "Qualifying"
        elif m := re.search(r"\brace\s*(\d)", subj, re.I):
            name = race_names.get(m.group(1), f"Race {m.group(1)}")
        if name and (name not in out or d["published_local"] < out[name]):
            out[name] = d["published_local"]
    return out


def build_sessions(timetables, offset_min: int, docs=(), f1_sessions=None, label="FORMULA 1", extra_timetables=()):
    """Session times for one event, by priority:
      1. FIA timetable PDFs (all versions merged; later documents override earlier ones, since
         reissues can cover only some days)
      2. formula1.com schedule, for sessions no timetable covers
      3. classification documents (time = first classification published), as a last resort."""
    fmt = lambda dt: dt.strftime("%Y-%m-%dT%H:%M")
    to_utc = lambda iso: fmt(datetime.fromisoformat(iso) - timedelta(minutes=offset_min)) + "Z"
    to_loc = lambda utc: fmt(datetime.fromisoformat(utc.rstrip("Z")) + timedelta(minutes=offset_min))

    merged = {}
    # timetables from a sister event (F2 sessions are also listed in the F1 timetable) fill gaps first
    for _, text in sorted(extra_timetables, key=lambda t: t[0]):
        merged.update(parse_timetable(text, label))
    for _, text in sorted(timetables, key=lambda t: t[0]):
        merged.update(parse_timetable(text, label))
    sessions = {}
    for name, (start, end) in merged.items():
        sessions[name] = {"name": name, "start_local": start, "end_local": end,
                          "start_utc": to_utc(start), "end_utc": to_utc(end), "source": "fia"}
    for f in f1_sessions or []:
        if f["name"] not in sessions:
            sessions[f["name"]] = {"name": f["name"], "start_local": to_loc(f["start_utc"]),
                                   "end_local": to_loc(f["end_utc"]), "start_utc": f["start_utc"],
                                   "end_utc": f["end_utc"], "source": "f1"}
    inferred = {}
    if label == "FORMULA 1":
        for d in docs:
            if d.get("category") != "results" or not d.get("published_local"):
                continue
            for rx, name in CLASSIFICATION_RX:
                if re.search(rx, d["subject"], re.I) and name not in sessions:
                    if name not in inferred or d["published_local"] < inferred[name]:
                        inferred[name] = d["published_local"]
                    break
    else:
        have = {re.sub(r" \(Group [AB]\)", "", n) for n in sessions}
        inferred = {n: t for n, t in f2_classified_sessions(docs).items() if n not in sessions and n not in have}
    for name, published in inferred.items():
        utc = to_utc(published)
        sessions[name] = {"name": name, "classified_local": published, "start_utc": utc, "end_utc": utc,
                          "inferred": True, "source": "results"}
    return sorted(sessions.values(), key=lambda s: s["start_utc"])


# --------------------------------------------------------------------------- formula1.com schedule

F1_SESSION_NAMES = {"Practice-1": "Practice 1", "Practice-2": "Practice 2", "Practice-3": "Practice 3",
                    "Sprint-Qualifying": "Sprint Qualifying", "Sprint-Shootout": "Sprint Qualifying",
                    "Sprint": "Sprint", "Qualifying": "Qualifying", "Race": "Race"}


def _iso_z(s: str) -> str:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def parse_f1_race_page(page: str):
    """formula1.com race pages embed the weekend as schema.org SportsEvent JSON-LD with sub-events."""
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', page, re.S):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        if data.get("@type") != "SportsEvent" or not data.get("subEvent"):
            continue
        sessions = []
        for e in data["subEvent"]:
            key = e.get("@id", "").split("#")[-1]
            name = F1_SESSION_NAMES.get(key)
            if name and e.get("startDate") and e.get("endDate"):
                sessions.append({"name": name, "start_utc": _iso_z(e["startDate"]), "end_utc": _iso_z(e["endDate"])})
        return {"name": data.get("name"), "sessions": sessions}
    return None


def load_f1_schedule(year: int, delay: float):
    """{race slug: {name, sessions, fetched}} for the season, refetching only what may have changed:
    the season list every 12 h, and a race page if never fetched or if its weekend is near and the copy
    is over an hour old. Finished weekends stay cached."""
    cache = {}
    if F1_CACHE_FILE.exists():
        try:
            cache = json.loads(F1_CACHE_FILE.read_text())
        except ValueError:
            cache = {}
    if cache.get("year") != year:
        cache = {"year": year, "races": {}}
    now = datetime.now(timezone.utc)
    age = lambda iso: (now - datetime.fromisoformat(iso)).total_seconds() / 3600 if iso else 1e9

    if age(cache.get("list_fetched")) > 12 or not cache["races"]:
        page = get(f"{F1_BASE}/en/racing/{year}")
        if page:
            slugs = sorted(set(re.findall(rf'href="/en/racing/{year}/([a-z0-9-]+)"', page)))
            for slug in slugs:
                if "testing" not in slug:
                    cache["races"].setdefault(slug, {})
            cache["list_fetched"] = now.isoformat()
        else:
            log("  formula1.com season list unavailable")

    for slug, race in cache["races"].items():
        sess = race.get("sessions") or []
        if sess:
            first = datetime.fromisoformat(sess[0]["start_utc"].rstrip("Z")).replace(tzinfo=timezone.utc)
            last = datetime.fromisoformat(sess[-1]["end_utc"].rstrip("Z")).replace(tzinfo=timezone.utc)
            finished = race.get("fetched") and datetime.fromisoformat(race["fetched"]) > last + timedelta(hours=6)
            near = first - timedelta(days=10) <= now <= last + timedelta(hours=6)
            if finished or not (near and age(race.get("fetched")) > 1):
                continue
        time.sleep(delay)
        page = get(f"{F1_BASE}/en/racing/{year}/{slug}")
        parsed = parse_f1_race_page(page) if page else None
        if parsed:
            race.update(parsed)
            race["fetched"] = now.isoformat()
            log(f"  formula1.com {slug}: {len(parsed['sessions'])} sessions")
    F1_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    F1_CACHE_FILE.write_text(json.dumps(cache, indent=1, ensure_ascii=False, sort_keys=True) + "\n")
    return cache["races"]


def match_f1_race(f1_races, docs):
    """Pick the formula1.com weekend for an FIA event: names differ (sponsors, local languages, venues),
    so match by date - the race whose weekend window holds most of the event's documents."""
    stamps = [paris_to_utc(d["published"]) for d in docs if d.get("published")]
    best, best_n = None, 0
    for race in f1_races.values():
        sess = race.get("sessions") or []
        if not sess:
            continue
        lo = datetime.fromisoformat(sess[0]["start_utc"].rstrip("Z")).replace(tzinfo=timezone.utc) - timedelta(days=4)
        hi = datetime.fromisoformat(sess[-1]["end_utc"].rstrip("Z")).replace(tzinfo=timezone.utc) + timedelta(days=2)
        n = sum(lo <= t <= hi for t in stamps)
        if n > best_n:
            best, best_n = race, n
    return best


# --------------------------------------------------------------------------- PDF parsing

FIELD_LABELS = ["No / Driver", "Competitor", "Time", "Session", "Fact", "Infringement",
                "Offence", "Decision", "Reasons", "Reason"]
FIELD_RX = re.compile(r"^\s{0,2}(" + "|".join(re.escape(x) for x in FIELD_LABELS) + r")\b\s*(.*)$")
STOP_RX = re.compile(r"^\s*(Competitors are reminded|Decisions of the Stewards are taken|The Stewards\s*$)")

# F1: "No.  Turn Car  Driver"; F2: "Decision  Turn  Car  Driver" / "Dec  Turn  Car  Driver" / "Car  Driver"
TABLE_HEAD_RX = re.compile(r"^\s*(?:No\.?\s{2,}(?:Turn\s+)?Car\b|(?:(?:Decision|Dec|No\.?)\s+)?(?:Turn\s+)?Car\s+Driver\b)", re.I)
TABLE_ROW_RX = re.compile(r"(?<!\S)(\d{1,2})\s{2,}([A-Z][\w'’.\-]+(?:\s[A-Z][\w'’.\-]+){1,3})(?=\s{2,}|$)")

NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
             "nine": 9, "ten": 10}
NUM = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten)"


def pdf_text(pdf: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf)
        f.flush()
        r = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True)
        return r.stdout


def parse_stewards_pdf(text: str) -> dict:
    lines = text.splitlines()
    fields: dict[str, list[str]] = {}
    current = None
    to_lines = []
    in_to = False
    in_table = False
    table_cars: list[int] = []
    table_names: dict[int, str] = {}

    for line in lines:
        if not line.strip():
            continue
        # "To  The Team Manager,\n      Audi Revolut F1 Team" header block
        m_to = re.match(r"^\s*To\s{2,}(.*?)(?:\s{2,}Date\b.*)?$", line)
        if m_to and not fields:
            to_lines = [m_to.group(1).strip()]
            in_to = True
            continue
        if in_to:
            part = re.split(r"\s{2,}(?:Time|Date)\b", line.strip())[0].strip()
            if line.startswith(" ") and part and not re.match(r"^(Time|Date)\b", part):
                to_lines.append(part)
                continue
            in_to = False

        if STOP_RX.match(line):
            current = None
            if fields.get("Reason"):
                break
            continue
        m = FIELD_RX.match(line)
        if TABLE_HEAD_RX.match(line):
            in_table, current = True, None
            continue
        if in_table and not (m and m.group(1) not in fields):
            r = TABLE_ROW_RX.search(line)
            if r:
                car = int(r.group(1))
                table_cars.append(car)
                table_names[car] = r.group(2).strip()
            continue
        if m and m.group(1) not in fields:
            in_table = False
            current = m.group(1)
            fields[current] = [m.group(2).strip()] if m.group(2).strip() else []
            continue
        if current and line.startswith(" "):
            fields[current].append(line.strip())
        elif current:
            # unindented non-label line (signatures etc.) ends the field block
            current = None

    out = {k.lower().replace(" / ", "_").replace(" ", "_"): " ".join(v).strip()
           for k, v in fields.items() if v}

    m_from = re.search(r"^\s*From\s{2,}(.*?)(?:\s{2,}Document\b.*)?$", text, re.M)
    if m_from:
        out["from"] = m_from.group(1).strip()

    if not any(k in out for k in ("decision", "fact", "reason")):
        # free-form letter / report: keep the body text as a summary
        body, started = [], False
        for line in lines:
            st = line.strip()
            if not st:
                continue
            if not started:
                if re.match(r"^Time\b|.*\s{2,}Time\s+\d", st) or re.search(r"\bTime\s+\d{1,2}:\d{2}\s*$", st):
                    started = True
                continue
            if STOP_RX.match(line) or re.match(r"^(The Stewards|The FIA Formula 1 Technical Delegate)\s*$", st):
                break
            body.append(st)
        summary = " ".join(body).strip()
        if summary:
            out["summary"] = summary[:2000]
        if re.search(r"grants?\s+permission|permission is granted|allowed to start", summary, re.I):
            out["decision"] = "Permission granted to start the race."
    for k in list(out):
        out[k] = re.split(r"\s*(?:Note:?\s*)?Competitors are reminded|\s*Decisions of the Stewards are taken", out[k])[0].strip()
        if not out[k]:
            del out[k]
    if "reasons" in out:
        out["reason"] = (out.get("reason", "") + " " + out.pop("reasons")).strip()
    if "offence" in out and "infringement" not in out:
        out["infringement"] = out.pop("offence")

    team = " ".join(x for x in to_lines if x and not x.lower().startswith("the team manager")).strip(" ,")
    if team and "competitor" not in out and not re.search(r"^(the stewards|all )|teams and officials|officials", team, re.I):
        out["competitor"] = team

    drivers = []
    if table_cars:
        counts: dict[int, int] = {}
        for c in table_cars:
            counts[c] = counts.get(c, 0) + 1
        out["table_rows"] = {str(c): n for c, n in counts.items()}
        drivers = [{"car": c, "name": table_names[c]} for c in counts]
    if out.get("no_driver") and not drivers:
        for num, name in re.findall(r"(\d{1,2})\s*[-–/]\s*([^\d,;()/]+?)(?=\s*(?:\d{1,2}\s*[-–/]|,|;|\band\b|\(|$))",
                                    out["no_driver"]):
            drivers.append({"car": int(num), "name": name.strip()})
    if drivers:
        out["drivers"] = drivers

    refs = sorted({int(n) for n in re.findall(r"\bdoc(?:ument)?s?\.?\s*(?:no\.?\s*)?(\d{1,3})\b", text, re.I)})
    if refs:
        out["refs"] = refs

    if table_cars and not out.get("decision") and re.search(
            r"did not use the track|cancel|deleted|track limit|yellow", out.get("fact", "") + " " + text[:1500], re.I):
        out["decision"] = "Lap times deleted for the cars listed."
    if out.get("decision"):
        out.update(penalty_summary(out["decision"]))
    return out


def penalty_summary(decision: str) -> dict:
    d = decision.lower()
    tags = []

    def has(p):
        return re.search(p, d)

    if has(r"no further action|no penalty (is )?applied|no penalty"):
        tags.append("No further action")
    if has(r"drive[- ]through"):
        tags.append("Drive-through")
    if has(r"stop[\s-]*(?:and|&)?[\s-]*go\b"):
        tags.append("Stop & go")
    m = re.search(NUM + r"\s*(?:-\s*)?seconds?\s*(?:\(\d+\)\s*)?(?:time\s+)?penalty", d)
    if m and not has(r"stop[\s-]*(?:and|&)?[\s-]*go\b"):
        tags.append(f"{NUM_WORDS.get(m.group(1), m.group(1))}s time penalty")
    elif has(r"time penalty"):
        tags.append("Time penalty")
    m = (re.search(NUM + r"\s*(?:-\s*)?(?:place|position)s?\s+grid", d)
         or re.search(r"drop of\s*" + NUM + r"\s*(?:grid\s*)?(?:place|position)s?", d))
    if m:
        tags.append(f"{NUM_WORDS.get(m.group(1), m.group(1))}-place grid drop")
    elif has(r"back of the (starting )?grid"):
        tags.append("Back of grid")
    elif has(r"grid (place |position )?(penalty|drop)"):
        tags.append("Grid penalty")
    if has(r"pit ?lane start|from (?:the )?pit ?lane"):
        tags.append("Pit lane start")
    m = re.search(r"(\d+)\s*penalty laps?", d)
    if m:
        tags.append(f"{m.group(1)} penalty lap{'s' if m.group(1) != '1' else ''}")
    if has(r"permission granted|grants? permission|permission is given"):
        tags.append("Permission to start")
    if has(r"disqualif"):
        tags.append("Disqualified")
    if has(r"reprimand"):
        tags.append("Reprimand")
    if has(r"warning"):
        tags.append("Warning")
    if has(r"lap time.*deleted|deleted.*lap time|deletion of|lap times? cancell?ation|lap times deleted"):
        tags.append("Lap time deleted")
    if has(r"suspended"):
        tags.append("Suspended")

    # the first amount is the fine; later ones are usually a suspended portion
    fine = 0
    m = (re.search(r"(?:€|eur(?:o|os)?\s*)\s?(\d[\d.,\s]*\d|\d)", decision, re.I)
         or re.search(r"(\d[\d.,]*)\s*(?:€|euros?)", decision, re.I))
    if m:
        fine = int(re.sub(r"[^\d]", "", m.group(1)) or 0)
    if fine or has(r"\bfined?\b"):
        tags.append("Fine")

    points = 0
    m = (re.search(r"(\d+|one|two|three|four|five|six)\s*(?:\(\d+\)\s*)?(?:driver\s+)?penalty points?", d)
         or re.search(r"in addition,?\s*(\d+|one|two|three|four|five|six)\s*points?", d))
    if m:
        points = int(NUM_WORDS.get(m.group(1), m.group(1)))
        tags.append(f"{points} penalty point{'s' if points != 1 else ''}")

    if "No further action" in tags and len(tags) == 1:
        outcome = "nfa"
    elif tags == ["Permission to start"]:
        outcome = "other"
    elif tags == ["Lap time deleted"]:
        outcome = "deleted"
    elif any(t for t in tags if t not in ("Warning", "Reprimand", "No further action", "Permission to start")):
        outcome = "penalty"
    elif "Reprimand" in tags:
        outcome = "reprimand"
    elif "Warning" in tags:
        outcome = "warning"
    else:
        outcome = "other"
    res = {"tags": tags, "outcome": outcome}
    if fine:
        res["fine_eur"] = fine
    if points:
        res["penalty_points"] = points
    return res


# --------------------------------------------------------------------------- main

def load_cache():
    if CACHE_FILE.exists():
        c = json.loads(CACHE_FILE.read_text())
        if c.get("version") == CACHE_VERSION:
            return c
    return {"version": CACHE_VERSION, "pdfs": {}}


CHANGED = []


def write_json(path: Path, obj):
    """Write only when content differs, so scheduled runs don't create empty commits."""
    path.parent.mkdir(parents=True, exist_ok=True)
    new = json.dumps(obj, indent=1, ensure_ascii=False) + "\n"
    if not path.exists() or path.read_text() != new:
        path.write_text(new)
        CHANGED.append(path.name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-pdfs", action="store_true", help="skip downloading stewards PDFs")
    ap.add_argument("--reparse", action="store_true", help="re-download all PDFs")
    ap.add_argument("--no-f1", action="store_true", help="don't use formula1.com for missing session times")
    ap.add_argument("--series", default="f1,f2", help="comma-separated series to scrape (default: f1,f2)")
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between requests")
    args = ap.parse_args()

    if not args.no_pdfs and not shutil.which("pdftotext"):
        sys.exit("pdftotext not found (install poppler-utils) or pass --no-pdfs")

    cache = load_cache()
    if args.reparse:
        cache["pdfs"] = {}
    wanted = [x.strip() for x in args.series.split(",") if x.strip()]
    context = {}  # results of earlier series, e.g. F1 timetables reused for F2 sessions
    failed = []
    for cfg in SERIES:
        if cfg["id"] not in wanted:
            continue
        try:
            context[cfg["id"]] = scrape_series(cfg, cache, args, context)
        except SystemExit as e:
            log(f"[{cfg['id']}] {e}")
            failed.append(cfg["id"])
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(cache, indent=0, ensure_ascii=False, sort_keys=True) + "\n")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for cfg in SERIES:
        upd = cfg["data"] / "updated.json"
        if cfg["id"] in context and (context[cfg["id"]]["changed"] or not upd.exists()):
            write_json(upd, {"updated": now})
    if failed and len(failed) == len(wanted):
        sys.exit(f"All series failed: {', '.join(failed)}")


def scrape_series(cfg, cache, args, context):
    data_dir = cfg["data"]
    tag = f"[{cfg['id']}]"
    changed_before = len(CHANGED)
    log(f"{tag} Fetching championship page")
    page = get(cfg["url"])
    if not page:
        raise SystemExit("Could not fetch championship page")
    soup = BeautifulSoup(page, "html.parser")
    seasons = select_options(soup, find_select(soup, "season"))
    if not seasons:
        raise SystemExit("No seasons found - page layout may have changed")
    season_url, season_label = seasons[0]  # first option is the current season
    season_name = season_label.title()
    log(f"{tag} Current season: {season_name} ({season_url})")

    season_soup = BeautifulSoup(get(season_url) or "", "html.parser")
    events = select_options(season_soup, find_select(season_soup, "event"))
    log(f"{tag} {len(events)} events")

    season_year = int(re.search(r"\d{4}", season_name).group()) if re.search(r"\d{4}", season_name) else datetime.now().year
    f1_races = {}
    if cfg["id"] == "f1" and not args.no_f1:
        try:
            f1_races = load_f1_schedule(season_year, args.delay)
        except Exception as e:  # formula1.com is a fallback; never fail the run over it
            log(f"  formula1.com schedule skipped: {e}")
    sister = context.get("f1", {}).get("timetables_by_event", [])
    out_events = []
    penalties = []
    drivers = {}
    timetables_by_event = []
    for ev_url, ev_name in events:
        time.sleep(args.delay)
        log(f"{tag} Event: {ev_name}")
        page = get(ev_url)
        if page is None:
            log("  skipped (fetch failed)")
            continue
        docs = parse_event_page(page, ev_name)
        if not docs:
            continue
        slug = slugify(ev_name)
        time_samples = []

        timetables = []
        heading = None
        for d in docs:
            is_tt = bool(TIMETABLE_RX.match(d["subject"]))
            if (d["category"] != "stewards" and not is_tt) or not d["url"] or args.no_pdfs:
                continue
            text = cache["pdfs"].get(d["url"])
            if text is None:
                time.sleep(args.delay)
                pdf = get(d["url"], binary=True)
                if not pdf:
                    continue
                text = pdf_text(pdf)
                cache["pdfs"][d["url"]] = text
                log(f"  downloaded Doc {d['num']}")
            if heading is None:
                heading = next((l.strip() for l in text.splitlines() if l.strip()), None)
            if is_tt:
                timetables.append((d["num"] or 0, text))
                continue
            det = parse_stewards_pdf(text)
            d["details"] = det
            m_time = re.search(r"\bTime\s+(\d{1,2}:\d{2})\b", text)
            if m_time and d["published"]:
                time_samples.append((d["published"], m_time.group(1)))
            if det.get("from") and not re.search(r"stewards", det["from"], re.I):
                d["type"] = "Report"
            for drv in det.get("drivers", []):
                team = det.get("competitor") if not det.get("table_rows") else None
                if team and re.search(r"teams and officials|^all |officials", team, re.I):
                    team = None
                prev = drivers.get(str(drv["car"]), {})
                drivers[str(drv["car"])] = {"name": drv["name"], "team": team or prev.get("team")}

        # cross-link related stewards documents (Summons <-> Decision etc.)
        by_num = {d["num"]: d for d in docs if d["num"] is not None}
        for d in docs:
            for r in d.get("details", {}).get("refs", []):
                if r in by_num and r != d["num"]:
                    d.setdefault("related", set()).add(r)
                    by_num[r].setdefault("related", set()).add(d["num"])
        for d in docs:
            if "related" in d:
                d["related"] = sorted(d["related"])

        dates = sorted(d["published"] for d in docs if d["published"])
        offset = infer_offset(time_samples)
        tz_source = "pdf"
        if offset is None:
            offset, tz_source = fallback_offset(ev_name, dates[0] if dates else None), "name"
        for d in docs:
            d["published_local"] = to_local(d["published"], offset)
        extra = match_sister_timetables(sister, docs) if cfg["id"] != "f1" else ()
        f1_race = match_f1_race(f1_races, docs)
        sessions = build_sessions(timetables, offset, docs, (f1_race or {}).get("sessions"),
                                  label=cfg["timetable_label"], extra_timetables=extra)
        if timetables:
            timetables_by_event.append({"sessions": sessions, "timetables": timetables})
        counts = {}
        for d in docs:
            counts[d["category"]] = counts.get(d["category"], 0) + 1
        ev_meta = {
            "slug": slug,
            "name": ev_name,
            "fia_url": ev_url,
            "doc_count": len(docs),
            "first_published": dates[0] if dates else None,
            "last_published": dates[-1] if dates else None,
            "first_local": to_local(dates[0], offset) if dates else None,
            "last_local": to_local(dates[-1], offset) if dates else None,
            "utc_offset_min": offset,
            "tz_source": tz_source,
            "sessions": sessions,
            "location": find_circuit((f1_race or {}).get("name"), heading, ev_name),
            "counts": counts,
        }
        out_events.append(ev_meta)
        write_json(data_dir / "events" / f"{slug}.json",
                   {"event": ev_meta, "season": season_name, "documents": docs})

        for d in docs:
            if d["category"] == "stewards" and d.get("type") in (
                    "Infringement", "Corrected Infringement", "Decision"):
                penalties.append({"event": ev_name, "event_slug": slug, **d})

    out_events.sort(key=lambda e: e["first_published"] or "")
    for i, e in enumerate(out_events, 1):
        e["round"] = i

    unmatched = sorted({d["subject"] for e in out_events
                        for d in json.loads((data_dir / "events" / f"{e['slug']}.json").read_text())["documents"]
                        if d["category"] == "other"})

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json(data_dir / "index.json", {
        "championship": cfg["championship"],
        "series": cfg["id"],
        "series_label": cfg["label"],
        "season": season_name,
        "source": season_url,
        "events": out_events,
        "categories": CATEGORIES,
        "drivers": dict(sorted(drivers.items(), key=lambda kv: int(kv[0]))),
        "unmatched_titles": unmatched,
    })
    write_json(data_dir / "penalties.json", {"season": season_name, "documents": penalties})
    total = sum(e["doc_count"] for e in out_events)
    log(f"{tag} Done: {len(out_events)} events, {total} documents, {len(penalties)} stewards rulings, "
        f"{len(unmatched)} unmatched titles")
    return {"changed": len(CHANGED) > changed_before, "timetables_by_event": timetables_by_event}


def match_sister_timetables(sister, docs):
    """Timetable PDFs of the F1 event held on the same weekend (they list support-series sessions)."""
    stamps = [paris_to_utc(d["published"]) for d in docs if d.get("published")]
    best, best_n = (), 0
    for ev in sister:
        sess = [x for x in ev["sessions"] if not x.get("inferred")]
        if not sess:
            continue
        lo = datetime.fromisoformat(sess[0]["start_utc"].rstrip("Z")).replace(tzinfo=timezone.utc) - timedelta(days=4)
        hi = datetime.fromisoformat(sess[-1]["end_utc"].rstrip("Z")).replace(tzinfo=timezone.utc) + timedelta(days=2)
        n = sum(lo <= t <= hi for t in stamps)
        if n > best_n:
            best, best_n = ev["timetables"], n
    return best


if __name__ == "__main__":
    main()
