/** Loads and queries the pre-processed GTFS data bundle */

export interface GtfsStop {
  name: string;
  lat: number;
  lng: number;
}

export interface GtfsLineInfo {
  name: string;
  type: number; // GTFS route_type: 1=subway, 2=rail, 3=bus, etc.
  desc: string;
}

export interface GtfsRouteShape {
  line: string;
  direction: string;
  headsign: string;
  /** Full OSRM-routed polyline [lat, lng][] */
  coords: [number, number][];
  /** Stop positions [lat, lng][] in order */
  stopCoords: [number, number][];
  stopNames?: string[];
  stopTimes?: number[]; // seconds from midnight per stop, parallel to stopCoords
  /** Departure times + headsigns per day (0=Sun…6=Sat), each sorted ascending by dep */
  tripDepartures?: Array<Array<{ dep: number; headsign: string }>>;
}

export interface GtfsData {
  generated: string;
  stopsByVgnId: Record<string, GtfsStop>;
  lineInfo: Record<string, GtfsLineInfo>;
  routeShapes: Record<string, GtfsRouteShape>;
}

let _cache: GtfsData | null = null;

export async function loadGtfsData(): Promise<GtfsData> {
  if (_cache) return _cache;
  const res = await fetch("/gtfs_data.json", { cache: "no-cache" });
  _cache = await res.json();
  return _cache!;
}

// ── Shape matching ────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9äöü]/g, "");
}

/** Find the best pre-computed shape for a given line + richtungstext */
export function matchShape(
  line: string,
  richtungstext: string,
  data: GtfsData
): GtfsRouteShape | null {
  const candidates = Object.values(data.routeShapes).filter(
    (s) => s.line === line
  );
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const target = normalize(richtungstext);
  let best = candidates[0];
  let bestScore = -1;

  for (const c of candidates) {
    const h = normalize(c.headsign);
    // Score: character overlap between headsign and richtungstext
    let score = 0;
    for (const ch of target) if (h.includes(ch)) score++;
    score /= Math.max(target.length, 1);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ── Stop-to-shape mapping ─────────────────────────────────────────────────────

/** Euclidean distance² in degrees (good enough for nearby stops) */
function dist2(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return (lat1 - lat2) ** 2 + (lng1 - lng2) ** 2;
}

/**
 * Given a canonical shape and a PULS stop sequence, map each PULS stop
 * to the nearest index in shape.stopCoords.
 * Returns an array of shape-stop-indices parallel to pulsStops.
 */
export function mapPulsStopsToShape(
  pulsStops: Array<{ lat: number; lng: number }>,
  shape: GtfsRouteShape
): number[] {
  return pulsStops.map((ps) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < shape.stopCoords.length; i++) {
      const d = dist2(ps.lat, ps.lng, shape.stopCoords[i][0], shape.stopCoords[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  });
}

/**
 * Extract the portion of shape.coords between two shape-stop indices.
 * shapeStopIndices are the result of mapPulsStopsToShape.
 */
export function shapeSegment(
  shape: GtfsRouteShape,
  coordsPerStop: number[][],
  fromStopIdx: number,
  toStopIdx: number
): [number, number][] {
  const startCoordIdx = coordsPerStop[fromStopIdx]?.[0] ?? 0;
  const endCoordIdx = coordsPerStop[toStopIdx]?.[0] ?? shape.coords.length - 1;
  return shape.coords.slice(startCoordIdx, endCoordIdx + 1);
}

/**
 * Pre-compute for each shape-stop-index, the range [firstCoordIdx, lastCoordIdx]
 * in shape.coords that "belongs" to that stop.
 *
 * Strategy: for each stopCoord, find the closest coord index, then assign
 * coord ranges between consecutive stops.
 */
export function buildCoordRanges(shape: GtfsRouteShape): number[] {
  // Returns: for each stop index, the index in coords where that stop is closest
  return shape.stopCoords.map(([lat, lng]) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < shape.coords.length; i++) {
      const d = dist2(lat, lng, shape.coords[i][0], shape.coords[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  });
}
