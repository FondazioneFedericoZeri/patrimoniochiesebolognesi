// Leaflet map centred on Bologna's historic centre
// zoomSnap: 0 allows fractional zoom levels (e.g. 15.5); zoomControl: false lets us place it manually
const map = L.map('map', { scrollWheelZoom: true, zoomSnap: 0, zoomControl: false }).setView([44.495, 11.3426], 15.5);

L.control.zoom({ position: 'topright' }).addTo(map);

// MapLibre GL vector tile layer via the leaflet-maplibre-gl plugin.
// OpenFreeMap liberty style: free, no API key, OSM data.
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
          'place_of_worship',  // churches, cathedrals, monasteries
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

// Lift the hero upward on button click
document.getElementById('btn').addEventListener('click', function () {
  var hero = document.getElementById('hero');
  hero.classList.add('up');
  setTimeout(function () {
    hero.style.display = 'none';
    map.invalidateSize();
  }, 1200);
});
