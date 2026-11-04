// The only module that calls the network, and only once the user has enabled market data.
// What leaves the phone: provider keys (Alpha Vantage, Marketaux), IP address, searched names, symbols and currencies.
// Quantities, amounts, accounts and operations never do.

import { setHistory, addNews, pruneNews, newsQuery, valuation } from './budget.js';

// Free quotas are small: biggest positions first, then titles with a target, then the watchlist.
function byImportance(s, today) {
  const val = {}, t = s.settings.profile.targets;
  for (const l of valuation(s, today)) val[l.isin] = (val[l.isin] ?? 0) + (l.value ?? l.cost);
  return [...s.instruments].sort((a, b) => (val[b.isin] ?? 0) - (val[a.isin] ?? 0) || (t[b.isin] ?? 0) - (t[a.isin] ?? 0));
}

const AV = 'https://www.alphavantage.co/query', FX = 'https://api.frankfurter.dev/v1/latest', NEWS = 'https://api.marketaux.com/v1/news/all';
const enc = encodeURIComponent;

async function get(s, url, symbols, fetchFn) {
  const host = new URL(url).host;
  s.requestLog = [{ at: new Date().toISOString(), host, symbols }, ...s.requestLog].slice(0, 50); // never logs the key
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`${host} : HTTP ${r.status}`);
  return r.json();
}

const needKey = (m, key) => {
  if (!m.enabled || !m[key]) throw new Error('Activez les données de marché et saisissez vos clés (onglet Bourse, « Clés et données envoyées »).');
};

// Finds titles by name or ticker (one Alpha Vantage call out of the 25 free per day).
export async function searchSymbols(s, query, fetchFn = fetch) {
  needKey(s.settings.market, 'avKey');
  const j = await get(s, `${AV}?function=SYMBOL_SEARCH&keywords=${enc(query)}&apikey=${enc(s.settings.market.avKey)}`, [query], fetchFn);
  if (j.Note || j.Information) throw new Error(`Alpha Vantage : ${j.Note || j.Information}`);
  return (j.bestMatches ?? []).map(x => ({ symbol: x['1. symbol'], name: x['2. name'], type: x['3. type'], region: x['4. region'], currency: x['8. currency'] }));
}

// At most one call per instrument and per currency set per day (free quota: 25 Alpha Vantage calls/day).
// Returns the list of problems; quotes that could not be refreshed keep their old date and show as stale.
export async function refreshMarket(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  const ccys = [...new Set(s.instruments.map(i => i.currency).filter(c => c !== 'EUR'))];
  if (ccys.some(c => s.fx[c]?.fetchedAt !== today)) {
    try {
      const j = await get(s, `${FX}?base=EUR&symbols=${ccys.join(',')}`, ccys, fetchFn);
      for (const c of ccys) if (j.rates?.[c]) s.fx[c] = { rate: j.rates[c], asOf: j.date, source: 'BCE (Frankfurter)', fetchedAt: today };
    } catch (e) { errors.push(`Change : ${e.message}`); }
  }
  if (!m.avKey) return [...errors, 'Clé Alpha Vantage manquante : cours non actualisés'];
  for (const i of byImportance(s, today).filter(i => s.quotes[i.isin]?.fetchedAt !== today)) {
    if (!i.symbol) { errors.push(`${i.name} : pas de symbole de cours (ouvrez sa fiche, « Trouver le cours »)`); continue; }
    let j;
    try { j = await get(s, `${AV}?function=TIME_SERIES_DAILY&outputsize=compact&symbol=${enc(i.symbol)}&apikey=${enc(m.avKey)}`, [i.symbol], fetchFn); }
    catch (e) { errors.push(`${i.symbol} : ${e.message}`); continue; }
    const ts = j['Time Series (Daily)'];
    // Alpha Vantage does not return the currency: the instrument's listing currency is assumed
    if (ts) setHistory(s, i.isin, Object.entries(ts).map(([d, v]) => [d, Number(v['4. close'])]), 'Alpha Vantage', today);
    else if (j.Note || j.Information) { errors.push(`Alpha Vantage : ${j.Note || j.Information}`); break; } // quota hit: stop spending calls
    else errors.push(`${i.symbol} : symbole inconnu chez Alpha Vantage`);
  }
  return errors;
}

// One Marketaux call per instrument and per day (free quota: 100 calls/day, 3 articles per call), searched by name.
export async function refreshNews(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  if (!m.newsKey) return ['Clé Marketaux manquante : actualités non actualisées'];
  for (const i of byImportance(s, today).filter(i => s.newsFetched[i.isin] !== today)) {
    const q = newsQuery(i);
    let j;
    try { j = await get(s, `${NEWS}?search=${enc(`"${q}"`)}&language=fr,en&api_token=${enc(m.newsKey)}`, [q], fetchFn); }
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
