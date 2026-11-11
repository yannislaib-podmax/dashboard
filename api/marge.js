// Fonction serveur — Marge brute PodMax (étape 1 : coûts de production).
//
// Lit CONTRATS (montant, net reçu, coût direct, marge brute) et LIGNES_COUT
// (détail des coûts par rôle / statut) dans Airtable (base HQ PODMAX AGENCY).
//
// Le jeton Airtable ne quitte jamais le serveur (variable AIRTABLE_TOKEN).
// Lecture par IDENTIFIANT de champ : renommer une colonne ne casse rien.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_CONTRATS = "tbl3SDo8VkXxXdzdA";
const TABLE_LIGNES_COUT = "tblhRBOnJ5EGK2cJk";

const CHAMPS_CONTRATS = {
  fldCzfvguNxkUzm83: "idContrat",
  fldIiqgAqlAgzvs2L: "produit",
  fldjHO9Feh6daNVbg: "statut",
  fldlhedw3iJNyAITQ: "dateSignature",
  fldz1nshv9SfQLn04: "montantTotal",
  fldy8OIvfHdsHTCCm: "caNet",
  fldKXecgVPkgvzMdf: "netRecu",
  flddeM9mdxdruwabs: "coutDirect",
  fldpnPICef2Vwwfem: "margeBrute",
  fldz4JsNJ81RK93lb: "estAbonnement",
};

const CHAMPS_LIGNES_COUT = {
  fldfdlVqErQKRh8XL: "idLigne",
  fld2UlCFj8zlH61zq: "contrat", // lien -> CONTRATS
  fldOHQcm9HcU3V0OL: "role",
  fldrPXTGI1EJVblTK: "statut",
  fldJz6KqGgiN75FLC: "nature",
  fldNfyWhi3io1aunr: "periode",
  fldpwiaYlDPMrpoWF: "montantRetenu",
  fldhkVNI717EqQfmq: "dateDue",
};

function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) {
    return brut.map((v) => (v && v.name !== undefined ? v.name : v));
  }
  if (typeof brut === "object") {
    if (brut.name !== undefined) return brut.name;
    if (brut.error !== undefined) return null; // erreur de formule Airtable
  }
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

    const reponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
      erreur: "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const [contrats, lignesCout] = await Promise.all([
      lireTable(token, TABLE_CONTRATS, CHAMPS_CONTRATS),
      lireTable(token, TABLE_LIGNES_COUT, CHAMPS_LIGNES_COUT),
    ]);

    contrats.sort((a, b) => String(b.dateSignature ?? "").localeCompare(String(a.dateSignature ?? "")));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbContrats: contrats.length,
      nbLignesCout: lignesCout.length,
      contrats,
      lignesCout,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
