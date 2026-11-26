// Fonction serveur — bilan hebdomadaire DELIVERY (données du template bilans/delivery.html).
//
// GET /api/bilan-delivery?semaine=2026-S48
//   Sans paramètre : dernière semaine ISO complète (lundi → dimanche, heure de Paris).
//   Renvoie { semaine, data, slack, meta } où `data` est exactement la structure
//   `DATA` attendue par le template, et `slack` { titre, lignes } le résumé du message.
//
// Source principale : table PACKS d'Airtable (même table que le récap delivery de 9h,
// scénario Make 8722038). Champs lus par IDENTIFIANT (renommer une colonne ne casse rien).
// Source optionnelle : Notion "Projets Clients" (classement d'urgence), seulement si la
// variable NOTION_TOKEN est définie ET que la base est partagée avec l'intégration.
//
// Limites connues (voir aussi la réponse JSON, champ meta.limites) :
//  - PACKS n'a pas d'historique de statut. "Livré cette semaine" = statut Livré dont la
//    dernière modification du statut tombe dans la semaine (fiable tant qu'un pack livré
//    n'est pas re-modifié). Les "photos de l'instant" (packs en production, bloqués,
//    sans CP) n'ont pas de comparaison S-1 / 4 sem. : le template affiche "—".
//  - Délai de livraison = date de commande du pack → dernière modification du statut Livré.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_PACKS = "tblHsrMj5vUMPiY72";
// Base Notion "Projets Clients — Onboarding & Production" (même ID que le module 25 de Make 8722038).
const NOTION_DB = "d65bff4b-e350-4a42-8353-a2ebbaa10f1f";

const CHAMPS_PACKS = {
  fldqac1OGnHUhYGeR: "nom", // ID Packs, ex. PMA-2026-0027-BEJA-YASSINE-GEOLIFE COMPANY LLC-ADS-C1-P1
  fldwJ36YZ9dyzKkmM: "statut", // Statut (liste de choix)
  fld1wtVfKHkDgfQeJ: "dateCommande", // date de commande du pack
  fldVAQ6Z3eoUJGoPs: "cree", // date de création de la ligne (repli si dateCommande vide)
  fldaWBv2tH8VECdWk: "modifStatut", // dernière modification du statut
  fldmhPyFpCBRdMetU: "cp", // Chef de projet (choix multiples)
};

const SEUIL_BLOQUE_JOURS = 5;
const NB_SEMAINES = 5;
const JOURS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS_LONGS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// Pipeline affiché (ordre du modèle). `cle` = nom normalisé du statut.
const ETAPES = [
  { n: "À démarrer", icon: "⚪", hint: "à assigner et lancer", prochaine: "assigner un chef de projet et lancer le pack" },
  { n: "Formulaire envoyé", icon: "⏳", hint: "attente client", prochaine: "relancer le client pour son onboarding" },
  { n: "Formulaire reçu", icon: "📥", hint: "kick-off à planifier", prochaine: "planifier le kick-off" },
  { n: "Kick-off planifié", icon: "📅", hint: "call de kick-off à venir", prochaine: "tenir le call de kick-off" },
  { n: "Kick-off réalisé", icon: "🤝", hint: "angles validés, scripts en cours", prochaine: "finaliser les scripts et le brief créatif" },
  { n: "Brief créatif réalisé", icon: "🧠", hint: "prêt pour le tournage", prochaine: "planifier le tournage" },
  { n: "Tournage réalisé", icon: "🎬", hint: "images tournées", prochaine: "lancer le montage" },
  { n: "Post production", icon: "✂️", hint: "montage en cours", prochaine: "finaliser le montage et envoyer en validation" },
  { n: "Validation", icon: "🔍", hint: "retour client", prochaine: "relancer le client pour sa validation" },
  { n: "Livré", icon: "📦", hint: "terminé", done: true },
];

// Statuts Airtable (y compris les anciens) → étape du pipeline. "Annule" est exclu du bilan.
const STATUT_VERS_ETAPE = {
  "a demarrer": "À démarrer",
  "formulaire envoye": "Formulaire envoyé",
  "brief en attente": "Formulaire envoyé",
  "formulaire recu": "Formulaire reçu",
  "kick-off planifie": "Kick-off planifié",
  "kick-off realise": "Kick-off réalisé",
  "brief creatif realise": "Brief créatif réalisé",
  "en tournage": "Brief créatif réalisé",
  "tournage realise": "Tournage réalisé",
  "post production": "Post production",
  "en montage": "Post production",
  "validation": "Validation",
  "livre": "Livré",
};

function sansAccent(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function etapeDe(statut) {
  if (sansAccent(statut) === "annule") return null;
  return STATUT_VERS_ETAPE[sansAccent(statut)] || null;
}

// ---------- Dates (tout est calculé sur des jours calendaires, fuseau Paris) ----------

const FMT_PARIS = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

function jourParis(brut) {
  if (!brut) return null;
  const s = String(brut);
  if (s.length <= 10) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return FMT_PARIS.format(d);
}

const versUtc = (jour) => {
  const [a, m, j] = jour.split("-").map(Number);
  return Date.UTC(a, m - 1, j);
};
const depuisUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const ajouterJours = (jour, n) => depuisUtc(versUtc(jour) + n * 86400000);
const ecartJours = (a, b) => Math.round((versUtc(a) - versUtc(b)) / 86400000);

// Lundi de la semaine contenant `jour`.
function lundiDe(jour) {
  const dow = new Date(versUtc(jour)).getUTCDay(); // 0 = dimanche
  return ajouterJours(jour, -((dow + 6) % 7));
}

// Numéro de semaine ISO + année ISO pour un lundi donné.
function semaineIso(lundi) {
  const jeudi = ajouterJours(lundi, 3);
  const annee = Number(jeudi.slice(0, 4));
  const premierJeudi = lundiDe(`${annee}-01-04`);
  return { annee, num: Math.round(ecartJours(lundi, premierJeudi) / 7) + 1 };
}

function lundiDeSemaineIso(annee, num) {
  return ajouterJours(lundiDe(`${annee}-01-04`), (num - 1) * 7);
}

const dansSemaine = (jour, lundi) => !!jour && jour >= lundi && jour <= ajouterJours(lundi, 6);

function formatJourLong(jour) {
  const d = new Date(versUtc(jour));
  return `${d.getUTCDate()} ${MOIS[d.getUTCMonth()]}`;
}

function libelleSemaine(lundi) {
  const dim = ajouterJours(lundi, 6);
  const dl = new Date(versUtc(lundi));
  const dd = new Date(versUtc(dim));
  const debut = dl.getUTCMonth() === dd.getUTCMonth() ? `${dl.getUTCDate()}` : formatJourLong(lundi);
  return `du lundi ${debut} au dimanche ${dd.getUTCDate()} ${MOIS[dd.getUTCMonth()]} ${dd.getUTCFullYear()}`;
}

function genereLe(maintenant) {
  const jour = FMT_PARIS.format(maintenant);
  const d = new Date(versUtc(jour));
  const heure = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" }).format(maintenant).replace(":", "h");
  return `${JOURS_LONGS[d.getUTCDay()]} ${d.getUTCDate()} ${MOIS[d.getUTCMonth()]} · ${heure}`;
}

// ---------- Lecture Airtable ----------

async function lirePacks(token) {
  const lignes = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_PACKS}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(CHAMPS_PACKS).forEach((id) => url.searchParams.append("fields[]", id));
    if (offset) url.searchParams.set("offset", offset);
    const reponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!reponse.ok) throw new Error(`Airtable a répondu ${reponse.status} : ${await reponse.text()}`);
    const donnees = await reponse.json();
    for (const enr of donnees.records) {
      const l = { _id: enr.id, createdTime: enr.createdTime };
      for (const [id, nom] of Object.entries(CHAMPS_PACKS)) l[nom] = enr.fields[id];
      lignes.push(l);
    }
    offset = donnees.offset;
  } while (offset);
  return lignes;
}

// "PMA-2026-0027-BEJA-YASSINE-GEOLIFE COMPANY LLC-ADS-C1-P1" → client "0027 BEJA · GEOLIFE COMPANY LLC-ADS", pack "C1 · Pack 1".
function decoderNom(nom) {
  const s = String(nom || "");
  const p = s.split("-");
  const mPack = s.match(/-(C\d+)-P(\d+)$/);
  const pack = mPack ? `${mPack[1]} · Pack ${mPack[2]}` : "—";
  if (p.length < 6 || !mPack) return { client: s || "—", pack };
  const corps = p.slice(2, p.length - 2); // sans PMA, année, Cn, Pn
  const [num, nomFamille, , ...societe] = corps;
  return { client: `${num} ${nomFamille}${societe.length ? " · " + societe.join("-") : ""}`, pack };
}

function normaliser(brut, maintenant) {
  const aujourdhui = FMT_PARIS.format(maintenant);
  const out = [];
  for (const r of brut) {
    const etape = etapeDe(r.statut);
    if (!etape) continue; // Annulé ou statut inconnu
    const commande = jourParis(r.dateCommande) || jourParis(r.cree || r.createdTime);
    const modif = jourParis(r.modifStatut) || commande;
    const cp = Array.isArray(r.cp) ? r.cp.filter(Boolean) : r.cp ? [String(r.cp)] : [];
    const livre = etape === "Livré";
    out.push({
      etape,
      livre,
      commande,
      modif,
      cp,
      ...decoderNom(r.nom),
      // jours sans changement de statut (packs livrés : sans objet)
      age: livre || !modif ? null : Math.max(0, ecartJours(aujourdhui, modif)),
    });
  }
  return out;
}

// ---------- Notion (optionnel) ----------

const ORDRE_URGENCE = ["Critique", "Urgent", "Modéré", "Faible", "Non planifié"];

async function lireUrgenceNotion() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return { disponible: false, raison: "NOTION_TOKEN absent" };
  const compte = [0, 0, 0, 0, 0];
  let curseur;
  try {
    do {
      const reponse = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({
          page_size: 100,
          filter: { property: "Statut", select: { does_not_equal: "Livré" } },
          ...(curseur ? { start_cursor: curseur } : {}),
        }),
      });
      if (!reponse.ok) throw new Error(`Notion a répondu ${reponse.status}`);
      const j = await reponse.json();
      for (const page of j.results || []) {
        const u = (page.properties?.["Urgence"]?.formula?.string) || "";
        const i = ORDRE_URGENCE.findIndex((k) => u.includes(k));
        if (i >= 0) compte[i] += 1;
      }
      curseur = j.has_more ? j.next_cursor : null;
    } while (curseur);
    return { disponible: true, retard: compte[0], urgents: compte[1], moderes: compte[2], faibles: compte[3], nonPlanifies: compte[4] };
  } catch (e) {
    return { disponible: false, raison: String(e.message || e) };
  }
}

// ---------- Calculs ----------

const moyenne = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : 0);
const arrondi = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const virgule = (v) => String(v).replace(".", ",");
const pluriel = (n, un, plusieurs) => (n > 1 ? plusieurs : un);

function fluxSemaine(packs, lundi) {
  const creesPacks = packs.filter((p) => dansSemaine(p.commande, lundi));
  const livres = packs.filter((p) => p.livre && dansSemaine(p.modif, lundi));
  const delais = livres.map((p) => (p.commande && p.modif ? Math.max(0, ecartJours(p.modif, p.commande)) : null)).filter((v) => v != null);
  const dans14 = delais.filter((d) => d <= 14).length;
  return {
    crees: creesPacks.length,
    livres: livres.length,
    delai: delais.length ? moyenne(delais) : null,
    dans14: delais.length ? (dans14 / delais.length) * 100 : null,
  };
}

function kpiFlux(l, v, serie, cle, { better, t = "abs", fmt = (x) => String(x), hero, icon }) {
  const courant = serie[serie.length - 1];
  const prec = serie[serie.length - 2];
  const base4 = serie.slice(0, -1).filter((x) => x != null);
  const d1 = courant != null && prec != null ? arrondi(courant - prec, 1) : null;
  const d4 = courant != null && base4.length ? arrondi(courant - moyenne(base4), 1) : null;
  const k = { l, v: v != null ? fmt(v) : "—", d1, d4, better, t, sp: serie.every((x) => x != null) ? serie.map((x) => arrondi(x, 1)) : null };
  if (hero) k.hero = true;
  if (icon) k.icon = icon;
  return k;
}

function construire(packs, lundi, maintenant, urgence) {
  const iso = semaineIso(lundi);
  const lundis = Array.from({ length: NB_SEMAINES }, (_, i) => ajouterJours(lundi, -7 * (NB_SEMAINES - 1 - i)));
  const flux = lundis.map((l) => fluxSemaine(packs, l));
  const cur = flux[flux.length - 1];
  const prec = flux[flux.length - 2];

  const actifs = packs.filter((p) => !p.livre);
  const enProd = actifs.filter((p) => p.etape !== "À démarrer");
  const aDemarrer = actifs.filter((p) => p.etape === "À démarrer");
  const bloques = actifs.filter((p) => p.age != null && p.age >= SEUIL_BLOQUE_JOURS);
  const sansCp = actifs.filter((p) => p.cp.length === 0);
  const ageMoyen = actifs.length ? moyenne(actifs.map((p) => p.age || 0)) : 0;

  const jours = Array.from({ length: 7 }, (_, i) => ajouterJours(lundi, i));
  const daily = {
    created: jours.map((j) => packs.filter((p) => p.commande === j).length),
    delivered: jours.map((j) => packs.filter((p) => p.livre && p.modif === j).length),
  };

  const stages = ETAPES.map((e) => {
    const membres = packs.filter((p) => p.etape === e.n);
    return {
      n: e.n,
      icon: e.icon,
      count: membres.length,
      age: e.done || !membres.length ? null : arrondi(moyenne(membres.map((p) => p.age || 0)), 1),
      blocked: membres.filter((p) => p.age != null && p.age >= SEUIL_BLOQUE_JOURS).length,
      hint: e.hint,
      ...(e.done ? { done: true } : {}),
    };
  });

  // Charge par chef de projet (packs actifs). Un pack à plusieurs CP compte pour chacun.
  const parCp = new Map();
  for (const p of actifs) {
    for (const nom of p.cp.length ? p.cp : ["Sans CP"]) {
      const c = parCp.get(nom) || { n: nom, packs: 0, blocked: 0 };
      c.packs += 1;
      if (p.age != null && p.age >= SEUIL_BLOQUE_JOURS) c.blocked += 1;
      parCp.set(nom, c);
    }
  }
  const cps = [...parCp.values()].sort((a, b) => (a.n === "Sans CP") - (b.n === "Sans CP") || b.packs - a.packs || a.n.localeCompare(b.n));

  const prochaine = Object.fromEntries(ETAPES.map((e) => [e.n, e.prochaine]));
  const listeBloques = [...bloques]
    .sort((a, b) => b.age - a.age)
    .slice(0, 10)
    .map((p) => ({
      client: p.client,
      pack: p.pack,
      stage: p.etape,
      days: p.age,
      cp: p.cp.length ? p.cp.join(", ") : "aucun",
      next: p.cp.length ? prochaine[p.etape] : "assigner un chef de projet",
    }));

  const serie = (cle) => flux.map((f) => f[cle]);
  const fmtJ = (v) => `${virgule(arrondi(v, 1))} j`;

  const groups = [
    {
      title: "Flux de la semaine",
      icon: "🚚",
      color: "#9B6BFF",
      items: [
        kpiFlux("Nouveaux packs", cur.crees, serie("crees"), "crees", { better: "up" }),
        kpiFlux("Packs livrés", cur.livres, serie("livres"), "livres", { better: "up", hero: true, icon: "📦" }),
        kpiFlux("Délai moyen de livraison", cur.delai, serie("delai"), "delai", { better: "down", fmt: fmtJ }),
      ],
    },
    {
      title: "Production en cours",
      icon: "🎬",
      color: "#E619B0",
      items: [
        { l: "Packs en production", v: String(enProd.length), d1: null, d4: null, better: "up", t: "abs", sp: null },
        { l: "À démarrer", v: String(aDemarrer.length), d1: null, d4: null, better: "down", t: "abs", sp: null },
        { l: "Sans chef de projet", v: String(sansCp.length), d1: null, d4: null, better: "down", t: "abs", sp: null },
      ],
    },
    {
      title: "Risques",
      icon: "🚨",
      color: "#FF5C7A",
      items: [
        { l: `Bloqués ${SEUIL_BLOQUE_JOURS} j ou plus`, v: String(bloques.length), d1: null, d4: null, better: "down", t: "abs", sp: null, hero: true, icon: "⏳" },
        { l: "Ancienneté moyenne du statut", v: fmtJ(ageMoyen), d1: null, d4: null, better: "down", t: "abs", sp: null },
        {
          ...kpiFlux("Part de packs livrés dans les 14 j", cur.dans14, serie("dans14"), "dans14", { better: "up", t: "pts", fmt: (x) => `${Math.round(x)} %` }),
          ring: cur.dans14 != null ? Math.round(cur.dans14) : 0,
          sp: null,
        },
      ],
    },
  ];

  // Libellés de variation pour les 3 pastilles du haut.
  const diff = (a, b) => (a - b > 0 ? `+${a - b}` : a - b < 0 ? `−${b - a}` : "=");
  const headline = [
    { l: "Packs en production", v: String(enProd.length), c: `${aDemarrer.length} à démarrer en plus`, good: true },
    { l: "Packs livrés cette semaine", v: String(cur.livres), c: `${diff(cur.livres, prec.livres)} vs S-1`, good: cur.livres >= prec.livres },
    { l: `Bloqués depuis ${SEUIL_BLOQUE_JOURS} j ou plus`, v: String(bloques.length), c: sansCp.length ? `${sansCp.length} sans CP` : "tous avec un CP", good: bloques.length === 0 },
  ];

  const insights = [];
  if (cur.livres > 0 || cur.crees > 0) {
    const delaiTxt = cur.delai != null ? ` Le délai moyen de livraison est de <b>${fmtJ(cur.delai)}</b>.` : "";
    insights.push({
      type: cur.livres >= prec.livres ? "good" : "warn",
      title: cur.livres >= prec.livres ? "Ce qui marche" : "Rythme de livraison",
      text: `<b>${cur.livres} ${pluriel(cur.livres, "pack livré", "packs livrés")}</b> cette semaine, contre ${prec.livres} la semaine précédente, pour <b>${cur.crees} ${pluriel(cur.crees, "nouveau pack", "nouveaux packs")}</b>.${delaiTxt}`,
    });
  } else {
    insights.push({ type: "warn", title: "Rythme de livraison", text: "Aucun pack créé ni livré cette semaine." });
  }
  const attenteClient = actifs.filter((p) => p.etape === "Formulaire envoyé" || p.etape === "Validation");
  insights.push({
    type: "warn",
    title: "À surveiller",
    text: attenteClient.length
      ? `<b>${attenteClient.length} ${pluriel(attenteClient.length, "pack attend", "packs attendent")}</b> un retour client (formulaire d'onboarding ou validation).`
      : "Aucun pack n'attend de retour client.",
  });
  insights.push({
    type: bloques.length ? "bad" : "good",
    title: bloques.length ? "Point faible" : "Aucun blocage",
    text: bloques.length
      ? `<b>${bloques.length} ${pluriel(bloques.length, "pack est bloqué", "packs sont bloqués")}</b> depuis ${SEUIL_BLOQUE_JOURS} jours ou plus${sansCp.length ? `, et <b>${sansCp.length}</b> ${pluriel(sansCp.length, "n'a", "n'ont")} pas de chef de projet` : ""}.`
      : `Aucun pack n'est resté ${SEUIL_BLOQUE_JOURS} jours ou plus sans changement de statut.`,
  });

  const alerts = [];
  if (bloques.length) {
    const max = Math.max(...bloques.map((p) => p.age));
    alerts.push({ c: bloques.length >= 3 ? "#FF5C7A" : "#F0B95A", i: bloques.length >= 3 ? "🚨" : "⚠️", t: `${bloques.length} ${pluriel(bloques.length, "pack bloqué", "packs bloqués")} depuis ${SEUIL_BLOQUE_JOURS} jours ou plus`, x: `Le plus ancien est sans mouvement depuis ${max} jours.` });
  }
  if (sansCp.length) alerts.push({ c: "#F0B95A", i: "⚠️", t: `${sansCp.length} ${pluriel(sansCp.length, "pack sans chef de projet", "packs sans chef de projet")}`, x: "Ils risquent de dépasser le délai de kick-off." });
  if (urgence && urgence.disponible && urgence.retard > 0) {
    alerts.push({ c: "#FF5C7A", i: "🚨", t: `${urgence.retard} ${pluriel(urgence.retard, "projet en retard", "projets en retard")} (urgence Notion)`, x: `${urgence.urgents} ${pluriel(urgence.urgents, "urgent", "urgents")} et ${urgence.moderes} ${pluriel(urgence.moderes, "modéré", "modérés")} derrière dans le classement.` });
  }
  const moyDelai = flux.slice(0, -1).map((f) => f.delai).filter((v) => v != null);
  if (cur.delai != null && moyDelai.length && cur.delai < moyenne(moyDelai)) {
    alerts.push({ c: "#6FD3A3", i: "✅", t: "Délai de livraison en amélioration", x: `${fmtJ(cur.delai)} contre ${fmtJ(moyenne(moyDelai))} en moyenne sur les semaines précédentes.` });
  }
  if (!alerts.length) alerts.push({ c: "#6FD3A3", i: "✅", t: "Rien à signaler", x: "Aucun seuil d'alerte n'est franchi cette semaine." });

  const trendPts = (cle) => flux.map((f) => (f[cle] == null ? 0 : arrondi(f[cle], 1)));
  const data = {
    sample: false,
    week: { num: iso.num, label: libelleSemaine(lundi), generated: genereLe(maintenant) },
    weeks: lundis.map((l) => `S${String(semaineIso(l).num).padStart(2, "0")}`),
    days: JOURS,
    headline,
    insights,
    groups,
    daily,
    stages,
    trend: [
      { t: "Packs livrés", pts: trendPts("livres"), better: "up", fmt: "int" },
      { t: "Nouveaux packs", pts: trendPts("crees"), better: "up", fmt: "int" },
      { t: "Délai moyen de livraison (j)", pts: trendPts("delai"), better: "down", fmt: "int" },
    ],
    cps,
    blocked: listeBloques,
    alerts,
  };

  const etiquette = `${iso.annee}-S${String(iso.num).padStart(2, "0")}`;
  const SEP = "━━━━━━━━━━━━━━━━━━━━━━";
  const DIV = "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈";
  const lignes = [
    SEP,
    "",
    `:package: *LIVRAISONS*`,
    `• :white_check_mark: Packs livrés : *${cur.livres}*  (S-1 : ${prec.livres})`,
    `• :new: Nouveaux packs : *${cur.crees}*  (S-1 : ${prec.crees})`,
  ];
  if (cur.delai != null) lignes.push(`• :stopwatch: Délai moyen de livraison : *${fmtJ(cur.delai)}*`);
  lignes.push(
    "",
    DIV,
    "",
    `:clapper: *PRODUCTION*`,
    `• :clapper: En production : *${enProd.length}*`,
    `• :white_circle: À démarrer : *${aDemarrer.length}*`,
    `• :bust_in_silhouette: Sans CP : *${sansCp.length}*`
  );
  if (urgence && urgence.disponible) {
    lignes.push(
      "",
      DIV,
      "",
      `:dart: *URGENCE NOTION*`,
      `• :large_purple_circle: En retard : *${urgence.retard}*`,
      `• :red_circle: Urgents : *${urgence.urgents}*`,
      `• :large_orange_circle: Modérés : *${urgence.moderes}*`
    );
  }
  lignes.push(
    "",
    DIV,
    "",
    bloques.length
      ? `:rotating_light: *${bloques.length}* ${pluriel(bloques.length, "pack bloqué", "packs bloqués")} depuis ${SEUIL_BLOQUE_JOURS} j ou plus (le plus ancien : *${Math.max(...bloques.map((p) => p.age))} j*)`
      : `:white_check_mark: Aucun pack bloqué depuis ${SEUIL_BLOQUE_JOURS} j ou plus`,
    "",
    SEP
  );

  return {
    semaine: etiquette,
    data,
    slack: { titre: `:bar_chart: *Bilan hebdo Delivery · ${etiquette}* (${libelleSemaine(lundi)})`, lignes },
    meta: {
      debut: lundi,
      fin: ajouterJours(lundi, 6),
      nbPacksLus: packs.length,
      urgenceNotion: urgence || { disponible: false, raison: "non demandée" },
      limites: [
        "Pas d'historique de statut dans PACKS : les packs en production, bloqués et sans CP sont une photo de l'instant (pas de comparaison S-1).",
        "Packs livrés / délai de livraison : daté sur la dernière modification du statut Livré.",
      ],
    },
  };
}

// ---------- Gestionnaire HTTP ----------

function lundiVise(parametre, maintenant) {
  if (parametre) {
    const m = String(parametre).match(/^(\d{4})-?S(\d{1,2})$/i);
    if (!m) throw Object.assign(new Error("Paramètre semaine invalide (attendu : 2026-S48)."), { code: 400 });
    const num = Number(m[2]);
    if (num < 1 || num > 53) throw Object.assign(new Error("Numéro de semaine invalide."), { code: 400 });
    return lundiDeSemaineIso(Number(m[1]), num);
  }
  // Par défaut : dernière semaine complète (celle qui précède la semaine en cours).
  return ajouterJours(lundiDe(FMT_PARIS.format(maintenant)), -7);
}

// Exportés pour les tests locaux (node -e), sans effet côté Vercel.
export const _interne = { construire, normaliser, lundiVise, semaineIso, lundiDeSemaineIso, decoderNom, etapeDe };

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return res.status(500).json({
      erreur: "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const maintenant = new Date();
    const lundi = lundiVise(req.query?.semaine, maintenant);
    const [brut, urgence] = await Promise.all([lirePacks(token), lireUrgenceNotion()]);
    const reponse = construire(normaliser(brut, maintenant), lundi, maintenant, urgence);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(reponse);
  } catch (erreur) {
    return res.status(erreur.code || 502).json({ erreur: String(erreur.message || erreur) });
  }
}
