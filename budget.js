// Budget V1 — pure logic, no DOM. Amounts are integer cents, signed from the account's view
// (negative = money leaving the account). Dates 'YYYY-MM-DD', months 'YYYY-MM'.

export const KINDS = { income: 'Revenu', expense: 'Dépense', refund: 'Remboursement', transfer: 'Virement interne', invest: 'Achat bourse' };

const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
const dayNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;
export const monthOf = d => d.slice(0, 7);
export const uid = () => crypto.randomUUID();
export const signed = (kind, cents) => (kind === 'income' || kind === 'refund' ? cents : -cents);

export function emptyState() {
  return {
    version: 2, accounts: [], ops: [], recurring: [], envelopes: [], dismissedAlerts: [], lastImport: null,
    categories: ['Logement', 'Alimentation', 'Santé', 'Mobilité et auto', 'Impôts', 'Loisirs', 'Abonnements', 'Divers']
      .map(name => ({ id: uid(), name, cap: 0 })),
    settings: { reserve: 0, globalCap: 0, alertPct: 80, lowSpendable: 10000, notify: false, market: { enabled: false, avKey: '' }, profile: defaultProfile() },
    instruments: [], quotes: {}, fx: {}, requestLog: [], peaks: {}, news: [], newsFetched: {}, history: {}, snapshots: {}, discovery: { date: null, items: {} }, notified: { verdicts: {}, sent: [] },
  };
}

// fee in cents per order, fxPct = conversion cost on non-EUR orders, targets = {isin: % of portfolio}
const defaultProfile = () => ({ horizon: 10, risk: 'equilibre', driftPts: 5, fee: 100, fxPct: 0.25, targets: {} });

export function validateState(x) {
  if (x?.version === 1 && x.settings) { // v1 → v2: market data (lot 2)
    Object.assign(x, { version: 2, instruments: [], quotes: {}, fx: {}, requestLog: [] });
    x.settings.market = { enabled: false, avKey: '' };
  }
  if (x?.version === 2 && x.settings) { // fields added with P03 and P02
    x.settings.profile ??= defaultProfile(); x.peaks ??= {}; x.news ??= []; x.newsFetched ??= {}; x.history ??= {}; x.snapshots ??= {}; x.discovery ??= { date: null, items: {} };
    x.settings.lowSpendable ??= 10000; x.notified ??= { verdicts: {}, sent: [] };
    // the hand-picked comparison ETFs were withdrawn (ideas now come from the market scan): drop those never bought
    const withdrawn = ['Amundi MSCI World (CW8)', 'Amundi PEA S&P 500 (PSP5)', 'Amundi Stoxx Europe 600 (MEUD)', 'Amundi PEA MSCI Emerging Markets (PAEEM)'];
    x.instruments = x.instruments.filter(i => !(i.type === 'ETF' && withdrawn.includes(i.name) && !x.ops.some(o => o.isin === i.isin)
      && !Object.values(x.snapshots).some(sn => sn.lines.some(l => l.isin === i.isin))));
  }
  const ok = x && x.version === 2 && x.settings?.market && x.quotes && x.fx
    && ['accounts', 'ops', 'recurring', 'envelopes', 'categories', 'dismissedAlerts', 'instruments', 'requestLog'].every(k => Array.isArray(x[k]))
    && x.ops.every(o => Number.isInteger(o.amount) && /^\d{4}-\d{2}-\d{2}$/.test(o.date));
  if (!ok) throw new Error('Fichier de données invalide');
  return x;
}

// ---- indicators ----

const spentOf = ops => 0 - sum(ops.filter(o => o.kind === 'expense' || o.kind === 'refund'), o => o.amount);
const incomeOf = ops => sum(ops.filter(o => o.kind === 'income'), o => o.amount);
// a planned op paired with a real one only counts through the real one
const matchedIds = s => new Set(s.ops.filter(o => o.plannedId).map(o => o.plannedId));

export const envelopeUsed = (s, id) => 0 - sum(s.ops.filter(o => o.envelopeId === id), o => o.amount);
export const envelopeLeft = (s, e) => (e.released ? 0 : e.amount - envelopeUsed(s, e.id));

export function monthStats(s, m) {
  const ops = s.ops.filter(o => monthOf(o.date) === m), matched = matchedIds(s);
  const real = ops.filter(o => !o.planned), planned = ops.filter(o => o.planned && !matched.has(o.id));
  const toDate = incomeOf(real) - spentOf(real);
  const forecast = toDate + incomeOf(planned) - spentOf(planned);
  // an envelope is deducted in full; once released it only keeps what was actually bought
  const stock = sum(s.envelopes.filter(e => e.month === m), e => (e.released ? envelopeUsed(s, e.id) : e.amount));
  const net = forecast - s.settings.reserve - stock;
  const savingsIds = new Set(s.accounts.filter(a => a.savings).map(a => a.id));
  return {
    income: incomeOf(real), spent: spentOf(real), toDate,
    expectedIncome: incomeOf(planned), expectedSpent: spentOf(planned), forecast,
    reserve: s.settings.reserve, stock, spendable: Math.max(0, net), shortfall: Math.max(0, -net),
    savedTransfer: sum(real.filter(o => o.kind === 'transfer' && savingsIds.has(o.accountId)), o => o.amount),
  };
}

export const balance = (s, a) => a.opening + sum(s.ops.filter(o => o.accountId === a.id && !o.planned), o => o.amount);

export function categorySpend(s, m, accountId) {
  const real = s.ops.filter(o => !o.planned && monthOf(o.date) === m && (!accountId || o.accountId === accountId));
  return s.categories.map(c => ({ ...c, spent: spentOf(real.filter(o => o.categoryId === c.id)) }));
}

export function alerts(s, m) {
  const out = [], pcts = [...new Set([s.settings.alertPct, 100])];
  const check = (key, label, spent, cap) => {
    if (cap > 0) for (const p of pcts) if (spent * 100 >= cap * p) out.push({ id: `${key}|${m}|${p}`, label, pct: p, spent, cap });
  };
  check('global', 'Budget global', monthStats(s, m).spent, s.settings.globalCap);
  for (const c of categorySpend(s, m)) check(c.id, c.name, c.spent, c.cap);
  return out.filter(a => !s.dismissedAlerts.includes(a.id));
}

export const upcoming = (s, m) => {
  const matched = matchedIds(s);
  return s.ops.filter(o => o.planned && !matched.has(o.id) && monthOf(o.date) === m).sort((a, b) => a.date.localeCompare(b.date));
};

export function staleAccounts(s, today, maxDays = 30) {
  return s.accounts
    .map(a => ({ a, last: [...s.ops.filter(o => o.accountId === a.id && !o.planned).map(o => o.date), s.snapshots?.[a.id]?.date ?? ''].sort().at(-1) || null }))
    .filter(x => !x.last || dayNum(today) - dayNum(x.last) > maxDays);
}

// ---- operations ----

export function saveOp(s, f, id) {
  if (!s.accounts.some(a => a.id === f.accountId)) throw new Error('Compte inconnu');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new Error('Date invalide');
  if (!['income', 'expense', 'refund'].includes(f.kind)) throw new Error('Type invalide');
  if (!Number.isInteger(f.cents) || f.cents <= 0) throw new Error('Montant invalide');
  const fields = { accountId: f.accountId, date: f.date, kind: f.kind, amount: signed(f.kind, f.cents),
    categoryId: f.categoryId || null, label: (f.label || '').trim(), planned: !!f.planned };
  if (!id) return s.ops.push({ id: uid(), ...fields });
  const o = s.ops.find(x => x.id === id);
  if (!o || o.transferId || o.envelopeId) throw new Error('Opération non modifiable ici');
  Object.assign(o, fields);
  if (o.planned) delete o.plannedId; else unmatchPlanned(s, o.id);
}

const unmatchPlanned = (s, plannedId) => s.ops.forEach(x => x.plannedId === plannedId && delete x.plannedId);

export function deleteOp(s, id) {
  const o = s.ops.find(x => x.id === id);
  if (!o) return;
  s.ops = s.ops.filter(x => x.id !== id && !(o.transferId && x.transferId === o.transferId));
  unmatchPlanned(s, id);
}

export function addTransfer(s, fromId, toId, date, cents, label = 'Virement') {
  if (fromId === toId) throw new Error('Choisissez deux comptes différents');
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  const transferId = uid();
  s.ops.push({ id: uid(), accountId: fromId, date, amount: -cents, kind: 'transfer', transferId, label },
             { id: uid(), accountId: toId, date, amount: cents, kind: 'transfer', transferId, label });
}

// Opposite amounts on two different accounts within a few days look like an internal transfer.
export function transferCandidates(s, maxDays = 3) {
  const free = s.ops.filter(o => !o.planned && ['income', 'expense', 'refund'].includes(o.kind) && !o.plannedId && !o.notTransfer);
  const used = new Set(), pairs = [];
  for (const out of free) {
    if (out.amount >= 0 || used.has(out.id)) continue;
    const inn = free.find(i => !used.has(i.id) && i.amount === -out.amount && i.accountId !== out.accountId
      && Math.abs(dayNum(i.date) - dayNum(out.date)) <= maxDays);
    if (inn) { used.add(out.id); used.add(inn.id); pairs.push([out, inn]); }
  }
  return pairs;
}

export function linkTransfer(s, outId, inId) {
  const transferId = uid();
  for (const o of s.ops.filter(x => x.id === outId || x.id === inId)) Object.assign(o, { kind: 'transfer', transferId, categoryId: null });
}

export function unlinkTransfer(s, transferId) {
  for (const o of s.ops.filter(x => x.transferId === transferId)) { o.kind = o.amount < 0 ? 'expense' : 'income'; delete o.transferId; }
}

// ---- planned / recurring ----

export function matchCandidates(s, planned) {
  return s.ops
    .filter(o => !o.planned && !o.plannedId && o.kind === planned.kind && monthOf(o.date) === monthOf(planned.date))
    .sort((a, b) => Math.abs(a.amount - planned.amount) - Math.abs(b.amount - planned.amount));
}

export function match(s, plannedId, realId) {
  const r = s.ops.find(o => o.id === realId);
  if (!r || r.planned) throw new Error('Opération réelle introuvable');
  unmatchPlanned(s, plannedId);
  r.plannedId = plannedId;
}
export const unmatch = unmatchPlanned;

// shortcut: monthly recurrence only; yearly items (taxes) are entered as one-off planned ops.
export function generateRecurring(s, m) {
  const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
  let n = 0;
  for (const r of s.recurring) {
    if (s.ops.some(o => o.recurringId === r.id && monthOf(o.date) === m)) continue;
    s.ops.push({ id: uid(), accountId: r.accountId, date: `${m}-${String(Math.min(r.day, last)).padStart(2, '0')}`,
      amount: signed(r.kind, r.cents), kind: r.kind, categoryId: r.categoryId, label: r.label, planned: true, recurringId: r.id });
    n++;
  }
  return n;
}

// ---- stock-market envelopes ----

export function addEnvelope(s, m, cents, label = 'Enveloppe bourse') {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  s.envelopes.push({ id: uid(), month: m, amount: cents, label, released: false });
}

// isin/qty are optional so a purchase can still be logged before the instrument is set up
export function buyFromEnvelope(s, envId, accountId, date, cents, label, isin, qty) {
  const e = s.envelopes.find(x => x.id === envId);
  if (!e) throw new Error('Enveloppe introuvable');
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  if (cents > envelopeLeft(s, e)) throw new Error('Montant supérieur au reliquat de l’enveloppe');
  if (isin) checkTrade(s, isin, qty);
  s.ops.push({ id: uid(), accountId, date, amount: -cents, kind: 'invest', envelopeId: envId, label, seq: stamp(s), ...(isin && { isin, qty }) });
}

export const releaseEnvelope = (s, id) => { s.envelopes.find(e => e.id === id).released = true; };

// ---- portfolio (lot 2, P01): consultation only, no order is ever sent ----

// The `isin` field is the instrument's id: its ISIN when known, otherwise the price symbol (added from a search).
export function saveInstrument(s, f) {
  const isin = String(f.isin ?? '').trim().toUpperCase(), symbol = (f.symbol || '').trim().toUpperCase(), currency = String(f.currency).trim().toUpperCase();
  const id = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) || s.instruments.some(x => x.isin === isin) ? isin : !isin && symbol ? symbol : null;
  if (!id) throw new Error('ISIN invalide');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Devise invalide (ex. EUR)');
  const old = s.instruments.find(x => x.isin === id);
  const i = { isin: id, name: (f.name || '').trim() || id, symbol, place: (f.place || '').trim(), currency, type: f.type || old?.type || '' };
  if (old) Object.assign(old, i); else s.instruments.push(i);
  return id;
}

// Broad ETFs rarely make headlines themselves: their news is searched by index name.
export function newsQuery(i) {
  const idx = i.name.match(/MSCI [A-Z][\w ]*?(?= UCITS| ETF| \(|$)|S&P ?500|NASDAQ[- ]?100|STOXX ?(Europe )?\d+|CAC ?40|DAX/i);
  return (idx ? idx[0] : i.name.replace(/\(.*?\)|\b(UCITS|ETF|Acc|Dist|SE|SA|Inc|Corp|PLC)\b\.?/gi, '')).replace(/\s+/g, ' ').trim();
}

// Daily closes from the price provider: keeps the last 100 and makes the latest one the current quote.
export function setHistory(s, isin, points, source, today) {
  const inst = s.instruments.find(i => i.isin === isin);
  const h = points.filter(([d, p]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && p > 0).sort((a, b) => a[0].localeCompare(b[0])).slice(-100);
  if (!inst || !h.length) return false;
  s.history[isin] = h;
  const [asOf, price] = h.at(-1), hi = h.reduce((m, x) => (x[1] > m[1] ? x : m));
  s.quotes[isin] = { price, currency: inst.currency, asOf, source, fetchedAt: today };
  trackPeak(s, isin, hi[1], hi[0]);
  return true;
}

export function trend(s, isin) {
  const h = s.history[isin];
  if (!h || h.length < 50) return null;
  const closes = h.map(x => x[1]), last = closes.at(-1);
  return { sma50: closes.slice(-50).reduce((a, b) => a + b, 0) / 50, perf3m: (last / closes[Math.max(0, closes.length - 64)] - 1) * 100,
    high: Math.max(...closes), asOf: h.at(-1)[0] };
}

const checkTrade = (s, isin, qty) => {
  if (!s.instruments.some(i => i.isin === isin)) throw new Error('Instrument inconnu');
  if (!(qty > 0)) throw new Error('Quantité invalide');
};

// A holding bought before using the app: no cash movement, only its cost.
export function addHolding(s, accountId, isin, date, qty, costCents) {
  checkTrade(s, isin, qty);
  if (!Number.isInteger(costCents) || costCents < 0) throw new Error('Prix de revient invalide');
  s.ops.push({ id: uid(), accountId, date, amount: 0, cost: costCents, kind: 'invest', isin, qty, label: 'Position existante', seq: stamp(s) });
}

// Records a sale already done at the broker; proceeds land in the broker account, not in the household budget.
export function addSale(s, accountId, isin, date, qty, cents) {
  checkTrade(s, isin, qty);
  const held = positions(s).find(p => p.accountId === accountId && p.isin === isin)?.qty ?? 0;
  if (qty > held + 1e-9) throw new Error('Quantité supérieure à la position');
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  s.ops.push({ id: uid(), accountId, date, amount: cents, kind: 'invest', isin, qty: -qty, label: `Vente ${s.instruments.find(i => i.isin === isin).name}`, seq: stamp(s) });
}

// Removes a title entered by mistake, with everything attached to it (trades, snapshot lines, prices, news, target).
export function deleteInstrument(s, isin) {
  s.ops = s.ops.filter(o => o.isin !== isin);
  for (const sn of Object.values(s.snapshots)) sn.lines = sn.lines.filter(l => l.isin !== isin);
  s.instruments = s.instruments.filter(i => i.isin !== isin);
  for (const k of ['quotes', 'history', 'peaks', 'newsFetched']) delete s[k][isin];
  delete s.settings.profile.targets[isin];
  s.news = s.news.filter(n => n.isin !== isin);
  if (s.discovery?.items) delete s.discovery.items[isin];
}

// Increasing number telling whether a trade was recorded before or after the last broker snapshot import.
const stamp = s => (s.seq = (s.seq ?? 0) + 1);

// Average-cost positions per account and instrument; cost in cents, fees included.
// An account with a broker snapshot starts from it: only its trades dated after the snapshot are added.
export function positions(s) {
  const snaps = s.snapshots ?? {}, map = new Map();
  for (const [accountId, sn] of Object.entries(snaps)) for (const l of sn.lines) map.set(`${accountId}|${l.isin}`, { accountId, isin: l.isin, qty: l.qty, cost: l.cost });
  const counted = o => {
    const sn = snaps[o.accountId];
    return o.kind === 'invest' && o.isin && o.qty && (!sn || o.date > sn.date || (o.seq ?? 0) > (sn.seq ?? 0)); // recorded after the import: not in it
  };
  for (const o of s.ops.filter(counted).sort((a, b) => a.date.localeCompare(b.date))) {
    const k = `${o.accountId}|${o.isin}`, p = map.get(k) ?? { accountId: o.accountId, isin: o.isin, qty: 0, cost: 0 };
    if (o.qty > 0) p.cost += o.cost ?? -o.amount;
    else p.cost -= p.qty > 0 ? Math.round((p.cost * -o.qty) / p.qty) : 0;
    p.qty = Math.round((p.qty + o.qty) * 1e6) / 1e6;
    map.set(k, p);
  }
  return [...map.values()].filter(p => p.qty > 0);
}

// shortcut: weekends only, exchange holidays ignored — a quote may look stale one day too early.
const businessDaysAfter = (from, to) => {
  let n = 0;
  for (let d = dayNum(from) + 1; d <= dayNum(to); d++) { const w = new Date(d * 864e5).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
};
// the previous trading day's close is still current
export const isStale = (asOf, today) => !asOf || businessDaysAfter(asOf, today) > 1;

export function valuation(s, today) {
  return positions(s).map(p => {
    const inst = s.instruments.find(i => i.isin === p.isin) ?? { isin: p.isin, name: p.isin, currency: 'EUR' };
    const q = s.quotes[p.isin]?.currency === inst.currency ? s.quotes[p.isin] : null;
    const fx = inst.currency === 'EUR' ? null : s.fx[inst.currency] ?? null;
    const value = q && (fx || inst.currency === 'EUR') ? Math.round((p.qty * q.price * 100) / (fx?.rate ?? 1)) : null;
    return { ...p, inst, quote: q, fx, value, gain: value == null ? null : value - p.cost,
      stale: isStale(q?.asOf, today) || (inst.currency !== 'EUR' && isStale(fx?.asOf, today)) };
  });
}

export function setQuote(s, isin, price, asOf, source = 'saisie manuelle') {
  const inst = s.instruments.find(i => i.isin === isin);
  if (!inst) throw new Error('Instrument inconnu');
  if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Cours ou date invalide');
  s.quotes[isin] = { price, currency: inst.currency, asOf, source, fetchedAt: asOf };
  trackPeak(s, isin, price, asOf);
}

// highest price seen since the app started following the instrument (used by the trailing-stop rule)
export function trackPeak(s, isin, price, asOf) {
  if (!(s.peaks[isin]?.price >= price)) s.peaks[isin] = { price, asOf };
}

// ---- news (lot 2, P02): headline, source, date and link only, never the article text ----

export function addNews(s, isin, a, today) {
  const url = String(a.url ?? '');
  if (!/^https?:\/\//i.test(url) || s.news.some(n => n.url === url)) return false; // only web links, no duplicates
  s.news.push({ isin, title: String(a.title ?? '').slice(0, 300), url, source: String(a.source ?? ''), publishedAt: String(a.publishedAt ?? '').slice(0, 10), fetchedAt: today,
    sentiment: Number.isFinite(a.sentiment) ? Math.max(-1, Math.min(1, a.sentiment)) : null });
  return true;
}
export const pruneNews = (s, today, keepDays = 30) => { s.news = s.news.filter(n => dayNum(today) - dayNum(n.publishedAt) <= keepDays); };
export const newsFor = (s, isin) => s.news.filter(n => n.isin === isin).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
export const isOldNews = (n, today) => dayNum(today) - dayNum(n.publishedAt) > 7;

// shortcut: keyword match on headlines (FR/EN); a human reads the article before acting
const NOTABLE = /fusion|merger|absorption|liquidation|delist|radiation|changement d.indice|index change|fermeture|closure|dissolution|suspension/i;

// ---- suggestions (lot 2, P03): explicit rules, information only, never an order ----

export const RISK = {
  prudent: { label: 'Prudent', trail: 7, maxLoss: 10 },
  equilibre: { label: 'Équilibré', trail: 12, maxLoss: 20 },
  dynamique: { label: 'Dynamique', trail: 20, maxLoss: 35 },
};
export const DISCLAIMER = 'Information, pas un conseil en investissement. Aucun ordre n’est passé.';
const euro = c => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const pct = x => `${x.toFixed(1).replace('.', ',')} %`;

// One verdict per followed title, merging allocation, price trend, news tone and the profile's risk limits.
// Each reason carries its points (+ favours buying, − favours selling), and its date and source when it has one.
export function suggestions(s, today) {
  const p = s.settings.profile, risk = RISK[p.risk];
  const lines = valuation(s, today), held = new Set(lines.map(l => l.isin));
  const blocked = [...new Set(lines.filter(l => l.value == null || l.stale).map(l => l.inst.name))];
  const byIsin = {};
  for (const l of lines) byIsin[l.isin] = (byIsin[l.isin] ?? 0) + (l.value ?? 0);
  const total = Object.values(byIsin).reduce((a, b) => a + b, 0);
  const weight = isin => (total ? ((byIsin[isin] ?? 0) * 100) / total : 0);
  const hasTargets = Object.values(p.targets).some(t => t > 0);

  const out = s.instruments.map(i => {
    const isHeld = held.has(i.isin), q = s.quotes[i.isin], reasons = [];
    const add = (pts, text, asOf, source) => reasons.push({ pts, text, asOf, source });
    const base = { isin: i.isin, name: i.name, held: isHeld, reasons };
    const fxOk = i.currency === 'EUR' || !isStale(s.fx[i.currency]?.asOf, today);
    // a missing or stale price suspends the verdict instead of guessing
    if (!q || q.currency !== i.currency || isStale(q.asOf, today) || !fxOk) {
      add(0, !q ? 'Aucun cours : actualisez ou saisissez-le.' : !fxOk ? `Taux de change ${i.currency} absent ou périmé.` : `Cours du ${q.asOf} non à jour.`, q?.asOf, q?.source);
      return { ...base, action: 'Suspendu', score: 0, suspended: true };
    }
    const t = p.targets[i.isin] ?? 0;
    if (hasTargets && (t > 0 || isHeld)) {
      if (blocked.length) add(0, `Allocation non calculée : cours manquant ou périmé pour ${blocked.join(', ')}.`);
      else {
        const w = weight(i.isin), gap = t - w, far = Math.abs(gap);
        const pts = far < p.driftPts ? 0 : Math.sign(gap) * (far >= 2 * p.driftPts ? 2 : 1);
        add(pts, `Poids ${pct(w)} pour une cible de ${pct(t)}${pts ? ` : ${pts > 0 ? 'sous' : 'sur'}-pondéré de ${far.toFixed(1).replace('.', ',')} points` : ', dans la tolérance'}.`);
      }
    }
    const tr = trend(s, i.isin);
    if (tr) {
      const up = q.price >= tr.sma50;
      add(up ? 1 : -1, `Cours ${up ? 'au-dessus' : 'en dessous'} de sa moyenne 50 jours (${tr.sma50.toFixed(2).replace('.', ',')} ${i.currency}).`, tr.asOf, q.source);
      if (tr.perf3m >= 5 || tr.perf3m <= -10) add(tr.perf3m > 0 ? 0.5 : -0.5, `${tr.perf3m > 0 ? '+' : ''}${pct(tr.perf3m)} sur 3 mois.`, tr.asOf, q.source);
    } else add(0, 'Tendance inconnue : historique insuffisant (actualisez en ligne).');
    const recent = s.news.filter(n => n.isin === i.isin && dayNum(today) - dayNum(n.publishedAt) <= 14);
    const tones = recent.map(n => n.sentiment).filter(Number.isFinite);
    if (tones.length >= 2) {
      const avg = tones.reduce((a, b) => a + b, 0) / tones.length;
      add(avg > 0.2 ? 1 : avg < -0.2 ? -1 : 0, `Ton des actualités ${avg > 0.2 ? 'positif' : avg < -0.2 ? 'négatif' : 'neutre'} (${tones.length} articles sur 14 jours).`, recent[0].publishedAt, 'Marketaux');
    } else if (!recent.length && !s.discovery?.items?.[i.isin]) add(0, 'Aucune actualité récente.');
    const found = s.discovery?.items?.[i.isin];
    if (found) add(found.tone >= 0.2 ? 1 : 0, `Repéré par l’outil : ${found.docs} articles cette semaine, ton ${found.tone >= 0.2 ? 'positif' : 'plutôt neutre'} (${found.tone.toFixed(2).replace('.', ',')}).`, found.asOf, 'Marketaux');
    const notable = recent.filter(n => NOTABLE.test(n.title));
    for (const n of notable) add(0, `À lire avant de décider : « ${n.title} »`, n.publishedAt, n.source);
    let limitHit = false;
    for (const l of lines.filter(l => l.isin === i.isin && l.cost > 0)) {
      const gain = ((l.value - l.cost) * 100) / l.cost, hi = Math.max(tr?.high ?? 0, s.peaks[i.isin]?.price ?? 0);
      const drop = hi ? ((hi - q.price) * 100) / hi : 0;
      if (gain <= -risk.maxLoss) { limitHit = true; add(-2, `Moins-value de ${pct(-gain)}, au-delà de votre perte maximale de ${risk.maxLoss} % (profil ${risk.label}).`); }
      else if (p.horizon < 5 && gain > 0 && drop >= risk.trail) {
        limitHit = true;
        add(-2, `${pct(drop)} sous son plus haut (${hi.toFixed(2).replace('.', ',')} ${i.currency}) avec ${pct(gain)} de plus-value : stop suiveur de ${risk.trail} % (horizon ${p.horizon} ans).`);
      }
    }
    const score = Math.round(reasons.reduce((a, r) => a + r.pts, 0) * 10) / 10;
    // a risk limit of the profile always leads to reducing the line, whatever the other signals say
    const action = notable.length ? 'À examiner'
      : isHeld ? (score <= -3 ? 'Vendre' : limitHit || score <= -2 ? 'Alléger' : score >= 2 ? 'Renforcer' : 'Conserver')
        : score >= 2 ? 'Acheter' : 'Attendre';
    return { ...base, action, score };
  });

  // this month's envelope goes to the strongest buy signal, within the remaining amount and the broker's cash
  const left = s.envelopes.filter(e => e.month === monthOf(today)).reduce((a, e) => a + envelopeLeft(s, e), 0);
  const pick = left > 0 && out.filter(x => x.action === 'Acheter' || x.action === 'Renforcer').sort((a, b) => b.score - a.score)[0];
  if (pick) {
    const i = s.instruments.find(x => x.isin === pick.isin), line = lines.find(l => l.isin === pick.isin);
    const accounts = line ? [s.accounts.find(a => a.id === line.accountId)]
      : s.accounts.filter(a => s.snapshots?.[a.id] || s.ops.some(o => o.kind === 'invest' && o.accountId === a.id));
    const fxCost = i.currency === 'EUR' ? 0 : p.fxPct / 100;
    const raw = (s.quotes[i.isin].price * 100 * (1 + fxCost)) / (i.currency === 'EUR' ? 1 : s.fx[i.currency].rate);
    const unit = Math.ceil(Math.round(raw * 1e6) / 1e6); // drop float noise (561.2 * 100 = 56120.000000001)
    // the broker's cash limits the purchase only when the app knows it (some movement recorded or an opening balance)
    const plan = a => {
      const known = a.opening !== 0 || s.ops.some(o => o.accountId === a.id && o.amount !== 0), cash = balance(s, a);
      const limit = known ? Math.min(left, cash) : left;
      const qty = a.fractional ? Math.max(0, Math.floor(((limit - p.fee) / raw) * 1000) / 1000) : Math.max(0, Math.floor((limit - p.fee) / unit));
      return { a, limit, qty, total: qty ? (a.fractional ? Math.round(qty * raw) : qty * unit) + p.fee : 0,
        where: !known ? 'reliquat de l’enveloppe, encaisse inconnue' : cash < left ? `limité par l’encaisse ${a.name}` : 'reliquat de l’enveloppe' };
    };
    const best = accounts.map(plan).sort((x, y) => y.total - x.total)[0];
    const parts = q => `${String(q).replace('.', ',')} part${q > 1 ? 's' : ''}`;
    if (!best) pick.reasons.push({ pts: 0, text: 'Enveloppe du mois : aucun compte titres connu pour acheter.' });
    else if (!best.qty) pick.reasons.push({ pts: 0, text: `Enveloppe du mois : ${euro(best.limit)} disponibles (${best.where}), insuffisant pour une part (${euro(unit)}) et les frais. Un compte acceptant les fractions de parts le permettrait.` });
    else {
      pick.buy = { qty: best.qty, total: best.total, limit: best.limit, accountId: best.a.id };
      pick.reasons.push({ pts: 0, text: `Enveloppe du mois : ${parts(best.qty)} sur ${best.a.name} pour environ ${euro(best.total)} frais compris (${best.where} : ${euro(best.limit)}).` });
    }
  }
  return out.sort((a, b) => (a.suspended ?? 0) - (b.suspended ?? 0) || Math.abs(b.score) - Math.abs(a.score));
}

// ---- phone notifications: only what is new, so the same advice or alert is never sent twice ----

const ACTIONABLE = ['Acheter', 'Renforcer', 'Alléger', 'Vendre', 'À examiner'];

export function pendingNotifications(s, today) {
  const n = (s.notified ??= { verdicts: {}, sent: [] }), m = monthOf(today), out = [];
  // a verdict is announced when it changes to something to act on
  for (const x of suggestions(s, today)) {
    if (x.suspended || !ACTIONABLE.includes(x.action) || n.verdicts[x.isin] === x.action) continue;
    const main = [...x.reasons].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
    out.push({ id: `v|${x.isin}|${x.action}`, kind: 'verdict', action: x.action, name: x.name, title: `${x.action} : ${x.name}`,
      body: (x.buy ? `Enveloppe : ${String(x.buy.qty).replace('.', ',')} part(s) ≈ ${euro(x.buy.total)}. ` : '') + (main?.text ?? '') });
  }
  // budget alerts are announced once per month and threshold
  const st = monthStats(s, m), low = s.settings.lowSpendable;
  if (low > 0 && st.spendable <= low)
    out.push({ id: `low|${m}`, once: true, title: 'Pouvoir d’achat presque atteint',
      body: `Il reste ${euro(st.spendable)} dépensables ce mois${st.shortfall ? ` (manque ${euro(st.shortfall)})` : ''}.` });
  for (const a of alerts(s, m)) out.push({ id: `a|${a.id}`, once: true, title: `Budget ${a.label} : ${a.pct} % atteint`, body: `${euro(a.spent)} dépensés sur ${euro(a.cap)}.` });
  const fresh = out.filter(x => !x.once || !n.sent.includes(x.id));
  // many verdicts at once (first use, big market move): one summary instead of a burst
  const verdicts = fresh.filter(x => x.kind === 'verdict');
  if (verdicts.length <= 3) return fresh;
  const by = a => verdicts.filter(x => x.action === a).map(x => x.name);
  return [{ id: `sum|${today}`, title: `${verdicts.length} avis bourse`,
    body: ACTIONABLE.filter(a => by(a).length).map(a => `${a} : ${by(a).join(', ')}`).join(' · ') }, ...fresh.filter(x => x.kind !== 'verdict')];
}

// Remembers what was announced: current verdicts, and the one-off alerts sent.
export function markNotified(s, sent, today) {
  for (const x of suggestions(s, today)) if (!x.suspended) s.notified.verdicts[x.isin] = x.action;
  s.notified.sent = [...s.notified.sent, ...sent.filter(x => x.once).map(x => x.id)].slice(-200);
}

// ---- import ----

const parseAmount = v => {
  let t = String(v ?? '').replace(/[\s €]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return t ? Math.round(Number(t) * 100) : NaN;
};
const parseDate = v => {
  const t = String(v ?? '').trim(), fr = t.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/), compact = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  return fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

// Splits a ;- or ,-separated file; headers are lower-cased without accents.
function csvTable(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('Fichier vide');
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => {
    const out = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    return [...out, cur.trim()];
  };
  const head = split(lines[0]).map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return { head, rows: lines.slice(1).map(split), col: (...res) => head.findIndex(h => res.some(re => re.test(h))) };
}

// shortcut: generic CSV (date; libellé; montant or débit/crédit); real bank formats still to verify on anonymised samples.
export function parseCsv(text) {
  const { rows: lines, col } = csvTable(text);
  const iDate = col(/date/), iLabel = col(/libelle|label|description/), iAmt = col(/montant|amount/), iDeb = col(/debit/), iCred = col(/credit/);
  if (iDate < 0 || iLabel < 0 || (iAmt < 0 && iDeb < 0 && iCred < 0)) throw new Error('Colonnes attendues : date, libellé, montant (ou débit/crédit)');
  const rows = [], errors = [];
  lines.forEach((c, n) => {
    const date = parseDate(c[iDate]);
    const amount = iAmt >= 0 ? parseAmount(c[iAmt]) : (parseAmount(c[iCred] || '0') || 0) - Math.abs(parseAmount(c[iDeb] || '0') || 0);
    if (!date || !Number.isFinite(amount) || amount === 0) errors.push(n + 2);
    else rows.push({ date, label: c[iLabel] || '', amount });
  });
  return { rows, errors };
}

export function importPreview(s, accountId, rows) {
  const keys = new Set(s.ops.map(o => o.importKey).filter(Boolean)), seen = {};
  return rows.map(r => {
    const base = [accountId, r.date, r.amount, r.label.trim().toLowerCase()].join('|');
    const importKey = `${base}#${(seen[base] = (seen[base] || 0) + 1)}`; // identical lines in one statement stay distinct
    const dup = keys.has(importKey) ? 'déjà importée'
      : s.ops.some(o => !o.planned && !o.importKey && o.accountId === accountId && o.date === r.date && o.amount === r.amount) ? 'saisie manuelle identique' : null;
    return { ...r, importKey, dup, keep: !dup };
  });
}

export function importRows(s, accountId, preview, today) {
  const kept = preview.filter(r => r.keep);
  for (const r of kept) s.ops.push({ id: uid(), accountId, date: r.date, amount: r.amount, kind: r.amount < 0 ? 'expense' : 'income',
    categoryId: null, label: r.label, importKey: r.importKey });
  s.lastImport = { date: today, accountId, count: kept.length };
  return kept.length;
}

// ---- broker statements (lot 2): IBKR Flex Query "Trades" CSV, or the app's own template for TR / Fortuneo ----

export const TRADES_TEMPLATE = 'date;isin;nom;sens;quantite;montant net;devise;taux\n03/11/2026;IE00B4L5Y983;iShares Core MSCI World;Achat;2;-210,40;EUR;\n';

// shortcut: column names follow IBKR's Flex field names and our template; to re-check on real anonymised exports.
export function parseTradesCsv(text) {
  const { rows: lines, col } = csvTable(text);
  if (col(/^transaction_id$/) >= 0 && col(/^category$/) >= 0) return parseTradeRepublic(lines, col);
  const c = {
    date: col(/^tradedate$/, /^date/), isin: col(/^isin$/), qty: col(/^quantity$/, /^quantite/), net: col(/^netcash$/, /^montant/),
    side: col(/^buy\/sell$/, /^sens$/), ccy: col(/^currencyprimary$/, /^currency$/, /^devise$/), fx: col(/^fxratetobase$/, /^taux/),
    id: col(/^tradeid$/, /^reference$/), name: col(/^description$/, /^nom$/), symbol: col(/^symbol$/), asset: col(/^assetclass$/),
  };
  if ([c.date, c.isin, c.qty, c.net].some(i => i < 0)) throw new Error('Colonnes attendues : date, ISIN, quantité, montant net');
  const num = v => Number(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.'));
  const rows = [], errors = [], ignored = [];
  lines.forEach((r, n) => {
    const line = n + 2, get = k => (c[k] >= 0 ? r[c[k]] ?? '' : '');
    if (get('asset') && get('asset').toUpperCase() !== 'STK') return ignored.push(line); // FX conversions, options…: out of scope
    const date = parseDate(get('date')), isin = get('isin').toUpperCase(), side = get('side').toLowerCase();
    let qty = num(get('qty')), net = parseAmount(get('net'));
    const currency = (get('ccy') || 'EUR').toUpperCase(), fx = currency === 'EUR' ? 1 : num(get('fx'));
    if (/^(buy|achat)/.test(side)) { qty = Math.abs(qty); net = -Math.abs(net); }
    if (/^(sell|vente)/.test(side)) { qty = -Math.abs(qty); net = Math.abs(net); }
    if (!date || !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) || !qty || !Number.isFinite(net) || !(fx > 0) || Math.sign(qty) === Math.sign(net)) return errors.push(line);
    rows.push({ date, isin, qty, amount: Math.round(net * fx), currency, name: get('name') || isin, symbol: get('symbol'), tradeId: get('id') });
  });
  return { rows, errors, ignored };
}

// Trade Republic « Exportation de transactions »: trades rebuild positions; dividends, interest and deposits move
// the broker's cash (outside the household budget); card payments are household expenses.
function parseTradeRepublic(lines, col) {
  const c = { date: col(/^date$/), cat: col(/^category$/), type: col(/^type$/), name: col(/^name$/), isin: col(/^symbol$/), shares: col(/^shares$/),
    amount: col(/^amount$/), fee: col(/^fee$/), tax: col(/^tax$/), ccy: col(/^currency$/), id: col(/^transaction_id$/), desc: col(/^description$/) };
  const num = v => Number(String(v ?? '').trim() || 0), rows = [], errors = [], ignored = [];
  // securities moved between TR sub-accounts come as −n / +n pairs on the same day: they cancel out
  const moves = {};
  for (const r of lines) if (r[c.cat] === 'DELIVERY') moves[r[c.isin] + r[c.date]] = (moves[r[c.isin] + r[c.date]] ?? 0) + num(r[c.shares]);
  lines.forEach((r, n) => {
    const line = n + 2, type = r[c.type] ?? '', date = parseDate(r[c.date]), isin = String(r[c.isin] ?? '').toUpperCase(), name = r[c.name] ?? '';
    const net = Math.round((num(r[c.amount]) + num(r[c.fee]) + num(r[c.tax])) * 100);
    if (!date || (r[c.ccy] && r[c.ccy] !== 'EUR')) return errors.push(line);
    if (r[c.cat] === 'DELIVERY') return Math.abs(moves[r[c.isin] + r[c.date]]) < 1e-9 ? ignored.push(line) : errors.push(line);
    if (r[c.cat] === 'TRADING') {
      const qty = Math.abs(num(r[c.shares])) * (type === 'SELL' ? -1 : 1);
      if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) || !qty || !net || Math.sign(qty) === Math.sign(net)) return errors.push(line);
      return rows.push({ date, isin, qty, amount: net, currency: 'EUR', name: name || isin, symbol: '', tradeId: r[c.id] });
    }
    if (!net) return ignored.push(line);
    const card = /^CARD_/.test(type);
    const label = card ? `Carte TR · ${name || r[c.desc]}` : type === 'DIVIDEND' ? `Dividende ${name}` : /INTEREST/.test(type) ? 'Intérêts'
      : /TAX/.test(type) ? 'Impôt / régularisation' : /INBOUND|INPAYMENT/.test(type) ? 'Versement' : String(r[c.desc] || type);
    rows.push({ date, amount: net, kind: card ? (net < 0 ? 'expense' : 'refund') : 'invest', label, tradeId: r[c.id] });
  });
  return { rows, errors, ignored };
}

// Fortuneo « Export portefeuille simple » (.xls, turned into rows of cells by the page): a dated snapshot of the positions.
export function parseFortuneoRows(rows) {
  const h = rows.findIndex(r => /^libell/i.test(String(r[0])) && r.some(x => /isin/i.test(String(x))));
  if (h < 0) throw new Error('Fichier Fortuneo non reconnu (colonnes Libellé … ISIN attendues)');
  const head = rows[h].map(x => String(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const col = re => head.findIndex(x => re.test(x));
  const c = { price: col(/^cours/), ccy: col(/^dev/), qty: col(/^qt/), value: col(/^valorisation/), pv: col(/^\+\/- values$/), isin: col(/^isin/) };
  if (Object.values(c).some(i => i < 0)) throw new Error('Colonnes Fortuneo manquantes (Cours, Dev, Qté, Valorisation, +/- values, ISIN)');
  const num = v => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.')));
  const cellDate = v => (typeof v === 'number' ? new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10) : parseDate(String(v).trim()));
  const date = rows.slice(0, h).map(r => cellDate(r[0])).find(Boolean);
  if (!date) throw new Error('Date du portefeuille introuvable');
  const lines = [], errors = [];
  rows.slice(h + 1).forEach((r, n) => {
    if (!String(r[0] ?? '').trim()) return;
    const isin = String(r[c.isin] ?? '').trim().toUpperCase(), qty = num(r[c.qty]), price = num(r[c.price]), value = num(r[c.value]), pv = num(r[c.pv]);
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) || !(qty > 0) || !(price > 0) || !(value > 0) || !Number.isFinite(pv)) return errors.push(h + n + 2);
    const label = String(r[0]).trim(), ticker = label.match(/\(([A-Z0-9.]+)\)$/)?.[1] ?? '';
    lines.push({ isin, name: label.replace(/\s*\([A-Z0-9.]+\)$/, ''), ticker, currency: String(r[c.ccy]).trim().toUpperCase() || 'EUR',
      qty, price, value: Math.round(value * 100), cost: Math.round((value - pv) * 100) }); // valuation and gain are in euros
  });
  return { date, kind: rows.slice(0, h).map(r => String(r[0]).match(/^\((\w+)/)?.[1]).find(Boolean) ?? '', lines, errors };
}

// shortcut: price symbol guessed from the ticker the broker shows (US → as is, Paris in EUR → .PAR); others via « Trouver le cours »
const guessSymbol = l => (!l.ticker ? '' : l.isin.startsWith('US') ? l.ticker : l.isin.startsWith('FR') && l.currency === 'EUR' ? `${l.ticker}.PAR` : '');

// The snapshot becomes the account's positions; trades recorded after its date still add to it. Re-importing replaces it.
export function applySnapshot(s, accountId, snap, source) {
  for (const l of snap.lines) {
    if (!s.instruments.some(i => i.isin === l.isin)) saveInstrument(s, { isin: l.isin, name: l.name, symbol: guessSymbol(l), currency: l.currency });
    const inst = s.instruments.find(i => i.isin === l.isin);
    if (inst.currency === l.currency && !(s.quotes[l.isin]?.asOf > snap.date)) setQuote(s, l.isin, l.price, snap.date, source);
    // the broker's own euro valuation tells the exchange rate it used
    if (l.currency !== 'EUR' && !(s.fx[l.currency]?.asOf >= snap.date))
      s.fx[l.currency] = { rate: (l.qty * l.price * 100) / l.value, asOf: snap.date, source: `${source} (taux implicite)`, fetchedAt: snap.date };
  }
  s.snapshots[accountId] = { date: snap.date, source, seq: stamp(s), lines: snap.lines.map(({ isin, qty, cost }) => ({ isin, qty, cost })) };
  s.lastImport = { date: snap.date, accountId, count: snap.lines.length };
  return snap.lines.length;
}

export function tradesPreview(s, accountId, rows) {
  const keys = new Set(s.ops.map(o => o.importKey).filter(Boolean)), seen = {};
  return rows.map(r => {
    const base = r.tradeId ? `${accountId}|trade|${r.tradeId}` : [accountId, r.date, r.isin, r.qty, r.amount].join('|');
    const importKey = r.tradeId ? base : `${base}#${(seen[base] = (seen[base] || 0) + 1)}`;
    const dup = keys.has(importKey) ? 'déjà importée'
      : s.ops.some(o => !o.importKey && o.kind === 'invest' && o.accountId === accountId && o.isin === r.isin && o.date === r.date && Math.abs(o.qty - r.qty) < 1e-9)
        ? 'saisie manuelle identique' : null;
    return { ...r, importKey, dup, keep: !dup, newInstrument: !!r.isin && !s.instruments.some(i => i.isin === r.isin) };
  });
}

export function importTrades(s, accountId, preview, today) {
  const kept = preview.filter(r => r.keep);
  for (const r of kept) {
    if (!r.isin) { // broker cash movement (dividend, interest, deposit) or card payment
      s.ops.push({ id: uid(), accountId, date: r.date, amount: r.amount, kind: r.kind, categoryId: null, label: r.label, importKey: r.importKey });
      continue;
    }
    if (!s.instruments.some(i => i.isin === r.isin)) saveInstrument(s, { isin: r.isin, name: r.name, currency: r.currency });
    s.ops.push({ id: uid(), accountId, date: r.date, amount: r.amount, kind: 'invest', isin: r.isin, qty: r.qty,
      label: `${r.qty > 0 ? 'Achat' : 'Vente'} ${r.name}`, importKey: r.importKey, seq: stamp(s) });
  }
  s.lastImport = { date: today, accountId, count: kept.length };
  return kept.length;
}

export function opsCsv(s) {
  const acc = Object.fromEntries(s.accounts.map(a => [a.id, a.name])), cat = Object.fromEntries(s.categories.map(c => [c.id, c.name]));
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['date;compte;type;categorie;libelle;montant;prevue',
    ...[...s.ops].sort((a, b) => a.date.localeCompare(b.date)).map(o =>
      [o.date, q(acc[o.accountId]), KINDS[o.kind], q(cat[o.categoryId]), q(o.label), (o.amount / 100).toFixed(2).replace('.', ','), o.planned ? 'oui' : 'non'].join(';'))].join('\n');
}

// ---- protected backup (AES-GCM, key derived from a password) ----

const b64 = u => { let t = ''; for (const b of u) t += String.fromCharCode(b); return btoa(t); };
const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(state, password) {
  if (!password || password.length < 8) throw new Error('Mot de passe de 8 caractères minimum');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), new TextEncoder().encode(JSON.stringify(state)));
  return JSON.stringify({ format: 'budget-backup', v: 1, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) });
}

export async function decryptBackup(text, password) {
  let plain;
  try {
    const f = JSON.parse(text);
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await deriveKey(password, unb64(f.salt)), unb64(f.data));
  } catch { throw new Error('Mot de passe incorrect ou fichier corrompu'); }
  return validateState(JSON.parse(new TextDecoder().decode(plain)));
}

// ---- fictional demo data (reproduces the acceptance figures) ----

export function demoState(today) {
  const s = emptyState(), m = monthOf(today), d = n => `${m}-${String(n).padStart(2, '0')}`;
  const cat = n => s.categories.find(c => c.name === n).id;
  const acc = (name, institution, extra) => { const a = { id: uid(), name, institution, opening: 0, liquid: true, savings: false, ...extra }; s.accounts.push(a); return a.id; };
  const bcp = acc('Compte courant', 'Banque BCP', { opening: 120000 });
  const fort = acc('Compte Fortuneo', 'Fortuneo', { opening: 80000 });
  const livret = acc('Livret A', 'Fortuneo', { opening: 500000, savings: true, liquid: false });
  const tr = acc('Trade Republic', 'Trade Republic', { opening: 30000, liquid: false });
  const ib = acc('IBKR', 'Interactive Brokers', { opening: 100000, liquid: false });
  Object.assign(s.settings, { reserve: 30000, globalCap: 200000, alertPct: 80 });
  for (const [n, cap] of [['Logement', 90000], ['Alimentation', 40000], ['Loisirs', 10000]]) s.categories.find(c => c.name === n).cap = cap;
  const add = (accountId, day, kind, cents, category, label, planned = false) =>
    s.ops.push({ id: uid(), accountId, date: d(day), amount: signed(kind, cents), kind, categoryId: category && cat(category), label, planned });

  s.recurring.push({ id: uid(), accountId: bcp, kind: 'income', cents: 250000, categoryId: null, label: 'Salaire', day: 1 },
                   { id: uid(), accountId: bcp, kind: 'expense', cents: 80000, categoryId: cat('Logement'), label: 'Loyer', day: 1 });
  generateRecurring(s, m);
  add(bcp, 1, 'income', 250000, null, 'Salaire');
  add(bcp, 1, 'expense', 80000, 'Logement', 'Loyer');
  for (const r of s.recurring) match(s, s.ops.find(o => o.recurringId === r.id).id, s.ops.find(o => !o.planned && o.label === r.label).id);
  add(fort, 2, 'expense', 18000, 'Alimentation', 'Courses');
  add(bcp, 2, 'expense', 7000, 'Mobilité et auto', 'Carburant');
  add(fort, 2, 'expense', 9000, 'Loisirs', 'Restaurant');
  add(bcp, 3, 'expense', 7000, 'Santé', 'Pharmacie');
  add(bcp, 3, 'refund', 3000, 'Santé', 'Remboursement mutuelle');
  add(fort, 3, 'expense', 2000, 'Abonnements', 'Streaming');
  add(bcp, 5, 'expense', 6000, 'Loisirs', 'Salle de sport', true);
  add(bcp, 10, 'expense', 15000, 'Mobilité et auto', 'Assurance auto', true);
  add(bcp, 15, 'expense', 9000, 'Logement', 'Électricité', true);
  add(fort, 20, 'expense', 20000, 'Alimentation', 'Courses fin de mois', true);
  addTransfer(s, bcp, fort, d(2), 20000, 'Virement BCP → Fortuneo');
  addTransfer(s, bcp, livret, d(3), 15000, 'Épargne mensuelle');
  // an unlinked pair, as an import would bring it, to demonstrate transfer detection
  add(bcp, 3, 'expense', 10000, null, 'VIR SEPA FORTUNEO');
  add(fort, 3, 'income', 10000, null, 'VIR RECU BCP');
  s.ops.push({ id: uid(), accountId: tr, date: new Date(Date.parse(today) - 60 * 864e5).toISOString().slice(0, 10), amount: 1250, kind: 'income', categoryId: null, label: 'Intérêts' });
  // fictional holdings and prices; the Apple quote is deliberately stale
  const ago = n => new Date(Date.parse(today) - n * 864e5).toISOString().slice(0, 10);
  saveInstrument(s, { isin: 'LU1681043599', name: 'Amundi MSCI World (CW8)', symbol: 'CW8.PAR', place: 'Euronext Paris', currency: 'EUR' });
  saveInstrument(s, { isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World', symbol: 'EUNL.DEX', place: 'Xetra', currency: 'EUR' });
  saveInstrument(s, { isin: 'US0378331005', name: 'Apple', symbol: 'AAPL', place: 'Nasdaq', currency: 'USD' });
  saveInstrument(s, { isin: 'FR0000120271', name: 'TotalEnergies', symbol: 'TTE.PAR', place: 'Euronext Paris', currency: 'EUR' });
  addHolding(s, tr, 'IE00B4L5Y983', '2025-01-15', 12, 110000);
  addHolding(s, ib, 'US0378331005', '2025-06-02', 3, 50000);
  addEnvelope(s, m, 10000, 'ETF du mois');
  buyFromEnvelope(s, s.envelopes[0].id, ib, d(3), 4000, 'CW8 (frais inclus)', 'LU1681043599', 0.0712);
  // 100 fictional daily closes: CW8 rising, iShares past its peak (trailing stop), TotalEnergies rising (buy candidate)
  const series = f => Array.from({ length: 100 }, (_, k) => [ago(99 - k), Math.round(f(k / 99) * 100) / 100]);
  setHistory(s, 'LU1681043599', series(x => 500 + 61.2 * x), 'démo (fictif)', today);
  setHistory(s, 'IE00B4L5Y983', series(x => (x < 0.7 ? 95 + (25 * x) / 0.7 : 120 - (15.5 * (x - 0.7)) / 0.3)), 'démo (fictif)', today);
  setHistory(s, 'FR0000120271', series(x => 50 + 8.3 * x), 'démo (fictif)', today);
  Object.assign(s.settings.profile, { horizon: 3, targets: { IE00B4L5Y983: 50, LU1681043599: 30, US0378331005: 20 } });
  addNews(s, 'FR0000120271', { title: 'Résultats trimestriels au-dessus des attentes (fictif)', url: 'https://example.com/demo-tte-1', source: 'démo (fictif)', publishedAt: ago(3), sentiment: 0.5 }, today);
  addNews(s, 'FR0000120271', { title: 'Hausse du dividende annoncée (fictif)', url: 'https://example.com/demo-tte-2', source: 'démo (fictif)', publishedAt: ago(5), sentiment: 0.4 }, today);
  setQuote(s, 'US0378331005', 268.3, ago(10), 'démo (fictif)');
  s.fx.USD = { rate: 1.1179, asOf: today, source: 'démo (fictif)', fetchedAt: today };
  addNews(s, 'LU1681043599', { title: 'Amundi annonce la fusion de deux ETF MSCI World (fictif)', url: 'https://example.com/demo-fusion', source: 'démo (fictif)', publishedAt: ago(2) }, today);
  addNews(s, 'IE00B4L5Y983', { title: 'Les ETF monde poursuivent leur collecte (fictif)', url: 'https://example.com/demo-collecte', source: 'démo (fictif)', publishedAt: ago(1) }, today);
  addNews(s, 'IE00B4L5Y983', { title: 'Baisse des frais sur une gamme d’ETF (fictif)', url: 'https://example.com/demo-frais', source: 'démo (fictif)', publishedAt: ago(12) }, today);
  return s;
}
