<p align="center">
  <img src="public/oz-logo.png" width="72" alt="OpenZirndorf Logo" />
</p>

<h1 align="center">Zirndorf Mobil</h1>

<p align="center">
  Echtzeitkarte des ÖPNV im Zirndorfer Gemeindegebiet —<br>
  Busse, S-Bahn und Regionalbahn live auf der Karte.
</p>

<p align="center">
  <a href="https://mobil.openzirndorf.de"><strong>→ mobil.openzirndorf.de</strong></a>
  &nbsp;·&nbsp;
  <a href="https://openzirndorf.de">Ein Projekt von OpenZirndorf</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Beta-F59E0B?style=flat-square" alt="Beta" />
  <img src="https://img.shields.io/badge/Hosting-GitHub%20Pages-181717?style=flat-square&logo=github" alt="GitHub Pages" />
  <img src="https://img.shields.io/badge/Daten-VGN%20Open%20Data-009A00?style=flat-square" alt="VGN Open Data" />
</p>

---

![Zirndorf Mobil Screenshot](docs/screenshot.png)

---

## Features

- 🚌 **Live-Positionen** aller Busse (VAG/VGN) und Bahnen (S4, RB 11, RE 90) im Zirndorfer Raum
- ⏱️ **Echtzeit-Verspätungsdaten** für Busse via VAG PULS API (Züge via DB REST API, sofern erreichbar)
- 🗓️ **Fahrplaninterpolation** für S-Bahn, Regionalbahn und Busfahrten, die PULS nicht kennt (GTFS-basiert)
- 🛤️ **Schienenstrecken** exakt entlang der OSM-Gleisgeometrie
- 🏠 **Haltestellenabfahrten** per Klick auf jede Haltestelle (PULS mit Echtzeit, sonst Fahrplan aus der VGN-EFA)
- 📍 **Haltestellen in meiner Nähe** – Standort wird nur lokal ausgewertet, nie übertragen
- ⭐ **Meine Haltestellen** merken und **Linien filtern** (nur lokal im Browser gespeichert)
- 🔗 **Teilbare Links** zu Haltestellen: `mobil.openzirndorf.de/#halt=<VGN-ID>` (z. B. für QR-Codes)
- 🌙 **Dunkelmodus** (folgt der System-Einstellung), Tastaturbedienung und Screenreader-Beschriftungen
- 📲 **Installierbar (PWA)** – App-Shell und Kartenkacheln werden gecacht
- 🔒 **Keine Verbindung zu Google** – Schriften (Inter, Montserrat, OFL) werden selbst ausgeliefert
- 📍 **POI-Layer:** Bushaltestellen, P+R, Fahrrad, Taxi, WC
- ⚠️ **Störungsbanner** bei Linien mit hoher Durchschnittsverspätung


## Technologie

| Schicht | Technologie |
|---|---|
| Frontend | React + TypeScript + Vite |
| Karte | Leaflet + OpenStreetMap |
| Echtzeitdaten Busse | VAG VGN API |
| Echtzeitdaten Bahn | DB REST API (v6.db.transport.rest) – derzeit oft nicht erreichbar |
| Abfahrten ohne PULS | VGN EFA (`efa.vgn.de`, nur Fahrplan) |
| Fahrplandaten | VGN GTFS Open Data |
| Schienengeometrie | OpenStreetMap / Overpass API |
| POI-Daten | OpenStreetMap / Overpass API |
| Hosting | GitHub Pages |

## Lokale Entwicklung

**Voraussetzungen:** Node.js ≥ 20, pnpm

```bash
# Abhängigkeiten installieren
pnpm install

# GTFS-Daten einmalig aufbauen (dauert ~2 Min, Overpass-Anfragen)
pnpm gtfs

# Entwicklungsserver starten
pnpm dev
```

Die App läuft dann unter `http://localhost:5173`.

### GTFS-Daten aktualisieren

```bash
pnpm gtfs
```

Overpass-Anfragen werden gecacht — bei unveränderter Streckenführung reicht ein erneuter `pnpm gtfs` nach dem Fahrplanwechsel.

## Deployment auf GitHub Pages

### Einmalige Einrichtung

**1. Repository auf GitHub anlegen** (öffentlich oder privat mit Pages-Plan)

**2. GitHub Pages aktivieren:**
Repository → Settings → Pages → Source: **GitHub Actions**

**3. Custom Domain eintragen:**
Repository → Settings → Pages → Custom domain: `mobil.openzirndorf.de`
*(Die `public/CNAME`-Datei ist bereits angelegt)*

**4. DNS-Eintrag beim Domain-Anbieter setzen:**
```
Typ:   CNAME
Name:  mobil
Wert:  <github-nutzername>.github.io
```
Danach kann es bis zu 24 h dauern, bis GitHub das TLS-Zertifikat ausstellt.

**5. Code pushen:**
```bash
git init                          # falls noch kein Git-Repo
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<nutzer>/<repo>.git
git push -u origin main
```

Der GitHub Actions Workflow (`.github/workflows/deploy.yml`) baut bei jedem Push auf `main` automatisch die GTFS-Daten neu und deployt die App. Laufzeit ca. 2–3 Minuten.

### GitHub Actions Badge einbinden

Nach dem ersten erfolgreichen Deploy den Badge-Link anpassen — in dieser README oben:
```
https://github.com/<nutzer>/<repo>/actions/workflows/deploy.yml/badge.svg
```

### Manuelles Deployment auslösen

Repository → **Actions → Deploy to GitHub Pages → Run workflow**

### Hinweis: GTFS-Daten

`public/gtfs_stops.json` und `public/gtfs_routes.json` werden im Workflow bei jedem Deploy neu gebaut – zusätzlich **wöchentlich per Cron** (montags), damit Fahrplanwechsel ankommen. Die eingecheckten Dateien dienen als Cache für die Streckengeometrie (BRouter/Overpass).

Dabei prüft `pnpm gtfs` auch alle Haltestellen gegen die VAG PULS API und berechnet die **Poll-Haltestellen**: die kleinste Menge an Haltestellen, an deren Abfahrtsmonitoren jede Busfahrt im Gebiet vorbeikommt. Fahrten ohne PULS-bekannten Halt im Gebiet (z. B. Linie 126) werden als `pulsless` markiert und nach Fahrplan angezeigt.

> GitHub deaktiviert Cron-Workflows nach 60 Tagen ohne Repo-Aktivität – dann unter *Actions* wieder aktivieren.

## Datenquellen & Lizenzen

| Quelle | Lizenz |
|---|---|
| [VGN Echtzeitdaten](https://www.vgn.de/web-entwickler/open-data/) | CC BY 4.0 |
| [VGN GTFS-Fahrplandaten](https://www.vgn.de/opendata/GTFS.zip) | CC BY 4.0 |
| [DB REST API](https://v6.db.transport.rest) | hafas-client (MIT) |
| [VGN EFA](https://www.vgn.de/web-entwickler/open-data/) | CC BY 4.0 |
| [OpenStreetMap](https://www.openstreetmap.org) | ODbL |
| [Overpass API](https://overpass-api.de) | ODbL |

## Projektstruktur

```
src/
  App.tsx          # Hauptkomponente, Karte, UI
  api.ts           # VAG PULS, VGN EFA, DB REST API, Positionsinterpolation
  gtfs.ts          # GTFS-Typen, Shape-Matching
  types.ts         # Gemeinsame TypeScript-Typen
  assets/          # Icons (bus.png, sbahn.png, haltestelle.png, …)
scripts/
  build-gtfs.ts    # GTFS-Parser, Routing, Poll-Haltestellen → public/gtfs_*.json
docs/
  screenshot.png   # App-Screenshot für README
public/
  CNAME            # Custom Domain für GitHub Pages
  oz-logo.png      # OpenZirndorf Logo (Original, nur README/Sharepic)
  oz-logo-192.png  # Favicon, Ladebildschirm, PWA-Icon
  oz-logo-512.png  # PWA-Icon
```
