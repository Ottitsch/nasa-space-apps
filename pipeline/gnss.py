"""Check the map against ground stations it has never seen.

Permanent GNSS (GPS) stations measure how fast one point of ground moves up or
down, year after year, with no radar involved. The Nevada Geodetic Laboratory
publishes a vertical rate for about twenty thousand of them (MIDAS velocities,
Blewitt et al. 2016, open data, no login). Where such a station stands inside
a place, its rate is compared with the rate the map gives for the same spot.

    python -m pipeline.gnss            # every place in web/data/index.json
    python -m pipeline.gnss --place mexico-city

The result is stored per place under "gnss" in web/data/index.json:

    stations             [{id, lat, lon, up_mm_yr, sigma_mm_yr, first, last, map_mm_yr}]
    typical_diff_mm_yr   median absolute difference, map minus station
    checked              date the comparison was made

What the comparison can and cannot show:
  * The station rate is an average over its whole record, often ten years or
    more. The map covers months. Where sinking changed speed, they differ for
    good reason.
  * The map is relative: zero is the typical ground of the place that is not
    moving. The station rate is absolute. A station on that quiet ground
    should read near zero in both; one in a sinking zone should sink in both.
  * A station sits on one building or pillar. The map value is the median of
    trusted pixels within 400 m.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
import requests

from .export import NODATA, merc_y
from .run import ROOT, _clean

MIDAS = "https://geodesy.unr.edu/velocities/midas.IGS14.txt"
MIN_YEARS = 2.5        # shorter records give unreliable vertical rates
MAX_SIGMA = 0.002      # m/yr: drop stations whose own rate is this uncertain
LAST_AFTER = 2018.0    # the record must reach into recent years
RADIUS_PX = 5          # 400 m


def load_stations(cache):
    """[(id, lat, lon, up m/yr, sigma m/yr, first, last)] for usable stations."""
    path = Path(cache) / "gnss" / "midas.IGS14.txt"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(MIDAS, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
    out = []
    for line in path.read_text().splitlines():
        c = line.split()
        if len(c) < 26:
            continue
        try:
            first, last, years = float(c[2]), float(c[3]), float(c[4])
            up, sig, lat, lon = float(c[10]), float(c[13]), float(c[24]), float(c[25])
        except ValueError:
            continue
        if years < MIN_YEARS or sig > MAX_SIGMA or last < LAST_AFTER:
            continue
        lon = (lon + 180.0) % 360.0 - 180.0
        out.append((c[0], lat, lon, up, sig, first, last))
    return out


def read_core(folder, W, H):
    """(rate mm/yr as float with NaN, valid mask) of one place."""
    raw = gzip.decompress((Path(folder) / "core.bin.gz").read_bytes())
    n = W * H
    rate = np.frombuffer(raw, "<i2", n).reshape(H, W).astype(np.float32)
    flags = np.frombuffer(raw, np.uint8, n, offset=4 * n).reshape(H, W)
    valid = (flags & 1).astype(bool) & (rate != NODATA)
    return np.where(valid, rate, np.nan), valid


def map_rate(rate, valid, bounds, lat, lon):
    """Median map rate (mm/yr) of trusted pixels within RADIUS_PX of a point, or None."""
    w, s, e, n = bounds
    H, W = rate.shape
    col = (lon - w) / (e - w) * W
    row = (merc_y(n) - merc_y(lat)) / (merc_y(n) - merc_y(s)) * H
    if not (0 <= col < W and 0 <= row < H):
        return None
    r0, r1 = max(0, int(row) - RADIUS_PX), min(H, int(row) + RADIUS_PX + 1)
    c0, c1 = max(0, int(col) - RADIUS_PX), min(W, int(col) + RADIUS_PX + 1)
    yy, xx = np.mgrid[r0:r1, c0:c1]
    near = valid[r0:r1, c0:c1] & (np.hypot(yy - row, xx - col) <= RADIUS_PX)
    if near.sum() < 3:
        return None
    return float(np.median(rate[r0:r1, c0:c1][near]))


def check_place(p, stations, data):
    w, s, e, n = p["bounds"]
    inside = [st for st in stations if s <= st[1] <= n and w <= st[2] <= e]
    if not inside:
        return None
    rate, valid = read_core(Path(data) / p["id"], p["width"], p["height"])
    rows = []
    for sid, lat, lon, up, sig, first, last in inside:
        m = map_rate(rate, valid, p["bounds"], lat, lon)
        if m is None:      # the station stands on ground the map leaves blank
            continue
        rows.append(dict(id=sid, lat=round(lat, 5), lon=round(lon, 5), up_mm_yr=round(up * 1000, 1),
                         sigma_mm_yr=round(sig * 1000, 1), first=int(first), last=int(last),
                         map_mm_yr=round(m, 1)))
    if not rows:
        return None
    diffs = [r["map_mm_yr"] - r["up_mm_yr"] for r in rows]
    return dict(stations=rows, typical_diff_mm_yr=round(float(np.median(np.abs(diffs))), 1),
                checked=date.today().isoformat(), source="Nevada Geodetic Laboratory MIDAS velocities (IGS14)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--place", action="append", help="id (repeatable); default: every place")
    ap.add_argument("--data", default=str(ROOT / "web" / "data"))
    ap.add_argument("--cache", default=str(ROOT / ".cache"))
    ap.add_argument("--dry", action="store_true", help="print the comparison, do not write index.json")
    a = ap.parse_args(argv)

    idx_path = Path(a.data) / "index.json"
    index = json.loads(idx_path.read_text())
    stations = load_stations(a.cache)
    print(f"{len(stations)} usable GNSS stations worldwide")
    all_diffs, hits = [], 0
    for p in index["places"]:
        if a.place and p["id"] not in a.place:
            continue
        res = check_place(p, stations, a.data)
        if res is None:
            p.pop("gnss", None)
            continue
        p["gnss"] = res
        hits += 1
        thr = p["threshold_mm_yr"]
        for r in res["stations"]:
            all_diffs.append(r["map_mm_yr"] - r["up_mm_yr"])
        worst = max(res["stations"], key=lambda r: abs(r["map_mm_yr"] - r["up_mm_yr"]))
        print(f"  {p['id']:18s} {len(res['stations']):2d} stations, typical difference "
              f"{res['typical_diff_mm_yr']:5.1f} mm/yr (detection limit {thr} mm/yr); "
              f"largest at {worst['id']}: station {worst['up_mm_yr']:+.1f}, map {worst['map_mm_yr']:+.1f}")
    if all_diffs:
        d = np.array(all_diffs)
        print(f"{hits} places with stations, {len(d)} comparisons: median |map - station| "
              f"{np.median(np.abs(d)):.1f} mm/yr, 90% within {np.percentile(np.abs(d), 90):.1f} mm/yr, "
              f"median bias {np.median(d):+.1f} mm/yr")
    else:
        print("no station stands on mapped ground in these places")
    if not a.dry:
        idx_path.write_text(json.dumps(_clean(index), separators=(",", ":"), allow_nan=False))
        print("index.json updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
