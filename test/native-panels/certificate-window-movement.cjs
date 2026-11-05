/* Windows certificate viewer ownership/movement acceptance; run with Electron. */
const { app, BaseWindow, BrowserWindow, NativePanel, screen, WebContentsView, webContents } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reportPath = path.resolve(process.env.CERT_WINDOW_TEST_REPORT || path.join(__dirname, 'certificate-window-results.json'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-certificate-movement-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('lang', 'zh-CN');
const results = [];
const observations = {};
const diagnostics = [];
const sources = new Set();
const ownedViewContents = new Set();
const startedAt = new Date().toISOString();
let server;
let origin;
let originalDesktop;
let finished = false;
let displays = [];

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await bounded(Promise.resolve().then(predicate), 1800, label);
    if (last) return last;
    await delay(80);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
async function check(name, action) {
  const start = Date.now();
  try {
    const detail = await bounded(action(), 25000, name);
    results.push({ name, ok: true, elapsedMs: Date.now() - start, detail });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, elapsedMs: Date.now() - start, error: error.stack || String(error) });
    console.error('FAIL', name, error.message);
  }
}
async function probe(helper, action, options = {}) {
  const encoded = Buffer.from(JSON.stringify({ action, pid: process.pid, ...options })).toString('base64');
  const { stdout } = await run(process.env.NATIVE_PANELS_PYTHON || 'python', [path.join(__dirname, helper), encoded],
    { windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return JSON.parse(stdout.trim());
}
const native = (action, options) => probe('native-panels-win.py', action, options);
const state = (hwnd) => probe('certificate-window-win.py', 'state', { hwnd });
const handleOf = (win) => Number(win.getNativeWindowHandle().readBigUInt64LE());
function unchanged(before, after, label) {
  assert.ok(Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2 &&
    Math.abs(after.width - before.width) <= 2 && Math.abs(after.height - before.height) <= 2,
  `${label}: ${JSON.stringify({ before, after })}`);
}
function moved(before, after, label) {
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) >= 15,
    `${label}: ${JSON.stringify({ before, after })}`);
}
async function pair(source, viewer) {
  return { source: await state(handleOf(source)), viewer: await state(viewer) };
}
async function pageInfoCertificate(source, wc) {
  let panel;
  const originalShow = NativePanel.prototype.show;
  NativePanel.prototype.show = function (...args) {
    panel = this;
    return originalShow.apply(this, args);
  };
  try {
    const bounds = source.getBounds();
    assert.equal(wc.showPageInfoDialog({ anchorBounds: { x: bounds.x + 30, y: bounds.y + 55, width: 24, height: 24 } }), true);
  } finally {
    NativePanel.prototype.show = originalShow;
  }
  assert.ok(panel, 'Public page info did not show a NativePanel');
  const entry = { method: 'showPageInfoDialog with real Win32 certificate-action clicks', actions: [], controls: [] };
  panel.on('action', (action) => entry.actions.push(action));
  for (const id of ['page-info-security', 'page-info-certificate']) {
    const current = await until(() => {
      const snapshot = panel._getState();
      const control = snapshot.controls.find((candidate) => candidate.id === id);
      return snapshot.visible && control ? { snapshot, control } : null;
    }, `public page info control ${id}`);
    const { snapshot, control } = current;
    const hwnd = Number(snapshot.windowHandle);
    const point = screen.dipToScreenPoint({ x: Math.round(control.bounds.x + control.bounds.width / 2),
      y: Math.round(control.bounds.y + control.bounds.height / 2) });
    const hit = await native('hit', point);
    assert.equal(hit.root, hwnd, `Public page-info control is obscured: ${JSON.stringify({ id, hit, point, snapshot })}`);
    entry.controls.push({ id, hwnd, bounds: control.bounds, point, hit });
    await native('click', { hwnd, ...point, forceActivation: true });
    await until(() => entry.actions.some((action) => action.id === id && action.type === 'click'), `native certificate action ${id}`);
  }
  entry.panelAfterCertificate = panel._getState();
  assert.equal(entry.panelAfterCertificate.visible, false, 'Certificate action did not hide its source NativePanel');
  return entry;
}
async function openViewer(source, wc, usePublicEntry = false) {
  const entry = usePublicEntry ? await pageInfoCertificate(source, wc) : { method: 'private _showCertificateViewer' };
  if (!usePublicEntry) assert.equal(wc._showCertificateViewer(), true);
  const viewer = await until(async () => {
    const value = await wc._getCertificateViewerState();
    return value.windowHandle && value.dom?.title ? value : null;
  }, 'certificate viewer WebUI ready');
  const hwnd = Number(viewer.windowHandle);
  assert.ok(Number.isSafeInteger(hwnd) && hwnd > 0);
  await until(async () => (await state(hwnd)).visible, 'certificate HWND visible');
  return { hwnd, diagnostic: viewer, entry };
}
async function realCaptionDrag(hwnd, dx, dy) {
  const before = await state(hwnd);
  if (!before.captionPoint) {
    const diagnostic = { reason: 'No native HTCAPTION point', state: before };
    try {
      const file = path.join(path.dirname(reportPath), `certificate-no-caption-${hwnd}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Capture the title area with inset corners so the rounded outer HWND
      // edges cannot sample another application or the desktop.
      diagnostic.screenshot = await native('screenshot', { hwnd, path: file,
        bounds: { x: before.bounds.x + 20, y: before.bounds.y + 5,
          width: before.bounds.width - 40, height: Math.min(150, before.bounds.height - 10) } });
    } catch (error) {
      diagnostic.screenshotError = String(error);
    }
    diagnostics.push(diagnostic);
  }
  assert.ok(before.captionPoint, `No native HTCAPTION point: ${JSON.stringify(before)}`);
  const point = before.captionPoint;
  const hit = await native('hit', { x: point.x, y: point.y });
  assert.equal(hit.root, hwnd, `Caption is obscured by another window: ${JSON.stringify({ before, hit })}`);
  await native('drag', { hwnd, x: point.x, y: point.y,
    end: { x: point.x + dx, y: point.y + dy }, forceActivation: true });
  await delay(160);
  const after = await state(hwnd);
  moved(before.bounds, after.bounds, 'Real caption drag did not move target');
  return { before, after, hit, delta: { x: dx, y: dy } };
}
async function modeCases(frame, fingerprint, useView = false) {
  const mode = useView ? 'base-window-webcontents-view-css-title' : frame ? 'native-frame' : 'frameless-css-title';
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false,
    partition: `certificate-window-${process.pid}-${mode}` };
  const options = { show: false, frame, title: `Certificate owner ${mode}`,
    x: 70, y: 45, width: 900, height: 630 };
  const source = useView ? new BaseWindow(options) : new BrowserWindow({ ...options, webPreferences: preferences });
  sources.add(source);
  let wc;
  if (useView) {
    const contentsView = new WebContentsView({ webPreferences: preferences });
    source.contentView.addChildView(contentsView);
    wc = contentsView.webContents;
    ownedViewContents.add(wc);
    const resize = () => {
      if (source.isDestroyed()) return;
      const { width, height } = source.getContentBounds();
      contentsView.setBounds({ x: 0, y: 0, width, height });
    };
    source.on('resize', resize);
    resize();
  } else {
    wc = source.webContents;
  }
  const session = wc.session;
  session.setCertificateVerifyProc((request, callback) => {
    let matched = false;
    try {
      matched = request.hostname === '127.0.0.1' &&
        new crypto.X509Certificate(request.certificate.data).fingerprint256 === fingerprint;
    } catch {}
    callback(matched ? 0 : -3);
  });
  const run = observations[mode] = { initialSource: source.getBounds(), sourceKind: useView ? 'BaseWindow+WebContentsView' : 'BrowserWindow',
    frame, movements: [] };
  let viewer;
  try {
    await wc.loadURL(origin + '/');
    source.show();
    await delay(180);
    viewer = await openViewer(source, wc, true);
    run.viewerAtOpen = viewer;
    await check(`${mode}: native title, isolated renderer and retained owner`, async () => {
      const snapshot = await pair(source, viewer.hwnd);
      run.identity = snapshot;
      assert.notEqual(viewer.hwnd, handleOf(source));
      assert.equal(snapshot.viewer.child, false, 'Certificate viewer is a WS_CHILD window');
      assert.equal(snapshot.viewer.owner, handleOf(source), 'Certificate viewer lost Win32 GW_OWNER');
      assert.equal(snapshot.viewer.ancestorParent, snapshot.viewer.desktop, 'Viewer is embedded under another HWND');
      assert.equal(snapshot.source.enabled, true, 'Nonmodal certificate viewer disabled source');
      assert.match(snapshot.viewer.title, /证书查看器/);
      assert.doesNotMatch(snapshot.viewer.title, /证书查看者/);
      assert.match(viewer.diagnostic.dom.title, /证书查看器/);
      assert.equal(viewer.diagnostic.url, 'chrome://view-cert/');
      for (const key of ['process', 'require', 'hostPreload']) assert.equal(viewer.diagnostic.dom[key], 'undefined', key);
      assert.equal(viewer.diagnostic.dom.chromeSend, 'function');
      assert.equal(wc.getURL(), origin + '/');
      run.publicWebContents = webContents.getAllWebContents().map((contents) => ({ id: contents.id, url: contents.getURL() }));
      return snapshot;
    });
    await check(`${mode}: source moves, maximize and display transfer leave viewer screen bounds unchanged`, async () => {
      const before = await pair(source, viewer.hwnd);
      const initial = source.getBounds();
      source.setPosition(initial.x + 45, initial.y + 25, false);
      await delay(180);
      const position = await pair(source, viewer.hwnd);
      source.setBounds({ x: initial.x + 80, y: initial.y + 10, width: initial.width - 30, height: initial.height - 20 }, false);
      await delay(180);
      const bounds = await pair(source, viewer.hwnd);
      let maximized;
      let restored;
      try {
        source.maximize();
        await until(() => source.isMaximized(), 'source maximized');
        await delay(180);
        maximized = await pair(source, viewer.hwnd);
      } finally {
        if (source.isMaximized()) source.unmaximize();
        await until(() => !source.isMaximized(), 'source unmaximized');
        await delay(180);
        restored = await pair(source, viewer.hwnd);
      }
      const sourceDisplay = screen.getDisplayMatching(source.getBounds());
      const alternate = screen.getAllDisplays().find((display) => display.id !== sourceDisplay.id);
      let displayTransfer = { covered: false, reason: 'Only one display is available', sourceDisplayId: sourceDisplay.id };
      if (alternate) {
        const restoreBounds = source.getBounds();
        const work = alternate.workArea;
        const width = Math.max(200, Math.min(restoreBounds.width, work.width - 40));
        const height = Math.max(150, Math.min(restoreBounds.height, work.height - 40));
        displayTransfer = { covered: true, sourceDisplayId: sourceDisplay.id, targetDisplayId: alternate.id,
          targetDisplay: { bounds: alternate.bounds, workArea: work, scaleFactor: alternate.scaleFactor },
          before: await pair(source, viewer.hwnd) };
        try {
          source.setBounds({ x: work.x + Math.max(0, Math.floor((work.width - width) / 2)),
            y: work.y + Math.max(0, Math.floor((work.height - height) / 2)), width, height }, false);
          await until(() => screen.getDisplayMatching(source.getBounds()).id === alternate.id, 'source moved to alternate display');
          await delay(220);
          displayTransfer.transferred = await pair(source, viewer.hwnd);
          displayTransfer.deviceScaleChanged = displayTransfer.before.source.dpi !== displayTransfer.transferred.source.dpi;
        } finally {
          source.setBounds(restoreBounds, false);
          await until(() => screen.getDisplayMatching(source.getBounds()).id === sourceDisplay.id, 'source returned to initial display');
          await delay(220);
          displayTransfer.returned = await pair(source, viewer.hwnd);
        }
      }
      const movement = { operation: 'programmatic', before, position, bounds, maximized, restored, displayTransfer };
      run.movements.push(movement);
      moved(before.source.bounds, position.source.bounds, 'Source setPosition was not effective');
      moved(position.source.bounds, bounds.source.bounds, 'Source setBounds was not effective');
      unchanged(before.viewer.bounds, position.viewer.bounds, 'Viewer followed source setPosition');
      unchanged(before.viewer.bounds, bounds.viewer.bounds, 'Viewer followed source setBounds');
      unchanged(bounds.viewer.bounds, maximized.viewer.bounds, 'Viewer followed source maximize');
      unchanged(bounds.viewer.bounds, restored.viewer.bounds, 'Viewer followed source unmaximize');
      if (displayTransfer.covered) {
        moved(displayTransfer.before.source.bounds, displayTransfer.transferred.source.bounds, 'Source did not physically move to another display');
        unchanged(displayTransfer.before.viewer.bounds, displayTransfer.transferred.viewer.bounds, 'Viewer followed source display transfer');
        unchanged(displayTransfer.before.viewer.bounds, displayTransfer.returned.viewer.bounds, 'Viewer followed source display return');
        assert.equal(displayTransfer.transferred.viewer.owner, handleOf(source));
      }
      assert.equal(bounds.viewer.owner, handleOf(source));
      return movement;
    });
    await check(`${mode}: real source caption drag leaves viewer screen bounds unchanged`, async () => {
      const before = await pair(source, viewer.hwnd);
      const drag = await realCaptionDrag(handleOf(source), 50, 20);
      const after = await pair(source, viewer.hwnd);
      run.movements.push({ operation: 'source-native-caption-drag', before, drag, after });
      unchanged(before.viewer.bounds, after.viewer.bounds, 'Viewer followed real source caption drag');
      assert.equal(after.viewer.owner, handleOf(source));
      return { before, drag, after };
    });
    await check(`${mode}: user can drag certificate viewer independently`, async () => {
      const before = await pair(source, viewer.hwnd);
      const drag = await realCaptionDrag(viewer.hwnd, 45, 15);
      const after = await pair(source, viewer.hwnd);
      run.movements.push({ operation: 'viewer-native-caption-drag', before, drag, after });
      unchanged(before.source.bounds, after.source.bounds, 'Dragging viewer moved its source');
      assert.equal(after.viewer.owner, handleOf(source));
      return { before, drag, after };
    });
    await check(`${mode}: owner minimize, restore and activation retain owned-window behavior`, async () => {
      const before = await pair(source, viewer.hwnd);
      source.minimize();
      await until(async () => (await state(handleOf(source))).minimized, 'source minimized');
      const minimized = await pair(source, viewer.hwnd);
      source.restore();
      await until(async () => {
        const current = await pair(source, viewer.hwnd);
        return !current.source.minimized && current.viewer.visible ? current : null;
      }, 'owned viewer restored');
      source.focus();
      await delay(160);
      const restored = await pair(source, viewer.hwnd);
      run.ownerLifecycle = { before, minimized, restored };
      assert.ok(!minimized.viewer.visible || minimized.viewer.minimized, 'Owned viewer stayed visible when owner minimized');
      assert.equal(restored.viewer.owner, handleOf(source));
      assert.equal(restored.viewer.aboveOwner, true, 'Owned viewer fell below its source');
      assert.equal(restored.source.enabled, true);
      assert.equal(restored.source.foregroundPid, process.pid, 'Source activation did not reach this process');
      unchanged(before.viewer.bounds, restored.viewer.bounds, 'Owner restore moved independently placed viewer');
      return { before, minimized, restored };
    });
    await check(`${mode}: source navigation and destruction close the certificate viewer`, async () => {
      const navigationViewer = viewer.hwnd;
      await wc.loadURL(origin + '/navigated');
      await until(async () => !(await state(navigationViewer)).exists, 'viewer closed on source navigation');
      const next = await openViewer(source, wc);
      source.destroy();
      await until(async () => !(await state(next.hwnd)).exists, 'viewer closed on source destruction');
      const closed = { navigationViewer, destructionViewer: next.hwnd,
        afterNavigation: await state(navigationViewer), afterDestruction: await state(next.hwnd),
        sourceWebContentsAliveBeforeExplicitCleanup: !wc.isDestroyed() };
      if (useView) {
        assert.equal(closed.sourceWebContentsAliveBeforeExplicitCleanup, true,
          'BaseWindow source contents were destroyed before independently checking owner-close cleanup');
      }
      run.closed = closed;
      return closed;
    });
  } finally {
    session.setCertificateVerifyProc(null);
    if (!source.isDestroyed()) source.destroy();
    if (useView && !wc.isDestroyed()) wc.close();
  }
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) results.push({ name: 'certificate movement fixture', ok: false, error: error.stack || String(error) });
  for (const source of sources) if (!source.isDestroyed()) source.destroy();
  for (const contents of ownedViewContents) if (!contents.isDestroyed()) contents.close();
  if (server) { server.closeAllConnections(); server.close(); }
  try { if (originalDesktop) await native('restore', originalDesktop); } catch {}
  const failed = results.filter((result) => !result.ok).length;
  const report = { suite: 'certificate-window-movement', startedAt, completedAt: new Date().toISOString(),
    distributionTarget: process.env.CERT_WINDOW_DISTRIBUTION_TARGET || 'local certificate movement fix',
    platform: process.platform, arch: process.arch, versions: { ...process.versions }, appVersion: app.getVersion(),
    executablePath: process.execPath,
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    testSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    coordinateSpace: 'Win32 per-monitor-DPI-aware physical screen pixels; Electron source API bounds are DIP', displays,
    summary: { total: results.length, passed: results.length - failed, failed }, results, observations, diagnostics };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  console.log(`Report: ${reportPath}`);
  app.exit(failed ? 1 : 0);
}
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => finish(new Error('Certificate movement suite exceeded 150 seconds')), 150000);
watchdog.unref();
app.whenReady().then(async () => {
  assert.equal(process.platform, 'win32', 'Windows native certificate movement acceptance');
  displays = screen.getAllDisplays().map((display) => ({ id: display.id, label: display.label, bounds: display.bounds,
    workArea: display.workArea, scaleFactor: display.scaleFactor, rotation: display.rotation }));
  const certDir = path.resolve(__dirname, '../../spec/fixtures/certificates');
  const certificate = fs.readFileSync(path.join(certDir, 'server.pem'));
  const fingerprint = new crypto.X509Certificate(certificate).fingerprint256;
  server = https.createServer({ key: fs.readFileSync(path.join(certDir, 'server.key')), cert: certificate }, (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Certificate owner fixture</title><style>html,body{margin:0;background:#183047;color:white}header{height:42px;padding-left:24px;-webkit-app-region:drag;font:18px/42px sans-serif}</style><header>Certificate owner: drag this title</header><p>Local TLS fixture</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  originalDesktop = await native('windows');
  for (const frame of [true, false]) await modeCases(frame, fingerprint);
  await modeCases(false, fingerprint, true);
  await finish();
}).catch(finish);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
