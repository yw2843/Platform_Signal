from __future__ import annotations

import gzip
import json
import math
import struct
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Iterable
from urllib.request import Request, urlopen


EARTH_RADIUS_M = 6_371_000.0
LGA_LAT = 40.77724222
LGA_LON = -73.87260555
LGA_ELEVATION_M = 20.7 * 0.3048
PROTOTYPE_ANTENNA_AGL_M = 50.0
PROTOTYPE_ANTENNA_ALT_M = LGA_ELEVATION_M + PROTOTYPE_ANTENNA_AGL_M
PREDICTION_SECONDS = 30
HISTORY_SECONDS = 60 * 60
DEFAULT_BUILDING_HEIGHT_M = 10.0
BUILDING_RETRY_SECONDS = 300.0
ACTIVE_TIMEOUT_SECONDS = 90
BUILDING_RESULT_FIELDS = (
    "building_data_status",
    "building_blocked",
    "blocking_building_count",
    "dominant_building_id",
    "dominant_building_height_m",
    "building_height_status",
    "worst_clearance_m",
    "fresnel_radius_m",
    "diffraction_v",
    "building_loss_db",
)

PHASE_FREQUENCIES: dict[str, dict[str, Any]] = {
    "ground_taxi": {
        "frequency_mhz": 121.7,
        "service": "ground",
        "facility_id": "LGA",
        "rule_id": "LGA_V2_GROUND",
    },
    "final_approach": {
        "frequency_mhz": 118.7,
        "service": "tower",
        "facility_id": "LGA",
        "rule_id": "LGA_V2_ARR_FINAL",
    },
    "initial_departure": {
        "frequency_mhz": 118.7,
        "service": "tower",
        "facility_id": "LGA",
        "rule_id": "LGA_V2_DEP_INITIAL",
    },
    "arrival_approach": {
        "frequency_mhz": 120.8,
        "service": "approach",
        "facility_id": "N90",
        "rule_id": "LGA_V2_ARR_APPROACH",
    },
    "departure_climb": {
        "frequency_mhz": 120.4,
        "service": "departure",
        "facility_id": "N90",
        "rule_id": "LGA_V2_DEP_CLIMB",
    },
}


def _finite(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _angle_delta(start: float, end: float) -> float:
    return (end - start + 180.0) % 360.0 - 180.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * (EARTH_RADIUS_M / 1000.0) * math.asin(math.sqrt(a))


def _to_local_m(lat: float, lon: float, ref_lat: float, ref_lon: float) -> tuple[float, float]:
    x = EARTH_RADIUS_M * math.cos(math.radians(ref_lat)) * math.radians(lon - ref_lon)
    y = EARTH_RADIUS_M * math.radians(lat - ref_lat)
    return x, y


def _from_local_m(x: float, y: float, ref_lat: float, ref_lon: float) -> tuple[float, float]:
    lat = ref_lat + math.degrees(y / EARTH_RADIUS_M)
    lon = ref_lon + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(ref_lat))))
    return lat, ((lon + 180.0) % 360.0) - 180.0


def _velocity_xy(point: dict[str, Any]) -> tuple[float, float] | None:
    speed_kt = _finite(point.get("speed_kt"))
    heading_deg = _finite(point.get("heading_deg"))
    if speed_kt is None or heading_deg is None:
        return None
    speed_mps = speed_kt / 1.943844
    heading = math.radians(heading_deg)
    return speed_mps * math.sin(heading), speed_mps * math.cos(heading)


def _geometry_altitude(point: dict[str, Any]) -> tuple[float | None, str]:
    geometric = _finite(point.get("geo_altitude_m"))
    if geometric is not None:
        return geometric, "geometric"
    barometric = _finite(point.get("baro_altitude_m"))
    if barometric is None:
        barometric = _finite(point.get("altitude_m"))
    return barometric, "barometric_fallback" if barometric is not None else "unavailable"


def interpolate_observations(a: dict[str, Any], b: dict[str, Any], timestamp: float) -> dict[str, Any]:
    """Interpolate one position between actual endpoints without modifying either endpoint."""
    start = float(a["timestamp"])
    end = float(b["timestamp"])
    duration = end - start
    if duration <= 0:
        raise ValueError("Observation B must be newer than observation A")
    u = _clamp((timestamp - start) / duration, 0.0, 1.0)
    h00 = 2 * u**3 - 3 * u**2 + 1
    h10 = u**3 - 2 * u**2 + u
    h01 = -2 * u**3 + 3 * u**2
    h11 = u**3 - u**2

    ref_lat = (float(a["latitude"]) + float(b["latitude"])) / 2.0
    ref_lon = (float(a["longitude"]) + float(b["longitude"])) / 2.0
    ax, ay = _to_local_m(float(a["latitude"]), float(a["longitude"]), ref_lat, ref_lon)
    bx, by = _to_local_m(float(b["latitude"]), float(b["longitude"]), ref_lat, ref_lon)
    av = _velocity_xy(a)
    bv = _velocity_xy(b)
    if av is None or bv is None:
        x = ax + (bx - ax) * u
        y = ay + (by - ay) * u
    else:
        x = h00 * ax + h10 * duration * av[0] + h01 * bx + h11 * duration * bv[0]
        y = h00 * ay + h10 * duration * av[1] + h01 * by + h11 * duration * bv[1]
    latitude, longitude = _from_local_m(x, y, ref_lat, ref_lon)

    altitude_a, _ = _geometry_altitude(a)
    altitude_b, _ = _geometry_altitude(b)
    vertical_a = _finite(a.get("vertical_fpm"))
    vertical_b = _finite(b.get("vertical_fpm"))
    if altitude_a is None or altitude_b is None:
        altitude = altitude_a if altitude_a is not None else altitude_b
    elif vertical_a is None or vertical_b is None:
        altitude = altitude_a + (altitude_b - altitude_a) * u
    else:
        va_mps = vertical_a / 196.8504
        vb_mps = vertical_b / 196.8504
        altitude = h00 * altitude_a + h10 * duration * va_mps + h01 * altitude_b + h11 * duration * vb_mps

    heading_a = _finite(a.get("heading_deg"))
    heading_b = _finite(b.get("heading_deg"))
    heading = heading_a
    if heading_a is not None and heading_b is not None:
        heading = (heading_a + _angle_delta(heading_a, heading_b) * u) % 360.0
    speed_a = _finite(a.get("speed_kt"))
    speed_b = _finite(b.get("speed_kt"))
    speed = speed_a if speed_b is None else speed_b if speed_a is None else speed_a + (speed_b - speed_a) * u
    vertical = vertical_a if vertical_b is None else vertical_b if vertical_a is None else vertical_a + (vertical_b - vertical_a) * u

    return {
        "timestamp": timestamp,
        "latitude": latitude,
        "longitude": longitude,
        "geo_altitude_m": altitude,
        "baro_altitude_m": None,
        "altitude_m": altitude,
        "altitude_ft": altitude * 3.28084 if altitude is not None else None,
        "speed_kt": speed,
        "heading_deg": heading,
        "vertical_fpm": vertical,
        "on_ground": bool(a.get("on_ground") and b.get("on_ground")),
        "distance_nm": _haversine_km(latitude, longitude, LGA_LAT, LGA_LON) / 1.852,
    }


def predict_observation(actuals: Iterable[dict[str, Any]], seconds: int) -> dict[str, Any]:
    points = list(actuals)
    if not points:
        raise ValueError("At least one actual observation is required")
    current = points[-1]
    speed_kt = _finite(current.get("speed_kt")) or 0.0
    heading_deg = _finite(current.get("heading_deg")) or 0.0
    speed_mps = speed_kt / 1.943844
    turn_rate_deg_s = 0.0
    if len(points) >= 2:
        previous = points[-2]
        previous_heading = _finite(previous.get("heading_deg"))
        elapsed = float(current["timestamp"]) - float(previous["timestamp"])
        if previous_heading is not None and elapsed > 0:
            candidate = _angle_delta(previous_heading, heading_deg) / elapsed
            if abs(candidate) <= 5.0:
                turn_rate_deg_s = candidate

    ref_lat = float(current["latitude"])
    ref_lon = float(current["longitude"])
    heading = math.radians(heading_deg)
    omega = math.radians(turn_rate_deg_s)
    duration = float(seconds)
    if abs(omega) < 1e-9:
        x = speed_mps * math.sin(heading) * duration
        y = speed_mps * math.cos(heading) * duration
    else:
        end_heading = heading + omega * duration
        x = speed_mps / omega * (math.cos(heading) - math.cos(end_heading))
        y = speed_mps / omega * (math.sin(end_heading) - math.sin(heading))
    latitude, longitude = _from_local_m(x, y, ref_lat, ref_lon)

    altitude, altitude_status = _geometry_altitude(current)
    vertical_fpm = _finite(current.get("vertical_fpm")) or 0.0
    if altitude is not None:
        altitude += vertical_fpm / 196.8504 * duration
    predicted_heading = (heading_deg + turn_rate_deg_s * duration) % 360.0
    return {
        "timestamp": float(current["timestamp"]) + duration,
        "latitude": latitude,
        "longitude": longitude,
        "geo_altitude_m": altitude if altitude_status == "geometric" else None,
        "baro_altitude_m": altitude if altitude_status != "geometric" else None,
        "altitude_m": altitude,
        "altitude_ft": altitude * 3.28084 if altitude is not None else None,
        "speed_kt": speed_kt,
        "heading_deg": predicted_heading,
        "vertical_fpm": vertical_fpm,
        "on_ground": bool(current.get("on_ground")),
        "distance_nm": _haversine_km(latitude, longitude, LGA_LAT, LGA_LON) / 1.852,
    }


def classify_phase(point: dict[str, Any], direction: str) -> tuple[str, float]:
    distance_nm = _finite(point.get("distance_nm"))
    altitude_ft = _finite(point.get("altitude_ft"))
    speed_kt = _finite(point.get("speed_kt"))
    vertical_fpm = _finite(point.get("vertical_fpm"))
    if distance_nm is None:
        return "unknown", 0.0
    low_and_slow = (
        distance_nm <= 1.5
        and altitude_ft is not None
        and altitude_ft <= 250
        and speed_kt is not None
        and speed_kt <= 50
    )
    if distance_nm <= 1.5 and (bool(point.get("on_ground")) or low_and_slow):
        return "ground_taxi", 1.0
    if direction == "arrival" and vertical_fpm is not None and vertical_fpm <= -200:
        if distance_nm <= 8 and altitude_ft is not None and altitude_ft <= 3_000:
            return "final_approach", 0.9
        if distance_nm <= 40 and altitude_ft is not None and altitude_ft <= 10_000:
            return "arrival_approach", 0.9
    if direction == "departure" and vertical_fpm is not None and vertical_fpm >= 200:
        if distance_nm <= 5 and altitude_ft is not None and altitude_ft <= 3_000:
            return "initial_departure", 0.9
        if distance_nm <= 40 and altitude_ft is not None and altitude_ft <= 15_000:
            return "departure_climb", 0.9
    return "unknown", 0.0


def _read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7
        if shift > 70:
            break
    raise ValueError("Invalid protobuf varint")


def _protobuf_fields(data: bytes) -> list[tuple[int, int, Any]]:
    fields: list[tuple[int, int, Any]] = []
    offset = 0
    while offset < len(data):
        key, offset = _read_varint(data, offset)
        field_number = key >> 3
        wire_type = key & 7
        if wire_type == 0:
            value, offset = _read_varint(data, offset)
        elif wire_type == 1:
            value = data[offset : offset + 8]
            offset += 8
        elif wire_type == 2:
            length, offset = _read_varint(data, offset)
            value = data[offset : offset + length]
            offset += length
        elif wire_type == 5:
            value = data[offset : offset + 4]
            offset += 4
        else:
            raise ValueError(f"Unsupported protobuf wire type {wire_type}")
        fields.append((field_number, wire_type, value))
    return fields


def _packed_varints(data: bytes) -> list[int]:
    values: list[int] = []
    offset = 0
    while offset < len(data):
        value, offset = _read_varint(data, offset)
        values.append(value)
    return values


def _zigzag(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def _decode_mvt_value(data: bytes) -> Any:
    for number, wire, value in _protobuf_fields(data):
        if number == 1 and wire == 2:
            return value.decode("utf-8", errors="replace")
        if number == 2 and wire == 5:
            return struct.unpack("<f", value)[0]
        if number == 3 and wire == 1:
            return struct.unpack("<d", value)[0]
        if number in {4, 5} and wire == 0:
            return value
        if number == 6 and wire == 0:
            return _zigzag(value)
        if number == 7 and wire == 0:
            return bool(value)
    return None


def _decode_geometry(commands: list[int]) -> list[list[tuple[int, int]]]:
    paths: list[list[tuple[int, int]]] = []
    current: list[tuple[int, int]] = []
    x = 0
    y = 0
    offset = 0
    while offset < len(commands):
        command_integer = commands[offset]
        offset += 1
        command = command_integer & 7
        count = command_integer >> 3
        if command in {1, 2}:
            for _ in range(count):
                if offset + 1 >= len(commands):
                    break
                x += _zigzag(commands[offset])
                y += _zigzag(commands[offset + 1])
                offset += 2
                if command == 1 and current:
                    paths.append(current)
                    current = []
                current.append((x, y))
        elif command == 7:
            for _ in range(count):
                if current and current[0] != current[-1]:
                    current.append(current[0])
        else:
            break
    if current:
        paths.append(current)
    return [path for path in paths if len(path) >= 4]


def _tile_point_to_lonlat(z: int, tile_x: int, tile_y: int, extent: int, x: int, y: int) -> tuple[float, float]:
    scale = 2**z
    world_x = (tile_x + x / extent) / scale
    world_y = (tile_y + y / extent) / scale
    lon = world_x * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * world_y))))
    return lon, lat


@dataclass
class BuildingFeature:
    building_id: str
    rings: list[list[tuple[float, float]]]
    height_m: float
    min_height_m: float
    height_status: str


def decode_building_tile(data: bytes, z: int, tile_x: int, tile_y: int) -> list[BuildingFeature]:
    buildings: list[BuildingFeature] = []
    for field_number, wire, layer_bytes in _protobuf_fields(data):
        if field_number != 3 or wire != 2:
            continue
        name = ""
        extent = 4096
        keys: list[str] = []
        values: list[Any] = []
        features: list[bytes] = []
        for number, layer_wire, value in _protobuf_fields(layer_bytes):
            if number == 1 and layer_wire == 2:
                name = value.decode("utf-8", errors="replace")
            elif number == 2 and layer_wire == 2:
                features.append(value)
            elif number == 3 and layer_wire == 2:
                keys.append(value.decode("utf-8", errors="replace"))
            elif number == 4 and layer_wire == 2:
                values.append(_decode_mvt_value(value))
            elif number == 5 and layer_wire == 0:
                extent = int(value)
        if name != "building":
            continue
        for index, feature_bytes in enumerate(features):
            feature_id: int | None = None
            tags: list[int] = []
            geometry_type = 0
            geometry: list[int] = []
            for number, feature_wire, value in _protobuf_fields(feature_bytes):
                if number == 1 and feature_wire == 0:
                    feature_id = int(value)
                elif number == 2 and feature_wire == 2:
                    tags = _packed_varints(value)
                elif number == 3 and feature_wire == 0:
                    geometry_type = int(value)
                elif number == 4 and feature_wire == 2:
                    geometry = _packed_varints(value)
            if geometry_type != 3:
                continue
            properties: dict[str, Any] = {}
            for tag_index in range(0, len(tags) - 1, 2):
                key_index = tags[tag_index]
                value_index = tags[tag_index + 1]
                if key_index < len(keys) and value_index < len(values):
                    properties[keys[key_index]] = values[value_index]
            raw_height = _finite(properties.get("render_height"))
            if raw_height is None or raw_height <= 0:
                height = DEFAULT_BUILDING_HEIGHT_M
                height_status = "estimated_default_10m"
            else:
                height = raw_height
                height_status = "source_render_height"
            min_height = _finite(properties.get("render_min_height")) or 0.0
            rings = [
                [_tile_point_to_lonlat(z, tile_x, tile_y, extent, x, y) for x, y in path]
                for path in _decode_geometry(geometry)
            ]
            if rings:
                buildings.append(
                    BuildingFeature(
                        building_id=str(feature_id if feature_id is not None else f"{z}/{tile_x}/{tile_y}/{index}"),
                        rings=rings,
                        height_m=height,
                        min_height_m=min_height,
                        height_status=height_status,
                    )
                )
    return buildings


def _lonlat_to_tile(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    n = 2**zoom
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(_clamp(lat, -85.05112878, 85.05112878))
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def _tiles_along_line(lon1: float, lat1: float, lon2: float, lat2: float, zoom: int) -> list[tuple[int, int, int]]:
    x1, y1 = _lonlat_to_tile(lon1, lat1, zoom)
    x2, y2 = _lonlat_to_tile(lon2, lat2, zoom)
    steps = max(1, int(math.ceil(max(abs(x2 - x1), abs(y2 - y1)) * 4)))
    result: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int, int]] = set()
    limit = 2**zoom
    for index in range(steps + 1):
        fraction = index / steps
        tile_x = int(math.floor(x1 + (x2 - x1) * fraction)) % limit
        tile_y = int(_clamp(math.floor(y1 + (y2 - y1) * fraction), 0, limit - 1))
        key = (zoom, tile_x, tile_y)
        if key not in seen:
            seen.add(key)
            result.append(key)
    return result


def _point_in_polygon(point: tuple[float, float], ring: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    for index in range(len(ring) - 1):
        x1, y1 = ring[index]
        x2, y2 = ring[index + 1]
        if (y1 > y) != (y2 > y):
            crossing = (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
            if x < crossing:
                inside = not inside
    return inside


def _segment_intersection_t(
    a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], d: tuple[float, float]
) -> float | None:
    rx = b[0] - a[0]
    ry = b[1] - a[1]
    sx = d[0] - c[0]
    sy = d[1] - c[1]
    denominator = rx * sy - ry * sx
    if abs(denominator) < 1e-12:
        return None
    qpx = c[0] - a[0]
    qpy = c[1] - a[1]
    t = (qpx * sy - qpy * sx) / denominator
    u = (qpx * ry - qpy * rx) / denominator
    return t if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0 else None


def _path_intersection_fraction(rx: float, ry: float, ring: list[tuple[float, float]]) -> float | None:
    start = (0.0, 0.0)
    end = (rx, ry)
    if _point_in_polygon(start, ring):
        return 0.001
    intersections = [
        value
        for index in range(len(ring) - 1)
        if (value := _segment_intersection_t(start, end, ring[index], ring[index + 1])) is not None
    ]
    if intersections:
        return max(0.001, min(0.999, min(intersections)))
    if _point_in_polygon(end, ring):
        return 0.999
    return None


def knife_edge_loss(v: float) -> float:
    if v <= -0.7:
        return 0.0
    return 6.9 + 20.0 * math.log10(math.sqrt((v - 0.1) ** 2 + 1.0) + v - 0.1)


class NoBuildingProvider:
    source_name = "unavailable"

    def obstruction(
        self,
        tx_lat: float,
        tx_lon: float,
        tx_alt_m: float,
        rx_lat: float,
        rx_lon: float,
        rx_alt_m: float,
        frequency_mhz: float,
    ) -> dict[str, Any]:
        return {
            "building_data_status": "unavailable",
            "building_blocked": None,
            "blocking_building_count": 0,
            "dominant_building_id": None,
            "dominant_building_height_m": None,
            "building_height_status": None,
            "worst_clearance_m": None,
            "fresnel_radius_m": None,
            "diffraction_v": None,
            "building_loss_db": None,
        }


class OpenMapTilesBuildingProvider(NoBuildingProvider):
    source_name = "openfreemap_openmaptiles"

    def __init__(
        self,
        tilejson_url: str = "https://tiles.openfreemap.org/planet",
        zoom: int = 13,
        timeout_seconds: float = 1.5,
        cache_limit: int = 512,
    ) -> None:
        self.tilejson_url = tilejson_url
        self.zoom = zoom
        self.timeout_seconds = timeout_seconds
        self.cache_limit = cache_limit
        self._tile_template: str | None = None
        self._template_attempted_at = 0.0
        self._cache: dict[tuple[int, int, int], tuple[list[BuildingFeature] | None, float]] = {}
        self._lock = threading.RLock()

    def _template(self) -> str | None:
        now = time.monotonic()
        with self._lock:
            if self._tile_template is not None:
                return self._tile_template
            if now - self._template_attempted_at < BUILDING_RETRY_SECONDS:
                return None
            self._template_attempted_at = now
        try:
            request = Request(
                self.tilejson_url,
                headers={"Accept": "application/json", "User-Agent": "Platform-Signal-V2/1.0"},
            )
            with urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            templates = payload.get("tiles") or []
            template = str(templates[0]) if templates else None
        except Exception:
            template = None
        with self._lock:
            self._tile_template = template
            return self._tile_template

    def _load_tile(self, key: tuple[int, int, int]) -> list[BuildingFeature] | None:
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                result, attempted_at = cached
                if result is not None or now - attempted_at < BUILDING_RETRY_SECONDS:
                    return result
        template = self._template()
        if not template:
            return None
        z, x, y = key
        url = template.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        try:
            request = Request(url, headers={"Accept": "application/x-protobuf", "User-Agent": "Platform-Signal-V2/1.0"})
            with urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read()
                content_encoding = response.headers.get("Content-Encoding", "").lower()
            if content_encoding == "gzip" or raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            result: list[BuildingFeature] | None = decode_building_tile(raw, z, x, y)
        except Exception:
            result = None
        with self._lock:
            if len(self._cache) >= self.cache_limit:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = (result, time.monotonic())
        return result

    def obstruction(
        self,
        tx_lat: float,
        tx_lon: float,
        tx_alt_m: float,
        rx_lat: float,
        rx_lon: float,
        rx_alt_m: float,
        frequency_mhz: float,
    ) -> dict[str, Any]:
        keys = _tiles_along_line(tx_lon, tx_lat, rx_lon, rx_lat, self.zoom)
        with ThreadPoolExecutor(max_workers=min(8, max(1, len(keys)))) as executor:
            tile_results = list(executor.map(self._load_tile, keys))
        available = [result for result in tile_results if result is not None]
        if not available:
            return super().obstruction(tx_lat, tx_lon, tx_alt_m, rx_lat, rx_lon, rx_alt_m, frequency_mhz)
        buildings = [building for tile in available for building in tile]
        result = evaluate_buildings(
            tx_lat,
            tx_lon,
            tx_alt_m,
            rx_lat,
            rx_lon,
            rx_alt_m,
            frequency_mhz,
            buildings,
        )
        result["building_data_status"] = "available" if len(available) == len(tile_results) else "partial"
        return result


class StaticBuildingProvider(NoBuildingProvider):
    source_name = "static_test"

    def __init__(self, buildings: list[BuildingFeature]) -> None:
        self.buildings = buildings

    def obstruction(
        self,
        tx_lat: float,
        tx_lon: float,
        tx_alt_m: float,
        rx_lat: float,
        rx_lon: float,
        rx_alt_m: float,
        frequency_mhz: float,
    ) -> dict[str, Any]:
        result = evaluate_buildings(
            tx_lat,
            tx_lon,
            tx_alt_m,
            rx_lat,
            rx_lon,
            rx_alt_m,
            frequency_mhz,
            self.buildings,
        )
        result["building_data_status"] = "available"
        return result


def evaluate_buildings(
    tx_lat: float,
    tx_lon: float,
    tx_alt_m: float,
    rx_lat: float,
    rx_lon: float,
    rx_alt_m: float,
    frequency_mhz: float,
    buildings: list[BuildingFeature],
) -> dict[str, Any]:
    rx_x, rx_y = _to_local_m(rx_lat, rx_lon, tx_lat, tx_lon)
    horizontal_distance = math.hypot(rx_x, rx_y)
    if horizontal_distance < 1.0:
        return {
            "building_data_status": "available",
            "building_blocked": False,
            "blocking_building_count": 0,
            "dominant_building_id": None,
            "dominant_building_height_m": None,
            "building_height_status": None,
            "worst_clearance_m": None,
            "fresnel_radius_m": None,
            "diffraction_v": None,
            "building_loss_db": 0.0,
        }
    wavelength = 299_792_458.0 / (frequency_mhz * 1_000_000.0)
    dominant: tuple[float, dict[str, Any]] | None = None
    blocked_count = 0
    for building in buildings:
        fractions: list[float] = []
        for lonlat_ring in building.rings:
            local_ring = [_to_local_m(lat, lon, tx_lat, tx_lon) for lon, lat in lonlat_ring]
            fraction = _path_intersection_fraction(rx_x, rx_y, local_ring)
            if fraction is not None:
                fractions.append(fraction)
        if not fractions:
            continue
        fraction = min(fractions)
        d1 = max(1.0, horizontal_distance * fraction)
        d2 = max(1.0, horizontal_distance - d1)
        ray_altitude = tx_alt_m + (rx_alt_m - tx_alt_m) * fraction
        building_top = LGA_ELEVATION_M + building.height_m
        obstruction_height = building_top - ray_altitude
        fresnel_radius = math.sqrt(wavelength * d1 * d2 / (d1 + d2))
        v = obstruction_height * math.sqrt(2.0 * (d1 + d2) / (wavelength * d1 * d2))
        loss = knife_edge_loss(v)
        if loss > 0:
            blocked_count += 1
        details = {
            "building_blocked": loss > 0,
            "dominant_building_id": building.building_id,
            "dominant_building_height_m": building.height_m,
            "building_height_status": building.height_status,
            "worst_clearance_m": ray_altitude - building_top,
            "fresnel_radius_m": fresnel_radius,
            "diffraction_v": v,
            "building_loss_db": loss,
        }
        if dominant is None or v > dominant[0]:
            dominant = (v, details)
    if dominant is None:
        return {
            "building_data_status": "available",
            "building_blocked": False,
            "blocking_building_count": 0,
            "dominant_building_id": None,
            "dominant_building_height_m": None,
            "building_height_status": None,
            "worst_clearance_m": None,
            "fresnel_radius_m": None,
            "diffraction_v": None,
            "building_loss_db": 0.0,
        }
    result = dominant[1]
    result["building_data_status"] = "available"
    result["blocking_building_count"] = blocked_count
    return result


@dataclass
class V2FlightState:
    actuals: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=4))
    history: deque[dict[str, Any]] = field(default_factory=deque)
    predictions: list[dict[str, Any]] = field(default_factory=list)
    current_phase: str = "unknown"
    frequency_assignment_status: str = "unavailable"
    pending_phase: str = "unknown"
    pending_count: int = 0
    unknown_actual_count: int = 0
    last_direction: str = "unknown"
    last_status: str = "unknown"
    last_observed_building: dict[str, Any] | None = None


class SignalV2Engine:
    def __init__(self, building_provider: NoBuildingProvider | None = None) -> None:
        self.building_provider = building_provider or NoBuildingProvider()
        self.states: dict[str, V2FlightState] = {}

    def ingest_actual(
        self,
        icao24: str,
        observation: dict[str, Any],
        direction: str,
        status: str,
    ) -> None:
        state = self.states.setdefault(icao24, V2FlightState())
        previous = state.actuals[-1] if state.actuals else None
        if previous and float(observation["timestamp"]) <= float(previous["timestamp"]):
            return
        active = status in {"probable", "confirmed"}
        previous_phase = state.current_phase

        if active and previous:
            if not state.history:
                phase, score, assignment = self._phase_for_sample(
                    state, previous, direction, "observed", previous_phase
                )
                state.history.append(
                    self._signal_point(icao24, previous, phase, score, assignment, "observed", 0, False)
                )
            next_time = float(previous["timestamp"]) + 1.0
            while next_time < float(observation["timestamp"]) - 1e-6:
                interpolated = interpolate_observations(previous, observation, next_time)
                phase, score, assignment = self._phase_for_sample(
                    state,
                    interpolated,
                    direction,
                    "reconciled",
                    previous_phase,
                )
                state.history.append(
                    self._signal_point(
                        icao24,
                        interpolated,
                        phase,
                        score,
                        assignment,
                        "interpolated_between_observations",
                        0,
                        True,
                        building_obstruction=state.last_observed_building,
                    )
                )
                next_time += 1.0

        state.actuals.append(dict(observation))
        state.last_direction = direction
        state.last_status = status
        if active:
            self._update_phase_actual(state, observation, direction, status)
            phase = state.current_phase
            score = 1.0 if phase == "ground_taxi" else 0.9 if phase != "unknown" else 0.0
            observed_signal = self._signal_point(
                icao24,
                observation,
                phase,
                score,
                state.frequency_assignment_status,
                "observed",
                0,
                False,
                calculate_building=True,
            )
            state.history.append(observed_signal)
            state.last_observed_building = self._building_result(observed_signal)
            state.predictions = []
            for seconds in range(1, PREDICTION_SECONDS + 1):
                predicted = predict_observation(state.actuals, seconds)
                predicted_phase, predicted_score, predicted_assignment = self._phase_for_sample(
                    state,
                    predicted,
                    direction,
                    "provisional_predicted",
                    state.current_phase,
                )
                state.predictions.append(
                    self._signal_point(
                        icao24,
                        predicted,
                        predicted_phase,
                        predicted_score,
                        predicted_assignment,
                        "predicted",
                        seconds,
                        False,
                        source_observation_time=float(observation["timestamp"]),
                        building_obstruction=state.last_observed_building,
                    )
                )
            self._trim_and_normalize(state, float(observation["timestamp"]))
        else:
            state.predictions = []

    def _update_phase_actual(
        self,
        state: V2FlightState,
        point: dict[str, Any],
        direction: str,
        status: str,
    ) -> None:
        candidate, _ = classify_phase(point, direction)
        distance_nm = _finite(point.get("distance_nm"))
        if distance_nm is not None and distance_nm > 40.0:
            state.current_phase = "unknown"
            state.frequency_assignment_status = "outside_40_nm"
            state.pending_phase = "unknown"
            state.pending_count = 0
            state.unknown_actual_count = 0
            return
        if candidate == "ground_taxi":
            state.current_phase = candidate
            state.frequency_assignment_status = "current_phase_match"
            state.pending_phase = "unknown"
            state.pending_count = 0
            state.unknown_actual_count = 0
            return
        if candidate == "unknown":
            state.pending_phase = "unknown"
            state.pending_count = 0
            state.unknown_actual_count += 1
            if state.current_phase != "unknown" and state.unknown_actual_count < 2:
                state.frequency_assignment_status = "held_during_transition"
            else:
                state.current_phase = "unknown"
                state.frequency_assignment_status = "unavailable"
            return
        state.unknown_actual_count = 0
        if state.current_phase == "unknown" and status in {"probable", "confirmed"}:
            state.current_phase = candidate
            state.frequency_assignment_status = "current_phase_match"
            state.pending_phase = "unknown"
            state.pending_count = 0
            return
        if candidate == state.current_phase:
            state.frequency_assignment_status = "current_phase_match"
            state.pending_phase = "unknown"
            state.pending_count = 0
            return
        if candidate == state.pending_phase:
            state.pending_count += 1
        else:
            state.pending_phase = candidate
            state.pending_count = 1
        state.frequency_assignment_status = "held_during_transition"
        if state.pending_count >= 2:
            state.current_phase = candidate
            state.frequency_assignment_status = "current_phase_match"
            state.pending_phase = "unknown"
            state.pending_count = 0

    @staticmethod
    def _phase_for_sample(
        state: V2FlightState,
        point: dict[str, Any],
        direction: str,
        phase_status: str,
        stable_phase: str,
    ) -> tuple[str, float, str]:
        candidate, score = classify_phase(point, direction)
        distance_nm = _finite(point.get("distance_nm"))
        if distance_nm is not None and distance_nm > 40.0:
            return "unknown", 0.0, "outside_40_nm"
        if phase_status in {"provisional_predicted", "reconciled"} and candidate != "unknown":
            assignment = "provisional_phase_match" if phase_status == "provisional_predicted" else "reconciled_phase_match"
            return candidate, score, assignment
        if stable_phase != "unknown":
            return stable_phase, 0.8, "held_during_transition"
        if candidate != "unknown":
            return candidate, score, "current_phase_match"
        return "unknown", 0.0, "unavailable"

    def _signal_point(
        self,
        icao24: str,
        point: dict[str, Any],
        phase: str,
        phase_score: float,
        frequency_assignment_status: str,
        position_status: str,
        prediction_horizon_seconds: int,
        was_live_prediction: bool,
        source_observation_time: float | None = None,
        calculate_building: bool = False,
        building_obstruction: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        frequency_rule = PHASE_FREQUENCIES.get(phase)
        frequency = frequency_rule["frequency_mhz"] if frequency_rule else None
        altitude_m, altitude_status = _geometry_altitude(point)
        result: dict[str, Any] = {
            "icao24": icao24,
            "timestamp": float(point["timestamp"]),
            "position_status": position_status,
            "source_observation_time": source_observation_time or float(point["timestamp"]),
            "prediction_horizon_seconds": prediction_horizon_seconds,
            "was_live_prediction": was_live_prediction,
            "aircraft_lat": float(point["latitude"]),
            "aircraft_lon": float(point["longitude"]),
            "aircraft_altitude_m": altitude_m,
            "altitude_status": altitude_status,
            "heading_deg": _finite(point.get("heading_deg")),
            "speed_kt": _finite(point.get("speed_kt")),
            "vertical_fpm": _finite(point.get("vertical_fpm")),
            "inferred_phase": phase,
            "phase_confidence": phase_score,
            "most_likely_frequency_mhz": frequency,
            "frequency_assignment_status": frequency_assignment_status,
            "frequency_confidence": phase_score if frequency is not None else 0.0,
            "service": frequency_rule["service"] if frequency_rule else None,
            "facility_id": frequency_rule["facility_id"] if frequency_rule else None,
            "matched_rule_id": frequency_rule["rule_id"] if frequency_rule else None,
            "site_id": "LGA_REFERENCE_V2",
            "calculation_method": "fspl_plus_dominant_building_diffraction_v2",
        }
        if frequency is None or altitude_m is None:
            result.update(
                {
                    "slant_distance_km": None,
                    "fspl_db": None,
                    "building_data_status": "not_calculated",
                    "building_blocked": None,
                    "blocking_building_count": 0,
                    "building_loss_db": None,
                    "building_calculation_status": "not_calculated",
                    "building_source_observation_time": None,
                    "total_loss_db": None,
                    "total_loss_status": "phase_or_altitude_unavailable",
                }
            )
            return result
        horizontal_km = _haversine_km(LGA_LAT, LGA_LON, result["aircraft_lat"], result["aircraft_lon"])
        slant_km = math.sqrt(horizontal_km**2 + ((altitude_m - PROTOTYPE_ANTENNA_ALT_M) / 1000.0) ** 2)
        fspl_db = 32.45 + 20 * math.log10(max(slant_km, 0.001)) + 20 * math.log10(frequency)
        if calculate_building:
            obstruction = self.building_provider.obstruction(
                LGA_LAT,
                LGA_LON,
                PROTOTYPE_ANTENNA_ALT_M,
                result["aircraft_lat"],
                result["aircraft_lon"],
                altitude_m,
                frequency,
            )
            building_calculation_status = "observed_exact"
            building_source_time = float(point["timestamp"])
        elif building_obstruction is not None:
            obstruction = dict(building_obstruction)
            building_calculation_status = "held_from_latest_observation"
            building_source_time = _finite(obstruction.pop("building_source_observation_time", None))
        else:
            obstruction = NoBuildingProvider().obstruction(
                LGA_LAT,
                LGA_LON,
                PROTOTYPE_ANTENNA_ALT_M,
                result["aircraft_lat"],
                result["aircraft_lon"],
                altitude_m,
                frequency,
            )
            building_calculation_status = "unavailable"
            building_source_time = None
        building_loss = _finite(obstruction.get("building_loss_db"))
        result.update(obstruction)
        result["building_calculation_status"] = building_calculation_status
        result["building_source_observation_time"] = building_source_time
        result["slant_distance_km"] = slant_km
        result["fspl_db"] = fspl_db
        result["total_loss_db"] = fspl_db + building_loss if building_loss is not None else fspl_db
        if building_loss is None:
            result["total_loss_status"] = "fspl_only_building_unavailable"
        elif building_calculation_status == "held_from_latest_observation":
            result["total_loss_status"] = "complete_with_held_observed_building"
        else:
            result["total_loss_status"] = "complete"
        return result

    @staticmethod
    def _building_result(signal_point: dict[str, Any]) -> dict[str, Any] | None:
        if signal_point.get("building_calculation_status") != "observed_exact":
            return None
        result = {key: signal_point.get(key) for key in BUILDING_RESULT_FIELDS}
        result["building_source_observation_time"] = signal_point.get("building_source_observation_time")
        return result

    @staticmethod
    def _trim_and_normalize(state: V2FlightState, now: float) -> None:
        cutoff = now - HISTORY_SECONDS
        while state.history and float(state.history[0]["timestamp"]) < cutoff:
            state.history.popleft()
        combined = list(state.history) + list(state.predictions)
        flight_losses = [float(point["total_loss_db"]) for point in combined if point.get("total_loss_db") is not None]
        flight_min = min(flight_losses) if flight_losses else None
        segment = 0
        previous_phase: str | None = None
        segments: dict[int, list[dict[str, Any]]] = {}
        for point in combined:
            phase = str(point.get("inferred_phase") or "unknown")
            if phase != previous_phase:
                segment += 1
                previous_phase = phase
            point["phase_segment_id"] = f"{phase}:{segment}"
            segments.setdefault(segment, []).append(point)
        for points in segments.values():
            losses = [float(point["total_loss_db"]) for point in points if point.get("total_loss_db") is not None]
            phase_min = min(losses) if losses else None
            for point in points:
                loss = _finite(point.get("total_loss_db"))
                if loss is None or phase_min is None:
                    point["relative_signal_phase_db"] = None
                    point["relative_power_phase_percent"] = None
                else:
                    relative = phase_min - loss
                    point["relative_signal_phase_db"] = relative
                    point["relative_power_phase_percent"] = 100 * 10 ** (relative / 10)
                if loss is None or flight_min is None:
                    point["relative_signal_flight_db"] = None
                    point["relative_power_flight_percent"] = None
                else:
                    relative_flight = flight_min - loss
                    point["relative_signal_flight_db"] = relative_flight
                    point["relative_power_flight_percent"] = 100 * 10 ** (relative_flight / 10)

    def snapshot(self, icao24: str, now: float | None = None) -> dict[str, Any] | None:
        state = self.states.get(icao24)
        if not state or not state.history:
            return None
        now = now or time.time()
        candidates = [point for point in state.predictions if float(point["timestamp"]) <= now]
        current = candidates[-1] if candidates else state.history[-1]
        return {
            "version": 2,
            "generated_at": now,
            "current": dict(current),
            "predicted_timeline": [dict(point) for point in state.predictions],
            "finalized_through": float(state.history[-1]["timestamp"]),
            "building_source": self.building_provider.source_name,
        }

    def history(self, icao24: str, since: float | None = None) -> dict[str, Any] | None:
        state = self.states.get(icao24)
        if not state:
            return None
        threshold = float(since) if since is not None else float("-inf")
        points = [dict(point) for point in state.history if float(point["timestamp"]) > threshold]
        return {
            "version": 2,
            "icao24": icao24,
            "since": since,
            "finalized_through": float(state.history[-1]["timestamp"]) if state.history else None,
            "points": points,
        }

    def expire(self, active_icao24: set[str]) -> None:
        for icao24 in list(self.states):
            if icao24 not in active_icao24:
                del self.states[icao24]
