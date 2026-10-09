/** Nächstgelegene Haltestellen – läuft komplett lokal, der Standort verlässt das Gerät nicht. */
import type { GtfsData } from "./gtfs";

export interface NearbyStop {
  vgnId: number;
  name: string;
  distanceM: number;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestStops(gtfs: GtfsData, lat: number, lng: number, count = 5, maxM = 2_000): NearbyStop[] {
  return Object.entries(gtfs.stopsByVgnId)
    .map(([vgnId, s]) => {
      // Abstand zum nächsten Steig, nicht nur zur ersten Position
      const positions = s.steige ?? [{ lat: s.lat, lng: s.lng }];
      const distanceM = Math.min(...positions.map((p) => haversineM(lat, lng, p.lat, p.lng)));
      return { vgnId: parseInt(vgnId), name: s.name, distanceM };
    })
    .filter((s) => s.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, count);
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}
