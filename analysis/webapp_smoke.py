import quickjs

ROOT = '/home/nico/duplo/webapp'

stubs = r'''
var __els = {};
function __mkEl(id) {
  return {
    id: id, textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    className: '', dataset: {}, style: {}, __h: {},
    addEventListener: function (t, cb) { (this.__h[t] = this.__h[t] || []).push(cb); },
    dispatchEvent: function () { return true; },
    appendChild: function () {}, querySelectorAll: function () { return []; },
    classList: { add: function () {}, remove: function () {} },
    scrollTop: 0, scrollHeight: 0,
  };
}
var document = {
  getElementById: function (id) { if (!__els[id]) __els[id] = __mkEl(id); return __els[id]; },
  createElement: function () { return __mkEl(); },
};
var window = { __hooks: {}, addEventListener: function (t, cb) { window.__hooks[t] = cb; } };
var navigator = {};
var performance = { now: function () { return Date.now(); } };
/* stub timers collect (fn, ms) so tests can fire them manually */
var __timers = [];
var setTimeout = function (fn, ms) { var id = __timers.length + 1; __timers.push([fn, ms, id]); return id; };
var clearTimeout = function (id) {
  for (var i = __timers.length - 1; i >= 0; i--) { if (__timers[i][2] === id) { __timers.splice(i, 1); return; } }
};
var __intervals = [];
var setInterval = function (fn, ms) { var id = __intervals.length + 1; __intervals.push([fn, ms, id]); return id; };
var clearInterval = function (id) {
  for (var i = __intervals.length - 1; i >= 0; i--) { if (__intervals[i][2] === id) { __intervals.splice(i, 1); return; } }
};
function TextDecoder() {}
TextDecoder.prototype.decode = function (u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };
function fireTimers(ms) {
  var fired = 0;
  for (var i = __timers.length - 1; i >= 0; i--) if (ms === undefined || __timers[i][1] === ms) __timers.splice(i, 1)[0][0]();
  return fired;
}
'''

src = open(f'{ROOT}/app.js', encoding='utf-8').read()

ctx = quickjs.Context()
ctx.eval(stubs)
ctx.eval(src)                                       # full top-level execution
ctx.eval('window.__hooks["DOMContentLoaded"]()')    # bootstrap exactly like a page load

test_js = r'''
(function () {
  var h = function (u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; };
  var out = [];
  out.push(h(cmdMotor(50)));
  out.push(h(cmdMotor(-30)));
  out.push(h(cmdSound(9)));
  out.push(h(cmdLed(3)));
  out.push(h(cmdSubscribe(0x12, 0, 1, true)));
  out.push(h(cmdHubPropRequest(6)));
  out.push(h(cmdHubAction(0x01)));
  out.push(verString(0x12030004));
  /* ---- throttler windowing ---- */
  var sent = 0;
  throttler.packetsPerWindow = 4; throttler.windowMillis = 80;
  throttler.writeCharacteristic = async function (d) { sent++; };
  for (var i = 0; i < 6; i++) throttler.enqueue(lwp3Build(0x02, [0x01]));
  out.push('sent=' + sent);
  throttler.packetsPerWindow = 64; throttler.windowMillis = 0;
  for (var j = 0; j < 3; j++) throttler.enqueue(lwp3Build(0x02, [0x01]));
  out.push('sent=' + sent);
  fireTimers();                                   /* emulate real timer flush */
  out.push('sent-after-timer=' + sent);
  out.push('timers=' + __timers.length);
  /* ---- motor keepalive ---- */
  startMotorKeepalive();
  out.push('intervals=' + __intervals.length);
  state.desiredSpeed = 42;
  state.connected = true;
  state.characteristic = {};
  var keepSent = 0;
  throttler.writeCharacteristic = async function (d) { keepSent++; };
  for (var k = 0; k < 3; k++) __intervals[__intervals.length - 1][0]();
  out.push('keepalive=' + keepSent);
  state.desiredSpeed = 0;
  __intervals[__intervals.length - 1][0]();
  out.push('keepalive-zero=' + keepSent);
  stopMotorKeepalive();
  out.push('intervals-cleared=' + (state.keepalive === null ? 'yes' : 'no'));
  /* ---- sound channel: retry book-keeping + feedback gating ---- */
  var s2 = 0;
  throttler.writeCharacteristic = async function (d) { s2++; };
  state.connected = true; state.characteristic = {};
  state.sawFeedback = false; state.soundPending = null;
  playSoundReliable(9);
  out.push('sound-timer=' + (__timers.some(t => t[1] === 250) ? 'yes' : 'no'));
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x01]));  /* completed → cancel retries */
  out.push('sound-cleared=' + (state.soundPending === null ? 'yes' : 'no'));
  out.push('saw-feedback=' + state.sawFeedback);
  playSoundReliable(5);                                      /* feedback-capable hub → gated */
  var beforeRetry = s2;
  var fired = 0;
  for (var q = __timers.length - 1; q >= 0; q--) if (__timers[q][1] === 250) { __timers.splice(q, 1)[0][0](); fired++; }
  out.push('fired=' + fired);
  out.push('retried=' + (s2 > beforeRetry ? 'yes' : 'no'));
  out.push('retry-tack=' + (state.soundPending !== null ? 'yes' : 'no'));
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x04]));  /* DISCARDED bit → not completed */
  out.push('kept-on-discard=' + (state.soundPending !== null ? 'yes' : 'no'));
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x01]));  /* completion on the retry → cleared */
  out.push('retried-cleared=' + (state.soundPending === null ? 'yes' : 'no'));
  return JSON.stringify(out);
})()
'''
result = ctx.eval(test_js)

expect = [
    bytes([8, 0, 0x81, 0, 0x11, 0x51, 0, 50]).hex(),        # motor +50
    bytes([8, 0, 0x81, 0, 0x11, 0x51, 0, 226]).hex(),       # motor -30 (s8 0xE2)
    bytes([8, 0, 0x81, 1, 0x11, 0x51, 1, 9]).hex(),         # sound 9 horn
    bytes([8, 0, 0x81, 0x11, 0x11, 0x51, 0, 3]).hex(),      # LED blue
    bytes([0x0A, 0, 0x41, 0x12, 0, 1, 0, 0, 0, 1]).hex(),   # subscribe color
    bytes([5, 0, 1, 6, 5]).hex(),                           # battery request
    bytes([4, 0, 2, 1]).hex(),                              # hub action switch-off
    '1.2.03.0004',                                          # LEGO version encoding (bugfix is BCD)
    'sent=4',                                               # throttled: 4 immediate; phase 2 waits on the toolbar flush
    'sent=4',                                               # unthrottled-phase: pending flush timer still defers

    'sent-after-timer=9',                                   # after timer fires: all flushed
    'timers=0',                                             # no timer left scheduled
    'intervals=1',                                          # keepalive registered
    'keepalive=3',                                          # 3 ticks at speed 42 -> 3 re-sends
    'keepalive-zero=3',                                     # at speed 0 keepalive stays silent
    'intervals-cleared=yes',                                # stop clears the interval
    'sound-timer=yes',                                      # sound click schedules its 250 ms retry
    'sound-cleared=yes',                                    # hub 'completed' feedback cancels retries
    'saw-feedback=true',                                    # 0x82 seen -> hub is feedback-capable
    'fired=1',                                              # one retry tick fired
    'retried=yes',                                          # gated retry enqueued another write
    'retry-tack=yes',                                       # retries stay on until completion
    'kept-on-discard=yes',                                  # 'discarded' not treated as completion
    'retried-cleared=yes',                                  # completion cancels the retry too
]

import json
got = json.loads(result)
fail = False
for i, (e, g) in enumerate(zip(expect, got)):
    ok = e == g
    fail |= not ok
    print(f"{'OK ' if ok else 'FAIL'} [{i:2}] {'match' if ok else f'expected {e} got {g}'}")
print('extra got:', got[len(expect):] if len(got) > len(expect) else '-')
print('RESULT:', 'ALL PASS' if not fail else 'FAILURES')
