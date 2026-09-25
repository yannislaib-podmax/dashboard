// Fonction serveur — pilotage quotidien PodMax.
//
// Distincte de /api/acquisition.js (qui lit la table ACQUISITION, rattachée
// au jour de RÉSERVATION du rendez-vous — la bonne base pour le CPA/CAC/ROAS
// et les taux de conversion, mais qui ne dit pas ce qui s'est passé
// aujourd'hui : un appel réservé il y a 4 jours peut avoir lieu aujourd'hui).
//
// Celle-ci lit directement la table CALL BOOKED et regroupe les appels par
// le jour où ils ont RÉELLEMENT eu lieu (champ "Date du rendez-vous"), pas
// par leur jour de réservation. Elle sert au pilotage opérationnel du jour
// (l'équipe est-elle productive aujourd'hui, y a-t-il un problème de
// no-show ce jour précis) — jamais au calcul de rentabilité publicitaire.
//
// Volontairement : que des COMPTAGES bruts, pas de taux de conversion. Un
// taux (% honorés, % closing) n'a de sens que rapporté à une cohorte
// complète ; le mélanger avec une vue "jour de l'appel" produirait un
// chiffre qui a l'air d'un taux de conversion mais n'en est pas un.
//
// Le jeton Airtable ne quitte jamais le serveur (AIRTABLE_TOKEN, Vercel).

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_ID = "tblaY2J8SD0grDEOK"; // CALL BOOKED

const CHAMPS = {
  fldhiaObnPFQjPioa: "bookingId",
  fld1oLvpPAWeppnwM: "dateAppel", // Date du rendez-vous — jour réel de l'appel
  fldUxmqK72q9MWwJe: "statut", // Confirmé / Honoré / No-show / Annulé
  fldIJJbmVTPBFHt1o: "issue", // SALE / NO_SALE / NO_SHOW / Autre
  fld1GgVHXLLo54h8s: "montantDeal",
  fldONsYE6GNJUI15C: "canal",
  fldChsnbeVQFDCmjy: "produit",
};

function valeur(brut) {
  if (brut === undefined || brut === null) return null;
  if (Array.isArray(brut)) {
    return brut.map((v) => (v && v.name !== undefined ? v.name : v)).join(", ");
  }
  if (typeof brut === "object" && brut.name !== undefined) return brut.name;
  return brut;
}

async function lireTousLesAppels(token) {
  const enregistrements = [];
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
      const appel = {};
      for (const [id, nom] of Object.entries(CHAMPS)) {
        appel[nom] = valeur(enr.fields[id]);
      }
      enregistrements.push(appel);
    }

    offset = donnees.offset;
  } while (offset);

  return enregistrements;
}

// Regroupe les appels par jour RÉEL d'appel (pas par jour de réservation),
// canal et produit — même granularité que l'ACQUISITION cohorte, mais sur
// une clé différente, pour que les deux ne soient jamais confondues.
function regrouperParJour(appels) {
  const parCle = new Map();

  for (const a of appels) {
    if (!a.dateAppel) continue; // pas de date de rendez-vous : rien à classer

    const jour = String(a.dateAppel).slice(0, 10);
    const canal = a.canal || "Autre";
    const produit = a.produit || "Autre";
    const cle = `${jour} | ${canal} | ${produit}`;

    if (!parCle.has(cle)) {
      parCle.set(cle, {
        cle,
        jour,
        canal,
        produit,
        appelsPrevus: 0, // tous statuts, y compris "Confirmé" (pas encore passé)
        appelsConclus: 0, // Honoré ou No-show : l'issue est connue
        honores: 0,
        noShow: 0,
        annules: 0,
        ventes: 0,
        contracte: 0,
      });
    }

    const ligne = parCle.get(cle);
    ligne.appelsPrevus += 1;

    if (a.statut === "Honoré" || a.statut === "No-show") ligne.appelsConclus += 1;
    if (a.statut === "Honoré") ligne.honores += 1;
    if (a.statut === "No-show") ligne.noShow += 1;
    if (a.statut === "Annulé") ligne.annules += 1;

    if (a.issue === "SALE") {
      ligne.ventes += 1;
      ligne.contracte += Number(a.montantDeal) || 0;
    }
  }

  return [...parCle.values()];
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
    const appels = await lireTousLesAppels(token);
    const lignes = regrouperParJour(appels);

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
