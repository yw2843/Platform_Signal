# Realtime Flight Tracker: LaGuardia Arrivals and Departures

**Status: integrated local/LAN prototype.** The tracker uses one centralized Python backend to authenticate with OpenSky, poll state vectors every 30 seconds, retain one hour of observations, and serve the original Platform Signal interface with Plan, 3D, and Section modes.

The airport relationship, flight phase, and frequency are inferred by transparent prototype rules. They are not an official airport manifest, flight plan, or record of live ATC handoffs.

## Confirmed implementation settings

- Free public map and terrain tile sources.
- Plan and 3D maps use the original CARTO Light Plan View tiles and colors.
- OpenFreeMap building-height data and a public raster-DEM terrain source.
- `../DC8_AFRC_AIR_0824.glb` as the shared visualization model for aircraft.
- One-hour rolling trails, capped by observation age.
- One centralized authenticated OpenSky poll every 30 seconds.
- Probable flights: amber aircraft/halo and dashed trail.
- Confirmed flights: green aircraft/halo and solid trail.
- Flight details appear only after an aircraft or route is clicked.
- Version 1 fields remain available unchanged; Version 2 adds separate one-second phase/frequency/signal-loss records.
- Version 2 uses a documented synthetic LGA reference site and calculation-only OpenFreeMap building geometry.
- Signal values are available to the browser and API, but visual signal graphics remain deferred.
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
  - predicts 30 one-second V2 positions and reconciles them after the next observation
  - calculates FSPL plus dominant-building diffraction for one V2 frequency per phase
       |
       | local /api/flights, read every 5 seconds
       v
Original Platform Signal browser UI
  - Plan/3D modes share the original CARTO Light basemap style
  - Section mode preserves subway signal routes and adds selected-flight altitude profiles
  - L/6 trains, aircraft, routes, terrain, and buildings
  - click-only details table
  - advances cached V2 signal data every second without another HTTP or OpenSky request
```

The browser never receives the OpenSky client secret. Multiple browser windows share the same backend response and do not multiply OpenSky API usage.

### Credential safety

Do not commit a replacement OpenSky secret to Git. `Flight_Data/credentials.json` is ignored and is not served by the local web server. The server uses an explicit public-file allowlist, so LAN clients cannot request the credential file or other project internals.

## Run locally

Requirements:

- Python 3.10 or newer.
- Internet access for OpenSky, MapLibre/deck.gl libraries, OpenFreeMap tiles, and terrain tiles.
- `../credentials.json` containing the OpenSky `clientId` and `clientSecret`.
- A WebGL2-capable browser for the deck.gl aircraft and routes.

From the repository root on Windows, double-click:

```text
start-website.bat
```

Or run:

```powershell
cd "D:\Cornell\Summer_Semester\Final Platform\Platform_Signal"
py -3 Flight_Data\realtime-flight-tracker\server.py --host 0.0.0.0 --port 8000 --open-browser
```

Then open:

```text
http://127.0.0.1:8000
```

To inspect the UI without contacting OpenSky:

```powershell
py -3 Flight_Data\realtime-flight-tracker\server.py --no-poll
```

Stop the server with `Ctrl+C`.

### Trusted private LAN access

Double-click `setup-lan-access.bat` once and approve the Windows Administrator prompt. It runs `setup-lan-access.ps1` to create an inbound Windows Firewall rule for TCP port 8000 that applies only to Private network profiles and the local subnet. Start the website with `start-website.bat`, then open the printed LAN URL from the second computer, for example:

```text
http://192.168.1.45:8000
```

Only the hosting laptop needs Python and OpenSky credentials. Keep that laptop awake, online, and running the server. Double-click `remove-lan-access.bat` and approve the Administrator prompt to remove the rule later.

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

Plan and 3D use independent MapLibre instances so the original subway and signal behavior remains intact. Both use the exact same original CARTO Light raster tiles and colors, and the selected flights/filters are synchronized.

| Feature | Plan | 3D |
|---|---|---|
| Camera pitch | 0 degrees | 60 degrees |
| Basemap colors | Original CARTO Light | Original CARTO Light |
| Terrain | Hidden | Public raster-DEM terrain |
| Buildings | Hidden | OpenStreetMap height extrusions at close zoom |
| Aircraft/trails | Altitude-aware, top-down | Altitude-aware perspective |

The supplied DC-8 model is reused as a generic aircraft visualization; it does not assert the actual aircraft type. A status-colored halo remains visible because textured glTF models cannot always be reliably recolored.

Free/public sources:

- CARTO Light raster basemap: https://carto.com/basemaps/
- OpenFreeMap building-height data: https://openfreemap.org/
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

Signal-quality graphics and visible detail rows remain intentionally absent until the later visualization step. The browser already receives the separate `signal_v2` timeline and emits `platform:flight-signal-v2-tick` once per second.

## Version 2 signal APIs

- `/api/flights` includes a separate `signal_v2` object for each eligible flight. The website continues reading this local endpoint every five seconds.
- `/api/signal-v2?icao24=abc123` returns finalized observed and reconciled one-second history for that flight.
- `/api/signal-v2?icao24=abc123&since=UNIX_SECONDS` returns only finalized points newer than `since`.

The five-second local reads never trigger OpenSky. Only the centralized 30-second polling service requests OpenSky. Predicted values are provisional until the actual B observation replaces the A-to-B interval with interpolation.

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
