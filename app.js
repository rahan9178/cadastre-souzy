/* Cadastre · Souzy-la-Briche — web app (PWA)
 * Sources :
 *  - API Carto IGN (cadastre + Géoportail de l'Urbanisme) : https://apicarto.ign.fr/api
 *  - Géoplateforme WMS vecteur : https://data.geopf.fr/wms-v/ows (GetCapabilities + GetFeatureInfo)
 *  - Fonds de plan WMTS Géoplateforme : https://data.geopf.fr/wmts
 */
'use strict';

const CONFIG = {
  insee: '91602',
  communeName: 'Souzy-la-Briche',
  center: [48.527, 2.151],
  apicarto: 'https://apicarto.ign.fr/api',
  wms: 'https://data.geopf.fr/wms-v/ows',
  wmts: 'https://data.geopf.fr/wmts',
  // Couches WMS cochées par défaut : noms ou titres qui correspondent à ces motifs
  defaultLayerPatterns: [/parcel|cadastr/i, /zone_urba|zone_secteur|zonage/i, /assiette|servitude|\bsup\b|sup_/i,
    /prescription/i, /info_surf|information/i, /secteur_cc/i, /psmv/i],
  // Couches proposées dans le menu ☰, par thème (les autres restent accessibles par la recherche)
  layerThemes: [
    { name: 'Cadastre', re: /cadastr|parcel/i },
    { name: 'Urbanisme (PLU, carte communale)', re: /zone_urba|zone_secteur|zonage|secteur_cc|prescription|info_(surf|lin|pct)|psmv|document_urba|\bplu\b|\bdu\b/i },
    { name: 'Servitudes d\'utilité publique', re: /assiette|generateur|servitude|\bsup\b|sup_|\bac[1-4]\b/i },
    { name: 'Patrimoine, nature, risques', re: /monument|patrimoine|site_(inscrit|classe)|sites? (inscrit|classé)|znieff|natura|ppr[nmt]?\b|risque|inondation|zone_humide|espace_bois/i }
  ],
  followMinDistance: 15,  // m
  followMinInterval: 5000 // ms
};

// Libellés des catégories de servitudes d'utilité publique (nomenclature CNIG)
const SUP_LABELS = {
  AC1: 'Monuments historiques (abords)', AC2: 'Sites inscrits et classés', AC3: 'Réserves naturelles',
  AC4: 'Site patrimonial remarquable (ex-ZPPAUP/AVAP)', A1: 'Bois et forêts', A2: 'Canalisations d\'irrigation',
  A4: 'Cours d\'eau non domaniaux', A5: 'Canalisations d\'eau et d\'assainissement', A7: 'Forêts de protection',
  AR3: 'Magasins à poudre', AR6: 'Champs de tir', AS1: 'Captages d\'eau potable', AS2: 'Établissements ostréicoles',
  EL2: 'Défense contre les inondations', EL3: 'Halage et marchepied', EL7: 'Alignement des voies',
  EL9: 'Passage des piétons sur le littoral', EL11: 'Interdiction d\'accès (routes express)',
  I1: 'Hydrocarbures', I3: 'Canalisations de gaz', I4: 'Lignes électriques', I5: 'Canalisations chimiques',
  I6: 'Mines et carrières', I7: 'Stockage souterrain de gaz', INT1: 'Voisinage des cimetières',
  JS1: 'Installations sportives', PM1: 'Plan de prévention des risques naturels', PM2: 'Installations classées',
  PM3: 'Plan de prévention des risques technologiques', PM4: 'Risque minier', PM5: 'Ouvrages hydrauliques',
  PT1: 'Télécom : perturbations électromagnétiques', PT2: 'Télécom : obstacles', PT3: 'Réseaux de télécommunication',
  T1: 'Voies ferrées', T4: 'Balisage aéronautique', T5: 'Dégagement aéronautique', T7: 'Aéronautique (hors dégagement)',
  T8: 'Radioélectrique aéronautique'
};

const TYPEZONE_LABELS = { U: 'Zone urbaine', AUc: 'À urbaniser (constructible)', AUs: 'À urbaniser (stricte)',
  A: 'Zone agricole', N: 'Zone naturelle et forestière', Nh: 'Zone naturelle (habitat)', Ah: 'Zone agricole (habitat)',
  ZC: 'Carte communale : zone constructible', ZnC: 'Carte communale : zone non constructible' };

// ---------------------------------------------------------------- utilitaires
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } }
};

async function fetchJson(url, { timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function pointGeom(latlng) {
  return { type: 'Point', coordinates: [round6(latlng.lng), round6(latlng.lat)] };
}
// Petit carré (~ d mètres de côté) pour attraper les objets linéaires/ponctuels autour de la position
function boxGeom(latlng, d = 20) {
  const dLat = d / 2 / 111320, dLng = d / 2 / (111320 * Math.cos(latlng.lat * Math.PI / 180));
  const a = latlng.lng - dLng, b = latlng.lat - dLat, c = latlng.lng + dLng, e = latlng.lat + dLat;
  return { type: 'Polygon', coordinates: [[[a, b], [c, b], [c, e], [a, e], [a, b]].map((p) => p.map(round6))] };
}
function round6(x) { return Math.round(x * 1e6) / 1e6; }
const apicarto = (path, params) => `${CONFIG.apicarto}${path}?${new URLSearchParams(params)}`;
const fmtArea = (m2) => (m2 >= 10000 ? `${(m2 / 10000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ha (${Number(m2).toLocaleString('fr-FR')} m²)` : `${Number(m2).toLocaleString('fr-FR')} m²`);

// ---------------------------------------------------------------- carte
const map = L.map('map', { zoomControl: false, maxZoom: 21 }).setView(CONFIG.center, 15);
L.control.zoom({ position: 'topleft' }).addTo(map);

const wmtsLayer = (layer, format, style = 'normal', opts = {}) => L.tileLayer(
  `${CONFIG.wmts}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${encodeURIComponent(style)}` +
  `&TILEMATRIXSET=PM&FORMAT=${format}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
  { maxZoom: 21, maxNativeZoom: 19, attribution: '© IGN Géoplateforme', ...opts });

const bases = {
  'Plan IGN': wmtsLayer('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
  'Photos aériennes': wmtsLayer('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg', 'normal', { maxNativeZoom: 20 })
};
const cadastreTiles = wmtsLayer('CADASTRALPARCELS.PARCELLAIRE_EXPRESS', 'image/png', 'PCI vecteur', { maxNativeZoom: 20, opacity: .9 });
bases[store.get('base', 'Photos aériennes')]?.addTo(map) || bases['Plan IGN'].addTo(map);
cadastreTiles.addTo(map);
const layersCtl = L.control.layers(bases, { 'Cadastre (WMTS)': cadastreTiles }, { position: 'topleft', collapsed: true }).addTo(map);
map.on('baselayerchange', (e) => store.set('base', e.name));

const communeLayer = L.geoJSON(null, { style: { color: '#e05a00', weight: 3, fill: false, dashArray: '6 6' }, interactive: false }).addTo(map);
const parcelLayer = L.geoJSON(null, { style: { color: '#ffd400', weight: 4, fillOpacity: .15 }, interactive: false }).addTo(map);
let posMarker = null, accCircle = null, queryMarker = null;

// ---------------------------------------------------------------- commune
async function loadCommune() {
  let fc = null;
  try { fc = await fetchJson(apicarto('/cadastre/commune', { code_insee: CONFIG.insee })); }
  catch (e) { fc = Offline.commune(); if (!fc) console.warn('Contour commune indisponible', e); }
  if (fc?.features?.length) {
    communeLayer.clearLayers().addData(fc);
    if (!lastView) map.fitBounds(communeLayer.getBounds(), { padding: [20, 20] });
  }
  try {
    const m = await fetchJson(apicarto('/gpu/municipality', { insee: CONFIG.insee }));
    state.municipality = m.features?.[0]?.properties || null;
  } catch (e) { state.municipality = Offline.municipality(); }
  ensureReseaux();
}

// ---------------------------------------------------------------- réseaux (Enedis, RTE, GRTgaz)
let reseauxLayer = null, reseauxLoading = false;
function refreshReseauxLayer() {
  const wasOn = reseauxLayer && map.hasLayer(reseauxLayer);
  if (reseauxLayer) { map.removeLayer(reseauxLayer); layersCtl.removeLayer(reseauxLayer); }
  reseauxLayer = Reseaux.layer();
  layersCtl.addOverlay(reseauxLayer, 'Réseaux électricité et gaz (open data)');
  if (wasOn || store.get('showReseaux', true)) reseauxLayer.addTo(map);
}
map.on('overlayadd overlayremove', (e) => { if (e.layer === reseauxLayer) store.set('showReseaux', e.type === 'overlayadd'); });

// Téléchargement automatique des réseaux sur la commune (rafraîchi tous les 30 jours)
async function ensureReseaux() {
  const d = Reseaux.get();
  const fresh = d && Date.now() - new Date(d.date).getTime() < 30 * 864e5;
  if (fresh || reseauxLoading || !navigator.onLine) return;
  const bbox = offlineBbox();
  if (!bbox) return;
  reseauxLoading = true;
  try { await Reseaux.download(bbox); refreshReseauxLayer(); }
  catch (e) { console.warn('Réseaux indisponibles', e); }
  finally { reseauxLoading = false; }
}
const lastView = store.get('lastView');
if (lastView) map.setView(lastView.c, lastView.z);
map.on('moveend', () => store.set('lastView', { c: map.getCenter(), z: map.getZoom() }));

// ---------------------------------------------------------------- WMS data.geopf.fr
const state = {
  wmsLayers: [],          // [{name,title,abstract,queryable}]
  infoFormats: [],
  selected: new Set(store.get('wmsSelected', [])),
  hasSavedSelection: store.get('wmsSelected', null) !== null,
  overlays: new Map(),    // name -> L.TileLayer.WMS
  municipality: null,
  lastQuery: null,
  queryId: 0
};

async function loadCapabilities() {
  const list = $('#layer-list');
  try {
    const url = `${CONFIG.wms}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const child = (el, tag) => Array.from(el.children).find((c) => c.localName === tag);
    const gfi = Array.from(xml.getElementsByTagNameNS('*', 'GetFeatureInfo'))[0];
    state.infoFormats = gfi ? Array.from(gfi.children).filter((c) => c.localName === 'Format').map((c) => c.textContent.trim()) : [];
    state.wmsLayers = Array.from(xml.getElementsByTagNameNS('*', 'Layer'))
      .map((el) => ({
        name: child(el, 'Name')?.textContent.trim(),
        title: child(el, 'Title')?.textContent.trim() || '',
        abstract: child(el, 'Abstract')?.textContent.trim() || '',
        queryable: el.getAttribute('queryable') === '1'
      }))
      .filter((l) => l.name);
    if (!state.hasSavedSelection) {
      for (const l of state.wmsLayers) {
        if (CONFIG.defaultLayerPatterns.some((p) => p.test(l.name) || p.test(l.title))) state.selected.add(l.name);
      }
      // garde-fou : pas plus de 12 couches cochées par défaut
      state.selected = new Set(Array.from(state.selected).slice(0, 12));
    }
    // ne garder que les noms qui existent encore dans le service
    const known = new Set(state.wmsLayers.map((l) => l.name));
    state.selected = new Set(Array.from(state.selected).filter((n) => known.has(n)));
    renderLayerList();
    syncOverlays();
    if (state.lastQuery) queryAt(state.lastQuery.latlng, state.lastQuery.source);
  } catch (e) {
    list.innerHTML = `<div class="warn">Impossible de lire le GetCapabilities de data.geopf.fr (${esc(e.message)}). Réessayez plus tard.</div>`;
  }
}

function layerTheme(l) {
  const t = CONFIG.layerThemes.find((th) => th.re.test(l.name) || th.re.test(l.title));
  return t ? t.name : null;
}

// Par défaut : couches cochées puis couches utiles groupées par thème. Recherche ou « toutes » : tout le service.
function renderLayerList() {
  const q = $('#layer-filter').value.trim().toLowerCase();
  const all = $('#show-all-layers').checked;
  const match = (l) => !q || l.name.toLowerCase().includes(q) || l.title.toLowerCase().includes(q);
  const groups = new Map([['Couches affichées', []]]);
  for (const th of CONFIG.layerThemes) groups.set(th.name, []);
  groups.set('Autres couches du service', []);
  for (const l of state.wmsLayers) {
    if (!match(l)) continue;
    if (state.selected.has(l.name)) { groups.get('Couches affichées').push(l); continue; }
    const th = layerTheme(l);
    if (th) groups.get(th).push(l);
    else if (all || q) groups.get('Autres couches du service').push(l);
  }
  const row = (l) => `
    <label class="layer-row">
      <input type="checkbox" data-name="${esc(l.name)}" ${state.selected.has(l.name) ? 'checked' : ''}>
      <span><span>${esc(l.title || l.name)}</span>${l.queryable ? '' : ' <small>(non interrogeable)</small>'}
      <div class="ln">${esc(l.name)}</div></span>
    </label>`;
  let html = '', shown = 0;
  for (const [name, rows] of groups) {
    if (!rows.length) continue;
    const cut = rows.slice(0, Math.max(0, 300 - shown));
    shown += cut.length;
    html += `<h3 class="group">${esc(name)} <small>(${rows.length})</small></h3>${cut.map(row).join('')}`;
    if (cut.length < rows.length) { html += `<p class="hint">${rows.length - cut.length} couches de plus : affinez la recherche.</p>`; break; }
  }
  $('#layer-list').innerHTML = html || '<p class="empty">Aucune couche ne correspond.</p>';
}

function syncOverlays() {
  for (const [name, lyr] of state.overlays) {
    if (!state.selected.has(name)) { map.removeLayer(lyr); layersCtl.removeLayer(lyr); state.overlays.delete(name); }
  }
  for (const name of state.selected) {
    if (state.overlays.has(name)) continue;
    const meta = state.wmsLayers.find((l) => l.name === name);
    const lyr = L.tileLayer.wms(CONFIG.wms, {
      layers: name, styles: '', format: 'image/png', transparent: true, version: '1.3.0',
      maxZoom: 21, opacity: .75, attribution: '© IGN Géoplateforme / GPU'
    }).addTo(map);
    lyr.isWmsOverlay = true;
    state.overlays.set(name, lyr);
    layersCtl.addOverlay(lyr, `WMS : ${meta?.title || name}`);
  }
  applyTileZoomCap();
  store.set('wmsSelected', Array.from(state.selected));
}

$('#layer-list').addEventListener('change', (e) => {
  const name = e.target?.dataset?.name;
  if (!name) return;
  e.target.checked ? state.selected.add(name) : state.selected.delete(name);
  syncOverlays();
});
$('#layer-filter').addEventListener('input', renderLayerList);
$('#show-all-layers').addEventListener('change', renderLayerList);
$('#btn-layers').addEventListener('click', () => $('#layers-panel').classList.toggle('hidden'));
$('#btn-layers-close').addEventListener('click', () => {
  $('#layers-panel').classList.add('hidden');
  if (state.lastQuery) queryAt(state.lastQuery.latlng, state.lastQuery.source);
});

function pickInfoFormat() {
  const pref = ['application/json', 'application/geo+json', 'application/vnd.ogc.gml', 'text/html', 'text/plain'];
  return pref.find((p) => state.infoFormats.includes(p)) || state.infoFormats[0] || 'application/json';
}

// GetFeatureInfo autour du point : fenêtre de 101×101 px à ~0,3 m/px en EPSG:3857
async function getFeatureInfo(latlng, layerName) {
  const p = L.CRS.EPSG3857.project(latlng);
  const half = 50 * 0.3 / Math.cos(latlng.lat * Math.PI / 180); // 1 m au sol = 1/cos(lat) m en EPSG:3857
  const fmt = pickInfoFormat();
  const params = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo', LAYERS: layerName, QUERY_LAYERS: layerName,
    STYLES: '', CRS: 'EPSG:3857', BBOX: [p.x - half, p.y - half, p.x + half, p.y + half].join(','),
    WIDTH: '101', HEIGHT: '101', I: '50', J: '50', INFO_FORMAT: fmt, FEATURE_COUNT: '20', FORMAT: 'image/png'
  });
  const r = await fetch(`${CONFIG.wms}?${params}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || fmt).toLowerCase();
  const text = await r.text();
  if (ct.includes('json')) {
    try { return { kind: 'json', data: JSON.parse(text) }; } catch { /* rendu texte ci-dessous */ }
  }
  if (ct.includes('xml') && /ServiceException/i.test(text)) throw new Error(text.replace(/<[^>]+>/g, ' ').trim().slice(0, 200));
  if (ct.includes('html')) return { kind: 'html', data: text };
  return { kind: 'text', data: text };
}

// ---------------------------------------------------------------- requêtes au point
async function queryAt(latlng, source) {
  const id = ++state.queryId;
  state.lastQuery = { latlng, source };
  const pt = JSON.stringify(pointGeom(latlng));
  const box = JSON.stringify(boxGeom(latlng));
  setSummary('Recherche des informations…', `${source} · ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);
  $('#sheet-body').innerHTML = '';

  // Hors ligne (ou préférence) : lecture des données téléchargées
  if (Offline.available() && (!navigator.onLine || $('#prefer-offline').checked)) {
    render(latlng, source, Offline.query(latlng), [], [], { offline: true });
    return;
  }

  const gpu = (ep, geom = pt) => fetchJson(apicarto(`/gpu/${ep}`, { geom })).then((fc) => fc.features || []);
  const tasks = {
    parcelle: fetchJson(apicarto('/cadastre/parcelle', { geom: pt })).then((fc) => fc.features || []),
    document: gpu('document'),
    zone: gpu('zone-urba'),
    secteurCC: gpu('secteur-cc'),
    supS: gpu('assiette-sup-s'),
    supL: gpu('assiette-sup-l', box),
    supP: gpu('assiette-sup-p', box),
    prescS: gpu('prescription-surf'),
    prescL: gpu('prescription-lin', box),
    prescP: gpu('prescription-pct', box),
    infoS: gpu('info-surf'),
    infoL: gpu('info-lin', box),
    infoP: gpu('info-pct', box)
  };
  const wmsNames = Array.from(state.selected).filter((n) => state.wmsLayers.find((l) => l.name === n)?.queryable);
  const wmsTasks = wmsNames.map((n) => getFeatureInfo(latlng, n).then((res) => ({ name: n, res }), (err) => ({ name: n, err })));

  const keys = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const wmsResults = await Promise.all(wmsTasks);
  if (id !== state.queryId) return; // une requête plus récente a été lancée
  const R = {}, errors = [];
  settled.forEach((s, i) => { if (s.status === 'fulfilled') R[keys[i]] = s.value; else { R[keys[i]] = []; errors.push(keys[i]); } });
  // Réseau défaillant (zone blanche…) : on bascule sur les données téléchargées
  if (errors.includes('parcelle') && Offline.available()) {
    render(latlng, source, Offline.query(latlng), [], [], { offline: true, fallback: true });
    return;
  }
  render(latlng, source, R, errors, wmsResults);
}

function render(latlng, source, R, errors, wmsResults, opts = {}) {
  parcelLayer.clearLayers();
  const parcels = R.parcelle;
  if (parcels.length) parcelLayer.addData(parcels);

  // ---- résumé
  const p = parcels[0]?.properties;
  const zones = R.zone.map((f) => f.properties.libelle).filter(Boolean);
  const sups = uniq(R.supS.concat(R.supL, R.supP).map((f) => supCode(f.properties)).filter(Boolean));
  const head = p ? `Parcelle ${p.section} ${p.numero}` : 'Aucune parcelle trouvée';
  const bits = [];
  if (zones.length) bits.push(`Zone ${uniq(zones).join(', ')}`);
  if (sups.length) bits.push(`SUP ${sups.join(', ')}`);
  setSummary(bits.length ? `${head} · ${bits.join(' · ')}` : head,
    `${opts.offline ? 'Hors ligne · ' : ''}${source} · ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`);

  let html = '';
  if (opts.offline) {
    const m = Offline.meta();
    html += `<div class="warn">${opts.fallback ? 'Réseau indisponible : ' : ''}données téléchargées le ${esc(new Date(m.date).toLocaleDateString('fr-FR'))}.</div>`;
  }
  if (p && p.code_insee && p.code_insee !== CONFIG.insee) {
    html += `<div class="warn">Ce point est hors de ${esc(CONFIG.communeName)} (commune ${esc(p.nom_com || p.code_insee)}).</div>`;
  }
  if (errors.length) html += `<div class="warn">Certaines sources n'ont pas répondu (${esc(errors.join(', '))}).</div>`;

  // ---- parcelle
  html += section('Parcelle cadastrale', parcels.map((f) => {
    const q = f.properties;
    return item(`Section ${q.section} · n° ${q.numero}`,
      [q.contenance ? `Contenance : ${fmtArea(q.contenance)}` : '', q.idu ? `Identifiant : ${q.idu}` : '', q.nom_com || ''].filter(Boolean).join(' · '),
      q);
  }));

  // ---- document d'urbanisme
  const muni = state.municipality || Offline.municipality();
  let docItems = R.document.map((f) => {
    const q = f.properties;
    return item(q.du_type ? `${q.du_type}${q.grid_title ? ' · ' + q.grid_title : ''}` : (q.grid_title || 'Document d\'urbanisme'),
      [q.etat ? `État : ${q.etat}` : '', q.datappro ? `Approuvé le ${q.datappro}` : ''].filter(Boolean).join(' · '), q);
  });
  if (!docItems.length && muni?.is_rnu) docItems = [item('Règlement national d\'urbanisme (RNU)', 'La commune n\'a pas de document d\'urbanisme publié sur le GPU.')];
  html += section('Document d\'urbanisme', docItems);

  // ---- zonage
  html += section('Zonage', R.zone.map((f) => {
    const q = f.properties;
    return item(`<span class="badge">${esc(q.libelle || '?')}</span>${esc(q.libelong || TYPEZONE_LABELS[q.typezone] || '')}`,
      [q.typezone ? `Type : ${TYPEZONE_LABELS[q.typezone] || q.typezone}` : '', q.destdomi ? `Destination dominante : ${q.destdomi}` : ''].filter(Boolean).join(' · '),
      q, true);
  }).concat(R.secteurCC.map((f) => {
    const q = f.properties;
    return item(`<span class="badge">${esc(q.libelle || q.typesect || '?')}</span>${esc(q.libelong || 'Secteur de carte communale')}`, '', q, true);
  })));

  // ---- servitudes
  const supFeatures = R.supS.concat(R.supL, R.supP);
  html += section('Servitudes d\'utilité publique', dedupe(supFeatures).map((f) => {
    const q = f.properties, code = supCode(q);
    const label = SUP_LABELS[code] || '';
    const name = q.nomass || q.nomsuplitt || q.nomgen || q.libelle || '';
    return item(`${code ? `<span class="badge">${esc(code)}</span>` : ''}${esc(label || name || 'Servitude')}`,
      [label && name ? name : '', q.typeass || ''].filter(Boolean).join(' · '), q, true);
  }));

  // ---- réseaux
  const res = Reseaux.near(latlng);
  const rd = Reseaux.get();
  html += section('Réseaux à proximité (moins de 15 m)', res.map(({ src, f, d }) => {
    const q = f.properties || {};
    return item(`<span class="badge" style="background:${esc(src.color)}">${esc(src.owner)}</span>${esc(src.label)}`,
      `à ${d < 1 ? 'moins de 1' : Math.round(d)} m`, q);
  }), rd ? 'Aucun réseau électrique ou gaz connu à moins de 15 m.' : 'Données réseaux pas encore chargées.');
  html += `<div class="hint">Tracés indicatifs (open data ${esc(rd?.date ? 'du ' + new Date(rd.date).toLocaleDateString('fr-FR') : '')}) : ils ne remplacent pas une DT-DICT avant travaux. Eau et assainissement ne sont pas publiés en open data.${rd?.failed?.length ? ` Non chargés : ${esc(rd.failed.join(', '))}.` : ''}</div>`;

  // ---- prescriptions & informations
  html += section('Prescriptions', dedupe(R.prescS.concat(R.prescL, R.prescP)).map((f) => {
    const q = f.properties;
    return item(esc(q.libelle || 'Prescription'), [q.typepsc ? `Type ${q.typepsc}${q.stypepsc ? '-' + q.stypepsc : ''}` : '', q.txt || ''].filter(Boolean).join(' · '), q);
  }));
  html += section('Informations', dedupe(R.infoS.concat(R.infoL, R.infoP)).map((f) => {
    const q = f.properties;
    return item(esc(q.libelle || 'Information'), [q.typeinf ? `Type ${q.typeinf}${q.stypeinf ? '-' + q.stypeinf : ''}` : '', q.txt || ''].filter(Boolean).join(' · '), q);
  }));

  // ---- WMS data.geopf.fr
  html += opts.offline
    ? section('Données WMS data.geopf.fr', [], 'Interrogation du WMS impossible hors ligne (les couches téléchargées restent affichées sur la carte).')
    : renderWms(wmsResults);

  html += `<div class="section links">
    <a href="https://www.geoportail-urbanisme.gouv.fr/map/#tile=1&lon=${latlng.lng.toFixed(6)}&lat=${latlng.lat.toFixed(6)}&zoom=18" target="_blank" rel="noopener">Ouvrir sur le Géoportail de l'Urbanisme</a>
    <a href="https://www.geoportail.gouv.fr/carte?c=${latlng.lng.toFixed(6)},${latlng.lat.toFixed(6)}&z=18&l0=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)&permalink=yes" target="_blank" rel="noopener">Géoportail</a>
  </div>`;
  $('#sheet-body').innerHTML = html;
  for (const fr of $('#sheet-body').querySelectorAll('iframe.gfi')) fr.srcdoc = fr.dataset.html;
}

function renderWms(results) {
  if (!state.wmsLayers.length) return section('Données WMS data.geopf.fr', [], 'Capacités WMS en cours de chargement…');
  if (!results.length) return section('Données WMS data.geopf.fr', [], 'Aucune couche WMS interrogeable cochée (menu ☰).');
  const items = [];
  for (const { name, res, err } of results) {
    const title = esc(state.wmsLayers.find((l) => l.name === name)?.title || name);
    if (err) { items.push(item(title, `Erreur : ${err.message}`)); continue; }
    if (res.kind === 'json') {
      const feats = res.data.features || [];
      for (const f of feats) {
        const q = f.properties || {};
        const main = q.libelle || q.nomass || q.nomsuplitt || q.suptype || q.nom || q.name || (f.id ? String(f.id) : '');
        items.push(item(`${title}${main ? ' · ' + esc(main) : ''}`, '', q, true));
      }
    } else if (res.kind === 'html') {
      if (/<td|<li|<tr/i.test(res.data)) items.push(`<div class="item"><div class="title">${title}</div><iframe class="gfi" sandbox="" data-html="${esc(res.data)}"></iframe></div>`);
    } else if (res.data.trim() && !/no features|^\s*$/i.test(res.data)) {
      items.push(`<div class="item"><div class="title">${title}</div><pre style="white-space:pre-wrap;font-size:12px">${esc(res.data.slice(0, 4000))}</pre></div>`);
    }
  }
  return section(`Données WMS data.geopf.fr (${results.length} couche${results.length > 1 ? 's' : ''} interrogée${results.length > 1 ? 's' : ''})`, items);
}

function supCode(q) {
  const c = q.suptype || q.typesup || q.categorie || '';
  return String(c).toUpperCase();
}
const uniq = (a) => Array.from(new Set(a));
function dedupe(features) {
  const seen = new Set();
  return features.filter((f) => {
    const q = f.properties || {};
    const k = q.idass || q.gml_id || q.gid || q.id || JSON.stringify(q);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function section(title, items, emptyText = 'Rien à cet endroit.') {
  return `<div class="section"><h3>${esc(title)}</h3>${items.length ? items.join('') : `<div class="empty">${esc(emptyText)}</div>`}</div>`;
}
// titleHtml doit déjà être échappé
function item(titleHtml, sub, props) {
  const links = props ? linksFrom(props) : '';
  return `<div class="item"><div class="title">${titleHtml}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${links}${props ? propsTable(props, false) : ''}</div>`;
}
function linksFrom(q) {
  const out = [];
  for (const [k, v] of Object.entries(q)) {
    const u = safeUrl(v);
    if (u) out.push(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(/urlfic|urlreg|pdf/i.test(k) || /\.pdf/i.test(u) ? 'Ouvrir le document (règlement)' : 'Lien : ' + k)}</a>`);
  }
  return out.length ? `<div class="links">${out.join('')}</div>` : '';
}
function propsTable(q, open) {
  const rows = Object.entries(q).filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && !/^(bbox|the_geom|geom)$/i.test(k));
  if (!rows.length) return '';
  return `<details${open ? ' open' : ''}><summary>Détails (${rows.length})</summary><table class="props">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></details>`;
}

function setSummary(main, sub) {
  $('#sheet-summary').innerHTML = `${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
}

// ---------------------------------------------------------------- panneau
$('#sheet-handle').addEventListener('click', () => $('#sheet').classList.toggle('collapsed'));
$('#sheet-summary').addEventListener('click', () => $('#sheet').classList.toggle('collapsed'));

// ---------------------------------------------------------------- géolocalisation
let watchId = null, lastFollowQuery = { t: 0, latlng: null };
const locateBtn = $('#btn-locate'), followBtn = $('#btn-follow');

function showPosition(pos) {
  const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
  const acc = pos.coords.accuracy;
  if (!posMarker) {
    posMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
    accCircle = L.circle(ll, { radius: acc, color: '#1a73e8', weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
  } else { posMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(acc); }
  return { ll, acc };
}
function geoError(err) {
  locateBtn.classList.remove('busy');
  const msg = { 1: 'Autorisez la localisation pour ce site dans le navigateur.', 2: 'Position indisponible.', 3: 'Délai de localisation dépassé.' }[err.code] || err.message;
  setSummary('Localisation impossible', msg);
}
const geoOpts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };

locateBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) { setSummary('La géolocalisation n\'est pas disponible sur cet appareil.'); return; }
  locateBtn.classList.add('busy');
  navigator.geolocation.getCurrentPosition((pos) => {
    locateBtn.classList.remove('busy');
    const { ll, acc } = showPosition(pos);
    map.setView(ll, Math.max(map.getZoom(), 18));
    if (queryMarker) { map.removeLayer(queryMarker); queryMarker = null; }
    queryAt(ll, `Ma position (± ${Math.round(acc)} m)`);
  }, geoError, geoOpts);
});

followBtn.addEventListener('click', () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId); watchId = null;
    followBtn.setAttribute('aria-pressed', 'false'); return;
  }
  if (!('geolocation' in navigator)) return;
  followBtn.setAttribute('aria-pressed', 'true');
  lastFollowQuery = { t: 0, latlng: null };
  watchId = navigator.geolocation.watchPosition((pos) => {
    const { ll, acc } = showPosition(pos);
    map.panTo(ll);
    const now = Date.now();
    const moved = !lastFollowQuery.latlng || ll.distanceTo(lastFollowQuery.latlng) > CONFIG.followMinDistance;
    if (moved && now - lastFollowQuery.t > CONFIG.followMinInterval) {
      lastFollowQuery = { t: now, latlng: ll };
      if (queryMarker) { map.removeLayer(queryMarker); queryMarker = null; }
      queryAt(ll, `Suivi de position (± ${Math.round(acc)} m)`);
    }
  }, (e) => { geoError(e); followBtn.setAttribute('aria-pressed', 'false'); watchId = null; }, geoOpts);
});

// toucher la carte = interroger ce point
map.on('click', (e) => {
  if (watchId !== null) followBtn.click(); // on arrête le suivi pour consulter un autre point
  if (!queryMarker) queryMarker = L.marker(e.latlng).addTo(map); else queryMarker.setLatLng(e.latlng);
  queryAt(e.latlng, 'Point touché sur la carte');
});

// ---------------------------------------------------------------- hors ligne
const dl = { ctrl: null };
const offlinePanel = $('#offline-panel');
$('#prefer-offline').checked = store.get('preferOffline', false);
$('#prefer-offline').addEventListener('change', (e) => store.set('preferOffline', e.target.checked));
$('#btn-offline').addEventListener('click', () => { $('#layers-panel').classList.add('hidden'); offlinePanel.classList.toggle('hidden'); refreshOfflinePanel(); });
$('#btn-offline-close').addEventListener('click', () => offlinePanel.classList.add('hidden'));
for (const id of ['#dl-plan', '#dl-wms', '#dl-ortho', '#dl-zoom']) $(id).addEventListener('change', () => refreshEstimate());

const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} Go` : `${Math.round(b / 1e6)} Mo`);

function offlineBbox() {
  const m = Offline.meta();
  if (m?.bbox) return m.bbox;
  if (communeLayer.getLayers().length) {
    const b = communeLayer.getBounds().pad(0.05);
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  return null;
}

// Liste des URL de tuiles à télécharger, construites par Leaflet lui-même pour être identiques à l'affichage
function tileUrls() {
  const bbox = offlineBbox();
  if (!bbox) return [];
  const zmax = Number($('#dl-zoom').value), zmin = 12;
  const urls = [];
  const add = (layer, maxZ) => {
    const prev = layer._tileZoom;
    for (const c of Offline.tileCoords(bbox, zmin, Math.min(zmax, maxZ))) {
      layer._tileZoom = c.z; // getTileUrl() lit le niveau de zoom ici
      urls.push(layer.getTileUrl(Object.assign(L.point(c.x, c.y), { z: c.z })));
    }
    layer._tileZoom = prev;
  };
  if ($('#dl-plan').checked) { add(bases['Plan IGN'], 19); add(cadastreTiles, 19); }
  if ($('#dl-ortho').checked) add(bases['Photos aériennes'], 19);
  if ($('#dl-wms').checked) for (const lyr of state.overlays.values()) if (map.hasLayer(lyr)) add(lyr, 17);
  return Array.from(new Set(urls));
}

function refreshEstimate() {
  const n = tileUrls().length;
  $('#dl-estimate').textContent = n ? `Environ ${n.toLocaleString('fr-FR')} tuiles de carte (≈ ${Math.max(1, Math.round(n * 0.02))} Mo).` : 'Contour de la commune pas encore chargé.';
}

async function refreshOfflinePanel() {
  const m = Offline.meta();
  const used = await Offline.usage();
  const status = $('#offline-status');
  if (m) {
    const c = m.counts || {};
    const sup = (c.supS || 0) + (c.supL || 0) + (c.supP || 0);
    status.innerHTML = `<div class="title">Données disponibles hors ligne</div>
      <div class="sub">Téléchargées le ${esc(new Date(m.date).toLocaleString('fr-FR'))} · ${esc(c.parcelle || 0)} parcelles, ${esc(c.zone || 0)} zones, ${esc(sup)} servitudes${used ? ` · ${esc(fmtBytes(used))} utilisés` : ''}</div>
      ${m.failed?.length ? `<div class="sub">Non téléchargés : ${esc(m.failed.join(', '))}</div>` : ''}`;
    $('#dl-start').textContent = 'Mettre à jour';
  } else {
    status.innerHTML = '<div class="title">Rien de téléchargé pour l\'instant</div><div class="sub">Sans réseau, l\'app ne peut rien afficher tant que la commune n\'est pas téléchargée.</div>';
    $('#dl-start').textContent = 'Télécharger la commune';
  }
  $('#dl-clear').disabled = !m;
  updateOfflineBadge();
  refreshEstimate();
}

function updateOfflineBadge() {
  $('#btn-offline').textContent = Offline.available() ? '✓⇩' : '⇩';
  $('#btn-offline').title = Offline.available() ? 'Hors ligne : commune téléchargée' : 'Hors ligne';
}

$('#dl-start').addEventListener('click', async () => {
  if (!navigator.onLine) { $('#dl-message').textContent = 'Pas de réseau : connectez-vous pour télécharger.'; return; }
  const prog = $('#dl-progress'), msg = $('#dl-message');
  dl.ctrl = new AbortController();
  $('#dl-start').disabled = true; $('#dl-cancel').hidden = false; prog.hidden = false; prog.value = 0;
  try {
    await Offline.downloadData({
      apicarto: CONFIG.apicarto, insee: CONFIG.insee, signal: dl.ctrl.signal,
      onProgress: (text, frac) => { msg.textContent = text; prog.value = frac * 0.3; }
    });
    if (!communeLayer.getLayers().length) loadCommune();
    await Reseaux.download(Offline.meta().bbox, {
      signal: dl.ctrl.signal,
      onProgress: (text, frac) => { msg.textContent = text; prog.value = 0.3 + frac * 0.1; }
    });
    refreshReseauxLayer();
    const urls = tileUrls();
    if (urls.length) {
      const r = await Offline.downloadTiles(urls, {
        signal: dl.ctrl.signal,
        onProgress: (done, total, failed) => {
          prog.value = 0.4 + 0.6 * done / total;
          msg.textContent = `Carte : ${done.toLocaleString('fr-FR')} / ${total.toLocaleString('fr-FR')} tuiles${failed ? ` (${failed} en échec)` : ''}`;
        }
      });
      store.set('tileMaxZoom', Number($('#dl-zoom').value));
      store.set('orthoOffline', $('#dl-ortho').checked);
      msg.textContent = `Terminé. ${r.failed ? `${r.failed} tuiles n'ont pas pu être téléchargées : relancez « Mettre à jour » pour les reprendre.` : 'L\'app fonctionne maintenant sans réseau dans la commune.'}`;
    } else {
      msg.textContent = 'Terminé. L\'app fonctionne maintenant sans réseau dans la commune.';
    }
    prog.value = 1;
  } catch (e) {
    msg.textContent = e.name === 'AbortError' ? 'Téléchargement annulé (ce qui est déjà téléchargé est conservé).' : `Échec : ${e.message}`;
  } finally {
    $('#dl-start').disabled = false; $('#dl-cancel').hidden = true; dl.ctrl = null;
    refreshOfflinePanel();
  }
});
$('#dl-cancel').addEventListener('click', () => dl.ctrl?.abort());
$('#dl-clear').addEventListener('click', async () => {
  if (!confirm('Supprimer les données et la carte téléchargées ?')) return;
  await Offline.clearAll();
  $('#dl-message').textContent = 'Données hors ligne supprimées.';
  refreshOfflinePanel();
});
window.addEventListener('online', () => { applyTileZoomCap(); loadCommune(); if (!state.wmsLayers.length) loadCapabilities(); });
window.addEventListener('offline', () => applyTileZoomCap());

// Sans réseau, on agrandit les tuiles du niveau téléchargé le plus détaillé au lieu d'afficher des cases vides
function applyTileZoomCap() {
  const cap = store.get('tileMaxZoom', null);
  const offline = !navigator.onLine && cap;
  // photos aériennes non téléchargées : on passe sur le Plan IGN
  if (offline && !store.get('orthoOffline', false) && map.hasLayer(bases['Photos aériennes'])) {
    map.removeLayer(bases['Photos aériennes']);
    bases['Plan IGN'].addTo(map);
  }
  for (const lyr of [...Object.values(bases), cadastreTiles, ...state.overlays.values()]) {
    if (lyr._nativeMax === undefined) lyr._nativeMax = lyr.options.maxNativeZoom ?? lyr.options.maxZoom;
    const lim = lyr.isWmsOverlay ? Math.min(cap || 17, 17) : cap;
    const next = offline ? Math.min(lyr._nativeMax, lim) : lyr._nativeMax;
    if (lyr.options.maxNativeZoom !== next) {
      lyr.options.maxNativeZoom = next;
      if (map.hasLayer(lyr)) lyr.redraw();
    }
  }
}

// ---------------------------------------------------------------- démarrage
Offline.load().then(() => Reseaux.load()).then(() => { refreshReseauxLayer(); updateOfflineBadge(); loadCommune(); });
applyTileZoomCap();
loadCapabilities();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
