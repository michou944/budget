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
    settings: { reserve: 0, globalCap: 0, alertPct: 80, market: { enabled: false, avKey: '' }, profile: defaultProfile() },
    instruments: [], quotes: {}, fx: {}, requestLog: [], peaks: {}, news: [], newsFetched: {},
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
    x.settings.profile ??= defaultProfile(); x.peaks ??= {}; x.news ??= []; x.newsFetched ??= {};
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
    .map(a => ({ a, last: s.ops.filter(o => o.accountId === a.id && !o.planned).map(o => o.date).sort().at(-1) ?? null }))
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
  s.ops.push({ id: uid(), accountId, date, amount: -cents, kind: 'invest', envelopeId: envId, label, ...(isin && { isin, qty }) });
}

export const releaseEnvelope = (s, id) => { s.envelopes.find(e => e.id === id).released = true; };

// ---- portfolio (lot 2, P01): consultation only, no order is ever sent ----

export function saveInstrument(s, f) {
  const isin = String(f.isin).trim().toUpperCase(), currency = String(f.currency).trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) throw new Error('ISIN invalide');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Devise invalide (ex. EUR)');
  const i = { isin, name: (f.name || '').trim() || isin, symbol: (f.symbol || '').trim().toUpperCase(), place: (f.place || '').trim(), currency,
    newsSymbol: (f.newsSymbol || '').trim().toUpperCase() };
  const old = s.instruments.find(x => x.isin === isin);
  if (old) Object.assign(old, i); else s.instruments.push(i);
}

const checkTrade = (s, isin, qty) => {
  if (!s.instruments.some(i => i.isin === isin)) throw new Error('Instrument inconnu');
  if (!(qty > 0)) throw new Error('Quantité invalide');
};

// A holding bought before using the app: no cash movement, only its cost.
export function addHolding(s, accountId, isin, date, qty, costCents) {
  checkTrade(s, isin, qty);
  if (!Number.isInteger(costCents) || costCents < 0) throw new Error('Prix de revient invalide');
  s.ops.push({ id: uid(), accountId, date, amount: 0, cost: costCents, kind: 'invest', isin, qty, label: 'Position existante' });
}

// Records a sale already done at the broker; proceeds land in the broker account, not in the household budget.
export function addSale(s, accountId, isin, date, qty, cents) {
  checkTrade(s, isin, qty);
  const held = positions(s).find(p => p.accountId === accountId && p.isin === isin)?.qty ?? 0;
  if (qty > held + 1e-9) throw new Error('Quantité supérieure à la position');
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Montant invalide');
  s.ops.push({ id: uid(), accountId, date, amount: cents, kind: 'invest', isin, qty: -qty, label: 'Vente' });
}

// Average-cost positions per account and instrument; cost in cents, fees included.
export function positions(s) {
  const map = new Map();
  for (const o of s.ops.filter(o => o.kind === 'invest' && o.isin && o.qty).sort((a, b) => a.date.localeCompare(b.date))) {
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
  s.news.push({ isin, title: String(a.title ?? '').slice(0, 300), url, source: String(a.source ?? ''), publishedAt: String(a.publishedAt ?? '').slice(0, 10), fetchedAt: today });
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

export function suggestions(s, today) {
  const p = s.settings.profile, risk = RISK[p.risk], out = [];
  const lines = valuation(s, today), inst = isin => s.instruments.find(i => i.isin === isin);
  const quoteFig = (isin) => { const q = s.quotes[isin]; return { label: 'Cours', value: `${q.price} ${q.currency}`, asOf: q.asOf, source: q.source }; };
  const fxFig = ccy => s.fx[ccy] && { label: `Change EUR/${ccy}`, value: String(s.fx[ccy].rate), asOf: s.fx[ccy].asOf, source: s.fx[ccy].source };
  // a price is usable only if dated, in the listing currency and, outside EUR, with a current exchange rate
  const fresh = isin => {
    const i = inst(isin), q = s.quotes[isin];
    return !!(i && q && q.currency === i.currency && !isStale(q.asOf, today) && (i.currency === 'EUR' || !isStale(s.fx[i.currency]?.asOf, today)));
  };
  const add = (isin, action, rule, reason, figures = [], risks = '', extra = {}) =>
    out.push({ isin, name: inst(isin)?.name ?? (isin || 'Portefeuille'), action, rule, reason, figures: figures.filter(Boolean), risks, ...extra });
  const suspend = (isin, rule, reason) => add(isin, 'Suspendu', rule, reason, [], '', { suspended: true });

  // 1. allocation drift — weights are only meaningful if every held line is valued with fresh data
  const targets = Object.entries(p.targets).filter(([, t]) => t > 0);
  const blocked = lines.filter(l => l.value == null || l.stale);
  const byIsin = {};
  for (const l of lines) byIsin[l.isin] = (byIsin[l.isin] ?? 0) + (l.value ?? 0);
  const total = Object.values(byIsin).reduce((a, b) => a + b, 0);
  const weight = isin => (total ? ((byIsin[isin] ?? 0) * 100) / total : 0);
  const allocOk = targets.length && !blocked.length;
  if (targets.length && blocked.length) suspend(null, 'Allocation cible', `Données manquantes ou périmées : ${[...new Set(blocked.map(l => l.inst.name))].join(', ')}`);
  if (allocOk) {
    for (const isin of new Set([...targets.map(([i]) => i), ...Object.keys(byIsin)])) {
      const t = p.targets[isin] ?? 0, w = weight(isin), drift = w - t;
      if (Math.abs(drift) < p.driftPts) continue;
      add(isin, drift > 0 ? 'Alléger' : 'Renforcer', 'Allocation cible',
        `Poids actuel ${pct(w)} pour une cible de ${pct(t)} : écart de ${Math.abs(drift).toFixed(1).replace('.', ',')} points, au-delà du seuil de ${p.driftPts} points.`,
        [{ label: 'Valeur de la ligne', value: euro(byIsin[isin] ?? 0) }, { label: 'Total du portefeuille', value: euro(total) }, s.quotes[isin] && quoteFig(isin)],
        drift > 0 ? 'Alléger peut déclencher de la fiscalité et des frais ; une ligne forte peut continuer de monter.' : 'Renforcer augmente l’exposition à cette ligne ; vérifier sa pertinence avant d’acheter.');
    }
  }

  // 2. this month's envelope: buy the most underweight target, within the remaining amount and the broker's cash
  const left = s.envelopes.filter(e => e.month === monthOf(today)).reduce((t, e) => t + envelopeLeft(s, e), 0);
  if (left > 0) {
    const rule = 'Enveloppe du mois';
    if (!targets.length) suspend(null, rule, 'Définissez une allocation cible pour orienter l’achat.');
    else if (!allocOk) suspend(null, rule, 'Allocation non calculable tant que des données manquent ou sont périmées.');
    else {
      const [isin] = targets.map(([i, t]) => [i, t - weight(i)]).sort((a, b) => b[1] - a[1])[0];
      const i = inst(isin), held = lines.find(l => l.isin === isin);
      const account = held ? s.accounts.find(a => a.id === held.accountId)
        : s.accounts.filter(a => s.ops.some(o => o.kind === 'invest' && o.accountId === a.id)).sort((a, b) => balance(s, b) - balance(s, a))[0];
      if (!fresh(isin)) suspend(isin, rule, 'Cours ou taux de change absent ou périmé.');
      else if (!account) suspend(isin, rule, 'Aucun compte titres connu pour cet instrument.');
      else {
        const cash = balance(s, account), limit = Math.min(left, cash);
        const fxCost = i.currency === 'EUR' ? 0 : p.fxPct / 100;
        const raw = (s.quotes[isin].price * 100 * (1 + fxCost)) / (i.currency === 'EUR' ? 1 : s.fx[i.currency].rate);
        const unit = Math.ceil(Math.round(raw * 1e6) / 1e6); // drop float noise (561.2 * 100 = 56120.000000001)
        const qty = Math.max(0, Math.floor((limit - p.fee) / unit)); // shortcut: whole shares only, fractional orders not modelled
        const figs = [{ label: 'Reliquat d’enveloppe', value: euro(left) }, { label: `Encaisse ${account.name}`, value: euro(cash) },
          quoteFig(isin), i.currency !== 'EUR' && fxFig(i.currency), { label: 'Frais estimés', value: euro(p.fee) + (fxCost ? ` + change ${p.fxPct} %` : '') }];
        const why = `Ligne la plus sous-pondérée (${pct(weight(isin))} pour une cible de ${pct(p.targets[isin])}).`;
        if (qty < 1) add(isin, 'Attendre', rule, `${why} Le montant disponible (${euro(limit)}${cash < left ? ', limité par l’encaisse' : ''}) ne couvre pas une part (${euro(unit)}) et les frais.`, figs);
        else add(isin, 'Acheter', rule, `${why} ${qty} part(s) pour environ ${euro(qty * unit + p.fee)} frais compris, dans la limite de ${euro(limit)}${cash < left ? ' (encaisse)' : ' (reliquat)'}.`, figs,
          'Le cours peut évoluer avant l’exécution ; le reliquat non utilisé peut être libéré.', { qty, total: qty * unit + p.fee, accountId: account.id, limit });
      }
    }
  }

  // 3. notable issuer news in the last 14 days: something to read, never an automatic sale
  for (const n of s.news.filter(n => NOTABLE.test(n.title) && dayNum(today) - dayNum(n.publishedAt) <= 14))
    add(n.isin, 'À examiner', 'Actualité marquante', `« ${n.title} »`, [{ label: 'Article', value: n.source, asOf: n.publishedAt, source: n.url }],
      'Titre repéré par mots-clés : lire l’article avant toute décision.');

  // 4. per-line risk rules from the investor profile, then "hold" when nothing fires
  for (const l of lines) {
    if (l.value == null || l.stale) { suspend(l.isin, 'Données', l.value == null ? 'Cours ou taux de change indisponible.' : `Cours du ${l.quote?.asOf} non à jour.`); continue; }
    const gain = l.cost ? ((l.value - l.cost) * 100) / l.cost : 0, peak = s.peaks[l.isin], price = l.quote.price;
    const figs = [quoteFig(l.isin), { label: 'Valeur / prix de revient', value: `${euro(l.value)} / ${euro(l.cost)}` }, l.fx && fxFig(l.inst.currency)];
    const drop = peak ? ((peak.price - price) * 100) / peak.price : 0;
    if (l.cost && gain <= -risk.maxLoss)
      add(l.isin, 'Vendre ou revoir', `Perte maximale (profil ${risk.label})`, `Moins-value de ${pct(-gain)}, au-delà de la limite de ${risk.maxLoss} % de votre profil.`, figs,
        'Vendre cristallise la perte ; sur un horizon long une baisse peut être temporaire.');
    else if (p.horizon < 5 && peak && gain > 0 && drop >= risk.trail)
      add(l.isin, 'Sécuriser', `Stop suiveur ${risk.trail} % (horizon ${p.horizon} ans)`, `Cours ${pct(drop)} sous le plus haut observé (${peak.price} le ${peak.asOf}) avec une plus-value de ${pct(gain)}.`,
        [...figs, { label: 'Plus haut observé', value: String(peak.price), asOf: peak.asOf }], 'Vendre peut faire manquer un rebond ; fiscalité de la plus-value.');
    else if (!out.some(x => x.isin === l.isin))
      add(l.isin, 'Conserver', 'Aucune règle déclenchée', `Plus- ou moins-value de ${pct(gain)}, dans les limites de votre profil ${risk.label}.`, figs);
  }
  return out;
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

export function tradesPreview(s, accountId, rows) {
  const keys = new Set(s.ops.map(o => o.importKey).filter(Boolean)), seen = {};
  return rows.map(r => {
    const base = r.tradeId ? `${accountId}|trade|${r.tradeId}` : [accountId, r.date, r.isin, r.qty, r.amount].join('|');
    const importKey = r.tradeId ? base : `${base}#${(seen[base] = (seen[base] || 0) + 1)}`;
    const dup = keys.has(importKey) ? 'déjà importée'
      : s.ops.some(o => !o.importKey && o.kind === 'invest' && o.accountId === accountId && o.isin === r.isin && o.date === r.date && Math.abs(o.qty - r.qty) < 1e-9)
        ? 'saisie manuelle identique' : null;
    return { ...r, importKey, dup, keep: !dup, newInstrument: !s.instruments.some(i => i.isin === r.isin) };
  });
}

export function importTrades(s, accountId, preview, today) {
  const kept = preview.filter(r => r.keep);
  for (const r of kept) {
    if (!s.instruments.some(i => i.isin === r.isin)) saveInstrument(s, { isin: r.isin, name: r.name, currency: r.currency });
    s.ops.push({ id: uid(), accountId, date: r.date, amount: r.amount, kind: 'invest', isin: r.isin, qty: r.qty,
      label: `${r.qty > 0 ? 'Achat' : 'Vente'} ${r.name}`, importKey: r.importKey });
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
  saveInstrument(s, { isin: 'FR0000120271', name: 'TotalEnergies (suivi)', symbol: 'TTE.PAR', place: 'Euronext Paris', currency: 'EUR' });
  addHolding(s, tr, 'IE00B4L5Y983', '2025-01-15', 12, 110000);
  addHolding(s, ib, 'US0378331005', '2025-06-02', 3, 50000);
  addEnvelope(s, m, 10000, 'ETF du mois');
  buyFromEnvelope(s, s.envelopes[0].id, ib, d(3), 4000, 'CW8 (frais inclus)', 'LU1681043599', 0.0712);
  setQuote(s, 'LU1681043599', 561.2, today, 'démo (fictif)');
  setQuote(s, 'IE00B4L5Y983', 120, ago(30), 'démo (fictif)'); // earlier peak, so the trailing-stop rule fires
  setQuote(s, 'IE00B4L5Y983', 104.5, today, 'démo (fictif)');
  Object.assign(s.settings.profile, { horizon: 3, targets: { IE00B4L5Y983: 50, LU1681043599: 30, US0378331005: 20 } });
  setQuote(s, 'FR0000120271', 58.3, today, 'démo (fictif)');
  setQuote(s, 'US0378331005', 268.3, ago(10), 'démo (fictif)');
  s.fx.USD = { rate: 1.1179, asOf: today, source: 'démo (fictif)', fetchedAt: today };
  addNews(s, 'LU1681043599', { title: 'Amundi annonce la fusion de deux ETF MSCI World (fictif)', url: 'https://example.com/demo-fusion', source: 'démo (fictif)', publishedAt: ago(2) }, today);
  addNews(s, 'IE00B4L5Y983', { title: 'Les ETF monde poursuivent leur collecte (fictif)', url: 'https://example.com/demo-collecte', source: 'démo (fictif)', publishedAt: ago(1) }, today);
  addNews(s, 'IE00B4L5Y983', { title: 'Baisse des frais sur une gamme d’ETF (fictif)', url: 'https://example.com/demo-frais', source: 'démo (fictif)', publishedAt: ago(12) }, today);
  return s;
}
