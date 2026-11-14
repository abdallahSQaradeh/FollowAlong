const fs = require('fs');
const W = 640, H = 360;
const listeners = {};
function el(id) {
  const h = {};
  return { id, style: {}, dataset: {}, textContent: '', controls: true, paused: true, currentTime: 0, duration: 100, videoWidth: 1920, videoHeight: 1080,
    classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); } },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    addEventListener(t, f) { (h[t] = h[t] || []).push(f); }, fire(t, e) { (h[t] || []).forEach(f => f(Object.assign({ preventDefault() {}, stopPropagation() {}, button: 0 }, e))); },
    play() { this.paused = false; }, pause() { this.paused = true; } };
}
const els = Object.fromEntries(['v', 'stage', 'ov', 'sel', 'zl', 'meta', 'st'].map(i => [i, el(i)]));
const posted = [];
global.window = { FA_CFG: { hint: 't' }, acquireVsCodeApi: () => ({ postMessage: m => posted.push(m) }),
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); } };
global.acquireVsCodeApi = window.acquireVsCodeApi;
global.document = { getElementById: i => els[i], querySelectorAll: () => [], body: el('body') };
global.ResizeObserver = class { constructor(f) { this.f = f; } observe() { this.f(); } };
global.requestAnimationFrame = f => f();
const fireWin = (t, e) => (listeners[t] || []).forEach(f => f(Object.assign({ preventDefault() {} }, e)));
eval(fs.readFileSync('D:/Projects/FollowAlong/prototypes/video-placement/player.js', 'utf8'));
const fa = window.__fa, ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);

// 1. drag a box (not zoomed) => zoom to area
els.ov.fire('mousedown', { clientX: 320, clientY: 180 });
fireWin('mousemove', { clientX: 400, clientY: 225 });
fireWin('mouseup', { clientX: 480, clientY: 270 });
ok(Math.abs(fa.z - 4) < 1e-6, `area 160x90 -> zoom 4x (got ${fa.z})`);
// centre of box (400,225) must land at stage centre (320,180): screen = tx + u*z, u = original 400
ok(Math.abs(fa.tx + 400 * fa.z - 320) < 1e-6 && Math.abs(fa.ty + 225 * fa.z - 180) < 1e-6, `area centred (tx ${fa.tx}, ty ${fa.ty})`);
ok(els.v.style.transform.includes('scale(4)'), 'transform applied: ' + els.v.style.transform);
ok(els.v.controls === false, 'native controls hidden while zoomed');
// 2. drag while zoomed => pan
const tx0 = fa.tx;
els.ov.fire('mousedown', { clientX: 300, clientY: 200 });
fireWin('mousemove', { clientX: 350, clientY: 200 });
fireWin('mouseup', { clientX: 350, clientY: 200 });
ok(Math.abs(fa.tx - (tx0 + 50)) < 1e-6 && fa.z === 4, `pan +50px (tx ${tx0} -> ${fa.tx})`);
// 3. wheel zoom at cursor keeps point under cursor
fa.reset();
const ux = (100 - fa.tx) / fa.z;
els.stage.fire('wheel', { deltaY: -1, clientX: 100, clientY: 100 });
ok(fa.z > 1 && Math.abs((100 - fa.tx) / fa.z - ux) < 1e-6, `wheel zoom ${fa.z.toFixed(2)}x keeps cursor point`);
// 4. host messages
window.addEventListener; fireWin('message', { data: { cmd: 'zoom', by: 0 } });
ok(fa.z === 1, 'host reset -> 1x');
fireWin('message', { data: { cmd: 'area' } });
ok(document.body.classList.s.has('area'), 'host area mode on');
// 5. clamp: zooming out at edge never shows black beyond picture box
fireWin('message', { data: { cmd: 'zoom', by: 3 } });
ok(fa.tx <= 0 && fa.tx >= W * (1 - fa.z), 'pan clamped');
// 6. click (no drag) toggles play after delay; dblclick cancels
fa.reset();
els.ov.fire('mousedown', { clientX: 10, clientY: 10 }); fireWin('mouseup', { clientX: 10, clientY: 10 });
setTimeout(() => {
  ok(els.v.paused === false, 'single click plays');
  els.ov.fire('mousedown', { clientX: 10, clientY: 10 }); fireWin('mouseup', { clientX: 10, clientY: 10 });
  els.ov.fire('dblclick', {});
  setTimeout(() => ok(els.v.paused === false, 'double click does not toggle play'), 300);
}, 300);
