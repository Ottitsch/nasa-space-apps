"""Add a neighbourhood group to a city, so it shows on organise.html and on the
take action page:

    python3 web/action/add_group.py chennai whatsapp https://chat.whatsapp.com/AbCdEf
    python3 web/action/add_group.py tehran bale https://ble.ir/join/AbCdEf "Sinking Ground Tehran"

Arguments: the city id (a file in web/action/cities), the app (whatsapp,
telegram, wechat, bale, rubika, eitaa, element, signal, viber, facebook,
email), the invite link, and optionally a label (default: the city's group
name). Adding the same link again replaces it. Then commit the city file.

Only list a group with the agreement of whoever runs it.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from check import PLATFORMS  # noqa: E402


def main(argv):
    if len(argv) not in (3, 4):
        print(__doc__)
        return 2
    city, platform, url = argv[:3]
    path = HERE / "cities" / f"{city}.json"
    if not path.exists():
        print(f"no city file {path.name}; cities: {', '.join(json.loads((HERE / 'cities' / 'index.json').read_text()))}")
        return 1
    if platform not in PLATFORMS:
        print(f"unknown app {platform!r}; use one of {', '.join(sorted(PLATFORMS))}")
        return 1
    if not re.match(r"^(https?://\S+|mailto:\S+)$", url):
        print("the link should start with https:// (or mailto: for an email list)")
        return 1
    text = path.read_text(encoding="utf-8")
    c = json.loads(text)
    label = argv[3] if len(argv) == 4 else (c.get("group_name") or {}).get("en", f"Sinking Ground {c['id']}")
    groups = [g for g in c.get("groups") or [] if g.get("url") != url]
    groups.append({"platform": platform, "url": url, "label": label})
    # rewrite only the groups line, so the rest of the file keeps its layout
    new = re.sub(r'"groups":\s*\[.*?\](?=\s*\n\s*[}\n])', '"groups": ' + json.dumps(groups, ensure_ascii=False),
                 text, count=1, flags=re.S)
    if json.loads(new).get("groups") != groups:
        print("could not update the groups line; edit the file by hand")
        return 1
    path.write_text(new, encoding="utf-8")
    print(f"{city}: {len(groups)} group(s) listed. Run python3 web/action/check.py, then commit {path.relative_to(HERE.parent.parent)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
