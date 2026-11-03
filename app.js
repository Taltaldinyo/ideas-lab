// מעבדת רעיונות - the screens. Hebrew, right-to-left, phone first.
// Rule for every status: a word AND an icon (Tal is partly colour blind), never colour alone.
// Rule for every piece of text that came from the database: textContent only (see dom.js).
import { h, icon, prose, linkify, fmtDate, daysAgoText, toast, debounce } from './dom.js?v=4';
import * as api from './data.js?v=4';
import { AGENT_STALE_HOURS } from './config.js?v=4';

const root = document.getElementById('app');

// ---------- what each status and verdict looks like
// The database value of "waiting" never changed; only the word on screen did ("דוח מוכן": the agent finished a report).
const STATUS = {
  with_agent: { word: 'אצל הסוכן', ic: 'hourglass', cls: 'agent' },
  waiting: { word: 'דוח מוכן', ic: 'file', cls: 'waiting' },
  ready: { word: 'מוכן לבנייה', ic: 'circle-check', cls: 'ready' },
  deleted: { word: 'נמחק', ic: 'trash', cls: 'deleted' },
};
const TABS = ['with_agent', 'waiting', 'ready', 'deleted'];
const VERDICT = {
  potential: { word: 'יש פוטנציאל', ic: 'star' },
  worth: { word: 'שווה', ic: 'check' },
  depends: { word: 'תלוי ב...', ic: 'help' },
  nothing: { word: 'אין כאן כלום', ic: 'x' },
};
const EMPTY = {
  with_agent: ['אין רעיונות אצל הסוכן', 'רעיון חדש שתוסיף למעלה יופיע כאן עד שהסוכן יענה.'],
  waiting: ['אין דוחות מוכנים', 'כשהסוכן יסיים דוח, הרעיון יעבור לכאן.'],
  ready: ['אין עדיין רעיון מוכן לבנייה', 'רעיון שתבחר "לבנייה" יופיע כאן עם תקציר.'],
  deleted: ['לא נמחק אף רעיון', 'רעיון שתמחק יישמר כאן עם הסיבה.'],
};
// the fixed one-line explanation of each part of a report (the same words every time)
const PART = {
  verdict: ['השורה התחתונה', 'מה הסוכן חושב על הרעיון, במשפט'],
  changes: ['מה השתנה מאז הסבב הקודם', 'מה הסוכן עדכן אחרי התשובות שלך'],
  questions: ['שאלות אליך', 'מה הסוכן צריך לדעת ממך כדי להתקדם'],
  plan: ['תוכנית בשלבים', 'איך מתקדמים, צעד אחרי צעד'],
  pros: ['יתרונות', 'מה טוב ברעיון'],
  cons: ['חסרונות', 'מה עלול להפריע או להכשיל'],
  facts: ['זמן ועלות', 'כמה זמן זה ייקח וכמה זה יעלה'],
};
const SKELETON_DELAY = 150; // a screen that loads faster than this never shows a skeleton

// ---------- phone storage (survives closing the app)
const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  delPrefix(prefix) { try { Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } },
};
const PENDING_KEY = 'ideas:pending';
const NEW_DRAFT_KEY = 'ideas:draft:new';

const S = {
  ideas: [], summaries: [], loaded: false, loadError: false,
  tab: sessionStorage.getItem('ideas:tab') || null,
  pending: store.get(PENDING_KEY, []),
  flushing: false, justAdded: null, listScroll: 0, lastLoad: 0,
  saveDrafts: null, // set by the open report: writes the answers being typed to the phone right now
  signedIn: false, // false on the sign-in screen: nothing is sent to the database from there (it would only bounce back)
  signingOut: false, // true while a sign-out the user asked for is running, so the "signed out" event does not repaint over it
};
let routeSeq = 0;
let listRefs = null; // pieces of the list screen that get repainted without rebuilding the quick-add form

const isDetail = () => /^#\/idea\//.test(location.hash);
const setTab = (t) => { S.tab = t; try { sessionStorage.setItem('ideas:tab', t); } catch { /* ignore */ } };

// ---------- motion. Plain CSS animations (style.css), so they run the same in every browser: a screen fades in and rises 8px
// over 0.28 s; a folded part of the report opens and closes the same way; a press shrinks the element and tints it in 0.12 s.
// (An earlier version used the browser's view-transition cross-fade; measured in Chrome it waited about 0.2 s, then faded two
// near-identical cream screens into each other with no movement, which could not be felt.)
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fire = (p) => p.catch((e) => console.error(e));

// <details> that fades when it opens and when it closes (the browser only fades the opening on its own).
function softDetails(d) {
  const sum = d.querySelector(':scope > summary');
  if (!sum) return d;
  sum.addEventListener('click', (e) => {
    if (!d.open || reducedMotion()) return; // opening: the browser opens it and CSS fades the content in
    e.preventDefault();
    if (d.classList.contains('closing')) return;
    d.classList.add('closing'); // the + shows at once; the content fades; then it really closes
    setTimeout(() => { d.open = false; d.classList.remove('closing'); }, 170);
  });
  return d;
}

// "נשארו N תווים" under a text field that has a limit, once it is close. The field itself cuts at the limit, so say so.
function limitNote(input, max) {
  const el = h('span', { class: 'limit-note', 'aria-live': 'polite' });
  const sync = () => {
    const left = max - input.value.length;
    el.textContent = left <= 0 ? 'הגעת לאורך המקסימלי' : left <= Math.max(20, Math.round(max * 0.1)) ? `נשארו ${left} תווים` : '';
  };
  input.addEventListener('input', sync);
  sync();
  return el;
}

// ---------- small building blocks
function statusBadge(status) {
  const s = STATUS[status] || STATUS.with_agent;
  return h('span', { class: `badge badge-${s.cls}` }, icon(s.ic), h('span', { text: s.word }));
}
function verdictChip(verdict) {
  const v = VERDICT[verdict];
  if (!v) return null;
  return h('span', { class: `chip chip-${verdict}` }, icon(v.ic), h('span', { text: v.word }));
}
const demoBanner = () => (api.isDemo ? h('p', { class: 'demo-banner', role: 'note' }, icon('warning'), h('span', { text: 'נתוני דוגמה - אלה לא הרעיונות שלך' })) : null);
const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

function mount(...nodes) {
  root.replaceChildren(...nodes);
  root.removeAttribute('aria-busy');
}

// ---------- sign in
// calm: the message is information (you signed out), not an error, so it is not drawn in the error colour
function showLogin(message = '', { calm = false } = {}) {
  routeSeq++;
  listRefs = null;
  S.saveDrafts = null;
  S.signedIn = false;
  document.title = 'מעבדת רעיונות';
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, 'aria-describedby': 'login-msg' });
  const msg = h('p', { id: 'login-msg', class: 'form-msg' + (calm ? ' form-note' : ''), role: 'alert', text: message });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'כניסה' });
  const form = h('form', { class: 'login-card card', onsubmit: async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    if (!pw.value) { msg.textContent = 'כתוב את הסיסמה'; return; }
    btn.disabled = true; btn.replaceChildren(spinner(), 'נכנס...'); msg.textContent = '';
    try {
      await api.signIn(pw.value);
      pw.value = '';
      start();
    } catch (err) {
      msg.textContent = err instanceof api.WrongPasswordError ? 'הסיסמה שגויה' : 'הכניסה נכשלה, בדוק חיבור ונסה שוב';
      btn.disabled = false; btn.textContent = 'כניסה';
      pw.select();
    }
  } },
  h('div', { class: 'login-logo' }, icon('flask')),
  h('h1', { class: 'display', text: 'מעבדת רעיונות' }),
  h('label', { for: 'pw', text: 'סיסמה' }), pw, msg, btn);
  mount(h('div', { class: 'login' }, form));
  pw.focus();
}

// ---------- the list
function agentStatus() {
  const runs = S.summaries.map((s) => s.createdAt).sort();
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const queued = S.ideas.filter((i) => i.status === 'with_agent');
  const oldestQueued = queued.map((i) => i.createdAt).sort()[0];
  const ref = lastRun || oldestQueued;
  const stale = queued.length > 0 && ref && (Date.now() - new Date(ref).getTime()) > AGENT_STALE_HOURS * 3600000;
  const box = h('div', { class: 'agent-status card-soft' },
    h('div', { class: 'agent-row' },
      h('p', { class: 'agent-last' },
        icon('flask'),
        h('span', { text: lastRun ? `הסוכן רץ לאחרונה: ${fmtDate(lastRun)}` : 'הסוכן עוד לא רץ' }),
        lastRun ? h('span', { class: 'muted', text: ` (${daysAgoText(lastRun)})` }) : null),
      h('p', { class: 'agent-queue' }, h('span', { text: 'בתור: ' }), h('strong', { text: String(queued.length) }))));
  if (stale) {
    box.append(h('p', { class: 'warn', role: 'status' }, icon('warning'),
      h('span', {}, h('strong', { text: 'שים לב: ' }),
        lastRun ? `עברו יותר מיומיים מאז שהסוכן רץ, ויש ${queued.length} ${queued.length === 1 ? 'רעיון' : 'רעיונות'} בתור.` : `הסוכן עוד לא רץ, ויש ${queued.length} ${queued.length === 1 ? 'רעיון' : 'רעיונות'} בתור.`,
        ' בשלב הזה מפעילים אותו בשיחה: "תריץ על הרעיונות".')));
  }
  return box;
}

function ideaCard(idea) {
  const verdicts = S.summaries.filter((s) => s.ideaId === idea.id).sort((a, b) => b.round - a.round);
  const v = idea.status === 'waiting' || idea.status === 'ready' ? verdicts[0]?.verdict : null;
  const when = idea.status === 'waiting' && verdicts[0] ? `דוח עודכן ${fmtDate(verdicts[0].createdAt)}`
    : idea.status === 'deleted' && idea.decidedAt ? `נמחק ${fmtDate(idea.decidedAt)}`
    : `נוסף ${fmtDate(idea.createdAt)}`;
  const card = h('a', { class: 'idea-card' + (S.justAdded === idea.id ? ' just-added' : ''), href: `#/idea/${idea.id}` },
    h('div', { class: 'idea-card-main' },
      h('p', { class: 'idea-card-title', text: idea.title }),
      h('div', { class: 'idea-card-meta' },
        statusBadge(idea.status),
        idea.currentRound > 0 ? h('span', { class: 'round-tag', text: `סבב ${idea.currentRound}` }) : null,
        v ? verdictChip(v) : null),
      h('p', { class: 'idea-card-date', text: when })),
    icon('chevron-left', 'idea-card-arrow'));
  return card;
}

function selectTab(t, { focus = false } = {}) {
  setTab(t); paintTabs({ animate: true }); paintList({ animate: true });
  if (focus) listRefs?.tabs.querySelector(`[data-tab="${t}"]`)?.focus({ preventScroll: true });
}

function paintTabs({ animate = false } = {}) {
  if (!listRefs) return;
  const hadFocus = listRefs.tabs.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
  const counts = Object.fromEntries(TABS.map((t) => [t, S.ideas.filter((i) => i.status === t).length]));
  listRefs.tabs.replaceChildren(...TABS.map((t) => {
    const st = STATUS[t];
    const selected = S.tab === t;
    return h('button', { type: 'button', role: 'tab', class: 'tab' + (selected ? ' selected' : '') + (selected && animate ? ' just-selected' : ''), 'aria-selected': selected ? 'true' : 'false', tabindex: selected ? '0' : '-1', 'data-tab': t,
      onclick: () => selectTab(t) },
      icon(st.ic), h('span', { class: 'tab-word', text: st.word }), h('span', { class: 'tab-count', text: String(counts[t]) }));
  }));
  // the buttons are rebuilt on every change; a keyboard user must not lose their place
  if (hadFocus) listRefs.tabs.querySelector(`[data-tab="${hadFocus}"]`)?.focus({ preventScroll: true });
}

function onTabKeys(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const from = e.target.dataset?.tab;
  if (!from) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' ? 1 : -1; // right-to-left: the next tab is on the left
  selectTab(TABS[(TABS.indexOf(from) + step + TABS.length) % TABS.length], { focus: true });
}

function paintList({ animate = false } = {}) {
  if (!listRefs) return;
  const box = listRefs.list;
  if (!S.loaded && !S.loadError) {
    box.replaceChildren(...[0, 1, 2].map(() => h('div', { class: 'idea-card skel-card', 'aria-hidden': 'true' }, h('span', { class: 'skel skel-line' }), h('span', { class: 'skel skel-line short' }))));
    box.setAttribute('aria-busy', 'true');
    return;
  }
  box.removeAttribute('aria-busy');
  if (S.loadError && !S.loaded) {
    const retry = h('button', { type: 'button', class: 'btn btn-primary', text: 'נסה שוב' });
    retry.addEventListener('click', () => { retry.disabled = true; retry.replaceChildren(spinner(), 'טוען...'); fire(loadList()); });
    box.replaceChildren(h('div', { class: 'empty card-soft', role: 'alert' }, icon('warning'), h('p', { class: 'empty-title', text: 'לא הצלחתי לטעון את הרעיונות' }),
      h('p', { class: 'muted', text: 'בדוק חיבור לאינטרנט ונסה שוב. מה שכתבת נשמר בטלפון.' }), retry));
    return;
  }
  const items = S.ideas.filter((i) => i.status === S.tab);
  if (!items.length) {
    const [t, sub] = EMPTY[S.tab];
    const goAdd = S.tab === 'with_agent' ? h('button', { type: 'button', class: 'btn btn-soft', onclick: () => {
      window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
      document.getElementById('qa-title')?.focus({ preventScroll: true });
    } }, icon('plus'), h('span', { text: 'הוסף רעיון' })) : null;
    box.replaceChildren(h('div', { class: 'empty card-soft' + (animate ? ' enter' : '') }, icon(STATUS[S.tab].ic, 'empty-ic'), h('p', { class: 'empty-title', text: t }), h('p', { class: 'muted', text: sub }), goAdd));
    return;
  }
  const ul = h('ul', { class: 'idea-list' + (animate ? ' enter' : ''), role: 'list' }, ...items.map((i) => h('li', {}, ideaCard(i))));
  if (S.loadError) ul.before(h('p', { class: 'warn small', role: 'status' }, icon('warning'), h('span', { text: 'הרענון נכשל. מוצג מה שנטען קודם.' })));
  box.replaceChildren(ul);
  if (S.justAdded) { const id = S.justAdded; setTimeout(() => { if (S.justAdded === id) S.justAdded = null; }, 1600); }
}

function paintStatus() {
  if (!listRefs) return;
  listRefs.status.replaceChildren(S.loaded ? agentStatus() : h('div', { class: 'agent-status card-soft', 'aria-hidden': 'true' }, h('span', { class: 'skel skel-line short' })));
}

function pendingTitle(n, failed) {
  if (S.flushing) return 'שולח...';
  const one = n === 1;
  const saved = one ? 'רעיון אחד נשמר' : `${n} רעיונות נשמרו`;
  return failed ? `${saved} בטלפון ולא ${one ? 'נשלח' : 'נשלחו'}` : `${saved} בטלפון ו${one ? 'ממתין' : 'ממתינים'} לשליחה`;
}

function paintPending() {
  if (!listRefs) return;
  const box = listRefs.pending;
  if (!S.pending.length) { box.replaceChildren(); return; }
  const failed = S.pending.some((p) => p.failed);
  const n = S.pending.length;
  box.replaceChildren(h('div', { class: 'pending card-soft', role: 'status' },
    h('p', { class: 'pending-title' }, icon('clock'),
      h('span', { text: pendingTitle(n, failed) })),
    h('ul', { class: 'pending-list' }, ...S.pending.map((p) => h('li', { text: p.title }))),
    failed ? h('p', { class: 'muted small', text: 'הרעיון בטוח בטלפון. ננסה שוב אוטומטית כשיהיה חיבור.' }) : null,
    h('button', { type: 'button', class: 'btn btn-soft btn-small', disabled: S.flushing, onclick: () => flushPending(true) },
      S.flushing ? [spinner(), 'שולח...'] : 'שלח עכשיו')));
}

function quickAdd() {
  const draft = store.get(NEW_DRAFT_KEY, { title: '', details: '' });
  const title = h('input', { type: 'text', id: 'qa-title', maxlength: 300, placeholder: 'רעיון חדש בשורה אחת', autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'רעיון חדש' });
  const details = h('textarea', { id: 'qa-details', rows: 3, maxlength: 4000, placeholder: 'פירוט, אם יש (לא חובה)', 'aria-label': 'פירוט לרעיון', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary qa-submit', disabled: true }, icon('plus'), h('span', { text: 'הוסף' }));
  const count = h('span', { class: 'qa-count', 'aria-live': 'polite' });
  const detailsNote = limitNote(details, 4000);
  const toggle = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false', 'aria-controls': 'qa-details' }, h('span', { text: 'הוסף פירוט' }));
  title.value = draft.title || ''; details.value = draft.details || '';
  const showDetails = (on) => { details.hidden = !on; toggle.setAttribute('aria-expanded', String(on)); toggle.firstChild.textContent = on ? 'בלי פירוט' : 'הוסף פירוט'; };
  if (details.value) showDetails(true);
  const sync = () => {
    submit.disabled = !title.value.trim();
    const left = 300 - title.value.length;
    count.textContent = left <= 0 ? 'הגעת לאורך המקסימלי' : left <= 50 ? `נשארו ${left} תווים` : '';
    if (title.value || details.value) store.set(NEW_DRAFT_KEY, { title: title.value, details: details.value }); else store.del(NEW_DRAFT_KEY);
  };
  title.addEventListener('input', sync);
  details.addEventListener('input', sync);
  toggle.addEventListener('click', () => { showDetails(details.hidden); if (!details.hidden) details.focus(); });
  sync();
  const form = h('form', { class: 'qa card', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const t = title.value.trim();
    if (!t) return; // a second tap or a second Enter finds the field already empty, so nothing is sent twice
    addPending({ id: crypto.randomUUID(), title: t.slice(0, 300), details: details.value.trim().slice(0, 4000), savedAt: Date.now() });
    title.value = ''; details.value = ''; showDetails(false); store.del(NEW_DRAFT_KEY); sync();
    detailsNote.textContent = '';
    title.focus();
  } },
  h('div', { class: 'qa-row' }, title, submit),
  h('div', { class: 'qa-sub' }, toggle, count),
  details, detailsNote);
  return form;
}

function renderList() {
  ++routeSeq;
  S.saveDrafts = null;
  document.title = 'מעבדת רעיונות';
  {
    const status = h('div', { class: 'status-slot' });
    const pending = h('div', { class: 'pending-slot' });
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'מצב הרעיון' });
    tabs.addEventListener('keydown', onTabKeys);
    const list = h('div', { class: 'list-slot', role: 'tabpanel' });
    listRefs = { status, pending, tabs, list };
    mount(h('div', { class: 'screen' },
      h('header', { class: 'topbar' }, h('h1', { class: 'display app-title' }, icon('flask'), h('span', { text: 'מעבדת רעיונות' }))),
      demoBanner(),
      quickAdd(), pending, status, tabs, list,
      h('footer', { class: 'foot' },
        h('button', { type: 'button', class: 'link-btn', id: 'export-btn', onclick: doExport }, icon('download'), h('span', { text: 'ייצוא כל הרעיונות לקובץ (JSON)' })),
        h('button', { type: 'button', class: 'link-btn', id: 'signout-btn', onclick: (e) => openSignOutDialog(e.currentTarget) }, icon('log-out'), h('span', { text: 'התנתק' })))));
    paintPending(); paintStatus(); paintTabs(); paintList();
    if (S.loaded) window.scrollTo(0, S.listScroll);
    fire(loadList());
  }
}

async function loadList() {
  const first = !S.loaded;
  let ok = false;
  try {
    const [ideas, summaries] = await Promise.all([api.listIdeas(), api.listRoundSummaries()]);
    S.ideas = ideas; S.summaries = summaries; S.loaded = true; S.loadError = false; S.lastLoad = Date.now();
    if (!S.tab || !TABS.includes(S.tab)) setTab(ideas.some((i) => i.status === 'waiting') ? 'waiting' : 'with_agent');
    ok = true;
  } catch (e) {
    if (api.isAuthError(e)) return showLogin('נדרשת כניסה מחדש');
    S.loadError = true;
  }
  if (!S.tab) setTab('with_agent');
  // the first real list replaces the grey placeholders with a fade; a silent refresh later changes nothing visible, so it does not animate
  paintStatus(); paintTabs(); paintList({ animate: ok && first });
}

// ---------- adding an idea: saved on the phone first, sent to the database after
function addPending(item) {
  S.pending.push(item);
  store.set(PENDING_KEY, S.pending);
  toast('נשמר בטלפון, שולח...');
  paintPending();
  flushPending();
}

async function flushPending(manual = false) {
  if (S.flushing || !S.signedIn || !S.pending.length) return;
  S.flushing = true; paintPending();
  let sent = 0, lastId = null;
  while (S.pending.length) {
    const item = S.pending[0];
    try {
      await api.addIdea({ id: item.id, title: item.title, details: item.details });
      S.pending.shift(); store.set(PENDING_KEY, S.pending);
      sent++; lastId = item.id;
    } catch (e) {
      if (api.isAuthError(e)) { S.flushing = false; return showLogin('נדרשת כניסה מחדש. הרעיון נשמר בטלפון ויישלח אחרי הכניסה.'); }
      item.failed = true;
      break;
    }
  }
  S.flushing = false;
  if (sent) {
    S.justAdded = lastId; setTab('with_agent');
    toast(sent === 1 ? 'הרעיון נוסף' : `${sent} רעיונות נוספו`);
    await loadList();
  } else if (manual) {
    toast('עדיין אין חיבור. הרעיון בטוח בטלפון.');
  }
  paintPending();
}

// ---------- export
async function doExport() {
  const btn = document.getElementById('export-btn');
  btn.disabled = true;
  try {
    const data = await api.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `ideas-lab-${api.isDemo ? 'SAMPLE-' : ''}${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('הקובץ נוצר');
  } catch (e) {
    if (api.isAuthError(e)) return showLogin('נדרשת כניסה מחדש');
    toast('הייצוא נכשל, נסה שוב');
  } finally { btn.disabled = false; }
}

// ---------- sign out
// Is there text typed on this device that is not in the database? (The new-idea box and the answers being written are
// saved to the phone as you type, under "ideas:draft:...".)
function hasDrafts() {
  try {
    return Object.keys(localStorage).some((k) => {
      if (!k.startsWith('ideas:draft:')) return false;
      const v = store.get(k, '');
      return typeof v === 'string' ? Boolean(v.trim()) : Boolean(v && Object.values(v).some((x) => typeof x === 'string' && x.trim()));
    });
  } catch { return false; }
}

// A short confirmation first, because signing out cancels the sign-in on the phone AND the computer. It also says out loud
// what stays on this device (ideas not sent yet, drafts): signing out never deletes text.
function openSignOutDialog(opener) {
  let busy = false, closing = null;
  const waiting = S.pending.length;
  const cancel = h('button', { type: 'button', class: 'btn btn-soft', id: 'signout-cancel', text: 'ביטול' });
  const confirmLabel = () => [icon('log-out'), h('span', { text: 'התנתק' })];
  const confirm = h('button', { type: 'button', class: 'btn btn-primary', id: 'signout-confirm' }, ...confirmLabel());
  const dlg = h('dialog', { class: 'confirm calm', role: 'alertdialog', 'aria-labelledby': 'signout-title', 'aria-describedby': 'signout-desc' },
    h('div', { class: 'confirm-body' },
      h('h2', { id: 'signout-title', class: 'confirm-title' }, icon('log-out'), h('span', { text: 'להתנתק?' })),
      h('div', { id: 'signout-desc' },
        h('p', { class: 'confirm-text', text: 'החיבור יתבטל בכל המכשירים, בטלפון ובמחשב. כדי להיכנס שוב תצטרך את הסיסמה.' }),
        waiting ? h('p', { class: 'confirm-text keep' }, icon('save'), h('span', { text: waiting === 1 ? 'רעיון אחד שעוד לא נשלח נשאר שמור במכשיר הזה, ויישלח אחרי הכניסה הבאה.' : `${waiting} רעיונות שעוד לא נשלחו נשארים שמורים במכשיר הזה, ויישלחו אחרי הכניסה הבאה.` })) : null,
        hasDrafts() ? h('p', { class: 'confirm-text keep' }, icon('save'), h('span', { text: 'הטיוטות שכתבת נשארות שמורות במכשיר הזה.' })) : null),
      h('div', { class: 'confirm-actions' }, cancel, confirm)));
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      dlg.addEventListener('close', () => { dlg.remove(); resolve(); }, { once: true });
      if (reducedMotion()) { dlg.close(); return; }
      dlg.classList.add('is-closing');
      setTimeout(() => dlg.close(), 160);
    });
    return closing;
  };
  const dismiss = () => { if (!busy) fire(close().then(() => { if (opener.isConnected) opener.focus({ preventScroll: true }); })); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); }); // Esc
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dismiss(); }); // a tap outside the box
  cancel.addEventListener('click', dismiss);
  confirm.addEventListener('click', async () => {
    if (busy) return; // no double tap
    busy = true; cancel.disabled = true; confirm.disabled = true; confirm.replaceChildren(spinner(), h('span', { text: 'מתנתק...' }));
    S.signingOut = true; S.signedIn = false; // from this moment nothing is sent to the database
    let res;
    try { res = await api.signOut(); } finally { S.signingOut = false; }
    // the screen forgets this account's ideas; what waits to be sent and the drafts stay on the device (other keys)
    S.ideas = []; S.summaries = []; S.loaded = false; S.loadError = false; S.lastLoad = 0; S.justAdded = null;
    await close();
    showLogin(res.everywhere
      ? 'התנתקת מכל המכשירים. כדי להיכנס שוב, הקלד את הסיסמה.'
      : 'התנתקת במכשיר הזה. לא היה חיבור לשרת, ולכן המכשירים האחרים עדיין מחוברים. כשיש חיבור, היכנס והתנתק שוב.', { calm: true });
  });
  document.body.append(dlg);
  dlg.showModal();
  cancel.focus(); // the safe button holds the focus
}

// ---------- one idea
const section = (title, ...kids) => h('section', { class: 'block' }, h('h3', { class: 'block-title', text: title }), ...kids);

// A card of the report with a title and its fixed explanation line, always open.
function openPart(key, cls, ...body) {
  const [title, hint] = PART[key];
  return h('section', { class: `card rcard ${cls}` },
    h('header', { class: 'rcard-head' }, h('h3', { class: 'rcard-title', text: title }), h('p', { class: 'rcard-hint', text: hint })),
    ...body);
}
// A card of the report that opens on a tap: title, the fixed explanation line, and how many items are inside.
function foldPart(key, cls, countText, ...body) {
  const [title, hint] = PART[key];
  return softDetails(h('details', { class: `card rsec ${cls}` },
    h('summary', {},
      h('span', { class: 'rsec-head' },
        h('span', { class: 'rsec-line' }, h('span', { class: 'rsec-title', text: title }), countText ? h('span', { class: 'rsec-count', text: countText }) : null),
        h('span', { class: 'rsec-hint', text: hint }))),
    h('div', { class: 'rsec-body' }, ...body)));
}

// Items are {title, text}: a short title in bold, then a sentence or two. An old report's plain string has no title and
// shows as one line of text, in the same spacing.
function itemBody(it) {
  return h('div', { class: 'pc-body' }, it.title ? h('strong', { class: 'item-title', text: it.title }) : null, it.text ? prose(it.text, 'item-text') : null);
}
const itemList = (items, mark, cls) => h('ul', { class: `pc-list ${cls}`, role: 'list' },
  ...items.map((it) => h('li', {}, h('span', { class: 'pc-mark', 'aria-hidden': 'true', text: mark }), itemBody(it))));
const stepList = (steps) => h('ol', { class: 'steps' },
  ...steps.map((s) => h('li', {}, h('strong', { class: 'item-title', text: s.title }), s.detail ? prose(s.detail, 'item-text') : null)));
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

function verdictCard(r) {
  const v = VERDICT[r.verdict] || VERDICT.depends;
  return h('section', { class: `card verdict verdict-${r.verdict}` },
    h('p', { class: 'verdict-label', text: PART.verdict[0] }),
    h('div', { class: 'verdict-main' },
      h('span', { class: 'verdict-badge' }, icon(v.ic)),
      h('p', { class: 'verdict-word', text: v.word })),
    r.verdictText ? prose(r.verdictText, 'verdict-text') : null,
    r.suggestReady ? h('p', { class: 'suggest' }, icon('circle-check'), h('span', {}, h('strong', { text: 'הסוכן מציע: ' }), 'מוכן לבנייה. ההחלטה שלך.')) : null);
}

// The report: the bottom line first and big, then what changed, then the questions to Tal (open, in `qa`),
// then the parts that open on a tap. `qa` is the questions card (with answer fields when it is Tal's turn).
function reportView(r, qa, { title } = {}) {
  return h('div', { class: 'report' },
    h('header', { class: 'report-head' },
      h('h2', { class: 'report-title', text: title || `הדוח האחרון - סבב ${r.round}` }),
      h('span', { class: 'muted small', text: fmtDate(r.createdAt) })),
    verdictCard(r),
    r.changes ? openPart('changes', 'rcard-changes', prose(r.changes, 'item-text')) : null,
    qa,
    r.planSteps.length ? foldPart('plan', 'rsec-plan', plural(r.planSteps.length, 'שלב אחד', 'שלבים'), stepList(r.planSteps)) : null,
    r.pros.length ? foldPart('pros', 'rsec-pros', String(r.pros.length), itemList(r.pros, '+', 'pros')) : null,
    r.cons.length ? foldPart('cons', 'rsec-cons', String(r.cons.length), itemList(r.cons, '−', 'cons')) : null,
    foldPart('facts', 'rsec-facts', '',
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', { text: 'זמן ומאמץ' }), h('dd', {}, linkify(r.timeEstimate || '-'))),
        h('div', {}, h('dt', { text: 'עלות' }), h('dd', {}, linkify(r.costEstimate || '-'))))));
}

// Questions already answered (or not): read-only
function qaReadonly(r) {
  if (!r.questions.length && !r.answers.length) return h('p', { class: 'muted', text: 'לא היו שאלות בסבב הזה.' });
  return h('ol', { class: 'qa-read' }, ...r.questions.map((q, i) => {
    const a = r.answers.find((x) => x.q === i);
    return h('li', {}, prose(q, 'q-text'), a ? h('p', { class: 'answer' }, h('span', { class: 'answer-tag', text: 'התשובה שלך: ' }), linkify(a.answer)) : h('p', { class: 'answer none', text: 'לא ענית על השאלה הזאת' }));
  }));
}

function historyBlock(rounds) {
  const old = rounds.slice(0, -1).reverse();
  if (!old.length) return null;
  return softDetails(h('details', { class: 'card history' },
    h('summary', {}, h('span', { text: `סבבים קודמים (${old.length})` })),
    ...old.map((r) => softDetails(h('details', { class: 'hist-round' },
      h('summary', {}, h('span', { class: 'hist-sum' }, h('strong', { text: `סבב ${r.round}` }), h('span', { class: 'muted small', text: fmtDate(r.createdAt) }), verdictChip(r.verdict))),
      h('div', { class: 'hist-body' },
        prose(r.verdictText),
        r.changes ? section('מה השתנה', prose(r.changes)) : null,
        section('שאלות ותשובות', qaReadonly(r))))))));
}

function statePanel(idea, rounds) {
  const last = rounds[rounds.length - 1];
  if (idea.status === 'with_agent') {
    return h('div', { class: 'state-panel state-agent' }, icon('hourglass'), h('div', {},
      h('p', { class: 'state-title', text: 'הכדור אצל הסוכן' }),
      h('p', { class: 'muted', text: last ? `הוא יעבוד על סבב ${last.round + 1} לפי התשובות שלך. עד אז אפשר לקרוא את הדוח האחרון.` : 'עוד אין דוח. אחרי שהסוכן ירוץ, הדוח יופיע כאן.' })));
  }
  if (idea.status === 'waiting') {
    return h('div', { class: 'state-panel state-waiting' }, icon('file'), h('div', {},
      h('p', { class: 'state-title', text: 'דוח מוכן' }),
      h('p', { class: 'muted', text: 'הסוכן סיים דוח. קרא, ענה על השאלות בקצרה, ובחר מה הלאה.' })));
  }
  if (idea.status === 'deleted') {
    return h('div', { class: 'state-panel state-deleted' }, icon('trash'), h('div', {},
      h('p', { class: 'state-title', text: 'הרעיון נמחק' }),
      h('p', {}, h('span', { class: 'answer-tag', text: 'הסיבה: ' }), idea.deleteReason ? linkify(idea.deleteReason) : '-')));
  }
  return null;
}

function briefCard(idea, rounds) {
  const withBrief = [...rounds].reverse().find((r) => r.buildBrief);
  return h('article', { class: 'card brief' },
    h('header', { class: 'report-head' }, h('h2', { class: 'report-title', text: 'תקציר בנייה' }), withBrief ? h('span', { class: 'muted small', text: `נכתב בסבב ${withBrief.round}` }) : null),
    withBrief ? prose(withBrief.buildBrief, 'brief-text') : h('p', { class: 'warn' }, icon('warning'), h('span', { text: 'הסוכן לא כתב תקציר בנייה לרעיון הזה. אפשר לפתוח שיחה ולבקש אותו.' })),
    h('p', { class: 'next-step' }, icon('chevron-left'), h('span', {}, 'להתחיל לבנות: פתח שיחה ואמור ', h('strong', { text: `"בוא נבנה את ${idea.title.length > 60 ? idea.title.slice(0, 60) + '…' : idea.title}"` }), '.')));
}

// "בטל": takes a "ready" or "deleted" idea back, with its report, questions and answers as they were.
// It says in words where the idea goes before the tap, and says "בוטל" after it (a toast, and the badge changes).
function undoBlock(idea) {
  const hint = idea.status === 'ready'
    ? 'לחצת "לבנייה" בטעות? הרעיון יחזור ל"דוח מוכן", עם הדוח, השאלות והתשובות.'
    : idea.currentRound >= 1
      ? 'נמחק בטעות? הרעיון יחזור ל"דוח מוכן", עם הדוח, השאלות והתשובות. סיבת המחיקה תימחק.'
      : 'נמחק בטעות? הרעיון יחזור ל"אצל הסוכן". סיבת המחיקה תימחק.';
  const err = h('p', { class: 'form-msg', role: 'alert' });
  const label = () => [icon('undo'), h('span', { text: 'בטל' })];
  const btn = h('button', { type: 'button', class: 'btn btn-soft', id: 'undo-btn', 'aria-describedby': 'undo-hint' }, ...label());
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    err.textContent = '';
    btn.disabled = true; btn.replaceChildren(spinner(), h('span', { text: 'מבטל...' }));
    let where;
    try {
      where = await api.undoDecision(idea.id);
    } catch (e) {
      if (api.isAuthError(e)) return showLogin('נדרשת כניסה מחדש');
      err.textContent = String(e?.message || '').includes('not_decided')
        ? 'הרעיון כבר לא במצב שאפשר לבטל. חזור לרשימה ורענן.'
        : 'הביטול נכשל, נסה שוב.';
      btn.disabled = false; btn.replaceChildren(...label());
      return;
    }
    // the list keeps a copy of the ideas; update it now so going back never shows the old state
    const cached = S.ideas.find((x) => x.id === idea.id);
    if (cached) { cached.status = where; cached.deleteReason = ''; cached.decidedAt = null; }
    setTab(where);
    toast(where === 'waiting' ? 'בוטל. הרעיון חזר ל"דוח מוכן"' : 'בוטל. הרעיון חזר ל"אצל הסוכן"');
    await renderDetail(idea.id, { keepScroll: false });
  });
  return h('div', { class: 'undo-block card-soft' }, h('p', { id: 'undo-hint', class: 'undo-hint', text: hint }), btn, err);
}

// "מחק לצמיתות": only inside an idea that is already "נמחק". The button opens a confirmation that says, in words, that it
// cannot be undone and what goes with it. (The database also refuses to delete an idea in any other state.)
function purgeBlock(idea) {
  const btn = h('button', { type: 'button', class: 'btn btn-purge', id: 'purge-btn', 'aria-describedby': 'purge-hint' }, icon('trash'), h('span', { text: 'מחק לצמיתות' }));
  btn.addEventListener('click', () => openPurgeDialog(idea, btn));
  return h('div', { class: 'purge-block' },
    h('p', { id: 'purge-hint', class: 'purge-hint', text: 'רוצה להיפטר ממנו סופית? מחיקה לצמיתות אי אפשר לבטל.' }), btn);
}

// An idea that was just written and has no report yet (with the agent, round 0): delete it straight away, no reason needed,
// because there is nothing for the agent to learn from. A short confirmation, then it is gone.
function freshDeleteBlock(idea) {
  const btn = h('button', { type: 'button', class: 'btn btn-purge', id: 'purge-btn', 'aria-describedby': 'purge-hint' }, icon('trash'), h('span', { text: 'מחק' }));
  btn.addEventListener('click', () => openPurgeDialog(idea, btn, { fresh: true }));
  return h('div', { class: 'purge-block' },
    h('p', { id: 'purge-hint', class: 'purge-hint', text: 'כתבת את זה סתם? עוד אין לו דוח, אפשר למחוק אותו לגמרי.' }), btn);
}

function openPurgeDialog(idea, opener, { fresh = false } = {}) {
  let busy = false, closing = null;
  const err = h('p', { class: 'form-msg', role: 'alert' });
  const cancel = h('button', { type: 'button', class: 'btn btn-soft', id: 'purge-cancel', text: 'ביטול' });
  const confirmLabel = () => [icon('trash'), h('span', { text: fresh ? 'מחק' : 'מחק לצמיתות' })];
  const confirm = h('button', { type: 'button', class: 'btn btn-danger', id: 'purge-confirm' }, ...confirmLabel());
  const shown = idea.title.length > 120 ? idea.title.slice(0, 120) + '…' : idea.title;
  const dlg = h('dialog', { class: 'confirm', role: 'alertdialog', 'aria-labelledby': 'purge-title', 'aria-describedby': 'purge-desc' },
    h('div', { class: 'confirm-body' },
      h('h2', { id: 'purge-title', class: 'confirm-title' }, icon('warning'), h('span', { text: fresh ? 'למחוק את הרעיון?' : 'למחוק לצמיתות?' })),
      h('p', { class: 'confirm-idea', text: `"${shown}"` }),
      fresh
        ? h('div', { id: 'purge-desc' }, h('p', { class: 'confirm-text' }, h('strong', { text: 'אי אפשר לבטל את זה. ' }), 'הרעיון יימחק לגמרי.'))
        : h('div', { id: 'purge-desc' },
          h('p', { class: 'confirm-text' }, h('strong', { text: 'אי אפשר לבטל את זה. ' }), 'הרעיון, הדוחות והתשובות שלו יימחקו.'),
          h('p', { class: 'confirm-text', text: 'גם מה שהסוכן למד מסיבת המחיקה ייעלם.' })),
      err,
      h('div', { class: 'confirm-actions' }, cancel, confirm)));
  // closes with a short fade; resolves when it is really closed
  const close = () => {
    if (closing) return closing;
    closing = new Promise((resolve) => {
      dlg.addEventListener('close', () => { dlg.remove(); resolve(); }, { once: true });
      if (reducedMotion()) { dlg.close(); return; }
      dlg.classList.add('is-closing');
      setTimeout(() => dlg.close(), 160);
    });
    return closing;
  };
  // closing without deleting: the focus goes back to the button that opened it (some browsers do not do that by themselves)
  const dismiss = () => { if (!busy) fire(close().then(() => { if (opener.isConnected) opener.focus({ preventScroll: true }); })); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dismiss(); }); // Esc
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dismiss(); }); // a tap outside the box
  cancel.addEventListener('click', dismiss);
  confirm.addEventListener('click', async () => {
    if (busy) return; // no double tap
    busy = true; err.textContent = '';
    cancel.disabled = true; confirm.disabled = true; confirm.replaceChildren(spinner(), h('span', { text: 'מוחק...' }));
    try {
      await api.purgeIdea(idea.id);
    } catch (e) {
      busy = false; cancel.disabled = false; confirm.disabled = false; confirm.replaceChildren(...confirmLabel());
      if (api.isAuthError(e)) { await close(); return showLogin('נדרשת כניסה מחדש'); }
      const m = String(e?.message || '');
      err.textContent = m.includes('not_purgeable') || m.includes('not_deleted') ? (fresh ? 'הסוכן כבר עבד על הרעיון הזה (או שהוא השתנה), ולכן לא נמחק. חזור לרשימה ורענן.' : 'הרעיון כבר לא במצב "נמחק", ולכן לא נמחק. חזור לרשימה ורענן.')
        : m.includes('not_found') ? 'הרעיון כבר לא קיים. חזור לרשימה ורענן.'
        : 'המחיקה נכשלה, נסה שוב.';
      confirm.focus();
      return;
    }
    // gone for good: the list's copy, the drafts on the phone, everything
    S.ideas = S.ideas.filter((x) => x.id !== idea.id);
    S.summaries = S.summaries.filter((s) => s.ideaId !== idea.id);
    store.delPrefix(`ideas:draft:${idea.id}:`);
    setTab(fresh ? 'with_agent' : 'deleted');
    toast(fresh ? 'הרעיון נמחק' : 'הרעיון נמחק לצמיתות');
    await close();
    location.hash = '#/';
  });
  document.body.append(dlg);
  dlg.showModal();
  cancel.focus(); // the safe button holds the focus, so Enter never deletes
}

const draftKey = (id, round, i) => `ideas:draft:${id}:r${round}:q${i}`;

// Tal's turn: the questions with their answer fields, and the three decisions.
// Returns the two pieces separately, because the questions sit inside the report and the decisions come after it.
function decisionArea(idea, r) {
  const questions = r ? r.questions : [];
  const round = idea.currentRound;
  // answers already in the database for this round: they exist after "בטל" brought the idea back
  const earlierAnswer = (i) => (r?.answers || []).find((a) => a.q === i)?.answer || '';
  let drafted = false, restored = false;
  const fields = questions.map((q, i) => {
    const ta = h('textarea', { id: `ans-${i}`, class: 'answer-input', rows: 3, maxlength: 2000, placeholder: 'התשובה שלך, בקצרה', 'aria-labelledby': `q-${i}` });
    const draft = store.get(draftKey(idea.id, round, i), '') || '';
    const earlier = earlierAnswer(i);
    ta.value = draft || earlier;
    if (draft) drafted = true; else if (earlier) restored = true;
    return ta;
  });
  const saved = h('p', { class: 'draft-note', 'aria-live': 'polite' });
  const noteSaved = () => { saved.replaceChildren(icon('check'), h('span', { text: 'הטיוטה נשמרה בטלפון' })); };
  const saveNow = (i) => { store.set(draftKey(idea.id, round, i), fields[i].value); noteSaved(); };
  const persist = debounce(saveNow, 250);
  fields.forEach((ta, i) => {
    ta.addEventListener('input', () => persist(i));
    ta.addEventListener('blur', () => { if (ta.value || store.get(draftKey(idea.id, round, i), '')) saveNow(i); }); // leaving the field never waits for the timer
  });
  // switching to another app, or closing the tab, while typing: write what is typed right now
  S.saveDrafts = () => fields.forEach((ta, i) => { if (ta.value) store.set(draftKey(idea.id, round, i), ta.value); });
  if (drafted) noteSaved();
  else if (restored) saved.replaceChildren(icon('check'), h('span', { text: 'חזרו התשובות שכתבת קודם' }));

  const err = h('p', { class: 'form-msg', role: 'alert' });
  const btnContinue = h('button', { type: 'button', class: 'decision decision-continue', 'data-action': 'continue' }, icon('search'), h('span', { class: 'decision-text' }, h('strong', { text: 'תמשיך לחקור' }), h('small', { text: 'חוזר לסוכן עם התשובות שלך' })));
  const btnBuild = h('button', { type: 'button', class: 'decision decision-build', 'data-action': 'build' }, icon('circle-check'), h('span', { class: 'decision-text' }, h('strong', { text: 'לבנייה' }), h('small', { text: 'מסמן מוכן ומציג את תקציר הבנייה' })));
  const btnDelete = h('button', { type: 'button', class: 'decision decision-delete', 'data-action': 'delete', 'aria-expanded': 'false', 'aria-controls': 'delete-panel' }, icon('trash'), h('span', { class: 'decision-text' }, h('strong', { text: 'למחוק' }), h('small', { text: 'מבקש סיבה במשפט אחד' })));
  const bigButtons = [btnContinue, btnBuild, btnDelete];
  const names = new Map([[btnContinue, 'תמשיך לחקור'], [btnBuild, 'לבנייה'], [btnDelete, 'למחוק']]);

  // delete asks for a reason first
  const reason = h('input', { type: 'text', id: 'delete-reason', maxlength: 500, placeholder: 'למשל: יש כבר עשרות כאלה', 'aria-label': 'סיבת המחיקה', autocomplete: 'off' });
  reason.value = store.get(`ideas:draft:${idea.id}:reason`, '') || '';
  const confirmLabel = () => [icon('trash'), h('span', { text: 'מחק את הרעיון' })];
  const confirmDelete = h('button', { type: 'button', class: 'btn btn-danger', disabled: !reason.value.trim() }, ...confirmLabel());
  const cancelDelete = h('button', { type: 'button', class: 'btn btn-soft', text: 'ביטול' });
  const reasonHint = h('p', { class: 'muted small', text: 'הסיבה נשמרת, כדי שהסוכן ילמד מה פחות מעניין אותך.' });
  const panel = h('div', { id: 'delete-panel', class: 'delete-panel card-soft', hidden: true },
    h('label', { for: 'delete-reason', class: 'delete-label', text: 'למה למחוק? משפט אחד' }), reason, limitNote(reason, 500), reasonHint,
    h('div', { class: 'row-gap' }, confirmDelete, cancelDelete));
  reason.addEventListener('input', () => { confirmDelete.disabled = !reason.value.trim(); store.set(`ideas:draft:${idea.id}:reason`, reason.value); });

  // while a decision is being saved: every button is off (no double tap), the fields cannot be edited (what was sent is what is saved),
  // and the tapped button shows a spinner and the word for what is happening
  let spun = [];
  const setBusy = (busy, which) => {
    [...bigButtons, cancelDelete].forEach((b) => { b.disabled = busy; b.classList.toggle('busy', busy && b === which); });
    confirmDelete.disabled = busy || !reason.value.trim();
    reason.readOnly = busy; fields.forEach((f) => { f.readOnly = busy; });
    if (busy) {
      const ic = which.querySelector('.ic');
      const sp = spinner(); ic.replaceWith(sp); spun.push([sp, ic]);
      if (which === btnDelete) confirmDelete.replaceChildren(spinner(), h('span', { text: 'מוחק...' }));
    } else {
      spun.forEach(([sp, ic]) => sp.replaceWith(ic)); spun = [];
      confirmDelete.replaceChildren(...confirmLabel());
    }
  };
  btnDelete.addEventListener('click', () => {
    const open = panel.hidden; panel.hidden = !open; btnDelete.setAttribute('aria-expanded', String(open));
    if (open) { panel.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); reason.focus({ preventScroll: true }); }
  });
  cancelDelete.addEventListener('click', () => { panel.hidden = true; btnDelete.setAttribute('aria-expanded', 'false'); btnDelete.focus(); });

  async function run(action, which) {
    err.textContent = '';
    setBusy(true, which); which.querySelector('strong').textContent = action === 'delete' ? 'מוחק...' : 'שומר...';
    const answers = questions.map((q, i) => ({ q: i, question: q, answer: fields[i].value.trim() }));
    try {
      await api.decide(idea.id, action, { answers, reason: action === 'delete' ? reason.value.trim() : null });
    } catch (e) {
      if (api.isAuthError(e)) { S.saveDrafts?.(); return showLogin('נדרשת כניסה מחדש. מה שכתבת נשמר בטלפון.'); }
      const m = String(e?.message || '');
      err.textContent = m.includes('not_waiting') ? 'הרעיון כבר לא במצב "דוח מוכן". חזור לרשימה ורענן.'
        : 'השמירה נכשלה, נסה שוב. מה שכתבת נשאר בשדות ובטלפון.';
      setBusy(false);
      bigButtons.forEach((b) => { b.querySelector('strong').textContent = names.get(b); });
      return;
    }
    S.saveDrafts = null;
    store.delPrefix(`ideas:draft:${idea.id}:`);
    // the list keeps a copy of the ideas; update it now so going back never shows the old state
    const cached = S.ideas.find((x) => x.id === idea.id);
    if (cached) {
      cached.status = action === 'continue' ? 'with_agent' : action === 'build' ? 'ready' : 'deleted';
      if (action === 'delete') cached.deleteReason = reason.value.trim();
      if (action !== 'continue') cached.decidedAt = new Date().toISOString();
    }
    if (action === 'build') { setTab('ready'); toast('סומן מוכן לבנייה'); await renderDetail(idea.id, { keepScroll: false }); return; }
    setTab(action === 'continue' ? 'with_agent' : 'deleted');
    toast(action === 'continue' ? 'חזר לסוכן עם התשובות שלך' : 'הרעיון נמחק, הסיבה נשמרה');
    location.hash = '#/';
  }
  btnContinue.addEventListener('click', () => { if (!btnContinue.disabled) run('continue', btnContinue); });
  btnBuild.addEventListener('click', () => { if (!btnBuild.disabled) run('build', btnBuild); });
  confirmDelete.addEventListener('click', () => { if (!confirmDelete.disabled && reason.value.trim()) run('delete', btnDelete); });

  const [qTitle, qHint] = PART.questions;
  const questionsCard = h('section', { class: 'card questions' },
    h('header', { class: 'rcard-head' },
      h('h3', { class: 'rcard-title', text: qTitle }),
      h('p', { class: 'rcard-hint', text: qHint }),
      questions.length ? h('span', { class: 'q-count', text: plural(questions.length, 'שאלה אחת', 'שאלות') }) : null),
    questions.length
      ? h('ol', { class: 'q-list' }, ...questions.map((q, i) => h('li', { class: 'q' }, prose(q, 'q-text'), fields[i], limitNote(fields[i], 2000))))
      : h('p', { class: 'muted', text: 'אין שאלות פתוחות בסבב הזה.' }),
    saved);
  const decisions = h('section', { class: 'decisions', 'aria-label': 'מה הלאה' }, btnContinue, btnBuild, btnDelete, panel, err);
  return { questionsCard, decisions };
}

async function renderDetail(id, { keepScroll = false } = {}) {
  const seq = ++routeSeq;
  listRefs = null;
  S.saveDrafts = null;
  const back = h('a', { class: 'back', href: '#/' }, icon('chevron-right'), h('span', { text: 'כל הרעיונות' }));
  let skeletonShown = false;
  const shell = (...kids) => h('div', { class: 'screen detail' + (skeletonShown ? ' no-enter settle' : '') }, h('header', { class: 'topbar' }, back), demoBanner(), ...kids);
  // a new screen fades in and rises (CSS). A skeleton shows only if the data takes longer than a blink; the real screen then replaces it with a short fade of its parts.
  const show = async (node) => { if (seq !== routeSeq) return; mount(node); if (!keepScroll) window.scrollTo(0, 0); };
  const skelTimer = setTimeout(() => {
    if (seq !== routeSeq) return;
    const skeleton = shell(h('div', { class: 'skel-detail', 'aria-hidden': 'true' }, h('span', { class: 'skel skel-title' }), h('span', { class: 'skel skel-line' }), h('span', { class: 'skel skel-block' })));
    skeletonShown = true; // from now on the real screen replaces this one without its own entrance
    fire(show(skeleton));
  }, SKELETON_DELAY);
  let d;
  try { d = await api.getIdeaDetail(id); }
  catch (e) {
    clearTimeout(skelTimer);
    if (seq !== routeSeq) return;
    if (api.isAuthError(e)) return showLogin('נדרשת כניסה מחדש');
    const retry = h('button', { type: 'button', class: 'btn btn-primary', text: 'נסה שוב' });
    retry.addEventListener('click', () => { retry.disabled = true; retry.replaceChildren(spinner(), 'טוען...'); fire(renderDetail(id)); });
    return show(shell(h('div', { class: 'empty card-soft', role: 'alert' }, icon('warning'), h('p', { class: 'empty-title', text: 'לא הצלחתי לטעון את הרעיון' }), retry)));
  }
  clearTimeout(skelTimer);
  if (seq !== routeSeq) return;
  if (!d) {
    return show(shell(h('div', { class: 'empty card-soft' }, icon('help'), h('p', { class: 'empty-title', text: 'הרעיון לא נמצא' }), h('p', { class: 'muted', text: 'ייתכן שנמחק, או שהקישור שגוי.' }))));
  }
  const { idea, rounds } = d;
  const last = rounds[rounds.length - 1];
  document.title = `${idea.title} - מעבדת רעיונות`;
  const title = h('h1', { class: 'idea-h1', tabindex: '-1', text: idea.title });
  const da = idea.status === 'waiting' ? decisionArea(idea, last) : null;
  // the questions card: with answer fields when it is Tal's turn, otherwise what was asked and answered
  const qa = da ? da.questionsCard
    : last ? h('section', { class: 'card rcard' }, h('header', { class: 'rcard-head' }, h('h3', { class: 'rcard-title', text: `שאלות ותשובות - סבב ${last.round}` }), h('p', { class: 'rcard-hint', text: 'מה הסוכן שאל, ומה ענית' })), qaReadonly(last))
    : null;
  await show(shell(
    title,
    h('div', { class: 'idea-badges' }, statusBadge(idea.status), idea.currentRound > 0 ? h('span', { class: 'round-tag', text: `סבב ${idea.currentRound}` }) : null, h('span', { class: 'muted small', text: `נוסף ${fmtDate(idea.createdAt)}` })),
    idea.details ? prose(idea.details, 'idea-details') : null,
    statePanel(idea, rounds),
    idea.status === 'deleted' ? purgeBlock(idea) : null, // at the top, right under the "נמחק" panel, not below the report
    idea.status === 'with_agent' && idea.currentRound === 0 ? freshDeleteBlock(idea) : null,
    idea.status === 'ready' || idea.status === 'deleted' ? undoBlock(idea) : null,
    idea.status === 'ready' ? briefCard(idea, rounds) : null,
    last ? reportView(last, qa) : qa,
    da ? da.decisions : null,
    historyBlock(rounds)));
  if (seq === routeSeq) title.focus({ preventScroll: true });
}

// ---------- routing
let started = false;
async function start() {
  if (!started) {
    started = true;
    window.addEventListener('hashchange', () => {
      if (listRefs) S.listScroll = window.scrollY;
      if (isDetail()) fire(renderDetail(decodeURIComponent(location.hash.replace('#/idea/', ''))));
      else renderList();
    });
    window.addEventListener('online', () => flushPending());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') { S.saveDrafts?.(); return; } // leaving the app: what is typed is on the phone first
      flushPending();
      if (listRefs && Date.now() - S.lastLoad > 30000) fire(loadList());
    });
    window.addEventListener('pagehide', () => S.saveDrafts?.());
    setInterval(() => { if (S.pending.length && document.visibilityState === 'visible') flushPending(); }, 30000);
    // signed out from outside (another tab, or the server): the message below. Not when the user just pressed "התנתק", and not
    // when the sign-in screen is already up (repainting it would wipe a password being typed).
    api.onSignedOut(() => { if (!S.signingOut && S.signedIn) showLogin('נותקת. התחבר שוב.'); });
  }
  S.signedIn = true;
  if (isDetail()) fire(renderDetail(decodeURIComponent(location.hash.replace('#/idea/', '')))); else renderList();
  flushPending();
}

(async function boot() {
  try {
    if (await api.hasSession()) start(); else showLogin();
  } catch { showLogin(); }
})();
