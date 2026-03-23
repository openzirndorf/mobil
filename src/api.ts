import type {
  AbfahrtRaw,
  FahrtHaltRaw,
  HaltestelleRaw,
  Stop,
  TripStop,
  Bus,
} from "./types";
import type { GtfsData } from "./gtfs";

const BASE = "https://start.vag.de/dm/api";
// foot profile allows bus-only / pedestrian streets that driving ignores
const OSRM = "https://router.project-osrm.org/route/v1/driving";

// ── OSRM road segments cache ──────────────────────────────────────────────────
// tripId → array of per-stop-pair coords: segments[i] = coords from stop[i] to stop[i+1]
const segmentCache = new Map<number, [number, number][][]>();

export function evictSegmentCache(tripId: number): void {
  segmentCache.delete(tripId);
}

// Via-point corrections for stop pairs where OSRM car routing takes the wrong road.
// Keyed by "stopA.name→stopB.name" (names from PULS API).
// Die echten Haltestellennamen aus der PULS-API nach Regex-Processing
// (h.Haltestellenname.replace(/ \(Lkr\.FÜ\).*/, "").trim()):
//   "Landratsamt (Zirndorf (Lkr.FÜ))"  → "Landratsamt (Zirndorf"
//   "Am Grasweg (Zirndorf (Lkr.FÜ))"   → "Am Grasweg (Zirndorf"
// Die alten Keys mit "Zirndorf X"-Format haben nie gegriffen!
const OSRM_VIA: Record<string, Array<{ lat: number; lng: number }>> = {
  // Vogelherdstr-Korridor (Linien 70, 72, N8):
  // Busse fahren durch Vogelherdstr; OSRM car routing nähme sonst Schwabacher Str.
  // Via-Punkt auf dem bidirektionalen Südabschnitt von Vogelherdstr (OSM way 23156774).
  "Landratsamt (Zirndorf→Am Grasweg (Zirndorf":   [{ lat: 49.440382, lng: 10.951868 }],
  "Am Grasweg (Zirndorf→Landratsamt (Zirndorf":   [{ lat: 49.440382, lng: 10.951868 }],
  // Marktplatz↔Landratsamt: kein Via-Punkt nötig – OSRM findet direkt die korrekte
  // Route via Schwabacher Str (533m/521m, lat 49.439–49.442).
  // Linie 70 Frühlingsmarkt-Umleitung dir=0: Kraftstr → Albert-Einstein-Str → Landratsamt
  "Kraftstr. (Zirndorf→Landratsamt (Zirndorf":    [{ lat: 49.44437, lng: 10.95142 }],
  // Linie 70 Frühlingsmarkt-Umleitung dir=1: Landratsamt → Brücknerstr (südl. Bypass)
  "Landratsamt (Zirndorf→Brücknerstr. (Zirndorf": [{ lat: 49.43986, lng: 10.95803 }],
};

export async function fetchRoadSegments(
  tripId: number,
  stops: TripStop[]
): Promise<[number, number][][]> {
  if (segmentCache.has(tripId)) return segmentCache.get(tripId)!;

  // Fetch all segments in parallel
  const results = await Promise.allSettled(
    stops.slice(0, -1).map((a, i) => {
      const b = stops[i + 1];
      const via = OSRM_VIA[`${a.name}→${b.name}`] ?? [];
      const waypoints = [a, ...via, b].map(w => `${w.lng},${w.lat}`).join(";");
      return fetch(
        `${OSRM}/${waypoints}?overview=full&geometries=geojson`
      )
        .then((r) => r.json())
        .then((d) =>
          (d.routes[0].geometry.coordinates as [number, number][]).map(
            ([lng, lat]) => [lat, lng] as [number, number]
          )
        );
    })
  );

  const segments: [number, number][][] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : [[stops[i].lat, stops[i].lng], [stops[i + 1].lat, stops[i + 1].lng]]
  );

  segmentCache.set(tripId, segments);
  return segments;
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
function fetchT(url: string, ms = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDate(s: string | undefined): Date | null {
  return s ? new Date(s) : null;
}

function betriebstagNow(): string {
  const now = new Date();
  if (now.getHours() < 3) now.setDate(now.getDate() - 1);
  return now.toISOString().slice(0, 10);
}

// ── API calls ─────────────────────────────────────────────────────────────────

// Alle Gemeindeteile + umliegende Orte für vollständige Erfassung
const STOP_AREAS = [
  "Zirndorf", "Anwanden", "Banderbach", "Bronnamberg",
  "Leichendorf", "Lind", "Weiherhof", "Weinzierlein",
  "Wintersdorf", "Wolfgangshof", "Alte Veste", "Oberasbach",
];

// Bounding-Box des Zirndorfer Gemeindegebiets
const ZIRNDORF_BBOX = { latMin: 49.38, latMax: 49.49, lngMin: 10.87, lngMax: 11.01 };

export function stopInZirndorf(lat: number, lng: number): boolean {
  return lat >= ZIRNDORF_BBOX.latMin && lat <= ZIRNDORF_BBOX.latMax
    && lng >= ZIRNDORF_BBOX.lngMin && lng <= ZIRNDORF_BBOX.lngMax;
}

export async function fetchZirndorfStops(): Promise<Stop[]> {
  const results = await Promise.allSettled(
    STOP_AREAS.map((name) =>
      fetchT(`${BASE}/haltestellen.json/vgn?name=${encodeURIComponent(name)}`).then((r) => r.json())
    )
  );
  const seen = new Set<number>();
  const stops: Stop[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const h of (r.value.Haltestellen ?? []) as HaltestelleRaw[]) {
      if (!h.Produkte) continue; // Stops ohne Produkt überspringen
      if (seen.has(h.VGNKennung)) continue;
      seen.add(h.VGNKennung);
      stops.push({
        name: h.Haltestellenname.replace(/ \(Lkr\.FÜ\).*/, "").trim(),
        vgnId: h.VGNKennung,
        vagId: h.VAGKennung,
        lat: h.Latitude,
        lng: h.Longitude,
      });
    }
  }
  return stops;
}

export async function fetchStopDepartures(vgnId: number): Promise<{
  stopName: string;
  departures: Array<{
    line: string; direction: string; scheduledTime: Date; actualTime: Date;
    delayMin: number; product: string; prognose: boolean;
  }>;
}> {
  const res = await fetch(
    `${BASE}/abfahrten.json/vgn/${vgnId}?timespan=90`
  );
  const data = await res.json();
  return {
    stopName: data.Haltestellenname ?? "",
    departures: (data.Abfahrten ?? []).map((a: AbfahrtRaw) => {
      const soll = new Date(a.AbfahrtszeitSoll);
      const ist  = new Date(a.AbfahrtszeitIst);
      return {
        line: a.Linienname,
        direction: a.Richtungstext,
        scheduledTime: soll,
        actualTime: ist,
        delayMin: Math.round((ist.getTime() - soll.getTime()) / 60000),
        product: a.Produkt,
        prognose: a.Prognose,
      };
    }),
  };
}

interface TripInfo {
  betriebstag: string;
  produkt: string;
  line: string;
  direction: string;
  /** Alle bekannten Haltestellen dieses Trips aus unseren Stop-Abfragen */
  knownStops: Array<{ name: string; lat: number; lng: number; departureSoll: Date; departureIst: Date }>;
}

export async function fetchActiveTripIds(stops: Stop[]): Promise<Map<number, TripInfo>> {
  const results = await Promise.allSettled(
    stops.map((s) =>
      fetchT(`${BASE}/abfahrten.json/vgn/${s.vgnId}?timeoffset=-30&timespan=90`)
        .then((r) => r.json())
        .then((data) => ({ stop: s, abfahrten: (data.Abfahrten ?? []) as AbfahrtRaw[] }))
    )
  );

  const tripMap = new Map<number, TripInfo>();
  const linesSeen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { stop, abfahrten } = r.value;
    for (const a of abfahrten) {
      linesSeen.add(`${a.Produkt}:${a.Linienname}`);
      const ks = {
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        departureSoll: new Date(a.AbfahrtszeitSoll),
        departureIst: new Date(a.AbfahrtszeitIst),
      };
      const existing = tripMap.get(a.Fahrtnummer);
      if (existing) {
        // Nur hinzufügen wenn dieser Stop noch nicht bekannt
        if (!existing.knownStops.some((s) => s.lat === stop.lat && s.lng === stop.lng)) {
          existing.knownStops.push(ks);
        }
      } else {
        tripMap.set(a.Fahrtnummer, {
          betriebstag: a.Betriebstag,
          produkt: a.Produkt,
          line: a.Linienname,
          direction: a.Richtungstext,
          knownStops: [ks],
        });
      }
    }
  }
  console.log(`[tripMap] ${tripMap.size} trips, lines seen:`, [...linesSeen].sort().join(", "));
  return tripMap;
}

async function fetchTripRoute(
  tripId: number,
  betriebstag: string,
  produkt: string
): Promise<{ line: string; direction: string; vehicleId: string; stops: TripStop[] } | null> {
  try {
    const res = await fetchT(
      `${BASE}/v1/fahrten.json/${produkt}/${tripId}?betriebstag=${betriebstag}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.Fahrtverlauf?.length) return null;

    const stops: TripStop[] = (data.Fahrtverlauf as FahrtHaltRaw[]).map(
      (h) => ({
        name: h.Haltestellenname.replace(/ \(Lkr\.FÜ\).*/, "").trim(),
        lat: h.Latitude,
        lng: h.Longitude,
        arrivalIst: parseDate(h.AnkunftszeitIst),
        departureIst: parseDate(h.AbfahrtszeitIst),
        arrivalSoll: parseDate(h.AnkunftszeitSoll),
        departureSoll: parseDate(h.AbfahrtszeitSoll),
      })
    );

    return { line: data.Linienname, direction: data.Richtungstext, vehicleId: data.Fahrzeugnummer, stops };
  } catch {
    return null;
  }
}

// ── Position interpolation (stop-based, segment tracking) ────────────────────

function interpolatePosition(
  stops: TripStop[],
  now: Date
): {
  lat: number; lng: number;
  segmentIndex: number; segmentT: number;
  prevStop: string | null; nextStop: string | null;
  delayMinutes: number;
} | null {
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    // Ist-Zeit bevorzugt, Soll-Zeit als Fallback (zeigt auch Busse ohne Echtzeit-Daten)
    const departedA = a.departureIst ?? a.arrivalIst ?? a.departureSoll ?? a.arrivalSoll;
    const arrivedB = b.arrivalIst ?? b.departureSoll ?? b.arrivalSoll;
    if (!departedA || !arrivedB) continue;

    // Verweilzeit: Bus erscheint 5s vor Abfahrt an der Haltestelle
    const dwellMs = 5_000;
    const windowStart = new Date(departedA.getTime() - dwellMs);

    if (now >= windowStart && now <= arrivedB) {
      const total = arrivedB.getTime() - departedA.getTime();
      // Während Verweilzeit (vor departedA): t=0 → Bus steht an Haltestelle A
      const elapsed = Math.max(0, now.getTime() - departedA.getTime());
      const t = total > 0 ? Math.min(elapsed / total, 1) : 0;
      const soll = a.departureSoll ?? a.arrivalSoll;
      const delay = soll ? Math.round((departedA.getTime() - soll.getTime()) / 60000) : 0;

      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        segmentIndex: i,
        segmentT: t,
        prevStop: a.name,
        nextStop: b.name,
        delayMinutes: delay,
      };
    }
  }

  const last = stops[stops.length - 1];
  const lastTime = last.arrivalIst ?? last.departureSoll;
  if (lastTime && now >= lastTime && now.getTime() - lastTime.getTime() < 120_000) {
    return {
      lat: last.lat, lng: last.lng,
      segmentIndex: stops.length - 2,
      segmentT: 1,
      prevStop: last.name, nextStop: null,
      delayMinutes: 0,
    };
  }

  // Bus approaching first stop (within 30 min before departure)
  const first = stops[0];
  const firstDep = first.departureSoll ?? first.departureIst;
  if (firstDep && now < firstDep && firstDep.getTime() - now.getTime() < 7 * 60_000) {
    return {
      lat: first.lat, lng: first.lng,
      segmentIndex: 0, segmentT: 0,
      prevStop: null, nextStop: first.name,
      delayMinutes: 0,
    };
  }

  return null;
}

// ── GTFS trip reconstruction ───────────────────────────────────────────────────

function nearestShapeStopIdx(stopCoords: [number, number][], lat: number, lng: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < stopCoords.length; i++) {
    const d = (lat - stopCoords[i][0]) ** 2 + (lng - stopCoords[i][1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ── Schedule-only lines (DB-operated, not in VAG PULS API) ───────────────────
const SCHEDULE_ONLY_LINES = new Set(["S4", "RB11", "RB 11"]);

// ── DB REST API – real-time delays for S-Bahn / regional trains ───────────────
const DB_REST = "https://v6.db.transport.rest";

// Stop ID cache: "lat2,lng2" → HAFAS stop ID (permanent)
const dbStopIdCache = new Map<string, string | null>();

async function lookupDbStopId(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (dbStopIdCache.has(key)) return dbStopIdCache.get(key)!;
  try {
    const res = await fetch(
      `${DB_REST}/stops/nearby?latitude=${lat}&longitude=${lng}&results=3&distance=600`
    );
    const data = await res.json() as Array<{ id: string }>;
    const id = data?.[0]?.id ?? null;
    dbStopIdCache.set(key, id);
    return id;
  } catch {
    dbStopIdCache.set(key, null);
    return null;
  }
}

// Delay cache: "stopId|lineNorm|plannedMin" → { delayMin, ts }
const dbDelayCache = new Map<string, { delayMin: number; ts: number }>();

async function fetchDbDelay(stopId: string, line: string, plannedDep: Date): Promise<number> {
  const lineNorm = line.replace(/\s+/g, "").toUpperCase();
  const key = `${stopId}|${lineNorm}|${Math.floor(plannedDep.getTime() / 60000)}`;
  const cached = dbDelayCache.get(key);
  if (cached && Date.now() - cached.ts < 4 * 60 * 1000) return cached.delayMin;
  try {
    const res = await fetch(
      `${DB_REST}/stops/${stopId}/departures?when=${plannedDep.toISOString()}&duration=12&results=40`
    );
    const data = await res.json() as {
      departures?: Array<{ line?: { name?: string }; plannedWhen?: string; delay?: number }>;
    };
    const match = data.departures?.find((d) => {
      const n = (d.line?.name ?? "").replace(/\s+/g, "").toUpperCase();
      if (n !== lineNorm) return false;
      if (!d.plannedWhen) return false;
      return Math.abs(new Date(d.plannedWhen).getTime() - plannedDep.getTime()) < 4 * 60 * 1000;
    });
    const delayMin = match?.delay != null ? Math.round(match.delay / 60) : 0;
    dbDelayCache.set(key, { delayMin, ts: Date.now() });
    return delayMin;
  } catch {
    return 0;
  }
}

function stableHash32(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

async function findScheduledBuses(gtfs: GtfsData, now: Date): Promise<Bus[]> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const nowSec = (now.getTime() - midnight.getTime()) / 1000;
  const dayOfWeek = now.getDay(); // 0=Sun … 6=Sat

  const buses: Bus[] = [];

  for (const [shapeKey, shape] of Object.entries(gtfs.routeShapes)) {
    if (!SCHEDULE_ONLY_LINES.has(shape.line)) continue;
    if (!shape.tripDepartures || !shape.stopTimes?.length) continue;

    const deps = shape.tripDepartures[dayOfWeek];
    if (!deps?.length) continue;

    const firstSec = shape.stopTimes[0];
    const lastSec = shape.stopTimes[shape.stopTimes.length - 1];
    const duration = lastSec - firstSec;

    // First stop within the Zirndorf area (to anchor the pre-departure window)
    const firstZirndorfIdx = shape.stopCoords.findIndex(([lat, lng]) => stopInZirndorf(lat, lng));
    if (firstZirndorfIdx === -1) continue;
    const firstZirndorfSec = shape.stopTimes![firstZirndorfIdx];

    for (const entry of deps) {
      const dep = entry.dep;
      const offset = dep - firstSec;
      // Window: up to 5 min before train reaches Zirndorf area, until trip ends + 2 min
      const firstZirndorfActual = firstZirndorfSec + offset;
      if (nowSec < firstZirndorfActual - 5 * 60 || nowSec > dep + duration + 120) continue;

      const allStops: TripStop[] = shape.stopCoords.map(([lat, lng], i) => {
        const soll = new Date(midnight.getTime() + (shape.stopTimes![i] + offset) * 1000);
        return {
          name: shape.stopNames?.[i] ?? "",
          lat, lng,
          arrivalIst: null,
          departureIst: soll,
          arrivalSoll: null,
          departureSoll: soll,
        };
      });

      // Clip to actual trip terminus when headsign differs from canonical shape
      let stops = allStops;
      if (entry.headsign && entry.headsign !== shape.headsign && shape.stopNames?.length) {
        const normHS = entry.headsign.toLowerCase().replace(/[\s()\-.,/]/g, "");
        for (let i = shape.stopNames.length - 1; i > 0; i--) {
          const normName = shape.stopNames[i].toLowerCase().replace(/[\s()\-.,/]/g, "");
          if (normName.startsWith(normHS.slice(0, 6)) || normHS.startsWith(normName.slice(0, 6))) {
            stops = allStops.slice(0, i + 1);
            break;
          }
        }
      }

      const pos = interpolatePosition(stops, now);
      // Negative synthetic tripId to avoid collision with real VAG IDs
      const tripId = -(Math.abs(stableHash32(shapeKey + String(dep))) % 2_000_000 + 1);

      buses.push({
        tripId,
        line: shape.line,
        direction: entry.headsign || shape.headsign,
        vehicleId: "",
        betriebstag: midnight.toISOString().slice(0, 10),
        stops,
        position: pos ? { lat: pos.lat, lng: pos.lng } : null,
        delayMinutes: 0,
        prevStop: pos?.prevStop ?? null,
        nextStop: pos?.nextStop ?? null,
        segmentIndex: pos?.segmentIndex ?? 0,
        segmentT: pos?.segmentT ?? 0,
        bearing: 270,
      });
    }
  }

  return buses.filter((b) => b.position !== null);
}

// ── Delay enrichment (off critical path) ──────────────────────────────────────

export async function enrichBusDelays(buses: Bus[]): Promise<Bus[]> {
  const now = new Date();
  return Promise.all(buses.map(async (bus) => {
    const refStop =
      bus.stops.find((s) => stopInZirndorf(s.lat, s.lng) && s.departureSoll != null && s.departureSoll >= now) ??
      bus.stops.find((s) => stopInZirndorf(s.lat, s.lng)) ??
      bus.stops[0];

    const refDep = refStop?.departureSoll ?? refStop?.arrivalSoll;
    if (!refDep) return bus;

    const stopId = await lookupDbStopId(refStop.lat, refStop.lng);
    if (!stopId) return bus;

    const delayMin = await fetchDbDelay(stopId, bus.line, refDep);
    if (delayMin === 0) return bus;

    const delayMs = delayMin * 60 * 1000;
    const shiftedStops: TripStop[] = bus.stops.map((s) => ({
      ...s,
      departureIst: s.departureSoll ? new Date(s.departureSoll.getTime() + delayMs) : null,
      arrivalIst: s.arrivalSoll ? new Date(s.arrivalSoll.getTime() + delayMs) : null,
    }));
    const pos = interpolatePosition(shiftedStops, now);
    return {
      ...bus,
      stops: shiftedStops,
      delayMinutes: delayMin,
      position: pos ? { lat: pos.lat, lng: pos.lng } : bus.position,
      prevStop: pos?.prevStop ?? bus.prevStop,
      nextStop: pos?.nextStop ?? bus.nextStop,
      segmentIndex: pos?.segmentIndex ?? bus.segmentIndex,
      segmentT: pos?.segmentT ?? bus.segmentT,
    };
  }));
}

function rebuildTripFromGtfs(
  info: { line: string; direction: string; knownStops: Array<{ name: string; lat: number; lng: number; departureSoll: Date; departureIst: Date }> },
  gtfs: GtfsData
): { line: string; direction: string; vehicleId: string; stops: TripStop[] } | null {
  const candidates = Object.values(gtfs.routeShapes).filter((s) => s.line === info.line);
  if (!candidates.length) return null;

  // Sort knownStops by departure time (API responses arrive out of order)
  const sortedKnown = [...info.knownStops].sort(
    (a, b) => a.departureSoll.getTime() - b.departureSoll.getTime()
  );

  // Pick best direction: text similarity (Richtungstext vs headsign) + geographic ordering bonus
  let shape = candidates[0];
  if (candidates.length > 1) {
    const target = info.direction.toLowerCase().replace(/[^a-z0-9äöü]/g, "");
    let bestScore = -1;
    for (const c of candidates) {
      const h = c.headsign.toLowerCase().replace(/[^a-z0-9äöü]/g, "");
      let score = 0;
      for (const ch of target) if (h.includes(ch)) score++;
      score /= Math.max(target.length, 1);
      // Geographic bonus: earliest known stop should appear before latest in the shape
      if (sortedKnown.length >= 2) {
        const fi = nearestShapeStopIdx(c.stopCoords, sortedKnown[0].lat, sortedKnown[0].lng);
        const li = nearestShapeStopIdx(c.stopCoords, sortedKnown[sortedKnown.length - 1].lat, sortedKnown[sortedKnown.length - 1].lng);
        if (fi < li) score += 10;
      }
      if (score > bestScore) { bestScore = score; shape = c; }
    }
  }

  if (!shape.stopTimes?.length || shape.stopTimes.length !== shape.stopCoords.length) return null;

  // Anchor: find the shape stop nearest to our earliest known stop (by time)
  const anchor = sortedKnown[0];
  const anchorIdx = nearestShapeStopIdx(shape.stopCoords, anchor.lat, anchor.lng);
  const anchorCanonicalSec = shape.stopTimes[anchorIdx];

  // Day start in ms (midnight of the departure day)
  const dayStart = new Date(anchor.departureSoll);
  dayStart.setHours(0, 0, 0, 0);
  const anchorActualSec = (anchor.departureSoll.getTime() - dayStart.getTime()) / 1000;
  const delay = anchor.departureIst.getTime() - anchor.departureSoll.getTime(); // ms
  const offsetSec = anchorActualSec - anchorCanonicalSec;

  const stops: TripStop[] = shape.stopCoords.map(([lat, lng], i) => {
    const soll = new Date(dayStart.getTime() + (shape.stopTimes![i] + offsetSec) * 1000);
    const ist = new Date(soll.getTime() + delay);
    return {
      name: shape.stopNames?.[i] ?? "",
      lat, lng,
      arrivalIst: null,
      departureIst: ist,
      arrivalSoll: null,
      departureSoll: soll,
    };
  });

  return { line: info.line, direction: info.direction, vehicleId: "", stops };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function fetchAllBuses(stops: Stop[], gtfs?: GtfsData): Promise<Bus[]> {
  const tripMap = await fetchActiveTripIds(stops);
  const today = betriebstagNow();

  const routes = await Promise.allSettled(
    Array.from(tripMap.entries()).map(([tripId, info]) =>
      fetchTripRoute(tripId, info.betriebstag, info.produkt).then((r) => ({ tripId, info, r }))
    )
  );

  const now = new Date();
  const buses: Bus[] = [];

  for (const res of routes) {
    if (res.status !== "fulfilled") continue;
    const { tripId, info, r } = res.value;

    // Fahrtverlauf aus API, oder Fallback: bekannte Stops aus Abfahrts-API (sortiert nach Zeit)
    let route = r;
    if (!route && gtfs) {
      const rebuilt = rebuildTripFromGtfs(info, gtfs);
      if (rebuilt) {
        console.log(`[GTFS] rebuilt trip ${tripId} line=${info.line} dir="${info.direction}" stops=${rebuilt.stops.length}`);
        route = rebuilt;
      } else {
        console.warn(`[GTFS] failed to rebuild trip ${tripId} line=${info.line} dir="${info.direction}"`);
      }
    }
    if (!route && info.knownStops.length >= 2) {
      // Last resort: use known stops only (needs ≥2 for interpolation)
      const sorted = [...info.knownStops].sort(
        (a, b) => a.departureSoll.getTime() - b.departureSoll.getTime()
      );
      route = {
        line: info.line, direction: info.direction, vehicleId: "",
        stops: sorted.map((s) => ({
          name: s.name, lat: s.lat, lng: s.lng,
          arrivalIst: null, departureIst: s.departureIst,
          arrivalSoll: null, departureSoll: s.departureSoll,
        })),
      };
    }
    if (!route) continue;
    const betriebstag = info.betriebstag;
    // Nur Fahrzeuge anzeigen, die mindestens einen Halt im Zirndorfer Gemeindegebiet haben
    const inZirndorf = route.stops.some((s) => stopInZirndorf(s.lat, s.lng));
    if (!inZirndorf) {
      console.log(`[filter] skipping trip ${tripId} line=${info.line} (no Zirndorf stop); bbox check on ${route.stops.length} stops, sample: ${JSON.stringify(route.stops[0])}`);
      continue;
    }
    const pos = interpolatePosition(route.stops, now);
    if (!pos) {
      console.log(`[interp] no position for trip ${tripId} line=${info.line}, stops=${route.stops.length}, first=${route.stops[0]?.departureSoll?.toISOString()}, last=${route.stops[route.stops.length-1]?.departureSoll?.toISOString()}, now=${now.toISOString()}`);
    }
    buses.push({
      tripId,
      line: route.line,
      direction: route.direction,
      vehicleId: route.vehicleId,
      betriebstag: betriebstag ?? today,
      stops: route.stops,
      position: pos ? { lat: pos.lat, lng: pos.lng } : null,
      delayMinutes: pos?.delayMinutes ?? 0,
      prevStop: pos?.prevStop ?? null,
      nextStop: pos?.nextStop ?? null,
      segmentIndex: pos?.segmentIndex ?? 0,
      segmentT: pos?.segmentT ?? 0,
      bearing: 270, // default west; updated in App.tsx from road geometry
    });
  }

  // Add schedule-based buses for lines not served by the VAG PULS API
  if (gtfs) {
    const scheduled = await findScheduledBuses(gtfs, now);
    console.log(`[schedule] ${scheduled.length} scheduled buses (S4/RB11)`);
    buses.push(...scheduled);
  }

  return buses.filter((b) => b.position !== null);
}

export function refreshPositions(buses: Bus[]): Bus[] {
  const now = new Date();
  return buses.map((bus) => {
    const pos = interpolatePosition(bus.stops, now);
    return {
      ...bus,
      position: pos ? { lat: pos.lat, lng: pos.lng } : null,
      delayMinutes: pos?.delayMinutes ?? bus.delayMinutes,
      prevStop: pos?.prevStop ?? bus.prevStop,
      nextStop: pos?.nextStop ?? bus.nextStop,
      segmentIndex: pos?.segmentIndex ?? bus.segmentIndex,
      segmentT: pos?.segmentT ?? bus.segmentT,
    };
  });
}
