// ── Raw API types ─────────────────────────────────────────────────────────────

export interface HaltestelleRaw {
  Haltestellenname: string;
  VAGKennung: string;
  VGNKennung: number;
  Longitude: number;
  Latitude: number;
  Produkte?: string;
}

export interface AbfahrtRaw {
  Linienname: string;
  Richtungstext: string;
  AbfahrtszeitSoll: string;
  AbfahrtszeitIst: string;
  Fahrtnummer: number;
  Fahrzeugnummer: string;
  Produkt: string;
  Prognose: boolean;
  Betriebstag: string;
}

export interface FahrtHaltRaw {
  Haltestellenname: string;
  VAGKennung: string;
  VGNKennung: number;
  Longitude: number;
  Latitude: number;
  AnkunftszeitSoll?: string;
  AnkunftszeitIst?: string;
  AbfahrtszeitSoll?: string;
  AbfahrtszeitIst?: string;
}

// ── App types ─────────────────────────────────────────────────────────────────

export interface Stop {
  name: string;
  vgnId: number;
  vagId: string;
  lat: number;
  lng: number;
}

export interface TripStop {
  name: string;
  lat: number;
  lng: number;
  arrivalIst: Date | null;
  departureIst: Date | null;
  arrivalSoll: Date | null;
  departureSoll: Date | null;
}

export interface Bus {
  tripId: number;
  line: string;
  direction: string;
  vehicleId: string;
  betriebstag: string;
  stops: TripStop[];
  /** Interpolated GPS position (stop-based fallback until road geometry loads) */
  position: { lat: number; lng: number } | null;
  delayMinutes: number;
  prevStop: string | null;
  nextStop: string | null;
  /** Index of the stop-pair segment the bus is currently between */
  segmentIndex: number;
  /** 0–1 progress within that stop-pair segment */
  segmentT: number;
  /** Bearing in degrees from north (0=N, 90=E, 180=S, 270=W) */
  bearing: number;
}
