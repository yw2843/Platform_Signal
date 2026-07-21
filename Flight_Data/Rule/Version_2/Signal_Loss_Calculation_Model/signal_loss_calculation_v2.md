# Version 2 One-Second Prototype Signal-Loss Calculation

## Status and purpose

This Version 2 rule calculates modeled path-loss changes once per second along an LGA flight track. It does not calculate measured received power in dBm.

Version 1 rules, workbook, source flight data, and existing visual presentation remain preserved. Version 2 is integrated as separate derived API data and a browser-side clock. Version 2 building calculations are computational only: they must not change building colors, opacity, filters, layers, feature state, outlines, labels, or any other 2D/3D map styling.

## Processing overview

```text
actual OpenSky observation A
        |
        v
predict one-second positions for the next 30 seconds
        |
        v
calculate provisional phase, one frequency, and signal loss
        |
        v
actual OpenSky observation B arrives
        |
        v
replace only provisional V2 samples with A-to-B interpolation
        |
        v
recalculate and finalize the one-second derived interval
```

The original A and B observations are never overwritten.

## Website integration and request timing

- The server requests OpenSky once every 30 seconds.
- The website requests the local `/api/flights` endpoint every 5 seconds. These local reads use cached server state and do not request OpenSky or consume additional OpenSky credits.
- Each `/api/flights` flight may include a separate `signal_v2` object with the current derived point and the 30 predicted one-second points.
- The browser advances `signal_v2.live_current` once per second and dispatches `platform:flight-signal-v2-tick`. This clock does not make a network request and does not alter any building style.
- Finalized A-to-B history is available from `/api/signal-v2?icao24=ICAO24&since=UNIX_SECONDS`. `since` is optional and the endpoint returns only points newer than it, allowing later visualizations to append reconciled history without repeatedly downloading the entire flight.
- Predicted points are provisional. Only observed and A-to-B interpolated points appear in the reconciled history endpoint.

## Time model

### Live prediction between updates

Use recent actual observations to estimate smoothed horizontal velocity, track, turn rate, and vertical rate. Predict one position per second with a constant-turn-rate-and-velocity horizontal model and constant vertical rate.

Each predicted sample contains:

```text
position_status = predicted
prediction_horizon_seconds = 1..30
source_observation_time
```

Prediction requirements:

- Use only actual observations to update the motion filter.
- Predicted samples do not count as independent evidence for phase confirmation.
- Limit normal prediction to the 30-second OpenSky polling interval.
- Stop predicting when the source flight is stale or required motion data is invalid.
- Preserve longitude wrapping and use a local metric coordinate frame or equivalent geodesic calculation rather than linear degrees.

### Reconciliation after the next update

When actual observation B arrives, replace only the provisional V2 samples between A and B. Reconstruct the interval at one-second spacing with endpoint-constrained cubic Hermite interpolation in a local metric frame:

- A and B positions are exact endpoints.
- Endpoint ground-speed and heading define horizontal tangents when available.
- Endpoint vertical rates define altitude tangents when available.
- Fall back to geodesic horizontal interpolation and linear altitude interpolation when tangent data is missing or invalid.
- Do not create duplicate timestamps.

Finalized samples contain:

```text
position_status = interpolated_between_observations
prediction_horizon_seconds = 0
was_live_prediction = true
```

## One frequency per stable phase

For every one-second sample, use only the `most_likely_frequency_mhz` selected by the Version 2 frequency rule. Do not calculate secondary candidate-frequency loss series.

The selected frequency remains stable through a phase segment unless the stateful phase rules accept a transition. If phase or frequency is unknown, signal loss is null rather than forced.

## Prototype signal origin

All Version 2 frequencies use one synthetic reference origin:

```text
site_id = LGA_REFERENCE_V2
latitude = 40.77724222
longitude = -73.87260555
antenna_height_agl_m = 50
```

This is a geometric prototype anchor, not a physical transmitter location.

## Aircraft altitude

Use OpenSky geometric altitude when available because the calculation needs physical path geometry. Otherwise use barometric altitude and set:

```text
altitude_status = barometric_fallback
```

Terrain does not add propagation loss. Terrain elevation may be used only to express the synthetic antenna, building tops, and aircraft altitude in a consistent vertical datum. If terrain elevation is unavailable, use the LGA elevation as the flat prototype reference and flag the fallback.

## Base free-space loss

Calculate three-dimensional slant distance from the synthetic origin to the aircraft:

```text
slant_distance_km = sqrt(horizontal_distance_km^2 + vertical_difference_km^2)
```

Then calculate:

```text
fspl_db = 32.45
        + 20 * log10(max(slant_distance_km, 0.001))
        + 20 * log10(frequency_mhz)
```

## Building data and strict UI isolation

Use the same OpenFreeMap/OpenMapTiles `building` vector-tile source that supplies the current 3D building geometry. Decode the data for calculation without mutating the MapLibre maps.

The calculator must not:

- add a building highlight or obstruction layer;
- call `setFeatureState` for buildings;
- modify any building layer filter or paint property;
- color buildings according to known, missing, estimated, blocking, or non-blocking height;
- add building flags, badges, outlines, labels, popups, or legends;
- expose missing-height status as visual styling.

All buildings in both maps keep the existing shared style. Height quality and blockage status exist only in Version 2 calculation records.

### Building height

- Use `render_height` in metres when it is finite and positive.
- Use `render_min_height` when it is finite; otherwise use zero.
- When `render_height` is absent or invalid, use a calculation-only height of 10 m.
- Mark the derived record `building_height_status = estimated_default_10m`.
- Do not change how the building is rendered because of the fallback.

### Spatial query

Cache only tiles needed by active signal rays. Store decoded building footprints and heights in a spatial index so a one-second calculation tests only buildings intersecting the transmitter-to-aircraft corridor.

Tile and feature identifiers are calculation metadata only. The result must not depend on which buildings happen to be visible in the current map viewport.

## Building obstruction and diffraction

Construct a three-dimensional ray from the synthetic LGA reference antenna to the aircraft. For each intersecting building:

1. Find the point or interval where the horizontal ray crosses the building footprint.
2. Calculate the direct-ray altitude at that location.
3. Calculate the building-top altitude from ground reference plus `render_height` or the 10 m fallback.
4. Calculate clearance relative to the direct ray and first Fresnel zone.
5. Retain the obstruction with the greatest diffraction parameter as the dominant building.

For the dominant obstruction:

```text
lambda_m = 299792458 / (frequency_mhz * 1000000)

v = obstruction_height_above_direct_ray_m
    * sqrt(2 * (d1_m + d2_m) / (lambda_m * d1_m * d2_m))
```

where `d1_m` is distance from the synthetic origin to the obstruction and `d2_m` is distance from the obstruction to the aircraft.

Use the standard single knife-edge approximation:

```text
if v <= -0.7:
    building_loss_db = 0
else:
    building_loss_db = 6.9
        + 20 * log10(sqrt((v - 0.1)^2 + 1) + v - 0.1)
```

Only the dominant obstruction contributes diffraction loss in this prototype. Other intersecting buildings are counted for reporting but are not added as repeated penalties.

## Total modeled loss

```text
total_loss_db = fspl_db + building_loss_db
```

No transmitter power, antenna gain, receiver sensitivity, weather, interference, or other engineering term is included.

## Route-relative signal change

For each continuous phase segment, the lowest modeled loss is the phase reference:

```text
relative_signal_phase_db = phase_minimum_total_loss_db - total_loss_db
relative_power_phase_ratio = 10^(relative_signal_phase_db / 10)
relative_power_phase_percent = 100 * relative_power_phase_ratio
```

For an optional whole-flight comparison:

```text
relative_signal_flight_db = flight_minimum_total_loss_db - total_loss_db
relative_power_flight_percent = 100 * 10^(relative_signal_flight_db / 10)
```

These are physical power ratios relative to the selected reference point, not quality, reliability, or measured strength.

## Required Version 2 output fields

```text
icao24
timestamp
position_status
source_observation_time
prediction_horizon_seconds
was_live_prediction
aircraft_lat
aircraft_lon
aircraft_altitude_m
altitude_status
inferred_phase
phase_confidence
phase_segment_id
most_likely_frequency_mhz
frequency_confidence
site_id
slant_distance_km
fspl_db
building_data_status
building_blocked
blocking_building_count
dominant_building_id
dominant_building_height_m
building_height_status
worst_clearance_m
fresnel_radius_m
diffraction_v
building_loss_db
total_loss_db
relative_signal_phase_db
relative_power_phase_percent
relative_signal_flight_db
relative_power_flight_percent
calculation_method = fspl_plus_dominant_building_diffraction_v2
```

## Validation requirements

- Actual OpenSky endpoints are unchanged.
- Reconciled intervals pass exactly through A and B.
- One-second timestamps contain no gaps or duplicates within a continuous interval.
- No prediction continues beyond the stale-flight limit.
- Predicted samples do not independently confirm a phase transition.
- A stable phase produces only one selected frequency and one loss series.
- A clear path produces zero building diffraction loss.
- A blocked test path produces deterministic positive loss.
- Missing building heights use 10 m only in calculation metadata.
- Version 1 rule/workbook values are not overwritten, and existing UI/building visual styles remain unchanged.
