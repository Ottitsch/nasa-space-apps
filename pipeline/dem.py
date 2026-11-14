"""Elevation on the stack grid, from the Copernicus GLO-90 DEM (public on AWS).

Used for two things: removing weather effects that follow topography, and
keeping the sinking detector on gently sloping ground where compaction
actually happens.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import requests
from scipy import ndimage as ndi

BASE = "https://copernicus-dem-90m.s3.amazonaws.com"


def _tile(lat: int, lon: int, cache: Path):
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"
    name = f"Copernicus_DSM_COG_30_{ns}_{ew}_DEM"
    path = cache / f"{name}.tif"
    missing = cache / f"{name}.missing"
    if missing.exists():
        return None
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        r = requests.get(f"{BASE}/{name}/{name}.tif", timeout=120)
        if r.status_code in (403, 404):   # open ocean: no tile
            missing.touch()
            return None
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.rename(path)
    return path


def dem_on_grid(grid, cache_dir) -> np.ndarray:
    """Bilinear sample of the DEM at every pixel of a UTM grid (metres)."""
    import rasterio
    from pyproj import Transformer

    nx, ny = grid["nx"], grid["ny"]
    x = grid["x0"] + 80.0 * np.arange(nx)
    y = grid["y0"] - 80.0 * np.arange(ny)
    X, Y = np.meshgrid(x, y)
    lon, lat = Transformer.from_crs(grid["epsg"], 4326, always_xy=True).transform(X, Y)
    out = np.zeros((ny, nx), np.float32)
    cache = Path(cache_dir) / "dem"
    for la in range(math.floor(lat.min()), math.floor(lat.max()) + 1):
        for lo in range(math.floor(lon.min()), math.floor(lon.max()) + 1):
            m = (np.floor(lat) == la) & (np.floor(lon) == lo)
            if not m.any():
                continue
            p = _tile(la, lo, cache)
            if p is None:
                continue
            with rasterio.open(p) as ds:
                a = ds.read(1)
                inv = ~ds.transform
                col, row = inv * (lon[m], lat[m])
            out[m] = ndi.map_coordinates(a, [row - 0.5, col - 0.5], order=1, mode="nearest")
    return out


def slope_degrees(dem, posting=80.0):
    gy, gx = np.gradient(ndi.gaussian_filter(dem, 1.0), posting)
    return np.degrees(np.arctan(np.hypot(gx, gy)))
