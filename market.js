// The only module that calls the network, and only once the user has enabled market data.
// What leaves the phone: provider key (Marketaux), IP address, searched names, symbols and currencies.
// Quantities, amounts, accounts and operations never do.

import { setHistory, addNews, pruneNews, newsQuery, valuation, positions, saveInstrument, deleteInstrument } from './budget.js';

const FX = 'https://api.frankfurter.dev/v1/latest', MX = 'https://api.marketaux.com/v1';
const enc = encodeURIComponent;
// the daily market scan keeps at most this many new ideas
export const SCAN_CALLS = 5;

async function get(s, url, symbols, fetchFn, init) {
  const host = new URL(url).host;
  s.requestLog = [{ at: new Date().toISOString(), host, symbols }, ...s.requestLog].slice(0, 50); // never logs the key
  const r = await fetchFn(url, init);
  if (!r.ok) throw new Error(`${host} : HTTP ${r.status}`);
  return r.json();
}

// ---- the user's own price service (Cloudflare Worker relaying Yahoo Finance and OpenFIGI, see cloudflare-worker.js) ----

const proxyOn = s => !!(s.settings.market.enabled && s.settings.market.proxyUrl);
async function proxyGet(s, path, label, fetchFn, init = {}) {
  const m = s.settings.market;
  try { return await get(s, m.proxyUrl.replace(/\/+$/, '') + path, label, fetchFn, { ...init, headers: { ...init.headers, 'x-key': m.proxyKey ?? '' } }); }
  catch (e) { throw new Error(/HTTP 401/.test(e.message) ? 'Service de cours : mot de passe refusé' : /HTTP 404/.test(e.message) ? 'cotation introuvable' : `Service de cours : ${e.message}`); }
}

// Exchange of the ISIN's home market (OpenFIGI codes) and the Yahoo suffix of each exchange.
const HOME = { US: 'US', FR: 'FP', DE: 'GY', NL: 'NA', IT: 'IM', ES: 'SM', BE: 'BB', JP: 'JT', GB: 'LN' };
const YAHOO_SUFFIX = { US: '', FP: '.PA', GY: '.DE', GR: '.F', GF: '.F', NA: '.AS', IM: '.MI', SM: '.MC', BB: '.BR', JT: '.T', LN: '.L' };
export function pickFromFigi(rows, isin) {
  for (const ex of [HOME[isin.slice(0, 2)], 'FP', 'GY', 'GR', 'NA', 'IM', 'US', 'JT', 'LN'].filter(Boolean)) {
    const r = rows.find(x => x.exchCode === ex);
    if (r) return r.ticker.replace(/[ /]/g, '-') + YAHOO_SUFFIX[ex];
  }
  return null;
}

// Yahoo symbol of a title: found once from its ISIN (Yahoo, then OpenFIGI, which knows US ISINs), then kept.
async function yahooSymbol(s, i, fetchFn) {
  if (i.ysym) return i.ysym;
  let sym = null;
  if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(i.isin)) {
    const quotes = await proxyGet(s, `/search?q=${i.isin}`, [i.isin], fetchFn);
    sym = quotes[0]?.symbol ?? pickFromFigi(await proxyGet(s, `/figi?isin=${i.isin}`, [i.isin], fetchFn), i.isin);
  } else if (i.symbol) sym = i.symbol.replace(/\.PAR$/, '.PA').replace(/\.DEX$/, '.DE').replace(/\.AMS$/, '.AS');
  if (sym) i.ysym = sym;
  return sym;
}

// 6 months of daily closes in the listing's own currency (London quotes in pence are turned into pounds).
async function proxyHistory(s, sym, fetchFn) {
  const c = await proxyGet(s, `/chart?s=${enc(sym)}`, [sym], fetchFn);
  return c.currency === 'GBp' ? { currency: 'GBP', closes: c.closes.map(([d, p]) => [d, p / 100]) } : { currency: String(c.currency).toUpperCase(), closes: c.closes };
}

// POST to the user's own service (push alerts, key hand-over)
export const workerCall = (s, path, body, fetchFn = fetch) => proxyGet(s, path, ['service'], fetchFn, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } });
// Marketaux: with the key kept on the phone, or through the service once the key was handed over to it
export const newsOn = m => !!(m.newsKey || (m.newsInWorker && m.proxyUrl));
const mx = (s, call, label, fetchFn) => {
  const m = s.settings.market;
  return m.newsKey ? get(s, `${MX}/${call}&api_token=${enc(m.newsKey)}`, label, fetchFn) : proxyGet(s, `/mx/${call}`, label, fetchFn);
};

const needKey = (m, key) => {
  if (!m.enabled || !m[key]) throw new Error('Activez les données de marché et saisissez vos clés (onglet Bourse → Plus → Réglages bourse).');
};
const needService = s => { if (!proxyOn(s)) throw new Error('Activez le service de cours (onglet Bourse → Plus → Réglages bourse).'); };

// Free quotas are small: biggest positions first, then titles with a target, then the others.
function byImportance(s, today) {
  const val = {}, t = s.settings.profile.targets;
  for (const l of valuation(s, today)) val[l.isin] = (val[l.isin] ?? 0) + (l.value ?? l.cost);
  // an idea from the market scan is refreshed here once bought
  return s.instruments.filter(i => !i.auto || val[i.isin] != null).sort((a, b) => (val[b.isin] ?? 0) - (val[a.isin] ?? 0) || (t[b.isin] ?? 0) - (t[a.isin] ?? 0));
}

// « Tester » button: one cheap call that fails with HTTP 401 when the Marketaux key is wrong.
export const checkNewsKey = (s, fetchFn = fetch) => mx(s, 'news/all?language=en&limit=1', ['test de la clé'], fetchFn);

// Finds titles by name or ticker, through the price service.
export async function searchSymbols(s, query, fetchFn = fetch) {
  needService(s);
  return (await proxyGet(s, `/search?q=${enc(query)}`, [query], fetchFn)).map(x => ({ symbol: x.symbol, name: x.name, type: x.type, region: x.exchange, currency: '' }));
}

// One call per title and per day, biggest positions first, keeping SCAN_CALLS for the market scan.
// Returns the list of problems; prices that could not be refreshed keep their old date and show as stale.
async function refreshFx(s, today, fetchFn, errors) {
  const ccys = [...new Set(s.instruments.map(i => i.currency).filter(c => c !== 'EUR'))];
  if (!ccys.some(c => s.fx[c]?.fetchedAt !== today)) return;
  try {
    const j = await get(s, `${FX}?base=EUR&symbols=${ccys.join(',')}`, ccys, fetchFn);
    for (const c of ccys) if (j.rates?.[c]) s.fx[c] = { rate: j.rates[c], asOf: j.date, source: 'BCE (Frankfurter)', fetchedAt: today };
  } catch (e) { errors.push(`Change : ${e.message}`); }
}

export async function refreshMarket(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  await refreshFx(s, today, fetchFn, errors);
  if (proxyOn(s)) { // own service: every title, every day, no quota
    for (const i of byImportance(s, today)) { // no quota: every refresh takes the live price (the last daily bar moves during the session)
      try {
        const sym = await yahooSymbol(s, i, fetchFn);
        if (!sym) { errors.push(`${i.name} : cotation introuvable`); continue; }
        const h = await proxyHistory(s, sym, fetchFn);
        i.currency = h.currency;
        setHistory(s, i.isin, h.closes, 'Yahoo (service perso)', today);
      } catch (e) { errors.push(`${i.name} : ${e.message}`); if (/mot de passe/.test(e.message)) break; }
    }
    await refreshFx(s, today, fetchFn, errors); // a listing may have brought a new currency
    return errors;
  }
  return [...errors, 'Service de cours à configurer : cours non actualisés'];
}

// One Marketaux call per title and per day (free quota: 100 calls/day, 3 articles per call), searched by name.
export async function refreshNews(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  if (!newsOn(m)) return ['Clé Marketaux manquante : actualités non actualisées'];
  // without a date Marketaux answers by relevance: articles years old, all thrown away by pruneNews
  const since = new Date(Date.parse(today) - 14 * 864e5).toISOString().slice(0, 10), done = `${today}:recent`; // new mark: today's fetches of old articles are redone
  for (const i of byImportance(s, today).filter(i => s.newsFetched[i.isin] !== done)) {
    const q = newsQuery(i), word = companyWord(i.name);
    let j;
    try { j = await mx(s, `news/all?search=${enc(`"${q}"`)}&language=fr,en&sort=published_desc&published_after=${since}`, [q], fetchFn); }
    catch (e) { errors.push(`${q} : ${e.message}`); if (/HTTP (401|402|429)/.test(e.message)) break; continue; } // bad key or quota: stop
    for (const a of j.data ?? []) {
      // an article's tone counts only for this company, not for the others it names
      const tones = (a.entities ?? []).filter(e => !e.name || plainWords(e.name).includes(word)).map(e => e.sentiment_score).filter(Number.isFinite);
      addNews(s, i.isin, { title: a.title, url: a.url, source: a.source, publishedAt: a.published_at,
        sentiment: tones.length ? tones.reduce((x, y) => x + y, 0) / tones.length : null }, today);
    }
    s.newsFetched[i.isin] = done;
  }
  pruneNews(s, today);
  return errors;
}

// First meaningful word of a company name (« SONY ADR » and « Sony Group Corporation » → sony), to spot duplicates.
const GENERIC = new Set(['the', 'adr', 'ads', 'inc', 'corp', 'group', 'holdings', 'holding', 'company', 'plc', 'ltd']);
const plainWords = t => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');
export const companyWord = name => plainWords(name).split(/\s+/).find(w => w.length > 2 && !GENERIC.has(w)) ?? '';

// Marketaux symbol → the id of an idea (Alpha Vantage style, kept so ideas already stored keep their id) and listing currency; markets the app cannot price are skipped.
// shortcut: US, Paris, Xetra and Amsterdam only; London (prices in pence) and others left out.
const MARKETS = [[/^[A-Z]{1,5}$/, '', 'USD'], [/\.PA$/, '.PAR', 'EUR'], [/\.DE$/, '.DEX', 'EUR'], [/\.AS$/, '.AMS', 'EUR']];
export function toAv(symbol) {
  const m = MARKETS.find(([re]) => re.test(symbol));
  return m && { symbol: symbol.replace(/\.[A-Z]+$/, '') + m[1], currency: m[2] };
}

// Daily market scan: the listed companies most covered by the news this week with a positive tone (Marketaux),
// whose price history is then fetched (Yahoo, through the price service). They become « idées » that the verdict engine judges
// like any other title. Yesterday's ideas make way for today's, unless they were bought in the meantime.
export async function discover(s, today, fetchFn = fetch) {
  const m = s.settings.market;
  needService(s);
  if (!newsOn(m)) needKey(m, 'newsKey');
  if (s.discovery?.date === today) return [];
  const week = new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10);
  let trending, minDocs = 5;
  try {
    trending = (await mx(s, `entity/trending/aggregation?countries=us,fr,de,nl&entity_types=equity&language=en,fr`
      + `&published_after=${week}&min_doc_count=5`, ['tendances du marché'], fetchFn)).data;
  } catch (e) {
    if (/HTTP 401/.test(e.message)) throw e;
    // shortcut: plan without the trending endpoint — rebuilt from the latest 15 market articles, a thinner signal
    trending = await trendingFromNews(s, week, fetchFn); minDocs = 1;
  }
  const followed = new Set(s.instruments.filter(i => !i.auto).flatMap(i => [i.isin, i.symbol]));
  const picks = (trending ?? [])
    .map(x => ({ ...toAv(String(x.key ?? '')), key: String(x.key ?? ''), docs: x.total_documents, tone: x.sentiment_avg }))
    .filter(x => x.symbol && x.tone >= 0.15 && x.docs >= minDocs && !followed.has(x.symbol))
    .sort((a, b) => b.docs * b.tone - a.docs * a.tone);
  const held = new Set(positions(s).map(p => p.isin));
  for (const i of s.instruments.filter(i => i.auto && !held.has(i.isin))) deleteInstrument(s, i.isin);
  s.discovery = { date: today, items: {} };
  const errors = [];
  for (const x of picks) {
    if (Object.keys(s.discovery.items).length >= SCAN_CALLS) break;
    let closes, currency;
    try { ({ closes, currency } = await proxyHistory(s, x.key, fetchFn)); } // Marketaux and Yahoo share suffixes (.PA, .DE, .AS)
    catch (e) { errors.push(`${x.symbol} : ${e.message}`); continue; }
    const id = saveInstrument(s, { symbol: x.symbol, name: x.symbol, currency, type: 'Equity' });
    Object.assign(s.instruments.find(i => i.isin === id), { auto: true, ysym: x.key });
    setHistory(s, id, closes, 'Yahoo (service perso)', today);
    s.discovery.items[id] = { docs: x.docs, tone: x.tone, asOf: today };
  }
  // one call to put company names on the ideas
  const ids = Object.keys(s.discovery.items);
  if (ids.length) {
    try {
      const names = await mx(s, `entity/search?symbols=${enc(picks.filter(x => ids.includes(x.symbol)).map(x => x.symbol.replace(/\.[A-Z]+$/, '')).join(','))}`, ['noms'], fetchFn);
      for (const e of names.data ?? []) {
        const i = s.instruments.find(y => y.auto && y.symbol.replace(/\.[A-Z]+$/, '') === e.symbol?.replace(/\.[A-Z]+$/, ''));
        if (i && e.name) i.name = e.name;
      }
    } catch { /* names are cosmetic: the ticker stays */ }
  }
  // the same company under another listing (US ADR, OTC line, other exchange) is not a new idea
  const mine = new Set(s.instruments.filter(i => !i.auto).map(i => companyWord(i.name)));
  for (const i of s.instruments.filter(i => i.auto && !held.has(i.isin) && mine.has(companyWord(i.name)))) deleteInstrument(s, i.isin);
  await refreshFx(s, today, fetchFn, errors); // an idea quoted in dollars needs today's rate
  return errors;
}

async function trendingFromNews(s, week, fetchFn) {
  const agg = {};
  for (const page of [1, 2, 3, 4, 5]) {
    const j = await mx(s, `news/all?countries=us,fr,de,nl&filter_entities=true&must_have_entities=true&language=en,fr`
      + `&published_after=${week}&page=${page}`, ['actualités du marché'], fetchFn);
    for (const a of j.data ?? []) for (const e of a.entities ?? []) {
      if (e.type !== 'equity' || !e.symbol) continue;
      const x = (agg[e.symbol] ??= { key: e.symbol, total_documents: 0, sum: 0 });
      x.total_documents++; x.sum += e.sentiment_score ?? 0;
    }
  }
  return Object.values(agg).map(x => ({ key: x.key, total_documents: x.total_documents, sentiment_avg: x.sum / x.total_documents }));
}
