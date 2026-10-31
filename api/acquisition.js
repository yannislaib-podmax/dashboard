// Fonction serveur — données d'acquisition PodMax.
//
// Elle lit la table ACQUISITION d'Airtable (base HQ PODMAX AGENCY) pour la
// dépense/impressions/clics/leads (pas de souci de doublon : un lead = une
// ligne, saisie manuelle pour la dépense). Mais le rendez-vous/honorés/
// ventes/contracté ne sont PAS lus depuis les rollups ACQUISITION : ces
// rollups additionnent TOUS les calls Closing liés à la ligne jour+canal+
// produit, R1 ET relances (R2/R3...) confondues — un lead qui relance compte
// pour 2 RDV au lieu d'1. On relit donc CALL BOOKED brut et on recalcule
// nous-mêmes ces 5 compteurs en ne gardant que le rang R1 (même règle que le
// Tracking UTM), puis on les substitue aux rollups Airtable.
//
// IMPORTANT : la jointure CALL BOOKED → ACQUISITION se fait par le vrai lien
// Airtable (champ "Dépense média", un ID d'enregistrement), PAS en
// reconstruisant une clé texte "jour | canal | produit". Vérifié sur les
// données réelles (2026-10-01) : le champ Produit de CALL BOOKED a été
// renommé après coup (ex. "Pack Créa Ads" → "🎯 Podmax Ads") sur des
// événements iClosed déjà en base, alors que le texte figé dans la colonne
// Produit/Clé d'ACQUISITION, lui, ne bouge jamais. Rejoindre par texte aurait
// donc cassé le lien sur la quasi-totalité des lignes existantes — vérifié
// sur Airtable avant d'écrire ce fichier, pas supposé.
//
// Le jeton Airtable ne quitte jamais le serveur. Il est lu depuis la variable
// d'environnement AIRTABLE_TOKEN, définie dans les réglages du projet Vercel.
//
// On interroge Airtable par IDENTIFIANT de champ et non par nom : renommer une
// colonne dans Airtable ne cassera donc pas le dashboard.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_ACQUISITION = "tblIDuDZ25yvenkEz";
const TABLE_CALL_BOOKED = "tblaY2J8SD0grDEOK";

// Correspondance identifiant Airtable → nom lisible côté page.
// Note : rendezVous/rendezVousConclus/honores/ventes/contracte sont bien lus
// ici (valeurs ACQUISITION brutes) mais écrasés plus bas par le recalcul R1.
const CHAMPS_ACQUISITION = {
  fldQYnMqFJOdFILX7: "cle",
  fldboNJfQPWEGq99U: "jour",
  fldFNl3ulxKLH2wQH: "canal",
  fldnuLNAEqzPlLzne: "produit",
  fldfcxZxF1SFJCIXn: "depense",
  fldlnPS7oaGEHby25: "impressions",
  fldcaSJjaqKNqvGlV: "clics",
  fldU8PNMP8Qo3lJgs: "leads",
  fldU60JOee3IjwdLz: "rendezVous",
  fldxfGAgdfydHcSbB: "rendezVousConclus",
  fldaDyIgZYVpE7aLb: "honores",
  fldr1manDq32B8IFv: "ventes",
  fldIacFZj53jCcMzM: "contracte",
};

const CHAMPS_CALL_BOOKED = {
  fldOrfHds1MiMVehg: "prisLe",
  fldLSlGP0yarBWZB8: "contactId", // sert a sortir du Rattrapage les calls d'un contact traite par un setter
  fldONsYE6GNJUI15C: "canal",
  fldChsnbeVQFDCmjy: "produit",
  fldS2brPeHHyuCRf3: "present",
  fldHub4Sw3d9ZiEzC: "conclu",
  fldwA9cRx6qHqForP: "vente",
  fld1GgVHXLLo54h8s: "montant",
  fldFPd5SGaSFfImIE: "typeAppel",
  fldhiaObnPFQjPioa: "bookingId", // "SETTER-" = call de setting synthetique, exclu du Rattrapage
  fldTBeyP7bcOpxz4p: "rangR",
  fld1v2skWq5Qt44Vq: "annule", // "Est annulé" (formule : Statut = "Annulé")
};

// DECISION 2026-10-13 : on ne se sert plus du lien CALL BOOKED / LEADS -> ACQUISITION
// (source de la moitie des bugs). ACQUISITION ne fournit plus que la DEPENSE
// (depense/impressions/clics, saisie manuelle puis table META_DEPENSE). Tout le
// reste (leads, RDV, ventes, clients) est compte directement dans LEADS,
// CALL BOOKED et CONTRATS, range par jour (Paris) | canal | produit.
const CHAMPS_LEADS = {
  fldaUTHkR9vloCz2e: "capteLe",
  fldllUNg0J5M1xIhb: "canal",
  fldGQUwkMl7QTDgQP: "produit",
};
const SANS = "Non déterminé";

// Jour AAAA-MM-JJ en heure de Paris (meme regle que api/tracking.js).
function jourParis(brut) {
  if (!brut) return null;
  const s = String(brut);
  if (s.length <= 10) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const cleLigne = (jour, canal, produit) => `${jour} | ${canal || SANS} | ${produit || SANS}`;
const CHAMP_LIEN_LEAD = "fldHbTh0TKkb2IECE"; // lien CALL BOOKED -> LEADS
const CHAMP_LIEN_CONTRATS = "fldszCN4DEDuhjCzh"; // lien CALL BOOKED -> CONTRATS (source unique des ventes et du CA)

// Acquisition PAR CLIENT (decision 2026-10-05) : l'acquisition sert a obtenir un
// client, pas un contrat. Chemin : CONTRATS -> CLIENTS <- LEADS (champ "Client",
// ecrit par l'Intake Tally) -> ligne ACQUISITION. La ligne retenue est celle du
// call Closing R1 du lead (meme ligne que ses RDV, donc ventes et RDV restent
// alignes) ; a defaut, la ligne ACQUISITION du lead lui-meme.
const TABLE_LEADS = "tblFfUo3I4ihrQmzr";
const TABLE_CONTRATS = "tbl3SDo8VkXxXdzdA";
const CHAMP_LEAD_CLIENT = "fld4U3Hv6uYDDdgv8"; // LEADS -> CLIENTS
const CHAMP_CONTRAT_CLIENT = "fldm0apf8f0JU1AIF"; // CONTRATS -> CLIENTS
// PAIEMENTS : sert aux cohortes (encaisse mois par mois depuis l'acquisition).
const TABLE_PAIEMENTS = "tblUodmImuM0egrdk";
const CHAMP_PAIEMENT_CLIENT = "fldp86WBeIMehdpPo"; // PAIEMENTS -> CLIENTS
const CHAMPS_PAIEMENTS = {
  fldo1n4fRI9ZoLGeN: "montantRecu",
  fldQTgnGDxV0v9wpr: "datePaiement",
};
const CHAMPS_CONTRATS = {
  fldTBSFvLGbiZKter: "typeContrat", // Abonnement / Prestation
  fldlhedw3iJNyAITQ: "dateSignature",
  fldz1nshv9SfQLn04: "montantTotal",
  fldcExyrANUkkgBP5: "montantRecu", // rollup : total encaisse sur ce contrat
};

// Un select Airtable arrive sous forme d'objet { id, name, color } ; un
// multipleSelects arrive en tableau d'objets ; un nombre arrive brut ; un
// champ vide n'arrive pas du tout.
function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) {
    return brut.map((v) => (v && v.name !== undefined ? v.name : v)).join(", ");
  }
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
}

async function lireTable(token, tableId, champs, champsBruts = []) {
  const lignes = [];
  let offset;
  const tousLesChamps = [...Object.keys(champs), ...champsBruts];

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    tousLesChamps.forEach((id) => url.searchParams.append("fields[]", id));
    if (offset) url.searchParams.set("offset", offset);

    const reponse = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!reponse.ok) {
      const detail = await reponse.text();
      throw new Error(`Airtable a répondu ${reponse.status} : ${detail}`);
    }

    const donnees = await reponse.json();

    for (const enr of donnees.records) {
      const ligne = { _id: enr.id };
      for (const [id, nom] of Object.entries(champs)) {
        ligne[nom] = valeur(enr.fields[id]);
      }
      // Champs bruts (non passés dans `valeur()`) : on garde le tableau
      // d'IDs liés tel quel, sans le transformer en texte joint.
      for (const id of champsBruts) {
        ligne[id] = Array.isArray(enr.fields[id]) ? enr.fields[id] : [];
      }
      lignes.push(ligne);
    }

    offset = donnees.offset;
  } while (offset);

  return lignes;
}

// Compte rendezVous/rendezVousConclus/honores/ventes/contracte/annules par
// ligne jour | canal | produit, a partir des seuls calls Closing de rang R1
// (un lead qui relance, R2/R3..., ne compte pas comme un 2e rendez-vous).
function recalculerDepuisCallBooked(callsBooked) {
  // R1 = champs sans suffixe (comportement historique). R2+ = relances (R2, R3...),
  // dans des champs suffixes "R2" : le dashboard choisit R1 / R2+ / Tous.
  const champsVides = () => {
    const o = {};
    for (const suf of ["", "R2", "D", "DR2"]) {
      for (const f of ["rendezVous", "rendezVousConclus", "honores", "ventes", "contracte", "annules"]) o[f + suf] = 0;
    }
    return o;
  };
  const parCle = {};
  // Premiere issue setter (ligne "SETTER-...") par contact : un call Rattrapage pris
  // APRES est un call du Setting, pas de l'acquisition (decision 2026-10-31).
  const premiereIssueSetter = new Map();
  for (const c of callsBooked) {
    if (c.contactId == null || c.typeAppel !== "Diagnostic" || !String(c.bookingId || "").startsWith("SETTER-")) continue;
    const t = String(c.prisLe || "");
    if (!premiereIssueSetter.has(c.contactId) || t < premiereIssueSetter.get(c.contactId)) premiereIssueSetter.set(c.contactId, t);
  }
  for (const c of callsBooked) {
    // Rattrapage (Diagnostic) : champs suffixes "D", tous rangs confondus.
    // Rattrapage = type "Rattrapage" (nouveau) ou ancien "Diagnostic" sans prefixe SETTER- ;
    // un Diagnostic "SETTER-" est un call de setting : hors acquisition.
    const rattrapage = c.typeAppel === "Rattrapage" || (c.typeAppel === "Diagnostic" && !String(c.bookingId || "").startsWith("SETTER-"));
    if (c.typeAppel !== "Closing" && !rattrapage) continue;
    if (rattrapage && c.contactId != null && premiereIssueSetter.has(c.contactId) && premiereIssueSetter.get(c.contactId) <= String(c.prisLe || "")) continue;
    // Rattrapage : meme logique de rang que le Closing (R1 -> "D", R2+ -> "DR2").
    const suf = rattrapage ? (c.rangR === 1 ? "D" : c.rangR > 1 ? "DR2" : null) : c.rangR === 1 ? "" : c.rangR > 1 ? "R2" : null;
    if (suf === null) continue;
    const jour = jourParis(c.prisLe);
    if (!jour) continue;
    const cle = cleLigne(jour, c.canal, c.produit);
    const p = (parCle[cle] = parCle[cle] || champsVides());
    p["rendezVous" + suf] += 1;
    p["rendezVousConclus" + suf] += c.conclu || 0;
    p["honores" + suf] += c.present || 0;
    p["ventes" + suf] += c.vente || 0;
    p["contracte" + suf] += c.montant || 0;
    p["annules" + suf] += c.annule || 0;
  }
  return parCle;
}

// Acquisition par client. Renvoie, par ID de ligne ACQUISITION :
//  - clients      : nombre de clients (avec au moins un contrat) issus de ce lead
//  - contracte1er : contracte du PREMIER achat (tous les contrats signes a la
//                   date du 1er contrat, abonnement Media Buying pris en
//                   option ce jour-la compris : 1re mensualite = CA
//                   d'acquisition ; les suivantes vont dans la LTV)
//  - encaisseTous : encaisse sur TOUS les contrats du client (a date)
function recalculerParClient(callsBooked, leads, contrats, paiements = []) {
  // lead -> ligne (jour|canal|produit) du call Closing R1
  const ligneParLeadViaCall = {};
  for (const c of callsBooked) {
    if (c.typeAppel !== "Closing" || c.rangR !== 1) continue;
    const jour = jourParis(c.prisLe);
    if (!jour) continue;
    for (const idLead of c[CHAMP_LIEN_LEAD] || []) {
      if (!ligneParLeadViaCall[idLead]) ligneParLeadViaCall[idLead] = { jour, canal: c.canal || SANS, produit: c.produit || SANS };
    }
  }

  // client -> contrats
  const contratsParClient = {};
  for (const k of contrats) {
    for (const idClient of k[CHAMP_CONTRAT_CLIENT] || []) {
      (contratsParClient[idClient] = contratsParClient[idClient] || []).push(k);
    }
  }

  // client -> paiements recus (dates + montants), pour les cohortes
  const paiementsParClient = {};
  for (const pa of paiements) {
    if (!pa.datePaiement || !(pa.montantRecu > 0)) continue;
    for (const idClient of pa[CHAMP_PAIEMENT_CLIENT] || []) {
      (paiementsParClient[idClient] = paiementsParClient[idClient] || []).push({
        jour: String(pa.datePaiement).slice(0, 10),
        montant: pa.montantRecu,
      });
    }
  }

  const parIdAcquisition = {};
  const detail = [];
  const clientsDejaVus = new Set();

  for (const lead of leads) {
    const idsClient = lead[CHAMP_LEAD_CLIENT] || [];
    if (!idsClient.length) continue;
    const idClient = idsClient[0];
    if (clientsDejaVus.has(idClient)) continue; // un client = un seul lead d'origine
    const mesContrats = contratsParClient[idClient] || [];
    if (!mesContrats.length) continue;

    const ligneLead = ligneParLeadViaCall[lead._id] || (lead.capteLe ? { jour: jourParis(lead.capteLe), canal: lead.canal || SANS, produit: lead.produit || SANS } : null);
    if (!ligneLead) continue;
    const idLigne = cleLigne(ligneLead.jour, ligneLead.canal, ligneLead.produit);
    clientsDejaVus.add(idClient);

    const dates = mesContrats.map((k) => String(k.dateSignature || "")).filter(Boolean).sort();
    const d0 = dates[0] || "";
    const duJour = mesContrats.filter((k) => String(k.dateSignature || "") === d0);
    // 1er achat = TOUS les contrats du jour du 1er contrat, abonnement Media Buying
    // pris en option compris (decision 2026-10-20) : sa 1re mensualite est du CA
    // d'acquisition, les mensualites suivantes ne comptent que dans la LTV
    // (encaisseTous).
    const premier = duJour;

    const p = (parIdAcquisition[idLigne] = parIdAcquisition[idLigne] || { clients: 0, contracte1er: 0, encaisseTous: 0 });
    p.clients += 1;
    p.contracte1er += premier.reduce((s, k) => s + (k.montantTotal || 0), 0);
    p.encaisseTous += mesContrats.reduce((s, k) => s + (k.montantRecu || 0), 0);

    detail.push({
      jour: ligneLead.jour,
      canal: ligneLead.canal,
      produit: ligneLead.produit,
      // nombre de prestations (hors abonnement) : >= 2 = client qui a renouvele
      prestations: mesContrats.filter((k) => k.typeContrat !== "Abonnement").length,
      paiements: paiementsParClient[idClient] || [],
    });
  }

  return { parIdAcquisition, detail };
}

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;

  if (!token) {
    return res.status(500).json({
      erreur:
        "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const [lignesAcquisition, callsBooked, leads, contrats, paiements] = await Promise.all([
      lireTable(token, TABLE_ACQUISITION, CHAMPS_ACQUISITION),
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED, [CHAMP_LIEN_LEAD, CHAMP_LIEN_CONTRATS]),
      lireTable(token, TABLE_LEADS, CHAMPS_LEADS, [CHAMP_LEAD_CLIENT]),
      lireTable(token, TABLE_CONTRATS, CHAMPS_CONTRATS, [CHAMP_CONTRAT_CLIENT]),
      lireTable(token, TABLE_PAIEMENTS, CHAMPS_PAIEMENTS, [CHAMP_PAIEMENT_CLIENT]),
    ]);

    // Ventes et CA = CONTRATS (meme regle que api/sales-team.js, decision
    // 2026-10-05) : un call est une vente s'il est rattache a un contrat, son CA
    // est le montant de ce contrat. L'issue iClosed (SALE) n'est plus utilisee.
    // Tous les contrats comptent, abonnements compris (montant = 1er mois).
    // L'Intake ne relie au call que le contrat principal : on y ajoute les
    // contrats du meme client signes le meme jour (ex. abonnement Media Buying
    // pris en option avec un pack). Une seule vente, montant = somme.
    const montantContrat = new Map(contrats.map((k) => [k._id, k.montantTotal || 0]));
    const contratsParClientJour = new Map();
    const contratParId = new Map(contrats.map((k) => [k._id, k]));
    const cleClientJour = (idClient, k) => `${idClient}|${String(k.dateSignature || "").slice(0, 10)}`;
    for (const k of contrats) {
      for (const idClient of k[CHAMP_CONTRAT_CLIENT] || []) {
        const cle = cleClientJour(idClient, k);
        if (!contratsParClientJour.has(cle)) contratsParClientJour.set(cle, []);
        contratsParClientJour.get(cle).push(k._id);
      }
    }
    for (const c of callsBooked) {
      const ids = new Set();
      for (const id of c[CHAMP_LIEN_CONTRATS] || []) {
        const k = contratParId.get(id);
        if (!k) continue;
        ids.add(id);
        for (const idClient of k[CHAMP_CONTRAT_CLIENT] || []) {
          for (const frere of contratsParClientJour.get(cleClientJour(idClient, k)) || []) ids.add(frere);
        }
      }
      c.vente = ids.size > 0 ? 1 : 0;
      c.montant = [...ids].reduce((t, id) => t + (montantContrat.get(id) || 0), 0);
    }

    const recalcul = recalculerDepuisCallBooked(callsBooked);
    const { parIdAcquisition: parClient, detail: clientsDetail } = recalculerParClient(callsBooked, leads, contrats, paiements);
    const vide = {
      rendezVous: 0, rendezVousConclus: 0, honores: 0, ventes: 0, contracte: 0, annules: 0,
      rendezVousR2: 0, rendezVousConclusR2: 0, honoresR2: 0, ventesR2: 0, contracteR2: 0, annulesR2: 0,
      rendezVousD: 0, rendezVousConclusD: 0, honoresD: 0, ventesD: 0, contracteD: 0, annulesD: 0,
      rendezVousDR2: 0, rendezVousConclusDR2: 0, honoresDR2: 0, ventesDR2: 0, contracteDR2: 0, annulesDR2: 0,
    };
    const videClient = { clients: 0, contracte1er: 0, encaisseTous: 0 };

    // Lignes = depense ACQUISITION + comptages calcules. On cree une ligne des
    // qu'un lead, un call ou un client existe sur une cle sans depense.
    const parCle = new Map();
    const ligneDe = (jour, canal, produit) => {
      const cle = cleLigne(jour, canal, produit);
      if (!parCle.has(cle)) {
        parCle.set(cle, { cle, jour, canal: canal || SANS, produit: produit || SANS, depense: 0, impressions: 0, clics: 0, leads: 0 });
      }
      return parCle.get(cle);
    };
    for (const a of lignesAcquisition) {
      const jour = a.jour ? String(a.jour).slice(0, 10) : null;
      if (!jour) continue;
      const l = ligneDe(jour, a.canal, a.produit);
      l.depense += a.depense ?? 0;
      l.impressions += a.impressions ?? 0;
      l.clics += a.clics ?? 0;
    }
    for (const ld of leads) {
      const jour = jourParis(ld.capteLe);
      if (jour) ligneDe(jour, ld.canal, ld.produit).leads += 1;
    }
    for (const cle of Object.keys(recalcul)) {
      const [jour, canal, produit] = cle.split(" | ");
      ligneDe(jour, canal, produit);
    }
    for (const cle of Object.keys(parClient)) {
      const [jour, canal, produit] = cle.split(" | ");
      ligneDe(jour, canal, produit);
    }

    const lignes = [...parCle.values()].map((ligne) => {
      const r = recalcul[ligne.cle] || vide;
      const cl = parClient[ligne.cle] || videClient;
      return {
        ...ligne,
        rendezVous: r.rendezVous,
        rendezVousConclus: r.rendezVousConclus,
        honores: r.honores,
        ventes: r.ventes,
        contracte: r.contracte,
        annules: r.annules,
        rendezVousR2: r.rendezVousR2,
        rendezVousConclusR2: r.rendezVousConclusR2,
        honoresR2: r.honoresR2,
        ventesR2: r.ventesR2,
        contracteR2: r.contracteR2,
        annulesR2: r.annulesR2,
        rendezVousD: r.rendezVousD,
        rendezVousConclusD: r.rendezVousConclusD,
        honoresD: r.honoresD,
        ventesD: r.ventesD,
        contracteD: r.contracteD,
        annulesD: r.annulesD,
        rendezVousDR2: r.rendezVousDR2,
        rendezVousConclusDR2: r.rendezVousConclusDR2,
        honoresDR2: r.honoresDR2,
        ventesDR2: r.ventesDR2,
        contracteDR2: r.contracteDR2,
        annulesDR2: r.annulesDR2,
        clients: cl.clients,
        contracte1er: cl.contracte1er,
        encaisseTous: cl.encaisseTous,
      };
    });

    lignes.sort((a, b) => String(b.jour ?? "").localeCompare(String(a.jour ?? "")));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbLignes: lignes.length,
      lignes,
      clientsDetail,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
