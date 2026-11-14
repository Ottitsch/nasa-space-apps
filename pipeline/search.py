"""Find NISAR GUNW (geocoded unwrapped interferogram) granules over a place.

Uses NASA's Common Metadata Repository (CMR). No login is needed to search.
"""
from __future__ import annotations

import collections
import dataclasses
import math
import time

import requests

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
# Newest first: validated products win over provisional ones when both exist.
COLLECTIONS = [
    ("validated", "C3622247503-ASF"),    # NISAR_L2_GUNW_V1
    ("provisional", "C2854335566-ASF"),  # NISAR_L2_GUNW_PROVISIONAL_V1
]


@dataclasses.dataclass
class Granule:
    name: str
    url: str
    track: int
    direction: str      # "A" ascending or "D" descending
    frame: int
    mode: str
    ref_date: str       # YYYYMMDD
    sec_date: str
    crid: str
    counter: int
    level: str          # validated or provisional
    polygon: list       # [(lat, lon), ...]

    @property
    def stack(self) -> str:
        return f"{self.track:03d}{self.direction}_{self.frame:03d}"


def bbox_from_center(lat: float, lon: float, size_km: float):
    """Square box (west, south, east, north) of the given edge length."""
    dlat = size_km / 2 / 110.574
    dlon = size_km / 2 / (111.320 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _parse(entry, level) -> Granule | None:
    name = entry["title"]
    p = name.split("_")
    # NISAR_L2_PR_GUNW_cyc_trk_dir_frm_cyc2_mode_pol_r0_r1_s0_s1_crid_acc_cov_site_ctr
    if len(p) < 20 or p[3] != "GUNW":
        return None
    url = next((l["href"] for l in entry.get("links", [])
                if l["href"].startswith("https://") and l["href"].endswith(".h5")
                and "QA_STATS" not in l["href"]), None)
    if url is None:
        return None
    poly = []
    for ring in entry.get("polygons", [[]])[0][:1]:
        v = [float(x) for x in ring.split()]
        poly = list(zip(v[0::2], v[1::2]))
    return Granule(name=name, url=url, track=int(p[5]), direction=p[6], frame=int(p[7]),
                   mode=p[9], ref_date=p[11][:8], sec_date=p[13][:8], crid=p[15],
                   counter=int(p[19]), level=level, polygon=poly)


def _inside(lat, lon, poly) -> bool:
    n, hit = len(poly), False
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def coverage(bbox, poly, n=9) -> float:
    """Fraction of the box covered by a granule footprint (sampled on a grid)."""
    w, s, e, nn = bbox
    hits = 0
    for i in range(n):
        for j in range(n):
            lat = s + (nn - s) * (i + 0.5) / n
            lon = w + (e - w) * (j + 0.5) / n
            hits += _inside(lat, lon, poly)
    return hits / (n * n)


def search(bbox) -> dict[str, list[Granule]]:
    """Return {stack_id: [granules sorted by date]} for every track and frame
    touching the box. Duplicate pairs keep the best processing level and newest
    version only."""
    best: dict[tuple, Granule] = {}
    rank = {lvl: i for i, (lvl, _) in enumerate(COLLECTIONS)}
    for level, cid in COLLECTIONS:
        page = 1
        while True:
            for attempt in range(5):
                try:
                    r = requests.get(CMR, params={
                        "collection_concept_id": cid,
                        "bounding_box": ",".join(f"{v:.5f}" for v in bbox),
                        "page_size": 2000, "page_num": page, "sort_key": "start_date",
                    }, timeout=90)
                    r.raise_for_status()
                    break
                except requests.RequestException:
                    if attempt == 4:
                        raise
                    time.sleep(3 * (attempt + 1))
            entries = r.json()["feed"]["entry"]
            for e in entries:
                g = _parse(e, level)
                if g is None:
                    continue
                key = (g.stack, g.ref_date, g.sec_date)
                old = best.get(key)
                newer = old is None or rank[g.level] < rank[old.level] or (
                    rank[g.level] == rank[old.level]
                    and (g.crid, g.counter) > (old.crid, old.counter))
                if newer:
                    best[key] = g
            if len(entries) < 2000:
                break
            page += 1
    stacks = collections.defaultdict(list)
    for g in best.values():
        stacks[g.stack].append(g)
    for v in stacks.values():
        v.sort(key=lambda g: (g.ref_date, g.sec_date))
    return dict(stacks)


def rank_stacks(bbox, stacks, min_coverage=0.6):
    """Score each stack by how much of the box it covers and how long it runs.
    Returns [(stack_id, coverage, n_pairs, span_days)] best first.

    A stack that covers the whole box comes first, unless another one covers
    nearly all of it (90 percent) and runs at least half as long again. The
    record length sets the smallest sinking that can be detected, so a year of
    passes over 95 percent of a place beats four months over all of it."""
    from datetime import date

    def d(s):
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))

    out = []
    for sid, gs in stacks.items():
        cov = min(coverage(bbox, g.polygon) for g in gs[:3])
        if cov < min_coverage:
            continue
        span = (d(max(g.sec_date for g in gs)) - d(min(g.ref_date for g in gs))).days
        out.append((sid, cov, len(gs), span))
    full_span = max((t[3] for t in out if t[1] >= 0.98), default=0)

    def covers(t):
        return t[1] >= 0.98 or (t[1] >= 0.9 and t[3] >= 1.5 * full_span)

    out.sort(key=lambda t: (-covers(t), -t[3], -t[1], -t[2]))
    return out
