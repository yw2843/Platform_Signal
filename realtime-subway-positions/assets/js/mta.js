/* ==============================================
   Realtime NYC Subway Positions
   ==============================================
   Fetches MTA GTFS-Realtime feeds, decodes the protobuf in the browser,
   and renders one point per active train on a MapLibre map.

   Feeds: https://api.mta.info/#/subwayRealTimeFeeds
   Spec:  https://gtfs.org/realtime/reference/
*/

const FEEDS = {
  l:       "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
  ace:     "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  nqrw:    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "123456":"https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  bdfm:    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  g:       "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  jz:      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
};

const POLL_INTERVAL_MS = 15000;

let STOPS = {};
let ROUTES = {};
let FeedMessage = null;
let map = null;
const enabledFeeds = new Set();

async function init() {
  setStatus("Loading data...");

  const [stops, routes] = await Promise.all([
    fetch("assets/data/stops.json").then(r => r.json()),
    fetch("assets/data/routes.json").then(r => r.json()),
  ]);
  STOPS = stops;
  ROUTES = routes;

  const root = protobuf.parse(window.GTFS_RT_PROTO, { keepCase: true }).root;
  FeedMessage = root.lookupType("transit_realtime.FeedMessage");

  setupMap();
  setupControls();
  await refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
}

function setupMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "&copy; OpenStreetMap contributors, &copy; CARTO",
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    },
    center: [-73.965, 40.72],
    zoom: 11,
  });

  map.on("load", () => {
    map.addSource("trains", { type: "geojson", data: emptyFC() });

    map.addLayer({
      id: "trains-circles",
      type: "circle",
      source: "trains",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          9, 3,
          14, 8,
        ],
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#111",
        "circle-stroke-width": 1,
        "circle-opacity": 0.9,
      },
    });

    map.on("click", "trains-circles", e => {
      const p = e.features[0].properties;
      const routeColor = p.color || "#666";
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <div>
            <span class="route-chip" style="background:${routeColor}">${p.route}</span>
            <strong>${p.destination || "Route " + p.route}</strong>
          </div>
          <div style="margin-top:0.35rem;font-size:0.8rem;color:#555;">
            Next stop: ${p.nextStop}<br/>
            Arriving: ${p.arrivalRel}
          </div>
        `)
        .addTo(map);
    });

    map.on("mouseenter", "trains-circles", () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", "trains-circles", () => map.getCanvas().style.cursor = "");
  });
}

function setupControls() {
  document.querySelectorAll("#legend input[type=checkbox]").forEach(cb => {
    if (cb.checked) enabledFeeds.add(cb.dataset.feed);
    cb.addEventListener("change", () => {
      if (cb.checked) enabledFeeds.add(cb.dataset.feed);
      else enabledFeeds.delete(cb.dataset.feed);
      refresh();
    });
  });
}

async function refresh() {
  if (!map || !map.isStyleLoaded()) {
    map?.once("load", refresh);
    return;
  }

  setStatus("Refreshing...");
  const feedNames = Array.from(enabledFeeds);
  const results = await Promise.allSettled(
    feedNames.map(name => fetchFeed(FEEDS[name]))
  );

  const trains = [];
  let errors = 0;
  results.forEach(r => {
    if (r.status === "fulfilled") trains.push(...extractTrains(r.value));
    else errors++;
  });

  const fc = trainsToGeoJSON(trains);
  map.getSource("trains").setData(fc);

  const t = new Date().toLocaleTimeString();
  setStatus(`${fc.features.length} trains  |  ${feedNames.length - errors}/${feedNames.length} feeds  |  ${t}`);
}

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return FeedMessage.decode(buf);
}

function extractTrains(feed) {
  const out = [];
  const now = Date.now() / 1000;

  for (const entity of feed.entity) {
    const tu = entity.trip_update;
    if (!tu || !tu.trip || !tu.stop_time_update?.length) continue;

    const next = tu.stop_time_update.find(s =>
      (s.arrival?.time && Number(s.arrival.time) >= now) ||
      (s.departure?.time && Number(s.departure.time) >= now)
    ) || tu.stop_time_update[0];

    const last = tu.stop_time_update[tu.stop_time_update.length - 1];

    out.push({
      routeId: tu.trip.route_id,
      tripId: tu.trip.trip_id,
      nextStopId: next.stop_id,
      arrivalTime: Number(next.arrival?.time || next.departure?.time || 0),
      finalStopId: last.stop_id,
    });
  }
  return out;
}

function stopCoords(stopId) {
  if (!stopId) return null;
  const base = stopId.replace(/[NS]$/, "");
  const s = STOPS[base];
  return s ? { coords: [s.lon, s.lat], name: s.name } : null;
}

function trainsToGeoJSON(trains) {
  const seen = new Set();
  const features = [];

  for (const t of trains) {
    if (seen.has(t.tripId)) continue;
    seen.add(t.tripId);

    const here = stopCoords(t.nextStopId);
    if (!here) continue;

    const dest = stopCoords(t.finalStopId);
    const route = ROUTES[t.routeId] || {};
    const secondsAway = Math.max(0, t.arrivalTime - Date.now() / 1000);

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: here.coords },
      properties: {
        route: t.routeId,
        color: route.color || "#666",
        nextStop: here.name,
        destination: dest ? dest.name : "",
        arrivalRel: secondsAway < 30 ? "arriving" : `${Math.round(secondsAway / 60)} min`,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

init().catch(err => {
  console.error(err);
  setStatus(`Error: ${err.message}. Check console. If this is a CORS error, see README.`);
});
