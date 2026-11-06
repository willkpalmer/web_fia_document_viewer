# F1 Document Viewer

A tidier view of the [FIA Formula One decision documents](https://www.fia.com/documents/championships/fia-formula-one-world-championship-14)
for the current season, published with GitHub Pages.

- **Browse by round.** The same season → event structure as fia.com.
- **Grouped by type.** Each document goes into one of these groups:
  - Stewards & Penalties
  - Technical & Scrutineering
  - Race Director & Procedures
  - Results
  - Event Admin
- **Filter and sort.** Filter by group, car/driver or stewards document type (Summons / Infringement / Decision), search the text, and sort by document number, car or title.
- **Stewards rulings parsed from the PDFs.** Each ruling shows driver, team, session, fact, regulation breached, decision and outcome tags (time penalty, grid drop, fine, penalty points, reprimand, warning, no further action). A Summons links to its Decision when the PDF names the other document.
- **Season penalties view.** A per-driver/team table of rulings, penalties, reprimands, warnings, penalty points and fines across all rounds. Click a row to see that driver's rulings.
- **Version handling.** Older versions (e.g. `Timetable` → `Timetable V2`) are hidden by default and recalled documents are struck through.
- **Shareable views.** Filters live in the URL, so a filtered view can be bookmarked or shared.

## How it works

```
scraper/fia_scraper.py  ── GitHub Actions on a schedule ──►  site/data/*.json  ──►  GitHub Pages (site/)
```

fia.com doesn't let other websites load its pages from a browser, so the page can't read it live. A scheduled
workflow (`.github/workflows/update.yml`) does the scraping instead:

1. Reads the current season's event list, then each event page.
2. Categorises each document by its title using the rules in `scraper/categories.py`.
3. Downloads each stewards' PDF **once**, extracts its fields with `pdftotext -layout`, and caches the result in
   `scraper/cache/pdf_details.json`.
4. Commits any changed JSON and redeploys Pages.

It runs every 10 minutes Friday–Sunday (UTC) and every 4 hours otherwise. Runs with no changes don't commit or redeploy.
PDFs are always opened from fia.com and are not re-hosted.

## Setup

1. Merge this into `main`. Scheduled workflows only run on the default branch.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**.
4. Run the workflow once from the **Actions** tab (**Update documents and deploy** → **Run workflow**).

## Running locally

```bash
sudo apt-get install poppler-utils
```

```bash
pip install -r scraper/requirements.txt
```

```bash
cd scraper && python fia_scraper.py
```

```bash
cd site && python -m http.server 8000
```

Options for `fia_scraper.py`:

- `--no-pdfs` skips the stewards PDFs.
- `--reparse` ignores the PDF cache, e.g. after improving the parser.

## Changing the groups

Edit `scraper/categories.py`. The rules are regexes checked in order, and the first match wins. Titles that match no rule
are listed in `site/data/index.json` under `unmatched_titles`, so you can add rules for them.

## Caveats

- **Cloudflare.** fia.com sits behind Cloudflare. If GitHub's runners ever get challenged (the scrape step fails with HTTP 403),
  run the scraper locally and push the updated `site/data`.
- **Title wording.** Categories depend on how the FIA words its titles. New wording lands in **Other** until a rule is added.
- **Penalty tags are heuristic.** They come from the Decision text, so the full decision is always shown next to them.

## Manual sync

The sidebar's **Sync now** button starts the update workflow straight away and reloads the page data when it finishes.
It needs a fine-grained GitHub token, created at **Settings → Developer settings → Fine-grained tokens**, with:

- **Repository access:** only this repository.
- **Permission:** **Actions: Read and write**.

The token is kept only in that browser's local storage. It's shared by any page on `<you>.github.io`, which is why it
should be limited to this one repository and the Actions permission.
The sidebar also shows when the last sync run happened, read from the public GitHub API.

**Auto-sync while open** is on by default. While the page is open with a saved token, it starts a sync every 10 minutes
on race weekends (Friday–Sunday UTC) and every hour otherwise. Even without a token, an open page checks for new data
every minute and reloads as soon as any sync publishes some. This matters because GitHub's own schedule can be delayed or
skipped when GitHub is busy.

## Session times

The right-hand panel lists the selected event's Formula 1 sessions, read from the FIA **Timetable** documents. Reissued
timetables are merged, with later versions overriding earlier ones. Each session is marked **Complete**, **In progress**
(with time remaining) or upcoming (with a countdown). Upcoming sessions show both track time and your own time.
Some events have no usable timetable on fia.com: the document is missing, or it's only a cover page. For those, sessions
are taken from their classification documents and marked complete, with the time the results were published.

The **Open session times page** button under the panel opens `sessions.html`, a standalone page laid out for phones.
It has:

- your time and track time as live clocks
- a banner with the live session or a countdown to the next one
- a card per session
- a dropdown to switch events

It opens on the event you were viewing. Opened on its own, it picks the event with the next live or upcoming session.
It works well saved to a phone's home screen.
