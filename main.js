// ── Global data ───────────────────────────────────────────────────
let placesData = [];
let csvReady = false;
let markersInitialized = false;
let panelActivatedBeforeCSV = false;

let clusterGroup = null;
let allMarkers = [];        // [{ marker, cat }] – used by the filter
let activeCategories = null; // populated in initChipFilters()

// ── CSV parser (handles RFC-4180 quoted fields) ───────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(function (line) {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach(function (h, i) {
      obj[h] = (values[i] || '').trim();
    });
    return obj;
  });
}

// Load CSV immediately on page load
fetch('assets/data.csv')
  .then(function (r) { return r.text(); })
  .then(function (text) {
    placesData = parseCSV(text);
    csvReady = true;
    // If the user clicked the button while the CSV was still loading, init now
    if (panelActivatedBeforeCSV) {
      initMarkers();
    }
  })
  .catch(function (err) {
    console.error('Impossibile caricare data.csv:', err);
  });

// ── Category → fill colour (reads directly from :root CSS variables) ─
const _css = getComputedStyle(document.documentElement);
const CATEGORY_COLORS = {
  'Chiese':                 _css.getPropertyValue('--col-church').trim(),
  'Basiliche e cattedrali': _css.getPropertyValue('--col-cathed').trim(),
  'Conventi e monasteri':   _css.getPropertyValue('--col-monast').trim(),
  'Musei':                  _css.getPropertyValue('--col-museum').trim(),
  'Oratori':                _css.getPropertyValue('--col-orator').trim(),
  'Altri luoghi di culto':  _css.getPropertyValue('--col-others').trim(),
};

// Returns true when the place is flagged as no longer existing.
// Works with a plain value ("Non più esistente") or combined values
// ("Chiese, Non più esistente") using a case-insensitive substring match.
function isNonEsistente(place) {
  return place.Categoria
    ? place.Categoria.toLowerCase().includes('non più esistente')
    : false;
}

// When Categoria is combined (e.g. "Chiese, Non più esistente"),
// return the first token that maps to a known category.
function primaryCat(place) {
  const parts = place.Categoria.split(/[,;|]+/).map(function (s) { return s.trim(); });
  for (let i = 0; i < parts.length; i++) {
    if (CATEGORY_COLORS[parts[i]]) return parts[i];
  }
  return parts[0];
}

function primaryColor(place) {
  return CATEGORY_COLORS[primaryCat(place)] || '#a5a5a5';
}

// ── Filter helpers ────────────────────────────────────────────────
function applyFilter() {
  clusterGroup.clearLayers();
  const showNonEsistente = activeCategories.has('Non più esistente');
  allMarkers.forEach(function (item) {
    if (!activeCategories.has(item.cat)) return;
    if (item.nonEsistente && !showNonEsistente) return;
    clusterGroup.addLayer(item.marker);
  });
}

function initChipFilters() {
  activeCategories = new Set([...Object.keys(CATEGORY_COLORS), 'Non più esistente']);

  document.querySelectorAll('.chip[data-category]').forEach(function (chip) {
    chip.classList.add('chip--active');
    chip.addEventListener('click', function () {
      const cat = chip.dataset.category;
      if (activeCategories.has(cat)) {
        activeCategories.delete(cat);
        chip.classList.remove('chip--active');
      } else {
        activeCategories.add(cat);
        chip.classList.add('chip--active');
      }
      applyFilter();
    });
  });
}

// Build a DivIcon that looks like a filled circle with a centred asterisk —
// used for "Non più esistente" markers.
function nonEsistenteIcon(color) {
  return L.divIcon({
    html: '<div class="place-marker--ex" style="background:' + color + '"><i class="bi bi-asterisk"></i></div>',
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// ── Leaflet map ───────────────────────────────────────────────────
// maxZoom required by markercluster's spiderfyOnMaxZoom logic
const map = L.map('map', { scrollWheelZoom: true, zoomSnap: 0, zoomControl: false, maxZoom: 19 }).setView([44.495, 11.3426], 15);

L.control.zoom({ position: 'topright' }).addTo(map);

const gl = L.maplibreGL({
  style: 'https://tiles.openfreemap.org/styles/liberty',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// Once the vector style is fully loaded, filter POIs to cultural/historic/religious only
gl.getMaplibreMap().on('style.load', function () {
  const glMap = gl.getMaplibreMap();

  // Set all text labels to prefer Italian name, falling back to the default OSM name
  glMap.getStyle().layers.forEach(function (layer) {
    if (layer.layout && layer.layout['text-field']) {
      glMap.setLayoutProperty(layer.id, 'text-field', [
        'coalesce', ['get', 'name:it'], ['get', 'name'],
      ]);
    }
  });

  glMap.getStyle().layers.forEach(function (layer) {
    // Hide commercial/retail shop layers entirely
    if (/shop|poi_shop|retail/i.test(layer.id)) {
      glMap.setLayoutProperty(layer.id, 'visibility', 'none');
    }
    // For all POI label layers, keep only cultural heritage classes
    if (/^poi/i.test(layer.id)) {
      glMap.setFilter(layer.id, [
        'in', ['get', 'class'], ['literal', [
          'place_of_worship',
          'monument',
          'castle',
          'ruins',
          'historic',
          'museum',
          'gallery',
          'artwork',
          'attraction',
        ]],
      ]);
    }
  });
});

// ── Marker initialisation ─────────────────────────────────────────
function initMarkers() {
  if (markersInitialized) return;
  markersInitialized = true;

  // maxClusterRadius: 1 → only markers at essentially the same pixel position
  // cluster (i.e. identical coordinates in the dataset).
  clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 1,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    iconCreateFunction: function (_cluster) {
      return L.divIcon({
        html: '<div class="cluster-icon"></div>',
        className: '',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
    },
  });

  placesData.forEach(function (place) {
    const lat = parseFloat(place.Lat);
    const lng = parseFloat(place.Long);
    if (isNaN(lat) || isNaN(lng)) return;

    let marker;

    if (isNonEsistente(place)) {
      // Colored circle with asterisk overlay
      const color = primaryColor(place);
      marker = L.marker([lat, lng], { icon: nonEsistenteIcon(color) });
    } else {
      // Plain filled circle
      const color = CATEGORY_COLORS[place.Categoria] || '#a5a5a5';
      marker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: color,
        color: '#fff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85,
      });
    }

    // Embed the ID on the marker — will be used by the detail panel
    marker.placeId = place.ID;

    // TODO: replace console.log with detail-panel open logic
    marker.on('click', function () {
      console.log('placeId:', this.placeId);
    });

    allMarkers.push({ marker: marker, cat: isNonEsistente(place) ? primaryCat(place) : place.Categoria, nonEsistente: isNonEsistente(place) });
    clusterGroup.addLayer(marker);
  });

  map.addLayer(clusterGroup);
  initChipFilters();
}

// ── Hero button ───────────────────────────────────────────────────
document.getElementById('btn').addEventListener('click', function () {
  const hero = document.getElementById('hero');
  const fab = document.getElementById('ui-fab');

  hero.classList.add('up');
  fab.classList.add('visible');

  if (csvReady) {
    initMarkers();
  } else {
    // CSV still loading — flag so initMarkers() fires when it arrives
    panelActivatedBeforeCSV = true;
  }

  setTimeout(function () {
    hero.style.display = 'none';
    map.invalidateSize();
  }, 1200);
});
