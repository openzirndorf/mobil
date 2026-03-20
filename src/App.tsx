import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { enrichBusDelays, fetchAllBuses, fetchRoadSegments, fetchStopDepartures, fetchZirndorfStops, refreshPositions, stopInZirndorf } from "./api";
import {
  buildCoordRanges,
  loadGtfsData,
  type GtfsData,
  type GtfsRouteShape,
} from "./gtfs";
import type { Bus, Stop } from "./types";
import busImgUrl from "./assets/bus.png";
import sbahnImgUrl from "./assets/sbahn.png";
import zugImgUrl from "./assets/zug.png";
import taxiImgUrl from "./assets/taxi.png";
import fahrradImgUrl from "./assets/fahrrad.png";
import prImgUrl from "./assets/pr.png";
import haltestelleImgUrl from "./assets/haltestelle.png";
import wcImgUrl from "./assets/wc.png";
import "./App.css";

const ZIRNDORF = { lat: 49.4415, lng: 10.955 };
const REFRESH_INTERVAL_MS = 15_000;
const SMOOTH_INTERVAL_MS = 1_000;

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function delayColor(min: number): string {
  if (min <= 1) return "#15803D"; // oz-color-success
  if (min <= 4) return "#B45309"; // oz-color-warning
  return "#B91C1C";               // oz-color-error
}
function delayLabel(min: number): string {
  return min <= 0 ? "pünktlich" : `+${min} Min`;
}

/** GTFS route_type → short label */
function routeTypeLabel(type: number): string {
  switch (type) {
    case 0: return "Tram";
    case 1: return "U-Bahn";
    case 2: return "Bahn";
    case 3: return "Bus";
    case 5: return "Seilbahn";
    case 100: return "Fernzug";
    case 109: return "S-Bahn";
    default: return "Bus";
  }
}

// ── Polyline along GTFS shape ────────────────────────────────────────────────

/**
 * Given a GTFS shape, returns [lat,lng][] coords between two stop positions.
 * coordRanges maps each shape-stop-index to a coord index.
 */
function shapeSlice(
  shape: GtfsRouteShape,
  coordRanges: number[],
  pulsStopIdx: number, // which PULS segment start
  pulsStops: Array<{ lat: number; lng: number }>
): [number, number][] {
  // Map this PULS stop to nearest shape stop index
  const fromIdx = nearestShapeStop(shape, pulsStops[pulsStopIdx]);
  const toIdx = pulsStopIdx + 1 < pulsStops.length
    ? nearestShapeStop(shape, pulsStops[pulsStopIdx + 1])
    : coordRanges.length - 1;

  const c0 = coordRanges[Math.min(fromIdx, coordRanges.length - 1)] ?? 0;
  const c1 = coordRanges[Math.min(toIdx, coordRanges.length - 1)] ?? shape.coords.length - 1;
  if (c0 >= c1) return [[pulsStops[pulsStopIdx].lat, pulsStops[pulsStopIdx].lng],
                         [pulsStops[Math.min(pulsStopIdx + 1, pulsStops.length - 1)].lat,
                          pulsStops[Math.min(pulsStopIdx + 1, pulsStops.length - 1)].lng]];
  return shape.coords.slice(c0, c1 + 1);
}

function nearestShapeStop(shape: GtfsRouteShape, pt: { lat: number; lng: number }): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < shape.stopCoords.length; i++) {
    const d = (pt.lat - shape.stopCoords[i][0]) ** 2 + (pt.lng - shape.stopCoords[i][1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Like matchShape but uses the bus's actual stop positions to prefer the
 * correctly-directed shape variant. Direction match outweighs text similarity.
 */
function matchShapeForBus(
  line: string,
  richtungstext: string,
  stops: Array<{ lat: number; lng: number }>,
  data: GtfsData
): GtfsRouteShape | null {
  const candidates = Object.values(data.routeShapes).filter((s) => s.line === line);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const firstStop = stops[0];
  const lastStop = stops[stops.length - 1];
  const target = richtungstext.toLowerCase().replace(/[^a-z0-9äöü]/g, "");

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const c of candidates) {
    // Direction match: bus's first stop should map to a lower shape index than last stop
    const fromIdx = nearestShapeStop(c, firstStop);
    const toIdx = nearestShapeStop(c, lastStop);
    const dirScore = fromIdx < toIdx ? 100 : 0;

    // Headsign text similarity
    const h = c.headsign.toLowerCase().replace(/[^a-z0-9äöü]/g, "");
    let textScore = 0;
    for (const ch of target) if (h.includes(ch)) textScore++;
    const score = dirScore + textScore / Math.max(target.length, 1) * 10;

    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ── pointOnPolyline: position + bearing along coords at fraction t ────────────

function pointOnPolyline(
  coords: [number, number][],
  t: number
): { lat: number; lng: number; bearing: number } {
  if (coords.length < 2) return { lat: coords[0][0], lng: coords[0][1], bearing: 270 };
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const dl = coords[i][0] - coords[i-1][0], dg = coords[i][1] - coords[i-1][1];
    cum.push(cum[i-1] + Math.sqrt(dl*dl + dg*dg));
  }
  const target = Math.min(t, 1) * cum[cum.length - 1];
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= target || i === coords.length - 1) {
      const seg = cum[i] - cum[i-1];
      const st = seg > 0 ? (target - cum[i-1]) / seg : 0;
      return {
        lat: coords[i-1][0] + (coords[i][0] - coords[i-1][0]) * st,
        lng: coords[i-1][1] + (coords[i][1] - coords[i-1][1]) * st,
        bearing: ((Math.atan2(coords[i][1] - coords[i-1][1], coords[i][0] - coords[i-1][0]) * 180 / Math.PI) + 360) % 360,
      };
    }
  }
  const last = coords[coords.length - 1];
  return { lat: last[0], lng: last[1], bearing: 270 };
}

// ── Bus icon ──────────────────────────────────────────────────────────────────

const BUS_W = 72;
const BUS_H = Math.round(BUS_W * (430 / 1300));
const ICON_BOX = Math.ceil(Math.sqrt(BUS_W * BUS_W + BUS_H * BUS_H)) + 4;

// Rail vehicles rendered slightly larger
const RAIL_W = Math.round(BUS_W * 1.35);
const RAIL_H = Math.round(BUS_H * 1.35);
const RAIL_BOX = Math.ceil(Math.sqrt(RAIL_W * RAIL_W + RAIL_H * RAIL_H)) + 4;

function busTransform(bearing: number): string {
  // bus.png faces west (left). Keep it upright: max ±90° tilt.
  // CSS applies transforms right-to-left: scaleX(-1) rotate(t) → rotate first, then flip.
  // Result bearing = 90° − t  →  t = 90° − bearing
  // East half (bearing 0–179°): flip + tilt = 90° − bearing
  // West half (bearing 180–359°): no flip, rotate from West: t = bearing − 270°
  if (bearing < 180) {
    const tilt = 90 - bearing; // +90 (N) … 0 (E) … −89 (S)
    return `scaleX(-1) rotate(${tilt}deg)`;
  } else {
    const tilt = bearing - 270; // −90 (S) … 0 (W) … +89 (N)
    return `rotate(${tilt}deg)`;
  }
}

/** Choose icon image based on GTFS route_type and line name */
function vehicleImg(routeType: number | undefined, line?: string): { src: string } {
  // S-Bahn: type 109 or line name starts with "S" followed by digit (S1, S4…)
  if (routeType === 109 || /^S\d/.test(line ?? "")) return { src: sbahnImgUrl };
  // Regional/long-distance rail
  if (routeType === 2 || routeType === 100) return { src: zugImgUrl };
  return { src: busImgUrl };
}

function makeBusIcon(line: string, delay: number, bearing: number, routeType?: number): L.DivIcon {
  const isRail = routeType === 109 || routeType === 2 || routeType === 100 || /^S\d/.test(line);
  const w = isRail ? RAIL_W : BUS_W;
  const h = isRail ? RAIL_H : BUS_H;
  const box = isRail ? RAIL_BOX : ICON_BOX;
  const color = delayColor(delay);
  const transform = busTransform(bearing);
  const { src } = vehicleImg(routeType, line);
  return L.divIcon({
    className: "",
    html: `
      <div style="position:relative;width:${box}px;height:${box}px;pointer-events:none;">
        <div style="position:absolute;top:50%;left:50%;
          transform:translate(-50%,-50%) ${transform};
          filter:drop-shadow(0 2px 5px rgba(0,0,0,0.55));">
          <img src="${src}" width="${w}" height="${h}" style="display:block;" />
        </div>
        <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);
          background:${color};color:#fff;font:bold 10px/1.4 sans-serif;
          padding:1px 5px;border-radius:3px;white-space:nowrap;
          box-shadow:0 1px 3px rgba(0,0,0,0.4);">${line}</div>
      </div>`,
    iconAnchor: [box / 2, box / 2],
    iconSize: [box, box],
  });
}

function makeStopIcon(isZirndorf = false, zoom = 13): L.DivIcon {
  const base = Math.round(Math.max(8, Math.min(40, 24 + (zoom - 13) * 4)));
  const size = isZirndorf ? base : Math.round(base * 0.7);
  return L.divIcon({
    className: "",
    html: `<img src="${haltestelleImgUrl}" width="${size}" height="${size}"
      style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))${isZirndorf ? "" : " opacity(0.6)"}" />`,
    iconAnchor: [size / 2, size / 2],
  });
}

// ── POI icons ─────────────────────────────────────────────────────────────────

interface Poi { lat: number; lng: number; name: string; type: "park_ride" | "bicycle_parking" | "taxi" | "toilets"; }

const POI_SIZE = 36;
const POI_SIZE_BIKE = Math.round(POI_SIZE * 0.95);

function makePoiIcon(type: Poi["type"]): L.DivIcon {
  const src = type === "taxi" ? taxiImgUrl : type === "park_ride" ? prImgUrl : type === "toilets" ? wcImgUrl : fahrradImgUrl;
  const s = type === "bicycle_parking" ? POI_SIZE_BIKE : POI_SIZE;
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 5px rgba(0,0,0,0.45));">
      <img src="${src}" width="${s}" height="${s}" style="display:block;" />
    </div>`;
  return L.divIcon({ className: "", html, iconAnchor: [s / 2, s] });
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const stopLayerRef = useRef<L.LayerGroup | null>(null);
  const poiLayerRef = useRef<L.LayerGroup | null>(null);
  const busMarkersRef = useRef<Map<number, L.Marker>>(new Map());
  const routeLinesRef = useRef<Map<number, L.Polyline>>(new Map());
  // GTFS shape coord-ranges cache per tripId
  const shapeRangesRef = useRef<Map<number, { shape: GtfsRouteShape; ranges: number[] }>>(new Map());
  // OSRM fallback segments for buses without a matching GTFS shape
  const osrmSegmentsRef = useRef<Map<number, [number, number][][]>>(new Map());

  const [stops, setStops] = useState<Stop[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [gtfs, setGtfs] = useState<GtfsData | null>(null);
  const [pois, setPois] = useState<Poi[]>([]);
  const [poisVisible, setPoisVisible] = useState({ park_ride: false, bicycle_parking: false, taxi: false, toilets: false });
  const [stopsVisible, setStopsVisible] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 640);
  const [zoom, setZoom] = useState(13);
  const [selectedBus, setSelectedBus] = useState<Bus | null>(null);
  const [selectedStop, setSelectedStop] = useState<{
    vgnId: number; name: string; loading: boolean;
    departures: Array<{
      line: string; direction: string; scheduledTime: Date; actualTime: Date;
      delayMin: number; product: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [overlayVisible, setOverlayVisible] = useState(true);
  const [overlayFading, setOverlayFading] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  // Fade out loading overlay once first data arrives
  useEffect(() => {
    if (!loading && overlayVisible) {
      setOverlayFading(true);
      const t = setTimeout(() => setOverlayVisible(false), 500);
      return () => clearTimeout(t);
    }
  }, [loading, overlayVisible]);

  const busesRef = useRef<Bus[]>([]);
  busesRef.current = buses;
  // Track when each trip was last seen to avoid flickering on refresh
  const busLastSeenRef = useRef<Map<number, number>>(new Map());
  const gtfsRef = useRef<GtfsData | null>(null);

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const map = L.map(mapRef.current, { zoomControl: false }).setView(
      [ZIRNDORF.lat, ZIRNDORF.lng], 13
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap-Mitwirkende", maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    stopLayerRef.current = L.layerGroup().addTo(map);
    map.on("zoomend", () => setZoom(map.getZoom()));
    mapInstance.current = map;
    return () => { map.remove(); mapInstance.current = null; };
  }, []);

  // ── Load GTFS data ──────────────────────────────────────────────────────────
  useEffect(() => {
    loadGtfsData((partial) => { setGtfs(partial); gtfsRef.current = partial; })
      .then((full) => { setGtfs(full); gtfsRef.current = full; });
  }, []);

  // ── Fetch P+R and bicycle parking from Overpass ──────────────────────────────
  useEffect(() => {
    const q = `[out:json][timeout:20];(
      node["amenity"="parking"]["park_ride"="yes"](49.38,10.86,49.54,11.08);
      way["amenity"="parking"]["park_ride"="yes"](49.38,10.86,49.54,11.08);
      node["amenity"="bicycle_parking"](49.40,10.90,49.52,11.02);
      node["amenity"="taxi"](49.38,10.86,49.54,11.08);
      node["amenity"="toilets"](49.38,10.86,49.54,11.08);
    );out center;`;
    fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((data: { elements: Array<{ lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> }) => {
        setPois(data.elements
          .filter((el) => {
            if (el.tags?.amenity !== "toilets") return true;
            const acc = el.tags?.access;
            return !acc || !["private", "customers", "no"].includes(acc);
          })
          .map((el) => ({
            lat: el.lat ?? el.center?.lat ?? 0,
            lng: el.lon ?? el.center?.lon ?? 0,
            name: el.tags?.name ?? (el.tags?.amenity === "bicycle_parking" ? "Fahrradabstellplatz" : el.tags?.amenity === "taxi" ? "Taxistand" : el.tags?.amenity === "toilets" ? "Öffentliche Toilette" : "P+R Parkplatz"),
            type: (el.tags?.amenity === "bicycle_parking" ? "bicycle_parking" : el.tags?.amenity === "taxi" ? "taxi" : el.tags?.amenity === "toilets" ? "toilets" : "park_ride") as Poi["type"],
          }))
          .filter((p) => p.lat && p.lng)
        );
      })
      .catch(() => {});
  }, []);

  // ── Draw all GTFS stops once data loads ──────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current;
    if (!gtfs || !stopLayerRef.current || !map) return;
    stopLayerRef.current.clearLayers();
    if (!stopsVisible) { stopLayerRef.current.remove(); return; }
    stopLayerRef.current.addTo(map);

    for (const [vgnId, stop] of Object.entries(gtfs.stopsByVgnId)) {
      const isZirn = stopInZirndorf(stop.lat, stop.lng);
      const vgnIdNum = parseInt(vgnId);
      L.marker([stop.lat, stop.lng], {
        icon: makeStopIcon(isZirn, zoom),
        zIndexOffset: isZirn ? 0 : -200,
      })
        .bindTooltip(stop.name, { direction: "top", offset: [0, -6] })
        .on("click", () => {
          setSelectedBus(null);
          setSelectedStop({ vgnId: vgnIdNum, name: stop.name, loading: true, departures: [] });
          fetchStopDepartures(vgnIdNum).then((result) => {
            setSelectedStop({ vgnId: vgnIdNum, name: stop.name, loading: false, departures: result.departures });
          }).catch(() => {
            setSelectedStop((prev) => prev?.vgnId === vgnIdNum ? { ...prev, loading: false } : prev);
          });
        })
        .addTo(stopLayerRef.current!);
    }
  }, [gtfs, stops, zoom, stopsVisible]);

  // ── Draw POI layer ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;
    poiLayerRef.current?.clearLayers();
    if (!poiLayerRef.current) {
      poiLayerRef.current = L.layerGroup().addTo(map);
    }
    const anyVisible = poisVisible.park_ride || poisVisible.bicycle_parking || poisVisible.taxi || poisVisible.toilets;
    if (!anyVisible) { poiLayerRef.current.remove(); return; }
    poiLayerRef.current.addTo(map);
    for (const poi of pois) {
      if (!poisVisible[poi.type]) continue;
      L.marker([poi.lat, poi.lng], { icon: makePoiIcon(poi.type), zIndexOffset: 200 })
        .bindTooltip(poi.name, { direction: "top", offset: [0, -8] })
        .addTo(poiLayerRef.current);
    }
  }, [pois, poisVisible]);

  // ── Load stops ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchZirndorfStops().then(setStops);
  }, []);

  // ── Full data refresh ───────────────────────────────────────────────────────
  const refresh = useCallback(async (currentStops: Stop[]) => {
    if (!currentStops.length) return;
    try {
      const fresh = await fetchAllBuses(currentStops, gtfsRef.current ?? undefined);
      const now = Date.now();
      const threshold = now - REFRESH_INTERVAL_MS * 1.5;
      for (const b of fresh) busLastSeenRef.current.set(b.tripId, now);
      const mergeBuses = (base: Bus[], updated: Bus[]) => {
        const updatedMap = new Map(updated.map((b) => [b.tripId, b]));
        const kept = base.filter((b) => !updatedMap.has(b.tripId) && (busLastSeenRef.current.get(b.tripId) ?? 0) > threshold);
        return [...updated, ...kept];
      };
      setBuses((prev) => mergeBuses(prev, fresh));
      // Enrich with delays in background – doesn't block initial render
      enrichBusDelays(fresh).then((enriched) => {
        setBuses((prev) => mergeBuses(prev, enriched));
      }).catch(() => {});
      setLastUpdate(new Date());
      setError(null);
    } catch {
      setError("API nicht erreichbar");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!stops.length) return;
    refresh(stops);
    const id = setInterval(() => refresh(stops), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [stops, refresh]);

  // ── Smooth position update ──────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (!busesRef.current.length) return;
      setBuses(refreshPositions(busesRef.current));
    }, SMOOTH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // ── Sync map markers ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current;
    if (!map) return;

    const activeIds = new Set(buses.map((b) => b.tripId));
    for (const [id, m] of busMarkersRef.current) {
      if (!activeIds.has(id)) { m.remove(); busMarkersRef.current.delete(id); }
    }
    for (const [id, l] of routeLinesRef.current) {
      if (!activeIds.has(id)) { l.remove(); routeLinesRef.current.delete(id); }
    }

    for (const bus of buses) {
      if (!bus.position) continue;
      const color = delayColor(bus.delayMinutes);

      // ── Match GTFS shape (once per trip) ────────────────────────────────────
      if (gtfs && !shapeRangesRef.current.has(bus.tripId)) {
        const shape = matchShapeForBus(bus.line, bus.direction, bus.stops, gtfs);
        if (shape) {
          shapeRangesRef.current.set(bus.tripId, { shape, ranges: buildCoordRanges(shape) });
        } else {
          // No GTFS shape → fetch OSRM at runtime as fallback
          fetchRoadSegments(bus.tripId, bus.stops).then((segs) => {
            osrmSegmentsRef.current.set(bus.tripId, segs);
            routeLinesRef.current.get(bus.tripId)?.setLatLngs(segs.flat());
          });
        }
      }

      // ── Compute route coords (GTFS shape trimmed to this bus's stops) ────────
      const gtfsCachedRoute = shapeRangesRef.current.get(bus.tripId);
      let routeCoords: [number, number][];
      if (gtfsCachedRoute) {
        const { shape, ranges } = gtfsCachedRoute;
        const fromSI = nearestShapeStop(shape, bus.stops[0]);
        const toSI = nearestShapeStop(shape, bus.stops[bus.stops.length - 1]);
        const c0 = ranges[Math.min(fromSI, ranges.length - 1)] ?? 0;
        const c1 = ranges[Math.min(toSI, ranges.length - 1)] ?? shape.coords.length - 1;
        routeCoords = c0 <= c1
          ? shape.coords.slice(c0, c1 + 1)
          : shape.coords.slice(c1, c0 + 1).reverse();
      } else {
        routeCoords = bus.stops.map((s) => [s.lat, s.lng] as [number, number]);
      }

      // ── Route polyline ──────────────────────────────────────────────────────
      if (!routeLinesRef.current.has(bus.tripId)) {
        const line = L.polyline(routeCoords, { color, weight: 3, opacity: 0.75 }).addTo(map);
        routeLinesRef.current.set(bus.tripId, line);
      } else {
        const line = routeLinesRef.current.get(bus.tripId)!;
        line.setStyle({ color });
        if (gtfsCachedRoute) line.setLatLngs(routeCoords);
      }

      // ── Bus position: GTFS shape → OSRM fallback → stop interpolation ───────
      let displayLat = bus.position.lat;
      let displayLng = bus.position.lng;
      let bearing = bus.bearing;

      const gtfsCached = shapeRangesRef.current.get(bus.tripId);
      const osrmSegs = osrmSegmentsRef.current.get(bus.tripId);

      if (gtfsCached) {
        const { shape, ranges } = gtfsCached;
        const segCoords = shapeSlice(shape, ranges, bus.segmentIndex, bus.stops);
        if (segCoords.length >= 2) {
          const pt = pointOnPolyline(segCoords, bus.segmentT);
          displayLat = pt.lat; displayLng = pt.lng; bearing = pt.bearing;
        }
      } else if (osrmSegs && bus.segmentIndex < osrmSegs.length) {
        const seg = osrmSegs[bus.segmentIndex];
        if (seg?.length >= 2) {
          const pt = pointOnPolyline(seg, bus.segmentT);
          displayLat = pt.lat; displayLng = pt.lng; bearing = pt.bearing;
        }
      }

      // ── Bus marker ──────────────────────────────────────────────────────────
      const routeType = gtfs?.lineInfo[bus.line]?.type;
      const icon = makeBusIcon(bus.line, bus.delayMinutes, bearing, routeType);
      if (!busMarkersRef.current.has(bus.tripId)) {
        const marker = L.marker([displayLat, displayLng], { icon, zIndexOffset: 500 })
          .bindTooltip(
            `Linie ${bus.line} → ${bus.direction}<br>${delayLabel(bus.delayMinutes)}`,
            { direction: "top", offset: [0, -ICON_BOX / 2] }
          )
          .on("click", () => { setSelectedStop(null); setSelectedBus((prev) => prev?.tripId === bus.tripId ? null : bus); })
          .addTo(map);
        busMarkersRef.current.set(bus.tripId, marker);
      } else {
        const marker = busMarkersRef.current.get(bus.tripId)!;
        marker.setLatLng([displayLat, displayLng]);
        marker.setIcon(icon);
        marker.setTooltipContent(
          `Linie ${bus.line} → ${bus.direction}<br>${delayLabel(bus.delayMinutes)}`
        );
      }
    }
  }, [buses, gtfs]);

  useEffect(() => {
    setSelectedBus((prev) => {
      if (!prev) return null;
      return buses.find((b) => b.tripId === prev.tripId) ?? null;
    });
  }, [buses]);

  const focusBus = (bus: Bus) => {
    setSelectedBus(bus);
    setSelectedStop(null);
    if (bus.position && mapInstance.current)
      mapInstance.current.setView([bus.position.lat, bus.position.lng], 15, { animate: true });
  };

  const activeBuses = buses.filter((b) => b.position !== null);

  const nextStopTime = (bus: Bus): Date | null => {
    if (!bus.nextStop) return null;
    const s = bus.stops.find((st) => st.name === bus.nextStop);
    return s?.departureIst ?? s?.departureSoll ?? s?.arrivalIst ?? s?.arrivalSoll ?? null;
  };

  const fmtTime = (d: Date) => d.toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit" });
  const fmtNextStop = (d: Date) => {
    const diffMin = (d.getTime() - Date.now()) / 60_000;
    if (diffMin < 0) return null;
    if (diffMin < 20) return `in ${Math.round(diffMin)} Min`;
    return fmtTime(d);
  };

  // Derive per-line delay hints from live data
  const lineDelayMap = new Map<string, number[]>();
  for (const bus of activeBuses) {
    if (!lineDelayMap.has(bus.line)) lineDelayMap.set(bus.line, []);
    lineDelayMap.get(bus.line)!.push(bus.delayMinutes);
  }
  const delayedLines = [...lineDelayMap.entries()]
    .map(([line, delays]) => ({ line, avg: delays.reduce((a, b) => a + b, 0) / delays.length }))
    .filter(({ avg }) => avg >= 5)
    .sort((a, b) => b.avg - a.avg);


  return (
    <div className="layout">
      {overlayVisible && (
        <div className={`loading-overlay${overlayFading ? " fading" : ""}`}>
          <div className="loading-card">
            <img src="/oz-logo.png" alt="OpenZirndorf" className="loading-logo" />
            <h1 className="loading-title">Zirndorf Mobil</h1>
            <p className="loading-subtitle">Busse &amp; Bahnen in Echtzeit</p>
            <div className="loading-bus-track">
              <img src={busImgUrl} className="loading-bus-img" alt="" aria-hidden="true" />
              <div className="loading-road" />
            </div>
            <div className="loading-spinner" aria-hidden="true" />
            <span className="loading-status">Echtzeitdaten werden geladen…</span>
          </div>
        </div>
      )}

      <div className="map-wrap">
        <div ref={mapRef} className="map" />
        <div className="beta-ribbon">Beta</div>
      </div>

      <button
        type="button"
        className={`sidebar-toggle ${sidebarOpen ? "open" : ""}`}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? "Seitenleiste einklappen" : "Seitenleiste ausklappen"}
      >
        <span className="sidebar-toggle-desktop">{sidebarOpen ? "›" : "‹"}</span>
        <span className="sidebar-toggle-mobile">{sidebarOpen ? "▼ Schließen" : "▲ Linien & Abfahrten"}</span>
      </button>

      <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="sidebar-header">
          <div>
            <a href="https://openzirndorf.de" target="_blank" rel="noopener noreferrer" className="sidebar-brand"><span className="sidebar-brand-dot" />OpenZirndorf</a>
            <h1>Zirndorf Mobil</h1>
            <p className="subtitle">Busse &amp; Bahnen in Echtzeit</p>
          </div>
          <div className="meta">
            {loading && <span className="badge loading">Lade…</span>}
            {error && <span className="badge error">{error}</span>}
            {lastUpdate && !loading && !error && (
              <span className="badge ok">
                ● {lastUpdate.toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
        </div>

        <div className="legend">
          <span style={{ color: "#15803D" }}>● pünktlich</span>
          <span style={{ color: "#B45309" }}>● 1–4 Min</span>
          <span style={{ color: "#B91C1C" }}>● &gt;4 Min</span>
        </div>

        <div className="poi-toggles">
          <button
            type="button"
            className={`poi-toggle ${stopsVisible ? "active" : ""}`}
            onClick={() => setStopsVisible((v) => !v)}
            title="Bushaltestellen ein-/ausblenden"
          >
            <img src={haltestelleImgUrl} style={{ width: 16, height: 16 }} alt="" /> Haltestellen
          </button>
          <button
            type="button"
            className={`poi-toggle ${poisVisible.park_ride ? "active" : ""}`}
            onClick={() => setPoisVisible((v) => ({ ...v, park_ride: !v.park_ride }))}
            title="P+R Parkplätze ein-/ausblenden"
          >
            <img src={prImgUrl} style={{ width: 16, height: 16 }} alt="" /> P+R
          </button>
          <button
            type="button"
            className={`poi-toggle ${poisVisible.bicycle_parking ? "active" : ""}`}
            onClick={() => setPoisVisible((v) => ({ ...v, bicycle_parking: !v.bicycle_parking }))}
            title="Fahrradabstellplätze ein-/ausblenden"
          >
            <img src={fahrradImgUrl} style={{ width: 16, height: 16 }} alt="" /> Fahrrad
          </button>
          <button
            type="button"
            className={`poi-toggle ${poisVisible.taxi ? "active" : ""}`}
            onClick={() => setPoisVisible((v) => ({ ...v, taxi: !v.taxi }))}
            title="Taxistände ein-/ausblenden"
          >
            <img src={taxiImgUrl} style={{ width: 16, height: 16 }} alt="" /> Taxi
          </button>
          <button
            type="button"
            className={`poi-toggle ${poisVisible.toilets ? "active" : ""}`}
            onClick={() => setPoisVisible((v) => ({ ...v, toilets: !v.toilets }))}
            title="Öffentliche Toiletten ein-/ausblenden"
          >
            <img src={wcImgUrl} style={{ width: 16, height: 16 }} alt="" /> WC
          </button>
        </div>

        {delayedLines.length > 0 && (
          <div className="disruption-banner">
            <span className="disruption-icon">⚠</span>
            <div className="disruption-body">
              {delayedLines.map(({ line, avg }) => (
                <span key={line}>Linie {line}: Ø +{Math.round(avg)} Min Verspätung</span>
              ))}
              <a href="https://www.vag.de/fahrplan/fahrplanaenderungen-stoerungen"
                target="_blank" rel="noopener noreferrer" className="disruption-link">
                Offizielle Störungsinfos →
              </a>
            </div>
          </div>
        )}

        {activeBuses.length === 0 && !loading && (
          <div className="empty">Gerade keine Busse in Zirndorf unterwegs</div>
        )}

        <ul className="bus-list">
          {activeBuses.map((bus) => {
            const info = gtfs?.lineInfo[bus.line];
            return (
              <li
                key={bus.tripId}
                className={`bus-item ${selectedBus?.tripId === bus.tripId ? "selected" : ""}`}
                onClick={() => focusBus(bus)}
              >
                <div className="line-badge" style={{ background: delayColor(bus.delayMinutes) }}>
                  {bus.line}
                </div>
                <div className="bus-info">
                  <span className="direction">→ {bus.direction}</span>
                  {bus.nextStop && <span className="next-stop">nächste: {bus.nextStop}</span>}
                  {info && (
                    <span className="line-type">{routeTypeLabel(info.type)}</span>
                  )}
                </div>
                <div className="delay">
                  {(() => { const t = nextStopTime(bus); const s = t && fmtNextStop(t); return s ? <span className="next-stop-time">{s}</span> : null; })()}
                  <span style={{ color: delayColor(bus.delayMinutes) }}>{delayLabel(bus.delayMinutes)}</span>
                </div>
              </li>
            );
          })}
        </ul>

        {selectedStop && (
          <div className="trip-detail">
            <div className="trip-header">
              <strong style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selectedStop.name}
              </strong>
              <button type="button" className="close-btn" onClick={() => setSelectedStop(null)}>✕</button>
            </div>
            {selectedStop.loading ? (
              <div className="empty">Lade Abfahrten…</div>
            ) : selectedStop.departures.length === 0 ? (
              <div className="empty">Keine Abfahrten in den nächsten 90 Min.</div>
            ) : (
              <div className="stop-list">
                {selectedStop.departures.map((dep, i) => (
                  <div key={i} className="dep-row">
                    <div className="line-badge" style={{ background: delayColor(dep.delayMin), fontSize: "0.75rem", padding: "2px 5px" }}>
                      {dep.line}
                    </div>
                    <span className="dep-dir">→ {dep.direction}</span>
                    <span className="dep-time">
                      {dep.actualTime.toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    {dep.delayMin > 0 && (
                      <span className="dep-delay" style={{ color: delayColor(dep.delayMin) }}>+{dep.delayMin}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {selectedBus && (() => {
          const info = gtfs?.lineInfo[selectedBus.line];
          return (
            <div className="trip-detail">
              <div className="trip-header">
                <strong>Linie {selectedBus.line}</strong>
                <span className="trip-dir">→ {selectedBus.direction}</span>
                <button type="button" className="close-btn" onClick={() => setSelectedBus(null)}>✕</button>
              </div>
              {info && (
                <div className="trip-fullname">{info.name}</div>
              )}
              {selectedBus.nextStop && (() => {
                const t = nextStopTime(selectedBus);
                return (
                  <div className="trip-next-stop">
                    <span className="trip-next-label">Nächste Haltestelle</span>
                    <span className="trip-next-name">{selectedBus.nextStop}</span>
                    {t && <span className="trip-next-time">{fmtTime(t)}</span>}
                  </div>
                );
              })()}
              <div className="stop-list">
                {selectedBus.stops.map((stop, i) => {
                  const time = stop.departureIst ?? stop.arrivalIst ?? stop.departureSoll;
                  const isCurrent = stop.name === selectedBus.prevStop;
                  const isPast = time !== null && time < new Date();
                  return (
                    <div key={i} className={`stop-row ${isCurrent ? "current" : ""} ${isPast ? "past" : ""}`}>
                      <span className="stop-dot" />
                      <span className="stop-name">{stop.name}</span>
                      {time && (
                        <span className="stop-time">
                          {time.toLocaleTimeString("de", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <footer className="sidebar-footer">
          <div className="footer-links">
            <a href="https://opendata.vag.de" target="_blank" rel="noopener noreferrer">VAG PULS</a>
            {" · "}
            <a href="https://www.vgn.de/web-entwickler/open-data/" target="_blank" rel="noopener noreferrer">VGN GTFS</a>
            {" · "}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OSM</a>
            {" · "}
            <a href="https://openzirndorf.de/impressum" target="_blank" rel="noopener noreferrer">Impressum</a>
            {" · "}
            <button type="button" className="disclaimer-btn" onClick={() => setDisclaimerOpen(true)}>Hinweis ⓘ</button>
          </div>
          <div className="footer-bottom">
            <a href="https://openzirndorf.de" target="_blank" rel="noopener noreferrer">OpenZirndorf</a>
            {" · "}
            <a href="https://portal.openzirndorf.de" target="_blank" rel="noopener noreferrer">Alle Apps →</a>
            {" · "}Made with ❤️ in Zirndorf
          </div>
        </footer>

        {disclaimerOpen && (
          <div className="disclaimer-backdrop" onClick={() => setDisclaimerOpen(false)}>
            <div className="disclaimer-modal" onClick={(e) => e.stopPropagation()}>
              <div className="disclaimer-header">
                <strong>Hinweise &amp; Quellen</strong>
                <button type="button" className="close-btn" onClick={() => setDisclaimerOpen(false)}>✕</button>
              </div>
              <div className="disclaimer-body">
                <p>
                  <strong>Zirndorf Mobil</strong> ist ein OpenZirndorf-Projekt und stellt Echtzeitdaten
                  des öffentlichen Nahverkehrs im Raum Zirndorf visuell dar. Wir erheben selbst keine
                  Fahrzeugdaten, sondern nutzen ausschließlich öffentlich zugängliche Quellen:
                </p>
                <ul>
                  <li><a href="https://opendata.vag.de" target="_blank" rel="noopener noreferrer">VAG PULS API</a> – Echtzeit-Abfahrten &amp; Verspätungen (VAG Nürnberg)</li>
                  <li><a href="https://www.vgn.de/web-entwickler/open-data/" target="_blank" rel="noopener noreferrer">VGN GTFS-Daten</a> – Fahrpläne, Haltestellen, Linienverläufe</li>
                  <li><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> – Kartenmaterial &amp; Streckenverlauf (© OSM-Mitwirkende)</li>
                  <li><a href="https://overpass-api.de" target="_blank" rel="noopener noreferrer">Overpass API</a> – POI-Daten (P+R, Fahrradstellplätze, Taxistände)</li>
                </ul>
                <p className="disclaimer-note">
                  <strong>Wichtig:</strong> Die Fahrzeugpositionen werden <em>interpoliert</em> –
                  berechnet aus Abfahrts- und Ankunftszeiten laut Fahrplan sowie gemeldeten Verspätungen.
                  Es handelt sich <em>nicht</em> um GPS-Echtpositionen. Die tatsächliche Position kann
                  abweichen. Herzlichen Dank an <strong>VAG</strong> und <strong>VGN</strong> für die
                  Bereitstellung der offenen Daten!
                </p>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
