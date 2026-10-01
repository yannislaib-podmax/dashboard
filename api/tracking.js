// Fonction serveur — tracking UTM PodMax.
//
// Elle lit LEADS et CALL BOOKED (base HQ PODMAX AGENCY) pour permettre de
// classer Source / Campagne / Content UTM par volume (leads, RDV booké, RDV
// honoré) et par CA contracté. Contrairement à ACQUISITION (agrégée par
// jour+canal+produit), on lit ici les lignes brutes : la granularité UTM n'a
// pas d'équivalent agrégé côté Airtable.
//
// Le jeton Airtable ne quitte jamais le serveur (AIRTABLE_TOKEN, Vercel).
// On interroge par IDENTIFIANT de champ, pas par nom.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_LEADS = "tblFfUo3I4ihrQmzr";
const TABLE_CALL_BOOKED = "tblaY2J8SD0grDEOK";

const CHAMPS_LEADS = {
  fldaUTHkR9vloCz2e: "capteLe",
  fldPsYc33WNxnbJx5: "source",
  fldllUNg0J5M1xIhb: "canal",
  fldGQUwkMl7QTDgQP: "produit",
  fldZdsEwaqcwqjqtg: "utmSource",
  fldptIrzRFTSHlI97: "utmCampaign",
  fldSuIDEn4U2QuUPv: "utmContent",
};

const CHAMPS_CALL_BOOKED = {
  fldOrfHds1MiMVehg: "prisLe",
  fldG440Cf4HAIkHEk: "source",
  fldONsYE6GNJUI15C: "canal",
  fldChsnbeVQFDCmjy: "produit",
  fldpmUNWfCbtLJFpv: "utmSource",
  fldSwOg00BaGNc9eH: "utmCampaign",
  fldTeh1hsGiPQGpN8: "utmContent",
  fldS2brPeHHyuCRf3: "present",
  fldHub4Sw3d9ZiEzC: "conclu",
  fldwA9cRx6qHqForP: "vente",
  fld1GgVHXLLo54h8s: "montant",
  fldFPd5SGaSFfImIE: "typeAppel",
  fldTBeyP7bcOpxz4p: "rangR",
};

// Un select Airtable arrive en objet { id, name, color } ; un multipleSelects
// arrive en tableau d'objets ; une date/nombre arrive brut ; un champ vide
// n'arrive pas du tout.
function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) {
    return brut.map((v) => (v && v.name !== undefined ? v.name : v)).join(", ");
  }
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
}

async function lireTable(token, tableId, champs, champJour) {
  const lignes = [];
  let offset;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(champs).forEach((id) => url.searchParams.append("fields[]", id));
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
      const ligne = {};
      for (const [id, nom] of Object.entries(champs)) {
        ligne[nom] = valeur(enr.fields[id]);
      }
      // Jour au format AAAA-MM-JJ, pour se brancher sur le même filtre
      // période que le reste du dashboard (DEBUT/FIN, format ISO court).
      ligne.jour = ligne[champJour] ? String(ligne[champJour]).slice(0, 10) : null;
      for (const compteur of ["present", "conclu", "vente", "montant"]) {
        if (compteur in ligne) ligne[compteur] = ligne[compteur] ?? 0;
      }
      lignes.push(ligne);
    }

    offset = donnees.offset;
  } while (offset);

  return lignes;
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
    const [leads, rdvBrut] = await Promise.all([
      lireTable(token, TABLE_LEADS, CHAMPS_LEADS, "capteLe"),
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED, "prisLe"),
    ]);

    // On exclut les calls Diagnostic (requalification post-disqualif, pas un
    // call produit) : seuls les calls Closing comptent pour le Tracking UTM.
    // Le Rang R (1/2/3...) reste dans la ligne : le funnel principal (cartes,
    // classement, camemberts, courbe) ne garde que le rang 1 côté app.js,
    // mais le rapport R1/R2 a besoin de voir aussi les rangs suivants.
    const rdv = rdvBrut
      .filter((r) => r.typeAppel === "Closing")
      .map(({ typeAppel, ...reste }) => reste);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbLeads: leads.length,
      nbRdv: rdv.length,
      leads,
      rdv,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
