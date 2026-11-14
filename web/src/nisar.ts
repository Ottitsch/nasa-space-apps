// Cumulative displacement cube built by scripts/build_subsidence.py from NISAR GUNW pairs.
import { rgbAt } from "./colors";

export interface Meta {
  bounds: [number, number, number, number]; // west, south, east, north
  width: number;
  height: number;
  steps: number;
  dates: string[];
  scale_mm: number;
  nodata: number;
  quantity: string;
  label: string;
  trend_file?: string;
  rate_mm_per_year?: { p5: number; median: number; p95: number };
  source: { track: string; direction: string; frame: string; pairs: { level: string }[] };
}

export interface Cube {
  meta: Meta;
  data: Int16Array; // [step][row, north first][col]
}

export interface ManifestEntry {
  id: string;
  label: string;
  path: string;
}

/** A track's measured cube plus its robust linear-trend cube. */
export interface Dataset {
  entry: ManifestEntry;
  measured: Cube;
  trend: Cube | null;
  limit: number; // shared colour-scale limit (mm)
}

const MANIFEST = "/data/subsidence/manifest.json";

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Empty when the cubes have not been generated (app falls back to synthetic data). */
export async function loadManifest(): Promise<ManifestEntry[]> {
  return (await json<ManifestEntry[]>(MANIFEST)) ?? [];
}

async function loadCube(path: string, meta: Meta, file: string): Promise<Cube | null> {
  try {
    const res = await fetch(`${path}/${file}`);
    if (!res.ok) return null;
    const data = new Int16Array(await res.arrayBuffer());
    return data.length === meta.steps * meta.width * meta.height ? { meta, data } : null;
  } catch {
    return null;
  }
}

export async function loadDataset(entry: ManifestEntry): Promise<Dataset | null> {
  const meta = await json<Meta>(`${entry.path}/meta.json`);
  if (!meta) return null;
  const measured = await loadCube(entry.path, meta, "cube.bin");
  if (!measured) return null;
  const trend = meta.trend_file ? await loadCube(entry.path, meta, meta.trend_file) : null;
  return { entry, measured, trend, limit: suggestLimit(measured) };
}

/** Displacement in mm at a coordinate, or null outside the data / on no-data cells. */
export function cubeValue(c: Cube, step: number, lng: number, lat: number): number | null {
  const { bounds: [w, s, e, n], width, height, nodata, scale_mm } = c.meta;
  if (lng < w || lng >= e || lat <= s || lat > n) return null;
  const col = Math.floor(((lng - w) / (e - w)) * width);
  const row = Math.floor(((n - lat) / (n - s)) * height);
  const v = c.data[step * width * height + row * width + col];
  return v === nodata ? null : v * scale_mm;
}

/** Colour scale limit (mm): 98th percentile of |final displacement|, rounded up to a tidy number. */
export function suggestLimit(c: Cube): number {
  const { width, height, steps, nodata, scale_mm } = c.meta;
  const last = c.data.subarray((steps - 1) * width * height);
  const abs: number[] = [];
  for (const v of last) if (v !== nodata) abs.push(Math.abs(v * scale_mm));
  if (!abs.length) return 100;
  abs.sort((a, b) => a - b);
  const p98 = abs[Math.floor(abs.length * 0.98)];
  const nice = [20, 50, 100, 150, 200, 300, 500, 1000];
  return nice.find((x) => x >= p98) ?? 1000;
}

/** Colourised PNG data URL of one time step. */
export function renderStep(c: Cube, step: number, limit: number): string {
  const { width, height, nodata, scale_mm } = c.meta;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const off = step * width * height;
  for (let i = 0; i < width * height; i++) {
    const v = c.data[off + i];
    if (v === nodata) continue; // stays transparent
    const [r, g, b] = rgbAt(v * scale_mm, limit);
    img.data.set([r, g, b, 215], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
