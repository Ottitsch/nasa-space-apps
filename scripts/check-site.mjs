// Checks the site in web/ before it is published:
//   node scripts/check-site.mjs
//
// Run by .github/workflows/check.yml on pull requests, and by Cloudflare Pages
// as its build command, where a failure stops the publish. It needs nothing
// but Node.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const problems = [];

// Every script has to parse. There is no build step that would catch it.
const scripts = readdirSync(`${web}js`).filter(f => f.endsWith('.js')).sort();
for (const f of scripts) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(`${web}js/${f}`),
    encoding: 'utf8',
  });
  if (r.status !== 0) problems.push(`web/js/${f} does not parse\n${r.stderr.trim()}`);
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

if (problems.length) {
  console.error(`site check failed, ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p.replace(/\n/g, '\n    ')}\n`);
  process.exit(1);
}
console.log(`site ok: ${scripts.length} scripts, ${places.length} places`);
