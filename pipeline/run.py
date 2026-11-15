"""Build the map data for one or more places.

    python -m pipeline.run --place mexico-city
    python -m pipeline.run --all
    python -m pipeline.run --all --offline
    python -m pipeline.run --lat 19.4 --lon -99.05 --size 64 --id my-city --name "My City"

For each place this searches NASA's catalogue for NISAR interferograms, reads
the window over the place from each remote file, builds a ground motion time
series, and writes compact files under web/data for the map to load.

The radar windows it downloads are kept in data/nisar (in the repository), with
a manifest of the NASA products they came from. With --offline nothing is
searched or downloaded: the map data is rebuilt from data/nisar alone.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

from . import dem as D
from . import export as E
from . import fetch as F
from . import landcover as L
from . import process as P
from . import search as S

ROOT = Path(__file__).resolve().parent.parent
PLACES = ROOT / "pipeline" / "places.json"


class Pair:
    """One interferogram as listed in the manifest (enough to find its window)."""

    def __init__(self, ref, sec, name="", url=None):
        self.ref_date, self.sec_date, self.name, self.url = ref, sec, name, url


def read_manifest(raw):
    path = Path(raw) / "manifest.json"
    return json.loads(path.read_text()) if path.exists() else {}


def write_manifest(raw, pid, bbox, chosen, stacks):
    """Record which NASA products each stored window came from."""
    man = read_manifest(raw)
    man[pid] = dict(
        bbox=[round(v, 5) for v in bbox],
        stacks=[dict(id=sid, coverage=round(cov, 3), span_days=span,
                     pairs=[dict(ref=g.ref_date, sec=g.sec_date, product=g.name) for g in stacks[sid]])
                for sid, cov, npairs, span in chosen])
    path = Path(raw) / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(sorted(man.items())), indent=1))


def static_layers(raw, pid, sid, grid, cache):
    """Elevation (m) and land cover on the stack grid. Kept next to the radar
    windows so a rebuild needs no network at all."""
    path = Path(raw) / pid / sid / "static.npz"
    if path.exists():
        z = np.load(path)
        if z["dem"].shape == (grid["ny"], grid["nx"]):
            return z["dem"].astype(np.float32), z["landcover"]
    elev = np.round(D.dem_on_grid(grid, cache)).astype(np.int16)
    cover = L.landcover_on_grid(grid, cache, f"{pid}_{sid}")
    F.save_npz(path, dict(dem=elev, landcover=cover))
    return elev.astype(np.float32), cover


def choose_stacks(bbox, stacks, max_tracks=2):
    """Best stack overall, plus the best one looking from the other side when it
    covers the place and runs for a comparable length of time."""
    ranked = S.rank_stacks(bbox, stacks)
    if not ranked:
        return []
    chosen = [ranked[0]]
    if max_tracks > 1:
        first_dir = ranked[0][0][3]
        for r in ranked[1:]:
            if r[0][3] != first_dir and r[1] >= 0.9 and r[3] >= 0.75 * ranked[0][3]:
                chosen.append(r)
                break
    return chosen


def fetch_stack(place_id, sid, granules, bbox, raw, workers, log):
    folder = Path(raw) / place_id / sid
    def path(g):
        return folder / f"{g.ref_date}_{g.sec_date}.npz"
    first = F.fetch_to_cache((granules[0].url, bbox, None, str(path(granules[0])), True))
    if first[2]:
        raise RuntimeError(f"could not read {granules[0].name}: {first[2]}")
    grid = F.load_cached(first[0])["grid"]
    jobs = [(g.url, bbox, grid, str(path(g)), True) for g in granules[1:]]
    failed = 0
    with ProcessPoolExecutor(workers) as ex:
        for p, dt, err in ex.map(F.fetch_to_cache, jobs):
            if err:
                failed += 1
                log(f"    skipped {Path(p).name}: {err}")
    items = []
    for g in granules:
        if path(g).exists():
            d = F.load_cached(path(g))
            d["ref_date"], d["sec_date"] = g.ref_date, g.sec_date
            items.append(d)
    return items, grid, failed


def resample_in_time(sec, t_abs):
    """Secondary track's cumulative motion at the primary track's dates.
    sec: dict(cum, t, velocity, t0) with t0 = offset (years) of its first date."""
    t_s, S_, v = sec["t"], sec["cum"], sec["velocity"]
    out = np.empty((len(t_abs),) + S_.shape[1:], np.float32)
    for k, ta in enumerate(t_abs):
        tr = ta - sec["t0"]
        if tr <= 0:
            out[k] = v * tr
        elif tr >= t_s[-1]:
            out[k] = S_[-1] + v * (tr - t_s[-1])
        else:
            j = int(np.searchsorted(t_s, tr, side="right")) - 1
            w = (tr - t_s[j]) / (t_s[j + 1] - t_s[j])
            out[k] = (1 - w) * S_[j] + w * S_[j + 1]
    return out - out[0][None]


# A stack whose rate map is noisier than this (metres per year) says nothing
# useful yet: three times the noise would already be a detection limit of
# 18 cm per year. It is skipped until more passes bring the noise down.
MAX_NOISE = 0.06


def track_agreement(prim, sec, sig):
    """How well two viewing directions agree where both see the ground.

    The two tracks are processed independently (different orbits, different
    days, different atmosphere), so their difference is an honest measure of
    how far to trust the map. Returns None when they share too little ground.
      typical_diff_mm_yr   median absolute difference of the two rate maps
      sinking_diff_mm_yr   the same inside the detected sinking (None if none)
      sinking_rate_mm_yr   median rate there in each direction [primary, secondary]
      shared_fraction      share of the mapped ground both directions cover
    """
    both = prim["valid"] & sec["valid"]
    if both.sum() < 500:
        return None
    diff = prim["velocity"] - sec["velocity"]
    out = dict(
        typical_diff_mm_yr=round(float(np.median(np.abs(diff[both]))) * 1000, 1),
        shared_fraction=round(float(both.sum() / max((prim["valid"] | sec["valid"]).sum(), 1)), 2),
        sinking_diff_mm_yr=None, sinking_rate_mm_yr=None,
    )
    hot = both & sig
    if hot.sum() >= 40:
        out["sinking_diff_mm_yr"] = round(float(np.median(np.abs(diff[hot]))) * 1000, 1)
        out["sinking_rate_mm_yr"] = [round(float(np.median(l["velocity"][hot])) * 1000, 1) for l in (prim, sec)]
    return out


def touches_edge(sig, margin=3):
    """True when detected sinking reaches the rim of the box: it may well go on
    outside the area that was measured."""
    rim = np.zeros_like(sig)
    rim[:margin], rim[-margin:], rim[:, :margin], rim[:, -margin:] = True, True, True, True
    return bool((sig & rim).any())


def run_place(place, cache, out, raw, workers=5, max_tracks=2, fetch_only=False, offline=False,
              log=print):
    t_start = time.time()
    pid = place["id"]
    bbox = S.bbox_from_center(place["lat"], place["lon"], place.get("size_km", 56))
    if offline:
        entry = read_manifest(raw).get(pid)
        if not entry:
            raise RuntimeError("not in data/nisar/manifest.json: run once without --offline")
        stacks = {st["id"]: [Pair(p["ref"], p["sec"], p["product"]) for p in st["pairs"]]
                  for st in entry["stacks"]}
        chosen = [(st["id"], st["coverage"], len(st["pairs"]), st["span_days"])
                  for st in entry["stacks"]][:max_tracks]
    else:
        stacks = S.search(bbox)
        chosen = choose_stacks(bbox, stacks, max_tracks)
        if not chosen:
            raise RuntimeError("no NISAR interferograms cover this place yet")
        write_manifest(raw, pid, bbox, chosen, stacks)
    mg = E.mercator_grid(bbox, place["lat"])

    tracks, layers = [], []
    for sid, cov, npairs, span in chosen:
        log(f"  {sid}: {npairs} pairs over {span} days, coverage {cov:.0%}")
        items, grid, failed = fetch_stack(pid, sid, stacks[sid], bbox, raw, workers, log)
        elev, cover = static_layers(raw, pid, sid, grid, cache)
        if fetch_only:
            continue
        if len(items) < 4:
            log(f"    too few interferograms ({len(items)}), skipping this track")
            continue
        try:
            res = P.process_stack(items, dem=elev, landcover=cover, log=log)
        except ValueError as e:
            log(f"    {e}, skipping this track")
            continue
        if res["valid"].mean() < 0.03 or not np.isfinite(res["sigma"]):
            log("    almost no ground with a stable radar signal, skipping this track")
            continue
        if res["sigma"] > MAX_NOISE:
            log(f"    too noisy so far ({res['sigma'] * 1000:.0f} mm/yr), skipping this track")
            continue
        warp = E.Warper(grid, mg)
        valid = warp(res["valid"])
        vel = np.where(valid, warp(res["velocity"]), np.nan)
        cum = np.stack([np.where(valid, warp(f), np.nan) for f in res["cum"]])
        valid &= np.isfinite(vel)
        layers.append(dict(velocity=vel, cum=cum, valid=valid, t=res["t"], sigma=res["sigma"],
                           dates=res["dates"], slope=warp(D.slope_degrees(elev)),
                           built=warp(cover == L.BUILT)))
        tracks.append(dict(id=sid, direction=res["direction"].lower(), pairs=res["n_pairs"],
                           incidence_deg=round(res["incidence"], 1),
                           first=res["dates"][0], last=res["dates"][-1],
                           noise_mm_yr=round(res["sigma"] * 1000, 1)))
        del res, items
    if fetch_only:
        return None
    if not layers:
        raise RuntimeError("no usable track")

    prim = layers[0]
    dates, t = prim["dates"], prim["t"]
    if len(layers) == 1:
        vel, cum, valid = prim["velocity"], prim["cum"], prim["valid"]
    else:
        sec = layers[1]
        d0 = date.fromisoformat(dates[0])
        sec["t0"] = (date.fromisoformat(sec["dates"][0]) - d0).days / 365.25
        sec_cum = resample_in_time(sec, t)
        wp, ws = 1 / prim["sigma"] ** 2, 1 / sec["sigma"] ** 2
        both = prim["valid"] & sec["valid"]
        only_s = sec["valid"] & ~prim["valid"]
        vel = prim["velocity"].copy()
        vel[both] = (wp * prim["velocity"][both] + ws * sec["velocity"][both]) / (wp + ws)
        vel[only_s] = sec["velocity"][only_s]
        cum = prim["cum"].copy()
        cum[:, both] = (wp * prim["cum"][:, both] + ws * sec_cum[:, both]) / (wp + ws)
        cum[:, only_s] = sec_cum[:, only_s]
        valid = prim["valid"] | sec["valid"]

    slope = prim["slope"]
    det = P.detect(vel, valid, slope, span_years=float(t[-1]), steady=P.sustained(cum, t, vel))
    vel = vel - det["median"]
    cum = cum - (det["median"] * t)[:, None, None]
    sig = det["significant"]

    built = prim["built"]
    agreement = track_agreement(prim, layers[1], sig) if len(layers) > 1 else None
    sizes = E.write_place(Path(out) / pid, vel, det["beta_rate"], valid, sig, built, cum, t)

    # headline numbers
    area = float(sig.sum()) * 0.0064
    peak = float(np.percentile(vel[sig], 0.5)) if sig.any() else None
    series = None
    if sig.any():
        hot = sig & (vel <= np.percentile(vel[sig], 10))
        series = [round(float(np.nanmean(f[hot])) * 1000, 1) for f in cum]
    entry = dict(
        id=pid, name=place["name"], country=place.get("country", ""),
        lat=place["lat"], lon=place["lon"], driver=place.get("driver", ""),
        bounds=[round(v, 6) for v in E.grid_bounds(mg)], width=mg["W"], height=mg["H"],
        dates=dates, t_years=[round(float(x), 5) for x in t], tracks=tracks,
        noise_mm_yr=round(det["sigma"] * 1000, 1),
        threshold_mm_yr=round(det["threshold"] * 1000, 1),
        sinking_area_km2=round(area, 1),
        builtup_sinking_km2=round(float((sig & built).sum()) * 0.0064, 1),
        peak_rate_mm_yr=None if peak is None else round(peak * 1000),
        max_distortion_per_yr=round(float(det["beta_rate"].max()), 7),
        hot_series_mm=series,
        valid_fraction=round(float(valid.mean()), 3),
        agreement=agreement,                    # None: one direction only, not cross checked
        reaches_edge=touches_edge(sig),
        bytes=sizes,
    )
    log(f"  done in {time.time() - t_start:.0f}s: noise {entry['noise_mm_yr']} mm/yr, "
        f"sinking area {entry['sinking_area_km2']} km2, peak {entry['peak_rate_mm_yr']} mm/yr, "
        f"files {sum(sizes.values()) / 1e6:.2f} MB")
    return entry


KEEP = ("gnss",)


def update_index(out, entry):
    """Merge one place into web/data/index.json (kept sorted by name)."""
    path = Path(out) / "index.json"
    index = json.loads(path.read_text()) if path.exists() else {"places": []}
    old = next((p for p in index["places"] if p["id"] == entry["id"]), {})
    for key in KEEP:                         # written by other steps (pipeline.gnss)
        if key in old and key not in entry:
            entry[key] = old[key]
    index["places"] = [p for p in index["places"] if p["id"] != entry["id"]] + [entry]
    index["places"].sort(key=lambda p: p["name"])
    index["generated"] = date.today().isoformat()
    index["source"] = ("NISAR L2 GUNW (geocoded unwrapped interferograms), NASA and ISRO, "
                       "distributed by the Alaska Satellite Facility DAAC")
    path.write_text(json.dumps(_clean(index), separators=(",", ":"), allow_nan=False))


def _clean(v):
    """JSON has no NaN: turn any that slipped through into null."""
    if isinstance(v, float) and not np.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--place", action="append", help="id from places.json (repeatable)")
    ap.add_argument("--all", action="store_true", help="every place in places.json")
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--fetch-only", action="store_true", help="only fill the download cache")
    ap.add_argument("--reverse", action="store_true", help="work through the list backwards")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--size", type=float, default=56, help="box edge in km")
    ap.add_argument("--id")
    ap.add_argument("--name")
    ap.add_argument("--offline", action="store_true",
                    help="no search, no download: rebuild from data/nisar only")
    ap.add_argument("--raw", default=str(ROOT / "data" / "nisar"),
                    help="where the radar windows are kept (in the repository)")
    ap.add_argument("--cache", default=str(ROOT / ".cache"),
                    help="scratch downloads of public elevation and land cover tiles")
    ap.add_argument("--out", default=str(ROOT / "web" / "data"))
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--tracks", type=int, default=2, help="max tracks to combine (1 or 2)")
    a = ap.parse_args(argv)

    known = {p["id"]: p for p in json.loads(PLACES.read_text())}
    if a.lat is not None:
        todo = [dict(id=a.id or "custom", name=a.name or a.id or "Custom", lat=a.lat, lon=a.lon,
                     size_km=a.size)]
    elif a.all:
        todo = list(known.values())
    else:
        todo = [known[p] for p in (a.place or [])]
    if not todo:
        ap.error("nothing to do: pass --place, --all, or --lat/--lon")

    if a.reverse:
        todo = todo[::-1]
    done = set()
    idx = Path(a.out) / "index.json"
    if a.skip_existing and idx.exists():
        done = {p["id"] for p in json.loads(idx.read_text())["places"]}
    failures = []
    for i, place in enumerate(todo):
        if place["id"] in done:
            continue
        print(f"[{i + 1}/{len(todo)}] {place['name']}", flush=True)
        try:
            entry = run_place(place, a.cache, a.out, a.raw, a.workers, a.tracks, a.fetch_only,
                              a.offline, log=lambda m: print(m, flush=True))
            if entry is not None:
                update_index(a.out, entry)
        except Exception as e:  # keep going: one bad place should not stop the batch
            failures.append((place["id"], str(e)))
            print(f"  FAILED: {e}", flush=True)
            traceback.print_exc()
    if failures:
        print("\nfailed:", *[f"  {pid}: {msg}" for pid, msg in failures], sep="\n")
    return 1 if failures and len(failures) == len(todo) else 0


if __name__ == "__main__":
    sys.exit(main())
