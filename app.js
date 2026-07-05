(function(){
  'use strict';

  const CONFIG = {
    bbox: '-0.6,42.2,7.8,45.6',
    center: [43.2267, 2.2564],
    initialZoom: 10,
    firmsSources: ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'MODIS_NRT'],
    dayRange: 1,
    refreshMs: 10 * 60 * 1000,
    maxZones: 80,
    maxReports: 45,
    clusterKm: 5,
    defaultMapKey: '849d3127e3ba24ab0bd4d96d4a9e9ecc',
    focusPlaces: [
      { name: 'Carcassonne', lat: 43.2130, lng: 2.3491, radiusKm: 18 },
      { name: 'Caux-et-Sauzens', lat: 43.2267, lng: 2.2564, radiusKm: 10 }
    ]
  };

  const state = {
    mapKey: localStorage.getItem('firms_map_key') || CONFIG.defaultMapKey || '',
    hotspots: [],
    zones: [],
    reports: [],
    officialFires: [],
    news: [],
    selectedId: null,
    zoneLayers: new Map(),
    reportLayers: new Map(),
    activeAreaLayer: null,
    activeWindLayer: null,
    activeAreaLabel: null,
    activeMarker: null,
    timer: null
  };

  const $ = id => document.getElementById(id);
  const els = {
    statusDot: $('status-dot'), statusText: $('status-text'), keyBox: $('key-box'), keyInput: $('key-input'), keySave: $('key-save'),
    refresh: $('refresh-btn'), theme: $('theme-toggle'), sidebar: $('sidebar'), panelToggle: $('panel-toggle'), banner: $('banner-area'),
    cards: $('fire-cards'), reports: $('reported-fires'), detail: $('detail-content'), zoneCount: $('zone-count'), hotspotCount: $('hotspot-count'), reportCount: $('report-count'), countBadge: $('count-badge')
  };

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true }).setView(CONFIG.center, CONFIG.initialZoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors · NASA FIRMS · Open-Meteo · GDELT · Feux de Forêt', maxZoom: 19, subdomains: 'abc'
  }).addTo(map);

  const clusterLayer = L.markerClusterGroup({
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: cluster => L.divIcon({
      html: `<div class="cluster-dot">${cluster.getChildCount()}</div>`,
      className: 'custom-cluster', iconSize: [38,38]
    })
  }).addTo(map);

  const zoneLayer = L.layerGroup().addTo(map);
  const reportLayer = L.layerGroup().addTo(map);

  setTimeout(() => map.invalidateSize(), 200);
  window.addEventListener('resize', () => map.invalidateSize());

  // ---------- UI ----------
  function setStatus(type, text){
    els.statusDot.className = 'dot' + (type ? ` ${type}` : '');
    els.statusText.textContent = text;
  }
  function banner(kind, html){ els.banner.innerHTML = `<div class="banner ${kind}">${html}</div>`; }
  function clearBanner(){ els.banner.innerHTML = ''; }
  function openPanel(){ els.sidebar.classList.add('open'); els.panelToggle.setAttribute('aria-expanded','true'); }
  function closePanel(){ if(innerWidth <= 820){ els.sidebar.classList.remove('open'); els.panelToggle.setAttribute('aria-expanded','false'); } }

  els.panelToggle.addEventListener('click', () => {
    const open = els.sidebar.classList.toggle('open');
    els.panelToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  els.theme.addEventListener('click', () => {
    const html = document.documentElement;
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('fire_theme', next);
    els.theme.textContent = next === 'dark' ? '☀️ Licht' : '🌙 Donker';
  });
  const savedTheme = localStorage.getItem('fire_theme');
  if(savedTheme){ document.documentElement.dataset.theme = savedTheme; }
  els.theme.textContent = document.documentElement.dataset.theme === 'dark' ? '☀️ Licht' : '🌙 Donker';

  els.keyInput.value = state.mapKey;
  els.keySave.addEventListener('click', () => {
    state.mapKey = els.keyInput.value.trim();
    if(state.mapKey) localStorage.setItem('firms_map_key', state.mapKey);
    loadAll();
  });
  els.keyInput.addEventListener('keydown', e => { if(e.key === 'Enter') els.keySave.click(); });
  els.refresh.addEventListener('click', loadAll);

  // ---------- Network helpers ----------
  async function fetchText(url, options={}){
    const direct = async () => {
      const res = await fetch(url, { cache: 'no-store', ...options });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    };
    const allOrigins = async () => {
      const res = await fetch('https://api.allorigins.win/get?url=' + encodeURIComponent(url), { cache: 'no-store' });
      if(!res.ok) throw new Error('Proxy HTTP ' + res.status);
      const data = await res.json();
      if(typeof data.contents !== 'string') throw new Error('Proxy gaf geen tekst terug');
      return data.contents;
    };
    const codeTabs = async () => {
      const res = await fetch('https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(url), { cache: 'no-store' });
      if(!res.ok) throw new Error('Proxy HTTP ' + res.status);
      return await res.text();
    };
    let last;
    for(const fn of [direct, allOrigins, codeTabs]){
      try{ return await fn(); }catch(e){ last = e; }
    }
    throw last || new Error('Fetch mislukt');
  }
  async function fetchJson(url){
    const res = await fetch(url, { cache: 'no-store' });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  // ---------- Data source 1: NASA FIRMS ----------
  function parseCSV(text){
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if(lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h,i) => obj[h] = (vals[i] || '').trim());
      return obj;
    });
  }

  async function fetchFirmsSource(source){
    if(!state.mapKey) return [];
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(state.mapKey)}/${source}/${CONFIG.bbox}/${CONFIG.dayRange}`;
    const text = await fetchText(url);
    if(/invalid map_key|invalid key/i.test(text)) throw new Error('Ongeldige NASA MAP_KEY');
    return parseCSV(text).map(row => normaliseHotspot(row, source)).filter(Boolean);
  }

  function normaliseHotspot(row, source){
    const lat = Number(row.latitude), lng = Number(row.longitude);
    if(!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const time = String(row.acq_time || '').padStart(4, '0');
    const frp = Number(row.frp || 0);
    const rawConf = String(row.confidence || '').toLowerCase();
    let conf = 'medium';
    if(rawConf === 'h' || rawConf === 'high' || Number(rawConf) >= 80) conf = 'high';
    if(rawConf === 'l' || rawConf === 'low' || (Number(rawConf) >= 0 && Number(rawConf) < 40 && rawConf !== '')) conf = 'low';
    return {
      id: `${source}-${lat.toFixed(4)}-${lng.toFixed(4)}-${row.acq_date}-${time}`,
      lat, lng, source, confidence: conf, frp,
      date: row.acq_date || '', time,
      daynight: row.daynight === 'N' ? 'nacht' : row.daynight === 'D' ? 'dag' : 'onbekend',
      satellite: row.satellite || row.instrument || source
    };
  }

  // ---------- Data source 2: Feux de Forêt public page ----------
  async function fetchFeuxDeForetReports(){
    const reports = [];
    try{
      const html = await fetchText('https://feuxdeforet.fr/');
      const docText = htmlToText(html);
      const re = /En cours\s+(\d{2})\s+([^\n]+?)\s+il y a\s+([^\n]+)/gi;
      let m;
      while((m = re.exec(docText)) && reports.length < CONFIG.maxReports){
        reports.push({
          id: 'fdf-' + reports.length,
          source: 'Feux de Forêt',
          department: m[1].trim(),
          title: cleanText(m[2]).replace(/Voir tout.*$/i, '').trim(),
          age: 'il y a ' + cleanText(m[3]).slice(0, 40),
          url: 'https://feuxdeforet.fr/cartes/feux/',
          status: 'En cours',
          kind: 'reported'
        });
      }
    }catch(e){ console.warn('Feux de Forêt niet geladen', e); }
    return uniqueReports(reports);
  }


  // ---------- Curated official / source-checked Southern France fires ----------
  // These are visible even when NASA has no current hotspot match in the last 24h.
  // Keep this list focused on Southern France and update the numbers/links when official situation reports change.
  function getOfficialSouthernFranceFires(){
    const fires = [

      {
        id:'focus-aude-carcassonne-caux-sauzens-2026-07-05',
        title:'Focus — Carcassonne / Caux-et-Sauzens', commune:'Caux-et-Sauzens', department:'11', departmentName:'Aude', region:'Occitanie',
        lat:43.2267, lng:2.2564, hectares:null, status:'Prioriteitszone: geen bevestigde actieve bosbrand gevonden', updated:'2026-07-05', started:'—',
        summary:'Lokale focuszone ten westen van Carcassonne rond Caux-et-Sauzens. Deze kaart toont hier NASA-hittepunten, wind en meldingen extra prominent. Ik markeer dit bewust niet als officiële actieve brand zolang er geen bevestigde prefectuur/SDIS-bron voor een actuele bosbrand op Caux-et-Sauzens is.',
        focus:true,
        sources:[
          {label:'Département de l’Aude — mairie Caux-et-Sauzens', url:'https://www.aude.fr/annuaire-mairies-du-departement/mairie-caux-et-sauzens'},
          {label:'Géorisques/commune — risque feu de forêt identifié', url:'https://www.georisques.gouv.fr/'},
          {label:'Mairie / PanneauPocket — débroussaillement', url:'https://app.panneaupocket.com/ville/201928478-caux-et-sauzens-11170?panneau=15867190'}
        ]
      },
      {
        id:'official-aude-pouzols-minervois-2026-07-02',
        title:'Aude — Pouzols-Minervois / Minervois', commune:'Pouzols-Minervois', department:'11', departmentName:'Aude', region:'Occitanie',
        lat:43.288, lng:2.827, hectares:900, status:'Fixé / sous surveillance', updated:'2026-07-03', started:'2026-07-01',
        summary:'Grand incendie du Minervois : environ 900 hectares parcourus, évacuations locales, routes fermées et moyens aériens importants.',
        sources:[
          {label:'Feux de Forêt — Aude, près de 1 000 ha', url:'https://feuxdeforet.fr/alerte-info/incendies-dans-l-aude-pres-de-1-000-hectares-partis-en-fumee-un-pompier-blesse-02-07-2026-7124/'},
          {label:'Le Dauphiné — feu de l’Aude fixé', url:'https://www.ledauphine.com/environnement/2026/07/03/incendies-dans-le-sud-de-la-france-nunez-attendu-dans-l-aude-plusieurs-feux-ne-sont-toujours-pas-maitrises'}
        ]
      },
      {
        id:'official-aude-narbonne-2026-07-02',
        title:'Aude — Narbonne', commune:'Narbonne', department:'11', departmentName:'Aude', region:'Occitanie',
        lat:43.184, lng:3.003, hectares:7.4, status:'Fixé', updated:'2026-07-02', started:'2026-07-02',
        summary:'Foyer de Narbonne signalé comme fixé après environ 7,4 hectares parcourus et des habitations touchées.',
        sources:[{label:'Feux de Forêt — article Aude', url:'https://feuxdeforet.fr/alerte-info/incendies-dans-l-aude-pres-de-1-000-hectares-partis-en-fumee-un-pompier-blesse-02-07-2026-7124/'}]
      },
      {
        id:'official-po-trevillach-2026-07-04',
        title:'Pyrénées-Orientales — Trévillach / Tarérach / Montalba', commune:'Trévillach', department:'66', departmentName:'Pyrénées-Orientales', region:'Occitanie',
        lat:42.7094, lng:2.5308, hectares:220, status:'En cours / évolution sous vent', updated:'2026-07-04 23:00', started:'2026-07-04 19:30',
        summary:'Incendie de végétation dans le secteur Trévillach, Montalba-le-Château, Tarérach et Rodès. Préfecture et secours mobilisés.',
        sources:[
          {label:'Préfecture 66 — point officiel Trévillach', url:'https://x.com/Prefet66/status/2073507384660742578'},
          {label:'Feux de Forêt — Trévillach 220 ha', url:'https://feuxdeforet.fr/alerte-info/incendie-majeur-dans-les-pyrenees-orientales-220-hectares-deja-brules-a-trevillach-04-07-2026-7128/'}
        ]
      },
      {
        id:'official-po-sainte-marie-canet-2026-07-02',
        title:'Pyrénées-Orientales — Sainte-Marie-la-Mer / Canet-en-Roussillon', commune:'Sainte-Marie-la-Mer', department:'66', departmentName:'Pyrénées-Orientales', region:'Occitanie',
        lat:42.728, lng:3.034, hectares:30, status:'Fixé / évacuations traitées', updated:'2026-07-03', started:'2026-07-02',
        summary:'Incendie littoral entre Sainte-Marie-la-Mer et Canet-en-Roussillon : environ 30 hectares, nombreux campeurs évacués, blessés légers signalés.',
        sources:[
          {label:'Feux de Forêt — Sainte-Marie / Canet', url:'https://feuxdeforet.fr/alerte-info/incendie-a-sainte-marie-la-mer-et-canet-en-roussillon-30-hectares-brules-1-700-personnes-evacuees-02-07-2026-7123/'},
          {label:'TV5MONDE — feux fixés et blessés légers', url:'https://information.tv5monde.com/international/nunez-inquiet-de-la-precocite-des-feux-celui-de-laude-enfin-fixe-2828771'}
        ]
      },
      {
        id:'official-gard-rochefort-du-gard-2026-07-04',
        title:'Gard — Rochefort-du-Gard / A9', commune:'Rochefort-du-Gard', department:'30', departmentName:'Gard', region:'Occitanie',
        lat:43.975, lng:4.689, hectares:40, status:'En cours / moyens engagés', updated:'2026-07-04 18:00', started:'2026-07-04 15:15',
        summary:'Feu de végétation parti après l’incendie d’un poids lourd sur l’A9 ; environ 40 hectares parcourus selon la préfecture.',
        sources:[
          {label:'Préfecture du Gard — incendie en cours', url:'https://www.gard.gouv.fr/Actualites/Incendie-en-cours-a-Rochefort-du-Gard'},
          {label:'Feux de Forêt — Rochefort-du-Gard', url:'https://feuxdeforet.fr/alerte-info/feu-de-foret-a-rochefort-du-gard-40-hectares-brules-des-moyens-exceptionnels-deployes-04-07-2026-7127/'}
        ]
      },
      {
        id:'official-drome-die-justin-2026-07-04',
        title:'Drôme — Die / massif de Justin', commune:'Die', department:'26', departmentName:'Drôme', region:'Auvergne-Rhône-Alpes',
        lat:44.754, lng:5.372, hectares:125, status:'Persistant / zone montagneuse', updated:'2026-07-05', started:'2026-06-24, reprise 2026-07-02',
        summary:'Feu difficile en zone montagneuse dans le massif de Justin près de Die ; 115 à 125 hectares selon les derniers bilans publics.',
        sources:[
          {label:'Le Dauphiné — 125 ha, 300 pompiers', url:'https://www.ledauphine.com/faits-divers-justice/2026/07/04/incendie-en-zone-montagneuse-115-hectares-brules-170-sapeurs-pompiers-engages'},
          {label:'Le Parisien — incendie persistant en Drôme', url:'https://www.leparisien.fr/societe/incendie-dans-la-drome-un-feu-de-foret-persiste-en-zone-montagneuse-04-07-2026-F652OGDGPNF6VHI2R24OIFBLKE.php'},
          {label:'Feux de Forêt — massif de Justin', url:'https://feuxdeforet.fr/alerte-info/drome-115-hectares-partis-en-fumee-dans-le-massif-de-justin-170-pompiers-mobilises-04-07-2026-7126/'}
        ]
      },
      {
        id:'official-bdr-lancon-provence-2026-07-01',
        title:'Bouches-du-Rhône — Lançon-Provence', commune:'Lançon-Provence', department:'13', departmentName:'Bouches-du-Rhône', region:'Provence-Alpes-Côte d’Azur',
        lat:43.591, lng:5.127, hectares:200, status:'Éteint / sous surveillance', updated:'2026-07-04', started:'2026-07-01',
        summary:'Incendie dans le secteur de Lançon-Provence, autour de 200 hectares selon Feux de Forêt ; feu déclaré éteint mais sous surveillance.',
        sources:[{label:'Feux de Forêt — Lançon-Provence 200 ha', url:'https://feuxdeforet.fr/bouches-du-rhone-13/lancon-provence-01-07-2026-1044/'}]
      },
      {
        id:'official-herault-oupia-2026-07-01',
        title:'Hérault / Aude — Oupia vers Minervois', commune:'Oupia', department:'34/11', departmentName:'Hérault / Aude', region:'Occitanie',
        lat:43.291, lng:2.762, hectares:600, status:'Grand feu signalé / à recouper', updated:'2026-07-01', started:'2026-07-01',
        summary:'Feu parti d’Oupia dans l’Hérault et progressant vers l’Aude ; chiffres publics variables selon les mises à jour.',
        sources:[{label:'Feux de Forêt — Aude/Hérault 600 ha', url:'https://feuxdeforet.fr/france/incendie-geant-dans-l-aude-et-l-herault-600-hectares-devores-par-les-flammes-des-centaines-de-pompie-01-07-2026-7119/'}]
      },
      {
        id:'official-aude-ginestas-2026-07-04',
        title:'Aude — Ginestas', commune:'Ginestas', department:'11', departmentName:'Aude', region:'Occitanie',
        lat:43.268, lng:2.872, hectares:null, status:'Feu en attaque / information communautaire', updated:'2026-07-04 18:30', started:'2026-07-04',
        summary:'Départ de feu signalé à Ginestas. À traiter comme signalement à vérifier, pas comme bilan officiel consolidé.',
        sources:[{label:'Feux de Forêt — Ginestas', url:'https://feuxdeforet.fr/aude-11/ginestas-04-07-2026-1369/'}]
      }
    ];
    return fires.map(f => ({...f, kind:'official', radiusKm: f.focus ? 7.5 : officialRadiusKm(f.hectares)}));
  }

  function officialRadiusKm(hectares){
    if(!Number.isFinite(Number(hectares)) || Number(hectares) <= 0) return 2.2;
    const km2 = Number(hectares) / 100;
    return Math.max(1.8, Math.min(18, Math.sqrt(km2 / Math.PI) + 1.2));
  }

  function officialFireToZone(f){
    const areaKm2 = Number.isFinite(Number(f.hectares)) ? Number(f.hectares) / 100 : Math.PI * f.radiusKm * f.radiusKm;
    return {
      id: f.id,
      type: 'official',
      lat: f.lat, lng: f.lng,
      points: [], reports: f.sources.map((src,i) => ({...src, id:f.id+'-src-'+i, title:src.label, source:'Broncontrole', status:f.status, url:src.url})), news: [], weather: null,
      place: { label: f.commune, department: f.departmentName, region: f.region },
      official: f,
      radiusKm: f.radiusKm,
      areaKm2,
      maxFrp: 0, totalFrp: 0, highCount: 0,
      latest: {date: f.updated || '', time: ''},
      confidence: f.status && /attaque|recouper|communautaire/i.test(f.status) ? 'medium' : 'high',
      factLevel: f.focus ? 'Focuszone — geen bevestigde actieve brand' : (f.sources.some(s => /gouv|Prefecture|Préfecture/i.test(s.label + ' ' + s.url)) ? 'Officiële bron + melding' : 'Brongecontroleerde melding')
    };
  }

  function officialFireAsReport(f){
    return {
      id:'report-'+f.id,
      zoneId:f.id,
      source:f.focus ? 'Focusgebied' : (f.factLevel || 'Broncontrole'),
      department:f.department,
      title:f.title,
      age:f.updated ? 'update ' + f.updated : '',
      url:f.sources[0]?.url || '',
      status:f.status,
      kind:'official',
      hectares:f.hectares
    };
  }

  // ---------- Data source 3: GDELT recent news ----------
  async function fetchGdeltNews(){
    try{
      const query = '("feu de forêt" OR incendie OR feux) France';
      const url = 'https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=ArtList&sort=DateDesc&maxrecords=50&query=' + encodeURIComponent(query);
      const data = await fetchJson(url);
      return (data.articles || []).slice(0, 50).map((a,i) => ({
        id: 'gdelt-' + i,
        source: a.sourceCommonName || 'GDELT',
        title: cleanText(a.title || ''),
        url: a.url,
        date: a.seendate || '',
        domain: a.domain || '',
        kind: 'news'
      })).filter(a => a.title && a.url);
    }catch(e){ console.warn('GDELT niet geladen', e); return []; }
  }

  // ---------- Data source 4: Open-Meteo wind ----------
  async function enrichZonesWithWeather(zones){
    const batch = zones.slice(0, CONFIG.maxZones);
    if(!batch.length) return zones;
    try{
      const lats = batch.map(z => z.lat.toFixed(4)).join(',');
      const lngs = batch.map(z => z.lng.toFixed(4)).join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m&wind_speed_unit=kmh&timezone=auto`;
      const data = await fetchJson(url);
      const arr = Array.isArray(data) ? data : [data];
      batch.forEach((z,i) => {
        const c = arr[i] && arr[i].current;
        if(c){ z.weather = { windSpeed: c.wind_speed_10m, windDir: c.wind_direction_10m, windGusts: c.wind_gusts_10m, temp: c.temperature_2m, humidity: c.relative_humidity_2m, time: c.time }; }
      });
    }catch(e){ console.warn('Open-Meteo niet geladen', e); }
    return zones;
  }

  // ---------- Data source 5: reverse geocode selected zone ----------
  async function reverseGeocode(zone){
    if(zone.place) return zone.place;
    try{
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${zone.lat}&lon=${zone.lng}&zoom=10&addressdetails=1&accept-language=nl,fr,en`;
      const data = await fetchJson(url);
      const a = data.address || {};
      zone.place = {
        label: a.city || a.town || a.village || a.municipality || a.county || data.display_name || 'Onbekende plaats',
        department: a.county || a.state_district || a.state || '',
        region: a.state || ''
      };
    }catch(e){ zone.place = { label: 'Onbekende plaats', department: '', region: '' }; }
    return zone.place;
  }

  // ---------- Processing ----------
  function clusterHotspots(points){
    const sorted = [...points].sort((a,b) => b.frp - a.frp);
    const zones = [];
    for(const p of sorted){
      let best = null, bestD = Infinity;
      for(const z of zones){
        const d = km(p.lat, p.lng, z.lat, z.lng);
        if(d < CONFIG.clusterKm && d < bestD){ best = z; bestD = d; }
      }
      if(best){ best.points.push(p); recalcZone(best); }
      else{
        const z = { id: 'zone-' + zones.length, lat: p.lat, lng: p.lng, points:[p], reports:[], news:[], weather:null, place:null };
        recalcZone(z); zones.push(z);
      }
    }
    return zones.sort((a,b) => scoreZone(b) - scoreZone(a));
  }

  function recalcZone(z){
    const weight = z.points.reduce((sum,p) => sum + Math.max(1, p.frp || 1), 0);
    z.lat = z.points.reduce((sum,p) => sum + p.lat * Math.max(1, p.frp || 1), 0) / weight;
    z.lng = z.points.reduce((sum,p) => sum + p.lng * Math.max(1, p.frp || 1), 0) / weight;
    z.maxFrp = Math.max(...z.points.map(p => p.frp || 0));
    z.totalFrp = z.points.reduce((sum,p) => sum + (p.frp || 0), 0);
    z.highCount = z.points.filter(p => p.confidence === 'high').length;
    z.latest = [...z.points].sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time))[0];
    const maxD = Math.max(0, ...z.points.map(p => km(z.lat,z.lng,p.lat,p.lng)));
    z.radiusKm = Math.min(18, Math.max(1.2, maxD + 1.2 + Math.log2(z.points.length + 1) * 0.6));
    z.areaKm2 = Math.PI * z.radiusKm * z.radiusKm;
    z.confidence = z.highCount >= 1 || z.maxFrp > 30 ? 'high' : z.points.some(p => p.confidence === 'medium') ? 'medium' : 'low';
  }

  function scoreZone(z){
    const focusBoost = focusScore(z);
    if(z.type === 'official') return 10000 + focusBoost + (z.official?.focus ? 4000 : 0) + (Number(z.official?.hectares) || 0) * 2 + (/cours|attaque|persistant/i.test(z.official?.status || '') ? 500 : 0);
    return focusBoost + z.points.length * 10 + z.totalFrp + z.highCount * 30;
  }

  function focusScore(z){
    let boost = 0;
    for(const f of CONFIG.focusPlaces){
      const d = km(z.lat, z.lng, f.lat, f.lng);
      if(d <= f.radiusKm) boost += Math.round((f.radiusKm - d + 1) * 120);
    }
    return boost;
  }

  function attachNewsAndReports(zones, reports, news){
    // Reports often have no coordinates. We attach only weak matches by department/name words when possible.
    for(const z of zones){
      if(z.type === 'official'){
        const own = reports.filter(r => r.zoneId === z.id);
        z.reports = uniqueReports([...z.reports, ...own]);
        const words = zoneKeywords(z);
        z.news = news.filter(n => containsAny(n.title, words)).slice(0, 3);
        z.factLevel = factLevel(z);
        continue;
      }
      const words = zoneKeywords(z);
      z.news = news.filter(n => containsAny(n.title, words)).slice(0, 3);
      z.reports = reports.filter(r => containsAny(r.title + ' ' + r.department, words)).slice(0, 3);
      z.factLevel = factLevel(z);
    }
  }

  function factLevel(z){
    if(z.type === 'official' && z.official?.focus) return 'Focuszone — geen bevestigde actieve brand';
    if(z.type === 'official') return z.factLevel || (z.official?.sources?.some(s => /gouv|Prefecture|Préfecture/i.test(s.label + ' ' + s.url)) ? 'Officiële bron + melding' : 'Brongecontroleerde melding');
    const hasSatellite = z.points.length > 0;
    const hasWeather = !!z.weather;
    const hasReports = z.reports.length > 0 || z.news.length > 0;
    if(hasSatellite && hasWeather && hasReports) return 'Sterk gecontroleerd';
    if(hasSatellite && hasWeather) return 'Satelliet + wind bevestigd';
    if(hasSatellite) return 'Alleen satelliet';
    return 'Melding zonder NASA-match';
  }

  function zoneKeywords(z){
    const ks = [];
    if(z.place){ ks.push(z.place.label, z.place.department, z.place.region); }
    if(z.official){ ks.push(z.official.title, z.official.commune, z.official.departmentName, z.official.department); }
    if(z.official?.focus){ ks.push('Carcassonne', 'Caux-et-Sauzens', 'Sauzens', 'Carcassonnais', 'Aude'); }
    // Add coarse French dept codes by longitude/latitude is unreliable, so keep this strict.
    return ks.filter(Boolean).flatMap(s => String(s).split(/[\s,'’()\-]+/).filter(w => w.length > 4));
  }

  // ---------- Rendering ----------
  async function loadAll(){
    els.refresh.disabled = true;
    setStatus('live', 'Laden…');
    clearBanner();
    try{
      const [firmsSettled, reports, news] = await Promise.all([
        Promise.allSettled(CONFIG.firmsSources.map(fetchFirmsSource)),
        fetchFeuxDeForetReports(),
        fetchGdeltNews()
      ]);

      const failures = [];
      state.hotspots = [];
      for(let i=0;i<firmsSettled.length;i++){
        const result = firmsSettled[i];
        if(result.status === 'fulfilled') state.hotspots.push(...result.value);
        else failures.push(CONFIG.firmsSources[i] + ': ' + (result.reason?.message || result.reason));
      }
      state.officialFires = getOfficialSouthernFranceFires();
      const officialReports = state.officialFires.map(officialFireAsReport);
      state.reports = uniqueReports([...officialReports, ...reports]);
      state.news = news;
      const nasaZones = clusterHotspots(dedupeHotspots(state.hotspots)).slice(0, CONFIG.maxZones);
      const officialZones = state.officialFires.map(officialFireToZone);
      state.zones = [...officialZones, ...nasaZones].sort((a,b) => scoreZone(b) - scoreZone(a)).slice(0, CONFIG.maxZones + officialZones.length);
      await enrichZonesWithWeather(state.zones);
      attachNewsAndReports(state.zones, state.reports, state.news);

      renderAll();
      const msg = `Bijgewerkt ${new Date().toLocaleTimeString('nl-NL', {hour:'2-digit', minute:'2-digit'})}`;
      setStatus('live', msg);
      if(failures.length){ banner('info', `Sommige NASA-bronnen laden niet: ${escapeHtml(failures.join(' · '))}. De kaart gebruikt de bronnen die wel werkten.`); }
      if(!state.hotspots.length && !state.reports.length) banner('info', 'Geen live hittepunten of meldingen gevonden. Dat kan ook betekenen dat een API/proxy tijdelijk blokkeert.');
    }catch(e){
      console.error(e);
      setStatus('error', 'Fout bij laden');
      banner('error', `Laden mislukt: ${escapeHtml(e.message || String(e))}`);
    }finally{
      els.refresh.disabled = false;
      startTimer();
    }
  }

  function renderAll(){
    clusterLayer.clearLayers(); zoneLayer.clearLayers(); reportLayer.clearLayers(); state.zoneLayers.clear(); state.reportLayers.clear(); clearSelectionLayers();
    els.zoneCount.textContent = state.zones.length;
    els.hotspotCount.textContent = state.hotspots.length;
    els.reportCount.textContent = state.reports.length;
    els.countBadge.textContent = state.zones.length ? `— ${state.zones.length}` : '';
    renderZonesOnMap(); renderCards(); renderReports();
  }

  function renderZonesOnMap(){
    for(const z of state.zones){
      const marker = L.marker([z.lat,z.lng], { icon: fireIcon(z.confidence), keyboard: true, title: zoneTitle(z) });
      marker.bindPopup(`<strong>${escapeHtml(zoneTitle(z))}</strong><br>${z.points.length} NASA-punt(en)<br>${z.factLevel}<br><button type="button" onclick="window.__selectFire('${z.id}')">Details tonen</button>`);
      marker.on('click', () => selectZone(z.id));
      clusterLayer.addLayer(marker); state.zoneLayers.set(z.id, marker);
    }
  }

  function renderCards(){
    if(!state.zones.length){ els.cards.innerHTML = '<div class="empty-state">Geen NASA-brandzones in de laatste 24 uur binnen Zuid-Frankrijk.</div>'; return; }
    els.cards.innerHTML = '';
    for(const z of state.zones){
      const card = document.createElement('article');
      card.className = 'fire-card'; card.tabIndex = 0; card.dataset.id = z.id;
      card.innerHTML = `
        <div class="name">${escapeHtml(zoneTitle(z))}</div>
        <div class="meta">${zoneMeta(z)}</div>
        <div class="pill-row">
          <span class="pill ${z.type === 'official' ? 'report' : (z.confidence === 'high' ? 'danger' : 'warn')}">${z.official?.focus ? 'focusgebied' : (z.type === 'official' ? 'officiële/gemelde brand' : confidenceLabel(z.confidence))}</span>
          <span class="pill good">${escapeHtml(z.factLevel)}</span>
          ${z.weather ? `<span class="pill">Wind ${Math.round(z.weather.windSpeed)} km/u</span>` : ''}
        </div>`;
      card.addEventListener('click', () => selectZone(z.id));
      card.addEventListener('keydown', e => { if(e.key === 'Enter') selectZone(z.id); });
      els.cards.appendChild(card);
    }
  }

  function renderReports(){
    const combined = [...state.reports, ...state.news.slice(0, 10).map(n => ({...n, source: n.source || 'GDELT', status:'Nieuwscontrole'}))].slice(0, CONFIG.maxReports);
    if(!combined.length){ els.reports.innerHTML = '<div class="empty-state">Geen specifieke meldingen gevonden via Feux de Forêt of GDELT.</div>'; return; }
    els.reports.innerHTML = '';
    for(const r of combined){
      const card = document.createElement('article');
      card.className = 'report-card';
      card.innerHTML = `
        <div class="name">${escapeHtml(r.title || 'Melding')}</div>
        <div class="meta">${escapeHtml(r.status || r.source)} · ${escapeHtml(r.department ? 'Dept. ' + r.department : r.source || '')}${r.hectares ? ' · ' + escapeHtml(r.hectares + ' ha') : ''} ${r.age ? '· ' + escapeHtml(r.age) : ''}</div>
        <div class="pill-row"><span class="pill report">${escapeHtml(r.source || 'Bron')}</span>${r.url ? `<a class="pill" href="${escapeAttr(r.url)}" target="_blank" rel="noopener">Open bron</a>` : ''}</div>`;
      if(r.zoneId){ card.tabIndex = 0; card.addEventListener('click', e => { if(e.target.tagName !== 'A') selectZone(r.zoneId); }); card.addEventListener('keydown', e => { if(e.key === 'Enter') selectZone(r.zoneId); }); }
      els.reports.appendChild(card);
    }
  }

  async function selectZone(id){
    const z = state.zones.find(x => x.id === id); if(!z) return;
    state.selectedId = id;
    if(z.type !== 'official') await reverseGeocode(z);
    attachNewsAndReports([z], state.reports, state.news);
    updateSelectedCards(); showSelectionLayers(z); renderDetail(z); closePanel();
  }
  window.__selectFire = selectZone;

  function showSelectionLayers(z){
    clearSelectionLayers();
    const areaText = mapAreaLabel(z);
    const areaColor = z.type === 'official' ? '#7b3ff2' : '#ff6b35';
    state.activeAreaLayer = L.circle([z.lat,z.lng], {
      radius: z.radiusKm * 1000,
      color: areaColor,
      weight: 4,
      fillColor: areaColor,
      fillOpacity: .18,
      dashArray: '8 8'
    }).addTo(zoneLayer);
    state.activeAreaLayer.bindTooltip(areaText.full, { permanent: false, sticky: true, className: 'area-tooltip' });
    state.activeAreaLabel = L.marker([z.lat,z.lng], {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: `<div class="area-label"><span>${escapeHtml(areaText.title)}</span><strong>${escapeHtml(areaText.main)}</strong><small>${escapeHtml(areaText.sub)}</small></div>`,
        iconSize: [190, 86],
        iconAnchor: [95, 43]
      })
    }).addTo(zoneLayer);
    if(z.weather && Number.isFinite(Number(z.weather.windDir))){
      const end = destinationPoint(z.lat, z.lng, z.weather.windDir, Math.min(12, Math.max(5, z.radiusKm * 1.5)));
      state.activeWindLayer = L.polyline([[z.lat,z.lng],[end.lat,end.lng]], { color: '#1769e0', weight: 5, opacity: .9 }).addTo(zoneLayer);
      const arrow = L.marker([end.lat,end.lng], { icon: L.divIcon({ html: `<div class="wind-arrow" style="transform:rotate(${z.weather.windDir}deg)">↑</div>`, className:'', iconSize:[34,34], iconAnchor:[17,17] }) }).addTo(zoneLayer);
      state.activeMarker = arrow;
    }
    const bounds = state.activeAreaLayer.getBounds(); map.fitBounds(bounds.pad(.45), { maxZoom: 12, animate: true });
  }
  function clearSelectionLayers(){
    if(state.activeAreaLayer) zoneLayer.removeLayer(state.activeAreaLayer);
    if(state.activeWindLayer) zoneLayer.removeLayer(state.activeWindLayer);
    if(state.activeAreaLabel) zoneLayer.removeLayer(state.activeAreaLabel);
    if(state.activeMarker) zoneLayer.removeLayer(state.activeMarker);
    state.activeAreaLayer = state.activeWindLayer = state.activeAreaLabel = state.activeMarker = null;
  }
  function updateSelectedCards(){ document.querySelectorAll('.fire-card').forEach(c => c.classList.toggle('selected', c.dataset.id === state.selectedId)); }

  function renderDetail(z){
    const place = z.place || {label:'Onbekende plaats', department:''};
    const latest = z.latest ? `${z.latest.date} ${z.latest.time.slice(0,2)}:${z.latest.time.slice(2)} UTC` : 'onbekend';
    const wind = z.weather ? `${Math.round(z.weather.windSpeed)} km/u naar ${windName(z.weather.windDir)} (${Math.round(z.weather.windDir)}°)` : 'niet geladen';
    const gusts = z.weather && z.weather.windGusts != null ? `${Math.round(z.weather.windGusts)} km/u` : 'onbekend';
    const newsLinks = [...z.reports, ...z.news].slice(0,5);
    els.detail.innerHTML = `
      <div class="detail-title">${escapeHtml(zoneTitle(z))}</div>
      <div class="detail-sub">${escapeHtml(place.department || '')}${place.region ? ' · ' + escapeHtml(place.region) : ''}${z.official ? ' · ' + escapeHtml(z.official.status) : ''}</div>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Geschatte straal</span><span class="detail-value">${z.radiusKm.toFixed(1)} km</span></div>
        <div class="detail-item"><span class="detail-label">Geschatte oppervlakte</span><span class="detail-value">${formatArea(z)}</span></div>
        <div class="detail-item"><span class="detail-label">Wind</span><span class="detail-value">${escapeHtml(wind)}</span></div>
        <div class="detail-item"><span class="detail-label">Windstoten</span><span class="detail-value">${escapeHtml(gusts)}</span></div>
        <div class="detail-item"><span class="detail-label">NASA-punten</span><span class="detail-value">${z.points.length || 'geen directe match'}</span></div>
        <div class="detail-item"><span class="detail-label">Laatste detectie</span><span class="detail-value">${escapeHtml(latest)}</span></div>
        <div class="detail-item"><span class="detail-label">${z.official ? 'Gerapporteerde oppervlakte' : 'Totale intensiteit'}</span><span class="detail-value">${z.official ? (z.official.hectares ? z.official.hectares + ' ha' : 'onbekend') : z.totalFrp.toFixed(1) + ' MW'}</span></div>
        <div class="detail-item"><span class="detail-label">Broncontrole</span><span class="detail-value">${escapeHtml(z.factLevel)}</span></div>
      </div>
      ${z.official ? `<p class="detail-note"><strong>${z.official.focus ? 'Focusnotitie' : 'Samenvatting'}:</strong> ${escapeHtml(z.official.summary)}</p>` : ''}
      <p class="detail-note"><strong>Let op:</strong> de oranje cirkel is een berekende/geschatte zone. Bij NASA-zones komt die uit satellietdetecties; bij gemelde branden komt die uit de gerapporteerde hectare-oppervlakte. Dit is geen officiële brandperimeter. Windpijl = richting waar de wind naartoe blaast; rook/vuur kan lokaal anders bewegen door terrein.</p>
      ${newsLinks.length ? `<ul class="source-list">${newsLinks.map(n => `<li><a href="${escapeAttr(n.url)}" target="_blank" rel="noopener">${escapeHtml(n.title || n.source)}</a> <small>${escapeHtml(n.source || '')}</small></li>`).join('')}</ul>` : '<p class="detail-note">Geen extra melding gevonden die automatisch aan deze zone gekoppeld kon worden. Controleer officiële lokale bronnen.</p>'}`;
    openPanel();
  }

  // ---------- Utility ----------

  function formatArea(z){
    const areaKm2 = Number(z.areaKm2 || 0);
    const ha = areaKm2 * 100;
    if(z.official?.focus) return `${formatNumber(ha)} ha bewakingszone (${formatNumber(areaKm2)} km²), geen bevestigde brandoppervlakte`;
    if(z.official && Number.isFinite(Number(z.official.hectares)) && Number(z.official.hectares) > 0){
      const officialHa = Number(z.official.hectares);
      return `${formatNumber(officialHa)} ha (${formatNumber(officialHa / 100)} km²)`;
    }
    return `${formatNumber(ha)} ha (${formatNumber(areaKm2)} km²)`;
  }

  function mapAreaLabel(z){
    const areaKm2 = Number(z.areaKm2 || 0);
    const ha = areaKm2 * 100;
    if(z.official?.focus){
      return {
        title: 'Focusgebied',
        main: 'Carcassonne / Caux',
        sub: `${formatNumber(ha)} ha bewakingszone`,
        full: `Focusgebied rond Carcassonne en Caux-et-Sauzens: ${formatNumber(ha)} ha bewakingszone. Dit is geen bevestigde brandoppervlakte.`
      };
    }
    if(z.official && Number.isFinite(Number(z.official.hectares)) && Number(z.official.hectares) > 0){
      const officialHa = Number(z.official.hectares);
      return {
        title: 'Totale brandoppervlakte',
        main: `${formatNumber(officialHa)} ha`,
        sub: `${formatNumber(officialHa / 100)} km² gemeld`,
        full: `Totale brandoppervlakte: ${formatNumber(officialHa)} ha (${formatNumber(officialHa / 100)} km²). Cirkel is een zichtbare geschatte zone rond de melding.`
      };
    }
    return {
      title: 'Geschatte brandzone',
      main: `${formatNumber(ha)} ha`,
      sub: `${formatNumber(areaKm2)} km² berekend`,
      full: `Geschatte brandzone op basis van NASA-hittepunten: ${formatNumber(ha)} ha (${formatNumber(areaKm2)} km²). Geen officiële brandperimeter.`
    };
  }

  function formatNumber(value){
    const n = Number(value);
    if(!Number.isFinite(n)) return 'onbekend';
    const digits = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
    return new Intl.NumberFormat('nl-NL', { maximumFractionDigits: digits }).format(n);
  }

  function fireIcon(conf){
    const color = conf === 'high' ? '#ff6b35' : conf === 'medium' ? '#d4a017' : '#8aa15b';
    return L.divIcon({ html:`<div class="fire-dot" style="background:${color}"></div>`, className:'', iconSize:[24,24], iconAnchor:[12,12] });
  }
  function zoneTitle(z){
    if(z.official) return z.official.title;
    if(z.place && z.place.label) return z.place.label;
    return `${z.lat.toFixed(3)}, ${z.lng.toFixed(3)}`;
  }
  function zoneMeta(z){
    if(z.type === 'official'){
      if(z.official?.focus) return `prioriteit rond Carcassonne en Caux-et-Sauzens · straal ${z.radiusKm.toFixed(1)} km · ${z.official.status}`;
      const area = z.official.hectares ? `${z.official.hectares} ha gemeld` : 'oppervlakte onbekend';
      return `${area} · geschatte zone ${z.radiusKm.toFixed(1)} km · update ${z.official.updated || 'onbekend'}`;
    }
    return `${z.points.length} hittepunt(en) · geschatte zone ${z.radiusKm.toFixed(1)} km · FRP ${z.totalFrp.toFixed(1)} MW`;
  }
  function confidenceLabel(c){ return c === 'high' ? 'hoge betrouwbaarheid' : c === 'low' ? 'lage betrouwbaarheid' : 'gemiddelde betrouwbaarheid'; }
  function km(lat1, lon1, lat2, lon2){
    const R=6371, dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
    const a=Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  function rad(d){ return d*Math.PI/180; }
  function destinationPoint(lat, lon, bearing, distKm){
    const R=6371, br=rad(bearing), la1=rad(lat), lo1=rad(lon), d=distKm/R;
    const la2=Math.asin(Math.sin(la1)*Math.cos(d)+Math.cos(la1)*Math.sin(d)*Math.cos(br));
    const lo2=lo1+Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(la1),Math.cos(d)-Math.sin(la1)*Math.sin(la2));
    return {lat: la2*180/Math.PI, lng: lo2*180/Math.PI};
  }
  function windName(deg){
    const dirs=['noord','noordoost','oost','zuidoost','zuid','zuidwest','west','noordwest'];
    return dirs[Math.round(((Number(deg)%360)+360)%360/45)%8];
  }
  function dedupeHotspots(points){
    const seen = new Set();
    return points.filter(p => { const k=`${p.lat.toFixed(3)},${p.lng.toFixed(3)},${p.date},${p.time}`; if(seen.has(k)) return false; seen.add(k); return true; });
  }
  function uniqueReports(reports){
    const seen = new Set();
    return reports.filter(r => { const k=(r.id || r.url || (r.department+'|'+r.title)).toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; });
  }
  function containsAny(text, words){ text = String(text || '').toLowerCase(); return words.some(w => text.includes(String(w).toLowerCase())); }
  function htmlToText(html){ return cleanText(String(html).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,'\n')); }
  function cleanText(s){ return String(s || '').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim(); }
  function escapeHtml(s){ return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function escapeAttr(s){ return escapeHtml(s).replace(/`/g,'&#96;'); }
  function startTimer(){ if(state.timer) clearInterval(state.timer); state.timer = setInterval(loadAll, CONFIG.refreshMs); }

  // Auto-load with the available key, but keep key box visible so the user can replace it.
  if(state.mapKey){ loadAll(); } else { setStatus('', 'Wacht op sleutel'); }
})();
