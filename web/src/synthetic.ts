// Synthetic subsidence data for UI development. Replace with NISAR-derived
// layers later; keep the same shape (one cumulative-displacement value per
// cell per time step) so the map code does not change.
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";

export const MONTHS = 12; // time steps after the baseline
const START = new Date(Date.UTC(2025, 10, 1)); // baseline: Nov 2025
const CELL = 0.1; // degrees

export function monthLabel(step: number): string {
  const d = new Date(Date.UTC(START.getUTCFullYear(), START.getUTCMonth() + step, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Property name holding the cumulative displacement (mm) at a time step.
export const stepKey = (step: number) => `d${step}`;

// Deterministic PRNG so the synthetic field is stable between reloads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeometry(x: number, y: number, g: Polygon | MultiPolygon): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some((h) => inRing(x, y, h)));
}

// Subsidence hotspots: centre, spread (deg), rate (mm/month, negative = sinking).
const HOTSPOTS = [
  { lon: -119.6, lat: 35.9, sigma: 0.7, rate: -14, season: 9 }, // southern San Joaquin Valley
  { lon: -120.4, lat: 36.8, sigma: 0.5, rate: -8, season: 6 }, // Fresno / Madera
  { lon: -121.8, lat: 39.0, sigma: 0.5, rate: -5, season: 4 }, // Sacramento Valley
  { lon: -115.6, lat: 33.0, sigma: 0.4, rate: -3, season: 1 }, // Imperial Valley
  { lon: -118.2, lat: 34.0, sigma: 0.3, rate: 2.5, season: 2 }, // LA basin (slight uplift)
];

export function buildField(state: FeatureCollection): FeatureCollection<Polygon> {
  const geom = state.features[0].geometry as Polygon | MultiPolygon;
  const rand = mulberry32(42);
  const features: Feature<Polygon>[] = [];

  for (let lon = -124.5; lon < -114; lon += CELL) {
    for (let lat = 32.5; lat < 42.1; lat += CELL) {
      const cx = lon + CELL / 2;
      const cy = lat + CELL / 2;
      if (!inGeometry(cx, cy, geom)) continue;

      let rate = -0.3 + (rand() - 0.5) * 0.6; // background drift
      let season = 0.5;
      for (const h of HOTSPOTS) {
        const dist2 = (cx - h.lon) ** 2 + (cy - h.lat) ** 2;
        const w = Math.exp(-dist2 / (2 * h.sigma ** 2));
        rate += h.rate * w;
        season += h.season * w;
      }

      const props: Record<string, number> = {};
      for (let t = 0; t <= MONTHS; t++) {
        // Trend + seasonal aquifer cycle (ground rises in wet months) + noise.
        const phase = (k: number) => Math.sin((2 * Math.PI * (k - 2)) / 12);
        const seasonal = season * (phase(t) - phase(0)); // zero at baseline
        const noise = t === 0 ? 0 : (rand() - 0.5) * 2;
        props[stepKey(t)] = Math.round((rate * t + seasonal + noise) * 10) / 10;
      }
      props.rate = Math.round(rate * 10) / 10;

      features.push({
        type: "Feature",
        properties: props,
        geometry: {
          type: "Polygon",
          coordinates: [[[lon, lat], [lon + CELL, lat], [lon + CELL, lat + CELL], [lon, lat + CELL], [lon, lat]]],
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
