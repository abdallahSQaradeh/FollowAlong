// PROTOTYPE — throwaway. Answers the wayfinder ticket "Where the video sits":
// where does the Lesson video live in the VS Code window, and can the learner
// resize / collapse / zoom it with the mouse?
//
// Five variants, switched from the status bar (‹ label ›) or Ctrl+' [ / Ctrl+' ]:
//   A  Editor split      — video in an editor group beside the code
//   B  Bottom panel      — video as a tab in the panel, next to the terminal
//   C  Secondary sidebar — video in the right-hand auxiliary bar
//   D  Mini strip        — a short editor group above the code
//   E  Floating window   — the video editor moved into its own always-on-top VS Code window
//
// The player (zoom to area, pan, wheel zoom) lives in player.js / player.css and is
// inlined into every variant's webview. No persistence, minimal error handling.
// MP4 audio is silent in VS Code webviews (see ticket "Can VS Code play the Course videos?").

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const BUILD = 5;

const VARIANTS = [
  { key: 'A', name: 'Editor split', hint: 'Drag the sash between the editor groups. Ctrl+\' V shrinks/restores the video group.' },
  { key: 'B', name: 'Bottom panel', hint: 'Drag the panel\'s top edge. Ctrl+\' V (or Ctrl+J) hides the panel — the terminal goes with it.' },
  { key: 'C', name: 'Secondary sidebar', hint: 'Drag the sidebar\'s left edge. Ctrl+\' V (or Ctrl+Alt+B) hides it.' },
  { key: 'D', name: 'Mini strip', hint: 'Drag the sash under the strip. Ctrl+\' V shrinks/restores it.' },
  { key: 'E', name: 'Floating window', hint: 'A separate always-on-top OS window. Clicking it moves focus out of the main window.' },
];

const DEFAULT_VIDEO = (() => {
  const dir = 'D:/Learning/Courses/Learn to Build Machine Learning Systems That Don\'t Suck/sv-mlthatds';
  const f = path.join(dir, '001 - Lesson 1 - Getting Started.mp4');
  return fs.existsSync(f) ? f : undefined;
})();

let ctx;
let current = 0;
let videoPath = DEFAULT_VIDEO;
let editorPanel;            // WebviewPanel used by A, D, E
const views = {};           // WebviewView for B and C, keyed by view id
let collapsed = false;
let lastState = { t: 0, d: 0, paused: true, box: '', zoom: undefined };
const status = {};
let out;

function log(s) {
  out = out || vscode.window.createOutputChannel('FollowAlong Prototype');
  out.appendLine(`${new Date().toLocaleTimeString()} ${s}`);
}

function activate(context) {
  ctx = context;
  log(`activated, build ${BUILD}`);

  for (const id of ['faProto.panelView', 'faProto.auxView']) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(id, {
      resolveWebviewView(view) {
        views[id] = view;
        setupWebview(view.webview, id === 'faProto.panelView' ? 'B' : 'C');
        view.onDidDispose(() => { delete views[id]; });
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }));
  }

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('faProto.next', () => switchTo((current + 1) % VARIANTS.length));
  reg('faProto.prev', () => switchTo((current + VARIANTS.length - 1) % VARIANTS.length));
  reg('faProto.pick', async () => {
    const pick = await vscode.window.showQuickPick(VARIANTS.map((v, i) => ({ label: `${v.key}  ${v.name}`, description: v.hint, i })));
    if (pick) switchTo(pick.i);
  });
  reg('faProto.pickVideo', async () => {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Video: ['mp4', 'webm'] }, defaultUri: vscode.Uri.file('D:/Learning/Courses') });
    if (!uris) return;
    videoPath = uris[0].fsPath;
    lastState = { t: 0, d: 0, paused: true, box: '', zoom: undefined };
    switchTo(current);
  });
  reg('faProto.togglePlay', () => post({ cmd: 'toggle' }));
  reg('faProto.back', () => post({ cmd: 'seek', by: -5 }));
  reg('faProto.forward', () => post({ cmd: 'seek', by: 5 }));
  reg('faProto.collapse', () => toggleCollapse());
  reg('faProto.zoomIn', () => post({ cmd: 'zoom', by: 1.25 }));
  reg('faProto.zoomOut', () => post({ cmd: 'zoom', by: 0.8 }));
  reg('faProto.zoomReset', () => post({ cmd: 'zoom', by: 0 }));
  reg('faProto.zoomArea', () => post({ cmd: 'area' }));

  // Floating switcher, visually distinct from the "real" status bar controls.
  const mk = (text, cmd, prio, tip) => {
    const s = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, prio);
    s.text = text; s.command = cmd; s.tooltip = tip;
    s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    s.show(); context.subscriptions.push(s); return s;
  };
  status.prev = mk('$(arrow-left)', 'faProto.prev', 1003, 'Previous variant (Ctrl+\' [)');
  status.label = mk('', 'faProto.pick', 1002, 'Pick variant');
  status.next = mk('$(arrow-right)', 'faProto.next', 1001, 'Next variant (Ctrl+\' ])');

  // "Real" mouse controls from the Controls decision, to judge the whole layout.
  const mkR = (cmd, prio) => {
    const s = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prio);
    s.command = cmd; s.show(); context.subscriptions.push(s); return s;
  };
  status.back = mkR('faProto.back', 103); status.back.text = '$(debug-step-back) 5s';
  status.play = mkR('faProto.togglePlay', 102);
  status.time = mkR(undefined, 101);
  status.zoom = mkR('faProto.zoomReset', 100);
  status.zoom.tooltip = 'Zoom (click to reset). Drag a box on the video to zoom to an area.';
  renderStatus();

  if (!videoPath) {
    vscode.window.showWarningMessage('FollowAlong prototype: default Lesson not found — pick one.', 'Pick video')
      .then(c => c && vscode.commands.executeCommand('faProto.pickVideo'));
  }
  switchTo(0);
}

async function switchTo(i) {
  current = i;
  collapsed = false;
  renderStatus();
  await teardown();
  const v = VARIANTS[i];
  const codeDoc = vscode.window.visibleTextEditors[0]?.document;

  if (v.key === 'A') {
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 0.62 }, { size: 0.38 }] });
    openEditorPanel(vscode.ViewColumn.Two, 'A');
    if (codeDoc) await vscode.window.showTextDocument(codeDoc, vscode.ViewColumn.One);
  } else if (v.key === 'D') {
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 1, groups: [{ size: 0.26 }, { size: 0.74 }] });
    openEditorPanel(vscode.ViewColumn.One, 'D');
    if (codeDoc) await vscode.window.showTextDocument(codeDoc, vscode.ViewColumn.Two);
  } else if (v.key === 'B') {
    await vscode.commands.executeCommand('workbench.view.extension.faProtoPanel');
    refreshView('faProto.panelView', 'B');
  } else if (v.key === 'C') {
    await vscode.commands.executeCommand('workbench.view.extension.faProtoAux');
    refreshView('faProto.auxView', 'C');
  } else if (v.key === 'E') {
    openEditorPanel(vscode.ViewColumn.Active, 'E', false);
    await waitUntil(() => editorPanel && editorPanel.active);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    await sleep(600);
    // The floating window now has focus: make it compact and pin it above the main window.
    await vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow').then(undefined, e => log('compact: ' + e));
    await vscode.commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop').then(undefined, e => log('on top: ' + e));
    vscode.window.showInformationMessage('Variant E: the video is in a floating, always-on-top window. Click back into the main window to type.');
    return; // don't steal focus back here, or the main window covers the floating one
  }
  returnFocus();
}

async function teardown() {
  if (editorPanel) { const p = editorPanel; editorPanel = undefined; p.dispose(); }
  for (const id of Object.keys(views)) views[id].webview.html = '<body></body>';
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  // Back to a single editor group so each variant starts from the same layout.
  await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{}] });
}

function openEditorPanel(column, key, preserveFocus = true) {
  const p = vscode.window.createWebviewPanel('faProto.editor', 'Lesson', { viewColumn: column, preserveFocus }, webviewOpts());
  editorPanel = p;
  p.onDidDispose(() => { if (editorPanel === p) editorPanel = undefined; });
  setupWebview(p.webview, key);
}

function refreshView(id, key) {
  const v = views[id];
  if (v) { setupWebview(v.webview, key); v.show(true); }
  // If not resolved yet, resolveWebviewView will set it up.
}

function webviewOpts() {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: videoPath ? [vscode.Uri.file(path.dirname(videoPath))] : [],
  };
}

function setupWebview(webview, key) {
  webview.options = webviewOpts();
  const variant = VARIANTS.find(v => v.key === key);
  const src = videoPath ? webview.asWebviewUri(vscode.Uri.file(videoPath)).toString() : '';
  // Inline the player, read fresh each time, so nothing depends on webview resource loading.
  const read = f => fs.readFileSync(path.join(ctx.extensionPath, f), 'utf8');
  // Carry time + zoom over from the previous variant, so the same area can be judged at each size.
  const cfg = { hint: variant.hint, zoom: lastState.zoom, time: lastState.t };
  webview.html = html({ src, variant, name: path.basename(videoPath || 'no video'), css: read('player.css'), js: read('player.js'), cfg });
  webview.onDidReceiveMessage(m => {
    if (m.type === 'state') { lastState = m; renderStatus(); }
    if (m.type === 'clicked') returnFocus();
    if (m.type === 'ready') log(`[${key}] player ready, stage height ${Math.round(m.stage)}px`);
    if (m.type === 'error') {
      log(`[${key}] ERROR ${m.msg}`);
      vscode.window.showErrorMessage('FollowAlong prototype player error: ' + m.msg);
    }
  });
}

function post(msg) {
  if (editorPanel) editorPanel.webview.postMessage(msg);
  for (const id of Object.keys(views)) views[id].webview.postMessage(msg);
}

async function toggleCollapse() {
  const key = VARIANTS[current].key;
  collapsed = !collapsed;
  if (key === 'A') {
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: collapsed ? [{ size: 0.92 }, { size: 0.08 }] : [{ size: 0.62 }, { size: 0.38 }] });
  } else if (key === 'D') {
    await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 1, groups: collapsed ? [{ size: 0.06 }, { size: 0.94 }] : [{ size: 0.26 }, { size: 0.74 }] });
  } else if (key === 'B') {
    await vscode.commands.executeCommand('workbench.action.togglePanel');
  } else if (key === 'C') {
    await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
  }
  returnFocus();
}

function returnFocus() {
  // Per the Controls decision: the player never keeps focus.
  const key = VARIANTS[current].key;
  if (key === 'E') return;
  if (key === 'D') vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
  else vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(50);
}

function fmt(s) { s = Math.floor(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function renderStatus() {
  const v = VARIANTS[current];
  status.label.text = `PROTOTYPE  ${v.key} (${v.name})`;
  status.label.tooltip = v.hint;
  status.play.text = lastState.paused ? '$(play)' : '$(debug-pause)';
  status.time.text = `${fmt(lastState.t)} / ${fmt(lastState.d)}`;
  status.time.tooltip = `video box ${lastState.box}`;
  const z = lastState.zoom && lastState.zoom.z;
  status.zoom.text = z > 1.001 ? `$(zoom-in) ${z.toFixed(1)}×` : '$(zoom-in) 1×';
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const inlineScript = s => s.replace(/<\/script/gi, '<\\/script');

function html({ src, variant, name, css, js, cfg }) {
  return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
<script>
  window.__vsc = acquireVsCodeApi();
  window.onerror = (m, s, l, c) => window.__vsc.postMessage({ type: 'error', msg: m + ' @' + l + ':' + c });
</script>
</head><body>
<div class="wrap ${variant.key === 'D' ? 'strip' : ''}">
  <div class="stage" id="stage">
    <video id="v" src="${esc(src)}" controls muted></video>
    <div class="overlay" id="ov"></div>
    <div class="sel" id="sel"></div>
    <div class="badge">PROTOTYPE · ${variant.key} ${esc(variant.name)} · build ${BUILD}</div>
    <div class="tools">
      <span class="zl" id="zl">1×</span>
      <button data-a="out" title="Zoom out (Ctrl+' -)">−</button>
      <button data-a="in" title="Zoom in (Ctrl+' =)">＋</button>
      <button data-a="area" title="Zoom to area: drag a box (Ctrl+' Z)">⬚ area</button>
      <button data-a="reset" title="Reset zoom (Ctrl+' 0, or double-click)">⟲</button>
    </div>
    <div class="meta" id="meta"></div>
  </div>
  <div class="side">
    <div style="font-weight:600;margin-bottom:4px">${esc(name)}</div>
    <div id="st"></div>
    <div><button data-a="back">−5s</button><button data-a="toggle">▶/❚❚</button><button data-a="fwd">+5s</button></div>
    <div><button data-a="pip">Pop out (PiP)</button></div>
  </div>
</div>
<script>window.FA_CFG = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};</script>
<script>${inlineScript(js)}</script>
</body></html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
