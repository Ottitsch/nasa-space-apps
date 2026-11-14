// Loading and reading the per place grids written by pipeline/export.py.

import { LIMITS, YEAR } from './config.js';

const NODATA = -32768;
const R = 6378137;
const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

/** Fetch a file that may or may not already have been gunzipped by the server. */
async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  const u = new Uint8Array(buf, 0, 2);
  if (u[0] === 0x1f && u[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return buf;
}

export async function loadIndex() {
  const r = await fetch('data/index.json');
  if (!r.ok) throw new Error('could not load data/index.json');
  const index = await r.json();
  for (const p of index.places) {
    p.t0 = Date.parse(p.dates[0] + 'T00:00:00Z');
    p.t1 = Date.parse(p.dates[p.dates.length - 1] + 'T00:00:00Z');
    p.span = p.t_years[p.t_years.length - 1];
    p.months = Math.max(1, Math.round(p.span * 12));
    p.early = p.span < 0.7;                         // under about eight months of passes
    // a place counts as sinking when at least 1 km2 is detected; smaller
    // patches still show on the map but do not make the headline
    p.detected = p.sinking_area_km2 >= 1 && Array.isArray(p.hot_series_mm);
    // mean rate of the fastest sinking zone, mm per year (negative)
    p.hotRate = p.detected ? p.hot_series_mm[p.hot_series_mm.length - 1] / p.span : 0;
  }
  return index;
}

/** Sinking (mm, positive) of a place's fastest zone at a moment in time. */
export function hotSunk(p, ms) {
  if (!p.detected || ms <= p.t0) return 0;
  const y = (ms - p.t0) / YEAR;
  const t = p.t_years, s = p.hot_series_mm;
  if (y >= p.span) return -(s[s.length - 1] + p.hotRate * (y - p.span));
  let k = 0;
  while (k < t.length - 2 && y > t[k + 1]) k++;
  const w = (y - t[k]) / (t[k + 1] - t[k]);
  return -((1 - w) * s[k] + w * s[k + 1]);
}

export class PlaceData {
  constructor(meta, core) {
    this.meta = meta;
    const W = (this.W = meta.width), H = (this.H = meta.height), n = (this.n = W * H);
    this.rate = new Int16Array(core, 0, n);        // mm per year, negative = sinking
    this.beta = new Uint16Array(core, 2 * n, n);   // angular distortion rate, 1e-6 per year
    this.flags = new Uint8Array(core, 4 * n, n);   // bit 0 valid, bit 1 significant, bit 2 built up
    const [w, s, e, nn] = meta.bounds;
    this.west = w; this.east = e;
    this.yN = mercY(nn); this.yS = mercY(s);
    this.pixelKm2 = 0.0064;                        // 80 m pixels on the ground
    this.frames = null;
    this._cache = new Map();
    this._firstRate = new Map();
    this._buildAlpha();
    this._findHot();
  }

  /** How strongly to draw each pixel: full inside detected sinking, soft at the rim. */
  _buildAlpha() {
    const { W, H, n, flags, rate } = this;
    const thr = this.meta.threshold_mm_yr;
    const a = (this.alpha = new Uint8Array(n));
    for (let i = 0; i < n; i++) if (flags[i] & 2) a[i] = 255;
    // two rings of neighbours fade out with their own rate
    for (let pass = 0; pass < 2; pass++) {
      const add = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
          if (a[i] || !(flags[i] & 1)) continue;
          if (a[i - 1] || a[i + 1] || a[i - W] || a[i + W]) {
            const f = Math.max(0, Math.min(1, (-rate[i] - 0.4 * thr) / (0.6 * thr)));
            if (f > 0) add.push(i, Math.round(f * (pass ? 140 : 210)));
          }
        }
      }
      for (let k = 0; k < add.length; k += 2) a[add[k]] = add[k + 1];
    }
  }

  /** Centre of the fastest sinking patch (7 x 7 pixel mean). */
  _findHot() {
    const { W, H, flags, rate } = this;
    let best = 0, bi = -1;
    for (let y = 3; y < H - 3; y += 2) {
      for (let x = 3; x < W - 3; x += 2) {
        const i = y * W + x;
        if (!(flags[i] & 2)) continue;
        let sum = 0, cnt = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const j = i + dy * W + dx;
            if (flags[j] & 1) { sum += rate[j]; cnt++; }
          }
        }
        if (cnt > 30 && sum / cnt < best) { best = sum / cnt; bi = i; }
      }
    }
    this.hot = bi < 0 ? null : this.lngLat(bi % W, Math.floor(bi / W));
  }

  lngLat(x, y) {
    const lng = this.west + ((x + 0.5) / this.W) * (this.east - this.west);
    const my = this.yN - ((y + 0.5) / this.H) * (this.yN - this.yS);
    const lat = (Math.atan(Math.exp(my / R)) * 360) / Math.PI - 90;
    return [lng, lat];
  }

  /** Grid index under a point, or -1 outside the data. */
  index(lng, lat) {
    const x = Math.floor(((lng - this.west) / (this.east - this.west)) * this.W);
    const y = Math.floor(((this.yN - mercY(lat)) / (this.yN - this.yS)) * this.H);
    return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : y * this.W + x;
  }

  years(ms) { return (ms - this.meta.t0) / YEAR; }

  setFrames(buf) {
    const w = this.W / 4, h = this.H / 4;
    const N = this.meta.dates.length;
    const a = new Int16Array(buf);
    if (a.length !== N * w * h) throw new Error('frames file does not match the index');
    this.frames = { w, h, N, data: a };
    this._cache.clear();
  }

  /** Measured wiggle around the straight line at date k, upsampled to full size (mm). */
  resid(k) {
    let r = this._cache.get(k);
    if (r) return r;
    const { W, H } = this, { w, h, data } = this.frames;
    r = new Float32Array(W * H);
    const off = k * w * h;
    const xi = new Int32Array(W), xw = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / 4 - 0.5));
      xi[x] = Math.min(w - 2, Math.floor(fx)); xw[x] = fx - xi[x];
    }
    for (let y = 0; y < H; y++) {
      const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / 4 - 0.5));
      const y0 = Math.min(h - 2, Math.floor(fy)), wy = fy - y0;
      const r0 = off + y0 * w, r1 = r0 + w;
      for (let x = 0; x < W; x++) {
        const i = xi[x], wx = xw[x];
        let a = data[r0 + i], b = data[r0 + i + 1], c = data[r1 + i], d = data[r1 + i + 1];
        if (a === NODATA) a = 0; if (b === NODATA) b = 0; if (c === NODATA) c = 0; if (d === NODATA) d = 0;
        r[y * W + x] = (1 - wy) * ((1 - wx) * a + wx * b) + wy * ((1 - wx) * c + wx * d);
      }
    }
    if (this._cache.size >= 4) this._cache.delete(this._cache.keys().next().value);
    this._cache.set(k, r);
    return r;
  }

  /**
   * What is needed to evaluate sinking at `y` years after the first pass:
   * sunk(i) = -(rate[i] * y + (1 - w) * a[i] + w * b[i])   in mm.
   * Up to the last pass this follows the measurements. After it, the last
   * measured state carries on at the measured rate.
   */
  blend(y) {
    const t = this.meta.t_years;
    if (!this.frames || y <= 0) return { a: null, b: null, w: 0 };
    const yy = Math.min(y, t[t.length - 1]);
    let k = 0;
    while (k < t.length - 2 && yy > t[k + 1]) k++;
    return { a: this.resid(k), b: this.resid(k + 1), w: (yy - t[k]) / (t[k + 1] - t[k]) };
  }

  /** Sinking in mm (positive = down) at one pixel. */
  sunkAt(i, y) {
    if (i < 0 || !(this.flags[i] & 1) || y <= 0) return 0;
    const { a, b, w } = this.blend(y);
    return -(this.rate[i] * y + (a ? (1 - w) * a[i] + w * b[i] : 0));
  }

  /** Risk class 0..4 of the ground at one pixel, y years after the first pass. */
  classAt(i, y) {
    if (i < 0 || y <= 0 || !(this.flags[i] & 1)) return 0;
    const d = this.beta[i] * 1e-6 * y;
    if (d >= LIMITS.structural) return 4;
    if (d >= LIMITS.damage) return 3;
    if (d >= LIMITS.cracking) return 2;
    return this.flags[i] & 2 ? 1 : 0;
  }

  /** Years after the first pass at which a pixel passes a distortion limit. */
  yearsToLimit(i, limit) {
    const b = this.beta[i] * 1e-6;
    return b > 0 ? limit / b : Infinity;
  }

  /**
   * Years after the first pass at which ground first passes a distortion
   * limit. "First" is the moment the area past the limit reaches the smallest
   * amount the panel can show (8 pixels, 0.05 km2), so that one noisy pixel
   * does not set the date. Infinity when too little ground sinks unevenly.
   * need = 5 looks at built up land only.
   */
  yearsToFirstPass(limit, need = 5) {
    let b = this._firstRate.get(need);
    if (b === undefined) {
      const { n, flags, beta } = this;
      const px = Math.ceil(0.05 / this.pixelKm2);
      const top = [];
      for (let i = 0; i < n; i++) {
        if (beta[i] && (flags[i] & need) === need) top.push(beta[i]);
      }
      top.sort((p, q) => q - p);
      b = top.length >= px ? top[px - 1] : 0;      // rate of the 8th fastest tilting pixel
      this._firstRate.set(need, b);
    }
    return b > 0 ? limit / (b * 1e-6) : Infinity;
  }

  /** km2 of ground in each risk class. need = 5 counts built up land only. */
  areaByClass(y, need = 1) {
    const out = [0, 0, 0, 0, 0];
    if (y <= 0) return out;
    const { n, flags, beta } = this;
    const c2 = (LIMITS.cracking / y) * 1e6, c3 = (LIMITS.damage / y) * 1e6, c4 = (LIMITS.structural / y) * 1e6;
    for (let i = 0; i < n; i++) {
      const f = flags[i];
      if ((f & need) !== need) continue;
      const b = beta[i];
      if (b >= c4) out[4]++; else if (b >= c3) out[3]++; else if (b >= c2) out[2]++; else if (f & 2) out[1]++;
    }
    return out.map(v => v * this.pixelKm2);
  }
}

export async function loadPlace(meta) {
  const core = await fetchBytes(`data/${meta.id}/core.bin.gz`);
  if (core.byteLength !== meta.width * meta.height * 5) throw new Error('core file does not match the index');
  return new PlaceData(meta, core);
}

export function loadFrames(meta) {
  return fetchBytes(`data/${meta.id}/frames.bin.gz`);
}
