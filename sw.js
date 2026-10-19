// Service worker : l'app fonctionne hors ligne pour son interface ;
// les données (cadastre, GPU, WMS) restent interrogées en direct.
const CACHE = 'cadastre-souzy-v3';
const TILE_CACHE = 'cadastre-tiles'; // rempli par le bouton « Hors ligne » (offline.js)
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'offline.js', 'reseaux.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png', 'vendor/leaflet/images/layers.png', 'vendor/leaflet/images/layers-2x.png',
  'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Tuiles de carte (WMTS et WMS GetMap) : d'abord les tuiles téléchargées, sinon le réseau
  // (les requêtes « cors » viennent du téléchargement hors ligne : on les laisse passer directement)
  if (url.hostname === 'data.geopf.fr' && /request=(gettile|getmap)/i.test(url.search) && e.request.mode !== 'cors') {
    e.respondWith(caches.open(TILE_CACHE).then((c) => c.match(e.request.url)).then((r) => r || fetch(e.request)));
    return;
  }
  // GetCapabilities : réponse en cache immédiate, rafraîchie en arrière-plan
  if (url.hostname === 'data.geopf.fr' && /getcapabilities/i.test(url.search)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => cached);
      return cached || fresh;
    }));
    return;
  }
  // Interface de l'app : réseau d'abord, cache si hors ligne
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
  }
});
