# Cadastre · Souzy-la-Briche (web app)

Web app installable (PWA) qui, à partir du GPS du téléphone (ou d'un point touché sur la carte), affiche :

- la **parcelle cadastrale** (section, numéro, contenance, identifiant) — API Carto IGN, module cadastre ;
- le **document d'urbanisme** et le **zonage** (UA, UB, A, N…) avec lien vers le règlement — API Carto GPU ;
- les **servitudes d'utilité publique** (AC1, AC2, I4, PT2…), prescriptions et informations — API Carto GPU ;
- les **données du WMS `https://data.geopf.fr/wms-v/ows`** : l'app lit le GetCapabilities au lancement, coche par défaut les couches cadastre / urbanisme / servitudes, les affiche sur la carte et les interroge par **GetFeatureInfo** à chaque position. Le menu ☰ permet de choisir d'autres couches du service.

Commune paramétrée : Souzy-la-Briche (INSEE 91602), dans `CONFIG` en haut de `app.js`.

## Utilisation

- **◎** : localise une fois et affiche les infos.
- **Suivre** : met à jour les infos en marchant (tous les 15 m, au plus toutes les 5 s).
- Toucher la carte : interroge ce point (utile depuis un ordinateur).
- Le panneau du bas se déplie en touchant sa poignée.

## Hors ligne

Bouton **⇩** en haut : « Télécharger la commune » (avec du réseau, idéalement en Wi-Fi).
L'app enregistre sur le téléphone les parcelles de la commune, le document d'urbanisme, le zonage,
les servitudes, prescriptions et informations (API Carto), ainsi que les tuiles de carte
(Plan IGN, plan cadastral, couches WMS cochées, et en option les photos aériennes).

Sans réseau, la position GPS est comparée localement à ces données : mêmes informations qu'en ligne,
sauf l'interrogation GetFeatureInfo du WMS, qui demande une connexion. Si le réseau tombe en cours
d'utilisation, l'app bascule seule sur les données téléchargées. « Mettre à jour » rafraîchit les données.

## Hébergement (GitHub Pages)

Le GPS d'un navigateur n'est disponible qu'en **HTTPS**, d'où l'hébergement.

1. Créer un dépôt GitHub public, par ex. `cadastre-souzy`.
2. Y déposer **tout le contenu de ce dossier** (index.html à la racine). Sur github.com : *Add file › Upload files*.
3. *Settings › Pages* : Source = *Deploy from a branch*, branche `main`, dossier `/ (root)`.
4. L'app est en ligne à `https://<votre-compte>.github.io/cadastre-souzy/`.
5. Sur Android, l'ouvrir dans Chrome puis menu ⋮ › **Ajouter à l'écran d'accueil** (ou « Installer l'application »).

Netlify Drop (glisser-déposer le dossier sur https://app.netlify.com/drop) fonctionne aussi.

Pour tester sur un ordinateur : `python3 -m http.server` dans ce dossier puis http://localhost:8000.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | interface mobile |
| `app.js` | carte Leaflet, géolocalisation, appels API Carto et WMS |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation PWA et fonctionnement hors ligne de l'interface |
| `vendor/leaflet/` | Leaflet 1.9.4 embarqué |
