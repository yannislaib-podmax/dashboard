// Fonction serveur — données d'acquisition PodMax.
//
// Elle lit la table ACQUISITION d'Airtable (base HQ PODMAX AGENCY), qui porte
// les compteurs agrégés par jour, canal et produit : leads, rendez-vous,
// honorés, ventes, contracté, dépense/impressions/clics.
//
// Le jeton Airtable ne quitte jamais le serveur. Il est lu depuis la variable
// d'environnement AIRTABLE_TOKEN, définie dans les réglages du projet Vercel.
//
// On interroge Airtable par IDENTIFIANT de champ et non par nom : renommer une
// colonne dans Airtable ne cassera donc pas le dashboard.

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_ID = "tblIDuDZ25yvenkEz"; // ACQUISITION

// Correspondance identifiant Airtable → nom lisible côté page.
const CHAMPS = {
  fldQYnMqFJOdFILX7: "cle",
  fldboNJfQPWEGq99U: "jour",
  fldFNl3ulxKLH2wQH: "canal",
  fldnuLNAEqzPlLzne: "produit",
  fldfcxZxF1SFJCIXn: "depense",
  fldlnPS7oaGEHby25: "impressions",
  fldcaSJjaqKNqvGlV: "clics",
  fldU8PNMP8Qo3lJgs: "leads",
  fldU60JOee3IjwdLz: "rendezVous",
  fldaDyIgZYVpE7aLb: "honores",
  fldr1manDq32B8IFv: "ventes",
  fldIacFZj53jCcMzM: "contracte",
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

async function lireToutesLesLignes(token) {
  const lignes = [];
  let offset;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(CHAMPS).forEach((id) => url.searchParams.append("fields[]", id));
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
      for (const [id, nom] of Object.entries(CHAMPS)) {
        ligne[nom] = valeur(enr.fields[id]);
      }
      for (const compteur of [
        "depense", "impressions", "clics", "leads", "rendezVous", "honores", "ventes", "contracte",
      ]) {
        ligne[compteur] = ligne[compteur] ?? 0;
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
    const lignes = await lireToutesLesLignes(token);

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
