const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = [];
const results = [];
const measurements = [];
app.commandLine.appendSwitch('site-per-process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-automation-options-')));
const reportPath = process.env.AUTOMATION_TEST_REPORT || path.join(app.getPath('userData'), 'results.json');
const focusPath = path.join(app.getPath('userData'), 'foreground.json');
let monitor;
let win;
let wc;
let origin;
let finishing = false;

const fixture = `<style>
html,body{margin:0;background:rgb(12,34,56);color:white}
input,button{display:block;width:180px;height:30px;margin:8px}
iframe{width:240px;height:140px;border:0}
canvas{position:fixed;left:400px;top:220px;width:32px;height:32px}
</style><input id="input" aria-label="Main input"><button id="button">Action</button>
<canvas id="paint" width="32" height="32"></canvas><script>
window.events=[];window.framesPainted=0;
for(const type of ['mousedown','mouseup','click','keydown','keyup','input']) {
  document.addEventListener(type,e=>events.push({type,id:e.target.id,key:e.key,buttons:e.buttons,trusted:e.isTrusted}));
}
const context=document.querySelector('#paint').getContext('2d');
function draw(){framesPainted++;context.fillStyle='rgb('+((framesPainted*23)%256)+','+((framesPainted*7)%256)+',100)';context.fillRect(0,0,32,32);requestAnimationFrame(draw)}
requestAnimationFrame(draw);
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fixture + (req.url.startsWith('/child') ? '' : `<iframe src="http://localhost:${server.address().port}/child"></iframe>`));
});

async function until(predicate, description, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}
async function check(name, fn) {
  let timer;
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Acceptance case timed out')), 18000); })
    ]);
    results.push({ name, ok: true, elapsedMs: Date.now() - started });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, elapsedMs: Date.now() - started, error: error.stack || String(error) });
    console.error('FAIL', name, error);
  } finally {
    clearTimeout(timer);
    for (const window of windows) {
      if (!window.isDestroyed()) {
        try { await window.webContents.resetAutomationOptions(); } catch (error) {
          const result = results.at(-1);
          result.ok = false;
          result.cleanupError = error.stack || String(error);
          console.error('FAIL cleanup', name, error);
        }
      }
    }
  }
}
async function createWindow() {
  const window = new BrowserWindow({
    show: false, frame: false, x: 130, y: 100, width: 720, height: 520,
    webPreferences: { sandbox: true }
  });
  windows.push(window);
  await window.loadURL(origin);
  return window;
}
const inspect = (source, contents = wc) => contents.executeJavaScript(source);
async function target(contents = wc, child = false) {
  const snapshot = await contents.getAgentSnapshot({ maxNodes: 100 });
  const element = snapshot.elements.find((item) => item.name === 'Main input' &&
    (child ? item.target.processId !== contents.mainFrame.processId :
      item.target.processId === contents.mainFrame.processId && item.target.routingId === contents.mainFrame.routingId));
  assert.ok(element, `Missing ${child ? 'child' : 'main'} input: ${JSON.stringify(snapshot.frames)}`);
  return element.target;
}
function options(state = wc.getAutomationState()) {
  return {
    isolateInput: state.isolateInput,
    blockRealPointer: state.blockRealPointer,
    blockRealKeyboard: state.blockRealKeyboard,
    keepRendering: state.keepRendering,
    virtualCursor: {
      enabled: state.virtualCursor.enabled,
      frameRate: state.virtualCursor.frameRate,
      hotspot: state.virtualCursor.hotspot,
      customImage: state.virtualCursor.customImage
    }
  };
}
const isolated = {
  isolateInput: true, blockRealPointer: true, blockRealKeyboard: true,
  keepRendering: true, virtualCursor: { enabled: false }
};
const mouse = (type, atMs = 0, extra = {}) => ({ kind: 'mouse', type, atMs, position: { x: 300, y: 120 }, ...extra });
const key = (type, atMs = 0, extra = {}) => ({ kind: 'key', type, atMs, ...extra });
async function completed(contents, steps) {
  const result = await contents.dispatchInputSequence(steps);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.dispatchedCount, steps.length);
  return result;
}
async function native(action, x = 0, y = 0) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
  // Validate ownership before invoking the shared helper. All posted input is
  // confined to this BrowserWindow's HWND; no global SendInput is used.
  const guard = `import ctypes,runpy,sys
from ctypes import wintypes
script,action,hwnd,x,y,expected=sys.argv[1:]
user=ctypes.WinDLL('user32',use_last_error=True)
user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
pid=wintypes.DWORD()
user.GetWindowThreadProcessId(wintypes.HWND(int(hwnd)),ctypes.byref(pid))
if pid.value!=int(expected): raise RuntimeError('Native input HWND does not belong to test process')
sys.argv=[script,action,hwnd,x,y]
runpy.run_path(script,run_name='__main__')`;
  await run(process.env.AGENT_PYTHON || 'python', ['-c', guard,
    path.join(__dirname, 'input-sequence-native-win.py'), action, hwnd, String(x), String(y), String(process.pid)
  ], { windowsHide: true, timeout: 4000 });
  await delay(100);
}
async function startMonitor() {
  assert.equal(process.platform, 'win32', 'This acceptance suite targets the Windows build');
  monitor = spawn(process.env.AGENT_PYTHON || 'python', [
    path.join(__dirname, 'agent-foreground-monitor.py'), String(process.pid), focusPath
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  let stderr = '';
  monitor.on('error', (error) => { launchError = error; });
  monitor.stderr.on('data', (chunk) => { stderr += chunk; });
  await until(() => {
    if (launchError) throw launchError;
    if (monitor.exitCode !== null) throw new Error(`Foreground monitor exited: ${stderr}`);
    return fs.existsSync(focusPath) && JSON.parse(fs.readFileSync(focusPath, 'utf8')).ready;
  }, 'foreground monitor ready', 5000);
}
async function systemInputSnapshot() {
  const { stdout } = await run(process.env.AGENT_PYTHON || 'python', [
    path.join(__dirname, 'agent-input-activity-win.py')
  ], { windowsHide: true, timeout: 4000 });
  return JSON.parse(stdout);
}
function assertNoActivation() {
  for (const window of windows) {
    if (!window.isDestroyed()) assert.equal(window.isFocused(), false, 'Test window obtained system focus');
  }
  const sample = JSON.parse(fs.readFileSync(focusPath, 'utf8'));
  assert.equal(sample.activations.length, 0, `Unexpected foreground activation: ${JSON.stringify(sample.activations)}`);
}
async function verifyBackgroundFrames(mode, contents = wc) {
  const before = await inspect('framesPainted', contents);
  // Establish continued RAF delivery before any screenshot can wake rendering.
  await delay(360);
  const withoutCapture = await inspect('framesPainted', contents);
  assert.ok(withoutCapture - before >= 2, `${mode}: RAF stopped before capture (${before} -> ${withoutCapture})`);
  const first = await contents.capturePage({ x: 400, y: 220, width: 16, height: 16 });
  assert.equal(first.isEmpty(), false, `${mode}: empty capture`);
  await delay(220);
  const after = await inspect('framesPainted', contents);
  assert.ok(after - withoutCapture >= 2, `${mode}: RAF did not continue`);
  const second = await contents.capturePage({ x: 400, y: 220, width: 16, height: 16 });
  assert.notDeepEqual(first.toBitmap(), second.toBitmap(), `${mode}: captured pixels stayed stale`);
  measurements.push({ mode, before, withoutCapture, after, rendering: contents.getAutomationState().rendering });
}

async function finish(error) {
  if (finishing) return;
  finishing = true;
  if (error) results.push({ name: 'suite infrastructure', ok: false, error: error.stack || String(error) });
  const report = {
    platform: process.platform, versions: process.versions, pid: process.pid,
    focusMonitorScope: 'Automation cases after the deliberate native-click reachability baseline',
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length, results, measurements
  };
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (fs.existsSync(focusPath)) fs.copyFileSync(focusPath, reportPath + '.focus.json');
  } catch (writeError) { console.error(writeError); report.failed++; }
  monitor?.kill();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server.close();
  console.log(`${report.passed} passed; ${report.failed} failed; report: ${reportPath}`);
  app.exit(report.failed ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('Suite watchdog exceeded 150 seconds')), 150000);
watchdog.unref();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  win = await createWindow();
  wc = win.webContents;

  await check('public surface removes replaced APIs and retains cursor setters', async () => {
    for (const name of ['setAutomationOptions', 'getAutomationState', 'resetAutomationOptions',
      'setVirtualCursorImage', 'setVirtualCursorFrameRate', 'dispatchInputSequence', 'clickElement']) {
      assert.equal(typeof wc[name], 'function', name);
    }
    assert.equal(typeof wc.setVirtualCursorEnabled, 'undefined');
    assert.equal(typeof wc.clickSelector, 'undefined');
    assert.deepEqual(options(), {
      isolateInput: false, blockRealPointer: false, blockRealKeyboard: false, keepRendering: false,
      virtualCursor: { enabled: false, frameRate: 0, hotspot: { x: 0, y: 0 }, customImage: false }
    });
  });

  await check('nested configuration and standalone cursor setters share incremental state', async () => {
    const pixels = Buffer.alloc(8 * 8 * 4, 255);
    const image = nativeImage.createFromBitmap(pixels, { width: 8, height: 8 });
    await wc.setAutomationOptions({ ...isolated, virtualCursor: { enabled: true, image, hotspot: { x: 2, y: 3 }, frameRate: 30 } });
    await wc.setAutomationOptions({ virtualCursor: { enabled: false } });
    let state = options();
    assert.equal(state.isolateInput, true);
    assert.equal(state.blockRealPointer, true);
    assert.equal(state.blockRealKeyboard, true);
    assert.equal(state.keepRendering, true);
    assert.deepEqual(state.virtualCursor, { enabled: false, frameRate: 30, hotspot: { x: 2, y: 3 }, customImage: true });
    wc.setVirtualCursorFrameRate(15);
    wc.setVirtualCursorImage(null);
    state = options();
    assert.deepEqual(state.virtualCursor, { enabled: false, frameRate: 15, hotspot: { x: 0, y: 0 }, customImage: false });
    await wc.setAutomationOptions({ blockRealPointer: false });
    assert.equal(options().blockRealPointer, false);
    assert.equal(options().blockRealKeyboard, true);
  });

  await check('configuration validation is atomic and pending raw updates cannot undo reset', async () => {
    await wc.setAutomationOptions(isolated);
    const before = options();
    for (const invalid of [
      { keepRendering: false, unknownOption: true },
      { blockRealPointer: false, isolateInput: 'true' },
      { keepRendering: false, virtualCursor: { enabled: true, frameRate: -1 } },
      { keepRendering: false, virtualCursor: { enabled: true, unknownOption: true } },
      { keepRendering: false, virtualCursor: { image: nativeImage.createEmpty() } },
      { keepRendering: false, virtualCursor: { image: null, hotspot: { x: -1, y: 0 } } }
    ]) {
      await assert.rejects(wc.setAutomationOptions(invalid));
      assert.deepEqual(options(), before);
    }
    // Keep the renderer's input barrier pending while reset invalidates an
    // already applied native update. Its old callback must not restore flags.
    const blocked = inspect('(()=>{const end=performance.now()+350;while(performance.now()<end){};return true})()');
    await delay(30);
    const pending = wc._setAutomationOptions({ blockRealPointer: false, keepRendering: false })
      .then(() => ({ ok: true }), (error) => ({ ok: false, reason: String(error) }));
    await wc.resetAutomationOptions();
    await blocked;
    const outcome = await pending;
    assert.equal(outcome.ok, false, 'Pending native update was not superseded by reset');
    assert.match(outcome.reason, /SUPERSEDED|RESET/);
    await delay(80);
    const reset = options();
    for (const name of ['isolateInput', 'blockRealPointer', 'blockRealKeyboard', 'keepRendering']) {
      assert.equal(reset[name], false, `Old native callback restored ${name}`);
    }
    assert.equal(reset.virtualCursor.enabled, false);
  });

  await check('cursor display off still gates reachable native pointer and keyboard input', async () => {
    // Ordinary native clicks may activate the HWND. Establish actual keyboard
    // reachability here, then begin the no-activation monitor for automation.
    win.showInactive();
    await wc.setAutomationOptions({ isolateInput: true, keepRendering: true });
    await completed(wc, [key('char', 0, { target: await target(), text: 'I' })]);
    let callbacks = 0;
    const listener = () => { callbacks++; };
    wc.on('before-input-event', listener);
    try {
      await inspect('events.length=0');
      await native('mouse', 60, 62);
      assert.ok((await inspect("events.filter(e=>e.type==='mousedown').length")) > 0, 'Native pointer baseline did not reach page');
      await native('key');
      assert.ok(callbacks > 0, 'Native keyboard baseline did not reach WebContents');
      await wc.setAutomationOptions({ blockRealPointer: true, blockRealKeyboard: true, virtualCursor: { enabled: false } });
      callbacks = 0;
      await inspect('events.length=0');
      const value = await inspect("document.querySelector('#input').value");
      await native('mouse', 60, 62);
      await native('key');
      assert.equal(callbacks, 0);
      assert.equal(await inspect('events.length'), 0);
      assert.equal(await inspect("document.querySelector('#input').value"), value);
      await completed(wc, [key('char', 0, { target: await target(), text: 'J' })]);
      assert.equal(await inspect("document.querySelector('#input').value"), value + 'J');
      const cursor = wc.getAutomationState().virtualCursor;
      assert.equal(cursor.enabled, false);
      assert.ok(cursor.blockedPointer > 0);
      assert.ok(cursor.blockedKeyboard > 0);
    } finally {
      wc.removeListener('before-input-event', listener);
      win.hide();
    }
  });

  await startMonitor();

  await check('BrowserWindow and hidden WebContentsView retain independent focus, rendering and OOPIF input', async () => {
    const other = new BrowserWindow({
      show: false, frame: false, x: 180, y: 140, width: 720, height: 520,
      webPreferences: { sandbox: true }
    });
    windows.push(other);
    const view = new WebContentsView({ webPreferences: { sandbox: true } });
    other.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 720, height: 520 });
    const second = view.webContents;
    try {
      await second.loadURL(origin);
      await Promise.all([wc.setAutomationOptions(isolated), second.setAutomationOptions(isolated)]);
      const systemBefore = await systemInputSnapshot();
      const firstTarget = await target();
      const secondTarget = await target(second);
      await Promise.all([
        completed(wc, [key('char', 0, { target: firstTarget, text: 'A' })]),
        completed(second, [key('char', 0, { target: secondTarget, text: 'B' })])
      ]);
      const framesBefore = await inspect('framesPainted', second);
      const framesStarted = Date.now();
      await delay(180);
      let framesAfter = await inspect('framesPainted', second);
      await until(async () => {
        framesAfter = await inspect('framesPainted', second);
        return framesAfter - framesBefore >= 2;
      }, `Hidden WebContentsView RAF stopped (${framesBefore}; state=${JSON.stringify(second.getAutomationState())})`, 1200);
      measurements.push({ mode: 'never-shown-web-contents-view', before: framesBefore,
        after: framesAfter, elapsedMs: Date.now() - framesStarted, rendering: second.getAutomationState().rendering });
      await verifyBackgroundFrames('never-shown-web-contents-view', second);
      assert.equal(await inspect('document.hasFocus()'), true);
      assert.equal(await inspect('document.hasFocus()', second), true);
      await completed(wc, [key('char', 0, { text: 'a' })]);
      await completed(second, [key('char', 0, { text: 'b' })]);
      assert.ok((await inspect("document.querySelector('#input').value")).endsWith('Aa'));
      assert.equal(await inspect("document.querySelector('#input').value", second), 'Bb');
      for (const [contents, text] of [[wc, 'C'], [second, 'D']]) {
        const child = await target(contents, true);
        await completed(contents, [key('char', 0, { target: child, text })]);
        const snapshot = await contents.getAgentSnapshot();
        assert.ok(snapshot.elements.some((item) => item.target.processId === child.processId && item.backendNodeId === child.backendNodeId && item.value === text));
        const childFrame = contents.mainFrame.framesInSubtree.find((frame) =>
          frame.processId === child.processId && frame.routingId === child.routingId);
        assert.ok(childFrame, 'OOPIF frame disappeared');
        assert.equal(await childFrame.executeJavaScript('document.hasFocus()'), true);
      }
      const systemAfter = await systemInputSnapshot();
      const concurrentInput = !systemBefore.coherentSnapshot || !systemAfter.coherentSnapshot ||
        systemBefore.lastInputTick !== systemAfter.lastInputTick;
      const cursorUnchanged = systemBefore.cursor.x === systemAfter.cursor.x &&
        systemBefore.cursor.y === systemAfter.cursor.y;
      measurements.push({ systemCursor: {
        status: concurrentInput ? 'inconclusive_concurrent_system_input' : cursorUnchanged ? 'passed' : 'failed',
        before: systemBefore, after: systemAfter
      } });
      if (!concurrentInput) {
        assert.deepEqual(systemAfter.cursor, systemBefore.cursor, 'Real system pointer moved without concurrent system input');
      }
      assertNoActivation();
    } finally {
      if (!second.isDestroyed()) second.close();
      if (!other.isDestroyed()) other.destroy();
    }
  });

  await check('keepRendering produces RAF progress before capture and fresh hidden/minimized/offscreen pixels', async () => {
    await wc.setAutomationOptions(isolated);
    const originalBounds = win.getBounds();
    try {
      win.hide();
      await delay(120);
      await verifyBackgroundFrames('hidden');
      win.showInactive();
      win.minimize();
      await until(() => win.isMinimized(), 'window minimized');
      await verifyBackgroundFrames('minimized');
      win.showInactive();
      await until(() => !win.isMinimized(), 'window restored without activation');
      win.setPosition(-20000, -20000);
      await delay(120);
      await verifyBackgroundFrames('outside-display');
      const rendering = wc.getAutomationState().rendering;
      assert.equal(rendering.viewAvailable, true);
      assert.equal(rendering.keepAlive, true);
      assert.equal(rendering.effectiveBackgroundThrottling, false);
      assertNoActivation();
    } finally { win.setBounds(originalBounds); win.showInactive(); }
  });

  await check('persistent rendering, task ownership and latest host throttling compose correctly', async () => {
    wc.setBackgroundThrottling(true);
    await wc.setAutomationOptions(isolated);
    await completed(wc, [key('char', 0, { target: await target(), text: 'L' })]);
    assert.equal(wc.getAutomationState().rendering.keepAlive, true, 'Task completion released persistent rendering');
    const pending = wc.dispatchInputSequence([mouse('mouseMoved'), mouse('mouseMoved', 1200)]);
    await until(() => wc.getAutomationState().inputActive, 'sequence started');
    wc.setBackgroundThrottling(false);
    await wc.setAutomationOptions({ keepRendering: false });
    let rendering = wc.getAutomationState().rendering;
    assert.equal(rendering.keepAlive, true, 'Persistent release removed task-owned rendering');
    assert.equal(rendering.requestedBackgroundThrottling, false);
    assert.equal((await pending).status, 'completed');
    rendering = wc.getAutomationState().rendering;
    assert.equal(rendering.keepAlive, false);
    assert.equal(rendering.effectiveBackgroundThrottling, false, 'Task restored a stale host setting');
    wc.setBackgroundThrottling(true);
    assert.equal(wc.getAutomationState().rendering.effectiveBackgroundThrottling, true);
  });

  await check('reset bypasses a long sequence, cancels queued work and releases owned input', async () => {
    await wc.setAutomationOptions({ ...isolated, virtualCursor: { enabled: true } });
    const input = await target();
    await inspect('events.length=0');
    const running = wc.dispatchInputSequence([
      key('keyDown', 0, { target: input, key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }),
      { kind: 'mouse', type: 'mousePressed', atMs: 0, target: input, offset: { x: 8, y: 8 }, button: 'left' },
      mouse('mouseMoved', 4000),
      mouse('mouseReleased', 4100, { button: 'left' }),
      key('keyUp', 4100, { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
    ]);
    await until(async () => (await inspect("events.some(e=>e.type==='mousedown')")), 'sequence acquired mouse and Shift');
    const queued = wc.dispatchInputSequence([key('char', 0, { target: input, text: 'Q' })]);
    const before = await inspect("document.querySelector('#input').value");
    const started = Date.now();
    await wc.resetAutomationOptions();
    assert.ok(Date.now() - started < 3000, 'Reset waited for full sequence duration');
    const [activeResult, queuedResult] = await Promise.all([running, queued]);
    assert.equal(activeResult.status, 'cancelled', JSON.stringify(activeResult));
    assert.equal(queuedResult.status, 'cancelled', JSON.stringify(queuedResult));
    assert.equal(queuedResult.dispatchedCount, 0);
    assert.ok(activeResult.cleanup.dispatched >= 2, JSON.stringify(activeResult.cleanup));
    assert.equal(activeResult.cleanup.failed, 0);
    assert.equal(wc.getAutomationState().inputActive, false);
    assert.equal(wc.getAutomationState().virtualCursor.buttons, 0);
    assert.equal(wc.getAutomationState().rendering.keepAlive, false);
    assert.equal(options().isolateInput, false);
    assert.equal(options().blockRealPointer, false);
    assert.equal(options().blockRealKeyboard, false);
    assert.equal(await inspect("document.querySelector('#input').value"), before);
    measurements.push({ reset: { activeResult, queuedResult, elapsedMs: Date.now() - started } });
  });

  await check('navigation retains options but invalidates old-document input and target references', async () => {
    await wc.setAutomationOptions(isolated);
    const oldTarget = await target();
    const configured = options();
    const pending = wc.dispatchInputSequence([key('char', 1000, { target: oldTarget, text: 'N' })]);
    await until(() => wc.getAutomationState().inputActive, 'navigation sequence started');
    const queued = wc.dispatchInputSequence([key('char', 0, { text: 'Q' })]);
    const queuedSingle = wc.dispatchKeyEvent({ type: 'char', text: 'R' }).then(
      (value) => ({ ok: true, value }), (error) => ({ ok: false, reason: String(error) })
    );
    await win.loadURL(origin + '?navigation=1');
    const result = await pending;
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(result.reason, /DOCUMENT|FRAME|STALE/);
    const queuedResult = await queued;
    assert.notEqual(queuedResult.status, 'completed', JSON.stringify(queuedResult));
    assert.equal(queuedResult.dispatchedCount, 0, 'Old-document queued sequence reached the new page');
    assert.match(queuedResult.reason, /DOCUMENT|NAVIG|STALE|FRAME/);
    const queuedSingleResult = await queuedSingle;
    assert.ok(!queuedSingleResult.ok || queuedSingleResult.value.status === 'failed',
      `Old-document single event reached the new page: ${JSON.stringify(queuedSingleResult)}`);
    assert.deepEqual(options(), configured);
    const stale = await wc.dispatchKeyEvent({ type: 'char', target: oldTarget, text: 'N' });
    assert.equal(stale.status, 'failed', JSON.stringify(stale));
    assert.equal(await inspect("document.querySelector('#input').value"), '');
    await completed(wc, [key('char', 0, { target: await target(), text: 'V' })]);
    assert.equal(await inspect("document.querySelector('#input').value"), 'V');
    assert.equal(await inspect('document.hasFocus()'), true);
    assertNoActivation();
  });

  await check('position and offset are unambiguous and clickElement uses trusted shared routing', async () => {
    await wc.setAutomationOptions(isolated);
    const input = await target();
    await inspect('events.length=0');
    for (const invalid of [
      { type: 'mouseMoved', x: 10, y: 10 },
      { type: 'mouseMoved', target: input, position: { x: 10, y: 10 } },
      { type: 'mouseMoved', position: { x: 10, y: 10 }, offset: { x: 1, y: 1 } }
    ]) await assert.rejects(wc.dispatchMouseEvent(invalid));
    assert.equal(await inspect('events.length'), 0);
    const result = await wc.clickElement({ selector: '#button' });
    assert.notEqual(result?.status, 'failed', JSON.stringify(result));
    const events = await inspect('events');
    assert.ok(events.some((event) => event.type === 'click' && event.id === 'button'));
    assert.ok(events.every((event) => event.trusted));
    assert.equal(wc.debugger.isAttached(), false);
    assertNoActivation();
  });
  await finish();
}).catch(finish);
