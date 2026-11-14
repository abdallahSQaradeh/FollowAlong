// PROTOTYPE — throwaway player script shared by every variant.
// Zoom model: the <video> gets transform translate(tx,ty) scale(z) inside a clipping .stage.
// A transparent .overlay above the picture catches all mouse input (native controls swallow it otherwise).
//
//   drag (not zoomed)      → draw a rectangle, zoom to fit that area
//   Shift+drag             → draw a new area even while zoomed
//   drag (zoomed)          → pan
//   wheel                  → zoom toward cursor
//   click                  → play / pause
//   double-click           → reset zoom
//   toolbar ＋ − ⬚ ⟲        → same, by mouse
//   messages from host     → {cmd:'zoom', by}, {cmd:'area'}, {cmd:'toggle'}, {cmd:'seek', by}
(function () {
  const vscode = window.__vsc || (window.acquireVsCodeApi ? acquireVsCodeApi() : { postMessage: m => console.log('[host]', m) });
  const cfg = window.FA_CFG || {};
  const $ = id => document.getElementById(id);
  const v = $('v'), stage = $('stage'), ov = $('ov'), sel = $('sel'), zl = $('zl'), meta = $('meta'), st = $('st');

  // ---------- state + reporting
  let z = 1, tx = 0, ty = 0, areaMode = false;
  const MAXZ = 8;

  function report() {
    const r = stage.getBoundingClientRect();
    const ar = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    let w = r.width, h = r.width / ar; if (h > r.height) { h = r.height; w = h * ar; }
    const box = `${Math.round(r.width)}×${Math.round(r.height)} (picture ${Math.round(w * z)}×${Math.round(h * z)} at ${z.toFixed(2)}×)`;
    meta.textContent = `${cfg.hint || ''}  ·  box ${box}`;
    if (st) st.textContent = box;
    vscode.postMessage({ type: 'state', t: v.currentTime, d: v.duration || 0, paused: v.paused, box,
      zoom: { z, fx: r.width ? tx / r.width : 0, fy: r.height ? ty / r.height : 0 } });
  }

  function apply() {
    const r = stage.getBoundingClientRect();
    z = Math.min(MAXZ, Math.max(1, z));
    tx = Math.min(0, Math.max(r.width * (1 - z), tx));
    ty = Math.min(0, Math.max(r.height * (1 - z), ty));
    v.style.transform = `translate(${tx}px,${ty}px) scale(${z})`;
    const zoomed = z > 1.001;
    document.body.classList.toggle('zoomed', zoomed);
    v.controls = !zoomed; // native controls would be magnified too
    document.body.classList.toggle('area', areaMode);
    zl.textContent = zoomed ? `${z.toFixed(2)}×` : '1×';
    report();
  }

  function zoomAt(nz, px, py) {
    nz = Math.min(MAXZ, Math.max(1, nz));
    tx = px - (px - tx) * (nz / z);
    ty = py - (py - ty) * (nz / z);
    z = nz; apply();
  }

  function zoomToRect(x, y, w, h) {
    const r = stage.getBoundingClientRect();
    const nz = Math.min(MAXZ, z * Math.min(r.width / w, r.height / h));
    // centre of the rectangle, in un-transformed video coordinates
    const ux = (x + w / 2 - tx) / z, uy = (y + h / 2 - ty) / z;
    z = nz; tx = r.width / 2 - ux * z; ty = r.height / 2 - uy * z;
    areaMode = false; apply();
  }

  function reset() { z = 1; tx = ty = 0; areaMode = false; apply(); }
  function centre() { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
  function toggle() { v.paused ? v.play() : v.pause(); }
  function focusBack() { setTimeout(() => vscode.postMessage({ type: 'clicked' }), 30); }

  // ---------- mouse on the overlay
  let drag = null, clickT;
  ov.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const mode = (areaMode || e.shiftKey || z <= 1.001) ? 'area' : 'pan';
    drag = { mode, x0: x, y0: y, tx0: tx, ty0: ty, moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (Math.abs(x - drag.x0) + Math.abs(y - drag.y0) > 6) drag.moved = true;
    if (!drag.moved) return;
    if (drag.mode === 'pan') {
      tx = drag.tx0 + (x - drag.x0); ty = drag.ty0 + (y - drag.y0);
      document.body.classList.add('panning'); apply();
    } else {
      sel.style.display = 'block';
      sel.style.left = Math.min(x, drag.x0) + 'px'; sel.style.top = Math.min(y, drag.y0) + 'px';
      sel.style.width = Math.abs(x - drag.x0) + 'px'; sel.style.height = Math.abs(y - drag.y0) + 'px';
    }
  });
  window.addEventListener('mouseup', e => {
    if (!drag) return;
    const d = drag; drag = null;
    document.body.classList.remove('panning');
    sel.style.display = 'none';
    if (!d.moved) { clearTimeout(clickT); clickT = setTimeout(() => { toggle(); focusBack(); }, 250); return; }
    if (d.mode === 'area') {
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const w = Math.abs(x - d.x0), h = Math.abs(y - d.y0);
      if (w > 12 && h > 12) zoomToRect(Math.min(x, d.x0), Math.min(y, d.y0), w, h);
    }
    focusBack();
  });
  ov.addEventListener('dblclick', e => { e.preventDefault(); clearTimeout(clickT); reset(); focusBack(); });
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { areaMode = false; apply(); } });

  // ---------- toolbar + side buttons
  document.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const a = b.dataset.a;
    if (a === 'in') zoomAt(z * 1.25, ...centre());
    if (a === 'out') zoomAt(z / 1.25, ...centre());
    if (a === 'area') { areaMode = !areaMode; apply(); return; } // keep focus here for the drag
    if (a === 'reset') reset();
    if (a === 'toggle') toggle();
    if (a === 'back') v.currentTime -= 5;
    if (a === 'fwd') v.currentTime += 5;
    if (a === 'pip') { v.requestPictureInPicture().catch(err => meta.textContent = 'PiP failed: ' + err.message); return; }
    focusBack();
  }));
  document.querySelectorAll('.tools,.side').forEach(el => el.addEventListener('mousedown', e => e.stopPropagation()));

  // ---------- host messages
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.cmd === 'toggle') toggle();
    if (m.cmd === 'seek') v.currentTime = Math.max(0, v.currentTime + m.by);
    if (m.cmd === 'zoom') { if (m.by) zoomAt(z * m.by, ...centre()); else reset(); }
    if (m.cmd === 'area') { areaMode = true; apply(); }
  });

  ['timeupdate', 'play', 'pause', 'loadedmetadata'].forEach(ev => v.addEventListener(ev, report));
  new ResizeObserver(apply).observe(stage);

  // restore the zoom carried over from the previous variant (normalised to stage size)
  if (cfg.zoom && cfg.zoom.z > 1) {
    requestAnimationFrame(() => {
      const r = stage.getBoundingClientRect();
      z = cfg.zoom.z; tx = cfg.zoom.fx * r.width; ty = cfg.zoom.fy * r.height; apply();
    });
  }
  if (cfg.time) v.addEventListener('loadedmetadata', () => { v.currentTime = cfg.time; }, { once: true });
  vscode.postMessage({ type: 'ready', stage: stage.getBoundingClientRect().height });
  window.__fa = { get z() { return z; }, get tx() { return tx; }, get ty() { return ty; }, zoomToRect, zoomAt, reset }; // for testing
})();
