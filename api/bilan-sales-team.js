// Fonction serveur — Bilan hebdomadaire SALES TEAM (Closer / Setter / Cold call).
//
// GET /api/bilan-sales-team?semaine=2026-S48   (defaut = derniere semaine ISO complete, lundi-dimanche, heure de Paris)
//
// MEME logique que api/sales-team.js (copiee, ce fichier-la n'est pas modifie) et api/coldcall.js :
//  - Closer  : calls de vente (Closing / Rattrapage / Setting) comptes au JOUR DU RDV ; ventes et CA
//              a la SIGNATURE du contrat (un contrat n'est compte qu'une fois, chez le 1er call chronologique).
//  - Setter  : COHORTE des leads dont jourAssignation est dans la semaine ; calls "via setter" suivis a toute date,
//              ventes datees a la signature dans la semaine.
//  - Cold call : agregats du Google Sheet (appeles / decroches / calls bookes declares) par jour.
// Rangs : tous les rangs (R1, R2+) pour les volumes ; taux de show / closing sur R1 uniquement (comme l'ecran Closing du dash, SALES_CLOSING_RANG = "r1").
//
// Reponse : { genereLe, semaine, sample:false, week, headline, insights, blocks:[closer,setter,coldcall], weeks, trend, alerts, slack }
// Le jeton Airtable ne quitte jamais le serveur (AIRTABLE_TOKEN).

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_LEADS = "tblFfUo3I4ihrQmzr";
const TABLE_CALL_BOOKED = "tblaY2J8SD0grDEOK";
const TABLE_CONTRATS = "tbl3SDo8VkXxXdzdA";

const CHAMPS_LEADS = {
  fldaUTHkR9vloCz2e: "capteLe",
  fldPQJPP97FujIbNm: "contactId",
  fldrhu8o1b2Oroz5b: "setter",
  fldE9CLUd3f08MQri: "statut",
  fldsTCF9f3IolFvV1: "dateAssignation",
  fldreiHMlZQd2xHX3: "nbCallsBookes",
  fldIV8czAyl8PtCln: "dateContacte",
  fldEGieq4LaubJ0Pv: "stage",
};
const CHAMPS_CALL_BOOKED = {
  fldhiaObnPFQjPioa: "bookingId",
  fldLSlGP0yarBWZB8: "contactId",
  fld1oLvpPAWeppnwM: "jourRdvDt",
  fldOrfHds1MiMVehg: "prisLe",
  fldFPd5SGaSFfImIE: "typeAppel",
  fldbZUTmmr0Nc2N7B: "closer",
  fldGgYg63q8hUIzqK: "setter",
  fldUxmqK72q9MWwJe: "statut",
  fldIJJbmVTPBFHt1o: "issue",
  fldKOzi8a88A3EQ7O: "motif",
  fldGrEX8JoVHL2wbD: "rangR",
  fldS2brPeHHyuCRf3: "present",
  fldHub4Sw3d9ZiEzC: "conclu",
  fldszCN4DEDuhjCzh: "contrats",
};
const CHAMPS_CONTRATS = {
  fldz1nshv9SfQLn04: "montantTotal",
  fldlhedw3iJNyAITQ: "dateSignature",
  fldm0apf8f0JU1AIF: "clients",
  fldy8OIvfHdsHTCCm: "caNet",
};

// ---------------------------------------------------------------- utilitaires (copies de sales-team.js)

function contratsAvecFreres(contratsBrut) {
  const parId = new Map(contratsBrut.map((k) => [k._id, k]));
  const parClientJour = new Map();
  const cle = (idClient, k) => `${idClient}|${String(k.dateSignature || "").slice(0, 10)}`;
  for (const k of contratsBrut) {
    for (const idClient of String(k.clients || "").split(", ").filter(Boolean)) {
      const c = cle(idClient, k);
      if (!parClientJour.has(c)) parClientJour.set(c, []);
      parClientJour.get(c).push(k._id);
    }
  }
  return (idsLies) => {
    const ids = new Set();
    for (const id of idsLies) {
      const k = parId.get(id);
      if (!k) continue;
      ids.add(id);
      for (const idClient of String(k.clients || "").split(", ").filter(Boolean)) {
        for (const frere of parClientJour.get(cle(idClient, k)) || []) ids.add(frere);
      }
    }
    return [...ids];
  };
}

function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) return brut.map((v) => (v && v.name !== undefined ? v.name : v)).join(", ");
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
}

function jourParis(brut) {
  if (!brut) return null;
  const s = String(brut);
  if (s.length <= 10) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function lireTable(token, tableId, champs) {
  const lignes = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(champs).forEach((id) => url.searchParams.append("fields[]", id));
    if (offset) url.searchParams.set("offset", offset);
    const reponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!reponse.ok) throw new Error(`Airtable a répondu ${reponse.status} : ${await reponse.text()}`);
    const donnees = await reponse.json();
    for (const enr of donnees.records) {
      const ligne = { _id: enr.id };
      for (const [id, nom] of Object.entries(champs)) ligne[nom] = valeur(enr.fields[id]);
      lignes.push(ligne);
    }
    offset = donnees.offset;
  } while (offset);
  return lignes;
}

// ---------------------------------------------------------------- semaines (ISO, lundi-dimanche, Paris)

const MS_JOUR = 86400000;
const parseJour = (s) => Date.parse(`${s}T00:00:00Z`);
const fmtJour = (ms) => new Date(ms).toISOString().slice(0, 10);
const ajouterJours = (jour, n) => fmtJour(parseJour(jour) + n * MS_JOUR);

function lundiIso(annee, num) {
  const quatre = new Date(Date.UTC(annee, 0, 4));
  const jourSem = (quatre.getUTCDay() + 6) % 7; // lundi = 0
  return fmtJour(quatre.getTime() - jourSem * MS_JOUR + (num - 1) * 7 * MS_JOUR);
}
function numeroIso(jour) {
  const d = new Date(parseJour(jour));
  const jeudi = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * MS_JOUR);
  const annee = jeudi.getUTCFullYear();
  const num = Math.floor((jeudi.getTime() - Date.UTC(annee, 0, 4) + ((new Date(Date.UTC(annee, 0, 4)).getUTCDay() + 6) % 7) * MS_JOUR) / (7 * MS_JOUR)) + 1;
  return { annee, num };
}
const semaineDe = (lundi) => {
  const { annee, num } = numeroIso(lundi);
  return { lundi, debut: lundi, fin: ajouterJours(lundi, 6), annee, num, code: `${annee}-S${String(num).padStart(2, "0")}`, court: `S${String(num).padStart(2, "0")}` };
};
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const jolie = (j) => `${Number(j.slice(8, 10))} ${MOIS[Number(j.slice(5, 7)) - 1]}`;

function choisirSemaine(param) {
  const m = /^(\d{4})-?S(\d{1,2})$/i.exec(String(param || "").trim());
  if (m) return semaineDe(lundiIso(Number(m[1]), Number(m[2])));
  const aujourdhui = jourParis(new Date().toISOString());
  const lundiCourant = ajouterJours(aujourdhui, -((new Date(parseJour(aujourdhui)).getUTCDay() + 6) % 7));
  return semaineDe(ajouterJours(lundiCourant, -7)); // derniere semaine complete
}

// ---------------------------------------------------------------- pipeline de donnees (meme regles que sales-team.js)

function preparer(leadsBrut, callsBrut, contratsBrut) {
  const montantContrat = new Map(contratsBrut.map((k) => [k._id, k.montantTotal || 0]));
  const encaisseContrat = new Map(contratsBrut.map((k) => [k._id, k.caNet || 0]));
  const etendre = contratsAvecFreres(contratsBrut);
  const liensContrats = (c) => etendre(String(c.contrats || "").split(", ").filter(Boolean));

  const leads = leadsBrut
    .filter((l) => l.setter)
    .map((l) => ({
      jourAssignation: jourParis(l.dateAssignation),
      contactId: l.contactId ?? null,
      setter: l.setter,
      stage: l.stage || null,
    }));

  const premiereIssueSetter = new Map();
  for (const c of callsBrut) {
    if (c.contactId == null || c.typeAppel !== "Diagnostic" || !String(c.bookingId || "").startsWith("SETTER-")) continue;
    const t = String(c.prisLe || "");
    if (!premiereIssueSetter.has(c.contactId) || t < premiereIssueSetter.get(c.contactId)) premiereIssueSetter.set(c.contactId, t);
  }

  const retenus = callsBrut.filter((c) => c.typeAppel === "Closing" || c.typeAppel === "Diagnostic" || c.typeAppel === "Rattrapage");
  const calls = retenus.map((c) => {
    const rattrapageBrut = c.typeAppel === "Rattrapage" || (c.typeAppel === "Diagnostic" && !String(c.bookingId || "").startsWith("SETTER-"));
    const viaSetting = rattrapageBrut && c.contactId != null && premiereIssueSetter.has(c.contactId) && premiereIssueSetter.get(c.contactId) <= String(c.prisLe || "");
    const rattrapage = rattrapageBrut && !viaSetting;
    return {
      jour: jourParis(c.jourRdvDt),
      contactId: c.contactId ?? null,
      typeAppel: viaSetting ? "Setting" : rattrapage ? "Rattrapage" : c.typeAppel,
      rattrapage,
      viaSetting,
      closer: c.closer || null,
      statut: c.statut,
      rangR: c.rangR,
      present: c.present || 0,
      conclu: c.conclu || 0,
      venteSeule: false,
    };
  });

  // Ventes datees a la SIGNATURE ; un contrat n'est compte qu'une fois (1er call chronologique).
  const parIdContrat = new Map(contratsBrut.map((k) => [k._id, k]));
  const reclames = new Set();
  const ventes = [];
  retenus
    .map((brut, i) => ({ brut, ligne: calls[i] }))
    .sort((a, b) => String(a.brut.jourRdvDt || "").localeCompare(String(b.brut.jourRdvDt || "")))
    .forEach(({ brut, ligne }) => {
      const ids = liensContrats(brut).filter((id) => !reclames.has(id));
      if (!ids.length) return;
      ids.forEach((id) => reclames.add(id));
      const ks = ids.map((id) => parIdContrat.get(id)).filter(Boolean);
      const signature = ks.map((k) => String(k.dateSignature || "").slice(0, 10)).filter(Boolean).sort()[0];
      if (!signature) return;
      ventes.push({
        ...ligne,
        jour: signature,
        venteSeule: true,
        statut: "Vente",
        present: 0,
        conclu: 0,
        vente: 1,
        montant: ks.reduce((t, k) => t + (k.montantTotal || 0), 0),
        encaisse: ks.reduce((t, k) => t + (k.caNet || 0), 0),
      });
    });

  return { leads, calls, ventes };
}

const somme = (liste, cle) => liste.reduce((t, x) => t + (x[cle] || 0), 0);
const dansSemaine = (j, w) => !!j && j >= w.debut && j <= w.fin;

// Agregats Closer d'une semaine (calls au jour du RDV, ventes a la signature).
function aggClosers({ calls, ventes }, w) {
  const venteCall = (c) => c.typeAppel !== "Diagnostic";
  const lignes = calls.filter((c) => venteCall(c) && dansSemaine(c.jour, w));
  const vs = ventes.filter((v) => venteCall(v) && dansSemaine(v.jour, w));
  const noms = new Set([...lignes, ...vs].map((x) => x.closer || "Sans closer"));
  const par = {};
  const un = (liste, nom) => liste.filter((x) => (x.closer || "Sans closer") === nom);
  const calcul = (L, V) => {
    const presents = somme(L, "present");
    const conclus = somme(L, "conclu");
    // Taux de PERFORMANCE sur R1 uniquement (comme l'ecran Closing du dashboard, SALES_CLOSING_RANG = "r1") ;
    // les volumes (RDV, presents, ventes, CA) restent sur tous les rangs.
    const L1 = L.filter((c) => c.rangR === 1);
    const V1 = V.filter((c) => c.rangR === 1);
    const presents1 = somme(L1, "present");
    const conclus1 = somme(L1, "conclu");
    return {
      rdv: L.length,
      annules: L.filter((c) => c.statut === "Annulé").length,
      presents,
      conclus,
      show: conclus1 > 0 ? (presents1 / conclus1) * 100 : null,
      showTous: conclus > 0 ? (presents / conclus) * 100 : null,
      ventes: somme(V, "vente"),
      closing: presents1 > 0 ? (somme(V1, "vente") / presents1) * 100 : null,
      closingTous: presents > 0 ? (somme(V, "vente") / presents) * 100 : null,
      ca: somme(V, "montant"),
      encaisse: somme(V, "encaisse"),
    };
  };
  noms.forEach((n) => (par[n] = calcul(un(lignes, n), un(vs, n))));
  const total = calcul(lignes, vs);
  total.panier = total.ventes > 0 ? total.ca / total.ventes : null;
  return { par, total };
}

// Agregats Setter d'une semaine : cohorte des leads assignes dans la semaine.
function aggSetters({ leads, calls, ventes }, w) {
  const contactsSetter = new Set(leads.filter((l) => l.contactId != null).map((l) => l.contactId));
  const estSetting = (c) => c.typeAppel !== "Diagnostic" && c.contactId != null && contactsSetter.has(c.contactId);
  const sourcesCalls = (c) => c.typeAppel === "Closing" || c.rattrapage === true || c.viaSetting === true;
  const parContactCalls = new Map();
  const parContactVentes = new Map();
  calls.filter((c) => sourcesCalls(c) && c.contactId != null && estSetting(c)).forEach((c) => {
    if (!parContactCalls.has(c.contactId)) parContactCalls.set(c.contactId, []);
    parContactCalls.get(c.contactId).push(c);
  });
  ventes.filter((c) => sourcesCalls(c) && c.contactId != null && estSetting(c)).forEach((c) => {
    if (!parContactVentes.has(c.contactId)) parContactVentes.set(c.contactId, []);
    parContactVentes.get(c.contactId).push(c);
  });

  const cohorte = leads.filter((l) => dansSemaine(l.jourAssignation, w)).map((l) => {
    const stage = String(l.stage || "").trim().toLowerCase();
    const issue = stage === "approved" || stage === "rejected";
    const cs = l.contactId != null ? parContactCalls.get(l.contactId) || [] : [];
    const vs = (l.contactId != null ? parContactVentes.get(l.contactId) || [] : []).filter((v) => dansSemaine(v.jour, w));
    return {
      setter: l.setter,
      contacte: stage === "contacted" || /^follow[\s-]*up/.test(stage) || issue,
      issue,
      approuve: stage === "approved",
      nbCalls: cs.length,
      honore: cs.some((c) => c.present),
      vendu: vs.length > 0,
      ca: somme(vs, "montant"),
      encaisse: somme(vs, "encaisse"),
    };
  });
  const calcul = (L) => ({
    assignes: L.length,
    contactes: L.filter((l) => l.contacte).length,
    issues: L.filter((l) => l.issue).length,
    approuves: L.filter((l) => l.approuve).length,
    callsBookes: somme(L, "nbCalls"),
    honores: L.filter((l) => l.honore).length,
    ventes: L.filter((l) => l.vendu).length,
    ca: somme(L, "ca"),
    encaisse: somme(L, "encaisse"),
  });
  const par = {};
  [...new Set(cohorte.map((l) => l.setter))].forEach((n) => (par[n] = calcul(cohorte.filter((l) => l.setter === n))));
  return { par, total: calcul(cohorte) };
}

// Agregats Cold call d'une semaine (Sheet : jours -> appeles / reponse / callBook).
function aggCallers(callers, w) {
  const par = {};
  for (const c of callers) {
    const o = { appeles: 0, reponse: 0, callBook: 0 };
    Object.entries(c.jours || {}).forEach(([jour, j]) => {
      const jj = jourParis(jour);
      if (!dansSemaine(jj, w)) return;
      o.appeles += j.appeles || 0;
      o.reponse += j.reponse || 0;
      o.callBook += j.callBook || 0;
    });
    par[c.caller || c.utm || "?"] = o;
  }
  const total = { appeles: 0, reponse: 0, callBook: 0 };
  Object.values(par).forEach((o) => {
    total.appeles += o.appeles;
    total.reponse += o.reponse;
    total.callBook += o.callBook;
  });
  return { par, total };
}

const DELAI_COLDCALL_MS = 8000;

async function lireColdCall() {
  const url = process.env.OUTBOUND_SHEET_URL;
  const token = process.env.OUTBOUND_SHEET_TOKEN;
  if (!url || !token) return { callers: [], erreur: "OUTBOUND_SHEET_URL / OUTBOUND_SHEET_TOKEN absents" };
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), DELAI_COLDCALL_MS);
  try {
    // Apps Script peut mettre longtemps a demarrer a froid : on coupe a 8 s pour ne jamais
    // bloquer le reste du bilan (le bloc Cold call passe alors en « donnees indisponibles »).
    const reponse = await fetch(`${url}?token=${encodeURIComponent(token)}`, { redirect: "follow", signal: controle.signal });
    const donnees = JSON.parse(await reponse.text());
    if (donnees.erreur) throw new Error(donnees.erreur);
    return { callers: donnees.callers || [], erreur: null };
  } catch (e) {
    const coupe = e && e.name === "AbortError";
    return { callers: [], erreur: coupe ? `Sheet cold call trop lent (plus de ${DELAI_COLDCALL_MS / 1000} s)` : String(e.message || e) };
  } finally {
    clearTimeout(minuteur);
  }
}

// ---------------------------------------------------------------- mise en forme

const fmtNb = (v) => {
  const s = Math.abs(Math.round(v)).toString();
  let r = "";
  for (let i = 0; i < s.length; i++) r += (i && (s.length - i) % 3 === 0 ? " " : "") + s[i];
  return (v < 0 ? "-" : "") + r;
};
const fmtEur = (v) => `${fmtNb(v)} €`;
const fmtPct = (v) => (v == null ? "—" : `${Math.round(v)} %`);
const FORMATS = { n: fmtNb, eur: fmtEur, pct: fmtPct };

// KPI : valeur S, comparaison S-1 et moyenne des 4 semaines precedentes (t = "%" ou "pts").
// `serie` = valeurs des 5 semaines [S-4, S-3, S-2, S-1, S] (null = non calculable).
function kpi(l, serie, { fmt = "n", better = "up", hero = false, icon = null }) {
  const v = serie[4];
  const rate = fmt === "pct";
  const ecart = (ref) => {
    if (v == null || ref == null) return 0;
    if (rate) return Math.round(v - ref);
    if (ref === 0) return v === 0 ? 0 : 100;
    return Math.round(((v - ref) / Math.abs(ref)) * 100);
  };
  const prec = serie.slice(0, 4).filter((x) => x != null);
  const moy4 = prec.length ? prec.reduce((a, b) => a + b, 0) / prec.length : null;
  const o = { l, v: v == null ? "—" : FORMATS[fmt](v), d1: ecart(serie[3]), d4: ecart(moy4), better, t: rate ? "pts" : "%" };
  if (hero) o.hero = true;
  if (icon) o.icon = icon;
  if (rate && v != null) o.ring = Math.max(0, Math.min(100, Math.round(v)));
  return o;
}
const rapport = (a, b) => (b > 0 ? (a / b) * 100 : null);

function serieDe(aggs, f) {
  return aggs.map((a) => {
    try {
      return f(a);
    } catch {
      return null;
    }
  });
}

function tableau(colonnes, parNom, total, nomTotal = "Total") {
  const lignes = Object.entries(parNom)
    .map(([nom, o]) => ({ nom, ...o }))
    .sort((a, b) => (b.ca || b.appeles || b.assignes || b.rdv || 0) - (a.ca || a.appeles || a.assignes || a.rdv || 0));
  return { cols: colonnes, rows: lignes, total: { nom: nomTotal, ...total } };
}

// ---------------------------------------------------------------- handler

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({ erreur: "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie." });
  }
  try {
    const semaine = choisirSemaine(req.query && req.query.semaine);
    // 5 semaines : S-4 ... S
    const semaines = [4, 3, 2, 1, 0].map((n) => semaineDe(ajouterJours(semaine.lundi, -7 * n)));

    const [leadsBrut, callsBrut, contratsBrut, cc] = await Promise.all([
      lireTable(token, TABLE_LEADS, CHAMPS_LEADS),
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED),
      lireTable(token, TABLE_CONTRATS, CHAMPS_CONTRATS),
      lireColdCall(),
    ]);
    const base = preparer(leadsBrut, callsBrut, contratsBrut);

    const A = semaines.map((w) => aggClosers(base, w));
    const S = semaines.map((w) => aggSetters(base, w));
    const C = semaines.map((w) => aggCallers(cc.callers, w));
    const cur = { closer: A[4], setter: S[4], cold: C[4] };

    // ---- bloc Closer
    const closer = {
      id: "closer",
      icon: "🎯",
      title: "Closer",
      color: "#9B6BFF",
      kpis: [
        kpi("Calls de vente (RDV)", serieDe(A, (a) => a.total.rdv), {}),
        kpi("Taux de show", serieDe(A, (a) => a.total.show), { fmt: "pct", icon: "👀", hero: true }),
        kpi("Ventes", serieDe(A, (a) => a.total.ventes), {}),
        kpi("Taux de closing", serieDe(A, (a) => a.total.closing), { fmt: "pct", icon: "🏆", hero: true }),
        kpi("CA contracté", serieDe(A, (a) => a.total.ca), { fmt: "eur" }),
        kpi("CA encaissé", serieDe(A, (a) => a.total.encaisse), { fmt: "eur" }),
        kpi("Panier moyen", serieDe(A, (a) => a.total.panier), { fmt: "eur" }),
        kpi("Annulations", serieDe(A, (a) => a.total.annules), { better: "down" }),
      ],
      table: tableau(
        [
          { k: "rdv", l: "RDV", t: "n" },
          { k: "presents", l: "Présents", t: "n" },
          { k: "show", l: "Show", t: "pct" },
          { k: "ventes", l: "Ventes", t: "n" },
          { k: "closing", l: "Closing", t: "pct" },
          { k: "ca", l: "CA contracté", t: "eur", bar: true },
          { k: "encaisse", l: "CA encaissé", t: "eur" },
        ],
        cur.closer.par,
        cur.closer.total
      ),
      alerts: [],
    };

    // ---- bloc Setter
    const setter = {
      id: "setter",
      icon: "📞",
      title: "Setter",
      color: "#E619B0",
      kpis: [
        kpi("Leads assignés", serieDe(S, (a) => a.total.assignes), {}),
        kpi("Taux de contact", serieDe(S, (a) => rapport(a.total.contactes, a.total.assignes)), { fmt: "pct", icon: "☎️", hero: true }),
        kpi("Issues renseignées", serieDe(S, (a) => a.total.issues), {}),
        kpi("Taux d'approbation", serieDe(S, (a) => rapport(a.total.approuves, a.total.issues)), { fmt: "pct" }),
        kpi("Calls de closing bookés", serieDe(S, (a) => a.total.callsBookes), { icon: "📅", hero: true }),
        kpi("Closing honorés", serieDe(S, (a) => a.total.honores), {}),
        kpi("Ventes (cohorte)", serieDe(S, (a) => a.total.ventes), {}),
        kpi("CA encaissé (cohorte)", serieDe(S, (a) => a.total.encaisse), { fmt: "eur" }),
      ],
      table: tableau(
        [
          { k: "assignes", l: "Assignés", t: "n" },
          { k: "contactes", l: "Contactés", t: "n" },
          { k: "issues", l: "Issues", t: "n" },
          { k: "approuves", l: "Approuvés", t: "n" },
          { k: "callsBookes", l: "Calls bookés", t: "n" },
          { k: "honores", l: "Honorés", t: "n" },
          { k: "ventes", l: "Ventes", t: "n" },
          { k: "ca", l: "CA contracté", t: "eur", bar: true },
        ],
        cur.setter.par,
        cur.setter.total
      ),
      alerts: [],
    };

    // ---- bloc Cold call
    const nomsCC = Object.keys(cur.cold.par);
    const parCC = {};
    nomsCC.forEach((n) => {
      const o = cur.cold.par[n];
      parCC[n] = { ...o, tauxRep: rapport(o.reponse, o.appeles), tauxBook: rapport(o.callBook, o.reponse) };
    });
    const totCC = { ...cur.cold.total, tauxRep: rapport(cur.cold.total.reponse, cur.cold.total.appeles), tauxBook: rapport(cur.cold.total.callBook, cur.cold.total.reponse) };
    const coldcall = {
      id: "coldcall",
      icon: "☎️",
      title: "Cold call",
      color: "#6FD3A3",
      kpis: [
        kpi("Appels passés", serieDe(C, (a) => a.total.appeles), {}),
        kpi("Décrochés", serieDe(C, (a) => a.total.reponse), {}),
        kpi("Taux de réponse", serieDe(C, (a) => rapport(a.total.reponse, a.total.appeles)), { fmt: "pct", icon: "📲", hero: true }),
        kpi("Calls bookés déclarés", serieDe(C, (a) => a.total.callBook), { icon: "📅", hero: true }),
        kpi("Booking / décroché", serieDe(C, (a) => rapport(a.total.callBook, a.total.reponse)), { fmt: "pct" }),
      ],
      table: tableau(
        [
          { k: "appeles", l: "Appelés", t: "n", bar: true },
          { k: "reponse", l: "Décrochés", t: "n" },
          { k: "tauxRep", l: "% réponse", t: "pct" },
          { k: "callBook", l: "Calls bookés", t: "n" },
          { k: "tauxBook", l: "% booking", t: "pct" },
        ],
        parCC,
        totCC
      ),
      alerts: [],
      erreur: cc.erreur,
    };

    // ---- alertes (seuils simples, calculees sur la semaine)
    const rouge = "#FF5C7A";
    const ambre = "#F0B95A";
    const vert = "#6FD3A3";
    const T = cur.closer.total;
    if (T.show != null) {
      if (T.show < 65) closer.alerts.push({ c: rouge, i: "🚨", t: `Taux de show à ${Math.round(T.show)} %`, x: `Sur les R1 (1er call de chaque lead, comme l'écran Closing). Toutes relances comprises : ${T.presents} présents sur ${T.conclus} calls conclus (seuil d'alerte 65 %).` });
      else if (T.show >= 80) closer.alerts.push({ c: vert, i: "✅", t: `Taux de show à ${Math.round(T.show)} %`, x: `Sur les R1 (1er call de chaque lead). Tous rangs : ${T.presents} présents sur ${T.conclus} calls conclus.` });
    }
    if (T.presents >= 5 && T.closing != null && T.closing < 20) closer.alerts.push({ c: ambre, i: "⚠️", t: `Taux de closing à ${Math.round(T.closing)} % (R1)`, x: `${T.ventes} vente(s) au total pour ${T.presents} présents (tous rangs : ${Math.round(T.closingTous ?? 0)} %).` });
    const meilleur = Object.entries(cur.closer.par).filter(([, o]) => o.ca > 0).sort((a, b) => b[1].ca - a[1].ca)[0];
    if (meilleur) closer.alerts.push({ c: vert, i: "🏆", t: `${meilleur[0]} en tête`, x: `${fmtEur(meilleur[1].ca)} contractés, ${meilleur[1].ventes} vente(s).` });
    const annulFort = T.rdv >= 5 && T.annules / T.rdv >= 0.25;
    if (annulFort) closer.alerts.push({ c: ambre, i: "⚠️", t: `${T.annules} calls annulés sur ${T.rdv}`, x: "Plus d'un quart des RDV de la semaine sont annulés." });
    const ST = cur.setter.total;
    if (ST.assignes > 0 && rapport(ST.contactes, ST.assignes) < 50) setter.alerts.push({ c: rouge, i: "🚨", t: `Seulement ${Math.round(rapport(ST.contactes, ST.assignes))} % des leads contactés`, x: `${ST.contactes} contactés sur ${ST.assignes} assignés cette semaine.` });
    if (ST.callsBookes > 0) setter.alerts.push({ c: vert, i: "✅", t: `${ST.callsBookes} call(s) de closing bookés`, x: `${ST.honores} honoré(s), ${ST.ventes} vente(s) sur la cohorte.` });
    if (ST.assignes === 0) setter.alerts.push({ c: ambre, i: "⚠️", t: "Aucun lead assigné cette semaine", x: "La cohorte du Setting est vide sur la période." });
    if (cc.erreur) coldcall.alerts.push({ c: rouge, i: "🚨", t: "Données cold call indisponibles", x: cc.erreur });
    else {
      if (totCC.appeles === 0) coldcall.alerts.push({ c: ambre, i: "⚠️", t: "Aucun appel enregistré", x: "Le Sheet des callers ne contient aucune activité sur la semaine." });
      else if (totCC.tauxRep != null && totCC.tauxRep < 10) coldcall.alerts.push({ c: ambre, i: "⚠️", t: `Taux de réponse à ${Math.round(totCC.tauxRep)} %`, x: `${totCC.reponse} décrochés sur ${totCC.appeles} appels.` });
      const topC = Object.entries(parCC).sort((a, b) => b[1].callBook - a[1].callBook)[0];
      if (topC && topC[1].callBook > 0) coldcall.alerts.push({ c: vert, i: "🏆", t: `${topC[0]} en tête`, x: `${topC[1].callBook} call(s) bookés déclarés sur ${topC[1].appeles} appels.` });
    }
    const alerts = [...closer.alerts, ...setter.alerts, ...coldcall.alerts];

    // ---- synthese
    const kv = (b, nom) => b.kpis.find((k) => k.l === nom);
    const type = (k) => ((k.d1 > 0) === (k.better === "up") ? "good" : "bad");
    const insights = [];
    for (const [bloc, nom, titre] of [
      [closer, "CA contracté", "Closing"],
      [setter, "Calls de closing bookés", "Setting"],
      [coldcall, "Calls bookés déclarés", "Cold call"],
    ]) {
      const k = kv(bloc, nom);
      if (!k) continue;
      const flat = Math.abs(k.d1) < 2;
      insights.push({
        type: flat ? "warn" : type(k),
        title: `${titre} : ${k.l.toLowerCase()} à ${k.v}`,
        text: flat ? "Stable par rapport à la semaine précédente." : `<b>${k.d1 > 0 ? "+" : ""}${k.d1} ${k.t === "pts" ? "pts" : "%"}</b> vs S-1 et ${k.d4 > 0 ? "+" : ""}${k.d4} ${k.t === "pts" ? "pts" : "%"} vs la moyenne des 4 dernières semaines.`,
      });
    }

    // ---- bandeau + tendance
    const headline = [
      { l: "CA contracté", v: fmtEur(T.ca), c: `${kv(closer, "CA contracté").d1 >= 0 ? "+" : ""}${kv(closer, "CA contracté").d1} % vs S-1`, good: kv(closer, "CA contracté").d1 >= 0 },
      { l: "Ventes", v: fmtNb(T.ventes), c: `${kv(closer, "Ventes").d1 >= 0 ? "+" : ""}${kv(closer, "Ventes").d1} % vs S-1`, good: kv(closer, "Ventes").d1 >= 0 },
      { l: "Taux de show", v: fmtPct(T.show), c: `${kv(closer, "Taux de show").d1 >= 0 ? "+" : ""}${kv(closer, "Taux de show").d1} pts vs S-1`, good: kv(closer, "Taux de show").d1 >= 0 },
    ];
    const trend = [
      { t: "CA contracté (€)", pts: A.map((a) => Math.round(a.total.ca)), better: "up", fmt: "eur" },
      { t: "Taux de show (%)", pts: A.map((a) => (a.total.show == null ? 0 : Math.round(a.total.show))), better: "up", fmt: "pct" },
      { t: "Calls de closing bookés via setter", pts: S.map((a) => a.total.callsBookes), better: "up", fmt: "n" },
    ];

    const week = {
      num: semaine.court,
      label: `Du ${jolie(semaine.debut)} au ${jolie(semaine.fin)} ${semaine.fin.slice(0, 4)}`,
      generated: new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date()).replace(",", " à"),
      debut: semaine.debut,
      fin: semaine.fin,
      code: semaine.code,
    };

    const slack = {
      titre: `Bilan Sales Team · ${semaine.court} (${jolie(semaine.debut)} – ${jolie(semaine.fin)})`,
      lignes: [
        `🎯 Closer : ${fmtNb(T.rdv)} RDV, show ${fmtPct(T.show)}, ${fmtNb(T.ventes)} vente(s), closing ${fmtPct(T.closing)}, ${fmtEur(T.ca)} contractés, ${fmtEur(T.encaisse)} encaissés (${kv(closer, "CA contracté").d1 >= 0 ? "+" : ""}${kv(closer, "CA contracté").d1} % vs S-1)`,
        `📞 Setter : ${fmtNb(ST.assignes)} leads assignés, ${fmtPct(rapport(ST.contactes, ST.assignes))} contactés, ${fmtNb(ST.callsBookes)} call(s) de closing bookés, ${fmtNb(ST.ventes)} vente(s)`,
        cc.erreur ? `☎️ Cold call : données indisponibles (${cc.erreur})` : `☎️ Cold call : ${fmtNb(totCC.appeles)} appels, ${fmtPct(totCC.tauxRep)} de réponse, ${fmtNb(totCC.callBook)} call(s) bookés déclarés`,
      ],
    };

    // Le bilan d'une semaine passee ne bouge pas : 5 min au CDN, ancienne reponse servie 10 min pendant le rafraichissement.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      genereLe: new Date().toISOString(),
      semaine: semaine.code,
      sample: false,
      week,
      headline,
      insights,
      blocks: [closer, setter, coldcall],
      weeks: semaines.map((w) => w.court),
      trend,
      alerts,
      slack,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
