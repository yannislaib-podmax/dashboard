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

const dansPeriode = (l) => {
  if (!DEBUT && !FIN) return true;
  if (!l.jour) return false;
  return (!DEBUT || l.jour >= DEBUT) && (!FIN || l.jour <= FIN);
};

let CANAL = "tout";
let PRODUIT = "tout";

const parCanalEtProduit = (lignes) =>
  lignes.filter(
    (l) => (CANAL === "tout" || l.canal === CANAL) && (PRODUIT === "tout" || l.produit === PRODUIT)
  );

const lignesFiltrees = () => parCanalEtProduit(TOUTES.filter(dansPeriode));

let COMPARAISON = "precedente";

const BAISSE_EST_BONNE = new Set(["coutVente", "coutAppel", "coutRdv", "coutLead", "cpm", "cpc", "dirResiliations"]);
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
  contracte: (l) => somme(l, "contracte"),
  roas: (l) => ratio(somme(l, "contracte"), somme(l, "depense")),
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

  // Taux de présence : honorés rapportés aux rendez-vous CONCLUS (Honoré ou
  // No-show), pas à tous les rendez-vous pris. Un rendez-vous encore
  // "Confirmé" (pas encore passé) ne doit pas compter comme une absence :
  // le compter aurait fait chuter artificiellement le taux tant que la
  // période contient des RDV à venir.
  tauxPresence: (l) => ratio(somme(l, "honores"), somme(l, "rendezVousConclus")),

  // Taux de closing : ventes rapportées aux appels réellement honorés.
  tauxClosing: (l) => ratio(somme(l, "ventes"), somme(l, "honores")),
};

const SEUIL_FIABILITE = 10;

/* ------------------------------------------------------------------ */
/*  Conversion                                                         */
/* ------------------------------------------------------------------ */

const ETAPES = [
  { cle: "leads", nom: "Leads" },
  { cle: "rendezVous", nom: "Rendez-vous pris" },
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

  const fragile = (base) => (base > 0 && base < SEUIL_FIABILITE ? " · trop peu pour conclure" : "");

  const bloc = document.getElementById("qualite");
  if (bloc) {
    bloc.innerHTML =
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

  // Base de la marche "Rendez-vous honorés" : les rendez-vous CONCLUS (Honoré
  // ou No-show), pas tous les rendez-vous pris. Un RDV encore "Confirmé" (à
  // venir) n'a pas encore d'issue et ne doit pas compter dans le dénominateur
  // — sinon le taux affiché chute artificiellement tant qu'il reste des RDV
  // à venir sur la période (même bug que le taux de présence).
  const bases = (jeu, vals) =>
    ETAPES.map((e, i) => {
      if (i === 0) return null;
      if (e.cle === "honores") return INDICATEURS.rendezVousConclus(jeu);
      return vals[i - 1];
    });

  entonnoir(ETAPES, valeurs, valeursPrec, bases(lignes, valeurs), valeursPrec ? bases(precedentes, valeursPrec) : null);
  camembertsConversion(lignes);
}

function ecartPoints(actuel, precedent) {
  if (actuel === null || precedent === null) return null;

  const brut = (actuel - precedent) * 100;
  const pts = Math.abs(brut) < 10 ? Math.round(brut * 10) / 10 : Math.round(brut);

  const valeur = Math.abs(pts).toString().replace(".", ",");
  const unite = `pt${Math.abs(pts) >= 2 ? "s" : ""}`;

  if (Math.abs(pts) <= SEUIL_STABLE_PTS) {
    return { classe: "stable", texte: pts === 0 ? "→ stable" : `→ ${valeur} ${unite}` };
  }

  return { classe: pts > 0 ? "bon" : "mauvais", texte: `${pts > 0 ? "↑" : "↓"} ${valeur} ${unite}` };
}

const marqueur = (e) => (e ? ` <span class="ecart-inline ${e.classe}">${e.texte}</span>` : "");

function entonnoir(ETAPES, valeurs, valeursPrec, bases, basesPrec) {
  const cible = document.getElementById("entonnoir");
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

      // Pour la marche honorés, la base réelle est les RDV conclus, pas les
      // RDV pris (voir bases() ci-dessus) : le libellé doit le refléter.
      const libelleBase = e.cle === "honores" ? "rendez-vous conclus" : ETAPES[i - 1].nom.toLowerCase();

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

  const morceaux = [
    `<div class="entonnoir-fig">
      <div class="etiquettes">${etiquettes}</div>
      <svg class="entonnoir-svg" viewBox="0 0 ${L} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="degrade-entonnoir" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="rgba(201,166,255,.42)"></stop>
            <stop offset="55%" stop-color="rgba(201,166,255,.24)"></stop>
            <stop offset="100%" stop-color="rgba(230,25,176,.34)"></stop>
          </linearGradient>
        </defs>
        <path d="${silhouette}" fill="url(#degrade-entonnoir)"
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

function tranches7(lignes) {
  const jours = lignes.map((l) => l.jour).filter(Boolean).sort();
  if (!jours.length) return [];

  const premier = jours[0];
  const dernier = jours[jours.length - 1];
  const blocs = [];
  let fin = enDate(dernier);

  for (let garde = 0; garde < 60; garde++) {
    const debut = new Date(fin - 6 * JOUR_MS);
    blocs.unshift({ debut: enIso(debut), fin: enIso(fin) });
    if (enIso(debut) <= premier) break;
    fin = new Date(debut - JOUR_MS);
  }

  return blocs
    .map((b) => {
      const dedans = lignes.filter((l) => l.jour >= b.debut && l.jour <= b.fin);
      return { ...b, depense: somme(dedans, "depense"), contracte: somme(dedans, "contracte") };
    })
    // On n'affiche une tranche que si elle a une dépense ou un CA à montrer :
    // des colonnes vides à hauteur minimale poussaient le graphique hors de
    // son cadre quand la période couvrait beaucoup de semaines inactives.
    .filter((b) => b.depense > 0 || b.contracte > 0);
}

function graphiqueCa(lignes) {
  const blocs = tranches7(lignes);
  const cible = document.getElementById("graph-ca");
  if (!cible) return;

  if (!blocs.length) {
    cible.innerHTML = `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.depense, b.contracte]));
  const h = (v) => Math.round((v / max) * 100);

  const jourMois = (iso) => {
    const d = enDate(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const legende = `
    <div class="legende-graph">
      <span><i class="b-depense"></i>Dépense pub</span>
      <span><i class="b-contracte"></i>CA contracté</span>
    </div>`;

  const colonnes = blocs
    .map((b) => {
      const roas = b.depense > 0 ? (b.contracte / b.depense).toFixed(2).replace(".", ",") + " ×" : "—";
      const bulle = `<strong>${jourMois(b.debut)} – ${jourMois(b.fin)}</strong>
        <span><i class="p-depense"></i>Dépense pub<b>${euros(b.depense)}</b></span>
        <span><i class="p-contracte"></i>CA contracté<b>${euros(b.contracte)}</b></span>
        <span class="bulle-pied">ROAS<b>${roas}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="valeur">${roas}</div>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-depense"   data-hauteur="${h(b.depense)}"></div>
            <div class="barre b-contracte" data-hauteur="${h(b.contracte)}"></div>
          </div>
        </div>
        <div class="jour">${jourMois(b.debut)} – ${jourMois(b.fin)}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);
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

  let cumul = 0;
  const arcs = parts
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

  const legende = parts
    .map(
      (p, i) => `<div class="part-ligne" data-i="${i}"${info(bulle(p))}>
        <i style="background:${p[2]}"></i>
        <span class="nom">${p[0]}${p[3] ? `<em class="taux-etape">${p[3]}</em>` : ""}</span>
        <span class="pct">${Math.round((p[1] / total) * 100)} %</span>
        <span class="montant">${format(p[1])}</span>
      </div>`
    )
    .join("");

  const centres = parts
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
    camembert("CA contracté", lignes, "contracte", euros),
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

  cible.innerHTML = [disque("Où la chaîne se perd", pertes, nombre), camembert("Ventes par canal", lignes, "ventes", nombre)].join("");

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

  brancherInfobulles(cible);
}

/* ------------------------------------------------------------------ */
/*  Vue d'ensemble                                                     */
/* ------------------------------------------------------------------ */

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

  document.getElementById("perf").innerHTML = [
    carte("Dépense pub", euros(depense), depense === 0 ? "aucune dépense renseignée" : null, ecart("depense")),
    carte("CA contracté", enEuros(val("contracte")), null, ecart("contracte")),
    carte("ROAS", enRoas(val("roas")), sansDepense || "le chiffre de pilotage", ecart("roas")),
  ].join("");

  document.getElementById("perf-couts").innerHTML = [
    carte("Coût par vente", enEuros(val("coutVente")), depense > 0 && ventes === 0 ? "aucune vente sur la période" : sansDepense, ecart("coutVente")),
    carte("Coût par appel honoré", enEuros(val("coutAppel")), sansDepense, ecart("coutAppel")),
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

const HYP = { panier: null, closing: null, presence: null, leadRdv: null, coutLead: null };

function mesures(lignes) {
  const s = (c) => somme(lignes, c);

  return {
    panier: ratio(s("contracte"), s("ventes")),
    closing: ratio(s("ventes"), s("honores")),
    // Même correctif que partout ailleurs : la base du taux de présence est
    // les RDV CONCLUS (Honoré/No-show), pas tous les RDV pris — sinon les
    // RDV "Confirmé" à venir font chuter artificiellement le taux.
    presence: ratio(s("honores"), s("rendezVousConclus")),
    leadRdv: ratio(s("rendezVous"), s("leads")),
    coutLead: ratio(s("depense"), s("leads")),
    reel: { ventes: s("ventes"), honores: s("honores"), rendezVous: s("rendezVous"), leads: s("leads"), depense: s("depense") },
    bases: { ventes: s("ventes"), honores: s("honores"), rendezVous: s("rendezVous"), rendezVousConclus: s("rendezVousConclus"), leads: s("leads") },
  };
}

const HYPOTHESES = [
  { cle: "leadRdv", nom: "Lead → rendez-vous", unite: "%", base: "leads", groupe: "taux" },
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

    ${groupe("Taux de conversion", ["leadRdv", "presence", "closing"])}
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
  const rdv = honores / v("presence");
  const leads = rdv / v("leadRdv");
  const depense = leads * v("coutLead");

  const arrondi = (x) => Math.ceil(x - 1e-9);

  const etages = [
    ["Ventes", ventes, m.reel.ventes],
    ["Rendez-vous honorés", honores, m.reel.honores],
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

function tranches7Direction(contrats, paiements) {
  const jours = [
    ...contrats.map((c) => c.dateSignature),
    ...paiements.map((p) => p.datePaiement),
  ]
    .filter(Boolean)
    .sort();
  if (!jours.length) return [];

  const premier = jours[0];
  const dernier = jours[jours.length - 1];
  const blocs = [];
  let fin = enDate(dernier);

  for (let garde = 0; garde < 60; garde++) {
    const debut = new Date(fin - 6 * JOUR_MS);
    blocs.unshift({ debut: enIso(debut), fin: enIso(fin) });
    if (enIso(debut) <= premier) break;
    fin = new Date(debut - JOUR_MS);
  }

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
  const cible = document.getElementById("direction-graph");
  if (!cible) return;

  const blocs = tranches7Direction(contrats, paiements);

  if (!blocs.length) {
    cible.innerHTML = `<div style="color:var(--txt3)">Pas encore de données.</div>`;
    return;
  }

  const max = Math.max(1, ...blocs.flatMap((b) => [b.contracte, b.encaisse]));
  const h = (v) => Math.round((v / max) * 100);

  const jourMois = (iso) => {
    const d = enDate(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const legende = `
    <div class="legende-graph">
      <span><i class="b-dir-contracte"></i>CA contracté</span>
      <span><i class="b-dir-encaisse"></i>CA encaissé</span>
    </div>`;

  const colonnes = blocs
    .map((b) => {
      const bulle = `<strong>${jourMois(b.debut)} – ${jourMois(b.fin)}</strong>
        <span><i class="p-dir-contracte"></i>CA contracté<b>${euros(b.contracte)}</b></span>
        <span><i class="p-dir-encaisse"></i>CA encaissé<b>${euros(b.encaisse)}</b></span>`;
      return `<div class="barre-col"${info(bulle)}>
        <div class="zone">
          <div class="groupe-barres">
            <div class="barre b-dir-contracte" data-hauteur="${h(b.contracte)}"></div>
            <div class="barre b-dir-encaisse"  data-hauteur="${h(b.encaisse)}"></div>
          </div>
        </div>
        <div class="jour">${jourMois(b.debut)} – ${jourMois(b.fin)}</div>
      </div>`;
    })
    .join("");

  cible.innerHTML = legende + `<div class="histo-barres">${colonnes}</div>`;
  brancherInfobulles(cible);

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

  const restrictions = [CANAL !== "tout" ? CANAL : null, PRODUIT !== "tout" ? PRODUIT : null].filter(Boolean);

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

  const sCanal = remplir("canal", canaux, "Tous les canaux");
  const sProduit = remplir("produit", produits, "Tous les produits");

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

function vueQuotidien(lignes) {
  const cible = document.getElementById("quot-jour");
  const table = document.getElementById("quot-table");
  if (!cible || !table) return;

  const duJour = lignes.filter((l) => l.jour === AUJOURDHUI);
  const total = (jeu, champ) => somme(jeu, champ);

  const conclusJour = total(duJour, "honores") + total(duJour, "noShow");

  cible.innerHTML =
    carte("Appels prévus", nombre(total(duJour, "appelsPrevus")), "réservés pour aujourd'hui, tous statuts") +
    carte("Appels honorés", nombre(total(duJour, "honores")), conclusJour ? `sur ${nombre(conclusJour)} conclu${conclusJour > 1 ? "s" : ""} aujourd'hui` : "aucun appel conclu pour l'instant") +
    carte("No-show", nombre(total(duJour, "noShow")), null) +
    carte("Annulés", nombre(total(duJour, "annules")), null) +
    carte("Ventes signées", nombre(total(duJour, "ventes")), null) +
    carte("Contracté", euros(total(duJour, "contracte")), null);

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

  const jours = [...parJour.values()].sort((a, b) => b.jour.localeCompare(a.jour)).slice(0, 14);

  if (!jours.length) {
    table.innerHTML = `<div style="padding:28px;color:var(--txt3)">Aucune donnée.</div>`;
    return;
  }

  const corps = jours
    .map(
      (j) => `<tr${j.jour === AUJOURDHUI ? ' class="total"' : ""}>
        <td>${j.jour === AUJOURDHUI ? "<strong>Aujourd'hui</strong>" : jourCourt(j.jour)}</td>
        ${cellule(j.appelsPrevus)}
        ${cellule(j.honores)}
        ${cellule(j.noShow)}
        ${cellule(j.annules)}
        ${cellule(j.ventes)}
        ${cellule(j.contracte, euros)}
      </tr>`
    )
    .join("");

  table.innerHTML = `
    <table>
      <thead><tr>
        <th>Jour</th><th>Appels prévus</th><th>Honorés</th><th>No-show</th><th>Annulés</th><th>Ventes</th><th>Contracté</th>
      </tr></thead>
      <tbody>${corps}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ */

async function charger() {
  try {
    const reponse = await fetch("/api/acquisition");
    const donnees = await reponse.json();
    if (!reponse.ok) throw new Error(donnees.erreur || `Erreur ${reponse.status}`);

    TOUTES = donnees.lignes;
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

    brancherPeriode();
    brancherCanalProduit();
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
