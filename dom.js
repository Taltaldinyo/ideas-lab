// Small DOM helpers. Everything is built with createElement + textContent: no innerHTML anywhere,
// so text that came from the agent or from Tal can never become markup.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- icons (stroke icons, 24x24). Each icon is a list of path strings.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  hourglass: ['M7 2h10', 'M7 22h10', 'M8 2v4a4 4 0 0 0 1.6 3.2L12 12l-2.4 2.8A4 4 0 0 0 8 18v4', 'M16 2v4a4 4 0 0 1-1.6 3.2L12 12l2.4 2.8A4 4 0 0 1 16 18v4'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  // a page with a folded corner and text lines: the "דוח מוכן" state
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5'],
  'circle-check': ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4 12 14.01l-3-3'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  warning: ['M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  // a door frame on the right and an arrow leaving it to the left (mirrored for right-to-left)
  'log-out': ['M15 21h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4', 'M8 17l-5-5 5-5', 'M3 12h12'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  flask: ['M10 2v7.31', 'M14 9.3V1.99', 'M8.5 2h7', 'M14 9.3a6.5 6.5 0 1 1-4 0'],
  star: ['M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z'],
  check: ['M20 6 9 17l-5-5'],
  help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  save: ['M20 6 9 17l-5-5'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
};

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', ('ic ' + cls).trim());
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

// ---------- text with safe links.
// Only http and https addresses become links, and always with rel="noopener noreferrer" and target=_blank.
// Everything else (javascript:, data:, anything) stays plain text.
const URL_RE = /https?:\/\/[^\s<>"'֐-׿]+/gi;
const TRAILING = /[.,;:!?)\]}־׃'"]+$/;

export function linkify(text) {
  const frag = document.createDocumentFragment();
  const s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let raw = m[0];
    const trail = raw.match(TRAILING);
    if (trail) raw = raw.slice(0, raw.length - trail[0].length);
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
    frag.append(h('a', { class: 'ext-link', href: url.href, target: '_blank', rel: 'noopener noreferrer', text: raw }));
    last = m.index + raw.length;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

// A block of text that keeps the writer's line breaks.
export const prose = (text, cls = '') => h('p', { class: ('prose ' + cls).trim() }, linkify(text));

// ---------- dates (Israeli format, local time)
const p2 = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => { const x = new Date(d); return `${p2(x.getDate())}/${p2(x.getMonth() + 1)}/${x.getFullYear()}`; };

export function daysAgoText(d, now = new Date()) {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(d); b.setHours(0, 0, 0, 0);
  const n = Math.round((a - b) / 86400000);
  if (n <= 0) return 'היום';
  if (n === 1) return 'אתמול';
  if (n === 2) return 'לפני יומיים';
  return `לפני ${n} ימים`;
}

// ---------- toast (short message that rises from the bottom and leaves by itself)
let toastTimer = 0;
export function toast(message, ms = 2800) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  clearTimeout(toastTimer);
  el.replaceChildren(icon('check'), h('span', { text: message }));
  // restart the transition even when a toast is already showing
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
