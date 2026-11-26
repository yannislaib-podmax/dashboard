// Fonction serveur — Bilan hebdomadaire ACQUISITION (JSON prêt pour le modèle bilans/acquisition.html).
//
// GET /api/bilan-acquisition?semaine=2026-S47
//   semaine : AAAA-Snn (semaine ISO, lundi → dimanche, heure de Paris).
//             Absente = dernière semaine ISO COMPLÈTE.
//
// ZÉRO INCOHÉRENCE : on n'a PAS recopié les règles de calcul. On appelle le handler de
// api/acquisition.js (celui qui alimente la page Acquisition du dashboard) et on lit ses
// lignes jour | canal | produit, avec la vue par défaut du dashboard :
//   Closing, rang R1, RDV rangés au jour de prise, calls tenus au jour du RDV,
//   ventes / contracté au jour de signature, dépense = META_DEPENSE.
// Lus en plus : PAIEMENTS (cash collecté), CONTRATS (ventes, CA contracté, encaissé : règle des signatures
// de la semaine, comme la page Sales Team) et api/tracking.js (UTM campagne / créa, classement des sources).
//
// Le jeton Airtable ne quitte jamais le serveur (variable AIRTABLE_TOKEN de Vercel).

import acquisition from "./acquisition.js";
import tracking from "./tracking.js";

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_PAIEMENTS = "tblUodmImuM0egrdk";
const TABLE_CONTRATS = "tbl3SDo8VkXxXdzdA";
const CHAMPS_CONTRATS = {
  fldlhedw3iJNyAITQ: "dateSignature",
  fldz1nshv9SfQLn04: "montantTotal",
  fldy8OIvfHdsHTCCm: "caNet", // CA net = montant reçu - remboursé (encaissé avant frais plateforme)
  fldm0apf8f0JU1AIF: "clients", // lien CONTRATS -> CLIENTS
  fldzWxYVXBe3ZOqN5: "typeAchat", // NOUVEAU / RENOUVELLEMENT / ADDITIONNEL
};
const CHAMPS_PAIEMENTS = {
  fldEOcNYA9u1DzLxR: "contrat", // lien PAIEMENTS -> CONTRATS (sert à isoler les échéances de contrats antérieurs)
  fldWJoZHWyeXsHNvM: "prevu", // montant de l'échéance
  fldo1n4fRI9ZoLGeN: "recu", // montant reçu
  fldQTgnGDxV0v9wpr: "date", // date de l'échéance / du paiement (même champ que le dashboard : datePaiement)
  fldFI3itlnPWMt6Hn: "statut", // Payé / En attente / Impayé / Partiel / Remboursé / Annulé
};

// Seuils des alertes automatiques.
const SEUIL_SHOW = 65; // % : sous ce taux de show, alerte rouge
const SEUIL_COLLECTE = 75; // % : sous ce taux de collecte, alerte ambre
const SEUIL_COUT_HAUSSE = 15; // % : coût par call booké au-dessus de la moyenne 4 sem. de plus de X %
const SEUIL_LEADS_BAISSE = 20; // % : leads en baisse de plus de X % vs S-1
const SOURCES_TOP = ["Ads"]; // sources prises en compte dans « Top campagnes / Top créas » (null = toutes)

const JOUR_MS = 86400000;
const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const JOURS_LONG = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/* ------------------------------------------------------------------ */
/*  Dates (chaînes AAAA-MM-JJ, calcul en UTC à midi : pas de souci d'heure d'été) */
/* ------------------------------------------------------------------ */

const enDate = (isoJour) => new Date(isoJour + "T12:00:00Z");
const enIso = (d) => d.toISOString().slice(0, 10);
const plusJours = (isoJour, n) => enIso(new Date(enDate(isoJour).getTime() + n * JOUR_MS));
const jourSemaineLundi0 = (isoJour) => (enDate(isoJour).getUTCDay() + 6) % 7; // 0 = lundi

function jourParisDe(instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

function lundiDeSemaineISO(annee, num) {
  const jan4 = enDate(`${annee}-01-04`);
  const lundi1 = new Date(jan4.getTime() - jourSemaineLundi0(enIso(jan4)) * JOUR_MS);
  return enIso(new Date(lundi1.getTime() + (num - 1) * 7 * JOUR_MS));
}

function semaineISODe(isoJour) {
  const d = enDate(isoJour);
  const jeudi = new Date(d.getTime() + (3 - jourSemaineLundi0(isoJour)) * JOUR_MS);
  const annee = jeudi.getUTCFullYear();
  const jan1 = new Date(Date.UTC(annee, 0, 1, 12));
  return { annee, num: Math.floor((jeudi - jan1) / JOUR_MS / 7) + 1 };
}

const libelleSemaine = (lundi) => {
  const { annee, num } = semaineISODe(lundi);
  return `${annee}-S${String(num).padStart(2, "0")}`;
};

function libellePlage(lundi) {
  const a = enDate(lundi);
  const b = enDate(plusJours(lundi, 6));
  const jA = a.getUTCDate();
  const jB = b.getUTCDate();
  const debut = a.getUTCMonth() === b.getUTCMonth() ? `${jA}` : `${jA} ${MOIS[a.getUTCMonth()]}${a.getUTCFullYear() !== b.getUTCFullYear() ? " " + a.getUTCFullYear() : ""}`;
  return `du lundi ${debut} au dimanche ${jB} ${MOIS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

function libelleGeneration(maintenant) {
  const jour = jourParisDe(maintenant);
  const d = enDate(jour);
  const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).format(maintenant);
  const [h, m] = hm.split(":");
  return `${JOURS_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} · ${Number(h)}h${m}`;
}

/* ------------------------------------------------------------------ */
/*  Formats français                                                   */
/* ------------------------------------------------------------------ */

function fm(v, d) {
  const s = Math.abs(v).toFixed(d);
  const p = s.split(".");
  let i = p[0];
  let g = "";
  while (i.length > 3) {
    g = " " + i.slice(-3) + g;
    i = i.slice(0, -3);
  }
  return (v < 0 ? "-" : "") + i + g + (p[1] ? "," + p[1] : "");
}
const nb = (v) => (v == null || Number.isNaN(v) ? "—" : fm(v, 0));
const eur = (v) => (v == null || Number.isNaN(v) ? "—" : fm(v, Math.abs(v) >= 500 || Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2) + " €");
const pct = (v) => (v == null || Number.isNaN(v) ? "—" : Math.round(v) + " %");
const ratio = (a, b) => (b > 0 ? a / b : null);
const somme = (ls, c) => ls.reduce((t, l) => t + (Number(l[c]) || 0), 0);

/* ------------------------------------------------------------------ */
/*  Lecture Airtable (paiements) et appel du handler Acquisition       */
/* ------------------------------------------------------------------ */

function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) return brut.map((v) => (v && v.name !== undefined ? v.name : v)).join(", ");
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
}

async function lirePaiements(token) {
  const lignes = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_PAIEMENTS}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(CHAMPS_PAIEMENTS).forEach((id) => url.searchParams.append("fields[]", id));
    if (offset) url.searchParams.set("offset", offset);
    const reponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!reponse.ok) throw new Error(`Airtable a répondu ${reponse.status} : ${await reponse.text()}`);
    const donnees = await reponse.json();
    for (const enr of donnees.records) {
      const l = {};
      for (const [id, nom] of Object.entries(CHAMPS_PAIEMENTS)) l[nom] = valeur(enr.fields[id]);
      lignes.push(l);
    }
    offset = donnees.offset;
  } while (offset);
  return lignes;
}

async function lireContrats(token) {
  const lignes = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_CONTRATS}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(CHAMPS_CONTRATS).forEach((id) => url.searchParams.append("fields[]", id));
    if (offset) url.searchParams.set("offset", offset);
    const reponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!reponse.ok) throw new Error(`Airtable a répondu ${reponse.status} : ${await reponse.text()}`);
    const donnees = await reponse.json();
    for (const enr of donnees.records) {
      const l = { _id: enr.id };
      for (const [id, nom] of Object.entries(CHAMPS_CONTRATS)) l[nom] = valeur(enr.fields[id]);
      lignes.push(l);
    }
    offset = donnees.offset;
  } while (offset);
  return lignes;
}

// Même principe que pour Acquisition : on rejoue le handler de api/tracking.js (UTM, rangs R, ventes datées de la signature).
async function lireTracking() {
  let code = 200;
  let corps = null;
  const res = {
    setHeader() {},
    status(c) {
      code = c;
      return res;
    },
    json(o) {
      corps = o;
      return res;
    },
  };
  await tracking({ query: {} }, res);
  if (code !== 200 || !corps || !Array.isArray(corps.rdv)) throw new Error((corps && corps.erreur) || "api/tracking.js n'a pas renvoyé de lignes");
  return corps;
}

// On rejoue le handler de api/acquisition.js avec une réponse factice pour récupérer ses lignes.
async function lireLignesAcquisition() {
  let code = 200;
  let corps = null;
  const res = {
    setHeader() {},
    status(c) {
      code = c;
      return res;
    },
    json(o) {
      corps = o;
      return res;
    },
  };
  await acquisition({ query: {} }, res);
  if (code !== 200 || !corps || !Array.isArray(corps.lignes)) throw new Error((corps && corps.erreur) || "api/acquisition.js n'a pas renvoyé de lignes");
  return corps.lignes;
}

/* ------------------------------------------------------------------ */
/*  Calcul d'une semaine                                               */
/* ------------------------------------------------------------------ */

const ids = (brut) => String(brut || "").split(", ").filter(Boolean);

function calculerSemaine(lignes, paiements, contrats, lundi) {
  const jours = Array.from({ length: 7 }, (_, i) => plusJours(lundi, i));
  const debut = jours[0];
  const fin = jours[6];
  const lignesSem = lignes.filter((l) => l.jour && l.jour >= debut && l.jour <= fin);

  const statutExclu = new Set(["Annulé", "Remboursé"]);
  const echeances = paiements.filter((p) => p.date && String(p.date).slice(0, 10) >= debut && String(p.date).slice(0, 10) <= fin && !statutExclu.has(p.statut));

  // Signatures de la semaine : jour de dateSignature (règle du dashboard : ventes et CA au jour de signature).
  const signes = contrats.filter((k) => k.dateSignature && String(k.dateSignature).slice(0, 10) >= debut && String(k.dateSignature).slice(0, 10) <= fin);
  const idsSignes = new Set(signes.map((k) => k._id));
  const clientsDe = (ks) => new Set(ks.flatMap((k) => ids(k.clients)));
  const clientsSignes = clientsDe(signes);
  const nouveauxClients = clientsDe(signes.filter((k) => k.typeAchat === "NOUVEAU"));

  const parJour = jours.map((j) => {
    const ls = lignesSem.filter((l) => l.jour === j);
    const ps = echeances.filter((p) => String(p.date).slice(0, 10) === j);
    const ks = signes.filter((k) => String(k.dateSignature).slice(0, 10) === j);
    const conclus = somme(ls, "rendezVousConclusRdv");
    const done = somme(ls, "honoresRdv");
    return {
      spend: somme(ls, "depense"),
      impr: somme(ls, "impressions"),
      clics: somme(ls, "clics"),
      leads: somme(ls, "leads"),
      booked: somme(ls, "rendezVous"),
      planned: somme(ls, "rendezVousRdv"),
      conclus,
      done,
      noshow: Math.max(0, conclus - done),
      sales: clientsDe(ks).size,
      signed: somme(ks, "montantTotal"),
      coll: somme(ps, "recu"),
    };
  });
  const tot = (c) => parJour.reduce((t, d) => t + d[c], 0);

  const bookesCohorte = somme(lignesSem, "rendezVous");
  const resolusCohorte = somme(lignesSem, "rendezVousConclus") + somme(lignesSem, "annules");
  const depense = tot("spend");
  // Dépense « mûre » (même règle que le dashboard) : on retire la part dont les RDV n'ont pas encore d'issue.
  const depenseMure = bookesCohorte > 0 ? depense * Math.min(1, resolusCohorte / bookesCohorte) : depense;

  const due = somme(echeances, "prevu");
  const collecte = somme(echeances, "recu");
  const reste = echeances.reduce((t, p) => t + Math.max(0, (p.prevu || 0) - (p.recu || 0)), 0);
  const impaye = echeances.filter((p) => p.statut === "Impayé").reduce((t, p) => t + Math.max(0, (p.prevu || 0) - (p.recu || 0)), 0);
  // Cash collecté sur des échéances de contrats signés AVANT la semaine (ex. 2e échéance d'un contrat plus ancien).
  const collAnterieur = echeances.filter((p) => !ids(p.contrat).some((id) => idsSignes.has(id))).reduce((t, p) => t + (p.recu || 0), 0);

  const T = {
    lundi,
    spend: depense,
    impr: tot("impr"),
    clics: tot("clics"),
    leads: tot("leads"),
    booked: tot("booked"),
    planned: tot("planned"),
    conclus: tot("conclus"),
    done: tot("done"),
    noshow: tot("noshow"),
    salesR1: somme(lignesSem, "ventes"), // ventes issues d'un call Closing R1 (entonnoir)
    sales: clientsSignes.size, // clients ayant signé dans la semaine
    contrats: signes.length,
    clients: nouveauxClients.size, // nouveaux clients (au moins un contrat NOUVEAU)
    signed: somme(signes, "montantTotal"), // CA contracté
    encSign: somme(signes, "caNet"), // encaissé sur les contrats signés dans la semaine
    coll: collecte,
    collAnterieur,
    due,
    reste,
    impaye,
    honoresCohorte: somme(lignesSem, "honores"),
  };
  // Répartition Closing / Rattrapage (équivalent du toggle « Tous » du dashboard) : mêmes champs que api/acquisition.js
  // (sans suffixe = Closing R1, « D » = Rattrapage R1, « R2 » / « DR2 » = rangs 2+). Appels : R1 ; ventes et CA : tous rangs,
  // car ils sont datés à la signature du contrat et rattachés au call qui le porte.
  const sm = (c) => somme(lignesSem, c);
  T.bookC = sm("rendezVous");
  T.bookR = sm("rendezVousD");
  T.bookedAll = T.bookC + T.bookR;
  T.plannedC = sm("rendezVousRdv");
  T.plannedR = sm("rendezVousRdvD");
  T.plannedAll = T.plannedC + T.plannedR;
  T.conclusC = sm("rendezVousConclusRdv");
  T.conclusR = sm("rendezVousConclusRdvD");
  T.conclusAll = T.conclusC + T.conclusR;
  T.doneC = sm("honoresRdv");
  T.doneR = sm("honoresRdvD");
  T.doneAll = T.doneC + T.doneR;
  T.noshowAll = Math.max(0, T.conclusAll - T.doneAll);
  T.salesC = sm("ventes") + sm("ventesR2");
  T.salesR = sm("ventesD") + sm("ventesDR2");
  T.signedC = sm("contracte") + sm("contracteR2");
  T.signedR = sm("contracteD") + sm("contracteDR2");
  T.encC = sm("encaisse") + sm("encaisseR2");
  T.encR = sm("encaisseD") + sm("encaisseDR2");
  T.cpl = ratio(T.spend, T.leads);
  T.cpc = ratio(T.spend, T.booked);
  T.cpm = T.impr > 0 ? (T.spend / T.impr) * 1000 : null;
  T.ctr = T.impr > 0 ? (T.clics / T.impr) * 100 : null;
  T.cac = ratio(depenseMure, T.clients);
  T.coutCall = ratio(depenseMure, T.honoresCohorte);
  T.coutVente = ratio(depenseMure, T.sales); // dépense mûre ÷ ventes (clients ayant signé)
  T.show = T.conclus > 0 ? (T.done / T.conclus) * 100 : null;
  T.taux = T.due > 0 ? (T.coll / T.due) * 100 : null;
  T.partEnc = T.signed > 0 ? (T.encSign / T.signed) * 100 : null;
  return { T, parJour, lignesSem, jours, signes };
}

/* ------------------------------------------------------------------ */
/*  Comparaisons                                                       */
/* ------------------------------------------------------------------ */

function ecart(cur, prev, t) {
  if (cur == null || prev == null || Number.isNaN(cur) || Number.isNaN(prev)) return 0;
  if (t === "pts" || t === "abs") return Math.round(cur - prev);
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}
const moyenne = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// Favorable si le sens du mouvement correspond au sens "better".
const favorable = (d, better) => (better === "up" ? d > 0 : d < 0);

/* ------------------------------------------------------------------ */
/*  Construction du JSON                                               */
/* ------------------------------------------------------------------ */

const ICONES = { "Fb ads": "📘", Instagram: "📷", "Cold Call": "📞", "Site web": "🌐", "Tiktok ads": "🎵", "Google ads": "🔎", "Setting Call": "☎️", YouTube: "▶️", LinkedIn: "💼", TikTok: "🎵", Facebook: "👍" };
const COULEURS = ["#9B6BFF", "#E619B0", "#6FD3A3", "#F0B95A", "#5BC0EB", "#FF8A5B", "#C9A6FF", "#8FA3B8"];

export function construireBilan({ lignes, paiements, contrats = [], track = { leads: [], rdv: [], ventes: [] }, lundi, maintenant = new Date() }) {
  // 5 semaines : index 4 = semaine du bilan, 0..3 = les 4 précédentes.
  const semaines = [4, 3, 2, 1, 0].map((k) => calculerSemaine(lignes, paiements, contrats, plusJours(lundi, -7 * k)));
  const cur = semaines[4];
  const prev = semaines[3];
  const T = cur.T;
  const P = prev.T;
  const quatre = semaines.slice(0, 4).map((s) => s.T);

  const d1 = (cle, t) => ecart(T[cle], P[cle], t);
  const d4 = (cle, t) => {
    const m = moyenne(quatre.map((x) => x[cle]));
    return m == null ? 0 : ecart(T[cle], m, t);
  };

  // Jour par jour. Un coût du jour sans call/lead n'existe pas : on le remplace par la moyenne de la semaine
  // (valeur de repli pour que les courbes restent lisibles ; la semaine reste calculée sur les vrais totaux).
  const cpcMoy = T.cpc ?? 0;
  const cplMoy = T.cpl ?? 0;
  const cpmMoy = T.cpm ?? 0;
  const ctrMoy = T.ctr ?? 0;
  const arr = (c) => cur.parJour.map((d) => d[c]);
  const arrondi2 = (x) => Math.round(x * 100) / 100;
  const daily = {
    spend: arr("spend").map(arrondi2),
    impr: arr("impr"),
    cpm: cur.parJour.map((d) => arrondi2(d.impr > 0 ? (d.spend / d.impr) * 1000 : cpmMoy)),
    ctr: cur.parJour.map((d) => arrondi2(d.impr > 0 ? (d.clics / d.impr) * 100 : ctrMoy)),
    leads: arr("leads"),
    booked: arr("booked"),
    cpc: cur.parJour.map((d) => arrondi2(d.booked > 0 ? d.spend / d.booked : cpcMoy)),
    cpl: cur.parJour.map((d) => arrondi2(d.leads > 0 ? d.spend / d.leads : cplMoy)),
    done: arr("done"),
    noshow: arr("noshow"),
    planned: arr("planned"),
    sales: arr("sales"),
    signed: arr("signed").map(arrondi2),
    coll: arr("coll").map(arrondi2),
  };

  const kpi = (l, cle, valFmt, better, t, extra = {}) => ({ l, v: valFmt(T[cle]), d1: d1(cle, t), d4: d4(cle, t), better, t, ...extra });
  const pct1 = (v) => (v == null || Number.isNaN(v) ? "—" : fm(v, 2) + " %");
  const s = (n) => (n > 1 ? "s" : "");
  // Ventilation « Closing · Rattrapage » affichée sous le chiffre (comme le mode « Tous » de l'onglet Closing).
  // Si Closing + Rattrapage ne couvre pas le total (contrats sans call rattaché), la différence est affichée « sans call ».
  const rep = (c, r, total, fmt) => {
    const lignes = [`<b>${fmt(c)}</b> Closing`, `<b>${fmt(r)}</b> Rattrapage`];
    const reste = Math.round((total - c - r) * 100) / 100;
    if (reste > 0.004) lignes.push(`<b>${fmt(reste)}</b> sans call`);
    return lignes;
  };
  const groups = [
    {
      title: "Média",
      icon: "📣",
      color: "#9B6BFF",
      items: [
        kpi("Dépense pub", "spend", eur, "down", "%", { c: "bleu", sub: ["Meta : Fb ads + Instagram"], ref: "au jour de la dépense" }),
        kpi("Impressions", "impr", nb, "up", "%", { c: "violet", sub: ["impressions Meta"], ref: "au jour de la diffusion" }),
        kpi("CPM", "cpm", eur, "down", "%", { c: "magenta", sub: ["coût pour 1 000 impressions"], ref: "dépense ÷ impressions" }),
        kpi("CTR", "ctr", pct1, "up", "%", { c: "vert", sub: [`${nb(T.clics)} clics`], ref: "clics ÷ impressions" }),
      ],
    },
    {
      title: "Volumes",
      icon: "📊",
      color: "#E619B0",
      items: [
        kpi("Leads", "leads", nb, "up", "%", { c: "bleu", ref: "à la capture du lead" }),
        kpi("Rendez-vous pris", "bookedAll", nb, "up", "%", { c: "violet", rep: rep(T.bookC, T.bookR, T.bookedAll, nb), ref: "à la prise de RDV" }),
        kpi("Rendez-vous honorés", "doneAll", nb, "up", "%", { c: "vert", rep: rep(T.doneC, T.doneR, T.doneAll, nb), sub: [`sur ${nb(T.conclusAll)} conclus · ${nb(T.noshowAll)} no-show${s(T.noshowAll)}`], ref: "au jour du RDV" }),
        kpi("Ventes", "sales", nb, "up", "abs", { c: "jaune", rep: rep(T.salesC, T.salesR, T.sales, nb), sub: [`${nb(T.contrats)} contrat${s(T.contrats)} · clients ayant signé`], ref: "à la signature" }),
      ],
    },
    {
      title: "Coûts",
      icon: "💶",
      color: "#F0B95A",
      items: [
        kpi("Coût par lead", "cpl", eur, "down", "%", { c: "bleu", sub: [`${eur(T.spend)} ÷ ${nb(T.leads)} leads`], ref: "à la capture du lead" }),
        kpi("Coût par call booké", "cpc", eur, "down", "%", { c: "violet", sub: [`${eur(T.spend)} ÷ ${nb(T.booked)} calls Closing R1`], ref: "à la prise de RDV" }),
        kpi("Coût par call présent", "coutCall", eur, "down", "%", { c: "vert", sub: [`dépense mûre ÷ ${nb(T.honoresCohorte)} présents`], ref: "calls pris dans la semaine" }),
        kpi("Coût par vente", "coutVente", eur, "down", "%", { c: "jaune", sub: [`dépense mûre ÷ ${nb(T.sales)} vente${s(T.sales)}`], ref: "à la signature" }),
      ],
    },
    {
      title: "CA & cash",
      icon: "💵",
      color: "#6FD3A3",
      items: [
        kpi("CA contracté", "signed", eur, "up", "%", { c: "bleu", rep: rep(T.signedC, T.signedR, T.signed, eur), ref: "à la signature" }),
        kpi("Encaissé sur les signatures", "encSign", eur, "up", "%", { c: "violet", rep: rep(T.encC, T.encR, T.encSign, eur), sub: T.partEnc == null ? [] : [`${Math.round(T.partEnc)} % du CA contracté`], ref: "à la signature" }),
        kpi("Cash collecté", "coll", eur, "up", "%", { c: "vert", sub: [T.collAnterieur > 0 ? `dont ${eur(T.collAnterieur)} d'échéances de contrats antérieurs` : "échéances de la semaine"], ref: "à la date d'échéance" }),
        kpi("Taux de collecte", "taux", pct, "up", "pts", { c: "jaune", sub: [`${eur(T.reste)} restent à collecter`], ref: "cash collecté ÷ échéances dues" }),
      ],
    },
  ];

  // Bandeau
  const chipTxt = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d) + " %";
  const headline = [
    { l: "Leads", v: nb(T.leads), c: chipTxt(d1("leads", "%")), good: !(d1("leads", "%") < 0) },
    { l: "Coût par call booké", v: eur(T.cpc), c: chipTxt(d1("cpc", "%")), good: !(d1("cpc", "%") > 0) },
    { l: "CA contracté", v: eur(T.signed), c: chipTxt(d1("signed", "%")), good: !(d1("signed", "%") < 0) },
  ];

  // Entonnoir
  const funnel = [
    ["🧲", "Leads", T.leads],
    ["📥", "Calls bookés", T.booked],
    ["📅", "Calls prévus", T.planned],
    ["✅", "Calls réalisés", T.done],
    ["🏆", "Ventes R1", T.salesR1],
  ];
  const funnelNote = `Ventes R1 = ventes issues d'un call Closing de rang R1. Signatures de la semaine, tous rangs : <b>${nb(T.sales)} client${T.sales > 1 ? "s" : ""}</b> · ${nb(T.contrats)} contrat${T.contrats > 1 ? "s" : ""} · <b>${eur(T.signed)}</b> contractés.`;

  // Sources (= canaux d'acquisition du dashboard). Dépense, leads, calls bookés (R1), calls réalisés : lignes Acquisition.
  // Ventes et CA contracté : contrats signés dans la semaine, rangés au canal du call auquel ils sont rattachés.
  const enSemaine = (j) => j && j >= cur.jours[0] && j <= cur.jours[6];
  const parCanal = new Map();
  const ligneCanal = (n) => {
    if (!parCanal.has(n)) parCanal.set(n, { n, spend: 0, leads: 0, booked: 0, done: 0, sales: 0, signed: 0 });
    return parCanal.get(n);
  };
  for (const l of cur.lignesSem) {
    const sc = ligneCanal(l.canal || "Non déterminé");
    sc.spend += l.depense || 0;
    sc.leads += l.leads || 0;
    sc.booked += l.rendezVous || 0;
    sc.done += l.honoresRdv || 0;
  }
  let ventesRattachees = 0;
  let contracteRattache = 0;
  for (const v of (track.ventes || []).filter((x) => enSemaine(x.jour))) {
    const sc = ligneCanal(v.canal || "Non déterminé");
    sc.sales += 1;
    sc.signed += v.montant || 0;
    ventesRattachees += 1;
    contracteRattache += v.montant || 0;
  }
  // Contrats signés sans call rattaché : ligne dédiée, pour que le total du tableau égale le CA contracté.
  const ecartContrats = Math.max(0, T.sales - ventesRattachees);
  const ecartCA = T.signed - contracteRattache;
  if (ecartContrats > 0 || Math.abs(ecartCA) > 0.5) {
    const sc = ligneCanal("Sans call rattaché");
    sc.sales += ecartContrats;
    sc.signed += ecartCA;
  }
  const sources = [...parCanal.values()]
    .filter((x) => x.spend || x.leads || x.booked || x.done || x.sales || x.signed)
    .sort((x, y) => y.booked - x.booked || y.leads - x.leads || y.spend - x.spend)
    .map((x, i) => ({ i: ICONES[x.n] || "📣", ...x, spend: arrondi2(x.spend), signed: arrondi2(x.signed), col: COULEURS[i % COULEURS.length] }));

  // Top campagnes (utm_campaign) et top créas (utm_content), sur la semaine, classés par VENTES.
  // Ventes et CA contracté = toutes les signatures de la semaine (track.ventes : un call = une vente, un contrat n'est compté
  // qu'une fois, rangs R1/R2/R3 confondus), rangées à l'UTM du call qui porte le contrat (même règle que le Tracking UTM).
  // Leads = captés dans la semaine ; bookés = calls Closing R1 pris dans la semaine ; honorés = présents parmi ces calls.
  // Valeur d'UTM telle que saisie dans Airtable (plusieurs valeurs = une seule clé, comme le Tracking).
  // Sont classées : toute campagne / créa qui a au moins une vente (quelle que soit la source) + les campagnes / créas de la pub
  // payante (source « Ads »). Le reste (noms de caller, de page, d'apporteur sans vente) est regroupé dans « Autres »,
  // pour que le total égale toujours les ventes et le CA contracté de la semaine.
  const SANS_UTM = "Non renseigné";
  const estPub = (x) => !SOURCES_TOP || SOURCES_TOP.includes(x.source);
  const topUtm = (champ) => {
    const m = new Map();
    const pt = (k) => {
      const cle = k || SANS_UTM;
      if (!m.has(cle)) m.set(cle, { n: cle, leads: 0, booked: 0, done: 0, sales: 0, signed: 0, pub: false, srcs: new Map() });
      return m.get(cle);
    };
    const marque = (x, r, poids) => {
      if (estPub(r)) x.pub = true;
      if (r.source) x.srcs.set(r.source, (x.srcs.get(r.source) || 0) + poids);
    };
    for (const l of (track.leads || []).filter((x) => enSemaine(x.jour))) {
      const x = pt(l[champ]);
      x.leads += 1;
      marque(x, l, 1);
    }
    for (const r of (track.rdv || []).filter((x) => enSemaine(x.jour) && x.typeAppel === "Closing" && x.rangR === 1 && !x.venteSeule)) {
      const x = pt(r[champ]);
      x.booked += 1;
      x.done += r.present || 0;
      marque(x, r, 1);
    }
    for (const v of (track.ventes || []).filter((x) => enSemaine(x.jour))) {
      const x = pt(v[champ]);
      x.sales += 1;
      x.signed += v.montant || 0;
      marque(x, v, 100);
    }
    const tous = [...m.values()].filter((x) => x.leads || x.booked || x.done || x.sales || x.signed);
    const gardees = tous.filter((x) => x.sales > 0 || x.pub);
    const classe = (x, y) => y.sales - x.sales || y.signed - x.signed || y.booked - x.booked || y.leads - x.leads;
    const ordonnees = [...gardees].sort(classe);
    const lignes = ordonnees.slice(0, 5);
    const restes = tous.filter((x) => !lignes.includes(x));
    const somLigne = (ls) => ({
      leads: somme(ls, "leads"), booked: somme(ls, "booked"), done: somme(ls, "done"), sales: somme(ls, "sales"), signed: arrondi2(somme(ls, "signed")),
    });
    const sortie = (x) => {
      let src = "";
      let max = -1;
      for (const [k, w] of x.srcs) if (w > max) { max = w; src = k; }
      return { n: x.n, src, leads: x.leads, booked: x.booked, done: x.done, sales: x.sales, signed: arrondi2(x.signed) };
    };
    return {
      total: somLigne(tous),
      lignes: lignes.map(sortie),
      autres: restes.length ? { n: `Autres (${restes.length})`, ...somLigne(restes) } : null,
    };
  };
  const ventesSemaine = (track.ventes || []).filter((x) => enSemaine(x.jour));
  const ventesPub = ventesSemaine.filter(estPub);
  const depensePub = T.spend;
  const top = {
    sources: SOURCES_TOP,
    base: "Classement par ventes, puis CA contracté, puis calls bookés · ventes et CA contracté = toutes les signatures de la semaine (R1, R2 et R3), rangées à l'UTM du call qui porte le contrat · leads captés dans la semaine · bookés = calls Closing R1 pris dans la semaine · honorés = présents parmi ces calls · campagnes et créas sans vente classées seulement pour la pub payante (source Ads), le reste est regroupé dans « Autres »",
    cout: {
      depense: arrondi2(depensePub),
      ventesPub: ventesPub.length,
      signedPub: arrondi2(ventesPub.reduce((t, v) => t + (v.montant || 0), 0)),
      coutParVentePub: ventesPub.length ? arrondi2(depensePub / ventesPub.length) : null,
      note: "La dépense Meta n'est pas ventilée par campagne ni par créa dans META_DEPENSE : le coût par vente est donné pour l'ensemble de la pub payante (dépense Meta de la semaine ÷ ventes sur source Ads).",
    },
    campagnes: topUtm("utmCampaign"),
    creas: topUtm("utmContent"),
  };

  // Tendance 5 semaines (valeur manquante = moyenne des valeurs connues, pour garder la courbe lisible)
  const serie = (cle, arrondi) => {
    const vals = semaines.map((s) => s.T[cle]);
    const m = moyenne(vals) ?? 0;
    return vals.map((v) => arrondi(v == null ? m : v));
  };
  const trend = [
    { t: "Coût par lead (€)", pts: serie("cpl", (v) => Math.round(v * 10) / 10), better: "down", fmt: "eur" },
    { t: "Coût par call booké (€)", pts: serie("cpc", (v) => Math.round(v * 10) / 10), better: "down", fmt: "eur" },
    { t: "Taux de show (%)", pts: serie("show", (v) => Math.round(v)), better: "up", fmt: "pct" },
  ];
  const weeks = semaines.map((s) => "S" + String(semaineISODe(s.T.lundi).num).padStart(2, "0"));

  // Alertes automatiques par seuils
  const alerts = [];
  const ROUGE = "#FF5C7A";
  const AMBRE = "#F0B95A";
  const VERT = "#6FD3A3";
  const showMoy = moyenne(quatre.map((x) => x.show));
  if (T.spend === 0) {
    alerts.push({ c: ROUGE, i: "🚨", t: "Dépense pub non saisie", x: "Aucune dépense dans META_DEPENSE sur la semaine : tous les coûts (par lead, par call, CAC) sont à lire avec prudence." });
  }
  if (T.show != null && T.show < SEUIL_SHOW) {
    const ecartShow = showMoy != null ? Math.round(T.show - showMoy) : null;
    alerts.push({
      c: ROUGE,
      i: "🚨",
      t: `Taux de show à ${Math.round(T.show)} %`,
      x: `Sous le seuil de ${SEUIL_SHOW} %${ecartShow != null ? ` et ${ecartShow < 0 ? "en baisse de " + Math.abs(ecartShow) + " points" : "en hausse de " + ecartShow + " points"} vs la moyenne des 4 dernières semaines` : ""}. ${nb(T.noshow)} no-show${T.noshow > 1 ? "s" : ""} sur ${nb(T.conclus)} calls conclus.`,
    });
  }
  const cpcMoy4 = moyenne(quatre.map((x) => x.cpc));
  if (T.cpc != null && cpcMoy4 != null) {
    const ecartCpc = Math.round(((T.cpc - cpcMoy4) / cpcMoy4) * 100);
    const minCinq = Math.min(...semaines.map((s) => s.T.cpc).filter((v) => v != null));
    if (ecartCpc >= SEUIL_COUT_HAUSSE) {
      alerts.push({ c: ROUGE, i: "🚨", t: `Coût par call booké à ${eur(T.cpc)}`, x: `${ecartCpc} % au-dessus de la moyenne des 4 dernières semaines (${eur(cpcMoy4)}).` });
    } else if (T.cpc <= minCinq && ecartCpc < 0) {
      alerts.push({ c: VERT, i: "✅", t: "Coût par call booké au plus bas", x: `${eur(T.cpc)} contre ${eur(cpcMoy4)} en moyenne sur 4 semaines : le plus bas des 5 dernières semaines.` });
    }
  }
  if (T.taux != null && T.taux < SEUIL_COLLECTE) {
    alerts.push({
      c: AMBRE,
      i: "⚠️",
      t: `Taux de collecte à ${Math.round(T.taux)} %`,
      x: `${eur(T.reste)} restent à collecter sur ${eur(T.due)} d'échéances de la semaine${T.impaye > 0 ? `, dont ${eur(T.impaye)} en impayé` : ""}.`,
    });
  }
  if (d1("leads", "%") <= -SEUIL_LEADS_BAISSE && P.leads > 0) {
    alerts.push({ c: AMBRE, i: "⚠️", t: `Leads en baisse de ${Math.abs(d1("leads", "%"))} %`, x: `${nb(T.leads)} leads contre ${nb(P.leads)} la semaine précédente.` });
  }
  if (T.sales === 0) {
    alerts.push({ c: AMBRE, i: "⚠️", t: "Aucune vente sur la semaine", x: `${nb(T.done)} call${T.done > 1 ? "s" : ""} réalisé${T.done > 1 ? "s" : ""}, aucun contrat signé.` });
  }
  if (!alerts.length) alerts.push({ c: VERT, i: "✅", t: "Aucune alerte", x: "Aucun seuil franchi cette semaine." });

  // Synthèse rédigée : meilleur mouvement, point à surveiller (cash), pire mouvement
  const candidats = [
    { nom: "coût par call booké", cle: "cpc", better: "down", t: "%", f: eur },
    { nom: "coût par lead", cle: "cpl", better: "down", t: "%", f: eur },
    { nom: "nombre de leads", cle: "leads", better: "up", t: "%", f: nb },
    { nom: "CA contracté", cle: "signed", better: "up", t: "%", f: eur },
    { nom: "taux de show", cle: "show", better: "up", t: "pts", f: pct },
    { nom: "nombre de calls bookés", cle: "booked", better: "up", t: "%", f: nb },
    { nom: "CPM", cle: "cpm", better: "down", t: "%", f: eur },
    { nom: "CTR", cle: "ctr", better: "up", t: "%", f: (v) => fm(v, 2) + " %" },
  ].map((c) => ({ ...c, d: d1(c.cle, c.t), val: T[c.cle] })).filter((c) => c.val != null);
  const unite = (c) => (c.t === "pts" ? " points" : " %");
  const meilleurs = candidats.filter((c) => favorable(c.d, c.better)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const pires = candidats.filter((c) => c.d !== 0 && !favorable(c.d, c.better)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const insights = [
    meilleurs.length
      ? { type: "good", title: "Ce qui marche", text: `Le <b>${meilleurs[0].nom}</b> ${meilleurs[0].better === "down" ? "baisse" : "progresse"} de <b>${Math.abs(meilleurs[0].d)}${unite(meilleurs[0])}</b> vs S-1 (<b>${meilleurs[0].f(meilleurs[0].val)}</b>).${meilleurs[1] ? ` ${meilleurs[1].nom.charAt(0).toUpperCase() + meilleurs[1].nom.slice(1)} : ${meilleurs[1].d > 0 ? "+" : "−"}${Math.abs(meilleurs[1].d)}${unite(meilleurs[1])}.` : ""}` }
      : { type: "good", title: "Ce qui marche", text: "Aucun indicateur ne progresse nettement par rapport à la semaine précédente." },
    T.reste > 0 || (T.taux != null && T.taux < 100)
      ? { type: "warn", title: "À surveiller", text: `<b>${eur(T.reste)}</b> restent à collecter (taux de collecte à <b>${pct(T.taux)}</b>)${T.impaye > 0 ? `, dont <b>${eur(T.impaye)}</b> d'échéances en impayé` : ""}.` }
      : { type: "warn", title: "À surveiller", text: `Toutes les échéances de la semaine (${eur(T.due)}) sont collectées.` },
    pires.length
      ? { type: "bad", title: "Point faible", text: `Le <b>${pires[0].nom}</b> ${pires[0].better === "down" ? "monte" : "recule"} de <b>${Math.abs(pires[0].d)}${unite(pires[0])}</b> vs S-1 (<b>${pires[0].f(pires[0].val)}</b>).${T.noshow > 0 ? ` ${nb(T.noshow)} no-show${T.noshow > 1 ? "s" : ""} sur la semaine.` : ""}` }
      : { type: "good", title: "Point faible", text: "Aucun indicateur ne se dégrade par rapport à la semaine précédente." },
  ];

  // Message Slack (mrkdwn)
  const fl = (d, better, t) => (d === 0 ? "=" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}${t === "pts" ? " pts" : t === "abs" ? "" : " %"}`) + (d === 0 ? "" : favorable(d, better) ? " ✅" : " ⚠️");
  const { num: numSem } = semaineISODe(lundi);
  const aere = (l) => l.flatMap((x, i) => (i && String(x).startsWith("•") && String(l[i - 1]).startsWith("•") ? ["", x] : [x])); // ligne vide entre chaque puce (Slack)
  const slack = {
    titre: `📣 *Bilan hebdo Acquisition · S${numSem}* (${libellePlage(lundi).replace(/^du lundi /, "").replace(" au dimanche ", " → ")})`,
    // Chaque entrée = une ligne ; "" = ligne vide (Make joint avec \n). Sections séparées pour une lecture en un coup d'œil.
    lignes: [
      "━━━━━━━━━━━━━━━━━━━━━━",
      "",
      `:mega: *ACQUISITION*`,
      `• :money_with_wings: Dépense pub : *${eur(T.spend)}*  (${fl(d1("spend", "%"), "down", "%")} vs S-1)`,
      `• :busts_in_silhouette: Leads : *${nb(T.leads)}*  (${fl(d1("leads", "%"), "up", "%")})`,
      `• :moneybag: Coût par lead : *${eur(T.cpl)}*`,
      `• :inbox_tray: Calls bookés : *${nb(T.booked)}*  (${fl(d1("booked", "%"), "up", "%")})`,
      `• :dart: Coût par call booké : *${eur(T.cpc)}*  (${fl(d1("cpc", "%"), "down", "%")})`,
      `• :film_projector: CPM : *${eur(T.cpm)}*  (${fl(d1("cpm", "%"), "down", "%")})  ·  CTR : *${T.ctr == null ? "—" : fm(T.ctr, 2) + " %"}*  (${fl(d1("ctr", "%"), "up", "%")})`,
      "",
      "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
      "",
      `:telephone_receiver: *CALLS*`,
      `• :white_check_mark: Réalisés : *${nb(T.done)}* sur ${nb(T.planned)} prévus`,
      `• :bust_in_silhouette: Taux de show : *${pct(T.show)}*  (${fl(d1("show", "pts"), "up", "pts")})`,
      "",
      "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
      "",
      `:trophy: *VENTES*`,
      `• :handshake: Clients : *${nb(T.sales)}*  (${nb(T.contrats)} contrat${T.contrats > 1 ? "s" : ""}, dont *${nb(T.clients)}* nouveau${T.clients > 1 ? "x" : ""} client${T.clients > 1 ? "s" : ""})`,
      `• :pencil2: CA contracté : *${eur(T.signed)}*  (${fl(d1("signed", "%"), "up", "%")})`,
      `• :euro: Encaissé sur ces signatures : *${eur(T.encSign)}*`,
      "",
      "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
      "",
      `:dollar: *CASH*`,
      `• :moneybag: Collecté : *${eur(T.coll)}*${T.collAnterieur > 0 ? `  (dont ${eur(T.collAnterieur)} d'échéances antérieures)` : ""}`,
      `• :chart_with_upwards_trend: Taux de collecte : *${pct(T.taux)}*`,
      `• :hourglass_flowing_sand: Reste à collecter : *${eur(T.reste)}*`,
      ...(top.campagnes.lignes[0] && top.campagnes.lignes[0].sales
        ? [
            "",
            "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
            "",
            `:first_place_medal: *TOP DE LA SEMAINE*`,
            `• Campagne : *${top.campagnes.lignes[0].n}*  (${nb(top.campagnes.lignes[0].sales)} vente${top.campagnes.lignes[0].sales > 1 ? "s" : ""}, ${eur(top.campagnes.lignes[0].signed)})`,
            `• Créa : *${top.creas.lignes[0].n}*  (${nb(top.creas.lignes[0].sales)} vente${top.creas.lignes[0].sales > 1 ? "s" : ""}, ${eur(top.creas.lignes[0].signed)})`,
          ]
        : []),
      ...(alerts.length
        ? ["", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "", `:rotating_light: *ALERTES*`, "", ...alerts.flatMap((a, i) => (i ? ["", `${a.i} *${a.t}* — ${a.x}`] : [`${a.i} *${a.t}* — ${a.x}`]))]
        : ["", "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈", "", `:white_check_mark: *Aucune alerte*`]),
      "",
      "━━━━━━━━━━━━━━━━━━━━━━",
    ],
  };

  return {
    semaine: libelleSemaine(lundi),
    debut: lundi,
    fin: plusJours(lundi, 6),
    genereLe: maintenant.toISOString(),
    sample: false,
    week: { num: numSem, label: libellePlage(lundi), generated: libelleGeneration(maintenant) },
    days: JOURS,
    daily,
    headline,
    insights,
    groups,
    funnel,
    funnelNote,
    sources,
    top,
    trend,
    weeks,
    alerts,
    slack: { ...slack, lignes: aere(slack.lignes), texte: [slack.titre, ...aere(slack.lignes)].join("\n") },
    meta: {
      perimetre: "Calls : Closing R1 (vue par défaut du dashboard), RDV au jour de prise, calls tenus au jour du RDV · Ventes et CA : contrats signés dans la semaine (jour de signature, comme la page Sales Team)",
      ventes: "Ventes = clients ayant signé dans la semaine ; nouveaux clients = au moins un contrat de type NOUVEAU ; CA contracté = montant total des contrats ; encaissé = CA net des contrats signés dans la semaine",
      collecte: "Échéances PAIEMENTS datées dans la semaine, hors Annulé / Remboursé",
      coutsManquants: "Un jour sans lead ou sans call booké reprend la moyenne de la semaine dans les courbes quotidiennes (totaux inchangés)",
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Handler                                                            */
/* ------------------------------------------------------------------ */

export function lundiDemande(parametre, maintenant = new Date()) {
  if (parametre) {
    const m = String(parametre).trim().match(/^(\d{4})-?S?(\d{1,2})$/i);
    if (!m) throw new Error("Paramètre semaine invalide : attendu AAAA-Snn (ex. 2026-S47)");
    const num = Number(m[2]);
    if (num < 1 || num > 53) throw new Error("Numéro de semaine hors limites (1 à 53)");
    return lundiDeSemaineISO(Number(m[1]), num);
  }
  // Dernière semaine complète = lundi de la semaine en cours - 7 jours.
  const aujourdhui = jourParisDe(maintenant);
  return plusJours(plusJours(aujourdhui, -jourSemaineLundi0(aujourdhui)), -7);
}

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({
      erreur: "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const lundi = lundiDemande(req.query && req.query.semaine);
    const [lignes, paiements, contrats, track] = await Promise.all([lireLignesAcquisition(), lirePaiements(token), lireContrats(token), lireTracking()]);
    const bilan = construireBilan({ lignes, paiements, contrats, track, lundi });
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(bilan);
  } catch (erreur) {
    const message = String(erreur.message || erreur);
    return res.status(/invalide|hors limites/.test(message) ? 400 : 502).json({ erreur: message });
  }
}
