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
    instruments: [], quotes: {}, fx: {}, requestLog: [], peaks: {}, news: [], newsFetched: {}, history: {}, snapshots: {}, discovery: { date: null, items: {} }, notified: { verdicts: {}, sent: [] }, journal: [],
  };
}

// fee in cents per order, fxPct = conversion cost on non-EUR orders, targets = {isin: % of portfolio}
const defaultProfile = () => ({ style: 'long', horizon: 10, risk: 'equilibre', driftPts: 5, fee: 100, fxPct: 0.25, targets: {} });

export function validateState(x) {
  if (x?.version === 1 && x.settings) { // v1 → v2: market data (lot 2)
    Object.assign(x, { version: 2, instruments: [], quotes: {}, fx: {}, requestLog: [] });
    x.settings.market = { enabled: false, avKey: '' };
  }
  if (x?.version === 2 && x.settings) { // fields added with P03 and P02
    x.settings.profile ??= defaultProfile(); x.peaks ??= {}; x.news ??= []; x.newsFetched ??= {}; x.history ??= {}; x.snapshots ??= {}; x.discovery ??= { date: null, items: {} };
    x.settings.lowSpendable ??= 10000; x.notified ??= { verdicts: {}, sent: [] }; x.journal ??= [];
    // sales saved by v32-v35 did not reach the cash
    for (const o of x.ops ?? []) if (o.proceeds != null) { o.amount = o.proceeds; delete o.proceeds; }
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

// The n months ending with m, oldest first ('2026-11', 12 → '2025-12' … '2026-11').
export const monthsBack = (m, n) => Array.from({ length: n }, (_, k) => {
  const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 - (n - 1 - k), 1));
  return d.toISOString().slice(0, 7);
});

// Spending per category from month `from` to month `to` (inclusive), largest first, with each category's payments;
// refunds reduce their category, transfers and stock purchases are not spending.
export function spendingByCategory(s, from, to) {
  const real = s.ops.filter(o => !o.planned && monthOf(o.date) >= from && monthOf(o.date) <= to && (o.kind === 'expense' || o.kind === 'refund'));
  const known = new Set(s.categories.map(c => c.id));
  return [...s.categories, { id: null, name: 'Sans catégorie', cap: 0 }]
    .map(c => { const ops = real.filter(o => (known.has(o.categoryId) ? o.categoryId : null) === c.id); return { ...c, spent: spentOf(ops), ops }; })
    .filter(c => c.spent > 0).sort((a, b) => b.spent - a.spent);
}

export const monthlySpending = (s, to, n = 12) => monthsBack(to, n).map(m => ({ month: m, spent: monthStats(s, m).spent }));

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
  if (!id) { const o = { id: uid(), ...fields }; s.ops.push(o); if (o.planned) linkPaid(s, o); else autoMatch(s, o); return o; }
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

// A real operation that looks like a planned one settles it, so it is never counted twice: same month and
// direction, same account or category, amount within 10 % (at least 5 €). The closest amount wins.
// The same test also finds an item already counted as paid on its due date: the real payment then replaces it.
const GENERIC_WORDS = new Set(['prlv', 'sepa', 'prelevement', 'paiement', 'carte', 'virement', 'vir', 'facture', 'abonnement', 'echeance', 'mensualite', 'cotisation', 'achat', 'pour', 'les', 'des']);
const labelWords = t => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
  .filter(w => w.length > 2 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
// Same item only if the labels share a real word; without a label, the category has to say it. Amount alone proves nothing.
function sameItem(due, real) {
  const a = labelWords(due.label), b = new Set(labelWords(real.label));
  return a.length && b.size ? a.some(w => b.has(w)) : !!due.categoryId && due.categoryId === real.categoryId;
}
const pays = (due, real) => due.kind === real.kind && monthOf(due.date) === monthOf(real.date)
  && (due.accountId === real.accountId || (due.categoryId && due.categoryId === real.categoryId))
  && Math.abs(due.amount - real.amount) <= Math.max(500, Math.abs(due.amount) * 0.1) && sameItem(due, real);
const closest = (list, amount) => [...list].sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount))[0];

export function autoMatch(s, real) {
  if (real.planned || real.plannedId || real.autoPaid || !['income', 'expense', 'refund'].includes(real.kind)) return false;
  const taken = new Set(s.ops.map(o => o.plannedId).filter(Boolean));
  const p = closest(s.ops.filter(x => (x.planned || x.autoPaid) && x !== real && !taken.has(x.id) && pays(x, real)), real.amount);
  if (!p) return false;
  if (p.autoPaid) { p.planned = true; delete p.autoPaid; } // kept aside, not erased: it comes back if this payment is deleted
  real.plannedId = p.id;
  return true;
}
// The same link when the due item is entered after its payment.
function linkPaid(s, due) {
  const r = closest(s.ops.filter(o => !o.planned && !o.autoPaid && !o.plannedId && pays(due, o)), due.amount);
  if (r) r.plannedId = due.id;
}

// Upcoming items are taken as paid on their due date (direct debits, standing orders): no button to press.
// A payment entered or imported later for the same item replaces the automatic one (see autoMatch).
export function settleDue(s, today) {
  const taken = new Set(s.ops.map(o => o.plannedId).filter(Boolean));
  const due = s.ops.filter(o => o.planned && o.date <= today && !taken.has(o.id));
  for (const o of due) Object.assign(o, { planned: false, autoPaid: true });
  return due.length;
}

// shortcut: monthly recurrence only; yearly items (taxes) are entered as one-off planned ops.
export function generateRecurring(s, m) {
  const last = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
  let n = 0;
  for (const r of s.recurring) {
    if (s.ops.some(o => o.recurringId === r.id && monthOf(o.date) === m)) continue;
    const due = { id: uid(), accountId: r.accountId, date: `${m}-${String(Math.min(r.day, last)).padStart(2, '0')}`,
      amount: signed(r.kind, r.cents), kind: r.kind, categoryId: r.categoryId, label: r.label, planned: true, recurringId: r.id };
    s.ops.push(due); linkPaid(s, due);
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
  const idx = i.name.match(/MSCI [A-Z][\w ]*?(?= UCITS| ETF| \(|\)|$)|S&P ?500|NASDAQ[- ]?100|STOXX ?(Europe )?\d+|CAC ?40|DAX/i);
  return (idx ? idx[0] : i.name.replace(/\b(UN)?SPONS?\b.*$/i, '').replace(/\(.*?\)|\b(UCITS|ETF|Acc|Dist|SE|SA|Inc|Corp|PLC|ADR|ADS|GR)\b\.?/gi, '')).replace(/\s+/g, ' ').trim();
}

// Daily closes from the price provider: keeps the last 100 and makes the latest one the current quote.
export function setHistory(s, isin, points, source, today) {
  const inst = s.instruments.find(i => i.isin === isin);
  const h = points.filter(([d, p]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && p > 0).sort((a, b) => a[0].localeCompare(b[0])).slice(-260);
  if (!inst || !h.length) return false;
  s.history[isin] = h;
  const [asOf, price] = h.at(-1), hi = h.reduce((m, x) => (x[1] > m[1] ? x : m));
  s.quotes[isin] = { price, currency: inst.currency, asOf, source, fetchedAt: today };
  trackPeak(s, isin, hi[1], hi[0]);
  return true;
}

// Reinforcement scenario: buying `qty` at `price` (listing currency) plus fees → new average cost, new weight, and the
// line's gain or loss if the price then moves. Nothing is recorded.
export function simulate(s, today, isin, qty, price, feeCents = 0) {
  const lines = valuation(s, today), mine = lines.filter(l => l.isin === isin), inst = s.instruments.find(i => i.isin === isin);
  const rate = inst.currency === 'EUR' ? 1 : s.fx[inst.currency]?.rate;
  if (!rate) throw new Error(`Taux de change ${inst.currency} manquant : actualisez d’abord.`);
  if (!(qty > 0) || !(price > 0)) throw new Error('Quantité et prix doivent être positifs');
  const held = mine.reduce((a, l) => a + l.qty, 0), cost = mine.reduce((a, l) => a + l.cost, 0), now = mine.reduce((a, l) => a + (l.value ?? 0), 0);
  const total = lines.reduce((a, l) => a + (l.value ?? 0), 0), add = Math.round((qty * price * 100) / rate) + feeCents;
  const newQty = held + qty, newCost = cost + add;
  return { held, newQty, add, newCost, pru: newCost / newQty, weightBefore: total ? (now * 100) / total : 0, weightAfter: ((now + add) * 100) / (total + add),
    at: [-30, -20, -10, 10, 20].map(change => ({ change, gain: Math.round((newQty * price * (1 + change / 100) * 100) / rate) - newCost })) };
}

// Stress test: what the valued lines would lose if every price fell `drop` % and the dollar `usd` % against the euro.
// shortcut: same fall for every line (no sector or correlation model), a first look rather than a risk model
export const stressLoss = (s, today, drop, usd = 0) => valuation(s, today).filter(l => l.value != null)
  .reduce((a, l) => a + Math.round(l.value * (1 - (1 - drop / 100) * (l.inst.currency === 'USD' ? 1 - usd / 100 : 1))), 0);

// Technical indicators from the daily closes (up to one year); null when there are too few prices.
export function indicators(s, isin) {
  const c = (s.history[isin] ?? []).map(x => x[1]);
  if (c.length < 20) return null;
  const last = c.at(-1), avg = n => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const year = c.slice(-252), hi = Math.max(...year), lo = Math.min(...year);
  const rets = c.slice(-61).map((v, k, a) => (k ? Math.log(v / a[k - 1]) : 0)).slice(1), mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100; // annualised, last 3 months
  let up = 0, down = 0;
  for (let k = c.length - 14; k < c.length; k++) { const d = c[k] - c[k - 1]; if (d > 0) up += d; else down -= d; }
  // shortcut: RSI over 14 days with simple averages, not Wilder's smoothing — same reading, slightly noisier
  return { last, sma50: avg(50), sma200: avg(200), hi, lo, drawdown: (last / hi - 1) * 100, vol, rsi: down ? 100 - 100 / (1 + up / down) : 100, days: year.length };
}

export function trend(s, isin) {
  const h = s.history[isin];
  if (!h || h.length < 50) return null;
  const closes = h.map(x => x[1]), last = closes.at(-1);
  return { first: closes[0], sma50: closes.slice(-50).reduce((a, b) => a + b, 0) / 50, perf3m: (last / closes[Math.max(0, closes.length - 64)] - 1) * 100,
    high: Math.max(...closes), asOf: h.at(-1)[0] };
}

// Levels watched by the Worker while the app is closed, for held titles with a Yahoo listing: the profile's maximum loss,
// the trailing stop (horizon under 5 years) and, in active style, the take-profit and buy-back levels; plus any ±6 % day.
// Prices in the listing's currency; no quantity or amount leaves the phone.
export function watchList(s, today) {
  const p = s.settings.profile, risk = RISK[p.risk] ?? RISK.equilibre, lines = valuation(s, today), r2 = x => Math.round(x * 100) / 100, out = [];
  for (const i of s.instruments.filter(i => i.ysym)) {
    const mine = lines.filter(l => l.isin === i.isin && l.cost > 0);
    if (!mine.length) continue;
    const qty = mine.reduce((a, l) => a + l.qty, 0), cost = mine.reduce((a, l) => a + l.cost, 0);
    const rate = i.currency === 'EUR' ? 1 : s.fx[i.currency]?.rate, tr = trend(s, i.isin), rules = [];
    if (rate) rules.push({ below: r2((cost / qty / 100) * rate * (1 - risk.maxLoss / 100)), msg: `perte de ${risk.maxLoss} % atteinte, votre limite : à alléger ?` });
    const hi = Math.max(tr?.high ?? 0, s.peaks[i.isin]?.price ?? 0);
    if (p.horizon < 5 && hi) rules.push({ below: r2(hi * (1 - risk.trail / 100)), msg: `${risk.trail} % sous son plus haut (stop suiveur) : à alléger ?` });
    if (p.style === 'actif' && tr) {
      rules.push({ above: r2(tr.sma50 * 1.12), msg: 'forte hausse : prendre une partie des bénéfices ?' });
      if (tr.first < tr.sma50) rules.push({ below: r2(tr.sma50 * 0.93), msg: 'repli dans une tendance qui monte : occasion de racheter ?' });
    }
    out.push({ s: i.ysym, n: i.name, rules, move: 6 });
  }
  return out;
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

// A purchase made at the broker: the title is followed from its ISIN if new, the amount (fees included) leaves that account's cash.
export function addPurchase(s, { accountId, isin, name, date, qty, cents, advice }) {
  if (!s.accounts.some(a => a.id === accountId)) throw new Error('Choisissez le courtier');
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  const id = String(isin ?? '').trim().toUpperCase();
  if (!s.instruments.some(i => i.isin === id)) saveInstrument(s, { isin: id, name, currency: 'EUR' }); // the real currency comes with the first price
  checkTrade(s, id, qty);
  const i = s.instruments.find(x => x.isin === id);
  s.ops.push({ id: uid(), accountId, date, amount: -cents, kind: 'invest', isin: id, qty, label: `Achat ${i.name}`, seq: stamp(s), ...(advice && { advice }) });
  return id;
}

// A position recorded on the wrong account (e.g. the CTO instead of the PEA) moves with its whole history.
export function moveHolding(s, isin, fromId, toId) {
  if (fromId === toId || !s.accounts.some(a => a.id === toId)) throw new Error('Choisissez un autre compte');
  const sn = s.snapshots?.[fromId], line = sn?.lines.find(l => l.isin === isin);
  if (line) { // the imported line becomes a holding on the new account, counted whatever that account's own import date
    sn.lines = sn.lines.filter(l => l !== line);
    s.ops.push({ id: uid(), accountId: toId, date: sn.date, amount: 0, cost: line.cost, kind: 'invest', isin, qty: line.qty, label: 'Position transférée', seq: stamp(s) });
  }
  for (const o of s.ops.filter(o => o.accountId === fromId && o.isin === isin)) Object.assign(o, { accountId: toId, seq: stamp(s) });
}

// Records a sale already done at the broker: the money received lands in that account's cash, not in the household budget.
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
  s.journal = (s.journal ?? []).filter(d => d.isin !== isin);
  delete s.settings.profile.targets[isin];
  s.news = s.news.filter(n => n.isin !== isin);
  if (s.discovery?.items) delete s.discovery.items[isin];
}

// Increasing number telling whether a trade was recorded before or after the last broker snapshot import.
const stamp = s => (s.seq = (s.seq ?? 0) + 1);

// Average-cost positions per account and instrument; cost in cents, fees included.
// An account with a broker snapshot starts from it: only its trades dated after the snapshot are added.
// A split multiplies the quantity and leaves the total cost unchanged; a sale books its realized gain against average cost.
// `until`: the book as it stood that day (an import only counts from its own date)
function book(s, until) {
  const snaps = Object.fromEntries(Object.entries(s.snapshots ?? {}).filter(([, sn]) => !until || sn.date <= until)), map = new Map();
  for (const [accountId, sn] of Object.entries(snaps)) for (const l of sn.lines) map.set(`${accountId}|${l.isin}`, { accountId, isin: l.isin, qty: l.qty, cost: l.cost, realized: 0 });
  const counted = o => {
    const sn = snaps[o.accountId];
    return o.kind === 'invest' && o.isin && (o.qty || o.split) && (!until || o.date <= until) && (!sn || o.date > sn.date || (o.seq ?? 0) > (sn.seq ?? 0)); // recorded after the import: not in it
  };
  for (const o of s.ops.filter(counted).sort((a, b) => a.date.localeCompare(b.date))) {
    const k = `${o.accountId}|${o.isin}`, p = map.get(k) ?? { accountId: o.accountId, isin: o.isin, qty: 0, cost: 0, realized: 0 };
    if (o.split) p.qty = Math.round(p.qty * o.split * 1e6) / 1e6;
    else {
      if (o.qty > 0) p.cost += o.cost ?? -o.amount;
      else { const out = p.qty > 0 ? Math.round((p.cost * -o.qty) / p.qty) : 0; p.cost -= out; p.realized += o.amount - out; }
      p.qty = Math.round((p.qty + o.qty) * 1e6) / 1e6;
    }
    map.set(k, p);
  }
  return [...map.values()];
}
export const positions = s => book(s).filter(p => p.qty > 0).map(({ accountId, isin, qty, cost }) => ({ accountId, isin, qty, cost }));
// Wealth at the end of each month: cash from the movements, titles at that day's close (at cost without a close).
// shortcut: foreign titles use today's exchange rate, and titles imported from a statement only appear from its date.
export function wealthSeries(s, months, today) {
  return months.map(m => {
    const end = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10), d = end < today ? end : today;
    const cash = sum(s.accounts, a => a.opening) + sum(s.ops.filter(o => !o.planned && o.date <= d), o => o.amount);
    const securities = d === today ? sum(valuation(s, today), l => l.value ?? l.cost) : sum(book(s, d).filter(p => p.qty > 0), p => { // today: same figure as the accounts
      const i = s.instruments.find(x => x.isin === p.isin), close = (s.history[p.isin] ?? []).filter(([t]) => t <= d).at(-1)?.[1];
      const rate = i?.currency === 'EUR' ? 1 : s.fx[i?.currency]?.rate;
      return close && rate ? Math.round((p.qty * close * 100) / rate) : p.cost;
    });
    return { month: m, cash, securities, total: cash + securities };
  });
}
// Each line's plan: its last purchase and the advice behind it, how it did since, and the levels where a rule acts.
export function linePlan(s, today, isin) {
  const p = s.settings.profile, r = RISK[p.risk], tr = trend(s, isin), hi = Math.max(tr?.high ?? 0, s.peaks[isin]?.price ?? 0);
  return valuation(s, today).filter(l => l.isin === isin).map(l => {
    const last = s.ops.filter(o => o.accountId === l.accountId && o.isin === isin && o.qty > 0 && !['Position existante', 'Position transférée'].includes(o.label))
      .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const paid = last ? (last.cost ?? -last.amount) / last.qty : null, unit = l.value != null ? l.value / l.qty : null, pru = l.cost / l.qty;
    return { accountId: l.accountId, last: last ? { date: last.date, perPart: Math.round(paid), advice: last.advice ?? null } : null, pru: Math.round(pru),
      sinceBuy: paid && unit ? ((unit - paid) * 100) / paid : null, lossAt: Math.round(pru * (1 - r.maxLoss / 100)),
      trailAt: p.horizon < 5 && hi ? Math.round(hi * (1 - r.trail / 100) * 100) / 100 : null };
  });
}
// What the titles earned (value + sales − money put in, dividends aside), and the same money at the same dates in a world ETF.
const BENCH = ['LU1681043599', 'IE00B4L5Y983'];
export function strategyReport(s, today) {
  const snaps = s.snapshots ?? {}, flows = [];
  for (const sn of Object.values(snaps)) for (const l of sn.lines) flows.push({ date: sn.date, cents: l.cost });
  for (const o of s.ops) {
    if (o.kind !== 'invest' || !o.isin || !o.qty || o.split) continue;
    const sn = snaps[o.accountId];
    if (sn && !(o.date > sn.date || (o.seq ?? 0) > (sn.seq ?? 0))) continue; // already inside the imported statement
    flows.push({ date: o.date, cents: o.qty > 0 ? (o.cost ?? -o.amount) : -o.amount });
  }
  const invested = sum(flows.filter(f => f.cents > 0), f => f.cents), back = -sum(flows.filter(f => f.cents < 0), f => f.cents);
  const value = sum(valuation(s, today), l => l.value ?? l.cost), gain = value + back - invested;
  const bi = BENCH.find(isin => s.history[isin]?.length > 1 && s.instruments.find(i => i.isin === isin)?.currency === 'EUR');
  let bench = null;
  if (bi && invested) {
    // shortcut: a flow older than the ETF's known prices uses its first price, flagged as « early »
    const h = s.history[bi], at = d => (h.filter(([t]) => t <= d).at(-1) ?? h[0])[1];
    const now = Math.round(flows.reduce((u, f) => u + f.cents / at(f.date), 0) * h.at(-1)[1]);
    bench = { name: s.instruments.find(i => i.isin === bi).name, value: now, gain: now + back - invested, from: h[0][0], early: flows.some(f => f.date < h[0][0]) };
  }
  return { invested, back, value, gain, bench };
}
export const realizedGain = (s, isin) => book(s).filter(p => p.isin === isin).reduce((a, p) => a + p.realized, 0);

// Decision journal: what I decided, why, at what price and what the tool said; reviewed later against the current price.
export const DECISIONS = { achat: '🟢 J’achète', vente: '🔴 Je vends', attente: '⏸️ J’attends', passe: '🙅 Je laisse passer' };
export function addDecision(s, today, isin, action, note = '', verdict = null) {
  if (!DECISIONS[action]) throw new Error('Décision inconnue');
  const q = s.quotes[isin];
  const d = { id: uid(), date: today, isin, action, note: note.trim(), price: q?.price ?? null, verdict };
  (s.journal ??= []).push(d);
  return d;
}
// Automatic journal: each new buy or sell advice of the tool is kept with its price, then checked against later prices.
const SIDE = { Acheter: 'achat', Renforcer: 'achat', Alléger: 'vente', Vendre: 'vente' };
export function logVerdicts(s, today) {
  for (const x of suggestions(s, today)) {
    // first day of the current verdict: a buy is only advised once it held since the day before
    if (!x.suspended && (s.signalSince ??= {})[x.isin]?.action !== x.action) s.signalSince[x.isin] = { action: x.action, date: today };
    if (x.suspended || !SIDE[x.action] || !s.quotes[x.isin]) continue;
    const last = (s.journal ?? []).filter(d => d.isin === x.isin).at(-1);
    if (last?.verdict !== x.action) addDecision(s, today, x.isin, SIDE[x.action], '', x.action);
  }
}
export const deleteDecision = (s, id) => { s.journal = s.journal.filter(d => d.id !== id); };
// change since the decision, and whether it went the way the decision bet on (buying wanted a rise, selling or skipping a fall)
export const journalReview = s => (s.journal ?? []).map(d => {
  const now = s.quotes[d.isin]?.price, change = d.price && now ? ((now - d.price) * 100) / d.price : null;
  const right = change == null || d.action === 'attente' || Math.abs(change) < 2 ? null : (d.action === 'achat') === (change > 0);
  return { ...d, now: now ?? null, change, right };
}).sort((a, b) => b.date.localeCompare(a.date));
// Cash typed by hand from the bank's screen: the gap becomes one movement, so the account shows exactly that amount.
// kind 'invest' keeps it out of the household budget.
export function setCash(s, accountId, date, cents) {
  const a = s.accounts.find(x => x.id === accountId);
  if (!a || !Number.isFinite(cents)) throw new Error('Montant invalide');
  const gap = cents - balance(s, a);
  if (gap) s.ops.push({ id: uid(), accountId, date, amount: gap, kind: 'invest', categoryId: null, label: 'Mise à jour des espèces' });
  return gap;
}
export function addSplit(s, accountId, isin, date, ratio) {
  if (!(ratio > 0) || ratio === 1) throw new Error('Ratio invalide : pour une division « 10 pour 1 », indiquez 10');
  if (!positions(s).some(p => p.accountId === accountId && p.isin === isin)) throw new Error('Aucune position sur ce compte');
  s.ops.push({ id: uid(), accountId, date, amount: 0, kind: 'invest', isin, qty: 0, split: ratio, label: `Division ${String(ratio).replace('.', ',')} pour 1`, seq: stamp(s) });
}

// shortcut: weekends only, exchange holidays ignored — a quote may look stale one day too early.
const businessDaysAfter = (from, to) => {
  let n = 0;
  for (let d = dayNum(from) + 1; d <= dayNum(to); d++) { const w = new Date(d * 864e5).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
};
// the previous trading day's close is still current
export const isStale = (asOf, today) => !asOf || businessDaysAfter(asOf, today) > 1;

// What the broker shows: cash plus the securities at the latest price (a line without a usable price is left out).
export function accountTotal(s, a, today) {
  // a title without a usable price yet counts at what it cost, so a purchase shows on its account at once
  const cash = balance(s, a), securities = valuation(s, today).filter(l => l.accountId === a.id).reduce((n, l) => n + (l.value ?? l.cost), 0);
  return { cash, securities, total: cash + securities };
}
export function valuation(s, today) {
  return positions(s).map(p => {
    const inst = s.instruments.find(i => i.isin === p.isin) ?? { isin: p.isin, name: p.isin, currency: 'EUR' };
    const q = s.quotes[p.isin]?.currency === inst.currency ? s.quotes[p.isin] : null;
    const fx = inst.currency === 'EUR' ? null : s.fx[inst.currency] ?? null;
    const raw = q && (fx || inst.currency === 'EUR') ? Math.round((p.qty * q.price * 100) / (fx?.rate ?? 1)) : null;
    // a price that makes the line worth under a third or over three times what was paid is far more likely
    // a wrong listing (other exchange, other currency) than a real move: it is set aside rather than shown
    const suspect = raw != null && p.cost > 0 && (raw < p.cost * 0.35 || raw > p.cost * 3);
    const value = suspect ? null : raw;
    return { ...p, inst, quote: q, fx, value, suspect, gain: value == null ? null : value - p.cost,
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
// shortcut: PEA eligibility guessed — European company (ISIN country), or a fund with « PEA » in its name or a French or
// Luxembourg ISIN (Irish-domiciled ETFs are generally not eligible); the broker has the final word
const EEA = 'FR DE NL BE IT ES PT LU AT FI DK SE NO IS LI GR CY MT SI SK EE LV LT PL CZ HU RO BG HR'.split(' ');
export const peaEligible = i => /\bPEA\b/i.test(i.name) || EEA.includes(i.isin.slice(0, 2));

// shortcut: usual small-order fees per broker (fixed € per order in cents, % of the amount, % currency conversion), used
// only when the user left them empty; indicative, the broker's own price list is the reference
const BROKER_FEES = [
  [/trade ?republic/i, { name: 'Trade Republic', fixed: 100, pct: 0, fx: 0 }],
  [/ibkr|interactive/i, { name: 'IBKR', fixed: 300, pct: 0, fx: 0.03 }],
  [/fortuneo/i, { name: 'Fortuneo', fixed: 195, pct: 0, fx: 0.25 }],
];
export const brokerFees = institution => BROKER_FEES.find(([re]) => re.test(institution ?? ''))?.[1] ?? null;

export const DISCLAIMER = 'Information, pas un conseil en investissement. Aucun ordre n’est passé.';
const euro = c => `${(c / 100).toFixed(2).replace('.', ',')} €`;
const pct = x => `${x.toFixed(1).replace('.', ',')} %`;

const parts = q => `${String(q).replace('.', ',')} part${q > 1 ? 's' : ''}`;
const SALE_PAUSE = 30, dayMonth = d => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

// Broad index funds, judged by the same rules as any idea. Added once: one you stop following stays gone.
const ETF_CANDIDATES = [['LU1681043599', 'Amundi MSCI World (CW8)'], ['FR0011871128', 'Amundi PEA S&P 500 (PSP5)'],
  ['LU0908500753', 'Amundi Stoxx Europe 600 (MEUD)'], ['FR0013412020', 'Amundi PEA MSCI Emerging Markets (PAEEM)']];
export function seedEtfs(s) {
  if (s.etfSeeded) return;
  s.etfSeeded = true;
  for (const [isin, name] of ETF_CANDIDATES) if (!s.instruments.some(i => i.isin === isin)) saveInstrument(s, { isin, name, currency: 'EUR', type: 'ETF' });
}

// The strategy in force, written from the profile: every decision of `suggestions` names one of these rules.
export function strategyRules(s) {
  const p = s.settings.profile, r = RISK[p.risk], active = p.style === 'actif', targets = Object.values(p.targets).some(t => t > 0);
  return [
    { n: 1, title: 'Données fiables', text: 'Sans cours récent ou sans taux de change à jour : pas d’avis, aucune opération.' },
    { n: 2, title: 'Part visée', text: targets ? `Chaque titre revient vers sa part visée, à ${p.driftPts} points près. Trop haut : vendre l’excédent. Trop bas : acheter jusqu’à la cible.` : 'Inactive : aucune part visée dans votre profil.' },
    { n: 3, title: 'Limite par ligne', text: p.maxWeight ? `Une ligne ne dépasse pas ${p.maxWeight} % du portefeuille : au-delà, aucun renforcement.` : 'Inactive : pas de limite dans votre profil.' },
    { n: 4, title: 'Perte maximale', text: `Perte de ${r.maxLoss} % ou plus sur une ligne (profil ${r.label}) : vendre la moitié.` },
    { n: 5, title: 'Stop suiveur', text: p.horizon < 5 ? `Une ligne en gain qui recule de ${r.trail} % depuis son plus haut : vendre la moitié.` : `Inactive : horizon de ${p.horizon} ans (elle joue sous 5 ans).` },
    { n: 6, title: 'Bénéfices et rachats', text: active ? 'Cours à 12 % ou plus au-dessus de sa moyenne 50 jours, avec un gain : vendre un tiers. Repli de 7 % sous cette moyenne dans une tendance haussière : acheter.' : 'Inactive : style long terme.' },
    { n: 7, title: 'Signaux de marché', text: 'Tendance, variation sur 3 mois et ton des actualités s’additionnent aux points des autres règles. Total de 2 ou plus (1,5 pour un ETF, qui n’a pas d’actualités propres) : acheter. De −2 ou moins : vendre un tiers. De −3 ou moins : tout vendre. Sinon : aucune opération. Un achat n’est conseillé que si son signal tient depuis la veille.' },
    { n: 8, title: 'Actualité importante', text: 'Fusion, radiation, fermeture… : aucune opération avant d’avoir lu l’article.' },
    { n: 9, title: 'Argent des achats', text: 'Montant d’un achat : jusqu’à la part visée s’il y en a une ; sinon un tiers de la ligne, ou un tiers d’une ligne moyenne pour un nouveau titre. L’enveloppe du mois va au meilleur signal, les autres se partagent les espèces du compte-titres ou du PEA. Les livrets ne sont jamais utilisés.' },
    { n: 10, title: 'Pause après une opération', text: `Après une vente sur une ligne, les règles 4, 5, 6 et la vente d’un tiers (règle 7) ne se déclenchent plus pendant ${SALE_PAUSE} jours. Après un achat, pas de nouveau renforcement pendant ${SALE_PAUSE} jours. Sinon, la même règle revendrait ou rachèterait une partie à chaque fois.` },
  ];
}

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
    const add = (pts, text, asOf, source, rule) => reasons.push({ pts, text, asOf, source, rule });
    const none = (rule, text) => ({ side: null, qty: 0, rule, text });
    const base = { isin: i.isin, name: i.name, held: isHeld, reasons };
    const fxOk = i.currency === 'EUR' || !isStale(s.fx[i.currency]?.asOf, today);
    // a missing or stale price suspends the verdict instead of guessing
    const odd = lines.find(l => l.isin === i.isin && l.suspect);
    if (!q || q.currency !== i.currency || isStale(q.asOf, today) || !fxOk || odd) {
      add(0, !q ? 'Aucun cours : actualisez ou saisissez-le.' : !fxOk ? `Taux de change ${i.currency} absent ou périmé.`
        : odd ? `Cours à vérifier : ${q.price} ${q.currency} donnerait une ligne sans rapport avec les ${euro(odd.cost)} investis (mauvaise cotation ?).`
          : `Cours du ${q.asOf} non à jour.`, q?.asOf, q?.source, 1);
      return { ...base, action: 'Suspendu', score: 0, suspended: true, order: none(1, 'Aucune opération tant que le cours n’est pas à jour.') };
    }
    const t = p.targets[i.isin] ?? 0, own = lines.filter(l => l.isin === i.isin), cuts = [], allValue = byIsin[i.isin] ?? 0;
    // what brings the title back to c % of the portfolio, the money going to the others
    const backTo = c => (allValue ? Math.min(1, (allValue - (c * total) / 100) / allValue) : 0);
    if (hasTargets && (t > 0 || isHeld)) {
      if (blocked.length) add(0, `Allocation non calculée : cours manquant ou périmé pour ${blocked.join(', ')}.`, undefined, undefined, 1);
      else {
        const w = weight(i.isin), gap = t - w, far = Math.abs(gap);
        const pts = far < p.driftPts ? 0 : Math.sign(gap) * (far >= 2 * p.driftPts ? 2 : 1);
        add(pts, `Poids ${pct(w)} pour une cible de ${pct(t)}${pts ? ` : ${pts > 0 ? 'sous' : 'sur'}-pondéré de ${far.toFixed(1).replace('.', ',')} points` : ', dans la tolérance'}.`, undefined, undefined, 2);
        if (pts < 0 && t > 0) cuts.push({ rule: 2, share: backTo(t), ls: own });
      }
    }
    const tr = trend(s, i.isin), active = p.style === 'actif';
    let takeProfit = 0;
    if (tr) {
      const gap = (q.price / tr.sma50 - 1) * 100, longUp = tr.first < tr.sma50;
      // active style: a dip inside a rising trend is a chance to buy back, instead of a sell signal
      if (active && gap <= -7 && longUp) add(2, `Repli de ${pct(-gap)} sous sa moyenne 50 jours alors que la tendance de fond monte : occasion de (r)acheter.`, tr.asOf, q.source, 6);
      else {
        const up = q.price >= tr.sma50;
        add(up ? 1 : -1, `Cours ${up ? 'au-dessus' : 'en dessous'} de sa moyenne 50 jours (${tr.sma50.toFixed(2).replace('.', ',')} ${i.currency}).`, tr.asOf, q.source, 7);
        if (tr.perf3m >= 5 || tr.perf3m <= -10) add(tr.perf3m > 0 ? 0.5 : -0.5, `${tr.perf3m > 0 ? '+' : ''}${pct(tr.perf3m)} sur 3 mois.`, tr.asOf, q.source, 7);
      }
      if (active && isHeld && gap >= 12) takeProfit = gap;
    } else add(0, 'Tendance inconnue : historique insuffisant (actualisez en ligne).');
    const recent = s.news.filter(n => n.isin === i.isin && dayNum(today) - dayNum(n.publishedAt) <= 14);
    const tones = recent.map(n => n.sentiment).filter(Number.isFinite);
    if (tones.length >= 2) {
      const avg = tones.reduce((a, b) => a + b, 0) / tones.length;
      add(avg > 0.2 ? 1 : avg < -0.2 ? -1 : 0, `Ton des actualités ${avg > 0.2 ? 'positif' : avg < -0.2 ? 'négatif' : 'neutre'} (${tones.length} articles sur 14 jours).`, recent[0].publishedAt, 'Marketaux', 7);
    } else if (!recent.length && !s.discovery?.items?.[i.isin]) add(0, 'Aucune actualité récente.');
    const found = s.discovery?.items?.[i.isin];
    if (found) add(found.tone >= 0.2 ? 1 : 0, `Repéré par l’outil : ${found.docs} articles cette semaine, ton ${found.tone >= 0.2 ? 'positif' : 'plutôt neutre'} (${found.tone.toFixed(2).replace('.', ',')}).`, found.asOf, 'Marketaux', 7);
    const notable = recent.filter(n => NOTABLE.test(n.title));
    for (const n of notable) add(0, `À lire avant de décider : « ${n.title} »`, n.publishedAt, n.source, 8);
    let limitHit = false;
    const mine = lines.filter(l => l.isin === i.isin && l.cost > 0), gainAll = mine.reduce((a, l) => a + l.gain, 0);
    const lastSale = l => s.ops.filter(o => o.accountId === l.accountId && o.isin === i.isin && o.qty < 0 && dayNum(today) - dayNum(o.date) < SALE_PAUSE).map(o => o.date).sort().at(-1);
    const cooled = own.length > 0 && own.every(lastSale);
    const resume = cooled ? new Date(Date.parse(own.map(lastSale).sort().at(-1)) + SALE_PAUSE * 864e5).toISOString().slice(0, 10) : null;
    if (cooled) add(0, `Ligne déjà allégée : pas de nouvelle vente partielle avant le ${dayMonth(resume)}.`, undefined, undefined, 10);
    const lastBuy = l => s.ops.filter(o => o.accountId === l.accountId && o.isin === i.isin && o.qty > 0 && !['Position existante', 'Position transférée'].includes(o.label)
      && dayNum(today) - dayNum(o.date) < SALE_PAUSE).map(o => o.date).sort().at(-1);
    const bought = own.map(lastBuy).filter(Boolean).sort().at(-1), buyResume = bought && new Date(Date.parse(bought) + SALE_PAUSE * 864e5).toISOString().slice(0, 10);
    if (bought) add(0, `Ligne renforcée le ${dayMonth(bought)} : pas de nouvel achat avant le ${dayMonth(buyResume)}.`, undefined, undefined, 10);
    if (takeProfit && gainAll > 0 && !cooled) { // active style: sell part of a strong rise, buy back later on a dip
      limitHit = true;
      const pea = mine.every(l => s.accounts.find(a => a.id === l.accountId)?.type === 'PEA');
      add(-2, `Forte hausse : ${pct(takeProfit)} au-dessus de sa moyenne 50 jours, avec ${euro(gainAll)} de plus-value : prendre une partie des bénéfices (vendre environ un tiers).`
        + (pea ? ' Sur un PEA, la vente n’est pas imposée tant que l’argent reste dedans.' : ' Sur un compte-titres, le gain réalisé est imposable.'), undefined, undefined, 6);
      cuts.push({ rule: 6, share: 1 / 3, ls: own });
    }
    for (const l of mine) {
      if (lastSale(l)) continue;
      const gain = ((l.value - l.cost) * 100) / l.cost, hi = Math.max(tr?.high ?? 0, s.peaks[i.isin]?.price ?? 0);
      const drop = hi ? ((hi - q.price) * 100) / hi : 0;
      if (gain <= -risk.maxLoss) { limitHit = true; cuts.push({ rule: 4, share: 0.5, ls: [l] }); add(-2, `Moins-value de ${pct(-gain)}, au-delà de votre perte maximale de ${risk.maxLoss} % (profil ${risk.label}).`, undefined, undefined, 4); }
      else if (p.horizon < 5 && gain > 0 && drop >= risk.trail) {
        limitHit = true;
        cuts.push({ rule: 5, share: 0.5, ls: [l] });
        add(-2, `${pct(drop)} sous son plus haut (${hi.toFixed(2).replace('.', ',')} ${i.currency}) avec ${pct(gain)} de plus-value : stop suiveur de ${risk.trail} % (horizon ${p.horizon} ans).`, undefined, undefined, 5);
      }
    }
    // concentration limit per line: above it, never « Renforcer », whatever the other signals say
    const overCap = isHeld && p.maxWeight > 0 && !blocked.length && weight(i.isin) >= p.maxWeight;
    if (overCap) add(0, `Poids ${pct(weight(i.isin))} : au-delà de votre limite de ${p.maxWeight} % par ligne, pas de renforcement.`, undefined, undefined, 3);
    const score = Math.round(reasons.reduce((a, r) => a + r.pts, 0) * 10) / 10;
    // a risk limit of the profile always leads to reducing the line, whatever the other signals say
    const buyAt = /\b(ETF|UCITS)\b/i.test(`${i.type ?? ''} ${i.name}`) ? 1.5 : 2;
    const action = notable.length ? 'À examiner'
      : isHeld ? (score <= -3 ? 'Vendre' : limitHit || (score <= -2 && !cooled) ? 'Alléger' : score >= buyAt && !overCap && !bought ? 'Renforcer' : 'Conserver')
        : score >= buyAt ? 'Acheter' : 'Attendre';
    // everything the verdict merged, in one sentence
    const toneAvg = tones.length >= 2 ? tones.reduce((a, b) => a + b, 0) / tones.length : null, alloc = reasons.find(r => r.rule === 2);
    const facts = [!tr ? 'tendance inconnue' : q.price >= tr.sma50 ? 'tendance haussière' : 'tendance baissière',
      notable.length ? 'actualité importante à lire' : toneAvg != null ? `actualités ${toneAvg > 0.2 ? 'positives' : toneAvg < -0.2 ? 'négatives' : 'neutres'}` : recent.length ? `${recent.length} actualité(s) sans ton mesuré` : 'pas d’actualité récente',
      cuts.some(c => c.rule === 4 || c.rule === 5) ? 'limite de risque atteinte' : cuts.some(c => c.rule === 6) ? 'forte hausse à encaisser' : cooled ? 'ligne déjà allégée' : isHeld ? 'risque dans vos limites' : null,
      overCap ? 'ligne au-delà de votre limite' : alloc && t > 0 ? (alloc.pts > 0 ? 'sous sa part visée' : alloc.pts < 0 ? 'au-dessus de sa part visée' : 'à sa part visée') : null].filter(Boolean).join(', ');
    // the conclusion's frame: what it still lacks, what would overturn it, and how much data stands behind it
    const ind = indicators(s, i.isin), level = ind?.sma200 ?? ind?.sma50, two = v => v.toFixed(2).replace('.', ',');
    const missing = [!ind?.sma200 && 'Moins d’un an de cours : moyenne 200 jours indisponible.', !recent.length && 'Aucune actualité récente analysée.',
      'Fondamentaux (chiffre d’affaires, résultats, valorisation) non analysés : pas de source gratuite fiable.'].filter(Boolean);
    const invalidation = !level ? null : ['Vendre', 'Alléger'].includes(action)
      ? `Revoir si le cours repasse au-dessus de ${two(ind.sma50 ?? level)} ${i.currency} (moyenne 50 jours).`
      : `Revoir si le cours passe sous ${two(level)} ${i.currency} (moyenne ${ind.sma200 ? 200 : 50} jours)${notable.length ? ' ou après lecture de l’actualité signalée' : ''}.`;
    const confidence = ind?.sma200 && tones.length >= 2 ? 'Élevée' : ind?.sma50 ? 'Moyenne' : 'Faible';
    const worst = [...reasons].filter(r => r.pts < 0).sort((a, b) => a.pts - b.pts)[0]?.rule ?? 7;
    let order = overCap ? none(3, 'Aucun achat : la ligne dépasse votre limite. Aucune vente demandée.') : none(7, 'Aucune opération : ni signal d’achat ni signal de vente.');
    if (cooled && action === 'Conserver') order = none(10, `Aucune vente pour l’instant : ligne déjà allégée, prochaine révision le ${dayMonth(resume)}.`);
    if (bought && action === 'Conserver' && score >= buyAt) order = none(10, `Aucun renfort pour l’instant : ligne renforcée le ${dayMonth(bought)}, prochaine révision le ${dayMonth(buyResume)}.`);
    if (action === 'À examiner') order = none(8, 'Aucune opération avant d’avoir lu l’actualité signalée.');
    if (action === 'Vendre' || action === 'Alléger') {
      if (overCap && action === 'Alléger') cuts.push({ rule: 3, share: backTo(p.maxWeight), ls: own });
      // the strongest rule triggered sets the size; a signal alone sells a third
      const cut = action === 'Vendre' ? { rule: 7, share: 1, ls: own } : [...cuts].sort((a, b) => b.share - a.share)[0] ?? { rule: worst, share: 1 / 3, ls: own };
      const sells = cut.ls.map(l => {
        const a = s.accounts.find(x => x.id === l.accountId), x = l.qty * cut.share;
        const qty = cut.share === 1 ? l.qty : Math.min(l.qty, a?.fractional || !Number.isInteger(l.qty) ? Math.floor(x * 1000) / 1000 : Math.ceil(x - 1e-9));
        return { accountId: l.accountId, name: a?.name ?? '?', qty, amount: Math.round((l.value * qty) / l.qty) };
      }).filter(x => x.qty > 0);
      order = { side: 'vente', sells, qty: sells.reduce((n, x) => n + x.qty, 0), amount: sells.reduce((n, x) => n + x.amount, 0), rule: cut.rule,
        text: sells.map(x => `Vendre ${cut.share === 1 ? `les ${parts(x.qty)}` : parts(x.qty)} sur ${x.name} (≈ ${euro(x.amount)})`).join(' et ') };
    }
    return { ...base, action, score, missing, invalidation, confidence, order, facts };
  });

  // this month's envelope goes to the strongest buy signal, within the remaining amount and the broker's cash
  const left = s.envelopes.filter(e => e.month === monthOf(today)).reduce((a, e) => a + envelopeLeft(s, e), 0);
  const signals = out.filter(x => x.action === 'Acheter' || x.action === 'Renforcer').sort((a, b) => b.score - a.score);
  const spare = Object.fromEntries(s.accounts.map(a => [a.id, Math.max(0, balance(s, a))]));
  signals.forEach((pick, k) => {
    const env = k === 0 && left > 0, src = env ? 'Enveloppe du mois' : 'Espèces du compte';
    const rule = [...pick.reasons].filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts)[0]?.rule ?? 7;
    const i = s.instruments.find(x => x.isin === pick.isin), line = lines.find(l => l.isin === pick.isin);
    // a held title is topped up where it is held; a new one goes to any brokerage account allowed to hold it
    const accounts = (line ? [s.accounts.find(a => a.id === line.accountId)]
      : s.accounts.filter(a => s.snapshots?.[a.id] || ['PEA', 'CTO'].includes(a.type) || s.ops.some(o => o.kind === 'invest' && o.accountId === a.id)))
      .filter(a => a.type !== 'PEA' || peaEligible(i));
    const price = s.quotes[i.isin].price, rate = i.currency === 'EUR' ? 1 : s.fx[i.currency].rate;
    // each broker's own fees (fixed per order, % of the amount, currency conversion), else the profile's estimate
    const plan = a => {
      const est = brokerFees(a.institution) ?? {};
      const fixed = a.feeFixed ?? est.fixed ?? p.fee, rest = (1 + (a.feePct ?? est.pct ?? 0) / 100) * (1 + (i.currency === 'EUR' ? 0 : (a.fxPct ?? est.fx ?? p.fxPct) / 100));
      const raw = (price * 100 * rest) / rate, unit = Math.ceil(Math.round(raw * 1e6) / 1e6); // drop float noise (561.2 * 100 = 56120.000000001)
      // the broker's cash limits the purchase only when the app knows it (some movement recorded or an opening balance)
      const known = a.opening !== 0 || s.ops.some(o => o.accountId === a.id && o.amount !== 0), cash = balance(s, a);
      // never buy so much that the line would pass the concentration limit
      const room = p.maxWeight > 0 && p.maxWeight < 100 && total ? Math.floor(((p.maxWeight * total) / 100 - (byIsin[i.isin] ?? 0)) / (1 - p.maxWeight / 100)) : Infinity;
      const pool = env ? (known ? Math.min(left, spare[a.id]) : left) : known ? Math.floor(spare[a.id] / (signals.length - k)) : 0;
      const aim = p.targets[i.isin] ?? 0, toTarget = !env && aim > 0 && aim < 100 && total ? Math.max(0, Math.round(((aim * total) / 100 - (byIsin[i.isin] ?? 0)) / (1 - aim / 100))) : Infinity; // new money also grows the total
      const titles = Object.keys(byIsin).length, sized = env ? Infinity : toTarget < Infinity ? toTarget : line ? Math.round((byIsin[i.isin] ?? 0) / 3) : titles ? Math.round(total / titles / 3) : Infinity;
      const limit = Math.max(0, Math.min(pool, room, sized)), wanted = Math.min(room, sized);
      // what the rule asks for, whatever the cash: shown even when the money is not there yet
      const wantQty = wanted === Infinity || wanted <= 0 ? 0 : a.fractional ? Math.max(0, Math.floor(((wanted - fixed) / raw) * 1000) / 1000) : Math.max(room >= unit ? 1 : 0, Math.floor((wanted - fixed) / unit));
      const qty = a.fractional ? Math.max(0, Math.floor(((limit - fixed) / raw) * 1000) / 1000) : Math.max(0, Math.floor((limit - fixed) / unit));
      const spend = qty ? (a.fractional ? Math.round(qty * raw) : qty * unit) + fixed : 0;
      return { a, limit, qty, unit, total: spend, known, wantQty, wantTotal: wantQty ? (a.fractional ? Math.round(wantQty * raw) : wantQty * unit) + fixed : 0, fees: qty ? spend - Math.round((qty * price * 100) / rate) : 0,
        where: !env ? `espèces de ${a.name}, part de ce signal` : !known ? 'reliquat de l’enveloppe, encaisse inconnue' : cash < left ? `limité par l’encaisse ${a.name}` : 'reliquat de l’enveloppe' };
    };
    const plans = accounts.map(plan);
    // a PEA wins when it can buy (less tax after 5 years); otherwise the account buying the most, then the cheapest
    const best = [...plans].sort((x, y) => (y.qty > 0) - (x.qty > 0) || (y.a.type === 'PEA') - (x.a.type === 'PEA') || y.total - x.total || x.fees - y.fees)[0];
    const verb = q => `${line ? 'Renforcer de' : 'Acheter'} ${parts(q)}`;
    if (!best) {
      pick.reasons.push({ pts: 0, rule: 9, text: `${src} : aucun compte titres ne peut recevoir ce titre (le PEA est réservé aux titres européens).` });
      pick.order = { side: 'achat', qty: 0, rule: 9, text: 'Aucun achat possible : aucun de vos comptes ne peut recevoir ce titre.' };
    } else if (!best.qty) {
      pick.reasons.push({ pts: 0, rule: 9, text: `${src} : ${euro(best.limit)} disponibles (${best.where}), insuffisant pour une part (${euro(best.unit)}) et les frais. Un compte acceptant les fractions de parts le permettrait.` });
      pick.order = best.wantQty
        ? { side: 'achat', qty: best.wantQty, amount: best.wantTotal, accountId: best.a.id, rule, funded: false, text: `${verb(best.wantQty)} sur ${best.a.name} (≈ ${euro(best.wantTotal)}, frais inclus) : `
          + (best.known ? `il manque ${euro(best.wantTotal - spare[best.a.id])} d’espèces` : `indiquez d’abord les espèces de ${best.a.name} dans Accueil`) }
        : { side: 'achat', qty: 0, rule: 9, text: `Aucun achat possible : ${euro(best.limit)} disponibles sur ${best.a.name}, moins qu’une part (${euro(best.unit)}) et ses frais, ou part visée déjà atteinte.` };
    } else {
      spare[best.a.id] -= best.total;
      pick.order = { side: 'achat', qty: best.qty, amount: best.total, accountId: best.a.id, rule, funded: true, text: `${verb(best.qty)} sur ${best.a.name} (≈ ${euro(best.total)}, frais inclus)` };
      pick.buy = { qty: best.qty, total: best.total, fees: best.fees, limit: best.limit, accountId: best.a.id };
      pick.reasons.push({ pts: 0, rule: 9, text: `${src} : ${parts(best.qty)} sur ${best.a.name}${best.a.type === 'PEA' ? ' (PEA : moins d’impôts après 5 ans)' : ''}`
        + ` pour environ ${euro(best.total)}, dont ${euro(best.fees)} de frais (${best.where} : ${euro(best.limit)}).` });
      const others = plans.filter(x => x.qty && x !== best);
      if (others.length) pick.reasons.push({ pts: 0, text: `Frais pour ce même montant ailleurs : ${others.map(x => `${x.a.name} ${euro(x.fees)}`).join(' · ')}.` });
    }
    const since = s.signalSince?.[pick.isin];
    if (pick.order?.qty && !(since?.action === pick.action && since.date < today)) Object.assign(pick.order, { pending: true, text: `À confirmer demain : ${pick.order.text}` });
  });
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
      body: (x.order?.qty ? `${x.order.text}. ` : '') + (main?.text ?? '') });
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
  for (const r of kept) {
    const o = { id: uid(), accountId, date: r.date, amount: r.amount, kind: r.amount < 0 ? 'expense' : 'income', categoryId: null, label: r.label, importKey: r.importKey };
    s.ops.push(o); autoMatch(s, o);
  }
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
  const head0 = rows.slice(0, h).map(r => String(r[0]));
  return { date, kind: head0.map(t => t.match(/^\((\w+)/)?.[1]).find(Boolean) ?? '', portfolio: head0.map(t => t.match(/Portefeuille\s+(\S+)/)?.[1]).find(Boolean) ?? '', lines, errors };
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
  s.snapshots[accountId] = { date: snap.date, source, portfolio: snap.portfolio ?? '', seq: stamp(s), lines: snap.lines.map(({ isin, qty, cost }) => ({ isin, qty, cost })) };
  const a = s.accounts.find(x => x.id === accountId);
  if (a && !a.type && /^(PEA|CHQ|CTO)$/.test(snap.kind ?? '')) a.type = snap.kind === 'PEA' ? 'PEA' : 'CTO'; // the export says what kind of account it is
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
