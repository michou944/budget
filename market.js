// The only module that calls the network, and only once the user has enabled market data.
// What leaves the phone: provider keys (Alpha Vantage, Marketaux), IP address, searched names, symbols and currencies.
// Quantities, amounts, accounts and operations never do.

import { setHistory, addNews, pruneNews, newsQuery, valuation, positions, saveInstrument, deleteInstrument } from './budget.js';

const AV = 'https://www.alphavantage.co/query', FX = 'https://api.frankfurter.dev/v1/latest', MX = 'https://api.marketaux.com/v1';
const enc = encodeURIComponent;
// Alpha Vantage free plan: 25 calls a day, shared between the user's titles and the daily market scan
export const AV_PER_DAY = 25, SCAN_CALLS = 5;
const localDay = () => new Date().toLocaleDateString('sv-SE');
const avUsed = s => (s.avCalls?.date === localDay() ? s.avCalls.n : 0);

async function get(s, url, symbols, fetchFn, init) {
  const host = new URL(url).host;
  s.requestLog = [{ at: new Date().toISOString(), host, symbols }, ...s.requestLog].slice(0, 50); // never logs the key
  if (host.includes('alphavantage')) s.avCalls = { date: localDay(), n: avUsed(s) + 1 };
  const r = await fetchFn(url, init);
  if (!r.ok) throw new Error(`${host} : HTTP ${r.status}`);
  return r.json();
}

// ---- the user's own price service (Cloudflare Worker relaying Yahoo Finance and OpenFIGI, see cloudflare-worker.js) ----

const proxyOn = s => !!(s.settings.market.enabled && s.settings.market.proxyUrl);
async function proxyGet(s, path, label, fetchFn) {
  const m = s.settings.market;
  try { return await get(s, m.proxyUrl.replace(/\/+$/, '') + path, label, fetchFn, { headers: { 'x-key': m.proxyKey ?? '' } }); }
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

const needKey = (m, key) => {
  if (!m.enabled || !m[key]) throw new Error('Activez les données de marché et saisissez vos clés (onglet Bourse, « Clés et données envoyées »).');
};

// Free quotas are small: biggest positions first, then titles with a target, then the others.
function byImportance(s, today) {
  const val = {}, t = s.settings.profile.targets;
  for (const l of valuation(s, today)) val[l.isin] = (val[l.isin] ?? 0) + (l.value ?? l.cost);
  // an idea from the market scan is refreshed here once bought
  return s.instruments.filter(i => !i.auto || val[i.isin] != null).sort((a, b) => (val[b.isin] ?? 0) - (val[a.isin] ?? 0) || (t[b.isin] ?? 0) - (t[a.isin] ?? 0));
}

const dailyCloses = j => Object.entries(j['Time Series (Daily)'] ?? {}).map(([d, v]) => [d, Number(v['4. close'])]);

// « Tester » button: one cheap call that fails with HTTP 401 when the Marketaux key is wrong.
export const checkNewsKey = (s, fetchFn = fetch) => get(s, `${MX}/news/all?language=en&limit=1&api_token=${enc(s.settings.market.newsKey)}`, ['test de la clé'], fetchFn);

// Finds titles by name or ticker (one Alpha Vantage call).
export async function searchSymbols(s, query, fetchFn = fetch) {
  if (proxyOn(s)) return (await proxyGet(s, `/search?q=${enc(query)}`, [query], fetchFn)).map(x => ({ symbol: x.symbol, name: x.name, type: x.type, region: x.exchange, currency: '' }));
  needKey(s.settings.market, 'avKey');
  const j = await get(s, `${AV}?function=SYMBOL_SEARCH&keywords=${enc(query)}&apikey=${enc(s.settings.market.avKey)}`, [query], fetchFn);
  if (j.Note || j.Information) throw new Error(`Alpha Vantage : ${j.Note || j.Information}`);
  return (j.bestMatches ?? []).map(x => ({ symbol: x['1. symbol'], name: x['2. name'], type: x['3. type'], region: x['4. region'], currency: x['8. currency'] }));
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
    for (const i of byImportance(s, today).filter(i => s.quotes[i.isin]?.fetchedAt !== today)) {
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
  if (!m.avKey) return [...errors, 'Clé Alpha Vantage manquante : cours non actualisés'];
  const todo = byImportance(s, today).filter(i => s.quotes[i.isin]?.fetchedAt !== today);
  for (const [k, i] of todo.entries()) {
    if (avUsed(s) >= AV_PER_DAY - SCAN_CALLS) { errors.push(`Quota gratuit du jour atteint : ${todo.length - k} petite(s) ligne(s) actualisée(s) demain.`); break; }
    if (!i.symbol) { errors.push(`${i.name} : pas de symbole de cours (ouvrez sa fiche, « Trouver le cours »)`); continue; }
    let j;
    try { j = await get(s, `${AV}?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${enc(i.symbol)}&apikey=${enc(m.avKey)}`, [i.symbol], fetchFn); }
    catch (e) { errors.push(`${i.symbol} : ${e.message}`); continue; }
    // Alpha Vantage does not return the currency: the instrument's listing currency is assumed
    if (j['Time Series (Daily)']) setHistory(s, i.isin, dailyCloses(j), 'Alpha Vantage', today);
    else if (j.Note || j.Information) { errors.push(`Alpha Vantage : ${j.Note || j.Information}`); break; } // quota hit: stop spending calls
    else errors.push(`${i.symbol} : symbole inconnu chez Alpha Vantage`);
  }
  return errors;
}

// One Marketaux call per title and per day (free quota: 100 calls/day, 3 articles per call), searched by name.
export async function refreshNews(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  if (!m.newsKey) return ['Clé Marketaux manquante : actualités non actualisées'];
  for (const i of byImportance(s, today).filter(i => s.newsFetched[i.isin] !== today)) {
    const q = newsQuery(i);
    let j;
    try { j = await get(s, `${MX}/news/all?search=${enc(`"${q}"`)}&language=fr,en&api_token=${enc(m.newsKey)}`, [q], fetchFn); }
    catch (e) { errors.push(`${q} : ${e.message}`); if (/HTTP (401|402|429)/.test(e.message)) break; continue; } // bad key or quota: stop
    for (const a of j.data ?? []) {
      const tones = (a.entities ?? []).map(e => e.sentiment_score).filter(Number.isFinite);
      addNews(s, i.isin, { title: a.title, url: a.url, source: a.source, publishedAt: a.published_at,
        sentiment: tones.length ? tones.reduce((x, y) => x + y, 0) / tones.length : null }, today);
    }
    s.newsFetched[i.isin] = today;
  }
  pruneNews(s, today);
  return errors;
}

// Marketaux symbol → Alpha Vantage symbol and listing currency; markets the app cannot price are skipped.
// shortcut: US, Paris, Xetra and Amsterdam only; London (prices in pence) and others left out.
const MARKETS = [[/^[A-Z]{1,5}$/, '', 'USD'], [/\.PA$/, '.PAR', 'EUR'], [/\.DE$/, '.DEX', 'EUR'], [/\.AS$/, '.AMS', 'EUR']];
export function toAv(symbol) {
  const m = MARKETS.find(([re]) => re.test(symbol));
  return m && { symbol: symbol.replace(/\.[A-Z]+$/, '') + m[1], currency: m[2] };
}

// Daily market scan: the listed companies most covered by the news this week with a positive tone (Marketaux),
// whose price history is then fetched (Alpha Vantage). They become « idées » that the verdict engine judges
// like any other title. Yesterday's ideas make way for today's, unless they were bought in the meantime.
export async function discover(s, today, fetchFn = fetch) {
  const m = s.settings.market, proxy = proxyOn(s);
  if (!proxy) needKey(m, 'avKey');
  needKey(m, 'newsKey');
  if (s.discovery?.date === today) return [];
  const week = new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10);
  let trending, minDocs = 5;
  try {
    trending = (await get(s, `${MX}/entity/trending/aggregation?countries=us,fr,de,nl&entity_types=equity&language=en,fr`
      + `&published_after=${week}&min_doc_count=5&api_token=${enc(m.newsKey)}`, ['tendances du marché'], fetchFn)).data;
  } catch (e) {
    if (/HTTP 401/.test(e.message)) throw e;
    // shortcut: plan without the trending endpoint — rebuilt from the latest 15 market articles, a thinner signal
    trending = await trendingFromNews(s, week, m.newsKey, fetchFn); minDocs = 1;
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
    if (Object.keys(s.discovery.items).length >= SCAN_CALLS || (!proxy && avUsed(s) >= AV_PER_DAY)) break;
    let closes, currency = x.currency;
    try {
      if (proxy) ({ closes, currency } = await proxyHistory(s, x.key, fetchFn)); // Marketaux and Yahoo share suffixes (.PA, .DE, .AS)
      else {
        const h = await get(s, `${AV}?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${enc(x.symbol)}&apikey=${enc(m.avKey)}`, [x.symbol], fetchFn);
        if (!h['Time Series (Daily)']) { if (h.Note || h.Information) { errors.push(`Alpha Vantage : ${h.Note || h.Information}`); break; } continue; }
        closes = dailyCloses(h);
      }
    } catch (e) { errors.push(`${x.symbol} : ${e.message}`); continue; }
    const id = saveInstrument(s, { symbol: x.symbol, name: x.symbol, currency, type: 'Equity' });
    Object.assign(s.instruments.find(i => i.isin === id), { auto: true, ...(proxy && { ysym: x.key }) });
    setHistory(s, id, closes, proxy ? 'Yahoo (service perso)' : 'Alpha Vantage', today);
    s.discovery.items[id] = { docs: x.docs, tone: x.tone, asOf: today };
  }
  // one call to put company names on the ideas
  const ids = Object.keys(s.discovery.items);
  if (ids.length) {
    try {
      const names = await get(s, `${MX}/entity/search?symbols=${enc(picks.filter(x => ids.includes(x.symbol)).map(x => x.symbol.replace(/\.[A-Z]+$/, '')).join(','))}&api_token=${enc(m.newsKey)}`, ['noms'], fetchFn);
      for (const e of names.data ?? []) {
        const i = s.instruments.find(y => y.auto && y.symbol.replace(/\.[A-Z]+$/, '') === e.symbol?.replace(/\.[A-Z]+$/, ''));
        if (i && e.name) i.name = e.name;
      }
    } catch { /* names are cosmetic: the ticker stays */ }
  }
  await refreshFx(s, today, fetchFn, errors); // an idea quoted in dollars needs today's rate
  return errors;
}

async function trendingFromNews(s, week, key, fetchFn) {
  const agg = {};
  for (const page of [1, 2, 3, 4, 5]) {
    const j = await get(s, `${MX}/news/all?countries=us,fr,de,nl&filter_entities=true&must_have_entities=true&language=en,fr`
      + `&published_after=${week}&page=${page}&api_token=${enc(key)}`, ['actualités du marché'], fetchFn);
    for (const a of j.data ?? []) for (const e of a.entities ?? []) {
      if (e.type !== 'equity' || !e.symbol) continue;
      const x = (agg[e.symbol] ??= { key: e.symbol, total_documents: 0, sum: 0 });
      x.total_documents++; x.sum += e.sentiment_score ?? 0;
    }
  }
  return Object.values(agg).map(x => ({ key: x.key, total_documents: x.total_documents, sentiment_avg: x.sum / x.total_documents }));
}
