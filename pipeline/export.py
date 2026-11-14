"""Put processed stacks on a Web Mercator grid and write compact files for the map.

Per place the web app gets two gzip files of raw little endian arrays:

  core.bin.gz    rate   int16   (H, W)     sinking rate, mm per year (negative = sinking)
                 beta   uint16  (H, W)     angular distortion rate, 1e-6 per year
                 flags  uint8   (H, W)     bit 0 valid, bit 1 significant sinking,
                                           bit 2 built up land (ESA WorldCover)
  frames.bin.gz  resid  int16   (N, h, w)  measured motion at each date minus the
                                           straight line rate * time, in mm, at
                                           quarter resolution (h = H // 4, w = W // 4)

The measured cumulative motion at date k is  rate * t_k + resid_k  (t in years
since the first date). Storing only the departure from the straight line keeps
the files small: the line is sharp and lives in core, the wiggle around it
(seasons, pauses, accelerations) is smooth and compresses well.

Missing values are -32768. Everything else the app needs is in data/index.json.
"""
from __future__ import annotations

import gzip
import math

import numpy as np
from scipy import ndimage as ndi

R = 6378137.0
NODATA = -32768


def merc_x(lon):
    return R * math.radians(lon)


def merc_y(lat):
    return R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def mercator_grid(bbox, lat0, ground_m=80.0):
    """Grid whose pixels are ground_m wide on the ground at latitude lat0."""
    w, s, e, n = bbox
    px = ground_m / math.cos(math.radians(lat0))
    x0, x1, y0, y1 = merc_x(w), merc_x(e), merc_y(s), merc_y(n)
    W = int(round((x1 - x0) / px)) // 4 * 4
    H = int(round((y1 - y0) / px)) // 4 * 4
    return dict(x0=x0, y1=y1, px=px, W=W, H=H)


def grid_bounds(mg):
    """(west, south, east, north) in degrees of the grid's outer edge."""
    def lon(x):
        return math.degrees(x / R)

    def lat(y):
        return math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)
    return [lon(mg["x0"]), lat(mg["y1"] - mg["H"] * mg["px"]),
            lon(mg["x0"] + mg["W"] * mg["px"]), lat(mg["y1"])]


class Warper:
    """Resample arrays from a stack's UTM grid onto the Mercator grid."""

    def __init__(self, grid, mg):
        from pyproj import Transformer

        xs = mg["x0"] + (np.arange(mg["W"]) + 0.5) * mg["px"]
        ys = mg["y1"] - (np.arange(mg["H"]) + 0.5) * mg["px"]
        X, Y = np.meshgrid(xs, ys)
        ux, uy = Transformer.from_crs(3857, grid["epsg"], always_xy=True).transform(X, Y)
        self.col = (ux - grid["x0"]) / 80.0
        self.row = (grid["y0"] - uy) / 80.0

    def __call__(self, a, order=1):
        if a.dtype == bool:
            out = ndi.map_coordinates(a.astype(np.uint8), [self.row, self.col], order=0,
                                      mode="constant", cval=0)
            return out.astype(bool)
        return ndi.map_coordinates(a.astype(np.float32), [self.row, self.col], order=order,
                                   mode="constant", cval=np.nan)


def shrink(a, f=4):
    """f x f block mean ignoring missing values. a: (..., H, W), H and W multiples of f."""
    import warnings

    H, W = a.shape[-2:]
    b = a.reshape(a.shape[:-2] + (H // f, f, W // f, f))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(b, axis=(-3, -1))


def to_i16(a, scale):
    out = np.round(np.nan_to_num(a, nan=0.0) * scale)
    out = np.clip(out, -32767, 32767).astype("<i2")
    out[~np.isfinite(a)] = NODATA
    return out


def write_place(outdir, velocity, beta_rate, valid, significant, built, cum, t):
    """velocity m/yr, beta_rate 1/yr, built = built up land (bool), cum metres
    (N, H, W), t years since the first date. Returns file sizes in bytes."""
    outdir.mkdir(parents=True, exist_ok=True)
    rate = to_i16(np.where(valid, velocity, np.nan), 1000.0)
    beta = np.clip(np.round(beta_rate * 1e6), 0, 65535).astype("<u2")
    flags = (valid.astype(np.uint8) | (significant.astype(np.uint8) << 1)
             | (built.astype(np.uint8) << 2))
    core = rate.tobytes() + beta.tobytes() + flags.tobytes()
    # departure from the straight line, using the rate exactly as the app will read it
    line = (rate.astype(np.float32) / 1000.0)[None] * np.asarray(t, np.float32)[:, None, None]
    resid = np.where(valid[None], cum - line, np.nan)
    frames = to_i16(shrink(resid, 4), 1000.0)
    sizes = {}
    for name, blob in (("core.bin.gz", core), ("frames.bin.gz", frames.tobytes())):
        data = gzip.compress(blob, compresslevel=9, mtime=0)
        (outdir / name).write_bytes(data)
        sizes[name] = len(data)
    return sizes
