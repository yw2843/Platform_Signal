/* global maplibregl, deck */

const LGA = {longitude: -73.87260555, latitude: 40.77724222};
const MODEL_HEADING_OFFSET_DEG = 0;
const COLORS = {
  probable: [245, 166, 35, 235],
  confirmed: [46, 212, 122, 240],
  selected: [255, 255, 255, 255],
};

const ui = {
  connection: document.getElementById('connection'),
  statusDot: document.getElementById('status-dot'),
  statusLabel: document.getElementById('status-label'),
  planButton: document.getElementById('plan-button'),
  threeDButton: document.getElementById('three-d-button'),
  confirmedCount: document.getElementById('confirmed-count'),
  probableCount: document.getElementById('probable-count'),
  lastUpdate: document.getElementById('last-update'),
  detailsPanel: document.getElementById('details-panel'),
  detailsClose: document.getElementById('details-close'),
  detailsStatus: document.getElementById('details-status'),
  detailsCallsign: document.getElementById('details-callsign'),
  detailsRoute: document.getElementById('details-route'),
  detailsBody: document.getElementById('details-body'),
  detailsNote: document.getElementById('details-note'),
  loadingCard: document.getElementById('loading-card'),
  mapMessage: document.getElementById('map-message'),
};

const state = {
  flights: [],
  selectedIcao24: null,
  mode: 'plan',
  overlay: null,
  mapReady: false,
  messageTimer: null,
};

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/bright',
  center: [LGA.longitude, LGA.latitude],
  zoom: 8.2,
  pitch: 0,
  bearing: 0,
  maxPitch: 80,
  canvasContextAttributes: {antialias: true},
});

map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({unit: 'nautical'}), 'bottom-right');

map.on('load', () => {
  addBoundaryLayers();
  addThreeDimensionalSources();

  state.overlay = new deck.MapboxOverlay({
    interleaved: true,
    layers: [],
    getTooltip: ({object}) => object ? tooltipText(object) : null,
  });
  map.addControl(state.overlay);
  state.mapReady = true;
  updateDeckLayers();
});

map.on('error', event => {
  const message = event?.error?.message || 'A map resource could not be loaded.';
  showMessage(message);
});

function addBoundaryLayers() {
  map.addSource('lga-boundary', {
    type: 'geojson',
    data: circleFeature(LGA.longitude, LGA.latitude, 40, 160),
  });
  map.addLayer({
    id: 'lga-boundary-fill',
    type: 'fill',
    source: 'lga-boundary',
    paint: {
      'fill-color': '#6dc8ff',
      'fill-opacity': 0.035,
    },
  });
  map.addLayer({
    id: 'lga-boundary-line',
    type: 'line',
    source: 'lga-boundary',
    paint: {
      'line-color': '#42a9e6',
      'line-width': 1.4,
      'line-opacity': 0.8,
      'line-dasharray': [3, 2],
    },
  });

  map.addSource('lga-airport', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [LGA.longitude, LGA.latitude]},
      properties: {},
    },
  });
  map.addLayer({
    id: 'lga-airport-marker',
    type: 'circle',
    source: 'lga-airport',
    paint: {
      'circle-radius': 5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0b1928',
      'circle-stroke-width': 2,
    },
  });
}

function addThreeDimensionalSources() {
  map.addSource('terrain-dem', {
    type: 'raster-dem',
    url: 'https://tiles.mapterhorn.com/tilejson.json',
    tileSize: 256,
  });
  map.addSource('openfreemap-buildings', {
    type: 'vector',
    url: 'https://tiles.openfreemap.org/planet',
  });

  const firstLabel = map.getStyle().layers.find(layer => layer.type === 'symbol' && layer.layout?.['text-field']);
  map.addLayer(
    {
      id: 'three-d-buildings',
      type: 'fill-extrusion',
      source: 'openfreemap-buildings',
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      layout: {visibility: 'none'},
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0],
          0, '#d8e1e7',
          80, '#afc2ce',
          250, '#7898ab',
        ],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.76,
      },
    },
    firstLabel?.id,
  );
}

function updateDeckLayers() {
  if (!state.mapReady || !state.overlay) return;

  const activeFlights = state.flights.filter(flight => flight.active);
  const probable = state.flights.filter(flight => flight.status === 'probable' && flight.track.length > 1);
  const confirmed = state.flights.filter(flight => flight.status === 'confirmed' && flight.track.length > 1);

  const onPick = info => {
    if (info?.object) selectFlight(info.object.icao24);
  };

  const layers = [
    new deck.PathLayer({
      id: 'confirmed-flight-trails',
      data: confirmed,
      getPath: flight => flight.track.map(point => [point.longitude, point.latitude, point.altitude_m || 0]),
      getColor: flight => flight.icao24 === state.selectedIcao24 ? COLORS.selected : COLORS.confirmed,
      getWidth: flight => flight.icao24 === state.selectedIcao24 ? 5 : 3,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 140],
      onClick: onPick,
      updateTriggers: {getColor: state.selectedIcao24, getWidth: state.selectedIcao24},
    }),
    new deck.PathLayer({
      id: 'probable-flight-trails',
      data: probable,
      getPath: flight => flight.track.map(point => [point.longitude, point.latitude, point.altitude_m || 0]),
      getColor: flight => flight.icao24 === state.selectedIcao24 ? COLORS.selected : COLORS.probable,
      getWidth: flight => flight.icao24 === state.selectedIcao24 ? 5 : 3,
      getDashArray: [3, 2],
      dashJustified: true,
      dashGapPickable: true,
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 140],
      extensions: [new deck.PathStyleExtension({dash: true})],
      onClick: onPick,
      updateTriggers: {getColor: state.selectedIcao24, getWidth: state.selectedIcao24},
    }),
    new deck.ScatterplotLayer({
      id: 'flight-status-halos',
      data: activeFlights,
      getPosition: flight => positionOf(flight),
      getRadius: 8,
      radiusUnits: 'pixels',
      getFillColor: flight => statusColor(flight, 115),
      getLineColor: flight => flight.icao24 === state.selectedIcao24 ? COLORS.selected : statusColor(flight, 255),
      lineWidthUnits: 'pixels',
      getLineWidth: flight => flight.icao24 === state.selectedIcao24 ? 3 : 1.5,
      stroked: true,
      pickable: true,
      onClick: onPick,
      updateTriggers: {getFillColor: state.selectedIcao24, getLineColor: state.selectedIcao24},
    }),
    new deck.ScenegraphLayer({
      id: 'dc8-aircraft-models',
      data: activeFlights,
      scenegraph: '/assets/plane.glb',
      getPosition: flight => positionOf(flight),
      getOrientation: flight => [0, (flight.current.heading_deg || 0) + MODEL_HEADING_OFFSET_DEG, 90],
      getScale: [1, 1, 1],
      sizeScale: 1,
      sizeMinPixels: 10,
      sizeMaxPixels: state.mode === 'plan' ? 32 : 58,
      _lighting: 'pbr',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 100],
      onClick: onPick,
      updateTriggers: {getOrientation: state.mode},
    }),
  ];

  state.overlay.setProps({layers});
}

function positionOf(flight) {
  const current = flight.current;
  return [current.longitude, current.latitude, current.altitude_m || 0];
}

function statusColor(flight, alpha) {
  const color = flight.status === 'confirmed' ? COLORS.confirmed : COLORS.probable;
  return [color[0], color[1], color[2], alpha];
}

function tooltipText(flight) {
  const call = flight.callsign || flight.icao24.toUpperCase();
  const distance = formatNumber(flight.current.distance_nm, 1, ' NM');
  return `${call} · ${capitalize(flight.status)} ${flight.direction} · ${distance}`;
}

async function refreshFlights() {
  try {
    const response = await fetch('/api/flights', {cache: 'no-store'});
    if (!response.ok) throw new Error(`Tracker API returned HTTP ${response.status}`);
    const payload = await response.json();
    state.flights = payload.flights || [];
    renderStatus(payload);
    updateDeckLayers();
    refreshSelectedFlight();
  } catch (error) {
    setConnection('error', 'Local API error');
    showMessage(error.message || String(error));
  }
}

function renderStatus(payload) {
  const service = payload.service || {};
  setConnection(service.state, service.state === 'online' ? 'Live' : capitalize(service.state || 'starting'));
  ui.confirmedCount.textContent = state.flights.filter(flight => flight.status === 'confirmed').length;
  ui.probableCount.textContent = state.flights.filter(flight => flight.status === 'probable').length;
  ui.lastUpdate.textContent = payload.source_time ? formatClock(payload.source_time) : '—';
  ui.loadingCard.classList.toggle('hidden', Boolean(payload.source_time));
  ui.connection.title = [service.message, service.remaining_credits != null ? `${service.remaining_credits} state credits remaining` : '']
    .filter(Boolean)
    .join(' · ');
}

function setConnection(status, label) {
  ui.statusDot.className = 'status-dot';
  if (status === 'online') ui.statusDot.classList.add('online');
  if (status === 'error') ui.statusDot.classList.add('error');
  ui.statusLabel.textContent = label;
}

function setMode(mode) {
  if (state.mode === mode || !state.mapReady) return;
  state.mode = mode;
  const is3D = mode === '3d';
  ui.planButton.classList.toggle('active', !is3D);
  ui.threeDButton.classList.toggle('active', is3D);
  ui.planButton.setAttribute('aria-pressed', String(!is3D));
  ui.threeDButton.setAttribute('aria-pressed', String(is3D));

  map.setLayoutProperty('three-d-buildings', 'visibility', is3D ? 'visible' : 'none');
  map.setTerrain(is3D ? {source: 'terrain-dem', exaggeration: 1} : null);
  map.easeTo({
    pitch: is3D ? 60 : 0,
    bearing: is3D ? -18 : 0,
    duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 850,
  });
  updateDeckLayers();
}

function selectFlight(icao24) {
  state.selectedIcao24 = icao24;
  const flight = state.flights.find(item => item.icao24 === icao24);
  if (!flight) return;
  renderDetails(flight);
  ui.detailsPanel.classList.add('open');
  ui.detailsPanel.setAttribute('aria-hidden', 'false');
  updateDeckLayers();
}

function closeDetails() {
  state.selectedIcao24 = null;
  ui.detailsPanel.classList.remove('open');
  ui.detailsPanel.setAttribute('aria-hidden', 'true');
  updateDeckLayers();
}

function refreshSelectedFlight() {
  if (!state.selectedIcao24) return;
  const flight = state.flights.find(item => item.icao24 === state.selectedIcao24);
  if (flight) renderDetails(flight);
  else closeDetails();
}

function renderDetails(flight) {
  const current = flight.current;
  ui.detailsStatus.textContent = `${capitalize(flight.status)} · ${capitalize(flight.direction)}`;
  ui.detailsStatus.style.color = flight.status === 'confirmed' ? '#2ed47a' : '#f5a623';
  ui.detailsCallsign.textContent = flight.callsign || flight.icao24.toUpperCase();
  ui.detailsRoute.textContent = `${flight.track.length} observations · one-hour rolling trail`;

  const frequency = current.frequency_mhz == null
    ? current.frequency_status
    : `${current.frequency_mhz.toFixed(1)} MHz`;
  const rows = [
    ['ICAO24', flight.icao24.toUpperCase()],
    ['Status', capitalize(flight.status)],
    ['Direction', capitalize(flight.direction)],
    ['Phase', label(current.phase)],
    ['Distance to LGA', formatNumber(current.distance_nm, 1, ' NM')],
    ['Altitude', formatNumber(current.altitude_ft, 0, ' ft')],
    ['Ground speed', formatNumber(current.speed_kt, 0, ' kt')],
    ['Vertical rate', formatSigned(current.vertical_fpm, 0, ' ft/min')],
    ['True track', formatNumber(current.heading_deg, 0, '°')],
    ['Service', current.service ? capitalize(current.service) : '—'],
    ['Frequency', frequency || '—'],
    ['Matched rule', current.matched_rule_id || '—'],
    ['Facility', current.facility_id || '—'],
    ['Last position', formatDateTime(current.timestamp)],
  ];
  ui.detailsBody.replaceChildren(...rows.map(([key, value]) => detailRow(key, value)));
  ui.detailsNote.textContent = current.phase_scope === 'outside_current_rule'
    ? 'This observation is beyond the current 40 NM phase/frequency rules. Frequency work is marked Future Research.'
    : 'Phase and frequency are inferred by the local prototype rules; they are not live ATC handoff data.';
}

function detailRow(key, value) {
  const row = document.createElement('tr');
  const header = document.createElement('th');
  const cell = document.createElement('td');
  header.scope = 'row';
  header.textContent = key;
  cell.textContent = value;
  row.append(header, cell);
  return row;
}

function circleFeature(longitude, latitude, radiusNm, steps) {
  const coordinates = [];
  const angularDistance = radiusNm / 3440.065;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  for (let index = 0; index <= steps; index += 1) {
    const bearing = 2 * Math.PI * index / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );
    coordinates.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
  }
  return {
    type: 'Feature',
    properties: {radius_nm: radiusNm},
    geometry: {type: 'Polygon', coordinates: [coordinates]},
  };
}

function formatNumber(value, digits, suffix = '') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits})}${suffix}`;
}

function formatSigned(value, digits, suffix = '') {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits})}${suffix}`;
}

function formatClock(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
}

function formatDateTime(epochSeconds) {
  if (!epochSeconds) return '—';
  return new Date(epochSeconds * 1000).toLocaleString();
}

function capitalize(value) {
  if (!value) return 'Unknown';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function label(value) {
  if (!value) return 'Unknown';
  return value.split('_').map(capitalize).join(' ');
}

function showMessage(message) {
  ui.mapMessage.textContent = message;
  ui.mapMessage.classList.add('visible');
  window.clearTimeout(state.messageTimer);
  state.messageTimer = window.setTimeout(() => ui.mapMessage.classList.remove('visible'), 8000);
}

ui.planButton.addEventListener('click', () => setMode('plan'));
ui.threeDButton.addEventListener('click', () => setMode('3d'));
ui.detailsClose.addEventListener('click', closeDetails);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDetails();
});
map.on('click', event => {
  if (!event.defaultPrevented && event.originalEvent?.target === map.getCanvas()) {
    // Deck layer clicks select a flight before this handler runs. Preserve it.
    window.setTimeout(() => {}, 0);
  }
});

refreshFlights();
window.setInterval(refreshFlights, 5000);
