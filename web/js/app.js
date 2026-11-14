// Sinking Ground: a globe of places where NISAR sees the ground going down,
// a time bar to scrub through measured and projected sinking, and buildings
// coloured by the strain the ground under them has built up.

import * as maplibregl from '../vendor/maplibre-gl.mjs';
import {
  END_YEAR, LIMITS, RISK, SINK_DECADES, SINK_MIN_MM, YEAR,
  fmtDate, fmtMonth, fmtRate, fmtSunk, rampCSS, sinkCSS, sinkLUT, sinkU,
} from './config.js';
import { hotSunk, loadFrames, loadIndex, loadPlace } from './data.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
// Building outlines: Google Open Buildings + Microsoft + OpenStreetMap, merged
// by VIDA and served as one PMTiles archive (read with HTTP range requests).
const BLDG_URL = 'pmtiles://https://data.source.coop/vida/google-microsoft-osm-open-buildings/pmtiles/goog_msft_osm.pmtiles';
const BLDG = { source: 'bldg', sourceLayer: 'goog_msft_osm_building_footprints' };
const BLDG_MIN_ZOOM = 13.5;
const NIGHT = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
const GLOBE_VIEW = { center: [-75, 18], zoom: 2.1, pitch: 0, bearing: 0 };
// keep the globe clear of the panels on wide screens
const globePad = () => (narrow() ? { top: 60, bottom: 110, left: 0, right: 0 } : { top: 0, bottom: 90, left: 320, right: 0 });
const narrow = () => window.innerWidth <= 860;

const state = {
  mode: 'sink',     // 'sink': how far the ground has sunk, 'risk': damage risk classes
  index: null,
  meta: null,       // selected place (index entry)
  place: null,      // its loaded PlaceData
  time: 0,
  loadToken: 0,
};

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
  style: 'https://tiles.openfreemap.org/styles/dark',
  ...GLOBE_VIEW,
  minZoom: 1,
  maxPitch: 70,
  attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'NISAR (NASA, ISRO) via ASF · NASA GIBS · Buildings: Google, Microsoft, OSM via VIDA',
}), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.on('error', e => console.warn('map:', e.error?.message || e));

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
const LUT = sinkLUT();
// risk class colours packed for the canvas (little endian ABGR)
const RISK_PX = RISK.map((r, i) => {
  const v = parseInt(r.color.slice(1), 16);
  const a = [0, 120, 215, 230, 240][i];
  return ((a << 24) | ((v & 255) << 16) | (((v >> 8) & 255) << 8) | (v >> 16)) >>> 0;
});
let image = null, pixels = null;

function addLayers() {
  map.setProjection({ type: 'globe' });
  try {
    map.setSky({
      'sky-color': '#0a1220', 'horizon-color': '#1b2c48', 'fog-color': '#0a1220',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    });
  } catch (e) { /* sky is decoration only */ }

  const layers = map.getStyle().layers;
  const firstSymbol = layers.find(l => l.type === 'symbol')?.id;
  const below = layers.find(l => l.id === 'waterway') ? 'waterway' : firstSymbol;

  // city lights on the globe, fading out as you approach street level
  map.addSource('night', { type: 'raster', tiles: [NIGHT], tileSize: 256, maxzoom: 8 });
  map.addLayer({
    id: 'night', type: 'raster', source: 'night', maxzoom: 9,
    paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.95, 5, 0.85, 8.5, 0] },
  }, below);

  // outline of the area we have data for
  map.addSource('extent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'extent', type: 'line', source: 'extent',
    paint: { 'line-color': '#5fd4e8', 'line-opacity': 0.45, 'line-width': 1, 'line-dasharray': [3, 3] },
  }, firstSymbol);

  // buildings, coloured through feature state by updateBuildings()
  if (window.pmtiles) {
    map.addSource(BLDG.source, { type: 'vector', url: BLDG_URL, minzoom: 12 });
    map.addLayer({
      id: 'bldg', type: 'fill-extrusion', source: BLDG.source, 'source-layer': BLDG.sourceLayer, minzoom: BLDG_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': ['match', ['coalesce', ['feature-state', 'risk'], 0],
          1, RISK[1].color, 2, RISK[2].color, 3, RISK[3].color, 4, RISK[4].color, '#39424f'],
        // heights are not in the data: one modest height for every building
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], BLDG_MIN_ZOOM, 0, 15, 7],
        'fill-extrusion-opacity': 0.93,
      },
    }, firstSymbol);
  }

  // one bubble per place
  map.addSource('places', { type: 'geojson', data: placesGeoJSON() });
  const detected = ['==', ['get', 'detected'], 1];
  map.addLayer({
    id: 'places-glow', type: 'circle', source: 'places', maxzoom: 9.5, filter: detected,
    paint: { 'circle-radius': ['*', 2.4, ['get', 'r']], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22, 'circle-blur': 1 },
  });
  map.addLayer({
    id: 'places-dot', type: 'circle', source: 'places', maxzoom: 9.5,
    paint: {
      'circle-radius': ['get', 'r'],
      'circle-color': ['case', detected, ['get', 'color'], 'rgba(120,135,160,0.25)'],
      'circle-stroke-color': ['case', detected, '#ffffff', '#8f9bb0'],
      'circle-stroke-width': ['case', detected, 1.3, 1],
    },
  });
  map.addLayer({
    id: 'places-label', type: 'symbol', source: 'places', maxzoom: 9.5, filter: detected,
    layout: {
      'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['get', 'label'], { 'font-scale': 0.88 }],
      'text-font': ['Noto Sans Regular'], 'text-size': 12.5,
      'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': ['get', 'ro'],
      'text-justify': 'auto', 'symbol-sort-key': ['-', 0, ['get', 'sunk']],
    },
    paint: { 'text-color': '#e8eef8', 'text-halo-color': 'rgba(7,11,18,0.9)', 'text-halo-width': 1.5 },
  });

  map.on('click', 'places-dot', e => { selectPlace(e.features[0].properties.id); e.preventDefault(); });
  map.on('mouseenter', 'places-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'places-dot', () => { map.getCanvas().style.cursor = ''; hover.remove(); });
  map.on('mousemove', 'places-dot', e => {
    const p = byId(e.features[0].properties.id);
    hover.setLngLat([p.lon, p.lat]).setHTML(
      `<div class="pop"><h4>${p.name}</h4>${p.detected
        ? `<div>Fastest zone sinking ${fmtRate(p.hotRate)}</div>`
        : `<div>No sinking detected above ${p.threshold_mm_yr} mm per year</div>`}</div>`).addTo(map);
  });
  map.on('click', inspect);
  map.on('idle', scanBuildings);
}

const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 });
const popup = new maplibregl.Popup({ maxWidth: '300px' });
const byId = id => state.index.places.find(p => p.id === id);

function placesGeoJSON() {
  const t = state.time;
  return {
    type: 'FeatureCollection',
    features: state.index.places.filter(p => p !== state.meta).map(p => {
      const sunk = hotSunk(p, t);
      const r = p.detected ? 5 + 21 * sinkU(sunk) : 3.5;
      return {
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id, name: p.name, detected: p.detected ? 1 : 0, sunk, r, ro: r / 12.5 + 0.35,
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
  const before = map.getLayer('building') ? 'building' : (map.getLayer('extent') ? 'extent' : undefined);
  map.addLayer({
    id: 'sink', type: 'raster', source: 'sink',
    paint: {
      'raster-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.9, 13, 0.8, 15.5, 0.55],
      'raster-fade-duration': 0, 'raster-resampling': 'linear',
    },
  }, before);
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
  const y = place.years(state.time);
  const { n, rate, alpha } = place;
  if (y <= 0) {
    pixels.fill(0);
  } else if (state.mode === 'risk') {
    for (let i = 0; i < n; i++) pixels[i] = alpha[i] > 128 ? RISK_PX[place.classAt(i, y)] : 0;
  } else {
    const { a, b, w } = place.blend(y);
    const half = SINK_MIN_MM / 2, k = 255 / SINK_DECADES;
    for (let i = 0; i < n; i++) {
      const al = alpha[i];
      if (!al) { pixels[i] = 0; continue; }
      let d = rate[i] * y;
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
  const y = place.years(state.time);
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
    `<li><i class="sw" style="background:${r.color}"></i><span>${r.short}</span><span class="v">${counts[i].toLocaleString()}</span></li>`).join('');
}

function clearBuildings() {
  if (map.getSource(BLDG.source)) map.removeFeatureState(BLDG);
  B.where.clear(); B.cls.clear(); B.ids = [];
}

// ---------------------------------------------------------- click to inspect

function limitText(place, i, limit) {
  const yrs = place.yearsToLimit(i, limit);
  if (!isFinite(yrs)) return 'not at this rate';
  const ms = place.meta.t0 + yrs * YEAR;
  if (ms > Date.UTC(END_YEAR, 11, 31)) return `after ${END_YEAR}`;
  return (ms <= state.time ? 'passed ' : 'around ') + fmtMonth(ms);
}

function inspect(e) {
  if (e.defaultPrevented) return;
  const place = state.place;
  if (!place) return;
  const { lng, lat } = e.lngLat;
  const i = place.index(lng, lat);
  if (i < 0) return;
  const m = place.meta, y = place.years(state.time);
  const valid = place.flags[i] & 1, sig = place.flags[i] & 2;
  const cls = place.classAt(i, y);
  const sunk = place.sunkAt(i, y);
  const proj = state.time > m.t1;
  let html = `<div class="pop"><span class="chip" style="background:${RISK[cls].color}">${RISK[cls].label}</span>`;
  if (!valid) {
    html += `<div class="note">No reliable radar signal here. Water, farmland, vegetation and steep ground are left out.</div>`;
  } else if (!sig) {
    html += `<div class="row"><span>Sinking rate</span><span>below ${m.threshold_mm_yr} mm per year</span></div>
      <div class="note">Nothing detected here so far. Slower sinking than the limit above cannot be ruled out.</div>`;
  } else {
    html += `<div class="row"><span>Sinking rate</span><span>${fmtRate(place.rate[i])}</span></div>
      <div class="row"><span>${proj ? 'Would have sunk by ' + fmtMonth(state.time) : 'Sunk by ' + fmtDate(state.time)}</span><span>${fmtSunk(sunk)}</span></div>
      <div class="row"><span>Cracking limit (1/500)</span><span>${limitText(place, i, LIMITS.cracking)}</span></div>
      <div class="row"><span>Structural limit (1/150)</span><span>${limitText(place, i, LIMITS.structural)}</span></div>
      <div class="note">Counted from the first radar pass on ${fmtDate(m.t0)}. One radar pixel is 80 m wide: a screening estimate, not a building inspection.</div>`;
  }
  popup.setLngLat(e.lngLat).setHTML(html + '</div>').addTo(map);
  emit('inspect', {
    place: m.id, lng, lat, valid: !!valid, detected: !!sig, riskClass: cls,
    rate_mm_per_year: valid ? place.rate[i] : null, sunk_mm: sunk, time: state.time, projected: proj,
  });
}

// ------------------------------------------------------------- place panel

function buildList() {
  const places = [...state.index.places].sort((a, b) => a.hotRate - b.hotRate || a.name.localeCompare(b.name));
  const max = Math.max(...places.map(p => -p.hotRate), 1);
  $('places').innerHTML = places.map(p => `
    <li data-q="${(p.name + ' ' + p.country).toLowerCase()}"><button type="button" data-id="${p.id}">
      <span class="nm">${p.name}</span>
      <span class="rt ${p.detected ? '' : 'none'}">${p.detected ? fmtRate(p.hotRate).replace(' per year', '/yr') : 'not detected'}</span>
      <span class="ct">${p.country} · ${p.months} mo of data</span><span></span>
      <span class="bar"><i style="width:${p.detected ? Math.sqrt(-p.hotRate / max) * 100 : 0}%"></i></span>
    </button></li>`).join('');
  $('places').addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) selectPlace(b.dataset.id);
  });
  $('search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of $('places').children) li.hidden = q && !li.dataset.q.includes(q);
  });
  const n = places.filter(p => p.detected).length;
  $('list-note').textContent = `${places.length} places measured, ${n} with sinking detected. Rates are for the fastest zone in each place. Places with only a few months of passes can only show fast sinking so far.`;
  $('list-toggle').addEventListener('click', () => {
    const body = $('list-body');
    body.hidden = !body.hidden;
    $('list-toggle').textContent = body.hidden ? '▸' : '▾';
    $('list-toggle').setAttribute('aria-expanded', String(!body.hidden));
  });
}

function drawChart() {
  const m = state.meta, svg = $('chart');
  if (!m || !m.detected) { svg.innerHTML = ''; svg.style.display = 'none'; return; }
  svg.style.display = '';
  const W = 300, H = 96, T = 12, Bm = 4, ih = H - T - Bm;
  const end = Date.UTC(END_YEAR, 11, 31);
  const max = hotSunk(m, end);
  const X = ms => timeline.frac(ms) * W;
  const Y = mm => T + ih * (1 - Math.sqrt(Math.max(0, mm) / max));
  const meas = m.dates.map((d, k) => [X(m.t0 + m.t_years[k] * YEAR), Y(-m.hot_series_mm[k])]);
  const proj = [];
  for (let k = 0; k <= 40; k++) { const ms = m.t1 + (k / 40) * (end - m.t1); proj.push([X(ms), Y(hotSunk(m, ms))]); }
  const path = pts => pts.map((p, k) => (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const xNow = X(m.t1);
  svg.innerHTML = `
    <path d="${path(meas)}L${xNow} ${H - Bm}L${meas[0][0]} ${H - Bm}Z" fill="rgba(95,212,232,0.16)"/>
    <path d="${path(proj)}L${W} ${H - Bm}L${xNow} ${H - Bm}Z" fill="rgba(255,165,61,0.10)"/>
    <path d="${path(meas)}" fill="none" stroke="#5fd4e8" stroke-width="2"/>
    <path d="${path(proj)}" fill="none" stroke="#ffa53d" stroke-width="2" stroke-dasharray="4 4"/>
    <line x1="${xNow}" x2="${xNow}" y1="${T - 6}" y2="${H - Bm}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="2 3"/>
    <text x="${xNow - 5}" y="9" text-anchor="end" font-size="9.5" fill="#93a3bb">measured</text>
    <text x="${xNow + 5}" y="9" font-size="9.5" fill="#93a3bb">projected</text>
    <text x="${W - 4}" y="${H - Bm - 5}" text-anchor="end" font-size="9.5" fill="#c9a377">${fmtSunk(max)} by ${END_YEAR}</text>
    <line id="chart-x" y1="${T - 6}" y2="${H - Bm}" stroke="#fff" stroke-opacity="0.5"/>
    <circle id="chart-dot" r="4" fill="#fff" stroke="#070b12" stroke-width="1.5"/>`;
  svg._X = X; svg._Y = Y;
}

function updatePanel() {
  const m = state.meta;
  if (!m) return;
  const t = state.time, proj = t > m.t1;
  const sunk = hotSunk(m, t);
  if (!m.detected) {
    $('place-big').textContent = 'No sinking detected';
    $('place-big-label').textContent = `Nothing faster than ${m.threshold_mm_yr} mm per year over a wide area in ${m.months} months of radar passes. Slower sinking may show up as more passes arrive.`
      + (m.sinking_area_km2 > 0 ? ` A few small spots (${m.sinking_area_km2} km² in total) are marked on the map; these can be earthworks, landfill or noise.` : '');
  } else if (t <= m.t0) {
    $('place-big').textContent = '0 cm';
    $('place-big-label').textContent = `Radar passes here start on ${fmtDate(m.t0)}.`;
  } else {
    $('place-big').textContent = fmtSunk(sunk);
    $('place-big-label').textContent = proj
      ? `How far the fastest zone would have sunk by ${fmtMonth(t)} if the current rate continues (counted from ${fmtDate(m.t0)}).`
      : `How far the fastest zone has sunk between ${fmtDate(m.t0)} and ${fmtDate(t)} (measured).`;
  }
  const svg = $('chart');
  if (svg._X && m.detected) {
    const x = svg._X(Math.max(t, m.t0)), y = svg._Y(sunk);
    $('chart-x')?.setAttribute('x1', x); $('chart-x')?.setAttribute('x2', x);
    $('chart-dot')?.setAttribute('cx', x); $('chart-dot')?.setAttribute('cy', y);
  }
  const place = state.place;
  if (place && m.detected) {
    const a = place.areaByClass(place.years(t), 5);
    const fmt = v => (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' km²';
    $('strain').hidden = false;
    $('strain-bars').innerHTML = [2, 3, 4].map(i =>
      `<li><i class="sw" style="background:${RISK[i].color}"></i><span>${RISK[i].short}</span><span class="v">${fmt(a[i])}</span></li>`).join('');
  } else {
    $('strain').hidden = true;
  }
}

function showPanel(m) {
  $('place').hidden = false;
  document.body.classList.add('has-place');
  $('place-country').textContent = m.country;
  $('place-name').textContent = m.name;
  $('place-status').innerHTML = `<span class="status ${m.detected ? '' : 'none'}">${m.detected ? 'Sinking detected' : 'No sinking detected'}</span>`
    + (m.early ? `<span class="status early">Early result: ${m.months} months of data</span>` : '');
  $('st-rate').textContent = m.detected ? fmtRate(m.hotRate) : 'none detected';
  $('st-area').textContent = m.detected ? `${m.sinking_area_km2.toLocaleString()} km²` : '0 km²';
  $('st-built').textContent = `${(m.builtup_sinking_km2 ?? 0).toLocaleString()} km²`;
  $('st-thr').textContent = `${m.threshold_mm_yr} mm per year`;
  $('st-span').textContent = `${m.dates.length} dates, ${m.tracks.length} ${m.tracks.length > 1 ? 'viewing directions' : 'viewing direction'}`;
  $('st-rec').textContent = `${fmtMonth(m.t0)} to ${fmtMonth(m.t1)}`;
  $('place-driver').textContent = m.driver ? `Main cause reported for this area: ${m.driver.toLowerCase()}.` : '';
  $('place-hot').hidden = !m.detected;
  for (const b of $('places').querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.id === m.id));
}

// ------------------------------------------------------------ select a place

async function selectPlace(id, opts = {}) {
  const m = byId(id);
  if (!m) return;
  const token = ++state.loadToken;
  popup.remove(); hover.remove();
  clearBuildings();
  removeOverlay();
  state.meta = m; state.place = null;
  stopSpin();
  showPanel(m);
  timeline.setRange(m.t0, m.t1);
  drawChart(); updatePanel();
  map.getSource('places')?.setData(placesGeoJSON());
  const [w, s, e, n] = m.bounds;
  if (opts.fly !== false) {
    map.fitBounds([[w, s], [e, n]], {
      padding: narrow() ? { top: 70, bottom: 300, left: 12, right: 12 } : { top: 30, bottom: 130, left: 340, right: 370 },
      pitch: 0, bearing: 0, duration: 2600, essential: true,
    });
  }
  toast(`Loading ${m.name}…`);
  try {
    const place = await loadPlace(m);
    if (token !== state.loadToken) return;
    state.place = place;
    addOverlay(place);
    drawOverlay(); updatePanel(); scanBuildings();
    toast('');
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
  clearBuildings(); removeOverlay();
  state.meta = null; state.place = null;
  $('place').hidden = true;
  document.body.classList.remove('has-place');
  for (const b of $('places').querySelectorAll('button')) b.removeAttribute('aria-current');
  globalRange();
  map.getSource('places')?.setData(placesGeoJSON());
  map.flyTo({ ...GLOBE_VIEW, center: map.getCenter(), padding: globePad(), duration: 2200, essential: true });
  writeHash();
}

function globalRange() {
  const ps = state.index.places;
  timeline.setRange(Math.min(...ps.map(p => p.t0)), Math.max(...ps.map(p => p.t1)));
}

// ------------------------------------------------- slow spin of the globe

let spinning = false;
function spin() {
  if (!spinning || state.meta || map.getZoom() > 3.2) return;
  const c = map.getCenter();
  map.easeTo({ center: [c.lng + 14, c.lat], duration: 5000, easing: t => t, essential: false });
}
function startSpin() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  spinning = true;
  spin();
}
function stopSpin() {
  if (!spinning) return;
  spinning = false;
  map.stop();
}
map.on('moveend', () => { if (spinning) spin(); });
for (const ev of ['mousedown', 'touchstart', 'wheel', 'keydown']) {
  map.getCanvasContainer().addEventListener(ev, stopSpin, { passive: true });
}

// --------------------------------------------------------------- map layer

function setMode(mode) {
  state.mode = mode;
  $('mode-sink').setAttribute('aria-pressed', String(mode === 'sink'));
  $('mode-risk').setAttribute('aria-pressed', String(mode === 'risk'));
  $('legend-sink').hidden = mode !== 'sink';
  $('legend-risk-title').textContent = mode === 'risk' ? 'Ground and buildings' : 'Buildings';
  drawOverlay();
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
    parts.push('t=' + new Date(state.time).toISOString().slice(0, 10));
    history.replaceState(null, '', '#' + parts.join('&'));
  }, 250);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const t = Date.parse(q.get('t') || '');
  return { place: q.get('place'), time: isNaN(t) ? null : t };
}

// --------------------------------------------------------------------- boot

function staticUI() {
  $('ramp').style.background = rampCSS();
  $('swatches').innerHTML = RISK.map(r => `<li><i style="background:${r.color}"></i>${r.short}</li>`).join('');
  $('about-open').addEventListener('click', () => $('about').showModal());
  $('mode-sink').addEventListener('click', () => setMode('sink'));
  $('mode-risk').addEventListener('click', () => setMode('risk'));
  $('place-close').addEventListener('click', deselect);
  $('place-hot').addEventListener('click', () => {
    const hot = state.place?.hot;
    if (hot) map.flyTo({ center: hot, zoom: 15.2, pitch: 55, bearing: -18, duration: 3200, essential: true });
  });
}

async function boot() {
  staticUI();
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
  const h = readHash();
  globalRange();
  if (h.time) timeline.setTime(h.time);
  await mapReady;
  map.setPadding(globePad());
  addLayers();
  window.sinkingGround = { map, state, timeline, selectPlace, deselect, setMode };
  if (h.place && byId(h.place)) {
    await selectPlace(h.place);
    if (h.time) timeline.setTime(h.time);
  } else {
    startSpin();
  }
}

boot();
