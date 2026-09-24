// Fonction serveur — données Direction (business) PodMax.
//
// Elle lit les tables CONTRATS et PAIEMENTS d'Airtable (base HQ PODMAX
// AGENCY) : ce qui a été vendu (contrats signés) et ce qui a été
// effectivement encaissé (paiements).
//
// Le jeton Airtable ne quitte jamais le serveur. Il est lu depuis la
// variable d'environnement AIRTABLE_TOKEN, définie dans les réglages du
// projet Vercel — la même que pour /api/acquisition.
//
// On interroge Airtable par IDENTIFIANT de champ et non par nom : renommer
// une colonne dans Airtable ne cassera donc pas le dashboard.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_CONTRATS = "tbl3SDo8VkXxXdzdA";
const TABLE_PAIEMENTS = "tblUodmImuM0egrdk";

const CHAMPS_CONTRATS = {
  fldCzfvguNxkUzm83: "idContrat",
  fldm0apf8f0JU1AIF: "client", // lien -> CLIENTS (tableau d'ids)
  fldTBSFvLGbiZKter: "typeContrat", // Abonnement / Prestation
  fldIiqgAqlAgzvs2L: "produit", // Produit / Pack
  fldCpECeifMRZHfwi: "moyenPaiement",
  fldlhedw3iJNyAITQ: "dateSignature",
  fldyJLMnj69dcqh6s: "canal",
  fldfDATKrrUGmTTFV: "closer",
  fldz1nshv9SfQLn04: "montantTotal",
  fldjHO9Feh6daNVbg: "statut",
  fldXz0ZazL2zKHt18: "dateResiliation",
  fldcExyrANUkkgBP5: "montantLtv", // rollup : total reçu sur ce contrat
  fldy8OIvfHdsHTCCm: "caNet",
};

const CHAMPS_PAIEMENTS = {
  fldZtXS9ve11uVVEz: "idPaiement",
  fldEOcNYA9u1DzLxR: "contrat", // lien -> CONTRATS (tableau d'ids)
  fldp86WBeIMehdpPo: "client", // lien -> CLIENTS (tableau d'ids)
  fldWJoZHWyeXsHNvM: "montantPrevu",
  fldo1n4fRI9ZoLGeN: "montantRecu",
  fldQTgnGDxV0v9wpr: "datePaiement",
  fldFI3itlnPWMt6Hn: "statutPaiement",
};

// Un select Airtable arrive sous forme d'objet { id, name, color } ; un
// multipleSelects arrive en tableau d'objets ; un lien arrive en tableau
// d'identifiants ; un nombre arrive brut ; un champ vide n'arrive pas du
// tout.
function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) {
    return brut.map((v) => (v && v.name !== undefined ? v.name : v));
  }
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
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

    const reponse = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!reponse.ok) {
      const detail = await reponse.text();
      throw new Error(`Airtable a répondu ${reponse.status} : ${detail}`);
    }

    const donnees = await reponse.json();

    for (const enr of donnees.records) {
      const ligne = { id: enr.id };
      for (const [id, nom] of Object.entries(champs)) {
        ligne[nom] = valeur(enr.fields[id]);
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
    const [contrats, paiements] = await Promise.all([
      lireTable(token, TABLE_CONTRATS, CHAMPS_CONTRATS),
      lireTable(token, TABLE_PAIEMENTS, CHAMPS_PAIEMENTS),
    ]);

    contrats.sort((a, b) => String(b.dateSignature ?? "").localeCompare(String(a.dateSignature ?? "")));
    paiements.sort((a, b) => String(b.datePaiement ?? "").localeCompare(String(a.datePaiement ?? "")));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbContrats: contrats.length,
      nbPaiements: paiements.length,
      contrats,
      paiements,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
