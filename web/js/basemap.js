import { theme } from './theme.js';
// The base map: real imagery with thin white outlines and labels on top, or a
// dark map with city lights. Both share one style so switching is instant.

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const BLUE_MARBLE = `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`;
const NIGHT_LIGHTS = `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`;
// Sentinel-2 cloudless by EOX: a cloud free mosaic of the whole planet at 10 m
const SENTINEL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg';

// short credits for the line along the bottom; the full ones are in the about text
export const ATTRIBUTION = [
  'NISAR (NASA, ISRO) via ASF',
  'NASA GIBS',
  '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX',
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '© <a href="https://www.openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a>',
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  'Buildings: VIDA',
].join(' · ');

/** Layers that belong to one base only. */
export const BASES = {
  satellite: ['sentinel', 'blue-marble'],
  night: ['night-water', 'night-lights'],
};

const name = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
const HALO = 'rgba(8, 12, 18, 0.78)';
const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
const road = (id, classes, minzoom, width, opacity) => ({
  id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom,
  filter: ['all', ['match', ['get', 'class'], classes, true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: { 'line-color': '#ffffff', 'line-width': width, 'line-opacity': opacity },
});
const label = (id, sourceLayer, filter, minzoom, maxzoom, layout, paint = {}) => ({
  id, type: 'symbol', source: 'omt', 'source-layer': sourceLayer, filter, minzoom, maxzoom,
  layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-max-width': 8, ...layout },
  paint: { 'text-color': '#ffffff', 'text-halo-color': HALO, 'text-halo-width': 1.3, 'text-halo-blur': 0.6, ...paint },
});

export function baseStyle(base = 'satellite') {
  const bm = theme().basemap;
  const show = id => ({ visibility: BASES[base].includes(id) ? 'visible' : 'none' });
  return {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': bm.sky, 'horizon-color': bm.horizon, 'fog-color': bm.sky,
      'atmosphere-blend': z(0, 1, 5, 1, 7, 0),
    },
    light: { anchor: 'viewport', intensity: 0.22, color: '#ffffff', position: [1.3, 200, 35] },
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      'blue-marble': { type: 'raster', tiles: [BLUE_MARBLE], tileSize: 256, maxzoom: 8 },
      'night-lights': { type: 'raster', tiles: [NIGHT_LIGHTS], tileSize: 256, maxzoom: 8 },
      sentinel: { type: 'raster', tiles: [SENTINEL], tileSize: 256, minzoom: 5, maxzoom: 14 },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': bm.land } },

      // night base: dark land, darker water, city lights on the globe
      {
        id: 'night-water', type: 'fill', source: 'omt', 'source-layer': 'water', layout: show('night-water'),
        paint: { 'fill-color': bm.night },
      },
      {
        id: 'night-lights', type: 'raster', source: 'night-lights', maxzoom: 9, layout: show('night-lights'),
        paint: { 'raster-opacity': z(0, 0.95, 5, 0.85, 8.5, 0), 'raster-fade-duration': 150 },
      },

      // satellite base: Blue Marble on the globe, Sentinel-2 from region level
      // down. The close up imagery is toned down so the data on top leads.
      {
        id: 'sentinel', type: 'raster', source: 'sentinel', minzoom: 5, layout: show('sentinel'),
        paint: {
          'raster-brightness-max': z(8, 0.95, 11, 0.7),
          'raster-saturation': z(8, 0, 11, -0.3),
          'raster-contrast': z(8, 0, 11, 0.08),
          'raster-fade-duration': 150,
        },
      },
      {
        id: 'blue-marble', type: 'raster', source: 'blue-marble', maxzoom: 8, layout: show('blue-marble'),
        paint: { 'raster-opacity': z(5.8, 1, 7.6, 0), 'raster-fade-duration': 150 },
      },

      {
        id: 'coast', type: 'line', source: 'omt', 'source-layer': 'water', maxzoom: 9,
        filter: ['==', ['get', 'class'], 'ocean'],
        paint: { 'line-color': '#ffffff', 'line-width': z(0, 0.4, 6, 0.9), 'line-opacity': z(0, 0.5, 6, 0.4, 9, 0) },
      },
      {
        id: 'border-state', type: 'line', source: 'omt', 'source-layer': 'boundary', minzoom: 3.5,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#ffffff', 'line-width': 0.6, 'line-opacity': z(3.5, 0, 5, 0.28), 'line-dasharray': [3, 2] },
      },
      {
        id: 'border-country', type: 'line', source: 'omt', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': z(0, 0.5, 6, 1.2, 12, 1.6), 'line-opacity': 0.6 },
      },
      // roads stay faint: they are there to find your way, not to be read
      road('road-minor', ['minor', 'service'], 13.5, z(13.5, 0.4, 17, 3), z(13.5, 0, 14.5, 0.16)),
      road('road-mid', ['secondary', 'tertiary'], 11, z(11, 0.4, 14, 1.1, 17, 5), z(11, 0, 12.5, 0.2)),
      road('road-major', ['motorway', 'trunk', 'primary'], 8.5, z(8.5, 0.4, 12, 1.2, 17, 7), z(8.5, 0, 11, 0.2, 13, 0.28)),

      // labels
      label('label-road', 'transportation_name', ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'], true, false], 13.5, 24,
        { 'symbol-placement': 'line', 'text-size': 10.5, 'text-font': ['Noto Sans Regular'], 'text-letter-spacing': 0.04 },
        { 'text-color': 'rgba(255,255,255,0.82)' }),
      label('label-water', 'water_name', ['match', ['get', 'class'], ['ocean', 'sea'], true, false], 1.5, 8,
        { 'text-size': z(1.5, 10.5, 6, 13), 'text-font': ['Noto Sans Italic'], 'text-letter-spacing': 0.18, 'text-max-width': 6 },
        { 'text-color': bm.water, 'text-halo-color': 'rgba(8,12,18,0.35)' }),
      label('label-quarter', 'place', ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], true, false], 11.5, 24,
        { 'text-size': z(11.5, 9.5, 15, 11.5), 'text-transform': 'uppercase', 'text-letter-spacing': 0.1, 'text-max-width': 7 },
        { 'text-color': 'rgba(255,255,255,0.8)' }),
      label('label-town', 'place', ['match', ['get', 'class'], ['town', 'village'], true, false], 8.5, 24,
        { 'text-size': z(8.5, 10, 14, 12.5), 'text-padding': 8, 'symbol-sort-key': ['get', 'rank'] },
        { 'text-color': 'rgba(255,255,255,0.9)' }),
      label('label-city', 'place', ['==', ['get', 'class'], 'city'], 3, 24,
        {
          'text-size': z(3, ['case', ['<=', ['get', 'rank'], 3], 11.5, 10], 10, ['case', ['<=', ['get', 'rank'], 3], 15, 13]),
          'text-padding': 6, 'symbol-sort-key': ['get', 'rank'],
        }),
      label('label-country', 'place', ['==', ['get', 'class'], 'country'], 1.2, 7,
        {
          'text-size': z(1.2, ['case', ['<=', ['get', 'rank'], 2], 10.5, 9], 6, ['case', ['<=', ['get', 'rank'], 2], 14, 12]),
          'text-transform': 'uppercase', 'text-letter-spacing': 0.14, 'text-max-width': 6.5, 'symbol-sort-key': ['get', 'rank'],
        },
        { 'text-color': 'rgba(255,255,255,0.92)' }),
    ],
  };
}

/** The app puts its own layers (ground overlay, buildings) under this one:
 *  above the imagery, borders and roads, below every name. */
export const UNDER_LABELS = 'label-road';

/** Re-colour an existing map after a theme switch (the style itself is not rebuilt). */
export function recolorBasemap(map) {
  const bm = theme().basemap;
  map.setSky({ 'sky-color': bm.sky, 'horizon-color': bm.horizon, 'fog-color': bm.sky });
  const set = (id, prop, value) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, value); };
  set('land', 'background-color', bm.land);
  set('night-water', 'fill-color', bm.night);
  set('label-water', 'text-color', bm.water);
}
