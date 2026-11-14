"""Check the take action files: city files against the schema, translations
against the English source. Run from anywhere:

    python3 web/action/check.py

Exits with status 1 if anything is wrong.
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DASH = re.compile("[—–]")
HANDLES = {"inspection", "groundwater", "information"}
problems = []


def bad(where, what):
    problems.append(f"{where}: {what}")


def texts(where, obj, langs):
    """A { "en": ..., "<lang>": ... } block must cover English and every city language."""
    if not isinstance(obj, dict):
        return bad(where, "should be an object of language to text")
    for lang in ["en", *langs]:
        if not str(obj.get(lang, "")).strip():
            bad(where, f"missing text for '{lang}'")
    for lang, value in obj.items():
        if isinstance(value, str) and DASH.search(value):
            bad(where, f"long dash in '{lang}' text")


def url(where, value, required=False):
    if value is None:
        if required:
            bad(where, "missing")
        return
    if not re.match(r"^https?://\S+$", str(value)):
        bad(where, f"not a web address: {value!r}")


def check_city(path, place_ids):
    name = path.name
    try:
        c = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        return bad(name, f"not valid JSON: {e}")
    if c.get("id") != path.stem:
        bad(name, f"id {c.get('id')!r} does not match the file name")
    if place_ids and c.get("id") not in place_ids:
        bad(name, "id is not a place in pipeline/places.json")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(c.get("checked", ""))):
        bad(name, "checked should be a date like 2026-11-14")
    langs = c.get("languages") or []
    if not langs:
        bad(name, "languages is empty")
    texts(f"{name} summary", c.get("summary"), langs)

    bodies = c.get("bodies") or []
    if not 3 <= len(bodies) <= 6:
        bad(name, f"expected 3 to 6 bodies, found {len(bodies)}")
    seen, handled = set(), set()
    for b in bodies:
        w = f"{name} body {b.get('id')!r}"
        if not b.get("id") or b["id"] in seen:
            bad(w, "missing or repeated id")
        seen.add(b.get("id"))
        for key in ("name", "name_en", "level"):
            if not b.get(key):
                bad(w, f"missing {key}")
        hs = set(b.get("handles") or [])
        if not hs or hs - HANDLES:
            bad(w, f"handles should be some of {sorted(HANDLES)}")
        handled |= hs
        texts(f"{w} role", b.get("role"), langs)
        url(f"{w} website", b.get("website"))
        url(f"{w} contact_url", b.get("contact_url"))
        url(f"{w} source", b.get("source"), required=True)
        if b.get("email") and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", b["email"]):
            bad(w, f"email does not look like one: {b['email']!r}")
    for need in ("inspection", "groundwater"):
        if need not in handled:
            bad(name, f"no body handles '{need}'")

    r = c.get("right_to_answer")
    if r is not None:
        w = f"{name} right_to_answer"
        for key in ("name", "name_en"):
            if not r.get(key):
                bad(w, f"missing {key}")
        texts(f"{w} what", r.get("what"), langs)
        texts(f"{w} how", r.get("how"), langs)
        url(f"{w} url", r.get("url"))
        url(f"{w} source", r.get("source"), required=True)
        if r.get("deadline_days") is not None:
            if not isinstance(r["deadline_days"], int):
                bad(w, "deadline_days should be a whole number")
            texts(f"{w} deadline_text", r.get("deadline_text"), langs)

    u = c.get("urgent")
    if u is not None:
        if not u.get("phone"):
            bad(f"{name} urgent", "missing phone")
        texts(f"{name} urgent what", u.get("what"), langs)
    cx = c.get("context")
    if cx is not None:
        texts(f"{name} context", {k: v for k, v in cx.items() if k != "sources"}, langs)
        for s in cx.get("sources") or []:
            url(f"{name} context source", s)
    o = c.get("organising")
    if o is not None:
        if not isinstance(o.get("telegram_usable"), bool):
            bad(f"{name} organising", "telegram_usable should be true or false")
        texts(f"{name} organising note", o.get("note"), langs)
    for g in c.get("groups") or []:
        url(f"{name} group", g.get("url"), required=True)
    return langs


def check_translation(lang, en):
    path = HERE / "i18n" / f"{lang}.json"
    if not path.exists():
        return bad(f"i18n/{lang}.json", "listed in index.json but missing")
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        return bad(path.name, f"not valid JSON: {e}")
    for key, source in en.items():
        if key not in d:
            bad(path.name, f"missing key {key}")
            continue
        a = sorted(re.findall(r"\{\w+\}", source))
        b = sorted(re.findall(r"\{\w+\}", d[key]))
        if a != b:
            bad(path.name, f"{key}: placeholders {b} should be {a}")
        if DASH.search(d[key]):
            bad(path.name, f"{key}: long dash")
    for key in d:
        if key not in en:
            bad(path.name, f"unknown key {key}")


def check_cases(lang, source):
    path = HERE / "i18n" / f"cases.{lang}.json"
    if not path.exists():
        return bad(path.name, "missing: the policy examples will show in English")
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        return bad(path.name, f"not valid JSON: {e}")
    for k in source["cases"]:
        for f in ("place", "before", "action", "after"):
            if not str(d.get("cases", {}).get(k["id"], {}).get(f, "")).strip():
                bad(path.name, f"case {k['id']} is missing {f}")
    for a in source["asks"]:
        for f in ("title", "text"):
            if not str(d.get("asks", {}).get(a["id"], {}).get(f, "")).strip():
                bad(path.name, f"ask {a['id']} is missing {f}")


def main():
    places = HERE.parent.parent / "pipeline" / "places.json"
    place_ids = {p["id"] for p in json.loads(places.read_text(encoding="utf-8"))} if places.exists() else set()
    en = json.loads((HERE / "i18n" / "en.json").read_text(encoding="utf-8"))
    listed = [l["code"] for l in json.loads((HERE / "i18n" / "index.json").read_text(encoding="utf-8"))]
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))

    cities = sorted((HERE / "cities").glob("*.json"))
    wanted = set()
    for path in cities:
        wanted |= set(check_city(path, place_ids) or [])
    for lang in listed:
        if lang != "en":
            check_translation(lang, en)
            check_cases(lang, cases)
    for lang in sorted(wanted - set(listed)):
        bad("i18n/index.json", f"a city writes in '{lang}' but that language is not listed")

    print(f"{len(cities)} city files, languages: {', '.join(listed)}")
    if problems:
        print(f"{len(problems)} problems:")
        for p in problems:
            print("  " + p)
        return 1
    print("all good")
    return 0


if __name__ == "__main__":
    sys.exit(main())
