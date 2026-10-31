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
};

const PORT_FALLBACK = {  /* 2018 hub layout — used only until Attached I/O arrives */
  motor: 0x00, speaker: 0x01, rgb: 0x11, color: 0x12, speedo: 0x13, voltage: 0x14,
};

const LWP3_COLORS = [
  [0,'Black'], [1,'Pink'], [2,'Purple'], [3,'Blue'], [4,'Light blue'],
  [5,'Cyan'], [6,'Green'], [7,'Yellow'], [8,'Orange'], [9,'Red'], [10,'White'], [255,'None'],
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
  portFormats: {},      /* port -> {datasets, type, figures, decimals} from Mode Info 0x80 */
  versions: { fw: null, hw: null },
  desiredSpeed: 0,      /* last commanded motor setpoint (keepalive source) */
  keepalive: null,      /* keepalive interval id */
  sawFeedback: false,   /* hub emitted 0x82 at least once */
  soundPending: null,   /* retry book-keeping for the lossy sound channel */
  preferWrite: false,   /* fall back to writeValue after WWR failures */
  stats: { tx: 0, txErr: 0, fb: 0, discard: 0 },
  lastSeenAdvert: null, /* hex of LEGO 6 bytes, from advert watch when available */
};

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
function cmdSound(id, port = ports()) {
  return lwp3Build(0x81, [port.speaker, 0x11, 0x51, 0x01, id]);
}
function cmdLed(color, port = ports()) {
  return lwp3Build(0x81, [port.rgb, 0x11, 0x51, 0x00, color]);
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
    this.onDrained = null;
  }
  writeCharacteristic(data) { /* default impl, replaced at runtime */ }

  enqueue(data) { this.queue.push(data); this.flush(); }

  flush() {
    while (this.timer === null && this.queue.length && this.canSendNow()) {
      const next = this.queue.shift();
      this.sentStamps.push(performance.now());
      try {
        const r = this.writeCharacteristic(next);
        if (r && typeof r.catch === 'function') r.catch(err => log('write failed: ' + (err?.message || err), 'err'));
      } catch (e) { log('write failed: ' + (e?.message || e), 'err'); }
    }
    if (this.queue.length && this.timer === null) {
      const oldest = this.sentStamps.length ? this.sentStamps[0] : performance.now();
      const wait = Math.max(1, this.windowMillis - (performance.now() - oldest));
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
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
    throttler.enqueue(cmdMotor(state.desiredSpeed));
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
  const port = ports().speaker;
  const msg = cmdSound(id);
  bytesOf(msg, 'TX', 'tx');
  log('→ Sound: ' + name, 'info');
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
    setPill('pill-bt', 'No Web Bluetooth', 'pill-warn');
    return;
  }
  setPill('pill-bt', 'Web Bluetooth ready', 'pill-ok');
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
  setPill('pill-conn', 'Connecting…', 'pill-warn');
  try {
    state.server = await d.gatt.connect();
    log('GATT connected — (app does: requestConnectionPriority → discoverServices)', 'info');
  } catch (e) {
    /* 2025 hub (Hub No. 16) requires bonding; Chrome pairs automatically…  */
    log('connect failed: ' + e.message + ' (2025 hub requires bonding — accept the pairing dialog)', 'err');
    setPill('pill-conn', 'Connect failed', 'pill-off');
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
  setPill('pill-conn', 'Connected', 'pill-ok');
  $('btn-disconnect').disabled = false;
  $('btn-poweroff').disabled = false;
  $('device-info').classList.remove('hidden');
  $('di-id').textContent = d.id || 'n/a (Chrome hides MAC)';
  $('di-name').textContent = d.name || '(empty)';

  /* mirror the app side-effect: zero the drive slider + reset UI */
  $('speed').value = 0; updateSpeedReadout();

  /* kick off hub scaffolding exactly like the game:
     button updates on, battery request, versions request */
  throttler.enqueue(cmdHubPropEnable(2));   /* button state updates   */
  throttler.enqueue(cmdHubPropRequest(6));  /* battery level          */
  throttler.enqueue(cmdHubPropRequest(3));  /* firmware version       */
  throttler.enqueue(cmdHubPropRequest(4));  /* hardware version       */
  log('requested Hub Properties: button(2) enable-updates, battery(6), fw(3), hw(4)', 'info');

  /* keepalive loop for the hub's drop-happy motor channel (see class comment) */
  startMotorKeepalive();
}

function disconnectNow() {
  stopMotorKeepalive();
  state.desiredSpeed = 0;
  clearSoundPending();
  if (state.characteristic) { try { state.characteristic.stopNotifications(); } catch (e) {} }
  state.device?.gatt.disconnect();
}

function onDisconnected() {
  stopMotorKeepalive();
  state.desiredSpeed = 0;
  clearSoundPending();
  state.sawFeedback = false;
  state.preferWrite = false;
  state.stats = { tx: 0, txErr: 0, fb: 0, discard: 0 };
  updateStats();
  state.connected = false;
  state.characteristic = null;
  state.ports = {}; state.portModes = {}; state.portFormats = {};
  state.versions = { fw: null, hw: null };
  $('btn-disconnect').disabled = true;
  $('btn-poweroff').disabled = true;
  $('device-info').classList.add('hidden');
  $('ports-grid').innerHTML = '<p class="hint">Connect first — the train announces its own ports.</p>';
  setPill('pill-conn', 'Disconnected', 'pill-off');
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
  if (type !== 0x82) log('← ' + name, 'info');    /* 0x82 is logged by decodeFeedback selectively */

  switch (type) {
    case 0x04: return decodeAttachedIO(u8);
    case 0x45: return decodePortValue(u8);
    case 0x01: return decodeHubProperties(u8);
    case 0x02: return decodeHubAction(u8);
    case 0x82: return decodeFeedback(u8);
    case 0x05: return decodeGenericError(u8);
    case 0x44: return decodeModeInfo(u8);
    default:
      /* 0x43 Port Information, 0x47 … also tolerated */
  }
}

function portKindLabel(k) {
  return { motor: 'Motor', speaker: 'Speaker', rgb: 'LED', color: 'Colour', speedo: 'Speedometer', voltage: 'Voltage' }[k] || k;
}

function decodeAttachedIO(u8) {
  /* [len,hub,0x04,port,event,typeLo,typeHi,hwRev×4,swRev×4] */
  const port = u8[3], event = u8[4];
  const type = u8[6] << 8 | u8[5];
  const tName = DEVICE_TYPES[type] || 'Unknown 0x' + type.toString(16);
  const evName = { 0: 'detached', 1: 'attached', 2: 'attached (virtual)' }[event] || '?';
  log(`Attached I/O: port 0x${port.toString(16)} ${evName} — ${tName}`, 'info');

  if (event === 0) { Object.keys(state.ports).forEach(k => { if (state.ports[k].port === port) delete state.ports[k]; }); renderPorts(); return; }
  if (event !== 1) return;

  let kind = null;
  switch (type) {
    case 0x29: kind = 'motor'; break;
    case 0x2A: kind = 'speaker'; break;
    case 0x17: kind = 'rgb'; break;
    case 0x2B: kind = 'color'; break;
    case 0x2C: kind = 'speedo'; break;
    case 0x14: kind = 'voltage'; break;
  }
  if (!kind) return;

  state.ports[kind] = { port, type, name: tName };

  /* Legoino parity: subscribe the output ports' modes before writing to them
   * (they do 0x41 + mode before every sound/LED command). notify = off, so
   * this only "activates" the port on the hub. */
   if (kind === 'speaker') { throttler.enqueue(cmdSubscribe(port, 1, 1, false)); }
   if (kind === 'rgb')     { throttler.enqueue(cmdSubscribe(port, 0, 1, false)); }

  /* sensors: subscribe like the app feeds the game — delta=1 */
  if (kind === 'color') { state.portModes[port] = { kind, mode: 0 }; throttler.enqueue(cmdSubscribe(port, 0, 1, true)); requestModeInfo(port, 0); }
  if (kind === 'speedo') { state.portModes[port] = { kind, mode: 0 }; throttler.enqueue(cmdSubscribe(port, 0, 1, true)); requestModeInfo(port, 0); }
  if (kind === 'voltage') { state.portModes[port] = { kind, mode: 0 }; throttler.enqueue(cmdSubscribe(port, 0, 1, true)); requestModeInfo(port, 0); }
  renderPorts();
}

function requestModeInfo(port, mode) {
  /* Port Mode Information Request: [len,hub,0x22,port,mode,info] info=0x80 VALUE FORMAT */
  throttler.enqueue(lwp3Build(0x22, [port, mode, 0x80]));
}

function decodeModeInfo(u8) {
  /* [len,hub,0x44,port,mode,0x80,datasets,type,figures,decimals] */
  if (u8[5] !== 0x80) return;
  const port = u8[3], mode = u8[4];
  const fmt = { datasets: u8[6], type: u8[7], figures: u8[8], decimals: u8[9] };
  state.portFormats[port] = fmt;
  const map = state.portModes[port];
  if (map) log(`Value format port 0x${port.toString(16)}: ${fmt.datasets}×${['s8','s16','s32','f32'][fmt.type] || '?'}`, 'info');
}

function decodePortValue(u8) {
  /* [len,hub,0x45,port,data…] — decode with the subscribed value format */
  const port = u8[3];
  const map = state.portModes[port];

  /* output ports subscribed for "activation" (speaker/LED) may echo values — nothing to display */
  if (state.ports.speaker?.port === port || state.ports.rgb?.port === port) return;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (!map) { log('Port Value for unsubscribed port 0x' + port.toString(16), 'warn'); return; }

  if (map.kind === 'color') {
    if (u8.length < 5) return;
    const idx = dv.getUint8(4);
    const name = (LWP3_COLORS.find(c => c[0] === idx) || [idx, 'unknown'])[1];
    $('val-color').textContent = `${name} (${idx})`;
  } else if (map.kind === 'speedo') {
    /* VALUE FORMAT usually s16 (tics per decisecond); fall back per received format */
    const fmt = state.portFormats[port];
    let v = 0, unit = '';
    switch (fmt?.type) {
      case 0: if (u8.length < 5) return; v = dv.getInt8(4); unit = ''; break;
      case undefined:
      case 1: if (u8.length < 6) return; v = dv.getInt16(4, true); unit = ' tics/10'; break;
      case 2: if (u8.length < 8) return; v = dv.getInt32(4, true); unit = ''; break;
      default: if (u8.length < 8) return; v = dv.getFloat32(4, true); unit = ''; break;
    }
    $('val-speedo').textContent = v + unit;
  } else if (map.kind === 'voltage') {
    /* 2018 hub: u16 raw → Volts = raw*6.4/3047 ; 2025 hub reports mV directly */
    if (u8.length < 6) return;
    const fmt = state.portFormats[port];
    let volts;
    if (fmt && fmt.type === 2) volts = dv.getInt32(4, true) / 1000;
    else {
      const raw = dv.getUint16(4, true);
      volts = raw * 6.4 / 3047;
    }
    $('val-voltage').textContent = volts.toFixed(2) + ' V';
    $('di-battery').textContent = volts.toFixed(2) + ' V (measured)';
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
      log('hub RSSI: ' + dv.getInt8(valStart) + ' dBm', 'info'); break;
    }
    case 6: { /* battery % */
      const p = dv.getUint8(valStart);
      $('di-battery').textContent = p + ' %';
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
  if (isSpeakerPort && (bits & 0x01)) {                     /* completed → stop retrying */
    log('sound confirmed by hub feedback (port 0x' + port.toString(16) + ')', 'info');
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

/* ============================================================== UI wiring */

function ports() {
  /* resolve by device type attached at runtime; fall back to 2018 layout */
  return {
    motor:   state.ports.motor?.port   ?? PORT_FALLBACK.motor,
    speaker: state.ports.speaker?.port ?? PORT_FALLBACK.speaker,
    rgb:     state.ports.rgb?.port     ?? PORT_FALLBACK.rgb,
    color:   state.ports.color?.port   ?? PORT_FALLBACK.color,
    speedo:  state.ports.speedo?.port  ?? PORT_FALLBACK.speedo,
    voltage: state.ports.voltage?.port ?? PORT_FALLBACK.voltage,
  };
}

function renderPorts() {
  const grid = $('ports-grid');
  grid.innerHTML = '';
  const kinds = Object.keys(state.ports);
  if (!kinds.length) { grid.innerHTML = '<p class="hint">No ports announced yet…</p>'; return; }
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
  $('speed-readout').style.color = v === 0 ? 'var(--dim)' : v > 0 ? 'var(--ok)' : 'var(--bad)';
}

function mountedControls() {
  /* ---- catch-up after tab throttling ----------------------------------
   * Chrome slows setInterval in background/hidden tabs to >=1000 ms — long
   * enough for a moving train to notice. When the page becomes visible or
   * focused again, immediately push the current setpoint so the train only
   * "misses" while nobody is looking. */
  const catchUp = () => {
    if (!state.connected || !state.characteristic || state.desiredSpeed === 0) return;
    throttler.enqueue(cmdMotor(state.desiredSpeed));
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { catchUp(); log('tab back in foreground — motor setpoint catch-up sent', 'info'); }
  });
  window.addEventListener('focus', catchUp);
  window.addEventListener('pageshow', catchUp);

  /* drive slider — track the setpoint for the keepalive; send change + one
   * immediate repeat (the hub drops single motor writes, see keepalive block) */
  $('speed').addEventListener('input', updateSpeedReadout);
  $('speed').addEventListener('change', () => {
    const v = parseInt($('speed').value, 10);
    state.desiredSpeed = v;
    if (!connectedGuard()) return;
    const msg = cmdMotor(v), again = cmdMotor(v);
    bytesOf(msg, 'TX', 'tx');
    log(`→ Port Output: motor ${v > 0 ? 'forward' : v < 0 ? 'reverse' : 'stop'} ${Math.abs(v)}` + (v !== 0 ? ' (+repeat, +100 ms keepalive)' : ''), 'info');
    throttler.enqueue(msg);
    if (v !== 0) throttler.enqueue(again);
  });
  $('btn-slowdown').onclick = () => { $('speed').value = Math.max(-100, parseInt($('speed').value, 10) - 10); $('speed').dispatchEvent(new Event('change')); };
  $('btn-speedup').onclick  = () => { $('speed').value = Math.min(100, parseInt($('speed').value, 10) + 10); $('speed').dispatchEvent(new Event('change')); };
  $('btn-stop').onclick = () => {
    $('speed').value = 0; updateSpeedReadout();
    state.desiredSpeed = 0;                  /* keepalive falls silent at 0 */
    if (!connectedGuard()) return;
    const msg = cmdMotor(0), again = cmdMotor(0);
    bytesOf(msg, 'TX', 'tx');
    throttler.enqueue(msg); throttler.enqueue(again);   /* stop twice — also drop-prone */
    log('→ motor stop (speed 0, sent twice)', 'info');
  };

  /* sounds */
  $('sounds').querySelectorAll('button[data-sound]').forEach(b => {
    b.onclick = () => {
      if (!connectedGuard()) return;
      playSoundReliable(parseInt(b.dataset.sound, 10));
    };
  });

  /* LED colours — LWP3 palette */
  const wrap = $('ledcolors');
  for (const [id, name] of LWP3_COLORS) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => {
      if (!connectedGuard()) return;
      const msg = cmdLed(id);
      bytesOf(msg, 'TX', 'tx');
      log(`→ LED colour: ${name} (${id})`, 'info');
      throttler.enqueue(msg);
    };
    wrap.appendChild(b);
  }

  $('btn-battery').onclick = () => { if (connectedGuard()) { throttler.enqueue(cmdHubPropRequest(6)); log('→ Hub Properties: request battery(6)', 'info'); } };
  $('btn-versions').onclick = () => { if (connectedGuard()) { throttler.enqueue(cmdHubPropRequest(3)); throttler.enqueue(cmdHubPropRequest(4)); log('→ Hub Properties: request fw(3), hw(4)', 'info'); } };
  $('btn-rssi').onclick = () => { if (connectedGuard()) { throttler.enqueue(cmdHubPropRequest(5)); log('→ Hub Properties: request rssi(5) — link quality probe', 'info'); } };
  $('btn-choose').onclick = findAndConnect;
  $('btn-disconnect').onclick = disconnectNow;
  $('btn-poweroff').onclick = () => {
    if (!connectedGuard()) return;
    throttler.enqueue(cmdHubAction(0x01));
    log('→ Hub Action: switch off (0x01) — train will announce 0x30/0x31 first', 'info');
  };
  $('btn-clearlog').onclick = () => { $('log').textContent = ''; };

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
  log('not connected — press “Find train…” first', 'warn');
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
    setPill('pill-scan', 'Scanning (advert watch)', 'pill-ok');
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
  if (!$('btn-choose')) return; // React mounts the controls before its ready event.
  mountedControls();
  updateSpeedReadout();
  if (!webBluetoothAvailable()) {
    setPill('pill-bt', 'No Web Bluetooth', 'pill-warn');
    log('navigator.bluetooth missing — use Chrome/Edge. HTTPS or localhost required.', 'err');
  } else {
    setPill('pill-bt', 'Web Bluetooth ready', 'pill-ok');
  }
  setPill('pill-scan', 'NotScanning', 'pill-off');
  setPill('pill-conn', 'Disconnected', 'pill-off');
  log('Names/protocol mirrored 1:1 from the LEGO DUPLO Train app: scan→' + LWP3.SERVICE.slice(4, 8) + '…, mfr id 919 (0x0397), throttler 4/80ms.', 'info');
}
window.addEventListener('DOMContentLoaded', bootstrapDuplo);
window.addEventListener('duplo-ui-ready', bootstrapDuplo);
