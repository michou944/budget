// Personal price service for the Budget app — a Cloudflare Worker.
// The app cannot call Yahoo Finance or OpenFIGI from the phone's browser (they refuse cross-site calls); this relay does.
// It only ever receives ISINs, names and symbols — never amounts, quantities or accounts — and keeps nothing.
//
// Setup (free): Cloudflare → Workers & Pages → Create → « Hello World » Worker → Edit code → paste this file → Deploy.
// Then Settings → Variables and secrets → add a secret named KEY (a password of your choice), and type the
// Worker's address and that password in the app (Bourse → Réglages bourse).

const ORIGIN = 'https://michou944.github.io'; // the only site allowed to use this service
const UA = { 'User-Agent': 'Mozilla/5.0' };

export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'x-key', 'Content-Type': 'application/json' };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const u = new URL(req.url), q = name => u.searchParams.get(name) ?? '';
    if (u.pathname === '/sante') { // public health check: fixed public symbol, only reports whether the sources answer
      const [y, f] = await Promise.all([
        fetch('https://query2.finance.yahoo.com/v8/finance/chart/TTE.PA?range=5d&interval=1d', { headers: UA }).then(r => r.status, () => 0),
        fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[{"idType":"ID_ISIN","idValue":"FR0000120271"}]' }).then(r => r.status, () => 0)]);
      return reply({ yahoo: y === 200 ? 'OK' : y, openfigi: f === 200 ? 'OK' : f, motDePasseConfigure: !!env.KEY });
    }
    if (!env.KEY || req.headers.get('x-key') !== env.KEY) return reply({ error: 'mot de passe refusé' }, 401);
    try {
      if (u.pathname === '/search') { // name, ticker or (non-US) ISIN → listings
        const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q('q'))}&quotesCount=8&newsCount=0`, { headers: UA });
        const quotes = (await r.json()).quotes ?? [];
        return reply(quotes.filter(x => x.symbol && ['EQUITY', 'ETF'].includes(x.quoteType))
          .map(x => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchange, type: x.quoteType })));
      }
      if (u.pathname === '/figi') { // ISIN → tickers per exchange (OpenFIGI knows US ISINs, Yahoo does not)
        const r = await fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([{ idType: 'ID_ISIN', idValue: q('isin') }]) });
        return reply(((await r.json())[0]?.data ?? []).map(x => ({ ticker: x.ticker, exchCode: x.exchCode })));
      }
      if (u.pathname === '/chart') { // symbol → currency and 6 months of daily closes
        const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q('s'))}?range=6mo&interval=1d`, { headers: UA });
        const res = (await r.json()).chart?.result?.[0];
        if (!res?.timestamp) return reply({ error: 'cotation introuvable' }, 404);
        const close = res.indicators.quote[0].close;
        return reply({ symbol: q('s'), currency: res.meta.currency,
          closes: res.timestamp.map((t, k) => [new Date(t * 1000).toISOString().slice(0, 10), close[k]]).filter(x => x[1] > 0) });
      }
      return reply({ error: 'adresse inconnue' }, 404);
    } catch (e) {
      return reply({ error: String(e?.message ?? e) }, 502);
    }
  },
};
