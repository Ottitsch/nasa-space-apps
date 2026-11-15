// Addresses: finding one, and getting the ground under it measured when no
// stored place covers it.
//
// The address is looked up with OpenStreetMap's Nominatim, from the browser.
// An address that no place covers falls in an area: a 56 km box around the
// nearest point of a grid 0.2 degrees apart. Areas are built on request by the
// site's api/area (functions/api/[[path]].js on Cloudflare Pages,
// pipeline/serve.py locally), which runs the same pipeline as for the places.
// Only the grid point is sent to it, never the address.

import { prepPlace } from './data.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const PER_DEG = 5;                     // grid points per degree, as in pipeline/area.py
export const AREA_ID = /^area-(\d{1,2})\.(\d)([ns])-(\d{1,3})\.(\d)([ew])$/;

/** Grid index as degrees in tenths, without floating point (as in pipeline/area.py). */
function deg(k) {
  const tenths = (Math.abs(k) * 10) / PER_DEG;
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** The area a spot falls in: the nearest grid point and its id. */
export function areaAt(lat, lon) {
  let i = Math.floor(lat * PER_DEG + 0.5), j = Math.floor(lon * PER_DEG + 0.5);
  i = Math.max(-89 * PER_DEG, Math.min(89 * PER_DEG, i));
  if (j >= 180 * PER_DEG) j -= 360 * PER_DEG;
  return { id: `area-${deg(i)}${i >= 0 ? 'n' : 's'}-${deg(j)}${j >= 0 ? 'e' : 'w'}`, lat: i / PER_DEG, lon: j / PER_DEG };
}

/** The area with this id, or null. */
export function areaById(id) {
  const m = AREA_ID.exec(id || '');
  if (!m) return null;
  const lat = (+m[1] + m[2] / 10) * (m[3] === 's' ? -1 : 1), lon = (+m[4] + m[5] / 10) * (m[6] === 'w' ? -1 : 1);
  return areaAt(lat, lon);
}

/** "20.94, -101.43" or "20.94 N 101.43 W" as { lat, lon }, or null. */
export function parseCoords(q) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(q);
  if (!m) return null;
  const lat = +m[1] * (/s/i.test(m[2] || '') ? -1 : 1), lon = +m[3] * (/w/i.test(m[4] || '') ? -1 : 1);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Up to five matches for an address: { lat, lon, label, short }. Throws if
 *  the search does not answer. */
export async function geocode(q) {
  const coords = parseCoords(q);
  if (coords) {
    const label = `${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}`;
    return [{ ...coords, label, short: label }];
  }
  const u = new URL(NOMINATIM);
  u.search = new URLSearchParams({ q, format: 'jsonv2', limit: '5', addressdetails: '1' });
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`address search: HTTP ${r.status}`);
  return (await r.json()).map(h => {
    const a = h.address || {};
    const near = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.village || a.hamlet;
    const town = a.city || a.town || a.municipality || a.county || a.state;
    const short = [near, town].filter(Boolean).filter((v, k, all) => all.indexOf(v) === k).join(', ');
    return { lat: +h.lat, lon: +h.lon, label: h.display_name, short: short || h.display_name.split(',')[0], country: a.country || '' };
  }).filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

/**
 * Ask the site about an area: { status, ... } as pipeline/serve.py describes.
 * build: true asks for it to be built if it is not. A site without the build
 * service (a plain static server) answers "unavailable".
 */
export async function askArea(area, build = false) {
  let r;
  try {
    r = await fetch(`api/area?lat=${area.lat}&lon=${area.lon}`, { method: build ? 'POST' : 'GET', cache: 'no-store' });
  } catch {
    return { status: 'error', reason: 'The site did not answer. Check the connection and try again.' };
  }
  const type = r.headers.get('content-type') || '';
  if (!type.includes('json')) {
    return { status: 'unavailable', reason: 'This copy of the site cannot build new areas. Run it with python -m pipeline.serve (see the README).' };
  }
  try { return await r.json(); } catch { return { status: 'error', reason: 'The site gave an answer that could not be read.' }; }
}

/** The index entry of a ready area, ready for loadPlace. */
export function areaMeta(answer) {
  const m = prepPlace({ ...answer.meta });
  m.base = answer.base;
  m.area = true;
  return m;
}
