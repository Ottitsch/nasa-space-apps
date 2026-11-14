// PDF downloads without a server.
//
// The browser already knows how to draw the report in every script we support
// (Latin, Arabic, Devanagari, Chinese). So the report is drawn to a canvas with
// html2canvas, saved as a JPEG, and wrapped in a small hand written PDF: one
// A4 page per image, plus real link areas so addresses stay clickable.
// The text in the PDF is a picture, so it cannot be selected or searched.

const A4 = [595.28, 841.89];   // points
const MARGIN = 34;             // 12 mm

let loading = null;
/** Load html2canvas on first use: it is 200 KB and most visits never need it. */
function html2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/html2canvas.min.js', import.meta.url).href;
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => { loading = null; reject(new Error('could not load the PDF helper')); };
    document.head.append(s);
  });
  return loading;
}

/**
 * Draw an element as it looks on a wide screen, whatever the device.
 * prepare(doc, el) runs on the copy just before drawing: use it to adjust the
 * copy or to measure things in it. Returns a canvas.
 */
export async function draw(element, { scale = 2.5, prepare } = {}) {
  const h2c = await html2canvas();
  return h2c(element, {
    scale, backgroundColor: '#ffffff', logging: false, useCORS: true,
    windowWidth: 1200,                       // lay out the copy as on a desktop, even on a phone
    ignoreElements: el => el.classList?.contains('screen'),
    onclone: (doc, el) => {
      doc.documentElement.classList.add('pdf');
      prepare?.(doc, el);
    },
  });
}

const jpeg = canvas => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? b.arrayBuffer().then(a => resolve(new Uint8Array(a))) : reject(new Error('could not encode the image'))), 'image/jpeg', 0.92));

/** Cut a tall canvas into page sized pieces, breaking only on blank rows. */
export function paginate(canvas) {
  const pageH = Math.floor(canvas.width * ((A4[1] - 2 * MARGIN) / (A4[0] - 2 * MARGIN)));
  // a little too long: one page, shrunk slightly, beats a second page with two lines on it
  if (canvas.height <= pageH * 1.15) return [canvas];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const blank = y => {
    const row = ctx.getImageData(0, y, canvas.width, 1).data;
    for (let i = 0; i < row.length; i += 16) if (row[i] < 245 || row[i + 1] < 245 || row[i + 2] < 245) return false;
    return true;
  };
  const pieces = [];
  let top = 0;
  while (top < canvas.height) {
    let bottom = Math.min(canvas.height, top + pageH);
    if (bottom < canvas.height) {
      for (let y = bottom; y > bottom - pageH * 0.25; y--) if (blank(y)) { bottom = y; break; }
    }
    const piece = document.createElement('canvas');
    piece.width = canvas.width; piece.height = bottom - top;
    const c = piece.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, piece.width, piece.height);
    c.drawImage(canvas, 0, -top);
    pieces.push(piece);
    top = bottom;
  }
  return pieces;
}

const hex16 = text => '<FEFF' + [...text].flatMap(ch => {
  const c = ch.codePointAt(0);
  const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
  return units.map(u => u.toString(16).padStart(4, '0'));
}).join('').toUpperCase() + '>';
const lit = text => '(' + text.replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '') + ')';
const n2 = v => v.toFixed(2);

/**
 * Build a PDF from canvases, one per page.
 * links: [{ page, x, y, w, h, url }] in canvas pixels of that page, origin top left.
 */
export async function build(canvases, { title = '', links = [] } = {}) {
  const enc = new TextEncoder();
  const chunks = [], offsets = [];
  let size = 0;
  const put = c => { const b = typeof c === 'string' ? enc.encode(c) : c; chunks.push(b); size += b.length; };
  const obj = (id, write) => { offsets[id] = size; put(`${id} 0 obj\n`); write(); put('\nendobj\n'); };

  put('%PDF-1.4\n%âãÏÓ\n');
  const count = canvases.length, infoId = 3 + 3 * count;
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${count} /Kids [${canvases.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`));

  for (let i = 0; i < count; i++) {
    const cv = canvases[i], img = await jpeg(cv);
    const k = Math.min((A4[0] - 2 * MARGIN) / cv.width, (A4[1] - 2 * MARGIN) / cv.height);
    const w = cv.width * k, h = cv.height * k, x = (A4[0] - w) / 2, y = A4[1] - MARGIN - h;
    const annots = links.filter(l => l.page === i && /^https?:\/\//.test(l.url)).map(l => {
      const x1 = x + l.x * k, y2 = y + h - l.y * k;
      return `<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [${n2(x1)} ${n2(y2 - l.h * k)} ${n2(x1 + l.w * k)} ${n2(y2)}] /A << /S /URI /URI ${lit(encodeURI(l.url))} >> >>`;
    });
    const content = enc.encode(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(y)} cm /Im0 Do Q`);
    const page = 3 + 3 * i;
    obj(page, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`));
    obj(page + 1, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
      put(img); put('\nendstream');
    });
    obj(page + 2, () => { put(`<< /Length ${content.length} >>\nstream\n`); put(content); put('\nendstream'); });
  }
  const d = new Date(), p = v => String(v).padStart(2, '0');
  const stamp = `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  obj(infoId, () => put(`<< /Title ${hex16(title)} /Producer (Sinking Ground) /CreationDate (${stamp}) >>`));

  const xref = size;
  put(`xref\n0 ${infoId + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= infoId; id++) put(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${infoId + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

export function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
