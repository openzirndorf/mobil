import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { enrichBusDelays, evictSegmentCache, fetchAllBuses, fetchRoadSegments, fetchStopDepartures, fetchZirndorfStops, refreshPositions, stopInZirndorf } from "./api";
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

// ── Static disruption notices ─────────────────────────────────────────────────

interface StaticNotice {
  from: string; // ISO datetime, local time (Europe/Berlin)
  to: string;
  lines: string[];
  text: string;
  /** Stop name substrings to remove from bus.stops before OSRM routing (all directions) */
  cancelledStops?: string[];
  /** Additional cancellations when bus.direction contains the given substring */
  cancelledStopsByDirection?: Record<string, string[]>;
}

const STATIC_NOTICES: StaticNotice[] = [
  {
    from: "2026-03-22T10:00:00",
    to:   "2026-03-22T21:00:00",
    lines: ["70"],
    text: "Frühlingsmarkt Zirndorf: Linie 70 fährt zwischen Kraftstraße und Am Grasweg über die Albert-Einstein-Straße. Haltestellen Bahnhof (Fürther Str.) und Marktplatz entfallen – Ersatzhalt direkt vor dem Bahnhof.",
    cancelledStops: ["Marktplatz"],
    // Richtung Nürnberg: auch Landratsamt entfällt (liegt auf dem gesperrten Abschnitt)
    cancelledStopsByDirection: { "Gustav-Adolf": ["Landratsamt"] },
  },
];

function activeNotices(): StaticNotice[] {
  const now = new Date();
  return STATIC_NOTICES.filter((n) => now >= new Date(n.from) && now <= new Date(n.to));
}

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
  const base = Math.round(Math.max(6, Math.min(32, 16 + (zoom - 13) * 3)));
  const size = isZirndorf ? base : Math.round(base * 0.7);
  return L.divIcon({
    className: "",
    html: `<img src="${haltestelleImgUrl}" width="${size}" height="${size}"
      style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.4))${isZirndorf ? "" : " opacity(0.6)"}" />`,
    iconAnchor: [size / 2, size / 2],
  });
}

// ── POI icons ─────────────────────────────────────────────────────────────────

interface Poi {
  lat: number;
  lng: number;
  name: string;
  type: "park_ride" | "bicycle_parking" | "taxi" | "toilets";
  toiletType?: "permanent" | "chemical" | "unknown";
  fee?: boolean;
}

function detectToiletType(tags: Record<string, string>): "permanent" | "chemical" | "unknown" {
  const disposal = tags["toilets:disposal"];
  const temporary = tags["temporary"];
  const operator = (tags["operator"] ?? "").toLowerCase();
  const building = tags["building"];
  if (disposal === "chemical" || temporary === "yes" || operator.includes("toi") || operator.includes("dixi") || operator.includes("wc box") || disposal === "pitlatrine") {
    return "chemical";
  }
  if (disposal === "flush" || building === "yes" || building === "toilets") {
    return "permanent";
  }
  return "unknown";
}

function toiletDisplayName(tags: Record<string, string>, toiletType: "permanent" | "chemical" | "unknown"): string {
  const base = tags.name ?? (toiletType === "chemical" ? "Chemietoilette (Dixi)" : "Öffentliche Toilette");
  const fee = tags.fee === "yes";
  return fee ? `${base} (kostenpflichtig)` : base;
}

const POI_SIZE = 36;
const POI_SIZE_BIKE = Math.round(POI_SIZE * 0.95);

function makePoiIcon(type: Poi["type"], toiletType?: Poi["toiletType"]): L.DivIcon {
  const src = type === "taxi" ? taxiImgUrl : type === "park_ride" ? prImgUrl : type === "toilets" ? wcImgUrl : fahrradImgUrl;
  const s = type === "bicycle_parking" ? POI_SIZE_BIKE : POI_SIZE;
  // Chemical toilets (Dixi) get an orange tint to distinguish them
  const filter = type === "toilets" && toiletType === "chemical"
    ? "drop-shadow(0 2px 5px rgba(0,0,0,0.45)) sepia(1) saturate(3) hue-rotate(350deg)"
    : "drop-shadow(0 2px 5px rgba(0,0,0,0.45))";
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;filter:${filter};">
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
  // Stop markers with isZirn flag for zoom-only icon updates
  const stopMarkersDataRef = useRef<Array<{ marker: L.Marker; isZirn: boolean }>>([]);
  // Trips already routed with correct detour stops (to avoid re-clearing on every tick)
  const detourRoutedRef = useRef<Set<number>>(new Set());
  // Guard: fetch Overpass POI data only once, on first POI-layer activation
  const poisFetchedRef = useRef(false);

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
  const [showSlowHint, setShowSlowHint] = useState(false);
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);

  // Fade out loading overlay once first data arrives
  useEffect(() => {
    if (!loading && overlayVisible) {
      setOverlayFading(true);
      const t = setTimeout(() => setOverlayVisible(false), 500);
      return () => clearTimeout(t);
    }
  }, [loading, overlayVisible]);

  // Show "first load takes longer" hint after 4 s of waiting
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setShowSlowHint(true), 4_000);
    return () => clearTimeout(t);
  }, [loading]);

  const busesRef = useRef<Bus[]>([]);
  busesRef.current = buses;
  const stopsRef = useRef<Stop[]>([]);
  stopsRef.current = stops;
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
    loadGtfsData((partial) => {
      // Fresh network data arrived (different generated timestamp) → clear shape cache
      // so buses are re-matched with the new shapes on next render.
      shapeRangesRef.current.clear();
      setGtfs(partial); gtfsRef.current = partial;
    }).then((full) => {
      // If routes weren't available yet (first network load), re-fetch buses now so
      // lines that needed GTFS fallback (fetchTripRoute failed) appear immediately.
      const hadRoutes = Object.keys(gtfsRef.current?.routeShapes ?? {}).length > 0;
      setGtfs(full); gtfsRef.current = full;
      if (!hadRoutes && stopsRef.current.length) refresh(stopsRef.current);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch P+R / POI from Overpass – lazy: only on first POI-layer activation ──
  useEffect(() => {
    const anyVisible = poisVisible.park_ride || poisVisible.bicycle_parking || poisVisible.taxi || poisVisible.toilets;
    if (!anyVisible || poisFetchedRef.current) return;
    poisFetchedRef.current = true;
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
          .map((el) => {
            const tags = el.tags ?? {};
            const amenity = tags.amenity;
            const type = (amenity === "bicycle_parking" ? "bicycle_parking" : amenity === "taxi" ? "taxi" : amenity === "toilets" ? "toilets" : "park_ride") as Poi["type"];
            const toiletType = type === "toilets" ? detectToiletType(tags) : undefined;
            const name = type === "toilets"
              ? toiletDisplayName(tags, toiletType!)
              : (tags.name ?? (amenity === "bicycle_parking" ? "Fahrradabstellplatz" : amenity === "taxi" ? "Taxistand" : "P+R Parkplatz"));
            return {
              lat: el.lat ?? el.center?.lat ?? 0,
              lng: el.lon ?? el.center?.lon ?? 0,
              name,
              type,
              toiletType,
              fee: tags.fee === "yes",
            };
          })
          .filter((p) => p.lat && p.lng)
        );
      })
      .catch(() => {});
  }, [poisVisible]);

  // ── Draw all GTFS stops once data loads (rebuilt only on data/visibility change) ──
  useEffect(() => {
    const map = mapInstance.current;
    if (!gtfs || !stopLayerRef.current || !map) return;
    stopLayerRef.current.clearLayers();
    stopMarkersDataRef.current = [];
    if (!stopsVisible) { stopLayerRef.current.remove(); return; }
    stopLayerRef.current.addTo(map);

    for (const [vgnId, stop] of Object.entries(gtfs.stopsByVgnId)) {
      const vgnIdNum = parseInt(vgnId);
      const positions = stop.steige ?? [{ lat: stop.lat, lng: stop.lng }];
      for (const pos of positions) {
        const isZirn = stopInZirndorf(pos.lat, pos.lng);
        const marker = L.marker([pos.lat, pos.lng], {
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
        stopMarkersDataRef.current.push({ marker, isZirn });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gtfs, stopsVisible]);

  // ── Update stop icon sizes on zoom (no full rebuild) ─────────────────────────
  useEffect(() => {
    for (const { marker, isZirn } of stopMarkersDataRef.current) {
      marker.setIcon(makeStopIcon(isZirn, zoom));
    }
  }, [zoom]);

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
      L.marker([poi.lat, poi.lng], { icon: makePoiIcon(poi.type, poi.toiletType), zIndexOffset: 200 })
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
      const threshold = now - REFRESH_INTERVAL_MS * 5;
      for (const b of fresh) busLastSeenRef.current.set(b.tripId, now);
      const mergeBuses = (base: Bus[], updated: Bus[]) => {
        const updatedMap = new Map(updated.map((b) => [b.tripId, b]));
        const kept = base.filter((b) => !updatedMap.has(b.tripId) && (busLastSeenRef.current.get(b.tripId) ?? 0) > threshold);
        return [...updated, ...kept];
      };
      // Wenn die API komplett leer zurückkommt obwohl vorher Busse da waren,
      // ist das ein API-Ausfall – alte Busse nicht löschen.
      if (fresh.length > 0 || busesRef.current.length === 0) {
        setBuses((prev) => mergeBuses(prev, fresh));
        // Enrich with delays in background – doesn't block initial render
        enrichBusDelays(fresh).then((enriched) => {
          setBuses((prev) => mergeBuses(prev, enriched));
        }).catch(() => {});
      }
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

      // Lines with active static notices use OSRM (detour) instead of pre-built GTFS shape
      const onDetour = staticNotices.some(n => n.lines.includes(bus.line));

      // First time we see a detour trip: clear any stale cached routes
      if (onDetour && !detourRoutedRef.current.has(bus.tripId)) {
        shapeRangesRef.current.delete(bus.tripId);
        osrmSegmentsRef.current.delete(bus.tripId);
        evictSegmentCache(bus.tripId);
      }

      // ── Match GTFS shape (once per trip) ────────────────────────────────────
      if (gtfs && !shapeRangesRef.current.has(bus.tripId) && !onDetour) {
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
      if (onDetour && !osrmSegmentsRef.current.has(bus.tripId)) {
        const notice = staticNotices.find(n => n.lines.includes(bus.line))!;
        const cancelledForDir = Object.entries(notice.cancelledStopsByDirection ?? {})
          .filter(([dir]) => bus.direction.includes(dir))
          .flatMap(([, stops]) => stops);
        const allCancelled = [...(notice.cancelledStops ?? []), ...cancelledForDir];
        const detourStops = allCancelled.length > 0
          ? bus.stops.filter(s => !allCancelled.some(c => s.name.includes(c)))
          : bus.stops;
        console.log(`[detour ${bus.line} dir="${bus.direction}"] cancelled:`, allCancelled, "stops:", detourStops.map(s => s.name));
        fetchRoadSegments(bus.tripId, detourStops).then((segs) => {
          osrmSegmentsRef.current.set(bus.tripId, segs);
          detourRoutedRef.current.add(bus.tripId);
          routeLinesRef.current.get(bus.tripId)?.setLatLngs(segs.flat());
        });
      }

      // ── Compute route coords (clipped from current segment to last stop) ────
      const gtfsCachedRoute = onDetour ? undefined : shapeRangesRef.current.get(bus.tripId);
      const osrmSegsRoute = osrmSegmentsRef.current.get(bus.tripId);
      let routeCoords: [number, number][];
      if (gtfsCachedRoute) {
        const { shape, ranges } = gtfsCachedRoute;
        // Start from current segment (not from trip start) to avoid showing already-traveled path
        const fromStop = bus.stops[Math.min(bus.segmentIndex, bus.stops.length - 1)];
        const toStop = bus.stops[bus.stops.length - 1];
        const fromSI = nearestShapeStop(shape, fromStop);
        const toSI = nearestShapeStop(shape, toStop);
        const c0 = ranges[Math.min(fromSI, ranges.length - 1)] ?? 0;
        const c1 = ranges[Math.min(toSI, ranges.length - 1)] ?? shape.coords.length - 1;
        routeCoords = c0 <= c1
          ? shape.coords.slice(c0, c1 + 1)
          : shape.coords.slice(c1, c0 + 1).reverse();
      } else if (osrmSegsRoute) {
        routeCoords = osrmSegsRoute.slice(bus.segmentIndex).flat() as [number, number][];
      } else {
        routeCoords = bus.stops.slice(bus.segmentIndex).map((s) => [s.lat, s.lng] as [number, number]);
      }

      // ── Route polyline ──────────────────────────────────────────────────────
      if (!routeLinesRef.current.has(bus.tripId)) {
        const line = L.polyline(routeCoords, { color, weight: 3, opacity: 0.75 }).addTo(map);
        routeLinesRef.current.set(bus.tripId, line);
      } else {
        const line = routeLinesRef.current.get(bus.tripId)!;
        line.setStyle({ color });
        if (gtfsCachedRoute || osrmSegsRoute) line.setLatLngs(routeCoords);
      }

      // ── Bus position: GTFS shape → OSRM fallback → stop interpolation ───────
      let displayLat = bus.position.lat;
      let displayLng = bus.position.lng;
      let bearing = bus.bearing;

      if (gtfsCachedRoute) {
        const { shape, ranges } = gtfsCachedRoute;
        const segCoords = shapeSlice(shape, ranges, bus.segmentIndex, bus.stops);
        if (segCoords.length >= 2) {
          const pt = pointOnPolyline(segCoords, bus.segmentT);
          displayLat = pt.lat; displayLng = pt.lng; bearing = pt.bearing;
        }
      } else if (osrmSegsRoute && bus.segmentIndex < osrmSegsRoute.length) {
        const seg = osrmSegsRoute[bus.segmentIndex];
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

  // Derive per-line delay hints from live data (only recompute when delays actually change)
  const delayedLines = useMemo(() => {
    const lineDelayMap = new Map<string, number[]>();
    for (const bus of activeBuses) {
      if (!lineDelayMap.has(bus.line)) lineDelayMap.set(bus.line, []);
      lineDelayMap.get(bus.line)!.push(bus.delayMinutes);
    }
    return [...lineDelayMap.entries()]
      .map(([line, delays]) => ({ line, avg: delays.reduce((a, b) => a + b, 0) / delays.length }))
      .filter(({ avg }) => avg >= 5)
      .sort((a, b) => b.avg - a.avg);
  // delayMinutes only changes on full API refresh (every 15s), not on position refresh (every 1s)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBuses.map((b) => `${b.tripId}:${b.delayMinutes}`).join(",")]);
  const staticNotices = activeNotices();


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
            {showSlowHint && (
              <p className="loading-slow-hint">Beim ersten Besuch etwas länger –<br />danach startet die App sofort.</p>
            )}
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

        {staticNotices.map((n, i) => (
          <div key={i} className="disruption-banner">
            <span className="disruption-icon">⚠</span>
            <div className="disruption-body">
              {n.lines.map((l) => (
                <span key={l} className="disruption-line-badge">Linie {l}</span>
              ))}
              <span>{n.text}</span>
            </div>
          </div>
        ))}

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
