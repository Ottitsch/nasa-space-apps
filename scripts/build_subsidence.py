#!/usr/bin/env python3
"""Build a cumulative vertical-displacement cube from NISAR GUNW pairs.

Pipeline (no AWS needed, runs from any machine with an Earthdata login):
  1. Ask NASA CMR for every GUNW pair of one track/frame over the area of interest.
  2. Chain the pairs into a time series (ref N -> sec N+1 -> ...).
  3. Read only the AOI of each pair over HTTPS (GDAL /vsicurl, ~/.netrc login),
     mask low-coherence pixels, block-average to a coarser grid.
  4. Subtract the ionosphere and wet-troposphere screens (the latter at terrain
     height from the public Copernicus DEM) per pair, but only where they lower
     the noise; remove each pair's planar ramp; convert phase -> vertical mm;
     accumulate over the chain.
  5. Write cube.bin / trend.bin / meta.json for the web app.

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
import time
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


def progress(done, total, t0, label=""):
    """One progress line: bar, count, elapsed time and ETA."""
    frac = done / total
    elapsed = time.time() - t0
    eta = elapsed / frac * (1 - frac) if done else 0
    mmss = lambda sec: f"{int(sec // 60)}m{int(sec % 60):02d}s"
    n = int(frac * 30)
    log(f"[{'#' * n}{'-' * (30 - n)}] {done}/{total} {frac * 100:3.0f}%  elapsed {mmss(elapsed)}  ETA {mmss(eta)}  {label}")


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
    """Worker: fetch phase/coherence/components/ionosphere for one pair (cached on disk)."""
    pair, aoi, fine, cache, res, dem_file = args
    cache = Path(cache)
    f = cache / f"{pair['name']}.npz"
    fi = cache / f"{pair['name']}.iono.npz"
    fw = cache / f"{pair['name']}.wet.npz"
    need_wet = dem_file is not None and not fw.exists()
    if f.exists() and fi.exists() and not need_wet:
        return pair["name"], "cached"
    gdal = _setup_gdal(str(cache / "cookies.txt"))
    last = None
    for attempt in range(3):
        try:
            if not f.exists():
                phase = _warp(gdal, pair["url"], UNW + "unwrappedPhase", aoi, fine)
                coh = _warp(gdal, pair["url"], UNW + "coherenceMagnitude", aoi, fine)
                cc = _warp(gdal, pair["url"], UNW + "connectedComponents", aoi, fine)
                np.savez_compressed(f, phase=phase.astype("float32"), coh=coh.astype("float32"), cc=cc.astype("uint16"))
            if not fi.exists():
                iono = _warp(gdal, pair["url"], UNW + "ionospherePhaseScreen", aoi, fine)
                np.savez_compressed(fi, iono=iono.astype("float32"))
            if need_wet:
                np.savez_compressed(fw, wet=read_wet(gdal, pair["url"], aoi, res, np.load(dem_file)))
            return pair["name"], "ok"
        except Exception as exc:  # network hiccups happen
            last = exc
    return pair["name"], f"FAILED: {last}"


def _grid_index(aoi, res, epsg, x, y):
    """Row/col indices into a radarGrid cube (UTM x/y arrays) for every output cell."""
    from osgeo import osr

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
    pts = np.array(osr.CoordinateTransformation(src, dst).TransformPoints(np.column_stack([LON.ravel(), LAT.ravel()]).tolist()))
    E, N = pts[:, 0].reshape(LON.shape), pts[:, 1].reshape(LON.shape)
    ci = np.clip(np.round((E - x[0]) / (x[1] - x[0])).astype(int), 0, len(x) - 1)
    ri = np.clip(np.round((N - y[0]) / (y[1] - y[0])).astype(int), 0, len(y) - 1)
    return ri, ci


def _radar_grid(gdal, url):
    root = gdal.OpenEx(f"/vsicurl/{url}", gdal.OF_MULTIDIM_RASTER).GetRootGroup()
    g = root.OpenGroupFromFullname("/science/LSAR/GUNW/metadata/radarGrid")
    return (g, g.OpenMDArray("xCoordinates").ReadAsArray(), g.OpenMDArray("yCoordinates").ReadAsArray(),
            g.OpenMDArray("heightAboveEllipsoid").ReadAsArray(), int(g.OpenMDArray("projection").ReadAsArray()))


def read_incidence(pair, aoi, res, cache):
    """Incidence angle (degrees, at 0 m height) on the coarse grid, from one pair.

    The radarGrid cube has its own UTM coordinate arrays, so sample it by hand.
    """
    gdal = _setup_gdal(str(Path(cache) / "cookies.txt"))
    g, x, y, h, epsg = _radar_grid(gdal, pair["url"])
    cube = g.OpenMDArray("incidenceAngle").ReadAsArray()[int(np.argmin(np.abs(h)))]
    ri, ci = _grid_index(aoi, res, epsg, x, y)
    return cube[ri, ci]


DEM_URL = ("/vsicurl/https://copernicus-dem-90m.s3.amazonaws.com/"
           "Copernicus_DSM_COG_30_N{la:02d}_00_W{lo:03d}_00_DEM/Copernicus_DSM_COG_30_N{la:02d}_00_W{lo:03d}_00_DEM.tif")
GEOID_OFFSET_M = -32.0  # DEM is above the geoid; ellipsoid height is roughly 32 m lower in California


def load_dem(aoi, res, cache):
    """Terrain height (m) on the coarse grid from the public Copernicus 90 m DEM (cached)."""
    f = Path(cache) / f"dem_{res}_{'_'.join(map(str, aoi))}.npy"
    if f.exists():
        return np.load(f)
    import math

    gdal = _setup_gdal(str(Path(cache) / "cookies.txt"))
    w, s, e, n = aoi
    tiles = [DEM_URL.format(la=la, lo=-lo) for la in range(math.floor(s), math.ceil(n))
             for lo in range(math.floor(w), math.ceil(e))]
    vrt = gdal.BuildVRT("", tiles)
    ds = gdal.Warp("", vrt, format="MEM", outputBounds=aoi, xRes=res, yRes=res, resampleAlg="average", dstSRS="EPSG:4326")
    dem = ds.GetRasterBand(1).ReadAsArray().astype("float32")
    np.save(f, dem)
    return dem


def read_wet(gdal, url, aoi, res, dem):
    """Wet-troposphere phase screen (rad) at terrain height on the coarse grid.

    Only the AOI window of the lowest levels (up to ~4.5 km) is read from the cube.
    """
    g, x, y, h, epsg = _radar_grid(gdal, url)
    ri, ci = _grid_index(aoi, res, epsg, x, y)
    r0, r1, c0, c1 = ri.min(), ri.max() + 1, ci.min(), ci.max() + 1
    nk = int(np.searchsorted(h, 4500)) + 1
    arr = g.OpenMDArray("wetTroposphericPhaseScreen")
    cube = arr.ReadAsArray(array_start_idx=[0, int(r0), int(c0)], count=[nk, int(r1 - r0), int(c1 - c0)])
    hh = np.clip(dem + GEOID_OFFSET_M, h[0], h[nk - 1] - 1e-3)
    k = np.clip(np.floor((hh - h[0]) / (h[1] - h[0])).astype(int), 0, nk - 2)
    fr = (hh - h[k]) / (h[1] - h[0])
    rr, cc = ri - r0, ci - c0
    return ((1 - fr) * cube[k, rr, cc] + fr * cube[k + 1, rr, cc]).astype("float32")


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


def gaussian_blur(a, sigma, keep_mask=False):
    """NaN-aware (normalised) Gaussian blur. Fills small holes unless keep_mask."""
    if sigma <= 0:
        return a
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()

    def conv(x):
        x = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 0, x)
        return np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 1, x)

    m = np.isfinite(a)
    num, den = conv(np.where(m, a, 0.0)), conv(m.astype(float))
    out = np.where(den > 1e-3, num / np.maximum(den, 1e-3), np.nan)
    if keep_mask:
        out = np.where(m, out, np.nan)
    return out.astype("float32")


def coarse_iono(name, cache, f):
    iono = np.load(Path(cache) / f"{name}.iono.npz")["iono"]
    return block_mean(iono, f, 0.3)


def remove_ramp(ph, dem=None):
    """Subtract a robustly fitted plane (and optionally a terrain-height term) from every pair.

    Each pair carries a large planar ramp (orbit, ionosphere, tides) that is
    unrelated to ground motion. The optional height term absorbs the stratified
    atmosphere, which makes high ground read differently from the valley.
    Cells far from the typical level (e.g. a subsiding bowl) are excluded from
    the fit so they are not fitted away.
    """
    t, h, w = ph.shape
    yy, xx = np.mgrid[0:h, 0:w]
    cols = [np.ones((h, w)), xx, yy]
    if dem is not None:
        cols.append((dem - np.nanmean(dem)) / 1000.0)
    basis = np.stack(cols, axis=-1)  # (h, w, k)
    out = np.empty_like(ph)
    for i in range(t):
        v = np.isfinite(ph[i])
        A = basis[v]
        y = ph[i][v]
        keep = np.ones(len(y), bool)
        for _ in range(5):
            c, *_ = np.linalg.lstsq(A[keep], y[keep], rcond=None)
            r = y - A @ c
            sigma = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
            keep = np.abs(r) < 2.5 * max(sigma, 1e-6)
        out[i] = ph[i] - basis @ c
    return out


def despike(ph, k, win=5):
    """Mask cells that differ from their local median by more than k robust sigmas.

    Catches isolated unwrapping errors and speckle without touching smooth signal.
    """
    t, h, w = ph.shape
    r = win // 2
    out = ph.copy()
    padded = np.pad(ph, ((0, 0), (r, r), (r, r)), constant_values=np.nan)
    for i in range(t):
        stack = np.stack([padded[i, dy:dy + h, dx:dx + w] for dy in range(win) for dx in range(win)])
        resid = ph[i] - np.nanmedian(stack, axis=0)
        v = resid[np.isfinite(resid)]
        sigma = 1.4826 * np.median(np.abs(v - np.median(v)))
        out[i] = np.where(np.abs(resid) > k * max(sigma, 1e-6), np.nan, ph[i])
    return out


def spread(ph, dem=None):
    """Robust noise level (rad) of one pair after ramp removal."""
    r = remove_ramp(ph[None], dem)[0]
    v = r[np.isfinite(r)]
    return 1.4826 * np.median(np.abs(v - np.median(v)))


def trimmed_mean(x, trim):
    """Per-pixel mean over axis 0 ignoring NaN and the `trim` fraction at each end."""
    n = np.isfinite(x).sum(axis=0)
    xs = np.sort(x, axis=0)  # NaN sorts last
    idx = np.arange(x.shape[0])[:, None, None]
    lo = np.floor(trim * n)
    keep = (idx >= lo) & (idx < n - lo)
    return np.where(n > 0, np.where(keep, xs, 0).sum(axis=0) / np.maximum(keep.sum(axis=0), 1), np.nan)


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
    p.add_argument("--iono", choices=["auto", "always", "never"], default="auto",
                   help="subtract the smoothed ionosphere screen: auto = per pair, only if it lowers the noise")
    p.add_argument("--iono-sigma", type=float, default=8, help="ionosphere smoothing (cells)")
    p.add_argument("--tropo", choices=["auto", "never"], default="auto",
                   help="subtract the wet-troposphere screen at terrain height, per pair, only if it clearly lowers the noise")
    p.add_argument("--min-gain", type=float, default=0.03, help="relative noise reduction needed to apply the troposphere correction")
    p.add_argument("--trend-smooth", type=float, default=4, help="extra smoothing of the trend/rate map (cells)")
    p.add_argument("--smooth", type=float, default=2, help="spatial Gaussian smoothing of the result (cells, 0 = off)")
    p.add_argument("--trim", type=float, default=0.15, help="share trimmed at each end when estimating the trend")
    p.add_argument("--label", help="name shown in the app (default: derived from track/direction/frame)")
    p.add_argument("--height-term", action="store_true", help="also fit a terrain-height term when removing the ramp (stratified atmosphere)")
    p.add_argument("--despike", type=float, default=5, help="mask cells > K robust sigmas from their 5x5 median (0 = off)")
    p.add_argument("--max-step-mm", type=float, default=100, help="mask any 12-day step larger than this (unwrapping errors; 0 = off)")
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

    dem_file = None
    dem = load_dem(aoi, a.res, cache) if (a.tropo != "never" or a.height_term) else None
    if a.tropo != "never":
        dem_file = str(cache / "dem_current.npy")
        np.save(dem_file, dem)
        log(f"terrain height {dem.min():.0f}-{dem.max():.0f} m (median {np.median(dem):.0f} m)")
    jobs = [(s, aoi, a.fine, str(cache), a.res, dem_file) for s in steps]
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=a.workers) as ex:
        for i, (name, status) in enumerate(ex.map(read_pair, jobs), 1):
            progress(i, len(jobs), t0, f"{status}  {name[-70:-40]}")
            if status.startswith("FAILED"):
                sys.exit("a read failed; rerun to resume from the cache")

    ph, co = zip(*(coarse_pair(s["name"], cache, f, a.min_coh, a.min_valid_frac) for s in steps))
    ph, co = np.stack(ph), np.stack(co)  # (T, H, W) radians / coherence

    ramp_dem = dem if a.height_term else None
    iono_used = []
    if a.iono != "never":
        for i, st in enumerate(steps):
            io = gaussian_blur(coarse_iono(st["name"], cache, f), a.iono_sigma)
            cand = ph[i] - io
            before, after = spread(ph[i], ramp_dem), spread(cand, ramp_dem)
            use = a.iono == "always" or after < before
            iono_used.append(bool(use))
            if use:
                ph[i] = cand
            log(f"iono {st['ref']}->{st['sec']}: noise {before:.2f} -> {after:.2f} rad, {'applied' if use else 'skipped'}")
    tropo_used = []
    if a.tropo != "never":
        for i, st in enumerate(steps):
            wet = np.load(cache / f"{st['name']}.wet.npz")["wet"]
            cand = ph[i] - wet
            before, after = spread(ph[i], ramp_dem), spread(cand, ramp_dem)
            use = after < before * (1 - a.min_gain)
            tropo_used.append(bool(use))
            if use:
                ph[i] = cand
            log(f"tropo {st['ref']}->{st['sec']}: noise {before:.2f} -> {after:.2f} rad, {'applied' if use else 'skipped'}")
    if not a.keep_ramp:
        ph = remove_ramp(ph, ramp_dem)
    if a.despike > 0:
        ph = despike(ph, a.despike)
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

    if a.max_step_mm > 0:  # a 12-day step this large is an unwrapping error, not ground motion
        inc_mm = np.where(np.abs(inc_mm) > a.max_step_mm, np.nan, inc_mm)
    inc_mm = np.stack([gaussian_blur(x, a.smooth, keep_mask=True) for x in inc_mm])  # spatial smoothing

    ok = np.isfinite(inc_mm).mean(axis=0) >= a.min_valid_frac
    med = np.nanmedian(np.where(np.isfinite(inc_mm), inc_mm, np.nan), axis=0)
    filled = np.where(np.isfinite(inc_mm), inc_mm, med)  # missing pair -> that cell's median step
    cum = np.concatenate([np.zeros((1,) + med.shape, "float32"), np.cumsum(filled, axis=0)])
    cum[:, ~ok] = np.nan

    # Robust linear trend: trimmed mean of per-pair rates (mm/yr), so a single bad pair cannot dominate.
    day = lambda d: datetime.strptime(d, "%Y%m%d")
    span_yr = np.array([(day(st["sec"]) - day(st["ref"])).days for st in steps]) / 365.25
    rate = gaussian_blur(trimmed_mean(inc_mm / span_yr[:, None, None], a.trim), a.trend_smooth, keep_mask=True)
    t_yr = np.array([0.0] + [(day(st["sec"]) - day(steps[0]["ref"])).days / 365.25 for st in steps])
    trend = (rate[None] * t_yr[:, None, None]).astype("float32")
    trend[:, ~ok] = np.nan

    pack = lambda arr: np.where(np.isfinite(arr), np.clip(np.round(arr / SCALE), -32767, 32767), NODATA).astype("<i2")
    q, qt = pack(cum), pack(trend)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "cube.bin").write_bytes(q.tobytes())
    (out / "trend.bin").write_bytes(qt.tobytes())

    dates = [steps[0]["ref"]] + [s["sec"] for s in steps]
    iso = lambda d: datetime.strptime(d, "%Y%m%d").strftime("%Y-%m-%d")
    meta = dict(
        bounds=list(aoi), width=q.shape[2], height=q.shape[1], resolution_deg=a.res,
        label=a.label or f"{'Ascending' if a.direction == 'A' else 'Descending'} track {a.track}, frame {a.frame}",
        steps=q.shape[0], dates=[iso(d) for d in dates], trend_file="trend.bin",
        rate_mm_per_year=dict(zip(["p5", "median", "p95"], [round(float(v), 1) for v in np.nanpercentile(rate[ok], [5, 50, 95])])),
        scale_mm=SCALE, nodata=NODATA, layout="int16 little-endian [step][row (north first)][col]",
        quantity="cumulative vertical displacement since first date, mm, positive = up",
        source=dict(track=a.track, direction=a.direction, frame=a.frame,
                    pairs=[dict(ref=iso(s["ref"]), sec=iso(s["sec"]), level=s["level"], granule=s["name"]) for s in steps]),
        processing=dict(
            wavelength_m=round(WAVELENGTH, 5), min_coherence=a.min_coh, min_valid_fraction=a.min_valid_frac,
            positive_phase_is_range_increase=bool(POSITIVE_PHASE_IS_RANGE_INCREASE),
            vertical_assumption="line-of-sight motion divided by cos(incidence angle)",
            ramp_removed=not a.keep_ramp,
            ionosphere_screen=dict(mode=a.iono, sigma_cells=a.iono_sigma, applied_pairs=sum(iono_used)),
            troposphere_wet_screen=dict(mode=a.tropo, min_gain=a.min_gain, applied_pairs=sum(tropo_used)),
            height_term=a.height_term, despike_sigma=a.despike, max_step_mm=a.max_step_mm,
            spatial_smoothing_cells=a.smooth, trend_smoothing_cells=a.trend_smooth, trend_trim=a.trim,
            not_applied=["hydrostatic troposphere", "solid earth tides"],
        ),
    )
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    final = cum[-1][ok]
    log(f"wrote {out}/cube.bin ({q.nbytes / 1e6:.1f} MB), valid cells {ok.mean() * 100:.0f}%")
    log(f"final cumulative mm: min {final.min():.0f}, p5 {np.percentile(final, 5):.0f}, "
        f"median {np.median(final):.0f}, p95 {np.percentile(final, 95):.0f}, max {final.max():.0f}")


if __name__ == "__main__":
    main()
