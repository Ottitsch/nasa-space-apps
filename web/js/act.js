// Take action: (1) a one page report for a spot, (2) a letter to the office
// responsible, (3) ways to find the neighbours. Everything is computed in the
// browser from the same files the map uses. Nothing the person types is sent
// anywhere.

import * as maplibregl from '../vendor/maplibre-gl.mjs';
import { END_YEAR, LIMITS, RISK, YEAR } from './config.js';
import { loadFrames, loadIndex, loadPlace, mercY } from './data.js';
import { build, draw, paginate, save } from './pdf.js';

const $ = id => document.getElementById(id);
const BLDG_URL = 'pmtiles://https://data.source.coop/vida/google-microsoft-osm-open-buildings/pmtiles/goog_msft_osm.pmtiles';
const BLDG_LAYER = 'goog_msft_osm_building_footprints';
const HORIZONS = ['now', 2030, 2040, 2050];
const RADII = [250, 500];
const RTL = new Set(['fa', 'ur', 'ar', 'he']);
const SEEN = ['cracks', 'doors', 'tilt', 'ground', 'pipes'];
const MAP_PX = 900;
// risk colours on paper: "not detected" is a quiet grey
const PAPER = ['#c3c9d2', RISK[1].color, RISK[2].color, RISK[3].color, RISK[4].color];
const END = Date.UTC(END_YEAR, 11, 31);

const S = {
  meta: null, place: null, city: null, cases: null, langs: [],
  lat: 0, lng: 0, r: 500, year: 2040,
  ui: null, letter: null,           // language contexts: { lang, d }
  ask: 'inspection', body: null,
  A: null,                          // analysis of the current spot
  map: null, mapReady: false, buildingsFailed: false,
};
const B = new Map();                // building id -> { idx, lng, lat, cls }

// ----------------------------------------------------------------- language

const dicts = {};
async function dict(lang) {
  if (!(lang in dicts)) {
    try {
      const r = await fetch(`action/i18n/${lang}.json`);
      dicts[lang] = r.ok ? await r.json() : null;
    } catch { dicts[lang] = null; }
  }
  return dicts[lang];
}
// Numbers and dates follow the country of the place, not just the language:
// Spanish in Mexico writes 2.2 m and 2,484, Spanish in Spain the reverse.
const REGION = {
  Mexico: 'MX', Iran: 'IR', Pakistan: 'PK', India: 'IN', Indonesia: 'ID', 'Türkiye': 'TR', "Côte d'Ivoire": 'CI',
  China: 'CN', 'United States': 'US', 'United Kingdom': 'GB', Colombia: 'CO', Peru: 'PE', Brazil: 'BR', Argentina: 'AR',
  Chile: 'CL', Netherlands: 'NL', Italy: 'IT', Spain: 'ES', Greece: 'GR', Egypt: 'EG', Nigeria: 'NG', Tanzania: 'TZ',
  'South Africa': 'ZA', Afghanistan: 'AF', Nepal: 'NP', Bangladesh: 'BD', Myanmar: 'MM', Thailand: 'TH', Vietnam: 'VN',
  Singapore: 'SG', Philippines: 'PH', Taiwan: 'TW', Japan: 'JP', Australia: 'AU',
};
function localeFor(lang) {
  try { return new Intl.Locale(lang, { region: REGION[S.meta?.country] }).toString(); } catch { return lang; }
}
const ctx = lang => ({ lang, loc: localeFor(lang), d: dicts[lang] || dicts.en });
const caseDicts = { en: null };
async function caseDict(lang) {
  if (!(lang in caseDicts)) {
    try {
      const r = await fetch(`action/i18n/cases.${lang}.json`);
      caseDicts[lang] = r.ok ? await r.json() : null;
    } catch { caseDicts[lang] = null; }
  }
  return caseDicts[lang];
}
function tr(L, key, vars) {
  const s = L.d[key] ?? dicts.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}
const t = (key, vars) => tr(S.ui, key, vars);
/** Text from a city file: { en: "...", es: "..." }. */
const pick = (obj, lang) => (obj && typeof obj === 'object' ? obj[lang] ?? obj.en ?? '' : obj || '');

const num = (L, n, d = 0) => new Intl.NumberFormat(L.loc, { maximumFractionDigits: d }).format(n);
const day = (L, ms) => new Intl.DateTimeFormat(L.loc, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(ms);
const month = (L, ms) => new Intl.DateTimeFormat(L.loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(ms);
const yearText = (L, y) => new Intl.DateTimeFormat(L.loc, { year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, 0, 1));
function sunk(L, mm) {
  const a = Math.abs(mm);
  if (a < 995) return tr(L, 'u.cm', { n: num(L, a / 10, a < 100 ? 1 : 0) });
  return tr(L, 'u.m', { n: new Intl.NumberFormat(L.loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(a / 1000) });
}
const rate = (L, mm) => tr(L, 'u.cmyr', { n: num(L, Math.abs(mm) / 10, Math.abs(mm) < 100 ? 1 : 0) });
const mmyr = (L, v) => tr(L, 'u.mmyr', { n: num(L, v, 1) });
const ha = (L, v) => tr(L, 'u.ha', { n: num(L, v, v < 10 ? 1 : 0) });
const metresText = (L, m) => tr(L, 'u.dist', { n: num(L, m) });

/** Place and country in the reader's language when the city file knows them. */
const placeName = L => pick(S.city?.place_name, L.lang) || S.meta.name;
const countryName = L => pick(S.city?.country_name, L.lang) || S.meta.country;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const web = u => (/^https?:\/\//i.test(u || '') ? u : null);
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
/** Host plus a shortened path, so two links on the same site can be told apart. */
const pageName = u => {
  try {
    const x = new URL(u), p = decodeURIComponent(x.pathname).replace(/\/$/, '');
    return x.hostname.replace(/^www\./, '') + (p.length > 34 ? p.slice(0, 32) + '…' : p);
  } catch { return u; }
};
const link = (u, text) => (web(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(text || host(u))}</a>` : '');

function toast(text) {
  const el = $('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

// ----------------------------------------------------------------- analysis

const yearsTo = year => (Date.UTC(year, 0, 1) - S.meta.t0) / YEAR;
const horizonY = h => (h === 'now' ? S.meta.span : yearsTo(h));

function metres(lng1, lat1, lng2, lat2) {
  const k = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.hypot((lng1 - lng2) * 111320 * k, (lat1 - lat2) * 110574);
}

function analyse() {
  const p = S.place, m = S.meta;
  let i = p.index(S.lng, S.lat), near = 0;
  if (i >= 0 && !(p.flags[i] & 1)) {           // no signal right here: use the nearest measured ground
    const x0 = i % p.W, y0 = (i / p.W) | 0;
    let best = Infinity, bi = -1;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= p.W || y >= p.H) continue;
        const j = y * p.W + x, d2 = dx * dx + dy * dy;
        if ((p.flags[j] & 1) && d2 < best) { best = d2; bi = j; }
      }
    }
    if (bi >= 0) { i = bi; near = Math.round(Math.sqrt(best) * 80); }
  }
  const valid = i >= 0 && !!(p.flags[i] & 1), sig = valid && !!(p.flags[i] & 2);
  const edge = valid && !sig && p.beta[i] > 0;   // not sinking fast itself, but tilting next to ground that is
  const when = limit => (valid ? m.t0 + p.yearsToLimit(i, limit) * YEAR : Infinity);
  const spot = {
    i, valid, sig, edge, near,
    rate: valid ? p.rate[i] : 0,
    series: m.t_years.map(y => (valid ? p.sunkAt(i, y) : 0)),
    now: valid ? p.sunkAt(i, m.span) : 0,
    by: Object.fromEntries([2030, 2040, 2050].map(y => [y, valid ? p.sunkAt(i, yearsTo(y)) : 0])),
    limits: { crack: when(LIMITS.cracking), damage: when(LIMITS.damage), struct: when(LIMITS.structural) },
    cls: valid ? p.classAt(i, m.span) : 0,
  };

  // the neighbourhood: built up pixels within the radius
  const cx = ((S.lng - p.west) / (p.east - p.west)) * p.W;
  const cy = ((p.yN - mercY(S.lat)) / (p.yN - p.yS)) * p.H;
  const rp = S.r / 80, ys = HORIZONS.map(horizonY);
  let built = 0, sinking = 0, fastest = 0;
  const area = HORIZONS.map(() => [0, 0, 0, 0, 0]);
  for (let y = Math.max(0, Math.floor(cy - rp)); y <= Math.min(p.H - 1, Math.ceil(cy + rp)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rp)); x <= Math.min(p.W - 1, Math.ceil(cx + rp)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > rp * rp) continue;
      const j = y * p.W + x, f = p.flags[j];
      if ((f & 5) !== 5) continue;
      built++;
      if ((f & 2) || p.beta[j]) sinking++;
      if ((f & 2) && p.rate[j] < fastest) fastest = p.rate[j];
      for (let k = 0; k < ys.length; k++) area[k][p.classAt(j, ys[k])]++;
    }
  }
  S.A = {
    spot, ys,
    hood: { builtHa: built * 0.64, sinkingHa: sinking * 0.64, fastest, area: area.map(a => a.map(v => v * 0.64)) },
    buildings: S.A?.buildings ?? null, nBuildings: S.A?.nBuildings ?? null, nSinking: S.A?.nSinking ?? null,
  };
}

// --------------------------------------------------------------- the sheet

function limitText(L, ms) {
  if (!isFinite(ms)) return tr(L, 'limit.never');
  if (ms > END) return tr(L, 'limit.after', { year: yearText(L, END_YEAR) });
  return tr(L, ms <= S.meta.t1 ? 'limit.passed' : 'limit.around', { date: month(L, ms) });
}

function shareUrl() {
  const u = new URL(location.href);
  u.hash = `place=${S.meta.id}&lat=${S.lat.toFixed(4)}&lng=${S.lng.toFixed(4)}&r=${S.r}`;
  return u.toString();
}

/** Chart labels sit in left to right drawings: keep right to left text in its own order. */
const iso = text => (RTL.has(S.ui.lang) ? `\u2067${text}\u2069` : text);

function measuredSVG() {
  const m = S.meta, s = S.A.spot.series, L = S.ui;
  const W = 330, H = 118, l = 6, r = 84, top = 8, b = 18, iw = W - l - r, ih = H - top - b;
  const max = Math.max(...s, 5) * 1.12;
  const X = k => l + (iw * m.t_years[k]) / m.span, Y = v => top + (ih * Math.max(0, v)) / max;
  const pts = s.map((v, k) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`);
  const last = s[s.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" direction="ltr" style="direction:ltr" role="img" aria-label="${esc(t('chart.measured'))}">
    <line x1="${l}" x2="${W - r}" y1="${top}" y2="${top}" stroke="#9aa5b4" stroke-dasharray="2 3"/>
    <polygon points="${l},${top} ${pts.join(' ')} ${W - r},${top}" fill="rgba(30,130,220,0.12)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#1e82dc" stroke-width="2"/>
    ${s.map((v, k) => `<circle cx="${X(k).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.2" fill="#1e82dc"/>`).join('')}
    <text x="${W - r + 5}" y="${top + 4}" font-size="10" fill="#5a6779">0</text>
    <text x="${W - r + 5}" y="${Math.max(top + 16, Y(last) + 4)}" font-size="10.5" font-weight="700" fill="#17202e">${esc(iso(sunk(L, last)))}</text>
    <text x="${l}" y="${H - 4}" font-size="10" fill="#5a6779">${esc(iso(day(L, m.t0)))}</text>
    <text x="${W - r}" y="${H - 4}" font-size="10" fill="#5a6779" text-anchor="end">${esc(iso(day(L, m.t1)))}</text>
  </svg>`;
}

function timelineSVG() {
  const m = S.meta, sp = S.A.spot, L = S.ui;
  const W = 330, H = 56, l = 6, r = 6, y = 16, h = 15, iw = W - l - r;
  const X = ms => l + (iw * (Math.min(END, Math.max(m.t0, ms)) - m.t0)) / (END - m.t0);
  const cuts = [[m.t0, sp.sig ? 1 : 0], [sp.limits.crack, 2], [sp.limits.damage, 3], [sp.limits.struct, 4]].filter(c => c[0] < END);
  let out = '';
  for (let k = 0; k < cuts.length; k++) {
    const a = X(cuts[k][0]), b = X(k + 1 < cuts.length ? cuts[k + 1][0] : END);
    if (b - a > 0.2) out += `<rect x="${a.toFixed(1)}" y="${y}" width="${(b - a).toFixed(1)}" height="${h}" fill="${PAPER[cuts[k][1]]}"/>`;
  }
  const ticks = [2030, 2040, 2050].map(yy => {
    const x = X(Date.UTC(yy, 0, 1));
    return `<line x1="${x}" x2="${x}" y1="${y + h}" y2="${y + h + 4}" stroke="#5a6779"/><text x="${x}" y="${H - 4}" font-size="10" fill="#5a6779" text-anchor="${yy === 2050 ? 'end' : 'middle'}">${esc(yearText(L, yy))}</text>`;
  }).join('');
  const xn = X(m.t1);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" direction="ltr" style="direction:ltr" role="img" aria-label="${esc(t('chart.timeline'))}">
    ${out}<rect x="${l}" y="${y}" width="${iw}" height="${h}" fill="none" stroke="#9aa5b4"/>
    <path d="M${xn} ${y - 1}l-4 -6h8z" fill="#17202e"/>
    <text x="${xn + 7}" y="${y - 4}" font-size="10" fill="#17202e">${esc(iso(t('chart.today')))}</text>
    ${ticks}</svg>`;
}

function renderSheet() {
  const m = S.meta, A = S.A, sp = A.spot, L = S.ui;
  const radius = metresText(L, S.r);
  $('sh-place').textContent = `${placeName(L)}, ${countryName(L)}`;
  $('sh-meta').textContent = `${t('sheet.spot')}: ${S.lat.toFixed(5)}, ${S.lng.toFixed(5)} · ${t('sheet.made', { date: day(L, Date.now()) })}`;
  $('sh-url').textContent = shareUrl().replace(/^https?:\/\//, '');

  const chip = `<span class="chip" style="background:${sp.cls ? RISK[sp.cls].color : '#6b7686'}">${esc(t('class.' + sp.cls))}</span>`;
  let v;
  if (!sp.valid) v = `<p class="big">${esc(t('verdict.nodata'))}</p><p class="sub">${esc(t('verdict.nodata.sub'))}</p>`;
  else if (sp.edge) v = `<p class="big">${sp.cls >= 2 ? chip : ''}${esc(t('verdict.edge'))}</p><p class="sub">${esc(t('verdict.edge.sub'))}</p>`;
  else if (!sp.sig) v = `<p class="big">${chip}${esc(t('verdict.none'))}</p><p class="sub">${esc(t('verdict.none.sub', { thr: mmyr(L, m.threshold_mm_yr) }))}</p>`;
  else v = `<p class="big">${chip}${esc(t('verdict.sinking', { rate: rate(L, sp.rate) }))}</p>`;
  if (sp.valid && sp.near) v += `<p class="sub">${esc(t('verdict.near', { dist: metresText(L, sp.near) }))}</p>`;
  if (m.early) v += `<p class="early">${esc(t('early', { months: num(L, m.months) }))}</p>`;
  $('sh-verdict').innerHTML = v;

  const row = (k, val) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`;
  let f = '';
  if (sp.sig) {
    f += row(t('fact.rate'), rate(L, sp.rate));
    f += row(t('fact.sunk', { from: day(L, m.t0), to: day(L, m.t1) }), sunk(L, sp.now));
    for (const y of [2030, 2040, 2050]) f += row(t('fact.by', { year: yearText(L, y) }), sunk(L, sp.by[y]));
    f += '<div class="gap"></div>';
  }
  if (sp.valid) {
    f += row(t('fact.crack'), limitText(L, sp.limits.crack));
    f += row(t('fact.damage'), limitText(L, sp.limits.damage));
    f += row(t('fact.struct'), limitText(L, sp.limits.struct));
  }
  $('sh-facts').innerHTML = f;

  $('sh-legend').innerHTML = PAPER.map((c, k) => `<li><i style="background:${c}"></i>${esc(t('class.' + k))}</li>`).join('');
  $('sh-caption').textContent = S.year === 'now'
    ? t('map.caption.now', { radius })
    : t('map.caption.year', { year: yearText(L, S.year), radius });
  $('pic').alt = t('map.alt');

  $('sh-measured').innerHTML = sp.sig
    ? `<h3>${esc(t('chart.measured'))}</h3><p class="sub">${esc(t('chart.measured.sub'))}</p>${measuredSVG()}` : '';
  $('sh-timeline').innerHTML = sp.valid
    ? `<h3>${esc(t('chart.timeline'))}</h3><p class="sub">${esc(t('chart.timeline.sub'))}</p>${timelineSVG()}` : '';

  renderHood();
  $('sh-source').textContent = t('source', {
    n: num(L, m.dates.length), from: day(L, m.t0), to: day(L, m.t1),
    tracks: t(m.tracks.length > 1 ? 'source.tracks.2' : 'source.tracks.1'),
    thr: mmyr(L, m.threshold_mm_yr), url: new URL('.', location.href).href.replace(/^https?:\/\//, ''),
  });
}

function renderHood() {
  const A = S.A, h = A.hood, L = S.ui;
  const pct = h.builtHa ? Math.round((100 * h.sinkingHa) / h.builtHa) : 0;
  const row = (k, val) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`;
  let facts = row(t('hood.built'), ha(L, h.builtHa)) + row(t('hood.sinking'), `${ha(L, h.sinkingHa)} (${num(L, pct)}%)`);
  if (h.fastest < 0) facts += row(t('hood.fastest'), rate(L, h.fastest));
  const counted = A.buildings && !S.buildingsFailed, missing = S.buildingsFailed || A.sparse;
  if (!missing) facts += row(t('hood.buildings'), counted ? num(L, A.nBuildings) : t('hood.counting'));
  const cols = HORIZONS.map(y => `<th>${esc(y === 'now' ? t('hood.col.now') : yearText(L, y))}</th>`).join('');
  const cell = v => (counted ? num(L, v) : ha(L, v));
  const data = counted ? A.buildings : h.area;
  const rows = [1, 2, 3, 4].map(c => `<tr><td><i style="background:${PAPER[c]}"></i>${esc(t('class.' + c))}</td>${data.map(a => `<td>${esc(cell(a[c]))}</td>`).join('')}</tr>`).join('');
  $('sh-hood').innerHTML = `<h3>${esc(t('hood.title', { radius: metresText(L, S.r) }))}</h3>
    <div class="hood-grid"><dl class="facts">${facts}</dl>
    <div><table><thead><tr><th>${esc(counted ? t('hood.buildings') : t('hood.built'))}</th>${cols}</tr></thead><tbody>${rows}</tbody></table>
    <p class="note">${esc(missing ? t('hood.nobuildings') : t('hood.note'))}</p></div></div>`;
}

// ------------------------------------------------- the picture (offscreen map)

function ring(lng, lat, r, n = 90) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = (2 * Math.PI * k) / n;
    out.push([lng + (r * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.sin(a)) / 110574]);
  }
  return out;
}
function centroid(g) {
  const c = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
  if (!c || c.length < 3) return null;
  let x = 0, y = 0;
  const m = c.length - 1;
  for (let i = 0; i < m; i++) { x += c[i][0]; y += c[i][1]; }
  return [x / m, y / m];
}

const riskCanvas = document.createElement('canvas');
function drawRisk() {
  const p = S.place, y = horizonY(S.year);
  riskCanvas.width = p.W; riskCanvas.height = p.H;
  const c = riskCanvas.getContext('2d'), img = c.createImageData(p.W, p.H), px = new Uint32Array(img.data.buffer);
  const col = PAPER.map((hex, k) => {
    const v = parseInt(hex.slice(1), 16), a = [0, 110, 200, 215, 230][k];
    return ((a << 24) | ((v & 255) << 16) | (((v >> 8) & 255) << 8) | (v >> 16)) >>> 0;
  });
  for (let i = 0; i < p.n; i++) px[i] = p.alpha[i] > 128 || p.beta[i] ? col[p.classAt(i, y)] : 0;
  c.putImageData(img, 0, 0);
  const src = S.map.getSource('risk');
  if (src) { src.play(); src.pause(); }
}

function initMap() {
  if (window.pmtiles) maplibregl.addProtocol('pmtiles', new window.pmtiles.Protocol().tile);
  let map;
  try {
    map = S.map = new maplibregl.Map({
      container: 'qmap', style: 'https://tiles.openfreemap.org/styles/positron', interactive: false,
      attributionControl: false, pixelRatio: 1, fadeDuration: 0, center: [S.lng, S.lat], zoom: 15, trackResize: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
  } catch (e) {            // no WebGL: the report still works without the picture
    $('pic-wait').textContent = '';
    S.buildingsFailed = true; renderHood();
    return;
  }
  map.on('error', e => {
    if (e.sourceId === 'bldg' || /pmtiles|source\.coop/i.test(String(e.error?.message))) {
      if (!S.buildingsFailed) { S.buildingsFailed = true; renderHood(); refreshLetter(); renderLead(); }
    }
  });
  map.on('load', () => {
    const layers = map.getStyle().layers;
    for (const l of layers) {
      if (l['source-layer'] === 'building') map.setLayoutProperty(l.id, 'visibility', 'none');
      // the picture is shown at about a third of its size: make street names survive that
      if (l.type === 'symbol' && l.layout?.['text-field']) map.setLayoutProperty(l.id, 'text-size', /place|label_/.test(l.id) ? 30 : 24);
    }
    const before = map.getLayer('tunnel_motorway_casing') ? 'tunnel_motorway_casing' : layers.find(l => l.type === 'symbol')?.id;
    const [w, s, e, n] = S.meta.bounds;
    riskCanvas.width = S.place.W; riskCanvas.height = S.place.H;
    map.addSource('risk', { type: 'canvas', canvas: riskCanvas, animate: false, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    map.addLayer({ id: 'risk', type: 'raster', source: 'risk', paint: { 'raster-opacity': 0.5, 'raster-fade-duration': 0 } }, before);
    if (window.pmtiles) {
      map.addSource('bldg', { type: 'vector', url: BLDG_URL });
      map.addLayer({
        id: 'bldg', type: 'fill', source: 'bldg', 'source-layer': BLDG_LAYER, minzoom: 13,
        paint: {
          'fill-color': ['match', ['coalesce', ['feature-state', 'risk'], 0], 1, PAPER[1], 2, PAPER[2], 3, PAPER[3], 4, PAPER[4], PAPER[0]],
          'fill-outline-color': 'rgba(30,40,60,0.45)',
        },
      }, before);
    } else { S.buildingsFailed = true; }
    map.addSource('ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#17202e', 'line-width': 4, 'line-dasharray': [2, 2] } });
    map.addSource('pin', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'pin-halo', type: 'circle', source: 'pin', paint: { 'circle-radius': 22, 'circle-color': '#ffffff', 'circle-opacity': 0.85 } });
    map.addLayer({ id: 'pin', type: 'circle', source: 'pin', paint: { 'circle-radius': 12, 'circle-color': '#17202e', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4 } });
    S.mapReady = true;
    placeMap();
  });
  map.on('idle', onIdle);
}

function placeMap() {
  if (!S.mapReady) return;
  const map = S.map, pts = ring(S.lng, S.lat, S.r);
  map.getSource('ring').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts } });
  map.getSource('pin').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [S.lng, S.lat] } });
  drawRisk();
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 70, animate: false });
  $('pic-wait').hidden = false;
  map.triggerRepaint();
}

function onIdle() {
  if (!S.mapReady) return;
  const map = S.map, p = S.place;
  let changed = false;
  if (map.getSource('bldg') && !S.buildingsFailed) {
    const yH = horizonY(S.year), seen = new Set(), inside = [];
    for (const f of map.querySourceFeatures('bldg', { sourceLayer: BLDG_LAYER })) {
      const id = f.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      let b = B.get(id);
      if (!b) {
        const c = centroid(f.geometry);
        if (!c) continue;
        b = { idx: p.index(c[0], c[1]), lng: c[0], lat: c[1], cls: -1 };
        B.set(id, b);
      }
      const cls = p.classAt(b.idx, yH);
      if (b.cls !== cls) {
        b.cls = cls;
        map.setFeatureState({ source: 'bldg', sourceLayer: BLDG_LAYER, id }, { risk: cls });
        changed = true;
      }
      if (metres(b.lng, b.lat, S.lng, S.lat) <= S.r) inside.push(b.idx);
    }
    if (seen.size || map.isSourceLoaded('bldg')) {
      const counts = S.A.ys.map(y => { const c = [0, 0, 0, 0, 0]; for (const i of inside) c[p.classAt(i, y)]++; return c; });
      const key = JSON.stringify(counts);
      if (key !== S.A.key) {
        // fewer than one outline per hectare of built up land means the open
        // building data barely covers this place (mainland China, for one)
        const sparse = inside.length < S.A.hood.builtHa;
        S.A.key = key; S.A.sparse = sparse;
        S.A.buildings = sparse ? null : counts; S.A.nBuildings = sparse ? null : inside.length;
        S.A.nSinking = sparse ? null : inside.filter(i => i >= 0 && ((p.flags[i] & 2) || p.beta[i])).length;
        renderHood(); renderLead(); refreshLetter();
      }
    }
  }
  if (!changed && map.getCanvas().width === MAP_PX) {
    $('pic').src = map.getCanvas().toDataURL('image/jpeg', 0.9);
    $('pic-wait').hidden = true;
  }
}

// ------------------------------------------------------------- the letter

function buildLetter() {
  const L = S.letter, m = S.meta, A = S.A, sp = A.spot, c = S.city;
  // an English letter uses the English names of offices and laws, any other language the local names
  const local = L.lang !== 'en';
  const name = $('you-name').value.trim(), addr = $('you-address').value.trim(), contact = $('you-contact').value.trim();
  const body = c?.bodies.find(b => b.id === S.body);
  const where = addr || tr(L, 'letter.where.point', { lat: S.lat.toFixed(5), lng: S.lng.toFixed(5), place: placeName(L) });
  const radius = metresText(L, S.r);
  const subject = tr(L, 'letter.subject.' + S.ask, { where });

  const ev = [];
  if (sp.sig) ev.push(tr(L, 'letter.ev.spot', { where, sunk: sunk(L, sp.now), from: day(L, m.t0), to: day(L, m.t1), rate: rate(L, sp.rate) }));
  else ev.push(tr(L, sp.edge ? 'letter.ev.spot.edge' : 'letter.ev.spot.none', { where }));
  if (A.hood.sinkingHa > 0) {
    ev.push(tr(L, 'letter.ev.hood', { radius, sinking: ha(L, A.hood.sinkingHa) }));
    if (A.hood.fastest < 0) ev.push(tr(L, 'letter.ev.hood.fastest', { fastest: rate(L, A.hood.fastest) }));
    if (A.nSinking > 0) ev.push(tr(L, 'letter.ev.hood.buildings', { buildings: num(L, A.nSinking) }));
  }
  if (sp.limits.crack <= END) ev.push(tr(L, 'letter.ev.limit', { date: month(L, sp.limits.crack) }));
  else if (A.buildings) {
    const k = HORIZONS.indexOf(2040), n = A.buildings[k][2] + A.buildings[k][3] + A.buildings[k][4];
    if (n > 0) ev.push(tr(L, 'letter.ev.limit.hood', { n: num(L, n), radius, year: yearText(L, 2040) }));
  }
  const seen = SEEN.filter(k => $('seen-' + k).checked).map(k => '  • ' + tr(L, 'letter.seen.' + k));
  const asks = [1, 2, 3].map(k => `  ${num(L, k)}. ${tr(L, `letter.ask.${S.ask}.${k}`)}`);
  // an access to information law backs a request for information, not a request
  // for an inspection, unless the city file says it covers both
  const law = (c?.right_to_answer?.asks || ['groundwater']).includes(S.ask) ? c?.right_to_answer : null;
  const right = law
    ? tr(L, law.deadline_days ? 'letter.right' : 'letter.right.nodays', { law: local ? law.name : law.name_en || law.name, deadline: deadline(L, law) })
    : tr(L, 'letter.noright');

  const parts = [
    [name || tr(L, 'letter.name.placeholder'), addr, contact].filter(Boolean).join('\n'),
    day(L, Date.now()),
    body ? (local ? body.name : body.name_en || body.name) : tr(L, 'letter.to.placeholder'),
    `${tr(L, 'letter.subject.label')} ${subject}`,
    tr(L, 'letter.salutation'),
    `${addr ? tr(L, 'letter.intro.address', { address: addr }) : tr(L, 'letter.intro.noaddress')} ${tr(L, 'letter.why.' + S.ask)}`,
    ev.join(' '),
    `${tr(L, 'letter.ev.caveat')} ${tr(L, 'letter.ev.link', { url: shareUrl() })}`,
    seen.length ? `${tr(L, 'letter.seen.intro')}\n${seen.join('\n')}` : '',
    `${tr(L, 'letter.ask.intro')}\n${asks.join('\n')}`,
    right,
    `${tr(L, 'letter.closing')}\n\n${name || tr(L, 'letter.name.placeholder')}${contact ? '' : '\n' + tr(L, 'letter.contact.placeholder')}`,
  ];
  return { subject, text: parts.filter(Boolean).join('\n\n'), email: body?.email || '' };
}

/** "20 working days": the city file's own wording when it has one. */
function deadline(L, law) {
  return pick(law.deadline_text, L.lang) || tr(L, 'u.days', { n: num(L, law.deadline_days) });
}

function refreshLetter() {
  if (!S.letter || !S.A) return;
  const { subject, text, email } = buildLetter();
  const ta = $('letter');
  ta.value = text;
  ta.dir = RTL.has(S.letter.lang) ? 'rtl' : 'ltr';
  ta.lang = S.letter.lang;
  $('l-email').href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

// ------------------------------------------------- step 2: who to send it to

function renderAsks() {
  $('asks').innerHTML = ['inspection', 'groundwater'].map(a => `
    <label><input type="radio" name="ask" value="${a}" ${a === S.ask ? 'checked' : ''}>
      <b>${esc(t('s2.ask.' + a))}</b><span>${esc(t(`s2.ask.${a}.sub`))}</span></label>`).join('');
  $('seen').innerHTML = SEEN.map(k => `<label><input type="checkbox" id="seen-${k}" ${$('seen-' + k)?.checked ? 'checked' : ''}> ${esc(t('s2.seen.' + k))}</label>`).join('');
}

function renderBodies() {
  const c = S.city, L = S.ui, lang = L.lang;
  if (!c) {
    $('city-summary').textContent = '';
    $('bodies').innerHTML = `<p>${esc(t('s2.generic.title', { place: placeName(S.ui) }))}</p>
      <ul class="plain" style="margin-top:8px">${[1, 2, 3, 4].map(k => `<li>${esc(t('s2.generic.' + k))}</li>`).join('')}</ul>`;
    $('bodies-note').textContent = '';
    return;
  }
  $('city-summary').textContent = pick(c.summary, lang);
  const fits = b => b.handles?.includes(S.ask);
  const list = [...c.bodies.filter(fits), ...c.bodies.filter(b => !fits(b) && b.handles?.includes('information'))];
  if (!list.some(b => b.id === S.body)) S.body = list[0]?.id ?? null;
  const line = (k, v) => (v ? `<dt>${esc(t(k))}</dt><dd>${v}</dd>` : '');
  $('bodies').innerHTML = list.map(b => `
    <div class="body ${b.id === S.body ? 'on' : ''}">
      <h4>${esc(b.name)}</h4>
      ${b.name_en && b.name_en !== b.name ? `<div class="en">${esc(b.name_en)}</div>` : ''}
      <p class="role">${esc(pick(b.role, lang))}</p>
      <dl>
        ${line('s2.to.website', link(b.website))}
        ${line('s2.to.contact', b.contact_url && b.contact_url !== b.website ? link(b.contact_url, pageName(b.contact_url)) : '')}
        ${line('s2.to.email', b.email ? `<a href="mailto:${encodeURIComponent(b.email)}">${esc(b.email)}</a>` : '')}
        ${line('s2.to.phone', b.phone ? `<a href="tel:${esc(String(b.phone).replace(/[^+\d]/g, ''))}" dir="ltr">${esc(b.phone)}</a>` : '')}
        ${line('s2.to.postal', b.postal ? esc(b.postal) : '')}
      </dl>
      <div class="pick"><button type="button" data-body="${esc(b.id)}">${esc(t(b.id === S.body ? 's2.to.picked' : 's2.to.pick'))}</button>
        ${web(b.source) ? `<span class="fine">${link(b.source, t('s2.to.source'))}</span>` : ''}</div>
    </div>`).join('');
  $('bodies-note').textContent = c.checked ? t('s2.to.checked', { date: day(L, Date.parse(c.checked + 'T00:00:00Z')) }) : '';
}

function renderCity() {
  const c = S.city, lang = S.ui.lang;
  const law = c?.right_to_answer;
  $('right-card').hidden = !law;
  if (law) {
    $('right').innerHTML = `<p><b>${esc(law.name)}</b>${law.name_en && law.name_en !== law.name ? ` <span class="fine">${esc(law.name_en)}</span>` : ''}</p>
      <p>${esc(pick(law.what, lang))}</p><p>${esc(pick(law.how, lang))}</p>
      <p class="fine">${law.deadline_days ? esc(t('s2.right.deadline', { deadline: deadline(S.ui, law) })) + ' ' : ''}
      ${web(law.url) ? `${esc(t('s2.right.portal'))}: ${link(law.url)}` : ''} ${web(law.source) ? '· ' + link(law.source, t('s2.to.source')) : ''}</p>`;
  }
  const u = c?.urgent;
  $('urgent').innerHTML = u
    ? `<b>${esc(t('s2.urgent.call', { phone: u.phone }))}</b> ${esc(pick(u.what, lang))}`
    : esc(t('s2.urgent.generic'));
  const cx = c?.context;
  $('context-card').hidden = !cx;
  if (cx) $('context').innerHTML = `${esc(pick(cx, lang))} <span class="fine">${(cx.sources || []).map(s => link(s)).filter(Boolean).join(' · ')}</span>`;
}

// ---------------------------------------------------- step 3: find the others

function renderLead() {
  const n = S.A?.nSinking;
  $('s3-lead').textContent = n > 0
    ? t('s3.lead.buildings', { n: num(S.ui, n), radius: metresText(S.ui, S.r) })
    : t('s3.lead.none');
}

function renderOthers() {
  const c = S.city, lang = S.ui.lang, place = placeName(S.ui);
  const groups = (c?.groups || []).filter(g => web(g.url));
  $('groups').innerHTML = groups.length
    ? groups.map(g => `<a class="btn group-btn" href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.label || t('s3.group.join', { place }))}</a>`).join('')
    : `<p>${esc(t('s3.group.none', { place }))}</p>`;
  $('organising').textContent = pick(c?.organising?.note, lang);
  $('kit').innerHTML = [1, 2, 3, 4, 5].map(k => `<li><b>${esc(t(`s3.kit.${k}.t`))}</b><span>${esc(t('s3.kit.' + k))}</span></li>`).join('');
  const cs = S.cases, over = caseDicts[lang];
  const ct = (k, f) => over?.cases?.[k.id]?.[f] || pick(k[f], 'en');
  const at = (a, f) => over?.asks?.[a.id]?.[f] || pick(a[f], 'en');
  $('cases-card').hidden = !cs?.cases?.length;
  $('asks-card').hidden = !cs?.asks?.length;
  if (cs?.cases?.length) {
    $('cases').innerHTML = cs.cases.map(k => `<div class="case"><h4>${esc(ct(k, 'place'))}</h4><dl>
      <dt>${esc(t('s3.cases.before'))}</dt><dd>${esc(ct(k, 'before'))}</dd>
      <dt>${esc(t('s3.cases.action'))}</dt><dd>${esc(ct(k, 'action'))}</dd>
      <dt>${esc(t('s3.cases.after'))}</dt><dd>${esc(ct(k, 'after'))}</dd></dl>
      <p class="src">${esc(t('s3.cases.sources'))}: ${(k.sources || []).map(s => link(s)).filter(Boolean).join(' · ')}</p></div>`).join('');
  }
  if (cs?.asks?.length) {
    $('policy-asks').innerHTML = cs.asks.map(a => `<li><b>${esc(at(a, 'title'))}.</b> ${esc(at(a, 'text'))}</li>`).join('');
  }
  renderLead();
}

// ------------------------------------------------------------ PDF downloads

/** Run a slow job behind a button: show that it is working, and say so if it fails. */
async function withButton(id, job) {
  const btn = $(id), label = btn.textContent;
  if (btn.getAttribute('aria-disabled') === 'true') return;
  btn.setAttribute('aria-disabled', 'true');
  btn.textContent = t('act.pdf.busy');
  try { await job(); } catch (err) { console.error(err); toast(t('act.pdf.fail')); }
  btn.textContent = label;
  btn.removeAttribute('aria-disabled');
}

/** The charts as pictures. The PDF helper misplaces live SVG, above all in right to left pages. */
async function chartPictures() {
  const out = [];
  for (const svg of $('sheet').querySelectorAll('.chart svg')) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const box = svg.viewBox.baseVal, c = document.createElement('canvas');
    c.width = box.width * 4; c.height = box.height * 4;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    out.push(c.toDataURL('image/png'));
  }
  return out;
}

async function downloadReport() {
  // the picture of the neighbourhood may still be drawing: give it a moment
  for (let k = 0; k < 60 && S.mapReady && !$('pic-wait').hidden; k++) await new Promise(r => setTimeout(r, 250));
  const charts = await chartPictures();
  let link = null;
  const canvas = await draw($('sheet'), {
    prepare: (doc, el) => {
      el.querySelectorAll('.chart svg').forEach((svg, i) => {
        const im = doc.createElement('img');
        im.src = charts[i];
        im.style.cssText = 'display:block;width:100%;height:auto';
        svg.replaceWith(im);
      });
      // where the address of the report sits, so it can be clicked in the PDF
      const a = el.querySelector('.brand small')?.getBoundingClientRect(), b = el.getBoundingClientRect();
      if (a && b.width) link = { x: (a.left - b.left) / b.width, y: (a.top - b.top) / b.width, w: a.width / b.width, h: a.height / b.width };
    },
  });
  const k = canvas.width;
  const blob = await build([canvas], {
    title: `${t('sheet.kicker')}: ${placeName(S.ui)}, ${countryName(S.ui)}`,
    links: link ? [{ page: 0, x: link.x * k, y: link.y * k, w: link.w * k, h: link.h * k, url: shareUrl() }] : [],
  });
  save(blob, `sinking-ground-${S.meta.id}-${S.lat.toFixed(4)}_${S.lng.toFixed(4)}.pdf`);
}

async function downloadLetter() {
  const paper = document.createElement('div');
  paper.className = 'letter-paper';
  paper.dir = RTL.has(S.letter.lang) ? 'rtl' : 'ltr';
  paper.lang = S.letter.lang;
  // One block per line of the letter. (As a single block of preformatted text
  // the PDF helper splits some Persian and Urdu words into unjoined letters.)
  // Long addresses get invisible break points so they wrap inside the page.
  for (const line of $('letter').value.split('\n')) {
    const div = document.createElement('div');
    div.textContent = line.replace(/https?:\/\/\S+/g, u => u.replace(/([\/&#=?])/g, '$1\u200b')) || '\u00a0';
    paper.append(div);
  }
  document.body.append(paper);
  try {
    const blob = await build(paginate(await draw(paper)), { title: buildLetter().subject });
    save(blob, `letter-${S.meta.id}.pdf`);
  } finally { paper.remove(); }
}

// ---------------------------------------------------------------- controls

function renderShare() {
  const url = shareUrl(), text = t('act.share.text', { place: placeName(S.ui) });
  const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text + ' ' + url)}`;
  // no point offering a Telegram button where Telegram does not open
  const tgWorks = S.city?.organising?.telegram_usable !== false;
  for (const id of ['share-tg', 'share-tg2']) { $(id).href = tg; $(id).hidden = !tgWorks; }
  $('share-wa2').classList.toggle('ghost', tgWorks);
  for (const id of ['share-wa', 'share-wa2']) $(id).href = wa;
}

function renderTools() {
  $('radius').innerHTML = RADII.map(r => `<button type="button" data-r="${r}" aria-pressed="${r === S.r}">${esc(metresText(S.ui, r))}</button>`).join('');
  $('year').innerHTML = HORIZONS.map(y => `<button type="button" data-y="${y}" aria-pressed="${y === S.year}">${esc(y === 'now' ? t('tools.year.now') : yearText(S.ui, y))}</button>`).join('');
}

function renderAll() {
  document.documentElement.lang = S.ui.lang;
  document.documentElement.dir = RTL.has(S.ui.lang) ? 'rtl' : 'ltr';
  document.title = t('page.title');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  $('back').href = `index.html#place=${S.meta.id}`;
  renderTools(); renderSheet(); renderAsks(); renderBodies(); renderCity(); renderOthers(); renderShare(); refreshLetter();
}

function writeHash() {
  history.replaceState(null, '', `#place=${S.meta.id}&lat=${S.lat.toFixed(5)}&lng=${S.lng.toFixed(5)}&r=${S.r}&lang=${S.ui.lang}`);
}

function setSpot(lng, lat) {
  if (S.place.index(lng, lat) < 0) { toast(t('tools.outside', { place: placeName(S.ui) })); return false; }
  S.lng = lng; S.lat = lat;
  S.A = null;
  analyse(); renderSheet(); renderShare(); renderLead(); refreshLetter(); placeMap(); writeHash();
  return true;
}

function wire() {
  $('radius').addEventListener('click', e => {
    const r = +e.target.dataset?.r;
    if (!r || r === S.r) return;
    S.r = r; S.A = null;
    analyse(); renderTools(); renderSheet(); renderShare(); renderLead(); refreshLetter(); placeMap(); writeHash();
  });
  $('year').addEventListener('click', e => {
    const y = e.target.dataset?.y;
    if (!y) return;
    S.year = y === 'now' ? 'now' : +y;
    renderTools(); renderSheet();
    if (S.mapReady) { drawRisk(); $('pic-wait').hidden = false; S.map.triggerRepaint(); }
  });
  $('pic').addEventListener('click', e => {
    if (!S.mapReady) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ll = S.map.unproject([((e.clientX - r.left) / r.width) * MAP_PX, ((e.clientY - r.top) / r.height) * MAP_PX]);
    setSpot(ll.lng, ll.lat);
  });
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast(t('tools.locate.fail'));
    toast(t('tools.locating'));
    navigator.geolocation.getCurrentPosition(
      pos => setSpot(pos.coords.longitude, pos.coords.latitude),
      () => toast(t('tools.locate.fail')), { enableHighAccuracy: true, timeout: 15000 });
  });
  $('pdf').addEventListener('click', () => withButton('pdf', downloadReport));
  $('l-pdf').addEventListener('click', () => withButton('l-pdf', downloadLetter));
  $('print').addEventListener('click', () => window.print());
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl()); toast(t('act.copied')); } catch { prompt('', shareUrl()); }
  };
  $('copy').addEventListener('click', copyLink);
  $('copy2').addEventListener('click', copyLink);

  $('asks').addEventListener('change', e => {
    if (e.target.name !== 'ask') return;
    S.ask = e.target.value; S.body = null;
    renderBodies(); refreshLetter();
  });
  $('bodies').addEventListener('click', e => {
    const id = e.target.dataset?.body;
    if (!id) return;
    S.body = id;
    renderBodies(); refreshLetter();
  });
  for (const id of ['you-name', 'you-address', 'you-contact']) $(id).addEventListener('input', refreshLetter);
  $('seen').addEventListener('change', refreshLetter);
  $('letter').addEventListener('input', () => {
    const lines = $('letter').value;
    const m = $('l-email').href.match(/^mailto:([^?]*)\?subject=([^&]*)/);
    if (m) $('l-email').href = `mailto:${m[1]}?subject=${m[2]}&body=${encodeURIComponent(lines)}`;
  });
  $('letter-lang').addEventListener('change', async e => {
    await dict(e.target.value);
    S.letter = ctx(e.target.value);
    refreshLetter();
  });
  $('l-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('letter').value); toast(t('s2.copied')); } catch { $('letter').select(); }
  });
  $('l-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([$('letter').value], { type: 'text/plain;charset=utf-8' }));
    a.download = `letter-${S.meta.id}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('l-print').addEventListener('click', () => {
    const pre = $('letter-print');
    pre.textContent = $('letter').value;
    pre.dir = RTL.has(S.letter.lang) ? 'rtl' : 'ltr';
    document.body.classList.add('print-letter');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-letter'));

  $('lang').addEventListener('change', async e => {
    await Promise.all([dict(e.target.value), caseDict(e.target.value)]);
    S.ui = ctx(e.target.value);
    renderAll(); writeHash();
  });
}

// --------------------------------------------------------------------- boot

async function json(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

async function boot() {
  const q = new URLSearchParams(location.hash.slice(1));
  await dict('en');
  S.ui = ctx('en');
  const fail = key => { const s = $('status'); s.textContent = t(key); s.classList.add('err'); };
  let index;
  try { index = await loadIndex(); } catch { return fail('error.load'); }
  const meta = (S.meta = index.places.find(p => p.id === q.get('place')));
  if (!meta) return fail('error.noplace');

  const [city, cases, langs] = await Promise.all([
    json(`action/cities/${meta.id}.json`), json('action/cases.json'), json('action/i18n/index.json'),
  ]);
  S.city = city; S.cases = cases;
  S.langs = Array.isArray(langs) && langs.length ? langs : [{ code: 'en', name: 'English' }];
  const have = code => S.langs.some(l => l.code === code);

  // interface language: asked for, else the city's own, else the browser's
  const wanted = [q.get('lang'), ...(city?.languages || []), (navigator.language || '').slice(0, 2), 'en'].find(c => c && have(c));
  await Promise.all([dict(wanted), caseDict(wanted)]);
  S.ui = ctx(dicts[wanted] ? wanted : 'en');
  $('lang').innerHTML = S.langs.map(l => `<option value="${esc(l.code)}" ${l.code === S.ui.lang ? 'selected' : ''}>${esc(l.name)}</option>`).join('');

  // letter language: the city's first language we have, else the interface language
  const letterLangs = [...new Set([...(city?.languages || []).filter(have), S.ui.lang, 'en'])];
  await Promise.all(letterLangs.map(dict));
  S.letter = ctx(letterLangs.find(c => dicts[c]) || 'en');
  $('letter-lang').innerHTML = letterLangs.filter(c => dicts[c])
    .map(c => `<option value="${esc(c)}" ${c === S.letter.lang ? 'selected' : ''}>${esc(dicts[c]._name || c)}</option>`).join('');

  try {
    S.place = await loadPlace(meta);
    S.place.setFrames(await loadFrames(meta));
  } catch { return fail('error.load'); }

  const lat = parseFloat(q.get('lat')), lng = parseFloat(q.get('lng'));
  const start = isFinite(lat) && isFinite(lng) && S.place.index(lng, lat) >= 0 ? [lng, lat] : S.place.hot || [meta.lon, meta.lat];
  [S.lng, S.lat] = start;
  if (RADII.includes(+q.get('r'))) S.r = +q.get('r');

  analyse();
  $('status').hidden = true;
  $('main').hidden = false;
  renderAll();
  wire();
  writeHash();
  initMap();
  window.takeAction = { S, setSpot };
}

boot();
