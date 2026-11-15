// Colour themes for the map page. One place defines every colour there that is
// not neutral black or white, so the map, the legends and the panels follow the
// theme the visitor picked. The choice is kept in localStorage and can be
// forced from the address with #theme=sage.
//
// Two things stay as they are in every theme. The Take action card and button
// keep their amber (css/style.css). The take action page keeps its own bright
// design: it carries no data-theme on <html>, so nothing is painted there, and
// it only takes the risk colours (through config.js) so that its report shows
// the buildings in the colours the visitor saw on the map.

const STORE = 'sinkingground-theme';

// ramp: [position 0..1, r, g, b, alpha] for the amount of sinking (log scale).
// risk: no sinking detected, sinking evenly, cracking possible, cracking likely, structural damage.
const DATA = {
  steel: {
    ramp: [[0.0, 31, 42, 68, 150], [0.3, 63, 111, 143, 190], [0.58, 143, 184, 176, 215], [0.82, 214, 222, 208, 230], [1.0, 233, 228, 212, 240]],
    risk: ['#4a5568', '#6f9fb0', '#d6b25e', '#c4623f', '#8e2f4a'],
    unit: '#1f2a44',
  },
  sage: {
    ramp: [[0.0, 29, 43, 42, 150], [0.3, 61, 107, 99, 190], [0.58, 143, 181, 164, 215], [0.82, 208, 222, 206, 230], [1.0, 230, 236, 223, 240]],
    risk: ['#4a5755', '#7fa3a0', '#d4b062', '#b9573d', '#7d2f45'],
    unit: '#1d2b2a',
  },
};

export const THEMES = {
  bone: {
    name: 'Bone & ink',
    ...DATA.steel,
    css: {
      '--accent': '#e8e2d6', '--accent-rgb': '232, 226, 214', '--accent-hover': '#f4efe6', '--accent-ink': '#15181d',
      '--proj': '#cdb98a', '--proj-rgb': '205, 185, 138',
      '--glass-bg': 'rgba(24, 28, 32, 0.62)',
      '--bg-a': '#12161c', '--bg-b': '#06080a', '--ramp-unit': DATA.steel.unit,
    },
    basemap: { sky: '#0b1114', horizon: '#3c5560', land: '#0b1013', night: '#05080a', water: 'rgba(206,218,218,0.7)' },
    themeColor: '#0b1013',
  },
  sage: {
    name: 'Slate & sage',
    ...DATA.sage,
    css: {
      '--accent': '#a9c5a0', '--accent-rgb': '169, 197, 160', '--accent-hover': '#bdd4b5', '--accent-ink': '#121a14',
      '--proj': '#d9c9a3', '--proj-rgb': '217, 201, 163',
      '--glass-bg': 'rgba(22, 29, 25, 0.62)',
      '--bg-a': '#111714', '--bg-b': '#060907', '--ramp-unit': DATA.sage.unit,
    },
    basemap: { sky: '#0a100e', horizon: '#3a5550', land: '#0a100e', night: '#050806', water: 'rgba(200,218,212,0.7)' },
    themeColor: '#0a100e',
  },
  mono: {
    name: 'Monochrome',
    ...DATA.steel,
    css: {
      '--accent': '#ffffff', '--accent-rgb': '255, 255, 255', '--accent-hover': '#e8e8e8', '--accent-ink': '#101214',
      '--proj': '#b8b8b8', '--proj-rgb': '184, 184, 184',
      '--glass-bg': 'rgba(24, 24, 24, 0.62)',
      '--bg-a': '#151515', '--bg-b': '#050505', '--ramp-unit': DATA.steel.unit,
    },
    basemap: { sky: '#0a0a0a', horizon: '#474747', land: '#0b0b0b', night: '#050505', water: 'rgba(220,220,220,0.7)' },
    themeColor: '#0b0b0b',
  },
};

export const DEFAULT_THEME = 'bone';

const listeners = [];
let currentId = DEFAULT_THEME;

function pick() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('theme');
  let stored = null;
  try { stored = localStorage.getItem(STORE); } catch { /* private mode: fine */ }
  for (const id of [fromHash, stored]) if (id && THEMES[id]) return id;
  return DEFAULT_THEME;
}

export const theme = () => THEMES[currentId];
export const themeId = () => currentId;

/** Run fn after every theme change (not on the first, silent application). */
export const onTheme = fn => listeners.push(fn);

function favicon(t) {
  const a = encodeURIComponent(t.css['--accent']), ink = encodeURIComponent(t.css['--accent-ink']);
  const href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='${a}'/%3E%3Cpath d='M6 12.5c4 0 5 8.5 10 8.5s6-8.5 10-8.5' fill='none' stroke='${ink}' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E`;
  document.querySelector('link[rel="icon"]')?.setAttribute('href', href);
}

function paint() {
  const t = theme(), root = document.documentElement;
  if (!('theme' in root.dataset)) return;   // only a page that asks for it wears the theme
  for (const [k, v] of Object.entries(t.css)) root.style.setProperty(k, v);
  root.dataset.theme = currentId;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.themeColor);
  favicon(t);
}

export function setTheme(id, { save = true } = {}) {
  if (!THEMES[id] || id === currentId) return;
  currentId = id;
  if (save) { try { localStorage.setItem(STORE, id); } catch { /* ignore */ } }
  paint();
  for (const fn of listeners) fn(theme());
}

/** Fill a <select> with the themes and keep it in step with the current one. */
export function themeSelect(el, { onChange } = {}) {
  el.innerHTML = Object.entries(THEMES).map(([id, t]) => `<option value="${id}">${t.name}</option>`).join('');
  el.value = currentId;
  el.addEventListener('change', () => { setTheme(el.value); onChange?.(el.value); });
  onTheme(() => { el.value = currentId; });
}

currentId = pick();
paint();
