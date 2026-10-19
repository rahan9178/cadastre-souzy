/* Cadastre · Souzy-la-Briche — réseaux en open data
 * Électricité : Enedis (data.enedis.fr) et RTE ; gaz de transport : GRTgaz (ODRÉ, odre.opendatasoft.com).
 * Portails Opendatasoft : l'identifiant du jeu est essayé d'abord, puis une recherche dans le catalogue.
 * Les tracés sont indicatifs : ils ne remplacent pas une DT-DICT avant travaux.
 * L'eau potable et l'assainissement ne sont pas publiés en open data (plans détenus par le syndicat / délégataire).
 */
'use strict';

const Reseaux = (() => {
  const ENEDIS = 'https://data.enedis.fr', ODRE = 'https://odre.opendatasoft.com';
  const SOURCES = [
    { key: 'hta', portal: ENEDIS, id: 'reseau-hta', search: 'réseau HTA aérien', label: 'Ligne moyenne tension (HTA) aérienne', owner: 'Enedis', color: '#d32f2f' },
    { key: 'htaSout', portal: ENEDIS, id: 'reseau-souterrain-hta', search: 'réseau HTA souterrain', label: 'Câble moyenne tension (HTA) souterrain', owner: 'Enedis', color: '#d32f2f', dash: '6 5' },
    { key: 'bt', portal: ENEDIS, id: 'reseau-bt', search: 'réseau BT aérien', label: 'Ligne basse tension (BT) aérienne', owner: 'Enedis', color: '#ef6c00' },
    { key: 'btSout', portal: ENEDIS, id: 'reseau-souterrain-bt', search: 'réseau BT souterrain', label: 'Câble basse tension (BT) souterrain', owner: 'Enedis', color: '#ef6c00', dash: '6 5' },
    { key: 'postes', portal: ENEDIS, id: 'poste-electrique', search: 'postes HTA/BT', label: 'Poste électrique HTA/BT', owner: 'Enedis', color: '#6a1b9a' },
    { key: 'poteaux', portal: ENEDIS, id: 'position-geographique-des-poteaux-hta-et-bt', search: 'poteaux HTA BT', label: 'Poteau électrique', owner: 'Enedis', color: '#8d6e63' },
    { key: 'rte', portal: ODRE, id: 'lignes-aeriennes-rte-nv', search: 'lignes aériennes RTE', label: 'Ligne haute tension aérienne', owner: 'RTE', color: '#4a148c' },
    { key: 'rteSout', portal: ODRE, id: 'lignes-souterraines-rte-nv', search: 'lignes souterraines RTE', label: 'Ligne haute tension souterraine', owner: 'RTE', color: '#4a148c', dash: '6 5' },
    { key: 'gaz', portal: ODRE, id: 'trace-du-reseau-grt-250', search: 'tracé réseau GRTgaz', label: 'Canalisation de transport de gaz', owner: 'GRTgaz', color: '#f9a825' }
  ];
  const TOL = 15; // m : distance de recherche autour de la position
  let data = null; // { date, sets: { key: [feature] }, failed: [] }

  async function getJson(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // Trouve le jeu de données et son champ géographique
  async function resolve(src, signal) {
    const api = `${src.portal}/api/explore/v2.1/catalog/datasets`;
    const geoField = (ds) => (ds.fields || []).find((f) => f.type === 'geo_shape') || (ds.fields || []).find((f) => f.type === 'geo_point_2d');
    try {
      const ds = await getJson(`${api}/${src.id}`, signal);
      const g = geoField(ds);
      if (g) return { id: src.id, geo: g.name };
    } catch (e) { if (e.name === 'AbortError') throw e; }
    const found = await getJson(`${api}?${new URLSearchParams({ where: `search("${src.search}")`, limit: '10' })}`, signal);
    for (const ds of found.results || []) {
      const g = geoField(ds);
      if (g) return { id: ds.dataset_id, geo: g.name };
    }
    throw new Error('jeu de données introuvable');
  }

  async function fetchSource(src, bbox, signal) {
    const { id, geo } = await resolve(src, signal);
    const [x0, y0, x1, y1] = bbox;
    const where = `in_bbox(${geo}, ${y0}, ${x0}, ${y1}, ${x1})`;
    const fc = await getJson(`${src.portal}/api/explore/v2.1/catalog/datasets/${id}/exports/geojson?${new URLSearchParams({ where, limit: '-1' })}`, signal);
    return (fc.features || []).filter((f) => f.geometry);
  }

  // Télécharge tous les réseaux sur l'emprise de la commune et les garde sur le téléphone
  async function download(bbox, { signal, onProgress } = {}) {
    const sets = {}, failed = [];
    for (let i = 0; i < SOURCES.length; i++) {
      const src = SOURCES[i];
      onProgress?.(`Réseaux : ${src.label}…`, i / SOURCES.length);
      try { sets[src.key] = await fetchSource(src, bbox, signal); }
      catch (e) { if (e.name === 'AbortError') throw e; failed.push(src.label); sets[src.key] = (data?.sets?.[src.key]) || []; }
    }
    data = { date: new Date().toISOString(), bbox, sets, failed };
    try { await Offline.idbPut('reseaux', data); } catch (e) { console.warn('Réseaux non enregistrés', e); }
    return data;
  }

  async function load() {
    try { data = (await Offline.idbGet('reseaux')) || null; } catch { data = null; }
    return data;
  }

  // ---- géométrie : distance (m) d'un point à une géométrie
  function distance(geom, lat, lng) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const P = (c) => [(c[0] - lng) * kx, (c[1] - lat) * ky];
    const seg = (a, b) => {
      const [ax, ay] = P(a), [bx, by] = P(b), dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    const line = (cs) => { let d = Infinity; for (let i = 1; i < cs.length; i++) d = Math.min(d, seg(cs[i - 1], cs[i])); return cs.length === 1 ? Math.hypot(...P(cs[0])) : d; };
    switch (geom?.type) {
      case 'Point': return Math.hypot(...P(geom.coordinates));
      case 'MultiPoint': return Math.min(...geom.coordinates.map((c) => Math.hypot(...P(c))));
      case 'LineString': return line(geom.coordinates);
      case 'MultiLineString': return Math.min(...geom.coordinates.map(line));
      case 'Polygon': return Offline.hits(geom, lat, lng, 0) ? 0 : Math.min(...geom.coordinates.map(line));
      case 'MultiPolygon': return Offline.hits(geom, lat, lng, 0) ? 0 : Math.min(...geom.coordinates.flat().map(line));
      case 'GeometryCollection': return Math.min(...geom.geometries.map((g) => distance(g, lat, lng)));
      default: return Infinity;
    }
  }

  // Éléments de réseau à moins de TOL mètres du point, triés par distance
  function near(latlng, tol = TOL) {
    if (!data) return [];
    const out = [];
    for (const src of SOURCES) {
      for (const f of data.sets[src.key] || []) {
        const d = distance(f.geometry, latlng.lat, latlng.lng);
        if (d <= tol) out.push({ src, f, d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  // Couche Leaflet de tous les réseaux téléchargés
  function layer() {
    const group = L.layerGroup();
    if (!data) return group;
    for (const src of SOURCES) {
      const feats = data.sets[src.key] || [];
      if (!feats.length) continue;
      L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        interactive: false,
        style: { color: src.color, weight: 3, opacity: .9, dashArray: src.dash || null },
        pointToLayer: (f, ll) => L.circleMarker(ll, { radius: src.key === 'poteaux' ? 2.5 : 5, color: src.color, weight: 1, fillOpacity: .9 })
      }).addTo(group);
    }
    return group;
  }

  return { SOURCES, load, download, near, layer, distance, get: () => data };
})();
