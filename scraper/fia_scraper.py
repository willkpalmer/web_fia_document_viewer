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
from datetime import datetime, timezone
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
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


DOC_PREFIX = re.compile(r"^(?:doc|document)\s*(\d+)\s*[-–:]?\s*", re.I)
RECALLED = re.compile(r"^recalled\s*[-–:]?\s*", re.I)
VERSION = re.compile(r"\s*\b(v\d+|amended|revised following ica judgement\s*-?)\b\s*", re.I)


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
        subject = re.sub(r"^\d{4}\s+[^-]*?(grand prix|gp|test[s]?)[^-]*-\s*", "", subject, flags=re.I)

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


# --------------------------------------------------------------------------- PDF parsing

FIELD_LABELS = ["No / Driver", "Competitor", "Time", "Session", "Fact", "Infringement",
                "Offence", "Decision", "Reasons", "Reason"]
FIELD_RX = re.compile(r"^\s{0,2}(" + "|".join(re.escape(x) for x in FIELD_LABELS) + r")\b\s*(.*)$")
STOP_RX = re.compile(r"^\s*(Competitors are reminded|Decisions of the Stewards are taken|The Stewards\s*$)")

TABLE_HEAD_RX = re.compile(r"^\s*No\.?\s{2,}(?:Turn\s+)?Car\b", re.I)
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
        if TABLE_HEAD_RX.match(line) and not (m and m.group(1) not in fields):
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
    if "reasons" in out:
        out["reason"] = (out.get("reason", "") + " " + out.pop("reasons")).strip()
    if "offence" in out and "infringement" not in out:
        out["infringement"] = out.pop("offence")

    team = " ".join(x for x in to_lines if x and not x.lower().startswith("the team manager")).strip(" ,")
    if team and "competitor" not in out and not re.match(r"^(the stewards|all )", team, re.I):
        out["competitor"] = team

    drivers = []
    if table_cars:
        counts: dict[int, int] = {}
        for c in table_cars:
            counts[c] = counts.get(c, 0) + 1
        out["table_rows"] = {str(c): n for c, n in counts.items()}
        drivers = [{"car": c, "name": table_names[c]} for c in counts]
    if out.get("no_driver") and not drivers:
        for num, name in re.findall(r"(\d{1,2})\s*[-–]\s*([^\d,;()]+?)(?=\s*(?:\d{1,2}\s*[-–]|,|;|\band\b|\(|$))",
                                    out["no_driver"]):
            drivers.append({"car": int(num), "name": name.strip()})
    if drivers:
        out["drivers"] = drivers

    refs = sorted({int(n) for n in re.findall(r"\bdoc(?:ument)?s?\.?\s*(?:no\.?\s*)?(\d{1,3})\b", text, re.I)})
    if refs:
        out["refs"] = refs

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
    if has(r"stop[- ]and[- ]go"):
        tags.append("Stop & go")
    m = re.search(r"(\d+)\s*(?:-\s*)?second(?:s)?\s+(?:time\s+)?penalty", d)
    if m:
        tags.append(f"{m.group(1)}s time penalty")
    elif has(r"time penalty"):
        tags.append("Time penalty")
    m = (re.search(NUM + r"\s*(?:-\s*)?(?:place|position)s?\s+grid", d)
         or re.search(r"drop of\s*" + NUM + r"\s*grid\s*(?:place|position)s?", d))
    if m:
        tags.append(f"{NUM_WORDS.get(m.group(1), m.group(1))}-place grid drop")
    elif has(r"back of the (starting )?grid"):
        tags.append("Back of grid")
    elif has(r"grid (place |position )?(penalty|drop)"):
        tags.append("Grid penalty")
    if has(r"pit ?lane start|from the pit ?lane"):
        tags.append("Pit lane start")
    m = re.search(r"(\d+)\s*penalty laps?", d)
    if m:
        tags.append(f"{m.group(1)} penalty lap{'s' if m.group(1) != '1' else ''}")
    if has(r"permission granted|grants? permission"):
        tags.append("Permission to start")
    if has(r"disqualif"):
        tags.append("Disqualified")
    if has(r"reprimand"):
        tags.append("Reprimand")
    if has(r"warning"):
        tags.append("Warning")
    if has(r"lap time.*deleted|deleted.*lap time|deletion of"):
        tags.append("Lap time deleted")
    if has(r"suspended"):
        tags.append("Suspended")

    fine = 0
    for amt in re.findall(r"(?:€|eur(?:o|os)?\s*)\s?([\d][\d.,\s]*\d|\d)", decision, re.I):
        n = re.sub(r"[^\d]", "", amt)
        if n:
            fine += int(n)
    for amt in re.findall(r"([\d][\d.,]*)\s*(?:€|euros?)", decision, re.I):
        n = re.sub(r"[^\d]", "", amt)
        if n and fine == 0:
            fine += int(n)
    if fine or has(r"\bfined?\b"):
        tags.append("Fine")

    points = 0
    m = re.search(r"(\d+|one|two|three|four|five|six)\s*(?:\(\d+\)\s*)?penalty points?", d)
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
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between requests")
    args = ap.parse_args()

    if not args.no_pdfs and not shutil.which("pdftotext"):
        sys.exit("pdftotext not found (install poppler-utils) or pass --no-pdfs")

    log("Fetching championship page")
    page = get(CHAMPIONSHIP_URL)
    if not page:
        sys.exit("Could not fetch championship page")
    soup = BeautifulSoup(page, "html.parser")
    seasons = select_options(soup, find_select(soup, "season"))
    if not seasons:
        sys.exit("No seasons found - page layout may have changed")
    season_url, season_label = seasons[0]  # first option is the current season
    season_name = season_label.title()
    log(f"Current season: {season_name} ({season_url})")

    season_soup = BeautifulSoup(get(season_url) or "", "html.parser")
    events = select_options(season_soup, find_select(season_soup, "event"))
    log(f"{len(events)} events")

    cache = load_cache()
    if args.reparse:
        cache["pdfs"] = {}
    out_events = []
    penalties = []
    drivers = {}

    for ev_url, ev_name in events:
        time.sleep(args.delay)
        log(f"Event: {ev_name}")
        page = get(ev_url)
        if page is None:
            log("  skipped (fetch failed)")
            continue
        docs = parse_event_page(page, ev_name)
        if not docs:
            continue
        slug = slugify(ev_name)

        for d in docs:
            if d["category"] != "stewards" or not d["url"] or args.no_pdfs:
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
            det = parse_stewards_pdf(text)
            d["details"] = det
            if det.get("from") and not re.search(r"stewards", det["from"], re.I):
                d["type"] = "Report"
            for drv in det.get("drivers", []):
                drivers[str(drv["car"])] = {"name": drv["name"], "team": det.get("competitor")}

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
            "counts": counts,
        }
        out_events.append(ev_meta)
        write_json(DATA_DIR / "events" / f"{slug}.json",
                   {"event": ev_meta, "season": season_name, "documents": docs})

        for d in docs:
            if d["category"] == "stewards" and d.get("type") in (
                    "Infringement", "Corrected Infringement", "Decision"):
                penalties.append({"event": ev_name, "event_slug": slug, **d})

    out_events.sort(key=lambda e: e["first_published"] or "")
    for i, e in enumerate(out_events, 1):
        e["round"] = i

    unmatched = sorted({d["subject"] for e in out_events
                        for d in json.loads((DATA_DIR / "events" / f"{e['slug']}.json").read_text())["documents"]
                        if d["category"] == "other"})

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json(DATA_DIR / "index.json", {
        "championship": "FIA Formula One World Championship",
        "season": season_name,
        "source": season_url,
        "events": out_events,
        "categories": CATEGORIES,
        "drivers": dict(sorted(drivers.items(), key=lambda kv: int(kv[0]))),
        "unmatched_titles": unmatched,
    })
    write_json(DATA_DIR / "penalties.json", {"season": season_name, "documents": penalties})
    if CHANGED or not (DATA_DIR / "updated.json").exists():
        write_json(DATA_DIR / "updated.json", {"updated": now})
        log(f"Changed: {', '.join(CHANGED)}")
    else:
        log("No changes")
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, indent=0, ensure_ascii=False, sort_keys=True) + "\n")

    total = sum(e["doc_count"] for e in out_events)
    log(f"Done: {len(out_events)} events, {total} documents, {len(penalties)} stewards rulings, "
        f"{len(unmatched)} unmatched titles")


if __name__ == "__main__":
    main()
