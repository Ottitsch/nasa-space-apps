// The organise page: for every city with a local guide, the group where
// neighbours meet, on the app people there actually use. Groups are listed in
// each city file (web/action/cities/<id>.json, "groups"); add one with
// `python3 web/action/add_group.py <id> <platform> <url>`.

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); };
const REPO = 'https://github.com/Ottitsch/nasa-space-apps';

// How each app is named and how its group is started. Kept general: menus
// move between app versions, the invite link stays.
const PLATFORMS = {
  whatsapp: { name: 'WhatsApp', start: 'Create a WhatsApp group with one or two neighbours you know, give it the name below, then copy its invite link from the group info.' },
  telegram: { name: 'Telegram', start: 'Create a Telegram group, give it the name below, then copy its invite link from the group settings.' },
  wechat: { name: 'WeChat', start: 'Start a WeChat group chat with neighbours you know and give it the name below. Its QR code expires after a week, so share a fresh one or name a member who can add people.' },
  bale: { name: 'Bale', start: 'Create a group in Bale with the name below and copy its invite link from the group settings.' },
  rubika: { name: 'Rubika', start: 'Create a group in Rubika with the name below and copy its invite link from the group settings.' },
  eitaa: { name: 'Eitaa', start: 'Create a group in Eitaa with the name below and copy its invite link from the group settings.' },
  element: { name: 'Element', start: 'Install the Element app (in Iran the web version is blocked, the app works), create a room with the name below, and copy its matrix.to link.' },
  signal: { name: 'Signal', start: 'Create a Signal group with the name below and turn on its group link.' },
  viber: { name: 'Viber', start: 'Create a Viber group or community with the name below and copy its invite link.' },
  facebook: { name: 'Facebook', start: 'Create a Facebook group with the name below and copy its address.' },
  email: { name: 'Email list', start: 'Start an email list with the name below and share its sign up page.' },
};

// Share of OONI measurements that failed between 1 August and 15 November
// 2026 (null: too few measurements). Element: its server, matrix.org.
// WeChat: its website. Read from api.ooni.io on 15 November 2026.
const APPS = ['WhatsApp', 'Telegram', 'Signal', 'Element', 'WeChat'];
const REACH = {
  'Mexico': [3, 1, 2, 0, 0],
  'Brazil': [1, 1, 0, 0, 1],
  'India': [1, 2, 2, 1, 57],
  'Afghanistan': [7, 5, 21, null, 2],
  'Togo': [1, 0, 2, 0, 0],
  'Iran': [89, 95, 94, 3, 4],
  'Pakistan': [1, 100, 98, 0, 1],
  'Indonesia': [0, 1, 2, 1, 1],
  'Türkiye': [5, 7, 2, 0, 0],
  "Côte d'Ivoire": [2, 1, 2, 0, 1],
  'China': [97, 97, 96, 85, 6],
};
const NOTES = {
  'Iran|Element': 'works with the app; the web version is blocked',
  'India|WeChat': 'banned since 2020',
};
const verdict = p => (p == null ? ['nodata', 'no data'] : p < 15 ? ['ok', 'works'] : p <= 50 ? ['part', 'partly'] : ['no', 'blocked']);

const pick = (obj, lang) => (obj ? obj[lang] || obj.en || '' : '');

function rateOf(p) {
  if (!p || !p.hot_series_mm) return null;
  return -p.hot_series_mm[p.hot_series_mm.length - 1] / p.t_years[p.t_years.length - 1];
}

function card(c, p) {
  const lang = c.languages[0];
  // long names keep their detail in brackets out of the heading
  const short = n => n.replace(/\s*\(.*\)\s*$/, '');
  const full = pick(c.place_name, lang), local = short(full), en = short(c.place_name.en);
  const detail = full !== local ? full.slice(local.length).trim().replace(/^\(|\)$/g, '') : '';
  const country = c.country_name.en;
  const plats = (c.platforms || []).filter(k => PLATFORMS[k]);
  const main = plats[0];
  const groups = (c.groups || []).filter(g => /^https?:\/\//.test(g.url || ''));
  const rate = rateOf(p);
  const early = p && p.t_years[p.t_years.length - 1] < 0.7;
  const why = rate
    ? `Sinking up to <b>${(rate / 10).toFixed(rate < 100 ? 1 : 0)} cm per year</b>${p.builtup_sinking_km2 ? ` under <b>${p.builtup_sinking_km2 >= 10 ? Math.round(p.builtup_sinking_km2) : p.builtup_sinking_km2} km²</b> of built up land` : ''}${early ? ' (early result, a few months of radar)' : ''}.`
    : '';
  const blocked = APPS.filter((a, k) => (REACH[country] || [])[k] > 50 && !NOTES[`${country}|${a}`]);
  const used = `Used here: <b>${PLATFORMS[main].name}</b>`
    + (plats.length > 1 ? `, also ${plats.slice(1).map(k => PLATFORMS[k].name).join(', ')}` : '')
    + (blocked.length ? `. Blocked here: ${blocked.join(', ')}` : '') + '.';
  const name = pick(c.group_name, lang);
  const nameEn = c.group_name.en !== name ? c.group_name.en : '';
  const issue = `${REPO}/issues/new?` + new URLSearchParams({
    title: `Group for ${en}`,
    body: `City: ${en} (${c.id})\nApp: ${PLATFORMS[main].name}\nInvite link: \n\nI started this group and agree to list it on the organise page.`,
  });
  const join = groups.length
    ? `<div class="org-join">${groups.map(g => `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">Join on ${esc(PLATFORMS[g.platform]?.name || g.platform)}</a>`).join('')}</div>
       <p class="fine">${esc(groups[0].label || '')}</p>`
    : `<p class="org-none"><span>No group yet.</span> Be the one who starts it.</p>`;
  return `<article class="org-city" id="${esc(c.id)}" data-q="${esc((full + ' ' + c.place_name.en + ' ' + country).toLowerCase())}">
    <header>
      <h2>${esc(local)}${local !== en ? ` <span class="org-en">${esc(en)}</span>` : ''}</h2>
      ${detail ? `<p class="org-detail" dir="auto">${esc(detail)}</p>` : ''}
      <p class="org-where">${esc(country)} · <span class="org-status ${groups.length ? 'open' : 'none'}">${groups.length ? 'Group open' : 'Waiting for a first group'}</span></p>
    </header>
    ${why ? `<p class="org-why">${why} <a href="index.html#place=${esc(c.id)}">See it on the map</a></p>` : ''}
    ${join}
    <p class="org-used">${used}</p>
    <details class="org-start"${groups.length ? '' : ''}>
      <summary>${groups.length ? 'Start a group for your street' : 'Start the group'}</summary>
      <ol>
        <li>${esc(PLATFORMS[main].start)}</li>
        <li>Name: <code class="org-name" dir="auto">${esc(name)}</code> <button type="button" class="btn ghost org-copy" data-copy="${esc(name)}">Copy</button>${nameEn ? ` <span class="fine">(${esc(nameEn)})</span>` : ''}</li>
        <li>Share the take action report for your street in the group, so everyone starts from the same measurement.</li>
        <li>Send us the invite link and the group appears here for your city: <a href="${esc(issue)}" target="_blank" rel="noopener">send the link</a>.</li>
      </ol>
    </details>
    <details class="org-careful">
      <summary>Before you organise here</summary>
      <p>${esc(pick(c.organising?.note, 'en'))}</p>
    </details>
    <a class="btn ghost org-act" href="act.html#place=${esc(c.id)}">Take action in ${esc(en)}</a>
  </article>`;
}

function matrix() {
  const head = `<tr><th scope="col">Country</th>${APPS.map(a => `<th scope="col">${a}</th>`).join('')}<th scope="col">Email</th></tr>`;
  const rows = Object.entries(REACH).map(([country, v]) => `<tr><th scope="row">${esc(country)}</th>${v.map((p, k) => {
    const note = NOTES[`${country}|${APPS[k]}`];
    const [cls, word] = verdict(p);
    return `<td class="${note && cls === 'no' ? 'no' : note ? 'part' : cls}" title="${p == null ? 'too few measurements' : `${p}% of tests failed`}">${esc(note || word)}</td>`;
  }).join('')}<td class="ok">works</td></tr>`).join('');
  $('matrix').innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
  $('matrix-note').innerHTML = 'Share of tests by the Open Observatory of Network Interference (OONI) that failed in each country between 1 August and 15 November 2026: under 15 percent is shown as works, over 50 percent as blocked. Element is measured on its server, matrix.org; WeChat on its website. Email works everywhere: Gmail itself is blocked in China, but mail sent from it still reaches Chinese inboxes. <a href="https://explorer.ooni.org" target="_blank" rel="noopener">OONI Explorer</a>';
}

function project(community) {
  const item = (title, text, href, label) => `<div class="org-chan"><h3>${title}</h3><p>${text}</p>${href
    ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`
    : '<p class="fine">Opening soon.</p>'}</div>`;
  $('project').innerHTML = [
    item('For organisers in every city', 'One space on Element for the people who run the city groups, to share what worked. Element works in Iran with the app, where WhatsApp and Telegram do not, and nobody sees your phone number.', community.element, 'Join on Element'),
    item('The email list', 'Email is the one channel that reaches every country on this map, China and Iran included. News, new data and letters that got an answer.', community.email, 'Sign up'),
    item('Start your city', 'Open the map, click your street, and the take action page gives you the report and a guide to starting a group. Then send us the link.', 'index.html', 'Open the map'),
  ].join('');
}

async function main() {
  try {
    const [index, ids, community] = await Promise.all([json('data/index.json'), json('action/cities/index.json'), json('action/community.json').catch(() => ({}))]);
    const byId = Object.fromEntries(index.places.map(p => [p.id, p]));
    const cities = await Promise.all(ids.map(id => json(`action/cities/${id}.json`)));
    cities.sort((a, b) => (rateOf(byId[b.id]) || 0) - (rateOf(byId[a.id]) || 0));
    $('list').innerHTML = cities.map(c => card(c, byId[c.id])).join('');
    const open = cities.filter(c => (c.groups || []).length).length;
    $('counts').textContent = `${cities.length} cities with a local guide, ${open} with a group open. Fastest sinking first.`;
    matrix();
    project(community);
    $('status').hidden = true;
    $('main').hidden = false;

    const cards = [...document.querySelectorAll('.org-city')];
    $('find').addEventListener('input', () => {
      const q = $('find').value.trim().toLowerCase();
      for (const el of cards) el.hidden = !!q && !el.dataset.q.includes(q);
      $('nomatch').hidden = cards.some(el => !el.hidden);
    });
    $('list').addEventListener('click', async e => {
      const b = e.target.closest('.org-copy');
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
    const hash = decodeURIComponent(location.hash.slice(1));
    const target = hash && document.getElementById(hash);
    if (target && target.classList.contains('org-city')) {
      target.classList.add('org-here');
      target.querySelector('.org-start')?.setAttribute('open', '');
      target.scrollIntoView({ block: 'start' });
    }
  } catch (e) {
    $('status').textContent = `Could not load the cities: ${e.message}`;
    $('status').classList.add('err');
  }
}

main();
