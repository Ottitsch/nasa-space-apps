// Areas built on request, for addresses that no stored place covers. Runs as a
// Cloudflare Pages Function next to the static site.
//
//   GET  /api/area?lat=..&lon=..    what is known about the area around a spot
//   POST /api/area?lat=..&lon=..    the same, and start building it if needed
//   GET  /api/areas/<id>/<file>     an area's files, before Pages has published them
//
// The answers are the ones pipeline/serve.py gives when the site runs locally
// (its docstring lists them). The building itself is done by the GitHub
// workflow .github/workflows/build-area.yml: it runs pipeline/area.py for the
// area and commits the files to web/data/areas/<id>/, which Pages publishes
// with its next deploy. Until it has, /api/areas/ passes them on from GitHub.
//
// Settings, in the Pages project under Settings, Variables and Secrets:
//   AREA_GITHUB_TOKEN  (secret) a fine grained GitHub token for this repository
//                      only, with Actions read and write and Contents read
//   AREA_REPO          owner/name of the repository, if not the one below
//   AREA_BRANCH        the branch Pages publishes, if not main
// Without the token every answer is "unavailable" and the map says so.

const REPO = 'Ottitsch/nasa-space-apps';
const WORKFLOW = 'build-area.yml';
const PER_DEG = 5;              // grid points per degree, as in pipeline/area.py
const SIZE_KM = 56;           // box edge, as in pipeline/area.py
const RETRY_DAYS = 30;
const MAX_ACTIVE = 4;           // builds running or queued at once
const ID_RE = /^area-\d{1,2}\.\d[ns]-\d{1,3}\.\d[ew]$/;
const FILES = new Set(['meta.json', 'core.bin.gz', 'frames.bin.gz']);
const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const COLLECTIONS = ['C3622247503-ASF', 'C2854335566-ASF'];   // NISAR L2 GUNW, as in pipeline/search.py
const DAY = 864e5;

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/area') {
      if (request.method !== 'GET' && request.method !== 'POST') return reply({ status: 'error', reason: 'GET or POST' }, 405);
      return await area(url, request.method === 'POST', env);
    }
    const m = path.match(/^\/api\/areas\/([^/]+)\/([^/]+)$/);
    if (m && request.method === 'GET') return await file(url, m[1], m[2], env);
    return reply({ status: 'error', reason: 'not found' }, 404);
  } catch (err) {
    return reply({ status: 'error', reason: String(err?.message || err).slice(0, 300) }, 502);
  }
}

// ------------------------------------------------------------- the grid

/** Grid index as degrees in tenths, without floating point (as in pipeline/area.py). */
function deg(k) {
  const tenths = (Math.abs(k) * 10) / PER_DEG;
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** The grid point nearest to a spot. */
function snap(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let i = Math.floor(lat * PER_DEG + 0.5), j = Math.floor(lon * PER_DEG + 0.5);
  i = Math.max(-89 * PER_DEG, Math.min(89 * PER_DEG, i));
  if (j >= 180 * PER_DEG) j -= 360 * PER_DEG;
  return { id: `area-${deg(i)}${i >= 0 ? 'n' : 's'}-${deg(j)}${j >= 0 ? 'e' : 'w'}`, lat: i / PER_DEG, lon: j / PER_DEG };
}

/** The 56 km box around a grid point (west, south, east, north), as pipeline/search.py draws it. */
function bbox(c) {
  const dlat = SIZE_KM / 2 / 110.574, dlon = SIZE_KM / 2 / (111.320 * Math.cos((c.lat * Math.PI) / 180));
  return [c.lon - dlon, c.lat - dlat, c.lon + dlon, c.lat + dlat];
}

// ------------------------------------------------------------- answers

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const ageDays = meta => (Date.now() - Date.parse((meta.built || '') + 'T00:00:00Z')) / DAY;

async function area(url, start, env) {
  const c = snap(parseFloat(url.searchParams.get('lat')), parseFloat(url.searchParams.get('lon')));
  if (!c) return reply({ status: 'error', reason: 'lat and lon are needed, in degrees' }, 400);

  // published with the site, or committed and waiting for the next deploy
  let meta = await published(url, `data/areas/${c.id}/meta.json`, env);
  let base = `data/areas/${c.id}/`;
  if (!meta && env.AREA_GITHUB_TOKEN) {
    const r = await github(env, `contents/web/data/areas/${c.id}/meta.json?ref=${branch(env)}`, { raw: true });
    if (r.ok) { meta = await r.json(); base = `api/areas/${c.id}/`; }
  }
  if (meta?.status === 'ready') return reply({ status: 'ready', id: c.id, base, meta });
  if (meta?.status === 'failed' && ageDays(meta) < RETRY_DAYS) {
    return reply({ status: 'failed', id: c.id, code: meta.code || 'error', reason: meta.reason || '' });
  }

  if (!env.AREA_GITHUB_TOKEN) {
    return reply({ status: 'unavailable', id: c.id, reason: 'Building new areas is not switched on for this site yet.' });
  }

  // being built?
  const r = await github(env, `actions/workflows/${WORKFLOW}/runs?per_page=50`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status} listing builds`);
  const runs = (await r.json()).workflow_runs || [];
  const mine = runs.filter(x => x.display_title === `area ${c.id}`);
  const active = mine.find(x => x.status !== 'completed');
  if (active) return reply(await building(env, c, active));
  const last = mine[0];
  if (last && last.conclusion !== 'success' && Date.now() - Date.parse(last.updated_at) < 15 * 60e3) {
    return reply({ status: 'failed', id: c.id, code: 'error', reason: 'The build stopped with an error. Try again later.' });
  }
  if (!start) return reply({ status: 'none', id: c.id });

  if (runs.filter(x => x.status !== 'completed').length >= MAX_ACTIVE) {
    return reply({ status: 'busy', id: c.id, reason: 'Too many areas are being built right now.' });
  }
  // no radar passes at all: say so at once rather than start a machine for it
  if ((await radarPasses(c)) === 0) {
    return reply({ status: 'failed', id: c.id, code: 'uncovered', reason: 'NISAR has no radar passes over this area yet.' });
  }
  const d = await github(env, `actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: branch(env), inputs: { lat: String(c.lat), lon: String(c.lon), id: c.id } }),
  });
  if (!d.ok) throw new Error(`GitHub answered ${d.status} starting the build`);
  return reply({ status: 'building', id: c.id, step: 'Waiting for a free machine', started: new Date().toISOString() });
}

/** What a running build is doing: the name of the workflow step it is on. */
async function building(env, c, run) {
  let step = run.status === 'in_progress' ? 'Starting' : 'Waiting for a free machine';
  const r = await github(env, `actions/runs/${run.id}/jobs`);
  if (r.ok) {
    const steps = (await r.json()).jobs?.[0]?.steps || [];
    const now = steps.find(s => s.status === 'in_progress');
    // the workflow's own steps have readable names; GitHub's (Set up job, Run actions/...) do not
    if (now) step = /^(Set up|Run actions\/|Post |Complete job)/.test(now.name) ? 'Starting' : now.name;
  }
  return { status: 'building', id: c.id, step, started: run.run_started_at || run.created_at };
}

/** How many NISAR interferograms cover the area (null if the catalogue did not answer). */
async function radarPasses(c) {
  const q = new URLSearchParams({ bounding_box: bbox(c).map(v => v.toFixed(5)).join(','), page_size: '1' });
  for (const id of COLLECTIONS) q.append('collection_concept_id[]', id);
  try {
    const r = await fetch(`${CMR}?${q}`);
    if (!r.ok) return null;
    const n = parseInt(r.headers.get('cmr-hits'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- files

/** One of an area's files: from the published site when it is there, else from GitHub. */
async function file(url, id, name, env) {
  if (!ID_RE.test(id) || !FILES.has(name)) return reply({ status: 'error', reason: 'not found' }, 404);
  const path = `data/areas/${id}/${name}`;
  const own = await env.ASSETS.fetch(new URL('/' + path, url));
  if (own.ok && !isPage(own)) return own;
  if (!env.AREA_GITHUB_TOKEN) return reply({ status: 'error', reason: 'not found' }, 404);
  const r = await github(env, `contents/web/${path}?ref=${branch(env)}`, { raw: true });
  if (!r.ok) return reply({ status: 'error', reason: 'not found' }, 404);
  return new Response(r.body, {
    headers: {
      'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    },
  });
}

/** A JSON file of the published site, or null. Pages answers a missing file
 *  with the start page, so anything that is not JSON counts as missing. */
async function published(url, path, env) {
  const r = await env.ASSETS.fetch(new URL('/' + path, url));
  if (!r.ok || isPage(r)) return null;
  try { return await r.json(); } catch { return null; }
}

const isPage = r => (r.headers.get('content-type') || '').includes('text/html');

// ------------------------------------------------------------- GitHub

const branch = env => env.AREA_BRANCH || 'main';

function github(env, path, { method = 'GET', body, raw = false } = {}) {
  return fetch(`https://api.github.com/repos/${env.AREA_REPO || REPO}/${path}`, {
    method, body,
    headers: {
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      authorization: `Bearer ${env.AREA_GITHUB_TOKEN}`,
      'user-agent': 'sinking-ground-site',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
}
