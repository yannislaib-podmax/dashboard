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
// Seul le cash collecté est lu en plus dans PAIEMENTS (le dashboard ne l'expose pas par jour).
//
// Le jeton Airtable ne quitte jamais le serveur (variable AIRTABLE_TOKEN de Vercel).

import acquisition from "./acquisition.js";

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_PAIEMENTS = "tblUodmImuM0egrdk";
const CHAMPS_PAIEMENTS = {
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

const clients = (l) => ("clients_C1" in l ? l.clients_C1 : l.clients) || 0; // vue par défaut du dashboard : Closing R1

function calculerSemaine(lignes, paiements, lundi) {
  const jours = Array.from({ length: 7 }, (_, i) => plusJours(lundi, i));
  const debut = jours[0];
  const fin = jours[6];
  const lignesSem = lignes.filter((l) => l.jour && l.jour >= debut && l.jour <= fin);

  const statutExclu = new Set(["Annulé", "Remboursé"]);
  const echeances = paiements.filter((p) => p.date && String(p.date).slice(0, 10) >= debut && String(p.date).slice(0, 10) <= fin && !statutExclu.has(p.statut));

  const parJour = jours.map((j) => {
    const ls = lignesSem.filter((l) => l.jour === j);
    const ps = echeances.filter((p) => String(p.date).slice(0, 10) === j);
    const conclus = somme(ls, "rendezVousConclusRdv");
    const done = somme(ls, "honoresRdv");
    return {
      spend: somme(ls, "depense"),
      leads: somme(ls, "leads"),
      booked: somme(ls, "rendezVous"),
      planned: somme(ls, "rendezVousRdv"),
      conclus,
      done,
      noshow: Math.max(0, conclus - done),
      sales: somme(ls, "ventes"),
      signed: somme(ls, "contracte"),
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

  const T = {
    lundi,
    spend: depense,
    leads: tot("leads"),
    booked: tot("booked"),
    planned: tot("planned"),
    conclus: tot("conclus"),
    done: tot("done"),
    noshow: tot("noshow"),
    sales: tot("sales"),
    signed: tot("signed"),
    clients: somme(lignesSem, "clients_C1" in (lignesSem[0] || {}) ? "clients_C1" : "clients"),
    coll: collecte,
    due,
    reste,
    impaye,
    honoresCohorte: somme(lignesSem, "honores"),
  };
  T.cpl = ratio(T.spend, T.leads);
  T.cpc = ratio(T.spend, T.booked);
  T.cac = ratio(depenseMure, T.sales);
  T.coutCall = ratio(depenseMure, T.honoresCohorte);
  T.show = T.conclus > 0 ? (T.done / T.conclus) * 100 : null;
  T.taux = T.due > 0 ? (T.coll / T.due) * 100 : null;
  return { T, parJour, lignesSem, jours };
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

export function construireBilan({ lignes, paiements, lundi, maintenant = new Date() }) {
  // 5 semaines : index 4 = semaine du bilan, 0..3 = les 4 précédentes.
  const semaines = [4, 3, 2, 1, 0].map((k) => calculerSemaine(lignes, paiements, plusJours(lundi, -7 * k)));
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
  const arr = (c) => cur.parJour.map((d) => d[c]);
  const arrondi2 = (x) => Math.round(x * 100) / 100;
  const daily = {
    spend: arr("spend").map(arrondi2),
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
  const groups = [
    {
      title: "Acquisition",
      icon: "📣",
      color: "#9B6BFF",
      items: [
        kpi("Dépense pub", "spend", eur, "down", "%", { spark: "spend" }),
        kpi("Leads", "leads", nb, "up", "%", { spark: "leads" }),
        kpi("Coût par lead", "cpl", eur, "down", "%", { spark: "cpl" }),
        kpi("Calls bookés", "booked", nb, "up", "%", { spark: "booked" }),
        kpi("Coût par call booké", "cpc", eur, "down", "%", { spark: "cpc", hero: true, icon: "🎯" }),
        kpi("Coût par vente (CAC)", "cac", eur, "down", "%", { spark: null }),
      ],
    },
    {
      title: "Calls",
      icon: "📞",
      color: "#E619B0",
      items: [
        kpi("Calls prévus", "planned", nb, "up", "%", { spark: "planned" }),
        kpi("Calls réalisés", "done", nb, "up", "%", { spark: "done" }),
        kpi("Taux de show", "show", pct, "up", "pts", { ring: T.show == null ? 0 : Math.round(T.show), hero: true, icon: "👤" }),
        kpi("Coût par call réalisé", "coutCall", eur, "down", "%", { spark: null }),
      ],
    },
    {
      title: "Ventes & cash",
      icon: "🏆",
      color: "#6FD3A3",
      items: [
        kpi("Ventes", "sales", nb, "up", "abs", { spark: "sales" }),
        kpi("Nouveaux clients", "clients", nb, "up", "abs", { spark: null }),
        kpi("Cash signé", "signed", eur, "up", "%", { spark: "signed" }),
        kpi("Cash collecté", "coll", eur, "up", "%", { spark: "coll" }),
        kpi("Taux de collecte", "taux", pct, "up", "pts", { ring: T.taux == null ? 0 : Math.round(T.taux), hero: true, icon: "💵" }),
        kpi("Reste à collecter", "reste", eur, "down", "%", { spark: null }),
      ],
    },
  ];

  // Bandeau
  const chipTxt = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + Math.abs(d) + " %";
  const headline = [
    { l: "Leads", v: nb(T.leads), c: chipTxt(d1("leads", "%")), good: !(d1("leads", "%") < 0) },
    { l: "Coût par call booké", v: eur(T.cpc), c: chipTxt(d1("cpc", "%")), good: !(d1("cpc", "%") > 0) },
    { l: "Cash signé", v: eur(T.signed), c: chipTxt(d1("signed", "%")), good: !(d1("signed", "%") < 0) },
  ];

  // Entonnoir
  const funnel = [
    ["🧲", "Leads", T.leads],
    ["📥", "Calls bookés", T.booked],
    ["📅", "Calls prévus", T.planned],
    ["✅", "Calls réalisés", T.done],
    ["🏆", "Ventes", T.sales],
  ];

  // Sources (= canaux d'acquisition du dashboard)
  const parCanal = new Map();
  for (const l of cur.lignesSem) {
    const n = l.canal || "Non déterminé";
    if (!parCanal.has(n)) parCanal.set(n, { n, spend: 0, leads: 0, booked: 0, done: 0, sales: 0, signed: 0 });
    const s = parCanal.get(n);
    s.spend += l.depense || 0;
    s.leads += l.leads || 0;
    s.booked += l.rendezVous || 0;
    s.done += l.honoresRdv || 0;
    s.sales += l.ventes || 0;
    s.signed += l.contracte || 0;
  }
  const sources = [...parCanal.values()]
    .filter((s) => s.spend || s.leads || s.booked || s.done || s.sales || s.signed)
    .sort((a, b) => b.leads - a.leads || b.spend - a.spend)
    .map((s, i) => ({ i: ICONES[s.n] || "📣", ...s, spend: arrondi2(s.spend), signed: arrondi2(s.signed), col: COULEURS[i % COULEURS.length] }));

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
    { nom: "cash signé", cle: "signed", better: "up", t: "%", f: eur },
    { nom: "taux de show", cle: "show", better: "up", t: "pts", f: pct },
    { nom: "nombre de calls bookés", cle: "booked", better: "up", t: "%", f: nb },
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
  const slack = {
    titre: `📣 Bilan hebdo Acquisition · S${numSem} (${libellePlage(lundi).replace(/^du lundi /, "").replace(" au dimanche ", " → ")})`,
    lignes: [
      `Dépense pub : *${eur(T.spend)}* (${fl(d1("spend", "%"), "down", "%")} vs S-1)`,
      `Leads : *${nb(T.leads)}* (${fl(d1("leads", "%"), "up", "%")}) · coût par lead *${eur(T.cpl)}*`,
      `Calls bookés : *${nb(T.booked)}* (${fl(d1("booked", "%"), "up", "%")}) · coût par call booké *${eur(T.cpc)}* (${fl(d1("cpc", "%"), "down", "%")})`,
      `Calls réalisés : *${nb(T.done)}* sur ${nb(T.planned)} prévus · taux de show *${pct(T.show)}* (${fl(d1("show", "pts"), "up", "pts")})`,
      `Ventes : *${nb(T.sales)}* · cash signé *${eur(T.signed)}* (${fl(d1("signed", "%"), "up", "%")}) · nouveaux clients *${nb(T.clients)}*`,
      `Cash collecté : *${eur(T.coll)}* · taux de collecte *${pct(T.taux)}* · reste à collecter *${eur(T.reste)}*`,
      ...alerts.map((a) => `${a.i} *${a.t}* — ${a.x}`),
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
    sources,
    trend,
    weeks,
    alerts,
    slack: { ...slack, texte: [slack.titre, ...slack.lignes].join("\n") },
    meta: {
      perimetre: "Closing R1 (vue par défaut du dashboard) · RDV au jour de prise, calls tenus au jour du RDV, ventes au jour de signature",
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
    const [lignes, paiements] = await Promise.all([lireLignesAcquisition(), lirePaiements(token)]);
    const bilan = construireBilan({ lignes, paiements, lundi });
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(bilan);
  } catch (erreur) {
    const message = String(erreur.message || erreur);
    return res.status(/invalide|hors limites/.test(message) ? 400 : 502).json({ erreur: message });
  }
}
