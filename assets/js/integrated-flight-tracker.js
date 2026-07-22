/* global deck, maplibregl, THREE */

(function () {
  "use strict";

  var LGA = { longitude: -73.87260555, latitude: 40.77724222 };
  var COLORS = {
    probable: [245, 166, 35, 235],
    confirmed: [46, 212, 122, 240],
    selected: [255, 255, 255, 255]
  };

  var ui = {
    connection: document.getElementById("connection"),
    statusDot: document.getElementById("status-dot"),
    statusLabel: document.getElementById("status-label"),
    confirmedCount: document.getElementById("confirmed-count"),
    probableCount: document.getElementById("probable-count"),
    lastUpdate: document.getElementById("last-update"),
    subwayCount: document.getElementById("subway-count"),
    subwayLines: document.getElementById("subway-lines"),
    subwayUpdate: document.getElementById("subway-update"),
    flightPicker: document.getElementById("row-planes"),
    statusFilter: document.getElementById("flight-status-filter"),
    directionFilter: document.getElementById("flight-direction-filter"),
    detailsPanel: document.getElementById("details-panel"),
    detailsClose: document.getElementById("details-close"),
    detailsStatus: document.getElementById("details-status"),
    detailsCallsign: document.getElementById("details-callsign"),
    detailsRoute: document.getElementById("details-route"),
    detailsBody: document.getElementById("details-body"),
    detailsNote: document.getElementById("details-note"),
    signalRouteLegend: document.getElementById("flight-signal-route-legend"),
    loadingCard: document.getElementById("loading-card"),
    mapMessage: document.getElementById("map-message")
  };

  var state = {
    flights: [],
    selectedIcao24: null,
    statusFilter: "all",
    directionFilter: "all",
    planOverlay: null,
    threeDOverlay: null,
    planSignalLayer: null,
    threeDSignalLayer: null,
    subwayRoutes3D: null,
    selectedTrainRouteId: null,
    selectedSignalHistory: [],
    selectedSignalProvisional: [],
    selectedSignalSince: null,
    selectedSignalWindowEnd: null,
    selectedSignalReferenceLossDb: null,
    selectedSignalLoadingIcao24: null,
    selectedSignalSelectionVersion: 0,
    selectedSignalFocusedVersions: { plan: null, "3d": null },
    selectedSignalNoDataMessageVersion: null,
    messageTimer: null
  };

  var SIGNAL_ROUTE_WINDOW_SECONDS = 15 * 60;
  var SIGNAL_VISUAL_FLOOR_DB = -20;
  var SIGNAL_RING_MIN_RADIUS_PX = 5;
  var SIGNAL_RING_MAX_RADIUS_PX = 34;
  var SIGNAL_RING_MIN_RADIUS_M = 20;
  var SIGNAL_RING_MAX_RADIUS_M = 350;
  var SIGNAL_RING_SEGMENTS = 20;
  var SIGNAL_ROUTE_COLOR = 0xff8424;

  var SUBWAY_OUTLINE_COLOR = [242, 242, 242, 235];   // #f2f2f2 -- matches SubwayOutlineColor in index.html
  var SUBWAY_LINE_WIDTH = 6;
  var SUBWAY_LINE_WIDTH_SELECTED = 3;                 // thinner while a train on this route is selected
  var SUBWAY_OUTLINE_WIDTH = 9;
  var SUBWAY_OUTLINE_WIDTH_SELECTED = 16;             // thicker while a train on this route is selected

  function hexToRgba(hex, alpha) {
    var value = parseInt(String(hex).replace("#", ""), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
  }

  // The 3D map has terrain enabled, so an ordinary MapLibre line layer for the
  // subway route gets depth-tested against extruded buildings and disappears
  // behind them. Rendering it as a deck.gl layer with depthTest off paints it
  // regardless of what's already in the depth buffer, keeping it visible
  // through buildings. Data comes from index.html's broadcast (see
  // "platform:three-d-subway-routes-updated" below) rather than a fetch here,
  // since index.html already owns loading/reprojecting the route shapes.
  function makeThreeDSubwayLayer() {
    if (!state.subwayRoutes3D || !state.subwayRoutes3D.features.length) return [];
    var selectedRouteId = state.selectedTrainRouteId;
    function isSelected(feature) { return feature.properties.routeId === selectedRouteId; }
    return [
      // Thin light-grey casing underneath every route line; thickens when a train on
      // that route is selected (mirrors setRouteHighlighted() for Plan View in index.html).
      new deck.GeoJsonLayer({
        id: "three-d-subway-lines-casing",
        data: state.subwayRoutes3D,
        getLineColor: SUBWAY_OUTLINE_COLOR,
        getLineWidth: function (feature) { return isSelected(feature) ? SUBWAY_OUTLINE_WIDTH_SELECTED : SUBWAY_OUTLINE_WIDTH; },
        lineWidthUnits: "pixels",
        lineJointRounded: true,
        lineCapRounded: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { getLineWidth: selectedRouteId }
      }),
      new deck.GeoJsonLayer({
        id: "three-d-subway-lines",
        data: state.subwayRoutes3D,
        getLineColor: function (feature) { return hexToRgba(feature.properties.color, 235); },
        getLineWidth: function (feature) { return isSelected(feature) ? SUBWAY_LINE_WIDTH_SELECTED : SUBWAY_LINE_WIDTH; },
        lineWidthUnits: "pixels",
        lineJointRounded: true,
        lineCapRounded: true,
        pickable: false,
        parameters: { depthTest: false },
        updateTriggers: { getLineWidth: selectedRouteId }
      })
    ];
  }

  function filteredFlights() {
    return state.flights.filter(function (flight) {
      if (!flight.active) return false;
      var statusMatches = state.statusFilter === "all" || flight.status === state.statusFilter;
      var directionMatches = state.directionFilter === "all" || flight.direction === state.directionFilter;
      return statusMatches && directionMatches;
    });
  }

  function attachOverlay(map, mode) {
    var property = mode === "plan" ? "planOverlay" : "threeDOverlay";
    if (!map || state[property]) return;
    addBoundaryLayers(map, mode);
    ensureSelectedSignalLayer(map, mode);
    var overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
      getTooltip: function (info) { return info.object ? tooltipText(info.object) : null; }
    });
    map.addControl(overlay);
    state[property] = overlay;
    updateFlightLayers();
    if (mode === "plan") {
      // Flight trails/planes and the boundary ring just landed on top of the
      // Plan map's layer stack (deck.gl's interleaved overlay has no beforeId,
      // so it renders above everything by default). Subway lines must stay
      // visually in front of that regardless of load order, so push them back
      // to the top now. (The 3D map doesn't need this -- its subway line is a
      // depth-test-disabled deck.gl layer, see makeThreeDSubwayLayer below.)
      if (window.PlanView && typeof window.PlanView.bringSubwayToFront === "function") {
        window.PlanView.bringSubwayToFront();
      }
    }
  }

  function addBoundaryLayers(map, mode) {
    var prefix = mode === "plan" ? "plan-flight-" : "three-d-flight-";
    if (!map.getSource(prefix + "boundary")) {
      map.addSource(prefix + "boundary", {
        type: "geojson",
        data: circleFeature(LGA.longitude, LGA.latitude, 40, 160)
      });
      map.addLayer({
        id: prefix + "boundary-fill",
        type: "fill",
        source: prefix + "boundary",
        paint: { "fill-color": "#6dc8ff", "fill-opacity": 0.035 }
      });
      map.addLayer({
        id: prefix + "boundary-line",
        type: "line",
        source: prefix + "boundary",
        paint: {
          "line-color": "#42a9e6",
          "line-width": 1.4,
          "line-opacity": 0.8,
          "line-dasharray": [3, 2]
        }
      });
    }
    if (!map.getSource(prefix + "airport")) {
      map.addSource(prefix + "airport", {
        type: "geojson",
        data: {
          type: "Feature",
          geometry: { type: "Point", coordinates: [LGA.longitude, LGA.latitude] },
          properties: {}
        }
      });
      map.addLayer({
        id: prefix + "airport-marker",
        type: "circle",
        source: prefix + "airport",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#0b1928",
          "circle-stroke-width": 2
        }
      });
    }
  }

  function makeFlightLayers(mode) {
    var flights = filteredFlights();
    var activeFlights = flights.filter(function (flight) { return flight.active; });
    var probable = flights.filter(function (flight) {
      return flight.status === "probable" && flight.track && flight.track.length > 1;
    });
    var confirmed = flights.filter(function (flight) {
      return flight.status === "confirmed" && flight.track && flight.track.length > 1;
    });
    var is3D = mode === "3d";
    var prefix = is3D ? "three-d-" : "plan-";
    var onPick = function (info) {
      if (info && info.object) selectFlight(info.object.icao24);
    };

    function flightPath(flight) {
      return flight.track.map(function (point) {
        return [point.longitude, point.latitude, is3D ? Number(point.altitude_m || 0) : 0];
      });
    }
    function flightPosition(flight) {
      var current = flight.current;
      if (flight.icao24 === state.selectedIcao24 && flight.signal_v2 && flight.signal_v2.live_current) {
        var live = flight.signal_v2.live_current;
        if (finiteNumber(live.aircraft_lon) != null && finiteNumber(live.aircraft_lat) != null) {
          return [Number(live.aircraft_lon), Number(live.aircraft_lat),
            is3D ? Math.max(0, Number(live.aircraft_altitude_m) || 0) : 0];
        }
      }
      return [current.longitude, current.latitude, is3D ? Number(current.altitude_m || 0) : 0];
    }
    function flightHeading(flight) {
      var current = flight.current;
      if (flight.icao24 === state.selectedIcao24 && flight.signal_v2 && flight.signal_v2.live_current &&
          finiteNumber(flight.signal_v2.live_current.heading_deg) != null) {
        return Number(flight.signal_v2.live_current.heading_deg);
      }
      return Number(current.heading_deg || 0);
    }

    var layers = [
      new deck.PathLayer({
        id: prefix + "confirmed-flight-trails",
        data: confirmed,
        getPath: flightPath,
        getColor: function (flight) {
          return flight.icao24 === state.selectedIcao24 ? COLORS.selected : COLORS.confirmed;
        },
        getWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 5 : 3; },
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        onClick: onPick,
        updateTriggers: { getColor: state.selectedIcao24, getWidth: state.selectedIcao24 }
      }),
      new deck.PathLayer({
        id: prefix + "probable-flight-trails",
        data: probable,
        getPath: flightPath,
        getColor: function (flight) {
          return flight.icao24 === state.selectedIcao24 ? COLORS.selected : COLORS.probable;
        },
        getWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 5 : 3; },
        getDashArray: [3, 2],
        dashJustified: true,
        dashGapPickable: true,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        extensions: [new deck.PathStyleExtension({ dash: true })],
        onClick: onPick,
        updateTriggers: { getColor: state.selectedIcao24, getWidth: state.selectedIcao24 }
      })
    ];
    layers.push(
      new deck.ScatterplotLayer({
        id: prefix + "flight-status-halos",
        data: activeFlights,
        getPosition: flightPosition,
        getRadius: 8,
        radiusUnits: "pixels",
        getFillColor: function (flight) { return statusColor(flight, 115); },
        getLineColor: function (flight) {
          return flight.icao24 === state.selectedIcao24 ? COLORS.selected : statusColor(flight, 255);
        },
        lineWidthUnits: "pixels",
        getLineWidth: function (flight) { return flight.icao24 === state.selectedIcao24 ? 3 : 1.5; },
        stroked: true,
        pickable: true,
        onClick: onPick,
        updateTriggers: { getLineColor: state.selectedIcao24, getLineWidth: state.selectedIcao24 }
      }),
      new deck.ScenegraphLayer({
        id: prefix + "dc8-aircraft-models",
        data: activeFlights,
        scenegraph: "/assets/plane.glb",
        getPosition: flightPosition,
        getOrientation: function (flight) { return [0, flightHeading(flight), 90]; },
        getScale: [1, 1, 1],
        sizeScale: 1,
        sizeMinPixels: 10,
        sizeMaxPixels: is3D ? 58 : 32,
        _lighting: "pbr",
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 100],
        onClick: onPick
      })
    );
    return layers;
  }

  function updateFlightLayers() {
    if (state.planOverlay) state.planOverlay.setProps({ layers: makeFlightLayers("plan") });
    if (state.threeDOverlay) {
      // Subway layer goes last so it also paints on top of flight trails/planes.
      state.threeDOverlay.setProps({ layers: makeFlightLayers("3d").concat(makeThreeDSubwayLayer()) });
      // The subway layers above register as native layers and can land above the live
      // train dots' native circle layer -- reassert that trains render on top of them.
      if (window.ThreeDView && typeof window.ThreeDView.bringLiveTrainsToFront === "function") {
        window.ThreeDView.bringLiveTrainsToFront();
      }
    }
    updateSelectedSignalGeometry();
  }

  function statusColor(flight, alpha) {
    var color = flight.status === "confirmed" ? COLORS.confirmed : COLORS.probable;
    return [color[0], color[1], color[2], alpha];
  }

  function tooltipText(flight) {
    var call = flight.callsign || flight.icao24.toUpperCase();
    return call + " - " + capitalize(flight.status) + " " + flight.direction + " - " +
      formatNumber(flight.current.distance_nm, 1, " NM");
  }

  async function refreshFlights() {
    try {
      var response = await fetch("/api/flights", { cache: "no-store" });
      if (!response.ok) throw new Error("Tracker API returned HTTP " + response.status);
      var payload = await response.json();
      state.flights = payload.flights || [];
      advanceSignalClock();
      renderStatus(payload);
      renderFlightButtons();
      updateFlightLayers();
      refreshSelectedFlight();
    } catch (error) {
      setConnection("error", "Local API error");
      showMessage(error.message || String(error));
    }
  }

  function selectSignalPoint(flight, nowSeconds) {
    var signal = flight.signal_v2;
    if (!signal) return null;
    var selected = signal.current || null;
    (signal.predicted_timeline || []).some(function (point) {
      if (Number(point.timestamp) > nowSeconds) return true;
      selected = point;
      return false;
    });
    return selected;
  }

  function advanceSignalClock() {
    var nowSeconds = Date.now() / 1000;
    var ticks = [];
    state.flights.forEach(function (flight) {
      if (!flight.signal_v2) return;
      flight.signal_v2.live_current = selectSignalPoint(flight, nowSeconds);
      if (flight.signal_v2.live_current) {
        ticks.push({
          icao24: flight.icao24,
          signal: flight.signal_v2.live_current
        });
      }
    });
    window.dispatchEvent(new CustomEvent("platform:flight-signal-v2-tick", {
      detail: { generatedAt: nowSeconds, flights: ticks }
    }));
    if (state.selectedIcao24) {
      var selectedFlight = state.flights.find(function (flight) {
        return flight.icao24 === state.selectedIcao24;
      });
      if (selectedFlight) {
        syncSelectedSignalRoute(selectedFlight, false);
        updateFlightLayers();
      }
    }
    if (state.selectedIcao24 && ui.detailsPanel.classList.contains("open")) {
      var selected = state.flights.find(function (flight) {
        return flight.icao24 === state.selectedIcao24;
      });
      if (selected) renderDetails(selected);
    }
  }

  function renderStatus(payload) {
    var service = payload.service || {};
    var activeFlights = state.flights.filter(function (flight) { return flight.active; });
    var label = service.state === "online" ? "Live" : capitalize(service.state || "starting");
    setConnection(service.state, label);
    ui.confirmedCount.textContent = activeFlights.filter(function (flight) {
      return flight.status === "confirmed";
    }).length;
    ui.probableCount.textContent = activeFlights.filter(function (flight) {
      return flight.status === "probable";
    }).length;
    ui.lastUpdate.textContent = payload.source_time ? formatClock(payload.source_time * 1000) : "--";
    ui.loadingCard.classList.toggle("hidden", Boolean(payload.source_time));
    ui.connection.title = [
      service.message,
      service.remaining_credits != null ? service.remaining_credits + " state credits remaining" : ""
    ].filter(Boolean).join(" - ");
  }

  function setConnection(status, label) {
    ui.statusDot.className = "status-dot";
    if (status === "online") ui.statusDot.classList.add("online");
    if (status === "error") ui.statusDot.classList.add("error");
    ui.statusLabel.textContent = label;
  }

  function renderFlightButtons() {
    var flights = filteredFlights();
    ui.flightPicker.replaceChildren();
    if (!flights.length) {
      var empty = document.createElement("span");
      empty.className = "filter-placeholder";
      empty.textContent = state.flights.length ? "No live flights match these filters" : "Waiting for classified flights...";
      ui.flightPicker.appendChild(empty);
      return;
    }
    flights.forEach(function (flight) {
      var signalAvailability = currentSignalAvailability(flight);
      var button = document.createElement("button");
      button.type = "button";
      button.className = "route-btn pill flight-" + flight.status;
      if (!signalAvailability.drawable) button.classList.add("flight-signal-unavailable");
      if (flight.icao24 === state.selectedIcao24) button.classList.add("active-flight");
      button.textContent = flight.callsign || flight.icao24.toUpperCase();
      button.title = capitalize(flight.status) + " " + flight.direction + " - " +
        formatNumber(flight.current.distance_nm, 1, " NM from LGA") + " - " +
        signalAvailability.reason;
      if (!signalAvailability.drawable) {
        var signalBadge = document.createElement("span");
        signalBadge.className = "flight-signal-state";
        signalBadge.textContent = "No current modeled signal";
        button.appendChild(signalBadge);
      }
      button.addEventListener("click", function () { selectFlight(flight.icao24); });
      ui.flightPicker.appendChild(button);
    });
  }

  function selectFlight(icao24) {
    var isNewSelection = state.selectedIcao24 !== icao24;
    if (isNewSelection) resetSelectedSignalRoute();
    state.selectedIcao24 = icao24;
    var flight = state.flights.find(function (item) { return item.icao24 === icao24; });
    if (!flight) return;
    // Synchronous: index.html's listener runs and clears any selected train
    // (closing the panel) before the lines below reopen it for this flight.
    document.dispatchEvent(new CustomEvent("platform:flight-selected", { detail: { icao24: icao24 } }));
    renderDetails(flight);
    renderFlightButtons();
    ui.detailsPanel.classList.add("open");
    ui.detailsPanel.setAttribute("aria-hidden", "false");
    syncSelectedSignalRoute(flight, true);
    var signalAvailability = currentSignalAvailability(flight);
    var callsign = flight.callsign || flight.icao24.toUpperCase();
    if (isNewSelection) {
      showMessage(signalAvailability.drawable
        ? callsign + ": loading and framing the selected 15-minute signal route..."
        : callsign + ": current signal unavailable (" + signalAvailability.reason.toLowerCase() +
          "); checking the rolling 15-minute route.");
    } else {
      focusSelectedSignalRoute(activeViewMode(), true);
    }
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
    updateFlightLayers();
  }

  function closeDetails() {
    state.selectedIcao24 = null;
    resetSelectedSignalRoute();
    ui.detailsPanel.classList.remove("open");
    ui.detailsPanel.setAttribute("aria-hidden", "true");
    renderFlightButtons();
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(null);
    updateFlightLayers();
  }

  function refreshSelectedFlight() {
    if (!state.selectedIcao24) return;
    var flight = state.flights.find(function (item) { return item.icao24 === state.selectedIcao24; });
    if (!flight) {
      closeDetails();
      return;
    }
    if (!flight.active) {
      var callsign = flight.callsign || flight.icao24.toUpperCase();
      closeDetails();
      showMessage(callsign + " is no longer live, so its signal route has been cleared.");
      return;
    }
    renderDetails(flight);
    syncSelectedSignalRoute(flight, true);
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
  }

  function renderDetails(flight) {
    var signal = flight.signal_v2
      ? (flight.signal_v2.live_current || flight.signal_v2.current)
      : null;
    ui.detailsStatus.textContent = "Version 2 modeled signal";
    ui.detailsStatus.style.color = "#8fc7ff";
    ui.detailsCallsign.textContent = flight.callsign || flight.icao24.toUpperCase();
    ui.detailsRoute.textContent = signal
      ? label(signal.position_status) + " V2 point - " + formatDateTime(signal.timestamp)
      : "Waiting for a Version 2 signal point";

    var rows = [];
    if (signal) {
      var buildingPath = "Unavailable - FSPL only";
      if (signal.building_data_status === "available" || signal.building_data_status === "partial") {
        buildingPath = signal.building_blocked
          ? "Blocked - " + (signal.blocking_building_count || 1) + " blocking"
          : "Clear";
        if (signal.building_data_status === "partial") buildingPath += " (partial data)";
      }
      rows.push(
        ["ICAO24", String(signal.icao24 || flight.icao24).toUpperCase()],
        ["Signal point", label(signal.position_status)],
        ["Phase", label(signal.inferred_phase)],
        ["Phase confidence", formatNumber(Number(signal.phase_confidence) * 100, 0, "%")],
        ["Service", signal.service ? label(signal.service) : "--"],
        ["Frequency", formatNumber(signal.most_likely_frequency_mhz, 1, " MHz")],
        ["Frequency assignment", label(signal.frequency_assignment_status)],
        ["Matched V2 rule", signal.matched_rule_id || "--"],
        ["Slant distance", formatNumber(signal.slant_distance_km, 2, " km")],
        ["Modeled total loss", formatNumber(signal.total_loss_db, 2, " dB")],
        ["Change vs phase strongest", formatSigned(signal.relative_signal_phase_db, 2, " dB")],
        ["Phase relative power", formatNumber(signal.relative_power_phase_percent, 1, "%")],
        ["Change vs flight strongest", formatSigned(signal.relative_signal_flight_db, 2, " dB")],
        ["Flight relative power", formatNumber(signal.relative_power_flight_percent, 1, "%")],
        ["Free-space loss", formatNumber(signal.fspl_db, 2, " dB")],
        ["Building loss", formatNumber(signal.building_loss_db, 2, " dB")],
        ["Building path", buildingPath],
        ["Building calculation", label(signal.building_calculation_status)],
        ["Signal time", formatDateTime(signal.timestamp)]
      );
    } else {
      rows.push(["V2 signal", "Waiting for an eligible phase and position"]);
    }
    ui.detailsBody.replaceChildren.apply(ui.detailsBody, rows.map(function (row) {
      return detailRow(row[0], row[1]);
    }));
    if (!signal || signal.frequency_assignment_status === "unavailable") {
      ui.detailsNote.textContent = "V2 has no valid phase/frequency assignment, so signal loss is not calculated.";
    } else if (signal.frequency_assignment_status === "outside_40_nm") {
      ui.detailsNote.textContent = "The V2 point is beyond 40 NM. No frequency or signal loss is assigned.";
    } else if (signal.frequency_assignment_status === "held_during_transition") {
      ui.detailsNote.textContent = "The frequency is temporarily held from the last stable V2 phase. It will clear after two consecutive unmatched actual observations.";
    } else {
      ui.detailsNote.textContent = "V2 values are modeled path loss, not measured dBm. Lower total loss is stronger; 0 dB relative change is the strongest modeled point in the selected phase or flight.";
    }
  }

  function finiteNumber(value) {
    if (value == null || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function mergeSignalPoints(existing, incoming) {
    var byTimestamp = {};
    existing.concat(incoming || []).forEach(function (point) {
      var timestamp = finiteNumber(point && point.timestamp);
      if (timestamp != null) byTimestamp[String(timestamp)] = point;
    });
    return Object.keys(byTimestamp).map(function (key) {
      return byTimestamp[key];
    }).sort(function (a, b) {
      return Number(a.timestamp) - Number(b.timestamp);
    });
  }

  function trimSelectedSignalRoute(windowEndSeconds) {
    var cutoff = windowEndSeconds - SIGNAL_ROUTE_WINDOW_SECONDS;
    state.selectedSignalHistory = state.selectedSignalHistory.filter(function (point) {
      return Number(point.timestamp) >= cutoff;
    });
    state.selectedSignalProvisional = state.selectedSignalProvisional.filter(function (point) {
      return Number(point.timestamp) >= cutoff;
    });
  }

  function resetSelectedSignalRoute() {
    state.selectedSignalHistory = [];
    state.selectedSignalProvisional = [];
    state.selectedSignalSince = null;
    state.selectedSignalWindowEnd = null;
    state.selectedSignalReferenceLossDb = null;
    state.selectedSignalLoadingIcao24 = null;
    state.selectedSignalSelectionVersion += 1;
    state.selectedSignalNoDataMessageVersion = null;
    setSignalLegendVisible(false);
  }

  function setSignalLegendVisible(visible) {
    if (!ui.signalRouteLegend) return;
    ui.signalRouteLegend.classList.toggle("visible", Boolean(visible));
    ui.signalRouteLegend.setAttribute("aria-hidden", String(!visible));
  }

  function updateSignalReference(points) {
    var references = (points || []).map(function (point) {
      var loss = finiteNumber(point && point.total_loss_db);
      var relative = finiteNumber(point && point.relative_signal_flight_db);
      return loss == null || relative == null ? null : loss + relative;
    }).filter(function (value) { return value != null; });
    if (references.length) state.selectedSignalReferenceLossDb = Math.min.apply(null, references);
  }

  function syncSelectedSignalRoute(flight, loadHistory) {
    if (!flight || flight.icao24 !== state.selectedIcao24 || !flight.signal_v2) return;
    var signal = flight.signal_v2;
    var provisional = [];
    if (signal.current) provisional.push(signal.current);
    provisional = provisional.concat(signal.predicted_timeline || []);
    var finalizedThrough = finiteNumber(signal.finalized_through);
    if (finalizedThrough != null) {
      state.selectedSignalWindowEnd = Math.max(
        state.selectedSignalWindowEnd == null ? finalizedThrough : state.selectedSignalWindowEnd,
        finalizedThrough
      );
      provisional = provisional.filter(function (point) {
        return Number(point.timestamp) > finalizedThrough;
      });
    }
    state.selectedSignalProvisional = mergeSignalPoints([], provisional);
    updateSignalReference([signal.current].concat(signal.predicted_timeline || []));
    trimSelectedSignalRoute(state.selectedSignalWindowEnd || Date.now() / 1000);
    setSignalLegendVisible(drawableSelectedSignalPoints().length >= 2);
    if (loadHistory) loadSelectedSignalHistory();
  }

  function loadSelectedSignalHistory() {
    if (!state.selectedIcao24) return;
    var icao24 = String(state.selectedIcao24).toLowerCase();
    if (state.selectedSignalLoadingIcao24 === icao24) return;
    var selectionVersion = state.selectedSignalSelectionVersion;
    var since = state.selectedSignalSince;
    if (since == null) {
      since = (state.selectedSignalWindowEnd || Date.now() / 1000) - SIGNAL_ROUTE_WINDOW_SECONDS - 2;
    }
    var url = "/api/signal-v2?icao24=" + encodeURIComponent(icao24) +
      "&since=" + encodeURIComponent(since);
    state.selectedSignalLoadingIcao24 = icao24;
    fetch(url, { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("Signal history returned HTTP " + response.status);
        return response.json();
      })
      .then(function (payload) {
        if (String(state.selectedIcao24 || "").toLowerCase() !== icao24 ||
            selectionVersion !== state.selectedSignalSelectionVersion) return;
        var incoming = payload.points || [];
        state.selectedSignalHistory = mergeSignalPoints(state.selectedSignalHistory, incoming);
        updateSignalReference(incoming);
        var finalizedThrough = finiteNumber(payload.finalized_through);
        if (finalizedThrough != null) {
          state.selectedSignalSince = finalizedThrough;
          state.selectedSignalWindowEnd = Math.max(
            state.selectedSignalWindowEnd == null ? finalizedThrough : state.selectedSignalWindowEnd,
            finalizedThrough
          );
          state.selectedSignalProvisional = state.selectedSignalProvisional.filter(function (point) {
            return Number(point.timestamp) > finalizedThrough;
          });
        }
        trimSelectedSignalRoute(state.selectedSignalWindowEnd || Date.now() / 1000);
        updateFlightLayers();
        resolveSelectedSignalFocus(selectionVersion);
      })
      .catch(function (error) {
        if (window.console && console.warn) console.warn("Selected signal route unavailable:", error);
        if (selectionVersion === state.selectedSignalSelectionVersion) {
          if (!focusSelectedSignalRoute(activeViewMode())) {
            showMessage("The selected signal-route history could not be loaded. Try selecting the flight again.");
          }
        }
      })
      .then(function () {
        if (selectionVersion === state.selectedSignalSelectionVersion &&
            state.selectedSignalLoadingIcao24 === icao24) {
          state.selectedSignalLoadingIcao24 = null;
        }
      });
  }

  function selectedSignalPoints() {
    var cutoff = (state.selectedSignalWindowEnd || Date.now() / 1000) - SIGNAL_ROUTE_WINDOW_SECONDS;
    return mergeSignalPoints(state.selectedSignalHistory, state.selectedSignalProvisional).filter(function (point) {
      return Number(point.timestamp) >= cutoff &&
        finiteNumber(point.aircraft_lon) != null && finiteNumber(point.aircraft_lat) != null;
    });
  }

  function drawableSignalPoint(point) {
    return finiteNumber(point && point.total_loss_db) != null &&
      finiteNumber(point && point.aircraft_lon) != null &&
      finiteNumber(point && point.aircraft_lat) != null &&
      finiteNumber(point && point.aircraft_altitude_m) != null;
  }

  function drawableSelectedSignalPoints() {
    return selectedSignalPoints().filter(drawableSignalPoint);
  }

  function currentSignalAvailability(flight) {
    var signalV2 = flight && flight.signal_v2;
    var current = signalV2 ? (signalV2.live_current || signalV2.current) : null;
    var candidates = current ? [current] : [];
    if (signalV2 && signalV2.predicted_timeline) {
      candidates = candidates.concat(signalV2.predicted_timeline);
    }
    if (candidates.some(drawableSignalPoint)) {
      return { drawable: true, reason: "Modeled signal available" };
    }
    if (!current) return { drawable: false, reason: "Waiting for modeled signal" };
    if (current.frequency_assignment_status === "outside_40_nm") {
      return { drawable: false, reason: "Outside 40 NM" };
    }
    if (current.frequency_assignment_status === "unavailable") {
      return { drawable: false, reason: "No phase/frequency assignment" };
    }
    return { drawable: false, reason: "Modeled loss unavailable" };
  }

  function activeViewMode() {
    return document.body.getAttribute("data-view-mode") || "plan";
  }

  function signalRouteBounds(points) {
    var bounds = {
      west: Infinity,
      south: Infinity,
      east: -Infinity,
      north: -Infinity
    };
    points.forEach(function (point) {
      var longitude = Number(point.aircraft_lon);
      var latitude = Number(point.aircraft_lat);
      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
    });
    return [[bounds.west, bounds.south], [bounds.east, bounds.north]];
  }

  function signalRouteBearing(points) {
    if (points.length < 2) return -20;
    var end = points[points.length - 1];
    var endLongitude = Number(end.aircraft_lon);
    var endLatitude = Number(end.aircraft_lat);
    var start = null;
    for (var index = points.length - 2; index >= 0; index -= 1) {
      if (Number(points[index].aircraft_lon) !== endLongitude ||
          Number(points[index].aircraft_lat) !== endLatitude) {
        start = points[index];
        break;
      }
    }
    if (!start) return finiteNumber(end.heading_deg) == null ? -20 : Number(end.heading_deg);
    var lat1 = Number(start.aircraft_lat) * Math.PI / 180;
    var lat2 = endLatitude * Math.PI / 180;
    var longitudeDelta = (endLongitude - Number(start.aircraft_lon)) * Math.PI / 180;
    var y = Math.sin(longitudeDelta) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitudeDelta);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function signalRoutePadding(map) {
    var width = map.getContainer().clientWidth || window.innerWidth;
    if (width >= 1100) return { top: 140, right: 410, bottom: 100, left: 370 };
    return { top: 100, right: 45, bottom: 90, left: 45 };
  }

  function focusSelectedSignalRoute(mode, force) {
    if (mode !== "plan" && mode !== "3d") return false;
    if (!state.selectedIcao24) return false;
    if (!force && state.selectedSignalFocusedVersions[mode] === state.selectedSignalSelectionVersion) {
      return true;
    }
    var points = drawableSelectedSignalPoints();
    if (points.length < 2) return false;
    var view = mode === "3d" ? window.ThreeDView : window.PlanView;
    var map = view && view.getMap();
    if (!map || !map.isStyleLoaded() || map.getContainer().clientWidth === 0) return false;
    var options = {
      padding: signalRoutePadding(map),
      maxZoom: mode === "3d" ? 15 : 15.5,
      duration: 1100
    };
    if (mode === "3d") {
      options.pitch = 65;
      options.bearing = signalRouteBearing(points);
    }
    map.fitBounds(signalRouteBounds(points), options);
    state.selectedSignalFocusedVersions[mode] = state.selectedSignalSelectionVersion;
    return true;
  }

  function resolveSelectedSignalFocus(selectionVersion) {
    if (selectionVersion !== state.selectedSignalSelectionVersion) return;
    var points = drawableSelectedSignalPoints();
    setSignalLegendVisible(points.length >= 2);
    if (points.length >= 2) {
      focusSelectedSignalRoute(activeViewMode());
      return;
    }
    if (state.selectedSignalNoDataMessageVersion === selectionVersion) return;
    state.selectedSignalNoDataMessageVersion = selectionVersion;
    var flight = state.flights.find(function (item) { return item.icao24 === state.selectedIcao24; });
    var callsign = flight ? (flight.callsign || flight.icao24.toUpperCase()) : "Selected flight";
    var availability = currentSignalAvailability(flight);
    showMessage(callsign + ": no modeled signal is available in the rolling 15-minute window (" +
      availability.reason.toLowerCase() + ").");
  }

  function signalStrength(point, visibleMinimumLoss) {
    var loss = finiteNumber(point && point.total_loss_db);
    if (loss == null) return null;
    var reference = state.selectedSignalReferenceLossDb;
    if (reference == null) reference = visibleMinimumLoss;
    if (reference == null) return null;
    var relativeDb = Math.max(SIGNAL_VISUAL_FLOOR_DB, Math.min(0, reference - loss));
    return (relativeDb - SIGNAL_VISUAL_FLOOR_DB) / -SIGNAL_VISUAL_FLOOR_DB;
  }

  function disposeSignalObject(object3d) {
    if (!object3d) return;
    var materials = [];
    object3d.traverse(function (node) {
      if (node.geometry && typeof node.geometry.dispose === "function") node.geometry.dispose();
      if (node.material) {
        (Array.isArray(node.material) ? node.material : [node.material]).forEach(function (material) {
          if (materials.indexOf(material) === -1) materials.push(material);
        });
      }
    });
    materials.forEach(function (material) { material.dispose(); });
  }

  function createSelectedSignalLayer(mode) {
    return {
      id: (mode === "3d" ? "three-d-" : "plan-") + "selected-flight-signal-rings",
      type: "custom",
      renderingMode: "3d",
      object3d: null,
      originMercator: null,
      meterScale: 1,
      metrics: { rings: 0, finalizedRings: 0, predictedRings: 0 },
      onAdd: function (map, gl) {
        this.map = map;
        this.camera = new THREE.Camera();
        this.scene = new THREE.Scene();
        this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
        this.renderer.autoClear = false;
        if (this.object3d) this.scene.add(this.object3d);
      },
      setSignalObject: function (payload) {
        if (this.object3d && this.scene) this.scene.remove(this.object3d);
        disposeSignalObject(this.object3d);
        this.object3d = payload ? payload.object3d : null;
        this.metrics = payload ? payload.metrics : { rings: 0, finalizedRings: 0, predictedRings: 0 };
        if (payload) {
          this.originMercator = maplibregl.MercatorCoordinate.fromLngLat(payload.originLonLat, 0);
          this.meterScale = this.originMercator.meterInMercatorCoordinateUnits();
        } else {
          this.originMercator = null;
        }
        if (this.object3d && this.scene) this.scene.add(this.object3d);
        if (this.map) this.map.triggerRepaint();
      },
      render: function (gl, matrix) {
        if (!this.object3d || !this.originMercator) return;
        var projection = new THREE.Matrix4().fromArray(matrix);
        var localTransform = new THREE.Matrix4()
          .makeTranslation(this.originMercator.x, this.originMercator.y, this.originMercator.z)
          .scale(new THREE.Vector3(this.meterScale, this.meterScale, this.meterScale));
        this.camera.projectionMatrix = projection.multiply(localTransform);
        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
      }
    };
  }

  function ensureSelectedSignalLayer(map, mode) {
    var property = mode === "3d" ? "threeDSignalLayer" : "planSignalLayer";
    if (!map || state[property]) return;
    var layer = createSelectedSignalLayer(mode);
    state[property] = layer;
    map.addLayer(layer);
    map.on("zoomend", function () { updateSelectedSignalGeometry(mode); });
  }

  function signalMetersPerPixel(map, latitude) {
    return 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, map.getZoom());
  }

  function addLineSegment(target, start, end) {
    target.push(start.x, start.y, start.z, end.x, end.y, end.z);
  }

  function makeSignalLineObject(positions, opacity) {
    if (!positions.length) return null;
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    var material = new THREE.LineBasicMaterial({
      color: SIGNAL_ROUTE_COLOR,
      transparent: true,
      opacity: opacity,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false
    });
    var lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    return lines;
  }

  function routeTangent(centers, index, previousTangent) {
    var tangent;
    if (index === 0) tangent = centers[1].clone().sub(centers[0]);
    else if (index === centers.length - 1) tangent = centers[index].clone().sub(centers[index - 1]);
    else tangent = centers[index + 1].clone().sub(centers[index - 1]);
    if (tangent.lengthSq() < 1e-8) {
      return previousTangent ? previousTangent.clone() : new THREE.Vector3(1, 0, 0);
    }
    return tangent.normalize();
  }

  function initialRingRight(tangent) {
    var reference = Math.abs(tangent.z) < 0.92
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
    var right = new THREE.Vector3().crossVectors(tangent, reference);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    return right.normalize();
  }

  function buildSignalRunGeometry(run, radiusMinM, radiusMaxM, finalizedPositions, predictedPositions) {
    var centers = run.map(function (sample) { return sample.center; });
    var previousTangent = null;
    var previousRight = null;
    var previousRing = null;
    var previousPredicted = false;
    var finalizedRings = 0;
    var predictedRings = 0;

    run.forEach(function (sample, index) {
      var tangent = routeTangent(centers, index, previousTangent);
      var right;
      if (!previousRight || !previousTangent) {
        right = initialRingRight(tangent);
      } else {
        var transport = new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent);
        right = previousRight.clone().applyQuaternion(transport);
        right.addScaledVector(tangent, -right.dot(tangent));
        if (right.lengthSq() < 1e-8) right = initialRingRight(tangent);
        else right.normalize();
      }
      var ringUp = new THREE.Vector3().crossVectors(tangent, right).normalize();
      var radius = radiusMinM + (radiusMaxM - radiusMinM) * sample.strength;
      var ring = [];
      for (var angleIndex = 0; angleIndex < SIGNAL_RING_SEGMENTS; angleIndex += 1) {
        var angle = angleIndex / SIGNAL_RING_SEGMENTS * Math.PI * 2;
        ring.push(sample.center.clone()
          .addScaledVector(right, Math.cos(angle) * radius)
          .addScaledVector(ringUp, Math.sin(angle) * radius));
      }

      var ringTarget = sample.predicted ? predictedPositions : finalizedPositions;
      for (var ringIndex = 0; ringIndex < SIGNAL_RING_SEGMENTS; ringIndex += 1) {
        addLineSegment(ringTarget, ring[ringIndex], ring[(ringIndex + 1) % SIGNAL_RING_SEGMENTS]);
      }
      if (sample.predicted) predictedRings += 1;
      else finalizedRings += 1;

      if (previousRing) {
        var strandTarget = sample.predicted || previousPredicted ? predictedPositions : finalizedPositions;
        for (var strandIndex = 0; strandIndex < SIGNAL_RING_SEGMENTS; strandIndex += 1) {
          addLineSegment(strandTarget, previousRing[strandIndex], ring[strandIndex]);
        }
      }
      previousRing = ring;
      previousPredicted = sample.predicted;
      previousTangent = tangent;
      previousRight = right;
    });
    return { finalizedRings: finalizedRings, predictedRings: predictedRings };
  }

  function makeSelectedSignalObject(map) {
    if (!state.selectedIcao24) return null;
    var points = selectedSignalPoints();
    if (points.length < 2) return null;
    var losses = points.map(function (point) { return finiteNumber(point.total_loss_db); })
      .filter(function (value) { return value != null; });
    var visibleMinimumLoss = losses.length ? Math.min.apply(null, losses) : null;
    var originPoint = points[Math.floor(points.length / 2)];
    var originLat = Number(originPoint.aircraft_lat);
    var originLon = Number(originPoint.aircraft_lon);
    var metersPerDegreeLat = 111320;
    var metersPerDegreeLon = metersPerDegreeLat * Math.cos(originLat * Math.PI / 180);
    var metersPerPixel = signalMetersPerPixel(map, originLat);
    var radiusMinM = Math.max(SIGNAL_RING_MIN_RADIUS_M,
      Math.min(80, SIGNAL_RING_MIN_RADIUS_PX * metersPerPixel));
    var radiusMaxM = Math.max(radiusMinM + 1,
      Math.min(SIGNAL_RING_MAX_RADIUS_M, SIGNAL_RING_MAX_RADIUS_PX * metersPerPixel));
    var runs = [];
    var currentRun = [];
    var previousTimestamp = null;

    points.forEach(function (point) {
      var strength = signalStrength(point, visibleMinimumLoss);
      var timestamp = Number(point.timestamp);
      var altitude = finiteNumber(point.aircraft_altitude_m);
      if (strength == null || altitude == null ||
          (previousTimestamp != null && timestamp - previousTimestamp > 5)) {
        if (currentRun.length >= 2) runs.push(currentRun);
        currentRun = [];
      }
      if (strength != null && altitude != null) {
        currentRun.push({
          timestamp: timestamp,
          strength: strength,
          predicted: point.position_status === "predicted",
          center: new THREE.Vector3(
            (Number(point.aircraft_lon) - originLon) * metersPerDegreeLon,
            -(Number(point.aircraft_lat) - originLat) * metersPerDegreeLat,
            Math.max(0, altitude)
          )
        });
      }
      previousTimestamp = timestamp;
    });
    if (currentRun.length >= 2) runs.push(currentRun);
    if (!runs.length) return null;

    var finalizedPositions = [];
    var predictedPositions = [];
    var finalizedRings = 0;
    var predictedRings = 0;
    runs.forEach(function (run) {
      var counts = buildSignalRunGeometry(
        run, radiusMinM, radiusMaxM, finalizedPositions, predictedPositions
      );
      finalizedRings += counts.finalizedRings;
      predictedRings += counts.predictedRings;
    });

    var group = new THREE.Group();
    var finalizedObject = makeSignalLineObject(finalizedPositions, 0.9);
    var predictedObject = makeSignalLineObject(predictedPositions, 0.38);
    if (finalizedObject) group.add(finalizedObject);
    if (predictedObject) group.add(predictedObject);
    return {
      originLonLat: [originLon, originLat],
      object3d: group,
      metrics: {
        rings: finalizedRings + predictedRings,
        finalizedRings: finalizedRings,
        predictedRings: predictedRings,
        radiusMinM: radiusMinM,
        radiusMaxM: radiusMaxM
      }
    };
  }

  function updateSelectedSignalGeometry(mode) {
    [
      { mode: "plan", map: window.PlanView && window.PlanView.getMap(), layer: state.planSignalLayer },
      { mode: "3d", map: window.ThreeDView && window.ThreeDView.getMap(), layer: state.threeDSignalLayer }
    ].forEach(function (target) {
      if (mode && target.mode !== mode) return;
      if (!target.map || !target.layer) return;
      target.layer.setSignalObject(makeSelectedSignalObject(target.map));
    });
  }

  function detailRow(key, value) {
    var row = document.createElement("tr");
    var header = document.createElement("th");
    var cell = document.createElement("td");
    header.scope = "row";
    header.textContent = key;
    cell.textContent = value;
    row.append(header, cell);
    return row;
  }

  function bindFilter(group, property) {
    group.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-value]");
      if (!button) return;
      state[property] = button.getAttribute("data-value");
      Array.prototype.forEach.call(group.querySelectorAll("button[data-value]"), function (option) {
        option.classList.toggle("selected", option === button);
      });
      renderFlightButtons();
      updateFlightLayers();
    });
  }

  function circleFeature(longitude, latitude, radiusNm, steps) {
    var coordinates = [];
    var angularDistance = radiusNm / 3440.065;
    var lat1 = latitude * Math.PI / 180;
    var lon1 = longitude * Math.PI / 180;
    for (var index = 0; index <= steps; index += 1) {
      var bearing = 2 * Math.PI * index / steps;
      var lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
      );
      var lon2 = lon1 + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
      );
      coordinates.push([lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
    }
    return {
      type: "Feature",
      properties: { radius_nm: radiusNm },
      geometry: { type: "Polygon", coordinates: [coordinates] }
    };
  }

  function formatNumber(value, digits, suffix) {
    if (value == null || !Number.isFinite(Number(value))) return "--";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }) + (suffix || "");
  }
  function formatSigned(value, digits, suffix) {
    if (value == null || !Number.isFinite(Number(value))) return "--";
    var number = Number(value);
    return (number > 0 ? "+" : "") + formatNumber(number, digits, suffix);
  }
  function formatClock(epochMilliseconds) {
    if (!epochMilliseconds) return "--";
    return new Date(epochMilliseconds).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }
  function formatDateTime(epochSeconds) {
    return epochSeconds ? new Date(epochSeconds * 1000).toLocaleString() : "--";
  }
  function capitalize(value) {
    if (!value) return "Unknown";
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }
  function label(value) {
    if (!value) return "Unknown";
    return String(value).split("_").map(capitalize).join(" ");
  }
  function showMessage(message) {
    ui.mapMessage.textContent = message;
    ui.mapMessage.classList.add("visible");
    window.clearTimeout(state.messageTimer);
    state.messageTimer = window.setTimeout(function () {
      ui.mapMessage.classList.remove("visible");
    }, 8000);
  }

  document.addEventListener("platform:plan-map-ready", function () {
    attachOverlay(window.PlanView && window.PlanView.getMap(), "plan");
    window.setTimeout(function () { focusSelectedSignalRoute("plan"); }, 0);
  });
  document.addEventListener("platform:three-d-map-ready", function () {
    attachOverlay(window.ThreeDView && window.ThreeDView.getMap(), "3d");
    window.setTimeout(function () { focusSelectedSignalRoute("3d"); }, 0);
  });
  document.addEventListener("platform:view-changed", function (event) {
    var mode = event.detail && event.detail.mode;
    if (mode !== "plan" && mode !== "3d") return;
    window.setTimeout(function () {
      updateSelectedSignalGeometry(mode);
      focusSelectedSignalRoute(mode);
    }, 0);
  });
  document.addEventListener("platform:three-d-subway-routes-updated", function (event) {
    state.subwayRoutes3D = (event.detail && event.detail.featureCollection) || null;
    updateFlightLayers();
  });
  document.addEventListener("platform:train-selected", function (event) {
    if (state.selectedIcao24) closeDetails();
    state.selectedTrainRouteId = (event.detail && event.detail.route) || null;
    updateFlightLayers();
  });
  document.addEventListener("platform:train-deselected", function () {
    state.selectedTrainRouteId = null;
    updateFlightLayers();
  });
  document.addEventListener("platform:subways-updated", function (event) {
    var detail = event.detail || {};
    ui.subwayCount.textContent = detail.count == null ? "0" : String(detail.count);
    ui.subwayLines.textContent = detail.visibleRoutes && detail.visibleRoutes.length
      ? detail.visibleRoutes.join(" + ")
      : "None";
    ui.subwayUpdate.textContent = detail.updatedAt ? formatClock(detail.updatedAt) : "--";
  });

  bindFilter(ui.statusFilter, "statusFilter");
  bindFilter(ui.directionFilter, "directionFilter");
  ui.detailsClose.addEventListener("click", closeDetails);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeDetails();
  });

  var existingPlanMap = window.PlanView && window.PlanView.getMap();
  if (existingPlanMap && existingPlanMap.isStyleLoaded()) attachOverlay(existingPlanMap, "plan");

  refreshFlights();
  window.setInterval(refreshFlights, 5000);
  window.setInterval(advanceSignalClock, 1000);
})();
