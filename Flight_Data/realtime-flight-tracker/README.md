# Realtime Flight Tracker: LaGuardia Arrivals and Departures

**Status: working local prototype.** The tracker uses one centralized Python backend to authenticate with OpenSky, poll state vectors every 30 seconds, retain one hour of observations, and serve a MapLibre Plan/3D web interface.

The airport relationship, flight phase, and frequency are inferred by transparent prototype rules. They are not an official airport manifest, flight plan, or record of live ATC handoffs.

## Confirmed implementation settings

- Free public map and terrain tile sources.
- One MapLibre map with a Plan/3D toggle and the same color style in both modes.
- OpenFreeMap building-height data and a public raster-DEM terrain source.
- `../DC8_AFRC_AIR_0824.glb` as the shared visualization model for aircraft.
- One-hour rolling trails, capped by observation age.
- One centralized authenticated OpenSky poll every 30 seconds.
- Probable flights: amber aircraft/halo and dashed trail.
- Confirmed flights: green aircraft/halo and solid trail.
- Flight details appear only after an aircraft or route is clicked.
- No signal-loss calculations in this version.
- The assumed LGA transmitter location is reserved for later signal-loss work.
- Data beyond the current 40 NM phase/frequency rules is labeled `Future Research`.

## Architecture

```text
OpenSky OAuth/API
       |
       | one request every 30 seconds
       v
Python backend (server.py)
  - keeps credentials out of the browser
  - buffers observations for one hour
  - classifies probable/confirmed LGA traffic
  - applies phase/frequency rules only within 40 NM
       |
       | local /api/flights, read every 5 seconds
       v
MapLibre + deck.gl browser UI
  - Plan/3D modes share one basemap style
  - aircraft, routes, terrain, and buildings
  - click-only details table
```

The browser never receives the OpenSky client secret. Multiple browser windows share the same backend response and do not multiply OpenSky API usage.

### Credential safety

Do not commit a replacement OpenSky secret to Git. This repository currently has `Flight_Data/credentials.json` in Git's tracked-file list, so adding it to `.gitignore` alone will not protect a newly saved secret. Before storing a new API client secret, remove the credential file from Git tracking in a deliberate security cleanup and rotate any credential that may have been shared.

## Run locally

Requirements:

- Python 3.10 or newer.
- Internet access for OpenSky, MapLibre/deck.gl libraries, OpenFreeMap tiles, and terrain tiles.
- `../credentials.json` containing the OpenSky `clientId` and `clientSecret`.
- A WebGL2-capable browser for the deck.gl aircraft and routes.

On Windows, double-click:

```text
start-tracker.bat
```

Or run:

```powershell
cd Flight_Data/realtime-flight-tracker
python server.py
```

Then open:

```text
http://127.0.0.1:8000
```

To inspect the UI without contacting OpenSky:

```powershell
python server.py --no-poll
```

Stop the server with `Ctrl+C`.

If the status shows `OpenSky rejected the API client ID or secret (HTTP 401)`, create or regenerate an API Client from the OpenSky account page and replace the local `clientId` and `clientSecret`. Website username/password credentials are not accepted by the current REST API OAuth flow.

## Data collection boundary and API credits

Primary endpoint:

```text
GET https://opensky-network.org/api/states/all
```

OpenSky calculates bounding-box area as:

```text
(lamax - lamin) * (lomax - lomin)
```

The published one-credit tier is at or below 25 square degrees. This tracker uses approximately 24.9 square degrees to stay below the ambiguous exact boundary:

```text
lamin=38.6061
lomin=-76.7397
lamax=42.9484
lomax=-71.0055
```

The collection box is approximately 260.5 NM north-south by 260.5 NM east-west around LGA. It is deliberately much larger than the LGA classification area.

At one credit per request and one request every 30 seconds:

```text
2 requests/minute * 60 * 24 = 2,880 state credits/day
```

A standard authenticated OpenSky account currently receives 4,000 state credits daily, leaving approximately 1,120 credits of operational margin. The backend records the `X-Rate-Limit-Remaining` header and respects rate-limit retry instructions.

Official documentation: https://openskynetwork.github.io/opensky-api/rest.html

## LGA classification boundary

The large collection box is not the LGA filter. LGA classification and frequency matching remain limited to:

```text
distance_to_lga_nm <= 40
```

LGA reference point:

```text
latitude=40.77724222
longitude=-73.87260555
```

The web map draws this 40 NM boundary. Unrelated aircraft remain hidden.

## Probable and confirmed logic

Each aircraft is grouped by `icao24`. Direction changes require three consecutive qualifying observations to reduce noisy switching.

### Probable LGA arrival

- Within 40 NM of LGA.
- At or below 10,000 ft.
- Descending at least 200 ft/min.
- Distance to LGA decreases by at least 0.05 NM per observation.
- All conditions persist for three observations.

### Confirmed LGA arrival

A probable arrival becomes confirmed after entering the final-approach zone while still descending:

- Within 8 NM of LGA.
- At or below 3,000 ft.

### Probable LGA departure

- Within 40 NM of LGA.
- At or below 15,000 ft.
- Climbing at least 200 ft/min.
- Distance to LGA increases by at least 0.05 NM per observation.
- All conditions persist for three observations.

### Confirmed LGA departure

A probable departure becomes confirmed when its observed trajectory includes the initial-departure zone:

- Within 5 NM of LGA.
- At or below 3,000 ft.
- Climbing and moving away.

An OpenSky on-ground observation within 1.5 NM, or the low-and-slow substitute from the rule file, is retained as additional LGA-origin evidence.

## Phase and representative frequency rules

The machine-readable configuration is `../Rule/FrequencyMatching/lga_frequency_rules.csv`; its explanation is `../Rule/FrequencyMatching/lga_frequency_rules.md`.

| Phase | Prototype conditions | Inferred representative frequency |
|---|---|---:|
| Ground/taxi | Within 1.5 NM; on ground or validated low-and-slow observation | 121.7 MHz |
| Final approach | Arrival within 8 NM, at or below 3,000 ft, descending | 118.7 MHz |
| Initial departure | Departure within 5 NM, at or below 3,000 ft, climbing | 118.7 MHz |
| Arrival approach | Arrival within 40 NM, at or below 10,000 ft, descending | 120.8 MHz |
| Departure climb | Departure within 40 NM, at or below 15,000 ft, climbing | 120.4 MHz |

Frequency is never used as evidence that a flight belongs to LGA. Classification happens first; the frequency rule is applied afterward.

## Beyond 40 NM: Future Research

The backend may buffer observations outside 40 NM because they fall inside the larger OpenSky collection box. New aircraft outside 40 NM are not classified as LGA traffic.

If an aircraft later qualifies as probable or confirmed, its earlier buffered route can be displayed. Likewise, a confirmed departure can remain visible after crossing 40 NM until its one-hour trail expires. Outside-scope observations use:

```text
phase_scope = outside_current_rule
phase = outside_current_rule
inferred_frequency_mhz = null
frequency_status = Future Research
```

No frequency beyond 40 NM is inferred in this version.

## Plan and 3D display

Plan and 3D are camera modes of the same MapLibre instance. They share the same OpenFreeMap style, labels, colors, selected flight, and map position.

| Feature | Plan | 3D |
|---|---|---|
| Camera pitch | 0 degrees | 60 degrees |
| Basemap colors | Shared | Shared |
| Terrain | Hidden | Public raster-DEM terrain |
| Buildings | Hidden | OpenStreetMap height extrusions at close zoom |
| Aircraft/trails | Altitude-aware, top-down | Altitude-aware perspective |

The supplied DC-8 model is reused as a generic aircraft visualization; it does not assert the actual aircraft type. A status-colored halo remains visible because textured glTF models cannot always be reliably recolored.

Free sources:

- OpenFreeMap vector map/buildings: https://openfreemap.org/
- MapLibre terrain example/source pattern: https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/
- MapLibre 3D buildings pattern: https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/

These public services do not provide a production availability guarantee.

## Click-only flight details

No permanent flight table covers the map. Clicking an aircraft or its trail opens a details panel containing:

- ICAO24 and callsign.
- Probable/confirmed status.
- Inferred arrival/departure direction.
- Inferred phase.
- Distance to LGA.
- Altitude, ground speed, vertical rate, and true track.
- Inferred service and representative frequency.
- Last position time and route observation count.

Signal-quality fields are intentionally absent until the separate signal-loss design is approved.

## State-vector conversions

OpenSky state vectors use SI units. The backend exposes user-facing aviation units:

```text
altitude_ft = altitude_m * 3.28084
speed_kt = velocity_m_s * 1.943844
vertical_fpm = vertical_rate_m_s * 196.8504
```

When OpenSky omits vertical rate, it is derived from consecutive altitude and timestamp observations.

## Operational limitations

- The tracker infers LGA relationship from movement; it does not have scheduled origin/destination data.
- A probable or confirmed label is not an official operational classification.
- The selected frequencies are representative prototype frequencies, not live ATC assignments.
- Coverage depends on OpenSky receivers and may be incomplete at low altitude.
- OpenSky can return null coordinates, altitude, track, or vertical rate.
- The backend backs off on HTTP 429 and repeated API errors.
- The 14.5 MB aircraft model is loaded once and cached by the browser.
- Public map and terrain sources can be unavailable independently of OpenSky.

## Tests

The local tests do not contact OpenSky:

```powershell
python -m unittest -v test_backend.py
```

They cover the collection-box credit boundary, arrival confirmation, departure confirmation, and the `Future Research` behavior beyond 40 NM.
