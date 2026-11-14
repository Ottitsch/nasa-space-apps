// Diverging scale: red = sinking, grey = no change, blue = rising.
const NEUTRAL = "#f0efec";
const POLES = ["#b2182b", "#ef8a62", NEUTRAL, "#67a9cf", "#2166ac"] as const;

export type Stop = [value: number, color: string];

export function colorStops(limit: number): Stop[] {
  return POLES.map((c, i) => [(-limit) + (i * limit) / 2, c]);
}

const hex = (c: string): [number, number, number] => [
  parseInt(c.slice(1, 3), 16),
  parseInt(c.slice(3, 5), 16),
  parseInt(c.slice(5, 7), 16),
];

const RGB = POLES.map(hex);

/** RGB for a value in mm, linearly interpolated between the stops. */
export function rgbAt(v: number, limit: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (v + limit) / (2 * limit))) * (RGB.length - 1);
  const i = Math.min(RGB.length - 2, Math.floor(t));
  const f = t - i;
  return [0, 1, 2].map((k) => Math.round(RGB[i][k] + (RGB[i + 1][k] - RGB[i][k]) * f)) as [number, number, number];
}
