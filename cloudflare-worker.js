// Personal price service for the Budget app — a Cloudflare Worker.
// The app cannot call Yahoo Finance or OpenFIGI from the phone's browser (they refuse cross-site calls); this relay does.
// It receives ISINs, names and symbols — never amounts, quantities or accounts. It keeps (KV storage « KV ») only:
// the Marketaux key, the phone's push address, and the price levels to watch for the closed-app alerts.
//
// Setup (free): deployed with « npx wrangler deploy » from this folder (wrangler.toml), webpush.js included.
// Then Settings → Variables and secrets → add a secret named KEY (a password of your choice), and type the
// Worker's address and that password in the app (Bourse → Réglages bourse).

const ORIGIN = 'https://michou944.github.io'; // the only site allowed to use this service
const UA = { 'User-Agent': 'Mozilla/5.0' };
import { makeVapid, sendPush } from './webpush.js';
const MX_PATHS = ['news/all', 'entity/trending/aggregation', 'entity/search']; // the only Marketaux calls the app makes

async function vapid(env) {
  let v = await env.KV.get('vapid', 'json');
  if (!v) { v = await makeVapid(); await env.KV.put('vapid', JSON.stringify(v)); }
  return v;
}
const push = async (env, sub, message) => sendPush(sub, message, await vapid(env), ORIGIN);

// Cron: each watched title's latest price against the levels the app computed; one notification per new crossing.
async function checkAlerts(env) {
  const p = await env.KV.get('push', 'json');
  if (!p?.subscription || !p.watch?.length) return;
  const fired = (await env.KV.get('fired', 'json')) ?? {}, now = {}, lines = [];
  const fmt = x => x.toFixed(1).replace('.', ',');
  for (const w of p.watch.slice(0, 40)) { // free plan: 50 outgoing calls per run
    const keep = () => { for (const k of Object.keys(fired)) if (k.startsWith(`${w.s}:`)) now[k] = 1; }; // source down: no re-alert later
    let res;
    try { res = (await (await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(w.s)}?range=5d&interval=1d`, { headers: UA })).json()).chart?.result?.[0]; } catch { keep(); continue; }
    const div = res?.meta?.currency === 'GBp' ? 100 : 1, ts = res?.timestamp ?? [], close = res?.indicators?.quote?.[0]?.close ?? [];
    const last = (res?.meta?.regularMarketPrice ?? close.at(-1)) / div, prev = close.at(-2) / div;
    if (!(last > 0)) { keep(); continue; }
    const hits = (w.rules ?? []).map((r, k) => [k, r]).filter(([, r]) => (r.below && last <= r.below) || (r.above && last >= r.above)).map(([k, r]) => [k, r.msg]);
    const mv = prev > 0 ? (last / prev - 1) * 100 : 0;
    if (w.move && Math.abs(mv) >= w.move) hits.push([`mv${ts.at(-1)}`, `${mv > 0 ? '+' : ''}${fmt(mv)} % sur la séance`]);
    for (const [k, msg] of hits) { now[`${w.s}:${k}`] = 1; if (!fired[`${w.s}:${k}`]) lines.push(`${w.n} : ${msg}`); }
  }
  if (lines.length) {
    const r = await push(env, p.subscription, { title: lines.length > 1 ? `Boussole · ${lines.length} alertes` : 'Boussole', body: lines.join(String.fromCharCode(10)), tab: 'stock' });
    if (r.status === 404 || r.status === 410) await env.KV.delete('push'); // the phone unsubscribed
  }
  if (JSON.stringify(now) !== JSON.stringify(fired)) await env.KV.put('fired', JSON.stringify(now));
}

export default {
  async scheduled(_, env, ctx) { ctx.waitUntil(checkAlerts(env)); },
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'x-key, content-type', 'Content-Type': 'application/json' };
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
      const body = req.method === 'POST' ? await req.json() : {};
      if (u.pathname === '/config') { // the phone hands its Marketaux key over once, then forgets it
        if (typeof body.newsKey !== 'string' || !body.newsKey.trim()) return reply({ error: 'clé vide' }, 400);
        await env.KV.put('newsKey', body.newsKey.trim());
        return reply({ ok: true });
      }
      if (u.pathname.startsWith('/mx/')) { // Marketaux with the stored key; its own status (401, 402, 429) goes back to the app
        const path = u.pathname.slice(4), key = env.NEWS_KEY ?? await env.KV.get('newsKey');
        if (!MX_PATHS.includes(path)) return reply({ error: 'adresse inconnue' }, 404);
        if (!key) return reply({ error: 'clé Marketaux absente du service' }, 401);
        const p = new URLSearchParams(u.search); p.set('api_token', key);
        const r = await fetch(`https://api.marketaux.com/v1/${path}?${p}`);
        return new Response(await r.text(), { status: r.status, headers: cors });
      }
      if (u.pathname === '/push/key') return reply({ publicKey: (await vapid(env)).publicKey });
      if (u.pathname === '/push/watch') { // subscription (when given) and the list of price levels to watch
        const p = (await env.KV.get('push', 'json')) ?? {};
        if (body.subscription) p.subscription = body.subscription;
        if (Array.isArray(body.watch)) p.watch = body.watch;
        if (!p.subscription?.endpoint?.startsWith('https://')) return reply({ error: 'abonnement manquant' }, 400);
        await env.KV.put('push', JSON.stringify(p));
        return reply({ ok: true, watched: p.watch?.length ?? 0 });
      }
      if (u.pathname === '/push/test') {
        const p = await env.KV.get('push', 'json');
        if (!p?.subscription) return reply({ error: 'alertes non activées' }, 400);
        const r = await push(env, p.subscription, { title: 'Boussole', body: `Alertes actives : ${p.watch?.length ?? 0} titre(s) surveillé(s) toutes les 30 min en semaine.`, tab: 'stock' });
        return reply(r.ok ? { ok: true } : { error: `envoi refusé (${r.status}) : ${(await r.text()).slice(0, 200)}` }, r.ok ? 200 : 502);
      }
      if (u.pathname === '/push/off') { await env.KV.delete('push'); await env.KV.delete('fired'); return reply({ ok: true }); }
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
      if (u.pathname === '/chart') { // symbol → currency and 1 year of daily closes (enough for a 200-day average)
        const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q('s'))}?range=1y&interval=1d`, { headers: UA });
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
