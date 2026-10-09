/**
 * Kleine localStorage-Helfer. Nur für Komfort-Einstellungen (gemerkte
 * Haltestellen, Linienfilter) – bleibt auf dem Gerät. localStorage kann in
 * privaten Fenstern oder bei blockierten Website-Daten fehlen/werfen, daher
 * immer mit Fallback.
 */

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher nicht verfügbar – Einstellung gilt dann nur für diese Sitzung */
  }
}
