#!/usr/bin/env python3
"""Compare the ascending and descending cubes, build a combined cube, write manifest.json.

Both cubes must share the same grid (same --aoi/--res in build_subsidence.py).
Each cell's time series is interpolated to common dates and averaged where both
tracks are valid, weighting each track by 1/noise^2 so the noisier one counts less.

Usage: python3 scripts/combine_tracks.py [folder]   (default: web/public/data/subsidence)
"""
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from build_subsidence import gaussian_blur
from cube_utils import load, rate_map

SCALE, NODATA = 0.1, -32768


def interp(cube, years, target):
    """Linear interpolation of each cell's series to `target` years (NaN if either neighbour is NaN)."""
    out = np.full((len(target),) + cube.shape[1:], np.nan, "float32")
    for k, t in enumerate(target):
        j = int(np.clip(np.searchsorted(years, t) - 1, 0, len(years) - 2))
        f = (t - years[j]) / (years[j + 1] - years[j])
        out[k] = (1 - f) * cube[j] + f * cube[j + 1]
    return out


def noise_level(rate):
    """Robust small-scale noise of a rate map (mm/yr): what is left after removing its smooth part."""
    hp = rate - gaussian_blur(rate, 3)
    v = hp[np.isfinite(hp)]
    return 1.4826 * np.median(np.abs(v - np.median(v)))


def wmean(a, b, wa, wb):
    """Inverse-variance weighted mean; falls back to whichever input is valid."""
    num = np.nansum([a * wa, b * wb], axis=0)
    den = np.nansum([np.where(np.isfinite(a), wa, np.nan), np.where(np.isfinite(b), wb, np.nan)], axis=0)
    return np.where(den > 0, num / np.where(den > 0, den, 1), np.nan)


def pack(a):
    return np.where(np.isfinite(a), np.clip(np.round(a / SCALE), -32767, 32767), NODATA).astype("<i2")


def main(root):
    root = Path(root)
    ma, ca, ya = load(root / "asc_034")
    md, cd, yd = load(root / "desc_114")
    ta, td = np.array(ma["dates"]), np.array(md["dates"])
    ra, rd = rate_map(ca, ya), rate_map(cd, yd)

    na, nd = noise_level(ra), noise_level(rd)
    wa, wd = 1 / na**2, 1 / nd**2
    print(f"noise ascending {na:.0f}, descending {nd:.0f} mm/yr -> weights {wa / (wa + wd):.2f} / {wd / (wa + wd):.2f}")
    both = np.isfinite(ra) & np.isfinite(rd)
    corr = np.corrcoef(ra[both], rd[both])[0, 1]
    print(f"rate agreement ascending vs descending: {both.sum()} shared cells, correlation {corr:.2f}, "
          f"median difference {np.median(ra[both] - rd[both]):.0f} mm/yr")

    # common dates: every 12 days across the overlap of both tracks
    d0 = max(date.fromisoformat(ta[0]), date.fromisoformat(td[0]))
    d1 = min(date.fromisoformat(ta[-1]), date.fromisoformat(td[-1]))
    dates = [d0 + timedelta(days=12 * i) for i in range((d1 - d0).days // 12 + 1)]
    abs_a = np.array([(date.fromisoformat(x) - d0).days for x in ta]) / 365.25
    abs_d = np.array([(date.fromisoformat(x) - d0).days for x in td]) / 365.25
    tgt = np.array([(x - d0).days for x in dates]) / 365.25

    ia, id_ = interp(ca, abs_a, tgt), interp(cd, abs_d, tgt)
    # restart both at the first common date so they are comparable
    ia, id_ = ia - ia[0], id_ - id_[0]
    comb = wmean(ia, id_, wa, wd)
    comb[:, ~(np.isfinite(ia[-1]) | np.isfinite(id_[-1]))] = np.nan

    # combined trend: average of the two tracks' trend cubes at the common dates
    _, ta_c, ya_t = load(root / "asc_034", "trend.bin")
    _, td_c, yd_t = load(root / "desc_114", "trend.bin")
    ra_t, rd_t = ta_c[-1] / ya_t[-1], td_c[-1] / yd_t[-1]  # mm/yr
    trate = wmean(ra_t, rd_t, wa, wd)
    trend = (trate[None] * tgt[:, None, None]).astype("float32")
    trend[:, ~np.isfinite(trate)] = np.nan

    out = root / "combined"
    out.mkdir(exist_ok=True)
    (out / "cube.bin").write_bytes(pack(comb).tobytes())
    (out / "trend.bin").write_bytes(pack(trend).tobytes())
    meta = dict(ma)
    meta.update(
        label="Combined ascending + descending",
        steps=len(dates), dates=[x.isoformat() for x in dates],
        rate_mm_per_year=dict(zip(["p5", "median", "p95"], [round(float(v), 1) for v in np.nanpercentile(trate, [5, 50, 95])])),
        source=dict(track="034A + 114D", direction="A+D", frame="020 + 070",
                    pairs=ma["source"]["pairs"] + md["source"]["pairs"]),
        combination=dict(rate_correlation=round(float(corr), 3), method="inverse-variance weighted mean of both tracks at common 12-day dates",
                         weights=dict(ascending=round(float(wa / (wa + wd)), 3), descending=round(float(wd / (wa + wd)), 3))),
    )
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"combined cube: {len(dates)} dates {dates[0]} -> {dates[-1]}")

    entries = []
    for pid in ("combined", "asc_034", "desc_114"):
        m = json.loads((root / pid / "meta.json").read_text())
        entries.append(dict(id=pid, label=m["label"], path=f"/data/subsidence/{pid}"))
    (root / "manifest.json").write_text(json.dumps(entries, indent=1))
    print("wrote manifest.json")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "web/public/data/subsidence")
