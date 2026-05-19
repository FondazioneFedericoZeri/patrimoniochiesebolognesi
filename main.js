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

// ── Active marker ─────────────────────────────────────────────────
function getMarkerEl(marker) {
  return marker._path || marker._icon || null;
}

function setActiveMarker(marker) {
  allMarkers.forEach(function (item) {
    const el = getMarkerEl(item.marker);
    if (el) el.classList.remove('active-marker');
  });
  const el = getMarkerEl(marker);
  if (el) el.classList.add('active-marker');
}

// ── Filter helpers ────────────────────────────────────────────────
function applyFilter() {
  clusterGroup.clearLayers();
  const showNonEsistente = activeCategories.has('Non più esistente');
  const onlyNonEsistente = showNonEsistente &&
    [...activeCategories].every(function (c) { return c === 'Non più esistente'; });

  allMarkers.forEach(function (item) {
    if (item.nonEsistente) {
      if (!showNonEsistente) return;
      if (!onlyNonEsistente && !activeCategories.has(item.cat)) return;
    } else {
      if (!activeCategories.has(item.cat)) return;
    }
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
    html: '<div class="place-marker--ex" style="background:' + color + '"><i class="fa-solid fa-asterisk"></i></div>',
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
    // Hide hospital / medical area fills (pink background on the basemap)
    if (/hospital|medical|healthcare/i.test(layer.id)) {
      glMap.setLayoutProperty(layer.id, 'visibility', 'none');
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
    zoomToBoundsOnClick: true,
    iconCreateFunction: function (_cluster) {
      return L.divIcon({
        html: '<div class="cluster-icon"><i class="fa-solid fa-plus"></i></div>',
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
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

    // Event on marker click: open popup (with costum content) and set active marker styling
    marker.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      const place = placesData.find(function (p) { return p.ID === this.placeId; }, this);
      console.log('place:', place.Contenitore);
      setActiveMarker(this);

      // ====== popup costumisation =======

      // Title
      document.getElementById('container-name').textContent = place.Contenitore;

      // "Non più esistente" text visibility
      if (isNonEsistente(place)) {
        document.getElementById('non-existing-place-text').style.display = 'flex';
      } else {
        document.getElementById('non-existing-place-text').style.display = 'none';
      }

      // Image
      if (place.Path) {
        document.getElementById('card-img-container').style.display = 'flex';
        document.querySelector('#card-img').src = `assets/images/thumb/${place.Path}`;
      } else {
        document.getElementById('card-img-container').style.display = 'none';
      }

      // Le opere nel contesto (LDCN, PRCD)
      const hasCatalogLinks = place.LDCN !== "" || place.PRCD !== "";

      if (hasCatalogLinks) {
        if (place.LDCN) {
          document.getElementById('btn-ldcn-container').style.display = 'inline-flex';
          document.getElementById('btn-ldcn').href = place.LDCN;
        } else {
          document.getElementById('btn-ldcn-container').style.display = 'none';
        }

        if (place.PRCD) {
          document.getElementById('btn-prcd-container').style.display = 'inline-flex';
          document.getElementById('btn-prcd').href = place.PRCD;
        } else {
          document.getElementById('btn-prcd-container').style.display = 'none';
        }

        document.getElementById('catalogue-links').style.display = 'block';
      } else {
        document.getElementById('catalogue-links').style.display = 'none';
      }

      // Il sito (Scheda_Chiesa)
      if (place.Scheda_Chiesa) {
        document.getElementById('btn-site').href = place.Scheda_Chiesa;
        document.getElementById('btn-site').style.display = 'inline-flex';
        document.getElementById('btn-site-img').href = place.Scheda_Chiesa;
      } else {
        document.getElementById('btn-site').style.display = 'none';
        document.getElementById('btn-site-img').href = '#';
      }

      // Additional resources
      const isLinkBlank = (link) => link === "" || link === undefined;

      let linksAddtional = {
        'Storia e Memoria di Bologna': place.Link_StorieMemorie,
        'Origine di Bologna': place.Link_OrigineBologna,
        'Biblioteca Salaborsa': place.Link_BibSalaBorsa,
        'Wikipedia': place.Link_Wiki,
        'Genus Bononiae': place.Link_GenusBononiae,
        'Centro Studi \'Gina Fasoli\'': place.Link_CentroFasoli,
        'Biblioteca Comunale dell\'Archiginnasio': place.Link_Archiginnasio,
        'Fondazione Cassa di Risparmio in Bologna': place.Link_Carisbo,
        'Beni Ecclesiastici in Web (BeWeb)': place.Link_Beweb,
        'Catalogo generale dei Beni Culturali': place.Link_CatBBCC,
        'Le chiese delle diocesi italiane': place.Link_Chiese_ita,
        'ASP Città di Bologna': place.Link_ASP,
        'Città Metropolitana di Bologna': place.Link_cittàmetr_BO
      }

      if (Object.values(linksAddtional).every(isLinkBlank)) {
        document.getElementById('additional-links').style.display = 'none';
      } else {
        document.getElementById('link-list').innerHTML = '';

        for (const [label, url] of Object.entries(linksAddtional)) {
          if (!isLinkBlank(url)) {
            document.getElementById('link-list').innerHTML += `<li><a href="${url}" target="_blank">${label} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></li>`;
          }
        }

        document.getElementById('additional-links').style.display = 'block';
      }

      // ==================================

      document.getElementById('ui-float-popup').classList.add('visible');
      document.getElementById('ui-float-top').classList.remove('visible');
    });

    allMarkers.push({ marker: marker, cat: isNonEsistente(place) ? primaryCat(place) : place.Categoria, nonEsistente: isNonEsistente(place) });
    clusterGroup.addLayer(marker);
  });

  map.addLayer(clusterGroup);
  initChipFilters();
}

function closePopup() {
  document.getElementById('ui-float-popup').classList.remove('visible');
  document.getElementById('ui-float-top').classList.add('visible');
  setActiveMarker({});
}

// ── Hero button ───────────────────────────────────────────────────
document.getElementById('btn').addEventListener('click', function () {
  const hero = document.getElementById('hero');
  const float = document.getElementById('ui-float-top');

  hero.classList.add('up');
  float.classList.add('visible');
  document.getElementById('ui-float-logos').classList.add('visible');

  // Show intro modal after the hero has finished lifting (1.1s transition)
  setTimeout(function () {
    const introModal = new bootstrap.Modal(document.getElementById('modal-intro'));
    introModal.show();
  }, 1000);

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
