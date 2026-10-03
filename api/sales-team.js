// Fonction serveur — Sales Team PodMax (Closing + Setting).
//
// Lit CALL BOOKED et LEADS (base HQ PODMAX AGENCY) pour piloter la performance
// individuelle de l'équipe de vente :
//  - Closing : les calls Closing de CALL BOOKED, par Closer (qui décroche R1,
//    R2... et combien ça rapporte).
//  - Setting : les leads assignés à un Setter, qui recouvrent deux familles
//    bien distinctes (décision du 2026-10-04) :
//      Famille 1 — Base de données : le setter s'assigne un vieux contact
//      iClosed jamais passé par le funnel (jamais disqualifié), l'appelle
//      lui-même et enregistre l'issue via le scénario "Issue d'appel
//      Diagnostic/Setting" (7688084), qui crée une ligne CALL BOOKED
//      synthétique dont le Booking ID commence par "SETTER-" (pas de vraie
//      réservation iClosed). Objectif : le taux de transfo direct en appel
//      de Closing booké.
//      Famille 2 — Rattrapage : le lead a été disqualifié par le funnel
//      normal, puis a lui-même réservé un vrai call Diagnostic (Booking ID
//      standard, pas de préfixe "SETTER-") que le setter traite. Objectif :
//      le taux de rattrapage, c'est-à-dire la part de ces disqualifiés qui
//      finissent quand même par booker un call de Closing grâce au setter.
//    On distingue les deux uniquement par le Booking ID du call Diagnostic
//    (préfixe "SETTER-" = Famille 1, sinon Famille 2) — c'est le seul signal
//    stable dans le temps (le Statut du lead change après coup, lui).
//
// Lignes brutes renvoyées (comme /api/tracking.js) : l'agrégation par
// closer/setter et par période se fait côté app.js, pour rester cohérente
// avec le filtre période global du dashboard. iClosed Contact ID est renvoyé
// sur les leads ET les calls pour permettre de relier un call Diagnostic à un
// éventuel call Closing du même contact (le "taux de transfo"/"rattrapage").
//
// Le jeton Airtable ne quitte jamais le serveur (AIRTABLE_TOKEN, Vercel).

const BASE_ID = "appL3hZhYJwCADFHm";
const TABLE_LEADS = "tblFfUo3I4ihrQmzr";
const TABLE_CALL_BOOKED = "tblaY2J8SD0grDEOK";

const CHAMPS_LEADS = {
  fldaUTHkR9vloCz2e: "capteLe",
  fldPQJPP97FujIbNm: "contactId",
  fldrhu8o1b2Oroz5b: "setter",
  fldE9CLUd3f08MQri: "statut",
  fldsTCF9f3IolFvV1: "dateAssignation",
  fldreiHMlZQd2xHX3: "nbCallsBookes",
};

const CHAMPS_CALL_BOOKED = {
  fldhiaObnPFQjPioa: "bookingId",
  fldLSlGP0yarBWZB8: "contactId",
  fld1oLvpPAWeppnwM: "jourRdvDt", // Date du rendez-vous — jour réel de l'appel
  fldOrfHds1MiMVehg: "prisLe",
  fldFPd5SGaSFfImIE: "typeAppel", // Closing / Diagnostic
  fldbZUTmmr0Nc2N7B: "closer",
  fldGgYg63q8hUIzqK: "setter",
  fldUxmqK72q9MWwJe: "statut", // Confirmé / Annulé / Honoré / No-show
  fldIJJbmVTPBFHt1o: "issue",
  fldTBeyP7bcOpxz4p: "rangR",
  fld1GgVHXLLo54h8s: "montant",
  fldONsYE6GNJUI15C: "canal",
  fldChsnbeVQFDCmjy: "produit",
  fldS2brPeHHyuCRf3: "present", // formule 0/1
  fldHub4Sw3d9ZiEzC: "conclu", // formule 0/1 (Honoré ou No-show)
  fldwA9cRx6qHqForP: "vente", // formule 0/1
};

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

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;

  if (!token) {
    return res.status(500).json({
      erreur:
        "AIRTABLE_TOKEN absent. Ajoute-le dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const [leadsBrut, callsBrut] = await Promise.all([
      lireTable(token, TABLE_LEADS, CHAMPS_LEADS),
      lireTable(token, TABLE_CALL_BOOKED, CHAMPS_CALL_BOOKED),
    ]);

    const leads = leadsBrut
      .filter((l) => l.setter) // un lead jamais assigné à un setter n'a rien à faire ici
      .map((l) => ({
        jour: l.capteLe ? String(l.capteLe).slice(0, 10) : null,
        jourAssignation: l.dateAssignation ? String(l.dateAssignation).slice(0, 10) : null,
        contactId: l.contactId ?? null,
        setter: l.setter,
        statut: l.statut,
        nbCallsBookes: l.nbCallsBookes || 0,
      }));

    const calls = callsBrut
      .filter((c) => c.typeAppel === "Closing" || c.typeAppel === "Diagnostic")
      .map((c) => ({
        jour: c.jourRdvDt ? String(c.jourRdvDt).slice(0, 10) : null,
        contactId: c.contactId ?? null,
        typeAppel: c.typeAppel,
        // Famille 1 (base de données, auto-assignation) vs Famille 2
        // (rattrapage post-disqualification) — uniquement pour les calls
        // Diagnostic ; null pour les calls Closing (pas concernés).
        famille: c.typeAppel === "Diagnostic" ? (String(c.bookingId || "").startsWith("SETTER-") ? 1 : 2) : null,
        closer: c.closer,
        setter: c.setter,
        statut: c.statut,
        issue: c.issue,
        rangR: c.rangR,
        montant: c.montant || 0,
        canal: c.canal,
        produit: c.produit,
        present: c.present || 0,
        conclu: c.conclu || 0,
        vente: c.vente || 0,
      }));

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      genereLe: new Date().toISOString(),
      nbLeads: leads.length,
      nbCalls: calls.length,
      leads,
      calls,
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
