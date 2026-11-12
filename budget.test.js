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
  s.settings.profile.maxWeight = 0; // these tests were written without a limit per line; the limit has its own tests
  return s;
}
const op = (s, kind, euros, extra = {}) => B.saveOp(s, { accountId: 'a', date: `${M}-02`, kind, cents: euros * 100, ...extra });

test('B02: à date / prévu, then reconciliation counts once', () => {
  const s = base();
  op(s, 'income', 2500); op(s, 'expense', 1200); op(s, 'expense', 500, { planned: true, label: 'Assurance' });
  let st = B.monthStats(s, M);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000);
  op(s, 'expense', 480, { label: 'Assurance' }); // the real payment, a little different from what was planned, settles it on its own
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
  assert.equal(s.ops.filter(o => /ssurance/i.test(o.label) && !o.planned).length, 1); // the paid-on-date line stands aside
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
  op(s, 'income', 2500); op(s, 'expense', 1200); op(s, 'expense', 500, { planned: true, label: 'Assurance' });
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
  // a price already « fetched today » but old is fetched again at the next refresh (it used to stay frozen all day)
  s.quotes[AAPL] = { ...s.quotes[AAPL], asOf: '2026-10-30', fetchedAt: T }; seen.length = 0;
  await refreshMarket(s, T, fake);
  assert.ok(seen.some(([u]) => u.startsWith('/chart'))); assert.equal(s.quotes[AAPL].asOf, s.history[AAPL].at(-1)[0]);
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
  assert.equal(v.buy.qty, 1); assert.ok(v.buy.total <= 60000); assert.match(v.reasons.at(-1).text, /espèces/);
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
  assert.match(v.reasons.at(-1).text, /0,176 part sur TR .*espèces inconnues/);
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

const spike = () => { const h = closes(100, 0); h[50] = [h[50][0], 120]; h[99] = [T, 104]; return h; }; // flat 100, one day at 120, now 104
test('Verdict: risk limits of the profile on held titles — trailing stop sells, max loss only alerts', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setHistory(s, ETF, [...closes(120, 0).slice(0, 99), [T, 104.5]], 'Alpha Vantage', T); // -12,9 % from its high, +4,5 % gain
  s.settings.profile.horizon = 3;
  assert.equal(verdict(s, ETF).action, 'Alléger'); assert.equal(verdict(s, ETF).order.qty, 5); // long term: the trailing stop sells half, never everything
  s.settings.profile.style = 'actif';
  assert.equal(verdict(s, ETF).action, 'Vendre'); // active style: below average (−1) + trailing stop (−2) → everything
  s.settings.profile.style = 'long';
  s.settings.profile.horizon = 10;
  assert.equal(verdict(s, ETF).action, 'Conserver');
  B.setQuote(s, ETF, 79, T); // −21 % vs cost, limit 20 % for « équilibré »
  let v = verdict(s, ETF);
  assert.equal(v.action, 'À examiner'); assert.equal(v.order.side, null); assert.equal(v.order.rule, 4); assert.match(v.order.text, /Aucune vente automatique/);
  s.settings.profile.risk = 'dynamique';
  assert.equal(verdict(s, ETF).action, 'Conserver');
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
  s.settings.profile.horizon = 3; s.settings.profile.style = 'actif'; // trailing stop + falling trend → « Vendre » (active style)
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
  assert.equal(v.action, 'Alléger'); assert.ok(v.reasons.some(r => /prendre une partie des bénéfices/.test(r.text) && /imposable/.test(r.text)));
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

test('Test B — simulator: 5 shares at 100 then 2 at 150 → 7 shares, average cost 114,2857; weight and scenarios', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 5, 50000); B.setQuote(s, ETF, 150, T);
  const r = B.simulate(s, T, ETF, 2, 150);
  assert.equal(r.newQty, 7); assert.equal(Math.round(r.pru * 10000) / 10000, 11428.5714); // cents per share: 114,2857 €
  assert.equal(r.weightBefore, 100); assert.equal(r.at.find(x => x.change === -20).gain, Math.round(7 * 120 * 100) - 80000);
  assert.equal(B.stressLoss(s, T, 20), 15000); // 750 € of value, −20 %
  B.addHolding(s, 'b', AAPL, '2025-01-01', 1, 20000); B.setQuote(s, AAPL, 220, T); s.fx.USD = { rate: 1.1, asOf: T };
  assert.equal(B.stressLoss(s, T, 0, 10), 2000); // only the dollar line moves: 200 € × 10 %
});

test('demo data reproduces the spec figures', () => {
  const demo = B.validateState(B.demoState('2026-11-03')), st = B.monthStats(demo, M);
  assert.equal(B.valuation(demo, '2026-11-03').filter(l => l.stale).length, 1);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000); assert.equal(st.spendable, 40000);
});

test('Decision journal: price and verdict kept at the time, reviewed against the current price', () => {
  const s = withInstruments();
  B.setQuote(s, ETF, 100, T);
  B.addDecision(s, T, ETF, 'achat', ' rebond attendu ', 'Renforcer');
  B.addDecision(s, T, ETF, 'passe');
  assert.throws(() => B.addDecision(s, T, ETF, 'bof'));
  B.setQuote(s, ETF, 110, T);
  const [a, b] = B.journalReview(s).sort((x, y) => (x.action < y.action ? -1 : 1));
  assert.equal(a.price, 100); assert.equal(a.note, 'rebond attendu'); assert.equal(a.verdict, 'Renforcer');
  assert.equal(Math.round(a.change), 10); assert.equal(a.right, true); assert.equal(b.right, false);
  B.deleteDecision(s, a.id); assert.equal(s.journal.length, 1);
  B.deleteInstrument(s, ETF); assert.equal(s.journal.length, 0);
});

test('Closed-app watch list: max-loss level per share in the listing currency, nothing for titles not held', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000); B.setQuote(s, ETF, 100, T);
  s.instruments.find(i => i.isin === ETF).ysym = 'SWDA.L';
  s.instruments.find(i => i.isin === AAPL).ysym = 'AAPL';
  s.settings.profile.risk = 'equilibre'; s.settings.profile.horizon = 10;
  const w = B.watchList(s, T);
  assert.equal(w.length, 1); assert.equal(w[0].s, 'SWDA.L'); assert.equal(w[0].move, 6);
  assert.deepEqual(w[0].rules.map(r => r.below), [80]); // 100 € per share, 20 % max loss
  assert.ok(!JSON.stringify(w).includes('100000'));
});

test('Automatic journal: each buy or sell advice is logged once with its price, again only when the advice changes', () => {
  const d = B.validateState(B.demoState(T)), act = B.suggestions(d, T).filter(x => !x.suspended && ['Acheter', 'Renforcer', 'Alléger', 'Vendre'].includes(x.action));
  assert.ok(act.length > 0);
  B.logVerdicts(d, T); B.logVerdicts(d, T);
  assert.equal(d.journal.length, act.length);
  const e = d.journal.find(j => j.isin === act[0].isin);
  assert.equal(e.verdict, act[0].action); assert.equal(e.price, d.quotes[act[0].isin].price);
  d.journal.at(-1).verdict = 'Conserver'; // a different earlier advice: the current one is logged again
  B.logVerdicts(d, T); assert.equal(d.journal.length, act.length + 1);
});

test('Account total: cash plus its own securities at the latest price, other accounts not mixed in', () => {
  const s = withInstruments(), b = s.accounts.find(a => a.id === 'b');
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 90000); B.setQuote(s, ETF, 100, T);
  const t = B.accountTotal(s, b, T);
  assert.equal(t.securities, 100000); assert.equal(t.total, B.balance(s, b) + 100000);
  const other = s.accounts.find(a => a.id !== 'b');
  assert.equal(B.accountTotal(s, other, T).securities, 0);
});

test('Cagnotte: the cash typed from the bank becomes the account balance, outside the household budget', () => {
  const s = B.demoState(T), a = s.accounts[0], before = B.balance(s, a), m = B.monthStats(s, T.slice(0, 7));
  assert.equal(B.setCash(s, a.id, T, before + 1250), 1250);
  assert.equal(B.balance(s, a), before + 1250);
  assert.equal(B.setCash(s, a.id, T, before + 1250), 0); // same amount: nothing added
  const n = s.ops.length; B.setCash(s, a.id, T, before - 500); assert.equal(B.balance(s, a), before - 500); assert.equal(s.ops.length, n + 1);
  assert.deepEqual([B.monthStats(s, T.slice(0, 7)).income, B.monthStats(s, T.slice(0, 7)).spent], [m.income, m.spent]);
  assert.throws(() => B.setCash(s, 'nope', T, 0));
});

test('Own purchase: new ISIN followed, position on the chosen broker, cash reduced, outside the household budget', () => {
  const s = B.demoState(T), a = s.accounts.at(-1), cash = B.balance(s, a), m = B.monthStats(s, T.slice(0, 7));
  const id = B.addPurchase(s, { accountId: a.id, isin: ' nl0010273215 ', name: 'ASML', date: T, qty: 2, cents: 40000 });
  assert.equal(id, 'NL0010273215'); assert.equal(s.instruments.find(i => i.isin === id).name, 'ASML');
  assert.deepEqual(B.positions(s).find(p => p.isin === id), { accountId: a.id, isin: id, qty: 2, cost: 40000 });
  assert.equal(B.balance(s, a), cash - 40000);
  B.addPurchase(s, { accountId: a.id, isin: id, date: T, qty: 1, cents: 21000 }); // known title: no name needed
  assert.equal(B.positions(s).find(p => p.isin === id).qty, 3);
  assert.equal(B.monthStats(s, T.slice(0, 7)).spent, m.spent);
  assert.throws(() => B.addPurchase(s, { accountId: a.id, isin: 'XX123', date: T, qty: 1, cents: 100 }), /ISIN/);
  assert.throws(() => B.addPurchase(s, { accountId: a.id, isin: id, date: T, qty: 0, cents: 100 }));
});

test('Account total: a title without price yet counts at its cost', () => {
  const s = withInstruments(), b = s.accounts.find(a => a.id === 'b');
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 90000);
  assert.equal(B.accountTotal(s, b, T).securities, 90000);
});

test('Move a position to another account: bought and imported lines follow, cost and quantity kept', () => {
  const s = withInstruments(), [a, b] = ['a', 'b'].map(id => s.accounts.find(x => x.id === id));
  s.snapshots.b = { date: '2026-01-01', seq: 0, lines: [{ isin: ETF, qty: 5, cost: 40000 }] };
  B.addPurchase(s, { accountId: 'b', isin: ETF, date: '2026-02-01', qty: 1, cents: 9000 });
  B.moveHolding(s, ETF, 'b', 'a');
  assert.deepEqual(B.positions(s).filter(p => p.isin === ETF), [{ accountId: 'a', isin: ETF, qty: 6, cost: 49000 }]);
  assert.equal(B.accountTotal(s, b, T).securities, 0); assert.equal(B.accountTotal(s, a, T).securities, 49000);
  assert.throws(() => B.moveHolding(s, ETF, 'a', 'a'));
});

test('Wealth over time: cash and titles at each month end, titles at the close of that day', () => {
  const s = withInstruments(), open = s.accounts.reduce((n, a) => n + a.opening, 0), cash0 = B.wealthSeries(s, ['2026-03'], T)[0].cash;
  B.addHolding(s, 'b', ETF, '2026-05-10', 10, 90000);
  s.history[ETF] = [['2026-05-29', 95], ['2026-06-30', 110], ['2026-10-30', 120]];
  const [apr, may, jun] = B.wealthSeries(s, ['2026-04', '2026-05', '2026-06'], T);
  assert.equal(apr.securities, 0); assert.equal(may.securities, 95000); assert.equal(jun.securities, 110000);
  assert.equal(jun.total, jun.cash + 110000); assert.ok(open !== undefined && cash0 === apr.cash);
  B.setQuote(s, ETF, 125, T); assert.equal(B.wealthSeries(s, ['2026-11'], T)[0].securities, 125000); // today: latest price, as on the accounts
  delete s.history[ETF]; assert.equal(B.wealthSeries(s, ['2026-06'], T)[0].securities, 90000); // no close: at cost
});

const dueState = () => { const s = B.emptyState(); s.accounts.push({ id: 'a', name: 'BCP', opening: 100000, liquid: true }, { id: 'b', name: 'X', opening: 0 }); return s; };
const pay = (cents, label, date = '2026-11-03', accountId = 'a') => ({ cents, kind: 'expense', accountId, date, label });
const nov = s => B.monthStats(s, '2026-11');

test('Due items: a payment with another label never settles or erases them', () => {
  let s = dueState();
  B.saveOp(s, { ...pay(1599, 'Netflix'), planned: true }); B.settleDue(s, '2026-11-04');
  B.saveOp(s, pay(1200, 'Boulangerie', '2026-11-05'));
  assert.equal(B.balance(s, s.accounts[0]), 100000 - 1599 - 1200); assert.equal(s.ops.length, 2);
  s = dueState();
  B.saveOp(s, { ...pay(1599, 'Netflix', '2026-11-20'), planned: true }); B.saveOp(s, pay(1200, 'Boulangerie', '2026-11-05'));
  assert.equal(nov(s).expectedSpent, 1599);
});

test('Due items: same result whichever is entered first, bank labels recognised', () => {
  for (const order of [[true, false], [false, true]]) {
    const s = dueState();
    for (const planned of order) B.saveOp(s, planned ? { ...pay(8371, 'Assurance auto'), planned } : pay(8371, 'PRLV SEPA MAIF ASSURANCE'));
    assert.deepEqual([nov(s).spent, nov(s).expectedSpent, nov(s).forecast], [8371, 0, -8371]);
    B.settleDue(s, '2026-11-04');
    assert.equal(B.balance(s, s.accounts[0]), 91629); // not debited twice once the date has passed
  }
});

test('Due items: a recurring item generated after its payment is linked too', () => {
  const s = dueState();
  B.saveOp(s, pay(90000, 'Loyer', '2026-11-01'));
  s.recurring.push({ id: 'r', accountId: 'a', day: 5, cents: 90000, kind: 'expense', categoryId: null, label: 'Loyer' });
  B.generateRecurring(s, '2026-11');
  assert.equal(nov(s).expectedSpent, 0);
});

test('Due items: two identical payments stay two, other accounts are not merged', () => {
  let s = dueState();
  B.saveOp(s, { ...pay(8371, 'Assurance'), planned: true }); B.saveOp(s, pay(8371, 'Assurance')); B.saveOp(s, pay(8371, 'Assurance'));
  assert.equal(nov(s).spent, 16742); assert.equal(s.ops.filter(o => o.plannedId).length, 1);
  s = dueState();
  B.saveOp(s, { ...pay(8371, 'Assurance'), planned: true }); B.saveOp(s, pay(8371, 'Assurance', '2026-11-03', 'b'));
  assert.equal(nov(s).expectedSpent, 8371);
});

test('Due items: deleting the payment brings the due item back, without double counting', () => {
  let s = dueState();
  B.saveOp(s, { ...pay(8371, 'Assurance'), planned: true });
  let r = B.saveOp(s, pay(8371, 'Assurance')); B.deleteOp(s, r.id);
  assert.deepEqual([nov(s).spent, nov(s).expectedSpent], [0, 8371]);
  s = dueState();
  B.saveOp(s, { ...pay(8371, 'Assurance'), planned: true }); B.settleDue(s, '2026-11-04');
  r = B.saveOp(s, pay(8371, 'Assurance'));
  assert.equal(B.balance(s, s.accounts[0]), 91629); assert.equal(B.settleDue(s, '2026-11-04'), 0); // the paid-on-date line stands aside
  B.deleteOp(s, r.id); B.settleDue(s, '2026-11-04');
  assert.equal(B.balance(s, s.accounts[0]), 91629); assert.equal(s.ops[0].autoPaid, true);
});

test('Hand-entered purchase takes from the cash, the sale lands in it, a declared holding moves nothing', () => {
  const s = withInstruments(), b = s.accounts.find(a => a.id === 'b'), cash = B.balance(s, b);
  B.addPurchase(s, { accountId: 'b', isin: ETF, date: '2026-01-01', qty: 2, cents: 10000 });
  B.addSale(s, 'b', ETF, '2026-02-01', 2, 12000);
  assert.equal(B.balance(s, b), cash + 2000); assert.equal(B.realizedGain(s, ETF), 2000);
  B.addHolding(s, 'b', ETF, '2026-03-01', 1, 5000); assert.equal(B.balance(s, b), cash + 2000);
  assert.equal(B.balance(B.validateState(JSON.parse(JSON.stringify(s))), b), cash + 2000); // a reload changes nothing
});

test('Order: every sale says how many, on which account and under which rule', () => {
  let s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 90000); s.settings.profile.horizon = 3;
  B.setHistory(s, ETF, spike(), 'test', T); // in gain, 13 % under its high, above its average: trailing stop, sell half
  let o = verdict(s, ETF).order;
  assert.deepEqual([o.side, o.qty, o.amount, o.rule], ['vente', 5, 52000, 5]);
  assert.match(o.text, /Vendre 5 parts sur Fortuneo/);
  s.settings.profile.style = 'actif';
  B.setHistory(s, ETF, [...closes(120, 0).slice(0, 99), [T, 104.5]], 'test', T); // active style, stop hit and below its average: everything goes
  const v = verdict(s, ETF);
  assert.equal(v.action, 'Vendre'); assert.equal(v.order.qty, 10); assert.equal(v.order.rule, 7); // the rule that says « tout vendre »
});

test('Order: back to the target share, the sale being the excess only', () => {
  const s = p03(0);
  const o = verdict(s, ETF).order; // 10 × 104,50 €, 100 % held for 60 % aimed
  assert.equal(o.side, 'vente'); assert.equal(o.qty, 4); assert.equal(o.rule, 2);
});

test('Order: buy signals share the broker cash without an envelope, up to the target, never the savings', () => {
  const s = p03(100000);
  s.accounts.find(a => a.id === 'l').opening = 9000000;
  const v = verdict(s, CW8);
  assert.equal(v.action, 'Acheter'); assert.equal(v.order.side, 'achat'); assert.equal(v.order.qty, 1); assert.equal(v.buy.accountId, 'b');
  assert.match(v.order.text, /Acheter 1 part sur Fortuneo/);
  s.accounts[1].opening = 0;
  assert.match(verdict(s, CW8).order.text, /Acheter 1 part sur Fortuneo .*indiquez d’abord les espèces/); // still a figure without cash
});

test('Order: a limit per line no longer crashes the purchase sizing', () => {
  const s = p03(500000);
  s.settings.profile.maxWeight = 70; B.addEnvelope(s, M, 120000);
  assert.equal(verdict(s, CW8).action, 'Acheter'); assert.ok(verdict(s, CW8).buy.qty > 0);
});

test('Strategy: every title has an order pointing to a written rule', () => {
  const s = B.demoState(T), rules = new Set(B.strategyRules(s).map(r => r.n));
  for (const x of B.suggestions(s, T)) { assert.ok(x.order.text); assert.ok(rules.has(x.order.rule), x.name); }
});

test('News: only recent articles are asked for, the tone is the company own, broker names are cleaned', async () => {
  const { refreshNews } = await import('./market.js');
  const s = withInstruments(); s.instruments = [{ isin: 'FR0000120271', name: 'TOTALENERGIES', symbol: '', currency: 'EUR' }];
  Object.assign(s.settings.market, { enabled: true, newsKey: 'K' });
  s.newsFetched.FR0000120271 = T; // fetched earlier today by the old query: done again
  const calls = [];
  await refreshNews(s, T, async url => { calls.push(url); return { ok: true, json: async () => ({ data: [{ title: 'A', url: 'https://ex.com/a', source: 'x', published_at: '2026-11-02',
    entities: [{ name: 'TotalEnergies SE', sentiment_score: 0.4 }, { name: 'Adani Green', sentiment_score: -0.9 }] }] }) }; });
  assert.match(calls[0], /published_after=2026-10-20/); assert.match(calls[0], /sort=published_desc/);
  assert.equal(s.news[0].sentiment, 0.4);
  assert.equal(B.newsQuery({ name: 'SONY FINANCIAL GR UNSPON ADS EACH REP 5 ORD' }), 'SONY FINANCIAL');
  assert.equal(B.newsQuery({ name: 'SONY ADR' }), 'SONY');
  assert.equal(B.newsQuery({ name: 'AMUNDI PEA MONDE (MSCI World) UCITS ETF - Acc EUR ACC' }), 'MSCI World');
});

test('Order: reinforcing always says how much, a third of the line without a target, with what is missing', () => {
  const s = withInstruments();
  B.addHolding(s, 'b', ETF, '2025-01-01', 30, 300000);
  B.setHistory(s, ETF, closes(120, 0.1), 'test', T);
  s.news.push(...['a', 'b'].map(u => ({ isin: ETF, title: 'x', url: `https://e.com/${u}`, source: 'e', publishedAt: T, sentiment: 0.6 })));
  s.accounts.find(a => a.id === 'b').opening = 200000;
  s.signalSince = { [ETF]: { action: 'Renforcer', date: dateBack(1) } }; // signal already there yesterday
  let v = verdict(s, ETF);
  assert.equal(v.action, 'Renforcer'); assert.match(v.order.text, /^Renforcer de 9 parts sur Fortuneo/); assert.equal(v.order.funded, true); // third of 3 600 € = 1 200 €, fees within
  assert.match(v.facts, /tendance haussière, actualités positives, risque dans vos limites/);
  s.accounts.find(a => a.id === 'b').opening = 100;
  v = verdict(s, ETF);
  assert.match(v.order.text, /^Renforcer de 9 parts .*il manque/); assert.equal(v.order.funded, false); assert.equal(v.buy, undefined);
});

test('ETF candidates: added once, a removed one stays gone, bought at a lower score than a stock', () => {
  const s = base(); B.seedEtfs(s);
  assert.equal(s.instruments.length, 4); assert.ok(s.instruments.every(i => i.type === 'ETF'));
  B.deleteInstrument(s, s.instruments[0].isin); B.seedEtfs(s);
  assert.equal(s.instruments.length, 3);
  assert.equal(B.validateState(JSON.parse(JSON.stringify(s))).instruments.length, 3); // loading keeps them
  const isin = s.instruments[0].isin;
  B.setHistory(s, isin, closes(120, 0.1), 'test', T); // rising: +1 and +0,5
  assert.equal(verdict(s, isin).action, 'Acheter');
});

test('Sales saved without cash by v32-v35 reach it on load, once', () => {
  const s = withInstruments(), cash = B.balance(s, s.accounts.find(a => a.id === 'b'));
  s.ops.push({ id: 'v', accountId: 'b', date: T, amount: 0, proceeds: 5000, kind: 'invest', isin: ETF, qty: -1, label: 'Vente' });
  const once = B.validateState(JSON.parse(JSON.stringify(s))), twice = B.validateState(JSON.parse(JSON.stringify(once)));
  assert.equal(B.balance(twice, twice.accounts.find(a => a.id === 'b')), cash + 5000);
});

test('After a partial sale the same rule waits 30 days instead of selling part of the rest', () => {
  const s = withInstruments(); s.settings.profile.horizon = 3;
  B.addHolding(s, 'b', ETF, '2025-01-01', 38, 342000);
  B.setHistory(s, ETF, spike(), 'test', T); // trailing stop: sell half
  assert.equal(verdict(s, ETF).order.qty, 19);
  B.addSale(s, 'b', ETF, T, 19, 197600);
  let v = verdict(s, ETF);
  assert.equal(v.action, 'Conserver'); assert.equal(v.order.side, null); assert.equal(v.order.rule, 10);
  s.ops.find(o => o.qty === -19).date = dateBack(31); // the pause is over
  v = verdict(s, ETF);
  assert.equal(v.action, 'Alléger'); assert.equal(v.order.qty, 10);
});

test('Buy signal: to confirm the first day, advised once it held since the day before', () => {
  const s = p03(500000);
  let v = verdict(s, CW8);
  assert.equal(v.order.pending, true); assert.match(v.order.text, /^À confirmer demain : Acheter/);
  B.logVerdicts(s, T); assert.equal(verdict(s, CW8).order.pending, true); // same day: still to confirm
  s.signalSince[CW8].date = dateBack(1);
  v = verdict(s, CW8); assert.equal(v.order.pending, undefined); assert.match(v.order.text, /^Acheter/);
});

test('After a purchase the line is not reinforced again for 30 days, and its plan is written', () => {
  const s = withInstruments(); s.accounts.find(a => a.id === 'b').opening = 200000;
  B.addHolding(s, 'b', ETF, '2025-01-01', 30, 300000);
  B.setHistory(s, ETF, closes(120, 0.1), 'test', T);
  s.news.push(...['a', 'b'].map(u => ({ isin: ETF, title: 'x', url: `https://e.com/${u}`, source: 'e', publishedAt: T, sentiment: 0.6 })));
  assert.equal(verdict(s, ETF).action, 'Renforcer');
  B.addPurchase(s, { accountId: 'b', isin: ETF, date: T, qty: 9, cents: 108000, advice: { action: 'Renforcer', rule: 7 } });
  const v = verdict(s, ETF);
  assert.equal(v.action, 'Conserver'); assert.equal(v.order.rule, 10); assert.match(v.order.text, /Aucun renfort/);
  const [pl] = B.linePlan(s, T, ETF), pru = 408000 / 39;
  assert.equal(pl.last.perPart, 12000); assert.deepEqual(pl.last.advice, { action: 'Renforcer', rule: 7 });
  assert.equal(pl.pru, Math.round(pru)); assert.equal(pl.lossAt, Math.round(pru * 0.8)); assert.equal(Math.round(pl.sinceBuy), 0);
});

test('Strategy report: result of the titles against the same money at the same dates in a world ETF', () => {
  const s = withInstruments();
  B.saveInstrument(s, { isin: CW8, name: 'CW8', symbol: 'CW8.PAR', currency: 'EUR' });
  B.setHistory(s, CW8, closes(200, 1), 'test', T); // 150 € fifty days ago, 190 € ten days ago, 200 € now
  B.addPurchase(s, { accountId: 'b', isin: ETF, date: dateBack(50), qty: 10, cents: 100000 });
  B.addSale(s, 'b', ETF, dateBack(10), 2, 30000);
  B.setQuote(s, ETF, 110, T);
  const r = B.strategyReport(s, T);
  assert.deepEqual([r.invested, r.back, r.value, r.gain], [100000, 30000, 88000, 18000]);
  const bench = Math.round((100000 / 150 - 30000 / 190) * 200);
  assert.equal(r.bench.value, bench); assert.equal(r.bench.gain, bench + 30000 - 100000); assert.equal(r.bench.early, false);
  delete s.history[CW8];
  assert.equal(B.strategyReport(s, T).bench, null);
});

test('Checks: what makes the figures wrong, and the five years of the PEA', () => {
  const s = withInstruments(); s.accounts.push({ id: 'p', name: 'PEA F', institution: 'Fortuneo', opening: 0, type: 'PEA' });
  B.addPurchase(s, { accountId: 'p', isin: ETF, date: T, qty: 1, cents: 10000 }); // no cash entered, no price yet
  const c = B.checks(s, T).join('\n');
  assert.match(c, /PEA F : espèces négatives/); assert.match(c, /World \(PEA F\) : compté au prix d’achat/); assert.match(c, /PEA F : indiquez sa date d’ouverture/);
  assert.doesNotMatch(c, /Livret : aucun mouvement/); // savings may rest
  s.accounts.find(a => a.id === 'p').opened = '2023-03-12';
  assert.equal(B.peaFiveYears(s.accounts.find(a => a.id === 'p')), '2028-03-12');
  assert.doesNotMatch(B.checks(s, T).join('\n'), /date d’ouverture/);
});

test('Import: a payment gets the category given last time to the same shop', () => {
  const s = base(), food = s.categories[0].id;
  B.saveOp(s, { accountId: 'a', date: '2026-10-02', kind: 'expense', cents: 4000, label: 'CB CARREFOUR 02/10 PARIS', categoryId: food });
  const rows = [{ date: '2026-11-02', amount: -5230, label: 'CB CARREFOUR MARKET 02/11' }, { date: '2026-11-03', amount: -900, label: 'CB BOULANGERIE 03/11' }];
  B.importRows(s, 'a', B.importPreview(s, 'a', rows), '2026-11-03');
  assert.equal(s.ops.find(o => /MARKET/.test(o.label)).categoryId, food);
  assert.equal(s.ops.find(o => /BOULANGERIE/.test(o.label)).categoryId, null);
});

test('Notifications: an advice to confirm is announced only once confirmed', () => {
  const s = p03(500000);
  s.settings.notify = true;
  assert.ok(!B.pendingNotifications(s, T).some(x => x.name === 'CW8')); // to confirm: nothing yet
  B.markNotified(s, [], T); B.logVerdicts(s, T);
  s.signalSince[CW8].date = dateBack(1);
  assert.ok(B.pendingNotifications(s, T).some(x => x.name === 'CW8' && /^Acheter/.test(x.body)));
});

test('Checks: savings near their ceiling, with the room left elsewhere', () => {
  const s = base();
  s.accounts.find(a => a.id === 'l').opening = 2200000; // « Livret » named: an other savings account, no ceiling
  s.accounts.push({ id: 'la', name: 'Livret A', institution: 'BCP', opening: 2200000, savings: true }, { id: 'dd', name: 'LDDS', institution: 'BCP', opening: 200000, savings: true });
  const c = B.checks(s, T).join('\n');
  assert.match(c, /Livret A : 22 ?000,00 € sur 22 ?950,00 € de plafond\. Place restante : LDDS \(10 ?000,00 €\)/);
  assert.doesNotMatch(c, /LDDS : /);
});

test('Backtest: the real rules replayed day by day, against keeping the title', () => {
  let s = withInstruments();
  const fall = Array.from({ length: 200 }, (_, k) => [dateBack(199 - k), k < 70 ? 100 : 100 - ((k - 70) * 50) / 129]); // flat, then halves
  B.setHistory(s, ETF, fall, 'test', T);
  let [r] = B.backtest(s);
  assert.equal(r.isin, ETF); assert.ok(Math.abs(r.hold + 50) < 1); // keeping it: about −50 %
  assert.ok(Math.abs(r.rules - r.hold) < 1); // the max loss alerts, it no longer sells on its own
  s = withInstruments(); s.settings.profile.horizon = 3;
  const peak = Array.from({ length: 200 }, (_, k) => [dateBack(199 - k), k < 130 ? 100 + (k * 50) / 130 : 150 - ((k - 130) * 60) / 69]); // up to 150, down to 90
  B.setHistory(s, ETF, peak, 'test', T);
  [r] = B.backtest(s);
  assert.ok(r.trades >= 1); assert.ok(r.rules > r.hold + 5, `rules ${r.rules} vs hold ${r.hold}`); // the trailing stop kept part of the gain
  assert.deepEqual(B.backtest(withInstruments()), []); // no prices, no test
});

test('Lot 1: trailing stop from the high since purchase, 10 % per stock by default, long term never sells on signals, safety savings', () => {
  // a high reached before buying no longer triggers the trailing stop
  const s = withInstruments(); s.settings.profile.horizon = 3;
  const h = Array.from({ length: 250 }, (_, k) => [dateBack(249 - k), k < 50 ? 150 - k * 0.8 : k < 240 ? 110 : 100 + (k - 240)]); h[249] = [T, 110];
  B.setHistory(s, ETF, h, 't', T);
  B.addPurchase(s, { accountId: 'b', isin: ETF, date: dateBack(7), qty: 10, cents: 100000 });
  let v = verdict(s, ETF);
  assert.ok(!v.reasons.some(r => r.rule === 5)); assert.notEqual(v.order.side, 'vente');
  assert.equal(B.linePlan(s, T, ETF)[0].trailAt, Math.round(110 * 0.88 * 100) / 100); // from the 110 € reached after buying
  // default limit, ETFs exempt
  assert.equal(B.emptyState().settings.profile.maxWeight, 10);
  const old = B.emptyState(); delete old.settings.profile.maxWeight;
  assert.equal(B.validateState(old).settings.profile.maxWeight, 10);
  const e = withInstruments(); e.settings.profile.maxWeight = 10;
  B.saveInstrument(e, { isin: CW8, name: 'Amundi MSCI World UCITS ETF', currency: 'EUR', type: 'ETF' });
  B.addHolding(e, 'b', CW8, '2025-01-01', 10, 500000); B.setHistory(e, CW8, closes(560, 0.5), 't', T);
  e.signalSince = { [CW8]: { action: 'Renforcer', date: dateBack(1) } }; e.accounts.find(a => a.id === 'b').opening = 1000000;
  v = verdict(e, CW8);
  assert.equal(v.action, 'Renforcer'); assert.ok(v.order.qty > 0); // 100 % of the portfolio, but an ETF: not limited
  // long term: strong falling signals ask for a look, they do not sell
  const f = withInstruments();
  B.addHolding(f, 'b', ETF, '2025-01-01', 10, 100000);
  B.setHistory(f, ETF, closes(110, -0.3), 't', T);
  f.news.push(...['a', 'b'].map(u => ({ isin: ETF, title: 'x', url: `https://e.com/${u}`, source: 'e', publishedAt: T, sentiment: -0.6 })));
  v = verdict(f, ETF);
  assert.equal(v.action, 'À examiner'); assert.equal(v.order.side, null); assert.equal(v.order.rule, 7);
  f.settings.profile.style = 'actif';
  assert.equal(verdict(f, ETF).order.side, 'vente');
  // buying with less than 3 months of safety savings is flagged
  const c = p03(500000);
  for (const m of ['2026-08', '2026-09', '2026-10']) B.saveOp(c, { accountId: 'a', date: `${m}-05`, kind: 'expense', cents: 100000, label: 'Loyer' });
  c.accounts.find(a => a.id === 'l').opening = 150000;
  assert.match(verdict(c, CW8).order.text, /épargne de précaution : 1,5 mois/);
});

test('Lot 2: limit order, tax and fees on a CTO sale, PEA sold first in gain, next review date', () => {
  const s = withInstruments(); s.settings.profile.horizon = 3;
  s.accounts.find(a => a.id === 'b').type = 'CTO';
  s.accounts.push({ id: 'p', name: 'PEA F', institution: 'Fortuneo', opening: 0, type: 'PEA' });
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 90000); B.addHolding(s, 'p', ETF, '2025-01-01', 10, 90000);
  const h = closes(100, 0); h[50] = [h[50][0], 120]; h[99] = [T, 104]; // in gain, 13 % under its high: trailing stop, sell half
  B.setHistory(s, ETF, h, 'test', T);
  let o = B.suggestions(s, T).find(x => x.isin === ETF).order;
  assert.equal(o.qty, 10); assert.equal(o.sells.length, 1); assert.equal(o.sells[0].accountId, 'p'); // half of 20, all from the PEA
  assert.match(o.how, /^Ordre à cours limité à 103,48 EUR minimum, valable 1 semaine\./);
  assert.match(o.how, /Sur le PEA d’abord/); assert.match(o.how, /pause sur cette ligne jusqu’au/);
  s.ops = s.ops.filter(x => x.accountId !== 'p'); // CTO only: the tax is estimated
  o = B.suggestions(s, T).find(x => x.isin === ETF).order;
  assert.match(o.how, /impôt estimé ≈ 21,98 € sur 70,00 € de plus-value.*il vous reste ≈ 496,07 €/); // 5 parts × 14 € gain × 31,4 %, minus Fortuneo's 1,95 € fee
  const p = p03(500000); p.signalSince = { [CW8]: { action: 'Acheter', date: dateBack(1) } };
  assert.match(B.suggestions(p, T).find(x => x.isin === CW8).order.how, /^Ordre à cours limité à 564,01 EUR maximum.*pas de nouveau renfort avant le/);
});

test('Lot 3: long-term trend, core and satellite, idea cap, sale confirmation, monthly plan, concentration', () => {
  // 11. a stock bouncing inside a year-long fall is not bought
  let s = withInstruments(); s.accounts.find(a => a.id === 'b').opening = 500000;
  const fall = Array.from({ length: 250 }, (_, k) => [dateBack(249 - k), k < 200 ? 200 - k * 0.6 : 80 + (k - 200) * 0.4]); // 200 → 80, then a bounce to 100, still under its 200-day average
  B.setHistory(s, ETF, fall, 't', T);
  s.news.push(...['a', 'b'].map(u => ({ isin: ETF, title: 'x', url: `https://e.com/${u}`, source: 'e', publishedAt: T, sentiment: 0.6 })));
  let v = verdict(s, ETF);
  assert.equal(v.action, 'Attendre'); assert.equal(v.order.rule, 11);
  // 12. satellite full: no stock purchase while ETFs are under their share
  s = p03(500000); s.settings.profile.coreMin = 70; // ETF « World » is a stock here (no ETF in its name): 100 % satellite
  v = verdict(s, CW8);
  assert.equal(v.action, 'Attendre'); assert.equal(v.order.rule, 12);
  assert.match(B.checks(s, T).join('\n'), /Cœur en ETF larges : 0 %/);
  // a sale on signals alone waits a day (active style), a stop does not
  s = withInstruments(); s.settings.profile.style = 'actif';
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setHistory(s, ETF, closes(110, -0.3), 't', T);
  s.news.push(...['a', 'b'].map(u => ({ isin: ETF, title: 'x', url: `https://e.com/${u}`, source: 'e', publishedAt: T, sentiment: -0.6 })));
  v = verdict(s, ETF);
  assert.equal(v.order.side, 'vente'); assert.equal(v.order.pending, true); assert.match(v.order.text, /^À confirmer demain/);
  s.signalSince = { [ETF]: { action: v.action, date: dateBack(1) } };
  assert.equal(verdict(s, ETF).order.pending, undefined);
  // 13. monthly plan: a fixed sum into the main ETF, once a month
  s = withInstruments(); s.settings.profile.monthly = 30000;
  s.accounts.push({ id: 'p', name: 'PEA F', institution: 'Fortuneo', opening: 100000, type: 'PEA' });
  B.saveInstrument(s, { isin: CW8, name: 'Amundi MSCI World UCITS ETF', currency: 'EUR', type: 'ETF' });
  B.setHistory(s, CW8, closes(100, 0), 't', T);
  v = verdict(s, CW8);
  assert.equal(v.order.rule, 13); assert.equal(v.order.accountId, 'p'); assert.equal(v.order.qty, 2); assert.match(v.order.text, /^Versement du mois : acheter 2 parts/);
  B.addPurchase(s, { accountId: 'p', isin: CW8, date: T, qty: 2, cents: 20195 });
  assert.equal(verdict(s, CW8).order.text, 'Versement du mois fait ✓');
  // concentration
  const c = withInstruments(); B.addHolding(c, 'b', ETF, '2025-01-01', 10, 100000); B.setQuote(c, ETF, 100, T);
  assert.match(B.checks(c, T).join('\n'), /World pèse 100 % de vos titres/);
});

test('Funds are recognised by their index name too', () => {
  for (const n of ['iShares Core MSCI World', 'Amundi PEA S&P 500 (PSP5)', 'Amundi MSCI World (CW8)', 'AMUNDI PEA MONDE (MSCI World) UCITS ETF']) assert.ok(B.isFund({ name: n }), n);
  for (const n of ['TotalEnergies', 'Apple', 'World', 'Safran']) assert.ok(!B.isFund({ name: n }), n);
});

test('Orders carry their limit price for the plain « À faire » list', () => {
  const s = withInstruments(); s.settings.profile.horizon = 3;
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 90000);
  const h = closes(100, 0); h[50] = [h[50][0], 120]; h[99] = [T, 104]; B.setHistory(s, ETF, h, 'test', T);
  const o = verdict(s, ETF).order;
  assert.equal(o.limit, 103.48); assert.equal(o.cur, 'EUR'); assert.equal(B.limitPrice('achat', 561.2), 564.01);
});
