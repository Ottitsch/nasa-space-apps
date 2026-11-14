#!/usr/bin/env python3
"""Build a cumulative vertical-displacement cube from NISAR GUNW pairs.

Pipeline (no AWS needed, runs from any machine with an Earthdata login):
  1. Ask NASA CMR for every GUNW pair of one track/frame over the area of interest.
  2. Chain the pairs into a time series (ref N -> sec N+1 -> ...).
  3. Read only the AOI of each pair over HTTPS (GDAL /vsicurl, ~/.netrc login),
     mask low-coherence pixels, block-average to a coarser grid.
  4. Remove each pair's planar ramp, convert phase -> vertical mm,
     accumulate over the chain.
  5. Write web/public/data/subsidence/{meta.json,cube.bin} for the web app.

Prerequisites: `brew install gdal` (with Python bindings) and a ~/.netrc entry
for urs.earthdata.nasa.gov.

Usage:
    python3 scripts/build_subsidence.py                 # defaults: Tulare Basin
    python3 scripts/build_subsidence.py --max-pairs 3   # quick test run
"""
import argparse
import json
import re
import sys
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
# CMR collection per maturity level, best first.
COLLECTIONS = {
    "VALIDATED": "C3622247503-ASF",
    "PROVISIONAL": "C2854335566-ASF",
    "BETA": "C2850261892-ASF",
}
NAME_RE = re.compile(
    r"NISAR_L2_\w\w_GUNW_(\d+)_(\d+)_([AD])_(\d+)_(\d+)_\w+_\w+_"
    r"(\d{8})T\d+_\d{8}T\d+_(\d{8})T\d+_\d{8}T\d+_"
)
GRID = "science/LSAR/GUNW/grids/frequencyA/"
UNW = GRID + "unwrappedInterferogram/HH/"

C = 299_792_458.0
CENTER_FREQ_HZ = 1.239e9  # frequencyA/centerFrequency in the product
WAVELENGTH = C / CENTER_FREQ_HZ  # ~0.242 m (L-band)

# ASSUMPTION (not stated in the ASF docs): NISAR follows the usual
# reference x conj(secondary) convention, where positive unwrapped phase means
# the range to the ground INCREASED (moving away from the satellite).
# Flip to -1 if known subsidence areas come out as uplift.
POSITIVE_PHASE_IS_RANGE_INCREASE = 1

NODATA = -32768
SCALE = 0.1  # mm per int16 unit


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- catalogue
def find_pairs(aoi, track, direction, frame):
    """Return {(ref_date, sec_date): pair} for one track/direction/frame."""
    w, s, e, n = aoi
    pairs = {}
    for level, cid in COLLECTIONS.items():
        url = f"{CMR}?collection_concept_id={cid}&bounding_box={w},{s},{e},{n}&page_size=2000"
        with urllib.request.urlopen(url, timeout=60) as r:
            items = json.load(r)["items"]
        for it in items:
            name = it["umm"]["GranuleUR"]
            m = NAME_RE.match(name)
            if not m:
                continue
            rc, trk, d, fr, sc, rd, sd = m.groups()
            if (trk, d, fr) != (track, direction, frame):
                continue
            h5 = [
                u["URL"]
                for u in it["umm"]["RelatedUrls"]
                if u["URL"].startswith("https") and u["URL"].endswith(".h5") and "QA_STATS" not in u["URL"]
            ]
            if not h5:
                continue
            key = (rd, sd)
            if key in pairs:  # same pair at several maturity levels: keep the best
                continue
            pairs[key] = dict(
                name=name, url=h5[0], level=level, ref_cycle=int(rc), sec_cycle=int(sc), ref=rd, sec=sd
            )
    return pairs


def chain(pairs):
    """Greedy chain from the earliest cycle: ref N -> sec N+k, smallest span first."""
    by_ref = {}
    for p in pairs.values():
        by_ref.setdefault(p["ref_cycle"], []).append(p)
    cur = min(by_ref)
    out = []
    while cur in by_ref:
        p = min(by_ref[cur], key=lambda x: x["sec_cycle"] - x["ref_cycle"])
        out.append(p)
        cur = p["sec_cycle"]
    if len(out) < len(pairs):
        log(f"note: {len(pairs)} pairs found, {len(out)} used in the chain")
    return out


# ---------------------------------------------------------------- reading
def _setup_gdal(cookies):
    from osgeo import gdal

    gdal.UseExceptions()
    gdal.SetConfigOption("GDAL_HTTP_NETRC", "YES")
    gdal.SetConfigOption("GDAL_HTTP_COOKIEFILE", cookies)
    gdal.SetConfigOption("GDAL_HTTP_COOKIEJAR", cookies)
    return gdal


def _warp(gdal, url, path, aoi, fine, resample="near", band=None):
    src = f'HDF5:"/vsicurl/{url}"://{path}'
    if band:
        src = gdal.Translate("", src, format="VRT", bandList=[band])
    w, s, e, n = aoi
    ds = gdal.Warp(
        "", src, format="MEM", dstSRS="EPSG:4326", outputBounds=(w, s, e, n),
        xRes=fine, yRes=fine, resampleAlg=resample,
    )
    return ds.GetRasterBand(1).ReadAsArray()


def read_pair(args):
    """Worker: fetch phase/coherence/components for one pair (cached on disk)."""
    pair, aoi, fine, cache = args
    cache = Path(cache)
    f = cache / f"{pair['name']}.npz"
    if f.exists():
        return pair["name"], "cached"
    gdal = _setup_gdal(str(cache / "cookies.txt"))
    last = None
    for attempt in range(3):
        try:
            phase = _warp(gdal, pair["url"], UNW + "unwrappedPhase", aoi, fine)
            coh = _warp(gdal, pair["url"], UNW + "coherenceMagnitude", aoi, fine)
            cc = _warp(gdal, pair["url"], UNW + "connectedComponents", aoi, fine)
            np.savez_compressed(f, phase=phase.astype("float32"), coh=coh.astype("float32"), cc=cc.astype("uint16"))
            return pair["name"], "ok"
        except Exception as exc:  # network hiccups happen
            last = exc
    return pair["name"], f"FAILED: {last}"


def read_incidence(pair, aoi, res, cache):
    """Incidence angle (degrees, at 0 m height) on the coarse grid, from one pair.

    The radarGrid cube has its own UTM coordinate arrays, so sample it by hand.
    """
    gdal = _setup_gdal(str(Path(cache) / "cookies.txt"))
    from osgeo import osr

    root = gdal.OpenEx(f"/vsicurl/{pair['url']}", gdal.OF_MULTIDIM_RASTER).GetRootGroup()
    g = root.OpenGroupFromFullname("/science/LSAR/GUNW/metadata/radarGrid")
    x = g.OpenMDArray("xCoordinates").ReadAsArray()
    y = g.OpenMDArray("yCoordinates").ReadAsArray()
    h = g.OpenMDArray("heightAboveEllipsoid").ReadAsArray()
    epsg = int(g.OpenMDArray("projection").ReadAsArray())
    cube = g.OpenMDArray("incidenceAngle").ReadAsArray()[int(np.argmin(np.abs(h)))]

    w, s, e, n = aoi
    cols, rows = round((e - w) / res), round((n - s) / res)
    lon = w + (np.arange(cols) + 0.5) * res
    lat = n - (np.arange(rows) + 0.5) * res
    LON, LAT = np.meshgrid(lon, lat)
    src, dst = osr.SpatialReference(), osr.SpatialReference()
    src.ImportFromEPSG(4326)
    dst.ImportFromEPSG(epsg)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    pts = osr.CoordinateTransformation(src, dst).TransformPoints(np.column_stack([LON.ravel(), LAT.ravel()]).tolist())
    E, N = np.array(pts)[:, 0].reshape(LON.shape), np.array(pts)[:, 1].reshape(LON.shape)
    ci = np.clip(np.round((E - x[0]) / (x[1] - x[0])).astype(int), 0, len(x) - 1)
    ri = np.clip(np.round((N - y[0]) / (y[1] - y[0])).astype(int), 0, len(y) - 1)
    return cube[ri, ci]


# ---------------------------------------------------------------- processing
def block_mean(a, f, min_frac):
    """Average f x f blocks, ignoring NaN; blocks with too few valid pixels -> NaN."""
    h, w = a.shape
    b = a.reshape(h // f, f, w // f, f)
    cnt = np.isfinite(b).sum(axis=(1, 3))
    tot = np.nansum(b, axis=(1, 3))
    out = np.where(cnt >= min_frac * f * f, tot / np.maximum(cnt, 1), np.nan)
    return out.astype("float32")


def coarse_pair(name, cache, f, min_coh, min_frac):
    d = np.load(Path(cache) / f"{name}.npz")
    phase, coh, cc = d["phase"], d["coh"], d["cc"]
    valid = np.isfinite(phase) & np.isfinite(coh) & (coh >= min_coh) & (cc > 0)
    if valid.any():  # one connected component only: its phase offset is consistent
        labels, counts = np.unique(cc[valid], return_counts=True)
        valid &= cc == labels[np.argmax(counts)]
    ph = np.where(valid, phase, np.nan)
    return block_mean(ph, f, min_frac), block_mean(np.where(valid, coh, np.nan), f, min_frac)


def remove_ramp(ph):
    """Subtract a robustly fitted plane from every pair.

    Each pair carries a large planar ramp (orbit, ionosphere, tides) that is
    unrelated to ground motion. Cells far from the typical level (e.g. a
    subsiding bowl) are excluded from the fit so they are not fitted away.
    """
    t, h, w = ph.shape
    yy, xx = np.mgrid[0:h, 0:w]
    out = np.empty_like(ph)
    for i in range(t):
        v = np.isfinite(ph[i])
        A = np.c_[np.ones(v.sum()), xx[v], yy[v]]
        y = ph[i][v]
        keep = np.ones(len(y), bool)
        for _ in range(5):
            c, *_ = np.linalg.lstsq(A[keep], y[keep], rcond=None)
            r = y - A @ c
            sigma = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
            keep = np.abs(r) < 2.5 * max(sigma, 1e-6)
        out[i] = ph[i] - (c[0] + c[1] * xx + c[2] * yy)
    return out


def manual_reference(phase_stack, ref_arg, aoi, res):
    """Cells within radius_km of (lon, lat) that are valid in >90% of pairs."""
    t, h, w = phase_stack.shape
    lon, lat, radius_km = ref_arg
    xs = aoi[0] + (np.arange(w) + 0.5) * res
    ys = aoi[3] - (np.arange(h) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    dist = np.hypot((X - lon) * 111.32 * np.cos(np.radians(lat)), (Y - lat) * 110.57)
    return (dist <= radius_km) & (np.isfinite(phase_stack).mean(axis=0) > 0.9)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--aoi", default="-120.7,35.4,-118.7,37.4", help="west,south,east,north (degrees)")
    p.add_argument("--track", default="034")
    p.add_argument("--direction", default="A")
    p.add_argument("--frame", default="020")
    p.add_argument("--res", type=float, default=0.01, help="output cell size in degrees")
    p.add_argument("--fine", type=float, default=0.001, help="read resolution in degrees (~80 m)")
    p.add_argument("--min-coh", type=float, default=0.4, help="coherence below this is masked")
    p.add_argument("--min-valid-frac", type=float, default=0.7, help="a cell needs this share of valid pairs")
    p.add_argument("--ref", help="optional reference area lon,lat,radius_km assumed stable (applied after ramp removal)")
    p.add_argument("--keep-ramp", action="store_true", help="do not remove the per-pair planar ramp")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--max-pairs", type=int, help="only use the first N pairs of the chain (testing)")
    p.add_argument("--cache", default="data_cache/nisar", help="folder for raw reads (resumable, gitignored)")
    p.add_argument("--out", default="web/public/data/subsidence")
    a = p.parse_args()

    aoi = tuple(float(x) for x in a.aoi.split(","))
    f = round(a.res / a.fine)
    width = round((aoi[2] - aoi[0]) / a.fine)
    height = round((aoi[3] - aoi[1]) / a.fine)
    if width % f or height % f:
        sys.exit("AOI size must be a multiple of --res")
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)

    pairs = find_pairs(aoi, a.track, a.direction, a.frame)
    if not pairs:
        sys.exit("no GUNW granules found for that track/direction/frame/AOI")
    steps = chain(pairs)
    if a.max_pairs:
        steps = steps[: a.max_pairs]
    log(f"{len(steps)} pairs in chain: {steps[0]['ref']} -> {steps[-1]['sec']}")

    jobs = [(s, aoi, a.fine, str(cache)) for s in steps]
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, (name, status) in enumerate(ex.map(read_pair, jobs), 1):
            log(f"[{i}/{len(jobs)}] {status}  {name[-70:-40]}")
            if status.startswith("FAILED"):
                sys.exit("a read failed; rerun to resume from the cache")

    ph, co = zip(*(coarse_pair(s["name"], cache, f, a.min_coh, a.min_valid_frac) for s in steps))
    ph, co = np.stack(ph), np.stack(co)  # (T, H, W) radians / coherence

    if not a.keep_ramp:
        ph = remove_ramp(ph)
    if a.ref:
        lon, lat, r = (float(x) for x in a.ref.split(","))
        ref = manual_reference(ph, (lon, lat, r), aoi, a.res)
        log(f"reference: {ref.sum()} cells within {r} km of {lon},{lat}")
        ph = ph - np.nanmedian(np.where(ref, ph, np.nan).reshape(len(steps), -1), axis=1)[:, None, None]

    inc = read_incidence(steps[0], aoi, a.res, cache)
    cos_inc = np.cos(np.radians(np.where(np.isfinite(inc) & (inc > 0), inc, np.nanmedian(inc[inc > 0]))))

    # phase -> vertical (mm, positive = up), assuming purely vertical motion
    sign = -POSITIVE_PHASE_IS_RANGE_INCREASE
    inc_mm = sign * ph * WAVELENGTH / (4 * np.pi) * 1000.0 / cos_inc

    ok = np.isfinite(inc_mm).mean(axis=0) >= a.min_valid_frac
    med = np.nanmedian(np.where(np.isfinite(inc_mm), inc_mm, np.nan), axis=0)
    filled = np.where(np.isfinite(inc_mm), inc_mm, med)  # missing pair -> that cell's median step
    cum = np.concatenate([np.zeros((1,) + med.shape, "float32"), np.cumsum(filled, axis=0)])
    cum[:, ~ok] = np.nan

    q = np.where(np.isfinite(cum), np.clip(np.round(cum / SCALE), -32767, 32767), NODATA).astype("<i2")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "cube.bin").write_bytes(q.tobytes())

    dates = [steps[0]["ref"]] + [s["sec"] for s in steps]
    iso = lambda d: datetime.strptime(d, "%Y%m%d").strftime("%Y-%m-%d")
    meta = dict(
        bounds=list(aoi), width=q.shape[2], height=q.shape[1], resolution_deg=a.res,
        steps=q.shape[0], dates=[iso(d) for d in dates],
        scale_mm=SCALE, nodata=NODATA, layout="int16 little-endian [step][row (north first)][col]",
        quantity="cumulative vertical displacement since first date, mm, positive = up",
        source=dict(track=a.track, direction=a.direction, frame=a.frame,
                    pairs=[dict(ref=iso(s["ref"]), sec=iso(s["sec"]), level=s["level"], granule=s["name"]) for s in steps]),
        processing=dict(
            wavelength_m=round(WAVELENGTH, 5), min_coherence=a.min_coh, min_valid_fraction=a.min_valid_frac,
            positive_phase_is_range_increase=bool(POSITIVE_PHASE_IS_RANGE_INCREASE),
            vertical_assumption="line-of-sight motion divided by cos(incidence angle)",
            ramp_removed=not a.keep_ramp,
            not_applied=["ionosphere", "troposphere", "solid earth tides"],
        ),
    )
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    final = cum[-1][ok]
    log(f"wrote {out}/cube.bin ({q.nbytes / 1e6:.1f} MB), valid cells {ok.mean() * 100:.0f}%")
    log(f"final cumulative mm: min {final.min():.0f}, p5 {np.percentile(final, 5):.0f}, "
        f"median {np.median(final):.0f}, p95 {np.percentile(final, 95):.0f}, max {final.max():.0f}")


if __name__ == "__main__":
    main()
