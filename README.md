# 🚂 DUPLO Train · Web Control

**Der LEGO® DUPLO® Zug, gesteuert direkt aus dem Browser.**

Koppeln, fahren, hupen, Licht umschalten – ohne App-Store, ohne Konto, ohne Cloud.
Die Web-App spricht das **LEGO Wireless Protocol v3 (LWP3)** und wurde aus der
offiziellen Android-App `com.lego.duplo.train` (1.8.16) reverse-engineert.

**Live (nach Aktivierung von GitHub Pages):**
[Projektseite](https://wotzlaff.github.io/duplo-train/) ·
[Steuerung](https://wotzlaff.github.io/duplo-train/control/)

> Unabhängiges Projekt. Keine Verbindung zur LEGO Gruppe. LEGO und DUPLO sind
> Marken der LEGO Gruppe.

---

## Inhalt

- [Was ist das?](#was-ist-das)
- [Die zwei Ansichten](#die-zwei-ansichten)
- [Schnellstart](#schnellstart)
- [GitHub Pages](#github-pages)
- [Repository-Struktur](#repository-struktur)
- [Technik](#technik)
- [Kompatibilität](#kompatibilität)
- [Fehlerbehebung](#fehlerbehebung)
- [Reverse Engineering](#reverse-engineering)
- [Lizenz](#lizenz)

---

## Was ist das?

Eine statische Website mit zwei Teilen:

| Pfad | Inhalt |
|---|---|
| `/` | Projektseite mit Funktionsübersicht, Protokoll-Doku und Startanleitung |
| `/control/` | Die eigentliche Web-Bluetooth-Steuerung |

Die Steuerung nutzt **Web Bluetooth** und verbindet sich direkt mit dem
DUPLO-Train-Hub. Es gibt keinen Server, kein Backend, kein Tracking. Alle
Daten bleiben zwischen Browser und Zug.

---

## Die zwei Ansichten

### 🎮 Einfach

Für den Alltag – alle Grundfunktionen ohne Sucherei:

- Zug suchen und koppeln
- Fahren von −100 bis +100, große Plus-/Minus-Tasten, Stopp
- Hupe (Sound-ID 9)
- Licht an/aus mit einem Tipp

### 🛠️ Experte

Alles, was das Protokoll hergibt:

- alle fünf dokumentierten Sounds plus freie Sound-ID (0–255)
- vollständige LWP3-Farbpalette (0–10 und „keine Farbe“)
- Anschlüsse und Port-Modi des Hubs
- Farbsensor, Tacho, Spannung, Akku, RSSI
- 60-Sekunden-Verlauf von Tacho und RSSI
- Geräte-Details: ID, Name, Hub-Typ, Firmware/Hardware, Taster
- Hex-Debug-Logs (TX/RX), kopierbar
- SendThrottler abschaltbar (4 Pakete / 80 ms → ungedrosselt)
- experimenteller Advert-Watch für die LEGO-Herstellerdaten (`0x0397`)

Die gewählte Ansicht wird im `localStorage` gemerkt.

---

## Schnellstart

Voraussetzungen:

- **Chrome oder Edge** (Desktop mit Bluetooth-Adapter oder Android)
- **HTTPS oder `localhost`** – Web Bluetooth ist eine Secure-Context-API
- eingeschalteter Zug, **LEGO-App geschlossen**, Hub mit nichts anderem verbunden

```bash
npm install
npm run dev
# http://localhost:5173
```

Dann:

1. „Steuerung öffnen“ bzw. `/control/` aufrufen.
2. **📡 Zug suchen …** antippen und den Hub auswählen.
3. Regler bewegen. Hupe und Licht stehen direkt daneben.
4. Für Details in den **Expertenmodus** wechseln.

Produktions-Build:

```bash
npm run build      # erzeugt dist/
npm run preview    # lokale Vorschau des Builds
```

---

## GitHub Pages

Das Repository ist für GitHub Pages vorbereitet. Der Workflow
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) baut die Seite bei
jedem Push auf `main` und veröffentlicht `dist/`.

Einmalig im Repository:

1. **Settings → Pages**
2. **Source: GitHub Actions**
3. Push auf `main`

Die Seite ist danach unter folgender Adresse erreichbar:

```
https://wotzlaff.github.io/duplo-train/
```

Die Steuerung liegt unter:

```
https://wotzlaff.github.io/duplo-train/control/
```

Der Workflow setzt `BASE_PATH` automatisch auf `/<repo-name>/`. Bei einem
User-/Organisations-Repository (`<name>.github.io`) bleibt es bei `/`.
Bei einem **privaten** Repository muss GitHub Pages im Plan freigeschaltet sein
(oder das Repository öffentlich gestellt werden).

Lokaler Build mit Pages-Basispfad:

```bash
BASE_PATH=/duplo-train/ npm run build
```

---

## Repository-Struktur

```
.
├── index.html                  Projektseite (Landing Page)
├── site/site.css               Styles der Projektseite
├── control/
│   ├── index.html              Steuerungsapp
│   ├── app.js                  LWP3, BLE, Throttler, UI-Logik
│   └── style.css               Styles der Steuerung
├── public/favicon.svg
├── BLE-MECHANICS.md            vollständige Reverse-Engineering-Notizen
├── analysis/                   DEX-Extraktion, Dumps, Smoke-Test
├── .github/workflows/deploy.yml
├── vite.config.js              Multi-Page-Build + Doku-Copy
├── package.json
└── LICENSE
```

Die App ist bewusst **framework-frei**: reines HTML, CSS und JavaScript.
Vite übernimmt nur Dev-Server und Multi-Page-Build.

---

## Technik

| Baustein | Umsetzung |
|---|---|
| Scan | `requestDevice({ filters: [{ services: [1623] }] })` |
| GATT | Service `00001623-…`, Characteristic `00001624-…` |
| Notifications | `startNotifications()` → CCCD `0100` |
| Writes | `writeValueWithoutResponse`, Fallback auf `writeValue` |
| Drosselung | 4 Pakete / 80 ms, Queue mit „Overtake“ für den Motor |
| Motor | `[08 00 81 PP 11 51 00 SS]`, `SS` als signed byte |
| Hupe | `[08 00 81 PP 11 51 01 09]` |
| Licht | LWP3-Farben 0–10, `0xFF` = aus |
| Keepalive | letzter Motorsollwert alle 100 ms, solange ≠ 0 |
| Ports | Auflösung über *Hub Attached I/O* nach Gerätetyp |
| Sensoren | Port Input Format Setup, Decoding nach gemeldetem Wertformat |
| Sounds | Retry nur ohne `0x82`-Fertigfeedback, damit nichts doppelt startet |
| Ausschalten | Hub Action `0x01` |

Die vollständigen Details, Byte-Tabellen und die Beweiskette aus dem APK stehen
in [BLE-MECHANICS.md](BLE-MECHANICS.md).

---

## Kompatibilität

| Generation | Hub | Sets | Besonderheit |
|---|---|---|---|
| 2018–2024 | Hub No. 5 (`0x20`) | 10874, 10875, 10877, 10882 | kein Bonding, leerer Advertise-Name |
| 2025 | Hub No. 16 (`0x21`) | 10427 | Bonding erforderlich, Chrome-Pairing bestätigen |

Beide Hubs werden über dieselbe LWP3-Schicht angesprochen. Die Ports werden zur
Laufzeit aus den *Attached I/O*-Events ermittelt.

---

## Fehlerbehebung

| Problem | Ursache / Lösung |
|---|---|
| Hub erscheint nicht im Auswahldialog | LEGO-App noch offen, Hub aus, oder bereits verbunden |
| Verbindung schlägt beim 2025er-Hub fehl | Pairing abgelehnt – erneut auswählen und bestätigen |
| Zug fährt an und stoppt sofort | bekanntes Verlustverhalten der Hubs; die App sendet den Sollwert alle 100 ms erneut |
| Sounds kommen unregelmäßig | Audio-Kanal ist verlustbehaftet; Retry wartet auf Hub-Feedback |
| Nichts bewegt sich | Expertenmodus → Hex-Log prüfen (`0x45`, `0x82`) |
| `navigator.bluetooth` fehlt | Chrome/Edge verwenden und über HTTPS oder `localhost` öffnen |
| Seite nach Reload nicht verbunden | BLE-Verbindung endet mit dem Reload; erneut „Zug suchen“ |

---

## Reverse Engineering

Grundlage ist das Play-Bundle-APK der offiziellen App:

- Paket `com.lego.duplo.train`, Version 1.8.16 (Code 4922)
- Unity/IL2CPP, eigene LEGO-Bluetooth-Bridge `dk.lego.cubb.*`
- Java-Schicht aus `classes.dex` extrahiert → [`analysis/dex-dumps/`](analysis/dex-dumps/)
- Abgleich mit der offiziellen
  [LEGO Wireless Protocol v3 Spezifikation](https://lego.github.io/lego-ble-wireless-protocol-docs/)
  und Community-Captures

Der Smoke-Test [`analysis/webapp_smoke.py`](analysis/webapp_smoke.py) prüft
Befehlsbytes, Throttler-Fenster, Keepalive und die Sound-Retry-Logik unter
QuickJS:

```bash
pip install quickjs
python analysis/webapp_smoke.py
```

---

## Lizenz

[MIT](LICENSE) für Code und Dokumentation.

LEGO und DUPLO sind Marken der LEGO Gruppe. Dieses Projekt ist ein unabhängiges
Reverse-Engineering-Vorhaben und steht in keiner Verbindung zur LEGO Gruppe.
