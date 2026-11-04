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

async function get(s, url, symbols, fetchFn) {
  const host = new URL(url).host;
  s.requestLog = [{ at: new Date().toISOString(), host, symbols }, ...s.requestLog].slice(0, 50); // never logs the key
  if (host.includes('alphavantage')) s.avCalls = { date: localDay(), n: avUsed(s) + 1 };
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`${host} : HTTP ${r.status}`);
  return r.json();
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

// Finds titles by name or ticker (one Alpha Vantage call).
export async function searchSymbols(s, query, fetchFn = fetch) {
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
  const m = s.settings.market;
  needKey(m, 'avKey'); needKey(m, 'newsKey');
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
    .map(x => ({ ...toAv(String(x.key ?? '')), docs: x.total_documents, tone: x.sentiment_avg }))
    .filter(x => x.symbol && x.tone >= 0.15 && x.docs >= minDocs && !followed.has(x.symbol))
    .sort((a, b) => b.docs * b.tone - a.docs * a.tone);
  const held = new Set(positions(s).map(p => p.isin));
  for (const i of s.instruments.filter(i => i.auto && !held.has(i.isin))) deleteInstrument(s, i.isin);
  s.discovery = { date: today, items: {} };
  const errors = [];
  for (const x of picks) {
    if (Object.keys(s.discovery.items).length >= SCAN_CALLS || avUsed(s) >= AV_PER_DAY) break;
    let h;
    try { h = await get(s, `${AV}?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${enc(x.symbol)}&apikey=${enc(m.avKey)}`, [x.symbol], fetchFn); }
    catch (e) { errors.push(`${x.symbol} : ${e.message}`); continue; }
    if (!h['Time Series (Daily)']) { if (h.Note || h.Information) { errors.push(`Alpha Vantage : ${h.Note || h.Information}`); break; } continue; }
    const id = saveInstrument(s, { symbol: x.symbol, name: x.symbol, currency: x.currency, type: 'Equity' });
    s.instruments.find(i => i.isin === id).auto = true;
    setHistory(s, id, dailyCloses(h), 'Alpha Vantage', today);
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
