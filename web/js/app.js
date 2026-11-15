// Sinking Ground: a globe of places where NISAR sees the ground going down,
// a time bar to scrub through measured and projected sinking, and buildings
// coloured by the strain the ground under them has built up.
// The screen is the map; controls are small panes of glass along its edges.

import * as maplibregl from '../vendor/maplibre-gl.mjs';
import {
  EARLIER, EARLIER_DEFAULT, END_YEAR, LIMITS, RISK, SINK_DECADES, SINK_MIN_MM, YEAR,
  fmtDate, fmtMonth, fmtRate, fmtSunk, rampCSS, sinkCSS, sinkLUT, sinkU,
} from './config.js';
import { ATTRIBUTION, BASES, UNDER_LABELS, baseStyle } from './basemap.js';
import { hotBefore, hotSunk, loadFrames, loadIndex, loadPlace, placesAt } from './data.js';
import { areaAt, areaById, areaMeta, askArea, geocode } from './areas.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Building outlines: Google Open Buildings + Microsoft + OpenStreetMap, merged
// by VIDA and served as one PMTiles archive (read with HTTP range requests).
const BLDG_URL = 'pmtiles://https://data.source.coop/vida/google-microsoft-osm-open-buildings/pmtiles/goog_msft_osm.pmtiles';
const BLDG = { source: 'bldg', sourceLayer: 'goog_msft_osm_building_footprints' };
const BLDG_MIN_ZOOM = 13.5;
const narrow = () => window.innerWidth <= 760;
// room the pane on the right takes from the map on wide screens
const PANE = 392;
// keep the globe clear of the panes
const globePad = () => (narrow()
  ? { top: 30, bottom: 110, left: 0, right: 0 }
  : { top: 0, bottom: 90, left: 0, right: ui.panel === 'none' ? 0 : PANE });
// the whole globe, sized to the free part of the window (it is about 610 px
// across at zoom 2.1); on a phone it may run past the sides
function globeView() {
  const pad = globePad();
  const high = window.innerHeight - pad.top - pad.bottom, wide = window.innerWidth - pad.left - pad.right;
  const across = narrow() ? Math.min(high * 0.9, wide * 1.35) : Math.min(high, wide) * 0.96;
  return { center: [-75, 18], zoom: Math.max(1, 2.1 + Math.log2(Math.max(240, across) / 610)), pitch: 0, bearing: 0 };
}

const state = {
  mode: 'sink',     // 'sink': how far the ground has sunk, 'risk': damage risk classes
  earlier: EARLIER_DEFAULT,   // uneven sinking from before NISAR: an id from EARLIER
  base: 'satellite', // 'satellite': real imagery, 'night': dark map with city lights
  index: null,
  meta: null,       // selected place (index entry)
  place: null,      // its loaded PlaceData
  time: 0,
  loadToken: 0,
};

// which pane is open on the right ('none', 'finder': the list of places,
// 'place': the selected place), and whether the list should come back when a
// place is closed
const ui = { panel: 'none', pinned: false };

/** Other features (for example a "contact your authority" flow) can listen for
 *  sinkingground:place, sinkingground:inspect and sinkingground:time on document. */
function emit(name, detail) {
  document.dispatchEvent(new CustomEvent('sinkingground:' + name, { detail }));
}

function toast(text, ms = 0) {
  const el = $('toast');
  el.textContent = text || '';
  el.hidden = !text;
  clearTimeout(toast.timer);
  if (text && ms) toast.timer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------- map setup

if (window.pmtiles) maplibregl.addProtocol('pmtiles', new window.pmtiles.Protocol().tile);

const map = new maplibregl.Map({
  container: 'map',
  style: baseStyle(readHash().base),
  ...globeView(),
  minZoom: 1,
  maxPitch: 70,
  attributionControl: false,   // credits are in the line along the bottom
});
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-right');
map.on('error', e => console.warn('map:', e.error?.message || e));

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
const LUT = sinkLUT();
// risk class colours packed for the canvas (little endian ABGR)
const RISK_PX = RISK.map((r, i) => {
  const v = parseInt(r.color.slice(1), 16);
  const a = [0, 105, 220, 232, 242][i];
  return ((a << 24) | ((v & 255) << 16) | (((v >> 8) & 255) << 8) | (v >> 16)) >>> 0;
});
let image = null, pixels = null;

function addLayers() {
  // outline of the area we have data for
  map.addSource('extent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'extent', type: 'line', source: 'extent',
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': 1, 'line-dasharray': [3, 3] },
  }, UNDER_LABELS);

  // buildings, coloured through feature state by updateBuildings()
  if (window.pmtiles) {
    map.addSource(BLDG.source, { type: 'vector', url: BLDG_URL, minzoom: 12 });
    map.addLayer({
      id: 'bldg', type: 'fill-extrusion', source: BLDG.source, 'source-layer': BLDG.sourceLayer, minzoom: BLDG_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': ['match', ['coalesce', ['feature-state', 'risk'], 0],
          1, RISK[1].color, 2, RISK[2].color, 3, RISK[3].color, 4, RISK[4].color, '#46505f'],
        // heights are not in the data: one modest height for every building
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], BLDG_MIN_ZOOM, 0, 15, 7],
        'fill-extrusion-opacity': 0.93,
      },
    }, UNDER_LABELS);
  }

  // one bubble per place
  map.addSource('places', { type: 'geojson', data: placesGeoJSON() });
  const detected = ['==', ['get', 'detected'], 1];
  // a soft shadow keeps the bubbles readable on bright ground
  map.addLayer({
    id: 'places-shadow', type: 'circle', source: 'places', maxzoom: 9.5,
    paint: { 'circle-radius': ['+', ['get', 'r'], 5], 'circle-color': '#000000', 'circle-opacity': ['case', detected, 0.4, 0.25], 'circle-blur': 0.7 },
  });
  map.addLayer({
    id: 'places-dot', type: 'circle', source: 'places', maxzoom: 9.5,
    paint: {
      'circle-radius': ['get', 'r'],
      'circle-color': ['case', detected, ['get', 'color'], '#ffffff'],
      'circle-opacity': ['case', detected, 0.86, 0.14],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': ['case', detected, 1, 0.9],
      'circle-stroke-width': ['case', detected, 1.6, 1.4],
    },
  });
  // measured places with nothing detected yet: a ring and a quieter name.
  // Added below the other labels so those win where they overlap.
  map.addLayer({
    id: 'places-label-quiet', type: 'symbol', source: 'places', maxzoom: 9.5, filter: ['!', detected],
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': ['get', 'ro'],
      'text-justify': 'auto',
    },
    paint: { 'text-color': 'rgba(255,255,255,0.78)', 'text-halo-color': 'rgba(8,12,18,0.85)', 'text-halo-width': 1.4, 'text-halo-blur': 0.5 },
  });
  map.addLayer({
    id: 'places-label', type: 'symbol', source: 'places', maxzoom: 9.5, filter: detected,
    layout: {
      'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['get', 'label'], { 'font-scale': 0.9, 'text-font': ['literal', ['Noto Sans Regular']] }],
      'text-font': ['Noto Sans Bold'], 'text-size': 13, 'text-line-height': 1.2,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': ['get', 'ro'],
      'text-justify': 'auto', 'symbol-sort-key': ['-', 0, ['get', 'sunk']],
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(8,12,18,0.85)', 'text-halo-width': 1.5, 'text-halo-blur': 0.5 },
  });

  map.on('click', 'places-dot', e => { selectPlace(e.features[0].properties.id); e.preventDefault(); });
  map.on('mouseenter', 'places-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'places-dot', () => { map.getCanvas().style.cursor = ''; hover.remove(); });
  map.on('mousemove', 'places-dot', e => {
    const p = byId(e.features[0].properties.id);
    hover.setLngLat([p.lon, p.lat]).setHTML(
      `<div class="pop hover"><h4>${p.name}</h4>${p.detected
        ? `<div>Fastest zone sinking ${fmtRate(p.hotRate)}</div>`
        : `<div>Measured for ${p.months} months. Nothing sinking faster than ${fmtRate(p.threshold_mm_yr)} yet</div>`}</div>`).addTo(map);
  });
  map.on('click', inspect);
  map.on('idle', scanBuildings);
  map.on('zoom', updateLegend);
}

const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 16, className: 'tip' });
const popup = new maplibregl.Popup({ maxWidth: '300px', focusAfterOpen: false, offset: 10 });
const byId = id => state.index.places.find(p => p.id === id);

function placesGeoJSON() {
  const t = state.time, since = earlierSince();
  return {
    type: 'FeatureCollection',
    features: state.index.places.filter(p => p !== state.meta).map(p => {
      const sunk = hotSunk(p, t) + hotBefore(p, since);
      const r = p.detected ? 5 + 21 * sinkU(sunk) : 4.2;
      return {
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id, name: p.name, detected: p.detected ? 1 : 0, sunk, r, ro: r / 13 + 0.4,
          color: sinkCSS(Math.max(sunk, SINK_MIN_MM + 1)),
          label: sunk > 1 ? fmtSunk(sunk) : fmtRate(p.hotRate).replace(' per year', '/yr'),
        },
      };
    }),
  };
}

// ------------------------------------------------------------ ground overlay

function addOverlay(place) {
  removeOverlay();
  canvas.width = place.W; canvas.height = place.H;
  image = ctx.createImageData(place.W, place.H);
  pixels = new Uint32Array(image.data.buffer);
  const [w, s, e, n] = place.meta.bounds;
  map.addSource('sink', { type: 'canvas', canvas, animate: false, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
  map.addLayer({
    id: 'sink', type: 'raster', source: 'sink',
    paint: {
      'raster-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.9, 13, 0.8, 15.5, 0.55],
      'raster-fade-duration': 0, 'raster-resampling': 'linear',
    },
  }, 'extent');
  map.getSource('extent').setData({
    type: 'Feature', geometry: { type: 'LineString', coordinates: [[w, n], [e, n], [e, s], [w, s], [w, n]] },
  });
}

function removeOverlay() {
  if (map.getLayer('sink')) map.removeLayer('sink');
  if (map.getSource('sink')) map.removeSource('sink');
  map.getSource('extent')?.setData({ type: 'FeatureCollection', features: [] });
}

function drawOverlay() {
  const place = state.place;
  if (!place || !map.getSource('sink')) return;
  const y = place.years(state.time), ye = place.earlierYears();
  const { n, rate, alpha } = place;
  if (state.mode === 'risk') {
    const ys = place.strainYears(state.time);
    for (let i = 0; i < n; i++) pixels[i] = alpha[i] > 128 ? RISK_PX[place.classAt(i, ys)] : 0;
  } else if (y <= 0 && !ye) {
    pixels.fill(0);
  } else {
    const { a, b, w } = place.blend(y);
    const half = SINK_MIN_MM / 2, k = 255 / SINK_DECADES, yt = Math.max(0, y) + ye;
    for (let i = 0; i < n; i++) {
      const al = alpha[i];
      if (!al) { pixels[i] = 0; continue; }
      let d = rate[i] * yt;
      if (a) d += (1 - w) * a[i] + w * b[i];
      const s = -d;
      if (s <= half) { pixels[i] = 0; continue; }
      let j = 0, fade = 1;
      if (s < SINK_MIN_MM) fade = (s - half) / half;
      else { j = (Math.log10(s / SINK_MIN_MM) * k) | 0; if (j > 255) j = 255; }
      j <<= 2;
      const A = (LUT[j + 3] * al * fade / 255) | 0;
      pixels[i] = (A << 24) | (LUT[j + 2] << 16) | (LUT[j + 1] << 8) | LUT[j];
    }
  }
  ctx.putImageData(image, 0, 0);
  const src = map.getSource('sink');
  src.play(); src.pause();     // push the canvas to the GPU once
}

// ----------------------------------------------------------------- buildings

const B = { where: new Map(), cls: new Map(), ids: [] };

function centroid(g) {
  const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
  if (!ring || ring.length < 3) return null;
  let x = 0, y = 0;
  const m = ring.length - 1;
  for (let i = 0; i < m; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / m, y / m];
}

function scanBuildings() {
  const place = state.place;
  if (!place || !map.getLayer('bldg') || map.getZoom() < BLDG_MIN_ZOOM) {
    B.ids = [];
    $('bldg-bars').hidden = true; $('bldg-hint').hidden = false;
    return;
  }
  const seen = new Set();
  for (const f of map.querySourceFeatures(BLDG.source, { sourceLayer: BLDG.sourceLayer })) {
    const id = f.id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    if (!B.where.has(id)) {
      const c = centroid(f.geometry);
      B.where.set(id, c ? place.index(c[0], c[1]) : -1);
    }
  }
  B.ids = [...seen];
  updateBuildings();
}

function updateBuildings() {
  const place = state.place;
  if (!place || !B.ids.length) return;
  const y = place.strainYears(state.time);
  const counts = [0, 0, 0, 0, 0];
  for (const id of B.ids) {
    const c = place.classAt(B.where.get(id), y);
    counts[c]++;
    if (B.cls.get(id) !== c) {
      B.cls.set(id, c);
      map.setFeatureState({ source: BLDG.source, sourceLayer: BLDG.sourceLayer, id }, { risk: c });
    }
  }
  $('bldg-hint').hidden = true;
  const ul = $('bldg-bars');
  ul.hidden = false;
  ul.innerHTML = RISK.map((r, i) =>
    `<li><span class="k"><i class="sw" style="background:${r.color}"></i>${r.short}</span><span class="v">${counts[i].toLocaleString()}</span></li>`).join('');
}

function clearBuildings() {
  if (map.getSource(BLDG.source)) map.removeFeatureState(BLDG);
  B.where.clear(); B.cls.clear(); B.ids = [];
}

// ---------------------------------------------------------- click to inspect

/** Address of the take action page: report, letter and neighbours for one spot. */
function actUrl(id, lng, lat) {
  return `act.html#place=${id}` + (lng == null ? '' : `&lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`)
    + (state.earlier === EARLIER_DEFAULT ? '' : `&earlier=${state.earlier}`);
}

/** Point the panel's take action button at a place, or at one spot in it. */
let actSpot = null;
function setActLink(id, lng, lat) {
  actSpot = [id, lng, lat];
  $('place-act').href = actUrl(id, lng, lat);
  $('place-org').href = `organise.html#${encodeURIComponent(id)}`;
}

const END = Date.UTC(END_YEAR, 11, 31);

/** The year uneven sinking is assumed to go back to, or null: first radar pass. */
const earlierSince = () => EARLIER.find(e => e.id === state.earlier).since;

/** Apply the setting to the loaded place. Earlier sinking is only assumed where
 *  sinking is detected over at least 1 km2. The small spots in other places can
 *  be earthworks or landfill, which have not been sinking like that for decades. */
function applyEarlier() {
  const place = state.place;
  place?.setEarlier(place.meta.detected ? earlierSince() : null);
  const since = place?.earlier ?? null;
  $('legend-note').hidden = since == null;
  $('legend-note').textContent = since == null ? ''
    : `Sinking and damage classes count sinking from before NISAR too, assumed at today's rate since ${since}.`;
}

/** When a limit is passed, given how many years of uneven sinking it takes. */
function whenText(place, yrs) {
  if (!isFinite(yrs)) return 'not at this rate';
  const ms = place.strainT0 + yrs * YEAR;
  if (ms > END) return `after ${END_YEAR}`;
  if (ms < place.meta.t0) return 'passed before NISAR began';   // only with earlier sinking counted
  return (ms <= state.time ? 'passed ' : 'around ') + fmtMonth(ms);
}

const limitText = (place, i, limit) => whenText(place, place.yearsToLimit(i, limit));

function inspect(e, label) {
  if (e.defaultPrevented) return;
  const place = state.place;
  if (!place) return;
  const { lng, lat } = e.lngLat;
  const i = place.index(lng, lat);
  if (i < 0) return;
  const m = place.meta, y = place.years(state.time);
  const valid = place.flags[i] & 1, sig = place.flags[i] & 2;
  const cls = place.classAt(i, place.strainYears(state.time));
  const sunk = place.sunkAt(i, y);
  const since = place.earlier;
  const proj = state.time > m.t1;
  let html = `<div class="pop">${label ? `<div class="pop-addr">${esc(label)}</div>` : ''}<div class="cls"><i class="sw" style="background:${RISK[cls].color}"></i>${RISK[cls].label}</div>`;
  if (!valid) {
    html += `<div class="note">No reliable radar signal here. Water, farmland, vegetation and steep ground are left out.</div>`;
  } else if (!sig && !place.beta[i]) {
    html += `<div class="row"><span>Sinking rate</span><span>below ${m.threshold_mm_yr} mm per year</span></div>
      <div class="note">Nothing detected here so far. Slower sinking than the limit above cannot be ruled out.</div>`;
  } else {
    html += (sig
      ? `<div class="row"><span>Sinking rate</span><span>${fmtRate(place.rate[i])}</span></div>`
        + (since == null ? ''
          : `<div class="row"><span>${proj ? 'Would have sunk since ' + since + ' by ' + fmtMonth(state.time) : 'Sunk since ' + since + ' (estimate)'}</span><span>${fmtSunk(sunk + place.beforeAt(i))}</span></div>`)
        + `<div class="row"><span>${since != null ? 'Measured by NISAR since ' + fmtDate(m.t0) : proj ? 'Would have sunk by ' + fmtMonth(state.time) : 'Sunk by ' + fmtDate(state.time)}</span><span>${fmtSunk(since != null ? place.sunkAt(i, Math.min(y, place.years(m.t1))) : sunk)}</span></div>`
      : `<div class="row"><span>Sinking rate</span><span>below ${m.threshold_mm_yr} mm per year</span></div>
      <div class="row"><span>Position</span><span>rim of a sinking zone</span></div>`) + `
      <div class="row"><span>Cracking limit (1/500)</span><span>${limitText(place, i, LIMITS.cracking)}</span></div>
      <div class="row"><span>Structural limit (1/150)</span><span>${limitText(place, i, LIMITS.structural)}</span></div>
      <div class="note">${since == null ? `Counted from the first radar pass on ${fmtDate(m.t0)}.`
        : `Sinking and the damage limits also count the years before NISAR, assumed at today's rate since ${since}. That part is an estimate.`} One radar pixel is 80 m wide: a screening estimate, not a building inspection.</div>`;
  }
  state.spot = [lng, lat];
  html += `<a class="pop-act" href="${actUrl(m.id, lng, lat)}">Take action for this spot</a>`;
  // above the pin when it is opened for an address, so the pin stays in sight
  popup.setOffset(label ? { top: [0, 10], bottom: [0, -46], left: [16, -22], right: [-16, -22] } : 10);
  popup.setLngLat(e.lngLat).setHTML(html + '</div>').addTo(map);
  setActLink(m.id, lng, lat);
  emit('inspect', {
    place: m.id, lng, lat, valid: !!valid, detected: !!sig, riskClass: cls,
    rate_mm_per_year: valid ? place.rate[i] : null, sunk_mm: sunk, time: state.time, projected: proj,
    earlierSince: since, sunk_before_mm: place.beforeAt(i),
  });
}

// ------------------------------------------------- panes on the right side

function setPanel(which) {
  ui.panel = which;
  document.body.dataset.panel = which;
  $('finder').hidden = which !== 'finder';
  $('place').hidden = which !== 'place';
  const b = $('finder-open'), open = which === 'finder';
  b.classList.toggle('open', open);
  b.setAttribute('aria-expanded', String(open));
  b.setAttribute('aria-label', open ? 'Close the list of places' : 'Search places');
}

function toggleFinder() {
  const open = ui.panel !== 'finder';
  if (!state.meta) ui.pinned = open;
  setPanel(open ? 'finder' : state.meta ? 'place' : 'none');
  if (open && !narrow()) $('search').focus();
  if (!state.meta && !narrow()) { stopSpin(); map.easeTo({ padding: globePad(), duration: 500 }); }
}

function buildList() {
  const places = [...state.index.places].sort((a, b) => a.hotRate - b.hotRate || a.name.localeCompare(b.name));
  const row = p => `
    <li data-q="${(p.name + ' ' + p.country).toLowerCase()}"><button type="button" data-id="${p.id}">
      <span class="nm">${p.name}<span class="ct">, ${p.country}</span></span>
      ${p.detected
        ? `<span class="rt">${p.early ? '<small title="Only a few months of radar passes so far">early</small>' : ''}${fmtRate(p.hotRate).replace(' per year', '/yr')}</span>`
        : `<span class="rt none">${p.months} mo of data</span>`}
    </button></li>`;
  const yes = places.filter(p => p.detected), no = places.filter(p => !p.detected);
  const list = $('places');
  list.innerHTML = `
    <h3 class="places-head">Sinking detected</h3><ol>${yes.map(row).join('')}</ol>
    <h3 class="places-head">Nothing detected yet</h3><ol>${no.map(row).join('')}</ol>
    <p class="empty" hidden>No place matches that.</p>
    <p class="fine">Rates are for the fastest zone in each place. Places with only a few months of passes can only show fast sinking so far.</p>`;
  $('list-note').textContent = `${places.length} measured by NISAR, ${yes.length} with sinking detected`;
  list.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) selectPlace(b.dataset.id);
  });
  const rows = [...list.querySelectorAll('li')], heads = [...list.querySelectorAll('.places-head')];
  const filter = () => {
    const q = $('search').value.trim().toLowerCase();
    for (const li of rows) li.hidden = !!q && !li.dataset.q.includes(q);
    for (const h of heads) h.hidden = !h.nextElementSibling.querySelector('li:not([hidden])');
    list.querySelector('.empty').hidden = rows.some(li => !li.hidden);
  };
  const offer = () => {
    const q = $('search').value.trim();
    $('addr-find').hidden = $('addr-note').hidden = q.length < 2;
    $('addr-q').textContent = `“${q}”`;
  };
  $('search').addEventListener('input', () => { filter(); offer(); });
  $('search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const first = rows.find(li => !li.hidden);
    if (first) selectPlace(first.firstElementChild.dataset.id);
    else findAddress($('search').value);
  });
  $('addr-find').addEventListener('click', () => findAddress($('search').value));
}

function drawChart() {
  const m = state.meta, svg = $('chart');
  if (!m || !m.detected) { svg.innerHTML = ''; svg.style.display = 'none'; $('chart-note').hidden = true; return; }
  svg.style.display = '';
  const W = 300, H = 96, T = 14, Bm = 4, ih = H - T - Bm;
  const end = Date.UTC(END_YEAR, 11, 31);
  const max = hotSunk(m, end), now = hotSunk(m, m.t1);
  const since = m.detected ? earlierSince() : null, before = hotBefore(m, since);
  const X = ms => timeline.frac(ms) * W;
  // The time bar gives the measured months a share of the width far larger
  // than their share of the years to 2050. The height axis gets the same
  // share below the amount sunk so far, so the line keeps one slope for one
  // rate and the projection carries straight on from the measured record.
  const f = timeline.frac(m.t1);
  const u = now > 0.5 && max > now
    ? mm => (mm <= now ? (f * Math.max(0, mm)) / now : f + ((1 - f) * (mm - now)) / (max - now))
    : mm => Math.max(0, mm) / max;
  const Y = mm => T + ih * (1 - u(mm));
  const meas = m.dates.map((d, k) => [X(m.t0 + m.t_years[k] * YEAR), Y(-m.hot_series_mm[k])]);
  const proj = [];
  for (let k = 0; k <= 40; k++) { const ms = m.t1 + (k / 40) * (end - m.t1); proj.push([X(ms), Y(hotSunk(m, ms))]); }
  const path = pts => pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const xNow = X(m.t1);
  svg.innerHTML = `
    <path d="${path(meas)}L${xNow} ${H - Bm}L${meas[0][0]} ${H - Bm}Z" fill="rgba(255,255,255,0.16)"/>
    <path d="${path(proj)}L${W} ${H - Bm}L${xNow} ${H - Bm}Z" fill="rgba(255,179,64,0.13)"/>
    <line x1="0" x2="${W}" y1="${H - Bm}" y2="${H - Bm}" stroke="rgba(255,255,255,0.18)"/>
    <path d="${path(meas)}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
    <path d="${path(proj)}" fill="none" stroke="#ffb340" stroke-width="2" stroke-dasharray="1 5" stroke-linecap="round"/>
    <line x1="${xNow}" x2="${xNow}" y1="${T - 2}" y2="${H - Bm}" stroke="rgba(255,255,255,0.3)"/>
    <text x="${xNow - 6}" y="9" text-anchor="end">Measured</text>
    <text x="${xNow + 6}" y="9">Projected</text>
    <text x="${xNow - 8}" y="${Y(now) - 8}" text-anchor="end" style="fill:#ffffff">${fmtSunk(now + before)}</text>
    <text x="${W - 9}" y="${H - Bm - 6}" text-anchor="end" style="fill:#ffb340">${fmtSunk(max + before)} by ${END_YEAR}</text>
    <line id="chart-x" y1="${T - 2}" y2="${H - Bm}" stroke="#0a84ff" stroke-width="2"/>
    <circle id="chart-dot" r="4.5" fill="#0a84ff" stroke="#ffffff" stroke-width="1.5"/>`;
  svg.setAttribute('aria-label', `Sinking of the fastest zone: ${fmtSunk(now)} measured from ${fmtMonth(m.t0)} to ${fmtMonth(m.t1)}, `
    + `${fmtSunk(max)} by ${END_YEAR} if the same rate continues`
    + (before ? `, plus ${fmtSunk(before)} estimated before NISAR since ${since}.` : '.') + ' The measured months are drawn larger on both axes.');
  $('chart-note').hidden = !before;
  $('chart-note').textContent = before
    ? `The line starts at ${fmtSunk(before)}: the sinking estimated from ${since} to ${fmtMonth(m.t0)} at the rate measured now.` : '';
  svg._X = X; svg._Y = Y;
}

function updatePanel() {
  const m = state.meta;
  if (!m) return;
  const t = state.time, proj = t > m.t1;
  const meas = hotSunk(m, t), since = m.detected ? earlierSince() : null, before = hotBefore(m, since);
  const sunk = meas + before;
  $('place-big').classList.toggle('text', !m.detected);
  if (!m.detected) {
    $('place-big').textContent = 'No sinking detected';
    $('place-big-label').textContent = m.sinking_area_km2 > 0
      ? `No built up land sinking faster than ${m.threshold_mm_yr} mm per year over 1 km² or more, in ${m.months} months of radar passes. `
        + `${m.sinking_area_km2} km² of sinking is marked on the map, ${m.builtup_sinking_km2 ?? 0} km² of it under built up land; `
        + `the rest is bare ground, farm edges, pits, mines or landfill.`
      : `Nothing faster than ${m.threshold_mm_yr} mm per year over a wide area in ${m.months} months of radar passes. Slower sinking may show up as more passes arrive.`;
  } else if (t <= m.t0 && !before) {
    $('place-big').textContent = '0 cm';
    $('place-big-label').textContent = `Radar passes here start on ${fmtDate(m.t0)}.`;
  } else if (before) {
    $('place-big').textContent = fmtSunk(sunk);
    $('place-big-label').textContent = (proj
      ? `How far the fastest zone would have sunk since ${since} by ${fmtMonth(t)} if the current rate continues.`
      : `How far the fastest zone has sunk since ${since}.`)
      + ` NISAR measured ${fmtSunk(Math.min(meas, hotSunk(m, m.t1)))} of it from ${fmtDate(m.t0)} to ${fmtDate(Math.min(t, m.t1))};`
      + ` the ${fmtSunk(before)} before that is an estimate at the rate measured now.`;
  } else {
    $('place-big').textContent = fmtSunk(sunk);
    $('place-big-label').textContent = proj
      ? `How far the fastest zone would have sunk by ${fmtMonth(t)} if the current rate continues (counted from ${fmtDate(m.t0)}).`
      : `How far the fastest zone has sunk between ${fmtDate(m.t0)} and ${fmtDate(t)} (measured).`;
  }
  const svg = $('chart');
  if (svg._X && m.detected) {
    const x = svg._X(Math.max(t, m.t0)), y = svg._Y(meas);
    $('chart-x')?.setAttribute('x1', x); $('chart-x')?.setAttribute('x2', x);
    $('chart-dot')?.setAttribute('cx', x); $('chart-dot')?.setAttribute('cy', y);
  }
  const place = state.place;
  updateSpot();
  if (place && m.detected) {
    const a = place.areaByClass(place.strainYears(t), 5);
    $('strain').hidden = false;
    $('strain-bars').innerHTML = [2, 3, 4].map((i, k) => {
      const when = whenText(place, place.yearsToFirstPass(STRAIN_LIMITS[k])).replace(/^(passed|around) /, 'first $1 ');
      return `<li><span class="k"><i class="sw" style="background:${RISK[i].color}"></i>${RISK[i].short}</span><span class="v">${fmtArea(a[i])}</span>
        <span class="when">${when}</span></li>`;
    }).join('');
    $('strain-note').textContent = strainNote(place, a);
  } else {
    $('strain').hidden = true;
  }
}

const STRAIN_LIMITS = [LIMITS.cracking, LIMITS.damage, LIMITS.structural];
const fmtArea = v => (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' km²';
const pastLimits = a => a[2] + a[3] + a[4];
const endArea = new WeakMap();    // built up land past the limits at the end of the time bar

/** What the rows rest on. With earlier sinking counted they are an estimate,
 *  and say so. Without it they count from the first radar pass, which no
 *  record is long enough for yet, so the honest answer is "none so far". */
function strainNote(place, a) {
  const m = place.meta, since = place.earlier;
  const first = place.yearsToFirstPass(LIMITS.cracking);
  if (!isFinite(first)) {
    return 'Uneven sinking does not stand clear of the noise on built up land here yet. Longer records lower the noise.';
  }
  if (since != null) {
    return `Estimate. The radar has watched this place since ${fmtDate(m.t0)}. These areas assume the uneven sinking it measures now was already going on at the same rate since ${since}.`
      + (m.early ? ` With only ${m.months} months of passes that rate is still rough.` : '');
  }
  const pass = `the first radar pass on ${fmtDate(m.t0)}`;
  if (pastLimits(a) >= 0.05) return `Counted from ${pass}. Strain from earlier sinking is not included.`;
  if (m.t0 + first * YEAR > END) {
    return `Uneven sinking is counted from ${pass}. What is measured here so far is too gentle to pass a limit before ${END_YEAR}.`;
  }
  if (!endArea.has(place)) endArea.set(place, pastLimits(place.areaByClass((END - m.t0) / YEAR, 5)));
  return `Uneven sinking is counted from ${pass}, so no ground has had time to pass a limit yet. `
    + `If the measured rate continues, ${fmtArea(endArea.get(place))} of built up land is past the cracking limit by ${END_YEAR}.`;
}

function showPanel(m) {
  setPanel('place');
  const spot = addr.spot?.place === m.id ? addr.spot : null;
  $('place-name').textContent = m.area && spot?.short ? `Around ${spot.short}` : m.name;
  $('place-sub').innerHTML = [m.area ? 'Measured for an address' : esc(m.country), m.detected ? 'Sinking detected' : 'No sinking detected']
    .filter(Boolean).join(' · ')
    + (m.early ? ` · <span class="early">Early result, ${m.months} months of data</span>` : '');
  $('spot').hidden = !spot;
  $('place-spot-label').textContent = spot ? spot.label : '';
  $('st-rate').textContent = m.detected ? fmtRate(m.hotRate) : 'none detected';
  $('st-area').textContent = m.detected ? `${m.sinking_area_km2.toLocaleString()} km²` : '0 km²';
  $('st-built').textContent = `${(m.builtup_sinking_km2 ?? 0).toLocaleString()} km²`;
  $('st-thr').textContent = `${m.threshold_mm_yr} mm per year`;
  $('st-span').textContent = `${m.dates.length} dates, ${m.tracks.length} ${m.tracks.length > 1 ? 'directions' : 'direction'}`;
  $('st-rec').textContent = `${fmtMonth(m.t0)} to ${fmtMonth(m.t1)}`;
  $('place-driver').textContent = m.driver ? `Main cause reported for this area: ${m.driver.toLowerCase()}.` : '';
  $('place-hot').hidden = !m.detected;
  setActLink(m.id);
  $('place').querySelector('.scroll').scrollTop = 0;
  for (const b of $('places').querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.id === m.id));
}

// ------------------------------------------------------------ select a place

async function selectPlace(id, opts = {}) {
  const m = byId(id);
  if (!m) return;
  const token = ++state.loadToken;
  popup.remove(); hover.remove();
  // opts.spot: { lng, lat, label, short }, the address it is opened for
  if (opts.spot) setSpot({ ...opts.spot, place: m.id }); else if (addr.spot?.place !== m.id) unpin();
  clearBuildings();
  removeOverlay();
  state.meta = m; state.place = null;
  applyEarlier();
  stopSpin();
  showPanel(m);
  timeline.setRange(m.t0, m.t1, m.dates.map(d => Date.parse(d + 'T00:00:00Z')));
  drawChart(); updatePanel(); updateLegend();
  map.getSource('places')?.setData(placesGeoJSON());
  const [w, s, e, n] = m.bounds;
  if (opts.fly !== false && opts.spot) {
    flyToSpot(opts.spot, 2600);
  } else if (opts.fly !== false) {
    map.fitBounds([[w, s], [e, n]], { padding: placePad(), pitch: 0, bearing: 0, duration: 2600, essential: true });
  }
  toast(`Loading ${m.name}…`);
  try {
    const place = await loadPlace(m);
    if (token !== state.loadToken) return;
    state.place = place;
    applyEarlier();
    addOverlay(place);
    drawOverlay(); updatePanel(); scanBuildings();
    toast('');
    if (addr.spot?.place === m.id) showSpot();
    emit('place', { id: m.id, name: m.name, country: m.country, detected: m.detected });
    const frames = await loadFrames(m);
    if (token !== state.loadToken) return;
    place.setFrames(frames);
    drawOverlay();
  } catch (err) {
    console.error(err);
    if (token === state.loadToken) toast(`Could not load ${m.name}: ${err.message}`, 6000);
  }
  writeHash();
}

function deselect() {
  state.loadToken++;
  popup.remove();
  unpin();
  clearBuildings(); removeOverlay();
  state.meta = null; state.place = null;
  applyEarlier();
  setPanel(ui.pinned ? 'finder' : 'none');
  updateLegend();
  for (const b of $('places').querySelectorAll('button')) b.removeAttribute('aria-current');
  globalRange();
  map.getSource('places')?.setData(placesGeoJSON());
  map.flyTo({ ...globeView(), center: map.getCenter(), padding: globePad(), duration: 2200, essential: true });
  writeHash();
}

function globalRange() {
  const ps = state.index.places;
  timeline.setRange(Math.min(...ps.map(p => p.t0)), Math.max(...ps.map(p => p.t1)));
}

// ------------------------------------------------------------ addresses
// Typed in the search field. A stored place that covers the address opens at
// it. Elsewhere the area around it is measured on request (see areas.js), and
// opens at the address once it is ready.

const addr = {
  marker: null,      // pin on the address
  spot: null,        // { lng, lat, label, short, place }: the address the open place was opened for
  token: 0,          // the newest lookup; older ones stop when it changes
  timer: 0,          // next check on an area being built
};

/** Room the panes leave for the map around a place. */
const placePad = () => (narrow()
  ? { top: 300, bottom: 120, left: 12, right: 12 }
  : { top: 40, bottom: 130, left: window.innerWidth > 1100 ? 200 : 16, right: PANE + 10 });

function setSpot(spot) {
  addr.spot = spot;
  if (!addr.marker) addr.marker = new maplibregl.Marker({ color: '#0a84ff', anchor: 'bottom' });
  addr.marker.setLngLat([spot.lng, spot.lat]).addTo(map);
}

function unpin() {
  addr.spot = null;
  addr.marker?.remove();
}

/** Fly to an address. On a wide screen it ends up low in the view, which
 *  leaves room for its popup above the pin, clear of the time bar. */
function flyToSpot(spot, duration, zoom = 15) {
  stopSpin();
  const padding = narrow() ? placePad() : { ...placePad(), top: Math.round(Math.min(340, window.innerHeight * 0.4)) };
  map.flyTo({ center: [spot.lng, spot.lat], zoom, pitch: 0, bearing: 0, padding, duration, essential: true });
}

/** The popup at the address, as if it had been clicked. On a phone the panel
 *  already says what the popup would, and the popup would hide the map, so it
 *  only opens there when asked for (force). */
function showSpot(force = false) {
  const s = addr.spot;
  if (!s || state.place?.meta.id !== s.place || (narrow() && !force)) return;
  inspect({ lngLat: new maplibregl.LngLat(s.lng, s.lat) }, s.label);
}

/** The ground under the address, at the date on the time bar, at the top of
 *  the place panel: the same reading as the popup, kept in view. */
function updateSpot() {
  const s = addr.spot, place = state.place, ul = $('spot-rows');
  if (!s || !place || place.meta.id !== s.place) { ul.innerHTML = ''; return; }
  const i = place.index(s.lng, s.lat), m = place.meta;
  const row = (k, v) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`;
  if (i < 0 || !(place.flags[i] & 1)) {
    ul.innerHTML = '<li class="txt">No reliable radar signal right at this spot: water, farmland, vegetation and steep ground are left out. Tap the map next to it to read the ground around it.</li>';
    return;
  }
  const cls = place.classAt(i, place.strainYears(state.time)), sig = place.flags[i] & 2;
  let html = `<li class="cls"><span class="k"><i class="sw" style="background:${RISK[cls].color}"></i><b>${RISK[cls].label}</b></span></li>`;
  html += row('Sinking rate', sig ? fmtRate(place.rate[i]) : `below ${m.threshold_mm_yr} mm per year`);
  if (sig || place.beta[i]) {
    html += row('Cracking limit (1/500)', limitText(place, i, LIMITS.cracking));
    html += row('Structural limit (1/150)', limitText(place, i, LIMITS.structural));
  }
  ul.innerHTML = html;
}

function addrBox(html) {
  clearTimeout(addr.timer);
  $('addr').innerHTML = html;
  $('addr').hidden = !html;
}

const spinner = '<span class="spin" aria-hidden="true"></span>';

async function findAddress(text) {
  const q = text.trim();
  if (!q) return;
  const token = ++addr.token;
  addrBox(`<p class="addr-msg">${spinner}Looking up the address…</p>`);
  let hits;
  try {
    hits = await geocode(q);
  } catch (err) {
    console.error(err);
    if (token === addr.token) addrBox('<p class="addr-msg">The address search did not answer. Try again in a moment.</p>');
    return;
  }
  if (token !== addr.token) return;
  if (!hits.length) {
    addrBox(`<p class="addr-msg">No address found for “${esc(q)}”. Add the town and the country, or type coordinates such as 20.94, -101.43.</p>`);
    return;
  }
  // several answers in the same spot are one answer
  const far = h => Math.hypot(h.lat - hits[0].lat, (h.lon - hits[0].lon) * Math.cos((h.lat * Math.PI) / 180)) > 0.02;
  if (!hits.some(far)) { goToAddress(hits[0]); return; }
  addrBox(`<p class="addr-head">Which one?</p><ol class="addr-hits">${hits.map((h, k) =>
    `<li><button type="button" data-k="${k}">${esc(h.label)}</button></li>`).join('')}</ol>`);
  for (const b of $('addr').querySelectorAll('button[data-k]')) b.addEventListener('click', () => goToAddress(hits[+b.dataset.k]));
}

async function goToAddress(hit) {
  const token = ++addr.token;
  const spot = { lng: hit.lon, lat: hit.lat, label: hit.label, short: hit.short };
  const inside = placesAt(state.index.places, spot.lng, spot.lat);
  const p = inside.find(x => !x.area) || inside[0];      // the reviewed places first
  if (p) {
    addrBox('');
    await selectPlace(p.id, { spot });
    return;
  }
  // nothing stored covers it: the area around it, measured on request. The
  // list stays open, as that is where the progress shows.
  if (state.meta) deselect();
  setPanel('finder');
  setSpot({ ...spot, place: null });
  flyToSpot(spot, 2400, 11);
  followArea(areaAt(spot.lat, spot.lng), spot, token);
}

/** Keep asking about an area until it is ready or cannot be built. */
async function followArea(area, spot, token, build = true) {
  const asked = Date.now();
  const card = (body, foot = '') => addrBox(`<div class="addr-card"><h4>${esc(spot.short || spot.label)}</h4>${body}${foot}</div>`);
  const again = (label = 'Try again') => `<button class="btn ghost" type="button" id="addr-again">${label}</button>`;
  const wire = () => $('addr-again')?.addEventListener('click', () => followArea(area, spot, ++addr.token, true));
  const tick = async first => {
    const answer = await askArea(area, first && build);
    if (token !== addr.token) return;
    const status = answer.status === 'none' && !build ? 'never' : answer.status;
    if (status === 'ready') {
      const meta = registerArea(answer);
      addrBox('');
      // open it, unless the person has opened another place in the meantime
      if (!state.meta) await selectPlace(meta.id, { spot });
      else toast(`The map around ${spot.short || spot.label} is ready. Look the address up again to open it.`, 8000);
      return;
    }
    if (status === 'building' || (status === 'none' && Date.now() - asked < 120e3)) {
      // just after a build is asked for it may not be listed yet: "none" then still means building
      const since = Date.parse(answer.started || '') || asked;
      const min = Math.max(0, Math.round((Date.now() - since) / 60e3));
      card(`<p>No place on the map covers this address yet, so the ground around it is being measured now: the NISAR
        radar passes over the 56 km around it are downloaded from NASA and processed, the same way as for every place
        on the map. That takes about 5 to 15 minutes.</p>
        <p class="addr-step">${spinner}<span>${esc(answer.step || 'Waiting for a free machine')}</span><span class="t">${min} min</span></p>`,
      '<p class="fine">You can look around meanwhile. It opens here by itself when it is ready.</p>');
      addr.timer = setTimeout(() => tick(false), 10000);
      return;
    }
    if (status === 'never' || status === 'none') {
      card('<p>No map has been made for the ground around this address yet.</p>', again('Measure it'));
    } else if (status === 'failed') {
      const why = {
        uncovered: 'NISAR images the land every 12 days, but its published products do not cover every area yet. Try again in a few weeks.',
        unusable: 'Every radar pass adds to the record, so this can change. The area is tried again after 30 days.',
        held: 'The same ground was checked by hand and held back, because what the radar shows there so far cannot be trusted.',
      }[answer.code];
      card(`<p>This area cannot be measured yet. ${esc(answer.reason || '')}</p>`, why ? `<p class="fine">${why}</p>` : again());
    } else if (status === 'busy') {
      card(`<p>${esc(answer.reason || 'Too many areas are being measured right now.')} Try again in a few minutes.</p>`, again());
    } else {
      card(`<p>${esc(answer.reason || 'Something went wrong.')}</p>`, status === 'unavailable' ? '' : again());
    }
    wire();
  };
  tick(true);
}

/** Add a ready area to the places the app knows, so it opens like one. */
function registerArea(answer) {
  const meta = areaMeta(answer);
  const list = state.index.places, k = list.findIndex(p => p.id === meta.id);
  if (k >= 0) list[k] = meta; else list.push(meta);
  return meta;
}

// ------------------------------------------------- slow spin of the globe
// Driven by its own frame timer (not by the map's move events), and stopped
// for good by the first camera action from the person or from the app.

let spinning = false, spinFrame = 0;
function startSpin() {
  if (spinning || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  spinning = true;
  let last = performance.now();
  const tick = now => {
    if (!spinning) return;
    const dt = Math.min(100, now - last);
    last = now;
    if (!state.meta && map.getZoom() <= 3.4) {
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + dt * 0.0028, c.lat] });   // about 3 degrees a second
    }
    spinFrame = requestAnimationFrame(tick);
  };
  spinFrame = requestAnimationFrame(tick);
}
function stopSpin() {
  spinning = false;
  cancelAnimationFrame(spinFrame);
}
for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(ev, stopSpin);
for (const ev of ['mousedown', 'touchstart', 'wheel', 'keydown']) {
  map.getCanvasContainer().addEventListener(ev, stopSpin, { passive: true });
}

// ------------------------------------------------- what the map shows

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('mode-sink').setAttribute('aria-pressed', String(mode === 'sink'));
  $('mode-risk').setAttribute('aria-pressed', String(mode === 'risk'));
  updateLegend();
  drawOverlay();
}

// ------------------------------------------- sinking from before NISAR

function setEarlier(id) {
  state.earlier = EARLIER.some(e => e.id === id) ? id : EARLIER_DEFAULT;
  $('earlier').value = state.earlier;
  applyEarlier();
  if (actSpot) setActLink(...actSpot);   // the report must use the same setting
  popup.remove();
  map.getSource('places')?.setData(placesGeoJSON());
  drawOverlay(); updateBuildings(); drawChart(); updatePanel();
}

// ------------------------------------------------------------- base map

function setBase(base) {
  state.base = BASES[base] ? base : 'satellite';
  document.body.dataset.base = state.base;
  for (const b of Object.keys(BASES)) {
    $('base-' + b).setAttribute('aria-pressed', String(b === state.base));
    for (const id of BASES[b]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', b === state.base ? 'visible' : 'none');
    }
  }
  writeHash();
}

/** The legend only shows what is on the map right now: the colour ramp for the
 *  ground and the bubbles, the risk classes once ground or buildings use them. */
function updateLegend() {
  const inPlace = !!state.meta;
  const classes = inPlace && (state.mode === 'risk' || map.getZoom() >= BLDG_MIN_ZOOM);
  if ($('legend-classes').hidden === classes) $('legend-classes').hidden = !classes;
  $('legend-sink').hidden = inPlace && state.mode === 'risk';
  $('legend-classes-title').textContent = state.mode === 'risk' ? 'Ground and buildings' : 'Buildings';
}

// ------------------------------------------- zoom, north, where the pointer is

function mapControls() {
  $('zoom-in').addEventListener('click', () => { stopSpin(); map.zoomIn(); });
  $('zoom-out').addEventListener('click', () => { stopSpin(); map.zoomOut(); });
  $('north').addEventListener('click', () => map.easeTo({ bearing: 0, pitch: 0, duration: 700 }));
  const turned = () => {
    const bearing = map.getBearing(), pitch = map.getPitch();
    $('north').hidden = Math.abs(bearing) < 0.5 && pitch < 0.5;
    $('north-needle').style.transform = `rotate(${-bearing}deg)`;
  };
  map.on('rotate', turned);
  map.on('pitch', turned);

  const part = (v, pos, neg) => {
    const a = Math.abs(v), d = Math.floor(a), min = Math.floor((a - d) * 60);
    return `${d}° ${String(min).padStart(2, '0')}′ ${v >= 0 ? pos : neg}`;
  };
  map.on('mousemove', e => {
    const { lng, lat } = e.lngLat.wrap();
    $('coords').textContent = `${part(lat, 'N', 'S')}\u2002${part(lng, 'E', 'W')}`;
  });
  map.on('mouseout', () => ($('coords').textContent = ''));
}

// --------------------------------------------------------------------- time

let frame = 0;
function onTime(ms) {
  state.time = ms;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!state.index) return;
    map.getSource('places')?.setData(placesGeoJSON());
    drawOverlay();
    updateBuildings();
    updatePanel();
    emit('time', { time: state.time, projected: timeline.projected });
    writeHash();
  });
}
const timeline = new Timeline(onTime);

// --------------------------------------------------------------------- hash

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const parts = [];
    if (state.meta) parts.push('place=' + state.meta.id);
    if (state.meta && addr.spot?.place === state.meta.id) parts.push(`at=${addr.spot.lat.toFixed(5)},${addr.spot.lng.toFixed(5)}`);
    parts.push('t=' + new Date(state.time).toISOString().slice(0, 10));
    if (state.earlier !== EARLIER_DEFAULT) parts.push('earlier=' + state.earlier);
    if (state.base !== 'satellite') parts.push('base=' + state.base);
    history.replaceState(null, '', '#' + parts.join('&'));
  }, 250);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const t = Date.parse(q.get('t') || '');
  const at = (q.get('at') || '').split(',').map(Number);
  return {
    place: q.get('place'), time: isNaN(t) ? null : t, earlier: q.get('earlier'),
    at: at.length === 2 && at.every(Number.isFinite) ? { lat: at[0], lng: at[1] } : null,
    base: BASES[q.get('base')] ? q.get('base') : 'satellite',
  };
}

// --------------------------------------------------------------------- boot

function staticUI() {
  $('ramp').style.background = rampCSS();
  const TINY = ['Not detected', 'Even sinking', 'Cracks possible', 'Cracks likely', 'Structural damage'];
  $('swatches').innerHTML = RISK.map((r, i) =>
    `<li style="--c:${r.color};--on:${i === 2 ? '#1a1206' : '#fff'}"><span class="long">${r.short}</span><span class="tiny">${TINY[i]}</span></li>`).join('');
  $('attrib').innerHTML = ATTRIBUTION;
  const about = $('about');
  $('title').addEventListener('click', () => about.showModal());
  $('about-open').addEventListener('click', () => about.showModal());
  about.addEventListener('click', e => {          // a click outside the text closes it
    const r = about.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) about.close();
  });
  $('finder-open').addEventListener('click', toggleFinder);
  $('mode-sink').addEventListener('click', () => setMode('sink'));
  $('mode-risk').addEventListener('click', () => setMode('risk'));
  $('base-satellite').addEventListener('click', () => setBase('satellite'));
  $('base-night').addEventListener('click', () => setBase('night'));
  $('place-close').addEventListener('click', deselect);
  $('place-spot').addEventListener('click', () => { if (addr.spot) { flyToSpot(addr.spot, 1600); showSpot(true); } });
  $('earlier').innerHTML = EARLIER.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
  $('earlier').addEventListener('change', e => { setEarlier(e.target.value); writeHash(); });
  $('place-hot').addEventListener('click', () => {
    const hot = state.place?.hot;
    if (hot) map.flyTo({ center: hot, zoom: 15.2, pitch: 55, bearing: -18, duration: 3200, essential: true });
  });

  // the layer list folds away on wide screens and pops up from a button on phones
  const layers = $('layers');
  $('layers-toggle').addEventListener('click', () => {
    const shut = layers.classList.toggle('collapsed');
    $('layers-toggle').setAttribute('aria-expanded', String(!shut));
    $('layers-toggle').setAttribute('aria-label', shut ? 'Expand' : 'Collapse');
  });
  const pop = open => {
    layers.classList.toggle('open', open);
    $('layers-open').setAttribute('aria-expanded', String(open));
  };
  $('layers-open').addEventListener('click', e => { e.stopPropagation(); pop(!layers.classList.contains('open')); });
  layers.addEventListener('click', e => { if (e.target.closest('.item')) pop(false); });
  document.addEventListener('click', e => { if (!layers.contains(e.target)) pop(false); });

  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || about.open) return;
    if (layers.classList.contains('open')) pop(false);
    else if (ui.panel === 'finder') toggleFinder();
  });
}

async function boot() {
  const h = readHash();
  state.base = h.base;
  document.body.dataset.base = h.base;
  $('base-satellite').setAttribute('aria-pressed', String(h.base === 'satellite'));
  $('base-night').setAttribute('aria-pressed', String(h.base === 'night'));
  staticUI();
  mapControls();
  const mapReady = new Promise(res => map.once('load', res));
  try {
    state.index = await loadIndex();
  } catch (err) {
    toast('No data found. Run the pipeline first (see README).');
    console.error(err);
    return;
  }
  $('about-meta').textContent = `Data built ${state.index.generated} from ${state.index.places.length} places. ${state.index.source}.`;
  buildList();
  setEarlier(h.earlier);
  globalRange();
  if (h.time) timeline.setTime(h.time);
  // on a wide screen the list of places is open from the start
  let opens = h.place && byId(h.place);
  const area = !opens && areaById(h.place);
  if (area) {
    const answer = await askArea(area);
    if (answer.status === 'ready') opens = registerArea(answer);
  }
  ui.pinned = !narrow();
  if (!opens) setPanel(ui.pinned ? 'finder' : 'none');
  await mapReady;
  map.jumpTo({ ...globeView(), padding: globePad() });
  addLayers();
  updateLegend();
  window.sinkingGround = { map, state, timeline, selectPlace, deselect, setMode, setBase, setEarlier, findAddress, goToAddress };
  if (opens) {
    const spot = h.at && placesAt([opens], h.at.lng, h.at.lat).length ? { ...h.at, label: 'Pinned spot' } : null;
    await selectPlace(opens.id, { spot });
    if (h.time) timeline.setTime(h.time);
  } else {
    startSpin();
  }
}

boot();
