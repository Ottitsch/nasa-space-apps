#!/usr/bin/env python3
"""Sanity-check a displacement cube against places with well-known behaviour.

Subsiding sites should show clearly lower rates than stable sites. This is a
qualitative check, not a calibration: the coordinates below are approximate and
come from general knowledge of Central Valley subsidence, not from a dataset.

Usage: python3 scripts/check_known_sites.py web/public/data/subsidence/asc_034 [more folders]
"""
import sys

import numpy as np

from cube_utils import load, rate_map, within_km

SUBSIDING = [
    ("Corcoran area", -119.55, 36.10),
    ("Pixley / Tulare", -119.25, 35.95),
    ("Fresno / Madera", -120.10, 36.90),
]
STABLE = [
    ("Sierra foothills", -119.00, 36.70),
    ("Coast Range (west)", -120.50, 36.30),
]
RADIUS_KM = 15


def main(folders):
    for folder in folders:
        meta, cube, years = load(folder)
        rate = rate_map(cube, years)
        print(f"\n{meta['label']}  ({folder})")
        print(f"  AOI rate mm/yr: p5 {np.nanpercentile(rate, 5):.0f}, median {np.nanmedian(rate):.0f}, "
              f"p95 {np.nanpercentile(rate, 95):.0f}")
        means = {}
        for kind, sites in (("subsiding", SUBSIDING), ("stable", STABLE)):
            for name, lon, lat in sites:
                sel = within_km(meta, lon, lat, RADIUS_KM) & np.isfinite(rate)
                means[name] = np.mean(rate[sel]) if sel.any() else np.nan
                print(f"  {kind:9s} {name:20s} {means[name]:7.0f} mm/yr  ({sel.sum()} cells)")
        sub = np.nanmean([means[n] for n, *_ in SUBSIDING])
        stb = np.nanmean([means[n] for n, *_ in STABLE])
        verdict = "OK (subsiding sites lower)" if sub < stb - 30 else "NOT CLEAR"
        print(f"  subsiding mean {sub:.0f} vs stable mean {stb:.0f} -> difference {sub - stb:.0f} mm/yr: {verdict}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
