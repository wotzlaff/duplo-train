# DUPLO Train Web Control (Web Bluetooth)

A single-page web app that talks to the LEGO DUPLO Train hub over BLE **exactly the
way the official Android app does** (`com.lego.duplo.train` 1.8.16). The BLE mechanics
were reverse-engineered from that APK — the full evidence trail is in
[`../BLE-MECHANICS.md`](../BLE-MECHANICS.md).

## Run it

```bash
cd webapp
python3 -m http.server 8000        # or any static file server
# open http://localhost:8000 in Chrome or Edge
```

- **HTTPS or `localhost` is mandatory** (Web Bluetooth is a secure-context API).
  Serving plain HTTP on anything other than localhost will not expose `navigator.bluetooth`.
- **Chrome / Edge only** (desktop with a BLE adapter, or Android). Safari and Firefox
  do not implement Web Bluetooth.

## Using it

1. Switch the train on, and **close the LEGO app** (and anything else connected to it) —
   the hub only advertises when it is free. No other app = no advertisements.
2. Click **📡 Find train…** and pick the device in the chooser.
   - **2018–2024 trains** (10874, 10875, 10877, 10882 — "Hub No. 5" `0x20`): they
     advertise an **empty name**, so pick the entry shown for the LEGO hub,
     e.g. '(empty name — 2018 trains advertise no name)'. **No pairing/bonding.**
   - **2025 train** (10427 — "Hub No. 16" `0x21`): **requires bonding**; accept the
     Chrome pairing dialog when it appears.
3. Everything else is automatic, mirroring the app: CCCD notifications are enabled,
   hub property requests (button/battery/FW/HW) go out, ports are resolved from
   *Hub Attached I/O* by device type, colour/speedometer/voltage sensors are
   subscribed with delta 1.
4. Drive the slider (−100…+100 = reverse…forward), play sounds, set LED colours,
   power the hub off with Hub Action `0x01`.

### Advert watch (optional, Chrome experimental)

**🔭 Advert watch** uses `requestLEScan` + `watchAdvertisements` to decode the LEGO
manufacturer data (id **919 / 0x0397**: button, system type, capabilities, status…).
Enable it first at `chrome://flags/#enable-experimental-web-platform-features`
(this is the web analogue of the app's raw no-filter scan + mfr-data sniffing).

## What matches the app 1:1

| Mechanic | App (CUBB layer) | Web app |
|---|---|---|
| Scan filter | empty filter list, client-side check for service `1623` + mfr id 919 | `requestDevice({filters:[{services:[1623]}]})` (same end effect) |
| GATT service/char | `00001623-…abcd123` / `00001624-…abcd123` (write-wo-response + notify) | same |
| Notifications | `setCharacteristicNotification` + CCCD `0100` | `startNotifications()` |
| Writes | `SendThrottler`: **4 packets / 80 ms**, write-without-response | same queue/window implementation |
| Speed streaming | Unity loop pushes the speed setpoint continuously (throttler "overtake" keeps freshest); re-sends cover the hub's unreliable motor channel (Legoino #52: single writes often lost, resend ~100 ms) | last commanded speed re-sent every **100 ms** while ≠ 0, + immediate repeat on change |
| Port discovery | *Hub Attached I/O* events, resolve by device type (motor `0x29`… voltage `0x14`) | same table |
| Motor | `[08 00 81 p 11 51 00 s8]` s8 −100…+100 | same bytes |
| Sounds | `[08 00 81 p 11 51 01 id]` (3,5,7,9,10) | same |
| LED | `[08 00 81 p 11 51 00 color]` LWP3 palette 0–10/255 | same |
| Sensors | `[0A 00 41 p mode delta-u32 01]`, delta = 1 | same |
| Hub props | ops: `05` request / `02` enable (button 2, battery 6, FW 3, HW 4) | same |
| Power off | Hub Action `0x01` | same |

## Troubleshooting

- **Sounds flaky** → the hub drops audio writes more often than motor writes (Legoino #52), and blind re-sends would interrupt a playing sound. The app therefore: subscribes the speaker port's mode once on attach (Legoino parity), tracks hub feedback (0x82), and re-sends at most a few times spaced 250 ms — stopping the moment the hub confirms completion.
- **Train starts and then stops right away / motor commands flaky** → that is a
  known trait of these hubs: single motor writes get dropped frequently on
  2018 *and* 2025 hubs (Legoino issue #52 — the library author's solution:
  resend the speed every ~100 ms). The web app therefore keeps re-sending the
  last commanded setpoint **every 100 ms** while it is non-zero, plus an
  immediate repeat on each speed change — mirroring how the official app
  streams the setpoint through its throttler. Stop (`0`) is still sent twice.
- **Device not in chooser** → LEGO app still open, hub already connected, or hub off.
- **Connect fails on 2025 hub** → bonding declined/missed; re-pick the device and accept pairing.
- **Nothing moves** → check the Inspector log for `0x45 Port Value` / `0x82 feedback`;
  hex TX/RX lines are on by default.
- Uncheck *Throttle writes like the app* to lift the 4/80 ms pacing (handy for debugging,
  the real app tunes this too via `SetNoAckParameters`).
- This is a browser app: a fresh page reload does not keep the BLE connection;
  re-run *Find train…* (Chrome may re-offer the previously chosen device in one click).

## Files

- `index.html` — UI + inspector log
- `app.js` — the whole implementation (LWP3 framing, throttler, decoding)
- `style.css` — styling
- Validation: `../analysis/webapp_smoke.py` runs the command builders, throttler and
  DOM bootstrap under QuickJS — run with the venv once `quickjs` is installed
  (`pip install quickjs`).
