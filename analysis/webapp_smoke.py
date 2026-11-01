"""Smoke test for the DUPLO Train web control.

Runs control/app.js under QuickJS with a tiny DOM stub and checks:
  * LWP3 command bytes,
  * the SendThrottler window,
  * the 100 ms motor keepalive,
  * sound retry / feedback gating.

Run with:
    pip install quickjs
    python analysis/webapp_smoke.py
"""

import json
from pathlib import Path

import quickjs

ROOT = Path(__file__).resolve().parent.parent / "control"

stubs = r"""
var __els = {};
function __mkEl(id) {
  return {
    id: id, textContent: '', innerHTML: '', value: '0', checked: false, disabled: false,
    className: '', dataset: {}, style: {}, __h: {},
    addEventListener: function (t, cb) { (this.__h[t] = this.__h[t] || []).push(cb); },
    dispatchEvent: function () { return true; },
    appendChild: function () {}, querySelectorAll: function () { return []; },
    classList: {
      add: function () {}, remove: function () {},
      toggle: function () {}, contains: function () { return false; },
    },
    setAttribute: function () {},
    scrollTop: 0, scrollHeight: 0,
  };
}
var document = {
  getElementById: function (id) { if (!__els[id]) __els[id] = __mkEl(id); return __els[id]; },
  createElement: function () { return __mkEl(); },
  addEventListener: function () {},
  hidden: false,
};
var window = { __hooks: {}, addEventListener: function (t, cb) { window.__hooks[t] = cb; } };
var navigator = {};
var localStorage = { getItem: function () { return null; }, setItem: function () {} };
/* deterministic clock: the 80 ms throttler window must not expire by accident */
var __now = 1000;
var performance = { now: function () { return __now; } };
/* stub timers collect (fn, ms, id) so tests can fire them manually */
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
"""

src = (ROOT / "app.js").read_text(encoding="utf-8")

ctx = quickjs.Context()
ctx.eval(stubs)
ctx.eval(src)                                       # full top-level execution
ctx.eval('window.__hooks["DOMContentLoaded"]()')    # bootstrap exactly like a page load


def drain_jobs(ctx, limit=10000):
    """Run QuickJS microtasks until the async test body has settled."""
    for _ in range(limit):
        if not ctx.execute_pending_job():
            return
    raise RuntimeError("pending QuickJS jobs did not settle")


test_js = r"""
(async function () {
  const h = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = [];
  const flush = async (n = 60) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

  /* ---- protocol command builders ---- */
  out.push(h(cmdMotor(50)));
  out.push(h(cmdMotor(-30)));
  out.push(h(cmdSound(9)));
  out.push(h(cmdLed(3)));
  out.push(h(cmdSubscribe(0x12, 0, 1, true)));
  out.push(h(cmdHubPropRequest(6)));
  out.push(h(cmdHubAction(0x01)));
  out.push(verString(0x12030004));

  /* ---- throttler windowing: 4 packets / 80 ms ---- */
  let sent = 0;
  throttler.packetsPerWindow = 4; throttler.windowMillis = 80;
  throttler.writeCharacteristic = async () => { sent++; };
  for (let i = 0; i < 6; i++) throttler.enqueue(lwp3Build(0x02, [0x01]));
  await flush();
  out.push('sent=' + sent);

  throttler.packetsPerWindow = 64; throttler.windowMillis = 0;
  for (let j = 0; j < 3; j++) throttler.enqueue(lwp3Build(0x02, [0x01]));
  await flush();
  out.push('sent=' + sent);                       /* timer still holds the queue */
  fireTimers();                                   /* emulate the window timer */
  await flush();
  out.push('sent-after-timer=' + sent);
  out.push('timers=' + __timers.length);

  /* ---- motor keepalive: re-send while speed != 0 ---- */
  startMotorKeepalive();
  out.push('intervals=' + __intervals.length);
  state.desiredSpeed = 42;
  state.connected = true;
  state.characteristic = {};
  let keepSent = 0;
  throttler.writeCharacteristic = async () => { keepSent++; };
  const keepaliveTick = __intervals[__intervals.length - 1][0];
  for (let k = 0; k < 3; k++) { keepaliveTick(); await flush(); }
  out.push('keepalive=' + keepSent);
  state.desiredSpeed = 0;
  keepaliveTick();
  await flush();
  out.push('keepalive-zero=' + keepSent);
  stopMotorKeepalive();
  out.push('intervals-cleared=' + (state.keepalive === null ? 'yes' : 'no'));

  /* ---- sound retry book-keeping and 0x82 feedback gating ---- */
  let s2 = 0;
  throttler.writeCharacteristic = async () => { s2++; };
  state.connected = true;
  state.characteristic = {};
  state.sawFeedback = false;
  state.soundPending = null;
  playSoundReliable(9);
  await flush();
  out.push('sound-timer=' + (__timers.some((t) => t[1] === 350) ? 'yes' : 'no'));
  out.push('sound-writes=' + s2);
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x01]));  /* completed -> cancel */
  await flush();
  out.push('sound-cleared=' + (state.soundPending === null ? 'yes' : 'no'));
  out.push('saw-feedback=' + state.sawFeedback);

  playSoundReliable(5);                                     /* feedback-capable hub */
  await flush();
  const beforeRetry = s2;
  let fired = 0;
  for (let q = __timers.length - 1; q >= 0; q--) {
    if (__timers[q][1] === 250) { __timers.splice(q, 1)[0][0](); fired++; }
  }
  await flush();
  out.push('fired=' + fired);
  out.push('retried=' + (s2 > beforeRetry ? 'yes' : 'no'));
  out.push('retry-tack=' + (state.soundPending !== null ? 'yes' : 'no'));
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x04]));  /* DISCARDED != done */
  out.push('kept-on-discard=' + (state.soundPending !== null ? 'yes' : 'no'));
  decodeFeedback(new Uint8Array([5, 0, 0x82, 0x01, 0x01]));  /* completion clears */
  out.push('retried-cleared=' + (state.soundPending === null ? 'yes' : 'no'));

  /* ---- basic light toggle keeps the last real colour ---- */
  let lightWrites = 0;
  throttler.writeCharacteristic = async () => { lightWrites++; };
  state.connected = true;
  state.characteristic = {};
  state.lightOn = false;
  state.lightColor = 10;
  toggleLight(); await flush();
  out.push('light-on=' + state.lightOn + ':' + state.lightColor);
  toggleLight(); await flush();
  out.push('light-off=' + state.lightOn + ':' + state.lightColor);
  setLed(3); await flush();
  out.push('light-blue=' + state.lightOn + ':' + state.lightColor);
  toggleLight(); await flush();
  out.push('light-off-blue=' + state.lightOn + ':' + state.lightColor);
  toggleLight(); await flush();
  out.push('light-reuse=' + state.lightOn + ':' + state.lightColor);
  out.push('light-writes=' + lightWrites);

  __testResult = JSON.stringify(out);
})().catch((error) => { __testError = String((error && error.stack) || error); });
"""

ctx.eval(test_js)
drain_jobs(ctx)

error = ctx.get("__testError")
if error:
    raise SystemExit(f"JS test failed:\n{error}")

result = ctx.get("__testResult")
if not result:
    raise SystemExit("JS test produced no result")

expect = [
    bytes([8, 0, 0x81, 0, 0x11, 0x51, 0, 50]).hex(),        # motor +50
    bytes([8, 0, 0x81, 0, 0x11, 0x51, 0, 226]).hex(),       # motor -30 (s8 0xE2)
    bytes([8, 0, 0x81, 1, 0x11, 0x51, 1, 9]).hex(),         # sound 9 horn
    bytes([8, 0, 0x81, 0x11, 0x11, 0x51, 0, 3]).hex(),      # LED blue
    bytes([0x0A, 0, 0x41, 0x12, 0, 1, 0, 0, 0, 1]).hex(),   # subscribe colour
    bytes([5, 0, 1, 6, 5]).hex(),                           # battery request
    bytes([4, 0, 2, 1]).hex(),                              # hub action switch-off
    "1.2.03.0004",                                          # LEGO version encoding
    "sent=4",                                               # 4 writes fit the window
    "sent=4",                                               # pending flush timer still defers
    "sent-after-timer=9",                                   # timer flush drains everything
    "timers=0",                                             # no timer left scheduled
    "intervals=1",                                          # keepalive registered
    "keepalive=3",                                          # 3 ticks -> 3 re-sends
    "keepalive-zero=3",                                     # speed 0 -> silent
    "intervals-cleared=yes",                                # stop clears the interval
    "sound-timer=yes",                                      # 350 ms retry for feedback-less hub
    "sound-writes=1",                                       # initial sound write
    "sound-cleared=yes",                                    # completed feedback cancels retries
    "saw-feedback=true",                                    # 0x82 seen -> ack-based retries
    "fired=1",                                              # exactly one retry tick
    "retried=yes",                                          # gated retry enqueued a write
    "retry-tack=yes",                                       # retries stay until completion
    "kept-on-discard=yes",                                  # DISCARDED is not completion
    "retried-cleared=yes",                                  # completion cancels the retry
    "light-on=true:10",                                     # default colour is white
    "light-off=false:10",                                   # off keeps the last colour
    "light-blue=true:3",                                    # palette feeds the toggle
    "light-off-blue=false:3",                               # off after blue
    "light-reuse=true:3",                                   # toggle reuses blue
    "light-writes=5",                                       # one LED write per action
]

got = json.loads(result)
fail = False
for i, (expected, actual) in enumerate(zip(expect, got)):
    ok = expected == actual
    fail |= not ok
    print(f"{'OK  ' if ok else 'FAIL'} [{i:2}] " + ("match" if ok else f"expected {expected!r} got {actual!r}"))
print("extra got:", got[len(expect):] if len(got) > len(expect) else "-")
print("RESULT:", "ALL PASS" if not fail else "FAILURES")
raise SystemExit(1 if fail else 0)
