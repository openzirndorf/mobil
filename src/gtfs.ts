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

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const IDB_NAME = "trafficmap-v2";
const IDB_STORE = "gtfs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => resolve(null);
  });
}

function idbSet(db: IDBDatabase, key: string, data: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(data, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Partial types for split files ─────────────────────────────────────────────

interface GtfsStopsFile {
  generated: string;
  stopsByVgnId: GtfsData["stopsByVgnId"];
  lineInfo: GtfsData["lineInfo"];
}

interface GtfsRoutesFile {
  generated: string;
  routeShapes: GtfsData["routeShapes"];
}

// ── Stale-while-revalidate fetch helper ───────────────────────────────────────

async function swrFetch<T extends { generated: string }>(
  db: IDBDatabase | null,
  idbKey: string,
  url: string,
  onFresh: (data: T) => void,
): Promise<T> {
  const cached = db ? await idbGet<T>(db, idbKey) : null;

  const networkFetch = fetch(url)
    .then((r) => r.json() as Promise<T>)
    .then(async (fresh) => {
      if (db && fresh.generated !== cached?.generated) {
        await idbSet(db, idbKey, fresh).catch(() => {});
      }
      return fresh;
    });

  if (cached) {
    networkFetch.then((fresh) => {
      if (fresh.generated !== cached.generated) onFresh(fresh);
    }).catch(() => {});
    return cached;
  }

  return networkFetch;
}

// ── Loader (progressive: stops first, routes in background) ──────────────────

let _cache: GtfsData | null = null;

export async function loadGtfsData(onPartial?: (data: GtfsData) => void): Promise<GtfsData> {
  if (_cache) return _cache;

  let db: IDBDatabase | null = null;
  try { db = await openDb(); } catch { /* IDB unavailable (private mode etc.) */ }

  // Load stops file immediately (small – ~50 KB)
  const stops = await swrFetch<GtfsStopsFile>(db, "stops", "/gtfs_stops.json", (fresh) => {
    if (_cache) _cache = { ..._cache, ...fresh };
  });

  // Return partial data to caller so map can render stop markers right away
  const partial: GtfsData = { ...stops, routeShapes: {} };
  _cache = partial;
  onPartial?.(partial);

  // Load routes file in parallel (large – ~960 KB, from IDB if cached)
  const routes = await swrFetch<GtfsRoutesFile>(db, "routes", "/gtfs_routes.json", (fresh) => {
    if (_cache) { _cache = { ..._cache, ...fresh }; onPartial?.(_cache); }
  });

  _cache = { ...stops, ...routes };
  return _cache;
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
