"""Land cover on the stack grid, from ESA WorldCover 2021 (10 m, public on AWS).

Radar phase over wetlands follows the water level, and over forest and crops it
follows moisture. Neither is the ground moving. We keep the analysis on land
cover where a phase change means the ground itself went up or down.
"""
from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np

BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
TREES, SHRUB, GRASS, CROP, BUILT, BARE, SNOW, WATER, WETLAND, MANGROVE, MOSS = \
    10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100
SOLID_GROUND = (SHRUB, GRASS, CROP, BUILT, BARE)


def _tile_url(lat3: int, lon3: int) -> str:
    ns = f"{'N' if lat3 >= 0 else 'S'}{abs(lat3):02d}"
    ew = f"{'E' if lon3 >= 0 else 'W'}{abs(lon3):03d}"
    return f"{BASE}/ESA_WorldCover_10m_2021_v200_{ns}{ew}_Map.tif"


def landcover_on_grid(grid, cache_dir, key) -> np.ndarray:
    """WorldCover class at every pixel of a UTM grid (0 where there is no data).
    The result is cached under cache_dir/landcover/<key>.npy."""
    import rasterio
    from pyproj import Transformer
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    path = Path(cache_dir) / "landcover" / f"{key}.npy"
    nx, ny = grid["nx"], grid["ny"]
    if path.exists():
        a = np.load(path)
        if a.shape == (ny, nx):
            return a
    x = grid["x0"] + 80.0 * np.arange(nx)
    y = grid["y0"] - 80.0 * np.arange(ny)
    X, Y = np.meshgrid(x, y)
    lon, lat = Transformer.from_crs(grid["epsg"], 4326, always_xy=True).transform(X, Y)
    out = np.zeros((ny, nx), np.uint8)
    ca = os.environ.get("CURL_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
               GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="2")
    if ca:
        env["CURL_CA_BUNDLE"] = ca
    step = 0.0007   # degrees, a little finer than the 80 m grid
    with rasterio.Env(**env):
        for la in range(math.floor(lat.min() / 3) * 3, math.floor(lat.max() / 3) * 3 + 1, 3):
            for lo in range(math.floor(lon.min() / 3) * 3, math.floor(lon.max() / 3) * 3 + 1, 3):
                m = (lat >= la) & (lat < la + 3) & (lon >= lo) & (lon < lo + 3)
                if not m.any():
                    continue
                w, e = lon[m].min() - step, lon[m].max() + step
                s, n = lat[m].min() - step, lat[m].max() + step
                try:
                    with rasterio.open(_tile_url(la, lo)) as ds:
                        win = from_bounds(w, s, e, n, ds.transform)
                        cols = max(2, int(round((e - w) / step)))
                        rows = max(2, int(round((n - s) / step)))
                        a = ds.read(1, window=win, out_shape=(rows, cols), boundless=True,
                                    fill_value=0, resampling=Resampling.nearest)
                except rasterio.errors.RasterioIOError:
                    continue      # open ocean: no tile
                ci = np.clip(((lon[m] - w) / (e - w) * cols).astype(int), 0, cols - 1)
                ri = np.clip(((n - lat[m]) / (n - s) * rows).astype(int), 0, rows - 1)
                out[m] = a[ri, ci]
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, out)
    return out
