"""Build the map for one area on request: the ground around an address that no
place in places.json covers.

    python -m pipeline.area --lat 20.94 --lon -101.43
    python -m pipeline.area --lat 20.94 --lon -101.43 --fetch-only
    python -m pipeline.area --lat 20.94 --lon -101.43 --offline

Areas sit on a fixed grid of points 0.2 degrees apart (about 22 km). A spot is
rounded to the nearest point, so everyone asking about the same neighbourhood
shares one build and the address itself is never sent or stored. Each area is
a 56 km box around its point (the pipeline's usual box), so the spot lies at
least 17 km inside it. Smaller boxes hold too little stable ground to measure
against when they sit on a sinking basin: tested in November 2026 on windows
cut from the stored places, a 40 km box over central Mexico City read twice
the noise of the 64 km place (14 against 6 mm per year), 48 km read 7, and
over Tehran 40 km read 17, 56 km 14 and the 80 km place 12.

An area is processed exactly like a place and written to web/data/areas/<id>/:
the two map files and a meta.json holding what index.json holds for a place,
plus "status": "ready".

An area that cannot be built for a reason that lies in the data (no radar
passes yet, no usable track, held back after review) gets a meta.json with
"status": "failed", a code and a reason, so the site can say why instead of
trying again at once; it is tried again after RETRY_DAYS. Other errors (the
network, a login) say nothing about the area: they are not written down, and
the command exits with status 1. A ready area is never replaced by a failure.

The radar windows go to data_cache/areas, which is not in the repository, so an
area costs the repository only its map files (tens to hundreds of KB).
pipeline/serve.py (locally) and .github/workflows/build-area.yml (for the live
site) run this.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import traceback
from datetime import date
from pathlib import Path

from . import run as R
from . import search as S

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data" / "areas"
RAW = ROOT / "data_cache" / "areas"
CACHE = ROOT / ".cache"
PER_DEG = 5                     # grid points per degree: 0.2 degrees apart
SIZE_KM = 56
RETRY_DAYS = 30                 # a failed area may be built again after this
ID_RE = re.compile(r"^area-(\d{1,2})\.(\d)([ns])-(\d{1,3})\.(\d)([ew])$")


class AreaError(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code, self.reason = code, reason


def _deg(k):
    """Grid index as degrees in tenths, written without floating point, so
    functions/api/[[path]].js and web/js/areas.js give the same id."""
    tenths = abs(k) * 10 // PER_DEG
    return f"{tenths // 10}.{tenths % 10}"


def snap(lat: float, lon: float) -> dict:
    """The grid point nearest to a spot: id, lat, lon and a name."""
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"not a spot on Earth: {lat}, {lon}")
    i = math.floor(lat * PER_DEG + 0.5)
    j = math.floor(lon * PER_DEG + 0.5)
    i = max(-89 * PER_DEG, min(89 * PER_DEG, i))
    if j >= 180 * PER_DEG:
        j -= 360 * PER_DEG
    ns, ew = ("n" if i >= 0 else "s"), ("e" if j >= 0 else "w")
    return dict(
        id=f"area-{_deg(i)}{ns}-{_deg(j)}{ew}", lat=i / PER_DEG, lon=j / PER_DEG,
        name=f"Around {_deg(i)}° {ns.upper()}, {_deg(j)}° {ew.upper()}",
    )


def parse_id(area_id: str):
    """(lat, lon) of an area id, or None."""
    m = ID_RE.match(area_id or "")
    if not m:
        return None
    lat = int(m[1]) + int(m[2]) / 10
    lon = int(m[4]) + int(m[5]) / 10
    return (-lat if m[3] == "s" else lat), (-lon if m[6] == "w" else lon)


def held_by(lat, lon):
    """A place held back after review whose box holds this spot, if any. Its
    reason (seasonal clay, a broken track) applies to the area as well."""
    for p in json.loads(R.PLACES.read_text()):
        if not p.get("hold"):
            continue
        w, s, e, n = S.bbox_from_center(p["lat"], p["lon"], p.get("size_km", 56))
        if w <= lon <= e and s <= lat <= n:
            return p
    return None


def read_meta(folder: Path):
    path = folder / "meta.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def is_current(meta) -> bool:
    """A ready area, or a failure recent enough not to try again yet."""
    if not meta:
        return False
    if meta.get("status") == "ready":
        return True
    try:
        age = (date.today() - date.fromisoformat(meta.get("built", ""))).days
    except ValueError:
        return False
    return meta.get("status") == "failed" and age < RETRY_DAYS


def _write(folder: Path, meta: dict):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps(R._clean(meta), separators=(",", ":"), allow_nan=False))


# what run_place says when it skips a track, and what that means to a reader
TRACK_REASONS = [
    ("too few interferograms", "There are too few usable radar passes here yet."),
    ("almost no ground with a stable radar signal",
     "Too little ground here gives a stable radar signal. Water, farmland and forest are left out."),
    ("too noisy", "The radar passes here are too noisy to measure sinking yet. That often happens "
                  "in a rainy season."),
    ("faster than any city is known to sink",
     "The radar track here reads faster sinking than any city is known to have, so it is left out."),
    ("more than twice as noisy", "The radar passes here are too noisy to measure sinking yet."),
]


def _failure(c, err, notes):
    if isinstance(err, AreaError):
        code, reason = err.code, err.reason
    elif "no NISAR interferograms" in str(err):
        code, reason = "uncovered", "NISAR has no radar passes over this area yet."
    elif "no usable track" in str(err):
        said = [r for key, r in TRACK_REASONS for line in notes if key in line]
        code, reason = "unusable", said[-1] if said else "No radar track here can be used yet."
    elif "Earthdata" in str(err):
        code, reason = "error", "The build could not read NASA's radar files: Earthdata Login refused."
    else:
        code = "error"
        reason = f"The build stopped with an error: {type(err).__name__}: {err}"[:300]
    return dict(status="failed", id=c["id"], name=c["name"], lat=c["lat"], lon=c["lon"],
                built=date.today().isoformat(), code=code, reason=reason)


def build(lat, lon, *, out=OUT, raw=RAW, cache=CACHE, fetch_only=False, offline=False,
          force=False, workers=5, log=print):
    """Build the area around a spot. Returns its meta (as written), the
    current meta when there is nothing to do, or None after --fetch-only."""
    c = snap(lat, lon)
    folder = Path(out) / c["id"]
    old = read_meta(folder)
    if not force and not offline and is_current(old):
        log(f"> {c['id']} is already built ({old['status']}, {old.get('built')})")
        return old
    notes = []

    def keep(m):
        notes.append(m)
        log(m)
        if "pairs over" in m:
            sid, rest = m.strip().split(":", 1)
            log(f"> Reading and processing radar track {sid} ({rest.split(' over')[0].strip()})")

    place = dict(id=c["id"], name=c["name"], country="", lat=c["lat"], lon=c["lon"], size_km=SIZE_KM)
    log(f"> Searching NASA's catalogue over {c['name']}" if not offline else "> Processing the radar passes")
    try:
        held = held_by(c["lat"], c["lon"])
        if held:
            raise AreaError("held", f"Held back after review, as for {held['name']}: {held['hold']}.")
        entry = R.run_place(place, cache, out, raw, workers, 2, fetch_only, offline, log=keep)
    except Exception as e:  # every failure is written down for the site to show
        traceback.print_exc()
        meta = _failure(c, e, notes)
        log(f"> {meta['reason']}")
        if old and old.get("status") == "ready":
            log("> keeping the map built earlier")
            return old
        if meta["code"] != "error":
            _write(folder, meta)
        return meta
    if fetch_only:
        return None
    meta = dict(status="ready", built=date.today().isoformat(), size_km=SIZE_KM, **entry)
    _write(folder, meta)
    log("> The map is ready")
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--id", help="refuse unless the spot rounds to this area (a check on the caller)")
    ap.add_argument("--fetch-only", action="store_true", help="only search and download")
    ap.add_argument("--offline", action="store_true", help="only process what --fetch-only downloaded")
    ap.add_argument("--force", action="store_true", help="build again even if the area is built")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--raw", default=str(RAW))
    ap.add_argument("--cache", default=str(CACHE))
    ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args(argv)
    try:
        c = snap(a.lat, a.lon)
    except ValueError as e:
        ap.error(str(e))
    if a.id and a.id != c["id"]:
        ap.error(f"the spot rounds to {c['id']}, not {a.id}")
    meta = build(a.lat, a.lon, out=a.out, raw=a.raw, cache=a.cache, fetch_only=a.fetch_only,
                 offline=a.offline, force=a.force, workers=a.workers, log=lambda m: print(m, flush=True))
    status = "fetched" if meta is None else meta["status"]
    # the workflow reads this to skip processing when there is nothing to process
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            print(f"status={status}", file=f)
    print(f"{c['id']}: {status}")
    return 1 if meta and meta.get("code") == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
