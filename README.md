# Pilotage PodMax — Acquisition

Dashboard statique (HTML/CSS/JS vanilla) + une fonction serveur Vercel,
calqué sur le dashboard « Objectif Pro » mais aux couleurs PodMax (dégradé
magenta → violet du logo) et branché sur la base Airtable *HQ PODMAX AGENCY*,
table **ACQUISITION**.

## Les quatre fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page : barre de filtres, quatre vues |
| `assets/app.js` | Toute la logique : indicateurs, entonnoir, camemberts, infobulles, simulateur |
| `assets/style.css` | Jetons de couleur PodMax, composants du dashboard |
| `api/acquisition.js` | Fonction serveur Vercel — **le seul fichier qui touche Airtable** |

## Différences avec le funnel Objectif Pro

PodMax ne suit pas de conversation IA ni de lien envoyé, et la table
ACQUISITION ne détaille pas les no-shows/annulations/reports séparément :
le funnel est donc plus court — **Leads → Rendez-vous pris → Rendez-vous
honorés → Ventes** — sans filtre « funnel A/B ». Tout le reste (période,
canal, produit, comparaison, simulateur) fonctionne à l'identique.

## Sécurité

Le jeton Airtable **n'existe que côté serveur**, lu depuis la variable
d'environnement `AIRTABLE_TOKEN` définie dans Vercel. Il ne descend jamais
dans le navigateur.

`api/acquisition.js` interroge Airtable **par identifiant de champ**, jamais
par nom : renommer une colonne dans Airtable ne casse pas le dashboard.

## Lancer en local

Ce projet n'a pas de dépendance npm : c'est un dossier statique + une
fonction serverless. Pour le tester en local avec la fonction API, il faut le
CLI Vercel :

```bash
npm i -g vercel
cd podmax-pilotage
vercel dev
```

Il demandera de créer/lier un projet Vercel puis de configurer
`AIRTABLE_TOKEN` — indique ton Personal Access Token Airtable (scopes
`data.records:read` + `schema.bases:read`, limité à la base HQ PODMAX
AGENCY).

Sans le CLI Vercel, tu peux quand même ouvrir `index.html` dans un navigateur,
mais l'appel à `/api/acquisition` échouera puisqu'il n'y a personne pour
exécuter la fonction serveur.

## Déploiement

1. Crée un dépôt GitHub `podmax-pilotage`, pousse ce dossier.
2. Sur vercel.com, « Add New Project » → importe le dépôt.
3. Dans Project → Settings → Environment Variables, ajoute `AIRTABLE_TOKEN`.
4. Déploie. Les assets portent un `?v=` dans `index.html` — **incrémente-le
   à chaque modification de `app.js` ou `style.css`**, sinon impossible de
   savoir si le navigateur sert la nouvelle version ou l'ancienne en cache.
5. Project → Settings → Domains pour brancher ton nom de domaine.

## Ce qui reste à faire

- Automatiser la saisie de la dépense/impressions/clics (API Meta Ads),
  comme sur Objectif Pro.
- Brancher le CA réellement encaissé (table PAIEMENTS) une fois le lien
  Contrat ↔ Acquisition posé, pour un second ROAS « collecté ».
- Alerter en cas de panne silencieuse du scénario Make qui remplit
  ACQUISITION.
