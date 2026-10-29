// Fonction serveur — Cold call (Google Sheet des callers).
//
// Le dash ne lit PAS le Sheet directement : il appelle la web app Apps Script
// du Sheet (voir "Script Sheet - Cold call (date + stats dash).gs"), qui renvoie
// des AGREGATS par caller (aucun nom, telephone ou email de prospect).
// Un onglet = un caller : renommer ou ajouter un onglet met a jour le dash.
//
// Variables Vercel : OUTBOUND_SHEET_URL (URL de la web app, finit par /exec)
// et OUTBOUND_SHEET_TOKEN (meme valeur que JETON dans le script).

export default async function handler(req, res) {
  const url = process.env.OUTBOUND_SHEET_URL;
  const token = process.env.OUTBOUND_SHEET_TOKEN;

  if (!url || !token) {
    return res.status(500).json({
      erreur:
        "OUTBOUND_SHEET_URL / OUTBOUND_SHEET_TOKEN absents. Ajoute-les dans Vercel → Settings → Environment Variables, puis redéploie.",
    });
  }

  try {
    const reponse = await fetch(`${url}?token=${encodeURIComponent(token)}`, { redirect: "follow" });
    const texte = await reponse.text();
    let donnees;
    try {
      donnees = JSON.parse(texte);
    } catch {
      throw new Error("Réponse du Sheet illisible (déploiement Apps Script absent ou accès non public ?)");
    }
    if (donnees.erreur) throw new Error(donnees.erreur);

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({
      genereLe: donnees.genereLe,
      callers: donnees.callers || [],
    });
  } catch (erreur) {
    return res.status(502).json({ erreur: String(erreur.message || erreur) });
  }
}
