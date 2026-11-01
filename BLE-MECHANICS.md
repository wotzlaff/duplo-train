# How the LEGO® DUPLO® Train app talks BLE (reverse-engineered)

Target: `external/com-lego-duplo-train-4922-61757855-0a6386dfd5ea152b4e5499a6bedc7f29.apk`
→ package `com.lego.duplo.train`, app name **Train**, version **1.8.16** (code 4922),
minSdk 21 / targetSdk 30, built with **Unity (IL2CPP)**, developed by LEGO + BKOM.

> Evidence for every statement below is in `analysis/dex-dumps/` (bytecode of the
> LEGO Bluetooth classes extracted from `classes.dex`). The Unity game logic
> (C#) is compiled to `libil2cpp.so`; this APK is a Play-Bundle *base* split,
> so `global-metadata.dat` is not present — the C# guts were cross-validated
> against the officially published LEGO protocol spec instead (see links).

---

## 1. Architecture: a Unity game on top of a dedicated LEGO Bluetooth stack

The app does **not** use a third-party BLE plugin. LEGO ships its own cross-platform
Bluetooth bridge, namespace `dk.lego.cubb.*` (CUBB = LEGO's internal BLE bridge
library), compiled into `classes.dex`:

```
┌──────────────────────────────┐
│  Unity C# game (IL2CPP)      │  game logic: train behaviour, sounds, colors…
│  libil2cpp.so                │  (native code, arm64-v8a / armeabi-v7a)
└──────────────┬───────────────┘
               │  UnitySendMessage / AndroidJavaObject
               ▼  (pipe-separated messages, see §3)
┌──────────────────────────────┐
│  dk.lego.cubb.unity.CUBBNative        │  Java bridge: command dispatch
│  dk.lego.cubb.model.*                 │  scan/connection state machine
│  dk.lego.cubb.bluetooth.*             │  GATT plumbing, throttled writes
│  dk.lego.cubb.bluetooth.wrappers.*    │  BluetoothAdapter/-Device/le.* wrappers
└──────────────┬───────────────┘
               │  android.bluetooth.*
               ▼
┌──────────────────────────────┐
│  BluetoothGatt / le core     │  the LEGO LWP3 protocol travels inside
└──────────────────────────────┘  one custom characteristic
```

Permissions demanded (AndroidManifest): `BLUETOOTH`, `BLUETOOTH_ADMIN`,
`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` (mandatory for LE scan on old
Androids), plus the usual Unity/web/vibration ones.

---

## 2. The GATT the app talks to (LEGO Wireless Protocol v3 / "LWP3")

The train (10874 Steam / 10875 Cargo / 10877/10882, and the 2025 set 10427) is a
**LEGO Powered Up hub**: one service, one characteristic. Water-tight
cross-check: the TI OAD firmware-update UUIDs found hardcoded in the DEX
(`F000FFC3/C4-0451-…`, used for the 2025 hub which sits on a TI CC26xx chip)
match the community capture of exactly this hub.

| BLE entity | UUID |
|---|---|
| **Service (LWP3)** | `00001623-1212-EFDE-1623-785FEABCD123` |
| **Characteristic (all traffic)** | `00001624-1212-EFDE-1623-785FEABCD123` |
| Bootloader service (FW update) | `00001625-1212-EFDE-1623-785FEABCD123` |
| Bootloader characteristic | `00001626-1212-EFDE-1623-785FEABCD123` |
| TI OAD service (2025 hub) | `F000FFC0-0451-4000-B000-000000000000` |
| CCCD descriptor (notify enable) | `00002902-0000-1000-8000-00805F9B34FB` |

Properties of characteristic 1624: **Write-without-response** + **Notify**.
Official spec: https://lego.github.io/lego-ble-wireless-protocol-docs/

Application-visible discovery flow (from `AndroidBluetoothDeviceWrapperImpl.handleServicesDiscovered`):
1. GATT connect → `discoverServices()`.
2. For every discovered service, keep it **only if** `DiscoveryFilters.isRecognizedService(uuid)` —
   the filter list is injected by the game at runtime (see JSON in §4.1).
3. For every characteristic, keep only `isRecognizedCharacteristic(uuid)`, remember it in
   "read" and "write" maps (the write one is a **deliberately cloned
   characteristic** — `utils/DocumentedHacks.cloneGattCharacteristicForWriting` —
   an Android GATT quirk workaround).
4. Every kept characteristic with `NotifyValue=true` gets notifications enabled:
   `setCharacteristicNotification(chr, true)` + write `0x0100` (`ENABLE_NOTIFICATION_VALUE`)
   to its CCCD `00002902` — through the same throttled sender as normal writes.

---

## 3. The game ⇄ bridge message protocol (what you'd reimplement)

Unity invokes Java `CUBBNative.handleMessageFromUnity(String)`; the Java side
posts to its own serial handler thread and splits the message on `|`.

### 3.1 Commands Unity → Java (`CUBBNative.evaluateMessage`)

| Command | Arguments (in order) | Effect |
|---|---|---|
| `Initialize` | `<b64 unit log>` + services JSON (§4.1) | installs GATT filter map + Unity logger |
| `SetScanState` | `T`/`F` | start / stop LE scan |
| `ConnectToDevice` | `<b64 deviceID>` \| `<options string>` (§4.2) | `connectGatt` |
| `DisconnectFromDevice` | `<b64 deviceID>` | `gatt.disconnect()` |
| `RequestMtuSize` | `<int size>` \| `<b64 deviceID>` | `gatt.requestMtu(size)` |
| `SendPacket` | `<b64 serviceUUID>` \| `<b64 charUUID>` \| `<b64 bytes>` \| `int` \| `int` \| `int` \| `<b64 deviceID>` | queue a write (queue flags: 1=non-replaceable, 2=do-not-overtake) |
| `SendPacketNotifyOnDataTransmitted` | `<b64 sdvcUUID>` \| `<b64 charUUID>` \| `<b64 bytes>` \| `int` \| `T`/`F` \| `<b64 deviceID>` | throttle send; asks for a `PacketTransmitted` callback |
| `SetNoAckParameters` | `<int packets>` \| `<int windowMs>` \| `<b64 deviceID>` | re-time the throttler |
| `SetLogLevel` | `<int level>` | log verbosity |

(!) the per-parameter order above mixes indexes decoded from the bytecode switch;
byte-strings and UUIDs travel **Base64**, integers plain, booleans are the single
letter `T` for true.

### 3.2 Events Java → Unity (`MessageToUnity` writer → `UnityPlayer.UnitySendMessage("CUBBNativeMessageReceiver", "OnMessageReceived", msg)`)

Wire format: pipe-separated fields; byte arrays and strings are **Base64 (NO_WRAP)**.

| Event | Payload fields |
|---|---|
| `ScanStateChanged` | `<AdapterScanState>` ∈ `NotScanning`, `TurningOnScanning`, `Scanning`, `BluetoothDisabled`, `BluetoothUnavailable` |
| `DeviceStateChanged` | `<deviceID=MAC>` \| `<Visible/Invisible/Disappeared>` \| `<b64 name>` \| `<serviceUUID>` \| `<rssi>` \| `<b64 manufacturerData>`
| `DeviceDisappeared` | `<deviceID>` |
| `DeviceConnectionStateChanged` | `<deviceID>` \| `Disconnected/Connecting/Connected` \| `<b64 error text>` |
| `MtuSizeChanged` | `<deviceID>` \| `<int mtu>` |
| `ReceivedPacket` | `<deviceID>` \| `<serviceUUID>` \| `<charUUID>` \| `<b64 packet>` ⇒ **all LWP3 traffic back from the train** |
| `PacketTransmitted` | `<deviceID>` \| `svc` \| `chr` \| `<int seqNr>` |
| `PacketDropped` | `<deviceID>` \| `svc` \| `chr` \| `<int seqNr>` |
| `Error`, `Log` | text |

Housekeeping state machine (`Model` + `DeviceDatabase`, mirrored 1:1 in the web app):
scan results are fed into a per-MAC "device entry"; a message to Unity is emitted
only when *name, serviceUUID, RSSI, manufacturerData or visibility* changed.
Visibility: seen < 1 s ago ⇒ `Visible`; older ⇒ `Invisible`; older than
**60 s** (EXISTENCE_THRESHOLD) ⇒ `Disappeared` (+ entry forgotten when not connected).
A periodic checker ticks every **3 s**.

---

## 4. Scanning & connection mechanics (the app's "how to find a train")

### 4.1 Scan (`AndroidBluetoothAdapterWrapperImpl.startScan`)

```java
btLeScanner = adapter.getBluetoothLeScanner();
List<ScanFilter> filters = new ArrayList<>();      // EMPTY LIST — no hardware filter!
ScanSettings settings = new ScanSettings.Builder()
    .setScanMode( 2 )                              // SCAN_MODE_LOW_LATENCY
    .setReportDelay(0)                             // unbundled, real-time results
    .build();
caller.aboutToStartScanning();                     // → "TurningOnScanning"
bluetoothLeScanner.startScan(filters, settings, serializingScanCallback);
```

…plus: classic-BT discovery is cancelled first. Since no hardware filter is used,
**every** LE advert arrives at the app, and the *software* does the matching —
that's because the app needs the **manufacturer data**, not just service UUIDs:

* `onScanResult` → any advertised service UUID ∈ configured services ⇒ interesting;
* `getManufacturerSpecificData(**919**)` → LEGO Systems' BLE company ID **0x0397** —
  the six-byte LEGO payload:

  * **offset 0**: button state (0/1),
  * **offset 1**: *System Type and Device Number* — `0x20` = DUPLO Train (10874/…),
    `0x21` = DUPLO Train 2025 (Hub No. 16),
  * **offset 2**: capabilities, **offset 3**: last network id, **offset 4**: status, **offset 5**: option.

`LEGO_MANUFACTURER_ID = 919` is verbatim in the DEX
(`CUBBNative$ScanCallbackListener`), and the same constant survives even inside
the compiled IL2CPP code (`movz w8, #0x397`).

### 4.2 Connection options (`ConnectionOptions`, TLC string)

```
ConnectToDevice|<b64-MAC>|autoConnect=false;sendStrategy=SoftAck;connectionPriority=high
```

* `autoConnect` → `BluetoothDevice.connectGatt(..., autoConnect, callback)` (background re-connect),
* `sendStrategy` ∈ `NoAck` / `SoftAck` *(default)* / `HardAck`,
* `connectionPriority` ∈ `low`/`medium`/`high`/`default` (default ⇒ do not call
  `requestConnectionPriority` at all) — invoked right after CONNECTED, before
  `discoverServices()`.

### 4.3 Write path — the throttler (this is the app's "motor smoothing")

The DUPLO app writes through a **window-throttled queue**, not raw writes:

* default **4 packets per 80 ms** window (`DEFAULT_PACKETS_PER_WINDOW`,
  `DEFAULT_WINDOW_SIZE_IN_MILLIS` in `SendThrottler`; retuneable via `SetNoAckParameters`),
* one write may be in flight (`gattWriteIsPending`); the next goes out on the
  GATT write-descriptor callback `onGattActionPerformed`,
* strategies: `HardAck` = write *with response*, ack=ATT callback;
  `SoftAck` = write *without response*, "sent" reported when the next GATT action
  completes; `NoAck` = pure fire-and-forget (no `PacketTransmitted`),
* queue supports packet *replacement* (overtake) — used to keep a freshly
  commanded speed ahead of queued older ones (flags 1/2 in §3.1),
* if the queue drains empty the pull-callback refills it from the send queue (`SendQueue`).

### 4.4 The 2025 hub special case

`isOADNonNotifyingCharacteristic` (DEX) explicitly ignores the non-notifying
TI OAD characteristics `F000FFC3/4` so firmware-update descriptors don't get
notifications assigned. The old hub (TI CC23x0/OAD absent) and new hub both sit
behind the same LWP3 characteristic; ports differ between generations and are
resolved from `Hub Attached I/O` (see §5).

---

## 5. The LWP3 protocol spoken over characteristic 1624

Headers: every message `[len, hubID=0x00, messageType, …payload]`, len includes itself.

Observed + documented (official spec §2.3): after the CCCD is enabled the train
**pushes** its inventory: one or more `Hub Attached I/O` (0x04)
`[len,0,0x04,port,event,typeLo,typeHi,hwRev×4,swRev×4]` messages —
event `0x01` attached — with the device types:

| Port (2018 hub) | Device type | Meaning |
|---|---|---|
| `0x00` | `0x29` | Motor |
| `0x01` | `0x2A` | Speaker |
| `0x11` | `0x17` | RGB LED |
| `0x12` | `0x2B` | Colour sensor |
| `0x13` | `0x2C` | Speedometer |
| `0x14` | `0x14` | Battery voltage |

(The 2025 hub uses different port numbers — resolve ports **by device type**,
never hardcode numbers.)

Downstream commands used by the game (`sendPacket`/throttler → 1624):

| Action | Bytes |
|---|---|
| Drive motor (port 0) | `08 00 81 00 11 51 00 <speed>` — signed −100…+100 |
| Play sound (port 1) | `08 00 81 01 11 51 01 <id>` — 3 brake, 5 depart/shunt, 7 water, 9 horn, 10 steam |
| Set LED (port 0x11) | `08 00 81 11 11 51 00 <color>` — LWP3 color index 0…10 |
| Subscribe sensor | `0A 00 41 <port> <mode> <delta u32 LE> 01` (Port Input Format Setup Single) |
| Ask battery etc. | `05 00 01 <prop> 05` (Hub Properties request; prop 6 = battery %) |
| Enable updates | `… 01 <prop> 02` (e.g. prop 2 = button state) |
| Disconnect | `04 00 02 02` / switch off `04 00 02 01` (Hub Actions) |

`0x11` = startup-and-send-feedback; feedback arrives as `0x82 Port Output Command Feedback`.

Upstream sensor values: `0x45 Port Value (Single)` `[len,0,0x45,port,fmt-dependent data]`,
decoded by the format brought back by `0x22/0x44` Port Mode Info (`info_type 0x80` =
datasets/type/figures/decimals). LWP3 colour indices: 0 black, 1 pink, 2 purple,
3 blue, 4 light blue, 5 cyan, 6 green, 7 yellow, 8 orange, 9 red, 10 white, 255 none.

### 5.1. 2018 front-light modes (observed; RGB write still unverified)

The web app's port probe on a 2018 hub reported port `0x11` / device type `0x17`
with two output modes (`output mask 0x0003`). Mode 0 returned a one-dataset,
8-bit value format and is the known palette mode used by the official app.
Mode 1 was named `RGB O`, but the hub did not return a value format for it.
An experimental direct RGB write was not reliable on the tested train, so the
free RGB picker was removed. The app keeps the confirmed palette buttons and
re-activates output mode 0 before each palette write. The exact mode-1 frame and
whether this hub supports it remain unconfirmed.

Sources cross-checked: official [LEGO BLE protocol docs](https://lego.github.io/lego-ble-wireless-protocol-docs/)
and community captures ([codecat's DUPLO train work](https://codecat.io/projects/lego-train/protocol/),
[JorgePe/BOOSTreveng](https://github.com/JorgePe/BOOSTreveng), node-poweredup).

---

## 5a. Motor-channel reliability (why one speed write is not enough)

* The DUPLO train hubs (2018 *and* 2025) **regularly drop single motor writes** —
  confirmed by the Legoino author on real hubs (Legoino issue #52, 2021):
  `setBasicMotorSpeed()` "works every once in 10 tries"; LED writes are reliable,
  motor/sound writes are not. His final workaround (also used by his PS3
  controller): **re-send the speed setpoint every 100 ms**.
* This also explains the observed "train starts, then stands again immediately
  (silently)" when only one write is sent after a change: the accepted-but-lost
  pattern hides with zero error output — the hub just continues at its previous
  (or zero) setpoint. No `0x05 Generic Error`, at most a `0x82` feedback gap.
* The official app does the same thing structurally: the Unity game loop pushes
  the current speed through the CUBB `SendThrottler` continuously, and the
  throttler's **packet-overtake** flags exist precisely to keep the *freshest*
  speed when writes pile up.
* Consequence for the Web-App: while connected and the commanded setpoint is
  non-zero, re-send it every **100 ms** (1 msg/100 ms ≪ 4 msgs/80 ms window, no
  flooding); each speed change additionally fires an immediate write + one
  repeat; stop (`0`) is sent twice.
* **Sound channel** — even more drop-prone ("I experience the same erratic
  behaviour with playing the sounds", #52), and NOT blindly re-sendable (sounds
  interrupt each other). Also verified from Legoino's working implementation:
  it subscribes the output port's mode (`0x41`+mode) before every sound/LED
  write (`playSound`: subscribe `{0x41,0x01,0x01,…}` then write
  `{0x81,0x01,0x11,0x51,0x01,sound}` — the same frame the web app sends).
  Web-App: speaker/LED port subscribed once on attach; sound retries are
  gated on `0x82` *Port Output Command Feedback* — bit `0x01` completed →
  stop retrying; bit `0x04` **discarded** shows the hub silently rejecting a
  write (observed + decoded by micschr0 in Legoino #90). If the hub never
  emits `0x82` (2018 hub; fredlcore never found feedback there), a small
  fixed number (≤2) of 250 ms spaced resends is used instead.
* **2025 hub (10427/10428) — NOT yet implemented in the web app**: per Legoino
  issue #90 the new trains put motor on port `0x32` (device type `0x29`,
  so the web app's port resolution already finds it) but address light and
  sound on a different port (`0x34` in app captures) with a different,
  longer frame, e.g. horn `0B 00 81 34 11 51 01 07 01 00 00`, light
  `0B 00 81 34 11 51 01 04 01 <color> 00` with a new color palette
  (01 white, 07 green, 08 yellow, 09 light blue, 0F dark blue, 0A purple,
  0E purple-pink, 0B light pink, 0D red-pink, 0C red). The app also drives
  the motor through port `0x34` (`0B 00 81 34 11 51 01 01 01 45 00` = forward).
  Bonding is mandatory (already handled by Chrome's pairing dialog). Support
  for these frames is pending — the current web app speaks the 2018 dialect.

---

## 6. What the APK doesn't contain (and how we compensated)

* `assets/**` is absent — this is a Play-Bundle **base split**, so
  `assets/bin/Data/Managed/Metadata/global-metadata.dat` (all C# names, strings)
  is not in the file. The GATT UUID constants and game-level messages live there.
* Compensated by: the complete Java-side bridge (§2–§4), the official LEGO
  wireless spec, and community captures that independently confirm every UUID,
  the manufacturer ID (0x0397 = 919 = verbatim DEX constant) and the TI OAD
  service (2025 hub) that the DEX hardcodes.
* `libil2cpp.so` was spot-checked (arm64): the only BLE-protocol constant that
  surfaces as an immediate is `#0x397` (LEGO manufacturer id), the rest are
  runtime metadata references.

---

## 7. Deliverable: the Web-App

`control/` contains a faithful Web Bluetooth re-implementation of these mechanics
(the project landing page lives in `index.html`):

* **Scan** filter — service UUID 1623 (the web analogue of the app's software filter),
  optional *advertising watch* path (`requestLEScan`, experimental) that mirrors
  the "empty filter + read manufacturer data 0x0397" trick and decodes the 6 LEGO bytes;
* **Connect** → discover service 1623 → **subscribe to 1624 notifications**
  (= enabling the CCCD, exactly like the app),
* full **LWP3 encoder/decoder** (attached IO, port values, hub properties, actions, errors),
* **throttled sender** mirroring `SendThrottler` (4 packets / 80 ms window,
  write-without-response, queue overtake),
* **train controls**: a simple view (connect, drive, horn, light toggle) plus an
  expert view with all five documented sounds, free sound IDs, the full LWP3
  colour palette, battery/switch-off, ports, sensors, a live chart and a
  byte-level log,
* ports are resolved **by device type** from `Hub Attached I/O` events, so both
  the 2018–2024 hub (0x20) and the 2025 hub (0x21) work.

Run it from `control/index.html` (Chrome/Edge — desktop with a real BLE adapter,
or Android Chrome; HTTPS or `localhost` required) while keeping the LEGO app
closed — the train only advertises when powered on and not yet connected.
