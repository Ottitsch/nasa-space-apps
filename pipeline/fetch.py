"""Read only the window we need out of each remote NISAR GUNW file.

A GUNW file is about 2 GB, but it is a chunked HDF5 file served over HTTPS.
We open it remotely, ask HDF5 where the chunks covering a city live, download
exactly those byte ranges in parallel, and decode them. That is 10 to 30 MB
and a few seconds per file instead of the whole thing.

Authentication: the files need an Earthdata Login bearer token. Either set
EARTHDATA_TOKEN in the environment, or run somewhere that injects the header
for nisar.asf.earthdatacloud.nasa.gov (the hosted Claude environment does).
"""
from __future__ import annotations

import io
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

UNW = "science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram"
CUBE = "science/LSAR/GUNW/metadata/radarGrid"
POSTING = 80.0  # metres, unwrapped interferogram grid
BLOCK = 1 << 20


class RangeFile(io.RawIOBase):
    """Minimal read only file object over HTTP range requests.

    The data host redirects every request to a short lived signed URL. We
    resolve that once and talk to the signed URL directly afterwards, which
    removes a slow extra round trip from every read.
    """

    def __init__(self, url):
        self.url = url
        self.session = requests.Session()
        self.pos = 0
        self.blocks: dict[int, bytes] = {}
        self.extents: list[tuple[int, int, bytes]] = []
        self.signed = None
        self.size = None
        self.requests_made = 0
        self.bytes_fetched = 0
        self._resolve()

    def _resolve(self):
        headers = {"Range": "bytes=0-0"}
        token = os.environ.get("EARTHDATA_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        r = self.session.get(self.url, headers=headers, allow_redirects=False, timeout=60)
        if r.status_code in (301, 302, 303, 307, 308):
            self.signed = r.headers["Location"]
            r = self.session.get(self.signed, headers={"Range": "bytes=0-0"}, timeout=60)
        else:
            self.signed = self.url
        if r.status_code == 401 or "urs.earthdata.nasa.gov" in (self.signed or ""):
            raise PermissionError(
                "Earthdata Login rejected the request. Set EARTHDATA_TOKEN to a valid "
                "token from https://urs.earthdata.nasa.gov (Generate Token).")
        r.raise_for_status()
        self.size = int(r.headers["Content-Range"].split("/")[1])

    def _get(self, start, end):
        """Fetch bytes [start, end)."""
        for attempt in range(5):
            try:
                r = self.session.get(self.signed, headers={"Range": f"bytes={start}-{end - 1}"},
                                     timeout=120)
                if r.status_code in (401, 403):  # signed URL expired
                    self._resolve()
                    continue
                r.raise_for_status()
                self.requests_made += 1
                self.bytes_fetched += len(r.content)
                return r.content
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))
        raise IOError("range request failed")

    def prefetch(self, ranges, threads=8, gap=256 * 1024):
        """Download many byte ranges at once (merging near neighbours)."""
        ranges = sorted((int(a), int(b)) for a, b in ranges if b > a)
        merged = []
        for a, b in ranges:
            if merged and a - merged[-1][1] <= gap:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        with ThreadPoolExecutor(threads) as ex:
            for (a, b), data in zip(merged, ex.map(lambda ab: self._get(*ab), merged)):
                self.extents.append((a, b, data))

    # file protocol used by h5py
    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else (self.pos + offset if whence == 1 else self.size + offset)
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        start, end = self.pos, self.pos + n
        for a, e, data in self.extents:
            if a <= start and end <= e:
                b[:n] = data[start - a:end - a]
                self.pos = end
                return n
        out = bytearray()
        for blk in range(start // BLOCK, (end - 1) // BLOCK + 1):
            if blk not in self.blocks:
                self.blocks[blk] = self._get(blk * BLOCK, min((blk + 1) * BLOCK, self.size))
            out += self.blocks[blk]
        off = start - (start // BLOCK) * BLOCK
        b[:n] = out[off:off + n]
        self.pos = end
        return n


def utm_window(bbox, epsg):
    """Bounds (xmin, ymin, xmax, ymax) of a lon/lat box in the product's UTM zone."""
    from pyproj import Transformer

    w, s, e, n = bbox
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    xs, ys = tr.transform([w, e, w, e, (w + e) / 2, (w + e) / 2],
                          [s, s, n, n, s, n])
    return min(xs), min(ys), max(xs), max(ys)


def _chunk_ranges(dset, sel):
    """Byte ranges of every stored chunk a selection touches."""
    chunks = dset.chunks
    if chunks is None:
        return []
    idx = [range((s.start // c) * c, s.stop, c) for s, c in zip(sel, chunks)]
    out = []
    import itertools

    for coord in itertools.product(*idx):
        try:
            info = dset.id.get_chunk_info_by_coord(coord)
        except Exception:
            continue
        if info.byte_offset is not None and info.size:
            out.append((info.byte_offset, info.byte_offset + info.size))
    return out


def read_subset(url, bbox, grid=None, geometry=True):
    """Read one interferogram over the box.

    grid: optional dict(epsg, x0, y0, nx, ny) defining the target pixel grid
    (x0, y0 = centre of the top left pixel). If None it is derived from the box
    and returned so later files of the same stack line up exactly.
    geometry: also read the incidence angle and line of sight vectors.
    """
    import h5py

    rf = RangeFile(url)
    # the first few MB hold most of the file's metadata: grab them in one go
    rf.prefetch([(0, min(rf.size, 8 * BLOCK))])
    h = h5py.File(rf, "r")
    g = h[UNW]
    pol = [k for k in g.keys() if k in ("HH", "VV", "HV", "VH")][0]
    epsg = int(g["projection"][()])
    x = g[f"{pol}/xCoordinates"][:]
    y = g[f"{pol}/yCoordinates"][:]
    dx = float(x[1] - x[0])
    dy = float(y[1] - y[0])  # negative: north up
    assert abs(dx - POSTING) < 1e-6 and abs(dy + POSTING) < 1e-6, (dx, dy)

    if grid is None:
        xmin, ymin, xmax, ymax = utm_window(bbox, epsg)
        i0 = int(np.floor((xmin - x[0]) / dx))
        j0 = int(np.floor((y[0] - ymax) / POSTING))
        nx = int(np.ceil((xmax - xmin) / POSTING)) + 1
        ny = int(np.ceil((ymax - ymin) / POSTING)) + 1
        grid = dict(epsg=epsg, x0=float(x[0] + i0 * dx), y0=float(y[0] - j0 * POSTING),
                    nx=nx, ny=ny)
    if epsg != grid["epsg"]:
        raise ValueError(f"UTM zone changed within stack: {epsg} vs {grid['epsg']}")

    nx, ny = grid["nx"], grid["ny"]
    oi = (grid["x0"] - x[0]) / dx
    oj = (y[0] - grid["y0"]) / POSTING
    if abs(oi - round(oi)) > 0.01 or abs(oj - round(oj)) > 0.01:
        raise ValueError(f"grid not aligned: offsets {oi}, {oj}")
    oi, oj = int(round(oi)), int(round(oj))
    si0, si1 = max(oi, 0), min(oi + nx, len(x))
    sj0, sj1 = max(oj, 0), min(oj + ny, len(y))
    inside = si1 > si0 and sj1 > sj0

    names = [f"{pol}/unwrappedPhase", f"{pol}/coherenceMagnitude",
             f"{pol}/connectedComponents", f"{pol}/ionospherePhaseScreen", "mask"]
    wanted = []
    if inside:
        for name in names:
            wanted += _chunk_ranges(g[name], (slice(sj0, sj1), slice(si0, si1)))

    cube_sel = None
    c = h[CUBE]
    if geometry:
        cx, cy, ch = c["xCoordinates"][:], c["yCoordinates"][:], c["heightAboveEllipsoid"][:]
        xa, xb = grid["x0"], grid["x0"] + (nx - 1) * POSTING
        ya, yb = grid["y0"] - (ny - 1) * POSTING, grid["y0"]
        ci = np.where((cx >= xa - 1000) & (cx <= xb + 1000))[0]
        cj = np.where((cy >= ya - 1000) & (cy <= yb + 1000))[0]
        k = int(np.argmin(np.abs(ch - 500.0)))  # one height layer is plenty
        if len(ci) and len(cj):
            cube_sel = (slice(k, k + 1), slice(int(cj[0]), int(cj[-1]) + 1),
                        slice(int(ci[0]), int(ci[-1]) + 1))
            for name in ("incidenceAngle", "losUnitVectorX", "losUnitVectorY"):
                wanted += _chunk_ranges(c[name], cube_sel)
    rf.prefetch(wanted)

    def window(name, fill, dtype):
        out = np.full((ny, nx), fill, dtype=dtype)
        if inside:
            out[sj0 - oj:sj1 - oj, si0 - oi:si1 - oi] = g[name][sj0:sj1, si0:si1]
        return out

    unw = window(names[0], np.nan, np.float32)
    coh = window(names[1], np.nan, np.float32)
    cc = window(names[2], 0, np.uint16)
    cc[cc == 65535] = 0
    iono = window(names[3], np.nan, np.float32)
    mask = window("mask", 255, np.uint32)
    low = (mask & 0xFF).astype(np.uint8)
    water = (low // 100) == 1
    bad = (low == 255) | ((low // 10) % 10 == 0) | (low % 10 == 0)

    geom = {}
    if cube_sel is not None:
        inc = c["incidenceAngle"][cube_sel]
        ex = c["losUnitVectorX"][cube_sel]
        ny_ = c["losUnitVectorY"][cube_sel]
        geom = dict(incidence=float(np.nanmean(inc)), los_east=float(np.nanmean(ex)),
                    los_north=float(np.nanmean(ny_)))

    ident = h["science/LSAR/identification"]

    def s(k):
        v = ident[k][()]
        return v.decode() if isinstance(v, bytes) else v

    meta = dict(
        wavelength=299792458.0 / float(h["science/LSAR/GUNW/grids/frequencyA/centerFrequency"][()]),
        look=s("lookDirection"), direction=s("orbitPassDirection"),
        ref_time=s("referenceZeroDopplerStartTime"), sec_time=s("secondaryZeroDopplerStartTime"),
        product_version=s("productVersion"), pol=pol, **geom,
    )
    h.close()
    stats = dict(requests=rf.requests_made, mb=rf.bytes_fetched / 1e6)
    return dict(grid=grid, unw=unw, coh=coh, cc=cc, iono=iono, water=water, bad=bad,
                meta=meta, stats=stats)


def fetch_to_cache(args):
    """Worker: read one granule window and store it as a compressed npz."""
    url, bbox, grid, path, geometry = args
    path = Path(path)
    if path.exists():
        return str(path), 0.0, None
    t = time.time()
    err = None
    for attempt in range(3):
        try:
            d = read_subset(url, bbox, grid, geometry)
            break
        except PermissionError as e:
            return str(path), time.time() - t, str(e)
        except Exception as e:  # network hiccups: retry with backoff
            err = f"{type(e).__name__}: {e}"
            time.sleep(5 * (attempt + 1))
    else:
        return str(path), time.time() - t, err
    flat = dict(unw=d["unw"], coh=d["coh"], cc=d["cc"], iono=d["iono"],
                water=d["water"], bad=d["bad"])
    for k, v in d["meta"].items():
        flat["meta_" + k] = np.array(v)
    for k, v in d["grid"].items():
        flat["grid_" + k] = np.array(v)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp.npz")
    np.savez_compressed(tmp, **flat)
    tmp.rename(path)
    return str(path), time.time() - t, None


def load_cached(path):
    z = np.load(path)
    d = {k: z[k] for k in ("unw", "coh", "cc", "iono", "water", "bad")}
    d["meta"] = {k[5:]: z[k].item() for k in z.files if k.startswith("meta_")}
    d["grid"] = {k[5:]: z[k].item() for k in z.files if k.startswith("grid_")}
    return d
