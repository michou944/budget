import * as B from './budget.js';
import { refreshMarket, refreshNews, searchSymbols } from './market.js';

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
const accName = id => S.accounts.find(a => a.id === id)?.name ?? '?';
const catName = id => S.categories.find(c => c.id === id)?.name ?? '';
const opts = (items, sel, empty) => (empty != null ? `<option value="">${empty}</option>` : '')
  + items.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');
const accOpts = (sel, empty) => opts(S.accounts.map(a => [a.id, `${a.name} · ${a.institution}`]), sel, empty);
const catOpts = sel => opts(S.categories.map(c => [c.id, c.name]), sel, '— catégorie —');
const row = (label, c, cls = '') => `<div class="row ${cls}"><span>${label}</span>${money(c)}</div>`;
const card = (title, body, cls = '') => `<section class="card ${cls}"><h2>${title}</h2>${body}</section>`;
const empty = t => `<div class="muted">${t}</div>`;
const monthBar = () => `<div class="grid2" style="margin-bottom:12px"><input type="month" value="${view.month}" data-change="month" aria-label="Mois">`
  + `<select data-change="account" aria-label="Filtrer par compte">${accOpts(view.account, 'Tous les comptes')}</select></div>`;
const btn = (act, id, text, cls = 'small ghost') => `<button class="${cls}" data-act="${act}" data-id="${esc(id)}">${text}</button>`;
// collapsible section; stays open across re-renders once the user opened it
const fold = (key, title, body, open) => `<details class="card fold" data-fold="${key}"${open || view.open.has(key) ? ' open' : ''}><summary>${title}</summary>${body}</details>`;

function opItem(o) {
  const tags = [o.planned && 'prévue', o.plannedId && 'rapprochée', o.transferId && 'virement interne', o.envelopeId && 'achat bourse', o.kind === 'refund' && 'remboursement'].filter(Boolean);
  const act = o.transferId ? btn('unlink', o.transferId, 'Délier') + btn('del', o.id, 'Suppr.', 'small danger')
    : o.envelopeId ? btn('del', o.id, 'Suppr.', 'small danger') : btn('edit', o.id, 'Modifier');
  return `<div class="op"><div class="l">${esc(o.label || B.KINDS[o.kind])}${tags.map(t => `<span class="tag">${t}</span>`).join('')}`
    + `<div class="muted">${o.date} · ${esc(accName(o.accountId))}${o.categoryId ? ' · ' + esc(catName(o.categoryId)) : ''}</div></div>`
    + `<div class="r">${money(o.amount)}<div class="actions">${act}</div></div></div>`;
}

const bar = (name, spent, cap) => `<div style="padding:4px 0"><div class="row" style="border:0;padding:0"><span>${esc(name)}</span><span>${eur(spent)}${cap ? ` / ${eur(cap)}` : ''}</span></div>`
  + (cap ? `<div class="bar"><i class="${spent > cap ? 'over' : ''}" style="width:${Math.max(0, Math.min(100, (spent * 100) / cap))}%"></i></div>` : '') + '</div>';

const onboarding = () => card('Bienvenue', empty('Aucun compte pour l’instant. Créez vos comptes et établissements, ou essayez avec des données fictives.')
  + `<div class="grid2" style="margin-top:8px"><button data-tab="settings">Créer un compte</button><button class="ghost" data-act="demo">Charger la démo</button></div>`);

// ---- views ----
const views = {
  dash() {
    const m = view.month, st = B.monthStats(S, m), al = B.alerts(S, m), stale = B.staleAccounts(S, today()), up = B.upcoming(S, m);
    const liquid = S.accounts.filter(a => a.liquid);
    const cats = B.categorySpend(S, m, view.account).filter(c => c.spent || c.cap);
    return monthBar()
      + `<section class="card hero"><div class="muted">Dépensable ce mois</div><div class="big">${eur(st.spendable)}</div>`
      + (st.shortfall ? `<div class="bad">Manque : ${eur(st.shortfall)}</div>` : '') + `<div class="muted">Reste prévu − réserve − bourse</div></section>`
      + (al.length ? card('Alertes', al.map(a => `<div class="row"><span class="${a.pct >= 100 ? 'bad' : 'warn'}">${esc(a.label)} : seuil ${a.pct} % atteint (${eur(a.spent)} / ${eur(a.cap)})</span>${btn('dismiss', a.id, 'OK')}</div>`).join('')) : '')
      + card('Mois', row('Reste à date', st.toDate, 'total') + row('Reste prévu fin de mois', st.forecast, 'total')
        + `<details style="margin-top:6px"><summary class="muted">Détail du calcul</summary>`
        + row('Revenus encaissés', st.income) + row('Dépenses payées', -st.spent) + row('Revenus attendus', st.expectedIncome) + row('Dépenses attendues', -st.expectedSpent)
        + row('Réserve mensuelle', -st.reserve) + row('Enveloppes bourse', -st.stock) + '</details>')
      + card('Bilan de fin de mois', row('Résultat réel (encaissé − payé)', st.toDate, 'total') + row('Transféré vers l’épargne (net des retraits)', st.savedTransfer)
        + empty('La réserve prévue n’est pas comptée comme épargne transférée.'))
      + card('Liquidités', (liquid.map(a => row(`${esc(a.name)} <span class="muted">${esc(a.institution)}</span>`, B.balance(S, a))).join('')
        + row('Total', liquid.reduce((t, a) => t + B.balance(S, a), 0), 'total')))
      + card('Dépenses par catégorie' + (view.account ? ` · ${esc(accName(view.account))}` : ''),
        (!view.account && S.settings.globalCap ? bar('Total du mois', st.spent, S.settings.globalCap) : '')
        + (cats.map(c => bar(c.name, c.spent, c.cap)).join('') || empty('Aucune dépense.')))
      + card('Prochaines échéances', up.map(opItem).join('') || empty('Rien de prévu.'))
      + fold('fresh', `Fraîcheur des données${stale.length ? ` · <span class="warn">${stale.length} compte(s) à mettre à jour</span>` : ''}`, `<div class="row"><span>Dernier import</span><span>${S.lastImport ? `${S.lastImport.date} · ${esc(accName(S.lastImport.accountId))} (${S.lastImport.count})` : 'aucun'}</span></div>`
        + (stale.map(x => `<div class="row"><span class="warn">${esc(x.a.name)}</span><span class="warn">${x.last ? 'dernière opération ' + x.last : 'aucune opération'}</span></div>`).join('')
          || `<div class="muted good">Tous les comptes ont une opération de moins de 30 jours.</div>`));
  },

  ops() {
    const e = view.edit && S.ops.find(o => o.id === view.edit);
    const list = S.ops.filter(o => B.monthOf(o.date) === view.month && (!view.account || o.accountId === view.account)).sort((a, b) => b.date.localeCompare(a.date));
    const pairs = B.transferCandidates(S);
    return monthBar()
      + (pairs.length ? card('Virements détectés', pairs.map(([o, i]) => `<div class="op"><div class="l">${esc(o.label)} → ${esc(i.label)}<div class="muted">${o.date} ${esc(accName(o.accountId))} → ${i.date} ${esc(accName(i.accountId))}</div></div>`
        + `<div class="r">${eur(i.amount)}<div class="actions">${btn('link', `${o.id}|${i.id}`, 'Lier', 'small')}${btn('notLink', `${o.id}|${i.id}`, 'Ignorer')}</div></div></div>`).join('')) : '')
      + fold('addOp', e ? 'Modifier l’opération' : '＋ Nouvelle opération', `<form data-form="op">
        <div class="grid2"><select name="kind">${opts([['expense', 'Dépense'], ['income', 'Revenu'], ['refund', 'Remboursement']], e?.kind ?? 'expense')}</select>
        <input name="amount" inputmode="decimal" placeholder="Montant €" required value="${e ? euros(Math.abs(e.amount)) : ''}"></div>
        <div class="grid2"><select name="accountId">${accOpts(e?.accountId ?? view.account)}</select><input type="date" name="date" required value="${e?.date ?? today()}"></div>
        <select name="categoryId">${catOpts(e?.categoryId)}</select>
        <input name="label" placeholder="Libellé" value="${esc(e?.label)}">
        <label class="chk"><input type="checkbox" name="planned"${e?.planned ? ' checked' : ''}> Prévue (pas encore payée ou encaissée)</label>
        <button>${e ? 'Enregistrer' : 'Ajouter'}</button>
        ${e ? `<div class="grid2"><button type="button" class="ghost" data-act="cancel">Annuler</button>${btn('del', e.id, 'Supprimer', 'danger')}</div>` : ''}</form>`, !!e)
      + fold('transfer', 'Virement entre comptes', `<form data-form="transfer"><div class="grid2"><select name="from" aria-label="De">${accOpts()}</select><select name="to" aria-label="Vers">${accOpts(S.accounts[1]?.id)}</select></div>
        <div class="grid2"><input name="amount" inputmode="decimal" placeholder="Montant €" required><input type="date" name="date" required value="${today()}"></div>
        <button>Enregistrer le virement</button>${empty('Exclu des revenus et des dépenses du foyer.')}</form>`)
      + fold('importOps', 'Importer un relevé bancaire (CSV)', importBlock(), !!view.preview)
      + card(`Opérations · ${list.length}`, list.map(opItem).join('') || empty('Aucune opération ce mois.'));
  },

  plan() {
    const m = view.month, up = B.upcoming(S, m), matched = S.ops.filter(o => o.plannedId && B.monthOf(o.date) === m);
    return monthBar()
      + card('À rapprocher', up.map(p => {
        const c = B.matchCandidates(S, p);
        return opItem(p) + (c.length ? `<form data-form="match" class="grid2" style="grid-template-columns:1fr auto;margin:4px 0 8px"><input type="hidden" name="plannedId" value="${p.id}">`
          + `<select name="realId" aria-label="Opération réelle">${opts(c.map(o => [o.id, `${o.date} ${o.label} ${eur(o.amount)}`]))}</select><button class="small">Rapprocher</button></form>` : '');
      }).join('') || empty('Aucune opération prévue en attente.'))
      + fold('matched', `Rapprochées · ${matched.length}`, matched.map(o => `<div class="op"><div class="l">${esc(o.label)} ↔ ${esc(S.ops.find(x => x.id === o.plannedId)?.label)}<div class="muted">${o.date}</div></div>`
        + `<div class="r">${money(o.amount)}<div class="actions">${btn('unmatch', o.plannedId, 'Annuler')}</div></div></div>`).join('') || empty('Aucune.'))
      + card('Échéances récurrentes (mensuelles)', S.recurring.map(r => `<div class="op"><div class="l">${esc(r.label)}<div class="muted">le ${r.day} · ${esc(accName(r.accountId))}${r.categoryId ? ' · ' + esc(catName(r.categoryId)) : ''}</div></div>`
        + `<div class="r">${money(B.signed(r.kind, r.cents))}<div class="actions">${btn('delRec', r.id, 'Suppr.', 'small danger')}</div></div></div>`).join('')
        + `<button data-act="gen" style="margin:8px 0">Générer les échéances de ${view.month}</button>`)
      + fold('rec', '＋ Nouvelle échéance récurrente', `
        <form data-form="rec"><div class="grid2"><select name="kind">${opts([['expense', 'Dépense'], ['income', 'Revenu']], 'expense')}</select><input name="amount" inputmode="decimal" placeholder="Montant €" required></div>
        <div class="grid2"><select name="accountId">${accOpts()}</select><input name="day" type="number" min="1" max="31" placeholder="Jour du mois" required></div>
        <select name="categoryId">${catOpts()}</select><input name="label" placeholder="Libellé (loyer, abonnement…)" required><button class="ghost">Ajouter une échéance</button></form>`);
  },

  stock() {
    const t = today(), lines = B.valuation(S, t), mk = S.settings.market, sug = B.suggestions(S, t), pf = S.settings.profile;
    const ready = mk.enabled && mk.avKey;
    const envs = S.envelopes.filter(e => e.month === view.month), open = envs.filter(e => B.envelopeLeft(S, e) > 0);
    const left = envs.reduce((a, e) => a + B.envelopeLeft(S, e), 0);
    const brokers = S.accounts.filter(a => S.ops.some(o => o.kind === 'invest' && o.accountId === a.id));
    const total = ls => ls.reduce((a, l) => a + (l.value ?? 0), 0), missing = lines.filter(l => l.value == null).length;
    const inst = isin => S.instruments.find(i => i.isin === isin);
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
      return `<div class="op tap" data-act="inst" data-id="${esc(x.isin)}"><div class="l"><b>${esc(x.name)}</b> ${badge(x)}`
        + `<div class="muted">${main ? esc(main.text) : ''}</div>`
        + (x.buy ? `<div class="good">Enveloppe : ${x.buy.qty} part(s) ≈ ${eur(x.buy.total)}</div>` : '') + '</div>'
        + `<div class="r">${ls.length ? (ls.every(l => l.value == null) ? '<span class="muted">non valorisé</span>' : `${eur(total(ls))}<div>${money(gain)}</div>`)
          : q ? `${num(q.price)} ${i.currency}` : ''}</div></div>`;
    };

    const sheet = isin => {
      const i = inst(isin), x = sug.find(y => y.isin === isin);
      if (!i || !x) return '';
      const q = S.quotes[isin], news = B.newsFor(S, isin), noOps = !S.ops.some(o => o.isin === isin);
      return card(`${esc(i.name)} ${btn('closeInst', '', 'Fermer')}`,
        `<div style="margin-bottom:8px">${badge(x)} <span class="muted">score ${x.score > 0 ? '+' : ''}${num(x.score)}</span></div>`
        + x.reasons.map(r => `<div class="row"><span>${signOf(r)} ${esc(r.text)}${meta(r)}</span></div>`).join('')
        + `<div class="muted" style="margin:6px 0">${B.DISCLAIMER}</div>`
        + `<div class="row"><span>Cours</span><span>${quoteInfo(q, i)}${staleTag(q && B.isStale(q.asOf, t))}</span></div>`
        + lines.filter(l => l.isin === isin).map(l => `<div class="row"><span>${esc(accName(l.accountId))} · ${num(l.qty)} part(s) · revient ${eur(l.cost)}</span><span>${l.value == null ? 'non valorisé' : eur(l.value)}</span></div>`).join('')
        + '<h2 style="margin-top:10px">Actualités</h2>'
        + (news.map(n => `<div class="op${B.isOldNews(n, t) ? ' old' : ''}"><div class="l"><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
          + `<div class="muted">${esc(n.source)} · ${n.publishedAt}</div></div></div>`).join('') || empty('Aucune actualité.'))
        + `<div class="grid2" style="margin-top:8px">${btn('findSymbol', isin, i.symbol ? 'Changer de cotation' : 'Trouver le cours', 'ghost')}${noOps ? btn('delInst', isin, 'Ne plus suivre', 'danger') : ''}</div>`
        + `<details style="margin-top:8px"><summary class="muted">Détails techniques</summary><form data-form="instrument"><input type="hidden" name="isin" value="${esc(isin)}">
          <div class="grid2"><input name="name" value="${esc(i.name)}" aria-label="Nom"><input name="symbol" value="${esc(i.symbol)}" placeholder="Symbole de cours" aria-label="Symbole"></div>
          <div class="grid2"><input name="currency" value="${esc(i.currency)}" maxlength="3" aria-label="Devise"><input name="place" value="${esc(i.place)}" placeholder="Place" aria-label="Place"></div>
          <button class="ghost">Enregistrer</button></form></details>`);
    };

    const searchCard = () => {
      const sr = view.search, target = sr?.forIsin && inst(sr.forIsin);
      return card(target ? `Cotation de ${esc(target.name)} ${btn('cancelSearch', '', 'Annuler')}` : 'Ajouter un titre',
        `<form data-form="search" class="grid2" style="grid-template-columns:1fr auto"><input name="q" placeholder="Nom ou ticker : MSCI World, TotalEnergies…" value="${esc(sr?.q)}" required><button class="small">Chercher</button></form>`
        + (sr ? sr.results.map((r, k) => `<div class="op"><div class="l">${esc(r.name)}<div class="muted">${esc(r.symbol)} · ${esc(r.type)} · ${esc(r.region)} · ${esc(r.currency)}</div></div>`
          + `<div class="r">${btn('pick', k, target ? 'Choisir' : 'Suivre', 'small')}</div></div>`).join('') || empty('Aucun résultat : essayez le ticker ou un autre nom.') : '')
        + (ready ? '' : empty('La recherche utilise votre clé Alpha Vantage : renseignez-la dans « Clés et données envoyées » plus bas.')));
    };

    return (view.inst ? sheet(view.inst) : '')
      + (view.search?.forIsin ? searchCard() : '')
      + (ready ? `<div style="margin-bottom:12px">${btn('refreshAll', '', 'Actualiser cours et actualités', '')}</div>` : '')
      + card('Mes titres', (sug.map(titleRow).join('') || empty('Aucun titre. Cherchez-en un ci-dessous ou importez un relevé courtier.'))
        + (lines.length ? row('Valeur des positions', total(lines), 'total') : '')
        + (missing ? `<div class="warn">${missing} ligne(s) sans cours, exclue(s) du total.</div>` : '')
        + `<div class="muted" style="margin-top:6px">Touchez un titre pour voir le détail. ${B.DISCLAIMER}</div>`)
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
        return `<h2 style="margin-top:10px">${esc(a.name)}</h2>` + row('Encaisse', B.balance(S, a))
          + ls.map(l => row(`${esc(l.inst.name)} <span class="muted">${num(l.qty)} × ${quoteInfo(l.quote, l.inst)}</span>`, l.value ?? 0)).join('');
      }).join('') + empty('Change : taux de référence BCE, pas celui du courtier.')) : '')
      + fold('profile', 'Mon profil et mes cibles', `<form data-form="profile">
        <div class="grid2"><label>Horizon (années)<input name="horizon" type="number" min="1" max="50" value="${pf.horizon}"></label>
        <label>Risque<select name="risk">${opts(Object.entries(B.RISK).map(([k, r]) => [k, `${r.label} (perte max ${r.maxLoss} %)`]), pf.risk)}</select></label></div>
        ${S.instruments.map(i => `<label>Part visée pour ${esc(i.name)} (%)<input name="t_${esc(i.isin)}" inputmode="decimal" value="${pf.targets[i.isin] ?? ''}"></label>`).join('')}
        <details><summary class="muted">Réglages avancés</summary>
        <div class="grid2"><label>Écart toléré (points)<input name="driftPts" type="number" min="1" max="50" value="${pf.driftPts}"></label>
        <label>Frais par ordre (€)<input name="fee" inputmode="decimal" value="${euros(pf.fee)}"></label></div>
        <label>Coût de change hors EUR (%)<input name="fxPct" inputmode="decimal" value="${String(pf.fxPct).replace('.', ',')}"></label></details>
        <button class="ghost">Enregistrer</button>${empty('Laisser une part vide : pas de cible pour ce titre. Le stop suiveur ne joue que sous 5 ans d’horizon.')}</form>`)
      + fold('keys', 'Clés et données envoyées', `<form data-form="market"><label class="chk"><input type="checkbox" name="enabled"${mk.enabled ? ' checked' : ''}> Activer les données en ligne</label>
        <input type="password" name="avKey" placeholder="Clé Alpha Vantage (cours, recherche)" value="${esc(mk.avKey)}" autocomplete="off">
        <input type="password" name="newsKey" placeholder="Clé Marketaux (actualités)" value="${esc(mk.newsKey)}" autocomplete="off"><button class="ghost">Enregistrer</button></form>
        ${empty('Envoyés : vos clés, votre adresse IP, les noms cherchés et les symboles suivis (alphavantage.co, marketaux.com), les devises (frankfurter.dev). Jamais : quantités, montants, comptes, opérations. Au plus un appel par titre et par jour.')}
        ${S.requestLog.slice(0, 10).map(r => `<div class="muted">${r.at.slice(0, 16).replace('T', ' ')} · ${esc(r.host)} · ${esc(r.symbols.join(', '))}</div>`).join('')}`, !ready)
      + (S.instruments.length ? fold('manual', 'Saisir un cours à la main', `<form data-form="quote"><select name="isin">${instOpts(S.instruments)}</select>
        <div class="grid2"><input name="price" inputmode="decimal" placeholder="Cours (devise de cotation)" required><input type="date" name="date" value="${t}" required></div><button class="ghost">Enregistrer le cours</button></form>`) : '');
  },

  settings() {
    const st = S.settings;
    const accountForm = a => `<form data-form="account" style="padding:8px 0;border-bottom:1px solid var(--line)"><input type="hidden" name="id" value="${a?.id ?? ''}">
      <div class="grid2"><input name="name" placeholder="Nom du compte" value="${esc(a?.name)}" required><input name="institution" placeholder="Établissement" value="${esc(a?.institution)}" required></div>
      <input name="opening" inputmode="decimal" placeholder="Solde initial €" value="${a ? euros(a.opening) : ''}">
      <label class="chk"><input type="checkbox" name="liquid"${!a || a.liquid ? ' checked' : ''}> Inclure dans les liquidités</label>
      <label class="chk"><input type="checkbox" name="savings"${a?.savings ? ' checked' : ''}> Compte épargne</label>
      <div class="grid2"><button class="${a ? 'ghost' : ''}">${a ? 'Enregistrer' : 'Ajouter le compte'}</button>${a ? btn('delAcc', a.id, 'Supprimer', 'danger') : ''}</div>
      ${a ? empty('Solde actuel : ' + eur(B.balance(S, a))) : ''}</form>`;
    const catForm = c => `<form data-form="cat" class="grid2" style="grid-template-columns:2fr 1fr auto${c ? ' auto' : ''};margin-bottom:6px"><input type="hidden" name="id" value="${c?.id ?? ''}">
      <input name="name" value="${esc(c?.name)}" placeholder="Nouvelle catégorie" required aria-label="Nom"><input name="cap" inputmode="decimal" value="${c ? euros(c.cap) : ''}" placeholder="Plafond €" aria-label="Plafond mensuel">
      <button class="small">${c ? 'OK' : 'Ajouter'}</button>${c ? btn('delCat', c.id, '×', 'small danger') : ''}</form>`;
    return card('Comptes', S.accounts.map(a => fold(`acc-${a.id}`, `${esc(a.name)} <span class="muted">${esc(a.institution)} · ${eur(B.balance(S, a))}</span>`, accountForm(a))).join('')
        + fold('accNew', '＋ Nouveau compte', accountForm(null), !S.accounts.length))
      + fold('budget', 'Réserve, plafond global et alertes', `<form data-form="settings"><label>Réserve mensuelle (€)<input name="reserve" inputmode="decimal" value="${euros(st.reserve)}"></label>
        <label>Plafond mensuel global (€, vide = aucun)<input name="globalCap" inputmode="decimal" value="${euros(st.globalCap)}"></label>
        <label>Seuil d’alerte (%)<input name="alertPct" type="number" min="1" max="100" value="${st.alertPct}"></label><button>Enregistrer</button></form>`)
      + fold('cats', 'Catégories et plafonds mensuels', S.categories.map(catForm).join('') + catForm(null))
      + fold('backup', 'Sauvegarde et export', `<form data-form="backup"><input type="password" name="pw" placeholder="Mot de passe (8 caractères min.)" autocomplete="new-password" required>
        <button>Télécharger une sauvegarde chiffrée</button></form><br>
        <form data-form="restore"><input type="file" name="file" accept=".json,application/json" required><input type="password" name="pw" placeholder="Mot de passe de la sauvegarde" autocomplete="current-password" required>
        <button class="ghost">Restaurer (remplace les données)</button></form><br>${btn('csv', '', 'Exporter les opérations (CSV)', 'ghost')}`)
      + card('Données', empty('Tout est enregistré sur ce téléphone uniquement. Pensez à sauvegarder régulièrement.')
        + `<div class="grid2" style="margin-top:8px">${btn('demo', '', 'Charger la démo', 'ghost')}${btn('reset', '', 'Tout effacer', 'danger')}</div>`);
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
  if (sn) return empty(`Portefeuille ${esc(sn.data.kind)} du ${sn.data.date} · ${sn.data.lines.length} ligne(s) → compte ${esc(accName(sn.accountId))}`
      + `${sn.data.errors.length ? ` · lignes illisibles : ${sn.data.errors.join(', ')}` : ''}`)
    + sn.data.lines.map(l => `<div class="op"><div class="l">${esc(l.name)}<div class="muted">${num(l.qty)} × ${num(l.price)} ${l.currency} · ${esc(l.isin)}</div></div>`
      + `<div class="r">${eur(l.value)}<div>${money(l.value - l.cost)}</div></div></div>`).join('')
    + empty(`Ces positions ${S.snapshots[sn.accountId] ? 'remplacent celles du précédent export' : 'deviennent celles de ce compte'} ; les achats saisis après le ${sn.data.date} s’y ajoutent.`)
    + `<div class="grid2">${btn('cancelSnap', '', 'Annuler', 'ghost')}${btn('confirmSnap', '', 'Importer', '')}</div>`;
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
  edit: id => { view.edit = id; view.tab = 'ops'; scrollTo(0, 0); },
  cancel: () => { view.edit = null; },
  del: id => { if (confirm('Supprimer cette opération ?')) { B.deleteOp(S, id); view.edit = null; } },
  unlink: id => B.unlinkTransfer(S, id),
  link: id => B.linkTransfer(S, ...pair(id)),
  notLink: id => { for (const o of S.ops) if (pair(id).includes(o.id)) o.notTransfer = true; },
  dismiss: id => S.dismissedAlerts.push(id),
  unmatch: id => B.unmatch(S, id),
  gen: () => alert(`${B.generateRecurring(S, view.month)} échéance(s) ajoutée(s).`),
  delRec: id => { S.recurring = S.recurring.filter(r => r.id !== id); },
  release: id => { if (confirm('Libérer le reliquat ? Il redevient dépensable ce mois.')) B.releaseEnvelope(S, id); },
  inst: isin => { view.inst = isin; scrollTo(0, 0); },
  closeInst: () => { view.inst = null; },
  refreshAll: async () => {
    const errs = [...await refreshMarket(S, today()), ...(S.settings.market.newsKey ? await refreshNews(S, today()) : [])];
    alert(errs.length ? errs.join('\n') : 'Cours, change et actualités à jour.');
  },
  findSymbol: async isin => { const i = S.instruments.find(x => x.isin === isin); view.search = { q: i.name, forIsin: isin, results: await searchSymbols(S, i.name) }; scrollTo(0, 0); },
  cancelSearch: () => { view.search = null; },
  pick: k => {
    const r = view.search.results[+k], target = S.instruments.find(x => x.isin === view.search.forIsin);
    if (target) { Object.assign(target, { symbol: r.symbol, currency: r.currency, type: r.type, place: r.region }); delete S.quotes[target.isin]; delete S.history[target.isin]; }
    else view.inst = B.saveInstrument(S, { symbol: r.symbol, name: r.name, currency: r.currency, type: r.type, place: r.region });
    view.search = null;
  },
  delInst: isin => {
    if (S.ops.some(o => o.isin === isin)) throw new Error('Cet instrument a des opérations.');
    S.instruments = S.instruments.filter(i => i.isin !== isin);
    delete S.quotes[isin];
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
    if (confirm('Supprimer ce compte ?')) S.accounts = S.accounts.filter(a => a.id !== id);
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
    B.saveOp(S, { accountId: f.accountId, date: f.date, kind: f.kind, cents: positive(f.amount), categoryId: f.categoryId, label: f.label, planned: f.planned === 'on' }, view.edit);
    view.edit = null;
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
    S.settings.profile = { horizon: n(f.horizon, 1, 50), risk: f.risk, driftPts: n(f.driftPts, 1, 50), fee, fxPct: n(f.fxPct || 0, 0, 10), targets };
  },
  quote: f => B.setQuote(S, f.isin, decimal(f.price), f.date),
  market: f => { S.settings.market = { enabled: f.enabled === 'on', avKey: f.avKey.trim(), newsKey: f.newsKey.trim() }; },
  holding: f => B.addHolding(S, f.accountId, f.isin, f.date, decimal(f.qty), parseEur(f.cost)),
  sale: f => { const [accountId, isin] = pair(f.pos); B.addSale(S, accountId, isin, f.date, decimal(f.qty), positive(f.amount)); },
  settings: f => {
    const reserve = parseEur(f.reserve), globalCap = parseEur(f.globalCap), alertPct = Number(f.alertPct);
    if (reserve < 0 || globalCap < 0 || !(Number.isInteger(alertPct) && alertPct >= 1 && alertPct <= 100)) throw new Error('Valeurs invalides');
    Object.assign(S.settings, { reserve, globalCap, alertPct });
  },
  account: f => {
    const a = { name: f.name.trim(), institution: f.institution.trim(), opening: parseEur(f.opening), liquid: f.liquid === 'on', savings: f.savings === 'on' };
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
  app.innerHTML = !S.accounts.length && view.tab !== 'settings' ? onboarding() : views[view.tab]();
  for (const b of document.querySelectorAll('nav button')) b.toggleAttribute('aria-current', b.dataset.tab === view.tab);
  document.querySelector(`nav [data-tab="${view.tab}"]`).setAttribute('aria-current', 'page');
}

async function run(fn) {
  try { await fn(); save(); } catch (err) { alert(err.message); }
  render();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) { view.tab = t.dataset.tab; view.edit = null; scrollTo(0, 0); return render(); }
  e.preventDefault();
  run(() => actions[t.dataset.act](t.dataset.id));
});
document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  run(() => forms[form.dataset.form](Object.fromEntries(new FormData(form)), form));
});
document.addEventListener('change', e => {
  const k = e.target.dataset.change;
  if (!k) return;
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
render();
