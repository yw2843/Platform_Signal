/* global deck */

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
    subwayRoutes3D: null,
    selectedTrainRouteId: null,
    messageTimer: null
  };

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
      var statusMatches = state.statusFilter === "all" || flight.status === state.statusFilter;
      var directionMatches = state.directionFilter === "all" || flight.direction === state.directionFilter;
      return statusMatches && directionMatches;
    });
  }

  function attachOverlay(map, mode) {
    var property = mode === "plan" ? "planOverlay" : "threeDOverlay";
    if (!map || state[property]) return;
    addBoundaryLayers(map, mode);
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
      return [current.longitude, current.latitude, is3D ? Number(current.altitude_m || 0) : 0];
    }

    return [
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
      }),
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
        getOrientation: function (flight) { return [0, Number(flight.current.heading_deg || 0), 90]; },
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
    ];
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
    if (state.selectedIcao24 && ui.detailsPanel.classList.contains("open")) {
      var selected = state.flights.find(function (flight) {
        return flight.icao24 === state.selectedIcao24;
      });
      if (selected) renderDetails(selected);
    }
  }

  function renderStatus(payload) {
    var service = payload.service || {};
    var label = service.state === "online" ? "Live" : capitalize(service.state || "starting");
    setConnection(service.state, label);
    ui.confirmedCount.textContent = state.flights.filter(function (flight) {
      return flight.status === "confirmed";
    }).length;
    ui.probableCount.textContent = state.flights.filter(function (flight) {
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
      empty.textContent = state.flights.length ? "No flights match these filters" : "Waiting for classified flights...";
      ui.flightPicker.appendChild(empty);
      return;
    }
    flights.forEach(function (flight) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "route-btn pill flight-" + flight.status;
      if (flight.icao24 === state.selectedIcao24) button.classList.add("active-flight");
      button.textContent = flight.callsign || flight.icao24.toUpperCase();
      button.title = capitalize(flight.status) + " " + flight.direction + " - " +
        formatNumber(flight.current.distance_nm, 1, " NM from LGA");
      button.addEventListener("click", function () { selectFlight(flight.icao24); });
      ui.flightPicker.appendChild(button);
    });
  }

  function selectFlight(icao24) {
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
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
    updateFlightLayers();
  }

  function closeDetails() {
    state.selectedIcao24 = null;
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
    renderDetails(flight);
    if (window.setActiveSectionFlight) window.setActiveSectionFlight(flight);
  }

  function renderDetails(flight) {
    var current = flight.current;
    var signal = flight.signal_v2
      ? (flight.signal_v2.live_current || flight.signal_v2.current)
      : null;
    ui.detailsStatus.textContent = capitalize(flight.status) + " - " + capitalize(flight.direction);
    ui.detailsStatus.style.color = flight.status === "confirmed" ? "#2ed47a" : "#f5a623";
    ui.detailsCallsign.textContent = flight.callsign || flight.icao24.toUpperCase();
    ui.detailsRoute.textContent = flight.track.length + " observations - one-hour rolling trail";

    var frequency = current.frequency_mhz == null
      ? current.frequency_status
      : Number(current.frequency_mhz).toFixed(1) + " MHz";
    var rows = [
      ["ICAO24", flight.icao24.toUpperCase()],
      ["Confirmation", capitalize(flight.status)],
      ["Direction", capitalize(flight.direction)],
      ["Phase", label(current.phase)],
      ["Distance to LGA", formatNumber(current.distance_nm, 1, " NM")],
      ["Altitude", formatNumber(current.altitude_ft, 0, " ft")],
      ["Ground speed", formatNumber(current.speed_kt, 0, " kt")],
      ["Vertical rate", formatSigned(current.vertical_fpm, 0, " ft/min")],
      ["True track", formatNumber(current.heading_deg, 0, " deg")],
      ["Service", current.service ? capitalize(current.service) : "--"],
      ["Frequency", frequency || "--"],
      ["Matched rule", current.matched_rule_id || "--"],
      ["Last position", formatDateTime(current.timestamp)]
    ];
    if (signal) {
      var buildingPath = "Unavailable - FSPL only";
      if (signal.building_data_status === "available" || signal.building_data_status === "partial") {
        buildingPath = signal.building_blocked
          ? "Blocked - " + (signal.blocking_building_count || 1) + " intersecting"
          : "Clear";
        if (signal.building_data_status === "partial") buildingPath += " (partial data)";
      }
      rows.push(
        ["V2 signal point", label(signal.position_status)],
        ["V2 phase", label(signal.inferred_phase)],
        ["V2 frequency", formatNumber(signal.most_likely_frequency_mhz, 1, " MHz")],
        ["Modeled total loss", formatNumber(signal.total_loss_db, 2, " dB")],
        ["Change vs phase strongest", formatSigned(signal.relative_signal_phase_db, 2, " dB")],
        ["Phase relative power", formatNumber(signal.relative_power_phase_percent, 1, "%")],
        ["Change vs flight strongest", formatSigned(signal.relative_signal_flight_db, 2, " dB")],
        ["Flight relative power", formatNumber(signal.relative_power_flight_percent, 1, "%")],
        ["Free-space loss", formatNumber(signal.fspl_db, 2, " dB")],
        ["Building loss", formatNumber(signal.building_loss_db, 2, " dB")],
        ["Building path", buildingPath],
        ["V2 signal time", formatDateTime(signal.timestamp)]
      );
    } else {
      rows.push(["V2 signal", "Waiting for an eligible phase and position"]);
    }
    ui.detailsBody.replaceChildren.apply(ui.detailsBody, rows.map(function (row) {
      return detailRow(row[0], row[1]);
    }));
    ui.detailsNote.textContent = current.phase_scope === "outside_current_rule"
      ? "Beyond 40 NM is reserved for Future Research; no frequency rule is applied."
      : "V2 values are modeled path loss, not measured dBm. Lower total loss is stronger; 0 dB relative change is the strongest modeled point in the selected phase or flight.";
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
  });
  document.addEventListener("platform:three-d-map-ready", function () {
    attachOverlay(window.ThreeDView && window.ThreeDView.getMap(), "3d");
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
