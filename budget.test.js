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
  assert.equal(s.quotes[ETF].price, 104.5); assert.equal(s.quotes[ETF].asOf, T); assert.equal(s.history[ETF].length, 100);
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
  assert.equal(v.action, 'Acheter'); assert.equal(v.buy.qty, 2); assert.equal(v.buy.total, 2 * 56120 + 100);
  s.accounts[1].opening = 60000; // cash now lower than the envelope
  v = verdict(s, CW8);
  assert.equal(v.buy.qty, 1); assert.ok(v.buy.total <= 60000); assert.match(v.reasons.at(-1).text, /encaisse/);
  s.accounts[1].opening = 50000;
  v = verdict(s, CW8);
  assert.equal(v.buy, undefined); assert.match(v.reasons.at(-1).text, /insuffisant/);
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
  B.buyFromEnvelope(s, s.envelopes[0].id, 'b', '2026-11-03', 6100, 'achat déjà dans l’export', 'FR0000120271', 1);
  B.buyFromEnvelope(s, s.envelopes[0].id, 'b', '2026-11-04', 3000, 'achat après l’export', 'JP3164630000', 1);
  const pos = Object.fromEntries(B.positions(s).map(p => [p.isin, p.qty]));
  assert.equal(pos['FR0000120271'], 10); assert.equal(pos['JP3164630000'], 4);
  B.applySnapshot(s, 'b', { ...snap, date: '2026-11-04', lines: snap.lines.slice(0, 1) }, 'Fortuneo');
  assert.deepEqual(B.positions(s).map(p => [p.isin, p.qty]), [['FR0000120271', 10]]);
});

test('demo data reproduces the spec figures', () => {
  const demo = B.validateState(B.demoState('2026-11-03')), st = B.monthStats(demo, M);
  assert.equal(B.valuation(demo, '2026-11-03').filter(l => l.stale).length, 1);
  assert.equal(st.toDate, 130000); assert.equal(st.forecast, 80000); assert.equal(st.spendable, 40000);
});
