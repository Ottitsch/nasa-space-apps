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
  source: { track: string; direction: string; frame: string; pairs: { level: string }[] };
}

export interface Cube {
  meta: Meta;
  data: Int16Array; // [step][row, north first][col]
}

const BASE = "/data/subsidence";

/** Resolves to null when the cube has not been generated (app falls back to synthetic data). */
export async function loadCube(): Promise<Cube | null> {
  try {
    const metaRes = await fetch(`${BASE}/meta.json`);
    if (!metaRes.ok || !metaRes.headers.get("content-type")?.includes("json")) return null;
    const meta: Meta = await metaRes.json();
    const binRes = await fetch(`${BASE}/cube.bin`);
    if (!binRes.ok) return null;
    const data = new Int16Array(await binRes.arrayBuffer());
    if (data.length !== meta.steps * meta.width * meta.height) return null;
    return { meta, data };
  } catch {
    return null;
  }
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
