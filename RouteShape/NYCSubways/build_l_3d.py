import json, math, csv, time, urllib.request

FT2M = 0.3048

# --- load route line (already WGS84, ordered 8 Av -> Canarsie) ---
route = json.load(open('Subway_L_official.geojson', encoding='utf-8'))
line = route['features'][0]['geometry']['coordinates']  # [ [lon,lat], ... ]

# --- load L station coords from the master stations file ---
allst = json.load(open('AllSubwayStations_20260716.geojson', encoding='utf-8'))
stations = []
for f in allst['features']:
    p = f['properties']
    trains = [t.strip() for t in p['trains'].replace(' ', ',').split(',') if t]
    if 'L' in trains:
        stations.append({'name': p['stop_name'], 'lat': p['stop_lat'], 'lon': p['stop_lon']})

# --- fetch real ground-surface elevation from USGS EPQS (feet) ---
for s in stations:
    url = f"https://epqs.nationalmap.gov/v1/json?x={s['lon']}&y={s['lat']}&units=Feet&wkid=4326&includeDate=false"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'research-script'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                s['surface_ft'] = json.load(resp)['value']
            break
        except Exception:
            time.sleep(1)
    else:
        raise RuntimeError(f"elevation fetch failed for {s['name']}")
    time.sleep(0.15)

# structure classification, documented from BMT Canarsie Line Wikipedia article (fetched this session):
# underground / transition (Wilson Av, double-decked) / elevated / elevated_tapering / at_grade
STRUCTURE = {
    '8 Av': 'underground', '6 Av': 'underground', 'Union Sq - 14 St': 'underground',
    '3 Av': 'underground', '1 Av': 'underground', 'Bedford Av': 'underground',
    'Lorimer St': 'underground', 'Graham Av': 'underground', 'Grand St': 'underground',
    'Montrose Av': 'underground', 'Morgan Av': 'underground', 'Jefferson St': 'underground',
    'DeKalb Av': 'underground', 'Myrtle - Wyckoff Avs': 'underground', 'Halsey St': 'underground',
    'Wilson Av': 'transition',
    'Bushwick Av - Aberdeen St': 'elevated', 'Broadway Jct': 'elevated',
    'Atlantic Av': 'elevated_tapering', 'Sutter Av': 'elevated_tapering',
    'Livonia Av': 'elevated_tapering', 'New Lots Av': 'elevated_tapering',
    'E 105 St': 'at_grade', 'Canarsie - Rockaway Pkwy': 'at_grade',
}

# depth_offset_m: positive = below surface (underground), negative = above surface (elevated)
# Anchors are representative engineering-scale approximations (not per-station documented
# values -- MTA does not publish as-built track profiles):
#  - shallow cut-and-cover underground ~ 9-10 m
#  - East River tube (1 Av / Bedford Av) needs clearance below the riverbed -> deepest, ~20 m
#  - standard NYC elevated structure clearance ~ 8 m above street
ANCHOR_DEPTH_M = {
    '8 Av': 9, '6 Av': 10, 'Union Sq - 14 St': 9, '3 Av': 9,
    '1 Av': 20, 'Bedford Av': 20,
    'Lorimer St': 8, 'Graham Av': 7, 'Grand St': 7, 'Montrose Av': 6, 'Morgan Av': 6,
    'Jefferson St': 5, 'DeKalb Av': 5, 'Myrtle - Wyckoff Avs': 4, 'Halsey St': 2,
    'Wilson Av': 0,
    'Bushwick Av - Aberdeen St': -8, 'Broadway Jct': -8,
    'Atlantic Av': -7, 'Sutter Av': -5, 'Livonia Av': -3, 'New Lots Av': -1,
    'E 105 St': 0, 'Canarsie - Rockaway Pkwy': 0,
}

def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlmb/2)**2
    return 2*R*math.asin(math.sqrt(a))

# cumulative distance along route line
cum = [0.0]
for i in range(1, len(line)):
    cum.append(cum[-1] + haversine_m(line[i-1][0], line[i-1][1], line[i][0], line[i][1]))
total_len = cum[-1]

# project each station onto the line: nearest vertex -> use that vertex's cumulative distance
def nearest_vertex_dist(lon, lat):
    best_i, best_d = 0, float('inf')
    for i, (vlon, vlat) in enumerate(line):
        d = haversine_m(lon, lat, vlon, vlat)
        if d < best_d:
            best_d, best_i = d, i
    return cum[best_i], best_d

for s in stations:
    d, snap = nearest_vertex_dist(s['lon'], s['lat'])
    s['dist_m'] = d
    s['snap_err_m'] = snap
    s['structure'] = STRUCTURE[s['name']]
    s['depth_offset_m'] = ANCHOR_DEPTH_M[s['name']]
    s['surface_m'] = s['surface_ft'] * FT2M

stations.sort(key=lambda s: s['dist_m'])
print('max snap error (m):', max(s['snap_err_m'] for s in stations))

anchor_dist = [s['dist_m'] for s in stations]
anchor_depth = [s['depth_offset_m'] for s in stations]
anchor_surface = [s['surface_m'] for s in stations]

def interp(x, xs, ys):
    if x <= xs[0]: return ys[0]
    if x >= xs[-1]: return ys[-1]
    for i in range(1, len(xs)):
        if x <= xs[i]:
            t = (x - xs[i-1]) / (xs[i] - xs[i-1])
            return ys[i-1] + t * (ys[i] - ys[i-1])
    return ys[-1]

# build 3D route line
line3d = []
for i, (lon, lat) in enumerate(line):
    d = cum[i]
    surf = interp(d, anchor_dist, anchor_surface)
    depth = interp(d, anchor_dist, anchor_depth)
    track_z = surf - depth
    line3d.append([lon, lat, round(track_z, 2)])

# build station points 3D
station_points = []
for s in stations:
    track_z = s['surface_m'] - s['depth_offset_m']
    station_points.append({
        'type': 'Feature',
        'properties': {
            'station': s['name'],
            'structure_type': s['structure'],
            'surface_elevation_m': round(s['surface_m'], 2),
            'depth_below_surface_m': s['depth_offset_m'],
            'track_elevation_m': round(track_z, 2),
            'track_elevation_ft': round(track_z / FT2M, 1),
            'dist_along_route_m': round(s['dist_m'], 1),
        },
        'geometry': {
            'type': 'Point',
            'coordinates': [s['lon'], s['lat'], round(track_z, 2)]
        }
    })

fc = {
    'type': 'FeatureCollection',
    'properties': {
        'description': 'L train (BMT Canarsie Line) route and stations with representative track elevation (z, meters).',
        'method': (
            'Surface elevation from USGS 3DEP DEM (EPQS API) at each station. '
            'Structure type (underground/elevated/at-grade/transition) from the BMT Canarsie Line '
            'Wikipedia article. Track depth/height relative to surface uses representative '
            'engineering-scale approximations (shallow cut-and-cover ~9-10m, East River tube '
            'clearance ~20m at 1 Av/Bedford Av, standard elevated structure clearance ~8m) since '
            'MTA does not publish as-built track profiles. Depth is linearly interpolated along the '
            'route between stations by distance -- for visual representation only, not surveyed data.'
        ),
        'z_units': 'meters',
        'generated': '2026-07-21',
    },
    'features': [
        {
            'type': 'Feature',
            'properties': {
                'route_id': 'L',
                'route_long': '14 St-Canarsie Local',
                'color': 'A7A9AC',
                'direction': '8 Av -> Canarsie-Rockaway Pkwy',
            },
            'geometry': {
                'type': 'LineString',
                'coordinates': line3d
            }
        },
    ] + station_points
}

out_path = 'Subway_L_3D.geojson'
json.dump(fc, open(out_path, 'w', encoding='utf-8'), indent=1)
print('wrote', out_path, 'route pts:', len(line3d), 'stations:', len(station_points))
