// Acceptance scenarios from the spec (recette minimale + complémentaire).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from './budget.js';

const M = '2026-11';
function base() {
  const s = B.emptyState();
  s.accounts.push({ id: 'a', name: 'BCP', institution: 'BCP', opening: 0, liquid: true, savings: false },
                  { id: 'b', name: 'Fortuneo', institution: 'Fortuneo', opening: 0, liquid: true, savings: false },
                  { id: 'l', name: 'Livret', institution: 'Fortuneo', opening: 0, liquid: false, savings: true });
  return s;
}
const op = (s, kind, euros, extra = {}) => B.saveOp(s, { accountId: 'a', date: `${M}-02`, kind, cents: euros * 100, ...extra });

test('B02: à date / prévu, then reconciliation counts once', () => {
  const s = base();
  op(s, 'income', 2500); op(s, 'expense', 1200); op(s, 'expense', 500, { planned: true });
  let st = B.monthStats(s, M);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000);
  op(s, 'expense', 480); // the real payment, a little different from what was planned, settles it on its own
  st = B.monthStats(s, M);
  assert.equal(st.toDate, 82000); assert.equal(st.forecast, 82000);
});

test('An upcoming item counts as paid on its due date; the real payment entered later replaces it, never twice', () => {
  const s = base(), cat = s.categories[3].id;
  B.saveOp(s, { accountId: 'a', date: `${M}-10`, kind: 'expense', cents: 15000, categoryId: cat, label: 'Assurance auto', planned: true });
  B.saveOp(s, { accountId: 'b', date: `${M}-05`, kind: 'expense', cents: 4000, label: 'Courses' }); // other account, other amount: unrelated
  assert.equal(B.settleDue(s, `${M}-09`), 0); assert.equal(B.upcoming(s, M).length, 1); // not due yet
  assert.equal(B.settleDue(s, `${M}-10`), 1); assert.equal(B.upcoming(s, M).length, 0);
  assert.equal(B.monthStats(s, M).spent, 19000);
  B.saveOp(s, { accountId: 'a', date: `${M}-11`, kind: 'expense', cents: 15200, categoryId: cat, label: 'PRLV ASSURANCE' }); // the bank's real debit
  assert.equal(B.monthStats(s, M).spent, 19200); // 152 € replaces 150 €, not added to it
  assert.equal(s.ops.filter(o => /ssurance/i.test(o.label)).length, 1);
});

test('A price far from what was paid is set aside as « à vérifier » instead of showing a false loss', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', AAPL, '2025-01-01', 3, 74245); // 3 shares bought 742,45 €
  B.setQuote(s, AAPL, 37.4, T); s.fx.USD = { rate: 1, asOf: T }; // the wrong listing: 3 × 37 = 112 €
  const [line] = B.valuation(s, T);
  assert.equal(line.value, null); assert.equal(line.suspect, true);
  const v = B.suggestions(s, T).find(x => x.isin === AAPL);
  assert.equal(v.action, 'Suspendu'); assert.match(v.reasons[0].text, /Cours à vérifier/);
});

test('B01: transfer changes neither income nor spending; savings transfer reported', () => {
  const s = base();
  op(s, 'income', 2500); op(s, 'expense', 1200);
  const before = B.monthStats(s, M);
  B.addTransfer(s, 'a', 'b', `${M}-03`, 20000);
  const after = B.monthStats(s, M);
  assert.equal(after.income, before.income); assert.equal(after.spent, before.spent); assert.equal(after.savedTransfer, 0);
  B.addTransfer(s, 'a', 'l', `${M}-04`, 15000);
  B.addTransfer(s, 'l', 'a', `${M}-05`, 5000);
  assert.equal(B.monthStats(s, M).savedTransfer, 10000);
});

test('B01: detected transfer pair is excluded once linked', () => {
  const s = base();
  op(s, 'expense', 100);
  B.saveOp(s, { accountId: 'b', date: `${M}-04`, kind: 'income', cents: 10000 });
  const [[out, inn]] = B.transferCandidates(s);
  B.linkTransfer(s, out.id, inn.id);
  const st = B.monthStats(s, M);
  assert.equal(st.income, 0); assert.equal(st.spent, 0);
});

test('B01: re-importing the same statement creates no duplicate', () => {
  const s = base();
  const csv = 'Date;Libellé;Montant\n01/11/2026;CB MARCHE;-12,50\n01/11/2026;CB MARCHE;-12,50\n02/11/2026;SALAIRE;2 500,00\ntotal;;\n';
  const { rows, errors } = B.parseCsv(csv);
  assert.equal(rows.length, 3); assert.deepEqual(errors, [5]);
  assert.equal(B.importRows(s, 'a', B.importPreview(s, 'a', rows), '2026-11-03'), 3);
  const again = B.importPreview(s, 'a', rows);
  assert.ok(again.every(r => r.dup && !r.keep));
  assert.equal(B.importRows(s, 'a', again, '2026-11-03'), 0);
  assert.equal(s.ops.length, 3);
});

test('B03: one alert per threshold and period', () => {
  const s = base();
  const c = s.categories[0]; c.cap = 10000; s.settings.alertPct = 80;
  op(s, 'expense', 85, { categoryId: c.id });
  let al = B.alerts(s, M);
  assert.equal(al.length, 1);
  s.dismissedAlerts.push(al[0].id);
  op(s, 'expense', 5, { categoryId: c.id });
  assert.equal(B.alerts(s, M).length, 0);
  op(s, 'expense', 20, { categoryId: c.id });
  al = B.alerts(s, M);
  assert.equal(al.length, 1); assert.equal(al[0].pct, 100);
});

test('B04: stale account flagged; encrypted backup restores accounts and ops', async () => {
  const s = base();
  op(s, 'expense', 10);
  const stale = B.staleAccounts(s, '2026-11-03').map(x => x.a.id);
  assert.deepEqual(stale, ['b', 'l']);
  const file = await B.encryptBackup(s, 'motdepasse');
  assert.ok(!file.includes('Fortuneo'));
  assert.deepEqual(await B.decryptBackup(file, 'motdepasse'), s);
  await assert.rejects(B.decryptBackup(file, 'mauvais!!'), /Mot de passe incorrect/);
});

test('Réserve + enveloppe bourse scenario', () => {
  const s = base();
  op(s, 'income', 2500); op(s, 'expense', 1200); op(s, 'expense', 500, { planned: true });
  s.settings.reserve = 30000;
  assert.equal(B.monthStats(s, M).spendable, 50000);
  assert.equal(B.monthStats(s, M).savedTransfer, 0);
  B.addEnvelope(s, M, 10000);
  const e = s.envelopes[0];
  assert.equal(B.monthStats(s, M).spendable, 40000);
  B.buyFromEnvelope(s, e.id, 'b', `${M}-05`, 4000, 'ETF');
  assert.equal(B.monthStats(s, M).spendable, 40000);
  assert.equal(B.envelopeLeft(s, e), 6000);
  assert.throws(() => B.buyFromEnvelope(s, e.id, 'b', `${M}-06`, 6001, 'trop'), /reliquat/);
  B.releaseEnvelope(s, e.id);
  assert.equal(B.monthStats(s, M).spendable, 46000);
  assert.equal(B.monthStats(s, '2026-12').stock, 0);
});

test('negative result shows 0 spendable and the shortfall', () => {
  const s = base();
  op(s, 'income', 100); s.settings.reserve = 30000;
  const st = B.monthStats(s, M);
  assert.equal(st.spendable, 0); assert.equal(st.shortfall, 20000);
});

test('v1 data is migrated to v2 with market data off', () => {
  const v1 = { ...base(), version: 1, settings: { reserve: 0, globalCap: 0, alertPct: 80 } };
  for (const k of ['instruments', 'quotes', 'fx', 'requestLog']) delete v1[k];
  const s = B.validateState(v1);
  assert.equal(s.version, 2); assert.equal(s.settings.market.enabled, false); assert.deepEqual(s.instruments, []);
});

const ETF = 'IE00B4L5Y983', AAPL = 'US0378331005';
function withInstruments() {
  const s = base();
  B.saveInstrument(s, { isin: ETF, name: 'World', symbol: 'EUNL.DEX', currency: 'EUR' });
  B.saveInstrument(s, { isin: AAPL, name: 'Apple', symbol: 'AAPL', currency: 'usd' });
  return s;
}

test('P01: average-cost positions, sales capped by holding', () => {
  const s = withInstruments();
  assert.throws(() => B.saveInstrument(s, { isin: 'XX123', currency: 'EUR' }), /ISIN/);
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.addEnvelope(s, M, 120000);
  B.buyFromEnvelope(s, s.envelopes[0].id, 'b', `${M}-02`, 120000, 'achat', ETF, 10);
  B.addSale(s, 'b', ETF, `${M}-03`, 5, 70000);
  assert.deepEqual(B.positions(s), [{ accountId: 'b', isin: ETF, qty: 15, cost: 165000 }]);
  assert.throws(() => B.addSale(s, 'b', ETF, `${M}-04`, 16, 1000), /supérieure/);
  assert.equal(B.monthStats(s, M).spent, 0); // trades never touch the household budget
});

test('P01: valuation in euros with FX, stale quotes flagged', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.addHolding(s, 'b', AAPL, '2025-01-01', 2, 40000);
  B.setQuote(s, ETF, 104.5, '2026-10-30'); // Friday
  B.setQuote(s, AAPL, 268.3, '2026-11-02');
  let [etf, apple] = B.valuation(s, '2026-11-02'); // Monday
  assert.equal(etf.value, 104500); assert.equal(etf.gain, 4500); assert.equal(etf.stale, false);
  assert.equal(apple.value, null); assert.equal(apple.stale, true); // no FX rate yet
  s.fx.USD = { rate: 1.1179, asOf: '2026-11-02' };
  [etf, apple] = B.valuation(s, '2026-11-03');
  assert.equal(apple.value, Math.round((2 * 268.3 * 100) / 1.1179)); assert.equal(apple.stale, false);
  assert.equal(etf.stale, true); // Friday close seen on Tuesday
});

const T = '2026-11-03', CW8 = 'LU1681043599';
const dateBack = n => new Date(Date.parse(T) - n * 864e5).toISOString().slice(0, 10);
const closes = (end, slope) => Array.from({ length: 100 }, (_, k) => [dateBack(99 - k), Math.round((end - slope * (99 - k)) * 100) / 100]);

test('P01: refresh is opt-in, stores 100 days of closes, logs hosts without the key, one call per day', async () => {
  const { refreshMarket } = await import('./market.js');
  const s = withInstruments(), calls = [];
  await assert.rejects(refreshMarket(s, T, () => assert.fail()), /désactivées/);
  Object.assign(s.settings.market, { enabled: true, avKey: 'SECRETKEY' });
  const series = Object.fromEntries(Array.from({ length: 120 }, (_, k) => [dateBack(119 - k), { '4. close': String(104.5 - 0.1 * (119 - k)) }]));
  const fake = async url => {
    calls.push(url);
    const body = url.includes('frankfurter') ? { date: T, rates: { USD: 1.12 } }
      : url.includes('AAPL') ? { Information: 'rate limit' } : { 'Time Series (Daily)': series };
    return { ok: true, json: async () => body };
  };
  const errors = await refreshMarket(s, T, fake);
  assert.equal(s.quotes[ETF].price, 104.5); assert.equal(s.quotes[ETF].asOf, T); assert.equal(s.history[ETF].length, 120); // up to a year is kept
  assert.equal(s.fx.USD.rate, 1.12);
  assert.match(errors.join(), /rate limit/);
  assert.ok(!JSON.stringify(s.requestLog).includes('SECRETKEY'));
  const n = calls.length;
  await refreshMarket(s, T, fake);
  assert.equal(calls.length, n + 1); // only the failed AAPL quote is retried
});

test('Refresh spends the daily quota on the biggest positions first', async () => {
  const { refreshMarket } = await import('./market.js');
  const s = withInstruments(), calls = [];
  B.addHolding(s, 'b', ETF, '2025-01-01', 1, 10000);
  B.addHolding(s, 'b', AAPL, '2025-01-01', 1, 90000);
  Object.assign(s.settings.market, { enabled: true, avKey: 'K' });
  await refreshMarket(s, T, async url => { calls.push(url); return { ok: true, json: async () => (url.includes('frankfurter') ? { rates: {} } : { Information: 'quota' }) }; });
  assert.match(calls.find(u => u.includes('alphavantage')), /symbol=AAPL/); // 900 € line before the 100 € one
});

test('Market scan: the tool picks its own ideas from news trends and price history, within the daily quota', async () => {
  const { discover, toAv, SCAN_CALLS } = await import('./market.js');
  const s = withInstruments(); // already follows EUNL.DEX and AAPL
  await assert.rejects(discover(s, T, () => assert.fail()), /Activez/);
  Object.assign(s.settings.market, { enabled: true, avKey: 'K', newsKey: 'N' });
  const rising = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [dateBack(99 - k), { '4. close': String(50 + 0.2 * k) }]));
  let trending = [
    { key: 'AAPL', total_documents: 90, sentiment_avg: 0.5 }, // already followed
    { key: 'NVDA', total_documents: 80, sentiment_avg: 0.4 },
    { key: 'MC.PA', total_documents: 30, sentiment_avg: 0.3 },
    { key: 'BP.L', total_documents: 50, sentiment_avg: 0.5 }, // London: not priced by the app
    { key: 'XOM', total_documents: 40, sentiment_avg: -0.3 }, // negative tone
    ...['TA', 'TB', 'TC', 'TD', 'TE', 'TF'].map(key => ({ key, total_documents: 6, sentiment_avg: 0.2 }))];
  const calls = [];
  const fake = async url => {
    calls.push(url);
    const body = url.includes('trending') ? { data: trending }
      : url.includes('entity/search') ? { data: [{ symbol: 'NVDA', name: 'NVIDIA Corporation' }, { symbol: 'MC.PA', name: 'LVMH' }] }
        : { 'Time Series (Daily)': rising };
    return { ok: true, json: async () => body };
  };
  assert.deepEqual(await discover(s, T, fake), []);
  const ideas = s.instruments.filter(i => i.auto);
  assert.equal(ideas.length, SCAN_CALLS); assert.equal(s.avCalls.n, SCAN_CALLS);
  assert.deepEqual(ideas.slice(0, 2).map(i => [i.isin, i.name, i.currency]), [['NVDA', 'NVIDIA Corporation', 'USD'], ['MC.PAR', 'LVMH', 'EUR']]);
  const v = verdict(s, 'MC.PAR'); // rising price + positive coverage
  assert.equal(v.action, 'Acheter'); assert.ok(v.reasons.some(r => /Repéré par l’outil : 30 articles/.test(r.text) && r.source === 'Marketaux'));
  const n = calls.length;
  await discover(s, T, fake); assert.equal(calls.length, n); // once a day
  B.addHolding(s, 'b', 'MC.PAR', T, 1, 7000); // the idea was bought
  trending = trending.slice(0, 2);
  await discover(s, '2026-11-04', fake);
  assert.deepEqual(s.instruments.filter(i => i.auto).map(i => i.isin), ['MC.PAR', 'NVDA']); // yesterday's ideas replaced, the bought one kept
  assert.deepEqual([toAv('BP.L'), toAv('SAP.DE')], [undefined, { symbol: 'SAP.DEX', currency: 'EUR' }]);
});

test('Market scan falls back to recent market articles when the trending endpoint is not in the plan', async () => {
  const { discover } = await import('./market.js');
  const s = withInstruments();
  Object.assign(s.settings.market, { enabled: true, avKey: 'K', newsKey: 'N' });
  const rising = Object.fromEntries(Array.from({ length: 100 }, (_, k) => [dateBack(99 - k), { '4. close': String(50 + 0.2 * k) }]));
  const fake = async url => {
    if (url.includes('trending')) return { ok: false, status: 402 };
    const body = url.includes('news/all') ? { data: [{ entities: [{ type: 'equity', symbol: 'SAP.DE', sentiment_score: 0.6 }, { type: 'index', symbol: 'DAX' }] }] }
      : url.includes('frankfurter') ? { date: T, rates: {} } : { 'Time Series (Daily)': rising };
    return { ok: true, json: async () => body };
  };
  await discover(s, T, fake);
  assert.deepEqual(s.instruments.filter(i => i.auto).map(i => i.isin), ['SAP.DEX']);
});

test('Own price service: listing found from the ISIN (OpenFIGI for US ISINs), currency from the listing, no quota', async () => {
  const { refreshMarket, pickFromFigi } = await import('./market.js');
  const s = withInstruments(); // an Irish ETF and Apple, both looked up by ISIN
  B.addHolding(s, 'b', AAPL, '2025-01-01', 3, 60000);
  Object.assign(s.settings.market, { enabled: true, proxyUrl: 'https://prix.example.workers.dev/', proxyKey: 'secret' });
  const seen = [];
  const fake = async (url, init) => {
    seen.push([url.replace('https://prix.example.workers.dev', ''), init?.headers?.['x-key']]);
    const p = new URL(url).pathname, body = p === '/search' ? [] // Yahoo does not know US ISINs
      : p === '/figi' ? (url.includes(AAPL) ? [{ ticker: 'APC', exchCode: 'GR' }, { ticker: 'AAPL', exchCode: 'US' }] : [{ ticker: 'EUNL', exchCode: 'GY' }])
        : p === '/chart' ? { currency: 'USD', closes: closes(270, 0.1) } : { date: T, rates: { USD: 1.12 } };
    return { ok: true, json: async () => body };
  };
  assert.deepEqual(await refreshMarket(s, T, fake), []);
  const apple = s.instruments.find(i => i.isin === AAPL), etf = s.instruments.find(i => i.isin === ETF);
  assert.equal(apple.ysym, 'AAPL'); assert.equal(etf.ysym, 'EUNL.DE'); assert.equal(etf.currency, 'USD'); // currency comes from the listing
  assert.equal(s.quotes[AAPL].source, 'Yahoo (service perso)'); assert.equal(s.history[AAPL].length, 100);
  assert.ok(seen.filter(([u]) => u.startsWith('/')).every(([, k]) => k === 'secret'));
  assert.equal(pickFromFigi([{ ticker: 'EI4', exchCode: 'GR' }, { ticker: '9684', exchCode: 'JT' }], 'JP3164630000'), '9684.T');
  // a wrong password is reported once, in plain words
  const denied = await refreshMarket(withInstrumentsOn(s.settings.market), T, async u => (u.includes('frankfurter') ? { ok: true, json: async () => ({ rates: {} }) } : { ok: false, status: 401 }));
  assert.deepEqual(denied, ['World : Service de cours : mot de passe refusé']);
});
const withInstrumentsOn = market => { const s = withInstruments(); Object.assign(s.settings.market, market); return s; };

test('Adding a title: name search gives symbol, type and currency; no ISIN needed; news searched by name or index', async () => {
  const { searchSymbols } = await import('./market.js');
  const s = base();
  await assert.rejects(searchSymbols(s, 'total', () => assert.fail()), /Activez/);
  Object.assign(s.settings.market, { enabled: true, avKey: 'K' });
  const [r] = await searchSymbols(s, 'total', async () => ({ ok: true, json: async () => ({ bestMatches: [
    { '1. symbol': 'TTE.PAR', '2. name': 'TotalEnergies SE', '3. type': 'Equity', '4. region': 'Paris', '8. currency': 'EUR' }] }) }));
  assert.deepEqual(r, { symbol: 'TTE.PAR', name: 'TotalEnergies SE', type: 'Equity', region: 'Paris', currency: 'EUR' });
  assert.equal(B.saveInstrument(s, { symbol: r.symbol, name: r.name, currency: r.currency, type: r.type }), 'TTE.PAR');
  assert.equal(B.newsQuery(s.instruments[0]), 'TotalEnergies');
  assert.equal(B.newsQuery({ name: 'iShares Core MSCI World UCITS ETF USD (Acc)' }), 'MSCI World');
});

function p03(cash) {
  const s = withInstruments();
  B.saveInstrument(s, { isin: CW8, name: 'CW8', symbol: 'CW8.PAR', currency: 'EUR' });
  s.accounts[1].opening = cash;
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setQuote(s, ETF, 104.5, T); B.setQuote(s, CW8, 561.2, T);
  s.settings.profile.targets = { [ETF]: 60, [CW8]: 40 };
  return s;
}
const verdict = (s, isin) => B.suggestions(s, T).find(x => x.isin === isin);

test('Verdict: the under-target title gets the envelope purchase, fees included, within envelope and cash', () => {
  const s = p03(500000);
  B.addEnvelope(s, M, 120000);
  assert.equal(verdict(s, ETF).action, 'Alléger'); // 100 % held vs 60 % target
  let v = verdict(s, CW8);
  assert.equal(v.action, 'Acheter'); assert.equal(v.buy.qty, 2); assert.equal(v.buy.total, 2 * 56120 + 195); // Fortuneo's estimated fee
  s.accounts[1].opening = 60000; // cash now lower than the envelope
  v = verdict(s, CW8);
  assert.equal(v.buy.qty, 1); assert.ok(v.buy.total <= 60000); assert.match(v.reasons.at(-1).text, /encaisse/);
  s.accounts[1].opening = 50000;
  v = verdict(s, CW8);
  assert.equal(v.buy, undefined); assert.match(v.reasons.at(-1).text, /insuffisant/);
});

test('Verdict: with 100 € a fractional-share account buys part of an expensive share; unknown cash does not block', () => {
  const s = p03(0);
  s.settings.profile.targets = { [CW8]: 100 }; // CW8 at 561,20 € is the buy candidate
  B.addEnvelope(s, M, 10000);
  assert.match(verdict(s, CW8).reasons.at(-1).text, /insuffisant/); // whole shares only, and 0 € known cash
  s.accounts.push({ id: 't', name: 'TR', institution: 'TR', opening: 0, liquid: false, savings: false, fractional: true });
  B.applySnapshot(s, 't', { date: '2026-11-01', lines: [] }, 'test'); // a brokerage account whose cash the app does not know
  const v = verdict(s, CW8);
  assert.equal(v.buy.accountId, 't'); assert.equal(v.buy.qty, 0.176); assert.ok(v.buy.total <= 10000);
  assert.match(v.reasons.at(-1).text, /0,176 part sur TR .*encaisse inconnue/);
});

test('Verdict: a non-EUR purchase includes conversion cost and stays within the limit', () => {
  const s = p03(500000);
  s.settings.profile.targets = { [AAPL]: 100 };
  B.setQuote(s, AAPL, 268.3, T); s.fx.USD = { rate: 1.1179, asOf: T, source: 'BCE' };
  B.addEnvelope(s, M, 100000);
  const v = verdict(s, AAPL);
  assert.equal(v.action, 'Acheter'); assert.equal(v.buy.qty, 4); assert.ok(v.buy.total <= 100000);
});

test('Verdict: stale or missing data suspends instead of guessing', () => {
  const s = p03(500000);
  B.addHolding(s, 'b', AAPL, '2025-01-01', 2, 40000);
  B.setQuote(s, AAPL, 268.3, '2026-10-20'); s.fx.USD = { rate: 1.12, asOf: T };
  B.addEnvelope(s, M, 120000);
  assert.equal(verdict(s, AAPL).action, 'Suspendu');
  const c = verdict(s, CW8);
  assert.equal(c.action, 'Attendre'); assert.equal(c.buy, undefined); assert.match(c.reasons[0].text, /non calculée/);
});

test('Verdict: trend and news tone are merged into one conclusion for a new title, each reason dated and sourced', () => {
  const s = withInstruments();
  B.setHistory(s, ETF, closes(104.5, 0.1), 'Alpha Vantage', T); // rising: above its 50-day average, +6,4 % over 3 months
  let v = verdict(s, ETF);
  assert.equal(v.score, 1.5); assert.equal(v.action, 'Attendre');
  assert.ok(v.reasons.some(r => r.pts === 1 && r.asOf === T && r.source === 'Alpha Vantage'));
  for (const k of [1, 2]) B.addNews(s, ETF, { title: `Bonne nouvelle ${k}`, url: `https://ex.com/${k}`, source: 'ex.com', publishedAt: '2026-11-02', sentiment: 0.5 }, T);
  v = verdict(s, ETF);
  assert.equal(v.score, 2.5); assert.equal(v.action, 'Acheter');
  for (const n of s.news) n.sentiment = -0.6;
  assert.equal(verdict(s, ETF).action, 'Attendre');
});

test('Verdict: risk limits of the profile on held titles — trailing stop, max loss — else hold', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setHistory(s, ETF, [...closes(120, 0).slice(0, 99), [T, 104.5]], 'Alpha Vantage', T); // -12,9 % from its high, +4,5 % gain
  s.settings.profile.horizon = 3;
  assert.equal(verdict(s, ETF).action, 'Vendre'); // below average (−1) + trailing stop (−2)
  s.settings.profile.horizon = 10;
  assert.equal(verdict(s, ETF).action, 'Conserver');
  B.setQuote(s, ETF, 79, T); // −21 % vs cost, limit 20 % for « équilibré »
  assert.equal(verdict(s, ETF).action, 'Vendre');
  s.settings.profile.risk = 'dynamique';
  assert.equal(verdict(s, ETF).action, 'Conserver');
  s.settings.profile.risk = 'equilibre';
  B.setHistory(s, ETF, [...closes(60, -0.1).slice(0, 99), [T, 79]], 'Alpha Vantage', T); // rising trend, but still −21 % vs cost
  const v = verdict(s, ETF);
  assert.ok(v.score >= -0.5); assert.equal(v.action, 'Alléger'); // the loss limit is never outvoted into « Conserver »
});

test('P02: news is opt-in, searched by name, web links only, tone kept, one call per title per day, key never logged', async () => {
  const { refreshNews } = await import('./market.js');
  const s = withInstruments(), calls = [];
  await assert.rejects(refreshNews(s, T, () => assert.fail()), /désactivées/);
  s.settings.market.enabled = true;
  assert.match((await refreshNews(s, T, () => assert.fail())).join(), /Marketaux manquante/);
  s.settings.market.newsKey = 'NEWSKEY';
  const fake = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: url.includes('World') ? [
      { title: 'Fusion annoncée', url: 'https://ex.com/a', source: 'ex.com', published_at: '2026-11-02T08:00:00Z', entities: [{ sentiment_score: 0.4 }, { sentiment_score: 0.2 }] },
      { title: 'Piège', url: 'javascript:alert(1)', source: 'x', published_at: '2026-11-02' },
      { title: 'Vieux', url: 'https://ex.com/old', source: 'ex.com', published_at: '2026-09-01' }] : [] }) };
  };
  assert.deepEqual(await refreshNews(s, T, fake), []);
  assert.ok(calls[0].includes('search=%22World%22'));
  assert.deepEqual(s.news.map(n => [n.url, Math.round(n.sentiment * 10) / 10]), [['https://ex.com/a', 0.3]]); // bad link rejected, >30 days pruned
  await refreshNews(s, T, fake);
  assert.equal(calls.length, 2); // one per title, not repeated the same day
  assert.ok(!JSON.stringify(s.requestLog).includes('NEWSKEY'));
});

test('Verdict: a notable headline from the last 14 days asks for review, with its source and date', () => {
  const s = withInstruments();
  B.setQuote(s, ETF, 104.5, T);
  B.addNews(s, ETF, { title: 'Index change for the fund', url: 'https://ex.com/1', source: 'ex.com', publishedAt: '2026-11-01' }, T);
  B.addNews(s, ETF, { title: 'Merger completed', url: 'https://ex.com/2', source: 'ex.com', publishedAt: '2026-10-01' }, T);
  const v = verdict(s, ETF);
  assert.equal(v.action, 'À examiner');
  assert.deepEqual(v.reasons.filter(r => /À lire/.test(r.text)).map(r => [r.asOf, r.source]), [['2026-11-01', 'ex.com']]);
});

// Columns named after IBKR Flex Query "Trades" fields; synthetic values.
const FLEX = [
  '"ClientAccountID","CurrencyPrimary","FXRateToBase","AssetClass","Symbol","Description","ISIN","TradeID","TradeDate","Quantity","TradePrice","IBCommission","NetCash","Buy/Sell"',
  '"U0000000","USD","0.9","STK","AAPL","APPLE INC","US0378331005","111","20261002","3","268.3","-1","-805.9","BUY"',
  '"U0000000","EUR","1","STK","EUNL","ISHARES CORE MSCI WORLD","IE00B4L5Y983","112","20261015","10","104.5","-1.25","-1046.25","BUY"',
  '"U0000000","EUR","1","STK","EUNL","ISHARES CORE MSCI WORLD","IE00B4L5Y983","113","20261020","-4","106","-1.25","422.75","SELL"',
  '"U0000000","USD","0.9","CASH","EUR.USD","EUR.USD","","114","20261002","800","1.11","-2","-720","BUY"',
  '"U0000000","EUR","1","STK","BAD","BAD","NOTANISIN","115","20261021","1","10","0","-10","BUY"',
].join('\n');

test('Broker import: IBKR Flex trades become positions, FX rows ignored, re-import creates no duplicate', () => {
  const s = withInstruments();
  const { rows, errors, ignored } = B.parseTradesCsv(FLEX);
  assert.deepEqual(errors, [6]); assert.deepEqual(ignored, [5]);
  assert.deepEqual(rows[0], { date: '2026-10-02', isin: AAPL, qty: 3, amount: -72531, currency: 'USD', name: 'APPLE INC', symbol: 'AAPL', tradeId: '111' });
  assert.equal(B.importTrades(s, 'b', B.tradesPreview(s, 'b', rows), T), 3);
  const pos = Object.fromEntries(B.positions(s).map(p => [p.isin, p]));
  assert.equal(pos[ETF].qty, 6); assert.equal(pos[ETF].cost, 62775); // 104625 × 6/10
  assert.equal(pos[AAPL].cost, 72531);
  assert.equal(B.balance(s, s.accounts[1]), -72531 - 104625 + 42275);
  assert.equal(B.monthStats(s, '2026-10').spent, 0); // trades stay out of the household budget
  const again = B.tradesPreview(s, 'b', rows);
  assert.ok(again.every(r => r.dup === 'déjà importée' && !r.keep));
});

test('Broker import: template (TR / Fortuneo) in French format; manual entry of the same trade is flagged', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2026-11-03', 2, 21040);
  const csv = B.TRADES_TEMPLATE + '04/11/2026;FR0000120271;TotalEnergies;Achat;5;-291,50;EUR;\n';
  const { rows, errors } = B.parseTradesCsv(csv);
  assert.deepEqual(errors, []);
  const prev = B.tradesPreview(s, 'b', rows);
  assert.equal(prev[0].dup, 'saisie manuelle identique'); assert.equal(prev[0].keep, false);
  assert.equal(prev[1].newInstrument, true);
  B.importTrades(s, 'b', prev, T);
  assert.equal(s.instruments.find(i => i.isin === 'FR0000120271').name, 'TotalEnergies');
  assert.equal(B.positions(s).find(p => p.isin === 'FR0000120271').cost, 29150);
});

// Same columns as Trade Republic's « Exportation de transactions »; fictional values.
const TR_HEAD = '"datetime","date","account_type","category","type","asset_class","name","symbol","shares","price","amount","fee","tax","currency","original_amount","original_currency","fx_rate","description","transaction_id","counterparty_name","counterparty_iban","payment_reference","mcc_code"';
const tr = (date, cat, type, name, isin, shares, amount, fee, tax, ccy, id, desc = '') =>
  `"${date}T10:00:00Z","${date}","DEFAULT","${cat}","${type}","","${name}","${isin}","${shares}","","${amount}","${fee}","${tax}","${ccy}","","","","${desc}","${id}","","","",""`;
const TR_CSV = [TR_HEAD,
  tr('2026-10-01', 'CASH', 'TRANSFER_INSTANT_INBOUND', '', '', '', '500.000000', '', '', 'EUR', 't1', 'Incoming transfer'),
  tr('2026-10-02', 'TRADING', 'BUY', 'NVIDIA', 'US67066G1040', '2.0000000000', '-200.00', '-1.00', '', 'EUR', 't2'),
  tr('2026-10-03', 'DELIVERY', 'FREE_RECEIPT', 'NVIDIA', 'US67066G1040', '-2.0000000000', '', '', '', '', 't3'),
  tr('2026-10-03', 'DELIVERY', 'FREE_RECEIPT', 'NVIDIA', 'US67066G1040', '2.0000000000', '', '', '', '', 't4'),
  tr('2026-10-05', 'TRADING', 'SELL', 'NVIDIA', 'US67066G1040', '1.0000000000', '120.00', '-1.00', '-2.00', 'EUR', 't5'),
  tr('2026-10-06', 'CASH', 'DIVIDEND', 'NVIDIA', 'US67066G1040', '1.0000000000', '1.10', '', '-0.52', 'EUR', 't6'),
  tr('2026-11-02', 'CASH', 'CARD_TRANSACTION', 'LIBRAIRIE', '', '', '-24.99', '', '', 'EUR', 't7'),
  tr('2026-11-02', 'CASH', 'CARD_ORDERING_FEE', '', '', '', '0.000000', '-50.00', '', 'EUR', 't8', 'Card'),
  tr('2026-11-03', 'CASH', 'INTEREST_PAYMENT', '', '', '', '0.000000', '', '', 'EUR', 't9'),
  tr('2026-11-03', 'CASH', 'DIVIDEND', 'X', 'US0000000001', '1', '1.00', '', '', 'USD', 't10'),
].join('\n');

test('Trade Republic export: trades rebuild the position, cash moves stay at the broker, card payments are household spending', () => {
  const s = base();
  const { rows, errors, ignored } = B.parseTradesCsv(TR_CSV);
  assert.deepEqual(errors, [11]); // a non-EUR line is refused rather than misread
  assert.deepEqual(ignored, [4, 5, 10]); // the −2/+2 transfer pair cancels out; a zero line is skipped
  assert.equal(B.importTrades(s, 'b', B.tradesPreview(s, 'b', rows), T), 6);
  assert.deepEqual(B.positions(s), [{ accountId: 'b', isin: 'US67066G1040', qty: 1, cost: 10050 }]);
  assert.equal(B.balance(s, s.accounts[1]), 50000 - 20100 + 11700 + 58 - 2499 - 5000);
  assert.equal(B.monthStats(s, '2026-10').income, 0); // deposit and dividend are not household income
  assert.equal(B.monthStats(s, '2026-11').spent, 2499 + 5000);
  assert.ok(B.tradesPreview(s, 'b', rows).every(r => r.dup === 'déjà importée'));
});

// Same layout as Fortuneo's « Export portefeuille simple » once read from the .xls; fictional values.
const FORTUNEO = [
  ['Portefeuille 000000000000'], ['(PEA M TEST)'], ['03/11/2026'], [''],
  ['Libellé', 'Cours', '', 'Dev', 'Var/Veille', 'Qté', 'PRU', 'Valorisation', '+/- values', '+/- values (%)', 'Poids', 'ISIN'],
  ['TOTALENERGIES (TTE)', 60, 'V', 'EUR', 0, 10, 50, 600, 100, 0.2, 0.5, 'FR0000120271'],
  ['Coca-Cola (KO)', 100, '', 'USD', 0.01, 5, 80, 450, 90, 0.25, 0.4, 'US1912161007'],
  ['Square Enix (EI4)', 20, '', 'EUR', 0, 3, 25, 60, -15, -0.2, 0.1, 'JP3164630000'],
  ['Ligne illisible', 'n/a', '', 'EUR', 0, 1, 1, 1, 0, 0, 0, 'BAD'],
];

test('Fortuneo snapshot: positions, cost, dated price and implied exchange rate; a re-import replaces it; later trades add', () => {
  const s = base();
  const snap = B.parseFortuneoRows(FORTUNEO);
  assert.equal(snap.date, T); assert.equal(snap.kind, 'PEA'); assert.deepEqual(snap.errors, [9]);
  assert.deepEqual(snap.lines[1], { isin: 'US1912161007', name: 'Coca-Cola', ticker: 'KO', currency: 'USD', qty: 5, price: 100, value: 45000, cost: 36000 });
  B.applySnapshot(s, 'b', snap, 'Fortuneo');
  assert.deepEqual(s.instruments.map(i => i.symbol), ['TTE.PAR', 'KO', '']); // ticker turned into a price symbol when it can be guessed
  assert.deepEqual(s.quotes['FR0000120271'], { price: 60, currency: 'EUR', asOf: T, source: 'Fortuneo', fetchedAt: T });
  assert.equal(Math.round(s.fx.USD.rate * 1e4) / 1e4, 1.1111);
  const v = Object.fromEntries(B.valuation(s, T).map(l => [l.isin, l]));
  assert.equal(v['US1912161007'].value, 45000); assert.equal(v['US1912161007'].gain, 9000); assert.equal(v['FR0000120271'].cost, 50000);
  B.addEnvelope(s, M, 10000);
  B.buyFromEnvelope(s, s.envelopes[0].id, 'b', '2026-11-03', 6100, 'achat saisi après l’import, même jour', 'FR0000120271', 1);
  B.buyFromEnvelope(s, s.envelopes[0].id, 'b', '2026-11-04', 3000, 'achat après l’export', 'JP3164630000', 1);
  B.addSale(s, 'b', 'US1912161007', '2026-11-03', 5, 46000); // everything sold the day of the export, recorded after the import
  const pos = Object.fromEntries(B.positions(s).map(p => [p.isin, p.qty]));
  assert.deepEqual(pos, { FR0000120271: 11, JP3164630000: 4 });
  B.applySnapshot(s, 'b', { ...snap, date: '2026-11-04', lines: snap.lines.slice(0, 1) }, 'Fortuneo'); // newer export already includes them
  assert.deepEqual(B.positions(s).map(p => [p.isin, p.qty]), [['FR0000120271', 10]]);
});

test('Deleting a title removes its trades, snapshot line, price, news and target', () => {
  const s = withInstruments();
  B.applySnapshot(s, 'b', B.parseFortuneoRows(FORTUNEO), 'Fortuneo');
  B.addHolding(s, 'b', ETF, '2025-01-01', 1, 10000);
  B.addNews(s, ETF, { title: 'x', url: 'https://ex.com/x', source: 'ex.com', publishedAt: T }, T);
  s.settings.profile.targets[ETF] = 50;
  B.deleteInstrument(s, ETF); B.deleteInstrument(s, 'FR0000120271');
  assert.deepEqual(B.positions(s).map(p => p.isin), ['US1912161007', 'JP3164630000']);
  assert.ok(!s.instruments.some(i => i.isin === ETF) && !s.quotes['FR0000120271'] && !s.news.length && !(ETF in s.settings.profile.targets));
});

test('Notifications: a verdict is announced when it changes, budget alerts once a month, many verdicts as one summary', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setHistory(s, ETF, [...closes(120, 0).slice(0, 99), [T, 104.5]], 'Alpha Vantage', T);
  s.settings.profile.horizon = 3; // trailing stop → « Vendre »
  op(s, 'income', 1000); op(s, 'expense', 950); // 50 € left, under the 100 € threshold
  let p = B.pendingNotifications(s, T);
  assert.deepEqual(p.map(x => x.title), ['Vendre : World', 'Pouvoir d’achat presque atteint']);
  assert.match(p[1].body, /50,00 €/);
  B.markNotified(s, p, T);
  assert.deepEqual(B.pendingNotifications(s, T), []); // nothing new, nothing sent
  s.settings.profile.horizon = 10; // → « Conserver »: not something to act on, not announced
  assert.deepEqual(B.pendingNotifications(s, T), []);
  B.markNotified(s, [], T);
  s.settings.profile.horizon = 3; // back to « Vendre »: a change again
  assert.deepEqual(B.pendingNotifications(s, T).map(x => x.title), ['Vendre : World']);
  for (const k of [1, 2, 3, 4]) { // five sell signals at once → one summary
    const id = `XX000000000${k}`;
    B.saveInstrument(s, { isin: id, name: `T${k}`, currency: 'EUR' });
    B.addHolding(s, 'b', id, '2025-01-01', 10, 100000);
    B.setHistory(s, id, [...closes(120, 0).slice(0, 99), [T, 104.5]], 'Alpha Vantage', T);
  }
  p = B.pendingNotifications(s, T);
  assert.equal(p.length, 1); assert.equal(p[0].title, '5 avis bourse'); assert.match(p[0].body, /^Vendre : World, T1, T2, T3, T4$/);
});

test('Purchase goes to the PEA when the title is eligible, never a US stock; fees compared across brokers', () => {
  const s = withInstruments();
  B.saveInstrument(s, { isin: CW8, name: 'CW8', symbol: 'CW8.PAR', currency: 'EUR' });
  s.accounts.push(
    { id: 'pea', name: 'Fortuneo PEA', institution: 'Fortuneo', opening: 0, liquid: false, savings: false, type: 'PEA', feeFixed: 195 },
    { id: 'tr', name: 'Trade Republic', institution: 'TR', opening: 0, liquid: false, savings: false, type: 'CTO', feeFixed: 100, fractional: true },
    { id: 'ib', name: 'IBKR', institution: 'IBKR', opening: 0, liquid: false, savings: false, type: 'CTO', feeFixed: 300, fxPct: 0.03 });
  B.setQuote(s, CW8, 561.2, T); B.setQuote(s, AAPL, 268.3, T); s.fx.USD = { rate: 1.12, asOf: T };
  B.addEnvelope(s, M, 120000);
  s.settings.profile.targets = { [CW8]: 100 };
  let v = verdict(s, CW8);
  assert.equal(v.buy.accountId, 'pea'); assert.equal(v.buy.qty, 2); assert.equal(v.buy.fees, 195);
  assert.match(v.reasons.at(-2).text, /Fortuneo PEA \(PEA : moins d’impôts/);
  assert.match(v.reasons.at(-1).text, /Trade Republic 1,00 € · IBKR 3,00 €/);
  s.settings.profile.targets = { [AAPL]: 100 }; // US stock: not eligible to a PEA
  v = verdict(s, AAPL);
  assert.notEqual(v.buy.accountId, 'pea');
  assert.ok(!v.reasons.some(r => /Fortuneo PEA/.test(r.text)));
});

test('A Fortuneo export tells the account type and its portfolio number', () => {
  const s = base();
  const snap = B.parseFortuneoRows(FORTUNEO);
  assert.equal(snap.portfolio, '000000000000');
  B.applySnapshot(s, 'b', snap, 'Fortuneo');
  assert.equal(s.accounts[1].type, 'PEA'); assert.equal(s.snapshots.b.portfolio, '000000000000');
});

test('Market scan does not suggest a company already followed under another listing', async () => {
  const { discover, companyWord } = await import('./market.js');
  assert.equal(companyWord('SONY ADR (SONY)'), companyWord('Sony Group Corporation'));
  const s = withInstruments();
  B.saveInstrument(s, { isin: 'JP3164630000', name: 'Square Enix', currency: 'EUR' });
  Object.assign(s.settings.market, { enabled: true, proxyUrl: 'https://p.example', newsKey: 'N' });
  const rising = closes(50, 0.2);
  const fake = async url => {
    const body = url.includes('trending') ? { data: [{ key: 'SQNXF', total_documents: 20, sentiment_avg: 0.4 }, { key: 'NVDA', total_documents: 10, sentiment_avg: 0.4 }] }
      : url.includes('entity/search') ? { data: [{ symbol: 'SQNXF', name: 'Square Enix Holdings Co., Ltd.' }, { symbol: 'NVDA', name: 'NVIDIA Corporation' }] }
        : url.includes('/chart') ? { currency: 'USD', closes: rising } : { date: T, rates: { USD: 1.1 } };
    return { ok: true, json: async () => body };
  };
  await discover(s, T, fake);
  assert.deepEqual(s.instruments.filter(i => i.auto).map(i => i.name), ['NVIDIA Corporation']);
});

test('Spending by category over a month or 12 months, and month by month', () => {
  assert.deepEqual(B.monthsBack('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  const s = base(), food = s.categories[1].id, fun = s.categories[5].id;
  const spend = (date, cents, categoryId, kind = 'expense') => B.saveOp(s, { accountId: 'a', date, kind, cents, categoryId });
  spend('2025-12-03', 5000, food); spend('2026-01-10', 12000, food); spend('2026-02-02', 3000, fun);
  spend('2026-02-05', 1000, food, 'refund'); spend('2026-02-06', 700, null);
  B.addTransfer(s, 'a', 'b', '2026-02-07', 50000); // not spending
  const feb = B.spendingByCategory(s, '2026-02', '2026-02');
  assert.deepEqual(feb.map(c => [c.name, c.spent]), [['Loisirs', 3000], ['Sans catégorie', 700]]); // food: refund only, nothing spent
  const year = B.spendingByCategory(s, '2025-03', '2026-02');
  assert.deepEqual(year.map(c => [c.name, c.spent, c.ops.length]), [['Alimentation', 16000, 3], ['Loisirs', 3000, 1], ['Sans catégorie', 700, 1]]);
  assert.deepEqual(B.monthlySpending(s, '2026-02', 3).map(x => x.spent), [5000, 12000, 2700]);
});

test('Broker fees left empty are estimated from the broker name', () => {
  const s = withInstruments();
  B.saveInstrument(s, { isin: CW8, name: 'CW8', symbol: 'CW8.PAR', currency: 'EUR' });
  s.accounts.push({ id: 'tr', name: 'TR', institution: 'Trade Republic', opening: 0, liquid: false, savings: false, type: 'CTO' });
  B.setQuote(s, CW8, 561.2, T); B.addEnvelope(s, M, 120000); s.settings.profile.targets = { [CW8]: 100 };
  s.settings.profile.fee = 500; // the profile's own guess is not used for a known broker
  const v = B.suggestions(s, T).find(x => x.isin === CW8);
  assert.equal(v.buy.accountId, 'tr'); assert.equal(v.buy.fees, 100);
  assert.equal(B.brokerFees('Interactive Brokers').fixed, 300); assert.equal(B.brokerFees('Banque BCP'), null);
});

test('Active style: take part of the profit after a strong rise, buy back on a dip inside a rising trend', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 80000); // bought 80 € a share
  s.settings.profile.style = 'actif';
  B.setHistory(s, ETF, [...closes(100, 0.1).slice(0, 99), [T, 115]], 'Alpha Vantage', T); // jumps 115 % of its average
  let v = verdict(s, ETF);
  assert.equal(v.action, 'Alléger'); assert.ok(v.reasons.some(r => /prendre une partie des bénéfices/.test(r.text) && /imposé à 30 %/.test(r.text)));
  s.settings.profile.style = 'long';
  assert.equal(verdict(s, ETF).action, 'Conserver'); // long term: no take-profit rule
  s.settings.profile.style = 'actif';
  B.setHistory(s, ETF, [...closes(100, 0.1).slice(0, 99), [T, 88]], 'Alpha Vantage', T); // dip ~10 % under its average, trend up since start
  v = verdict(s, ETF);
  assert.ok(v.reasons.some(r => /occasion de \(r\)acheter/.test(r.text)));
  assert.equal(v.action, 'Renforcer');
});

test('Test C — a line over the concentration limit is never reinforced, and a purchase never passes the limit', () => {
  const s = p03(500000); // ETF held 10 × 104,50 €, CW8 followed
  B.addHolding(s, 'b', CW8, '2025-01-01', 20, 1000000); // CW8: 20 × 561,20 € → ETF weighs about 8,5 %
  s.settings.profile.targets = { [ETF]: 60, [CW8]: 40 }; s.settings.profile.maxWeight = 5;
  const v = verdict(s, ETF);
  assert.notEqual(v.action, 'Renforcer'); assert.ok(v.reasons.some(r => /au-delà de votre limite de 5 %/.test(r.text)));
  B.addEnvelope(s, M, 100000);
  assert.ok(!B.suggestions(s, T).some(x => x.isin === ETF && x.buy)); // no room left for the ETF
});

test('Test E — a 10-for-1 split multiplies the quantity, divides the unit cost, leaves the value; a sale books its realized gain', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 5, 50000); // 5 × 100 €
  B.setQuote(s, ETF, 120, T);
  const before = B.valuation(s, T)[0].value;
  B.addSplit(s, 'b', ETF, '2026-06-10', 10);
  B.setQuote(s, ETF, 12, T); // the listing price is divided too
  const [p] = B.positions(s);
  assert.equal(p.qty, 50); assert.equal(p.cost, 50000); assert.equal(B.valuation(s, T)[0].value, before);
  B.addSale(s, 'b', ETF, '2026-07-01', 10, 15000); // sells 10 for 150 € that cost 100 €
  assert.equal(B.realizedGain(s, ETF), 5000); assert.equal(B.positions(s)[0].cost, 40000);
  assert.throws(() => B.addSplit(s, 'b', ETF, T, 1), /Ratio/);
});

test('Indicators from one year of prices, and the conclusion frame (missing data, invalidation, confidence)', () => {
  const s = withInstruments();
  const year = Array.from({ length: 252 }, (_, k) => [dateBack(251 - k), 100 + k * 0.2 + (k % 2 ? 1 : -1)]); // rising, zigzag
  B.setHistory(s, ETF, year, 'Yahoo', T);
  const ind = B.indicators(s, ETF);
  assert.equal(ind.days, 252); assert.ok(ind.sma200 < ind.sma50 && ind.sma50 < ind.last);
  assert.ok(ind.rsi > 50 && ind.rsi < 100); assert.ok(ind.drawdown <= 0 && ind.drawdown > -2); assert.ok(ind.vol > 0);
  const v = verdict(s, ETF);
  assert.match(v.invalidation, /moyenne 200 jours/);
  assert.ok(v.missing.some(m => /Fondamentaux/.test(m)) && !v.missing.some(m => /200 jours indisponible/.test(m)));
  assert.equal(v.confidence, 'Moyenne'); // a year of prices, but no news tone yet
  assert.equal(B.indicators(s, AAPL), null);
});

test('demo data reproduces the spec figures', () => {
  const demo = B.validateState(B.demoState('2026-11-03')), st = B.monthStats(demo, M);
  assert.equal(B.valuation(demo, '2026-11-03').filter(l => l.stale).length, 1);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000); assert.equal(st.spendable, 40000);
});
