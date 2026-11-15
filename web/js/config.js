// Shared constants: colours, limits, time range.

export const END_YEAR = 2050;
export const DAY = 86400000;
export const YEAR = 365.25 * DAY;

// Angular distortion limits from foundation engineering practice
// (Skempton and MacDonald 1956, Bjerrum 1963). Screening levels, not verdicts.
export const LIMITS = { cracking: 1 / 500, damage: 1 / 300, structural: 1 / 150 };

// Uneven sinking from before NISAR.
// The radar has watched since late 2025. That is far too short for any ground
// to pass a damage limit, while the ground it sees sinking was sinking long
// before. So the damage classes also count earlier strain, by assuming the
// distortion rate NISAR measures now was already going on since a given year.
// It is the assumption the projection makes ("the measured rate continues")
// applied backwards: 2000 mirrors the 2050 end of the time bar. `since: null`
// counts from the first radar pass only.
export const EARLIER = [
  { id: 'none', since: null, label: 'not counted' },
  { id: '2015', since: 2015, label: 'assumed since 2015' },
  { id: '2000', since: 2000, label: 'assumed since 2000' },
];
export const EARLIER_DEFAULT = '2000';

export const RISK = [
  { label: 'No sinking detected', short: 'Not detected', color: '#4a5568' },
  { label: 'Sinking evenly', short: 'Sinking evenly', color: '#6f9fb0' },
  { label: 'Cracking possible (past 1/500)', short: 'Cracking possible', color: '#d6b25e' },
  { label: 'Cracking likely (past 1/300)', short: 'Cracking likely', color: '#c4623f' },
  { label: 'Structural damage likely (past 1/150)', short: 'Structural damage likely', color: '#8e2f4a' },
];

// Ground sinking colour ramp: log scale from 1 cm to 10 m.
export const SINK_MIN_MM = 10;
export const SINK_DECADES = 3;
const STOPS = [
  [0.0, 31, 42, 68, 150],
  [0.3, 63, 111, 143, 190],
  [0.58, 143, 184, 176, 215],
  [0.82, 214, 222, 208, 230],
  [1.0, 233, 228, 212, 240],
];

/** 256 entry RGBA lookup table for the ramp. */
export function sinkLUT() {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const u = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && u > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1];
    const w = (u - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = Math.round(a[c + 1] + w * (b[c + 1] - a[c + 1]));
  }
  return lut;
}

/** Position 0..1 on the ramp for an amount sunk in mm. */
export function sinkU(mm) {
  if (!(mm > SINK_MIN_MM)) return 0;
  return Math.min(1, Math.log10(mm / SINK_MIN_MM) / SINK_DECADES);
}

export function sinkCSS(mm) {
  const lut = sinkLUT.cache || (sinkLUT.cache = sinkLUT());
  const i = Math.round(sinkU(mm) * 255) * 4;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}

export function rampCSS() {
  return 'linear-gradient(90deg,' + STOPS.map(s => `rgb(${s[1]},${s[2]},${s[3]}) ${s[0] * 100}%`).join(',') + ')';
}

/** "3.2 cm", "48 cm", "5.4 m" from millimetres. */
export function fmtSunk(mm) {
  const a = Math.abs(mm);
  if (a < 1) return '0 cm';
  if (a < 100) return (a / 10).toFixed(1) + ' cm';
  if (a < 1000) return Math.round(a / 10) + ' cm';
  return (a / 1000).toFixed(a < 10000 ? 1 : 0) + ' m';
}

/** "36 cm per year" from mm per year. */
export function fmtRate(mm) {
  const a = Math.abs(mm);
  return (a < 100 ? (a / 10).toFixed(1) : Math.round(a / 10)) + ' cm per year';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function fmtMonth(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
