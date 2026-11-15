"""Neighbourhood groups that people add to a place from the take action page.

    python3 web/action/groups.py add <place id> <app> <invite link> [label]

The take action page (step 3) sends a new group to the site's function
(functions/api/[[path]].js), which starts the GitHub workflow
.github/workflows/add-group.yml; that workflow runs this command and commits
web/action/groups.json, which Pages publishes with its next deploy. Run locally,
pipeline/serve.py calls add() directly.

groups.json maps a place id to its groups:

    { "mexico-city": [{ "platform": "whatsapp", "url": "https://chat.whatsapp.com/...",
                        "label": "Colonia Doctores", "added": "2026-11-15" }] }

Only invite links of the apps below are accepted, so nothing else can be
posted on the site through this route. To take a group down, delete it from
groups.json and commit.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent
FILE = HERE / "groups.json"
MAX_PER_PLACE = 12
AREA_ID = re.compile(r"^area-\d{1,2}\.\d[ns]-\d{1,3}\.\d[ew]$")

# app: (name, invite link pattern, what a link starts with). The same patterns
# are in functions/api/[[path]].js and web/js/act.js; keep the three in step.
APPS = {
    "whatsapp": ("WhatsApp", r"https://(chat\.whatsapp\.com/[A-Za-z0-9]{10,40}|(www\.)?whatsapp\.com/channel/[A-Za-z0-9]{10,40})/?", "https://chat.whatsapp.com/"),
    "telegram": ("Telegram", r"https://t\.me/(\+|joinchat/)?[A-Za-z0-9_-]{5,64}/?", "https://t.me/"),
    "signal": ("Signal", r"https://signal\.group/#[A-Za-z0-9_-]{20,200}", "https://signal.group/#"),
    "element": ("Element", r"https://matrix\.to/#/[#!][A-Za-z0-9._=-]+:[A-Za-z0-9.-]+", "https://matrix.to/#/"),
    "viber": ("Viber", r"https://invite\.viber\.com/\?g2?=[A-Za-z0-9_-]{10,100}", "https://invite.viber.com/"),
    "facebook": ("Facebook", r"https://(www\.|m\.)?facebook\.com/groups/[A-Za-z0-9._-]{3,100}/?", "https://www.facebook.com/groups/"),
    "discord": ("Discord", r"https://discord\.(gg|com/invite)/[A-Za-z0-9-]{2,40}", "https://discord.gg/"),
    "bale": ("Bale", r"https://ble\.ir/join/[A-Za-z0-9_-]{5,64}", "https://ble.ir/join/"),
    "rubika": ("Rubika", r"https://rubika\.ir/joing?/[A-Za-z0-9_-]{5,64}", "https://rubika.ir/joing/"),
    "eitaa": ("Eitaa", r"https://eitaa\.com/joinchat/[A-Za-z0-9_-]{5,64}", "https://eitaa.com/joinchat/"),
}


def valid_link(platform: str, url: str) -> bool:
    return platform in APPS and re.fullmatch(APPS[platform][1], url or "") is not None


def clean_label(label: str) -> str:
    return re.sub(r"[\x00-\x1f<>]", "", label or "").strip()[:60]


def place_exists(place: str) -> bool:
    index = json.loads((WEB / "data" / "index.json").read_text(encoding="utf-8"))
    if any(p["id"] == place for p in index["places"]):
        return True
    return bool(AREA_ID.match(place)) and (WEB / "data" / "areas" / place / "meta.json").exists()


def load() -> dict:
    return json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {}


def add(place: str, platform: str, url: str, label: str = "") -> str:
    """Add a group. Returns "added" or "exists"; raises ValueError if it is not acceptable."""
    url = (url or "").strip()
    if not valid_link(platform, url):
        raise ValueError(f"not an invite link for {platform}")
    if not place_exists(place):
        raise ValueError(f"unknown place {place!r}")
    groups = load()
    here = groups.setdefault(place, [])
    if any(g["url"] == url for g in here):
        return "exists"
    if len(here) >= MAX_PER_PLACE:
        raise ValueError(f"{place} already lists {MAX_PER_PLACE} groups")
    here.append({"platform": platform, "url": url, "label": clean_label(label), "added": date.today().isoformat()})
    FILE.write_text(json.dumps(dict(sorted(groups.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return "added"


def main(argv):
    if len(argv) not in (4, 5) or argv[0] != "add":
        print(__doc__)
        return 2
    try:
        print(add(*argv[1:]))
    except ValueError as e:
        print(f"refused: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
