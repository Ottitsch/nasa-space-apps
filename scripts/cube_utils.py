"""Shared helpers for reading the displacement cubes written by build_subsidence.py."""
import json
from datetime import date
from pathlib import Path

import numpy as np


def load(folder, name="cube.bin"):
    """Return (meta, array[step, row, col] in mm with NaN for no-data, years since first date)."""
    folder = Path(folder)
    meta = json.loads((folder / "meta.json").read_text())
    raw = np.fromfile(folder / name, "<i2").reshape(meta["steps"], meta["height"], meta["width"]).astype("float32")
    raw[raw == meta["nodata"]] = np.nan
    d = [date.fromisoformat(x) for x in meta["dates"]]
    years = np.array([(x - d[0]).days for x in d]) / 365.25
    return meta, raw * meta["scale_mm"], years


def cell_grid(meta):
    """Longitude / latitude of every cell centre."""
    w, s, e, n = meta["bounds"]
    res = meta["resolution_deg"]
    xs = w + (np.arange(meta["width"]) + 0.5) * res
    ys = n - (np.arange(meta["height"]) + 0.5) * res
    return np.meshgrid(xs, ys)


def within_km(meta, lon, lat, radius_km):
    X, Y = cell_grid(meta)
    return np.hypot((X - lon) * 111.32 * np.cos(np.radians(lat)), (Y - lat) * 110.57) <= radius_km


def rate_map(cube, years):
    """Per-cell least-squares slope in mm/yr (NaN where fewer than 10 samples)."""
    t = years - years.mean()
    ok = np.isfinite(cube)
    n = ok.sum(axis=0)
    mean = np.where(n > 0, np.nansum(cube, axis=0) / np.maximum(n, 1), np.nan)
    num = np.nansum(np.where(ok, (cube - mean) * t[:, None, None], 0), axis=0)
    den = np.where(ok, t[:, None, None] ** 2, 0).sum(axis=0)
    return np.where(n >= 10, num / np.maximum(den, 1e-9), np.nan)
