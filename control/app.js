/* ============================================================================
 * DUPLO Train — Web Bluetooth control
 * Re-implementation of the BLE mechanics reverse-engineered from the official
 * LEGO DUPLO Train Android app (com.lego.duplo.train v1.8.16):
 *
 *   - scan filtered on LEGO hub service       00001623-1212-efde-1623-785feabcd123
 *   - all traffic in/out of one characteristic 00001624-1212-efde-1623-785feabcd123
 *   - manufacturer "LEGO System A/S" id 0x0397 (=919, same constant the app uses)
 *   - throttled writes: 4 packets / 80 ms window, write-without-response (CUBB SendThrottler)
 *   - ports resolved by device type from Hub Attached I/O (works on 2018 + 2025 hub)
 *   - LWP3 message format [len, hub=0, type, payload]  (LEGO official spec)
 * ============================================================================ */

/* ------------------------------------------------------------------ consts */

const LWP3 = {
  SERVICE:      '00001623-1212-efde-1623-785feabcd123',
  CHAR:         '00001624-1212-efde-1623-785feabcd123',
  BOOT_SERVICE: '00001625-1212-efde-1623-785feabcd123',
  MFR_ID:       0x0397,               // LEGO Systems A/S — same 919 the app checks
  HUB_ID:       0x00,
};

/* hub type byte = advertisement offset 1 (System Type + Device Number) */
const HUB_TYPES = {
  0x20: 'DUPLO Train Base — Hub No. 5 (2018-2024 sets: 10874/10875/10877/10882)',
  0x21: 'DUPLO Train Base — Hub No. 16 (2025 set: 10427)',
};

/* device type ids reported in Hub Attached I/O */
const DEVICE_TYPES = {
  0x14: 'Battery voltage',
  0x17: 'RGB light',
  0x29: 'Motor (drive)',
  0x2A: 'Speaker',
  0x2B: 'Colour sensor',
  0x2C: 'Speedometer',
  0x5A: 'Events — Sound + Licht (2025)',
  0x5B: 'TAG-Sensor (2025)',
};

const PORT_FALLBACK = {  /* 2018 hub layout — used only until Attached I/O arrives */
  motor: 0x00, speaker: 0x01, rgb: 0x11, color: 0x12, speedo: 0x13, voltage: 0x14,
};
const PORT_FALLBACK_MODERN = {  /* 2025 hub layout (10427 / 10428) */
  motor: 0x32, speaker: 0x01, rgb: 0x34, color: null, speedo: 0x36, voltage: 0x35,
};
const MODERN_EVENT = { LIGHT: 0x0104, SOUND: 0x0107 };

const LWP3_COLORS = [
  [0,'Schwarz'], [1,'Pink'], [2,'Lila'], [3,'Blau'], [4,'Hellblau'],
  [5,'Cyan'], [6,'Grün'], [7,'Gelb'], [8,'Orange'], [9,'Rot'], [10,'Weiß'], [255,'Keine Farbe'],
];
const COLOR_SWATCHES = {
  0: '#111318', 1: '#ff8ab6', 2: '#8f4acb', 3: '#0055bf', 4: '#9fc3e9',
  5: '#00a9ce', 6: '#237841', 7: '#f2cd37', 8: '#fe8a18', 9: '#c91a09',
  10: '#f4f4f4', 255: 'transparent',
};
const LIGHT_DEFAULT_COLOR = 10;   /* 2018 palette: white — used the first time the light is switched on */
const MODERN_LIGHT_DEFAULT = 0x01; /* 2025 palette: white */
const MODERN_COLORS = [
  [0x00, 'Aus', 'transparent'],
  [0x01, 'Weiß', '#f4f4f4'],
  [0x07, 'Grün', '#237841'],
  [0x08, 'Gelb', '#f2cd37'],
  [0x09, 'Hellblau', '#9fc3e9'],
  [0x0F, 'Dunkelblau', '#0055bf'],
  [0x0A, 'Lila', '#8f4acb'],
  [0x0E, 'Lila-Pink', '#c870a0'],
  [0x0B, 'Hellpink', '#ff8ab6'],
  [0x0D, 'Rot-Pink', '#e23b32'],
  [0x0C, 'Rot', '#c91a09'],
];

const SOUND_NAMES = {
  3: 'Brake', 5: 'Depart', 7: 'Water refill', 9: 'Horn', 10: 'Steam',
};

const MSG_TYPES = {
  0x01: 'Hub Properties',        0x02: 'Hub Actions',
  0x03: 'Hub Alerts',            0x04: 'Hub Attached I/O',
  0x05: 'Generic Error',         0x21: 'Port Information Request',
  0x22: 'Port Mode Info Request',0x41: 'Port Input Format Setup (Single)',
  0x43: 'Port Information',      0x44: 'Port Mode Information',
  0x45: 'Port Value (Single)',   0x47: 'Port Input Format (Single)',
  0x81: 'Port Output Command',   0x82: 'Port Output Command Feedback',
};

const ERROR_CODES = {
  1: 'ACK', 2: 'MACK', 3: 'Buffer overflow', 4: 'Timeout',
  5: 'Command not recognised', 6: 'Invalid use (param error)', 7: 'Overcurrent', 8: 'Internal error',
};

/* ------------------------------------------------------------------- state */

const state = {
  device: null,
  server: null,
  service: null,
  characteristic: null,
  connected: false,
  ports: {},            /* kind -> {port, type, name} resolved from Attached I/O */
  portModes: {},        /* port -> mode currently subscribed (decode format) */
  portFormats: {},      /* port -> mode -> {datasets, type, figures, decimals} */
  portRanges: {},       /* port -> mode -> {min,max} from RAW range info */
  versions: { fw: null, hw: null },
  desiredSpeed: 0,      /* last commanded motor setpoint (keepalive source) */
  keepalive: null,      /* keepalive interval id */
  rssiInterval: null,   /* periodic hub RSSI request */
  speedoPrimeTimer: null,
  colorPrimeTimer: null,
  sawFeedback: false,   /* hub emitted 0x82 at least once */
  soundPending: null,   /* retry book-keeping for the lossy sound channel */
  preferWrite: false,   /* fall back to writeValue after WWR failures */
  hubGeneration: null,  /* null | 'legacy' (2018–2024) | 'modern' (2025) */
  eventsPort: null,     /* 2025 EVENTS port (sound + light), usually 0x34 */
  lightOn: false,       /* basic light toggle state */
  lightColor: null,     /* last non-off colour in the active palette */
  stats: { tx: 0, txErr: 0, fb: 0, discard: 0 },
  sensorHistory: { speedo: [], rssi: [] },
  lastSeenAdvert: null, /* hex of LEGO 6 bytes, from advert watch when available */
};
let uiBootstrapped = false;

/* ================================================================== helpers */

const $ = (id) => document.getElementById(id);
const hex = (u8, sep = ' ') => [...u8].map(b => b.toString(16).padStart(2, '0')).join(sep);
const bytesOf = (msg, label = '', cls = '') => {
  if (!$('chk-hexlogging').checked) return;
  log(`${label.padEnd(4)} ${hex(msg)}`, cls);
};

function log(html, cls = 'info') {
  const box = $('log');
  const line = document.createElement('span');
  line.className = cls;
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `[${t}] ${html}\n`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setPill(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'pill ' + cls;
}

/* ========================================================= light & views */

function activeColors() {
  if (state.hubGeneration === 'modern') return MODERN_COLORS;
  return LWP3_COLORS.map(([id, name]) => [id, name, COLOR_SWATCHES[id] || '#6b7280']);
}

function colorSwatch(id) {
  if (state.hubGeneration === 'modern') {
    const entry = MODERN_COLORS.find(([value]) => value === id);
    return entry ? entry[2] : '#6b7280';
  }
  return COLOR_SWATCHES[id] || '#6b7280';
}

function colorName(id) {
  const list = state.hubGeneration === 'modern' ? MODERN_COLORS : LWP3_COLORS;
  return (list.find(([value]) => value === id) || [id, 'Farbe ' + id])[1];
}

function defaultLightColor() {
  return state.hubGeneration === 'modern' ? MODERN_LIGHT_DEFAULT : LIGHT_DEFAULT_COLOR;
}

function isOffColor(color) {
  return state.hubGeneration === 'modern' ? color === 0 : color === 255;
}

function setHubGeneration(gen) {
  if (state.hubGeneration === gen) return;
  state.hubGeneration = gen;
  state.lightOn = false;
  state.lightColor = null;
  const el = $('di-generation');
  if (el) el.textContent = gen === 'modern' ? '2025 (EVENTS, Port 0x34)' : '2018–2024';
  const hubType = $('di-hubtype');
  if (hubType && (!hubType.textContent || hubType.textContent === '–')) {
    hubType.textContent = gen === 'modern' ? 'Hub No. 16 (0x21, 2025)' : 'Hub No. 5 (0x20, 2018–2024)';
  }
  renderLedPalette();
  renderLightState();
  log('Hub-Generation: ' + (gen === 'modern'
    ? '2025 (EVENTS-Port 0x34, Sound/Licht) — Bonding muss im Browser bestätigt sein, sonst ignoriert der Hub Befehle still'
    : '2018–2024 (klassische Ports)'), 'info');
}

function renderLedPalette() {
  const wrap = $('ledcolors');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const [id, name, swatch] of activeColors()) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="led-dot" style="background:${swatch || '#6b7280'}"></span>${name}`;
    b.onclick = () => setLed(id);
    wrap.appendChild(b);
  }
}

function renderLightState() {
  const button = $('btn-light');
  const label = $('light-state');
  const swatch = $('light-swatch');
  if (button) {
    button.classList.toggle('is-on', state.lightOn);
    button.setAttribute('aria-pressed', state.lightOn ? 'true' : 'false');
  }
  if (label) label.textContent = state.lightOn ? 'An' : 'Aus';
  if (swatch) {
    swatch.style.backgroundColor = state.lightOn
      ? (colorSwatch(state.lightColor ?? defaultLightColor()) || '#ffd500')
      : '#535866';
  }
}

function setLed(color, announce = true) {
  if (!connectedGuard()) return false;

  if (state.hubGeneration === 'modern') {
    if (color === 255) color = 0;       /* 2018 "keine Farbe" → 2025 off */
    if (!state.eventsPort) {
      log('2025er EVENTS-Port noch nicht gemeldet – sende Lichtbefehl trotzdem an 0x34', 'warn');
    }
  } else if (state.ports.rgb) {
    /* Legoino parity: activate the LED port's mode before writing to it. */
    throttler.enqueue(cmdSubscribe(state.ports.rgb.port, 0, 1, false));
  }

  const msg = cmdLed(color);
  bytesOf(msg, 'TX', 'tx');
  throttler.enqueue(msg);

  if (isOffColor(color)) {
    state.lightOn = false;            /* keep the last real colour for the toggle */
  } else {
    state.lightOn = true;
    state.lightColor = color;
  }
  renderLightState();

  if (announce) {
    log(`→ LED: ${colorName(color)} (${color})` +
      (state.hubGeneration === 'modern' ? ' via EVENTS' : ''), 'info');
  }
  return true;
}

function toggleLight() {
  if (!state.connected) {
    log('Nicht verbunden – zuerst „Zug suchen“ drücken.', 'warn');
    return;
  }
  if (state.lightOn) setLed(state.hubGeneration === 'modern' ? 0 : 255);
  else setLed(state.lightColor ?? defaultLightColor());
}

function setView(name, persist = true) {
  const expert = name === 'expert';
  if (document.body) document.body.dataset.view = expert ? 'expert' : 'basic';
  $('view-basic').classList.toggle('hidden', expert);
  $('view-expert').classList.toggle('hidden', !expert);

  for (const [button, active] of [[$('mode-basic'), !expert], [$('mode-expert'), expert]]) {
    if (!button) continue;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  const hint = $('mode-hint');
  if (hint) hint.textContent = expert
    ? 'Alle Rohdaten, Sensoren, Farben und das LWP3-Protokoll.'
    : 'Koppeln, fahren, hupen, Licht – mehr braucht es nicht.';

  if (persist) { try { localStorage.setItem('duplo.view', name); } catch (e) {} }
  if (expert) drawSensorChart();      /* canvas has a size only once visible */
}

/* ============================================================ LWP3 framing */

function lwp3Build(type, payload, hub = LWP3.HUB_ID) {
  /* len covers everything including itself */
  const len = 1 + 1 + 1 + payload.length;      /* len byte, hub, type, payload */
  const out = new Uint8Array(len);
  out[0] = len; out[1] = hub; out[2] = type;
  out.set(payload, 3);
  return out;
}

/* ------------------------------------------- command builders (app parity) */

/* Port Output Command 0x81 + WriteDirectModeData(0x51), 0x11 = execute now + ask feedback */
function cmdMotor(speed, port = ports()) {
  return lwp3Build(0x81, [port.motor, 0x11, 0x51, 0x00, speedSigned(speed)]);
}
/* 2025 EVENTS port 0x34: [len,0,0x81,port,0x11,0x51,0x01,opLo,opHi,parLo,parHi] */
function cmdMultiEvent(opcode, value, port = state.eventsPort ?? PORT_FALLBACK_MODERN.rgb) {
  return lwp3Build(0x81, [
    port, 0x11, 0x51, 0x01,
    opcode & 0xff, (opcode >> 8) & 0xff,
    value & 0xff, (value >> 8) & 0xff,
  ]);
}
function cmdSound(id, port = ports()) {
  if (state.hubGeneration === 'modern') {
    if (id === 9) return cmdMultiEvent(MODERN_EVENT.SOUND, 0);   /* horn lives on EVENTS */
    return lwp3Build(0x81, [port.speaker ?? PORT_FALLBACK_MODERN.speaker, 0x11, 0x51, 0x01, id]);
  }
  return lwp3Build(0x81, [port.speaker, 0x11, 0x51, 0x01, id]);
}
function cmdLed(color, port = ports()) {
  if (state.hubGeneration === 'modern') {
    return cmdMultiEvent(MODERN_EVENT.LIGHT, color === 255 ? 0 : color);
  }
  return lwp3Build(0x81, [port.rgb, 0x11, 0x51, 0x00, color]);
}
function soundTargetPort(id) {
  if (state.hubGeneration === 'modern') {
    return id === 9
      ? (state.eventsPort ?? PORT_FALLBACK_MODERN.rgb)
      : (state.ports.speaker?.port ?? PORT_FALLBACK_MODERN.speaker);
  }
  return ports().speaker;
}
/* Port Input Format Setup (Single): port, mode, delta(u32 LE), notify flag */
function cmdSubscribe(port, mode, delta = 1, notify = true) {
  return lwp3Build(0x41, [port, mode, delta & 0xff, (delta >> 8) & 0xff, (delta >> 16) & 0xff, (delta >> 24) & 0xff, notify ? 1 : 0]);
}
function cmdHubAction(action) { return lwp3Build(0x02, [action]); }
function cmdHubPropRequest(prop)  { return lwp3Build(0x01, [prop, 0x05]); } /* request update */
function cmdHubPropEnable(prop)   { return lwp3Build(0x01, [prop, 0x02]); } /* enable updates */

function speedSigned(v) { return v & 0xff; } /* s8 two's complement, as the app trains do */

/* ==================================================== throttler (CUBB port)
 * The app's SendThrottler: queue of writes; allow 4 packets per 80 ms window;
 * retuneable (SetNoAckParameters) — exactly mirrored here, with a full-window
 * queue incl. "overtake" semantics used to keep the freshest motor speed.
 * ==========================================================================*/

class SendThrottler {
  constructor(packetsPerWindow = 4, windowMillis = 80) {
    this.packetsPerWindow = packetsPerWindow;
    this.windowMillis = windowMillis;
    this.queue = [];
    this.sentStamps = [];
    this.timer = null;
    this.writing = false;
    this.onDrained = null;
  }
  writeCharacteristic(data) { /* default impl, replaced at runtime */ }

  enqueue(data) { this.queue.push(data); this.flush(); }

  async flush() {
    if (this.writing || this.timer !== null) return;
    this.writing = true;
    try {
      while (this.queue.length && this.canSendNow()) {
        const next = this.queue.shift();
        this.sentStamps.push(performance.now());
        try {
          /* Web Bluetooth rejects overlapping writes with "GATT operation already in progress". */
          await this.writeCharacteristic(next);
        } catch (e) { log('write failed: ' + (e?.message || e), 'err'); }
      }
    } finally {
      this.writing = false;
      if (this.queue.length && this.timer === null) {
        const oldest = this.sentStamps.length ? this.sentStamps[0] : performance.now();
        const wait = Math.max(1, this.windowMillis - (performance.now() - oldest));
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
      }
    }
  }
  canSendNow() {
    const cutoff = performance.now() - this.windowMillis;
    this.sentStamps = this.sentStamps.filter(t => t > cutoff);
    return this.sentStamps.length < this.packetsPerWindow;
  }
}

const throttler = new SendThrottler();
throttler.writeCharacteristic = async (data) => {
  if (!state.connected || !state.characteristic) return;
  try {
    if (state.preferWrite) {                                     /* previous WWR attempt failed hard */
      await state.characteristic.writeValue(data);
    } else {
      /* write-without-response, exactly as the app uses on characteristic 1624 */
      await state.characteristic.writeValueWithoutResponse(data);
    }
    state.stats.tx++;
  } catch (e) {
    /* Some Linux/BlueZ setups drop write-without-response — fall back to the
     * acked write (slightly slower, but reliable). Flip once, log loudly. */
    if (!state.preferWrite) {
      state.preferWrite = true;
      log('writeValueWithoutResponse failed (' + (e?.message || e) + ') — switching to writeValue (with response)', 'warn');
      try { await state.characteristic.writeValue(data); state.stats.tx++; }
      catch (e2) { state.stats.txErr++; throw e2; }
    } else {
      state.stats.txErr++;
      throw e;
    }
  }
  updateStats();
};

/* ========================================================= motor keepalive
 * The DUPLO train hubs drop single motor writes surprisingly often — the
 * author of Legoino confirmed this on real hubs and fixed it by re-sending
 * the speed every ~100 ms (Legoino issue #52), 2025 hub behaves the same.
 * The official app does the same: its Unity loop pushes the current speed
 * setpoint through the CUBB throttler continuously — which is exactly why
 * SendThrottler has the "packet overtake" mechanism (keep freshest speed).
 * Mirrored here: while connected and speed ≠ 0, re-send the setpoint
 * every 100 ms, silently (no log spam), paced by the throttler. */
const MOTOR_KEEPALIVE_MS = 100;

function startMotorKeepalive() {
  if (state.keepalive !== null) return;
  state.keepalive = setInterval(() => {
    if (!state.connected || !state.characteristic || state.desiredSpeed === 0) return;
    enqueueLatestMotor(state.desiredSpeed);
  }, MOTOR_KEEPALIVE_MS);
}

function stopMotorKeepalive() {
  if (state.keepalive !== null) { clearInterval(state.keepalive); state.keepalive = null; }
}

/* ================================================= sound delivery (lossy channel)
 * Sounds are even more drop-prone than the motor (Legoino #52), and cannot be
 * blindly re-sent or they interrupt each other — the author needed extra care
 * to avoid double plays. Strategy:
 *   - Legoino subscribes the output port's mode before every sound/Led write;
 *     we do the same once on attach (see decodeAttachedIO).
 *   - If the hub sends 0x82 feedback (2025 hub does; decoded below), retries
 *     are gated on it: resend only while no "completed" came back.
 *   - If it never sends feedback, fall back to a fixed small number of spaced
 *     resends (same idea as the PS3/Legoino loop, kept gentle). */

function clearSoundPending() {
  if (state.soundPending && state.soundPending.timer) clearTimeout(state.soundPending.timer);
  state.soundPending = null;
}

function playSoundReliable(id) {
  const name = SOUND_NAMES[id] || id;
  const port = soundTargetPort(id);
  const msg = cmdSound(id);
  bytesOf(msg, 'TX', 'tx');
  log(`→ Sound: ${name} (Port 0x${port.toString(16)})` +
    (state.hubGeneration === 'modern' ? ' — 2025er Dialekt' : ''), 'info');
  throttler.enqueue(msg);

  clearSoundPending();                       /* a fresh click supersedes the old retry */
  let tries = 0;
  const gap = state.sawFeedback ? 250 : 350;  /* wider gaps for feedback-less hubs */
  const maxTries = state.sawFeedback ? 3 : 4; /* conservative if the hub gives no feedback */

  const attempt = () => {
    if (!state.soundPending || state.soundPending.stale) return;
    if (!state.connected || !state.characteristic || ++tries > maxTries) { clearSoundPending(); return; }
    log('→ Sound retry #' + tries + ' (' + name + ') — no hub feedback yet', 'warn');
    bytesOf(msg, 'TX', 'tx');
    throttler.enqueue(msg);
    state.soundPending.timer = setTimeout(attempt, gap);
  };
  state.soundPending = { port, stale: false, timer: setTimeout(attempt, gap) };
}

/* ============================================================== BLE plumbing */

function webBluetoothAvailable() { return 'bluetooth' in navigator; }

async function findAndConnect() {
  if (!webBluetoothAvailable()) {
    log('Web Bluetooth is not available in this browser. Use Chrome/Edge (desktop with BLE adapter, or Android).', 'err');
    setPill('pill-bt', 'Kein Web Bluetooth', 'pill-warn');
    return;
  }
  setPill('pill-bt', 'Web Bluetooth bereit', 'pill-ok');
  log('requestDevice({ filters:[{ services:[ LWP3 ' + LWP3.SERVICE.slice(4, 12) + '… ]}]}) — the web analogue of the app scan:', 'info');

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      /* IMPORTANT: recognized-service filter == DiscoveryFilters.isRecognizedService() in the app */
      filters: [{ services: [LWP3.SERVICE] }],
      optionalServices: [LWP3.SERVICE, LWP3.BOOT_SERVICE, 'f000ffc0-0451-4000-b000-000000000000'],
    });
  } catch (e) {
    log('user picker closed: ' + e.message, 'warn');
    return;
  }
  log('device picked: ' + (device.name || '(empty name — 2018 trains advertise no name)'), 'info');

  state.device = device;
  device.addEventListener('gattserverdisconnected', onDisconnected);

  await connectGatt();
}

async function connectGatt() {
  const d = state.device;
  state.hubGeneration = null;
  state.eventsPort = null;
  state.lightColor = null;
  state.lightOn = false;
  renderLedPalette();
  renderLightState();
  const generationEl = $('di-generation');
  if (generationEl) generationEl.textContent = '–';
  const hubTypeEl = $('di-hubtype');
  if (hubTypeEl) hubTypeEl.textContent = '–';
  setPill('pill-conn', 'Verbinde …', 'pill-warn');
  try {
    state.server = await d.gatt.connect();
    log('GATT connected — (app does: requestConnectionPriority → discoverServices)', 'info');
  } catch (e) {
    /* 2025 hub (Hub No. 16) requires bonding; Chrome pairs automatically…  */
    log('connect failed: ' + e.message + ' (2025 hub requires bonding — accept the pairing dialog)', 'err');
    setPill('pill-conn', 'Verbindung fehlgeschlagen', 'pill-off');
    return;
  }

  /* sidestep "already connected" double-clicks */
  if (!state.server) return;

  try {
    state.service = await state.server.getPrimaryService(LWP3.SERVICE);
    state.characteristic = await state.service.getCharacteristic(LWP3.CHAR);
  } catch (e) {
    log('service/char discovery failed: ' + e.message, 'err');
    return;
  }

  /* CCCD enable == gatt.setCharacteristicNotification(chr, true) + write 0x0100 in the app */
  try {
    await state.characteristic.startNotifications();
    state.characteristic.addEventListener('characteristicvaluechanged', onNotify);
    log('notifications on 1624 (write 0100 → CCCD 2902, as the app does). Train will now push Attached I/O…', 'info');
  } catch (e) {
    log('startNotifications failed: ' + e.message, 'err');
    return;
  }

  state.connected = true;
  setPill('pill-conn', 'Verbunden', 'pill-ok');
  $('btn-disconnect').disabled = false;
  $('btn-poweroff').disabled = false;
  $('device-info').classList.remove('hidden');
  $('device-hint')?.classList.add('hidden');
  $('di-id').textContent = d.id || 'n/a (Chrome hides MAC)';
  $('di-name').textContent = d.name || '(empty)';

  /* mirror the app side-effect: zero the drive slider + reset UI */
  $('speed').value = 0; updateSpeedReadout();
  state.desiredSpeed = 0;
  state.lightOn = false;
  renderLightState();
  state.sensorHistory = { speedo: [], rssi: [] };
  drawSensorChart();

  /* kick off hub scaffolding exactly like the game:
     button updates on, battery request, versions request */
  throttler.enqueue(cmdHubPropEnable(2));   /* button state updates   */
  throttler.enqueue(cmdHubPropRequest(6));  /* battery level          */
  throttler.enqueue(cmdHubPropRequest(3));  /* firmware version       */
  throttler.enqueue(cmdHubPropRequest(4));  /* hardware version       */
  log('requested Hub Properties: button(2) enable-updates, battery(6), fw(3), hw(4)', 'info');

  /* keepalive loop for the hub's drop-happy motor channel (see class comment) */
  startMotorKeepalive();
  requestRssi();
  state.rssiInterval = setInterval(requestRssi, 5000);
}

function disconnectNow() {
  stopMotorKeepalive();
  stopRssiPolling();
  if (state.speedoPrimeTimer !== null) { clearTimeout(state.speedoPrimeTimer); state.speedoPrimeTimer = null; }
  if (state.colorPrimeTimer !== null) { clearTimeout(state.colorPrimeTimer); state.colorPrimeTimer = null; }
  state.desiredSpeed = 0;
  clearSoundPending();
  if (state.characteristic) { try { state.characteristic.stopNotifications(); } catch (e) {} }
  state.device?.gatt.disconnect();
}

function onDisconnected() {
  stopMotorKeepalive();
  stopRssiPolling();
  if (state.speedoPrimeTimer !== null) { clearTimeout(state.speedoPrimeTimer); state.speedoPrimeTimer = null; }
  if (state.colorPrimeTimer !== null) { clearTimeout(state.colorPrimeTimer); state.colorPrimeTimer = null; }
  state.desiredSpeed = 0;
  clearSoundPending();
  state.sawFeedback = false;
  state.preferWrite = false;
  state.stats = { tx: 0, txErr: 0, fb: 0, discard: 0 };
  updateStats();
  state.connected = false;
  state.characteristic = null;
  state.hubGeneration = null;
  state.eventsPort = null;
  state.lightColor = null;
  state.lightOn = false;
  renderLedPalette();
  renderLightState();
  const generationEl = $('di-generation');
  if (generationEl) generationEl.textContent = '–';
  const hubTypeEl = $('di-hubtype');
  if (hubTypeEl) hubTypeEl.textContent = '–';
  state.ports = {}; state.portModes = {}; state.portFormats = {}; state.portRanges = {};
  state.versions = { fw: null, hw: null };
  $('btn-disconnect').disabled = true;
  $('btn-poweroff').disabled = true;
  $('device-info').classList.add('hidden');
  $('device-hint')?.classList.remove('hidden');
  ['val-color', 'val-speedo', 'val-voltage', 'val-battery', 'val-rssi'].forEach(id => { $(id).textContent = '–'; });
  $('color-swatch').style.backgroundColor = '#535866';
  state.sensorHistory = { speedo: [], rssi: [] };
  drawSensorChart();
  $('ports-grid').innerHTML = '<p class="hint">Zuerst verbinden – der Zug meldet seine Anschlüsse selbst.</p>';
  setPill('pill-conn', 'Nicht verbunden', 'pill-off');
  log('GATT disconnected', 'warn');
}

/* ================================================== notification decoding */

function onNotify(e) {
  /* Chrome delivers e.target.value as a DataView — normalize by the view's exact bytes */
  const v = e.target.value;
  const u8 = (v instanceof DataView)
    ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    : new Uint8Array(v);
  bytesOf(u8, 'RX', 'rx');
  if (u8.length < 3) return;
  const type = u8[2];
  const name = MSG_TYPES[type] || ('?0x' + type.toString(16));
  if (type !== 0x82 && type !== 0x45 && type !== 0x01) log('← ' + name, 'info'); // high-volume updates stay quiet

  switch (type) {
    case 0x04: return decodeAttachedIO(u8);
    case 0x45: return decodePortValue(u8);
    case 0x01: return decodeHubProperties(u8);
    case 0x02: return decodeHubAction(u8);
    case 0x82: return decodeFeedback(u8);
    case 0x05: return decodeGenericError(u8);
    case 0x44: return decodeModeInfo(u8);
    case 0x47: return decodeInputFormat(u8);
    case 0x43: return decodePortInformation(u8);
    default:
      /* 0x43 Port Information, 0x47 … also tolerated */
  }
}

function portKindLabel(k) {
  return {
    motor: 'Motor', speaker: 'Lautsprecher', rgb: 'LED', color: 'Farbsensor',
    speedo: 'Tacho', voltage: 'Spannung', events: 'Events (Sound + Licht)', tag: 'TAG-Sensor',
  }[k] || (k.startsWith('device-') ? 'Unbekanntes Gerät' : k);
}

function decodeAttachedIO(u8) {
  /* [len,hub,0x04,port,event,typeLo,typeHi,hwRev×4,swRev×4] */
  const port = u8[3], event = u8[4];
  const type = u8[6] << 8 | u8[5];
  const tName = DEVICE_TYPES[type] || 'Unknown 0x' + type.toString(16);
  const evName = { 0: 'detached', 1: 'attached', 2: 'attached (virtual)' }[event] || '?';
  log(`Attached I/O: port 0x${port.toString(16)} ${evName} — ${tName}`, 'info');

  if (event === 0) {
    Object.keys(state.ports).forEach(k => { if (state.ports[k].port === port) delete state.ports[k]; });
    if (state.eventsPort === port) state.eventsPort = null;
    renderPorts();
    return;
  }
  if (event !== 1) return;

  let kind = null;
  switch (type) {
    case 0x29: kind = 'motor'; break;
    case 0x2A: kind = 'speaker'; break;
    case 0x17: kind = 'rgb'; break;
    case 0x2B: kind = 'color'; break;
    case 0x2C: kind = 'speedo'; break;
    case 0x14: kind = 'voltage'; break;
    case 0x5A: kind = 'events'; break;
    case 0x5B: kind = 'tag'; break;
  }

  /* 2025 hubs renumber every port into the 0x3x range. This is the most
   * reliable generation signal we get before the first command. */
  if (kind === 'events' || port >= 0x30) setHubGeneration('modern');
  else if (!state.hubGeneration && (kind === 'speaker' || kind === 'rgb' || kind === 'color')) {
    setHubGeneration('legacy');
  }

  if (!kind) {
    state.ports[`device-${port}`] = { port, type, name: tName };
    renderPorts();
    return;
  }

  state.ports[kind] = { port, type, name: tName };

  /* Legoino parity: subscribe the output ports' modes before writing to them
   * (they do 0x41 + mode before every sound/LED command). notify = off, so
   * this only "activates" the port on the hub. */
  if (kind === 'speaker') { throttler.enqueue(cmdSubscribe(port, 1, 1, false)); }
  if (kind === 'rgb')     { throttler.enqueue(cmdSubscribe(port, 0, 1, false)); }

  /* 2025: sound + light are collapsed into the EVENTS port. The hub only
   * accepts writes on 0x34 after EVENTS mode 1 has been subscribed. */
  if (kind === 'events') {
    state.eventsPort = port;
    state.portModes[port] = { kind: 'events', mode: 1 };
    const subscribe = cmdSubscribe(port, 1, 1, true);
    bytesOf(subscribe, 'TX', 'tx');
    throttler.enqueue(subscribe);
    log(`EVENTS-Port 0x${port.toString(16)} abonniert (2025: Sound + Licht)`, 'info');
    /* 10427 keeps its beeper on the internal port 0x01; activate it for the
     * non-horn sounds. On the 10428 this port may not exist (harmless). */
    const speakerSub = cmdSubscribe(0x01, 1, 1, false);
    bytesOf(speakerSub, 'TX', 'tx');
    throttler.enqueue(speakerSub);
  }

  /* Sensors use mode 0; the color sensor uses its RGB mode 3. */
  if (kind === 'color' || kind === 'speedo' || kind === 'voltage') {
    const mode = kind === 'color' ? 3 : 0;
    state.portModes[port] = { kind, mode };
    const subscribe = cmdSubscribe(port, mode, (kind === 'speedo' || kind === 'color') ? 0 : 1, true);
    bytesOf(subscribe, 'TX', 'tx');
    throttler.enqueue(subscribe);
    requestModeInfo(port, mode);
    if (kind === 'color') requestModeInfo(port, mode, 0x01);
    if (kind === 'color') {
      if (state.colorPrimeTimer !== null) clearTimeout(state.colorPrimeTimer);
      state.colorPrimeTimer = setTimeout(() => {
        state.colorPrimeTimer = null;
        if (!state.connected || state.ports.color?.port !== port) return;
        const steady = cmdSubscribe(port, mode, 1, true);
        bytesOf(steady, 'TX', 'tx');
        throttler.enqueue(steady);
        log('RGB sensor switched to change-only updates (delta 1)', 'info');
      }, 300);
    }
    if (kind === 'speedo') {
      if (state.speedoPrimeTimer !== null) clearTimeout(state.speedoPrimeTimer);
      state.speedoPrimeTimer = setTimeout(() => {
        state.speedoPrimeTimer = null;
        if (!state.connected || state.ports.speedo?.port !== port) return;
        const steady = cmdSubscribe(port, 0, 1, true);
        bytesOf(steady, 'TX', 'tx');
        throttler.enqueue(steady);
        log('speedometer switched to change-only updates (delta 1)', 'info');
      }, 300);
    }
  }
  renderPorts();
}

function requestPortInformation(port) {
  /* Port Information Request, info type 0x01 describes available modes. */
  const msg = lwp3Build(0x21, [port, 0x01]);
  bytesOf(msg, 'TX', 'tx');
  throttler.enqueue(msg);
}

function requestModeInfo(port, mode, info = 0x80) {
  const msg = lwp3Build(0x22, [port, mode, info]);
  bytesOf(msg, 'TX', 'tx');
  throttler.enqueue(msg);
}

function probePorts() {
  if (!connectedGuard()) return;
  const ports = Object.values(state.ports);
  if (!ports.length) { log('No attached ports to inspect yet', 'warn'); return; }
  log(`Probing mode information for ${ports.length} attached ports…`, 'info');
  for (const { port } of ports) requestPortInformation(port);
}

function decodePortInformation(u8) {
  /* 0x43 info type 0x01: port, info, capabilities, count, input mask, output mask */
  if (u8.length < 11 || u8[4] !== 0x01) return;
  const port = u8[3], capabilities = u8[5], count = u8[6];
  const inputModes = u8[7] | (u8[8] << 8);
  const outputModes = u8[9] | (u8[10] << 8);
  const modes = [];
  for (let mode = 0; mode < Math.min(count, 16); mode++) {
    if (inputModes & (1 << mode)) modes.push(mode);
  }
  const hexModes = value => `0x${value.toString(16).padStart(4, '0')}`;
  log(`port 0x${port.toString(16)} info: capabilities 0x${capabilities.toString(16)}, ${count} modes, input ${hexModes(inputModes)}, output ${hexModes(outputModes)}`, 'info');
  if (!modes.length) {
    /* Some DUPLO Hub No. 16 ports have known-bad mode masks; inspect every mode. */
    modes.push(...Array.from({ length: Math.min(count, 16) }, (_, mode) => mode));
    log(`port 0x${port.toString(16)} has no input mask; probing all ${modes.length} declared modes (mask may be unreliable)`, 'warn');
  }
  for (const mode of modes) {
    requestModeInfo(port, mode, 0x00); // mode name
    requestModeInfo(port, mode, 0x01); // raw range
    requestModeInfo(port, mode, 0x04); // SI unit/symbol
    requestModeInfo(port, mode, 0x80); // value format
  }
}

function decodeInputFormat(u8) {
  /* [len,hub,0x47,port,mode,delta(u32 LE),notify] */
  if (u8.length < 10) return;
  const port = u8[3], mode = u8[4];
  const delta = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(5, true);
  log(`sensor subscription confirmed: port 0x${port.toString(16)} mode ${mode}, delta ${delta}, notifications ${u8[9] ? 'on' : 'off'}`, u8[9] ? 'info' : 'warn');
}

function decodeModeInfo(u8) {
  /* [len,hub,0x44,port,mode,infoType,…] */
  if (u8.length < 6) return;
  const port = u8[3], mode = u8[4];
  if (u8[5] === 0x00) {
    const name = new TextDecoder().decode(u8.slice(6)).replace(/\0+$/, '').trim();
    log(`port 0x${port.toString(16)} mode ${mode} name: ${name || '(empty)'}`, 'info');
    return;
  }
  if (u8[5] === 0x04) {
    const symbol = new TextDecoder().decode(u8.slice(6)).replace(/\0+$/, '').trim();
    log(`port 0x${port.toString(16)} mode ${mode} unit: ${symbol || '(none)'}`, 'info');
    return;
  }
  if (u8[5] === 0x01 && u8.length >= 14) {
    const rangeView = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const range = { min: rangeView.getFloat32(6, true), max: rangeView.getFloat32(10, true) };
    state.portRanges[port] ||= {};
    state.portRanges[port][mode] = range;
    log(`port 0x${port.toString(16)} mode ${mode} raw range: ${range.min}…${range.max}`, 'info');
    return;
  }
  if (u8[5] !== 0x80 || u8.length < 10) return;
  const fmt = { datasets: u8[6], type: u8[7], figures: u8[8], decimals: u8[9] };
  state.portFormats[port] ||= {};
  state.portFormats[port][mode] = fmt;
  log(`Value format port 0x${port.toString(16)} mode ${mode}: ${fmt.datasets}×${['s8','s16','s32','f32'][fmt.type] || '?'} (${fmt.figures} figures, ${fmt.decimals} decimals)`, 'info');
}

function readSensorNumber(dv, offset, fmt, length) {
  const type = fmt?.type ?? 1;
  const bytes = [1, 2, 4, 4][type];
  if (!bytes || offset + bytes > length) return null;
  switch (type) {
    case 0: return dv.getInt8(offset);
    case 1: return dv.getInt16(offset, true);
    case 2: return dv.getInt32(offset, true);
    case 3: return dv.getFloat32(offset, true);
    default: return null;
  }
}

function decodePortValue(u8) {
  /* [len,hub,0x45,port,data…] — decode with the subscribed value format */
  const port = u8[3];
  const map = state.portModes[port];

  /* output ports subscribed for "activation" (speaker/LED) may echo values — nothing to display */
  if (state.ports.speaker?.port === port || state.ports.rgb?.port === port) return;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (!map) { log('Port Value for unsubscribed port 0x' + port.toString(16), 'warn'); return; }

  if (map.kind === 'events') {
    /* 2025 EVENTS: two little-endian u16 values (opcode, parameter).
     * Includes action-brick scans and the hub's own event stream. */
    if (u8.length >= 8) {
      const opcode = dv.getUint16(4, true);
      const param = dv.getUint16(6, true);
      if (opcode || param) {
        log(`EVENTS: Opcode 0x${opcode.toString(16).padStart(4, '0')}, Parameter 0x${param.toString(16).padStart(4, '0')}`, 'info');
      }
    }
    return;
  }

  if (map.kind === 'color') {
    const el = $('val-color');
    if (map.mode === 3) {
      const fmt = state.portFormats[port]?.[map.mode] || { datasets: 3, type: 1, decimals: 0 };
      const width = [1, 2, 4, 4][fmt.type] || 2;
      const channels = Array.from({ length: Math.min(fmt.datasets || 3, 3) }, (_, i) => readSensorNumber(dv, 4 + i * width, fmt, u8.length));
      if (channels.length !== 3 || channels.some(value => value === null)) return;
      const range = state.portRanges[port]?.[map.mode];
      const hasRange = range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min;
      const rgb = hasRange
        ? channels.map(value => Math.max(0, Math.min(255, Math.round((value - range.min) * 255 / (range.max - range.min)))))
        : null;
      const label = hasRange
        ? `R ${rgb[0]} · G ${rgb[1]} · B ${rgb[2]}`
        : `RAW R ${channels[0]} · G ${channels[1]} · B ${channels[2]}`;
      if (el.textContent !== label) log(`RGB sensor${hasRange ? '' : ' (raw; range unavailable)'}: ${label}`, 'info');
      el.textContent = label;
      el.title = hasRange ? `RAW: ${channels.join(' · ')} (s16)` : 'Rohintensitäten (s16); Farbbereich noch unbekannt';
      $('color-swatch').style.backgroundColor = hasRange ? `rgb(${rgb.join(',')})` : '#535866';
    } else {
      if (u8.length < 5) return;
      const idx = dv.getUint8(4);
      const name = (LWP3_COLORS.find(c => c[0] === idx) || [idx, 'unknown'])[1];
      const label = `${name} (${idx})`;
      if (el.textContent !== label) log(`colour sensor: ${name} (${idx})`, 'info');
      el.textContent = label;
      const background = COLOR_SWATCHES[idx] || '#6b7280';
      $('color-swatch').style.backgroundColor = background === 'transparent' ? '#535866' : background;
    }
  } else if (map.kind === 'speedo') {
    const fmt = state.portFormats[port]?.[map.mode];
    const raw = readSensorNumber(dv, 4, fmt, u8.length);
    if (raw === null) return;
    const value = raw / (10 ** (fmt?.decimals || 0));
    $('val-speedo').textContent = Number.isInteger(value) ? String(value) : value.toFixed(fmt?.decimals || 2);
    recordSensorSample('speedo', value);
  } else if (map.kind === 'voltage') {
    const fmt = state.portFormats[port]?.[map.mode];
    const raw = readSensorNumber(dv, 4, fmt, u8.length);
    if (raw === null) return;
    /* Older hubs send a 16-bit ADC reading; newer hubs send millivolts or volts. */
    const volts = fmt?.type === 1 ? raw * 6.4 / 3047 : fmt?.type === 2 ? raw / 1000 :
      fmt?.type === 3 ? raw / (10 ** (fmt.decimals || 0)) : raw * 6.4 / 3047;
    $('val-voltage').textContent = volts.toFixed(2) + ' V';
  }
}

const FW_FIELDS = ['fw', 'hw', 'name', 'rssi'];
function decodeHubProperties(u8) {
  const prop = u8[3], op = u8[4];
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const valStart = 5;
  switch (prop) {
    case 1: { /* advertising name */
      const s = new TextDecoder().decode(u8.slice(valStart));
      $('di-name').textContent = s || '(empty)';
      log('hub name: "' + s + '"', 'info'); break;
    }
    case 2: { /* button state */
      const b = dv.getUint8(valStart);
      $('di-button').textContent = b ? 'pressed 🔘' : 'released';
      break;
    }
    case 3: { /* fw version — Int32 in LEGO version-number encoding */
      state.versions.fw = verString(dv.getUint32(valStart, true));
      renderVersions(); break;
    }
    case 4: { /* hw version */
      state.versions.hw = verString(dv.getUint32(valStart, true));
      renderVersions(); break;
    }
    case 5: { /* rssi */
      const rssi = dv.getInt8(valStart);
      $('val-rssi').textContent = rssi + ' dBm';
      recordSensorSample('rssi', rssi);
      if ($('chk-hexlogging').checked) log('hub RSSI: ' + rssi + ' dBm', 'info');
      break;
    }
    case 6: { /* battery % */
      const p = dv.getUint8(valStart);
      $('di-battery').textContent = p + ' %';
      $('val-battery').textContent = p + ' %';
      break;
    }
    default: log('Hub property 0x' + prop.toString(16) + ' → ' + hex(u8.slice(valStart)), 'info');
  }
}

function renderVersions() {
  const parts = [];
  if (state.versions.fw) parts.push('fw ' + state.versions.fw);
  if (state.versions.hw) parts.push('hw ' + state.versions.hw);
  if (parts.length) $('di-versions').textContent = parts.join(' · ');
}

function verString(v) {
  /* LEGO version-number encoding: major(4b, top bit reserved) minor(4b) bugfix BCD(8b) build BCD(16b) */
  const major = v >>> 28;
  const minor = (v >>> 24) & 0x0f;
  const bugfix = ((v >>> 16) & 0xff).toString(16).padStart(2, '0');
  const build = ((v & 0xffff).toString(16) || '0').padStart(4, '0');
  return `${major}.${minor}.${bugfix}.${build}`;
}

function decodeHubAction(u8) {
  const action = u8[3];
  const names = { 0x01: 'switch off', 0x02: 'disconnect', 0x30: 'hub will switch off', 0x31: 'hub will disconnect', 0x32: 'going to boot mode' };
  log('Hub Action 0x' + action.toString(16) + (names[action] ? ' (' + names[action] + ')' : ''), 'info');
  if (action === 0x31 || action === 0x02) state.device?.gatt.disconnect();
}

function decodeFeedback(u8) {
  /* [len,hub,0x82,port,status] — status bits: 0x01 buffer empty & command
   * completed, 0x02 in progress, 0x04 command DISCARDED (hub silently
   * rejects the write!), 0x08 idle. Observed/decoded per LWP3 spec and
   * community captures (Legoino issue #90 / micschr0). */
  const port = u8[3], bits = u8[4];
  state.stats.fb++;
  if (!state.sawFeedback) {
    state.sawFeedback = true;
    log('hub sends output feedback (0x82) — sound/motor retry gating is now confirmed-ack-based', 'info');
  }

  const isSpeakerPort = !!(state.soundPending && state.soundPending.port === port);
  /* 2018/2024: 0x01 = buffer empty + completed. 2025: community captures show
   * 0x02 as "completed" and 0x01/0x08 as buffer status; accept all three so a
   * played sound is not interrupted by an unnecessary retry. */
  const completed = state.hubGeneration === 'modern'
    ? !!(bits & 0x02) || !!(bits & 0x01) || !!(bits & 0x08)
    : !!(bits & 0x01);
  if (isSpeakerPort && completed) {
    log('sound confirmed by hub feedback (port 0x' + port.toString(16) + ', status 0x' + bits.toString(16) + ')', 'info');
    clearSoundPending();
  }
  if (bits & 0x04) {
    state.stats.discard++;
    log('port feedback: command DISCARDED by hub (port 0x' + port.toString(16) + ' status 0x' + bits.toString(16) + ')', 'err');
  }
  /* completed/in-progress spam (keepalive) stays silent — see the bt-stats line */
  updateStats();
}

function decodeGenericError(u8) {
  const offending = u8[3], code = u8[4];
  log(`Generic error: cmd 0x${offending.toString(16)} → ${ERROR_CODES[code] || 'code ' + code}`, 'err');
}

function updateStats() {
  const s = state.stats;
  const el = $('bt-stats');
  if (el) el.textContent = 'writes ok ' + s.tx + ' · write errors ' + s.txErr +
    ' · hub feedback ' + s.fb + ' · discarded ' + s.discard +
    (state.preferWrite ? ' · writeValue fallback ACTIVE' : '');
}

const CHART_WINDOW_MS = 60_000;
function recordSensorSample(sensor, value) {
  const now = Date.now();
  const samples = state.sensorHistory[sensor];
  samples.push({ time: now, value });
  state.sensorHistory[sensor] = samples.filter(sample => now - sample.time <= CHART_WINDOW_MS);
  drawSensorChart(now);
}

function drawSensorChart(now = Date.now()) {
  const canvas = $('sensor-chart');
  if (!canvas) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const panels = [
    { key: 'speedo', label: 'Tacho', color: '#ffd500', top: 8, bottom: 124 },
    { key: 'rssi', label: 'RSSI (dBm)', color: '#71b7ff', top: 145, bottom: 261 },
  ];
  for (const panel of panels) {
    const left = 58, right = width - 12;
    const samples = state.sensorHistory[panel.key].filter(sample => now - sample.time <= CHART_WINDOW_MS);
    const values = samples.map(sample => sample.value);
    let min = panel.key === 'rssi' ? -100 : Math.min(0, ...values);
    let max = panel.key === 'rssi' ? 0 : Math.max(1, ...values);
    if (panel.key === 'speedo') {
      const padding = Math.max(1, (max - min) * 0.1);
      min -= padding; max += padding;
    }
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#9aa0b0';
    ctx.fillText(panel.label, 8, panel.top + 12);
    ctx.strokeStyle = '#303647'; ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const y = panel.top + 25 + i * 34;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.fillStyle = '#858b9b';
      ctx.fillText((max - (max - min) * i / 2).toFixed(0), 8, y + 4);
    }
    ctx.fillStyle = '#73798a';
    ctx.fillText('−60 s', left, panel.bottom - 3);
    ctx.fillText('jetzt', Math.max(left, right - 30), panel.bottom - 3);
    if (!samples.length) continue;
    ctx.strokeStyle = panel.color; ctx.lineWidth = 2; ctx.beginPath();
    samples.forEach((sample, index) => {
      const x = left + Math.max(0, Math.min(1, 1 - (now - sample.time) / CHART_WINDOW_MS)) * (right - left);
      const y = panel.top + 25 + (max - sample.value) / (max - min || 1) * 68;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function requestRssi() {
  if (!state.connected) return;
  throttler.enqueue(cmdHubPropRequest(5));
}

function stopRssiPolling() {
  if (state.rssiInterval !== null) {
    clearInterval(state.rssiInterval);
    state.rssiInterval = null;
  }
}

/* ============================================================== UI wiring */

function ports() {
  /* resolve by device type attached at runtime; fall back to the known layout */
  const modern = state.hubGeneration === 'modern';
  return {
    motor:   state.ports.motor?.port   ?? (modern ? PORT_FALLBACK_MODERN.motor   : PORT_FALLBACK.motor),
    speaker: state.ports.speaker?.port ?? PORT_FALLBACK_MODERN.speaker,
    rgb:     state.ports.rgb?.port     ?? (modern ? PORT_FALLBACK_MODERN.rgb     : PORT_FALLBACK.rgb),
    color:   state.ports.color?.port   ?? (modern ? PORT_FALLBACK_MODERN.color   : PORT_FALLBACK.color),
    speedo:  state.ports.speedo?.port  ?? (modern ? PORT_FALLBACK_MODERN.speedo  : PORT_FALLBACK.speedo),
    voltage: state.ports.voltage?.port ?? (modern ? PORT_FALLBACK_MODERN.voltage : PORT_FALLBACK.voltage),
  };
}

function renderPorts() {
  const grid = $('ports-grid');
  grid.innerHTML = '';
  const kinds = Object.keys(state.ports);
  if (!kinds.length) { grid.innerHTML = '<p class="hint">Noch keine Anschlüsse gemeldet …</p>'; return; }
  kinds.sort((a, b) => state.ports[a].port - state.ports[b].port);
  for (const k of kinds) {
    const p = state.ports[k];
    const el = document.createElement('div');
    el.className = 'porttile';
    el.innerHTML = `<b>${portKindLabel(k)}</b><span>port 0x${p.port.toString(16)} · type 0x${p.type.toString(16)} · ${p.name}</span>`;
    grid.appendChild(el);
  }
}

function updateSpeedReadout() {
  const v = parseInt($('speed').value, 10);
  $('speed-readout').textContent = (v > 0 ? '↑' : v < 0 ? '↓' : '') + Math.abs(v);
  $('speed-readout').style.color = v === 0 ? 'var(--dim)' : v > 0 ? 'var(--green)' : 'var(--red)';
}

function removeQueuedMotorCommands() {
  const motorPort = ports().motor;
  throttler.queue = throttler.queue.filter(msg =>
    !(msg[2] === 0x81 && msg[3] === motorPort && msg[5] === 0x51 && msg[6] === 0x00));
}

function enqueueLatestMotor(speed) {
  removeQueuedMotorCommands();
  throttler.enqueue(cmdMotor(speed));
}

function mountedControls() {
  window.addEventListener('resize', drawSensorChart);
  drawSensorChart();

  /* ---- basic / expert view switch ------------------------------------ */
  $('mode-basic').onclick = () => setView('basic');
  $('mode-expert').onclick = () => setView('expert');
  let savedView = 'basic';
  try {
    if (localStorage.getItem('duplo.view') === 'expert') savedView = 'expert';
  } catch (e) { /* storage unavailable (private mode etc.) */ }
  setView(savedView, false);

  $('btn-clearchart').onclick = () => {
    state.sensorHistory = { speedo: [], rssi: [] };
    drawSensorChart();
  };
  /* ---- catch-up after tab throttling ----------------------------------
   * Chrome slows setInterval in background/hidden tabs to >=1000 ms — long
   * enough for a moving train to notice. When the page becomes visible or
   * focused again, immediately push the current setpoint so the train only
   * "misses" while nobody is looking. */
  const catchUp = () => {
    if (!state.connected || !state.characteristic || state.desiredSpeed === 0) return;
    enqueueLatestMotor(state.desiredSpeed);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { catchUp(); log('tab back in foreground — motor setpoint catch-up sent', 'info'); }
  });
  window.addEventListener('focus', catchUp);
  window.addEventListener('pageshow', catchUp);

  /* Send while dragging. Coalesce queued motor values so only the freshest target waits. */
  $('speed').addEventListener('input', () => {
    updateSpeedReadout();
    const v = parseInt($('speed').value, 10);
    state.desiredSpeed = v;
    if (state.connected && state.characteristic) enqueueLatestMotor(v);
  });
  $('speed').addEventListener('change', () => {
    const v = parseInt($('speed').value, 10);
    state.desiredSpeed = v;
    if (!connectedGuard()) return;
    const msg = cmdMotor(v), again = cmdMotor(v);
    bytesOf(msg, 'TX', 'tx');
    log(`→ Port Output: motor ${v > 0 ? 'forward' : v < 0 ? 'reverse' : 'stop'} ${Math.abs(v)}` + (v !== 0 ? ' (+repeat, +100 ms keepalive)' : ''), 'info');
    removeQueuedMotorCommands();
    throttler.enqueue(msg);
    throttler.enqueue(again);
  });
  $('btn-slowdown').onclick = () => { $('speed').value = Math.max(-100, parseInt($('speed').value, 10) - 10); $('speed').dispatchEvent(new Event('change')); };
  $('btn-speedup').onclick  = () => { $('speed').value = Math.min(100, parseInt($('speed').value, 10) + 10); $('speed').dispatchEvent(new Event('change')); };
  $('btn-stop').onclick = () => {
    $('speed').value = 0; updateSpeedReadout();
    state.desiredSpeed = 0;                  /* keepalive falls silent at 0 */
    if (!connectedGuard()) return;
    const msg = cmdMotor(0), again = cmdMotor(0);
    bytesOf(msg, 'TX', 'tx');
    removeQueuedMotorCommands();
    throttler.enqueue(msg); throttler.enqueue(again);   /* stop twice — also drop-prone */
    log('→ motor stop (speed 0, sent twice)', 'info');
  };

  /* basic quick actions: horn + light toggle */
  $('btn-horn').onclick = () => {
    if (!connectedGuard()) return;
    $('btn-horn').classList.add('pulse');
    setTimeout(() => $('btn-horn').classList.remove('pulse'), 300);
    playSoundReliable(9);
  };
  $('btn-light').onclick = toggleLight;
  renderLightState();

  /* sounds */
  $('sounds').querySelectorAll('button[data-sound]').forEach(b => {
    b.onclick = () => {
      if (!connectedGuard()) return;
      playSoundReliable(parseInt(b.dataset.sound, 10));
    };
  });
  $('btn-testsound').onclick = () => {
    const id = Number($('sound-id').value);
    if (!Number.isInteger(id) || id < 0 || id > 255) {
      log('Sound-ID muss eine ganze Zahl von 0 bis 255 sein', 'warn');
      return;
    }
    if (!connectedGuard()) return;
    log(`testing unlisted sound ID ${id}`, 'info');
    playSoundReliable(id);
  };

  /* LED colours — palette follows the detected hub generation
   * (2018 LWP3 table vs. the 2025 EVENTS colour set). */
  renderLedPalette();
  $('btn-battery').onclick = () => { if (connectedGuard()) { throttler.enqueue(cmdHubPropRequest(6)); log('→ Hub Properties: request battery(6)', 'info'); } };
  $('btn-versions').onclick = () => { if (connectedGuard()) { throttler.enqueue(cmdHubPropRequest(3)); throttler.enqueue(cmdHubPropRequest(4)); log('→ Hub Properties: request fw(3), hw(4)', 'info'); } };
  $('btn-rssi').onclick = () => { if (connectedGuard()) { requestRssi(); log('→ Hub Properties: request rssi(5) — link quality probe', 'info'); } };
  $('btn-probeports').onclick = probePorts;
  $('btn-choose').onclick = findAndConnect;
  $('btn-disconnect').onclick = disconnectNow;
  $('btn-poweroff').onclick = () => {
    if (!connectedGuard()) return;
    throttler.enqueue(cmdHubAction(0x01));
    log('→ Hub Action: switch off (0x01) — train will announce 0x30/0x31 first', 'info');
  };
  $('btn-clearlog').onclick = () => { $('log').textContent = ''; };
  $('btn-copylog').onclick = async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText($('log').innerText || $('log').textContent);
      button.textContent = 'Kopiert!';
      setTimeout(() => { button.textContent = 'Logs kopieren'; }, 1500);
    } catch (e) {
      log('Could not copy logs: ' + (e?.message || e), 'err');
    }
  };

  /* throttle rate switch — mirrors SetNoAckParameters */
  $('chk-throttle').addEventListener('change', (e) => {
    throttler.packetsPerWindow = e.target.checked ? 4 : 64;
    throttler.windowMillis = e.target.checked ? 80 : 0;
    log('SendThrottler: ' + (e.target.checked ? '4 packets / 80 ms (app default)' : 'unthrottled'), 'info');
  });

  /* advanced: advertising watch (Chrome experimental) */
  $('btn-advscan').onclick = advancedAdvertWatch;
}

function connectedGuard() {
  if (state.connected) return true;
  log('Nicht verbunden – zuerst „Zug suchen“ drücken.', 'warn');
  return false;
}

/* ==== advanced scan path: mirrors the app's "no filter + read LEGO mfr data"
 * Chrome only, behind chrome://flags/#enable-experimental-web-platform-features */
async function advancedAdvertWatch() {
  if (!webBluetoothAvailable()) { log('no Web Bluetooth', 'err'); return; }
  if (!navigator.bluetooth.requestLEScan) {
    log('requestLEScan is unavailable — enable chrome://flags/#enable-experimental-web-platform-features for manufacturer-data scanning (the app\u2019s raw approach).', 'warn');
    return;
  }
  try {
    await navigator.bluetooth.requestLEScan({
      filters: [{ services: [LWP3.SERVICE] }],
      keepRepeatedDevices: true,
    });
    log('advertising watch started — LEGO manufacturer data (0x0397) will be decoded', 'info');
    setPill('pill-scan', 'Scan läuft (Advert watch)', 'pill-ok');
  } catch (e) { log('requestLEScan failed: ' + e.message, 'err'); }

  const devices = await navigator.bluetooth.getDevices().catch(() => []);
  let watched = 0;
  for (const d of devices) {
    if (d.watchAdvertisementsSupported !== false) {
      try {
        d.addEventListener('advertisementreceived', (ev) => {
          const md = ev.manufacturerData?.get(LWP3.MFR_ID);
          if (!md) return;
          const u8 = new Uint8Array(md.buffer, md.byteOffset, md.byteLength);
          /* six LEGO bytes: [button, systemType, capabilities, lastNet, status, option] */
          const bytesHex = hex(u8);
          const sysType = u8[1] ?? null;
          $('di-mfr').textContent = bytesHex;
          $('di-hubtype').textContent = HUB_TYPES[sysType] ?? ('0x' + (sysType ?? 0).toString(16));
          if (ev.rssi != null) log(`advert ${d.name || '(no-name)'} rssi=${ev.rssi} LEGO-data[${bytesHex}] hub=0x${(sysType ?? 0).toString(16)}`, 'info');
          state.lastSeenAdvert = bytesHex;
        });
        await d.watchAdvertisements().catch(() => {});
        watched++;
      } catch (e) { /* skip */ }
    }
  }
  log('watching ' + watched + ' known device(s); open "Find train…" to add them.', 'info');
}

/* ================================================================= bootstrap */
function bootstrapDuplo() {
  if (!$('btn-choose')) return;   // controls must be present in the document
  mountedControls();
  updateSpeedReadout();
  if (!webBluetoothAvailable()) {
    setPill('pill-bt', 'Kein Web Bluetooth', 'pill-warn');
    log('navigator.bluetooth missing — use Chrome/Edge. HTTPS or localhost required.', 'err');
  } else {
    setPill('pill-bt', 'Web Bluetooth bereit', 'pill-ok');
  }
  setPill('pill-scan', 'Scan bereit', 'pill-off');
  setPill('pill-conn', 'Nicht verbunden', 'pill-off');
  log('Names/protocol mirrored 1:1 from the LEGO DUPLO Train app: scan→' + LWP3.SERVICE.slice(4, 8) + '…, mfr id 919 (0x0397), throttler 4/80ms.', 'info');
}
window.addEventListener('DOMContentLoaded', bootstrapDuplo);
