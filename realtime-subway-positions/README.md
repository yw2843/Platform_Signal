# Realtime NYC Subway Positions

A working MapLibre map that shows live positions of MTA subway trains, decoded from the official GTFS-Realtime protobuf feeds directly in the browser.

## What you will build

A single-page site with:
- A basemap centered on Manhattan
- Colored dots for every active train, updated every 15 seconds
- Route colors matching official MTA line colors
- A click popup showing route, current or next station, and destination
- No server, no API key, no build step

Runs entirely client-side. Deploys to GitHub Pages as-is.

## Prerequisites

- A code editor
- Ability to run `python3 -m http.server 8000` locally
- A browser (Chrome, Firefox, Safari, Edge all work)

No API key. The MTA removed key requirements in 2021.

## Data sources

**MTA GTFS-Realtime feeds** (protobuf, one endpoint per line group):

| Endpoint | Lines |
|---|---|
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs` | 1, 2, 3, 4, 5, 6, 7, S |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace` | A, C, E |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm` | B, D, F, M |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz` | J, Z |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l` | L |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw` | N, Q, R, W |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g` | G |
| `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si` | Staten Island |

**Static schedule (stops.txt, routes.txt, stop_times.txt)**: https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip

The tutorial bundles a small `stops.json` with about 40 stations. Replace with the full stops.txt from the static feed for a production site.

## How positions work

GTFS-Realtime does not give latitude and longitude for subway trains. It gives:
- Which trip the train is running
- The stop_id of the next stop
- Arrival time at that stop

We compute a position by:
1. Reading the current stop_id from the `trip_update` message
2. Looking up its coordinates in `stops.json`
3. Optionally interpolating between the last-departed stop and the next stop using the time delta

For a first cut, we just place the train at its next stop. That is what this tutorial does. Interpolation is in the extensions section.

## Files

```
realtime-subway-positions/
├── README.md
├── index.html
├── assets/
│   ├── css/style.css
│   ├── js/
│   │   ├── mta.js               ← main logic
│   │   └── gtfs-realtime.proto.js ← protobuf schema as a JS string
│   └── data/
│       ├── stops.json           ← curated station coordinates
│       └── routes.json          ← route colors
```

## Walkthrough

### 1. Include protobufjs and MapLibre

Both load from CDN. No npm.

```html
<script src="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/protobufjs@7.2.5/dist/protobuf.min.js"></script>
```

### 2. Load the GTFS-Realtime schema

`gtfs-realtime.proto.js` exports a string containing the .proto definition. protobufjs parses it at runtime:

```js
const root = protobuf.parse(GTFS_RT_PROTO, { keepCase: true }).root;
const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
```

### 3. Fetch and decode a feed

```js
async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return FeedMessage.decode(buf);
}
```

The response is binary protobuf. `arrayBuffer()` gives us raw bytes; protobufjs decodes them into a JS object.

### 4. Extract active trains

Each `entity` in the feed is either a `trip_update` or a `vehicle`. We use `trip_update`:

```js
function extractTrains(feed) {
  const trains = [];
  for (const entity of feed.entity) {
    const tu = entity.trip_update;
    if (!tu || !tu.trip || !tu.stop_time_update) continue;
    const next = tu.stop_time_update[0];
    if (!next) continue;
    trains.push({
      routeId: tu.trip.route_id,
      tripId: tu.trip.trip_id,
      nextStopId: next.stop_id,
      arrivalTime: next.arrival?.time,
    });
  }
  return trains;
}
```

### 5. Convert stop IDs to coordinates

Subway stop IDs end in `N` or `S` for northbound/southbound. Strip the direction letter before looking up in `stops.json`:

```js
function stopCoords(stopId) {
  const base = stopId.replace(/[NS]$/, "");
  const stop = STOPS[base];
  return stop ? [stop.lon, stop.lat] : null;
}
```

### 6. Build a GeoJSON FeatureCollection

Each train is a point feature with route and destination in properties. Feed it to a MapLibre `geojson` source and update on each poll:

```js
function trainsToGeoJSON(trains) {
  return {
    type: "FeatureCollection",
    features: trains
      .map(t => {
        const coords = stopCoords(t.nextStopId);
        if (!coords) return null;
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: coords },
          properties: {
            route: t.routeId,
            color: ROUTES[t.routeId]?.color || "#666",
            nextStop: STOPS[t.nextStopId.replace(/[NS]$/, "")]?.name || t.nextStopId,
          },
        };
      })
      .filter(Boolean),
  };
}
```

### 7. Poll every 15 seconds

The MTA does not want you polling faster than that. Their feeds update every 15 to 30 seconds anyway.

```js
setInterval(refresh, 15000);
refresh();
```

## CORS

The MTA GTFS-RT endpoints currently return `Access-Control-Allow-Origin: *`, so browser fetch works. If that changes:

- Deploy a Cloudflare Worker or Netlify Function that proxies the request
- Point your client at your proxy URL instead

Do not use a public CORS proxy for production. They rate-limit and disappear without notice.

## Extensions

- **Interpolate between stops.** For each train, save the previous stop's departure time and the next stop's arrival time. Interpolate coordinates by `(now - prev_departure) / (next_arrival - prev_departure)` along the line geometry.
- **Show the whole route as a line layer** using the NYC OpenData subway lines GeoJSON: https://data.cityofnewyork.us/Transportation/Subway-Lines/3qz8-muuu
- **Highlight delays.** If `arrivalTime - now` exceeds the scheduled headway, color the train red.
- **Filter by line.** Add a checkbox row that toggles which route IDs to show.
- **Historical replay.** Log positions to a file every 15 seconds for an hour, then replay it in a scrubbing UI.

## Common pitfalls

- **Stop IDs.** MTA stop IDs are alphanumeric (`127`, `A27`, `L06`). The `N`/`S` suffix indicates direction. Strip it for coordinate lookup.
- **Empty feeds.** After service ends (roughly 2 AM to 5 AM overnight, less service), some feeds return nearly empty responses. This is not a bug.
- **Route colors.** Trains on the 4/5/6 all use green. Trains on the N/Q/R/W all use yellow. The `route_id` in the feed is a single letter or digit; look it up in `routes.json`.
- **Duplicate entities.** Some trains appear in both `trip_update` and `vehicle` entities. Deduplicate by `tripId` if you use both.
- **protobufjs bundle size.** The library is ~200KB gzipped. Fine for a tutorial, worth trimming for production.
