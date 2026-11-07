import * as B from './budget.js';
import { refreshMarket, refreshNews, searchSymbols, discover, checkNewsKey, workerCall, newsOn } from './market.js';

const KEY = 'budget.v1';
const app = document.getElementById('app');
const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
const view = { tab: 'dash', month: B.monthOf(today()), account: '', edit: null, preview: null, open: new Set(['addOp']) };
let S = load();

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return B.emptyState();
  try { return B.validateState(JSON.parse(raw)); } catch {
    localStorage.setItem(KEY + '.illisible', raw); // keep the unreadable copy rather than overwrite it
    alert('Données locales illisibles, mises de côté. Restaurez une sauvegarde.');
    return B.emptyState();
  }
}
const save = () => localStorage.setItem(KEY, JSON.stringify(S));

// ---- formatting helpers ----
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const eur = c => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const money = c => `<span class="${c < 0 ? 'neg' : c > 0 ? 'pos' : ''}">${eur(c)}</span>`;
const euros = c => (c ? String(c / 100).replace('.', ',') : '');
const parseEur = v => {
  const t = String(v ?? '').replace(/[\s €]/g, '').replace(',', '.'), n = t === '' ? 0 : Math.round(Number(t) * 100);
  if (!Number.isFinite(n)) throw new Error('Montant invalide');
  return n;
};
const positive = v => { const n = parseEur(v); if (n <= 0) throw new Error('Montant invalide'); return n; };
const decimal = v => { const n = Number(String(v).replace(/[\s ]/g, '').replace(',', '.')); if (!(n > 0)) throw new Error('Nombre invalide'); return n; };
const num = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 6 });
// technical errors from the price and news services, said in plain words with what to do
const plain = e => (/marketaux[^:]*: HTTP 401/i.test(e) ? 'Clé Marketaux refusée : vérifiez-la dans « Réglages bourse » (actualités et idées en pause).'
  : /marketaux[^:]*: HTTP (402|429)/i.test(e) ? 'Quota Marketaux du jour atteint : actualités et idées reprendront demain.'
    : /Alpha Vantage : /.test(e) ? 'Quota Alpha Vantage du jour atteint : configurez le service de cours pour ne plus en dépendre.'
      : /pas de symbole de cours/.test(e) ? e.replace(/ \(.*\)$/, ' : ouvrez sa fiche, « Trouver le cours ».')
        : e);
const accName = id => S.accounts.find(a => a.id === id)?.name ?? '?';
const catName = id => S.categories.find(c => c.id === id)?.name ?? '';
const opts = (items, sel, empty) => (empty != null ? `<option value="">${empty}</option>` : '')
  + items.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');
const accOpts = (sel, empty) => opts(S.accounts.map(a => [a.id, `${a.name} · ${a.institution}`]), sel, empty);
const catOpts = sel => opts(S.categories.map(c => [c.id, c.name]), sel, '— catégorie —');
const row = (label, c, cls = '') => `<div class="row ${cls}"><span>${label}</span>${money(c)}</div>`;
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${title}</h2>${body}</section>`;
const empty = t => `<div class="muted">${t}</div>`;
const monthName = m => new Date(m + '-15T12:00').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
const monthBar = (withAccount = true) => `<div class="monthnav">${btn('prevMonth', '', '‹', '')}<b>${monthName(view.month)}</b>${btn('nextMonth', '', '›', '')}</div>`
  + (withAccount && S.accounts.length > 1 ? `<div class="chips" style="margin:0 0 12px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px">`
    + [['', 'Tous les comptes'], ...S.accounts.map(a => [a.id, a.name])].map(([id, n]) => `<label><input type="radio" name="accf" data-change="account" value="${esc(id)}"${view.account === id ? ' checked' : ''}><span style="white-space:nowrap">${esc(n)}</span></label>`).join('')
    + '</div>' : '');
const btn = (act, id, text, cls = 'small ghost') => `<button class="${cls}" data-act="${act}" data-id="${esc(id)}">${text}</button>`;
// collapsible section; stays open across re-renders once the user opened it
const fold = (key, title, body, open) => `<details class="card fold" data-fold="${key}"${open || view.open.has(key) ? ' open' : ''}><summary>${title}</summary>${body}</details>`;

// an icon per category, guessed from its name (categories are the user's own)
const ICONS = [[/logement|loyer|maison/i, '🏠'], [/aliment|course|super/i, '🛒'], [/sant|pharma|m[ée]dec/i, '💊'], [/mobilit|auto|carbur|transport/i, '🚗'],
  [/imp[oô]t|tax/i, '🧾'], [/loisir|resto|sortie/i, '🎉'], [/abonn|stream/i, '📺'], [/v[êe]t|habill/i, '👕'], [/enfant|[ée]cole/i, '🧸'],
  [/voyage|vacance/i, '✈️'], [/cadeau/i, '🎁'], [/[ée]pargne/i, '🐷'], [/divers/i, '📦']];
const catIcon = name => ICONS.find(([re]) => re.test(name ?? ''))?.[1] ?? '💳';
const opIcon = o => (o.transferId ? '🔁' : o.envelopeId || o.kind === 'invest' ? '📈' : o.kind === 'income' ? '💶' : o.kind === 'refund' ? '↩️' : catIcon(catName(o.categoryId)));
const shortDate = d => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

function opItem(o) {
  const tags = [o.planned && 'à venir', o.autoPaid && 'payé à échéance', o.transferId && 'virement interne'].filter(Boolean);
  const editable = !o.transferId && !o.envelopeId && o.kind !== 'invest';
  const sub = [shortDate(o.date), accName(o.accountId), catName(o.categoryId)].filter(Boolean).map(esc).join(' · ');
  return `<div class="op${editable ? ` tap" data-act="edit" data-id="${o.id}` : ''}"><div class="av">${opIcon(o)}</div>`
    + `<div class="l">${esc(o.label || catName(o.categoryId) || B.KINDS[o.kind])}${tags.map(t => `<span class="tag">${t}</span>`).join('')}<div class="muted">${sub}</div></div>`
    + `<div class="r">${money(o.amount)}${o.transferId ? `<div class="actions">${btn('unlink', o.transferId, 'Délier')}${btn('del', o.id, 'Suppr.', 'small danger')}</div>`
      : !editable ? `<div class="actions">${btn('del', o.id, 'Suppr.', 'small danger')}</div>` : ''}</div></div>`;
}

const bar = (name, spent, cap) => `<div style="padding:4px 0"><div class="row" style="border:0;padding:0"><span>${esc(name)}</span><span>${eur(spent)}${cap ? ` / ${eur(cap)}` : ''}</span></div>`
  + (cap ? `<div class="bar"><i class="${spent > cap ? 'over' : ''}" style="width:${Math.max(0, Math.min(100, (spent * 100) / cap))}%"></i></div>` : '') + '</div>';

const onboarding = () => card('Bienvenue 👋', empty('Aucun compte pour l’instant. Créez vos comptes et établissements, ou essayez avec des données fictives.')
  + `<div class="grid2" style="margin-top:12px"><button data-tab="settings">Créer un compte</button><button class="ghost" data-act="demo">Voir la démo</button></div>`);

// Bottom panel to add or change an entry: big amount, categories and accounts as icons to tap, no drop-down list.
// an account that is neither current nor savings and has no type yet is a brokerage account (created before types existed)
const accKind = a => (a.type === 'PEA' ? 'pea' : a.type === 'CTO' ? 'cto' : a.savings ? 'epargne' : a.liquid ? 'courant' : 'cto');
const ACC_TYPES = { courant: ['🏦', 'Compte courant'], livretA: ['🐷', 'Livret A'], ldds: ['🐷', 'LDDS'], lep: ['🐷', 'LEP'], cel: ['🐷', 'CEL'], pel: ['🐷', 'PEL'],
  av: ['🛡️', 'Assurance-vie'], epargne: ['🐷', 'Autre épargne'], pea: ['📈', 'PEA'], cto: ['📈', 'Compte-titres (CTO)'] };
// accounts made before the types: guessed from their name until edited
const guessSub = n => [[/livret ?a\b/i, 'livretA'], [/ldds|ldd\b/i, 'ldds'], [/\blep\b/i, 'lep'], [/\bcel\b/i, 'cel'], [/\bpel\b/i, 'pel'], [/assurance|\bav\b/i, 'av']].find(([r]) => r.test(n))?.[1];
const accType = a => (a.savings ? (ACC_TYPES[a.sub] ? a.sub : guessSub(a.name) ?? 'epargne') : accKind(a));
// « Fortuneo · PEA »: the name, plus the envelope when the name does not say it
const accTag = id => { const a = S.accounts.find(x => x.id === id); if (!a) return '?'; const k = accKind(a), t = k === 'pea' ? 'PEA' : k === 'cto' ? 'CTO' : '';
  return t && !a.name.toUpperCase().includes(t) ? `${a.name} · ${t}` : a.name; };
const byBank = list => [...list].sort((x, y) => x.institution.localeCompare(y.institution, 'fr') || x.name.localeCompare(y.name, 'fr'));
// one journal entry: decision, price then → now, and whether it went the way the decision bet on
const decisionRow = (d, withName) => `<div class="op"><div class="l"><b>${esc(d.verdict ?? B.DECISIONS[d.action])}</b>${withName ? ` · ${esc(S.instruments.find(i => i.isin === d.isin)?.name ?? d.isin)}` : ''}`
  + `<div class="muted">${shortDate(d.date)}${d.price ? ` · cours ${num(d.price)}` : ''}${d.note ? ` · « ${esc(d.note)} »` : ''}</div></div>`
  + `<div style="text-align:right">${d.change == null ? '' : `<span class="${d.change < 0 ? 'neg' : 'pos'}">${d.change > 0 ? '+' : ''}${d.change.toFixed(1).replace('.', ',')} %</span>`}`
  + `<div class="muted">${d.right == null ? '' : d.right ? '✅ bien vu' : '❌ raté'}</div>${btn('delDecision', d.id, '✕')}</div></div>`;
// an account's amount: for a broker account, cash plus securities, like the broker's own screen
const acctAmount = a => { const t = B.accountTotal(S, a, today()); return t.securities ? `${money(t.total)}<div class="muted" style="font-size:12px">dont titres ${eur(t.securities)}</div>` : money(t.cash); };
const chip = (name, value, label, on) => `<label><input type="radio" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}><span>${label}</span></label>`;
const catChips = sel => `<div class="cats">${[...S.categories.map(c => [c.id, c.name]), ['', 'Aucune']].map(([id, n]) => `<label><input type="radio" name="categoryId" value="${esc(id)}"${(sel ?? '') === id ? ' checked' : ''}><span><b>${id ? catIcon(n) : '·'}</b>${esc(n)}</span></label>`).join('')}</div>`;
const cancelBtn = '<button type="button" class="ghost" data-act="closeSheet">Annuler</button>';

// Panels opened from Réglages (one per topic) and the entry panel: same look, no drop-down list for everyday choices.
function sheet() {
  if (!view.sheet) return '';
  const [kind, id] = view.sheet === true ? ['op'] : view.sheet.split(':');
  const st = S.settings, a = id && S.accounts.find(x => x.id === id);
  const body = {
    op: opSheet,
    account: () => {
      const t = !a ? 'courant' : accType(a);
      const pctVal = v => (v != null ? String(v).replace('.', ',') : '');
      return `<h2>${a ? esc(a.name) : 'Nouveau compte'}</h2><form data-form="account"><input type="hidden" name="id" value="${a?.id ?? ''}">
        <label>Banque ou courtier<input name="institution" value="${esc(a?.institution)}" placeholder="ex. BCP, Fortuneo, Trade Republic" list="banks" required></label>
        <datalist id="banks">${[...new Set(S.accounts.map(x => x.institution))].map(b => `<option value="${esc(b)}">`).join('')}</datalist>
        <div class="muted">Type de compte</div>
        <div class="chips">${Object.entries(ACC_TYPES).map(([k, [i, l]]) => chip('acctype', k, `${i} ${l}`, t === k)).join('')}</div>
        ${empty('Un PEA ou un CTO comprend ses titres et son compte espèces : les achats de titres et les espèces de la cagnotte vont sur ce même compte.')}
        <label>Nom <span class="muted">(facultatif)</span><input name="name" value="${esc(a?.name)}" placeholder="par défaut : banque + type, ex. Fortuneo PEA"></label>
        <label>Solde de départ (€)<input name="opening" inputmode="decimal" value="${a ? euros(a.opening) : ''}" placeholder="0"></label>
        <details${a?.type ? ' open' : ''}><summary class="muted">Bourse : frais du courtier</summary><div style="display:grid;gap:10px;margin-top:10px">
        <div class="grid2"><label>Par ordre (€)<input name="feeFixed" inputmode="decimal" value="${a?.feeFixed != null ? pctVal(a.feeFixed / 100) : ''}"></label><label>En % du montant<input name="feePct" inputmode="decimal" value="${pctVal(a?.feePct)}"></label></div>
        <label>Change hors euro (%)<input name="fxPct" inputmode="decimal" value="${pctVal(a?.fxPct)}"></label>
        <label class="chk"><input type="checkbox" name="fractional"${a?.fractional ? ' checked' : ''}> Fractions de parts possibles</label>
        ${empty((est => (est ? `Laissez vide pour utiliser l’estimation ${est.name} : ${eur(est.fixed)} par ordre${est.fx ? `, ${String(est.fx).replace('.', ',')} % de change hors euro` : ''}. ` : 'Laissez vide pour l’estimation de votre profil (1 € par ordre). '))(B.brokerFees(a?.institution))
          + 'Si vous connaissez vos vrais frais, notez-les : l’app achète sur le PEA quand le titre y est éligible, sinon sur le compte le moins cher.')}</div></details>
        <button>Enregistrer</button>${a ? btn('delAcc', a.id, 'Supprimer ce compte', 'danger') : ''}${cancelBtn}</form>`;
    },
    budget: () => {
      const pcts = [...new Set([70, 80, 90, 100, st.alertPct])].sort((x, y) => x - y);
      return `<h2>🎯 Épargne, plafond et alertes</h2><form data-form="settings">
        <label>Mettre de côté chaque mois (€)<input name="reserve" inputmode="decimal" value="${euros(st.reserve)}" placeholder="0"></label>
        <label>Plafond de dépenses du mois (€, vide = aucun)<input name="globalCap" inputmode="decimal" value="${euros(st.globalCap)}"></label>
        <div class="muted">M’alerter quand un plafond atteint</div><div class="chips">${pcts.map(p => chip('alertPct', p, `${p} %`, st.alertPct === p)).join('')}</div>
        <label>M’alerter quand le reste à dépenser passe sous (€)<input name="lowSpendable" inputmode="decimal" value="${euros(st.lowSpendable)}"></label>
        <button>Enregistrer</button>${cancelBtn}</form>`;
    },
    rec: () => `<h2>🔁 Échéances récurrentes</h2>`
      + (S.recurring.map(r => `<div class="op"><div class="av">${r.kind === 'income' ? '💶' : catIcon(catName(r.categoryId))}</div><div class="l">${esc(r.label)}<div class="muted">le ${r.day} de chaque mois · ${esc(accName(r.accountId))}</div></div>`
        + `<div class="r">${money(B.signed(r.kind, r.cents))}<div class="actions">${btn('delRec', r.id, 'Suppr.', 'small danger')}</div></div></div>`).join('') || empty('Aucune pour l’instant.'))
      + `<h2 style="margin-top:16px">Ajouter</h2><form data-form="rec">
        <div class="chips" style="justify-content:center">${chip('kind', 'expense', 'Dépense', true)}${chip('kind', 'income', 'Entrée (salaire…)', false)}</div>
        <div class="amount"><input name="amount" inputmode="decimal" placeholder="0,00 €" required aria-label="Montant en euros"></div>
        <input name="label" placeholder="Nom : loyer, Netflix, salaire…" required>${catChips('')}
        <div class="muted">Compte</div><div class="chips">${S.accounts.map((x, k) => chip('accountId', x.id, esc(x.name), k === 0)).join('')}</div>
        <label>Le combien du mois ?<input name="day" type="number" min="1" max="31" placeholder="ex. 5" required></label>
        <button>Ajouter l’échéance</button>${cancelBtn}${empty('Chaque mois, elle apparaît dans « À venir » et compte comme payée à sa date.')}</form>`,
    cats: () => `<h2>🏷️ Catégories et plafonds</h2>${empty('Un plafond est un budget maximum par mois (vide = aucun).')}`
      + S.categories.map(c => `<form data-form="cat" class="op" style="display:grid;grid-template-columns:auto 1fr 90px auto;gap:8px;align-items:center"><input type="hidden" name="id" value="${c.id}">
        <div class="av">${catIcon(c.name)}</div><input name="name" value="${esc(c.name)}" required aria-label="Nom"><input name="cap" inputmode="decimal" value="${euros(c.cap)}" placeholder="Plafond" aria-label="Plafond mensuel">
        <button class="small">OK</button></form>`).join('')
      + `<form data-form="cat" style="margin-top:12px;grid-template-columns:1fr 90px auto;display:grid;gap:8px"><input name="name" placeholder="Nouvelle catégorie" required><input name="cap" inputmode="decimal" placeholder="Plafond"><button class="small">Ajouter</button></form>`
      + `<div style="margin-top:12px">${S.categories.map(c => btn('delCat', c.id, `🗑 ${esc(c.name)}`, 'small danger')).join(' ')}</div>${cancelBtn}`,
    backup: () => `<h2>💾 Sauvegarde et export</h2><form data-form="backup"><label>Mot de passe de la sauvegarde<input type="password" name="pw" placeholder="8 caractères minimum" autocomplete="new-password" required></label>
        <button>Télécharger une sauvegarde chiffrée</button></form>
        <form data-form="restore" style="margin-top:16px"><div class="muted">Restaurer une sauvegarde (remplace les données de ce téléphone)</div><input type="file" name="file" accept=".json,application/json" required>
        <input type="password" name="pw" placeholder="Mot de passe de la sauvegarde" autocomplete="current-password" required><button class="ghost">Restaurer</button></form>
        <div style="margin-top:16px;display:grid;gap:10px">${btn('csv', '', 'Exporter les mouvements (CSV, pour Excel)', 'ghost')}${cancelBtn}</div>`,
  }[kind]?.();
  return body ? `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet" role="dialog"><div class="grip"></div>${body}</div>` : '';
}

function opSheet() {
  const e = view.edit && S.ops.find(o => o.id === view.edit), t = today(), y = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE');
  const when = !e || e.date === t ? 'today' : e.date === y ? 'yesterday' : 'other', kind = e?.kind ?? 'expense';
  const acc = e?.accountId ?? (view.account || S.accounts.find(a => a.liquid)?.id || S.accounts[0]?.id);
  const radio = (name, value, label, on) => `<label><input type="radio" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}><span>${label}</span></label>`;
  return `<form data-form="op" aria-label="${e ? 'Modifier le mouvement' : 'Nouveau mouvement'}">
    <div class="chips" style="justify-content:center">${radio('kind', 'expense', 'Dépense', kind === 'expense')}${radio('kind', 'income', 'Entrée', kind === 'income')}${radio('kind', 'refund', 'Remboursement', kind === 'refund')}</div>
    <div class="amount"><input name="amount" inputmode="decimal" placeholder="0,00 €" required value="${e ? euros(Math.abs(e.amount)) : ''}" aria-label="Montant en euros"></div>
    <div class="muted">Catégorie</div>
    <div class="cats">${[...S.categories.map(c => [c.id, c.name]), ['', 'Aucune']].map(([id, n]) => `<label><input type="radio" name="categoryId" value="${esc(id)}"${(e?.categoryId ?? '') === id ? ' checked' : ''}><span><b>${id ? catIcon(n) : '·'}</b>${esc(n)}</span></label>`).join('')}</div>
    <div class="muted">Compte</div><div class="chips">${S.accounts.map(a => radio('accountId', a.id, esc(a.name), a.id === acc)).join('')}</div>
    <div class="muted">Date</div><div class="chips">${radio('when', 'today', 'Aujourd’hui', when === 'today')}${radio('when', 'yesterday', 'Hier', when === 'yesterday')}${radio('when', 'other', 'Autre date :', when === 'other')}</div>
    <input type="date" name="date" value="${e?.date ?? t}" aria-label="Autre date" data-change="otherDate">
    <input name="label" placeholder="Note (facultatif), ex. Carrefour" value="${esc(e?.label)}">
    <label class="chk"><input type="checkbox" name="planned"${e?.planned ? ' checked' : ''}> Pas encore payé (à venir)</label>
    <button style="padding:15px;font-size:16px">${e ? 'Enregistrer' : 'Ajouter'}</button>
    ${e ? btn('del', e.id, 'Supprimer ce mouvement', 'danger') : ''}
    <button type="button" class="ghost" data-act="closeSheet">Annuler</button></form>`;
}
// Last 3 months of closes as a small line, green when the price went up over the period, red when down.
function spark(isin) {
  const h = (S.history[isin] ?? []).slice(-63).map(x => x[1]);
  if (h.length < 2) return '';
  const lo = Math.min(...h), hi = Math.max(...h), y = p => 26 - ((p - lo) / (hi - lo || 1)) * 24;
  return `<svg class="spark" viewBox="0 0 72 28" aria-hidden="true"><polyline fill="none" stroke="${h.at(-1) >= h[0] ? 'var(--good)' : 'var(--bad)'}" stroke-width="2" stroke-linejoin="round"
    points="${h.map((p, k) => `${((k * 72) / (h.length - 1)).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}"/></svg>`;
}
// The title's price over 1, 3 or 6 months (daily closes), with its change over the period, high and low.
function priceChart(isin, currency) {
  const all = S.history[isin] ?? [], range = view.range ?? '3m';
  if (all.length < 2) return empty('La courbe apparaît après la première actualisation des cours.');
  const h = all.slice(-{ '1m': 22, '3m': 63, '6m': 130, '1y': 260 }[range]), p = h.map(x => x[1]);
  const lo = Math.min(...p), hi = Math.max(...p), W = 320, H = 150, x = k => (k * W) / (h.length - 1), y = v => 14 + (1 - (v - lo) / (hi - lo || 1)) * (H - 40);
  const up = p.at(-1) >= p[0], col = up ? 'var(--good)' : 'var(--bad)', chg = (p.at(-1) / p[0] - 1) * 100;
  const pts = h.map((q, k) => `${x(k).toFixed(1)},${y(q[1]).toFixed(1)}`).join(' '), two = v => v.toFixed(2).replace('.', ',');
  return `<div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:22px">${two(p.at(-1))} ${currency}</b>`
    + `<b style="color:${col}">${chg >= 0 ? '▲ +' : '▼ '}${chg.toFixed(1).replace('.', ',')} %</b></div>`
    + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du cours" style="width:100%;height:auto;margin-top:4px">`
    + `<defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#16a34a' : '#dc2626'}" stop-opacity=".28"/><stop offset="1" stop-color="${up ? '#16a34a' : '#dc2626'}" stop-opacity="0"/></linearGradient></defs>`
    + `<polygon fill="url(#pg)" points="0,${H - 26} ${pts} ${W},${H - 26}"/><polyline fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`
    + `<text x="2" y="10" font-size="10" fill="var(--muted)">max ${two(hi)}</text><text x="2" y="${H - 30}" font-size="10" fill="var(--muted)">min ${two(lo)}</text>`
    + `<text x="2" y="${H - 6}" font-size="10" fill="var(--muted)">${shortDate(h[0][0])}</text><text x="${W - 2}" y="${H - 6}" font-size="10" text-anchor="end" fill="var(--muted)">${shortDate(h.at(-1)[0])}</text></svg>`
    + `<div class="seg">${[['1m', '1 mois'], ['3m', '3 mois'], ['6m', '6 mois'], ['1y', '1 an']].map(([r, t]) => `<button class="${range === r ? '' : 'ghost'}" data-act="range" data-id="${r}">${t}</button>`).join('')}</div>`;
}
const fab = () => `<button class="fab" data-act="newOp" aria-label="Ajouter un mouvement">＋</button>`;

const PALETTE = ['#0f766e', '#4f46e5', '#0e7490', '#c026d3', '#ea580c', '#ca8a04', '#16a34a', '#e11d48', '#64748b'];

// Spending of the month (ring) or of the last 12 months (bars), by category; a category opens on its payments.
function spendCard(m) {
  const year = view.period === 'year', months = B.monthsBack(m, 12), from = year ? months[0] : m;
  const rows = B.spendingByCategory(S, from, m), total = rows.reduce((t, c) => t + c.spent, 0);
  const prev = B.spendingByCategory(S, months[10], months[10]).reduce((t, c) => t + c.spent, 0);
  const seg = `<div class="seg" style="margin-bottom:12px">${[['month', 'Ce mois'], ['year', '12 mois']].map(([p, t]) => `<button class="${(p === 'year') === year ? '' : 'ghost'}" data-act="period" data-id="${p}">${t}</button>`).join('')}</div>`;
  const compare = year ? `soit ${eur(Math.round(total / 12))} par mois en moyenne`
    : prev ? `${total >= prev ? '▲ +' : '▼ −'}${eur(Math.abs(total - prev))} par rapport au mois précédent` : '';
  const R = 52, C = 2 * Math.PI * R;
  let acc = 0;
  const ring = `<div class="donut"><svg viewBox="0 0 140 140" width="170" height="170" role="img" aria-label="Répartition des dépenses par catégorie">
    <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--soft)" stroke-width="18"/>`
    + rows.map((c, k) => { const len = (c.spent / (total || 1)) * C, s = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="18"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`; acc += len; return s; }).join('')
    + `</svg><div class="c"><b>${eur(total)}</b><span class="muted">dépensés</span></div></div>`;
  const chart = series => {
    const top = Math.max(...series.map(x => x.spent), 1);
    return `<svg viewBox="0 0 300 118" role="img" aria-label="Dépenses des 12 derniers mois" style="width:100%;height:auto;margin:2px 0 12px">`
      + series.map((x, k) => {
        const h = (Math.max(0, x.spent) / top) * 92;
        return `<rect x="${k * 25 + 4}" y="${100 - h}" width="17" height="${h}" rx="5" fill="var(--accent)" opacity="${k === series.length - 1 ? 1 : 0.45}"><title>${x.month} : ${eur(x.spent)}</title></rect>`
          + `<text x="${k * 25 + 12.5}" y="114" font-size="9" text-anchor="middle" fill="var(--muted)">${'JFMAMJJASOND'[+x.month.slice(5) - 1]}</text>`;
      }).join('') + '</svg>';
  };
  const catRow = (c, k) => `<details class="cat"><summary><div class="legend"><span class="dot" style="background:${PALETTE[k % PALETTE.length]}"></span>`
    + `<span class="av" style="width:34px;height:34px;font-size:17px;border-radius:11px">${c.id ? catIcon(c.name) : '·'}</span><span style="flex:1">${esc(c.name)}`
    + (!year && c.cap ? `<span class="muted" style="display:block">${c.spent > c.cap ? '<b class="bad">plafond dépassé</b>' : `plafond ${eur(c.cap)}`}</span>` : '')
    + `</span><span style="text-align:right;font-weight:650">${eur(c.spent)}<span class="muted" style="display:block">${Math.round((c.spent * 100) / total)} %</span></span></div></summary>`
    + [...c.ops].sort((a, b) => a.amount - b.amount).slice(0, 10).map(opItem).join('') + (c.ops.length > 10 ? empty(`… et ${c.ops.length - 10} autre(s)`) : '') + '</details>';
  return card('Mes dépenses', seg + (year ? `<div style="font-size:28px;font-weight:800">${eur(total)}</div>${empty(compare)}${chart(B.monthlySpending(S, m, 12))}`
    : (total ? ring + (compare ? `<div class="muted" style="text-align:center;margin-bottom:8px">${compare}</div>` : '') : ''))
    + (rows.map(catRow).join('') || empty('Aucune dépense sur cette période.')));
}

// ---- views ----
const views = {
  dash() {
    const m = view.month, st = B.monthStats(S, m), al = B.alerts(S, m), up = B.upcoming(S, m), stale = B.staleAccounts(S, today());
    const thisMonth = m === B.monthOf(today()), pct = st.income ? Math.min(100, Math.round((st.spent * 100) / st.income)) : 0;
    const paid = S.ops.filter(o => !o.planned && B.monthOf(o.date) === m && o.kind === 'expense').sort((a, b) => b.date.localeCompare(a.date));
    const aside = [st.reserve && `épargne prévue ${eur(st.reserve)}`, st.stock && `bourse ${eur(st.stock)}`].filter(Boolean);
    const account = a => `<div class="op"><div class="av">${ACC_TYPES[accType(a)][0]}</div><div class="l">${esc(a.name)}<div class="muted">${esc(a.institution)} · ${ACC_TYPES[accType(a)][1]}</div></div><div class="r">${acctAmount(a)}</div></div>`;
    return monthBar(false)
      + `<section class="hero"><div class="lbl">Reste à dépenser ${thisMonth ? 'ce mois-ci' : `en ${monthName(m)}`}</div><div class="big">${eur(st.spendable)}</div>`
      + (st.shortfall ? `<div style="font-weight:700">⚠️ Il manque ${eur(st.shortfall)} pour couvrir ce qui est prévu</div>` : '')
      + (st.income ? `<div class="bar" style="margin-top:12px"><i style="width:${pct}%"></i></div><div class="lbl" style="font-size:12px;margin-top:4px">${pct} % de vos entrées déjà dépensées</div>` : '')
      + `<div class="stats"><div><small>Entrées</small>${eur(st.income)}</div><div><small>Sorties</small>${eur(st.spent)}</div><div><small>À venir</small>${eur(st.expectedSpent)}</div></div>`
      + `<div class="lbl" style="font-size:12px;margin-top:10px">Solde du mois ${eur(st.toDate)}${st.savedTransfer ? ` · versé sur l’épargne ${eur(st.savedTransfer)}` : ''}${aside.length ? ` · déjà mis de côté : ${aside.join(', ')}` : ''}</div></section>`
      // one banner per category, its highest threshold; « OK » dismisses every threshold reached
      + [...new Set(al.map(a => a.label))].map(l => { const all = al.filter(a => a.label === l), a = all.at(-1);
        return `<div class="banner ${a.pct >= 100 ? 'bad' : 'warn'}"><span>${a.pct >= 100 ? '🚨' : '⚠️'} ${esc(l)} : ${a.pct >= 100 ? 'plafond dépassé' : `${a.pct} % du plafond`} (${eur(a.spent)} / ${eur(a.cap)})</span>${btn('dismiss', all.map(x => x.id).join(','), 'OK')}</div>`; }).join('')
      + spendCard(m)
      + card(`À venir${up.length ? ` · ${eur(up.reduce((t, o) => t - o.amount, 0))}` : ''}`, (up.map(opItem).join('')
        + (up.length ? empty('Comptée comme payée à sa date ; si la banque prélève un autre montant, le vrai mouvement la remplace.') : ''))
        || empty('Rien à venir. Ajoutez loyer, abonnements… dans Réglages › Échéances récurrentes.'))
      + (paid.length ? card(`Déjà payé · ${eur(paid.reduce((t, o) => t - o.amount, 0))}`, paid.slice(0, 6).map(opItem).join('')
        + (paid.length > 6 ? `<div style="margin-top:8px">${btn('goOps', '', `Voir les ${paid.length} paiements →`, 'small ghost')}</div>` : '')) : '')
      + card('Mes comptes', byBank(S.accounts).map(account).join('') || empty('Aucun compte : créez-en dans Réglages.'))
      + (stale.length ? `<div class="banner warn"><span>🕒 ${stale.length} compte(s) sans mouvement depuis 30 jours : ${stale.map(x => esc(x.a.name)).join(', ')}</span></div>` : '')
      + fab();
  },

  ops() {
    const list = S.ops.filter(o => B.monthOf(o.date) === view.month && (!view.account || o.accountId === view.account)).sort((a, b) => b.date.localeCompare(a.date));
    const pairs = B.transferCandidates(S), days = [...new Set(list.map(o => o.date))];
    const inOut = list.filter(o => !o.planned).reduce((t, o) => (o.kind === 'income' ? [t[0] + o.amount, t[1]] : ['expense', 'refund'].includes(o.kind) ? [t[0], t[1] - o.amount] : t), [0, 0]);
    return monthBar()
      + `<div class="grid2" style="margin-bottom:14px"><div class="card" style="margin:0"><div class="muted">Entrées</div><b class="pos" style="font-size:18px">${eur(inOut[0])}</b></div>`
      + `<div class="card" style="margin:0"><div class="muted">Sorties</div><b class="neg" style="font-size:18px">${eur(inOut[1])}</b></div></div>`
      + (pairs.length ? card('🔁 Virements entre vos comptes ?', empty('Ces deux mouvements semblent être un même virement. Liez-les pour qu’ils ne comptent ni en entrée ni en sortie.')
        + pairs.map(([o, i]) => `<div class="op"><div class="l">${esc(o.label)} → ${esc(i.label)}<div class="muted">${shortDate(o.date)} · ${esc(accName(o.accountId))} → ${esc(accName(i.accountId))}</div></div>`
          + `<div class="r">${eur(i.amount)}<div class="actions">${btn('link', `${o.id}|${i.id}`, 'Lier', 'small')}${btn('notLink', `${o.id}|${i.id}`, 'Non')}</div></div></div>`).join('')) : '')
      + card(`${list.length} mouvement(s)`, days.map(d => `<div class="day">${new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>`
        + list.filter(o => o.date === d).map(opItem).join('')).join('') || empty('Aucun mouvement ce mois. Touchez ＋ pour en ajouter un.'))
      + fold('transfer', '🔁 Virement entre mes comptes', `<form data-form="transfer"><div class="grid2"><label>De<select name="from">${accOpts()}</select></label><label>Vers<select name="to">${accOpts(S.accounts[1]?.id)}</select></label></div>
        <div class="grid2"><input name="amount" inputmode="decimal" placeholder="Montant €" required><input type="date" name="date" required value="${today()}"></div>
        <button>Enregistrer le virement</button>${empty('Ne compte ni en entrée ni en sortie.')}</form>`)
      + fold('importOps', '📄 Importer un relevé bancaire (CSV)', importBlock(), !!view.preview)
      + fab();
  },

  stock() {
    const t = today(), lines = B.valuation(S, t), mk = S.settings.market, sug = B.suggestions(S, t), pf = S.settings.profile;
    const ready = mk.enabled && (mk.proxyUrl || mk.avKey), lr = S.lastRefresh;
    const held = sug.filter(x => x.held), noAdvice = held.filter(x => x.suspended).length;
    const envs = S.envelopes.filter(e => e.month === view.month), open = envs.filter(e => B.envelopeLeft(S, e) > 0);
    const left = envs.reduce((a, e) => a + B.envelopeLeft(S, e), 0);
    const brokers = S.accounts.filter(a => S.ops.some(o => o.kind === 'invest' && o.accountId === a.id));
    const total = ls => ls.reduce((a, l) => a + (l.value ?? 0), 0), missing = lines.filter(l => l.value == null).length;
    const inst = isin => S.instruments.find(i => i.isin === isin), sr0 = view.search && !view.search.forIsin;
    const cash = S.accounts.filter(a => ['cto', 'pea'].includes(accKind(a)) || brokers.includes(a));
    const quoteInfo = (q, i) => (q ? `${num(q.price)} ${i.currency} · ${q.asOf} · ${esc(q.source)}` : 'cours indisponible');
    const staleTag = on => (on ? '<span class="tag warn">périmé</span>' : '');
    const cls = { Acheter: 'good', Renforcer: 'good', Attendre: 'muted', Alléger: 'warn', Vendre: 'bad', 'À examiner': 'warn', Suspendu: 'muted' };
    const badge = x => `<span class="verdict ${cls[x.action] ?? ''}">${esc(x.action)}</span>`;
    const instOpts = list => opts(list.map(i => [i.isin, i.name]));
    const signOf = r => (r.pts > 0 ? '<b class="good">+</b>' : r.pts < 0 ? '<b class="bad">−</b>' : '<span class="muted">•</span>');
    const meta = r => (r.asOf || r.source ? ` <span class="muted">· ${[r.asOf, r.source].filter(Boolean).map(esc).join(' · ')}</span>` : '');

    const titleRow = x => {
      const ls = lines.filter(l => l.isin === x.isin), q = S.quotes[x.isin], i = inst(x.isin);
      const main = [...x.reasons].sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
      const gain = ls.reduce((a, l) => a + (l.gain ?? 0), 0);
      return `<div class="op tap" data-act="inst" data-id="${esc(x.isin)}"><div class="l"><b>${esc(x.name)}</b> ${badge(x)}${i.auto && !ls.length ? '<span class="tag">repéré par l’outil</span>' : ''}`
        + (ls.length ? `<div class="muted">🏦 ${ls.map(l => `${esc(accTag(l.accountId))} · ${num(l.qty)} part(s)`).join(' — ')}</div>` : '')
        + `<div class="muted">${main ? esc(main.text) : ''}</div>`
        + (x.buy ? `<div class="good">Enveloppe : ${num(x.buy.qty)} part(s) ≈ ${eur(x.buy.total)} sur ${esc(accName(x.buy.accountId))}</div>` : '') + '</div>'
        + spark(x.isin) + `<div class="r">${ls.length ? (ls.every(l => l.value == null) ? '<span class="muted">non valorisé</span>' : `${eur(total(ls))}<div>${money(gain)}</div>`)
          : q ? `${num(q.price)} ${i.currency}` : ''}</div></div>`;
    };

    const sheet = isin => {
      const i = inst(isin), x = sug.find(y => y.isin === isin);
      if (!i || !x) return '';
      const q = S.quotes[isin], news = B.newsFor(S, isin), noOps = !S.ops.some(o => o.isin === isin) && !lines.some(l => l.isin === isin);
      return card(`${esc(i.name)} ${btn('closeInst', '', 'Fermer')}`,
        priceChart(isin, i.currency)
        + `<div style="margin:12px 0 8px">${badge(x)} <span class="muted">score ${x.score > 0 ? '+' : ''}${num(x.score)}</span></div>`
        + [['👍 Pour', r => r.pts > 0], ['👎 Contre', r => r.pts < 0], ['ℹ️ À savoir', r => !r.pts]].map(([t, keep]) => {
          const rs = x.reasons.filter(keep);
          return rs.length ? `<div class="day">${t}</div>` + rs.map(r => `<div class="row"><span>${signOf(r)} ${esc(r.text)}${meta(r)}</span></div>`).join('') : '';
        }).join('')
        + (x.missing?.length ? `<div class="day">❔ Données manquantes</div>${x.missing.map(m => `<div class="muted">• ${esc(m)}</div>`).join('')}` : '')
        + (x.invalidation ? `<div class="day">🔄 Ce qui changerait l’avis</div><div class="muted">${esc(x.invalidation)}</div>` : '')
        + (x.confidence ? `<div class="day">Confiance : ${x.confidence}</div>${empty('Qualité et quantité des données derrière cet avis, pas une probabilité de gain.')}` : '')
        + ((ind => (!ind ? '' : `<details style="margin-top:10px"><summary><b>📊 Indicateurs</b></summary>`
          + [[`Moyenne 50 jours : ${ind.sma50 ? ind.sma50.toFixed(2).replace('.', ',') : '—'}`, 'Le cours moyen des 2,5 derniers mois. Au-dessus : tendance courte haussière.'],
            [`Moyenne 200 jours : ${ind.sma200 ? ind.sma200.toFixed(2).replace('.', ',') : 'il faut 1 an de cours'}`, 'La tendance de fond. Beaucoup d’investisseurs la surveillent.'],
            [`RSI : ${Math.round(ind.rsi)}`, 'Vitesse des dernières hausses et baisses (14 jours). Au-dessus de 70 : la hausse s’emballe ; sous 30 : la baisse s’emballe. Ce n’est pas un signal d’achat ou de vente à lui seul.'],
            [`Volatilité : ${Math.round(ind.vol)} % par an`, 'Amplitude habituelle des variations. Sous 20 % : calme ; au-dessus de 40 % : très agité.'],
            [`Baisse depuis le plus haut : ${ind.drawdown.toFixed(1).replace('.', ',')} %`, `Plus haut ${ind.hi.toFixed(2).replace('.', ',')} · plus bas ${ind.lo.toFixed(2).replace('.', ',')} sur ${ind.days >= 250 ? '52 semaines' : `${ind.days} séances`}.`]]
            .map(([v, e]) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${v}</b><div class="muted">${e}</div></div>`).join('') + '</details>'))(B.indicators(S, isin)))
        + ((r => (r ? `<details style="margin-top:10px"><summary><b>🧮 Si vous suivez l’avis : ${num(x.buy.qty)} part(s)</b></summary><div style="margin-top:10px">` + [['Parts après l’achat', `${num(r.held)} → <b>${num(r.newQty)}</b>`], ['Coût de l’achat (frais estimés inclus)', eur(r.add)],
            ['Nouveau prix de revient par part', `<b>${eur(Math.round(r.pru))}</b>`], ['Poids dans le portefeuille', `${r.weightBefore.toFixed(1).replace('.', ',')} % → <b>${r.weightAfter.toFixed(1).replace('.', ',')} %</b>`]]
            .map(([l, v]) => `<div class="row"><span>${l}</span><span>${v}</span></div>`).join('')
            + `<div class="day">Si ensuite le cours varie de…</div>` + r.at.map(c => `<div class="row"><span>${c.change > 0 ? '+' : ''}${c.change} %</span>${money(c.gain)}</div>`).join('')
            + empty('Gain ou perte sur toute la ligne après cet achat. Calcul seulement : rien n’est enregistré.') + '</div></details>' : ''))(
          x?.buy && q ? (() => { try { return B.simulate(S, t, isin, x.buy.qty, q.price, x.buy.fees); } catch { return null; } })() : null))
        + ((ds => (ds.length ? `<details style="margin-top:10px"><summary><b>📓 Avis passés de l’outil · ${ds.length}</b></summary>${ds.map(d => decisionRow(d)).join('')}</details>` : ''))(
          B.journalReview(S).filter(d => d.isin === isin)))
        + `<div class="muted" style="margin:6px 0">${B.DISCLAIMER}</div>`
        + `<div class="row"><span>Cours</span><span>${quoteInfo(q, i)}${staleTag(q && B.isStale(q.asOf, t))}</span></div>`
        + lines.filter(l => l.isin === isin).map(l => `<div class="row"><span>${esc(accName(l.accountId))} · ${num(l.qty)} part(s) · revient ${eur(l.cost)}</span><span>${l.value == null ? 'non valorisé' : eur(l.value)}</span></div>`).join('')
        + ((r => (r ? `<div class="row"><span>Plus-value déjà encaissée (ventes)</span>${money(r)}</div>` : ''))(B.realizedGain(S, isin)))
        + ((ops => (ops.length ? `<details style="margin-top:8px"><summary class="muted">Historique des opérations · ${ops.length}</summary>`
          + ops.map(o => `<div class="row"><span>${shortDate(o.date)} · ${esc(accName(o.accountId))} · ${esc(o.label)}${o.qty ? ` · ${num(Math.abs(o.qty))} part(s)` : ''}</span>${o.split ? '' : money(o.amount)}</div>`).join('') + '</details>' : ''))(
          S.ops.filter(o => o.isin === isin).sort((a, b) => b.date.localeCompare(a.date))))
        + '<h2 style="margin-top:10px">Actualités</h2>'
        + (news.map(n => `<div class="op${B.isOldNews(n, t) ? ' old' : ''}"><div class="l"><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
          + `<div class="muted">${esc(n.source)} · ${n.publishedAt}</div></div></div>`).join('') || empty('Aucune actualité.'))
        + '<details style="margin-top:12px"><summary><b>⚙️ Gérer ce titre</b> <span class="muted">vente, division, cotation</span></summary>'
        + lines.filter(l => l.isin === isin).map(l => `<details style="margin-top:8px"><summary><b>J’ai vendu</b> <span class="muted">sur ${esc(accName(l.accountId))}</span></summary>
          <form data-form="sale"><input type="hidden" name="pos" value="${esc(`${l.accountId}|${isin}`)}">
          <div class="grid2"><label>Quantité vendue<input name="qty" inputmode="decimal" value="${num(l.qty)}"></label><label>Montant net reçu (€)<input name="amount" inputmode="decimal" required></label></div>
          <input type="date" name="date" value="${t}" required><button>Enregistrer la vente</button>
          ${empty('Quantité pré-remplie avec tout ce que vous détenez : changez-la si vous avez vendu une partie.')}</form></details>`).join('')
        + (lines.some(l => l.isin === isin) ? `<details style="margin-top:8px"><summary class="muted">Déclarer une division (split)</summary><form data-form="split">
          <input type="hidden" name="isin" value="${esc(isin)}"><select name="accountId">${opts(lines.filter(l => l.isin === isin).map(l => [l.accountId, accName(l.accountId)]))}</select>
          <div class="grid2"><label>Ratio (10 pour « 10 pour 1 »)<input name="ratio" inputmode="decimal" required></label><label>Date<input type="date" name="date" value="${t}" required></label></div>
          <button class="ghost">Enregistrer la division</button>${empty('La quantité est multipliée, le coût total ne change pas. Inutile si l’export de votre courtier est postérieur à la division.')}</form></details>` : '')
        + `<div class="grid2" style="margin-top:8px">${btn('findSymbol', isin, i.symbol ? 'Changer de cotation' : 'Trouver le cours', 'ghost')}${btn('delInst', isin, noOps ? 'Ne plus suivre' : 'Supprimer ce titre', 'danger')}</div>`
        + `<details style="margin-top:8px"><summary class="muted">Détails techniques</summary><form data-form="instrument"><input type="hidden" name="isin" value="${esc(isin)}">
          <div class="grid2"><input name="name" value="${esc(i.name)}" aria-label="Nom"><input name="symbol" value="${esc(i.symbol)}" placeholder="Symbole de cours" aria-label="Symbole"></div>
          <div class="grid2"><input name="currency" value="${esc(i.currency)}" maxlength="3" aria-label="Devise"><input name="place" value="${esc(i.place)}" placeholder="Place" aria-label="Place"></div>
          <button class="ghost">Enregistrer</button></form></details>`
        + '</details>');
    };

    const searchCard = () => {
      const sr = view.search, target = sr?.forIsin && inst(sr.forIsin);
      return (target ? (b => card(`Cotation de ${esc(target.name)} ${btn('cancelSearch', '', 'Annuler')}`, b)) : (b => fold('add', 'Suivre un autre titre', b, !!sr)))(
        `<form data-form="search" class="grid2" style="grid-template-columns:1fr auto"><input name="q" placeholder="Nom ou ticker : MSCI World, TotalEnergies…" value="${esc(sr?.q)}" required><button class="small">Chercher</button></form>`
        + (sr ? sr.results.map((r, k) => `<div class="op"><div class="l">${esc(r.name)}<div class="muted">${esc(r.symbol)} · ${esc(r.type)} · ${esc(r.region)} · ${esc(r.currency)}</div></div>`
          + `<div class="r">${btn('pick', k, target ? 'Choisir' : 'Suivre', 'small')}</div></div>`).join('') || empty('Aucun résultat : essayez le ticker ou un autre nom.') : '')
        + (ready ? '' : empty('La recherche a besoin du service de cours : voir « Réglages bourse » plus bas.'))
);
    };

    return (view.inst ? sheet(view.inst) : '')
      + (view.search?.forIsin ? searchCard() : '')
      + (lines.length ? (() => {
        const valued = lines.filter(l => l.value != null), gainAll = valued.reduce((a, l) => a + l.gain, 0), costAll = valued.reduce((a, l) => a + l.cost, 0);
        return `<section class="hero"><div class="lbl">Mon portefeuille</div><div class="big">${eur(total(lines))}</div>`
          + `<div style="font-weight:700;font-size:16px">${gainAll >= 0 ? '▲ +' : '▼ −'}${eur(Math.abs(gainAll))}${costAll ? ` (${gainAll >= 0 ? '+' : '−'}${Math.abs((gainAll * 100) / costAll).toFixed(1).replace('.', ',')} %)` : ''}</div>`
          + `<div class="stats"><div><small>Positions</small>${held.length}</div><div><small>Avis à suivre</small>${held.filter(x => ['Renforcer', 'Alléger', 'Vendre', 'À examiner'].includes(x.action)).length}</div><div><small>Idées</small>${sug.filter(x => !x.held && x.action === 'Acheter').length}</div></div></section>`;
      })() : '')
      + `<section class="card"><div class="row" style="border:0;align-items:center"><span>${!ready ? '<b class="warn">Service de cours à configurer</b>'
          : noAdvice ? `<b class="warn">${noAdvice} titre(s) sans avis</b>` : held.length ? '<b class="good">Tous vos titres ont un avis ✓</b>' : '<b>Bourse</b>'}</span>`
        + (ready ? btn('refreshAll', '', 'Actualiser', 'small') : '') + '</div>'
        + (!ready ? empty('Ouvrez « Réglages bourse » en bas de page : 5 minutes de configuration, une seule fois.') : '')
        + (view.refreshing ? empty('⏳ Actualisation des cours, actualités et avis…') : lr ? empty(`Dernière actualisation : ${new Date(lr.at).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`) : '')
        + (lr?.errors.length ? `<details><summary class="warn">${lr.errors.length} point(s) à régler</summary>${lr.errors.map(e => `<div class="muted">• ${esc(e)}</div>`).join('')}</details>` : '')
        + `<details><summary class="muted">Comment l’outil décide</summary><div class="muted">
          Pour chaque titre, il additionne des points : <b>+1/−1</b> si le cours est au-dessus/en dessous de sa moyenne des 50 derniers jours,
          <b>±0,5</b> pour une forte hausse/baisse sur 3 mois, <b>±1</b> selon le ton des actualités des 14 derniers jours,
          <b>±1 ou 2</b> si le titre s’écarte de la part que vous visez, <b>−2</b> si votre perte maximale ou votre stop est atteint.
          Total ≥ 2 : Acheter / Renforcer. Total ≤ −2 : Alléger ; ≤ −3 : Vendre. Sinon : Conserver / Attendre.
          Sans cours récent ou avec un cours incohérent, il ne donne pas d’avis (« Suspendu »).</div></details></section>`
      + card('Mes positions', (sug.filter(x => x.held).map(titleRow).join('') || empty('Aucune position. Importez un relevé courtier (plus bas).'))
        + (lines.length ? row('Valeur des positions', total(lines), 'total') : '')
        + (missing ? `<div class="warn">${missing} ligne(s) sans cours, exclue(s) du total.</div>` : '')
        + empty('Touchez un titre pour voir pourquoi : Renforcer, Conserver, Alléger ou Vendre.'))
      + card('Idées d’achat', (sug.filter(x => !x.held).sort((a, b) => (a.suspended ?? 0) - (b.suspended ?? 0) || b.score - a.score).map(titleRow).join('')
          || empty(ready && newsOn(mk) ? 'Appuyez sur « Actualiser ».' : 'Il faut le service de cours et la clé Marketaux (« Réglages bourse » plus bas).'))
        + empty('Chaque jour, l’outil repère les sociétés dont on parle le plus avec un ton positif, vérifie que leur cours monte, et garde les 5 meilleures. L’enveloppe du mois va à la meilleure.')
        + `<div class="muted" style="margin-top:6px"><b>${B.DISCLAIMER}</b> Les signaux ne garantissent aucun gain.</div>`)
      + fold('purchase', '➕ J’ai acheté une action', `<form data-form="purchase"><div class="muted">Chez</div>`
        + `<div class="chips">${byBank(cash.length ? cash : S.accounts).map((a, n) => chip('accountId', a.id, esc(accTag(a.id)), !n)).join('')}</div>`
        + `<label>ISIN<input name="isin" list="isins" placeholder="ex. FR0000120271" autocapitalize="characters" autocomplete="off" required></label>`
        + `<datalist id="isins">${S.instruments.map(i => `<option value="${esc(i.isin)}">${esc(i.name)}</option>`).join('')}</datalist>`
        + `<label>Nom <span class="muted">(seulement si c’est un nouveau titre)</span><input name="name" placeholder="ex. TotalEnergies"></label>`
        + `<div class="grid2"><label>Quantité<input name="qty" inputmode="decimal" required></label><label>Total payé, frais inclus (€)<input name="amount" inputmode="decimal" required></label></div>`
        + `<label>Date<input type="date" name="date" value="${t}" required></label><button>Enregistrer l’achat</button>`
        + `${empty('Le montant est retiré des espèces du courtier (cagnotte). Le cours et l’avis arrivent à la prochaine actualisation.')}</form>`)
      + (cash.length ? card(`💰 Ma cagnotte · ${eur(cash.reduce((n, x) => n + B.balance(S, x), 0))}`, `<form data-form="cash"><input type="hidden" name="date" value="${t}">`
        + byBank(cash).map(x => `<label>${esc(accTag(x.id))} <span class="muted">· espèces</span><input name="c_${esc(x.id)}" inputmode="decimal" value="${euros(B.balance(S, x))}"></label>`).join('')
        + `<button>Mettre à jour mes comptes</button>${empty('Recopiez les espèces affichées par chaque banque (dividendes compris). L’écart est enregistré dans Mouvements, hors budget du foyer.')}</form>`) : '')
      + `<details class="card fold" data-fold="more"${!ready || sr0 || view.trades || view.snap || view.open.has('more') ? ' open' : ''}><summary>⚙️ Autres options</summary>`
      + (view.search?.forIsin ? '' : searchCard())
      + fold('env', `Enveloppe du mois · reliquat ${eur(left)}`,
        (envs.map(e => `<div class="op"><div class="l">${esc(e.label)}<div class="muted">${eur(e.amount)} affectés · ${eur(B.envelopeUsed(S, e.id))} achetés${e.released ? ' · reliquat libéré' : ''}</div></div>`
          + `<div class="r">Reliquat ${eur(B.envelopeLeft(S, e))}<div class="actions">${B.envelopeLeft(S, e) > 0 ? btn('release', e.id, 'Libérer') : ''}</div></div></div>`).join('')
          || empty('Aucune enveloppe ce mois (pas de renouvellement automatique).'))
        + `<form data-form="env" style="margin-top:8px"><div class="grid2"><input name="amount" inputmode="decimal" placeholder="Montant €" required><input name="label" placeholder="Libellé" value="Enveloppe bourse"></div>
          <button class="ghost">Affecter à la bourse (${view.month})</button>${empty('Déduit immédiatement du dépensable du mois.')}</form>`
        + (open.length ? `<form data-form="buy" style="margin-top:8px"><b>Achat passé chez le courtier</b><select name="envId">${opts(open.map(e => [e.id, `${e.label} · reliquat ${eur(B.envelopeLeft(S, e))}`]))}</select>
          <div class="grid2"><select name="isin" aria-label="Titre"><option value="">— titre —</option>${instOpts(S.instruments)}</select><input name="qty" inputmode="decimal" placeholder="Quantité"></div>
          <div class="grid2"><input name="amount" inputmode="decimal" placeholder="Montant frais inclus €" required><select name="accountId">${accOpts(brokers[0]?.id)}</select></div>
          <input type="hidden" name="date" value="${t}"><input type="hidden" name="label" value="Achat"><button>Enregistrer l’achat</button></form>` : ''))
      + (S.instruments.length ? fold('trade', 'Saisir une position existante ou une vente',
        `<form data-form="holding"><div class="muted">Position détenue avant l’app</div>
          <div class="grid2"><select name="isin">${instOpts(S.instruments)}</select><select name="accountId">${accOpts(brokers[0]?.id)}</select></div>
          <div class="grid2"><input name="qty" inputmode="decimal" placeholder="Quantité" required><input name="cost" inputmode="decimal" placeholder="Prix de revient total €" required></div>
          <input type="hidden" name="date" value="${t}"><button class="ghost">Ajouter la position</button></form>`
        + (lines.length ? `<form data-form="sale" style="margin-top:12px"><div class="muted">Vente déjà passée chez le courtier</div>
          <select name="pos">${opts(lines.map(l => [`${l.accountId}|${l.isin}`, `${accName(l.accountId)} · ${l.inst.name} (${num(l.qty)})`]))}</select>
          <div class="grid2"><input name="qty" inputmode="decimal" placeholder="Quantité vendue" required><input name="amount" inputmode="decimal" placeholder="Montant net reçu €" required></div>
          <input type="hidden" name="date" value="${t}"><button class="ghost">Enregistrer la vente</button></form>` : '')) : '')
      + fold('import', 'Importer un relevé courtier (Fortuneo, Trade Republic, IBKR)', tradeImportBlock(), !!(view.trades || view.snap))
      + (brokers.length ? fold('brokers', 'Détail par courtier', brokers.map(a => {
        const ls = lines.filter(l => l.accountId === a.id);
        return `<h2 style="margin-top:10px">${esc(a.name)} · ${eur(B.accountTotal(S, a, t).total)}</h2>` + row('Encaisse', B.balance(S, a))
          + ls.map(l => row(`${esc(l.inst.name)} <span class="muted">${num(l.qty)} × ${quoteInfo(l.quote, l.inst)}</span>`, l.value ?? 0)).join('');
      }).join('') + empty('Change : taux de référence BCE, pas celui du courtier.')) : '')
      + (lines.some(l => l.value != null) ? fold('stress', '📉 Et si ça baisse ?', [10, 20, 30].map(d => `<div class="row"><span>Marché −${d} %</span>${money(-B.stressLoss(S, t, d))}</div>`).join('')
        + (lines.some(l => l.inst.currency === 'USD') ? `<div class="row"><span>Dollar −10 % (titres en $)</span>${money(-B.stressLoss(S, t, 0, 10))}</div>` : '')
        + empty('Perte sur la valeur actuelle du portefeuille si tous les titres baissent d’autant. L’encaisse n’est pas comptée.')) : '')
      + (S.journal?.length ? fold('journal', `📓 Avis de l’outil, vérifiés · ${S.journal.length}`, ((r, ok) => (ok.length ? empty(`${ok.filter(d => d.right).length} avis bien vu(s) sur ${ok.length} déjà jugeable(s).`) : '')
        + r.map(d => decisionRow(d, true)).join(''))(B.journalReview(S), B.journalReview(S).filter(d => d.right != null))
        + empty('Chaque avis Acheter, Renforcer, Alléger ou Vendre est noté tout seul avec le cours du jour. « Bien vu » : le cours a ensuite monté de plus de 2 % après un avis d’achat, ou baissé après un avis de vente.')) : '')
      + fold('profile', 'Mon profil et mes cibles', `<form data-form="profile">
        <div class="muted">Ma façon d’investir</div>
        <div class="chips">${chip('style', 'long', '🌳 Long terme : je garde', pf.style !== 'actif')}${chip('style', 'actif', '🔄 Actif : je vends les fortes hausses, je rachète les baisses', pf.style === 'actif')}</div>
        ${empty('En style actif, plus d’allers-retours veut dire plus de frais et, sur un compte-titres, plus d’impôts : à privilégier sur le PEA.')}
        <div class="muted">Une seule ligne ne doit pas dépasser</div>
        <div class="chips">${[0, 5, 10, 15, 20].map(w => chip('maxWeight', w, w ? `${w} % du portefeuille` : 'Pas de limite', (pf.maxWeight ?? 0) === w)).join('')}</div>
        <div class="muted">Je garde mes placements environ</div>
        <div class="chips">${[...new Set([2, 5, 10, 20, pf.horizon])].sort((x, y) => x - y).map(h => chip('horizon', h, `${h} ans`, pf.horizon === h)).join('')}</div>
        <div class="muted">Je supporte une baisse de</div>
        <div class="chips">${Object.entries(B.RISK).map(([k, r]) => chip('risk', k, `${r.label} · ${r.maxLoss} % max`, pf.risk === k)).join('')}</div>
        ${S.instruments.map(i => `<label>Part visée pour ${esc(i.name)} (%)<input name="t_${esc(i.isin)}" inputmode="decimal" value="${pf.targets[i.isin] ?? ''}"></label>`).join('')}
        <details><summary class="muted">Réglages avancés</summary>
        <div class="grid2"><label>Écart toléré (points)<input name="driftPts" type="number" min="1" max="50" value="${pf.driftPts}"></label>
        <label>Frais par ordre (€)<input name="fee" inputmode="decimal" value="${euros(pf.fee)}"></label></div>
        <label>Coût de change hors EUR (%)<input name="fxPct" inputmode="decimal" value="${String(pf.fxPct).replace('.', ',')}"></label></details>
        <button class="ghost">Enregistrer</button>${empty('Laisser une part vide : pas de cible pour ce titre. Le stop suiveur ne joue que sous 5 ans d’horizon.')}</form>`)
      + fold('keys', 'Réglages bourse (service de cours, clés)', `<form data-form="market"><label class="chk"><input type="checkbox" name="enabled"${mk.enabled ? ' checked' : ''}> Activer les données en ligne</label>
        <label>Adresse de votre service de cours<input name="proxyUrl" type="url" placeholder="https://prix-budget.xxx.workers.dev" value="${esc(mk.proxyUrl)}" autocomplete="off"></label>
        <label>Mot de passe du service<input type="password" name="proxyKey" value="${esc(mk.proxyKey)}" autocomplete="off"></label>
        <label>Clé Marketaux (actualités et idées)<input type="password" name="newsKey" value="${esc(mk.newsKey)}" autocomplete="off"${mk.newsInWorker ? ' placeholder="Rangée dans votre service ✓"' : ''}></label>
        <details><summary class="muted">Sans service de cours</summary><label>Clé Alpha Vantage (25 cours par jour)<input type="password" name="avKey" value="${esc(mk.avKey)}" autocomplete="off"></label></details>
        <div class="grid2"><button class="ghost">Enregistrer</button>${btn('testKeys', '', 'Tester', 'ghost')}</div></form>
        ${mk.proxyUrl ? `<div style="margin-top:12px"><b>🔔 Alertes même appli fermée</b>${mk.push
          ? `<div class="muted">Actives : votre service vérifie vos titres toutes les 30 min en semaine (seuil de perte, stop suiveur, forte hausse, ±6 % sur une séance).</div><div class="grid2">${btn('pushTest', '', 'Envoyer un essai', 'ghost')}${btn('pushOff', '', 'Désactiver', 'ghost')}</div>`
          : `<div class="muted">S’activent toutes seules dès que les notifications sont autorisées. Votre service reçoit seulement les noms des titres et les cours à surveiller : ni quantités ni montants.</div>${btn('pushOn', '', 'Autoriser les notifications', 'ghost')}`}</div>` : ''}
        <details style="margin-top:8px"><summary><b>Créer le service de cours (5 min, gratuit)</b></summary><div class="muted">
          1. Créez un compte sur <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener noreferrer">dash.cloudflare.com</a>.<br>
          2. « Workers et Pages » → « Créer » → « Hello World » → donnez-lui un nom (ex. prix-budget) → « Déployer ».<br>
          3. « Modifier le code » : remplacez tout par le contenu de <a href="cloudflare-worker.js" target="_blank">cloudflare-worker.js</a> → « Déployer ».<br>
          4. « Paramètres » → « Variables et secrets » → « Ajouter » : type Secret, nom <b>KEY</b>, valeur = un mot de passe de votre choix.<br>
          5. Ici : collez l’adresse du service (…workers.dev) et ce mot de passe, puis « Enregistrer » et « Tester ».</div></details>
        ${empty('Envoyés : à votre service, les ISIN et symboles suivis (et, si les alertes sont activées, les cours seuils de vos titres et l’adresse de notification du téléphone) ; à Marketaux, votre clé et les noms suivis. Jamais : quantités, montants, comptes, opérations.')}
        ${S.requestLog.slice(0, 10).map(r => `<div class="muted">${r.at.slice(0, 16).replace('T', ' ')} · ${esc(r.host)} · ${esc(r.symbols.join(', '))}</div>`).join('')}`, !ready)
      + (S.instruments.length ? fold('manual', 'Saisir un cours à la main', `<form data-form="quote"><select name="isin">${instOpts(S.instruments)}</select>
        <div class="grid2"><input name="price" inputmode="decimal" placeholder="Cours (devise de cotation)" required><input type="date" name="date" value="${t}" required></div><button class="ghost">Enregistrer le cours</button></form>`) : '')
      + '</details>';
  },

  settings() {
    const st = S.settings, notifOn = st.notify && canNotify() && Notification.permission === 'granted';
    const item = (id, icon, title, sub, right = '<span class="muted" style="font-size:22px">›</span>') => `<div class="op tap" data-act="panel" data-id="${esc(id)}"><div class="av">${icon}</div>`
      + `<div class="l">${title}${sub ? `<div class="muted">${sub}</div>` : ''}</div><div class="r">${right}</div></div>`;
    const t = today(), banks = [...new Set(byBank(S.accounts).map(a => a.institution))];
    return card('Mes comptes', banks.map(b => { const as = byBank(S.accounts).filter(a => a.institution === b);
      return `<div class="day">🏛️ ${esc(b)} · ${eur(as.reduce((n, a) => n + B.accountTotal(S, a, t).total, 0))}</div>` + as.map(a => { const k = accType(a), v = B.accountTotal(S, a, t);
        return item(`account:${a.id}`, ACC_TYPES[k][0], esc(a.name), ['pea', 'cto'].includes(k) ? `${ACC_TYPES[k][1]} · titres ${eur(v.securities)} · espèces ${eur(v.cash)}` : ACC_TYPES[k][1], money(v.total)); }).join(''); }).join('')
        + item('account:', '＋', '<b style="color:var(--accent)">Ajouter un compte</b>', ''))
      + card('Budget', item('budget:', '🎯', 'Épargne, plafond et alertes', `${eur(st.reserve)} mis de côté par mois · alerte sous ${eur(st.lowSpendable)}`)
        + item('rec:', '🔁', 'Échéances récurrentes', S.recurring.length ? S.recurring.map(r => esc(r.label)).join(', ') : 'loyer, abonnements, salaire…')
        + item('cats:', '🏷️', 'Catégories et plafonds', S.categories.map(c => catIcon(c.name)).join(' ')))
      + card('Téléphone', `<div class="op"><div class="av">🔔</div><div class="l">Notifications<div class="muted">avis bourse, plafonds, reste à dépenser</div></div>`
          + (canNotify() ? `<div class="r"><input type="checkbox" data-change="notif" aria-label="Notifications"${notifOn ? ' checked' : ''}></div>` : '') + '</div>'
          + (!canNotify() ? empty('Sur iPhone : ajoutez d’abord l’app à l’écran d’accueil, puis ouvrez-la depuis l’icône.')
            : notifOn ? `<div style="margin:0 0 6px 54px">${btn('testNotif', '', 'Envoyer un essai', 'small ghost')}</div>`
              : Notification.permission === 'denied' ? empty('Refusées dans les réglages du téléphone : autorisez-les pour cette app.') : '')
        + item('backup:', '💾', 'Sauvegarde et export', 'sauvegarde chiffrée, restauration, fichier Excel'))
      + card('Données', empty('Tout est enregistré sur ce téléphone uniquement. Pensez à faire une sauvegarde de temps en temps.')
        + `<div class="grid2" style="margin-top:10px">${btn('demo', '', 'Charger la démo', 'ghost')}${btn('reset', '', 'Tout effacer', 'danger')}</div>`);
  },
};

function importBlock() {
  const p = view.preview;
  if (!p) return `<form data-form="importFile"><select name="accountId">${accOpts(view.account)}</select><input type="file" name="file" accept=".csv,text/csv" required>
    <button>Aperçu</button>${empty('Colonnes reconnues : date, libellé, montant (ou débit / crédit). Rien n’est enregistré avant validation.')}</form>`;
  return empty(`${esc(accName(p.accountId))} · ${p.rows.length} ligne(s)${p.errors.length ? ` · lignes illisibles ignorées : ${p.errors.join(', ')}` : ''}`)
    + p.rows.map((r, i) => `<label class="op"><span class="l"><input type="checkbox" data-change="keep" data-id="${i}"${r.keep ? ' checked' : ''}> ${esc(r.label)}`
      + `<span class="muted" style="display:block">${r.date}${r.dup ? ` · <span class="warn">doublon : ${r.dup}</span>` : ''}</span></span><span class="r">${money(r.amount)}</span></label>`).join('')
    + `<div class="grid2">${btn('cancelImport', '', 'Annuler', 'ghost')}${btn('confirmImport', '', `Importer ${p.rows.filter(r => r.keep).length}`, '')}</div>`;
}

function tradeImportBlock() {
  const p = view.trades, sn = view.snap;
  // another Fortuneo portfolio (PEA vs compte-titres) already imported into this account would be overwritten
  const prev = sn && S.snapshots[sn.accountId], other = prev?.portfolio && sn.data.portfolio && prev.portfolio !== sn.data.portfolio ? prev.portfolio : '';
  if (sn) return empty(`Portefeuille ${esc(sn.data.kind)} du ${sn.data.date} · ${sn.data.lines.length} ligne(s) → compte ${esc(accName(sn.accountId))}`
      + `${sn.data.errors.length ? ` · lignes illisibles : ${sn.data.errors.join(', ')}` : ''}`)
    + sn.data.lines.map(l => `<div class="op"><div class="l">${esc(l.name)}<div class="muted">${num(l.qty)} × ${num(l.price)} ${l.currency} · ${esc(l.isin)}</div></div>`
      + `<div class="r">${eur(l.value)}<div>${money(l.value - l.cost)}</div></div></div>`).join('')
    + (other ? `<div class="bad">Attention : ce compte contient déjà un autre portefeuille Fortuneo (n° …${esc(other.slice(-4))}). Importer ici remplacerait ses positions.
        Choisissez ou créez un compte à part, par exemple « Fortuneo ${esc(sn.data.kind === 'PEA' ? 'PEA' : 'CTO')} ».</div>` : '')
    + empty(`Fichier : portefeuille ${esc(sn.data.kind === 'CHQ' ? 'compte-titres (CTO)' : sn.data.kind)} n° …${esc(String(sn.data.portfolio).slice(-4))}. `
      + `Ces positions ${S.snapshots[sn.accountId] ? 'remplacent celles du précédent export de ce compte' : 'deviennent celles de ce compte'} ; les achats saisis après le ${sn.data.date} s’y ajoutent.`)
    + `<div class="grid2">${btn('cancelSnap', '', 'Annuler', 'ghost')}${btn('confirmSnap', '', other ? 'Remplacer quand même' : 'Importer', other ? 'danger' : '')}</div>`;
  if (!p) return `<form data-form="tradesFile"><select name="accountId" aria-label="Compte">${accOpts(S.accounts.find(a => S.ops.some(o => o.kind === 'invest' && o.accountId === a.id))?.id)}</select>
    <input type="file" name="file" accept=".csv,.xls,.xlsx,text/csv" required><button>Aperçu</button>
    ${empty('Fortuneo : « Export portefeuille simple » (.xls), un fichier par compte (PEA, compte-titres). Trade Republic : « Exportation de transactions » (.csv). IBKR : Flex Query « Trades » en CSV.')}
    ${empty('Autre courtier : remplissez le modèle (montant net frais inclus, négatif pour un achat).')}</form>
    <div style="margin-top:8px">${btn('template', '', 'Télécharger le modèle', 'ghost')}</div>`;
  return empty(`${esc(accName(p.accountId))} · ${p.rows.length} opération(s)${p.errors.length ? ` · lignes illisibles : ${p.errors.join(', ')}` : ''}${p.ignored.length ? ` · lignes hors actions et ETF ignorées : ${p.ignored.join(', ')}` : ''}`)
    + p.rows.map((r, i) => `<label class="op"><span class="l"><input type="checkbox" data-change="keepTrade" data-id="${i}"${r.keep ? ' checked' : ''}> `
      + (r.isin ? `${r.qty > 0 ? 'Achat' : 'Vente'} ${num(Math.abs(r.qty))} · ${esc(r.name)}` : esc(r.label))
      + `${r.newInstrument ? '<span class="tag">nouveau titre</span>' : ''}<span class="muted" style="display:block">${r.date}${r.isin ? ` · ${esc(r.isin)}` : ''}${r.currency && r.currency !== 'EUR' ? ` · ${r.currency}` : ''}`
      + `${r.dup ? ` · <span class="warn">doublon : ${r.dup}</span>` : ''}</span></span><span class="r">${money(r.amount)}</span></label>`).join('')
    + `<div class="grid2">${btn('cancelTrades', '', 'Annuler', 'ghost')}${btn('confirmTrades', '', `Importer ${p.rows.filter(r => r.keep).length}`, '')}</div>`;
}

// ---- actions ----
const pair = id => id.split('|');
const readText = async file => { // bank exports are often Windows-1252
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
};
// SheetJS (vendor/, Apache-2.0) is only loaded when an Excel file is imported
const loadXlsx = () => window.XLSX ? Promise.resolve(window.XLSX) : new Promise((ok, ko) => {
  const sc = Object.assign(document.createElement('script'), { src: 'vendor/xlsx.full.min.js' });
  sc.onload = () => ok(window.XLSX);
  sc.onerror = () => ko(new Error('Lecteur Excel indisponible : réessayez connecté à Internet.'));
  document.head.append(sc);
});
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const actions = {
  edit: id => { view.edit = id; view.sheet = true; },
  newOp: () => { view.edit = null; view.sheet = true; view.focusAmount = true; },
  closeSheet: () => { view.edit = null; view.sheet = false; },
  panel: id => { view.sheet = id; },
  range: r => { view.range = r; },
  prevMonth: () => { view.month = B.monthsBack(view.month, 2)[0]; },
  nextMonth: () => { view.month = new Date(Date.UTC(+view.month.slice(0, 4), +view.month.slice(5, 7), 1)).toISOString().slice(0, 7); },
  del: id => { if (confirm('Supprimer ce mouvement ?')) { B.deleteOp(S, id); view.edit = null; view.sheet = false; } },
  unlink: id => B.unlinkTransfer(S, id),
  link: id => B.linkTransfer(S, ...pair(id)),
  notLink: id => { for (const o of S.ops) if (pair(id).includes(o.id)) o.notTransfer = true; },
  dismiss: ids => S.dismissedAlerts.push(...ids.split(',')),
  unmatch: id => B.unmatch(S, id),
  goOps: () => { view.tab = 'ops'; scrollTo(0, 0); },
  period: p => { view.period = p; },
  delRec: id => { S.recurring = S.recurring.filter(r => r.id !== id); },
  release: id => { if (confirm('Libérer le reliquat ? Il redevient dépensable ce mois.')) B.releaseEnvelope(S, id); },
  inst: isin => { view.inst = isin; scrollTo(0, 0); },
  closeInst: () => { view.inst = null; },
  refreshAll: async () => {
    const t = today(), errs = [...await refreshMarket(S, t)];
    if (newsOn(S.settings.market)) {
      errs.push(...await refreshNews(S, t));
      try { errs.push(...await discover(S, t)); } catch (e) { errs.push(`Recherche d’idées : ${e.message}`); }
    }
    const m = S.settings.market;
    if (m.proxyUrl && m.newsKey) try { await actions.moveNewsKey(true); } catch (e) { errs.push(`Clé Marketaux : ${e.message}`); }
    if (!m.push && 'PushManager' in window && Notification.permission === 'granted') try { await actions.pushOn(true); } catch (e) { errs.push(`Alertes appli fermée : ${e.message}`); }
    B.logVerdicts(S, t);
    const watch = JSON.stringify(B.watchList(S, t));
    if (m.push && watch !== m.pushSent) { // the closed-app alerts follow the portfolio
      try { await workerCall(S, '/push/watch', { watch: JSON.parse(watch) }); m.pushSent = watch; } catch (e) { errs.push(`Alertes appli fermée : ${e.message}`); }
    }
    S.lastRefresh = { at: new Date().toISOString(), errors: [...new Set(errs.map(plain))] }; // shown on the Bourse screen, no pop-up
  },
  testKeys: async () => {
    const m = S.settings.market, out = [];
    if (!m.enabled) throw new Error('Cochez d’abord « Activer les données en ligne », puis Enregistrer.');
    if (m.proxyUrl) try { await searchSymbols(S, 'TotalEnergies'); out.push('Service de cours : OK ✓'); } catch (e) { out.push(plain(e.message)); }
    if (newsOn(m)) try { await checkNewsKey(S); out.push('Clé Marketaux : OK ✓'); } catch (e) { out.push(plain(e.message)); }
    alert(out.join('\n') || 'Renseignez l’adresse du service et la clé Marketaux, puis Enregistrer.');
  },
  findSymbol: async isin => { const i = S.instruments.find(x => x.isin === isin); view.search = { q: i.name, forIsin: isin, results: await searchSymbols(S, i.name) }; scrollTo(0, 0); },
  cancelSearch: () => { view.search = null; },
  moveNewsKey: async () => { // done by the refresh: the key goes to the user's service and leaves the phone
    const m = S.settings.market;
    await workerCall(S, '/config', { newsKey: m.newsKey });
    m.newsInWorker = true; m.newsKey = '';
  },
  pushOn: async quiet => {
    if (!('PushManager' in window)) throw new Error('Ce navigateur ne sait pas recevoir d’alertes appli fermée. Installez l’appli sur l’écran d’accueil (Chrome).');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications refusées : autorisez-les dans les réglages du téléphone.');
    const { publicKey } = await workerCall(S, '/push/key'), reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    const watch = B.watchList(S, today()), m = S.settings.market;
    await workerCall(S, '/push/watch', { subscription: sub.toJSON(), watch });
    Object.assign(m, { push: true, pushSent: JSON.stringify(watch) });
    if (quiet !== true) alert(`Alertes activées : ${watch.length} titre(s) surveillé(s).`);
  },
  pushTest: async () => { await workerCall(S, '/push/test'); },
  pushOff: async () => {
    await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
    await workerCall(S, '/push/off');
    Object.assign(S.settings.market, { push: false, pushSent: null });
  },
  notifOn: async () => {
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications refusées : autorisez-les dans les réglages du téléphone.');
    S.settings.notify = true; // the advice already shown on screen counts as known: only changes are announced from now on
    B.markNotified(S, [], today());
  },
  notifOff: () => { S.settings.notify = false; },
  testNotif: async () => (await navigator.serviceWorker.ready).showNotification('Boussole', { body: 'Les notifications fonctionnent.', icon: 'icon-192.png' }),
  pick: k => {
    const r = view.search.results[+k], target = S.instruments.find(x => x.isin === view.search.forIsin);
    // with the price service, the result is a Yahoo listing; its real currency arrives with the first price
    const ysym = S.settings.market.proxyUrl ? r.symbol : undefined, currency = r.currency || target?.currency || 'EUR';
    if (target) { Object.assign(target, { symbol: r.symbol, currency, type: r.type, place: r.region, ysym }); delete S.quotes[target.isin]; delete S.history[target.isin]; }
    else { view.inst = B.saveInstrument(S, { symbol: r.symbol, name: r.name, currency, type: r.type, place: r.region }); S.instruments.find(i => i.isin === view.inst).ysym = ysym; }
    view.search = null;
  },
  delDecision: id => B.deleteDecision(S, id),
  delInst: isin => {
    const name = S.instruments.find(i => i.isin === isin)?.name;
    const held = S.ops.some(o => o.isin === isin) || Object.values(S.snapshots).some(sn => sn.lines.some(l => l.isin === isin));
    if (!confirm(held ? `Supprimer ${name} avec ses achats, ventes et position importée ? Pour une vente réelle, utilisez plutôt « J’ai vendu ».` : `Ne plus suivre ${name} ?`)) return;
    B.deleteInstrument(S, isin);
    view.inst = null;
  },
  template: () => download('modele-releve-courtier.csv', '﻿' + B.TRADES_TEMPLATE, 'text/csv'),
  cancelTrades: () => { view.trades = null; },
  cancelSnap: () => { view.snap = null; },
  confirmSnap: () => { const n = B.applySnapshot(S, view.snap.accountId, view.snap.data, 'Fortuneo'); view.snap = null; alert(`${n} position(s) importée(s).`); },
  confirmTrades: () => { const n = B.importTrades(S, view.trades.accountId, view.trades.rows, today()); view.trades = null; alert(`${n} opération(s) titres importée(s).`); },
  cancelImport: () => { view.preview = null; },
  confirmImport: () => { const n = B.importRows(S, view.preview.accountId, view.preview.rows, today()); view.preview = null; alert(`${n} opération(s) importée(s).`); },
  delAcc: id => {
    if (S.ops.some(o => o.accountId === id) || S.recurring.some(r => r.accountId === id)) throw new Error('Ce compte a des opérations ou échéances : supprimez-les d’abord.');
    if (confirm('Supprimer ce compte ?')) { S.accounts = S.accounts.filter(a => a.id !== id); view.sheet = false; }
  },
  delCat: id => {
    if (!confirm('Supprimer cette catégorie ? Les opérations sont conservées, sans catégorie.')) return;
    S.categories = S.categories.filter(c => c.id !== id);
    for (const x of [...S.ops, ...S.recurring]) if (x.categoryId === id) x.categoryId = null;
  },
  csv: () => download(`operations-${today()}.csv`, '﻿' + B.opsCsv(S), 'text/csv'),
  demo: () => { if (confirm('Remplacer les données par la démonstration fictive ?')) { S = B.demoState(today()); view.tab = 'dash'; } },
  reset: () => { if (confirm('Effacer toutes les données de ce téléphone ?')) S = B.emptyState(); },
};

const forms = {
  op: f => {
    const date = f.when === 'yesterday' ? new Date(Date.now() - 864e5).toLocaleDateString('sv-SE') : f.when === 'other' ? f.date : today();
    B.saveOp(S, { accountId: f.accountId, date, kind: f.kind, cents: positive(f.amount), categoryId: f.categoryId, label: f.label, planned: f.planned === 'on' }, view.edit);
    view.edit = null; view.sheet = false;
  },
  transfer: f => B.addTransfer(S, f.from, f.to, f.date, positive(f.amount), `Virement ${accName(f.from)} → ${accName(f.to)}`),
  match: f => B.match(S, f.plannedId, f.realId),
  rec: f => {
    const day = Number(f.day);
    if (!(Number.isInteger(day) && day >= 1 && day <= 31)) throw new Error('Jour invalide');
    S.recurring.push({ id: B.uid(), accountId: f.accountId, kind: f.kind, cents: positive(f.amount), categoryId: f.categoryId || null, label: f.label.trim(), day });
  },
  env: f => B.addEnvelope(S, view.month, positive(f.amount), f.label.trim() || 'Enveloppe bourse'),
  buy: f => B.buyFromEnvelope(S, f.envId, f.accountId, f.date, positive(f.amount), `Achat ${S.instruments.find(i => i.isin === f.isin)?.name ?? ''}`.trim(),
    f.isin || undefined, f.isin ? decimal(f.qty) : undefined),
  search: async f => { view.search = { q: f.q, forIsin: view.search?.forIsin, results: await searchSymbols(S, f.q.trim()) }; },
  instrument: f => B.saveInstrument(S, f),
  profile: f => {
    const n = (v, lo, hi) => { const x = Number(String(v ?? '').replace(',', '.')); if (!(x >= lo && x <= hi)) throw new Error('Valeur de profil invalide'); return x; };
    const targets = {};
    for (const i of S.instruments) if (f['t_' + i.isin]) targets[i.isin] = n(f['t_' + i.isin], 0, 100);
    if (Object.values(targets).reduce((a, b) => a + b, 0) > 100.0001) throw new Error('La somme des cibles dépasse 100 %');
    const fee = parseEur(f.fee);
    if (!B.RISK[f.risk] || fee < 0) throw new Error('Valeur de profil invalide');
    S.settings.profile = { style: f.style === 'actif' ? 'actif' : 'long', maxWeight: n(f.maxWeight ?? 0, 0, 100), horizon: n(f.horizon, 1, 50), risk: f.risk, driftPts: n(f.driftPts, 1, 50), fee, fxPct: n(f.fxPct || 0, 0, 10), targets };
  },
  quote: f => B.setQuote(S, f.isin, decimal(f.price), f.date),
  market: f => {
    const proxyUrl = f.proxyUrl.trim();
    if (proxyUrl && !/^https:\/\//.test(proxyUrl)) throw new Error('L’adresse du service doit commencer par https://');
    if (proxyUrl !== S.settings.market.proxyUrl) for (const i of S.instruments) delete i.ysym; // listings are looked up again by the new service
    Object.assign(S.settings.market, { enabled: f.enabled === 'on', proxyUrl, proxyKey: f.proxyKey.trim(), avKey: f.avKey.trim(), newsKey: f.newsKey.trim() });
  },
  holding: f => {
    const qty = decimal(f.qty), cost = parseEur(f.cost), q = S.quotes[f.isin], i = S.instruments.find(x => x.isin === f.isin);
    // Test A: a « total cost » far from quantity × price is probably a price per share (or the reverse): ask, never guess
    const now = q && (i.currency === 'EUR' ? q.price * 100 : S.fx[i.currency] ? (q.price * 100) / S.fx[i.currency].rate : null);
    const ratio = now ? cost / (qty * now) : 1;
    if ((ratio < 0.2 || ratio > 5) && !confirm(`${eur(cost)} pour ${num(qty)} part(s), soit ${eur(Math.round(cost / qty))} par part, alors que le cours est d’environ ${eur(Math.round(now))}.\n`
      + `Avez-vous bien saisi le prix de revient TOTAL (et non par part) ? OK pour enregistrer tel quel, Annuler pour corriger.`)) throw new Error('Saisie annulée : corrigez le prix de revient total.');
    B.addHolding(S, f.accountId, f.isin, f.date, qty, cost);
  },
  purchase: f => { view.inst = B.addPurchase(S, { ...f, qty: decimal(f.qty), cents: positive(f.amount) }); },
  cash: f => { for (const [k, v] of Object.entries(f)) if (k.startsWith('c_') && String(v).trim()) B.setCash(S, k.slice(2), f.date, parseEur(v)); },
  split: f => B.addSplit(S, f.accountId, f.isin, f.date, decimal(f.ratio)),
  sale: f => { const [accountId, isin] = pair(f.pos); B.addSale(S, accountId, isin, f.date, decimal(f.qty), positive(f.amount)); },
  settings: f => {
    const reserve = parseEur(f.reserve), globalCap = parseEur(f.globalCap), alertPct = Number(f.alertPct), lowSpendable = parseEur(f.lowSpendable);
    if (reserve < 0 || globalCap < 0 || lowSpendable < 0 || !(Number.isInteger(alertPct) && alertPct >= 1 && alertPct <= 100)) throw new Error('Valeurs invalides');
    Object.assign(S.settings, { reserve, globalCap, alertPct, lowSpendable });
  },
  account: f => {
    const pctOrNone = v => { if (!String(v ?? '').trim()) return undefined; const x = Number(String(v).replace(',', '.')); if (!(x >= 0 && x <= 20)) throw new Error('Pourcentage de frais invalide'); return x; };
    const t = ACC_TYPES[f.acctype] ? f.acctype : 'courant', savings = !['courant', 'pea', 'cto'].includes(t);
    const a = { name: f.name.trim() || `${f.institution.trim()} ${ACC_TYPES[t][1].replace(/ \(CTO\)$/, '')}`, institution: f.institution.trim(), opening: parseEur(f.opening),
      liquid: t === 'courant', savings, sub: savings && t !== 'epargne' ? t : undefined, fractional: f.fractional === 'on',
      type: t === 'cto' ? 'CTO' : t === 'pea' ? 'PEA' : undefined, feeFixed: String(f.feeFixed ?? '').trim() ? parseEur(f.feeFixed) : undefined, feePct: pctOrNone(f.feePct), fxPct: pctOrNone(f.fxPct) };
    if (a.feeFixed < 0) throw new Error('Frais invalides');
    if (f.id) Object.assign(S.accounts.find(x => x.id === f.id), a); else S.accounts.push({ id: B.uid(), ...a });
  },
  cat: f => {
    const c = { name: f.name.trim(), cap: parseEur(f.cap) };
    if (c.cap < 0) throw new Error('Plafond invalide');
    if (f.id) Object.assign(S.categories.find(x => x.id === f.id), c); else S.categories.push({ id: B.uid(), ...c });
  },
  tradesFile: async (f, form) => {
    const file = form.file.files[0];
    if (/\.xlsx?$/i.test(file.name)) {
      const X = await loadXlsx(), wb = X.read(await file.arrayBuffer());
      view.snap = { accountId: f.accountId, data: B.parseFortuneoRows(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' })) };
      return;
    }
    const { rows, errors, ignored } = B.parseTradesCsv(await readText(file));
    view.trades = { accountId: f.accountId, rows: B.tradesPreview(S, f.accountId, rows), errors, ignored };
  },
  importFile: async (f, form) => {
    const { rows, errors } = B.parseCsv(await readText(form.file.files[0]));
    view.preview = { accountId: f.accountId, rows: B.importPreview(S, f.accountId, rows), errors };
  },
  backup: async f => download(`budget-sauvegarde-${today()}.json`, await B.encryptBackup(S, f.pw), 'application/json'),
  restore: async (f, form) => {
    const next = await B.decryptBackup(await readText(form.file.files[0]), f.pw);
    if (confirm(`Restaurer ${next.accounts.length} compte(s) et ${next.ops.length} opération(s) ? Les données actuelles seront remplacées.`)) S = next;
  },
};

// ---- wiring ----
function render() {
  // recurring items of the month shown (and later ones) appear on their own: no « générer » button
  if (view.month >= B.monthOf(today()) && B.generateRecurring(S, view.month)) save();
  if (B.settleDue(S, today())) save(); // due items are paid on their date, no button to press
  app.innerHTML = (!S.accounts.length && view.tab !== 'settings' ? onboarding() : views[view.tab]()) + sheet();
  if (view.focusAmount) { view.focusAmount = false; app.querySelector('.sheet [name=amount]')?.focus(); }
  for (const b of document.querySelectorAll('nav button')) b.toggleAttribute('aria-current', b.dataset.tab === view.tab);
  document.querySelector(`nav [data-tab="${view.tab}"]`).setAttribute('aria-current', 'page');
}

async function run(fn) {
  try { await fn(); save(); } catch (err) { alert(err.message); }
  render();
  notify();
}

// Sends the new advice and budget alerts as phone notifications (only while the app is running: no server).
const canNotify = () => 'Notification' in window && 'serviceWorker' in navigator;
async function notify() {
  if (!S.settings.notify || !canNotify() || Notification.permission !== 'granted') return;
  const list = B.pendingNotifications(S, today());
  if (!list.length) return;
  const reg = await navigator.serviceWorker.ready;
  for (const x of list) await reg.showNotification(x.title, { body: x.body, tag: x.id, icon: 'apple-touch-icon.png', data: { tab: x.id.startsWith('v|') || x.id.startsWith('sum|') ? 'stock' : 'dash' } });
  B.markNotified(S, list, today());
  save();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) {
    if (t.dataset.tab !== view.tab) history.pushState({ tab: t.dataset.tab }, '');
    view.tab = t.dataset.tab; view.edit = null; view.sheet = false; scrollTo(0, 0); return render();
  }
  if (['newOp', 'edit', 'panel', 'inst'].includes(t.dataset.act)) history.pushState({ tab: view.tab, layer: true }, ''); // the back button closes it
  e.preventDefault();
  run(() => actions[t.dataset.act](t.dataset.id));
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  run(async () => {
    await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form);
    if (form.closest('.sheet') && form.dataset.form !== 'cat') { view.sheet = false; view.edit = null; } // saved: the panel closes (categories stay open to edit several)
  });
});
document.addEventListener('change', e => {
  const k = e.target.dataset.change;
  if (!k) return;
  // picking a date in the entry panel ticks « Autre date » without redrawing (that would lose what is typed)
  if (k === 'otherDate') { const r = e.target.form.querySelector('[name=when][value=other]'); if (r) r.checked = true; return; }
  if (k === 'notif') return run(() => (e.target.checked ? actions.notifOn() : actions.notifOff()));
  if (k === 'month' && e.target.value) view.month = e.target.value;
  if (k === 'account') view.account = e.target.value;
  if (k === 'keep') view.preview.rows[+e.target.dataset.id].keep = e.target.checked;
  if (k === 'keepTrade') view.trades.rows[+e.target.dataset.id].keep = e.target.checked;
  render();
});

document.addEventListener('toggle', e => { // 'toggle' does not bubble: listen in the capture phase
  const k = e.target.dataset?.fold;
  if (k) e.target.open ? view.open.add(k) : view.open.delete(k);
}, true);

navigator.storage?.persist?.(); // ask the browser not to evict local data
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
const startTab = new URLSearchParams(location.search).get('tab'); // set by a tapped notification
if (views[startTab]) view.tab = startTab;
// payments entered before automatic matching existed: settle the planned items they correspond to
if (S.ops.filter(o => B.monthOf(o.date) >= B.monthOf(today()) && !o.planned).map(o => B.autoMatch(S, o)).some(Boolean)) save();
// Android back button: closes the open panel or title sheet first, then goes back to the previous tab
history.replaceState({ tab: view.tab }, '');
addEventListener('popstate', e => {
  if (view.sheet || view.inst) { view.sheet = false; view.edit = null; view.inst = null; }
  else view.tab = e.state?.tab ?? 'dash';
  render();
});
render();
notify();
async function autoRefresh() {
  const m = S.settings.market, last = Date.parse(S.lastRefresh?.at ?? 0);
  if (view.refreshing || !navigator.onLine || !m.enabled || !(m.proxyUrl || m.avKey) || Date.now() - last < 30 * 60e3) return;
  const calm = () => !view.sheet && !document.activeElement?.matches('input, textarea, select'); // never redraw over typing
  view.refreshing = true; if (calm()) render();
  // no pop-up: problems are listed on the Bourse screen
  try { await actions.refreshAll(); } catch (e) { S.lastRefresh = { at: new Date().toISOString(), errors: [plain(e.message)] }; }
  view.refreshing = false; save(); if (calm()) render(); notify();
}
autoRefresh();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoRefresh(); });
