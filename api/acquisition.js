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
  fldONsYE6GNJUI15C: "canal",
  fldChsnbeVQFDCmjy: "produit",
  fldS2brPeHHyuCRf3: "present",
  fldHub4Sw3d9ZiEzC: "conclu",
  fldwA9cRx6qHqForP: "vente",
  fld1GgVHXLLo54h8s: "montant",
  fldFPd5SGaSFfImIE: "typeAppel",
  fldTBeyP7bcOpxz4p: "rangR",
};

const CHAMP_LIEN_ACQUISITION = "fld5Wqq8cb4vPqWW2"; // "Dépense média" — lien CALL BOOKED -> ACQUISITION

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

// Recalcule rendezVous/rendezVousConclus/honores/ventes/contracte par ligne
// ACQUISITION (identifiée par son ID Airtable réel, pas par un texte
// reconstruit), à partir des seuls calls Closing de rang R1 — un lead qui
// relance (R2, R3...) ne doit pas compter comme un 2e rendez-vous.
function recalculerDepuisCallBooked(callsBooked) {
  const parIdAcquisition = {};
  const point = (id) => (parIdAcquisition[id] = parIdAcquisition[id] || { rendezVous: 0, rendezVousConclus: 0, honores: 0, ventes: 0, contracte: 0 });

  for (const c of callsBooked) {
    if (c.typeAppel !== "Closing" || c.rangR !== 1) continue;
    const idsLies = c[CHAMP_LIEN_ACQUISITION] || [];
    if (!idsLies.length) continue; // pas de ligne ACQUISITION liée — rien à rattacher

    const p = point(idsLies[0]);
    p.rendezVous += 1;
    p.rendezVousConclus += c.conclu || 0;
    p.honores += c.present || 0;
    p.ventes += c.vente || 0;
    p.contracte += c.montant || 0;
  }

  return parIdAcquisition;
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
    const [lignesAcquisition, callsBooked] = await Promise.all([
      lireTable(token, TABLE_ACQUISITION, CHAMPS_ACQUISITION),
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED, [CHAMP_LIEN_ACQUISITION]),
    ]);

    const recalcul = recalculerDepuisCallBooked(callsBooked);
    const vide = { rendezVous: 0, rendezVousConclus: 0, honores: 0, ventes: 0, contracte: 0 };

    const lignes = lignesAcquisition.map((ligne) => {
      const r = recalcul[ligne._id] || vide;
      const { _id, ...reste } = ligne;
      return {
        ...reste,
        depense: ligne.depense ?? 0,
        impressions: ligne.impressions ?? 0,
        clics: ligne.clics ?? 0,
        leads: ligne.leads ?? 0,
        rendezVous: r.rendezVous,
        rendezVousConclus: r.rendezVousConclus,
        honores: r.honores,
        ventes: r.ventes,
        contracte: r.contracte,
      };
    });

    lignes.sort((a, b) => String(b.jour ?? "").localeCompare(String(a.jour ?? "")));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbLignes: lignes.length,
      lignes,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
