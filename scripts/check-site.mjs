// Checks the site in web/ before it is published:
//   node scripts/check-site.mjs
//
// Run by .github/workflows/check.yml on pull requests, and by Cloudflare Pages
// as its build command, where a failure stops the publish. It needs nothing
// but Node.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = `${root}web/`;
const problems = [];

// Every script has to parse, the site's and the Pages Functions' next to it.
// There is no build step that would catch it.
const listJs = dir => (existsSync(`${root}${dir}`)
  ? readdirSync(`${root}${dir}`, { recursive: true }).filter(f => f.endsWith('.js')).sort().map(f => `${dir}/${f}`)
  : []);
const scripts = [...listJs('web/js'), ...listJs('functions')];
for (const f of scripts) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(`${root}${f}`),
    encoding: 'utf8',
  });
  if (r.status !== 0) problems.push(`${f} does not parse\n${r.stderr.trim()}`);
}

// Every place in the index needs both of its data files, complete.
let places = [];
try {
  places = JSON.parse(readFileSync(`${web}data/index.json`, 'utf8')).places;
  if (!Array.isArray(places) || places.length === 0) throw new Error('no places listed');
} catch (e) {
  problems.push(`web/data/index.json: ${e.message}`);
  places = [];
}
for (const { id } of places) {
  for (const name of ['core.bin.gz', 'frames.bin.gz']) {
    try {
      gunzipSync(readFileSync(`${web}data/${id}/${name}`));
    } catch (e) {
      problems.push(`web/data/${id}/${name}: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
    }
  }
}

// Areas built on request (pipeline/area.py): a meta.json each, and a ready
// one needs both data files, complete and of the size its meta gives.
const areasDir = `${web}data/areas`;
const areas = existsSync(areasDir) ? readdirSync(areasDir).sort() : [];
for (const id of areas) {
  const where = `web/data/areas/${id}`;
  let meta;
  try {
    meta = JSON.parse(readFileSync(`${areasDir}/${id}/meta.json`, 'utf8'));
  } catch (e) {
    problems.push(`${where}/meta.json: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
    continue;
  }
  if (meta.id !== id) problems.push(`${where}/meta.json: id is ${meta.id}`);
  if (meta.status === 'failed') continue;
  if (meta.status !== 'ready') { problems.push(`${where}/meta.json: status is ${meta.status}`); continue; }
  const sizes = { 'core.bin.gz': meta.width * meta.height * 5, 'frames.bin.gz': meta.dates?.length * (meta.width / 4) * (meta.height / 4) * 2 };
  for (const [name, bytes] of Object.entries(sizes)) {
    try {
      const n = gunzipSync(readFileSync(`${areasDir}/${id}/${name}`)).length;
      if (n !== bytes) problems.push(`${where}/${name}: ${n} bytes, the meta asks for ${bytes}`);
    } catch (e) {
      problems.push(`${where}/${name}: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
    }
  }
}

if (problems.length) {
  console.error(`site check failed, ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p.replace(/\n/g, '\n    ')}\n`);
  process.exit(1);
}
console.log(`site ok: ${scripts.length} scripts, ${places.length} places, ${areas.length} areas built on request`);
