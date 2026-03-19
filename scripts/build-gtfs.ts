/**
 * GTFS pre-processing script.
 * Downloads VGN GTFS, extracts Zirndorf-area data, pre-routes via OSRM,
 * and writes public/gtfs_data.json.
 *
 * Run: pnpm gtfs
 */

import fs from "fs";
import path from "path";
import https from "https";
import zlib from "zlib";
import { createReadStream } from "fs";
import { pipeline } from "stream/promises";

// ── tiny CSV parser ───────────────────────────────────────────────────────────
function* parseCsv(content: string): Generator<Record<string, string>> {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return;
  // Strip BOM
  const headerLine = lines[0].replace(/^\uFEFF/, "");
  const headers = splitCsvLine(headerLine);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = (vals[j] ?? "").replace(/^"|"$/g, "")));
    yield row;
  }
}

function gtfsTimeToSeconds(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ── ZIP extraction (built-in, no adm-zip) ────────────────────────────────────
async function readZipFile(zipPath: string, fileName: string): Promise<string> {
  // Use system unzip for simplicity
  const { execSync } = await import("child_process");
  const tmp = `/tmp/gtfs_extract_${Date.now()}`;
  execSync(`unzip -p "${zipPath}" "${fileName}" > "${tmp}"`, { stdio: ["pipe", "pipe", "pipe"] });
  const content = fs.readFileSync(tmp, "utf8");
  fs.unlinkSync(tmp);
  return content;
}

// ── HTTP download ─────────────────────────────────────────────────────────────
function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        download(res.headers.location!, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// ── OSRM routing (foot profile, segment by segment) ──────────────────────────
const OSRM = "https://router.project-osrm.org/route/v1/driving";
async function osrmRoute(
  stops: Array<{ lat: number; lng: number }>
): Promise<Array<[number, number]>> {
  // Route segment by segment, concatenate
  const allCoords: Array<[number, number]> = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
    try {
      const data = await fetch(url).then((r) => r.json()) as any;
      const coords: [number, number][] = data.routes[0].geometry.coordinates.map(
        ([lng, lat]: [number, number]) => [lat, lng] as [number, number]
      );
      if (i === 0) allCoords.push(...coords);
      else allCoords.push(...coords.slice(1)); // avoid duplicating junction point
    } catch {
      // fallback: straight line
      if (i === 0) allCoords.push([a.lat, a.lng]);
      allCoords.push([b.lat, b.lng]);
    }
    // Rate-limit: tiny pause
    await new Promise((r) => setTimeout(r, 80));
  }
  return allCoords;
}

// ── Overpass railway routing (one query per route, BFS through OSM graph) ─────
async function railwayRoute(
  stops: Array<{ lat: number; lng: number }>
): Promise<Array<[number, number]>> {
  if (stops.length < 2) return stops.map((s) => [s.lat, s.lng]);

  // Single bounding box for all stops
  const pad = 0.015;
  const latMin = Math.min(...stops.map((s) => s.lat)) - pad;
  const latMax = Math.max(...stops.map((s) => s.lat)) + pad;
  const lngMin = Math.min(...stops.map((s) => s.lng)) - pad;
  const lngMax = Math.max(...stops.map((s) => s.lng)) + pad;

  const query = `[out:json][timeout:60];way["railway"~"^(rail|light_rail)$"]["service"!~"^(yard|siding|crossover|spur)$"](${latMin},${lngMin},${latMax},${lngMax});out geom;`;

  // Build adjacency graph
  const nodeMap = new Map<string, [number, number]>();
  const adj = new Map<string, Set<string>>();
  const nk = (lat: number, lon: number) => `${lat.toFixed(6)},${lon.toFixed(6)}`;

  try {
    const endpoints = [
      "https://overpass.kumi.systems/api/interpreter",
      "https://lz4.overpass-api.de/api/interpreter",
      "https://overpass-api.de/api/interpreter",
    ];
    let text = "";
    for (const ep of endpoints) {
      try {
        const r = await fetch(`${ep}?data=${encodeURIComponent(query)}`);
        text = await r.text();
        if (text.trimStart().startsWith("{")) break;
        console.warn(`    ${ep} returned non-JSON, trying next…`);
        text = "";
      } catch (e) { console.warn(`    ${ep} failed: ${e}`); }
      await new Promise((rr) => setTimeout(rr, 500));
    }
    if (!text) {
      console.warn(`    Overpass: all endpoints failed – falling back to stop coords`);
      return stops.map((s) => [s.lat, s.lng]);
    }
    const data = JSON.parse(text) as { elements: Array<{ geometry?: Array<{ lat: number; lon: number }> }> };
    for (const way of data.elements) {
      const geom = way.geometry;
      if (!geom || geom.length < 2) continue;
      for (let j = 0; j < geom.length; j++) {
        const k = nk(geom[j].lat, geom[j].lon);
        nodeMap.set(k, [geom[j].lat, geom[j].lon]);
        if (!adj.has(k)) adj.set(k, new Set());
        if (j > 0) {
          const pk = nk(geom[j - 1].lat, geom[j - 1].lon);
          if (!adj.has(pk)) adj.set(pk, new Set());
          adj.get(k)!.add(pk);
          adj.get(pk)!.add(k);
        }
      }
    }
  } catch (e) {
    console.warn(`    Overpass error: ${e}`);
    return stops.map((s) => [s.lat, s.lng]);
  }

  if (nodeMap.size < 2) {
    console.warn(`    Overpass: no railway ways found in bbox – falling back to stop coords`);
    return stops.map((s) => [s.lat, s.lng]);
  }
  console.log(`    Overpass: ${nodeMap.size} rail nodes, routing ${stops.length} stops…`);

  // Helper: nearest graph node to a coordinate
  const nearest = (lat: number, lng: number): string => {
    let best = "", bd = Infinity;
    for (const [k, c] of nodeMap) {
      const d = (c[0] - lat) ** 2 + (c[1] - lng) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };

  // Euclidean distance² between two node keys (used as edge weight)
  const edgeDist = (a: string, b: string): number => {
    const ca = nodeMap.get(a)!, cb = nodeMap.get(b)!;
    return (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2;
  };

  // A* between two node keys, weighted by geographic distance
  const astarPath = (startKey: string, endKey: string): [number, number][] | null => {
    if (startKey === endKey) return [nodeMap.get(startKey)!];
    const ec = nodeMap.get(endKey)!;
    const heuristic = (k: string): number => {
      const c = nodeMap.get(k)!;
      return (c[0] - ec[0]) ** 2 + (c[1] - ec[1]) ** 2;
    };
    const gCost = new Map<string, number>([[startKey, 0]]);
    const prev = new Map<string, string | null>([[startKey, null]]);
    // Min-heap: [fCost, key]
    const open: Array<[number, string]> = [[heuristic(startKey), startKey]];
    let found = false;
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [, cur] = open.shift()!;
      if (cur === endKey) { found = true; break; }
      const gCur = gCost.get(cur)!;
      for (const next of (adj.get(cur) ?? [])) {
        const g = gCur + edgeDist(cur, next);
        if (!gCost.has(next) || g < gCost.get(next)!) {
          gCost.set(next, g);
          prev.set(next, cur);
          open.push([g + heuristic(next), next]);
        }
      }
    }
    if (!found) return null;
    const path: [number, number][] = [];
    let cur: string = endKey;
    while (prev.get(cur) !== null) { path.unshift(nodeMap.get(cur)!); cur = prev.get(cur)!; }
    path.unshift(nodeMap.get(cur)!);
    return path;
  };

  // Route stop-by-stop through the graph
  const allCoords: Array<[number, number]> = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const sk = nearest(a.lat, a.lng);
    const ek = nearest(b.lat, b.lng);
    const path = astarPath(sk, ek);
    if (path && path.length >= 2) {
      if (i === 0) allCoords.push(...path);
      else allCoords.push(...path.slice(1));
    } else {
      if (i === 0) allCoords.push([a.lat, a.lng]);
      allCoords.push([b.lat, b.lng]);
    }
  }
  return allCoords;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const GTFS_URL = "https://www.vgn.de/opendata/GTFS.zip";
const GTFS_CACHE = "/tmp/vgn_gtfs_cache.zip";
const OUT_FILE = path.resolve("public/gtfs_data.json");

// Bounding box: Zirndorf Gemeindegebiet + S-Bahn Außenorte
const BBOX = { latMin: 49.39, latMax: 49.51, lngMin: 10.89, lngMax: 11.02 };

// Lines we want to pre-route (serve Zirndorf area)
const TARGET_LINES = new Set([
  "70", "72", "112", "113", "150", "151", "152", "154",
  "70E", "72E", "RB11", "RB 11", "S4",
]);

async function main() {
  // 1. Download GTFS if not cached
  if (!fs.existsSync(GTFS_CACHE)) {
    console.log("⬇  Downloading VGN GTFS…");
    await download(GTFS_URL, GTFS_CACHE);
    console.log("   Done.");
  } else {
    console.log("✓  Using cached GTFS.");
  }

  // 2. Parse ALL stops (we filter later by which trips use them)
  console.log("📍 Parsing stops…");
  const stopData = await readZipFile(GTFS_CACHE, "stops.txt");
  const stops: Record<string, { name: string; lat: number; lng: number; vgnId: string }> = {};

  for (const r of parseCsv(stopData)) {
    if (r.location_type !== "") continue;
    const lat = parseFloat(r.stop_lat), lng = parseFloat(r.stop_lon);
    const m = r.stop_id.match(/de:\d+:(\d+):/);
    const vgnId = m ? m[1] : "";
    stops[r.stop_id] = { name: r.stop_name, lat, lng, vgnId };
  }
  console.log(`   ${Object.keys(stops).length} total stops loaded`);

  // 3. Parse routes
  console.log("🗺  Parsing routes…");
  const routesData = await readZipFile(GTFS_CACHE, "routes.txt");
  const routes: Record<string, { line: string; name: string; type: number; desc: string }> = {};
  const targetRouteIds = new Set<string>();

  for (const r of parseCsv(routesData)) {
    routes[r.route_id] = {
      line: r.route_short_name,
      name: r.route_long_name,
      type: parseInt(r.route_type),
      desc: r.route_desc,
    };
    if (TARGET_LINES.has(r.route_short_name)) targetRouteIds.add(r.route_id);
  }
  console.log(`   ${targetRouteIds.size} target route_ids`);

  // 4. Parse trips
  console.log("🚌 Parsing trips…");
  const tripsData = await readZipFile(GTFS_CACHE, "trips.txt");
  const trips: Record<string, { routeId: string; serviceId: string; headsign: string; direction: string }> = {};
  const targetTripIds = new Set<string>();

  for (const r of parseCsv(tripsData)) {
    if (targetRouteIds.has(r.route_id)) {
      trips[r.trip_id] = {
        routeId: r.route_id,
        serviceId: r.service_id,
        headsign: r.trip_headsign,
        direction: r.direction_id,
      };
      targetTripIds.add(r.trip_id);
    }
  }
  console.log(`   ${targetTripIds.size} target trips`);

  // 4b. Parse calendar (day-of-week service patterns, 0=Sun … 6=Sat)
  console.log("📅 Parsing calendar…");
  const calendarData = await readZipFile(GTFS_CACHE, "calendar.txt");
  // serviceId → boolean[7], index matches JS getDay() (0=Sun, 1=Mon … 6=Sat)
  const serviceCalendar = new Map<string, boolean[]>();
  for (const r of parseCsv(calendarData)) {
    serviceCalendar.set(r.service_id, [
      r.sunday === "1", r.monday === "1", r.tuesday === "1",
      r.wednesday === "1", r.thursday === "1", r.friday === "1", r.saturday === "1",
    ]);
  }
  console.log(`   ${serviceCalendar.size} service patterns`);

  // 5. Parse stop_times → build route variants + collect all stop_ids used
  console.log("⏱  Parsing stop_times (this takes a moment)…");
  const stopTimesData = await readZipFile(GTFS_CACHE, "stop_times.txt");

  const tripStopSeqs: Record<string, Array<{ stopId: string; seq: number; depTime: string; arrTime: string }>> = {};
  const usedStopIds = new Set<string>(); // all stop_ids on target-line trips

  for (const r of parseCsv(stopTimesData)) {
    if (!targetTripIds.has(r.trip_id)) continue;
    if (!tripStopSeqs[r.trip_id]) tripStopSeqs[r.trip_id] = [];
    tripStopSeqs[r.trip_id].push({ stopId: r.stop_id, seq: parseInt(r.stop_sequence), depTime: r.departure_time, arrTime: r.arrival_time });
    usedStopIds.add(r.stop_id);
  }

  for (const tripId of Object.keys(tripStopSeqs)) {
    tripStopSeqs[tripId].sort((a, b) => a.seq - b.seq);
  }
  console.log(`   ${Object.keys(tripStopSeqs).length} trips, ${usedStopIds.size} distinct stops used`);

  // 6. Find canonical route variant per (routeId + direction [+ headsign for rail])
  //    = the trip with the most stops (= fullest variant)
  //    Rail lines get per-headsign variants so Fürth-bound and Nürnberg-bound
  //    trips have accurate stop times instead of sharing one canonical shape.
  const RAIL_LINES_SPLIT = new Set(["RB11", "RB 11"]);
  const variantKey = (routeId: string, direction: string, headsign: string) =>
    RAIL_LINES_SPLIT.has(routes[routeId]?.line ?? "")
      ? `${routeId}__${direction}__${headsign}`
      : `${routeId}__${direction}`;

  const routeVariants: Record<string, { tripId: string; stopIds: string[]; stopTimes: Array<{ dep: string; arr: string }> }> = {};

  for (const [tripId, seq] of Object.entries(tripStopSeqs)) {
    const trip = trips[tripId];
    if (!trip) continue;
    const key = variantKey(trip.routeId, trip.direction, trip.headsign);
    const current = routeVariants[key];
    if (!current || seq.length > current.stopIds.length) {
      routeVariants[key] = { tripId, stopIds: seq.map((s) => s.stopId), stopTimes: seq.map((s) => ({ dep: s.depTime, arr: s.arrTime })) };
    }
  }
  console.log(`   ${Object.keys(routeVariants).length} canonical route variants`);

  // 6b. Collect departure times per variant per day-of-week
  console.log("🗓  Collecting departure times per day…");
  const variantDepartures: Record<string, Array<Array<{ dep: number; headsign: string }>>> = {};
  for (const [key, variant] of Object.entries(routeVariants)) {
    const depsPerDay: Array<Array<{ dep: number; headsign: string }>> = Array.from({ length: 7 }, () => []);
    const canonFirstId = variant.stopIds[0];
    for (const [tripId, seq] of Object.entries(tripStopSeqs)) {
      const t = trips[tripId];
      if (!t || variantKey(t.routeId, t.direction, t.headsign) !== key) continue;
      const match = seq.find((s) => s.stopId === canonFirstId);
      if (!match?.depTime) continue;
      const depSec = gtfsTimeToSeconds(match.depTime);
      const cal = serviceCalendar.get(t.serviceId);
      if (!cal) continue;
      for (let d = 0; d < 7; d++) {
        if (cal[d]) depsPerDay[d].push({ dep: depSec, headsign: t.headsign });
      }
    }
    for (const arr of depsPerDay) arr.sort((a, b) => a.dep - b.dep);
    variantDepartures[key] = depsPerDay;
  }

  // 7. Pre-route variants via OSRM (buses) or stop-coords (rail)
  // Rail lines use stop coordinates directly – no road routing needed/wanted
  const RAIL_LINES = new Set(["S4", "RB11", "RB 11"]);
  console.log("🛣  Pre-routing variants via OSRM (slow – only runs once)…");

  let existingShapes: Record<string, { coords: Array<[number, number]> }> = {};
  if (fs.existsSync(OUT_FILE)) {
    try { existingShapes = JSON.parse(fs.readFileSync(OUT_FILE, "utf8")).routeShapes ?? {}; } catch {}
  }

  const routeShapes: Record<
    string,
    {
      line: string;
      direction: string;
      headsign: string;
      coords: Array<[number, number]>;
      stopCoords: Array<[number, number]>;
      stopNames: string[];
      stopTimes: number[];
      tripDepartures: Array<Array<{ dep: number; headsign: string }>>;
    }
  > = {};

  let done = 0;
  for (const [key, variant] of Object.entries(routeVariants)) {
    const trip = trips[variant.tripId];
    if (!trip) continue;
    const route = routes[trip.routeId];

    // Only keep stops we have coordinates for
    const waypoints = variant.stopIds
      .map((sid) => stops[sid])
      .filter(Boolean)
      .map((s) => ({ lat: s!.lat, lng: s!.lng }));

    if (waypoints.length < 2) continue;

    let coords: Array<[number, number]>;
    if (RAIL_LINES.has(route.line)) {
      // Rail: use Overpass OSM geometry; fall back to stop coords
      const cached = existingShapes[key]?.coords;
      if (cached && cached.length > waypoints.length * 3) {
        coords = cached;
        console.log(`  [${++done}/${Object.keys(routeVariants).length}] ${route.line} dir=${trip.direction} (rail – cached overpass)`);
      } else {
        console.log(`  [${++done}/${Object.keys(routeVariants).length}] ${route.line} dir=${trip.direction} "${trip.headsign}" (${waypoints.length} stops – overpass railway)`);
        coords = await railwayRoute(waypoints);
        if (coords.length < 2) coords = waypoints.map((w) => [w.lat, w.lng]);
      }
    } else if (existingShapes[key]?.coords?.length) {
      coords = existingShapes[key].coords;
      console.log(`  [${++done}/${Object.keys(routeVariants).length}] ${route.line} dir=${trip.direction} (cached)`);
    } else {
      console.log(`  [${++done}/${Object.keys(routeVariants).length}] ${route.line} dir=${trip.direction} "${trip.headsign}" (${waypoints.length} stops)`);
      coords = await osrmRoute(waypoints);
    }

    routeShapes[key] = {
      line: route.line,
      direction: trip.direction,
      headsign: trip.headsign,
      coords,
      stopCoords: waypoints.map((w) => [w.lat, w.lng]),
      stopNames: variant.stopIds
        .map((sid) => stops[sid]?.name ?? "")
        .filter((_, i) => stops[variant.stopIds[i]]),
      stopTimes: variant.stopTimes
        .filter((_, i) => stops[variant.stopIds[i]])
        .map((t) => gtfsTimeToSeconds(t.dep || t.arr)),
      tripDepartures: variantDepartures[key] ?? Array.from({ length: 7 }, () => []),
    };
  }

  // 8. Build final output
  // Collect unique VGN stops from all used stop_ids (one entry per VGN ID)
  const stopsByVgnId: Record<string, { name: string; lat: number; lng: number }> = {};
  for (const stopId of usedStopIds) {
    const s = stops[stopId];
    if (!s?.vgnId || stopsByVgnId[s.vgnId]) continue;
    stopsByVgnId[s.vgnId] = { name: s.name, lat: s.lat, lng: s.lng };
  }

  const output = {
    generated: new Date().toISOString(),
    gtfsSource: GTFS_URL,
    stopsByVgnId,

    // Route metadata: line → {name, type, desc}
    lineInfo: Object.fromEntries(
      Object.values(routes)
        .filter((r) => TARGET_LINES.has(r.line))
        .map((r) => [r.line, { name: r.name, type: r.type, desc: r.desc }])
        // Deduplicate by line name
        .filter(([line], i, arr) => arr.findIndex(([l]) => l === line) === i)
    ) as Record<string, { name: string; type: number; desc: string }>,

    // Pre-routed shapes: "routeId__direction" → coords
    routeShapes,
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output));
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`\n✅ Written ${OUT_FILE} (${kb} KB)`);
  console.log(`   ${Object.keys(output.stopsByVgnId).length} stops`);
  console.log(`   ${Object.keys(output.lineInfo).length} lines`);
  console.log(`   ${Object.keys(output.routeShapes).length} route shapes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
