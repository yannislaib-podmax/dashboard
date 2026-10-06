// Pilotage PodMax — section Acquisition.
// Les données sont chargées une seule fois, les quatre sous-vues les partagent.

const euros = (n) => {
  const v = n || 0;
  const decimales = Number.isInteger(v) ? 0 : 2;
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: decimales,
    maximumFractionDigits: decimales,
  }).format(v);
};

const pourcent = (v) => {
  if (v === null || v === undefined) return "—";
  const p = v * 100;
  const arrondi = Math.round(p * 10) / 10;
  return (Number.isInteger(arrondi) ? arrondi : arrondi.toFixed(1).replace(".", ",")) + " %";
};

const nombre = (n) => new Intl.NumberFormat("fr-FR").format(n || 0);

const jourCourt = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
};

const cellule = (v, f = nombre) => `<td${!v ? ' class="zero"' : ""}>${f(v)}</td>`;

const carte = (libelle, chiffre, note, ecart) => `
  <div class="glass carte rv">
    <div class="libelle">${libelle}</div>
    <div class="chiffre">${chiffre}</div>
    ${ecart ? `<div class="ecart ${ecart.classe}">${ecart.texte}</div>` : ""}
    ${note ? `<div class="note">${note}</div>` : ""}
  </div>`;

const somme = (lignes, champ) => lignes.reduce((s, l) => s + (l[champ] || 0), 0);

// Base de calcul du CA dans « Performance pub » (décision 2026-10-05) :
//  - "call"    : CA des ventes saisies dans iClosed au call (historique) ;
//  - "premier" : CA du 1er achat de chaque client acquis (contrats Airtable) ;
//  - "tous"    : CA encaissé sur tous les contrats de ces clients, à date.
let CA_MODE = "premier";
const CA_MODES = {
  call: { champ: "contracte", libelle: "CA contracté", note: "CA contracté des ventes rattachées au call, tel que saisi dans iClosed." },
  premier: { champ: "contracte1er", libelle: "CA du 1er achat", note: "Contracté du premier achat de chaque nouveau client (contrats Airtable). Mesure ce que coûte un nouveau client. Les ventes d'avant le formulaire Tally n'y figurent pas." },
  tous: { champ: "encaisseTous", libelle: "CA encaissé (tous contrats)", note: "Tout ce que les clients acquis ont payé depuis, à date (renouvellements compris). Mesure ce qu'un client rapporte. Les ventes d'avant le formulaire Tally n'y figurent pas." },
};
const caChamp = () => CA_MODES[CA_MODE].champ;
const caLibelle = () => CA_MODES[CA_MODE].libelle;

/* ------------------------------------------------------------------ */
/*  Infobulle partagée                                                 */
/* ------------------------------------------------------------------ */

const info = (html) => ` data-info="${html.replace(/"/g, "&quot;")}"`;

let INFOBULLE = null;

function brancherInfobulles(racine) {
  if (!INFOBULLE) {
    INFOBULLE = document.createElement("div");
    INFOBULLE.className = "infobulle";
    document.body.appendChild(INFOBULLE);
  }

  const placer = (evt) => {
    const marge = 16;
    const r = INFOBULLE.getBoundingClientRect();
    let gauche = evt.clientX + marge;
    let haut = evt.clientY - r.height - marge;
    if (gauche + r.width > window.innerWidth - 8) gauche = evt.clientX - r.width - marge;
    if (haut < 8) haut = evt.clientY + marge;
    INFOBULLE.style.left = gauche + "px";
    INFOBULLE.style.top = haut + "px";
  };

  racine.querySelectorAll("[data-info]").forEach((el) => {
    el.addEventListener("mouseenter", (evt) => {
      INFOBULLE.innerHTML = el.dataset.info;
      INFOBULLE.classList.add("on");
      placer(evt);
    });
    el.addEventListener("mousemove", placer);
    el.addEventListener("mouseleave", () => INFOBULLE.classList.remove("on"));
  });
}

/* ------------------------------------------------------------------ */
/*  Données, période, canal et produit                                 */
/* ------------------------------------------------------------------ */

let TOUTES = [];

// Pilotage quotidien — données de /api/pilotage-quotidien, séparées de TOUTES
// à dessein : jour de l'APPEL, pas jour de réservation (voir ce fichier API).
// Ne participe jamais aux filtres période/canal/produit de la vue cohorte.
let QUOT = [];

let DEBUT = null;
let FIN = null;

const JOUR_MS = 86400000;
const enIso = (d) => d.toISOString().slice(0, 10);
const enDate = (iso) => new Date(iso + "T12:00:00");
const AUJOURDHUI = enIso(new Date());

// Granularité des graphiques en bâtonnés (Dépense/CA et CA contracté/encaissé) :
// "semaine" = tranches glissantes de 7 jours (comportement historique),
// "mois" = un bâton par mois calendaire. Chaque graphique garde son état et
// ses dernières données pour pouvoir se redessiner seul au clic sur le toggle.
let GRANULARITE_CA = "semaine";
let GRANULARITE_DIRECTION = "semaine";
let GRANULARITE_QUOTIDIEN = "semaine";
let GRANULARITE_TRACKING = "semaine";
let DERNIERES_LIGNES_CA = [];
let DERNIERS_CONTRATS_DIRECTION = [];
let DERNIERS_PAIEMENTS_DIRECTION = [];
let DERNIERS_JOURS_QUOTIDIEN = [];

const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

// Graphique "Temporalité de l'acquisition" (sous les cartes de conversion) :
// regroupe Leads / RDV bookés / Ventes par jour de semaine, semaine du mois
// ou mois de l'année, toutes années confondues — pour repérer des créneaux
// structurellement plus ou moins performants (ex. pas de lead le week-end).
let GRANULARITE_TEMPO = "jour"; // "jour" (Lun-Dim) | "semaine" (S1-S4) | "mois" (Janv-Déc)
let DERNIERES_LIGNES_TEMPO = [];
const JOURS_SEMAINE_LONGS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const MOIS_LONGS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

// Découpe une plage de dates (triées, format ISO) en blocs {debut, fin} selon
// la granularité choisie. En semaine : tranches glissantes de 7 jours en
// remontant depuis la plus récente (comportement historique). En mois : un
// bloc par mois calendaire complet couvrant la plage.
function decoupagePeriodes(joursTries, granularite) {
  if (!joursTries.length) return [];
  const premier = joursTries[0];
  const dernier = joursTries[joursTries.length - 1];

  if (granularite === "mois") {
    const blocs = [];
    let curDebut = new Date(enDate(premier).getFullYear(), enDate(premier).getMonth(), 1, 12);
    const limite = enDate(dernier);
    for (let garde = 0; garde < 60; garde++) {
      const curFin = new Date(curDebut.getFullYear(), curDebut.getMonth() + 1, 0, 12);
      blocs.push({ debut: enIso(curDebut), fin: enIso(curFin) });
      if (curFin >= limite) break;
      curDebut = new Date(curDebut.getFullYear(), curDebut.getMonth() + 1, 1, 12);
    }
    return blocs;
  }

  const blocs = [];
  let fin = enDate(dernier);
  for (let garde = 0; garde < 60; garde++) {
    const debut = new Date(fin - 6 * JOUR_MS);
    blocs.unshift({ debut: enIso(debut), fin: enIso(fin) });
    if (enIso(debut) <= premier) break;
    fin = new Date(debut - JOUR_MS);
  }
  return blocs;
}

function libellePeriode(b, granularite) {
  const jourMois = (iso) => {
    const d = enDate(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  if (granularite === "mois") {
    const d = enDate(b.debut);
    return `${MOIS_COURTS[d.getMonth()]} ${d.getFullYear()}`;
  }
  return `${jourMois(b.debut)} – ${jourMois(b.fin)}`;
}

// Découpage étendu (jour/semaine/mois/année) pour la courbe Tracking — les
// graphiques en bâtonnés n'ont que semaine/mois, décline ici le même principe
// en délégant à decoupagePeriodes() pour ces deux-là.
function decoupagePeriodesEtendu(joursTries, granularite) {
  if (!joursTries.length) return [];

  if (granularite === "jour") return joursTries.map((j) => ({ debut: j, fin: j }));

  if (granularite === "annee") {
    const premier = joursTries[0];
    const dernier = joursTries[joursTries.length - 1];
    const blocs = [];
    for (let an = enDate(premier).getFullYear(); an <= enDate(dernier).getFullYear(); an++) {
      blocs.push({ debut: `${an}-01-01`, fin: `${an}-12-31` });
    }
    return blocs;
  }

  return decoupagePeriodes(joursTries, granularite); // "semaine" | "mois"
}

const JOUR_MOIS_COURT = (iso) => {
  const d = enDate(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

function libellePeriodeEtendu(b, granularite) {
  if (granularite === "jour") return JOUR_MOIS_COURT(b.debut);
  if (granularite === "annee") return String(enDate(b.debut).getFullYear());
  return libellePeriode(b, granularite); // "semaine" | "mois"
}

// Boutons "Semaine / Mois" injectés dans un graphique en bâtonnés.
function toggleGranulariteHtml(granulariteActuelle) {
  return `
    <div class="toggle-granularite">
      <button type="button" class="${granulariteActuelle === "semaine" ? "actif" : ""}" data-granularite="semaine">Semaine</button>
      <button type="button" class="${granulariteActuelle === "mois" ? "actif" : ""}" data-granularite="mois">Mois</button>
    </div>`;
}

function brancherToggleGranularite(cible, onChange) {
  cible.querySelectorAll(".toggle-granularite button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("actif")) return;
      onChange(btn.dataset.granularite);
    });
  });
}

const dansPeriode = (l) => {
  if (!DEBUT && !FIN) return true;
  if (!l.jour) return false;
  return (!DEBUT || l.jour >= DEBUT) && (!FIN || l.jour <= FIN);
};

let CANAL = "tout";
let PRODUIT = "tout";
let SOURCE = "tout";

// La table ACQUISITION (dépense/impressions/clics) n'a pas de champ Source
// propre : seul Canal y existe. Mais chaque valeur de Canal correspond sans
// ambiguïté à une Source (confirmé avec Yannis le 02/10) — on dérive donc
// Source depuis Canal au lieu de redemander une saisie manuelle chaque matin.
// Ça permet de filtrer dépense/impressions/clics par Source comme le reste.
const CANAL_VERS_SOURCE = {
  "Fb ads": "Ads",
  "Tiktok ads": "Ads",
  "Google ads": "Ads",
  Instagram: "Organique",
  TikTok: "Organique",
  YouTube: "Organique",
  Facebook: "Organique",
  LinkedIn: "Organique",
  "Site web": "Organique",
  "Setting Call": "Autre",
  "Setting dm": "Autre",
  Autre: "Autre",
};
const deriverSource = (canal) => CANAL_VERS_SOURCE[canal] || "Autre";

const parCanalEtProduit = (lignes) =>
  lignes.filter(
    (l) =>
      (CANAL === "tout" || l.canal === CANAL) &&
      (PRODUIT === "tout" || l.produit === PRODUIT) &&
      (SOURCE === "tout" || l.source === SOURCE)
  );

const lignesFiltrees = () => parCanalEtProduit(TOUTES.filter(dansPeriode));

let COMPARAISON = "precedente";

const BAISSE_EST_BONNE = new Set(["coutClient", "coutVente", "coutAppel", "coutRdv", "coutLead", "cpm", "cpc", "dirResiliations"]);
const SANS_JUGEMENT = new Set(["depense"]);

const SEUIL_STABLE_PCT = 5;
const SEUIL_STABLE_PTS = 2;

function plagePrecedente() {
  if (COMPARAISON === "aucune" || !DEBUT || !FIN) return null;

  let a, b;

  if (COMPARAISON === "annee") {
    const recule = (iso) => {
      const d = enDate(iso);
      d.setFullYear(d.getFullYear() - 1);
      return enIso(d);
    };
    a = recule(DEBUT);
    b = recule(FIN);
  } else {
    const duree = Math.round((enDate(FIN) - enDate(DEBUT)) / JOUR_MS) + 1;
    const finPrec = new Date(enDate(DEBUT) - JOUR_MS);
    a = enIso(new Date(finPrec - (duree - 1) * JOUR_MS));
    b = enIso(finPrec);
  }

  return [a, b];
}

function lignesPrecedentes() {
  const plage = plagePrecedente();
  if (!plage) return null;
  const [a, b] = plage;

  return parCanalEtProduit(TOUTES.filter((l) => l.jour && l.jour >= a && l.jour <= b));
}

function ecartDe(actuel, precedent, cle) {
  if (precedent === null || precedent === undefined || actuel === null) return null;
  if (precedent === 0) {
    return actuel > 0 ? { classe: "plat", texte: "rien d'équivalent avant" } : null;
  }

  const p = Math.round(((actuel - precedent) / precedent) * 100);

  if (Math.abs(p) <= SEUIL_STABLE_PCT) {
    return {
      classe: SANS_JUGEMENT.has(cle) ? "neutre" : "stable",
      texte: p === 0 ? "→ stable" : `→ ${Math.abs(p)} %`,
    };
  }

  const monte = p > 0;
  const classe = SANS_JUGEMENT.has(cle) ? "neutre" : (BAISSE_EST_BONNE.has(cle) ? !monte : monte) ? "bon" : "mauvais";

  return { classe, texte: `${monte ? "↑" : "↓"} ${Math.abs(p)} %` };
}

/* ------------------------------------------------------------------ */
/*  Indicateurs                                                        */
/* ------------------------------------------------------------------ */

const ratio = (a, b) => (b > 0 ? a / b : null);

const INDICATEURS = {
  depense: (l) => somme(l, "depense"),
  contracte: (l) => somme(l, caChamp()),
  roas: (l) => ratio(somme(l, caChamp()), somme(l, "depense")),
  clients: (l) => somme(l, "clients"),
  encaisse: (l) => somme(l, "encaisseTous"),
  roasTous: (l) => ratio(somme(l, "encaisseTous"), somme(l, "depense")),
  ltv: (l) => ratio(somme(l, "encaisseTous"), somme(l, "clients")),
  // LTV / coût d'acquisition : > 1 = chaque client rapporte plus qu'il n'a coûté.
  // Marge par client : ce qu'il a rapporté à date moins ce qu'il a coûté à acquérir.
  margeClient: (l) => {
    const n = somme(l, "clients");
    return n > 0 ? (somme(l, "encaisseTous") - somme(l, "depense")) / n : null;
  },
  // Combien de fois le 1er achat est dépassé par la valeur à date du client.
  multipleLtv: (l) => ratio(somme(l, "encaisseTous"), somme(l, "contracte1er")),
  ltvSurCout: (l) => ratio(ratio(somme(l, "encaisseTous"), somme(l, "clients")), ratio(somme(l, "depense"), somme(l, "clients"))),
  coutClient: (l) => ratio(somme(l, "depense"), somme(l, "clients")),
  coutVente: (l) => ratio(somme(l, "depense"), somme(l, "ventes")),
  coutAppel: (l) => ratio(somme(l, "depense"), somme(l, "honores")),
  // Coût par call booké : dépense rapportée aux RDV pris (call confirmé),
  // tous statuts confondus — avant même de savoir s'ils seront honorés.
  coutRdv: (l) => ratio(somme(l, "depense"), somme(l, "rendezVous")),
  coutLead: (l) => ratio(somme(l, "depense"), somme(l, "leads")),

  cpm: (l) => {
    const imp = somme(l, "impressions");
    return imp > 0 ? (somme(l, "depense") / imp) * 1000 : null;
  },
  cpc: (l) => ratio(somme(l, "depense"), somme(l, "clics")),
  ctr: (l) => ratio(somme(l, "clics"), somme(l, "impressions")),

  leads: (l) => somme(l, "leads"),
  rendezVous: (l) => somme(l, "rendezVous"),
  rendezVousConclus: (l) => somme(l, "rendezVousConclus"),
  honores: (l) => somme(l, "honores"),
  ventes: (l) => somme(l, "ventes"),
  annules: (l) => somme(l, "annules"),

  // Taux de présence : honorés rapportés aux rendez-vous CONCLUS (Honoré ou
  // No-show), pas à tous les rendez-vous pris. Un rendez-vous encore
  // "Confirmé" (pas encore passé) ne doit pas compter comme une absence :
  // le compter aurait fait chuter artificiellement le taux tant que la
  // période contient des RDV à venir.
  tauxPresence: (l) => ratio(somme(l, "honores"), somme(l, "rendezVousConclus")),

  // Taux de closing : ventes rapportées aux appels réellement honorés.
  tauxClosing: (l) => ratio(somme(l, "ventes"), somme(l, "honores")),

  // Taux d'annulation : annulés rapportés à TOUS les rendez-vous pris (pas
  // aux seuls rendez-vous conclus) — l'annulation se joue avant que le call
  // ait lieu, donc sa base est le total réservé, comme le taux de closing se
  // base sur les honorés et le taux de présence sur les conclus.
  tauxAnnulation: (l) => ratio(somme(l, "annules"), somme(l, "rendezVous")),
};

const SEUIL_FIABILITE = 10;

/* ------------------------------------------------------------------ */
/*  Conversion                                                         */
/* ------------------------------------------------------------------ */

const ETAPES = [
  { cle: "leads", nom: "Leads" },
  { cle: "rendezVous", nom: "Rendez-vous pris" },
  { cle: "rendezVousConclus", nom: "RDV conclus" },
  { cle: "honores", nom: "Rendez-vous honorés" },
  { cle: "ventes", nom: "Ventes" },
];

function vueConversion(lignes, precedentes) {
  const ecart = (cle) => {
    const f = INDICATEURS[cle];
    return precedentes ? ecartDe(f(lignes), f(precedentes), cle) : null;
  };

  const valeurs = ETAPES.map((e) => INDICATEURS[e.cle](lignes));
  const valeursPrec = precedentes ? ETAPES.map((e) => INDICATEURS[e.cle](precedentes)) : null;

  document.getElementById("conv").innerHTML = ETAPES.map((e, i) =>
    carte(e.nom, nombre(valeurs[i]), null, ecart(e.cle))
  ).join("");

  const presence = INDICATEURS.tauxPresence(lignes);
  const presencePrec = precedentes ? INDICATEURS.tauxPresence(precedentes) : null;
  const rdvConclus = somme(lignes, "rendezVousConclus");

  const closing = INDICATEURS.tauxClosing(lignes);
  const closingPrec = precedentes ? INDICATEURS.tauxClosing(precedentes) : null;
  const appels = somme(lignes, "honores");

  // Taux d'annulation sur R1 Closing uniquement : `lignes` vient toujours de
  // TOUTES (/api/acquisition), déjà recalculée en ne gardant que les calls
  // Closing de rang R1 — cf. commentaire en tête de ce fichier API.
  const annulation = INDICATEURS.tauxAnnulation(lignes);
  const annulationPrec = precedentes ? INDICATEURS.tauxAnnulation(precedentes) : null;
  const rdvPris = somme(lignes, "rendezVous");

  // Pour expliquer le taux "Rendez-vous pris -> RDV conclus" dans l'entonnoir :
  // ce qui n'est ni conclu ni annule est encore "a venir" (RDV futur, pas un souci).
  const annulesCount = somme(lignes, "annules");
  const aVenir = Math.max(0, rdvPris - rdvConclus - annulesCount);

  const fragile = (base) => (base > 0 && base < SEUIL_FIABILITE ? " · trop peu pour conclure" : "");

  const bloc = document.getElementById("qualite");
  if (bloc) {
    bloc.innerHTML =
      carte(
        "Taux d'annulation",
        pourcent(annulation),
        rdvPris === 0 ? "aucun rendez-vous pris sur la période" : `sur ${nombre(rdvPris)} rendez-vous pris (R1, closing)${fragile(rdvPris)}`,
        annulation !== null && annulationPrec !== null ? ecartPoints(annulation, annulationPrec, true) : null
      ) +
      carte(
        "Taux de présence",
        pourcent(presence),
        rdvConclus === 0 ? "aucun rendez-vous conclu sur la période" : `sur ${nombre(rdvConclus)} rendez-vous conclu${rdvConclus > 1 ? "s" : ""} (hors RDV encore à venir)${fragile(rdvConclus)}`,
        presence !== null && presencePrec !== null ? ecartPoints(presence, presencePrec) : null
      ) +
      carte(
        "Taux de closing",
        pourcent(closing),
        appels === 0 ? "aucun appel honoré sur la période" : `sur ${nombre(appels)} appel${appels > 1 ? "s" : ""} honoré${appels > 1 ? "s" : ""}${fragile(appels)}`,
        closing !== null && closingPrec !== null ? ecartPoints(closing, closingPrec) : null
      );
  }

  graphiqueTemporalite(lignes);

  // Base de chaque marche : la valeur de la marche précédente. Depuis l'ajout
  // du step "RDV conclus" (Honoré + No-show, hors RDV encore "Confirmé" à
  // venir) juste avant "Rendez-vous honorés", ce step précédent EST déjà la
  // bonne base pour "honorés" — plus besoin de cas particulier ici (c'était
  // nécessaire avant que "RDV conclus" n'existe comme marche à part entière).
  const bases = (jeu, vals) => ETAPES.map((e, i) => (i === 0 ? null : vals[i - 1]));

  entonnoir("entonnoir", ETAPES, valeurs, valeursPrec, bases(lignes, valeurs), valeursPrec ? bases(precedentes, valeursPrec) : null, {
    aVenir,
    annulesCount,
    annulationPct: annulation,
  });
  camembertsConversion(lignes);
}

// `baisseEstBonne` : par défaut une hausse est "bon" (présence, closing...).
// Pour un taux dont la baisse est souhaitable (annulation), passer true.
function ecartPoints(actuel, precedent, baisseEstBonne = false) {
  if (actuel === null || precedent === null) return null;

  const brut = (actuel - precedent) * 100;
  const pts = Math.abs(brut) < 10 ? Math.round(brut * 10) / 10 : Math.round(brut);

  const valeur = Math.abs(pts).toString().replace(".", ",");
  const unite = `pt${Math.abs(pts) >= 2 ? "s" : ""}`;

  if (Math.abs(pts) <= SEUIL_STABLE_PTS) {
    return { classe: "stable", texte: pts === 0 ? "→ stable" : `→ ${valeur} ${unite}` };
  }

  const monte = pts > 0;
  const classe = (baisseEstBonne ? !monte : monte) ? "bon" : "mauvais";

  return { classe, texte: `${monte ? "↑" : "↓"} ${valeur} ${unite}` };
}

const marqueur = (e) => (e ? ` <span class="ecart-inline ${e.classe}">${e.texte}</span>` : "");

function entonnoir(cibleId, ETAPES, valeurs, valeursPrec, bases, basesPrec, extra = {}) {
  const cible = document.getElementById(cibleId);
  if (!cible) return;

  const base = valeurs[0];
  const max = Math.max(...valeurs);

  if (!max) {
    cible.innerHTML = `<div style="color:var(--txt3)">Pas encore de données sur cette période.</div>`;
    return;
  }

  const L = 1000, H = 300, MARGE = 62, CY = H / 2, DEMI_MAX = 116, PLANCHER = 6;
  const pas = (L - 2 * MARGE) / (ETAPES.length - 1);
  const x = (i) => MARGE + i * pas;
  const demi = (i) => Math.max(PLANCHER, (valeurs[i] / max) * DEMI_MAX);

  const bord = (signe) => {
    let d = `M ${x(0)} ${CY + signe * demi(0)}`;
    for (let i = 1; i < ETAPES.length; i++) {
      const x0 = x(i - 1), x1 = x(i);
      const y0 = CY + signe * demi(i - 1), y1 = CY + signe * demi(i);
      d += ` C ${x0 + pas / 2} ${y0} ${x1 - pas / 2} ${y1} ${x1} ${y1}`;
    }
    return d;
  };

  const dernier = ETAPES.length - 1;

  let bas = "";
  for (let i = ETAPES.length - 1; i > 0; i--) {
    const x0 = x(i), x1 = x(i - 1);
    const y0 = CY + demi(i), y1 = CY + demi(i - 1);
    bas += ` C ${x0 - pas / 2} ${y0} ${x1 + pas / 2} ${y1} ${x1} ${y1}`;
  }
  const silhouette = bord(-1) + ` L ${x(dernier)} ${CY + demi(dernier)}` + bas + " Z";

  const etiquettes = ETAPES.map(
    (e, i) => `<div class="etq" style="left:${(x(i) / L) * 100}%">
      <span class="etq-nb">${nombre(valeurs[i])}</span>
      <span class="etq-nom">${e.nom}</span>
    </div>`
  ).join("");

  const zones = ETAPES.map((e, i) => {
    const partBase = base ? Math.round((valeurs[i] / base) * 100) : null;
    const versPrec =
      i > 0 && valeurs[i - 1]
        ? `<span>Depuis ${ETAPES[i - 1].nom.toLowerCase()}<b>${Math.round((valeurs[i] / valeurs[i - 1]) * 100)} %</b></span>`
        : "";
    const bulle = `<strong>${e.nom}</strong>
      <span>Volume<b>${nombre(valeurs[i])}</b></span>
      ${versPrec}
      ${partBase !== null && i > 0 ? `<span class="bulle-pied">Des leads<b>${partBase} %</b></span>` : ""}`;
    return `<div class="zone-etage" style="left:${((x(i) - pas / 2) / L) * 100}%;width:${(pas / L) * 100}%"${info(bulle)}></div>`;
  }).join("");

  const taux = ETAPES.slice(1)
    .map((e, k) => {
      const i = k + 1;
      const avant = bases[i];
      const milieu = ((x(i - 1) + x(i)) / 2 / L) * 100;

      if (!avant) {
        return `<div class="taux" style="left:${milieu}%"><span class="muet">—</span></div>`;
      }

      const t = Math.round((valeurs[i] / avant) * 100);
      const anomalie = t > 100;
      const avantP = basesPrec ? basesPrec[i] : null;
      const ecart = valeursPrec && avantP ? ecartPoints(valeurs[i] / avant, valeursPrec[i] / avantP) : null;

      const libelleBase = ETAPES[i - 1].nom.toLowerCase();

      // "Rendez-vous pris → RDV conclus" : ce taux mélange de base les RDV
      // encore "Confirmé" (pas encore passés, pas un souci) et les vrais
      // annulés (un souci). On l'affiche quand meme, mais avec le detail
      // (RDV a venir + taux d'annulation) pour que le pourcentage se
      // comprenne sans ambiguite, au lieu du "—" muet d'avant.
      if (e.cle === "rendezVousConclus") {
        const { aVenir = 0, annulesCount = 0, annulationPct = null } = extra;
        const bulle = `<strong>${ETAPES[i - 1].nom} → ${e.nom}</strong>
          <span>Taux<b>${t} %</b></span>
          <span>Base<b>${nombre(avant)} ${libelleBase}</b></span>
          <span>Conclus<b>${nombre(valeurs[i])}</b></span>
          <span class="bulle-pied">Dont ${nombre(aVenir)} encore à venir (pas un souci) et ${nombre(annulesCount)} annulés, soit un taux d'annulation de ${pourcent(annulationPct)}.</span>`;

        return `<div class="taux" style="left:${milieu}%"${info(bulle)}>
          <span class="t-valeur">${t} %</span>${marqueur(ecart)}
          <span class="t-base">dont ${nombre(aVenir)} à venir</span>
        </div>`;
      }

      const bulle = `<strong>${ETAPES[i - 1].nom} → ${e.nom}</strong>
        <span>Taux<b>${t} %</b></span>
        <span>Base<b>${nombre(avant)} ${libelleBase}</b></span>
        <span>Arrivés<b>${nombre(valeurs[i])}</b></span>`;

      return `<div class="taux${anomalie ? " anomalie" : ""}" style="left:${milieu}%"${info(bulle)}>
        <span class="t-valeur">${t} %</span>${marqueur(ecart)}
        ${anomalie ? '<span class="t-note">étage plus large que le précédent</span>' : ""}
      </div>`;
    })
    .join("");

  // ID de dégradé unique par cible : plusieurs entonnoirs sur la même page
  // (Performance + Sales Team Closing + Setting) avec le même id de gradient
  // entrent en collision — le navigateur ne résout alors qu'un seul des deux
  // <linearGradient>, et les autres entonnoirs se retrouvent avec un
  // remplissage transparent (silhouette vide à l'intérieur).
  const idDegrade = `degrade-entonnoir-${cibleId}`;

  const morceaux = [
    `<div class="entonnoir-fig">
      <div class="etiquettes">${etiquettes}</div>
      <svg class="entonnoir-svg" viewBox="0 0 ${L} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${idDegrade}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="rgba(201,166,255,.42)"></stop>
            <stop offset="55%" stop-color="rgba(201,166,255,.24)"></stop>
            <stop offset="100%" stop-color="rgba(230,25,176,.34)"></stop>
          </linearGradient>
        </defs>
        <path d="${silhouette}" fill="url(#${idDegrade})"
          stroke="rgba(201,166,255,.42)" stroke-width="1.5"
          vector-effect="non-scaling-stroke"></path>
      </svg>
      <div class="zones">${zones}</div>
      <div class="taux-rangee">${taux}</div>
    </div>`,
  ];

  const ventes = valeurs[valeurs.length - 1];
  const baseP = valeursPrec ? valeursPrec[0] : null;
  const ecartGlobal =
    valeursPrec && baseP && base ? ecartPoints(ventes / base, valeursPrec[valeursPrec.length - 1] / baseP) : null;

  const global = base
    ? `<strong>${((ventes / base) * 100).toFixed(1).replace(".", ",")} %</strong>
       des leads aboutissent à une vente${marqueur(ecartGlobal)}`
    : `Chaîne complète incalculable : aucun lead sur la période.`;

  cible.innerHTML = morceaux.join("") + `<div class="entonnoir-global">${global}</div>`;
  brancherInfobulles(cible);
}

/* ------------------------------------------------------------------ */
/*  Dépense et chiffre d'affaires, par tranche de 7 jours              */
/* ------------------------------------------------------------------ */

function tranches7(lignes, granularite) {
  const jours = lignes.map((l) => l.jour).filter(Boolean).sort();
  if (!jours.length) return [];

  const blocs = decoupagePeriodes(jours, granularite);

  return blocs
    .map((b) => {
      const dedans = lignes.filter((l) => l.jour >= b.debut && l.jour <= b.fin);
      const premier = somme(dedans, "contracte1er");
      const encaisse = somme(dedans, "encaisseTous");
      // Renouvellements = ce que ces clients ont payé en plus de leur 1er achat.
      return { ...b, depense: somme(dedans, "depense"), contracte: premier, renouv: Math.max(0, encaisse - premier), total: Math.max(premier, encaisse) };
    })
    // On n'affiche une tranche que si elle a une dépense ou un CA à montrer :
    // des colonnes vides à hauteur minimale poussaient le graphique hors de
    // son cadre quand la période couvrait beaucoup de semaines/mois inactifs.
    .filter((b) => b.depense > 0 || b.total > 0);
}

function graphiqueCa(lignes) {
  DERNIERES_LIGNES_CA = lignes;

  const cible = document.getElementById("graph-ca");
  if (!cible) return;

  const granularite = GRANULARITE_CA;
  const blocs = tranches7(lignes, granularite);
  const toggle = toggleGranulariteHtml(granularite);

  if (!blocs.length) {
    cible.innerHTML = toggle + `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    brancherToggleGranularite(cible, (g) => {
      GRANULARITE_CA = g;
      graphiqueCa(DERNIERES_LIGNES_CA);
    });
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.depense, b.total]));
  const h = (v) => Math.round((v / max) * 100);

  const legende = `
    <div class="legende-graph">
      <span><i class="b-depense"></i>Dépense pub</span>
      <span><i class="b-contracte"></i>1er achat des clients acquis</span>
      <span><i class="b-renouv"></i>Renouvellements (LTV à date)</span>
    </div>
    <p class="note-graph">Chaque période montre ce que les clients <em>acquis cette période</em> ont payé à date : les périodes récentes sont plus basses, les clients n'ont pas encore renouvelé.</p>`;

  const colonnes = blocs
    .map((b) => {
      const roas1 = b.depense > 0 ? (b.contracte / b.depense).toFixed(2).replace(".", ",") + " ×" : "—";
      const roasT = b.depense > 0 ? (b.total / b.depense).toFixed(2).replace(".", ",") + " ×" : "—";
      const libelle = libellePeriode(b, granularite);
      const bulle = `<strong>${libelle}</strong>
        <span><i class="p-depense"></i>Dépense pub<b>${euros(b.depense)}</b></span>
        <span><i class="p-contracte"></i>1er achat<b>${euros(b.contracte)}</b></span>
        <span><i class="p-renouv"></i>Renouvellements<b>${euros(b.renouv)}</b></span>
        <span class="bulle-pied">ROAS 1er achat<b>${roas1}</b></span>
        <span class="bulle-pied">ROAS tous contrats<b>${roasT}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="valeur">${roasT}</div>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-depense" data-hauteur="${h(b.depense)}"></div>
            <div class="barre pile" data-hauteur="${h(b.total)}">
              <div class="b-renouv" style="flex:${b.renouv}"></div>
              <div class="b-contracte" style="flex:${b.contracte}"></div>
            </div>
          </div>
        </div>
        <div class="jour">${libelle}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = toggle + legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);
  brancherToggleGranularite(cible, (g) => {
    GRANULARITE_CA = g;
    graphiqueCa(DERNIERES_LIGNES_CA);
  });

  requestAnimationFrame(() =>
    setTimeout(() => {
      cible.querySelectorAll(".barre").forEach((b) => {
        b.style.height = b.dataset.hauteur + "%";
      });
    }, 120)
  );
}

/* ------------------------------------------------------------------ */
/*  Temporalité de l'acquisition (jour de semaine / semaine du mois /   */
/*  mois de l'année) — repérer les créneaux les plus performants.      */
/* ------------------------------------------------------------------ */

// Regroupe les lignes filtrées (toutes années confondues) dans les buckets
// du mode choisi. Les buckets vides restent dans le résultat (contrairement
// à tranches7) : un bâton à zéro, par exemple le dimanche, EST l'information
// recherchée — il ne faut pas le faire disparaître.
function bucketsTemporalite(lignes, mode) {
  const ordre = mode === "jour" ? JOURS_SEMAINE_LONGS : mode === "semaine" ? ["Semaine 1", "Semaine 2", "Semaine 3", "Semaine 4"] : MOIS_LONGS;

  const parBucket = {};
  ordre.forEach((cle) => (parBucket[cle] = { cle, leads: 0, rendezVous: 0, ventes: 0 }));

  lignes.forEach((l) => {
    if (!l.jour) return;
    const d = enDate(l.jour);
    let cle;
    if (mode === "jour") {
      cle = JOURS_SEMAINE_LONGS[(d.getDay() + 6) % 7]; // getDay() : 0=dimanche -> on remet Lundi en premier
    } else if (mode === "semaine") {
      cle = `Semaine ${Math.min(4, Math.ceil(d.getDate() / 7))}`; // jours 29-31 rattachés à la semaine 4
    } else {
      cle = MOIS_LONGS[d.getMonth()];
    }
    const b = parBucket[cle];
    if (!b) return;
    b.leads += l.leads || 0;
    b.rendezVous += l.rendezVous || 0;
    b.ventes += l.ventes || 0;
  });

  return ordre.map((cle) => parBucket[cle]);
}

function toggleTemporaliteHtml(modeActuel) {
  return `
    <div class="toggle-granularite">
      <button type="button" class="${modeActuel === "jour" ? "actif" : ""}" data-mode-tempo="jour">Jour de la semaine</button>
      <button type="button" class="${modeActuel === "semaine" ? "actif" : ""}" data-mode-tempo="semaine">Semaine du mois</button>
      <button type="button" class="${modeActuel === "mois" ? "actif" : ""}" data-mode-tempo="mois">Mois de l'année</button>
    </div>`;
}

function brancherToggleTemporalite(cible, onChange) {
  cible.querySelectorAll("[data-mode-tempo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("actif")) return;
      onChange(btn.dataset.modeTempo);
    });
  });
}

function graphiqueTemporalite(lignes) {
  DERNIERES_LIGNES_TEMPO = lignes;

  const cible = document.getElementById("graph-temporalite");
  if (!cible) return;

  const mode = GRANULARITE_TEMPO;
  const blocs = bucketsTemporalite(lignes, mode);
  const toggle = toggleTemporaliteHtml(mode);
  const rebrancher = () =>
    brancherToggleTemporalite(cible, (m) => {
      GRANULARITE_TEMPO = m;
      graphiqueTemporalite(DERNIERES_LIGNES_TEMPO);
    });

  const aucuneActivite = !blocs.some((b) => b.leads || b.rendezVous || b.ventes);
  if (aucuneActivite) {
    cible.innerHTML = toggle + `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    rebrancher();
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.leads, b.rendezVous, b.ventes]));
  const h = (v) => Math.round((v / max) * 100);

  const legende = `
    <div class="legende-graph">
      <span><i class="b-temp-leads"></i>Leads</span>
      <span><i class="b-temp-rdv"></i>RDV bookés</span>
      <span><i class="b-temp-ventes"></i>Ventes</span>
    </div>`;

  const colonnes = blocs
    .map((b) => {
      const bulle = `<strong>${b.cle}</strong>
        <span><i class="p-temp-leads"></i>Leads<b>${nombre(b.leads)}</b></span>
        <span><i class="p-temp-rdv"></i>RDV bookés<b>${nombre(b.rendezVous)}</b></span>
        <span><i class="p-temp-ventes"></i>Ventes<b>${nombre(b.ventes)}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-temp-leads"  data-hauteur="${h(b.leads)}"></div>
            <div class="barre b-temp-rdv"    data-hauteur="${h(b.rendezVous)}"></div>
            <div class="barre b-temp-ventes" data-hauteur="${h(b.ventes)}"></div>
          </div>
        </div>
        <div class="jour">${b.cle}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = toggle + legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);
  rebrancher();

  requestAnimationFrame(() =>
    setTimeout(() => {
      cible.querySelectorAll(".barre").forEach((b) => {
        b.style.height = b.dataset.hauteur + "%";
      });
    }, 120)
  );
}

/* ------------------------------------------------------------------ */
/*  Répartition par canal                                              */
/* ------------------------------------------------------------------ */

const PALETTE = ["#C9A6FF", "#E619B0", "#6FD3A3", "#F0B95A", "#7FE3E3", "#F08585", "#9B6BFF"];
let COULEUR_CANAL = {};

function fixerCouleurs() {
  const canaux = [...new Set(TOUTES.map((l) => l.canal).filter(Boolean))].sort();
  COULEUR_CANAL = Object.fromEntries(canaux.map((c, i) => [c, PALETTE[i % PALETTE.length]]));
}

function camembert(titre, lignes, champ, format) {
  const parTotal = {};
  lignes.forEach((l) => {
    const c = l.canal || "Inconnu";
    parTotal[c] = (parTotal[c] || 0) + (l[champ] || 0);
  });

  const parts = Object.entries(parTotal)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([nom, valeur]) => [nom, valeur, COULEUR_CANAL[nom] || "#8895A7"]);

  return disque(titre, parts, format);
}

function disque(titre, parts, format) {
  const total = parts.reduce((s, [, v]) => s + v, 0);

  if (!total) {
    return `<div class="glass camembert rv">
      <h3>${titre}</h3>
      <div class="vide">Rien à répartir sur cette période.</div>
    </div>`;
  }

  const bulle = ([nom, valeur, , second]) =>
    `<strong>${nom}</strong>
     <span>Volume<b>${format(valeur)}</b></span>
     <span>Part du total<b>${Math.round((valeur / total) * 100)} %</b></span>
     ${second ? `<span class="bulle-pied">${second}</span>` : ""}`;

  // Au-delà de 10 valeurs (courant sur une dimension UTM à forte cardinalité
  // comme Content ou Campagne) : la légende ET l'anneau lui-même devenaient
  // illisibles (plein de tranches fines indiscernables). On plafonne les deux
  // — l'anneau agrège le surplus dans une tranche "Autres", la légende le
  // garde en détail derrière un "voir plus".
  const LIMITE_LEGENDE = 10;
  const visiblesParts = parts.slice(0, LIMITE_LEGENDE);
  const masquees = parts.slice(LIMITE_LEGENDE);
  const sommeAutres = masquees.reduce((s, p) => s + p[1], 0);
  const partsArc = masquees.length
    ? [...visiblesParts, [`Autres (${masquees.length} valeurs)`, sommeAutres, "#8895A7", null]]
    : visiblesParts;
  const iAutres = LIMITE_LEGENDE; // index de la tranche "Autres" dans partsArc/arcs

  let cumul = 0;
  const arcs = partsArc
    .map((p, i) => {
      const pct = (p[1] / total) * 100;
      const arc = `<circle class="part" data-i="${i}"${info(bulle(p))} cx="21" cy="21" r="15.915" fill="none"
        stroke="${p[2]}" stroke-width="6.5"
        stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}"
        stroke-dashoffset="${(100 - cumul).toFixed(2)}"></circle>`;
      cumul += pct;
      return arc;
    })
    .join("");

  const ligne = (p, i) => `<div class="part-ligne" data-i="${i}"${info(bulle(p))}>
        <i style="background:${p[2]}"></i>
        <span class="nom">${p[0]}${p[3] ? `<em class="taux-etape">${p[3]}</em>` : ""}</span>
        <span class="pct">${Math.round((p[1] / total) * 100)} %</span>
        <span class="montant">${format(p[1])}</span>
      </div>`;

  const visibles = visiblesParts.map(ligne).join("");

  // Les lignes masquées n'ont pas de tranche individuelle dans l'anneau (elles
  // sont fondues dans "Autres") : leur survol pointe toutes vers cette même
  // tranche agrégée, pas vers un index inexistant.
  const legende =
    visibles +
    (masquees.length
      ? `<div class="parts-plus" hidden>${masquees.map((p) => ligne(p, iAutres)).join("")}</div>
         <button type="button" class="parts-voir-plus" data-n="${masquees.length}">Voir ${masquees.length} de plus</button>`
      : "");

  const centres = partsArc
    .map((p) => JSON.stringify({ v: format(p[1]), n: Math.round((p[1] / total) * 100) + " %" }))
    .join(",");

  return `<div class="glass camembert rv">
    <h3>${titre}</h3>
    <div class="disque-enveloppe" data-centres="[${centres.replace(/"/g, "&quot;")}]">
      <svg class="disque" viewBox="0 0 42 42" role="img" aria-label="${titre}">
        <circle class="fond" cx="21" cy="21" r="15.915" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="6.5"></circle>
        ${arcs}
      </svg>
      <div class="disque-centre">
        <span class="c-valeur">${format(total)}</span>
        <span class="c-nom">total</span>
      </div>
    </div>
    <div class="parts">${legende}</div>
  </div>`;
}

function camemberts(lignes) {
  const cible = document.getElementById("camemberts");
  if (!cible) return;

  cible.innerHTML = [
    camembert("Dépense pub", lignes, "depense", euros),
    camembert("Rendez-vous", lignes, "rendezVous", nombre),
    camembert(caLibelle(), lignes, caChamp(), euros),
  ].join("");

  brancherSurvol(cible);
}

/* ------------------------------------------------------------------ */
/*  Camemberts de la section Conversion                                */
/* ------------------------------------------------------------------ */

const TEINTES_PERTE = {
  sansRdv: "#F0B95A",
  nonHonores: "#F08585",
  sansVente: "#C9A6FF",
  vente: "#6FD3A3",
};

function camembertsConversion(lignes) {
  const cible = document.getElementById("camemberts-conv");
  if (!cible) return;

  const v = {
    leads: somme(lignes, "leads"),
    rdv: somme(lignes, "rendezVous"),
    // Base des "non honorés" : seulement les RDV dont l'issue est connue
    // (Honoré/No-show). Un RDV encore "Confirmé" (à venir) n'est pas une
    // absence — l'ignorer ici évite de gonfler artificiellement cette perte.
    rdvConclus: somme(lignes, "rendezVousConclus"),
    honores: somme(lignes, "honores"),
    ventes: somme(lignes, "ventes"),
  };

  const perte = (a, b) => Math.max(0, a - b);
  const tauxPerte = (perdus, base) => (base > 0 ? `${Math.round((perdus / base) * 100)} % de l'étape` : null);

  const pertes = [
    ["Leads sans rendez-vous", perte(v.leads, v.rdv), TEINTES_PERTE.sansRdv, tauxPerte(perte(v.leads, v.rdv), v.leads)],
    ["Rendez-vous non honorés", perte(v.rdvConclus, v.honores), TEINTES_PERTE.nonHonores, tauxPerte(perte(v.rdvConclus, v.honores), v.rdvConclus)],
    ["Appels sans vente", perte(v.honores, v.ventes), TEINTES_PERTE.sansVente, tauxPerte(perte(v.honores, v.ventes), v.honores)],
    ["Ventes", v.ventes, TEINTES_PERTE.vente, null],
  ].filter(([, valeur]) => valeur > 0);

  // Pertes par canal : combien de leads, canal par canal, n'ont finalement
  // abouti à aucune vente. Complète le camembert de gauche (QUELLE étape fait
  // le plus perdre) par le QUEL canal fait le plus perdre — contrairement à
  // "Ventes par canal" (retiré), qui montrait une réussite, pas une perte,
  // et n'avait donc pas sa place dans une section "Où ça se perd".
  const parCanal = {};
  lignes.forEach((l) => {
    const c = l.canal || "Inconnu";
    const perteLigne = Math.max(0, (l.leads || 0) - (l.ventes || 0));
    parCanal[c] = (parCanal[c] || 0) + perteLigne;
  });
  const pertesParCanal = Object.entries(parCanal)
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([nom, valeur]) => [nom, valeur, COULEUR_CANAL[nom] || "#8895A7"]);

  cible.innerHTML = [disque("Où la chaîne se perd", pertes, nombre), disque("Pertes par canal", pertesParCanal, nombre)].join("");

  brancherSurvol(cible);
}

function brancherSurvol(cible) {
  cible.querySelectorAll(".camembert").forEach((carteEl) => {
    const svg = carteEl.querySelector(".disque");
    if (!svg) return;

    const enveloppe = carteEl.querySelector(".disque-enveloppe");
    const cValeur = carteEl.querySelector(".c-valeur");
    const cNom = carteEl.querySelector(".c-nom");
    const centres = JSON.parse(enveloppe.dataset.centres || "[]");
    const total = { v: cValeur.textContent, n: cNom.textContent };

    const montrer = (i) => {
      const c = i === null ? total : centres[i];
      if (c) {
        cValeur.textContent = c.v;
        cNom.textContent = c.n;
      }

      svg.classList.toggle("survol", i !== null);
      svg.querySelectorAll(".part").forEach((p) => p.classList.toggle("actif", Number(p.dataset.i) === i));
      carteEl.querySelectorAll(".part-ligne").forEach((l) => l.classList.toggle("actif", Number(l.dataset.i) === i));
    };

    [...svg.querySelectorAll(".part"), ...carteEl.querySelectorAll(".part-ligne")].forEach((el) => {
      el.addEventListener("mouseenter", () => montrer(Number(el.dataset.i)));
      el.addEventListener("mouseleave", () => montrer(null));
    });
  });

  cible.querySelectorAll(".parts-voir-plus").forEach((bouton) => {
    bouton.addEventListener("click", () => {
      const bloc = bouton.previousElementSibling;
      const masque = !bloc.hidden;
      bloc.hidden = masque;
      bouton.textContent = masque ? `Voir ${bouton.dataset.n} de plus` : "Réduire";
    });
  });

  brancherInfobulles(cible);
}

/* ------------------------------------------------------------------ */
/*  Vue d'ensemble                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Cohortes : l'encaissé des clients acquis, mois après mois          */
/* ------------------------------------------------------------------ */

// Cohorte = mois d'acquisition (jour de la ligne ACQUISITION du client).
// Pour chaque cohorte : encaissé cumulé aux mois M0, M+1, M+2... rapporté à la
// dépense pub de ce même mois (= ROAS cumulé). La courbe "toutes cohortes" ne
// compare chaque mois qu'aux cohortes assez anciennes pour l'avoir vécu : sans
// ça, les cohortes récentes tireraient la courbe vers le bas.
const moisIndex = (cle) => Number(cle.slice(0, 4)) * 12 + Number(cle.slice(5, 7)) - 1;

function calculerCohortes(lignes) {
  const clients = parCanalEtProduit(CLIENTS_DETAIL.filter((c) => c.jour && dansPeriode(c)));
  const aujourdhui = new Date();
  const moisCourant = aujourdhui.getFullYear() * 12 + aujourdhui.getMonth();

  const parCohorte = {};
  const cohorte = (cle) =>
    (parCohorte[cle] = parCohorte[cle] || { cle, clients: 0, renouvele: 0, depense: 0, flux: {} });

  lignes.forEach((l) => {
    if (l.jour && l.depense > 0) cohorte(l.jour.slice(0, 7)).depense += l.depense;
  });

  clients.forEach((c) => {
    const k = cohorte(c.jour.slice(0, 7));
    k.clients += 1;
    if (c.prestations >= 2) k.renouvele += 1;
    c.paiements.forEach((p) => {
      const m = Math.max(0, moisIndex(p.jour) - moisIndex(c.jour));
      k.flux[m] = (k.flux[m] || 0) + p.montant;
    });
  });

  // Seules les cohortes avec une dépense connue sont comparables.
  const cohortes = Object.values(parCohorte)
    .filter((k) => k.depense > 0)
    .sort((x, y) => x.cle.localeCompare(y.cle))
    .map((k) => {
      const age = moisCourant - moisIndex(k.cle);
      const cumul = [];
      let somme = 0;
      for (let m = 0; m <= age; m++) {
        somme += k.flux[m] || 0;
        cumul.push(somme);
      }
      return { ...k, age, cumul, roas: cumul.map((v) => v / k.depense) };
    });

  const ageMax = cohortes.reduce((mx, k) => Math.max(mx, k.age), 0);
  const global = [];
  for (let m = 0; m <= ageMax; m++) {
    const ok = cohortes.filter((k) => k.age >= m);
    const dep = ok.reduce((s, k) => s + k.depense, 0);
    if (!dep) break;
    global.push(ok.reduce((s, k) => s + k.cumul[m], 0) / dep);
  }

  const idxPayback = global.findIndex((v) => v >= 1);
  const nbClients = clients.length;
  const renouveles = clients.filter((c) => c.prestations >= 2).length;

  return {
    cohortes,
    global,
    payback: idxPayback, // -1 = pas encore rentabilisé
    roasM3: global.length > 3 ? global[3] : null,
    nbClients,
    tauxRenouv: nbClients > 0 ? renouveles / nbClients : null,
  };
}

function courbeCohortes(cible, co) {
  if (!co.cohortes.length || !co.global.length) {
    cible.innerHTML = `<div class="vide">Pas encore assez de données : il faut des clients acquis avec une dépense pub renseignée sur le même mois.</div>`;
    return;
  }

  const recentes = co.cohortes.slice(-6);
  const L = 1000, H = 300, M_HAUT = 16, M_BAS = 34, M_GAUCHE = 46, M_DROITE = 40;
  const nMois = Math.max(1, co.global.length - 1);
  const max = Math.max(1.25, ...co.global, ...recentes.flatMap((k) => k.roas));
  const x = (m) => M_GAUCHE + (m * (L - M_GAUCHE - M_DROITE)) / nMois;
  const y = (v) => M_HAUT + (H - M_HAUT - M_BAS) * (1 - v / max);
  const chemin = (vals) => vals.map((v, m) => `${m ? "L" : "M"}${x(m).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const fmt = (v) => v.toFixed(2).replace(".", ",") + " ×";

  const grille = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const yy = y(max * t).toFixed(1);
      return `<line x1="${M_GAUCHE}" x2="${L - M_DROITE}" y1="${yy}" y2="${yy}" class="courbe-grille"/>
        <text x="${M_GAUCHE - 10}" y="${yy}" class="courbe-axe-y" text-anchor="end" dominant-baseline="middle">${(max * t).toFixed(1).replace(".", ",")}×</text>`;
    })
    .join("");

  const axeX = co.global
    .map((_, m) => `<text x="${x(m).toFixed(1)}" y="${H - 10}" class="courbe-axe" text-anchor="middle">${m === 0 ? "M0" : "M+" + m}</text>`)
    .join("");

  const couleurs = Object.fromEntries(recentes.map((k, i) => [k.cle, PALETTE[i % PALETTE.length]]));
  const lignesCohortes = recentes
    .map((k) => `<path d="${chemin(k.roas)}" fill="none" stroke="${couleurs[k.cle]}" stroke-width="2" stroke-opacity=".8" class="courbe-ligne"><title>Cohorte ${libelleMois(k.cle)} : ${k.clients} client${k.clients > 1 ? "s" : ""}, ${fmt(k.roas[k.roas.length - 1])} à date</title></path>`)
    .join("");

  const ligneGlobale = `<path d="${chemin(co.global)}" fill="none" stroke="#fff" stroke-width="3.5" class="courbe-ligne"/>` +
    co.global.map((v, m) => `<circle cx="${x(m).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5" fill="#fff"><title>M${m ? "+" + m : "0"} : ${fmt(v)} (toutes cohortes assez anciennes)</title></circle>`).join("");

  const seuil = `<line x1="${M_GAUCHE}" x2="${L - M_DROITE}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}" stroke="var(--vert)" stroke-width="1.5" stroke-dasharray="6 5"/>
    <text x="${L - M_DROITE}" y="${(y(1) - 7).toFixed(1)}" text-anchor="end" fill="var(--vert)" font-size="12">rentabilisé</text>`;

  const legende = `<div class="legende-graph">
      <span><i style="background:#fff"></i>Toutes cohortes</span>
      ${recentes.map((k) => `<span><i style="background:${couleurs[k.cle]}"></i>${libelleMois(k.cle)}</span>`).join("")}
    </div>`;

  cible.innerHTML = legende + `<svg viewBox="0 0 ${L} ${H}" class="courbe-svg" role="img" aria-label="ROAS cumulé par mois depuis l'acquisition">${grille}${seuil}${lignesCohortes}${ligneGlobale}${axeX}</svg>
    <p class="note-graph">Ligne blanche : toutes les cohortes, en ne comparant chaque mois qu'aux cohortes assez anciennes pour l'avoir vécu. Sous la ligne verte, la dépense n'est pas encore remboursée.</p>`;
}

const libelleMois = (cle) => `${MOIS_LONGS[Number(cle.slice(5, 7)) - 1].slice(0, 4).toLowerCase()}. ${cle.slice(2, 4)}`;

function vueEnsemble(lignes, precedentes) {
  const ecart = (cle) => {
    const f = INDICATEURS[cle];
    return precedentes ? ecartDe(f(lignes), f(precedentes), cle) : null;
  };

  const depense = somme(lignes, "depense");
  const ventes = somme(lignes, "ventes");
  const impressions = somme(lignes, "impressions");
  const clics = somme(lignes, "clics");

  const enEuros = (v) => (v === null ? "—" : euros(v));
  const enRoas = (v) => (v === null ? "—" : v.toFixed(2).replace(".", ",") + " ×");
  const val = (cle) => INDICATEURS[cle](lignes);

  const sansDepense = depense === 0 ? "dépense non saisie" : null;

  // RDV pris mais dont l'issue n'est pas encore connue (ni Honoré, ni
  // No-show, ni Annulé) : ils pèsent dans la dépense de la période mais pas
  // encore dans "honorés"/"ventes", donc "Coût par appel honoré" et "Coût
  // par vente" sont mécaniquement surestimés tant qu'ils n'ont pas eu lieu.
  const rdvAVenir = somme(lignes, "rendezVous") - somme(lignes, "rendezVousConclus");
  const noteAVenir =
    rdvAVenir > 0
      ? `${nombre(rdvAVenir)} RDV de la période encore à venir : ce chiffre va bouger`
      : null;

  const modeClient = CA_MODE !== "call";
  const nbClients = val("clients");
  const sansClient = modeClient && nbClients === 0 ? "aucun client rattaché sur la période" : null;

  document.getElementById("perf").innerHTML = [
    carte("Dépense pub", euros(depense), depense === 0 ? "aucune dépense renseignée" : null, ecart("depense")),
    carte(caLibelle(), enEuros(val("contracte")), sansClient, ecart("contracte")),
    carte("ROAS", enRoas(val("roas")), sansDepense || "le chiffre de pilotage", ecart("roas")),
    carte("Nouveaux clients", nombre(nbClients), null, ecart("clients")),
  ].join("");

  const sansLtv = nbClients === 0 ? "aucun client rattaché sur la période" : null;
  // Ligne 1 : ce que rapporte un client. Ligne 2 : ce que ça donne face à la dépense.
  document.getElementById("perf-ltv").innerHTML = [
    carte("CA encaissé (tous contrats)", enEuros(val("encaisse")), sansLtv || "tout ce que ces clients ont payé à date", ecart("encaisse")),
    carte("LTV moyenne par client", enEuros(val("ltv")), sansLtv || "encaissé à date, par client acquis", ecart("ltv")),
    carte("LTV / 1er achat", enRoas(val("multipleLtv")), sansLtv || "combien de fois le 1er contrat est dépassé", ecart("multipleLtv")),
  ].join("");
  document.getElementById("perf-ltv-rentab").innerHTML = [
    carte("ROAS tous contrats", enRoas(val("roasTous")), sansDepense || "encaissé total / dépense pub", ecart("roasTous")),
    carte("Marge par client", enEuros(val("margeClient")), sansLtv || sansDepense || "LTV à date moins coût par client", ecart("margeClient")),
    carte("LTV / coût par client", enRoas(val("ltvSurCout")), sansLtv || sansDepense || "au-dessus de 1 ×, un client rapporte plus qu'il n'a coûté", ecart("ltvSurCout")),
  ].join("");

  const co = calculerCohortes(lignes);
  const sansCohorte = co.nbClients === 0 ? "aucun client rattaché sur la période" : null;
  document.getElementById("perf-ltv-cycle").innerHTML = [
    carte("Taux de renouvellement", co.tauxRenouv === null ? "—" : pourcent(co.tauxRenouv), sansCohorte || "clients avec au moins 2 prestations", null),
    carte(
      "Délai de rentabilité",
      co.payback >= 0 ? (co.payback === 0 ? "dès M0" : `M+${co.payback}`) : "pas encore",
      co.global.length ? (co.payback >= 0 ? "mois après l'acquisition où l'encaissé couvre la dépense" : "l'encaissé n'a pas encore couvert la dépense") : "pas assez de données",
      null
    ),
    carte("ROAS à M+3", co.roasM3 === null ? "—" : enRoas(co.roasM3), co.roasM3 === null ? "pas encore de cohorte de 3 mois" : "encaissé cumulé 3 mois après l'acquisition / dépense", null),
  ].join("");
  courbeCohortes(document.getElementById("perf-cohortes"), co);

  document.getElementById("perf-couts").innerHTML = [
    modeClient
      ? carte("Coût par client", enEuros(val("coutClient")), sansClient || sansDepense, ecart("coutClient"))
      : carte("Coût par vente", enEuros(val("coutVente")), (depense > 0 && ventes === 0 ? "aucune vente sur la période" : sansDepense) || noteAVenir, ecart("coutVente")),
    carte("Coût par appel honoré", enEuros(val("coutAppel")), sansDepense || noteAVenir, ecart("coutAppel")),
    carte("Coût par call booké", enEuros(val("coutRdv")), sansDepense, ecart("coutRdv")),
    carte("Coût par lead", enEuros(val("coutLead")), sansDepense, ecart("coutLead")),
  ].join("");

  document.getElementById("perf-couts-media").innerHTML = [
    carte("CPM", enEuros(val("cpm")), impressions === 0 ? "impressions non saisies" : `sur ${nombre(impressions)} impressions`, ecart("cpm")),
    carte("CPC", enEuros(val("cpc")), clics === 0 ? "clics non saisis" : `sur ${nombre(clics)} clics`, ecart("cpc")),
    carte("CTR", impressions === 0 ? "—" : pourcent(val("ctr")), impressions === 0 ? "impressions non saisies" : `${nombre(clics)} clics sur ${nombre(impressions)} impressions`, ecart("ctr")),
  ].join("");

  graphiqueCa(lignes);
  camemberts(lignes);

  requestAnimationFrame(() =>
    setTimeout(() => {
      document.querySelectorAll(".barre").forEach((b) => {
        b.style.height = b.dataset.hauteur + "%";
      });
    }, 120)
  );
}

/* ------------------------------------------------------------------ */
/*  Détail par jour                                                    */
/* ------------------------------------------------------------------ */

function vueJour(lignes) {
  if (!lignes.length) {
    document.getElementById("table-jour").innerHTML = `<div style="padding:28px;color:var(--txt3)">Aucune donnée.</div>`;
    return;
  }

  const corps = lignes
    .map((l) => {
      const oubli = !l.depense && l.leads > 0;
      return `<tr>
        <td>${l.jour ?? "—"}</td>
        <td><span class="pastille">${l.canal ?? "—"}</span></td>
        <td class="${oubli ? "manquant" : !l.depense ? "zero" : ""}">${l.depense ? euros(l.depense) : "—"}</td>
        ${cellule(l.leads)}
        ${cellule(l.rendezVous)}
        ${cellule(l.honores)}
        ${cellule(l.ventes)}
        ${cellule(l.contracte, euros)}
      </tr>`;
    })
    .join("");

  document.getElementById("table-jour").innerHTML = `
    <table>
      <thead><tr>
        <th>Jour</th><th>Canal</th><th>Dépense</th>
        <th>Leads</th><th>RDV</th><th>Honorés</th><th>Ventes</th><th>Contracté</th>
      </tr></thead>
      <tbody>${corps}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ */
/*  Par canal                                                          */
/* ------------------------------------------------------------------ */

function vueCanal(lignes) {
  const champs = ["depense", "leads", "rendezVous", "honores", "ventes", "contracte"];

  const parCanal = {};
  lignes.forEach((l) => {
    const c = l.canal || "Inconnu";
    parCanal[c] ||= Object.fromEntries(champs.map((f) => [f, 0]));
    champs.forEach((f) => (parCanal[c][f] += l[f] || 0));
  });

  const canaux = Object.entries(parCanal).sort((a, b) => b[1].leads - a[1].leads);

  if (!canaux.length) {
    document.getElementById("table-canal").innerHTML = `<div style="padding:28px;color:var(--txt3)">Aucune donnée.</div>`;
    return;
  }

  const ligne = (nom, d, classe = "") => {
    const parRdv = d.depense > 0 && d.rendezVous > 0 ? euros(d.depense / d.rendezVous) : "—";
    return `<tr class="${classe}">
      <td>${classe ? "<strong>Total</strong>" : `<span class="pastille">${nom}</span>`}</td>
      <td class="${!d.depense ? "zero" : ""}">${d.depense ? euros(d.depense) : "—"}</td>
      ${cellule(d.leads)}
      ${cellule(d.rendezVous)}
      ${cellule(d.honores)}
      ${cellule(d.ventes)}
      ${cellule(d.contracte, euros)}
      <td class="${parRdv === "—" ? "zero" : ""}">${parRdv}</td>
    </tr>`;
  };

  const total = Object.fromEntries(champs.map((f) => [f, somme(lignes, f)]));

  document.getElementById("table-canal").innerHTML = `
    <table>
      <thead><tr>
        <th>Canal</th><th>Dépense</th><th>Leads</th>
        <th>RDV</th><th>Honorés</th><th>Ventes</th><th>Contracté</th><th>Coût / RDV</th>
      </tr></thead>
      <tbody>
        ${canaux.map(([nom, d]) => ligne(nom, d)).join("")}
        ${ligne("", total, "total")}
      </tbody>
    </table>`;
}

/* ------------------------------------------------------------------ */
/*  Dépenses média                                                     */
/* ------------------------------------------------------------------ */

function vueDepenses(lignes) {
  if (!lignes.length) {
    document.getElementById("table-depenses").innerHTML = `<div style="padding:28px;color:var(--txt3)">Aucune donnée.</div>`;
    return;
  }

  const corps = lignes
    .map((l) => {
      const oubli = !l.depense && l.leads > 0;
      const etat = l.depense ? "Saisie" : l.leads > 0 ? "À saisir" : "Sans activité";
      return `<tr>
        <td>${l.jour ?? "—"}</td>
        <td><span class="pastille">${l.canal ?? "—"}</span></td>
        <td class="${oubli ? "manquant" : !l.depense ? "zero" : ""}">${l.depense ? euros(l.depense) : "—"}</td>
        ${cellule(l.leads)}
        ${cellule(l.rendezVous)}
        <td class="${oubli ? "manquant" : "zero"}">${etat}</td>
      </tr>`;
    })
    .join("");

  const aSaisir = lignes.filter((l) => !l.depense && l.leads > 0).length;

  document.getElementById("table-depenses").innerHTML = `
    <table>
      <thead><tr>
        <th>Jour</th><th>Canal</th><th>Dépense</th><th>Leads</th><th>RDV</th><th>État</th>
      </tr></thead>
      <tbody>${corps}</tbody>
    </table>`;

  const pied = document.querySelector("#vue-depenses .sous-titre");
  if (pied) {
    pied.textContent = aSaisir
      ? `${aSaisir} journée${aSaisir > 1 ? "s" : ""} avec de l'activité mais sans montant saisi.`
      : "Toutes les journées avec activité ont un montant saisi.";
  }
}

/* ------------------------------------------------------------------ */
/*  Simulateur                                                         */
/* ------------------------------------------------------------------ */

let OBJECTIF = 20000;

const HYP = { panier: null, closing: null, presence: null, conclusion: null, leadRdv: null, coutLead: null };

function mesures(lignes) {
  const s = (c) => somme(lignes, c);

  return {
    panier: ratio(s("contracte"), s("ventes")),
    closing: ratio(s("ventes"), s("honores")),
    // Même correctif que partout ailleurs : la base du taux de présence est
    // les RDV CONCLUS (Honoré/No-show), pas tous les RDV pris — sinon les
    // RDV "Confirmé" à venir font chuter artificiellement le taux.
    presence: ratio(s("honores"), s("rendezVousConclus")),
    // Étape que le simulateur oubliait : parmi les RDV pris, ceux qui arrivent
    // à un verdict (Honoré ou No-show). Le reste = annulés + encore à venir.
    conclusion: ratio(s("rendezVousConclus"), s("rendezVous")),
    leadRdv: ratio(s("rendezVous"), s("leads")),
    coutLead: ratio(s("depense"), s("leads")),
    reel: { ventes: s("ventes"), honores: s("honores"), rendezVousConclus: s("rendezVousConclus"), rendezVous: s("rendezVous"), leads: s("leads"), depense: s("depense") },
    bases: { ventes: s("ventes"), honores: s("honores"), rendezVous: s("rendezVous"), rendezVousConclus: s("rendezVousConclus"), leads: s("leads") },
  };
}

const HYPOTHESES = [
  { cle: "leadRdv", nom: "Lead → rendez-vous", unite: "%", base: "leads", groupe: "taux" },
  { cle: "conclusion", nom: "RDV pris → conclus", unite: "%", base: "rendezVous", groupe: "taux" },
  { cle: "presence", nom: "Taux de présence", unite: "%", base: "rendezVousConclus", groupe: "taux" },
  { cle: "closing", nom: "Taux de closing", unite: "%", base: "honores", groupe: "taux" },
  { cle: "panier", nom: "Panier moyen", unite: "€", base: "ventes", groupe: "eco" },
  { cle: "coutLead", nom: "Coût par lead", unite: "€", base: "leads", groupe: "eco" },
];

function simulateur(lignes) {
  const cible = document.getElementById("simu");
  if (!cible) return;

  const m = mesures(lignes);
  const valeur = (cle) => (HYP[cle] !== null ? HYP[cle] : m[cle]);

  const champ = (h) => {
    const v = valeur(h.cle);
    const affiche = v === null ? "" : h.unite === "%" ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100;
    const maigre = m.bases[h.base] < SEUIL_FIABILITE;
    return `<label class="hyp${HYP[h.cle] !== null ? " forcee" : ""}">
      <span class="hyp-nom">${h.nom}</span>
      <span class="hyp-saisie">
        <input type="number" step="any" min="0" data-hyp="${h.cle}"
          value="${affiche}" placeholder="${v === null ? "non mesuré" : ""}">
        <em>${h.unite}</em>
      </span>
      <span class="hyp-note${maigre ? " maigre" : ""}">${
        HYP[h.cle] !== null
          ? "forcé · " + (v === null ? "aucun repère" : "mesuré : " + (h.unite === "%" ? Math.round(m[h.cle] * 100) + " %" : euros(m[h.cle])))
          : maigre
          ? `mesuré sur ${nombre(m.bases[h.base])} — trop peu`
          : `mesuré sur ${nombre(m.bases[h.base])}`
      }</span>
    </label>`;
  };

  const groupe = (nom, cles) => {
    const html = HYPOTHESES.filter((h) => cles.includes(h.cle)).map(champ).join("");
    return html ? `<div class="hyp-groupe"><h4>${nom}</h4><div class="hypotheses">${html}</div></div>` : "";
  };

  const forcees = HYPOTHESES.filter((h) => HYP[h.cle] !== null).length;

  cible.innerHTML = `
    <div class="simu-objectif">
      <label>
        <span class="hyp-nom">Objectif de CA contracté</span>
        <span class="hyp-saisie grand">
          <input type="number" step="1000" min="0" id="simu-cible" value="${OBJECTIF}">
          <em>€</em>
        </span>
      </label>
      <button type="button" class="synchro${forcees ? " active" : ""}" id="simu-synchro" ${forcees ? "" : "disabled"}>
        Synchroniser au réel${forcees ? ` · ${forcees} forcée${forcees > 1 ? "s" : ""}` : ""}
      </button>
    </div>

    ${groupe("Taux de conversion", ["leadRdv", "conclusion", "presence", "closing"])}
    ${groupe("Hypothèses économiques", ["panier", "coutLead"])}
    <div id="simu-resultat"></div>`;

  cible.querySelector("#simu-synchro").addEventListener("click", () => {
    HYPOTHESES.forEach((h) => (HYP[h.cle] = null));
    simulateur(lignes);
  });

  const recalculer = () => resultatSimulation(m);

  cible.querySelector("#simu-cible").addEventListener("input", (e) => {
    OBJECTIF = Number(e.target.value) || 0;
    recalculer();
  });

  cible.querySelectorAll("[data-hyp]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const cle = e.target.dataset.hyp;
      const brut = e.target.value.trim();
      const h = HYPOTHESES.find((x) => x.cle === cle);
      HYP[cle] = brut === "" ? null : h.unite === "%" ? Number(brut) / 100 : Number(brut);
      e.target.closest(".hyp").classList.toggle("forcee", HYP[cle] !== null);

      const n = HYPOTHESES.filter((x) => HYP[x.cle] !== null).length;
      const bouton = cible.querySelector("#simu-synchro");
      bouton.disabled = n === 0;
      bouton.classList.toggle("active", n > 0);
      bouton.textContent = n ? `Synchroniser au réel · ${n} forcée${n > 1 ? "s" : ""}` : "Synchroniser au réel";

      recalculer();
    });
  });

  recalculer();
}

function avancement(reel, requis, neutre) {
  if (!requis) return null;
  const pct = Math.round((reel / requis) * 100);
  if (neutre) return { classe: "neutre", texte: `${pct} % du budget` };
  if (pct >= 100) return { classe: "bon", texte: `↑ objectif dépassé` };
  if (pct >= 95) return { classe: "stable", texte: `→ ${pct} % — presque` };
  return { classe: "mauvais", texte: `↓ ${pct} % atteint` };
}

function resultatSimulation(m) {
  const cible = document.getElementById("simu-resultat");
  if (!cible) return;

  const v = (cle) => (HYP[cle] !== null ? HYP[cle] : m[cle]);
  const manquantes = HYPOTHESES.filter((h) => v(h.cle) === null || v(h.cle) === 0);

  if (manquantes.length) {
    cible.innerHTML = `<div class="simu-bloque">
      <strong>Chaîne incomplète.</strong> Impossible de remonter l'entonnoir sans
      ${manquantes.map((h) => h.nom.toLowerCase()).join(", ")}.
      Force ces valeurs à la main, ou élargis la période.
    </div>`;
    return;
  }

  const ventes = OBJECTIF / v("panier");
  const honores = ventes / v("closing");
  const conclus = honores / v("presence");
  const rdv = conclus / v("conclusion");
  const leads = rdv / v("leadRdv");
  const depense = leads * v("coutLead");

  const arrondi = (x) => Math.ceil(x - 1e-9);

  const etages = [
    ["Ventes", ventes, m.reel.ventes],
    ["Rendez-vous honorés", honores, m.reel.honores],
    ["RDV conclus", conclus, m.reel.rendezVousConclus],
    ["Rendez-vous pris", rdv, m.reel.rendezVous],
    ["Leads", leads, m.reel.leads],
  ];

  const lignesHtml = etages
    .map(([nom, requis, reel]) => {
      const e = avancement(reel, requis, false);
      const barre = requis ? Math.min(100, Math.round((reel / requis) * 100)) : 0;
      return `<div class="simu-ligne">
        <span class="s-nom">${nom}</span>
        <span class="s-requis">${nombre(arrondi(requis))}</span>
        <span class="s-jauge"><i style="width:${barre}%"></i></span>
        <span class="s-reel">${nombre(reel)}</span>
        ${e ? `<span class="ecart-inline ${e.classe}">${e.texte}</span>` : "<span></span>"}
      </div>`;
    })
    .join("");

  const eBudget = avancement(m.reel.depense, depense, true);
  const roas = OBJECTIF / depense;

  cible.innerHTML = `
    <div class="simu-tableau">
      <div class="simu-entete"><span></span><span>Nécessaire</span><span></span><span>Réalisé</span><span></span></div>
      ${lignesHtml}
      <div class="simu-ligne budget">
        <span class="s-nom">Dépense publicitaire</span>
        <span class="s-requis">${euros(depense)}</span>
        <span class="s-jauge"><i style="width:${depense ? Math.min(100, Math.round((m.reel.depense / depense) * 100)) : 0}%"></i></span>
        <span class="s-reel">${euros(m.reel.depense)}</span>
        ${eBudget ? `<span class="ecart-inline ${eBudget.classe}">${eBudget.texte}</span>` : "<span></span>"}
      </div>
    </div>
    <div class="simu-pied">
      ROAS attendu <strong>${roas.toFixed(2).replace(".", ",")} ×</strong>
      · coût par vente <strong>${euros(depense / ventes)}</strong>
    </div>`;
}

/* ------------------------------------------------------------------ */
/*  Direction — Tableau de bord                                        */
/* ------------------------------------------------------------------ */

let DIRECTION_CONTRATS = [];
let DIRECTION_PAIEMENTS = [];

const idLie = (v) => (Array.isArray(v) ? v[0] : null);

function contratsDirectionFiltres() {
  return DIRECTION_CONTRATS.filter((c) => {
    if (DEBUT || FIN) {
      if (!c.dateSignature) return false;
      if (DEBUT && c.dateSignature < DEBUT) return false;
      if (FIN && c.dateSignature > FIN) return false;
    }
    if (CANAL !== "tout" && c.canal !== CANAL) return false;
    if (PRODUIT !== "tout" && c.produit !== PRODUIT) return false;
    return true;
  });
}

function paiementsDirectionFiltres() {
  const parContrat = Object.fromEntries(DIRECTION_CONTRATS.map((c) => [c.id, c]));

  return DIRECTION_PAIEMENTS.filter((p) => {
    if (DEBUT || FIN) {
      if (!p.datePaiement) return false;
      if (DEBUT && p.datePaiement < DEBUT) return false;
      if (FIN && p.datePaiement > FIN) return false;
    }
    if (CANAL !== "tout" || PRODUIT !== "tout") {
      const c = parContrat[idLie(p.contrat)];
      if (CANAL !== "tout" && (!c || c.canal !== CANAL)) return false;
      if (PRODUIT !== "tout" && (!c || c.produit !== PRODUIT)) return false;
    }
    return true;
  });
}

function contratsDirectionDansPlage(a, b) {
  return DIRECTION_CONTRATS.filter((c) => {
    if (!c.dateSignature || c.dateSignature < a || c.dateSignature > b) return false;
    if (CANAL !== "tout" && c.canal !== CANAL) return false;
    if (PRODUIT !== "tout" && c.produit !== PRODUIT) return false;
    return true;
  }).filter((c) => c.statut !== "Annulé");
}

function paiementsDirectionDansPlage(a, b) {
  const parContrat = Object.fromEntries(DIRECTION_CONTRATS.map((c) => [c.id, c]));

  return DIRECTION_PAIEMENTS.filter((p) => {
    if (!p.datePaiement || p.datePaiement < a || p.datePaiement > b) return false;
    if (CANAL !== "tout" || PRODUIT !== "tout") {
      const c = parContrat[idLie(p.contrat)];
      if (CANAL !== "tout" && (!c || c.canal !== CANAL)) return false;
      if (PRODUIT !== "tout" && (!c || c.produit !== PRODUIT)) return false;
    }
    return true;
  });
}

function resiliationsDansPlage(a, b) {
  return DIRECTION_CONTRATS.filter((c) => {
    if (!c.dateResiliation || c.dateResiliation < a || c.dateResiliation > b) return false;
    if (CANAL !== "tout" && c.canal !== CANAL) return false;
    if (PRODUIT !== "tout" && c.produit !== PRODUIT) return false;
    return true;
  }).length;
}

function mesuresDirection(contrats, paiements, resiliations) {
  const caContracte = somme(contrats, "montantTotal");
  const caEncaisse = somme(paiements, "montantRecu");
  const nbClients = new Set(contrats.map((c) => idLie(c.client)).filter(Boolean)).size;

  // Le taux de recouvrement ne doit compter que les échéances déjà ÉCHUES
  // (date passée). Une échéance à venir n'a simplement pas encore son tour —
  // la compter comme "prévue mais pas reçue" ferait chuter artificiellement
  // le taux alors qu'il n'y a rien d'anormal.
  const paiementsEchus = paiements.filter((p) => p.datePaiement && p.datePaiement <= AUJOURDHUI);
  const montantPrevuEchu = somme(paiementsEchus, "montantPrevu");
  const montantRecuEchu = somme(paiementsEchus, "montantRecu");

  return {
    caContracte,
    caEncaisse,
    nbClients,
    panierMoyen: contrats.length ? caContracte / contrats.length : null,
    tauxRecouvrement: montantPrevuEchu > 0 ? montantRecuEchu / montantPrevuEchu : null,
    ltvMoyenne: nbClients ? somme(contrats, "montantLtv") / nbClients : null,
    resiliations,
  };
}

function tranches7Direction(contrats, paiements, granularite) {
  const jours = [
    ...contrats.map((c) => c.dateSignature),
    ...paiements.map((p) => p.datePaiement),
  ]
    .filter(Boolean)
    .sort();
  if (!jours.length) return [];

  const blocs = decoupagePeriodes(jours, granularite);

  return blocs
    .map((b) => ({
      ...b,
      contracte: contrats
        .filter((c) => c.dateSignature >= b.debut && c.dateSignature <= b.fin)
        .reduce((s, c) => s + (c.montantTotal || 0), 0),
      encaisse: paiements
        .filter((p) => p.datePaiement >= b.debut && p.datePaiement <= b.fin)
        .reduce((s, p) => s + (p.montantRecu || 0), 0),
    }))
    .filter((b) => b.contracte > 0 || b.encaisse > 0);
}

function grapheDirection(contrats, paiements) {
  DERNIERS_CONTRATS_DIRECTION = contrats;
  DERNIERS_PAIEMENTS_DIRECTION = paiements;

  const cible = document.getElementById("direction-graph");
  if (!cible) return;

  const granularite = GRANULARITE_DIRECTION;
  const blocs = tranches7Direction(contrats, paiements, granularite);
  const toggle = toggleGranulariteHtml(granularite);
  const rebrancherToggle = () =>
    brancherToggleGranularite(cible, (g) => {
      GRANULARITE_DIRECTION = g;
      grapheDirection(DERNIERS_CONTRATS_DIRECTION, DERNIERS_PAIEMENTS_DIRECTION);
    });

  if (!blocs.length) {
    cible.innerHTML = toggle + `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    rebrancherToggle();
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.contracte, b.encaisse]));
  const h = (v) => Math.round((v / max) * 100);

  const legende = `
    <div class="legende-graph">
      <span><i class="b-dir-contracte"></i>CA contracté</span>
      <span><i class="b-dir-encaisse"></i>CA encaissé</span>
    </div>`;

  const colonnes = blocs
    .map((b) => {
      const libelle = libellePeriode(b, granularite);
      const bulle = `<strong>${libelle}</strong>
        <span><i class="p-dir-contracte"></i>CA contracté<b>${euros(b.contracte)}</b></span>
        <span><i class="p-dir-encaisse"></i>CA encaissé<b>${euros(b.encaisse)}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-dir-contracte" data-hauteur="${h(b.contracte)}"></div>
            <div class="barre b-dir-encaisse"  data-hauteur="${h(b.encaisse)}"></div>
          </div>
        </div>
        <div class="jour">${libelle}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = toggle + legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);
  rebrancherToggle();

  requestAnimationFrame(() =>
    setTimeout(() => {
      cible.querySelectorAll(".barre").forEach((b) => {
        b.style.height = b.dataset.hauteur + "%";
      });
    }, 120)
  );
}

function camembertsDirection(contrats) {
  const cible = document.getElementById("direction-camemberts");
  if (!cible) return;

  const parClef = (clef) => {
    const totaux = {};
    contrats.forEach((c) => {
      const nom = c[clef] || "Inconnu";
      totaux[nom] = (totaux[nom] || 0) + (c.montantTotal || 0);
    });
    return Object.entries(totaux)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([nom, valeur], i) => [nom, valeur, PALETTE[i % PALETTE.length]]);
  };

  cible.innerHTML = [
    disque("Répartition par Closer", parClef("closer"), euros),
    disque("Répartition par Produit", parClef("produit"), euros),
  ].join("");

  brancherSurvol(cible);
}

function vueDirection() {
  const cible = document.getElementById("direction-cartes");
  if (!cible) return;

  const contrats = contratsDirectionFiltres().filter((c) => c.statut !== "Annulé");
  const paiements = paiementsDirectionFiltres();
  const resiliations = resiliationsDansPlage(DEBUT || "", FIN || "9999-99-99");
  const m = mesuresDirection(contrats, paiements, resiliations);

  const plage = plagePrecedente();
  const mPrec = plage
    ? mesuresDirection(
        contratsDirectionDansPlage(plage[0], plage[1]),
        paiementsDirectionDansPlage(plage[0], plage[1]),
        resiliationsDansPlage(plage[0], plage[1])
      )
    : null;

  const ecart = (cleObjet, cleSens) => (mPrec ? ecartDe(m[cleObjet], mPrec[cleObjet], cleSens || cleObjet) : null);

  cible.innerHTML = [
    carte("CA contracté", euros(m.caContracte), contrats.length ? null : "aucun contrat signé sur la période", ecart("caContracte")),
    carte("CA encaissé", euros(m.caEncaisse), null, ecart("caEncaisse")),
    carte("Clients signés", nombre(m.nbClients), null, ecart("nbClients")),
    carte("Panier moyen", m.panierMoyen === null ? "—" : euros(m.panierMoyen), contrats.length ? null : "aucun contrat sur la période", ecart("panierMoyen")),
  ].join("");

  const bloc = document.getElementById("direction-sante");
  if (bloc) {
    bloc.innerHTML = [
      carte("Taux de recouvrement", m.tauxRecouvrement === null ? "—" : pourcent(m.tauxRecouvrement), m.tauxRecouvrement === null ? "aucune échéance échue sur la période" : "sur les échéances déjà passées, hors à venir", ecart("tauxRecouvrement")),
      carte("LTV moyenne", m.ltvMoyenne === null ? "—" : euros(m.ltvMoyenne), m.nbClients ? null : "aucun client signé sur la période", ecart("ltvMoyenne")),
      carte("Résiliations", nombre(m.resiliations), null, ecart("resiliations", "dirResiliations")),
    ].join("");
  }

  grapheDirection(contrats, paiements);
  camembertsDirection(contrats);
}

/* ------------------------------------------------------------------ */
/*  Navigation et apparitions                                          */
/* ------------------------------------------------------------------ */

function apparitions(racine) {
  const doux = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const cibles = racine.querySelectorAll(".rv");

  if (doux || !("IntersectionObserver" in window)) {
    cibles.forEach((e) => e.classList.add("on"));
    return;
  }

  racine.querySelectorAll(".cartes").forEach((g) => {
    [...g.children].forEach((c, i) => {
      if (c.classList.contains("rv")) c.style.transitionDelay = i * 110 + "ms";
    });
  });

  const obs = new IntersectionObserver(
    (lots) =>
      lots.forEach((l) => {
        if (l.isIntersecting) {
          l.target.classList.add("on");
          obs.unobserve(l.target);
        }
      }),
    { rootMargin: "0px 0px -8% 0px" }
  );
  cibles.forEach((e) => obs.observe(e));
}

function afficherVue(nom) {
  document.querySelectorAll(".vue").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".sous a").forEach((a) => a.classList.remove("actif"));

  const vue = document.getElementById("vue-" + nom);
  const lien = document.querySelector(`.sous a[data-vue="${nom}"]`);
  if (!vue) return;

  vue.classList.add("active");
  if (lien) lien.classList.add("actif");

  const barre = document.getElementById("filtre");
  const ancre = vue.querySelector(".convention") || vue.querySelector(".titre-vue");
  if (barre && ancre) ancre.after(barre);

  vue.querySelectorAll(".rv").forEach((e) => e.classList.remove("on"));
  requestAnimationFrame(() => apparitions(vue));

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function brancherNavigation() {
  document.querySelectorAll(".groupe > button").forEach((b) => {
    if (b.classList.contains("inactif")) return;
    b.addEventListener("click", () => b.parentElement.classList.toggle("ouvert"));
  });

  document.querySelectorAll(".sous a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const vue = a.dataset.vue;
      history.replaceState(null, "", "#" + vue);
      afficherVue(vue);
      fermerMenuMobile();
    });
  });

  brancherMenuMobile();
}

/* ---------- Menu burger (mobile) ---------- */

function ouvrirMenuMobile() {
  // Déplie le groupe de la vue active pour que le lien courant soit visible
  // sans tap supplémentaire.
  const actif = document.querySelector(".sous a.actif");
  if (actif) actif.closest(".groupe")?.classList.add("ouvert");
  document.getElementById("rail").classList.add("ouvert-mobile");
  document.getElementById("burger").setAttribute("aria-expanded", "true");
  document.body.classList.add("menu-ouvert");
}

function fermerMenuMobile() {
  document.getElementById("rail").classList.remove("ouvert-mobile");
  document.getElementById("burger").setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-ouvert");
}

function brancherMenuMobile() {
  const burger = document.getElementById("burger");
  const fermer = document.getElementById("railFermer");
  const fond = document.getElementById("railFond");
  if (!burger) return;

  burger.addEventListener("click", () => {
    const ouvert = document.getElementById("rail").classList.contains("ouvert-mobile");
    ouvert ? fermerMenuMobile() : ouvrirMenuMobile();
  });
  fermer.addEventListener("click", fermerMenuMobile);
  fond.addEventListener("click", fermerMenuMobile);
  document.addEventListener("keydown", (e) => e.key === "Escape" && fermerMenuMobile());

  // Geste natif : glisser le tiroir vers la gauche pour le fermer, glisser
  // depuis le bord gauche de l'écran pour l'ouvrir.
  let x0 = null, y0 = null;
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (x0 === null || window.innerWidth > 900) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    const ouvert = document.getElementById("rail").classList.contains("ouvert-mobile");
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (ouvert && dx < 0) fermerMenuMobile();
      else if (!ouvert && dx > 0 && x0 < 24) ouvrirMenuMobile();
    }
    x0 = null;
  }, { passive: true });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) fermerMenuMobile();
  });
}

/* ------------------------------------------------------------------ */
/*  Filtres                                                             */
/* ------------------------------------------------------------------ */

function majLegende() {
  const n = lignesFiltrees().length;
  const borne = (v) => (v ? jourCourt(v) : "—");
  const periode = DEBUT || FIN ? `du ${borne(DEBUT)} au ${borne(FIN)}` : "toute la période";

  const restrictions = [
    CANAL !== "tout" ? CANAL : null,
    PRODUIT !== "tout" ? PRODUIT : null,
    SOURCE !== "tout" ? SOURCE : null,
  ].filter(Boolean);

  document.getElementById("filtre-note").textContent = [`${n} ligne${n > 1 ? "s" : ""}`, periode, ...restrictions].join(" · ");
}

function rendre() {
  const lignes = lignesFiltrees();
  const precedentes = lignesPrecedentes();

  vueEnsemble(lignes, precedentes);
  vueConversion(lignes, precedentes);
  simulateur(lignes);
  vueJour(lignes);
  vueCanal(lignes);
  vueDepenses(lignes);
  vueDirection();
  vueTracking();
  vueSalesClosing();
  vueSalesSetting();

  const active = document.querySelector(".vue.active");
  if (active) {
    active.querySelectorAll(".rv").forEach((e) => e.classList.remove("on"));
    requestAnimationFrame(() => apparitions(active));
  }
}

function brancherCanalProduit() {
  const remplir = (id, valeurs, libelleTout) => {
    const select = document.getElementById(id);
    select.innerHTML = `<option value="tout">${libelleTout}</option>` + valeurs.map((v) => `<option value="${v}">${v}</option>`).join("");
    return select;
  };

  const canaux = [...new Set(TOUTES.map((l) => l.canal).filter(Boolean))].sort();
  const produits = [...new Set(TOUTES.map((l) => l.produit).filter(Boolean))].sort();
  const sources = [...new Set(TOUTES.map((l) => l.source).filter(Boolean))].sort();

  const sCanal = remplir("canal", canaux, "Tous les canaux");
  const sProduit = remplir("produit", produits, "Tous les produits");
  const sSource = remplir("source", sources, "Toutes les sources");

  sCanal.addEventListener("change", () => {
    CANAL = sCanal.value;
    majLegende();
    rendre();
  });
  sProduit.addEventListener("change", () => {
    PRODUIT = sProduit.value;
    majLegende();
    rendre();
  });
  sSource.addEventListener("change", () => {
    SOURCE = sSource.value;
    majLegende();
    rendre();
  });

  const sComparaison = document.getElementById("comparaison");
  sComparaison.value = COMPARAISON;
  sComparaison.addEventListener("change", () => {
    COMPARAISON = sComparaison.value;
    majLegende();
    rendre();
  });

  document.getElementById("filtre").hidden = false;
  majLegende();
}

function brancherPeriode() {
  const select = document.getElementById("periode");
  const zoneDates = document.getElementById("dates");
  const iDebut = document.getElementById("debut");
  const iFin = document.getElementById("fin");

  const jours = TOUTES.map((l) => l.jour).filter(Boolean).sort();
  const premier = jours[0] || "";
  const dernier = jours[jours.length - 1] || "";
  [iDebut, iFin].forEach((i) => {
    i.min = premier;
    i.max = dernier;
  });

  select.addEventListener("change", () => {
    const choix = select.value;
    zoneDates.hidden = choix !== "perso";

    if (choix === "tout") {
      DEBUT = null;
      FIN = null;
      iDebut.value = "";
      iFin.value = "";
    } else if (choix === "perso") {
      DEBUT = DEBUT || premier;
      FIN = FIN || dernier;
      iDebut.value = DEBUT;
      iFin.value = FIN;
    } else {
      const ref = enDate(dernier);
      FIN = dernier;

      if (choix === "trimestre") {
        const moisDebut = Math.floor(ref.getMonth() / 3) * 3;
        DEBUT = enIso(new Date(ref.getFullYear(), moisDebut, 1, 12));
      } else if (choix === "annee") {
        DEBUT = enIso(new Date(ref.getFullYear(), 0, 1, 12));
      } else {
        DEBUT = enIso(new Date(ref - (Number(choix) - 1) * JOUR_MS));
      }

      if (premier && DEBUT < premier) DEBUT = premier;
      iDebut.value = DEBUT;
      iFin.value = FIN;
    }

    majLegende();
    rendre();
  });

  [iDebut, iFin].forEach((i) =>
    i.addEventListener("change", () => {
      DEBUT = iDebut.value || null;
      FIN = iFin.value || null;
      select.value = "perso";
      zoneDates.hidden = false;
      majLegende();
      rendre();
    })
  );
}

/* ------------------------------------------------------------------ */
/*  Pilotage quotidien                                                 */
/* ------------------------------------------------------------------ */

// Camembert du jour : répartition des appels prévus aujourd'hui par issue.
// "En attente" = appels confirmés dont l'heure n'est pas encore passée (ou
// dont l'issue n'a pas encore été saisie) — jamais négatif.
function camembertQuotidien(duJour) {
  const cible = document.getElementById("quot-camembert");
  if (!cible) return;

  const total = (champ) => somme(duJour, champ);
  const honores = total("honores");
  const noShow = total("noShow");
  const annules = total("annules");
  const enAttente = Math.max(0, total("appelsPrevus") - honores - noShow - annules);

  cible.innerHTML = disque(
    "Aujourd'hui, par issue",
    [
      ["Honorés", honores, "#6FD3A3"],
      ["No-show", noShow, "#F08585"],
      ["Annulés", annules, "#8895A7"],
      ["En attente", enAttente, "#9B6BFF"],
    ],
    nombre
  );

  brancherSurvol(cible);
}

// Regroupe les jours (jour réel d'appel) en tranches de 7 jours glissantes
// ou en mois calendaires — même découpage que les autres graphiques en
// bâtonnés (cf. decoupagePeriodes), appliqué ici aux compteurs honorés /
// no-show / annulés / appels prévus plutôt qu'à des montants.
function tranchesQuotidien(joursData, granularite) {
  const joursTries = joursData.map((j) => j.jour).filter(Boolean).sort();
  if (!joursTries.length) return [];

  const blocs = decoupagePeriodes(joursTries, granularite);

  return blocs
    .map((b) => {
      const dedans = joursData.filter((j) => j.jour >= b.debut && j.jour <= b.fin);
      return {
        ...b,
        appelsPrevus: somme(dedans, "appelsPrevus"),
        honores: somme(dedans, "honores"),
        noShow: somme(dedans, "noShow"),
        annules: somme(dedans, "annules"),
      };
    })
    .filter((b) => b.appelsPrevus > 0);
}

// Histogramme day-by-day, avec le même toggle Semaine/Mois que les
// graphiques Dépense/CA et CA contracté/encaissé.
function graphiqueQuotidien(joursData) {
  DERNIERS_JOURS_QUOTIDIEN = joursData;

  const cible = document.getElementById("quot-graph");
  if (!cible) return;

  const granularite = GRANULARITE_QUOTIDIEN;
  const blocs = tranchesQuotidien(joursData, granularite);
  const toggle = toggleGranulariteHtml(granularite);

  if (!blocs.length) {
    cible.innerHTML = toggle + `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    brancherToggleGranularite(cible, (g) => {
      GRANULARITE_QUOTIDIEN = g;
      graphiqueQuotidien(DERNIERS_JOURS_QUOTIDIEN);
    });
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.honores, b.noShow, b.annules]));
  const h = (v) => Math.round((v / max) * 100);

  const legende = `
    <div class="legende-graph">
      <span><i class="p-honores"></i>Honorés</span>
      <span><i class="p-noshow"></i>No-show</span>
      <span><i class="p-annules"></i>Annulés</span>
    </div>`;

  const colonnes = blocs
    .map((b) => {
      const libelle = libellePeriode(b, granularite);
      const bulle = `<strong>${libelle}</strong>
        <span><i class="p-honores"></i>Honorés<b>${nombre(b.honores)}</b></span>
        <span><i class="p-noshow"></i>No-show<b>${nombre(b.noShow)}</b></span>
        <span><i class="p-annules"></i>Annulés<b>${nombre(b.annules)}</b></span>
        <span class="bulle-pied">Appels prévus<b>${nombre(b.appelsPrevus)}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-honores" data-hauteur="${h(b.honores)}"></div>
            <div class="barre b-noshow"  data-hauteur="${h(b.noShow)}"></div>
            <div class="barre b-annules" data-hauteur="${h(b.annules)}"></div>
          </div>
        </div>
        <div class="jour">${libelle}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = toggle + legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);
  brancherToggleGranularite(cible, (g) => {
    GRANULARITE_QUOTIDIEN = g;
    graphiqueQuotidien(DERNIERS_JOURS_QUOTIDIEN);
  });

  requestAnimationFrame(() =>
    setTimeout(() => {
      cible.querySelectorAll(".barre").forEach((b) => {
        b.style.height = b.dataset.hauteur + "%";
      });
    }, 120)
  );
}

function vueQuotidien(lignes) {
  const cible = document.getElementById("quot-jour");
  const table = document.getElementById("quot-table");
  if (!cible || !table) return;

  const duJour = lignes.filter((l) => l.jour === AUJOURDHUI);
  const total = (jeu, champ) => somme(jeu, champ);

  const conclusJour = total(duJour, "honores") + total(duJour, "noShow");

  // Taux calculés uniquement à partir des compteurs du jour même (jamais
  // mélangés à la cohorte/au spend) : présence = honorés / issue connue ce
  // jour, closing = ventes / honorés ce jour. Cf. commentaire de l'API.
  const tauxPresenceJour = ratio(total(duJour, "honores"), conclusJour);
  const tauxClosingJour = ratio(total(duJour, "ventes"), total(duJour, "honores"));

  cible.innerHTML =
    carte("Appels prévus", nombre(total(duJour, "appelsPrevus")), "réservés pour aujourd'hui, tous statuts") +
    carte("Appels honorés", nombre(total(duJour, "honores")), conclusJour ? `sur ${nombre(conclusJour)} conclu${conclusJour > 1 ? "s" : ""} aujourd'hui` : "aucun appel conclu pour l'instant") +
    carte("Taux de présence", pourcent(tauxPresenceJour), conclusJour ? "honorés sur appels conclus aujourd'hui" : "aucun appel conclu pour l'instant") +
    carte("No-show", nombre(total(duJour, "noShow")), null) +
    carte("Annulés", nombre(total(duJour, "annules")), null) +
    carte("Taux de closing", pourcent(tauxClosingJour), total(duJour, "honores") ? "ventes sur honorés aujourd'hui" : "aucun appel honoré pour l'instant") +
    carte("Ventes signées", nombre(total(duJour, "ventes")), null) +
    carte("Contracté", euros(total(duJour, "contracte")), null);

  camembertQuotidien(duJour);

  // Table des 14 derniers jours, tous canaux/produits confondus par jour —
  // le détail canal/produit reste dans la vue cohorte.
  const parJour = new Map();
  lignes.forEach((l) => {
    if (!parJour.has(l.jour)) {
      parJour.set(l.jour, { jour: l.jour, appelsPrevus: 0, appelsConclus: 0, honores: 0, noShow: 0, annules: 0, ventes: 0, contracte: 0 });
    }
    const j = parJour.get(l.jour);
    ["appelsPrevus", "appelsConclus", "honores", "noShow", "annules", "ventes", "contracte"].forEach(
      (champ) => (j[champ] += l[champ] || 0)
    );
  });

  const parJourTous = [...parJour.values()].sort((a, b) => b.jour.localeCompare(a.jour));
  const jours = parJourTous.slice(0, 14);

  // Le graphique en bâtonnés prend tout l'historique dispo (le toggle
  // Semaine/Mois a besoin de plus que 14 jours pour être utile) ; la table
  // "Détail" ci-dessous reste bornée aux 14 derniers jours.
  graphiqueQuotidien(parJourTous);

  if (!jours.length) {
    table.innerHTML = `<div style="padding:28px;color:var(--txt3)">Aucune donnée.</div>`;
    return;
  }

  const cellulePourcent = (v) => `<td${v === null ? ' class="zero"' : ""}>${pourcent(v)}</td>`;

  const corps = jours
    .map((j) => {
      const conclus = j.honores + j.noShow;
      const tauxPresence = ratio(j.honores, conclus);
      const tauxClosing = ratio(j.ventes, j.honores);
      return `<tr${j.jour === AUJOURDHUI ? ' class="total"' : ""}>
        <td>${j.jour === AUJOURDHUI ? "<strong>Aujourd'hui</strong>" : jourCourt(j.jour)}</td>
        ${cellule(j.appelsPrevus)}
        ${cellule(j.honores)}
        ${cellulePourcent(tauxPresence)}
        ${cellule(j.noShow)}
        ${cellule(j.annules)}
        ${cellule(j.ventes)}
        ${cellulePourcent(tauxClosing)}
        ${cellule(j.contracte, euros)}
      </tr>`;
    })
    .join("");

  table.innerHTML = `
    <table>
      <thead><tr>
        <th>Jour</th><th>Appels prévus</th><th>Honorés</th><th>Taux présence</th><th>No-show</th><th>Annulés</th><th>Ventes</th><th>Taux closing</th><th>Contracté</th>
      </tr></thead>
      <tbody>${corps}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ */
/*  Tracking UTM — Source / Campagne / Content                        */
/* ------------------------------------------------------------------ */

// Données brutes de /api/tracking (une ligne par lead, une ligne par
// rendez-vous), séparées de TOUTES à dessein : la granularité UTM n'a pas
// d'équivalent agrégé côté Airtable, contrairement à ACQUISITION.
let TRACK_LEADS = [];
// TRACK_RDV = funnel principal, uniquement le 1er call Closing par lead
// (Rang R = 1) : un lead ne compte qu'une fois dans les cartes/classement/
// camemberts/courbe, quel que soit le nombre de calls qu'il a eu ensuite.
let TRACK_RDV = [];
// TRACK_RDV_TOUS = tous les calls Closing, tous rangs confondus (R1, R2, R3...)
// — uniquement pour le rapport R1/R2 plus bas, qui a justement besoin de voir
// les rangs suivants pour mesurer le taux de relance par UTM.
let TRACK_RDV_TOUS = [];

let TRACK_DIMENSION = "source"; // "source" | "campagne" | "content"
let TRACK_METRIQUE = "ca"; // "ca" | "present" | "booke"

// "Source" et "Canal" utilisent les champs de qualification (pas les UTM) :
// Source = Ads/Organique/Recommandation/Autre, Canal = Instagram/TikTok/Facebook...
// "Campagne" et "Content" restent les UTM bruts (granularité pub, pas de
// qualification équivalente ailleurs dans Airtable).
const TRACK_CHAMP = { source: "source", canal: "canal", campagne: "utmCampaign", content: "utmContent" };
const TRACK_LIBELLE = { source: "source", canal: "canal", campagne: "campagne", content: "content" };
const TRACK_NON_RENSEIGNE = "Non renseigné";

// Même filtre période (DEBUT/FIN) ET même filtre Canal/Produit/Source (barre
// commune) que le reste du dashboard, pour que les trois se répercutent aussi
// ici. Ici `l.source` est le vrai champ de qualification du lead/RDV (pas une
// dérivation depuis Canal comme pour les lignes ACQUISITION).
const parCanalEtProduitTrack = (lignes) =>
  lignes.filter(
    (l) =>
      (CANAL === "tout" || l.canal === CANAL) &&
      (PRODUIT === "tout" || l.produit === PRODUIT) &&
      (SOURCE === "tout" || l.source === SOURCE)
  );

const trackLignesFiltrees = () => ({
  leads: parCanalEtProduitTrack(TRACK_LEADS.filter(dansPeriode)),
  rdv: parCanalEtProduitTrack(TRACK_RDV.filter(dansPeriode)),
});

// Même logique de période précédente que le reste du dashboard (barre de
// comparaison commune), appliquée aux lignes brutes leads/RDV du tracking.
function trackLignesPrecedentes() {
  const plage = plagePrecedente();
  if (!plage) return null;
  const [a, b] = plage;
  const dansPlage = (l) => l.jour && l.jour >= a && l.jour <= b;

  return {
    leads: parCanalEtProduitTrack(TRACK_LEADS.filter(dansPlage)),
    rdv: parCanalEtProduitTrack(TRACK_RDV.filter(dansPlage)),
  };
}

// Même filtre période + Canal/Produit que trackLignesFiltrees, mais sur
// TRACK_RDV_TOUS (tous les rangs R) : sert uniquement au rapport R1/R2.
const trackRelancesFiltrees = () => parCanalEtProduitTrack(TRACK_RDV_TOUS.filter(dansPeriode));

// Rapport R1 / R2 : par valeur de la dimension active, combien de leads ont
// eu un 1er call Closing (R1) et combien sont repartis en relance (R2, R3...).
// Un taux de relance élevé sur une valeur donnée peut signaler des leads
// moins qualifiés/moins chauds sur ce canal (ils ne closent pas au 1er call).
function trackRapportR1R2(champ, rdvTous) {
  const cible = document.getElementById("tracking-rapport-r");
  if (!cible) return;

  const parValeur = {};
  const point = (cle) => (parValeur[cle] = parValeur[cle] || { r1: 0, relances: 0 });

  rdvTous.forEach((r) => {
    const p = point(r[champ] || TRACK_NON_RENSEIGNE);
    if (r.rangR === 1) p.r1 += 1;
    else if (r.rangR > 1) p.relances += 1;
  });

  const lignes = Object.entries(parValeur)
    .map(([nom, v]) => [nom, v.r1, v.relances, ratio(v.relances, v.r1)])
    .filter(([, r1, relances]) => r1 > 0 || relances > 0)
    .sort((a, b) => (b[3] ?? -1) - (a[3] ?? -1));

  if (!lignes.length) {
    cible.innerHTML = `<div class="vide">Aucun call Closing sur cette période.</div>`;
    return;
  }

  const totalR1 = lignes.reduce((s, [, r1]) => s + r1, 0);
  const totalRelances = lignes.reduce((s, [, , relances]) => s + relances, 0);
  const tauxGlobal = ratio(totalRelances, totalR1);

  const cellulePourcent = (v) => `<td${v === null ? ' class="zero"' : ""}>${pourcent(v)}</td>`;

  const corps = lignes
    .map(([nom, r1, relances, taux]) => `<tr>
        <td>${nom}</td>
        ${cellule(r1)}
        ${cellule(relances)}
        ${cellulePourcent(taux)}
      </tr>`)
    .join("");

  cible.innerHTML = `
    <table>
      <thead><tr>
        <th>${TRACK_LIBELLE[TRACK_DIMENSION]}</th><th>R1 (1er call)</th><th>Relances (R2+)</th><th>Taux de relance</th>
      </tr></thead>
      <tbody>${corps}</tbody>
      <tfoot><tr class="total">
        <td>Total</td>${cellule(totalR1)}${cellule(totalRelances)}${cellulePourcent(tauxGlobal)}
      </tr></tfoot>
    </table>`;
}

// NOTE (2026-10-01) : le CA/Ventes ici vient encore de l'outcome rempli par
// le closer sur CALL BOOKED (R1 uniquement, décision prise plus haut). Ce
// n'est pas la vraie source de vérité — à terme, le CA/Ventes doit être lu
// sur CLIENTS/CONTRATS/PAIEMENTS, une fois le lead rattaché à son
// enregistrement de vente (chantier à part). Pas touché pour l'instant.
function trackAgreger(champ, leads, rdv) {
  const parValeur = {};
  const point = (cle) => (parValeur[cle] = parValeur[cle] || { leads: 0, rdv: 0, present: 0, conclu: 0, ventes: 0, ca: 0 });

  leads.forEach((l) => { point(l[champ] || TRACK_NON_RENSEIGNE).leads += 1; });
  rdv.forEach((r) => {
    const p = point(r[champ] || TRACK_NON_RENSEIGNE);
    p.rdv += 1;
    p.present += r.present || 0;
    p.conclu += r.conclu || 0;
    p.ventes += r.vente || 0;
    p.ca += r.montant || 0;
  });

  return parValeur;
}

const TRACK_METRIQUES = {
  leads: {
    titre: "Classement par leads",
    valeur: (v) => v.leads,
    format: nombre,
    secondaire: () => null,
  },
  ca: {
    titre: "Classement par CA contracté",
    valeur: (v) => v.ca,
    format: euros,
    secondaire: () => null,
  },
  present: {
    titre: "Classement par rendez-vous honorés",
    valeur: (v) => v.present,
    format: nombre,
    secondaire: (v) => (v.conclu > 0 ? `${Math.round((v.present / v.conclu) * 100)} % de présence` : null),
  },
  booke: {
    titre: "Classement par rendez-vous booké",
    valeur: (v) => v.rdv,
    format: nombre,
    secondaire: () => null,
  },
  ventes: {
    titre: "Classement par ventes",
    valeur: (v) => v.ventes,
    format: nombre,
    secondaire: (v) => (v.present > 0 ? `${Math.round((v.ventes / v.present) * 100)} % de closing` : null),
  },
};

// vide-type pour une valeur UTM qui n'existait pas encore sur la période
// précédente (pas de ligne du tout pour ce nom-là) : traité comme 0, pas
// comme "pas de donnée" — "cette source est apparue" est une info en soi.
const TRACK_VIDE = { leads: 0, rdv: 0, present: 0, conclu: 0, ventes: 0, ca: 0 };

function trackClassement(valeurs, parValeurPrec) {
  const cible = document.getElementById("tracking-classement");
  if (!cible) return;

  const def = TRACK_METRIQUES[TRACK_METRIQUE];
  const classe = valeurs
    .map(([nom, v]) => [nom, def.valeur(v), def.secondaire(v), v])
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (!classe.length) {
    cible.innerHTML = `<div class="vide">Rien à classer sur cette période.</div>`;
    return;
  }

  const max = classe[0][1];

  const bulle = (nom, v) => `
    <strong>${nom}</strong>
    <span>Leads<b>${nombre(v.leads)}</b></span>
    <span>Call booké<b>${nombre(v.rdv)}</b></span>
    <span>Call présent<b>${nombre(v.present)}</b></span>
    <span>CA contracté<b>${euros(v.ca)}</b></span>
    ${v.conclu > 0 ? `<span class="bulle-pied">${Math.round((v.ventes / v.conclu) * 100)} % de closing · ${Math.round((v.present / v.conclu) * 100)} % de présence</span>` : ""}`;

  cible.innerHTML = classe
    .map(([nom, val, secondaire, v], i) => {
      // Écart vs la même valeur UTM sur la période précédente — c'est ici,
      // pas sur les cartes globales, que la comparaison a un sens : elle
      // porte bien sur la dimension active (ex: "Instagram ↑ 18 %").
      const ecart = parValeurPrec
        ? ecartDe(val, def.valeur(parValeurPrec[nom] || TRACK_VIDE), "track")
        : null;

      return `
      <div class="classement-ligne"${info(bulle(nom, v))}>
        <span class="classement-rang">${i + 1}</span>
        <span class="classement-nom">${nom}</span>
        <div class="classement-piste"><div class="classement-barre" style="width:${Math.max(4, Math.round((val / max) * 100))}%"></div></div>
        <div class="classement-chiffres">
          <span class="classement-valeur">${def.format(val)}${ecart ? `<span class="ecart-inline ${ecart.classe}">${ecart.texte}</span>` : ""}</span>
          ${secondaire ? `<span class="classement-secondaire">${secondaire}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");

  brancherInfobulles(cible);
}

function trackCamemberts(valeurs, parValeurPrec) {
  const cible = document.getElementById("tracking-camemberts");
  if (!cible) return;

  // Couleur stable par valeur UTM (ordre alphabétique) pour que les deux
  // disques (CA / Leads) utilisent la même teinte pour une même valeur.
  const noms = valeurs.map(([nom]) => nom).sort();
  const couleur = Object.fromEntries(noms.map((n, i) => [n, PALETTE[i % PALETTE.length]]));

  // Même principe que le classement : l'écart affiché sur chaque part vise
  // la valeur UTM de cette part-là, vs la période précédente — pas un total
  // global qui ne dit rien sur la répartition.
  const partsPour = (champVal) =>
    valeurs
      .map(([nom, v]) => {
        const ecart = parValeurPrec ? ecartDe(v[champVal], (parValeurPrec[nom] || TRACK_VIDE)[champVal], "track") : null;
        const badge = ecart ? `<span class="ecart-inline ${ecart.classe}">${ecart.texte}</span>` : null;
        return [nom, v[champVal], couleur[nom], badge];
      })
      .filter(([, val]) => val > 0)
      .sort((a, b) => b[1] - a[1]);

  const libelle = TRACK_LIBELLE[TRACK_DIMENSION];

  cible.innerHTML = [
    disque(`Leads par ${libelle}`, partsPour("leads"), nombre),
    disque(`Call booké par ${libelle}`, partsPour("rdv"), nombre),
    disque(`Call présent par ${libelle}`, partsPour("present"), nombre),
    disque(`Ventes par ${libelle}`, partsPour("ventes"), nombre),
    disque(`CA contracté par ${libelle}`, partsPour("ca"), euros),
  ].join("");

  brancherSurvol(cible);
}

// Carte de stat avec infobulle au survol (même gabarit que carte(), avec
// un attribut data-info en plus — carte() elle-même n'en a pas besoin
// ailleurs, donc on ne la modifie pas globalement).
const carteInfo = (libelle, chiffre, infoHtml, ecart) => `
  <div class="glass carte rv"${info(infoHtml)}>
    <div class="libelle">${libelle}</div>
    <div class="chiffre">${chiffre}</div>
    ${ecart ? `<div class="ecart ${ecart.classe}">${ecart.texte}</div>` : ""}
  </div>`;

// Répartition d'une carte de synthèse par la dimension active : top 6
// valeurs qui composent ce total, pour répondre à "combien de X, mais réparti
// comment ?" directement au survol — pas juste le total brut de la carte.
function trackBulleRepartition(titre, valeurs, champVal, format) {
  const libelle = TRACK_LIBELLE[TRACK_DIMENSION];
  const lignes = valeurs
    .map(([nom, v]) => [nom, v[champVal] || 0])
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!lignes.length) return `<strong>${titre}</strong><span class="bulle-pied">Rien à répartir sur cette période</span>`;

  const total = lignes.reduce((s, [, v]) => s + v, 0);
  const haut = lignes.slice(0, 6);
  const reste = lignes.length - haut.length;

  return `<strong>${titre} par ${libelle}</strong>` +
    haut.map(([nom, val]) => `<span>${nom}<b>${format(val)}</b></span>`).join("") +
    `<span class="bulle-pied">${reste > 0 ? `+ ${reste} autre${reste > 1 ? "s" : ""} · ` : ""}Total<b>${format(total)}</b></span>`;
}

// Boutons Jour/Semaine/Mois/Année pour la courbe — même mécanique que
// brancherToggleGranularite (générique sur data-granularite), gabarit à 4
// options au lieu de 2.
function toggleGranulariteCourbeHtml(actuelle) {
  const options = [["jour", "Jour"], ["semaine", "Semaine"], ["mois", "Mois"], ["annee", "Année"]];
  return `<div class="toggle-granularite">${options
    .map(([v, libelle]) => `<button type="button" class="${actuelle === v ? "actif" : ""}" data-granularite="${v}">${libelle}</button>`)
    .join("")}</div>`;
}

// Valeur de la métrique active pour une valeur UTM donnée, sur un seul bloc
// de la courbe (recalcule l'agrégat à partir des lignes brutes filtrées par
// nom+bloc — trackAgreger() agrège sur toute la période d'un coup, ici il
// faut un agrégat par tranche de temps).
function trackValeurBloc(nom, champ, leads, rdv, bloc) {
  const dansBloc = (l) => (l[champ] || TRACK_NON_RENSEIGNE) === nom && l.jour >= bloc.debut && l.jour <= bloc.fin;
  const lJ = leads.filter(dansBloc);
  const rJ = rdv.filter(dansBloc);

  const v = {
    leads: lJ.length,
    rdv: rJ.length,
    present: somme(rJ, "present"),
    conclu: somme(rJ, "conclu"),
    ventes: somme(rJ, "vente"),
    ca: somme(rJ, "montant"),
  };

  return TRACK_METRIQUES[TRACK_METRIQUE].valeur(v);
}

function trackCourbe(champ, leads, rdv, valeurs) {
  const cible = document.getElementById("tracking-courbe");
  if (!cible) return;

  const def = TRACK_METRIQUES[TRACK_METRIQUE];

  // Top 5 valeurs UTM sur la métrique active — au-delà, la courbe devient
  // illisible (même logique que le plafond à 10 des camemberts, en plus
  // strict ici car chaque valeur est une ligne entière, pas juste une part).
  const top5 = valeurs
    .map(([nom, v]) => [nom, def.valeur(v)])
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nom]) => nom);

  if (!top5.length) {
    cible.innerHTML = `${toggleGranulariteCourbeHtml(GRANULARITE_TRACKING)}<div class="vide">Rien à tracer sur cette période.</div>`;
    brancherToggleGranularite(cible, (g) => {
      GRANULARITE_TRACKING = g;
      trackCourbe(champ, leads, rdv, valeurs);
    });
    return;
  }

  // Même couleur que les camemberts pour une même valeur UTM : ordre
  // alphabétique sur TOUTES les valeurs (pas seulement le top 5), pour que
  // l'attribution d'index dans la palette reste stable d'un graphique à
  // l'autre.
  const nomsTries = valeurs.map(([nom]) => nom).sort();
  const couleur = Object.fromEntries(nomsTries.map((n, i) => [n, PALETTE[i % PALETTE.length]]));

  const jours = [...new Set([...leads, ...rdv].map((l) => l.jour).filter(Boolean))].sort();
  const blocs = decoupagePeriodesEtendu(jours, GRANULARITE_TRACKING);

  const series = top5.map((nom) => ({
    nom,
    couleur: couleur[nom],
    points: blocs.map((b) => trackValeurBloc(nom, champ, leads, rdv, b)),
  }));

  const max = Math.max(1, ...series.flatMap((s) => s.points));

  // Marge de droite plus large que les autres : c'est là que vient s'écrire
  // le nom de fin de ligne. Marge de gauche élargie pour loger les valeurs
  // de l'axe Y (sans elles, la grille ne donne aucune échelle concrète).
  const L = 1000, H = 300, M_HAUT = 16, M_BAS = 34, M_GAUCHE = 46, M_DROITE = 108;
  const largeurUtile = L - M_GAUCHE - M_DROITE;
  const hauteurUtile = H - M_HAUT - M_BAS;
  const x = (i) => (blocs.length > 1 ? M_GAUCHE + (i * largeurUtile) / (blocs.length - 1) : M_GAUCHE + largeurUtile / 2);
  const y = (v) => M_HAUT + hauteurUtile - (v / max) * hauteurUtile;

  // Grille + échelle : sans les valeurs à gauche, une courbe ne dit rien de
  // la tendance réelle (de combien à combien ?) — chaque ligne de grille
  // porte maintenant sa valeur, formatée comme la métrique active.
  const grille = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const yy = (M_HAUT + hauteurUtile * (1 - t)).toFixed(1);
      const valeurAxe = def.format(Math.round(max * t));
      return `<line x1="${M_GAUCHE}" x2="${L - M_DROITE}" y1="${yy}" y2="${yy}" class="courbe-grille" />
        <text x="${M_GAUCHE - 10}" y="${yy}" class="courbe-axe-y" text-anchor="end" dominant-baseline="middle">${valeurAxe}</text>`;
    })
    .join("");

  // Pas tous les libellés d'axe si trop de blocs (ex: vue "Jour" sur 60 jours)
  // — un sur N pour rester lisible, toujours en gardant le premier/dernier.
  const PAS_AXE = Math.max(1, Math.ceil(blocs.length / 8));
  const axeX = blocs
    .map((b, i) => (i % PAS_AXE === 0 || i === blocs.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" class="courbe-axe" text-anchor="middle">${libellePeriodeEtendu(b, GRANULARITE_TRACKING)}</text>` : ""))
    .join("");

  // Courbe lissée par interpolation monotone (Hermite cubique, méthode
  // Fritsch-Carlson) plutôt que Catmull-Rom : Catmull-Rom dépasse les valeurs
  // réelles entre deux points (il "fait des collines" même entre deux zéros
  // dès qu'un pic est à proximité), ce qui rendait le graphique trompeur et
  // illisible sur des séries à beaucoup de zéros. La version monotone ne
  // dépasse jamais le min/max des deux points qu'elle relie.
  const cheminLisse = (pts) => {
    const n = pts.length;
    if (n < 2) return "";
    if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;

    const dx = [];
    const d = []; // pente de chaque segment
    for (let i = 0; i < n - 1; i++) {
      dx.push(pts[i + 1][0] - pts[i][0]);
      d.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
    }

    const m = [d[0]];
    for (let i = 1; i < n - 1; i++) m.push((d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);

    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      if (a < 0) m[i] = 0;
      if (b < 0) m[i + 1] = 0;
      const s2 = a * a + b * b;
      if (s2 > 9) {
        const tau = 3 / Math.sqrt(s2);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }

    let chemin = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const c1x = (pts[i][0] + dx[i] / 3).toFixed(1);
      const c1y = (pts[i][1] + (m[i] * dx[i]) / 3).toFixed(1);
      const c2x = (pts[i + 1][0] - dx[i] / 3).toFixed(1);
      const c2y = (pts[i + 1][1] - (m[i + 1] * dx[i]) / 3).toFixed(1);
      chemin += ` C${c1x},${c1y} ${c2x},${c2y} ${pts[i + 1][0]},${pts[i + 1][1]}`;
    }
    return chemin;
  };

  // ID de dégradé unique par série (couleur -> transparent), pour remplir
  // l'aire sous chaque courbe et donner tout de suite une masse visuelle à la
  // tendance, pas juste un trait fin perdu dans la carte.
  const pointsParSerie = series.map((s) => s.points.map((v, i) => [Number(x(i).toFixed(1)), Number(y(v).toFixed(1))]));
  const tracesParSerie = pointsParSerie.map(cheminLisse);

  const degrades = series
    .map(
      (s, i) => `<linearGradient id="courbe-degrade-${i}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.couleur}" stop-opacity="0.32" />
        <stop offset="100%" stop-color="${s.couleur}" stop-opacity="0" />
      </linearGradient>`
    )
    .join("");

  const baseY = (M_HAUT + hauteurUtile).toFixed(1);
  const aires = series
    .map((s, i) => {
      const pts = pointsParSerie[i];
      const aireD = `${tracesParSerie[i]} L${pts[pts.length - 1][0]},${baseY} L${pts[0][0]},${baseY} Z`;
      return `<path d="${aireD}" fill="url(#courbe-degrade-${i})" class="courbe-aire"></path>`;
    })
    .join("");

  const lignesSvg = series
    .map((s, i) => `<path d="${tracesParSerie[i]}" fill="none" stroke="${s.couleur}" stroke-width="2.75" class="courbe-ligne" />`)
    .join("");

  // Libellés de fin de ligne : juste le nom (la valeur exacte vient du
  // curseur au survol, voir plus bas) — avec un écart minimal entre eux pour
  // ne pas se chevaucher quand plusieurs courbes finissent proches. Les noms
  // UTM réels peuvent être très longs (campagnes Meta, IDs bruts) : tronqués
  // ici pour tenir dans la marge de droite, le nom complet reste visible dans
  // la légende au-dessus du graphique et dans l'infobulle au survol.
  const MAX_CAR_LABEL = 20;
  const tronqueLabel = (texte) => (texte.length > MAX_CAR_LABEL ? `${texte.slice(0, MAX_CAR_LABEL - 1)}…` : texte);
  const MIN_ECART_LABEL = 15;
  const labelsFin = series
    .map((s, i) => ({ s, yBrut: y(s.points[s.points.length - 1]) }))
    .sort((a, b) => a.yBrut - b.yBrut)
    .reduce((acc, cur, i) => {
      const yPlace = i === 0 ? cur.yBrut : Math.max(cur.yBrut, acc[i - 1].yPlace + MIN_ECART_LABEL);
      acc.push({ ...cur, yPlace });
      return acc;
    }, [])
    .map(({ s, yPlace }) => `<text x="${(x(blocs.length - 1) + 10).toFixed(1)}" y="${yPlace.toFixed(1)}" class="courbe-label" fill="${s.couleur}" dominant-baseline="middle"><title>${s.nom}</title>${tronqueLabel(s.nom)}</text>`)
    .join("");

  // Curseur de survol synchronisé : une ligne verticale + un point par série
  // à l'index survolé, une seule bulle qui regroupe toutes les valeurs de ce
  // jour-là — bien plus lisible que deviner quelle courbe on frôle au pixel
  // près. Les éléments existent dès le rendu (opacity 0), le JS ci-dessous
  // se contente de les repositionner/afficher au survol.
  const pointsCurseur = series
    .map((s, i) => `<circle class="courbe-curseur-point" data-i="${i}" r="4.5" fill="${s.couleur}" cx="${x(0)}" cy="${y(s.points[0])}" opacity="0"></circle>`)
    .join("");

  const legende = `<div class="legende-graph">${series.map((s) => `<span><i style="background:${s.couleur}"></i>${s.nom}</span>`).join("")}</div>`;

  cible.innerHTML = `
    ${toggleGranulariteCourbeHtml(GRANULARITE_TRACKING)}
    ${legende}
    <svg class="courbe-svg" viewBox="0 0 ${L} ${H}">
      <defs>${degrades}</defs>
      ${grille}
      ${aires}
      ${lignesSvg}
      <line class="courbe-curseur-ligne" x1="${x(0)}" x2="${x(0)}" y1="${M_HAUT}" y2="${M_HAUT + hauteurUtile}" opacity="0"></line>
      ${pointsCurseur}
      <rect class="courbe-survol" x="${M_GAUCHE}" y="${M_HAUT}" width="${largeurUtile}" height="${hauteurUtile}" fill="transparent"></rect>
      ${axeX}
      ${labelsFin}
    </svg>`;

  brancherToggleGranularite(cible, (g) => {
    GRANULARITE_TRACKING = g;
    trackCourbe(champ, leads, rdv, valeurs);
  });

  // Survol synchronisé : on retrouve l'index de bloc le plus proche du
  // curseur, on déplace la ligne verticale + les points dessus, et on affiche
  // une bulle unique (réutilise le composant infobulle partagé) avec toutes
  // les valeurs de ce jour-là, triées de la plus grande à la plus petite.
  const svg = cible.querySelector(".courbe-svg");
  const zoneSurvol = cible.querySelector(".courbe-survol");
  const ligneCurseur = cible.querySelector(".courbe-curseur-ligne");
  const pointsCurseurEls = [...cible.querySelectorAll(".courbe-curseur-point")];

  if (!INFOBULLE) {
    INFOBULLE = document.createElement("div");
    INFOBULLE.className = "infobulle";
    document.body.appendChild(INFOBULLE);
  }

  const placerBulle = (evt) => {
    const marge = 16;
    const r = INFOBULLE.getBoundingClientRect();
    let gauche = evt.clientX + marge;
    let haut = evt.clientY - r.height - marge;
    if (gauche + r.width > window.innerWidth - 8) gauche = evt.clientX - r.width - marge;
    if (haut < 8) haut = evt.clientY + marge;
    INFOBULLE.style.left = gauche + "px";
    INFOBULLE.style.top = haut + "px";
  };

  const survol = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const ratio = blocs.length > 1 ? (loc.x - M_GAUCHE) / largeurUtile : 0;
    const index = Math.min(blocs.length - 1, Math.max(0, Math.round(ratio * (blocs.length - 1))));

    const xi = x(index).toFixed(1);
    ligneCurseur.setAttribute("x1", xi);
    ligneCurseur.setAttribute("x2", xi);
    ligneCurseur.setAttribute("opacity", "1");

    const lignesBulle = series
      .map((s, i) => ({ s, v: s.points[index] }))
      .sort((a, b) => b.v - a.v)
      .map(({ s, v }) => `<span><i style="background:${s.couleur}"></i>${s.nom}<b>${def.format(v)}</b></span>`)
      .join("");

    series.forEach((s, i) => {
      pointsCurseurEls[i].setAttribute("cx", xi);
      pointsCurseurEls[i].setAttribute("cy", y(s.points[index]).toFixed(1));
      pointsCurseurEls[i].setAttribute("opacity", "1");
    });

    INFOBULLE.innerHTML = `<strong>${libellePeriodeEtendu(blocs[index], GRANULARITE_TRACKING)}</strong>${lignesBulle}`;
    INFOBULLE.classList.add("on");
    placerBulle(evt);
  };

  const quitter = () => {
    ligneCurseur.setAttribute("opacity", "0");
    pointsCurseurEls.forEach((p) => p.setAttribute("opacity", "0"));
    INFOBULLE.classList.remove("on");
  };

  zoneSurvol.addEventListener("mousemove", survol);
  zoneSurvol.addEventListener("mouseleave", quitter);
}

function vueTracking() {
  const cible = document.getElementById("vue-tracking");
  if (!cible) return;

  const champ = TRACK_CHAMP[TRACK_DIMENSION];
  const { leads, rdv } = trackLignesFiltrees();
  const parValeur = trackAgreger(champ, leads, rdv);
  const valeurs = Object.entries(parValeur);

  const totalCa = somme(rdv, "montant");
  const totalPresent = somme(rdv, "present");
  const totalVentes = somme(rdv, "vente");

  // Comparaison à la période précédente, même principe que les autres onglets.
  const precedentes = trackLignesPrecedentes();
  const ecartLeads = precedentes ? ecartDe(leads.length, precedentes.leads.length, "leads") : null;
  const ecartRdv = precedentes ? ecartDe(rdv.length, precedentes.rdv.length, "rendezVous") : null;
  const ecartPresent = precedentes ? ecartDe(totalPresent, somme(precedentes.rdv, "present"), "honores") : null;
  const ecartVentes = precedentes ? ecartDe(totalVentes, somme(precedentes.rdv, "vente"), "ventes") : null;
  const ecartCa = precedentes ? ecartDe(totalCa, somme(precedentes.rdv, "montant"), "contracte") : null;

  const cartesCible = document.getElementById("tracking-cartes");
  cartesCible.innerHTML = [
    carteInfo("Leads", nombre(leads.length), trackBulleRepartition("Leads", valeurs, "leads", nombre), ecartLeads),
    carteInfo("RDV booké", nombre(rdv.length), trackBulleRepartition("RDV booké", valeurs, "rdv", nombre), ecartRdv),
    carteInfo("RDV honoré", nombre(totalPresent), trackBulleRepartition("RDV honoré", valeurs, "present", nombre), ecartPresent),
    carteInfo("Ventes", nombre(totalVentes), trackBulleRepartition("Ventes", valeurs, "ventes", nombre), ecartVentes),
    carteInfo("CA contracté", euros(totalCa), trackBulleRepartition("CA contracté", valeurs, "ca", euros), ecartCa),
  ].join("");
  brancherInfobulles(cartesCible);

  // Même agrégation que parValeur, mais sur la période précédente, pour
  // comparer chaque valeur UTM à elle-même d'une période à l'autre dans le
  // classement et les camemberts (pas juste un total global comme sur les
  // cartes ci-dessus).
  const parValeurPrec = precedentes ? trackAgreger(champ, precedentes.leads, precedentes.rdv) : null;

  trackClassement(valeurs, parValeurPrec);
  trackCourbe(champ, leads, rdv, valeurs);
  trackCamemberts(valeurs, parValeurPrec);
  trackRapportR1R2(champ, trackRelancesFiltrees());

  // Les cartes/classement/courbe/camemberts ci-dessus viennent d'être reconstruits
  // (innerHTML) : ce sont de nouveaux éléments ".rv", jamais observés par
  // l'IntersectionObserver d'apparitions() (qui n'observe qu'une fois, au
  // premier rendu de la vue). Sans ce ré-armement, ils resteraient invisibles
  // pour toujours après un clic sur un toggle Source/Canal/.../métrique.
  requestAnimationFrame(() => apparitions(cible));
}

function brancherTracking() {
  const brancherToggle = (id, attribut, onChoix) => {
    const zone = document.getElementById(id);
    if (!zone) return;
    zone.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("actif")) return;
        zone.querySelectorAll("button").forEach((b) => b.classList.remove("actif"));
        btn.classList.add("actif");
        onChoix(btn.dataset[attribut]);
        vueTracking();
      });
    });
  };

  brancherToggle("tracking-dimension", "dimension", (v) => (TRACK_DIMENSION = v));
  brancherToggle("tracking-metrique", "metrique", (v) => (TRACK_METRIQUE = v));
}

/* ------------------------------------------------------------------ */
/*  Sales Team — Closing & Setting                                     */
/* ------------------------------------------------------------------ */

let SALES_LEADS = [];
let CLIENTS_DETAIL = [];
let SALES_CALLS = [];
let SALES_CLOSER = "tout";
let SALES_SETTER = "tout";
// Périmètre de rang R pour les métriques de PERFORMANCE de Closing (taux,
// classement, courbe) — "r1" (par défaut) isole le 1er call sur chaque lead,
// comme Tracking le fait déjà pour ses KPI d'acquisition (rangR === 1) ; un
// lead relancé plusieurs fois ne doit pas gonfler le volume de performance.
// Les cartes de volume (RDV/ventes/CA) et les camemberts restent sur TOUS
// les rangs quel que soit ce réglage : c'est le business réel, relances
// comprises — décision du 2026-10-04 (demande utilisateur).
let SALES_CLOSING_RANG = "r1";

// Closing : calls Closing de CALL BOOKED, filtrés période + closer actif.
const salesCallsClosing = () =>
  SALES_CALLS.filter(
    (c) => c.typeAppel === "Closing" && dansPeriode(c) && (SALES_CLOSER === "tout" || c.closer === SALES_CLOSER)
  );

function salesToggleHtml(noms, actif, attribut) {
  return (
    `<button type="button" class="${actif === "tout" ? "actif" : ""}" data-${attribut}="tout">Tous</button>` +
    noms.map((n) => `<button type="button" class="${actif === n ? "actif" : ""}" data-${attribut}="${n}">${n}</button>`).join("")
  );
}

function brancherSalesToggle(id, noms, getActif, onChoix, rerender) {
  const zone = document.getElementById(id);
  if (!zone) return;
  zone.innerHTML = salesToggleHtml(noms, getActif(), id);
  // `id` contient des tirets (ex: "sales-closing-filtre") : btn.dataset[id] ne
  // marche pas (dataset expose la version camelCase, pas la clé kebab-case
  // brute) et renvoyait toujours undefined — c'était le même bug qu'au
  // premier jet du toggle Tracking. On relit l'attribut directement.
  zone.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("actif")) return;
      onChoix(btn.getAttribute("data-" + id));
      rerender();
    });
  });
}

// Toggle R1 uniquement / Tous les rangs — restreint les métriques de
// PERFORMANCE de Closing (taux, classement, courbe) au 1er call sur chaque
// lead par défaut. Même correctif d'attribut brut que brancherSalesToggle.
function salesRangToggleHtml(id, actif) {
  return (
    `<button type="button" class="${actif === "r1" ? "actif" : ""}" data-${id}="r1">R1 uniquement</button>` +
    `<button type="button" class="${actif === "tous" ? "actif" : ""}" data-${id}="tous">Tous les rangs</button>`
  );
}

function brancherSalesRangToggle(id, getActif, onChoix, rerender) {
  const zone = document.getElementById(id);
  if (!zone) return;
  zone.innerHTML = salesRangToggleHtml(id, getActif());
  zone.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("actif")) return;
      onChoix(btn.getAttribute("data-" + id));
      rerender();
    });
  });
}

// Courbe multi-séries générique (aires dégradées + curseur interactif),
// adaptée de trackCourbe() pour être réutilisable hors Tracking UTM : même
// rendu visuel, mais cibleId/blocs/series/format/granularité passés en
// paramètres au lieu de dépendre des globales TRACK_*.
function courbeMultiSeries(cibleId, blocs, series, format, granulariteActuelle, onGranularite) {
  const cible = document.getElementById(cibleId);
  if (!cible) return;

  if (!series.length) {
    cible.innerHTML = `${toggleGranulariteCourbeHtml(granulariteActuelle)}<div class="vide">Rien à tracer sur cette période.</div>`;
    brancherToggleGranularite(cible, onGranularite);
    return;
  }

  const max = Math.max(1, ...series.flatMap((s) => s.points));

  const L = 1000, H = 300, M_HAUT = 16, M_BAS = 34, M_GAUCHE = 46, M_DROITE = 108;
  const largeurUtile = L - M_GAUCHE - M_DROITE;
  const hauteurUtile = H - M_HAUT - M_BAS;
  const x = (i) => (blocs.length > 1 ? M_GAUCHE + (i * largeurUtile) / (blocs.length - 1) : M_GAUCHE + largeurUtile / 2);
  const y = (v) => M_HAUT + hauteurUtile - (v / max) * hauteurUtile;

  const grille = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const yy = (M_HAUT + hauteurUtile * (1 - t)).toFixed(1);
      const valeurAxe = format(Math.round(max * t));
      return `<line x1="${M_GAUCHE}" x2="${L - M_DROITE}" y1="${yy}" y2="${yy}" class="courbe-grille" />
        <text x="${M_GAUCHE - 10}" y="${yy}" class="courbe-axe-y" text-anchor="end" dominant-baseline="middle">${valeurAxe}</text>`;
    })
    .join("");

  const PAS_AXE = Math.max(1, Math.ceil(blocs.length / 8));
  const axeX = blocs
    .map((b, i) => (i % PAS_AXE === 0 || i === blocs.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 10}" class="courbe-axe" text-anchor="middle">${libellePeriodeEtendu(b, granulariteActuelle)}</text>` : ""))
    .join("");

  const cheminLisse = (pts) => {
    const n = pts.length;
    if (n < 2) return "";
    if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;

    const dx = [];
    const d = [];
    for (let i = 0; i < n - 1; i++) {
      dx.push(pts[i + 1][0] - pts[i][0]);
      d.push((pts[i + 1][1] - pts[i][1]) / (dx[i] || 1));
    }

    const m = [d[0]];
    for (let i = 1; i < n - 1; i++) m.push((d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);

    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      if (a < 0) m[i] = 0;
      if (b < 0) m[i + 1] = 0;
      const s2 = a * a + b * b;
      if (s2 > 9) {
        const tau = 3 / Math.sqrt(s2);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }

    let chemin = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const c1x = (pts[i][0] + dx[i] / 3).toFixed(1);
      const c1y = (pts[i][1] + (m[i] * dx[i]) / 3).toFixed(1);
      const c2x = (pts[i + 1][0] - dx[i] / 3).toFixed(1);
      const c2y = (pts[i + 1][1] - (m[i + 1] * dx[i]) / 3).toFixed(1);
      chemin += ` C${c1x},${c1y} ${c2x},${c2y} ${pts[i + 1][0]},${pts[i + 1][1]}`;
    }
    return chemin;
  };

  const pointsParSerie = series.map((s) => s.points.map((v, i) => [Number(x(i).toFixed(1)), Number(y(v).toFixed(1))]));
  const tracesParSerie = pointsParSerie.map(cheminLisse);

  const degrades = series
    .map(
      (s, i) => `<linearGradient id="courbe-degrade-${cibleId}-${i}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.couleur}" stop-opacity="0.32" />
        <stop offset="100%" stop-color="${s.couleur}" stop-opacity="0" />
      </linearGradient>`
    )
    .join("");

  const baseY = (M_HAUT + hauteurUtile).toFixed(1);
  const aires = series
    .map((s, i) => {
      const pts = pointsParSerie[i];
      const aireD = `${tracesParSerie[i]} L${pts[pts.length - 1][0]},${baseY} L${pts[0][0]},${baseY} Z`;
      return `<path d="${aireD}" fill="url(#courbe-degrade-${cibleId}-${i})" class="courbe-aire"></path>`;
    })
    .join("");

  const lignesSvg = series
    .map((s, i) => `<path d="${tracesParSerie[i]}" fill="none" stroke="${s.couleur}" stroke-width="2.75" class="courbe-ligne" />`)
    .join("");

  // `secondaires` (optionnel, par série) : un taux complémentaire déjà
  // formaté en texte (ex: "62 % présence") pour chaque point — affiché à
  // côté du nom en fin de ligne (dernier point), et pour le point survolé
  // dans la bulle (voir plus bas).
  const MAX_CAR_LABEL = 20;
  const tronqueLabel = (texte) => (texte.length > MAX_CAR_LABEL ? `${texte.slice(0, MAX_CAR_LABEL - 1)}…` : texte);
  const MIN_ECART_LABEL = 15;
  const labelsFin = series
    .map((s, i) => ({ s, yBrut: y(s.points[s.points.length - 1]) }))
    .sort((a, b) => a.yBrut - b.yBrut)
    .reduce((acc, cur, i) => {
      const yPlace = i === 0 ? cur.yBrut : Math.max(cur.yBrut, acc[i - 1].yPlace + MIN_ECART_LABEL);
      acc.push({ ...cur, yPlace });
      return acc;
    }, [])
    .map(({ s, yPlace }) => {
      const dernierSecondaire = s.secondaires ? s.secondaires[s.secondaires.length - 1] : null;
      return `<text x="${(x(blocs.length - 1) + 10).toFixed(1)}" y="${yPlace.toFixed(1)}" class="courbe-label" fill="${s.couleur}" dominant-baseline="middle"><title>${s.nom}</title>${tronqueLabel(s.nom)}${dernierSecondaire ? ` (${dernierSecondaire})` : ""}</text>`;
    })
    .join("");

  const pointsCurseur = series
    .map((s, i) => `<circle class="courbe-curseur-point" data-i="${i}" r="4.5" fill="${s.couleur}" cx="${x(0)}" cy="${y(s.points[0])}" opacity="0"></circle>`)
    .join("");

  const legende = `<div class="legende-graph">${series.map((s) => `<span><i style="background:${s.couleur}"></i>${s.nom}</span>`).join("")}</div>`;

  cible.innerHTML = `
    ${toggleGranulariteCourbeHtml(granulariteActuelle)}
    ${legende}
    <svg class="courbe-svg" viewBox="0 0 ${L} ${H}">
      <defs>${degrades}</defs>
      ${grille}
      ${aires}
      ${lignesSvg}
      <line class="courbe-curseur-ligne" x1="${x(0)}" x2="${x(0)}" y1="${M_HAUT}" y2="${M_HAUT + hauteurUtile}" opacity="0"></line>
      ${pointsCurseur}
      <rect class="courbe-survol" x="${M_GAUCHE}" y="${M_HAUT}" width="${largeurUtile}" height="${hauteurUtile}" fill="transparent"></rect>
      ${axeX}
      ${labelsFin}
    </svg>`;

  brancherToggleGranularite(cible, onGranularite);

  const svg = cible.querySelector(".courbe-svg");
  const zoneSurvol = cible.querySelector(".courbe-survol");
  const ligneCurseur = cible.querySelector(".courbe-curseur-ligne");
  const pointsCurseurEls = [...cible.querySelectorAll(".courbe-curseur-point")];

  if (!INFOBULLE) {
    INFOBULLE = document.createElement("div");
    INFOBULLE.className = "infobulle";
    document.body.appendChild(INFOBULLE);
  }

  const placerBulle = (evt) => {
    const marge = 16;
    const r = INFOBULLE.getBoundingClientRect();
    let gauche = evt.clientX + marge;
    let haut = evt.clientY - r.height - marge;
    if (gauche + r.width > window.innerWidth - 8) gauche = evt.clientX - r.width - marge;
    if (haut < 8) haut = evt.clientY + marge;
    INFOBULLE.style.left = gauche + "px";
    INFOBULLE.style.top = haut + "px";
  };

  const survol = (evt) => {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const ratioX = blocs.length > 1 ? (loc.x - M_GAUCHE) / largeurUtile : 0;
    const index = Math.min(blocs.length - 1, Math.max(0, Math.round(ratioX * (blocs.length - 1))));

    const xi = x(index).toFixed(1);
    ligneCurseur.setAttribute("x1", xi);
    ligneCurseur.setAttribute("x2", xi);
    ligneCurseur.setAttribute("opacity", "1");

    const lignesBulle = series
      .map((s, i) => ({ s, v: s.points[index], secondaire: s.secondaires ? s.secondaires[index] : null }))
      .sort((a, b) => b.v - a.v)
      .map(({ s, v, secondaire }) => `<span><i style="background:${s.couleur}"></i>${s.nom}<b>${format(v)}${secondaire ? ` · ${secondaire}` : ""}</b></span>`)
      .join("");

    series.forEach((s, i) => {
      pointsCurseurEls[i].setAttribute("cx", xi);
      pointsCurseurEls[i].setAttribute("cy", y(s.points[index]).toFixed(1));
      pointsCurseurEls[i].setAttribute("opacity", "1");
    });

    INFOBULLE.innerHTML = `<strong>${libellePeriodeEtendu(blocs[index], granulariteActuelle)}</strong>${lignesBulle}`;
    INFOBULLE.classList.add("on");
    placerBulle(evt);
  };

  const quitter = () => {
    ligneCurseur.setAttribute("opacity", "0");
    pointsCurseurEls.forEach((p) => p.setAttribute("opacity", "0"));
    INFOBULLE.classList.remove("on");
  };

  zoneSurvol.addEventListener("mousemove", survol);
  zoneSurvol.addEventListener("mouseleave", quitter);
}

let GRANULARITE_SALES_CLOSING = "semaine";
let SALES_CLOSING_METRIQUE = "ca"; // "booke" | "present" | "ventes" | "ca"

// Métriques sélectionnables sur le graphique d'évolution Closing — même
// structure que TRACK_METRIQUES (titre court pour le toggle, valeur extraite
// d'un agrégat {rdv,conclus,honores,ventes,ca}, format d'affichage, taux
// secondaire optionnel affiché à côté du nom et dans la bulle de survol).
const SALES_METRIQUES = {
  booke: {
    libelleCourt: "Call booké",
    valeur: (v) => v.rdv,
    format: nombre,
    secondaire: () => null,
  },
  present: {
    libelleCourt: "Call présent",
    valeur: (v) => v.honores,
    format: nombre,
    secondaire: (v) => (v.conclus > 0 ? `${Math.round((v.honores / v.conclus) * 100)} % présence` : null),
  },
  ventes: {
    libelleCourt: "Ventes",
    valeur: (v) => v.ventes,
    format: nombre,
    secondaire: (v) => (v.honores > 0 ? `${Math.round((v.ventes / v.honores) * 100)} % closing` : null),
  },
  ca: {
    libelleCourt: "CA",
    valeur: (v) => v.ca,
    format: euros,
    secondaire: () => null,
  },
};

// Agrégat {rdv,conclus,honores,ventes,ca} d'un closer sur un seul bloc de
// temps — base commune pour toutes les métriques du toggle ci-dessus (avant,
// ne renvoyait que le CA, ce qui ne permettait pas de changer de métrique).
function salesStatsBlocCloser(nom, calls, bloc) {
  const dansBloc = calls.filter((c) => (c.closer || "Non renseigné") === nom && c.jour >= bloc.debut && c.jour <= bloc.fin);
  return {
    rdv: dansBloc.length,
    conclus: somme(dansBloc, "conclu"),
    honores: somme(dansBloc, "present"),
    ventes: somme(dansBloc, "vente"),
    ca: somme(dansBloc, "montant"),
  };
}

// `metriquesObj` générique (pas figé sur SALES_METRIQUES) pour pouvoir
// réutiliser le même toggle sur Closing (SALES_METRIQUES) et sur chaque
// famille Setting (jeu de métriques propre au vocabulaire transfo/rattrapage).
function salesMetriqueToggleHtml(id, metriquesObj, actif) {
  return Object.entries(metriquesObj)
    .map(([cle, def]) => `<button type="button" class="${actif === cle ? "actif" : ""}" data-${id}="${cle}">${def.libelleCourt}</button>`)
    .join("");
}

// Même correctif que brancherSalesToggle : `id` contient des tirets, donc on
// lit l'attribut brut plutôt que btn.dataset[id].
function brancherSalesMetrique(id, metriquesObj, getActif, onChoix, rerender) {
  const zone = document.getElementById(id);
  if (!zone) return;
  zone.innerHTML = salesMetriqueToggleHtml(id, metriquesObj, getActif());
  zone.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("actif")) return;
      onChoix(btn.getAttribute("data-" + id));
      rerender();
    });
  });
}

// Classement générique (closer ou setter) — même principe que
// trackClassement (Tracking UTM) : barre proportionnelle au max, valeur +
// taux secondaire de la métrique active, bulle de détail au survol. `entries`
// est un tableau [nom, statsObj] (déjà agrégé par nom, pas encore trié).
function salesRenduClassement(cibleId, entries, metriquesObj, metriqueActive, bulleFn) {
  const cible = document.getElementById(cibleId);
  if (!cible) return;

  const def = metriquesObj[metriqueActive];
  const classe = entries
    .map(([nom, v]) => [nom, def.valeur(v), def.secondaire(v), v])
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!classe.length) {
    cible.innerHTML = `<div class="vide">Rien à classer sur cette période.</div>`;
    return;
  }

  const max = classe[0][1];

  cible.innerHTML = classe
    .map(
      ([nom, val, secondaire, v], i) => `
      <div class="classement-ligne"${info(bulleFn(nom, v))}>
        <span class="classement-rang">${i + 1}</span>
        <span class="classement-nom">${nom}</span>
        <div class="classement-piste"><div class="classement-barre" style="width:${Math.max(4, Math.round((val / max) * 100))}%"></div></div>
        <div class="classement-chiffres">
          <span class="classement-valeur">${def.format(val)}</span>
          ${secondaire ? `<span class="classement-secondaire">${secondaire}</span>` : ""}
        </div>
      </div>`
    )
    .join("");

  brancherInfobulles(cible);
}

// Agrégat complet (volumes + taux) d'un jeu de calls Closing — factorisé pour
// être calculé identiquement sur la période actuelle et la période
// précédente (comparaison ↑/↓ sur les cartes).
function salesStatsCallsClosing(calls) {
  const rdv = calls.length;
  const conclus = somme(calls, "conclu");
  const honores = somme(calls, "present");
  const ventes = somme(calls, "vente");
  const ca = somme(calls, "montant");
  const annules = calls.filter((c) => c.statut === "Annulé").length;
  return {
    rdv,
    conclus,
    honores,
    ventes,
    ca,
    annules,
    presence: ratio(honores, conclus),
    closing: ratio(ventes, honores),
    annulation: ratio(annules, rdv),
    panier: ventes > 0 ? ca / ventes : null,
  };
}

// Calls Closing de la période précédente (même filtre closer), pour les
// badges ↑/↓ sur les cartes — `null` si la comparaison est désactivée
// (COMPARAISON === "aucune").
function salesCallsClosingPrecedentes() {
  const plage = plagePrecedente();
  if (!plage) return null;
  const [a, b] = plage;
  return SALES_CALLS.filter(
    (c) => c.typeAppel === "Closing" && c.jour && c.jour >= a && c.jour <= b && (SALES_CLOSER === "tout" || c.closer === SALES_CLOSER)
  );
}

// Agrégat R1 vs R2+ pour la section "Relation R1 / R2" — même population de
// calls Closing que le reste de l'onglet (`calls` dans vueSalesClosing : tous
// rangs confondus, période + closer actif déjà appliqués), juste éclatée par
// rang pour comparer le 1er call à la relance.
//
// Le chiffre principal (le donut) répond à UNE question précise : parmi les
// R1 qui ont effectivement eu lieu (présents), combien repartent en relance
// R2+ ? Un R1 non honoré n'a pas eu de conversation, il ne peut pas "repartir"
// en R2 au sens d'un 2e entretien — donc la base n'est PAS tous les R1
// bookés, seulement les R1 présents. On rapproche par contact (un même lead
// peut avoir plusieurs lignes de call), pas par simple comptage de lignes.
function salesStatsR1R2(calls) {
  const r1 = calls.filter((c) => c.rangR === 1);
  const r2 = calls.filter((c) => c.rangR > 1);
  const r1Presents = r1.filter((c) => c.present);

  const conclusR1 = somme(r1, "conclu");
  const conclusR2 = somme(r2, "conclu");
  const honoresR1 = r1Presents.length;
  const honoresR2 = somme(r2, "present");

  const contactsR1Presents = new Set(r1Presents.map((c) => c.contactId).filter((id) => id != null));
  const contactsR2 = new Set(r2.map((c) => c.contactId).filter((id) => id != null));
  const nbR1PresentsQuiRepartent = [...contactsR1Presents].filter((id) => contactsR2.has(id)).length;

  return {
    nbR1: r1.length,
    nbR2: r2.length,
    nbR1Presents: contactsR1Presents.size,
    nbR1PresentsQuiRepartent,
    tauxRelance: ratio(nbR1PresentsQuiRepartent, contactsR1Presents.size),
    conclusR1,
    conclusR2,
    honoresR1,
    honoresR2,
    presenceR1: ratio(honoresR1, conclusR1),
    presenceR2: ratio(honoresR2, conclusR2),
    closingR1: ratio(somme(r1, "vente"), honoresR1),
    closingR2: ratio(somme(r2, "vente"), honoresR2),
    // Annulation : part des calls bookés qui ont été annulés (avant d'avoir lieu).
    annulesR1: r1.filter((c) => c.statut === "Annulé").length,
    annulesR2: r2.filter((c) => c.statut === "Annulé").length,
    annulationR1: ratio(r1.filter((c) => c.statut === "Annulé").length, r1.length),
    annulationR2: ratio(r2.filter((c) => c.statut === "Annulé").length, r2.length),
  };
}

// Rendu "Relation R1/R2" : un donut pour le chiffre qui frappe (la part de R1
// PRÉSENTS qui repart en relance) + deux paires de barres pour comparer
// présence et closing entre le 1er call et la relance — même vocabulaire de
// couleur que le reste du dashboard (bleu = R1, magenta = relance). Chaque
// chiffre est sourcé (base précisée en note + bulle au survol) pour ne pas
// laisser place à l'interprétation.
const SEUIL_FIABILITE_R1R2 = 10;

function salesGraphR1R2(cibleId, s) {
  const cible = document.getElementById(cibleId);
  if (!cible) return;

  if (s.nbR1 === 0 && s.nbR2 === 0) {
    cible.innerHTML = `<div class="vide">Pas encore de call Closing sur cette période.</div>`;
    return;
  }

  const fragile = (base) => (base > 0 && base < SEUIL_FIABILITE_R1R2 ? " · trop peu pour conclure" : "");

  const RAYON = 64;
  const CIRCONFERENCE = 2 * Math.PI * RAYON;
  const taux = s.tauxRelance || 0;
  const arc = (taux * CIRCONFERENCE).toFixed(1);
  const reste = (CIRCONFERENCE - taux * CIRCONFERENCE).toFixed(1);
  const idDegrade = `degrade-r1r2-${cibleId}`;

  const bulleDonut = `
    <strong>Taux de relance</strong>
    <span>R1 présents (honorés)<b>${nombre(s.nbR1Presents)}</b></span>
    <span>Dont repartis en R2+<b>${nombre(s.nbR1PresentsQuiRepartent)}</b></span>
    <span class="bulle-pied">Base : R1 honorés uniquement — un R1 non honoré n'a pas eu lieu${fragile(s.nbR1Presents)}</span>`;

  // `note` : phrase courte sous chaque barre qui précise la base du %, pour
  // qu'un chiffre isolé (ex: "100 %") ne soit jamais lu hors contexte.
  const barre = (val, classe, base, libelleBase) => {
    const pct = val === null ? 0 : Math.max(2, Math.round(val * 100));
    const bulle = `
      <strong>${classe === "r1" ? "R1 — 1er call" : "R2+ — relance"}</strong>
      <span>Taux<b>${val === null ? "—" : pourcent(val)}</b></span>
      <span>Base (${libelleBase})<b>${nombre(base)}</b></span>`;
    return `
      <div class="r1r2-barre-bloc">
        <div class="r1r2-barre-ligne"${info(bulle)}>
          <div class="r1r2-piste-barre"><div class="r1r2-barre ${classe}" style="width:${pct}%"></div></div>
          <span class="r1r2-valeur">${val === null ? "—" : pourcent(val)}</span>
        </div>
        <div class="r1r2-note">${base === 0 ? `aucun${classe === "r1" ? " R1" : "e relance"} ${libelleBase}` : `sur ${nombre(base)} ${libelleBase}${fragile(base)}`}</div>
      </div>`;
  };

  cible.innerHTML = `
    <div class="r1r2-wrap">
      <div class="r1r2-donut-bloc">
        <div class="r1r2-donut"${info(bulleDonut)}>
          <svg viewBox="0 0 160 160">
            <defs>
              <linearGradient id="${idDegrade}" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#4FC3F7" />
                <stop offset="100%" stop-color="#E619B0" />
              </linearGradient>
            </defs>
            <circle class="r1r2-piste" cx="80" cy="80" r="${RAYON}"></circle>
            <circle class="r1r2-arc" cx="80" cy="80" r="${RAYON}" stroke="url(#${idDegrade})" stroke-dasharray="${arc} ${reste}"></circle>
          </svg>
          <div class="r1r2-donut-centre">
            <span class="r1r2-donut-chiffre">${s.tauxRelance === null ? "—" : pourcent(s.tauxRelance)}</span>
          </div>
        </div>
        <div class="r1r2-donut-legende"${info(bulleDonut)}>
          <span class="r1r2-donut-label">des R1 présents repartent en R2</span>
          <span class="r1r2-donut-fraction">${nombre(s.nbR1PresentsQuiRepartent)} sur ${nombre(s.nbR1Presents)}</span>
        </div>
      </div>
      <div class="r1r2-compare">
        <div class="r1r2-legende">
          <span><i class="r1"></i>R1 — 1er call (${nombre(s.nbR1)} bookés, ${nombre(s.honoresR1)} présents)</span>
          <span><i class="r2"></i>R2+ — relance (${nombre(s.nbR2)})</span>
        </div>
        <div class="r1r2-metrique">
          <div class="r1r2-metrique-titre">Taux de présence</div>
          ${barre(s.presenceR1, "r1", s.conclusR1, "R1 conclus (honoré ou no-show)")}
          ${barre(s.presenceR2, "r2", s.conclusR2, "relances conclues")}
        </div>
        <div class="r1r2-metrique">
          <div class="r1r2-metrique-titre">Taux de closing</div>
          ${barre(s.closingR1, "r1", s.honoresR1, "R1 honorés")}
          ${barre(s.closingR2, "r2", s.honoresR2, "relances honorées")}
        </div>
        <div class="r1r2-metrique">
          <div class="r1r2-metrique-titre">Taux d'annulation</div>
          ${barre(s.annulationR1, "r1", s.nbR1, "R1 bookés")}
          ${barre(s.annulationR2, "r2", s.nbR2, "relances bookées")}
        </div>
      </div>
    </div>`;
  // Pas de brancherInfobulles() ici : vueSalesClosing() le fait déjà une fois
  // sur toute la vue après ce rendu (double-binding sinon, cf. commentaire
  // d'origine sur apparitions()).
}

function vueSalesClosing() {
  const cible = document.getElementById("vue-sales-closing");
  if (!cible) return;

  const closers = [...new Set(SALES_CALLS.filter((c) => c.typeAppel === "Closing" && c.closer).map((c) => c.closer))].sort();
  brancherSalesToggle(
    "sales-closing-filtre",
    closers,
    () => SALES_CLOSER,
    (v) => (SALES_CLOSER = v),
    vueSalesClosing
  );
  brancherSalesRangToggle(
    "sales-closing-rang",
    () => SALES_CLOSING_RANG,
    (v) => (SALES_CLOSING_RANG = v),
    vueSalesClosing
  );

  // `callsTousRangs` : tous rangs confondus, jamais filtré par le toggle —
  // sert UNIQUEMENT à la section Relation R1/R2 plus bas, qui a besoin des
  // deux rangs en même temps pour comparer R1 à la relance. `calls` :
  // restreint au périmètre choisi par le toggle R1/Tous ci-dessus — sert à
  // TOUT le reste de l'onglet (cartes, taux, classement, entonnoir,
  // camemberts, courbe), pour que les chiffres restent cohérents entre eux
  // quel que soit le réglage (demande utilisateur du 2026-10-04 : des cartes
  // "business" qui ne suivaient pas le toggle rendaient la lecture
  // incohérente).
  const callsTousRangs = salesCallsClosing();
  const calls = SALES_CLOSING_RANG === "r1" ? callsTousRangs.filter((c) => c.rangR === 1) : callsTousRangs;
  const callsPrecTousRangs = salesCallsClosingPrecedentes();
  const callsPrec = callsPrecTousRangs ? (SALES_CLOSING_RANG === "r1" ? callsPrecTousRangs.filter((c) => c.rangR === 1) : callsPrecTousRangs) : null;
  const s = salesStatsCallsClosing(calls);
  const sPrec = callsPrec ? salesStatsCallsClosing(callsPrec) : null;
  const suffixeRang = SALES_CLOSING_RANG === "r1" ? " · R1 uniquement" : " · tous rangs";
  const { rdv, conclus, honores, ventes, ca, panier } = s;

  document.getElementById("sales-closing-cartes").innerHTML = [
    carte("RDV bookés", nombre(rdv), `calls Closing sur la période${suffixeRang}`, sPrec ? ecartDe(rdv, sPrec.rdv, "salesRdv") : null),
    carte("RDV conclus", nombre(conclus), "Honoré ou No-show (hors RDV encore à venir)", sPrec ? ecartDe(conclus, sPrec.conclus, "salesConclus") : null),
    carte("RDV honorés", nombre(honores), "calls Closing réellement tenus", sPrec ? ecartDe(honores, sPrec.honores, "salesHonores") : null),
    carte("Ventes", nombre(ventes), honores ? `sur ${nombre(honores)} honoré${honores > 1 ? "s" : ""}` : "aucun call honoré", sPrec ? ecartDe(ventes, sPrec.ventes, "salesVentes") : null),
    carte("CA contracté", euros(ca), ventes ? `${nombre(ventes)} vente${ventes > 1 ? "s" : ""}` : "aucune vente", sPrec ? ecartDe(ca, sPrec.ca, "salesCa") : null),
  ].join("");

  // Cartes-etroit — même traitement que #qualite en Performance (taux
  // d'annulation/présence/closing), + Panier moyen à côté : c'est aussi un
  // ratio (CA / ventes), pas un volume, donc sa place est ici plutôt que
  // dans les cartes d'en-tête. Tout le bloc suit le toggle R1/Tous comme le
  // reste de l'onglet.
  document.getElementById("sales-closing-cartes-etroit").innerHTML = [
    carte(
      "Taux d'annulation",
      rdv === 0 ? "—" : pourcent(s.annulation),
      (rdv === 0 ? "aucun rendez-vous pris sur la période" : `sur ${nombre(rdv)} rendez-vous pris`) + suffixeRang,
      s.annulation !== null && sPrec && sPrec.annulation !== null ? ecartPoints(s.annulation, sPrec.annulation, true) : null
    ),
    carte(
      "Taux de présence",
      s.presence === null ? "—" : pourcent(s.presence),
      (conclus === 0 ? "aucun call conclu sur la période" : `sur ${nombre(conclus)} conclu${conclus > 1 ? "s" : ""}`) + suffixeRang,
      s.presence !== null && sPrec && sPrec.presence !== null ? ecartPoints(s.presence, sPrec.presence) : null
    ),
    carte(
      "Taux de closing",
      s.closing === null ? "—" : pourcent(s.closing),
      (honores === 0 ? "aucun call honoré sur la période" : `sur ${nombre(honores)} honoré${honores > 1 ? "s" : ""}`) + suffixeRang,
      s.closing !== null && sPrec && sPrec.closing !== null ? ecartPoints(s.closing, sPrec.closing) : null
    ),
    carte(
      "Panier moyen",
      panier === null ? "—" : euros(panier),
      `par vente${suffixeRang}`,
      panier !== null && sPrec && sPrec.panier !== null ? ecartDe(panier, sPrec.panier, "salesPanier") : null
    ),
  ].join("");

  entonnoir(
    "sales-closing-entonnoir",
    [
      { nom: "RDV bookés", cle: "rdv" },
      { nom: "RDV conclus", cle: "conclus" },
      { nom: "RDV honorés", cle: "honores" },
      { nom: "Ventes", cle: "ventes" },
    ],
    [rdv, conclus, honores, ventes],
    null,
    [null, rdv, conclus, honores],
    null
  );

  // Agrégat par closer — suit le toggle R1/Tous comme tout le reste
  // (classement, camemberts, courbe) pour que les chiffres restent
  // cohérents entre les sections de l'onglet.
  const parCloser = {};
  calls.forEach((c) => {
    const n = c.closer || "Non renseigné";
    if (!parCloser[n]) parCloser[n] = { rdv: 0, conclus: 0, honores: 0, ventes: 0, ca: 0 };
    const p = parCloser[n];
    p.rdv += 1;
    p.conclus += c.conclu;
    p.honores += c.present;
    p.ventes += c.vente;
    p.ca += c.montant;
  });
  const lignesCloser = Object.entries(parCloser).sort((a, b) => b[1].ca - a[1].ca);

  // Classement — le meilleur closer en haut, juste sous les cartes d'en-tête
  // (même principe que le classement UTM de Tracking) : toggle Call booké/
  // Call présent/Ventes/CA, même métrique que la courbe d'évolution plus bas.
  brancherSalesMetrique(
    "sales-closing-metrique",
    SALES_METRIQUES,
    () => SALES_CLOSING_METRIQUE,
    (v) => (SALES_CLOSING_METRIQUE = v),
    vueSalesClosing
  );
  const bulleCloser = (nom, v) => `
    <strong>${nom}${suffixeRang}</strong>
    <span>RDV bookés<b>${nombre(v.rdv)}</b></span>
    <span>RDV honorés<b>${nombre(v.honores)}</b></span>
    <span>Ventes<b>${nombre(v.ventes)}</b></span>
    <span>CA contracté<b>${euros(v.ca)}</b></span>
    ${v.conclus > 0 ? `<span class="bulle-pied">${v.honores > 0 ? Math.round((v.ventes / v.honores) * 100) : 0} % de closing · ${Math.round((v.honores / v.conclus) * 100)} % de présence</span>` : ""}`;
  salesRenduPodium("sales-closing-classement", lignesCloser, SALES_METRIQUES, SALES_CLOSING_METRIQUE, bulleCloser);

  // Le tableau "Par closer" est remplacé par le classement ci-dessus (même
  // info, mieux hiérarchisée) — demande du 2026-10-04.
  const couleurCloser = Object.fromEntries(lignesCloser.map(([nom], i) => [nom, PALETTE[i % PALETTE.length]]));
  const partsCa = lignesCloser.filter(([, p]) => p.ca > 0).map(([nom, p]) => [nom, p.ca, couleurCloser[nom]]);
  const partsRdv = lignesCloser.filter(([, p]) => p.rdv > 0).map(([nom, p]) => [nom, p.rdv, couleurCloser[nom]]);

  document.getElementById("sales-closing-camemberts").innerHTML = [
    disque(`RDV bookés par closer${suffixeRang}`, partsRdv, nombre),
    disque(`CA contracté par closer${suffixeRang}`, partsCa, euros),
  ].join("");

  brancherSurvol(document.getElementById("sales-closing-camemberts"));

  // Relation R1/R2 — seule section qui ignore volontairement le toggle
  // R1/Tous (elle a besoin des deux rangs en même temps pour comparer R1 à
  // la relance) : utilise `callsTousRangs`, pas `calls`.
  salesGraphR1R2("sales-closing-r1r2", salesStatsR1R2(callsTousRangs));

  // Évolution de la métrique active par closer dans le temps — top 5, même
  // couleur que la table/les camemberts ci-dessus pour une lecture cohérente.
  // Toggle Call booké/Call présent/Ventes/CA (comme le classement Tracking) :
  // le taux secondaire (présence/closing) s'affiche dans la bulle et en bout
  // de ligne via courbeMultiSeries. Le toggle lui-même a déjà été branché
  // plus haut (il pilote aussi le classement).
  const metriqueDef = SALES_METRIQUES[SALES_CLOSING_METRIQUE];
  const top5Closers = lignesCloser.slice(0, 5).map(([nom]) => nom);
  const joursCalls = calls.map((c) => c.jour).filter(Boolean).sort();
  const blocsCloser = decoupagePeriodesEtendu(joursCalls, GRANULARITE_SALES_CLOSING);
  const seriesCloser = top5Closers.map((nom) => {
    const statsParBloc = blocsCloser.map((b) => salesStatsBlocCloser(nom, calls, b));
    return {
      nom,
      couleur: couleurCloser[nom],
      points: statsParBloc.map((st) => metriqueDef.valeur(st)),
      secondaires: statsParBloc.map((st) => metriqueDef.secondaire(st)),
    };
  });
  courbeMultiSeries("sales-closing-courbe", blocsCloser, seriesCloser, metriqueDef.format, GRANULARITE_SALES_CLOSING, (g) => {
    GRANULARITE_SALES_CLOSING = g;
    vueSalesClosing();
  });
  brancherInfobulles(cible);

  // Les cartes/entonnoir/table/camemberts ci-dessus viennent d'être reconstruits
  // (innerHTML) : ce sont de nouveaux éléments ".rv", jamais observés par
  // l'IntersectionObserver d'apparitions() (qui n'observe qu'une fois, au
  // premier rendu de la vue). Sans ce ré-armement, ils restent invisibles
  // après un clic sur le toggle closer ou métrique — même bug que Tracking.
  requestAnimationFrame(() => apparitions(cible));
}

// Tous les contacts ayant au moins un call Closing — toute date confondue
// (pas filtré période) : la conversion d'un Diagnostic en Closing peut
// arriver après la période affichée, et on veut quand même la compter.
const salesContactsAvecClosing = () =>
  new Set(SALES_CALLS.filter((c) => c.typeAppel === "Closing" && c.contactId != null).map((c) => c.contactId));

// Calls Diagnostic d'une famille donnée (1 = base de données/auto-assignation,
// 2 = rattrapage post-disqualification — voir api/sales-team.js), filtrés
// période + setter actif.
const salesCallsDiagFamille = (famille) =>
  SALES_CALLS.filter(
    (c) => c.typeAppel === "Diagnostic" && c.famille === famille && dansPeriode(c) && (SALES_SETTER === "tout" || c.setter === SALES_SETTER)
  );

// Même famille de calls Diagnostic, mais sur la période précédente (↑/↓ sur
// les cartes) — `null` si la comparaison est désactivée.
function salesCallsDiagFamillePrecedents(famille) {
  const plage = plagePrecedente();
  if (!plage) return null;
  const [a, b] = plage;
  return SALES_CALLS.filter(
    (c) => c.typeAppel === "Diagnostic" && c.famille === famille && c.jour && c.jour >= a && c.jour <= b && (SALES_SETTER === "tout" || c.setter === SALES_SETTER)
  );
}

// Métrique active du classement "par setter" — une entrée par famille (1/2),
// vocabulaire partagé (diag/honores/transformes) mais libellés adaptés au
// moment de la lecture (voir metriquesSetting dans salesRenduFamilleSetting).
let SALES_SETTING_METRIQUE = { 1: "transformes", 2: "transformes" };

// Rend un bloc Famille (cartes + entonnoir + table + camemberts) pour la
// famille donnée. `libelleTaux`/`libelleAppels` adaptent le vocabulaire des
// cartes à la famille (transfo vs rattrapage) sans dupliquer la logique.
function salesRenduFamilleSetting(famille, prefixeId, libelleAppels, libelleTaux) {
  const diag = salesCallsDiagFamille(famille);
  const diagPrec = salesCallsDiagFamillePrecedents(famille);
  const contactsClosing = salesContactsAvecClosing();
  const honores = somme(diag, "present");
  const presence = ratio(honores, diag.length);

  const contactsDiagUniques = new Set(diag.map((c) => c.contactId).filter((id) => id != null));
  const transformes = [...contactsDiagUniques].filter((id) => contactsClosing.has(id)).length;
  const taux = ratio(transformes, contactsDiagUniques.size);

  // Même calcul sur la période précédente, pour les badges ↑/↓.
  let honoresPrec = null;
  let tauxPrec = null;
  if (diagPrec) {
    honoresPrec = somme(diagPrec, "present");
    const contactsDiagUniquesPrec = new Set(diagPrec.map((c) => c.contactId).filter((id) => id != null));
    const transformesPrec = [...contactsDiagUniquesPrec].filter((id) => contactsClosing.has(id)).length;
    tauxPrec = ratio(transformesPrec, contactsDiagUniquesPrec.size);
  }

  document.getElementById(`${prefixeId}-cartes`).innerHTML = [
    carte(libelleAppels, nombre(diag.length), "sur la période", diagPrec ? ecartDe(diag.length, diagPrec.length, "salesDiag") : null),
    carte("Honorés", nombre(honores), presence === null ? "—" : `${pourcent(presence)} de présence`, diagPrec ? ecartDe(honores, honoresPrec, "salesHonores") : null),
    carte(libelleTaux, taux === null ? "—" : pourcent(taux), contactsDiagUniques.size ? `${nombre(transformes)} sur ${nombre(contactsDiagUniques.size)}` : "aucun appel sur la période", taux !== null && tauxPrec !== null ? ecartPoints(taux, tauxPrec) : null),
  ].join("");

  entonnoir(
    `${prefixeId}-entonnoir`,
    [
      { nom: libelleAppels, cle: "diag" },
      { nom: "Honorés", cle: "honores" },
      { nom: "Closing booké", cle: "closing" },
    ],
    [diag.length, honores, transformes],
    null,
    [null, diag.length, honores],
    null
  );

  const parSetter = {};
  diag.forEach((c) => {
    const n = c.setter || "Non renseigné";
    if (!parSetter[n]) parSetter[n] = { diag: 0, honores: 0, contacts: new Set() };
    parSetter[n].diag += 1;
    parSetter[n].honores += c.present;
    if (c.contactId != null) parSetter[n].contacts.add(c.contactId);
  });

  const lignesSetter = Object.entries(parSetter)
    .map(([nom, p]) => [nom, { ...p, transformes: [...p.contacts].filter((id) => contactsClosing.has(id)).length }])
    .sort((a, b) => b[1].diag - a[1].diag);

  // Classement — le meilleur setter en haut, juste sous les cartes d'en-tête
  // de cette famille (même principe que Closing). Vocabulaire du taux final
  // adapté à la famille (transfo vs rattrapage).
  const libelleTauxCourt = famille === 1 ? "transfo" : "rattrapage";
  const metriquesSetting = {
    diag: { libelleCourt: libelleAppels, valeur: (v) => v.diag, format: nombre, secondaire: () => null },
    honores: {
      libelleCourt: "Honorés",
      valeur: (v) => v.honores,
      format: nombre,
      secondaire: (v) => (v.diag > 0 ? `${Math.round((v.honores / v.diag) * 100)} % présence` : null),
    },
    transformes: {
      libelleCourt: "Closing booké",
      valeur: (v) => v.transformes,
      format: nombre,
      secondaire: (v) => (v.contacts.size > 0 ? `${Math.round((v.transformes / v.contacts.size) * 100)} % ${libelleTauxCourt}` : null),
    },
  };
  brancherSalesMetrique(
    `${prefixeId}-metrique`,
    metriquesSetting,
    () => SALES_SETTING_METRIQUE[famille],
    (v) => (SALES_SETTING_METRIQUE[famille] = v),
    () => salesRenduFamilleSetting(famille, prefixeId, libelleAppels, libelleTaux)
  );
  const bulleSetter = (nom, v) => `
    <strong>${nom}</strong>
    <span>${libelleAppels}<b>${nombre(v.diag)}</b></span>
    <span>Honorés<b>${nombre(v.honores)}</b></span>
    <span>Closing booké<b>${nombre(v.transformes)}</b></span>
    ${v.contacts.size > 0 ? `<span class="bulle-pied">${Math.round((v.transformes / v.contacts.size) * 100)} % de ${libelleTauxCourt} · ${v.diag > 0 ? Math.round((v.honores / v.diag) * 100) : 0} % de présence</span>` : ""}`;
  salesRenduPodium(`${prefixeId}-classement`, lignesSetter, metriquesSetting, SALES_SETTING_METRIQUE[famille], bulleSetter);

  document.getElementById(`${prefixeId}-table`).innerHTML = lignesSetter.length
    ? `<table>
        <thead><tr><th>Setter</th><th>${libelleAppels}</th><th>Honorés</th><th>Présence</th><th>Closing booké</th><th>${libelleTaux}</th></tr></thead>
        <tbody>${lignesSetter
          .map(
            ([nom, p]) => `<tr>
              <td>${nom}</td>
              ${cellule(p.diag)}
              ${cellule(p.honores)}
              <td>${p.diag ? pourcent(p.honores / p.diag) : "—"}</td>
              ${cellule(p.transformes)}
              <td>${p.contacts.size ? pourcent(p.transformes / p.contacts.size) : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>`
    : `<div class="vide">Pas encore d'appel sur cette période.</div>`;

  const couleurSetter = Object.fromEntries(lignesSetter.map(([nom], i) => [nom, PALETTE[i % PALETTE.length]]));
  const partsDiag = lignesSetter.filter(([, p]) => p.diag > 0).map(([nom, p]) => [nom, p.diag, couleurSetter[nom]]);
  const partsTransformes = lignesSetter.filter(([, p]) => p.transformes > 0).map(([nom, p]) => [nom, p.transformes, couleurSetter[nom]]);

  document.getElementById(`${prefixeId}-camemberts`).innerHTML = [
    disque(`${libelleAppels} par setter`, partsDiag, nombre),
    disque("Closing booké par setter", partsTransformes, nombre),
  ].join("");

  brancherSurvol(document.getElementById(`${prefixeId}-camemberts`));
}

function vueSalesSetting() {
  const cible = document.getElementById("vue-sales-setting");
  if (!cible) return;

  const setters = [...new Set(SALES_CALLS.filter((c) => c.typeAppel === "Diagnostic" && c.setter).map((c) => c.setter))].sort();
  brancherSalesToggle(
    "sales-setting-filtre",
    setters,
    () => SALES_SETTER,
    (v) => (SALES_SETTER = v),
    vueSalesSetting
  );

  salesRenduFamilleSetting(1, "sales-setting-f1", "Appels Diagnostic", "Taux de transfo en Closing");
  salesRenduFamilleSetting(2, "sales-setting-f2", "Appels Diagnostic (rattrapage)", "Taux de rattrapage en Closing");

  brancherInfobulles(cible);

  // Même ré-armement que vueSalesClosing : les deux blocs famille viennent
  // d'être reconstruits (innerHTML), leurs ".rv" ne sont jamais observés par
  // apparitions() sans ce requestAnimationFrame — sinon invisibles après un
  // clic sur le toggle setter.
  requestAnimationFrame(() => apparitions(cible));
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Sales Team — podium (Closing et Setting)                           */
/* ------------------------------------------------------------------ */

// Podium animé (Classement) : coupe au-dessus du n°1, marches qui montent,
// confettis, valeurs qui comptent. Rang 4+ en lignes classiques dessous.
const PODIUM_COULEURS = ["#F5C451", "#D5DBE6", "#D89A6A"]; // or, argent, bronze

function salesRenduPodium(cibleId, entries, metriquesObj, metriqueActive, bulleFn) {
  const cible = document.getElementById(cibleId);
  if (!cible) return;

  const def = metriquesObj[metriqueActive];
  const classe = entries
    .map(([nom, v]) => ({ nom, val: def.valeur(v), sec: def.secondaire(v), v }))
    .filter((e) => e.val > 0)
    .sort((x, y) => y.val - x.val);

  if (!classe.length) {
    cible.innerHTML = `<div class="vide">Rien à classer sur cette période.</div>`;
    return;
  }

  const initiales = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("");
  const hauteurs = [100, 72, 54];
  const delais = [0.95, 0.35, 0.65]; // le n°1 monte en dernier
  const ordre = [1, 0, 2].filter((i) => classe[i]); // visuel : 2e, 1er, 3e

  const coupe = `
    <div class="podium-coupe">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="or-${cibleId}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#FFF3B0"/><stop offset=".45" stop-color="#F5C451"/><stop offset="1" stop-color="#B9791A"/>
          </linearGradient>
        </defs>
        <path d="M18 6h28v14c0 9-6 16-14 17-8-1-14-8-14-17z" fill="url(#or-${cibleId})"/>
        <path d="M18 10H8c0 9 4 15 11 16M46 10h10c0 9-4 15-11 16" fill="none" stroke="url(#or-${cibleId})" stroke-width="3.2" stroke-linecap="round"/>
        <rect x="28" y="37" width="8" height="10" fill="url(#or-${cibleId})"/>
        <path d="M20 56c0-5 5-9 12-9s12 4 12 9z" fill="url(#or-${cibleId})"/>
        <path d="M24 10v10c0 5 2 9 5 11" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M32 14l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7z" fill="#fff" fill-opacity=".85"/>
      </svg>
      <i class="etoile e1"></i><i class="etoile e2"></i><i class="etoile e3"></i>
    </div>`;

  const confettis = Array.from({ length: 22 }, (_, i) => {
    const c = ["#F5C451", "#E619B0", "#C9A6FF", "#6FD3A3", "#7FE3E3", "#fff"][i % 6];
    const x = 10 + ((i * 37) % 80);
    const d = (1.5 + (i % 7) * 0.12).toFixed(2);
    const t = (2.2 + (i % 5) * 0.35).toFixed(2);
    const r = (i % 2 ? 1 : -1) * (180 + i * 23);
    return `<s style="left:${x}%;background:${c};animation-delay:${d}s;animation-duration:${t}s;--r:${r}deg"></s>`;
  }).join("");

  const colonnes = ordre
    .map((i) => {
      const e = classe[i];
      const col = PODIUM_COULEURS[i];
      return `
      <div class="podium-col p${i + 1}" style="--c:${col};--d:${delais[i]}s;--h:${hauteurs[i]}%"${info(bulleFn(e.nom, e.v))}>
        <div class="podium-perso">
          ${i === 0 ? coupe : ""}
          <div class="podium-avatar"><span>${initiales(e.nom)}</span></div>
          <div class="podium-nom">${e.nom}</div>
          <div class="podium-valeur" data-val="${e.val}">${def.format(e.val)}</div>
          ${e.sec ? `<div class="podium-sec">${e.sec}</div>` : ""}
        </div>
        <div class="podium-marche"><b>${i + 1}</b></div>
      </div>`;
    })
    .join("");

  const reste = classe.slice(3);
  const max = classe[0].val;
  const lignes = reste
    .map(
      (e, k) => `
      <div class="classement-ligne"${info(bulleFn(e.nom, e.v))}>
        <span class="classement-rang">${k + 4}</span>
        <span class="classement-nom">${e.nom}</span>
        <div class="classement-piste"><div class="classement-barre" style="width:${Math.max(4, Math.round((e.val / max) * 100))}%"></div></div>
        <div class="classement-chiffres">
          <span class="classement-valeur">${def.format(e.val)}</span>
          ${e.sec ? `<span class="classement-secondaire">${e.sec}</span>` : ""}
        </div>
      </div>`
    )
    .join("");

  cible.innerHTML = `
    <div class="podium rv">
      <div class="podium-halo"></div>
      <div class="podium-confettis">${confettis}</div>
      <div class="podium-scene">${colonnes}</div>
      <div class="podium-sol"></div>
    </div>
    ${lignes ? `<div class="podium-reste">${lignes}</div>` : ""}`;

  // Compteur : les valeurs montent de 0 à leur total quand le n°1 arrive.
  const doux = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doux) {
    cible.querySelectorAll(".podium-valeur").forEach((el) => {
      const cibleVal = Number(el.dataset.val);
      const debut = performance.now() + 700;
      el.textContent = def.format(0);
      const pas = (t) => {
        const p = Math.min(1, Math.max(0, (t - debut) / 1400));
        el.textContent = def.format(Math.round(cibleVal * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(pas);
      };
      requestAnimationFrame(pas);
    });
  }

  brancherInfobulles(cible);
}


async function charger() {
  try {
    const reponse = await fetch("/api/acquisition");
    const donnees = await reponse.json();
    if (!reponse.ok) throw new Error(donnees.erreur || `Erreur ${reponse.status}`);

    TOUTES = donnees.lignes.map((l) => ({ ...l, source: deriverSource(l.canal) }));
    CLIENTS_DETAIL = (donnees.clientsDetail || []).map((c) => ({ ...c, source: deriverSource(c.canal) }));
    fixerCouleurs();

    // Le pilotage quotidien reste vide si /api/pilotage-quotidien échoue —
    // même logique d'isolement que pour Direction ci-dessous : ça n'empêche
    // jamais le reste du dashboard de fonctionner.
    try {
      const reponseQuot = await fetch("/api/pilotage-quotidien");
      const donneesQuot = await reponseQuot.json();
      if (reponseQuot.ok) {
        QUOT = donneesQuot.lignes || [];
        vueQuotidien(QUOT);
      }
    } catch {
      // Ignoré volontairement : voir commentaire ci-dessus.
    }

    // La section Direction reste vide si /api/direction échoue (réseau, panne
    // de la fonction...) — un try/catch dédié l'isole pour que ça n'empêche
    // jamais le reste du dashboard (Acquisition) de fonctionner.
    try {
      const reponseDirection = await fetch("/api/direction");
      const donneesDirection = await reponseDirection.json();
      if (reponseDirection.ok) {
        DIRECTION_CONTRATS = donneesDirection.contrats || [];
        DIRECTION_PAIEMENTS = donneesDirection.paiements || [];
      }
    } catch {
      // Ignoré volontairement : voir commentaire ci-dessus.
    }

    // Tracking UTM — même isolement : ça ne bloque jamais le reste du
    // dashboard si /api/tracking échoue.
    try {
      const reponseTracking = await fetch("/api/tracking");
      const donneesTracking = await reponseTracking.json();
      if (reponseTracking.ok) {
        TRACK_LEADS = donneesTracking.leads || [];
        TRACK_RDV_TOUS = donneesTracking.rdv || [];
        TRACK_RDV = TRACK_RDV_TOUS.filter((r) => r.rangR === 1);
      }
    } catch {
      // Ignoré volontairement : voir commentaire ci-dessus.
    }

    // Sales Team (Closing/Setting) — même isolement que les sections ci-dessus.
    try {
      const reponseSales = await fetch("/api/sales-team");
      const donneesSales = await reponseSales.json();
      if (reponseSales.ok) {
        SALES_LEADS = donneesSales.leads || [];
        SALES_CALLS = donneesSales.calls || [];
        vueSalesClosing();
        vueSalesSetting();
      }
    } catch {
      // Ignoré volontairement : voir commentaire ci-dessus.
    }

    brancherPeriode();
    brancherCanalProduit();
    brancherTracking();
    rendre();

    const heure = new Date(donnees.genereLe).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("etat").textContent = `${donnees.nbLignes} lignes · ${heure}`;

    brancherNavigation();
    afficherVue((location.hash || "#ensemble").slice(1));
  } catch (erreur) {
    document.getElementById("etat").textContent = "Erreur";
    document.getElementById("erreur").innerHTML = `<div class="glass message erreur"><strong>Impossible de charger les données.</strong><br>${erreur.message}</div>`;
  }
}

charger();

/* ------------------------------------------------------------------ */
/*  Couleurs des cartes : une suite continue par vue, pour qu'aucune    */
/*  carte n'ait la même couleur que sa voisine (ni à côté, ni en       */
/*  dessous) — sinon les cartes empilées forment des colonnes de       */
/*  couleur qui laissent croire à un lien entre des KPI indépendants.  */
/* ------------------------------------------------------------------ */

const COULEURS_CARTES = [
  ["#4FC3F7", "79,195,247", "#7DD3FC"],
  ["#9B6BFF", "155,107,255", "#C4A6FF"],
  ["#E619B0", "230,25,176", "#F893DA"],
  ["#6FD3A3", "111,211,163", "#9BE5C0"],
  ["#F0B95A", "240,185,90", "#F6CF8A"],
  ["#7FE3E3", "127,227,227", "#A8F0F0"],
  ["#FF8A65", "255,138,101", "#FFB59E"],
  ["#7C8CFF", "124,140,255", "#AEB8FF"],
];

function colorerCartes() {
  document.querySelectorAll(".vue").forEach((vue) => {
    vue.querySelectorAll(".carte").forEach((c, i) => {
      const [b, rgb, t] = COULEURS_CARTES[i % COULEURS_CARTES.length];
      c.dataset.acc = "1";
      c.style.setProperty("--ac", b);
      c.style.setProperty("--ac-rgb", rgb);
      c.style.setProperty("--ac-t", t);
    });
  });
}

let colorationPrevue = false;
new MutationObserver(() => {
  if (colorationPrevue) return;
  colorationPrevue = true;
  requestAnimationFrame(() => {
    colorationPrevue = false;
    colorerCartes();
  });
}).observe(document.body, { childList: true, subtree: true });
colorerCartes();
