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
  op(s, 'expense', 500);
  const planned = s.ops.find(o => o.planned), real = B.matchCandidates(s, planned)[0];
  assert.equal(real.amount, -50000);
  B.match(s, planned.id, real.id);
  st = B.monthStats(s, M);
  assert.equal(st.toDate, 80000); assert.equal(st.forecast, 80000);
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

test('P01: market refresh is opt-in, logs hosts without the key, one call per day', async () => {
  const { refreshMarket } = await import('./market.js');
  const s = withInstruments(), calls = [];
  await assert.rejects(refreshMarket(s, '2026-11-03', () => assert.fail()), /désactivées/);
  Object.assign(s.settings.market, { enabled: true, avKey: 'SECRETKEY' });
  const fake = async url => {
    calls.push(url);
    const body = url.includes('frankfurter') ? { date: '2026-11-03', rates: { USD: 1.12 } }
      : url.includes('AAPL') ? { Information: 'rate limit' } : { 'Global Quote': { '05. price': '104.50', '07. latest trading day': '2026-11-03' } };
    return { ok: true, json: async () => body };
  };
  const errors = await refreshMarket(s, '2026-11-03', fake);
  assert.equal(s.quotes[ETF].price, 104.5); assert.equal(s.fx.USD.rate, 1.12);
  assert.match(errors.join(), /rate limit/);
  assert.ok(!JSON.stringify(s.requestLog).includes('SECRETKEY'));
  const n = calls.length;
  await refreshMarket(s, '2026-11-03', fake); // only the failed AAPL quote is retried
  assert.equal(calls.length, n + 1);
});

const CW8 = 'LU1681043599', T = '2026-11-03';
function p03(cash) {
  const s = withInstruments();
  B.saveInstrument(s, { isin: CW8, name: 'CW8', symbol: 'CW8.PAR', currency: 'EUR' });
  s.accounts[1].opening = cash;
  B.addHolding(s, 'b', ETF, '2025-01-01', 10, 100000);
  B.setQuote(s, ETF, 104.5, T); B.setQuote(s, CW8, 561.2, T);
  s.settings.profile.targets = { [ETF]: 60, [CW8]: 40 };
  return s;
}
const buys = s => B.suggestions(s, T).filter(x => x.action === 'Acheter');

test('P03: envelope purchase goes to the most underweight line, fees included, within envelope and cash', () => {
  const s = p03(500000);
  B.addEnvelope(s, M, 120000);
  const [b] = buys(s);
  assert.equal(b.isin, CW8); assert.equal(b.qty, 2); assert.equal(b.total, 2 * 56120 + 100);
  assert.ok(B.suggestions(s, T).some(x => x.action === 'Alléger' && x.isin === ETF)); // 100 % vs 60 % target
  s.accounts[1].opening = 60000; // cash now lower than the envelope
  const [c] = buys(s);
  assert.equal(c.qty, 1); assert.ok(c.total <= 60000); assert.match(c.reason, /encaisse/);
  s.accounts[1].opening = 50000;
  assert.equal(buys(s).length, 0);
  assert.ok(B.suggestions(s, T).some(x => x.action === 'Attendre'));
});

test('P03: a non-EUR purchase includes conversion cost and stays within the limit', () => {
  const s = p03(500000);
  s.settings.profile.targets = { [AAPL]: 100 };
  B.setQuote(s, AAPL, 268.3, T); s.fx.USD = { rate: 1.1179, asOf: T, source: 'BCE' };
  B.addEnvelope(s, M, 100000);
  const [b] = buys(s);
  assert.equal(b.qty, 4); assert.ok(b.total <= 100000);
  assert.ok(b.figures.some(f => f.label === 'Change EUR/USD' && f.asOf === T));
});

test('P03: stale or missing data suspends suggestions instead of guessing', () => {
  const s = p03(500000);
  B.addHolding(s, 'b', AAPL, '2025-01-01', 2, 40000);
  B.setQuote(s, AAPL, 268.3, '2026-10-20'); s.fx.USD = { rate: 1.12, asOf: T };
  B.addEnvelope(s, M, 120000);
  const sug = B.suggestions(s, T);
  assert.equal(buys(s).length, 0);
  assert.ok(sug.some(x => x.suspended && x.rule === 'Allocation cible'));
  assert.ok(sug.some(x => x.suspended && x.rule === 'Enveloppe du mois'));
  assert.ok(sug.some(x => x.suspended && x.isin === AAPL));
});

test('P03: profile rules — trailing stop on short horizon, max loss, otherwise hold; each signal is sourced and dated', () => {
  const s = p03(0);
  s.settings.profile.targets = {};
  B.setQuote(s, ETF, 120, '2026-10-01'); B.setQuote(s, ETF, 104.5, T); // peak 120, now -12.9 %, still above cost
  s.settings.profile.horizon = 3;
  let [x] = B.suggestions(s, T);
  assert.equal(x.action, 'Sécuriser');
  assert.ok(x.rule && x.reason && x.figures.some(f => f.asOf === T && f.source));
  s.settings.profile.horizon = 10;
  assert.equal(B.suggestions(s, T)[0].action, 'Conserver');
  B.setQuote(s, ETF, 79, T); // -21 % vs cost, limit 20 % for "équilibré"
  assert.equal(B.suggestions(s, T)[0].action, 'Vendre ou revoir');
  s.settings.profile.risk = 'dynamique';
  assert.equal(B.suggestions(s, T)[0].action, 'Conserver');
});

test('P02: news is opt-in, web links only, deduplicated, one call per instrument per day, key never logged', async () => {
  const { refreshNews } = await import('./market.js');
  const s = withInstruments(), calls = [];
  s.instruments[0].newsSymbol = 'EUNL';
  await assert.rejects(refreshNews(s, T, () => assert.fail()), /désactivées/);
  s.settings.market.enabled = true;
  assert.match((await refreshNews(s, T, () => assert.fail())).join(), /Marketaux manquante/);
  s.settings.market.newsKey = 'NEWSKEY';
  const fake = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ data: [
      { title: 'Fusion annoncée', url: 'https://ex.com/a', source: 'ex.com', published_at: '2026-11-02T08:00:00Z' },
      { title: 'Piège', url: 'javascript:alert(1)', source: 'x', published_at: '2026-11-02' },
      { title: 'Vieux', url: 'https://ex.com/old', source: 'ex.com', published_at: '2026-09-01' }] }) };
  };
  assert.deepEqual(await refreshNews(s, T, fake), []);
  assert.deepEqual(s.news.map(n => n.url), ['https://ex.com/a']); // bad link rejected, >30 days pruned
  await refreshNews(s, T, fake);
  assert.equal(calls.length, 1);
  await refreshNews(s, '2026-11-04', fake);
  assert.equal(s.news.length, 1);
  assert.ok(!JSON.stringify(s.requestLog).includes('NEWSKEY'));
});

test('P02: a notable headline from the last 14 days is flagged for review with its source and date', () => {
  const s = withInstruments();
  B.addNews(s, ETF, { title: 'Index change for the fund', url: 'https://ex.com/1', source: 'ex.com', publishedAt: '2026-11-01' }, T);
  B.addNews(s, ETF, { title: 'Merger completed', url: 'https://ex.com/2', source: 'ex.com', publishedAt: '2026-10-01' }, T);
  B.addNews(s, ETF, { title: 'Quarterly report', url: 'https://ex.com/3', source: 'ex.com', publishedAt: '2026-11-02' }, T);
  const flagged = B.suggestions(s, T).filter(x => x.action === 'À examiner');
  assert.equal(flagged.length, 1);
  assert.deepEqual(flagged[0].figures[0], { label: 'Article', value: 'ex.com', asOf: '2026-11-01', source: 'https://ex.com/1' });
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

test('demo data reproduces the spec figures', () => {
  const demo = B.validateState(B.demoState('2026-11-03')), st = B.monthStats(demo, M);
  assert.equal(B.valuation(demo, '2026-11-03').filter(l => l.stale).length, 1);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000); assert.equal(st.spendable, 40000);
});
