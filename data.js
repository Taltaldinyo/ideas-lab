// Everything that reads or writes ideas. The screens never talk to Supabase directly.
// The Supabase library is a copy kept in vendor/, loaded by index.html (same file the calendar app uses).
const { createClient } = window.supabase;
import { SUPABASE_URL, SUPABASE_KEY, LOGIN_EMAIL, AUTH_STORAGE_KEY } from './config.js?v=5';

// Demo mode: sample ideas kept in memory, no sign-in. Only on this computer (localhost), so the screens can be
// checked without the real password and without touching real data. ?demo, ?demo=fresh, ?demo=empty, ?demo=big
const params = new URLSearchParams(location.search);
export const isDemo = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('demo');
export const demoKind = params.get('demo') || 'default';

const supabase = isDemo ? null : createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true },
});

export class WrongPasswordError extends Error {}

// ---------- shapes. The database stores the agent's arrays as JSON; anything malformed becomes empty, never a crash.
const strList = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string' && s.trim()) : []);
const clip = (v) => (typeof v === 'string' ? v.trim() : '');
// A pro / con is either a plain string (every report written before the new format) or {title, text}.
// Both become {title, text}; an old string has no title and shows as one line of text.
const item = (s) => {
  if (typeof s === 'string') return s.trim() ? { title: '', text: s.trim() } : null;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const title = clip(s.title), text = clip(s.text) || clip(s.detail);
    return title || text ? { title, text } : null;
  }
  return null;
};
export const itemList = (x) => (Array.isArray(x) ? x.map(item).filter(Boolean) : []);
// A plan step is {title, detail}. A bare string is tolerated as a title.
export const stepList = (x) => (Array.isArray(x)
  ? x.map((s) => (typeof s === 'string' ? { title: s, detail: '' } : s)).filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({ title: s.title.trim(), detail: clip(s.detail) || clip(s.text) }))
  : []);

const IDEA_COLUMNS = 'id,title,details,status,current_round,delete_reason,created_at,updated_at,decided_at';
const cleanIdea = (r) => ({
  id: r.id, title: r.title, details: r.details ?? '', status: r.status, currentRound: r.current_round ?? 0,
  deleteReason: r.delete_reason ?? '', createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at ?? null,
});
const cleanRound = (r, answers = []) => ({
  round: r.round_no, createdAt: r.created_at, verdict: r.verdict, verdictText: r.verdict_text ?? '',
  changes: r.changes ?? '', planSteps: stepList(r.plan_steps), pros: itemList(r.pros), cons: itemList(r.cons),
  questions: strList(r.questions), timeEstimate: r.time_estimate ?? '', costEstimate: r.cost_estimate ?? '',
  buildBrief: r.build_brief ?? '', suggestReady: Boolean(r.suggest_ready),
  answers: answers.filter((a) => a.round_no === r.round_no).sort((a, b) => a.question_index - b.question_index)
    .map((a) => ({ q: a.question_index, question: a.question_text, answer: a.answer })),
});

// ---------- session
export async function hasSession() {
  if (isDemo) return true;
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}

export async function signIn(password) {
  if (isDemo) return;
  const { error } = await supabase.auth.signInWithPassword({ email: LOGIN_EMAIL, password });
  if (!error) return;
  if (error.status === 400) throw new WrongPasswordError();
  throw error;
}

// Real sign-out: the server cancels every saved sign-in of this account (phone and computer), and this device forgets its own.
// Returns { everywhere: true } when the server confirmed. With no connection the server can't be told, so the sign-in is
// still removed from this device and the answer says so ({ everywhere: false }). Ideas waiting to be sent and drafts
// are not touched: they live under other keys and must survive a sign-out.
export async function signOut() {
  if (isDemo) return { everywhere: true };
  let everywhere = false;
  try {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    everywhere = !error;
  } catch { everywhere = false; }
  try {
    Object.keys(localStorage).filter((k) => k === AUTH_STORAGE_KEY || k.startsWith(`${AUTH_STORAGE_KEY}-`)).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
  return { everywhere };
}

export function onSignedOut(callback) {
  if (isDemo) return;
  supabase.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') callback(); });
}

// Signed out or expired: bad/expired token, or the request arrived without one.
const AUTH_CODES = ['PGRST301', 'PGRST302', 'PGRST303', '42501'];
export const isAuthError = (e) => e?.status === 401 || AUTH_CODES.includes(e?.code);

// ---------- reads
export async function listIdeas() {
  if (isDemo) return demo.listIdeas();
  const { data, error } = await supabase.from('ideas').select(IDEA_COLUMNS).order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(cleanIdea);
}

// Only what the list needs: the newest verdict per idea, and when the agent last reported.
export async function listRoundSummaries() {
  if (isDemo) return demo.listRoundSummaries();
  const { data, error } = await supabase.from('ideas_report_rounds')
    .select('idea_id,round_no,verdict,created_at').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map((r) => ({ ideaId: r.idea_id, round: r.round_no, verdict: r.verdict, createdAt: r.created_at }));
}

export async function getIdeaDetail(id) {
  if (isDemo) return demo.getIdeaDetail(id);
  const [ideaRes, roundsRes, ansRes] = await Promise.all([
    supabase.from('ideas').select(IDEA_COLUMNS).eq('id', id).maybeSingle(),
    supabase.from('ideas_report_rounds').select('*').eq('idea_id', id).order('round_no'),
    supabase.from('ideas_answers').select('round_no,question_index,question_text,answer').eq('idea_id', id),
  ]);
  for (const res of [ideaRes, roundsRes, ansRes]) if (res.error) throw res.error;
  if (!ideaRes.data) return null;
  return { idea: cleanIdea(ideaRes.data), rounds: roundsRes.data.map((r) => cleanRound(r, ansRes.data)) };
}

// ---------- writes
// The id is made on the phone, so sending the same idea twice (a retry after a dropped connection) never makes two.
export async function addIdea({ id, title, details }) {
  if (isDemo) return demo.addIdea({ id, title, details });
  const { error } = await supabase.from('ideas').insert({ id, title, details: details || null });
  if (error && error.code !== '23505') throw error; // 23505 = already saved by an earlier attempt that did get through
}

// action: 'continue' | 'build' | 'delete'. One call, all or nothing in the database.
export async function decide(id, action, { answers = [], reason = null } = {}) {
  if (isDemo) return demo.decide(id, action, answers, reason);
  const { error } = await supabase.rpc('ideas_decide', { p_idea_id: id, p_action: action, p_answers: answers, p_reason: reason });
  if (error) throw error;
}

// Takes a "ready" or "deleted" idea back. Returns where it went: 'waiting' (the report is there to answer),
// or 'with_agent' (an idea deleted before the agent ever looked at it has no report to wait on).
export async function undoDecision(id) {
  if (isDemo) return demo.undoDecision(id);
  const { data, error } = await supabase.rpc('ideas_undo', { p_idea_id: id });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row?.status === 'with_agent' ? 'with_agent' : 'waiting';
}

// "מחק לצמיתות": really deletes an idea that is already in the "deleted" state, with its reports and answers.
// The database refuses (not_deleted) for any other state, so this can never remove a live idea.
export async function purgeIdea(id) {
  if (isDemo) return demo.purgeIdea(id);
  const { error } = await supabase.rpc('ideas_purge', { p_idea_id: id });
  if (error) throw error;
}

export async function exportAll() {
  const sample = isDemo;
  let ideas, rounds, answers;
  if (isDemo) {
    ideas = await demo.listIdeas();
    const details = await Promise.all(ideas.map((i) => demo.getIdeaDetail(i.id)));
    return { exported_at: new Date().toISOString(), sample_data: sample, ideas: details.map((d) => ({ ...d.idea, rounds: d.rounds })) };
  }
  const [i, r, a] = await Promise.all([
    supabase.from('ideas').select('*').order('created_at'),
    supabase.from('ideas_report_rounds').select('*').order('round_no'),
    supabase.from('ideas_answers').select('*'),
  ]);
  for (const res of [i, r, a]) if (res.error) throw res.error;
  ideas = i.data; rounds = r.data; answers = a.data;
  return {
    exported_at: new Date().toISOString(),
    sample_data: false,
    ideas: ideas.map((idea) => ({
      ...cleanIdea(idea),
      rounds: rounds.filter((x) => x.idea_id === idea.id).map((x) => cleanRound(x, answers.filter((y) => y.idea_id === idea.id))),
    })),
  };
}

// =====================================================================================================
// Demo store. SAMPLE DATA ONLY - nothing here is a real idea. Titles start with "דוגמה:".
// window.__ideasDemo is a handle for the browser tests (only exists in demo mode on localhost).
// =====================================================================================================
const demo = (() => {
  if (!isDemo) return null;
  const DAY = 86400000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const longWord = 'א'.repeat(70);
  const big = demoKind === 'big';
  const rich = demoKind === 'rich'; // ?demo=rich: the first idea's newest report uses the new item format, with long text

  const planSteps = [
    { title: 'לבדוק ביקוש', detail: 'לדבר עם חמישה אנשים שחיים בדירה משותפת ולשאול איך הם מחלקים הוצאות היום.' },
    { title: 'אב טיפוס בגיליון', detail: 'גיליון משותף עם נוסחה אחת, לפני שכותבים קוד.' },
    { title: 'אפליקציה קטנה', detail: 'רק שלושה מסכים: הוצאה חדשה, יתרות, התחשבנות.' },
  ];

  let ideas = [];
  let rounds = []; // full rounds, each with .ideaId
  let answers = []; // {ideaId, round_no, question_index, question_text, answer}

  if (demoKind !== 'empty') {
    ideas = [
      { id: 'demo-0001', title: 'דוגמה: אפליקציה לחלוקת הוצאות בדירה משותפת', details: 'כל חודש אנחנו מסתבכים עם מי שילם על מה.', status: 'waiting', currentRound: 2, deleteReason: '', createdAt: ago(5 * DAY), updatedAt: ago(3 * DAY), decidedAt: null },
      { id: 'demo-0002', title: 'דוגמה: תזכורת יומית לשתות מים', details: '', status: 'with_agent', currentRound: 0, deleteReason: '', createdAt: ago(2 * 3600000), updatedAt: ago(2 * 3600000), decidedAt: null },
      { id: 'demo-0003', title: 'דוגמה: ערכת תרגול לבחינות חשבונאות', details: 'שאלות עם פתרון צעד אחר צעד.', status: 'waiting', currentRound: 1, deleteReason: '', createdAt: ago(6 * DAY), updatedAt: ago(3 * DAY), decidedAt: null },
      { id: 'demo-0004', title: 'דוגמה: מעקב אחרי קבלות לשנת המס', details: '', status: 'ready', currentRound: 2, deleteReason: '', createdAt: ago(9 * DAY), updatedAt: ago(4 * DAY), decidedAt: ago(4 * DAY) },
      { id: 'demo-0005', title: 'דוגמה: משחק טריוויה על כדורגל', details: '', status: 'deleted', currentRound: 1, deleteReason: 'יש עשרות כאלה כבר, ואין לי יתרון.', createdAt: ago(12 * DAY), updatedAt: ago(10 * DAY), decidedAt: ago(10 * DAY) },
      { id: 'demo-0006', title: 'דוגמה: רעיון נוסף שממתין לסוכן', details: '', status: 'with_agent', currentRound: 0, deleteReason: '', createdAt: ago(DAY), updatedAt: ago(DAY), decidedAt: null },
    ];
    if (big) ideas.unshift({ id: 'demo-big', title: `דוגמה: ${longWord} ${longWord} https://example.com/${'a'.repeat(90)}`, details: `${longWord}\n${'שורה ארוכה '.repeat(30)}`, status: 'waiting', currentRound: 1, deleteReason: '', createdAt: ago(DAY), updatedAt: ago(DAY), decidedAt: null });
    const mk = (ideaId, round, ago_, extra) => rounds.push({
      ideaId, round, createdAt: ago(ago_), verdict: 'worth', verdictText: '', changes: '', planSteps, pros: ['פשוט לבנייה', 'צורך אמיתי'], cons: ['תחרות מאפליקציות קיימות'],
      questions: [], timeEstimate: 'כשבועיים של ערבים', costEstimate: 'אפס, על התשתית הקיימת', buildBrief: '', suggestReady: false, ...extra,
    });
    mk('demo-0001', 1, 4 * DAY, { verdict: 'depends', verdictText: 'תלוי אם אנשים מוכנים להתחייב לעוד אפליקציה לחלוקת הוצאות, כי כבר קיימות כאלה בחינם.', questions: ['מי המשתמשים בפועל: רק אתה ושותפיך לדירה, או גם אחרים?', 'האם נתקלת בבעיה שאפליקציות קיימות לא פותרות?'] });
    mk('demo-0001', 2, 3 * DAY, {
      verdict: 'potential', verdictText: 'יש פוטנציאל, בגרסה קטנה שמיועדת לדירות שותפים בלבד.',
      changes: 'הצמצום לדירות שותפים מסיר את רוב התחרות. הוספתי תוכנית של שלושה שלבים והורדתי את העלות לאפס.',
      questions: ['האם ההתחשבנות החודשית צריכה להיות אוטומטית, או שמספיק סיכום שאתה שולח בוואטסאפ?', 'מה קורה כששותף עוזב באמצע חודש? https://example.com/roommates-guide?ref=lab'],
      suggestReady: false, buildBrief: '',
    });
    if (rich) {
      const r2 = rounds.find((r) => r.ideaId === 'demo-0001' && r.round === 2);
      Object.assign(r2, {
        verdictText: 'יש פוטנציאל, בגרסה קטנה שמיועדת לדירות שותפים בלבד. היא פותרת בעיה אמיתית שחוזרת כל חודש, ואפשר לבדוק אותה בשבוע אחד של עבודה לפני שמשקיעים עוד.',
        changes: 'הצמצום לדירות שותפים מסיר את רוב התחרות. הוספתי תוכנית של ארבעה שלבים, הורדתי את העלות לאפס, והוספתי בדיקת ביקוש לפני כתיבת קוד.',
        planSteps: [
          { title: 'לבדוק ביקוש עם חמישה אנשים', detail: 'לדבר עם חמישה אנשים שגרים בדירה משותפת ולשאול איך הם מחלקים הוצאות היום. אם שלושה מהם אומרים שזה כואב, ממשיכים.' },
          { title: 'אב טיפוס בגיליון משותף', detail: 'גיליון אחד עם נוסחה אחת שמחשבת מי חייב למי. אם הוא מספיק לחברים, אולי אין צורך באפליקציה בכלל.' },
          { title: 'אפליקציה קטנה של שלושה מסכים', detail: 'הוצאה חדשה, יתרות, והתחשבנות בסוף החודש. בלי התראות ובלי חשבונות משתמש בשלב הראשון.' },
          { title: 'מדידה אחרי חודש', detail: 'לבדוק אם השותפים באמת משתמשים בה, ורק אז להחליט אם להרחיב.' },
        ],
        pros: [
          { title: 'פשוט לבנייה', text: 'שלושה מסכים בלבד, ואפשר להתחיל מגיליון לפני שכותבים קוד.' },
          { title: 'צורך אמיתי וחוזר', text: 'כל חודש אותה התחשבנות מסתבכת, ולכן יש סיבה לחזור לאפליקציה.' },
          { title: 'עלות אפס', text: 'רץ על התשתית הקיימת ואין תשלום לשום שירות.' },
          'יתרון בפורמט הישן: מחרוזת רגילה בלי כותרת, כמו בדוחות הקודמים',
        ],
        cons: [
          { title: 'תחרות מאפליקציות חינמיות', text: 'כבר קיימות כמה אפליקציות לחלוקת הוצאות, ולכן צריך סיבה ברורה למה לבחור בזאת.' },
          { title: 'תלוי בשותפים', text: 'אם השותפים לא משתמשים, האפליקציה חסרת ערך גם אם היא מצוינת.' },
          'חיסרון בפורמט הישן: מחרוזת רגילה בלי כותרת',
        ],
        questions: [
          'האם ההתחשבנות החודשית צריכה להיות אוטומטית, או שמספיק סיכום שאתה שולח בוואטסאפ לשותפים בסוף כל חודש?',
          'מה קורה כששותף עוזב באמצע חודש, והאם צריך לחלק את ההוצאות לפי ימים? https://example.com/roommates-guide?ref=lab',
          'האם יש הוצאות שאתם לא מחלקים שווה בשווה, למשל חשמל לפי צריכה?',
        ],
        timeEstimate: 'כשבועיים של ערבים: שבוע לבדיקת ביקוש ולגיליון, ושבוע לאפליקציה הקטנה.',
        costEstimate: 'אפס. הכל רץ על התשתית הקיימת, ואין שירות בתשלום.',
      });
    }
    mk('demo-0003', 1, 3 * DAY, { verdict: 'nothing', verdictText: 'כרגע אין כאן כלום שלא קיים בספר הלימוד, אלא אם יש זווית מיוחדת.', questions: ['איזה חלק בבחינות הכי קשה לך?'], pros: ['ביקוש קבוע'], cons: ['שוק רווי', 'דורש הרבה תוכן'], changes: '' });
    mk('demo-0004', 1, 8 * DAY, { verdict: 'worth', verdictText: 'שווה.', questions: ['איפה שומרים את הקבלות היום?'] });
    mk('demo-0004', 2, 5 * DAY, {
      verdict: 'worth', verdictText: 'שווה לבנות, בגרסה שמצלמת קבלה ושומרת אותה לפי חודש.', changes: 'התשובה על המקום שבו הקבלות נשמרות הבהירה שצריך רק צילום ותיקיות לפי חודש.',
      questions: [], suggestReady: true,
      buildBrief: 'מה לבנות: מסך אחד שמצלם קבלה ושומר אותה בתיקייה לפי חודש.\nשלבים: 1) צילום ושמירה. 2) חיפוש לפי חנות. 3) ייצוא לרואה החשבון.\nזמן: כשבוע. עלות: אפס.\nמקורות: https://example.com/receipts\nהחלטות של טל: בלי סריקה אוטומטית של סכומים בשלב ראשון.',
    });
    mk('demo-0005', 1, 11 * DAY, { verdict: 'nothing', verdictText: 'אין כאן כלום מעבר למה שכבר קיים.', cons: ['שוק רווי'], pros: [] });
    answers = [
      { ideaId: 'demo-0001', round_no: 1, question_index: 0, question_text: 'מי המשתמשים בפועל: רק אתה ושותפיך לדירה, או גם אחרים?', answer: 'רק אני ושני השותפים שלי.' },
      { ideaId: 'demo-0004', round_no: 1, question_index: 0, question_text: 'איפה שומרים את הקבלות היום?', answer: 'בתיקייה בטלפון, בלי סדר.' },
    ];
    if (big) rounds.push({ ideaId: 'demo-big', round: 1, createdAt: ago(DAY), verdict: 'potential', verdictText: `${longWord} ${longWord}`, changes: '', planSteps: [{ title: longWord + longWord, detail: 'https://example.com/' + 'b'.repeat(100) }], pros: [longWord + ' ' + longWord, { title: longWord + longWord, text: 'https://example.com/' + 'd'.repeat(100) }], cons: ['x'.repeat(120), { title: 'y'.repeat(110), text: longWord + ' ' + 'z'.repeat(90) }], questions: [longWord + ' ' + longWord + '?'], timeEstimate: longWord, costEstimate: 'https://example.com/' + 'c'.repeat(80), buildBrief: '', suggestReady: false });
  }

  // ?demo=fresh: the agent reported an hour ago, so the staleness warning stays away
  if (demoKind === 'fresh' && rounds.length) {
    const newest = rounds.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    newest.createdAt = ago(3600000);
  }

  let failNext = 0;
  const calls = { decide: 0, purge: 0, undo: 0 }; // how many times each write reached the store (the tests check there is no double send)
  const net = async () => { await new Promise((r) => setTimeout(r, 120)); if (failNext > 0) { failNext--; throw new TypeError('Failed to fetch'); } };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const find = (id) => ideas.find((i) => i.id === id);

  const api = {
    async listIdeas() { await net(); return clone(ideas).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async listRoundSummaries() {
      await net();
      return rounds.map((r) => ({ ideaId: r.ideaId, round: r.round, verdict: r.verdict, createdAt: r.createdAt }));
    },
    async getIdeaDetail(id) {
      await net();
      const idea = find(id);
      if (!idea) return null;
      // same cleaning as the real database path (cleanRound), so old strings and new {title, text} items look the same here
      const rs = rounds.filter((r) => r.ideaId === id).sort((a, b) => a.round - b.round)
        .map((r) => ({ ...clone(r), planSteps: stepList(r.planSteps), pros: itemList(r.pros), cons: itemList(r.cons), answers: answers.filter((a) => a.ideaId === id && a.round_no === r.round).sort((a, b) => a.question_index - b.question_index).map((a) => ({ q: a.question_index, question: a.question_text, answer: a.answer })) }));
      return { idea: clone(idea), rounds: rs };
    },
    async addIdea({ id, title, details }) {
      await net();
      if (find(id)) return;
      ideas.push({ id, title, details: details || '', status: 'with_agent', currentRound: 0, deleteReason: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), decidedAt: null });
    },
    async decide(id, action, ans, reason) {
      calls.decide++;
      await net();
      const idea = find(id);
      if (!idea) throw Object.assign(new Error('not_found'), { code: 'P0001' });
      if (action === 'delete') {
        if (!reason || !reason.trim()) throw new Error('reason_required');
        idea.status = 'deleted'; idea.deleteReason = reason.trim(); idea.decidedAt = new Date().toISOString();
        return;
      }
      if (idea.status !== 'waiting') throw new Error('not_waiting');
      for (const a of ans) {
        if (!String(a.answer || '').trim()) continue;
        answers = answers.filter((x) => !(x.ideaId === id && x.round_no === idea.currentRound && x.question_index === a.q));
        answers.push({ ideaId: id, round_no: idea.currentRound, question_index: a.q, question_text: a.question, answer: String(a.answer).trim() });
      }
      idea.status = action === 'continue' ? 'with_agent' : 'ready';
      if (action === 'build') idea.decidedAt = new Date().toISOString();
    },
    async undoDecision(id) {
      calls.undo++;
      await net();
      const idea = find(id);
      if (!idea) throw Object.assign(new Error('not_found'), { code: 'P0001' });
      if (idea.status !== 'ready' && idea.status !== 'deleted') throw new Error('not_decided');
      idea.status = idea.currentRound >= 1 ? 'waiting' : 'with_agent';
      idea.deleteReason = ''; idea.decidedAt = null;
      return idea.status;
    },
    async purgeIdea(id) {
      calls.purge++;
      await net();
      const idea = find(id);
      if (!idea) throw Object.assign(new Error('not_found'), { code: 'P0001' });
      // allowed: an idea in "deleted", or one with the agent that has no report yet. Anything else is refused, as the database does.
      if (!(idea.status === 'deleted' || (idea.status === 'with_agent' && idea.currentRound === 0))) throw Object.assign(new Error('not_purgeable'), { code: 'P0001' });
      ideas = ideas.filter((i) => i.id !== id);
      rounds = rounds.filter((r) => r.ideaId !== id); // the reports and the answers go with the idea
      answers = answers.filter((a) => a.ideaId !== id);
    },
  };

  // Test handle: simulate the agent answering, drop the network for the next calls, read what was saved.
  window.__ideasDemo = {
    failNext(n = 1) { failNext = n; },
    failCount: () => failNext,
    calls: () => ({ ...calls }),
    setStatus(id, status) { find(id).status = status; }, // change an idea behind the app's back, to test the "no longer in that state" messages
    agentReply(id, over = {}) {
      const idea = find(id);
      const round = idea.currentRound + 1;
      rounds.push({ ideaId: id, round, createdAt: new Date().toISOString(), verdict: 'potential', verdictText: 'דוגמה: יש כאן גרעין טוב.', changes: round > 1 ? 'עודכן לפי התשובות שלך.' : '', planSteps, pros: ['פשוט'], cons: ['תחרות'], questions: ['שאלה לדוגמה אחת?', 'שאלה לדוגמה שתיים?'], timeEstimate: 'שבועיים', costEstimate: 'אפס', buildBrief: '', suggestReady: false, ...over });
      idea.status = 'waiting'; idea.currentRound = round;
    },
    state: () => clone({ ideas, rounds, answers }),
  };
  return api;
})();
