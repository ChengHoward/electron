/* Native-panel acceptance: run with the newly compiled Electron, never node. */
const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  NativePanel,
  nativeImage,
  nativeTheme,
  screen,
  webContents
} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reportPath = process.env.NATIVE_PANELS_REPORT || path.join(__dirname, 'native-panels-results.json');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-native-panels-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('site-per-process');
const results = [];
const measurements = {};
const limitations = [];
const panels = new Set();
const windows = new Set();
const panelNativeHandles = new Set();
const activationPoints = new Map();
let parent;
let view;
let wc;
let originalDesktop;
let origin;
let secureOrigin;
let secureServer;
let finished = false;
let transientCounter = 0;
const fixture = `<!doctype html><title>Native panels isolated acceptance</title>
<style>html,body{margin:0;height:100%;font:18px sans-serif;background:#15314d;color:white}
#agent{position:absolute;left:410px;top:80px;width:150px;height:34px}
#click{position:absolute;left:410px;top:140px;width:150px;height:38px}
#animated{position:absolute;left:10px;top:360px;width:160px;height:100px}</style>
<input id=agent aria-label="Page agent input"><button id=click>Page button</button><canvas id=animated width=160 height=100></canvas>
<script>window.framesPainted=0;window.pageEvents=[];window.clicks=0;
document.querySelector('#click').onclick=()=>window.clicks++;
for(const name of ['input','keydown','keyup','click'])document.addEventListener(name,e=>window.pageEvents.push({type:name,id:e.target.id,trusted:e.isTrusted,value:e.target.value}));
const canvas=document.querySelector('canvas');const context=canvas.getContext('2d');
function paint(){window.framesPainted++;context.fillStyle='rgb('+(window.framesPainted%256)+',100,140)';context.fillRect(0,0,160,100);requestAnimationFrame(paint)}paint();
</script>`;
const server = http.createServer((request, response) => {
  if (request.url === '/pending') return;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fixture);
});
const eventsFor = (panel) => {
  const events = { action: [], dismissed: [], closed: 0 };
  panel.on('action', (action) => events.action.push(action));
  panel.on('dismissed', (details) => events.dismissed.push(details));
  panel.on('closed', () => events.closed++);
  return events;
};
function content(overrides = {}) {
  return {
    type: 'column',
    id: 'root',
    width: 320,
    gap: 6,
    padding: 12,
    children: [
      { type: 'text', id: 'heading', text: 'Native acceptance', fontSize: 16 },
      {
        type: 'row',
        id: 'row',
        gap: 6,
        children: [
          {
            type: 'icon',
            id: 'icon',
            width: 16,
            height: 16,
            image: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 })
          },
          { type: 'text', id: 'muted', text: 'Live page remains visible', muted: true }
        ]
      },
      { type: 'button', id: 'button', text: 'Native action' },
      { type: 'button', id: 'disabled-button', text: 'Disabled action', disabled: true },
      { type: 'toggle', id: 'toggle', text: 'Native toggle', checked: false },
      { type: 'input', id: 'input', placeholder: 'Native input', value: '', maxLength: 80 },
      {
        type: 'option',
        id: 'option',
        value: 'first',
        items: [
          { id: 'first', label: 'First choice', value: 'first' },
          { id: 'second', label: 'Second choice', value: 'second' },
          { id: 'disabled', label: 'Disabled choice', disabled: true }
        ]
      },
      { type: 'separator', id: 'separator' },
      { type: 'progress', id: 'progress', value: 0.5 },
      {
        type: 'list',
        id: 'list',
        height: 100,
        gap: 4,
        children: Array.from({ length: 35 }, (_, i) => ({
          type: 'button',
          id: `item-${i}`,
          text: `List item ${i}`
        }))
      }
    ],
    ...overrides
  };
}
function makePanel(options = {}) {
  const panel = new NativePanel({
    parent,
    sourceWebContents: wc,
    content: content(),
    focusMode: 'input',
    dismissOnOutsideClick: false,
    ...options
  });
  panels.add(panel);
  return panel;
}
async function usingPanel(fn, options = {}) {
  const panel = makePanel(options);
  try {
    return await fn(panel, eventsFor(panel));
  } finally {
    panel.destroy();
  }
}
function state(panel) {
  assert.equal(typeof panel._getState, 'function', 'Native state diagnostics are required for OS-level acceptance');
  const actual = panel._getState();
  for (const handle of [actual.windowHandle, actual.shadowWindowHandle]) {
    if (handle && handle !== '0') panelNativeHandles.add(Number(handle));
  }
  return actual;
}
function control(panel, id) {
  const found = state(panel).controls.find((node) => node.id === id);
  assert.ok(found, `Missing actual native control ${id}`);
  return found;
}
function anchor() {
  const bounds = parent.getBounds();
  return { x: bounds.x + 35, y: bounds.y + 22, width: 24, height: 24 };
}
async function show(panel, options = {}) {
  panel.show({ anchorBounds: anchor(), ...options });
  await delay(120);
  assert.equal(state(panel).visible, true);
}
async function native(action, options = {}) {
  const encoded = Buffer.from(
    JSON.stringify({ action, pid: process.pid, activationPoint: activationPoints.get(options.hwnd), ...options })
  ).toString('base64');
  const { stdout } = await run(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [path.join(__dirname, 'native-panels-win.py'), encoded],
    { windowsHide: true, timeout: 10000 }
  );
  return JSON.parse(stdout.trim());
}
async function createUnderlay() {
  const child = spawn(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [path.join(__dirname, 'native-panels-underlay.py')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let buffer = '';
  let nextId = 0;
  let errorOutput = '';
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.ready) readyResolve(message);
      else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  child.on('error', readyReject);
  child.on('exit', (code) => readyReject(new Error(`Underlay exited ${code}: ${errorOutput}`)));
  child.stdin.on('error', () => {});
  const details = await Promise.race([
    ready,
    delay(5000).then(() => {
      throw new Error(`Underlay did not start: ${errorOutput}`);
    })
  ]).catch((error) => {
    child.stdin.end();
    child.kill();
    throw error;
  });
  const request = (action, extra = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Underlay ${action} did not respond: ${errorOutput}`));
      }, 3000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ action, id, ...extra })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    });
  return {
    ...details,
    request,
    stop: async () => {
      try {
        await request('stop');
      } finally {
        child.stdin.end();
        child.kill();
      }
    }
  };
}
const handleOf = (win) => Number(win.getNativeWindowHandle().readBigUInt64LE());
async function nativePopup(panel) {
  const owner = handleOf(parent);
  const allWindows = (await native('windows')).windows;
  const candidates = allWindows.filter((win) => win.owner === owner && win.visible);
  const actual = state(panel);
  const bounds = screen.dipToScreenRect(null, actual.bounds);
  const match = actual.windowHandle
    ? candidates.find((win) => win.hwnd === Number(actual.windowHandle))
    : candidates.find(
        (win) =>
          !(win.exstyle & 0x20) && Math.abs(win.bounds.x - bounds.x) <= 4 && Math.abs(win.bounds.y - bounds.y) <= 4
      );
  const diagnostic = {
    windowHandle: actual.windowHandle,
    shadowWindowHandle: actual.shadowWindowHandle,
    bounds: actual.bounds,
    contentBounds: actual.contentBounds,
    visible: actual.visible
  };
  assert.ok(
    match,
    `No owned native HWND at panel bounds: ${JSON.stringify({ candidates, allWindows, owner, actual: diagnostic, bounds })}`
  );
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Math.abs(match.bounds[field] - bounds[field]) <= 4,
      `Native HWND ${field} disagrees with screen DIP geometry: ${JSON.stringify({ native: match.bounds, expected: bounds })}`
    );
  }
  activationPoints.set(
    match.hwnd,
    screen.dipToScreenPoint({ x: actual.contentBounds.x + 5, y: actual.contentBounds.y + 24 })
  );
  return match;
}
async function capturePanel(panel, name, nativeWindow) {
  try {
    const popup = nativeWindow || (await nativePopup(panel));
    const bounds = nativeWindow ? nativeWindow.bounds : screen.dipToScreenRect(null, state(panel).contentBounds);
    const output = path.join(path.dirname(reportPath), `native-panels-${name}.png`);
    const capture = await native('screenshot', { hwnd: popup.hwnd, bounds, path: output });
    (measurements.screenshots ||= {})[name] = capture;
    (measurements.screenshotNativeState ||= {})[name] = state(panel);
  } catch (error) {
    limitations.push(`Optional native ${name} screenshot was unavailable: ${error.message}`);
  }
}
const screenPoint = (bounds) =>
  screen.dipToScreenPoint({ x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) });
async function clickControl(panel, id) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const popup = await nativePopup(panel);
    const bounds = control(panel, id).bounds;
    const body = state(panel).contentBounds;
    const point = screenPoint(bounds);
    const insideBody = bounds.y >= body.y && bounds.y + bounds.height <= body.y + body.height;
    const hit = await native('hit', point);
    if (insideBody && hit.root === popup.hwnd) {
      await native('click', { hwnd: popup.hwnd, ...point });
      await delay(70);
      return;
    }
    const wheelPoint = screen.dipToScreenPoint({
      x: body.x + body.width - 20,
      y: Math.round(body.y + body.height / 2)
    });
    await native('wheel', { hwnd: popup.hwnd, ...wheelPoint, delta: bounds.y < body.y ? 720 : -720 });
    await delay(80);
  }
  assert.fail(`Native control ${id} could not be scrolled into the visible panel`);
}
async function panelKey(panel, vk, modifiers = []) {
  const popup = await nativePopup(panel);
  await native('key', { hwnd: popup.hwnd, vk, modifiers });
  await delay(60);
}
async function typePanel(panel, text) {
  const popup = await nativePopup(panel);
  await native('text', { hwnd: popup.hwnd, text });
  await delay(80);
}
const inspect = (source) => wc.executeJavaScript(source);
function assertRgbNear(actual, expected, message = 'Native painted color differs') {
  assert.ok(
    actual.every((channel, index) => Math.abs(channel - expected[index]) <= 2),
    `${message}: actual=${actual.join(',')}, expected=${expected.join(',')}`
  );
}
const ids = () =>
  webContents
    .getAllWebContents()
    .map((item) => item.id)
    .sort((a, b) => a - b);
const rendererPids = () =>
  app
    .getAppMetrics()
    .filter((metric) => ['Tab', 'Renderer'].includes(metric.type))
    .map((metric) => metric.pid)
    .sort((a, b) => a - b);
async function check(name, fn) {
  let timer;
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Acceptance case timed out')), 22000);
      })
    ]);
    results.push({ name, ok: true, elapsedMs: Date.now() - started });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, elapsedMs: Date.now() - started, error: error.stack });
    console.error('FAIL', name, error);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, message, timeout = 1800) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await delay(35);
  }
  assert.fail(message);
}
function addWindow(options = {}) {
  const win = new BaseWindow({ show: false, width: 600, height: 540, ...options });
  windows.add(win);
  return win;
}
async function transientSource() {
  const win = addWindow({ x: parent.getBounds().x + 30, y: parent.getBounds().y + 30 });
  const child = new WebContentsView({
    webPreferences: { sandbox: true, partition: `native-panel-transient-${++transientCounter}` }
  });
  win.contentView.addChildView(child);
  child.setBounds({ x: 0, y: 0, width: 600, height: 500 });
  await child.webContents.loadURL(`${origin}/transient`);
  const panel = makePanel({ parent: win, sourceWebContents: child.webContents });
  return { win, child, contents: child.webContents, panel };
}
async function pageInfo(options) {
  const original = NativePanel.prototype.show;
  let captured;
  NativePanel.prototype.show = function (...args) {
    captured = this;
    panels.add(this);
    return original.apply(this, args);
  };
  try {
    assert.equal(wc.showPageInfoDialog({ anchorBounds: anchor(), ...options }), true);
    assert.ok(captured, 'PageInfo must use the native panel backend');
    await delay(120);
    return captured;
  } finally {
    NativePanel.prototype.show = original;
  }
}
async function main() {
  assert.equal(process.platform, 'win32', 'This acceptance driver targets Windows');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  parent = addWindow({ title: 'Native panels acceptance', x: 130, y: 100 });
  view = new WebContentsView({ webPreferences: { sandbox: true } });
  parent.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 600, height: 500 });
  wc = view.webContents;
  await wc.loadURL(`${origin}/`);
  originalDesktop = await native('windows');
  parent.show();
  parent.focus();
  await delay(200);
  measurements.displays = screen
    .getAllDisplays()
    .map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor }));
  measurements.imeLayouts = originalDesktop.imeLayouts;
  limitations.push(
    'Touch/pen hardware, physical trackpad inertia, and spoken screen-reader output were not hardware-tested.'
  );
  if (new Set(measurements.displays.map((display) => display.scaleFactor)).size < 2) {
    limitations.push(
      'Mixed-DPI monitor transfer cannot be exercised: connected displays do not have different scale factors.'
    );
  }

  await check('all seven methods are available and runtime support is truthful', async () => {
    assert.equal(typeof NativePanel, 'function');
    assert.equal(NativePanel.isSupported(), process.arch === 'x64');
    assert.equal(typeof wc.showPageInfoDialog, 'function');
    await usingPanel(async (panel) => {
      for (const method of ['show', 'update', 'hide', 'destroy']) assert.equal(typeof panel[method], 'function');
      assert.equal(state(panel).visible, false);
    });
  });
  await check(
    'constructor validates owner, source, every control kind, themes and duplicate IDs before effects',
    async () => {
      const before = ids();
      const dead = addWindow();
      dead.destroy();
      const invalidOptions = [
        undefined,
        null,
        {},
        { parent },
        { parent: {} },
        { parent: dead, content: content() },
        { parent, content: content(), focusMode: 'dom' },
        { parent, content: content(), radius: -1 },
        { parent, content: content(), shadow: 'true' },
        { parent, content: content(), dismissOnEscape: 1 },
        { parent, content: content(), theme: 'sepia' },
        { parent, content: content(), theme: { background: 'red' } },
        { parent, content: content(), theme: { fontSize: 0 } }
      ];
      for (const options of invalidOptions) assert.throws(() => new NativePanel(options));
      const invalidNodes = [
        { type: 'text', id: 'x' },
        { type: 'text', text: 'missing id' },
        { type: 'html', id: 'x' },
        { type: 'button', id: 'x', text: 'x', onclick: 'alert(1)' },
        { type: 'toggle', id: 'x', text: 'x', checked: 'yes' },
        { type: 'input', id: 'x', value: 1 },
        { type: 'input', id: 'x', maxLength: -1 },
        { type: 'progress', id: 'x', value: 1.01 },
        { type: 'progress', id: 'x', value: NaN },
        { type: 'icon', id: 'x', image: 'https://example.com/image.png' },
        {
          type: 'option',
          id: 'x',
          items: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' }
          ]
        },
        { type: 'column', id: 'x', children: [{ type: 'text', id: 'x', text: 'duplicate' }] },
        { type: 'row', id: 'x', children: [], gap: Infinity }
      ];
      for (const tree of invalidNodes) {
        assert.throws(() => new NativePanel({ parent, content: tree }), JSON.stringify(tree));
      }
      assert.deepEqual(ids(), before);
    }
  );
  await check('show validates screen DIP anchors and placements, including all finite coordinate checks', async () => {
    await usingPanel(async (panel) => {
      for (const options of [
        undefined,
        null,
        {},
        { anchorBounds: {} },
        { anchorBounds: { x: 1, y: 1, width: -1, height: 1 } },
        { anchorBounds: { x: Infinity, y: 1, width: 1, height: 1 } },
        { anchorBounds: { x: 1, y: NaN, width: 1, height: 1 } },
        { anchorBounds: anchor(), placement: 'left' }
      ]) {
        assert.throws(() => panel.show(options));
      }
      assert.equal(state(panel).visible, false);
      for (const placement of ['auto', 'bottom-start', 'bottom-end', 'top-start', 'top-end']) {
        await show(panel, { placement });
        panel.hide();
      }
    });
  });
  await check(
    'BrowserWindow owners and source-free informational panels use the same native implementation',
    async () => {
      const browser = new BrowserWindow({ show: false, width: 400, height: 300 });
      windows.add(browser);
      const panel = makePanel({
        parent: browser,
        sourceWebContents: browser.webContents,
        content: { type: 'text', id: 'browser-label', text: 'BrowserWindow native owner' }
      });
      try {
        browser.show();
        panel.show({ anchorBounds: { x: 250, y: 200, width: 24, height: 24 } });
        assert.equal(state(panel).visible, true);
        panel.hide();
      } finally {
        panel.destroy();
        browser.destroy();
        parent.focus();
      }
      const unbound = new NativePanel({ parent, content: content(), focusMode: 'none' });
      panels.add(unbound);
      try {
        const before = (await native('windows')).foreground;
        unbound.show({ anchorBounds: anchor() });
        await delay(100);
        assert.equal(state(unbound).visible, true);
        assert.equal((await native('windows')).foreground, before, 'Informational panel stole OS activation');
        assert.equal(state(unbound).focusedId, undefined);
      } finally {
        unbound.destroy();
      }
    }
  );
  let nativeWindowsVerified = false;
  await check(
    'native owned popup overlaps WCV, extends outside parent and creates no WebContents or renderer',
    async () => {
      await usingPanel(async (panel) => {
        const before = ids();
        const pids = rendererPids();
        const bounds = parent.getBounds();
        await show(panel, {
          anchorBounds: { x: bounds.x + bounds.width - 45, y: bounds.y + 15, width: 24, height: 24 }
        });
        const actual = state(panel);
        const popup = await nativePopup(panel);
        measurements.nativeWindow = popup;
        assert.equal(actual.nativeWindowsValid, true);
        measurements.nativeIdentity = {
          nativeWindowsValid: actual.nativeWindowsValid,
          parentWindowHandle: actual.parentWindowHandle,
          windowHandle: actual.windowHandle,
          shadowWindowHandle: actual.shadowWindowHandle
        };
        assert.notEqual(popup.hwnd, handleOf(parent), 'Panel must have a separate top-level HWND');
        assert.equal(Boolean(popup.style & 0x40000000), false, 'WS_CHILD panel cannot extend outside its parent');
        assert.ok(
          actual.bounds.x + actual.bounds.width > bounds.x + bounds.width,
          'Popup must be able to extend outside its owner'
        );
        assert.equal(popup.owner, handleOf(parent));
        assert.equal(Boolean(popup.exstyle & 0x00040000), false, 'WS_EX_APPWINDOW must be absent');
        if (actual.shadowWindowHandle && actual.shadowWindowHandle !== '0') {
          const shadow = (await native('windows')).windows.find(
            (window) => window.hwnd === Number(actual.shadowWindowHandle)
          );
          assert.ok(shadow && shadow.visible, 'The native shadow HWND is missing');
          assert.notEqual(shadow.hwnd, popup.hwnd);
          assert.notEqual(shadow.hwnd, handleOf(parent));
          assert.ok(shadow.exstyle & 0x00080000, 'Shadow must be WS_EX_LAYERED');
          assert.ok(shadow.exstyle & 0x00000020, 'Shadow must be WS_EX_TRANSPARENT');
          assert.ok(shadow.exstyle & 0x08000000, 'Shadow must be WS_EX_NOACTIVATE');
          measurements.shadowWindow = shadow;
        }
        assert.deepEqual(ids(), before);
        assert.deepEqual(rendererPids(), pids);
        assert.equal(wc.isDestroyed(), false);
        assert.equal(parent.isVisible(), true);
        nativeWindowsVerified = true;
      });
    }
  );
  if (!nativeWindowsVerified) {
    limitations.push(
      'Interactive acceptance stopped because independent native HWND identity/ownership did not pass. No physical input is attempted past this gate.'
    );
    return;
  }
  await check('real native button, disabled button and toggle dispatch exact actions', async () => {
    await usingPanel(async (panel, events) => {
      await show(panel);
      await clickControl(panel, 'button');
      assert.ok(events.action.some((action) => action.id === 'button' && action.type === 'click'));
      const count = events.action.length;
      await clickControl(panel, 'disabled-button');
      assert.equal(events.action.length, count);
      await clickControl(panel, 'toggle');
      assert.equal(control(panel, 'toggle').checked, true);
      assert.ok(
        events.action.some((action) => action.id === 'toggle' && action.type === 'change' && action.value === true)
      );
    });
  });
  await check('native color palette updates actual painted panel pixels', async () => {
    await usingPanel(async (panel) => {
      await show(panel);
      panel.update({
        theme: {
          mode: 'dark',
          background: '#102030',
          text: '#DDEEFF',
          muted: '#8899AA',
          accent: '#4488FF',
          border: '#405060',
          fontFamily: 'Segoe UI',
          fontSize: 14
        }
      });
      await delay(120);
      const box = state(panel).contentBounds;
      const point = screen.dipToScreenPoint({ x: box.x + 5, y: box.y + 24 });
      const pixel = await native('pixel', point);
      assertRgbNear(pixel.rgb, [16, 32, 48]);
      measurements.nativeThemePixel = { point, ...pixel };
    });
  });
  await check(
    'system theme responds to process theme changes while native input, focus, scroll and HWND remain stable',
    async () => {
      const previous = nativeTheme.themeSource;
      try {
        nativeTheme.themeSource = 'light';
        await delay(120);
        await usingPanel(
          async (panel) => {
            await show(panel);
            const hwnd = (await nativePopup(panel)).hwnd;
            const listPoint = screenPoint(control(panel, 'list').bounds);
            await native('wheel', { hwnd, ...listPoint, delta: -1080 });
            await delay(80);
            const offset = control(panel, 'list').scrollOffset;
            assert.ok(offset > 0);
            await clickControl(panel, 'input');
            await typePanel(panel, 'theme draft');
            const focus = state(panel).focusedId;
            const sample = async () => {
              const body = state(panel).contentBounds;
              return native('pixel', screen.dipToScreenPoint({ x: body.x + 5, y: body.y + 24 }));
            };
            const light = await sample();
            await capturePanel(panel, 'light');
            nativeTheme.themeSource = 'dark';
            await delay(220);
            assert.equal(nativeTheme.shouldUseDarkColors, true);
            const dark = await sample();
            await capturePanel(panel, 'dark');
            assert.ok(
              dark.rgb.some((channel, index) => Math.abs(channel - light.rgb[index]) > 20),
              `Native system theme did not repaint: light=${light.rgb}, dark=${dark.rgb}`
            );
            assert.equal((await nativePopup(panel)).hwnd, hwnd);
            assert.equal(control(panel, 'input').value, 'theme draft');
            assert.equal(control(panel, 'list').scrollOffset, offset);
            assert.equal(state(panel).focusedId, focus);
            nativeTheme.themeSource = 'light';
            await delay(180);
            assertRgbNear((await sample()).rgb, light.rgb, 'System theme did not return to light');
            measurements.systemThemeHotUpdate = {
              light: light.rgb,
              dark: dark.rgb,
              hwnd,
              preservedInput: true,
              preservedScroll: offset
            };
          },
          { theme: 'system' }
        );
      } finally {
        nativeTheme.themeSource = previous;
      }
    }
  );
  await check(
    'Chinese Unicode native typing, input change and Enter submission do not enter the source page',
    async () => {
      await usingPanel(async (panel, events) => {
        await show(panel);
        await clickControl(panel, 'input');
        const pageBefore = await inspect("document.querySelector('#agent').value");
        await typePanel(panel, '中文输入 hello');
        assert.equal(control(panel, 'input').value, '中文输入 hello');
        await panelKey(panel, 13);
        assert.ok(
          events.action.some(
            (action) => action.id === 'input' && action.type === 'change' && action.value === '中文输入 hello'
          )
        );
        assert.ok(
          events.action.some(
            (action) => action.id === 'input' && action.type === 'submit' && action.value === '中文输入 hello'
          )
        );
        assert.equal(await inspect("document.querySelector('#agent').value"), pageBefore);
        measurements.unicodeInput =
          'Real Windows SendInput Unicode packets entered the native textfield; this does not claim IME composition.';
      });
    }
  );
  await check('native option keyboard selection emits the selected value and keyboard navigation works', async () => {
    await usingPanel(async (panel, events) => {
      await show(panel);
      await clickControl(panel, 'input');
      await panelKey(panel, 9);
      assert.equal(state(panel).focusedId, 'option');
      await panelKey(panel, 35);
      assert.equal(control(panel, 'option').value, 'second');
      assert.ok(
        events.action.some((action) => action.id === 'option' && action.type === 'change' && action.value === 'second'),
        JSON.stringify(events.action)
      );
      // A closed native Combobox handles End immediately; Enter opens its menu.
      // Reset with Home, then select the middle of three native menu rows using
      // the original OS mouse click. The last row is disabled.
      await panelKey(panel, 36);
      assert.equal(control(panel, 'option').value, 'first');
      const before = new Set(
        (await native('windows')).windows.filter((window) => window.visible).map((window) => window.hwnd)
      );
      await clickControl(panel, 'option');
      const popup = await nativePopup(panel);
      const menus = (await native('windows')).windows.filter((window) => window.visible && !before.has(window.hwnd));
      const menu = menus.find((window) => window.owner === popup.hwnd) || menus[0];
      assert.ok(menu, `Native option menu has no visible HWND: ${JSON.stringify(menus)}`);
      await capturePanel(panel, 'option-open', menu);
      const point = {
        x: Math.round(menu.bounds.x + menu.bounds.width / 2),
        y: Math.round(menu.bounds.y + menu.bounds.height / 2)
      };
      assert.equal((await native('hit', point)).root, menu.hwnd);
      const count = events.action.length;
      await native('click', { hwnd: menu.hwnd, ...point });
      await delay(100);
      assert.equal(control(panel, 'option').value, 'second');
      assert.ok(
        events.action
          .slice(count)
          .some((action) => action.id === 'option' && action.type === 'change' && action.value === 'second'),
        JSON.stringify(events.action)
      );
      measurements.optionSelection = {
        keyboard: 'second',
        mouse: control(panel, 'option').value,
        menu,
        actions: events.action
      };
      await clickControl(panel, 'input');
      await panelKey(panel, 9);
      assert.notEqual(state(panel).focusedId, 'input');
    });
  });
  await check('native text input enforces maxLength and explicit changed values can replace a draft', async () => {
    await usingPanel(async (panel) => {
      await show(panel);
      await clickControl(panel, 'input');
      await typePanel(panel, 'x'.repeat(100));
      assert.equal(control(panel, 'input').value, 'x'.repeat(80));
      const replacement = content();
      replacement.children.find((node) => node.id === 'input').value = 'reset';
      panel.update({ content: replacement });
      assert.equal(control(panel, 'input').value, 'reset');
    });
  });
  await check(
    'stable control IDs retain native HWND, draft input, focus and scroll during incremental refresh',
    async () => {
      await usingPanel(async (panel) => {
        await show(panel);
        const hwnd = (await nativePopup(panel)).hwnd;
        assert.equal(control(panel, 'list').bounds.height, 100, 'The native list did not retain its configured height');
        const listPoint = screenPoint(control(panel, 'list').bounds);
        await native('wheel', { hwnd, ...listPoint, delta: -1080 });
        await delay(120);
        const offset = control(panel, 'list').scrollOffset;
        assert.ok(offset > 0, `Native list did not scroll: ${offset}`);
        await clickControl(panel, 'input');
        await typePanel(panel, 'unsent draft');
        const focusedId = state(panel).focusedId;
        measurements.incrementalUpdateScroll = {
          afterWheel: offset,
          beforeUpdate: control(panel, 'list').scrollOffset
        };
        for (let i = 0; i < 8; i++) {
          const replacement = content();
          replacement.children[0].text = `Refresh ${i}`;
          replacement.children.find((node) => node.id === 'progress').value = i / 8;
          panel.update({
            content: replacement,
            theme: i % 2 ? 'dark' : { mode: 'light', accent: '#3184FF', fontSize: 13 },
            radius: 12,
            shadow: true
          });
        }
        await delay(120);
        measurements.incrementalUpdateScroll.afterUpdate = control(panel, 'list').scrollOffset;
        assert.equal((await nativePopup(panel)).hwnd, hwnd);
        assert.equal(control(panel, 'input').value, 'unsent draft');
        assert.equal(state(panel).focusedId, focusedId);
        assert.ok(
          Math.abs(control(panel, 'list').scrollOffset - offset) <= 1,
          `Native content scroll offset changed across update: ${offset} -> ${control(panel, 'list').scrollOffset}`
        );
      });
    }
  );
  await check('invalid updates are atomic across content, bounds, theme and active native state', async () => {
    await usingPanel(async (panel) => {
      await show(panel);
      await clickControl(panel, 'input');
      await typePanel(panel, 'atomic draft');
      const before = state(panel);
      const invalid = [
        null,
        undefined,
        { radius: -1 },
        { content: content(), theme: { accent: 'invalid' } },
        { anchorBounds: { x: 600, y: 100, width: -1, height: 5 }, theme: 'dark' },
        {
          theme: 'dark',
          content: { type: 'column', id: 'root', children: [{ type: 'text', id: 'root', text: 'duplicate' }] }
        },
        { shadow: false, theme: 'dark', bogus: 1 }
      ];
      for (const patch of invalid) {
        assert.throws(() => panel.update(patch));
        assert.deepEqual(state(panel), before);
      }
    });
  });
  await check(
    'live animation paints and Agent sequence continue while native panels are open and updating',
    async () => {
      await usingPanel(async (panel) => {
        await show(panel);
        const beforeFrames = await inspect('framesPainted');
        const beforeImage = await wc.capturePage({ x: 10, y: 360, width: 160, height: 100 });
        const snapshot = await wc.getAgentSnapshot();
        const target = snapshot.elements.find((element) => element.name === 'Page agent input').target;
        const steps = Array.from({ length: 21 }, (_, index) => ({
          kind: 'mouse',
          type: 'mouseMoved',
          atMs: index * 35,
          x: 450 + index,
          y: 250
        }));
        steps.push(
          ...Array.from('AGENT', (text, index) => ({ kind: 'key', type: 'char', atMs: 750 + index * 10, target, text }))
        );
        const job = wc.dispatchInputSequence(steps);
        job.catch(() => {}); // The result is awaited after the concurrent updates below.
        for (let index = 0; index < 7; index++) {
          panel.update({ theme: index % 2 ? 'light' : 'dark' });
          await delay(70);
        }
        const result = await job;
        assert.equal(result.status, 'completed', JSON.stringify(result));
        assert.equal(result.dispatchedCount, steps.length);
        const afterImage = await wc.capturePage({ x: 10, y: 360, width: 160, height: 100 });
        assert.ok((await inspect('framesPainted')) > beforeFrames + 3);
        assert.notEqual(
          crypto.createHash('sha256').update(beforeImage.toPNG()).digest('hex'),
          crypto.createHash('sha256').update(afterImage.toPNG()).digest('hex')
        );
        assert.ok((await inspect('pageEvents')).every((event) => event.trusted));
        assert.equal(await inspect("document.querySelector('#agent').value"), 'AGENT');
        measurements.concurrentSequence = result;
      });
    }
  );
  await check('native input and dismissal preserve real page-input protection while Agent input succeeds', async () => {
    await wc.setVirtualCursorEnabled(true, { blockRealPointer: true, blockRealKeyboard: true });
    try {
      await usingPanel(async (panel) => {
        await show(panel);
        await clickControl(panel, 'input');
        await typePanel(panel, 'panel-only');
        assert.equal(control(panel, 'input').value, 'panel-only');
        panel.hide();
        await delay(80);
        await inspect("document.querySelector('#agent').focus()");
        wc.focus();
        const before = await inspect("document.querySelector('#agent').value");
        await native('text', { hwnd: handleOf(parent), text: 'BLOCKED' });
        assert.equal(await inspect("document.querySelector('#agent').value"), before);
        const point = screen.dipToScreenPoint({
          x: parent.getContentBounds().x + 450,
          y: parent.getContentBounds().y + 155
        });
        const beforeClicks = await inspect('clicks');
        await native('click', { hwnd: handleOf(parent), ...point });
        assert.equal(await inspect('clicks'), beforeClicks);
        const result = await wc.dispatchInputSequence([{ kind: 'key', type: 'char', atMs: 0, text: 'A' }]);
        assert.equal(result.status, 'completed');
        assert.equal(await inspect("document.querySelector('#agent').value"), `${before}A`);
      });
    } finally {
      await wc.setVirtualCursorEnabled(false);
    }
  });
  await check('hide/show reuses native resources and destroy is idempotent with one closed event', async () => {
    const panel = makePanel();
    const events = eventsFor(panel);
    const before = ids();
    wc.focus();
    await inspect("document.querySelector('#agent').focus()");
    await show(panel);
    const hwnd = (await nativePopup(panel)).hwnd;
    for (let index = 0; index < 8; index++) {
      panel.hide();
      assert.equal(state(panel).visible, false);
      await show(panel);
    }
    assert.equal((await nativePopup(panel)).hwnd, hwnd);
    assert.equal(events.dismissed.length, 0);
    assert.deepEqual(ids(), before);
    panel.hide();
    await delay(60);
    assert.equal(wc.isFocused(), true, 'Programmatic hide did not restore source focus');
    assert.equal(await inspect('document.activeElement.id'), 'agent');
    panel.destroy();
    panel.destroy();
    assert.equal(events.closed, 1);
    assert.equal(state(panel).destroyed, true);
    assert.throws(() => panel.show({ anchorBounds: anchor() }));
    assert.throws(() => panel.update({ theme: 'dark' }));
    assert.equal(
      (await native('windows')).windows.some((win) => win.hwnd === hwnd),
      false
    );
  });
  await check(
    'Escape and outside click emit dismissal reasons and return focus without destroying the instance',
    async () => {
      await usingPanel(
        async (panel, events) => {
          wc.focus();
          await inspect("document.querySelector('#agent').focus()");
          await show(panel);
          await clickControl(panel, 'input');
          await panelKey(panel, 27);
          assert.equal(state(panel).visible, false);
          assert.ok(events.dismissed.some((event) => event.reason === 'escape'));
          assert.equal(state(panel).destroyed, false);
          assert.equal(wc.isFocused(), true, 'Escape did not restore source focus');
        },
        { dismissOnOutsideClick: true }
      );
      await usingPanel(
        async (panel, events) => {
          await show(panel);
          const point = screen.dipToScreenPoint({
            x: parent.getContentBounds().x + 560,
            y: parent.getContentBounds().y + 450
          });
          await native('click', { hwnd: handleOf(parent), ...point });
          await until(() => !state(panel).visible, 'Outside click did not dismiss');
          assert.ok(events.dismissed.some((event) => ['outside-click', 'blur'].includes(event.reason)));
          assert.equal(state(panel).destroyed, false);
        },
        { dismissOnOutsideClick: true }
      );
    }
  );
  await check('round corners pass OS hit testing to the visible underlying page', async () => {
    await usingPanel(async (panel) => {
      await show(panel);
      const popup = await nativePopup(panel);
      const box = state(panel).contentBounds;
      const corner = screen.dipToScreenPoint({ x: box.x + 1, y: box.y + 1 });
      const center = screenPoint(box);
      const cornerHit = await native('hit', corner);
      const centerHit = await native('hit', center);
      assert.notEqual(cornerHit.root, popup.hwnd, 'Rounded transparent corner intercepted the underlying page');
      assert.equal(centerHit.root, popup.hwnd);
      assert.equal(cornerHit.pid, process.pid);
      measurements.roundedHitTests = { cornerHit, centerHit };
    });
  });
  await check(
    'large custom corner radius clips child controls to the same rounded visible and input region',
    async () => {
      await usingPanel(
        async (panel) => {
          await show(panel);
          const popup = await nativePopup(panel);
          const button = control(panel, 'corner-button');
          const point = screen.dipToScreenPoint({ x: button.bounds.x + 15, y: button.bounds.y + 15 });
          const hit = await native('hit', point);
          const pixel = await native('pixel', point);
          assert.notEqual(hit.root, popup.hwnd);
          assertRgbNear(pixel.rgb, [21, 49, 77], 'A child control painted outside the rounded panel body');
          measurements.largeRadiusCorner = { point, hit, ...pixel };
        },
        {
          radius: 160,
          shadow: false,
          content: {
            type: 'column',
            id: 'round-root',
            width: 320,
            height: 320,
            children: [{ type: 'button', id: 'corner-button', text: 'Clipped native control', height: 80 }]
          }
        }
      );
    }
  );
  await check('parent movement, hide and minimize follow owner without leaving orphan popups', async () => {
    await usingPanel(async (panel, events) => {
      await show(panel);
      const before = state(panel).bounds;
      const previous = parent.getBounds();
      parent.setPosition(previous.x + 35, previous.y + 25);
      await delay(120);
      const after = state(panel).bounds;
      assert.equal(after.x - before.x, 35);
      assert.equal(after.y - before.y, 25);
      parent.hide();
      await until(() => !state(panel).visible, 'Panel remained visible after parent hide');
      assert.ok(events.dismissed.some((event) => event.reason === 'parent-hidden'));
      parent.show();
      parent.focus();
      await show(panel);
      parent.minimize();
      await until(() => !state(panel).visible, 'Panel remained visible after parent minimize');
      parent.restore();
      parent.show();
      parent.setBounds(previous);
      await delay(100);
    });
  });
  await check(
    'transparent corners and shadow outside the parent pass real clicks to a separate test process',
    async () => {
      const underlay = await createUnderlay();
      try {
        await usingPanel(
          async (panel, events) => {
            const parentBounds = parent.getBounds();
            await show(panel, {
              anchorBounds: {
                x: parentBounds.x + parentBounds.width - 45,
                y: parentBounds.y + 15,
                width: 24,
                height: 24
              }
            });
            const body = state(panel).contentBounds;
            assert.ok(
              body.x + body.width - 1 > parentBounds.x + parentBounds.width,
              'The rounded test corner must be outside the parent'
            );
            const physical = screen.dipToScreenRect(null, {
              x: parentBounds.x + parentBounds.width + 1,
              y: body.y - 30,
              width: Math.max(100, body.x + body.width - parentBounds.x - parentBounds.width + 60),
              height: body.height + 80
            });
            await underlay.request('show', { bounds: physical });
            panel.hide();
            await show(panel, {
              anchorBounds: {
                x: parentBounds.x + parentBounds.width - 45,
                y: parentBounds.y + 15,
                width: 24,
                height: 24
              }
            });
            const popup = await nativePopup(panel);
            const corners = [
              { x: body.x + body.width - 1, y: body.y + 1 },
              { x: body.x + body.width + 5, y: body.y + body.height / 2 }
            ];
            for (const corner of corners) {
              const point = screen.dipToScreenPoint({ x: Math.round(corner.x), y: Math.round(corner.y) });
              await native('click', { hwnd: popup.hwnd, ...point, allowedPids: [underlay.pid] });
            }
            await delay(100);
            const observed = await underlay.request('stats');
            assert.equal(
              observed.clicks,
              corners.length,
              `Cross-process underlay did not receive original OS clicks: ${JSON.stringify(observed)}`
            );
            assert.equal(events.action.length, 0);
            measurements.crossProcessHitTesting = { underlayPid: underlay.pid, hwnd: underlay.hwnd, ...observed };
          },
          {
            dismissOnOutsideClick: false,
            content: {
              type: 'column',
              id: 'cross-root',
              width: 320,
              padding: 12,
              children: [{ type: 'button', id: 'cross-button', text: 'Native panel remains interactive' }]
            }
          }
        );
      } finally {
        await underlay.stop();
        parent.focus();
      }
    }
  );
  await check('screen-edge placement is constrained on every connected display', async () => {
    await usingPanel(async (panel) => {
      for (const display of screen.getAllDisplays()) {
        const work = display.workArea;
        parent.setPosition(work.x + 40, work.y + 40);
        const corners = [
          { x: work.x + 1, y: work.y + 1 },
          { x: work.x + work.width - 3, y: work.y + 1 },
          { x: work.x + 1, y: work.y + work.height - 3 },
          { x: work.x + work.width - 3, y: work.y + work.height - 3 }
        ];
        for (const corner of corners) {
          await show(panel, { anchorBounds: { ...corner, width: 2, height: 2 } });
          const bounds = state(panel).bounds;
          const actualWindow = await nativePopup(panel);
          (measurements.edgePlacements ||= []).push({
            displayId: display.id,
            work,
            bounds,
            contentBounds: state(panel).contentBounds,
            nativeBounds: actualWindow.bounds,
            anchorBounds: state(panel).anchorBounds
          });
          assert.ok(bounds.x >= work.x - 1 && bounds.y >= work.y - 1, JSON.stringify({ work, bounds }));
          assert.ok(bounds.x + bounds.width <= work.x + work.width + 1, JSON.stringify({ work, bounds }));
          assert.ok(bounds.y + bounds.height <= work.y + work.height + 1, JSON.stringify({ work, bounds }));
        }
      }
      parent.setPosition(130, 100);
    });
  });
  await check(
    'new document and same-URL reload invalidate old panel instances and suppress stale actions',
    async () => {
      for (const reload of [false, true]) {
        const panel = makePanel();
        const events = eventsFor(panel);
        await show(panel);
        const pending = new Promise((resolve) => wc.once('did-finish-load', resolve));
        if (reload) wc.reload();
        else wc.loadURL(`${origin}/next`).catch(() => {});
        await pending;
        assert.equal(state(panel).destroyed, true);
        assert.equal(events.closed, 1);
        assert.throws(() => panel.show({ anchorBounds: anchor() }));
        assert.equal(events.action.length, 0);
      }
    }
  );
  await check('same-document main-frame navigation invalidates stale controls without reloading the page', async () => {
    const panel = makePanel();
    const events = eventsFor(panel);
    await show(panel);
    await inspect("location.hash='native-panel-same-document'");
    await until(() => state(panel).destroyed, 'Main-frame same-document navigation did not invalidate the panel');
    assert.equal(events.closed, 1);
    assert.equal(events.action.length, 0);
  });
  await check('source host transfer invalidates the old owner and permits a fresh panel in the new owner', async () => {
    const other = addWindow({ x: 200, y: 140 });
    const panel = makePanel();
    const events = eventsFor(panel);
    await show(panel);
    try {
      parent.contentView.removeChildView(view);
      other.contentView.addChildView(view);
      await until(() => state(panel).destroyed, 'Moved source did not invalidate the original panel');
      assert.equal(events.closed, 1);
      assert.throws(() => new NativePanel({ parent, sourceWebContents: wc, content: content() }));
      const fresh = makePanel({ parent: other });
      fresh.destroy();
    } finally {
      other.contentView.removeChildView(view);
      parent.contentView.addChildView(view);
      other.destroy();
    }
  });
  await check('source destruction and renderer loss invalidate the bound native panel', async () => {
    for (const crash of [false, true]) {
      const temporary = await transientSource();
      const events = eventsFor(temporary.panel);
      try {
        if (crash) temporary.contents.forcefullyCrashRenderer();
        else temporary.contents.close();
        await until(() => state(temporary.panel).destroyed, 'Source loss did not destroy the native panel', 4000);
        assert.equal(events.closed, 1);
      } finally {
        if (!temporary.contents.isDestroyed()) temporary.contents.close();
        await until(() => temporary.contents.isDestroyed(), 'Temporary source did not finish closing');
        temporary.win.destroy();
      }
    }
  });
  await check('parent destruction releases native panel resources and emits closed once', async () => {
    const temporary = await transientSource();
    const events = eventsFor(temporary.panel);
    temporary.win.show();
    temporary.panel.show({ anchorBounds: { x: 200, y: 180, width: 24, height: 24 } });
    await delay(100);
    temporary.win.destroy();
    assert.equal(state(temporary.panel).destroyed, true);
    assert.equal(events.closed, 1);
    temporary.panel.destroy();
    assert.equal(events.closed, 1);
    if (!temporary.contents.isDestroyed()) temporary.contents.close();
    await until(() => temporary.contents.isDestroyed(), 'Parent-destroyed source did not finish closing');
  });
  await check('PageInfo validates committed origin, host and arguments and uses live HTTP security state', async () => {
    for (const options of [
      undefined,
      null,
      {},
      { anchorBounds: {} },
      { anchorBounds: { ...anchor(), width: -1 } },
      { anchorBounds: anchor(), siteUrl: 1 },
      { anchorBounds: anchor(), siteUrl: 'not a URL' },
      { anchorBounds: anchor(), siteUrl: 'https://different.invalid/' }
    ]) {
      assert.throws(() => wc.showPageInfoDialog(options));
    }
    const info = wc._getPageInfo();
    assert.equal(info.origin, origin);
    assert.equal(info.securityState, 'insecure');
    assert.equal(info.ownerWindowId, parent.id);
    assert.ok(info.documentId);
    assert.ok(info.entryId);
    const before = ids();
    const panel = await pageInfo({ siteUrl: `${origin}/any-same-origin-path` });
    assert.deepEqual(ids(), before);
    assert.equal(state(panel).visible, true);
    measurements.httpPageInfo = info;
    panel.destroy();
    const unattached = new WebContentsView();
    await unattached.webContents.loadURL(`${origin}/unattached`);
    assert.throws(() => unattached.webContents.showPageInfoDialog({ anchorBounds: anchor() }));
    const unattachedContents = unattached.webContents;
    unattachedContents.close();
    await until(() => unattachedContents.isDestroyed(), 'Unattached source did not finish closing');
    assert.throws(() => unattachedContents.showPageInfoDialog({ anchorBounds: anchor() }));
  });
  await check('PageInfo website settings emits the committed page identity through a real native button', async () => {
    const received = [];
    const listener = (event, details) => received.push({ eventSender: event.sender.id, ...details });
    wc.on('page-info-open-site-settings', listener);
    try {
      const panel = await pageInfo();
      await capturePanel(panel, 'page-info');
      assert.ok(
        control(panel, 'page-info-site-settings').bounds.height >= 30,
        'Website settings button was clipped by native layout'
      );
      await clickControl(panel, 'page-info-site-settings');
      assert.equal(received.length, 1);
      assert.equal(received[0].origin, origin);
      assert.equal(received[0].url, wc.getURL());
      assert.equal(received[0].eventSender, wc.id);
      assert.equal(state(panel).destroyed, true);
    } finally {
      wc.removeListener('page-info-open-site-settings', listener);
    }
  });
  await check('PageInfo reads the last committed page while a different navigation is pending', async () => {
    const committed = wc.getURL();
    const started = new Promise((resolve) => wc.once('did-start-loading', resolve));
    const pending = wc.loadURL(`${origin}/pending`).catch(() => {});
    await started;
    try {
      const info = wc._getPageInfo();
      assert.equal(info.url, committed);
      assert.equal(info.origin, origin);
      const panel = await pageInfo({ siteUrl: committed });
      assert.equal(state(panel).visible, true);
      panel.destroy();
      measurements.pendingNavigationPageInfo = { committed, pendingUrl: `${origin}/pending`, observed: info.url };
    } finally {
      wc.stop();
      await pending;
    }
  });
  await check('PageInfo navigation/reload and transfer destroy old dialogs without a settings event', async () => {
    const received = [];
    const listener = (...args) => received.push(args);
    wc.on('page-info-open-site-settings', listener);
    try {
      for (const reload of [false, true]) {
        const panel = await pageInfo();
        const pending = new Promise((resolve) => wc.once('did-finish-load', resolve));
        if (reload) wc.reload();
        else wc.loadURL(`${origin}/page-info-new`).catch(() => {});
        await pending;
        assert.equal(state(panel).destroyed, true);
      }
      const panel = await pageInfo();
      const other = addWindow();
      try {
        parent.contentView.removeChildView(view);
        other.contentView.addChildView(view);
        await until(() => state(panel).destroyed, 'PageInfo survived host transfer');
      } finally {
        other.contentView.removeChildView(view);
        parent.contentView.addChildView(view);
        other.destroy();
      }
      assert.equal(received.length, 0);
    } finally {
      wc.removeListener('page-info-open-site-settings', listener);
    }
  });
  await check('PageInfo permission checks are labeled host policy and cannot race a replaced document', async () => {
    const checks = [];
    wc.session.setPermissionCheckHandler((contents, permission, requestedOrigin) => {
      checks.push({ contentsId: contents.id, permission, requestedOrigin });
      return permission === 'geolocation';
    });
    try {
      const info = wc._getPageInfo();
      assert.ok(
        info.permissions.some(
          (permission) => permission.id === 'geolocation' && permission.allowed && permission.source === 'host-check'
        )
      );
      assert.ok(checks.length > 0);
      assert.ok(checks.every((check) => check.contentsId === wc.id));
      measurements.permissionPageInfo = info.permissions;
      let raced = false;
      wc.session.setPermissionCheckHandler(() => {
        if (!raced) {
          raced = true;
          wc.loadURL(`${origin}/permission-race`).catch(() => {});
        }
        return true;
      });
      assert.throws(() => wc.showPageInfoDialog({ anchorBounds: anchor() }));
      await until(() => !wc.isLoading(), 'Permission navigation did not finish');
    } finally {
      wc.session.setPermissionCheckHandler(null);
    }
  });

  const chineseLayouts = originalDesktop.imeLayouts.filter((layout) => (layout & 0x3ff) === 4);
  if (!chineseLayouts.length) {
    limitations.push(
      'No Chinese IME is installed in the active Windows session; candidate UI and composition Escape remain unverified. Unicode Chinese native typing was tested separately.'
    );
  } else {
    await check('installed Chinese IME composes native text and first Escape is reserved for composition', async () => {
      await usingPanel(async (panel, events) => {
        await show(panel);
        await clickControl(panel, 'input');
        const popup = await nativePopup(panel);
        const layout = await native('ime', { hwnd: popup.hwnd, layout: chineseLayouts[0], keys: 'nihao' });
        try {
          assert.equal(layout.activeLayout, chineseLayouts[0]);
          assert.equal(
            control(panel, 'input').composing,
            true,
            'Configured Chinese IME did not start a real native composition'
          );
          panel.update({ content: content(), theme: 'dark' });
          assert.equal(control(panel, 'input').composing, true, 'Incremental native update lost IME composition');
          await panelKey(panel, 27);
          assert.equal(state(panel).visible, true, 'Composition Escape dismissed the native panel');
          assert.equal(events.dismissed.length, 0);
          await native('ime', { hwnd: popup.hwnd, layout: chineseLayouts[0], keys: 'nihao' });
          await panelKey(panel, 32);
          await delay(100);
          assert.match(control(panel, 'input').value, /[\u3400-\u9fff]/, 'IME did not commit Chinese text');
          measurements.realIme = { layout: chineseLayouts[0], value: control(panel, 'input').value };
        } finally {
          await native('layout', { hwnd: popup.hwnd, layout: layout.oldLayout });
        }
      });
    });
  }

  const certDir = path.resolve(__dirname, '../../spec/fixtures/certificates');
  if (fs.existsSync(path.join(certDir, 'server.pem'))) {
    await check('PageInfo exposes actual TLS certificate and preserves verification errors', async () => {
      secureServer = https.createServer(
        {
          key: fs.readFileSync(path.join(certDir, 'server.key')),
          cert: fs.readFileSync(path.join(certDir, 'server.pem'))
        },
        (request, response) => response.end(fixture)
      );
      await new Promise((resolve) => secureServer.listen(0, '127.0.0.1', resolve));
      secureOrigin = `https://127.0.0.1:${secureServer.address().port}`;
      const onCertificateError = (event, contents, url, error, certificate, callback) => {
        if (contents === wc && url.startsWith(secureOrigin)) {
          event.preventDefault();
          callback(true);
        }
      };
      app.on('certificate-error', onCertificateError);
      try {
        const trustedView = new WebContentsView({
          webPreferences: { sandbox: true, partition: 'native-panel-trusted-tls' }
        });
        parent.contentView.addChildView(trustedView);
        trustedView.setBounds({ x: 490, y: 400, width: 80, height: 60 });
        trustedView.webContents.session.setCertificateVerifyProc((_request, callback) => callback(0));
        try {
          await trustedView.webContents.loadURL(`${secureOrigin}/host-verified`);
          const verified = trustedView.webContents._getPageInfo();
          assert.equal(verified.securityState, 'secure');
          assert.equal(verified.certificateStatus, 0);
          assert.ok(verified.certificate?.fingerprint && verified.protocol && verified.cipher);
          measurements.hostVerifiedTlsPageInfo = verified;
        } finally {
          trustedView.webContents.session.setCertificateVerifyProc(null);
          parent.contentView.removeChildView(trustedView);
          trustedView.webContents.close();
        }
        await wc.loadURL(secureOrigin);
        const info = wc._getPageInfo();
        assert.ok(info.certificate && info.certificate.fingerprint);
        assert.equal(info.securityState, 'certificate-error');
        assert.ok(info.certificateStatus !== 0);
        assert.ok(info.protocol);
        assert.ok(info.cipher);
        measurements.tlsPageInfo = info;
        const panel = await pageInfo();
        assert.equal(state(panel).visible, true);
        panel.destroy();
      } finally {
        app.removeListener('certificate-error', onCertificateError);
        await wc.loadURL(`${origin}/`);
      }
    });
  } else limitations.push('TLS certificate fixture was unavailable; TLS certificate and error-state case was not run.');

  await check('all panel-created native resources are released without WebContents leaks', async () => {
    for (const panel of panels) panel.destroy();
    await delay(100);
    assert.deepEqual(ids(), [wc.id]);
    const popups = (await native('windows')).windows.filter((win) => win.visible && win.owner === handleOf(parent));
    assert.equal(popups.length, 0, JSON.stringify(popups));
    const leaked = (await native('windows')).windows.filter((win) => panelNativeHandles.has(win.hwnd));
    assert.equal(leaked.length, 0, `Panel/shadow native handles leaked: ${JSON.stringify(leaked)}`);
  });
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) results.push({ name: 'probe setup/completion', ok: false, error: error.stack });
  for (const panel of panels) {
    try {
      panel.destroy();
    } catch {}
  }
  for (const win of windows) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {}
  }
  try {
    if (wc && !wc.isDestroyed()) wc.close();
  } catch {}
  try {
    if (originalDesktop) await native('restore', originalDesktop);
  } catch {}
  server.closeAllConnections();
  server.close();
  if (secureServer) {
    secureServer.closeAllConnections();
    secureServer.close();
  }
  const failed = results.filter((result) => !result.ok);
  const report = {
    suite: 'native-panels',
    startedAtUtc: process.env.NATIVE_PANELS_STARTED_UTC,
    completedAtUtc: new Date().toISOString(),
    executable: process.execPath,
    executableSha256: process.env.NATIVE_PANELS_BINARY_SHA256,
    versions: process.versions,
    arch: process.arch,
    platform: process.platform,
    summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    results,
    measurements,
    limitations
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary));
  app.exit(failed.length ? 1 : 0);
}
app.on('window-all-closed', () => {});
app
  .whenReady()
  .then(main)
  .then(() => finish())
  .catch(finish);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
