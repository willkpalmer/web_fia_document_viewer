"""Rules that turn an FIA document title into a category and a document type.

Rules are checked in order; the first matching pattern wins. Patterns are
matched case-insensitively against the title with the "Doc N - " prefix,
"Recalled - " prefix and "2026 Xyz Grand Prix - " prefix removed.

Edit this file to move document types between groups.
"""

import re

CATEGORIES = [
    {"id": "stewards", "label": "Stewards & Penalties",
     "description": "Infringements, summonses, decisions, rights of review"},
    {"id": "technical", "label": "Technical & Scrutineering",
     "description": "Scrutineering, power unit elements, parc fermé, covering of components, post-race checks"},
    {"id": "race_director", "label": "Race Director & Procedures",
     "description": "Race Director's notes, procedures, curfew, hazard declarations, deleted laps"},
    {"id": "results", "label": "Results & Classifications",
     "description": "Classifications, starting grids, championship points"},
    {"id": "admin", "label": "Event Admin",
     "description": "Entry list, timetable, competition visa"},
    {"id": "other", "label": "Other", "description": "Anything not matched by a rule"},
]

# (category, pattern)
RULES = [
    ("stewards", r"^\(?(infringe?ment|infringment|corrected infringement|summons|decision|offence|"
                 r"hearing|steward|notification)\b"),
    ("stewards", r"right of review|withdrawal|^car \d|^cars \d|tyre return infringement|"
                 r"penalty points|^[a-z ]+ - car \d"),
    ("technical", r"scrutineering|pu element|power unit|parc ferm|parts and parameters|covers-on|"
                  r"covering of components|post-race (checks|inspections)|tyre pressure|"
                  r"car presentation|technical delegate|homologation|fuel|plank|skid"),
    ("race_director", r"race director|competition notes|event notes|drivers' meeting|procedure|"
                      r"curfew|restricted period|hazard|lightning|deleted lap|sc\d|safety car|"
                      r"pit lane|track limits"),
    ("results", r"classification|starting grid|championship points|lap times|speed trap|results"),
    ("admin", r"entry list|timetable|competition visa|biograph|circuit map|stewards|accreditation"),
]

_COMPILED = [(cat, re.compile(p, re.I)) for cat, p in RULES]


def categorise(subject: str) -> str:
    for cat, rx in _COMPILED:
        if rx.search(subject):
            return cat
    return "other"


_STEWARDS_TYPES = [
    ("Corrected Infringement", r"^corrected infringement"),
    ("Infringement", r"^\(?infringe?ment|^infringment|tyre return infringement"),
    ("Summons", r"^summons"),
    ("Decision", r"^decision"),
    ("Right of Review", r"right of review"),
    ("Hearing", r"^hearing"),
]


def stewards_type(subject: str) -> str:
    for name, p in _STEWARDS_TYPES:
        if re.search(p, subject, re.I):
            return name
    return "Stewards Note"
