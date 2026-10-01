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
      const ligne = {};
      for (const [id, nom] of Object.entries(champs)) {
        ligne[nom] = valeur(enr.fields[id]);
      }
      lignes.push(ligne);
    }

    offset = donnees.offset;
  } while (offset);

  return lignes;
}

// Même clé que la colonne "Clé" d'ACQUISITION (AAAA-MM-JJ | Canal | Produit),
// reconstruite à partir des champs bruts de CALL BOOKED (Pris le, Canal,
// Produit sont déjà les mêmes valeurs que celles écrites dans ACQUISITION par
// Make — pas besoin de refaire le calcul UTM → Canal/Produit ici).
function cleDe(jour, canal, produit) {
  return `${jour} | ${canal || ""} | ${produit || ""}`;
}

// Recalcule rendezVous/rendezVousConclus/honores/ventes/contracte par clé
// jour+canal+produit, à partir des seuls calls Closing de rang R1 — un lead
// qui relance (R2, R3...) ne doit pas compter comme un 2e rendez-vous.
function recalculerDepuisCallBooked(callsBooked) {
  const parCle = {};
  const point = (cle) => (parCle[cle] = parCle[cle] || { rendezVous: 0, rendezVousConclus: 0, honores: 0, ventes: 0, contracte: 0 });

  for (const c of callsBooked) {
    if (c.typeAppel !== "Closing" || c.rangR !== 1) continue;
    const jour = c.prisLe ? String(c.prisLe).slice(0, 10) : null;
    if (!jour) continue;

    const p = point(cleDe(jour, c.canal, c.produit));
    p.rendezVous += 1;
    p.rendezVousConclus += c.conclu || 0;
    p.honores += c.present || 0;
    p.ventes += c.vente || 0;
    p.contracte += c.montant || 0;
  }

  return parCle;
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
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED),
    ]);

    const recalcul = recalculerDepuisCallBooked(callsBooked);
    const vide = { rendezVous: 0, rendezVousConclus: 0, honores: 0, ventes: 0, contracte: 0 };
    const clesVues = new Set();

    const lignes = lignesAcquisition.map((ligne) => {
      const cle = ligne.cle || cleDe(ligne.jour, ligne.canal, ligne.produit);
      clesVues.add(cle);
      const r = recalcul[cle] || vide;
      return {
        ...ligne,
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

    // Filet de sécurité : un call R1 dont la clé jour+canal+produit n'a pas
    // (ou plus) de ligne ACQUISITION en face — ne devrait pas arriver (Make
    // upserte toujours la ligne ACQUISITION à la prise du call), mais si ça
    // arrive on ne veut pas perdre silencieusement du volume.
    for (const [cle, r] of Object.entries(recalcul)) {
      if (clesVues.has(cle)) continue;
      const [jour, canal, produit] = cle.split(" | ");
      lignes.push({
        cle, jour, canal: canal || null, produit: produit || null,
        depense: 0, impressions: 0, clics: 0, leads: 0,
        rendezVous: r.rendezVous,
        rendezVousConclus: r.rendezVousConclus,
        honores: r.honores,
        ventes: r.ventes,
        contracte: r.contracte,
      });
    }

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
