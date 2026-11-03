// The only module that calls the network, and only once the user has enabled market data.
// What leaves the phone: provider keys (Alpha Vantage, Marketaux), IP address, symbols and currencies.
// Quantities, amounts, accounts and operations never do.

import { trackPeak, addNews, pruneNews } from './budget.js';

const AV = 'https://www.alphavantage.co/query', FX = 'https://api.frankfurter.dev/v1/latest', NEWS = 'https://api.marketaux.com/v1/news/all';

async function get(s, url, symbols, fetchFn) {
  const host = new URL(url).host;
  s.requestLog = [{ at: new Date().toISOString(), host, symbols }, ...s.requestLog].slice(0, 50); // never logs the key
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`${host} : HTTP ${r.status}`);
  return r.json();
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
  for (const i of s.instruments.filter(i => i.symbol && s.quotes[i.isin]?.fetchedAt !== today)) {
    let j;
    try { j = await get(s, `${AV}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(i.symbol)}&apikey=${encodeURIComponent(m.avKey)}`, [i.symbol], fetchFn); }
    catch (e) { errors.push(`${i.symbol} : ${e.message}`); continue; }
    const q = j['Global Quote'];
    if (q?.['05. price']) {
      // Alpha Vantage does not return the currency: the instrument's listing currency is assumed
      s.quotes[i.isin] = { price: Number(q['05. price']), currency: i.currency, asOf: q['07. latest trading day'], source: 'Alpha Vantage', fetchedAt: today };
      trackPeak(s, i.isin, s.quotes[i.isin].price, s.quotes[i.isin].asOf);
    } else if (j.Note || j.Information) { errors.push(`Alpha Vantage : ${j.Note || j.Information}`); break; } // quota hit: stop spending calls
    else errors.push(`${i.symbol} : symbole inconnu chez Alpha Vantage`);
  }
  return errors;
}

// One Marketaux call per instrument and per day (free quota: 100 calls/day, 3 articles per call).
export async function refreshNews(s, today, fetchFn = fetch) {
  const m = s.settings.market, errors = [];
  if (!m.enabled) throw new Error('Données de marché désactivées');
  if (!m.newsKey) return ['Clé Marketaux manquante : actualités non actualisées'];
  for (const i of s.instruments.filter(i => i.newsSymbol && s.newsFetched[i.isin] !== today)) {
    let j;
    try { j = await get(s, `${NEWS}?symbols=${encodeURIComponent(i.newsSymbol)}&filter_entities=true&language=fr,en&api_token=${encodeURIComponent(m.newsKey)}`, [i.newsSymbol], fetchFn); }
    catch (e) { errors.push(`${i.newsSymbol} : ${e.message}`); if (/HTTP (401|402|429)/.test(e.message)) break; continue; } // bad key or quota: stop
    for (const a of j.data ?? []) addNews(s, i.isin, { title: a.title, url: a.url, source: a.source, publishedAt: a.published_at }, today);
    s.newsFetched[i.isin] = today;
  }
  pruneNews(s, today);
  return errors;
}
