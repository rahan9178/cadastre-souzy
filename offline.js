/* Cadastre · Souzy-la-Briche — mode hors ligne
 * - stockage des données de la commune (GeoJSON) dans IndexedDB
 * - recherche locale « qu'y a-t-il à ce point ? » (point dans polygone, distance aux lignes/points)
 * - téléchargement des tuiles de carte dans le Cache Storage (servies ensuite par sw.js)
 */
'use strict';

const Offline = (() => {
  const DB_NAME = 'cadastre-offline', STORE = 'kv', TILE_CACHE = 'cadastre-tiles';

  // Couches API Carto téléchargées. geom : 'commune' = rectangle englobant de la commune
  const DATASETS = [
    { key: 'parcelle', path: '/cadastre/parcelle', by: 'insee' },
    { key: 'document', path: '/gpu/document' },
    { key: 'zone', path: '/gpu/zone-urba' },
    { key: 'secteurCC', path: '/gpu/secteur-cc' },
    { key: 'supS', path: '/gpu/assiette-sup-s' },
    { key: 'supL', path: '/gpu/assiette-sup-l' },
    { key: 'supP', path: '/gpu/assiette-sup-p' },
    { key: 'prescS', path: '/gpu/prescription-surf' },
    { key: 'prescL', path: '/gpu/prescription-lin' },
    { key: 'prescP', path: '/gpu/prescription-pct' },
    { key: 'infoS', path: '/gpu/info-surf' },
    { key: 'infoL', path: '/gpu/info-lin' },
    { key: 'infoP', path: '/gpu/info-pct' }
  ];

  // ------------------------------------------------------------ IndexedDB
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const idbGet = (k) => tx('readonly', (s) => s.get(k));
  const idbPut = (k, v) => tx('readwrite', (s) => s.put(v, k));
  const idbClear = () => tx('readwrite', (s) => s.clear());

  // ------------------------------------------------------------ géométrie
  // Coordonnées locales en mètres autour d'un point (équirectangulaire, suffisant à l'échelle d'une commune)
  function toMeters(lat0) {
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return (lng, lat, lng0) => [(lng - lng0) * kx, (lat - lat0) * ky];
  }
  function ringContains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const polyContains = (rings, x, y) => ringContains(rings[0], x, y) && !rings.slice(1).some((h) => ringContains(h, x, y));
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  // Vrai si la géométrie contient le point (surfaces) ou passe à moins de tol mètres (lignes, points)
  function hits(geom, lat, lng, tol) {
    if (!geom) return false;
    const m = toMeters(lat);
    const lineHit = (coords) => {
      for (let i = 1; i < coords.length; i++) {
        const [ax, ay] = m(coords[i - 1][0], coords[i - 1][1], lng), [bx, by] = m(coords[i][0], coords[i][1], lng);
        if (segDist(0, 0, ax, ay, bx, by) <= tol) return true;
      }
      return false;
    };
    switch (geom.type) {
      case 'Polygon': return polyContains(geom.coordinates, lng, lat);
      case 'MultiPolygon': return geom.coordinates.some((p) => polyContains(p, lng, lat));
      case 'LineString': return lineHit(geom.coordinates);
      case 'MultiLineString': return geom.coordinates.some(lineHit);
      case 'Point': return Math.hypot(...m(geom.coordinates[0], geom.coordinates[1], lng)) <= tol;
      case 'MultiPoint': return geom.coordinates.some((c) => Math.hypot(...m(c[0], c[1], lng)) <= tol);
      case 'GeometryCollection': return geom.geometries.some((g) => hits(g, lat, lng, tol));
      default: return false;
    }
  }
  function bboxOf(geom) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    const walk = (x) => {
      if (typeof x[0] === 'number') { a = Math.min(a, x[0]); b = Math.min(b, x[1]); c = Math.max(c, x[0]); d = Math.max(d, x[1]); }
      else x.forEach(walk);
    };
    if (geom?.type === 'GeometryCollection') geom.geometries.forEach((g) => walk(g.coordinates));
    else if (geom?.coordinates) walk(geom.coordinates);
    return [a, b, c, d];
  }

  // ------------------------------------------------------------ données en mémoire
  let mem = null; // { meta, commune, municipality, sets: {key: [{f, bb}]} }

  async function load() {
    try {
      const meta = await idbGet('meta');
      if (!meta) { mem = null; return null; }
      const sets = {};
      for (const ds of DATASETS) {
        const feats = (await idbGet(`ds:${ds.key}`)) || [];
        sets[ds.key] = feats.map((f) => ({ f, bb: bboxOf(f.geometry) }));
      }
      mem = { meta, commune: await idbGet('commune'), municipality: await idbGet('municipality'), sets };
      return meta;
    } catch (e) { console.warn('Lecture des données hors ligne impossible', e); mem = null; return null; }
  }

  const available = () => !!mem;
  const meta = () => mem?.meta || null;
  const commune = () => mem?.commune || null;
  const municipality = () => mem?.municipality || null;

  // Même structure que la réponse réseau de queryAt()
  function query(latlng, tol = 10) {
    const { lat, lng } = latlng;
    const dLat = tol / 110540, dLng = tol / (111320 * Math.cos(lat * Math.PI / 180));
    const R = {};
    for (const ds of DATASETS) {
      R[ds.key] = (mem?.sets[ds.key] || [])
        .filter(({ bb }) => lng >= bb[0] - dLng && lng <= bb[2] + dLng && lat >= bb[1] - dLat && lat <= bb[3] + dLat)
        .filter(({ f }) => hits(f.geometry, lat, lng, tol))
        .map(({ f }) => f);
    }
    return R;
  }

  // ------------------------------------------------------------ téléchargement des données
  async function fetchAll(base, params, signal, onPage) {
    const limit = 500, out = [];
    for (let start = 0, page = 0; page < 100; start += limit, page++) {
      const url = `${base}?${new URLSearchParams({ ...params, _limit: limit, _start: start })}`;
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} sur ${base}`);
      const fc = await r.json();
      const feats = fc.features || [];
      out.push(...feats);
      onPage?.(out.length);
      if (feats.length < limit) break;
    }
    return out;
  }

  async function downloadData({ apicarto, insee, signal, onProgress }) {
    onProgress?.('Contour de la commune…', 0);
    const cr = await fetch(`${apicarto}/cadastre/commune?code_insee=${insee}`, { signal });
    if (!cr.ok) throw new Error(`Contour de la commune : HTTP ${cr.status}`);
    const communeFc = await cr.json();
    if (!communeFc.features?.length) throw new Error('Contour de la commune introuvable');
    const bb = communeFc.features.map((f) => bboxOf(f.geometry)).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const pad = 0.002; // ~150-200 m de marge autour de la commune
    const [x0, y0, x1, y1] = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad].map((v) => Math.round(v * 1e6) / 1e6);
    const geom = JSON.stringify({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });

    let municipality = null;
    try {
      const mr = await fetch(`${apicarto}/gpu/municipality?insee=${insee}`, { signal });
      if (mr.ok) municipality = (await mr.json()).features?.[0]?.properties || null;
    } catch (e) { if (e.name === 'AbortError') throw e; }

    const counts = {}, failed = [];
    const results = {};
    for (let i = 0; i < DATASETS.length; i++) {
      const ds = DATASETS[i];
      onProgress?.(`Téléchargement : ${ds.key}…`, i / DATASETS.length);
      const params = ds.by === 'insee' ? { code_insee: insee } : { geom };
      try {
        results[ds.key] = await fetchAll(`${apicarto}${ds.path}`, params, signal,
          (n) => onProgress?.(`Téléchargement : ${ds.key} (${n})…`, i / DATASETS.length));
        counts[ds.key] = results[ds.key].length;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failed.push(ds.key); results[ds.key] = null;
      }
    }
    if (!results.parcelle) throw new Error('Le téléchargement des parcelles a échoué');

    // On n'écrase un jeu existant que s'il a été téléchargé avec succès
    for (const ds of DATASETS) if (results[ds.key]) await idbPut(`ds:${ds.key}`, results[ds.key]);
    await idbPut('commune', communeFc);
    if (municipality) await idbPut('municipality', municipality);
    const m = { date: new Date().toISOString(), counts, failed, bbox: [x0, y0, x1, y1] };
    await idbPut('meta', m);
    try { await navigator.storage?.persist?.(); } catch { /* facultatif */ }
    await load();
    onProgress?.('Données enregistrées', 1);
    return m;
  }

  // ------------------------------------------------------------ tuiles
  // Liste des coordonnées de tuiles (schéma XYZ / PM) couvrant une emprise
  function tileCoords(bbox, zmin, zmax) {
    const [x0, y0, x1, y1] = bbox, out = [];
    const tx = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
    const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
    for (let z = zmin; z <= zmax; z++) {
      for (let x = tx(x0, z); x <= tx(x1, z); x++) for (let y = ty(y1, z); y <= ty(y0, z); y++) out.push({ x, y, z });
    }
    return out;
  }

  async function downloadTiles(urls, { signal, onProgress, concurrency = 6 }) {
    const cache = await caches.open(TILE_CACHE);
    let done = 0, failed = 0, i = 0;
    async function worker() {
      while (i < urls.length) {
        if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
        const url = urls[i++];
        try {
          if (!(await cache.match(url))) {
            const r = await fetch(url, { mode: 'cors', signal });
            if (r.ok) await cache.put(url, r); else failed++;
          }
        } catch (e) { if (e.name === 'AbortError') throw e; failed++; }
        done++;
        if (done % 10 === 0 || done === urls.length) onProgress?.(done, urls.length, failed);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { done, failed };
  }

  async function clearAll() {
    await idbClear();
    await caches.delete(TILE_CACHE);
    mem = null;
  }

  async function usage() {
    try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch { return 0; }
  }

  return { load, available, meta, commune, municipality, query, downloadData, tileCoords, downloadTiles, clearAll, usage, hits };
})();
