/* Real native UI acceptance and screenshots. Run with the newly built Electron. */
const {
  app,
  BrowserWindow,
  NativePanel,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  systemPreferences,
  webContents
} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.env.NATIVE_UI_OUTPUT;
assert.ok(output, 'An explicit output directory is required');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-native-ui-')));
app.commandLine.appendSwitch('lang', process.env.NATIVE_UI_LANG || 'zh-CN');
if (process.env.NATIVE_UI_FORCE_HIGH_CONTRAST === '1') app.commandLine.appendSwitch('force-high-contrast');
const results = [];
const screenshots = {};
const panels = [];
const registeredPreloads = [];
const menuIcons = new Map();
let parent;
let server;
let originalDesktop;
let activeMenu;
let snapshot;
const originalShow = NativePanel.prototype.show;
app.on('window-all-closed', () => {});
NativePanel.prototype.show = function (...args) {
  if (!panels.includes(this)) panels.push(this);
  return originalShow.apply(this, args);
};

async function native(action, options = {}) {
  // Chromium hosts Windows shell dialogs in a child utility process.
  const allowedPids = app.isReady()
    ? app
        .getAppMetrics()
        .filter((p) => p.type === 'Utility' && p.serviceName === 'chrome.mojom.UtilWin')
        .map((p) => p.pid)
    : [];
  const { stdout } = await run(
    process.env.NATIVE_UI_PYTHON,
    [
      path.join(__dirname, 'native-panels-win.py'),
      Buffer.from(JSON.stringify({ action, pid: process.pid, allowedPids, ...options })).toString('base64')
    ],
    { windowsHide: true, timeout: 15000 }
  );
  return JSON.parse(stdout);
}
async function check(name, fn) {
  if (process.env.NATIVE_UI_FILTER && !new RegExp(process.env.NATIVE_UI_FILTER).test(name)) return;
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
    console.error(error.stack);
  }
  console.log(name, results.at(-1).ok ? 'PASS' : 'FAIL');
}
function image(name) {
  if (menuIcons.has(name)) return menuIcons.get(name);
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'native-ui', `${name}.png`));
}
async function loadMenuIcons(wc) {
  // Rasterize repo-native SVG test assets in the existing host renderer. Menus
  // receive ordinary NativeImage objects and do not create a WebContents.
  for (const name of [
    'minus',
    'plus',
    'reload',
    'home',
    'sliders',
    'forward',
    'download',
    'settings',
    'popout',
    'split'
  ]) {
    const original = fs.readFileSync(path.join(__dirname, 'assets', 'native-ui', `${name}.svg`), 'utf8');
    for (const variant of ['', '-dark', '-disabled', '-dark-disabled']) {
      const color = variant.includes('disabled')
        ? variant.includes('dark')
          ? '#68686B'
          : '#BEBDBE'
        : variant.includes('dark')
          ? '#D1CFCA'
          : undefined;
      const svg = color ? original.replace(/#[0-9A-Fa-f]{6}/g, color) : original;
      const source = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
      const data = await wc.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 72;
      canvas.getContext('2d').drawImage(image, 0, 0, 72, 72);
      return canvas.toDataURL('image/png');
    })()`);
      menuIcons.set(name + variant, nativeImage.createFromDataURL(data));
    }
  }
}
function text(id, value, extra = {}) {
  return { type: 'text', id, text: value, singleLine: true, ...extra };
}
function iconButton(id, name, accessibleName, extra = {}) {
  return {
    type: 'iconButton',
    id,
    image: image(name),
    accessibleName,
    tooltip: accessibleName,
    width: 30,
    height: 30,
    ...extra
  };
}
function panelState(panel) {
  return panel._getState();
}
function node(panel, id) {
  const found = panelState(panel).controls.find((control) => control.id === id);
  assert.ok(found, id);
  return found;
}
function handle(parentWindow = parent) {
  const b = parentWindow.getNativeWindowHandle();
  return Number(b.length === 8 ? b.readBigUInt64LE() : b.readUInt32LE());
}
function physicalPoint(point) {
  // Use the owning HWND's DPI explicitly, including for non-activating panels.
  const rect = screen.dipToScreenRect(parent, { ...point, width: 1, height: 1 });
  return { x: rect.x, y: rect.y };
}
function anchor(x = 480, y = 88) {
  const b = parent.getContentBounds();
  return { x: b.x + x, y: b.y + y, width: 24, height: 1 };
}
function newPanel(content, options = {}) {
  return new NativePanel({
    parent,
    content,
    theme: { mode: 'light', fontSize: 13, background: '#FFFEFF', text: '#171717', muted: '#8C8C8C', border: '#E4E4E4' },
    radius: 16,
    dismissOnOutsideClick: false,
    ...options
  });
}
async function show(panel, x, y) {
  panel.show({ anchorBounds: anchor(x, y), placement: 'bottom-start' });
  await delay(240);
}
async function click(panel, id) {
  const state = panelState(panel);
  const bounds = node(panel, id).bounds;
  const point = physicalPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  });
  const body = state.contentBounds;
  const hit = await native('hit', point);
  (snapshot.pointerChecks ??= []).push({ id, point, expected: Number(state.windowHandle), hit });
  assert.equal(hit.root, Number(state.windowHandle), `Click target must be inside native control ${id}`);
  await native('click', {
    hwnd: Number(state.windowHandle),
    ...point,
    activationPoint: physicalPoint({ x: body.x + 4, y: body.y + 24 })
  });
  await delay(80);
}
async function key(panel, vk, modifiers = []) {
  const result = await native('key', { hwnd: Number(panelState(panel).windowHandle), vk, modifiers });
  await delay(80);
  return result;
}
async function typeText(panel, value) {
  await native('text', { hwnd: Number(panelState(panel).windowHandle), text: value });
  await delay(80);
}
async function repeatKey(panel, vk, repeat, modifiers = []) {
  const result = await native('key', { hwnd: Number(panelState(panel).windowHandle), vk, repeat, modifiers });
  await delay(80);
  return result;
}
async function capturePanel(panel, name) {
  await delay(240);
  const state = panelState(panel);
  const file = path.join(output, `${name}.png`);
  await native('screenshot', {
    hwnd: Number(state.windowHandle),
    bounds: screen.dipToScreenRect(parent, state.contentBounds),
    path: file
  });
  screenshots[name] = { path: file, state };
}
function blueFocusPixel(rgb) {
  return rgb[2] > rgb[0] + 25 && rgb[2] > rgb[1] + 12;
}
function nearPixel(actual, expected, tolerance = 20) {
  return actual.every((channel, i) => Math.abs(channel - expected[i]) <= tolerance);
}
async function tabTo(panel, id) {
  for (let step = 0; step < 12; step++) {
    if (panelState(panel).focusedId === id) return;
    await key(panel, 0x09);
  }
  assert.equal(panelState(panel).focusedId, id, 'Physical Tab reaches ' + id);
}
async function observeFocusRing(panel, id, name) {
  // Capture first so an old binary without diagnostics still leaves physical
  // evidence of its clipped outline before the pixel assertion fails.
  const initial = panelState(panel);
  await native('move', {
    hwnd: Number(initial.windowHandle),
    ...physicalPoint({ x: initial.contentBounds.x + initial.contentBounds.width / 2, y: initial.contentBounds.y + 4 }),
    keepCursor: true
  });
  await capturePanel(panel, name);
  const state = panelState(panel);
  const control = node(panel, id);
  const bounds = screen.dipToScreenRect(parent, control.bounds);
  const body = screen.dipToScreenRect(parent, state.contentBounds);
  const scale = screen.getDisplayMatching(control.bounds).scaleFactor;
  const bodyMargin = Math.ceil(2 * scale);
  const insideBody = (point) =>
    point.x >= body.x + bodyMargin &&
    point.x < body.x + body.width - bodyMargin &&
    point.y >= body.y + bodyMargin &&
    point.y < body.y + body.height - bodyMargin;
  const edges = {};
  const points = [];
  for (const side of ['top', 'right', 'bottom', 'left']) {
    edges[side] = [];
    for (let depth = -Math.ceil(4 * scale); depth <= Math.ceil(6 * scale); depth++) {
      const point =
        side === 'top'
          ? { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + depth }
          : side === 'bottom'
            ? { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + bounds.height - 1 - depth }
            : side === 'left'
              ? { x: bounds.x + depth, y: bounds.y + Math.floor(bounds.height / 2) }
              : { x: bounds.x + bounds.width - 1 - depth, y: bounds.y + Math.floor(bounds.height / 2) };
      if (!insideBody(point)) continue;
      edges[side].push({ index: points.length, depth });
      points.push(point);
    }
  }
  const cornerInset = Math.max(1, Math.round(1.5 * scale));
  const corners = [
    { x: bounds.x + cornerInset, y: bounds.y + cornerInset },
    { x: bounds.x + bounds.width - 1 - cornerInset, y: bounds.y + cornerInset },
    { x: bounds.x + cornerInset, y: bounds.y + bounds.height - 1 - cornerInset },
    { x: bounds.x + bounds.width - 1 - cornerInset, y: bounds.y + bounds.height - 1 - cornerInset }
  ].map((point) => {
    point.x = Math.max(body.x + bodyMargin, Math.min(point.x, body.x + body.width - bodyMargin - 1));
    point.y = Math.max(body.y + bodyMargin, Math.min(point.y, body.y + body.height - bodyMargin - 1));
    assert.ok(insideBody(point), 'Rounded-corner observation belongs to the panel HWND');
    const index = points.length;
    points.push(point);
    return index;
  });
  // At radius 4 this crosses the straight left edge; at radius 14 it lies
  // outside the rounded arc. The image itself starts below this probe.
  const curve = [];
  for (let depth = 0; depth <= Math.floor(2.5 * scale); depth++) {
    const point = { x: bounds.x + depth, y: bounds.y + Math.round(7 * scale) };
    if (!insideBody(point)) continue;
    curve.push(points.length);
    points.push(point);
  }
  const { pixels } = await native('pixels', { hwnd: Number(state.windowHandle), points });
  const topBlue = edges.top.map(({ index }) => pixels[index]).filter((pixel) => blueFocusPixel(pixel.rgb));
  topBlue.sort((a, b) => b.rgb[2] - b.rgb[0] - (a.rgb[2] - a.rgb[0]));
  const reference = topBlue[0]?.rgb;
  return {
    id,
    name,
    bounds: control.bounds,
    scale,
    focusedId: state.focusedId,
    focusRing: control.focusRing,
    reference,
    edges: Object.fromEntries(
      Object.entries(edges).map(([side, entries]) => [
        side,
        entries.map(({ index, depth }) => ({ ...pixels[index], depth }))
      ])
    ),
    corners: corners.map((index) => pixels[index]),
    curve: curve.map((index) => pixels[index])
  };
}
function assertCompleteFocusRing(observation) {
  const { id, name, bounds, reference, focusRing } = observation;
  assert.equal(observation.focusedId, id, name + ': the real native control retains focus');
  assert.ok(reference, name + ': a blue top edge must remain visible');
  for (const [side, pixels] of Object.entries(observation.edges)) {
    assert.ok(
      pixels.some((pixel) => pixel.depth >= 0 && nearPixel(pixel.rgb, reference)),
      name + ': the ' + side + ' focus edge must be painted inside the control, matching ' + JSON.stringify(reference)
    );
  }
  for (const corner of observation.corners) {
    assert.ok(!nearPixel(corner.rgb, reference, 30), name + ': the rounded corner remains background, not blue');
  }
  assert.ok(focusRing?.visible, name + ': the native focus ring is visible');
  assert.equal(focusRing.haloInset, 1);
  assert.equal(focusRing.haloThickness, 2);
  for (const side of ['x', 'y']) assert.ok(focusRing.bounds[side] >= bounds[side] - 1, name + ': inner ring origin');
  assert.ok(focusRing.bounds.x + focusRing.bounds.width <= bounds.x + bounds.width + 1, name + ': inner ring right');
  assert.ok(focusRing.bounds.y + focusRing.bounds.height <= bounds.y + bounds.height + 1, name + ': inner ring bottom');
}
async function focusRingChecks(wc) {
  await check(
    'focus ring: full-width rows retain four pixel edges with mouse, Tab, arrows and activation in light/dark',
    async () => {
      const observations = [];
      const tree = () => ({
        type: 'column',
        id: 'focus-rows',
        width: 320,
        gap: 0,
        children: [
          text('focus-heading', 'Native focus outline', { height: 28 }),
          ...['first', 'second'].map((name) => ({
            type: 'item',
            id: 'focus-' + name,
            height: 48,
            style: { radius: 8, paddingLeft: 12, paddingRight: 12 },
            children: [text('focus-' + name + '-label', name)]
          }))
        ]
      });
      for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        const p = newPanel(tree(), { contentInset: 0, radius: 0, shadow: false, theme: noteTheme(dark) });
        const actions = [];
        p.on('action', (action) => actions.push(action));
        try {
          await show(p, 180, 140);
          await click(p, 'focus-second');
          await capturePanel(p, `focus-rows-${theme}-before`);
          const initialClicks = actions.length;
          await click(p, 'focus-first');
          await click(p, 'focus-first');
          assert.equal(actions.length, initialClicks + 2, 'Repeated physical clicks still activate the focused row');
          observations.push(await observeFocusRing(p, 'focus-first', `focus-rows-${theme}-mouse`));
          await key(p, 0x09);
          assert.equal(panelState(p).focusedId, 'focus-second');
          observations.push(await observeFocusRing(p, 'focus-second', `focus-rows-${theme}-tab`));
          await key(p, 0x26);
          assert.equal(panelState(p).focusedId, 'focus-first');
          await key(p, 0x28);
          assert.equal(panelState(p).focusedId, 'focus-second');
          const beforeKeys = actions.length;
          await key(p, 0x0d);
          await key(p, 0x20);
          assert.equal(actions.length, beforeKeys + 2, 'Enter and Space retain native row activation');
          assert.ok(actions.every((action) => action.type === 'click'));
        } finally {
          p.destroy();
        }
      }
      snapshot.focusRows = observations;
      observations.forEach(assertCompleteFocusRing);
    }
  );
  await check(
    'focus ring: icon button radius updates retain rounded pixels, focus and keyboard activation',
    async () => {
      const observations = [];
      const tree = (radius) => ({
        type: 'column',
        id: 'focus-icons',
        width: 180,
        padding: 12,
        gap: 8,
        children: [
          { type: 'button', id: 'focus-before', text: 'Before', height: 28 },
          {
            type: 'row',
            id: 'focus-icon-row',
            height: 48,
            children: [
              iconButton('focus-icon', 'settings', 'Native icon focus', {
                width: 48,
                height: 48,
                tooltip: '',
                style: { radius }
              })
            ]
          },
          { type: 'button', id: 'focus-after', text: 'After', height: 28 }
        ]
      });
      const p = newPanel(tree(4), { theme: noteTheme() });
      const actions = [];
      p.on('action', (action) => actions.push(action));
      try {
        await show(p, 180, 140);
        const hwnd = panelState(p).windowHandle;
        for (const dark of [false, true]) {
          const theme = dark ? 'dark' : 'light';
          p.update({ content: tree(4), theme: noteTheme(dark) });
          await tabTo(p, 'focus-before');
          await capturePanel(p, `focus-icon-${theme}-before`);
          await key(p, 0x09);
          assert.equal(panelState(p).focusedId, 'focus-icon');
          const small = await observeFocusRing(p, 'focus-icon', `focus-icon-${theme}-radius-4`);
          p.update({ content: tree(14) });
          assert.equal(panelState(p).windowHandle, hwnd);
          assert.equal(panelState(p).focusedId, 'focus-icon');
          const large = await observeFocusRing(p, 'focus-icon', `focus-icon-${theme}-radius-14`);
          observations.push({ theme, small, large });
          const beforeClicks = actions.filter((action) => action.id === 'focus-icon').length;
          await click(p, 'focus-icon');
          await click(p, 'focus-icon');
          await key(p, 0x0d);
          await key(p, 0x20);
          assert.equal(actions.filter((action) => action.id === 'focus-icon').length, beforeClicks + 4);
          await key(p, 0x09);
          assert.equal(panelState(p).focusedId, 'focus-after');
          await key(p, 0x09, [0x10]);
          assert.equal(panelState(p).focusedId, 'focus-icon');
        }
      } finally {
        p.destroy();
      }
      snapshot.focusIcons = observations;
      for (const { theme, small, large } of observations) {
        assertCompleteFocusRing(small);
        assertCompleteFocusRing(large);
        assert.ok(
          small.curve.some((pixel) => nearPixel(pixel.rgb, small.reference)),
          theme + ': radius 4 has a straight edge at 7 DIP'
        );
        assert.ok(
          large.curve.every((pixel) => !nearPixel(pixel.rgb, large.reference)),
          theme + ': radius 14 rounds away the same edge'
        );
      }
    }
  );
  await check(
    'focus ring: PageInfo security row paints a complete mouse and Tab outline before native navigation',
    async () => {
      const observations = [];
      const originalTheme = nativeTheme.themeSource;
      try {
        for (const dark of [false, true]) {
          const theme = dark ? 'dark' : 'light';
          nativeTheme.themeSource = theme;
          wc.showPageInfoDialog({ anchorBounds: anchor(120, 76) });
          await delay(220);
          const p = panels.at(-1);
          try {
            await capturePanel(p, `focus-page-info-${theme}-before`);
            const row = node(p, 'page-info-security').bounds;
            const heading = node(p, 'page-info-title').bounds;
            // A real press focuses the row. Dragging out before release cancels
            // activation, allowing its mouse focus outline to be observed first.
            await native('drag', {
              hwnd: Number(panelState(p).windowHandle),
              ...physicalPoint({ x: Math.round(row.x + row.width / 2), y: Math.round(row.y + row.height / 2) }),
              end: physicalPoint({
                x: Math.round(heading.x + heading.width / 2),
                y: Math.round(heading.y + heading.height / 2)
              })
            });
            await delay(100);
            assert.equal(node(p, 'page-info-security').type, 'item', 'Cancelled mouse press must not navigate');
            observations.push(await observeFocusRing(p, 'page-info-security', `focus-page-info-${theme}-mouse`));
            await key(p, 0x09);
            assert.equal(panelState(p).focusedId, 'page-info-site-settings');
            await key(p, 0x09, [0x10]);
            assert.equal(panelState(p).focusedId, 'page-info-security');
            observations.push(await observeFocusRing(p, 'page-info-security', `focus-page-info-${theme}-tab`));
            await key(p, 0x0d);
            assert.ok(node(p, 'page-info-description').text, 'Enter opens the real security subpage');
            await capturePanel(p, `focus-page-info-${theme}-security`);
            await click(p, 'page-info-back');
            await click(p, 'page-info-security');
            assert.ok(node(p, 'page-info-description').text, 'Mouse activation still opens the security subpage');
            await tabTo(p, 'page-info-back');
            await key(p, 0x20);
            assert.equal(node(p, 'page-info-security').type, 'item', 'Space activates the native back icon');
          } finally {
            p.destroy();
          }
        }
      } finally {
        nativeTheme.themeSource = originalTheme;
      }
      snapshot.focusPageInfo = observations;
      observations.forEach(assertCompleteFocusRing);
    }
  );
}
function downloads() {
  const names = [
    'Sudo Rom v1.zip',
    'manual_labels_011-020.json',
    'manual_labels_20261010 (1).json',
    'manual_labels_20261010 (1).json',
    'manual_labels_20261010.json'
  ];
  return {
    type: 'column',
    id: 'downloads',
    width: 360,
    gap: 0,
    children: [
      {
        type: 'row',
        id: 'download-header',
        height: 28,
        children: [
          text('downloads-title', '下载', { flex: 1, style: { fontWeight: 'medium' } }),
          iconButton('downloads-folder', 'folder', '打开下载文件夹')
        ]
      },
      {
        type: 'list',
        id: 'download-list',
        height: 286,
        gap: 0,
        children: names.map((name, i) => ({
          type: 'item',
          id: `download-${i}`,
          height: 56,
          gap: 12,
          accessibleName: name,
          style: { radius: 8, paddingTop: 8, paddingBottom: 8 },
          children: [
            { type: 'icon', id: `file-${i}`, width: 32, height: 32, image: image(i ? 'json-tile' : 'file-tile') },
            {
              type: 'column',
              id: `download-copy-${i}`,
              gap: 2,
              flex: 1,
              children: [
                text(`name-${i}`, name),
                text(
                  `status-${i}`,
                  i
                    ? `已下载 · ${i === 1 ? '19.7' : '9.1'} kB · ${['', '16:15', '15:58', '15:54', '15:52'][i]}`
                    : '已停止 · 15:32',
                  { fontSize: 12, muted: true }
                )
              ]
            },
            iconButton(`reveal-${i}`, 'folder', '在文件夹中显示'),
            iconButton(`more-${i}`, 'more', '更多操作')
          ]
        }))
      }
    ]
  };
}
function suggestions(count = 6, selected = 0) {
  const titles = [
    'github',
    'Normalize generated C headers',
    'Fix fingerprint connection lifecycle',
    'Release fcurl v0.2.0 · FastTLS',
    'GitHub - FastTLS/fasttls-ffi',
    'FastTLS'
  ];
  return {
    type: 'column',
    id: 'suggestions',
    width: 360,
    gap: 0,
    children: [
      {
        type: 'list',
        id: 'suggestion-list',
        height: 216,
        gap: 0,
        children: Array.from({ length: count }, (_, i) => ({
          type: 'item',
          id: `suggestion-${i}`,
          height: 36,
          gap: 10,
          selected: selected === i,
          accessibleName: titles[i % titles.length],
          style: {
            radius: 10,
            hoverBackground: '#F2F1F2',
            selectedBackground: '#F2F1F2',
            paddingLeft: 10,
            paddingRight: 10
          },
          children: [
            {
              type: 'icon',
              id: `suggestion-icon-${i}`,
              image: image(i === 0 ? 'search' : i === 5 ? 'globe' : 'github'),
              width: 16,
              height: 16
            },
            text(`suggestion-title-${i}`, titles[i % titles.length], {
              flex: 1,
              ...(i === 4 ? { highlights: [{ start: 0, end: 6 }] } : {})
            }),
            text(
              `suggestion-url-${i}`,
              i === 0 ? '搜索网页' : i === 5 ? '— fasttls.github.io' : '— github.com/FastTLS',
              { width: 110, muted: true }
            )
          ]
        }))
      }
    ]
  };
}
function detailedSuggestions(width, selected = 0) {
  const entries = [
    ['Lido Accounts | Etherscan', '— etherscan.io/accounts/label/lido', 'globe'],
    ['edist/FEATURES.zh-CN.md at main · ChengHoward/edist', '— github.com/ChengHoward/edist', 'github'],
    ['Sudo Rom v1.zip - Google 云端硬盘', '— drive.google.com/file/d/1-2b6Q7jrzDqFzYli', 'folder'],
    ['127.0.0.1:8791/index-v2.json', '', 'globe'],
    ['Release fcurl v0.2.0 · FastTLS/fasttls-curl · GitHub', '— github.com/FastTLS/fasttls-curl/releases', 'github'],
    ['SM-C7010 | Samsung Galaxy C7 Pro Duos | PDA/CSC', '— sfirmware.com/downloads-firmware', 'globe']
  ];
  return {
    type: 'column',
    id: 'detailed-suggestions',
    width,
    gap: 0,
    children: entries.map(([title, url, name], i) => ({
      type: 'item',
      id: `detail-${i}`,
      selected: selected === i,
      height: 36,
      gap: 6,
      accessibleName: title,
      style: {
        radius: 10,
        selectedBackground: '#F2F1F2',
        hoverBackground: '#F2F1F2',
        paddingLeft: 10,
        paddingRight: 8
      },
      children: [
        { type: 'icon', id: `detail-icon-${i}`, image: image(name), width: 18, height: 18 },
        text(`detail-title-${i}`, title, { maxWidth: Math.round(width * 0.56), muted: !url }),
        text(`detail-url-${i}`, url, { flex: 1, muted: true }),
        {
          type: 'row',
          id: `detail-remove-slot-${i}`,
          width: 22,
          height: 36,
          style: { align: 'center' },
          children: [
            iconButton(`detail-remove-${i}`, 'close', '删除这条建议', {
              visible: selected === i,
              width: 22,
              height: 24
            })
          ]
        }
      ]
    }))
  };
}
function comment() {
  return {
    type: 'row',
    id: 'comment',
    width: 294,
    gap: 6,
    height: 26,
    children: [
      {
        type: 'input',
        id: 'comment-input',
        placeholder: '添加评论…',
        flex: 1,
        style: { borderless: true, paddingLeft: 6 }
      },
      iconButton('comment-microphone', 'mic', '语音输入', { width: 24, height: 24 })
    ]
  };
}
function note({ value, submitOnEnter, maxLength, dark = false, saveId = 'note-save', saveText = '保存' } = {}) {
  return {
    type: 'column',
    id: 'note',
    width: 340,
    gap: 12,
    children: [
      {
        type: 'textarea',
        id: 'note-body',
        height: 168,
        placeholder: '写下想法…',
        ...(value === undefined ? {} : { value }),
        ...(submitOnEnter === undefined ? {} : { submitOnEnter }),
        ...(maxLength === undefined ? {} : { maxLength }),
        style: {
          background: dark ? '#252525' : '#FAFAFA',
          borderColor: dark ? '#494949' : '#E5E5E5',
          borderWidth: 1,
          radius: 10,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 12
        }
      },
      {
        type: 'row',
        id: 'note-footer',
        gap: 8,
        children: [
          text('note-spacer', '', { flex: 1 }),
          { type: 'button', id: 'note-cancel', text: '取消', variant: 'plain', width: 58, height: 30 },
          { type: 'button', id: saveId, text: saveText, width: 58, height: 30, style: { radius: 7 } }
        ]
      }
    ]
  };
}
function noteTheme(dark = false) {
  return {
    mode: dark ? 'dark' : 'light',
    fontSize: 13,
    background: dark ? '#202020' : '#FFFFFF',
    text: dark ? '#E9E9E9' : '#171717',
    muted: dark ? '#AAAAAA' : '#969696',
    border: dark ? '#424242' : '#E4E4E4'
  };
}
function editingState(panel) {
  const field = node(panel, 'note-body');
  assert.ok(field.selection && Number.isInteger(field.selection.start) && Number.isInteger(field.selection.end));
  assert.ok(field.caretBounds && field.viewportBounds && field.displayOffset, 'Native textarea diagnostics');
  return {
    value: field.value,
    selection: field.selection,
    caretBounds: field.caretBounds,
    viewportBounds: field.viewportBounds,
    displayOffset: field.displayOffset,
    lineCount: field.lineCount,
    focusedId: panelState(panel).focusedId,
    windowHandle: panelState(panel).windowHandle
  };
}
async function textareaPixels(panel, { background, border, borderWidth, corner, insets }) {
  await delay(160);
  const field = node(panel, 'note-body');
  const bounds = screen.dipToScreenRect(parent, field.bounds);
  const scale = screen.getDisplayMatching(field.bounds).scaleFactor;
  const stripLength = Math.ceil((borderWidth + 3) * scale);
  const points = [
    { x: bounds.x + Math.round(bounds.width * 0.7), y: bounds.y + bounds.height - Math.ceil(12 * scale) },
    { x: bounds.x + 2, y: bounds.y + 2 },
    ...Array.from({ length: stripLength }, (_, i) => ({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + i }))
  ];
  const { pixels } = await native('pixels', { hwnd: Number(panelState(panel).windowHandle), points });
  const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 3);
  assert.ok(near(pixels[0].rgb, background), 'Actual native editor background: ' + JSON.stringify(pixels[0]));
  assert.ok(near(pixels[1].rgb, corner), 'Actual native editor corner shape: ' + JSON.stringify(pixels[1]));
  const borderPixels = pixels.slice(2).filter((p) => near(p.rgb, border));
  assert.ok(
    borderPixels.length >= Math.max(1, Math.floor(borderWidth * scale) - 1),
    'Expected native border color/thickness: ' + JSON.stringify(pixels)
  );
  assert.ok(borderPixels.length <= Math.ceil(borderWidth * scale) + 1, 'Border must retain the requested thin stroke');
  const actualInsets = {
    top: field.viewportBounds.y - field.bounds.y,
    left: field.viewportBounds.x - field.bounds.x,
    right: field.bounds.x + field.bounds.width - field.viewportBounds.x - field.viewportBounds.width,
    bottom: field.bounds.y + field.bounds.height - field.viewportBounds.y - field.viewportBounds.height
  };
  assert.deepEqual(field.contentInsets, insets, 'The native editing viewport includes both padding and border');
  for (const side of ['top', 'left', 'right', 'bottom']) {
    assert.ok(
      Math.abs(actualInsets[side] - insets[side]) <= 1,
      `Native ${side} content padding: ${JSON.stringify(actualInsets)}`
    );
  }
  return { bounds, scale, pixels, actualInsets };
}
async function withNote(options, fn) {
  const p = newPanel(note(options), { focusMode: 'input', contentInset: 14, radius: 14, theme: noteTheme() });
  const actions = [];
  let draft = options?.value || '';
  p.on('action', (action) => {
    actions.push(action);
    if (action.id === 'note-body' && action.type === 'change') draft = action.value;
  });
  try {
    await show(p, 176, 130);
    await fn(p, actions, () => draft);
  } finally {
    p.destroy();
  }
}
async function textareaChecks() {
  await check('textarea: fixed-height note, physical wrapping and light/dark native screenshots', async () => {
    await withNote({}, async (p, actions) => {
      const initial = panelState(p);
      assert.equal(initial.nativeWindowsValid, true);
      assert.equal(node(p, 'note-body').bounds.height, 168);
      await click(p, 'note-body');
      const line = 'A long native note keeps wrapping inside the fixed editor. '.repeat(5);
      await typeText(p, line);
      const field = node(p, 'note-body');
      assert.equal(field.value, line);
      assert.ok(field.lineCount > 1, 'A single logical line must wrap into multiple native display lines');
      assert.equal(field.bounds.height, 168);
      assert.deepEqual(panelState(p).contentBounds, initial.contentBounds);
      assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
      await key(p, 0x41, [0x11]);
      await typeText(p, '整理今天的想法');
      await key(p, 0x0d, [0x10]);
      await typeText(p, '保留重要信息，稍后继续。');
      await key(p, 0x0d, [0x10]);
      await key(p, 0x0d, [0x10]);
      await typeText(p, '周五前完成界面复核，保存需要跟进的细节。');
      const lightState = editingState(p);
      await capturePanel(p, 'textarea-note-light');
      const lightPixels = await textareaPixels(p, {
        background: [250, 250, 250],
        border: [229, 229, 229],
        borderWidth: 1,
        corner: [255, 255, 255],
        insets: { top: 11, right: 13, bottom: 11, left: 13 }
      });
      p.update({ content: note({ dark: true }), theme: noteTheme(true) });
      assert.deepEqual(editingState(p), lightState, 'Appearance changes retain native editing state');
      await capturePanel(p, 'textarea-note-dark');
      const darkPixels = await textareaPixels(p, {
        background: [37, 37, 37],
        border: [73, 73, 73],
        borderWidth: 1,
        corner: [32, 32, 32],
        insets: { top: 11, right: 13, bottom: 11, left: 13 }
      });
      const custom = note();
      custom.children[0].style = {
        background: '#E8F2FF',
        borderColor: '#738BA5',
        borderWidth: 3,
        radius: 0,
        paddingTop: 14,
        paddingBottom: 14,
        paddingLeft: 16,
        paddingRight: 16
      };
      p.update({ content: custom, theme: noteTheme() });
      const customPixels = await textareaPixels(p, {
        background: [232, 242, 255],
        border: [115, 139, 165],
        borderWidth: 3,
        corner: [115, 139, 165],
        insets: { top: 17, right: 19, bottom: 17, left: 19 }
      });
      snapshot.textarea = {
        wrapLineCount: field.lineCount,
        fixedHeight: field.bounds.height,
        lightPixels,
        darkPixels,
        customPixels
      };
      assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
    });
  });
  await check(
    'textarea: default Enter submits full multiline value and custom save/cancel use host draft',
    async () => {
      await withNote({}, async (p, actions, draft) => {
        await click(p, 'note-body');
        await typeText(p, 'First line');
        await key(p, 0x0d, [0x10]);
        await typeText(p, '第二行');
        const expected = 'First line\n第二行';
        assert.equal(node(p, 'note-body').value, expected);
        assert.equal(draft(), expected);
        await key(p, 0x0d);
        assert.deepEqual(
          actions.filter((a) => a.type === 'submit'),
          [{ id: 'note-body', type: 'submit', value: expected }]
        );
        assert.equal(node(p, 'note-body').value, expected, 'Submit must not insert a newline');
        assert.equal(panelState(p).visible, true);
        const saved = [];
        const onSave = (action) => {
          if (action.id === 'note-archive' && action.type === 'click') saved.push(draft());
        };
        p.on('action', onSave);
        p.update({ content: note({ saveId: 'note-archive', saveText: '存档' }) });
        assert.equal(node(p, 'note-body').value, expected);
        await click(p, 'note-archive');
        assert.deepEqual(saved, [expected], 'Application-defined replacement button reads the current multiline draft');
        await click(p, 'note-cancel');
        assert.equal(actions.filter((a) => a.id === 'note-cancel' && a.type === 'click').length, 1);
        assert.equal(saved.length, 1, 'Cancel does not trigger the save listener');
        p.off('action', onSave);
      });
    }
  );
  await check('textarea: submitOnEnter false keeps Enter and Shift+Enter as physical newlines', async () => {
    await withNote({ submitOnEnter: false }, async (p, actions, draft) => {
      await click(p, 'note-body');
      await typeText(p, 'one');
      await key(p, 0x0d);
      await typeText(p, 'two');
      await key(p, 0x0d, [0x10]);
      await typeText(p, '三');
      assert.equal(node(p, 'note-body').value, 'one\ntwo\n三');
      assert.equal(draft(), 'one\ntwo\n三');
      assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
      p.update({ content: note({ submitOnEnter: true }) });
      await key(p, 0x0d);
      assert.equal(actions.filter((a) => a.type === 'submit').at(-1).value, 'one\ntwo\n三');
    });
  });
  await check('textarea: maxLength counts multiline UTF-16 input and zero restores unlimited editing', async () => {
    await withNote({ maxLength: 9, submitOnEnter: false }, async (p, actions, draft) => {
      await click(p, 'note-body');
      await typeText(p, '你好🙂a');
      await key(p, 0x0d);
      await typeText(p, '123456');
      assert.equal(node(p, 'note-body').value, '你好🙂a\n123');
      assert.equal(draft(), '你好🙂a\n123');
      assert.ok(actions.filter((a) => a.type === 'change').every((a) => a.value.length <= 9));
      p.update({ content: note({ maxLength: 0, submitOnEnter: false }) });
      await typeText(p, '456789');
      assert.equal(node(p, 'note-body').value, '你好🙂a\n123456789');
      assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
    });
  });
  await check('textarea: draft, reversed selection, caret and viewport survive content/theme updates', async () => {
    await withNote({}, async (p, actions) => {
      await click(p, 'note-body');
      await typeText(p, 'Draft selection survives stable updates.');
      await key(p, 0x0d, [0x10]);
      await typeText(p, 'Second native line');
      const beforeKey = editingState(p);
      const driver = await repeatKey(p, 0x25, 6, [0x10]);
      const before = editingState(p);
      snapshot.textareaSelectionAttempt = { beforeKey, driver, afterKey: before };
      assert.ok(before.selection.start > before.selection.end, 'Shift+Left creates a reversed native selection');
      const count = actions.length;
      p.update({ content: note() });
      assert.deepEqual(editingState(p), before);
      p.update({ theme: { ...noteTheme(), accent: '#567AA6' } });
      assert.deepEqual(editingState(p), before);
      assert.equal(actions.length, count, 'Reconciliation does not synthesize edits or submissions');
      await typeText(p, '更新');
      assert.equal(node(p, 'note-body').value, before.value.slice(0, -6) + '更新');
      snapshot.textareaSelection = { before, afterReplacement: editingState(p) };
    });
  });
  await check('textarea: long content scrolls internally, Up/Down select text and Tab traverses controls', async () => {
    const value = Array.from({ length: 45 }, (_, i) => `Native line ${String(i + 1).padStart(2, '0')} — 保留正文`).join(
      '\n'
    );
    await withNote({ value, submitOnEnter: false }, async (p, actions) => {
      await click(p, 'note-body');
      await key(p, 0x23, [0x11]);
      const bottom = editingState(p);
      assert.ok(bottom.lineCount >= 45);
      assert.ok(bottom.displayOffset.y < 0, 'The native editor scrolls its own multiline viewport');
      assert.ok(bottom.caretBounds.y >= bottom.viewportBounds.y - 1);
      assert.ok(
        bottom.caretBounds.y + bottom.caretBounds.height <= bottom.viewportBounds.y + bottom.viewportBounds.height + 1
      );
      p.update({ content: note({ value, submitOnEnter: false }) });
      assert.deepEqual(editingState(p), bottom, 'Unchanged source values preserve the scrolled draft');
      const driver = await key(p, 0x26, [0x10]);
      const selection = node(p, 'note-body').selection;
      snapshot.textareaScrollAttempt = { bottom, driver, afterUp: editingState(p) };
      assert.notEqual(selection.start, selection.end);
      assert.equal(panelState(p).focusedId, 'note-body');
      await key(p, 0x28);
      assert.equal(panelState(p).focusedId, 'note-body');
      assert.equal(node(p, 'note-body').value, value);
      const rect = node(p, 'note-body').bounds;
      await native('wheel', {
        hwnd: Number(panelState(p).windowHandle),
        ...physicalPoint({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }),
        delta: 720
      });
      await delay(120);
      assert.ok(
        node(p, 'note-body').displayOffset.y > bottom.displayOffset.y,
        'Physical wheel scrolls upward inside textarea'
      );
      const scrolled = editingState(p);
      p.update({ content: note({ value, submitOnEnter: false }), theme: { ...noteTheme(), accent: '#567AA6' } });
      assert.deepEqual(
        editingState(p),
        scrolled,
        'Updates preserve a manually scrolled viewport independently of the caret'
      );
      assert.equal(node(p, 'note-body').bounds.height, 168);
      await key(p, 0x09);
      assert.equal(panelState(p).focusedId, 'note-cancel');
      await key(p, 0x09, [0x10]);
      assert.equal(panelState(p).focusedId, 'note-body');
      assert.equal(actions.filter((a) => ['click', 'submit'].includes(a.type)).length, 0);
      snapshot.textareaScroll = { bottom, afterWheel: scrolled, afterTab: editingState(p) };
    });
  });
  await check('textarea: Chinese IME survives updates, reserves first Escape and commits before submit', async () => {
    const layoutId = originalDesktop.imeLayouts.find((layout) => (layout & 0x3ff) === 4);
    assert.ok(layoutId, 'An installed Chinese IME is required');
    await withNote({}, async (p, actions, draft) => {
      const dismissed = [];
      p.on('dismissed', (event) => dismissed.push(event));
      let previous;
      try {
        await click(p, 'note-body');
        previous = await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
        snapshot.textareaImeAttempt = { driver: previous, field: node(p, 'note-body'), state: panelState(p) };
        // Windows gives TEXT_AREA a separate TSF document. Its initial Pinyin
        // mode can be English even when the owning HWND already has a Chinese
        // HKL; IMM32 may have no context for this TSF-only control. Set that
        // fixture precondition with the real Pinyin Shift toggle, then require
        // actual native composition and a Chinese commit below.
        for (let i = 0; i < 4 && !node(p, 'note-body').composing; i++) await delay(100);
        if (!node(p, 'note-body').composing && node(p, 'note-body').value === 'nihao') {
          await key(p, 0x41, [0x11]);
          await key(p, 0x08);
          assert.equal(node(p, 'note-body').value, '');
          await key(p, 0x10);
          const retry = await native('ime', {
            hwnd: Number(panelState(p).windowHandle),
            layout: layoutId,
            keys: 'nihao'
          });
          snapshot.textareaImeAttempt.nativeModeRetry = { driver: retry, field: node(p, 'note-body') };
          for (let i = 0; i < 4 && !node(p, 'note-body').composing; i++) await delay(100);
        }
        assert.equal(node(p, 'note-body').composing, true);
        p.update({ content: note(), theme: { ...noteTheme(), accent: '#567AA6' } });
        assert.equal(node(p, 'note-body').composing, true);
        assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
        await key(p, 0x1b);
        assert.equal(panelState(p).visible, true);
        assert.equal(dismissed.length, 0);
        await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
        assert.equal(node(p, 'note-body').composing, true);
        await key(p, 0x20);
        assert.equal(node(p, 'note-body').composing, false);
        assert.match(node(p, 'note-body').value, /[\u3400-\u9fff]/);
        await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
        assert.equal(node(p, 'note-body').composing, true);
        await key(p, 0x0d);
        assert.equal(node(p, 'note-body').composing, false);
        assert.match(node(p, 'note-body').value, /[\u3400-\u9fff]/);
        assert.equal(
          node(p, 'note-body').value.includes('\n'),
          false,
          'IME confirmation Enter must not insert a newline'
        );
        assert.equal(
          actions.filter((a) => a.type === 'submit').length,
          0,
          'IME confirmation Enter is not a form submission'
        );
        assert.equal(draft(), node(p, 'note-body').value);
        await key(p, 0x0d);
        assert.equal(actions.filter((a) => a.type === 'submit').length, 1);
        assert.equal(actions.find((a) => a.type === 'submit').value, draft());
        await key(p, 0x1b);
        assert.equal(panelState(p).visible, false, 'Non-composing Escape follows the panel dismissal policy');
        assert.deepEqual(dismissed, [{ reason: 'escape' }]);
      } finally {
        if (previous) await native('layout', { hwnd: Number(panelState(p).windowHandle), layout: previous.oldLayout });
      }
    });
  });
  await check('textarea: invalid schema updates reject atomically without extra WebContents', async () => {
    await withNote({}, async (p, actions) => {
      const before = panelState(p);
      const count = webContents.getAllWebContents().length;
      for (const fields of [
        { submitOnEnter: 'true' },
        { submitOnEnter: null },
        { value: 3 },
        { placeholder: false },
        { maxLength: -1 },
        { maxLength: 1.5 },
        { maxLength: 65537 },
        { height: -1 },
        { style: { borderColor: 'gray' } },
        { multiline: true }
      ]) {
        const content = note();
        Object.assign(content.children[0], fields);
        assert.throws(() => p.update({ content, theme: 'dark' }));
        assert.deepEqual(panelState(p), before);
      }
      const content = note();
      content.children[0].type = 'input';
      content.children[0].submitOnEnter = true;
      assert.throws(() => p.update({ content }));
      assert.deepEqual(panelState(p), before);
      assert.equal(actions.length, 0);
      assert.equal(webContents.getAllWebContents().length, count);
      assert.equal(count, snapshot.webContentsBefore);
    });
  });
  await check('textarea: existing single-line input still submits on Enter without a newline', async () => {
    const p = newPanel(
      { type: 'input', id: 'single-input', width: 280, placeholder: '单行输入' },
      { focusMode: 'input' }
    );
    const actions = [];
    p.on('action', (action) => actions.push(action));
    try {
      await show(p, 176, 130);
      await click(p, 'single-input');
      await typeText(p, 'Single line 回归');
      await key(p, 0x0d);
      assert.equal(node(p, 'single-input').value, 'Single line 回归');
      assert.deepEqual(
        actions.filter((a) => a.type === 'submit'),
        [{ id: 'single-input', type: 'submit', value: 'Single line 回归' }]
      );
      assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
    } finally {
      p.destroy();
    }
  });
}
function scrollCenter(rect) {
  return physicalPoint({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
}
function assertModernScrollbar(bar) {
  assert.equal(bar.visible, true);
  assert.equal(bar.bounds.width, 12, 'The native scroll gutter has a consistent width');
  assert.equal(bar.track.width, 12);
  assert.ok(bar.track.y >= bar.bounds.y && bar.track.y - bar.bounds.y <= 2);
  assert.ok(bar.bounds.height - bar.track.height <= 4, 'Only end-cap padding remains; no arrow-button slots');
  for (const name of ['previous', 'next', 'previousButton', 'nextButton']) {
    assert.ok(!bar[name] || bar[name].width * bar[name].height === 0, `No ${name} arrow hit target`);
  }
  assert.ok(bar.thumbPaintBounds.height >= 24, 'The rounded thumb retains a usable minimum size');
  assert.equal(
    bar.thumbPaintBounds.width,
    nativeTheme.shouldUseHighContrastColors || bar.hovered || bar.pressed ? 6 : 4
  );
}
async function scrollVisualPixels(panel, bar) {
  const paint = screen.dipToScreenRect(parent, bar.thumbPaintBounds);
  const sampleY = Math.floor(paint.y + paint.height / 2);
  const points = [
    { x: Math.floor(paint.x + paint.width / 2), y: sampleY },
    { x: paint.x, y: paint.y },
    physicalPoint({ x: bar.track.x, y: Math.round(bar.track.y + bar.track.height / 2) }),
    physicalPoint({ x: bar.track.x - 2, y: Math.round(bar.track.y + bar.track.height / 2) })
  ];
  const { pixels } = await native('pixels', { hwnd: Number(panelState(panel).windowHandle), points });
  const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  assert.ok(distance(pixels[0].rgb, pixels[3].rgb) > 15, 'The native thumb is visibly distinct from the surface');
  assert.ok(
    distance(pixels[1].rgb, pixels[3].rgb) < distance(pixels[0].rgb, pixels[3].rgb),
    'The end cap is actually rounded'
  );
  assert.ok(distance(pixels[2].rgb, pixels[3].rgb) <= 20, 'Track edge remains transparent or lightly tinted');
  return pixels;
}
async function exerciseScrollbar(panel, getBar, getOffset, contentPoint, name, darkPatch = { theme: 'dark' }) {
  const state = panelState(panel);
  await native('move', {
    hwnd: Number(state.windowHandle),
    ...physicalPoint({ x: state.contentBounds.x + 5, y: state.contentBounds.y + 24 }),
    keepCursor: true
  });
  await delay(120);
  assertModernScrollbar(getBar());
  const normal = await scrollVisualPixels(panel, getBar());
  await capturePanel(panel, `${name}-light`);
  const initial = getOffset();
  const wheelPoint = contentPoint();
  const attempt = { initial, wheelPoint, initialState: panelState(panel), initialBar: getBar() };
  (snapshot.scrollbarAttempts ??= {})[name] = attempt;
  await native('wheel', { hwnd: Number(state.windowHandle), ...wheelPoint, delta: -360 });
  await delay(120);
  const wheelOffset = getOffset();
  Object.assign(attempt, { wheelOffset, wheelState: panelState(panel), wheelBar: getBar() });
  if (wheelOffset === initial) await capturePanel(panel, `${name}-wheel-no-change`);
  assert.ok(wheelOffset > initial, 'Physical wheel changes the content offset');
  assert.ok(Math.abs(getBar().position - wheelOffset) <= 1, 'Scrollbar position is the actual content offset');
  const bar = getBar();
  const pageY = Math.min(bar.track.y + bar.track.height - 3, bar.thumb.y + bar.thumb.height + 30);
  await native('click', {
    hwnd: Number(state.windowHandle),
    ...physicalPoint({ x: Math.round(bar.track.x + bar.track.width / 2), y: Math.round(pageY) })
  });
  await delay(120);
  assert.ok(getOffset() > wheelOffset, 'Clicking below the thumb pages the real viewport');
  const dragging = getBar();
  await native('drag', {
    hwnd: Number(state.windowHandle),
    ...scrollCenter(dragging.thumb),
    end: physicalPoint({
      x: Math.round(dragging.track.x + dragging.track.width / 2),
      y: Math.round(dragging.track.y + dragging.track.height - 2)
    })
  });
  await delay(120);
  assert.ok(getOffset() > getBar().maximum * 0.9, 'Dragging the thumb reaches the last content lines');
  const offset = getOffset();
  const materialStates = [];
  for (const backgroundMaterial of ['acrylic', 'none']) {
    panel.update({ backgroundMaterial });
    await delay(160);
    assert.equal(getOffset(), offset, 'Material updates retain list/outer/textarea scroll position');
    assert.equal(panelState(panel).windowHandle, state.windowHandle, 'Material updates reuse the existing native host');
    materialStates.push(await materialState(panel, backgroundMaterial));
    if (backgroundMaterial === 'acrylic') await capturePanel(panel, `${name}-acrylic-light`);
  }
  await native('move', { hwnd: Number(state.windowHandle), ...scrollCenter(getBar().thumb), keepCursor: true });
  await delay(160);
  assertModernScrollbar(getBar());
  assert.equal(getBar().hovered, true);
  assert.equal(getBar().thumbPaintBounds.width, 6);
  await capturePanel(panel, `${name}-hover`);
  panel.update(darkPatch);
  await delay(160);
  assert.equal(getOffset(), offset, 'Theme update preserves the current content offset');
  assertModernScrollbar(getBar());
  const darkPixels = await scrollVisualPixels(panel, getBar());
  assert.notDeepEqual(darkPixels[0].rgb, normal[0].rgb, 'The scrollbar paints using the updated theme');
  await capturePanel(panel, `${name}-dark`);
  panel.update({ backgroundMaterial: 'acrylic' });
  await delay(160);
  assert.equal(getOffset(), offset);
  await capturePanel(panel, `${name}-acrylic-dark`);
  panel.update({ backgroundMaterial: 'none' });
  assert.equal(getOffset(), offset);
  return {
    initial,
    wheelOffset,
    finalOffset: getOffset(),
    scrollbar: getBar(),
    normalPixels: normal,
    darkPixels,
    materialStates
  };
}
async function materialState(panel, requested) {
  const state = panelState(panel);
  const osState = await native('material', { hwnd: Number(state.windowHandle) });
  assert.equal(state.backgroundMaterial, requested);
  if (osState.hresult === 0) {
    assert.equal(
      state.materialDwmBackdrop,
      osState.backdrop,
      'Backend diagnostics agree with an independent DWM query'
    );
  } else {
    assert.ok(
      state.materialDwmBackdrop === undefined || state.materialDwmBackdrop === -1,
      'Unavailable DWM attributes are reported explicitly'
    );
  }
  if (requested === 'none') {
    assert.equal(state.backgroundMaterialApplied, 'none');
    assert.notEqual(osState.backdrop, 3);
  } else {
    const eligible =
      osState.windowsBuild >= 22621 &&
      osState.composition &&
      osState.transparencyEnabled &&
      !nativeTheme.shouldUseHighContrastColors &&
      !osState.highContrast &&
      !osState.energySaver;
    if (eligible && osState.hresult === 0) {
      assert.equal(state.backgroundMaterialApplied, 'acrylic');
      assert.equal(osState.backdrop, 3, 'Official DWMWA_SYSTEMBACKDROP_TYPE is DWMSBT_TRANSIENTWINDOW');
    } else {
      assert.equal(state.backgroundMaterialApplied, 'none');
      assert.ok(state.materialFallbackReason, 'System-policy degradation is explicit');
    }
  }
  return { requested, applied: state.backgroundMaterialApplied, fallback: state.materialFallbackReason, osState };
}
async function acrylicChecks() {
  if (process.env.NATIVE_UI_FORCE_HIGH_CONTRAST === '1') {
    await check(
      'acrylic fallback: process-only forced colors makes acrylic opaque and keeps none transparency',
      async () => {
        assert.equal(nativeTheme.shouldUseHighContrastColors, true);
        const content = {
          type: 'column',
          id: 'fallback-root',
          width: 330,
          children: [
            { type: 'column', id: 'fallback-blank', height: 80, children: [] },
            {
              type: 'list',
              id: 'fallback-list',
              height: 124,
              children: Array.from({ length: 40 }, (_, i) =>
                text(`fallback-line-${i}`, `System color ${i + 1}`, { height: 26 })
              )
            }
          ]
        };
        const p = newPanel(content, {
          backgroundMaterial: 'acrylic',
          theme: { mode: 'light', background: '#00FFFFFF' }
        });
        try {
          await show(p, 176, 130);
          const state = panelState(p);
          assert.equal(state.backgroundMaterial, 'acrylic');
          assert.equal(state.backgroundMaterialApplied, 'none');
          assert.equal(state.materialFallbackReason, 'forced-colors');
          const environment = await native('material', { hwnd: Number(state.windowHandle) });
          assert.notEqual(environment.backdrop, 3);
          const bounds = screen.dipToScreenRect(parent, state.contentBounds);
          const points = Array.from({ length: 8 }, (_, i) => ({ x: bounds.x + 40 + i * 4, y: bounds.y + 40 }));
          await parent.webContents.executeJavaScript(`(() => {
          const c=document.createElement('canvas');c.id='fallback-pattern';c.width=Math.ceil(innerWidth*devicePixelRatio);c.height=Math.ceil(innerHeight*devicePixelRatio);
          c.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none';document.body.append(c);
          const g=c.getContext('2d');for(let y=0;y<c.height;y+=4)for(let x=0;x<c.width;x+=4){g.fillStyle=((x/4+y/4)%2)?'#FFFFFF':'#000000';g.fillRect(x,y,4,4)}
        })()`);
          p.hide();
          await delay(240);
          const reference = await native('pixels', { hwnd: handle(), points });
          assert.ok(
            Math.max(...reference.pixels.map((p) => p.rgb[0])) - Math.min(...reference.pixels.map((p) => p.rgb[0])) >
              200
          );
          await show(p, 176, 130);
          const opaque = await native('pixels', { hwnd: Number(state.windowHandle), points });
          for (const pixel of opaque.pixels) {
            assert.deepEqual(
              pixel.rgb,
              [255, 255, 255],
              'Fallback forces the requested transparent white to opaque white'
            );
          }
          await capturePanel(p, 'acrylic-fallback-opaque');
          await native('move', {
            hwnd: Number(state.windowHandle),
            ...physicalPoint({ x: state.contentBounds.x + 5, y: state.contentBounds.y + 24 }),
            keepCursor: true
          });
          await delay(120);
          const bar = node(p, 'fallback-list').scrollbar;
          assert.equal(bar.visible, true);
          assert.equal(bar.thumbPaintBounds.width, 6, 'Forced colors retain the thicker accessible thumb');
          const rgb = (name) =>
            systemPreferences
              .getColor(name)
              .slice(1, 7)
              .match(/../g)
              .map((v) => parseInt(v, 16));
          const systemPalette = { window: rgb('window'), text: rgb('window-text'), highlight: rgb('highlight') };
          const scrollbarPixels = await native('pixels', {
            hwnd: Number(state.windowHandle),
            points: [
              scrollCenter(bar.thumbPaintBounds),
              physicalPoint({
                x: Math.round(bar.track.x + bar.track.width / 2),
                y: Math.round(bar.track.y + bar.track.height - 4)
              })
            ]
          });
          assert.deepEqual(
            scrollbarPixels.pixels[0].rgb,
            systemPalette.text,
            'The normal thumb uses the public Windows system text color'
          );
          assert.deepEqual(
            scrollbarPixels.pixels[1].rgb,
            systemPalette.window,
            'The forced-color track uses the public Windows system window color'
          );
          await native('move', { hwnd: Number(state.windowHandle), ...scrollCenter(bar.thumb), keepCursor: true });
          await delay(120);
          const hoverPixels = await native('pixels', {
            hwnd: Number(state.windowHandle),
            points: [scrollCenter(node(p, 'fallback-list').scrollbar.thumbPaintBounds)]
          });
          assert.deepEqual(
            hoverPixels.pixels[0].rgb,
            systemPalette.highlight,
            'Hover uses the public Windows highlight color'
          );
          p.update({ backgroundMaterial: 'none' });
          await delay(240);
          assert.equal(panelState(p).backgroundMaterialApplied, 'none');
          const nonePixels = [];
          for (let i = 0; i < points.length; i++) {
            const hit = await native('hit', points[i]);
            assert.ok(
              [handle(), Number(state.windowHandle)].includes(hit.root),
              'Transparent samples stay inside the owned test windows'
            );
            const pixel = await native('pixel', points[i]);
            nonePixels.push(pixel.rgb);
            assert.ok(
              pixel.rgb.every((v, c) => Math.abs(v - reference.pixels[i].rgb[c]) <= 3),
              'None keeps the pre-existing transparent-theme behavior'
            );
          }
          const center = scrollCenter(state.contentBounds);
          const hit = await native('hit', center);
          assert.ok([handle(), Number(state.windowHandle)].includes(hit.root));
          const file = path.join(output, 'acrylic-fallback-none-transparent.png');
          await native('screenshot', { hwnd: hit.root, bounds, path: file });
          screenshots['acrylic-fallback-none-transparent'] = { path: file, state: panelState(p) };
          snapshot.materialFallback = {
            environment,
            reference,
            opaque,
            nonePixels,
            systemPalette,
            scrollbarPixels,
            hoverPixels
          };
          assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
        } finally {
          p.destroy();
          await parent.webContents.executeJavaScript("document.querySelector('#fallback-pattern')?.remove()");
        }
      }
    );
  }
  await check('acrylic: constructor/update enum validation is atomic and creates no WebContents', async () => {
    const p = newPanel(note(), { focusMode: 'input', backgroundMaterial: 'acrylic' });
    try {
      await show(p, 176, 130);
      snapshot.materialEnvironment = await materialState(p, 'acrylic');
      const before = panelState(p);
      for (const backgroundMaterial of [null, true, 1, '', 'mica', 'Acrylic', {}, []]) {
        assert.throws(() => newPanel(note(), { backgroundMaterial }));
        assert.throws(() =>
          p.update({ backgroundMaterial, theme: 'dark', content: note({ value: 'must not apply' }) })
        );
        assert.deepEqual(panelState(p), before);
      }
      assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
    } finally {
      p.destroy();
    }
  });
  await check(
    'acrylic: official backdrop readback, actual blur and opaque child boundary in light/dark screenshots',
    async () => {
      const tree = {
        type: 'column',
        id: 'material-sample',
        width: 320,
        height: 220,
        children: [
          { type: 'column', id: 'material-space', height: 130, children: [] },
          {
            type: 'column',
            id: 'material-opaque',
            width: 140,
            height: 48,
            style: { background: '#D9E8F5' },
            children: []
          }
        ]
      };
      const p = newPanel(tree, { backgroundMaterial: 'none' });
      try {
        await show(p, 176, 130);
        const body = panelState(p).contentBounds;
        const bounds = screen.dipToScreenRect(parent, body);
        const host = screen.dipToScreenRect(parent, parent.getContentBounds());
        const scale = screen.getDisplayMatching(body).scaleFactor;
        const high = {
          x: Math.round(22 * scale),
          y: Math.round(22 * scale),
          width: Math.round(96 * scale),
          height: Math.round(70 * scale)
        };
        const low = {
          x: Math.round(154 * scale),
          y: Math.round(22 * scale),
          width: Math.round(120 * scale),
          height: Math.round(70 * scale)
        };
        await parent.webContents.executeJavaScript(`(() => {
        const canvas=document.createElement('canvas');canvas.id='material-pattern';
        canvas.width=Math.ceil(innerWidth*devicePixelRatio);canvas.height=Math.ceil(innerHeight*devicePixelRatio);
        canvas.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none';
        document.body.append(canvas);const c=canvas.getContext('2d');c.fillStyle='#BAC5D1';c.fillRect(0,0,canvas.width,canvas.height);
        const origin={x:${bounds.x - host.x},y:${bounds.y - host.y}},high=${JSON.stringify(high)},low=${JSON.stringify(low)};
        for(let y=0;y<high.height;y+=4)for(let x=0;x<high.width;x+=4){c.fillStyle=((x/4+y/4)%2)?'#FFFFFF':'#000000';c.fillRect(origin.x+high.x+x,origin.y+high.y+y,4,4)}
        c.fillStyle='#202020';c.fillRect(origin.x+low.x,origin.y+low.y,low.width/2,low.height);
        c.fillStyle='#E0E0E0';c.fillRect(origin.x+low.x+low.width/2,origin.y+low.y,low.width/2,low.height);
      })()`);
        p.hide();
        await delay(300);
        const reference = path.join(output, 'acrylic-host-pattern.png');
        await native('screenshot', { hwnd: handle(), bounds, path: reference });
        screenshots['acrylic-host-pattern'] = { path: reference, bounds };
        await show(p, 176, 130);
        await capturePanel(p, 'acrylic-none');
        const none = await materialState(p, 'none');
        p.update({ backgroundMaterial: 'acrylic', theme: 'light' });
        await delay(350);
        const light = await materialState(p, 'acrylic');
        await capturePanel(p, 'acrylic-light');
        const opaque = scrollCenter(node(p, 'material-opaque').bounds);
        assert.deepEqual(
          (await native('pixel', opaque)).rgb,
          [217, 232, 245],
          'An opaque child covers the material at its own bounds'
        );
        p.update({ theme: 'dark' });
        await delay(350);
        const dark = await materialState(p, 'acrylic');
        await capturePanel(p, 'acrylic-dark');
        const contrast = await native('image-contrast', {
          images: {
            reference,
            none: screenshots['acrylic-none'].path,
            light: screenshots['acrylic-light'].path,
            dark: screenshots['acrylic-dark'].path
          },
          regions: { high, low }
        });
        const referenceContrast = contrast.images.reference;
        assert.ok(
          referenceContrast.highDeviation > 80 && referenceContrast.lowContrast > 150,
          'The own-window reference has both high and low frequency contrast'
        );
        assert.ok(
          contrast.images.none.highDeviation < 3 && contrast.images.none.lowContrast < 3,
          'Solid material hides the host pattern'
        );
        for (const [name, observed] of [
          ['light', light],
          ['dark', dark]
        ]) {
          if (observed.applied === 'acrylic') {
            const measured = contrast.images[name];
            assert.ok(measured.lowContrast > 2, 'The system backdrop samples the real host behind it');
            const attenuation =
              measured.highDeviation /
              measured.lowContrast /
              (referenceContrast.highDeviation / referenceContrast.lowContrast);
            assert.ok(
              attenuation < 0.6,
              `${name} high-frequency blur differs from simple alpha transparency: ${attenuation}`
            );
            measured.relativeHighFrequency = attenuation;
          }
        }
        snapshot.materialBlur = { none, light, dark, contrast };
        for (const isDark of [false, true]) {
          const content = note({
            dark: isDark,
            submitOnEnter: false,
            value: Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行 · 记录想法与待办事项`).join('\n')
          });
          content.children.unshift(text('acrylic-note-title', '便笺', { fontSize: 16 }));
          content.children[1].style = { borderless: true, paddingTop: 6, paddingLeft: 4, paddingRight: 4 };
          p.update({ backgroundMaterial: 'acrylic', theme: noteTheme(isDark), content });
          await delay(250);
          await capturePanel(p, `acrylic-note-${isDark ? 'dark' : 'light'}`);
        }
        (snapshot.limitations ??= []).push(
          'Global transparency/high-contrast/energy-saver settings were read only; alternate policy states require a separate system configured by its user.'
        );
        assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
      } finally {
        p.destroy();
        await parent.webContents.executeJavaScript("document.querySelector('#material-pattern')?.remove()");
      }
    }
  );
  await check(
    'acrylic: none/acrylic updates retain multiline draft, focus, selection, caret and scrolled viewport',
    async () => {
      const value = Array.from({ length: 35 }, (_, i) => `Material draft ${i + 1} — 保留编辑状态`).join('\n');
      await withNote({ value, submitOnEnter: false }, async (p, actions) => {
        await click(p, 'note-body');
        await key(p, 0x23, [0x11]);
        await repeatKey(p, 0x25, 6, [0x10]);
        const before = editingState(p);
        assert.notEqual(before.selection.start, before.selection.end);
        assert.ok(before.displayOffset.y < 0);
        const count = actions.length;
        const states = [];
        for (const backgroundMaterial of ['acrylic', 'none', 'acrylic', 'none']) {
          p.update({ backgroundMaterial });
          await delay(120);
          assert.deepEqual(editingState(p), before);
          states.push(await materialState(p, backgroundMaterial));
        }
        assert.equal(actions.length, count);
        assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
        snapshot.materialEditing = { before, states };
      });
    }
  );
  await check('acrylic: material updates preserve real Chinese IME composition and commit', async () => {
    const layoutId = originalDesktop.imeLayouts.find((layout) => (layout & 0x3ff) === 4);
    assert.ok(layoutId, 'An installed Chinese IME is required');
    await withNote({}, async (p, actions) => {
      let previous;
      try {
        await click(p, 'note-body');
        previous = await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
        if (!node(p, 'note-body').composing && node(p, 'note-body').value === 'nihao') {
          await key(p, 0x41, [0x11]);
          await key(p, 0x08);
          await key(p, 0x10);
          await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
        }
        assert.equal(node(p, 'note-body').composing, true);
        const before = editingState(p);
        for (const backgroundMaterial of ['acrylic', 'none']) {
          p.update({ backgroundMaterial });
          assert.equal(node(p, 'note-body').composing, true);
          assert.deepEqual(editingState(p), before);
        }
        for (const scrollbarPlacement of ['overlay', 'gutter']) {
          const content = note();
          content.children[0].scrollbarPlacement = scrollbarPlacement;
          p.update({ content });
          const current = node(p, 'note-body');
          assert.equal(current.composing, true, 'Changing placement retains the active IME');
          assert.equal(current.value, before.value);
          assert.deepEqual(current.selection, before.selection);
          assert.equal(panelState(p).focusedId, before.focusedId);
        }
        await key(p, 0x20);
        assert.equal(node(p, 'note-body').composing, false);
        assert.match(node(p, 'note-body').value, /[\u3400-\u9fff]/);
        assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
      } finally {
        if (previous) await native('layout', { hwnd: Number(panelState(p).windowHandle), layout: previous.oldLayout });
      }
    });
  });
  await check('scrollbars: outer overflow shares the arrowless thumb, track paging, wheel and drag', async () => {
    const content = {
      type: 'column',
      id: 'outer-scroll-fixture',
      width: 330,
      children: Array.from({ length: 100 }, (_, i) => text(`outer-line-${i}`, `外层内容 ${i + 1}`, { height: 30 }))
    };
    const p = newPanel(content);
    const originalBounds = parent.getBounds();
    try {
      parent.setBounds(screen.getDisplayMatching(originalBounds).workArea);
      await delay(180);
      await show(p, 130, 90);
      const getBar = () => panelState(p).scrollbar;
      const result = await exerciseScrollbar(
        p,
        getBar,
        () => getBar().position,
        () => {
          const b = panelState(p).contentBounds;
          return physicalPoint({ x: Math.round(b.x + b.width / 2), y: b.y + 50 });
        },
        'scrollbar-outer'
      );
      const offset = getBar().position;
      p.update({ content });
      assert.equal(getBar().position, offset);
      snapshot.outerScrollbar = result;
    } finally {
      p.destroy();
      parent.setBounds(originalBounds);
      await delay(120);
    }
  });
  await check(
    'scrollbars: textarea uses the same native arrowless scrollbar without changing the fixed editor height',
    async () => {
      const value = Array.from({ length: 55 }, (_, i) => `编辑区内容 ${i + 1} — 继续记录`).join('\n');
      await withNote({ value, submitOnEnter: false }, async (p, actions) => {
        await click(p, 'note-body');
        // Views Textarea inherits Home as a line command, even with Control.
        // Collapse Select All at the left edge to establish the document start.
        await key(p, 0x41, [0x11]);
        await key(p, 0x25);
        const field = () => node(p, 'note-body');
        assert.deepEqual(field().selection, { start: 0, end: 0 });
        assert.equal(field().displayOffset.y, 0, 'Wheel begins at the verified top of the document');
        const result = await exerciseScrollbar(
          p,
          () => field().scrollbar,
          () => -field().displayOffset.y,
          () => scrollCenter(field().viewportBounds),
          'scrollbar-textarea',
          { theme: noteTheme(true), content: note({ value, submitOnEnter: false, dark: true }) }
        );
        assert.equal(field().bounds.height, 168);
        assert.equal(field().value, value);
        assert.equal(actions.filter((a) => a.type === 'submit').length, 0);
        snapshot.textareaScrollbar = result;
      });
    }
  );
}
async function scrollbarPlacementChecks() {
  await check('scrollbar placement: strict enums, atomic patches and independent node defaults', async () => {
    const tree = () => ({
      type: 'list',
      id: 'placement-list',
      width: 300,
      height: 130,
      children: Array.from({ length: 20 }, (_, i) => text(`placement-${i}`, `内容 ${i + 1}`, { height: 28 }))
    });
    const p = newPanel(tree(), { scrollbarPlacement: 'overlay' });
    try {
      await show(p, 176, 130);
      assert.equal(panelState(p).scrollbar.placement, 'overlay');
      assert.equal(
        node(p, 'placement-list').scrollbar.placement,
        'gutter',
        'Node default does not inherit the outer placement'
      );
      const before = panelState(p);
      for (const scrollbarPlacement of [null, true, 1, '', 'inside', 'outside', {}, []]) {
        assert.throws(() => newPanel(tree(), { scrollbarPlacement }));
        assert.throws(() => p.update({ scrollbarPlacement, theme: 'dark' }));
        assert.throws(() => p.update({ content: { ...tree(), scrollbarPlacement }, theme: 'dark' }));
        assert.throws(() => p.update({ content: { type: 'textarea', id: 'invalid-editor', scrollbarPlacement } }));
        assert.deepEqual(panelState(p), before);
      }
      assert.throws(() =>
        p.update({ content: { type: 'text', id: 'invalid-label', text: 'x', scrollbarPlacement: 'overlay' } })
      );
      assert.throws(() => p.update({ content: { ...tree(), style: { scrollbarPlacement: 'overlay' } } }));
      p.update({ theme: 'dark' });
      assert.equal(panelState(p).scrollbar.placement, 'overlay');
      p.update({ scrollbarPlacement: 'gutter' });
      assert.equal(panelState(p).scrollbar.placement, 'gutter');
    } finally {
      p.destroy();
    }
  });
  await check(
    'scrollbar placement: textarea hugs the frame independently of text padding and retains editing state',
    async () => {
      const value = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行 · 便笺正文`).join('\n');
      const tree = (placement = 'gutter', padding = {}, dark = false, includeValue = false) => {
        const content = note({ dark, ...(includeValue ? { value } : {}), submitOnEnter: false });
        content.children[0].scrollbarPlacement = placement;
        Object.assign(content.children[0].style, { paddingRight: 0 }, padding);
        return content;
      };
      const p = newPanel(tree('gutter', {}, false, true), { focusMode: 'input', theme: noteTheme() });
      const actions = [];
      p.on('action', (a) => actions.push(a));
      try {
        await show(p, 176, 130);
        await click(p, 'note-body');
        await key(p, 0x41, [0x11]);
        await key(p, 0x25);
        const field = () => node(p, 'note-body');
        const initial = field();
        const bar = initial.scrollbar.bounds;
        assert.equal(
          initial.bounds.x + initial.bounds.width - bar.x - bar.width,
          3,
          'The bar sits 2 DIP inside the 1 DIP frame'
        );
        assert.equal(bar.y - initial.bounds.y, 3, 'Text top padding does not inset the scrollbar');
        assert.ok(
          initial.viewportBounds.x + initial.viewportBounds.width <= bar.x - 2,
          'Gutter mode reserves room outside the editing viewport'
        );
        await native('wheel', {
          hwnd: Number(panelState(p).windowHandle),
          ...scrollCenter(initial.viewportBounds),
          delta: -120
        });
        await delay(120);
        const offset = field().displayOffset;
        assert.ok(offset.y < 0);
        const selection = field().selection;
        const states = [];
        for (const dark of [false, true]) {
          for (const placement of ['overlay', 'gutter']) {
            p.update({ content: tree(placement, {}, dark), theme: noteTheme(dark) });
            await delay(160);
            const current = field();
            assert.deepEqual(current.bounds, initial.bounds);
            assert.deepEqual(current.scrollbar.bounds, bar);
            assert.equal(current.scrollbar.placement, placement);
            assert.equal(current.value, value);
            assert.deepEqual(current.selection, selection);
            assert.deepEqual(current.displayOffset, offset);
            assert.equal(panelState(p).focusedId, 'note-body');
            if (placement === 'overlay') {
              assert.equal(
                current.viewportBounds.x + current.viewportBounds.width,
                current.bounds.x + current.bounds.width - 1
              );
              assert.ok(current.viewportBounds.width > initial.viewportBounds.width);
            } else {
              assert.equal(current.viewportBounds.width, initial.viewportBounds.width);
            }
            await capturePanel(p, `textarea-placement-${placement}-${dark ? 'dark' : 'light'}`);
            states.push(current);
          }
        }
        p.update({
          content: tree('gutter', { paddingTop: 30, paddingRight: 44, paddingBottom: 22 }),
          theme: noteTheme()
        });
        await delay(100);
        assert.deepEqual(field().scrollbar.bounds, bar, 'Large asymmetric text padding does not move the bar');
        assert.equal(field().viewportBounds.y - field().bounds.y, 31);
        assert.equal(
          field().bounds.x + field().bounds.width - field().viewportBounds.x - field().viewportBounds.width,
          45
        );
        assert.equal(field().value, value);
        assert.deepEqual(field().selection, selection);
        assert.equal(actions.length, 0, 'Layout changes do not emit editing actions');
        snapshot.textareaPlacement = { initial, states, padded: field() };
      } finally {
        p.destroy();
      }
    }
  );
  await check('scrollbar placement: list overlay and gutter change only the viewport allocation', async () => {
    const tree = (scrollbarPlacement = 'gutter') => ({
      type: 'list',
      id: 'placement-list',
      width: 320,
      height: 180,
      scrollbarPlacement,
      style: { paddingTop: 20, paddingRight: 30 },
      children: Array.from({ length: 30 }, (_, i) => text(`placement-row-${i}`, `列表内容 ${i + 1}`, { height: 30 }))
    });
    const p = newPanel(tree());
    try {
      await show(p, 176, 130);
      const initial = node(p, 'placement-list');
      const child = node(p, 'placement-row-0').bounds;
      await native('wheel', { hwnd: Number(panelState(p).windowHandle), ...scrollCenter(initial.bounds), delta: -120 });
      await delay(100);
      const offset = node(p, 'placement-list').scrollOffset;
      assert.ok(offset > 0);
      for (const placement of ['overlay', 'gutter', 'overlay']) {
        p.update({ content: tree(placement) });
        await delay(100);
        const current = node(p, 'placement-list');
        assert.deepEqual(current.bounds, initial.bounds);
        assert.equal(current.scrollOffset, offset);
        assert.equal(current.scrollbar.placement, placement);
        assert.equal(node(p, 'placement-row-0').bounds.width, child.width + (placement === 'overlay' ? 12 : 0));
      }
      snapshot.listPlacement = panelState(p);
    } finally {
      p.destroy();
    }
  });
  await check(
    'scrollbar placement: outer overflow switches live without moving the panel or scroll position',
    async () => {
      const content = {
        type: 'column',
        id: 'placement-outer',
        width: 300,
        children: Array.from({ length: 100 }, (_, i) =>
          text(`placement-outer-${i}`, `面板内容 ${i + 1}`, { height: 30 })
        )
      };
      const p = newPanel(content);
      try {
        await show(p, 130, 90);
        const initial = panelState(p);
        assert.equal(initial.scrollbar.visible, true);
        await native('wheel', {
          hwnd: Number(initial.windowHandle),
          ...scrollCenter(initial.contentBounds),
          delta: -120
        });
        await delay(100);
        const offset = panelState(p).scrollbar.position;
        assert.ok(offset > 0);
        for (const scrollbarPlacement of ['overlay', 'gutter']) {
          p.update({ scrollbarPlacement });
          await delay(120);
          const state = panelState(p);
          assert.deepEqual(state.bounds, initial.bounds);
          assert.equal(state.scrollbar.placement, scrollbarPlacement);
          assert.equal(state.scrollbar.position, offset);
        }
        snapshot.outerPlacement = panelState(p);
      } finally {
        p.destroy();
      }
    }
  );
}
function zoomControls(value = 100) {
  return [
    { type: 'button', id: 'minus', icon: image('minus'), accessibleName: '缩小', enabled: value > 25, group: 1 },
    { type: 'label', id: 'percentage', label: `${value}%`, group: 1 },
    { type: 'button', id: 'plus', icon: image('plus'), accessibleName: '放大', enabled: value < 200, group: 1 },
    { type: 'button', id: 'reset', icon: image('reload'), accessibleName: '重置缩放', enabled: value !== 100 }
  ];
}
function menuTemplate() {
  return [
    { id: 'find', label: '在页面中查找' },
    { label: '打印' },
    { type: 'separator' },
    { id: 'zoom', label: '缩放', controls: zoomControls() },
    { type: 'separator' },
    { label: '显示设备工具栏' },
    { label: '截取屏幕截图' },
    { type: 'separator' },
    { label: '导入 Cookie 和密码...' },
    { id: 'passwords', label: '密码和自动填充', submenu: [{ label: '密码管理器' }, { label: '联系信息' }] },
    { label: '下载' },
    { label: '历史记录' },
    { label: '清除浏览数据' },
    { type: 'separator' },
    { label: '浏览器设置' }
  ];
}
async function openMenu(
  menu,
  appearance = {
    theme: 'light',
    fontSize: 13,
    width: 230,
    rowHeight: 28,
    separatorSpacing: 11,
    itemPadding: 9,
    separatorInset: 9,
    background: '#FFFEFF',
    hover: '#F2F1F2'
  },
  x = 600
) {
  parent.focus();
  await delay(150);
  // Isolate keyboard navigation from hover left by another test menu.
  const content = parent.getContentBounds();
  await native('move', {
    hwnd: handle(),
    ...physicalPoint({ x: content.x + content.width - 32, y: content.y + 20 }),
    keepCursor: true
  });
  activeMenu = menu;
  menu.popup({ window: parent, x, y: 82, ...(appearance ? { appearance } : {}) });
  await delay(260);
  const state = menu._getPopupState()[0];
  assert.ok(
    state?.windowHandle && Number(state.windowHandle),
    'Menu did not stay open: ' + JSON.stringify(menu._getPopupState())
  );
  return state;
}
async function menuClick(menu, controlId) {
  const state = menu._getPopupState()[0];
  const control = state.rows.flatMap((row) => row.controls).find((control) => control.id === controlId);
  assert.ok(control, controlId);
  const point = physicalPoint({
    x: Math.round(control.bounds.x + control.bounds.width / 2),
    y: Math.round(control.bounds.y + control.bounds.height / 2)
  });
  await native('click', { hwnd: Number(state.windowHandle), ...point });
  await delay(90);
}
async function captureMenu(menu, name) {
  const state = menu._getPopupState()[0];
  const file = path.join(output, `${name}.png`);
  await native('screenshot', {
    hwnd: Number(state.windowHandle),
    bounds: screen.dipToScreenRect(parent, state.contentBounds || state.bounds),
    path: file
  });
  screenshots[name] = { path: file, state };
}
async function certificateState(wc, predicate = (s) => s.dom?.title) {
  let state;
  for (let i = 0; i < 80; ++i) {
    state = await wc._getCertificateViewerState();
    if (predicate(state)) return state;
    await delay(100);
  }
  assert.fail('Certificate WebUI did not reach the expected state: ' + JSON.stringify(state));
}
async function certificateClick(state, bounds) {
  const point = physicalPoint({
    x: Math.round(state.contentBounds.x + bounds.x + bounds.width / 2),
    y: Math.round(state.contentBounds.y + bounds.y + bounds.height / 2)
  });
  const hit = await native('hit', point);
  assert.equal(hit.root, Number(state.windowHandle));
  await native('click', {
    hwnd: Number(state.windowHandle),
    ...point,
    activationPoint: physicalPoint({ x: state.bounds.x + 100, y: state.bounds.y + 15 })
  });
  await delay(100);
}
async function captureCertificate(state, name) {
  const file = path.join(output, `${name}.png`);
  await native('screenshot', {
    hwnd: Number(state.windowHandle),
    bounds: screen.dipToScreenRect(parent, state.bounds),
    path: file
  });
  screenshots[name] = { path: file, state };
}
async function certificateExport(state, format, expected) {
  await certificateClick(state, state.dom.elements.find((e) => e.id === 'export').bounds);
  let dialog;
  for (let i = 0; i < 40 && !dialog; ++i) {
    dialog = (await native('windows')).windows.find((w) => w.visible && w.class === '#32770');
    if (!dialog) await delay(100);
  }
  if (!dialog) snapshot.exportWindowFailure = { ...(await native('windows')), processes: app.getAppMetrics() };
  assert.ok(dialog, 'Native Save As dialog');
  const controls = (await native('controls', { hwnd: dialog.hwnd })).controls;
  (snapshot.exportDialogs ??= []).push({ dialog, controls });
  const point = (control) => ({
    x: Math.round(control.bounds.x + control.bounds.width / 2),
    y: Math.round(control.bounds.y + control.bounds.height / 2)
  });
  const formats = controls.find((c) => c.visible && c.class === 'ComboBox' && c.items?.length >= 5);
  const filename = controls.filter((c) => c.visible && c.class === 'Edit').sort((a, b) => b.bounds.y - a.bounds.y)[0];
  const save = controls.find((c) => c.visible && c.class === 'Button' && c.id === 1);
  assert.ok(formats && filename && save, JSON.stringify(controls));
  assert.equal(formats.items.length, 6);
  if (format === -1) {
    await native('key', { hwnd: dialog.hwnd, vk: 0x1b, forceActivation: true });
    return;
  }
  await native('click', { hwnd: dialog.hwnd, ...point(formats), forceActivation: true });
  await native('key', { hwnd: dialog.hwnd, vk: 0x24 });
  for (let i = 0; i < format; ++i) await native('key', { hwnd: dialog.hwnd, vk: 0x28 });
  await native('key', { hwnd: dialog.hwnd, vk: 0x0d });
  let previousName;
  let settled = 0;
  for (let i = 0; i < 20 && settled < 2; ++i) {
    const current = (await native('controls', { hwnd: dialog.hwnd })).controls;
    const selected = current.find((c) => c.hwnd === formats.hwnd)?.selectedIndex;
    const name = current.find((c) => c.hwnd === filename.hwnd)?.text;
    settled = selected === format && name === previousName ? settled + 1 : 0;
    previousName = name;
    await delay(100);
  }
  assert.equal(settled, 2, 'Native export format and automatic filename suffix settle before typing');
  const suffix = ['pem', 'pem', 'der', 'p7c', 'p7c'][format];
  const file = path.join(output, `certificate-export-${format}.${suffix}`);
  fs.rmSync(file, { force: true });
  let verified = false;
  for (let attempt = 1; attempt <= 2 && !verified; ++attempt) {
    await native('click', { hwnd: dialog.hwnd, ...point(filename) });
    await native('key', { hwnd: dialog.hwnd, vk: 0x41, modifiers: [0x11] });
    await native('text', { hwnd: dialog.hwnd, text: file, textIntervalMs: 10 });
    const observations = [];
    let exactReads = 0;
    for (let i = 0; i < 10 && exactReads < 2; ++i) {
      const current = (await native('controls', { hwnd: dialog.hwnd })).controls;
      const actual = current.find((c) => c.hwnd === filename.hwnd)?.text;
      observations.push(actual);
      exactReads = actual === file ? exactReads + 1 : 0;
      await delay(100);
    }
    verified = exactReads === 2;
    (snapshot.exportFilenameInput ??= []).push({ format, attempt, expected: file, observations, verified });
  }
  assert.ok(verified, 'Native filename Edit must exactly retain the requested path before Save');
  await native('click', { hwnd: dialog.hwnd, ...point(save) });
  for (let i = 0; i < 60 && !fs.existsSync(file); ++i) await delay(100);
  assert.ok(fs.existsSync(file), 'Exported certificate file');
  const data = fs.readFileSync(file);
  if (format < 2) {
    const blocks = data.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    assert.equal(blocks.length, format === 1 ? expected.length : 1);
    blocks.forEach((block, i) =>
      assert.equal(
        new crypto.X509Certificate(block).fingerprint256.replace(/:/g, '').toLowerCase(),
        expected[i].sha256.toLowerCase()
      )
    );
  } else if (format === 2) {
    assert.equal(
      new crypto.X509Certificate(data).fingerprint256.replace(/:/g, '').toLowerCase(),
      expected[0].sha256.toLowerCase()
    );
  } else {
    const { stdout } = await run(
      process.env.NATIVE_UI_PYTHON,
      [
        '-c',
        'import json,sys; from cryptography.hazmat.primitives.serialization.pkcs7 import load_der_pkcs7_certificates; from cryptography.hazmat.primitives import hashes; print(json.dumps([c.fingerprint(hashes.SHA256()).hex() for c in load_der_pkcs7_certificates(open(sys.argv[1],"rb").read())]))',
        file
      ],
      { windowsHide: true, timeout: 15000 }
    );
    assert.deepEqual(
      JSON.parse(stdout).sort(),
      expected
        .slice(0, format === 3 ? 1 : expected.length)
        .map((c) => c.sha256.toLowerCase())
        .sort()
    );
  }
  (snapshot.exports ??= []).push({ format: formats.items[format], path: file, bytes: data.length });
}
function destroyPanels() {
  for (const panel of panels) panel.destroy();
}
async function all() {
  await app.whenReady();
  nativeTheme.themeSource = 'light';
  originalDesktop = await native('windows');
  server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html;charset=utf-8');
    response.end(
      `<!doctype html><meta charset=utf-8><title>Native UI preview</title><style>body{margin:0;font:14px 'Segoe UI',sans-serif;color:#171717}header{height:88px;background:#fff;border-bottom:1px solid #eee;display:flex;align-items:center;padding:0 22px;gap:12px}#address{border:1px solid #e4e4e4;border-radius:24px;width:580px;padding:12px 18px;font:14px 'Segoe UI'}main{padding:62px 28px}h1{font-size:32px;margin:0 0 8px}p{font-size:18px;color:#676767}#agent{position:absolute;left:28px;top:380px}canvas{position:absolute;left:28px;top:450px;width:80px;height:30px}</style><header><span>←　→　↻</span><input id=address value="learn.chatgpt.com/docs/changelog"><span>　♧　↓　⋯</span></header><main><h1>ChatGPT &amp; Codex changelog</h1><p>Latest updates to ChatGPT and Codex</p></main><input id=agent aria-label="Page agent input"><canvas width=80 height=30></canvas><script>window.framesPainted=0;const c=document.querySelector('canvas').getContext('2d');function paint(){framesPainted++;c.fillStyle='rgb('+(framesPainted%256)+',100,140)';c.fillRect(0,0,80,30);requestAnimationFrame(paint)}paint()</script>`
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  parent = new BrowserWindow({
    x: 40,
    y: 30,
    width: 1000,
    height: 760,
    autoHideMenuBar: true,
    title: 'Native UI preview',
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  await parent.loadURL(`http://127.0.0.1:${server.address().port}`);
  parent.show();
  parent.setAlwaysOnTop(true);
  parent.focus();
  await delay(300);
  const initialBounds = parent.getContentBounds();
  const initialPoint = physicalPoint({ x: initialBounds.x + initialBounds.width - 32, y: initialBounds.y + 20 });
  await native('click', { hwnd: handle(), ...initialPoint, activationPoint: initialPoint });
  const wc = parent.webContents;
  await loadMenuIcons(wc);
  snapshot = {
    locale: app.getLocale(),
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    displays: screen.getAllDisplays(),
    webContentsBefore: webContents.getAllWebContents().length
  };

  await check('downloads: flat rows, independent icon actions, progress refresh and light screenshot', async () => {
    const p = newPanel(downloads());
    const actions = [];
    p.on('action', (action) => actions.push(action));
    try {
      await show(p, 460, 86);
      await capturePanel(p, 'downloads-light');
      await click(p, 'reveal-1');
      assert.deepEqual(
        actions.map((a) => a.id),
        ['reveal-1']
      );
      await click(p, 'download-0');
      assert.deepEqual(
        actions.map((a) => a.id),
        ['reveal-1', 'download-0']
      );
      const tree = downloads();
      tree.children[1].children[0].children[1].children[1].text = '下载中 · 12.4 MB / 20 MB';
      p.update({ content: tree });
      assert.equal(node(p, 'status-0').text, '下载中 · 12.4 MB / 20 MB');
      assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
    } finally {
      p.destroy();
    }
  });
  await check(
    'address suggestions: no activation steal, highlighted text, selected row scroll and atomic styles',
    async () => {
      await wc.executeJavaScript("document.querySelector('#address').focus()");
      wc.focus();
      const p = newPanel(suggestions(), { focusMode: 'none' });
      const actions = [];
      p.on('action', (a) => actions.push(a));
      try {
        const foreground = (await native('windows')).foreground;
        await show(p, 112, 76);
        assert.equal((await native('windows')).foreground, foreground);
        await capturePanel(p, 'address-suggestions');
        p.update({ content: suggestions(30, 26) });
        assert.ok(node(p, 'suggestion-list').scrollOffset > 0);
        assert.equal(actions.length, 0);
        assert.equal(await wc.executeJavaScript('document.activeElement.id'), 'address');
        const before = panelState(p);
        for (const style of [{ radius: -1 }, { color: 'red' }, { fontWeight: 'heavy' }, { css: 'display:none' }]) {
          const tree = suggestions();
          tree.children[0].children[0].style = style;
          assert.throws(() => p.update({ content: tree, theme: 'dark' }));
          assert.deepEqual(panelState(p), before);
        }
      } finally {
        p.destroy();
      }
    }
  );
  await check('list row keyboard navigation executes only on confirmation', async () => {
    const p = newPanel(suggestions());
    const actions = [];
    p.on('action', (a) => actions.push(a));
    try {
      await show(p, 112, 76);
      await click(p, 'suggestion-0');
      actions.length = 0;
      await key(p, 0x28);
      assert.equal(actions.length, 0);
      assert.equal(panelState(p).focusedId, 'suggestion-1');
      await key(p, 0x0d);
      assert.deepEqual(
        actions.map((a) => a.id),
        ['suggestion-1']
      );
    } finally {
      p.destroy();
    }
  });
  await check(
    'address details: aligned width, natural title then URL, ellipsis, reserved delete target and retained address selection',
    async () => {
      const rect = await wc.executeJavaScript(
        `(() => { const a=document.querySelector('#address'); a.style.width='548px';a.style.padding='6px 10px';a.style.font='13px Segoe UI';a.style.outline='none';a.style.background='#F2F2F2';const style=document.createElement('style');style.textContent='#address::selection{background:#B6D4E8;color:#111}';document.head.append(style);a.value='https://etherscan.io/accounts/label/lido';a.focus();a.select();const r=a.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`
      );
      const b = parent.getContentBounds();
      const p = newPanel(detailedSuggestions(Math.round(rect.width)), {
        focusMode: 'none',
        contentInset: 4,
        radius: 12
      });
      const actions = [];
      p.on('action', (action) => actions.push(action));
      try {
        p.show({
          anchorBounds: {
            x: b.x + Math.round(rect.x),
            y: b.y + Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          placement: 'bottom-start'
        });
        await delay(220);
        const body = panelState(p).contentBounds;
        assert.ok(Math.abs(body.x - b.x - rect.x) <= 1);
        assert.ok(
          Math.abs(body.width - Math.round(rect.width)) <= 1,
          'Fractional-DPI width must stay within one enclosing DIP'
        );
        const title = node(p, 'detail-title-0').bounds;
        const url = node(p, 'detail-url-0').bounds;
        assert.ok(url.x - title.x - title.width <= 8, 'URL must immediately follow its title');
        assert.ok(node(p, 'detail-title-4').bounds.width <= Math.round(rect.width * 0.56));
        const selection = await wc.executeJavaScript(
          '({id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})'
        );
        assert.equal(selection.id, 'address');
        assert.equal(selection.start, 0);
        assert.ok(selection.end > 20);
        await capturePanel(p, 'address-suggestions-details');
        const contextPath = path.join(output, 'address-suggestions-details-context.png');
        const context = {
          x: body.x - 8,
          y: b.y + Math.round(rect.y) - 10,
          width: body.width + 21,
          height: body.y + body.height + 20 - (b.y + Math.round(rect.y) - 10)
        };
        await native('screenshot', {
          hwnd: Number(panelState(p).windowHandle),
          bounds: screen.dipToScreenRect(parent, context),
          path: contextPath
        });
        screenshots['address-suggestions-details-context'] = { path: contextPath, state: panelState(p) };
        await click(p, 'detail-remove-0');
        assert.deepEqual(
          actions.map((a) => a.id),
          ['detail-remove-0']
        );
        assert.equal(await wc.executeJavaScript('document.activeElement.id'), 'address');
        const after = await wc.executeJavaScript(
          '({start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})'
        );
        assert.equal(after.start, selection.start);
        assert.equal(after.end, selection.end);
      } finally {
        p.destroy();
      }
    }
  );
  await check('floating input: borderless draft, stable update, submit and independent voice action', async () => {
    const p = newPanel(comment(), {
      focusMode: 'input',
      radius: 30,
      contentInset: 10,
      theme: { mode: 'light', fontSize: 13, muted: '#BEBEBE' }
    });
    const actions = [];
    p.on('action', (a) => actions.push(a));
    try {
      await show(p, 170, 180);
      await capturePanel(p, 'floating-comment');
      await click(p, 'comment-input');
      await native('text', { hwnd: Number(panelState(p).windowHandle), text: '测试评论草稿' });
      p.update({ content: comment() });
      assert.equal(node(p, 'comment-input').value, '测试评论草稿');
      assert.equal(panelState(p).focusedId, 'comment-input');
      await click(p, 'comment-microphone');
      assert.equal(actions.filter((a) => a.id === 'comment-microphone').length, 1);
      await click(p, 'comment-input');
      await key(p, 0x0d);
      assert.equal(actions.filter((a) => a.type === 'submit').length, 1);
      assert.equal(actions.find((a) => a.type === 'submit').value, '测试评论草稿');
    } finally {
      p.destroy();
    }
  });
  await check('external address IME: composition keeps address focus and does not confirm suggestions', async () => {
    const layoutId = originalDesktop.imeLayouts.find((layout) => (layout & 0x3ff) === 4);
    assert.ok(layoutId, 'An installed Chinese IME is required');
    const rect = await wc.executeJavaScript(`(() => {
      const a=document.querySelector('#address'); a.value=''; a.focus();
      window.addressComposition=false;
      a.addEventListener('compositionstart',()=>window.addressComposition=true);
      a.addEventListener('compositionend',()=>window.addressComposition=false);
      const r=a.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const b = parent.getContentBounds();
    wc.focus();
    await native('click', {
      hwnd: handle(),
      ...physicalPoint({
        x: Math.round(b.x + rect.x + rect.width / 2),
        y: Math.round(b.y + rect.y + rect.height / 2)
      })
    });
    const p = newPanel(suggestions(), { focusMode: 'none' });
    let confirmations = 0;
    let previous;
    const onInput = (_event, input) => {
      if (input.key === 'Enter' && !input.isComposing) confirmations++;
    };
    wc.on('before-input-event', onInput);
    try {
      await show(p, 112, 76);
      previous = await native('ime', { hwnd: handle(), layout: layoutId, keys: 'nihao' });
      snapshot.externalIme = {
        previous,
        dom: await wc.executeJavaScript(
          '({composition:window.addressComposition,active:document.activeElement.id,value:document.querySelector("#address").value,focus:document.hasFocus()})'
        ),
        windows: await native('windows')
      };
      assert.equal(await wc.executeJavaScript('window.addressComposition'), true);
      assert.equal(await wc.executeJavaScript('document.activeElement.id'), 'address');
      p.update({ content: suggestions(8, 2) });
      assert.equal(await wc.executeJavaScript('window.addressComposition'), true);
      await native('key', { hwnd: handle(), vk: 0x20 });
      assert.match(await wc.executeJavaScript('document.querySelector("#address").value'), /[\u3400-\u9fff]/);
      assert.equal(confirmations, 0);
    } finally {
      if (previous) await native('layout', { hwnd: handle(), layout: previous.oldLayout });
      wc.off('before-input-event', onInput);
      p.destroy();
    }
  });
  await check('borderless native input IME: preserve composition on update and reserve first Escape', async () => {
    const layoutId = originalDesktop.imeLayouts.find((layout) => (layout & 0x3ff) === 4);
    assert.ok(layoutId);
    const p = newPanel(comment(), {
      focusMode: 'input',
      radius: 30,
      contentInset: 10,
      theme: { mode: 'light', fontSize: 13, muted: '#BEBEBE' }
    });
    const dismissed = [];
    p.on('dismissed', (e) => dismissed.push(e));
    let previous;
    try {
      await show(p, 170, 180);
      await click(p, 'comment-input');
      previous = await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
      assert.equal(node(p, 'comment-input').composing, true);
      p.update({ content: comment(), theme: 'dark' });
      assert.equal(node(p, 'comment-input').composing, true);
      await key(p, 0x1b);
      assert.equal(panelState(p).visible, true);
      assert.equal(dismissed.length, 0);
      await native('ime', { hwnd: Number(panelState(p).windowHandle), layout: layoutId, keys: 'nihao' });
      await key(p, 0x20);
      assert.match(node(p, 'comment-input').value, /[\u3400-\u9fff]/);
      p.update({ theme: { mode: 'light', fontSize: 13, muted: '#BBBBBB' } });
      await capturePanel(p, 'floating-comment-ime');
    } finally {
      if (previous) await native('layout', { hwnd: Number(panelState(p).windowHandle), layout: previous.oldLayout });
      p.destroy();
    }
  });
  await textareaChecks();
  await acrylicChecks();
  await scrollbarPlacementChecks();
  await check(
    'menu: isolated appearance, native segmented zoom, repeated clicks, refresh and no NativePanel',
    async () => {
      const menu = Menu.buildFromTemplate(menuTemplate());
      let value = 100;
      const actions = [];
      let closed = 0;
      menu.on('menu-will-close', () => closed++);
      menu.on('control-action', (detail) => {
        actions.push(detail);
        value = detail.controlId === 'reset' ? 100 : value + (detail.controlId === 'plus' ? 10 : -10);
        menu.getMenuItemById('zoom').controls = zoomControls(value);
        menu.refresh();
      });
      const beforePanels = panels.length;
      try {
        await openMenu(menu);
        await captureMenu(menu, 'menu-light');
        const beforeHover = menu._getPopupState()[0];
        const inline = beforeHover.rows[0].controls;
        assert.equal(inline.find((c) => c.id === 'plus').bounds.width, 24);
        assert.equal(inline.find((c) => c.id === 'percentage').bounds.width, 44);
        assert.equal(inline.find((c) => c.id === 'plus').bounds.height, 24);
        const plus = inline.find((c) => c.id === 'plus').bounds;
        await native('move', {
          hwnd: Number(beforeHover.windowHandle),
          ...physicalPoint({ x: Math.round(plus.x + plus.width / 2), y: Math.round(plus.y + plus.height / 2) }),
          keepCursor: true
        });
        await captureMenu(menu, 'menu-zoom-hover');
        await native('restore', { cursor: originalDesktop.cursor });
        await menuClick(menu, 'plus');
        await menuClick(menu, 'plus');
        assert.equal(value, 120);
        assert.equal(closed, 0);
        assert.equal(menu._getPopupState()[0].rows[0].controls.find((c) => c.id === 'percentage').label, '120%');
        await menuClick(menu, 'reset');
        assert.equal(value, 100);
        assert.equal(actions.length, 3);
        assert.equal(panels.length, beforePanels);
        assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
        const frames = await wc.executeJavaScript('framesPainted');
        await delay(200);
        assert.ok((await wc.executeJavaScript('framesPainted')) > frames + 2);
        const previous = menu._getPopupState();
        menu.getMenuItemById('zoom').controls = [{ id: 'oops', type: 'button', label: '?' }];
        assert.throws(() => menu.refresh());
        assert.deepEqual(menu._getPopupState(), previous);
        menu.getMenuItemById('zoom').controls = zoomControls(value);
        menu.refresh();
        const state = menu._getPopupState()[0];
        await native('key', { hwnd: Number(state.windowHandle), vk: 0x1b });
        await delay(160);
        assert.equal(closed, 1);
      } finally {
        menu.closePopup(parent);
        activeMenu = undefined;
      }
    }
  );
  await check('menu: submenu native keyboard open and screenshot', async () => {
    const menu = Menu.buildFromTemplate(menuTemplate());
    try {
      const state = await openMenu(menu, undefined, 200);
      const item = state.items.find((item) => item.label === '密码和自动填充');
      assert.ok(item);
      const point = physicalPoint({
        x: Math.round(item.bounds.x + item.bounds.width / 2),
        y: Math.round(item.bounds.y + item.bounds.height / 2)
      });
      await native('click', { hwnd: Number(state.windowHandle), ...point });
      await delay(240);
      await native('key', { hwnd: Number(state.windowHandle), vk: 0x25 });
      await native('key', { hwnd: Number(state.windowHandle), vk: 0x27 });
      await delay(300);
      const windows = (await native('windows')).windows.filter(
        (w) =>
          w.visible &&
          w.class.includes('Chrome_WidgetWin') &&
          w.hwnd !== handle() &&
          !panels.some((p) => Number(panelState(p).windowHandle) === w.hwnd)
      );
      assert.ok(windows.length >= 2, 'Expected native parent and submenu hosts: ' + JSON.stringify(windows));
      await captureMenu(menu, 'menu-submenu-parent');
      for (let i = 0; i < windows.length; ++i) {
        const w = windows[i];
        const file = path.join(output, `menu-submenu-window-${i}.png`);
        await native('screenshot', { hwnd: w.hwnd, bounds: w.bounds, path: file });
        screenshots[`menu-submenu-window-${i}`] = { path: file, nativeWindow: w };
      }
    } finally {
      menu.closePopup(parent);
      activeMenu = undefined;
    }
  });
  await check('menu: dark theme and malformed appearance rejection', async () => {
    const menu = Menu.buildFromTemplate(menuTemplate());
    try {
      for (const appearance of [
        { radius: -1 },
        { theme: true },
        { background: 'white' },
        { unknown: 1 },
        { rowHeight: 1.5 }
      ]) {
        assert.throws(() => menu.popup({ window: parent, appearance }));
      }
      await openMenu(menu, { theme: 'dark', width: 230, fontSize: 13, rowHeight: 28, separatorSpacing: 11 });
      await captureMenu(menu, 'menu-dark');
    } finally {
      menu.closePopup(parent);
      activeMenu = undefined;
    }
  });
  await check(
    'inline native link: precise hit area, keyboard focus, stable updates and atomic range validation',
    async () => {
      const content = {
        type: 'text',
        id: 'inline-link',
        width: 300,
        text: 'Connection details. Learn more',
        linkRange: { start: 20, end: 30 }
      };
      const p = newPanel(content, { focusMode: 'input' });
      const actions = [];
      p.on('action', (a) => actions.push(a));
      try {
        await show(p, 110, 85);
        const link = node(p, 'inline-link').linkBounds[0];
        assert.ok(link);
        await native('click', {
          hwnd: Number(panelState(p).windowHandle),
          ...physicalPoint({
            x: Math.round(link.x + link.width / 2),
            y: Math.round(link.y + link.height / 2)
          })
        });
        await delay(70);
        assert.deepEqual(
          actions.map((a) => a.id),
          ['inline-link']
        );
        p.update({ content: { ...content } });
        p.update({ theme: 'dark' });
        assert.equal(panelState(p).focusedId, 'inline-link');
        const before = panelState(p);
        assert.throws(() => p.update({ content: { ...content, linkRange: { start: 20, end: 999 } }, theme: 'light' }));
        assert.deepEqual(panelState(p), before);
      } finally {
        p.destroy();
      }
    }
  );
  await check('menu: close policy, callback reentry and lifetime while inline actions close the popup', async () => {
    const menu = Menu.buildFromTemplate([
      { id: 'zoom', label: 'Zoom', controls: [{ id: 'go', type: 'button', label: 'Done', closeOnClick: true }] }
    ]);
    let callbacks = 0;
    let actions = 0;
    menu.on('control-action', () => {
      actions++;
      assert.equal(menu._getPopupState().length, 0);
    });
    try {
      parent.focus();
      menu.popup({ window: parent, x: 600, y: 82, appearance: { theme: 'light' }, callback: () => callbacks++ });
      await delay(200);
      await menuClick(menu, 'go');
      assert.equal(actions, 1);
      assert.equal(callbacks, 1);
      menu.closePopup(parent);
      assert.equal(callbacks, 1);
    } finally {
      menu.closePopup(parent);
    }
  });
  await check('menu: left-opening submenu at display edge and combined native screenshot', async () => {
    const before = parent.getBounds();
    const work = screen.getDisplayMatching(before).workArea;
    const menu = Menu.buildFromTemplate(menuTemplate());
    try {
      parent.setPosition(work.x + work.width - before.width, work.y + 30);
      await delay(120);
      const s = await openMenu(
        menu,
        { theme: 'light', fontSize: 13, width: 230, rowHeight: 28, separatorSpacing: 11 },
        990
      );
      const item = s.items.find((i) => i.label === '密码和自动填充');
      assert.ok(item);
      await native('click', {
        hwnd: Number(s.windowHandle),
        ...physicalPoint({
          x: Math.round(item.bounds.x + item.bounds.width / 2),
          y: Math.round(item.bounds.y + item.bounds.height / 2)
        })
      });
      await delay(280);
      const windows = (await native('windows')).windows;
      const child = windows.find(
        (w) =>
          w.visible && w.class.includes('Chrome_WidgetWin') && w.hwnd !== handle() && w.hwnd !== Number(s.windowHandle)
      );
      assert.ok(child);
      const raw = screen.dipToScreenRect(parent, s.bounds),
        body = screen.dipToScreenRect(parent, s.contentBounds);
      const cb = {
        x: child.bounds.x + body.x - raw.x,
        y: child.bounds.y + body.y - raw.y,
        width: child.bounds.width - (raw.width - body.width),
        height: child.bounds.height - (raw.height - body.height)
      };
      snapshot.reverseMenu = { state: s, windows, child, childBody: cb, body };
      assert.ok(cb.x < body.x, 'Submenu must flip left at the work-area edge');
      const union = {
        x: Math.min(cb.x, body.x),
        y: Math.min(cb.y, body.y),
        width: Math.max(cb.x + cb.width, body.x + body.width) - Math.min(cb.x, body.x),
        height: Math.max(cb.y + cb.height, body.y + body.height) - Math.min(cb.y, body.y)
      };
      const file = path.join(output, 'menu-submenu.png');
      await native('screenshot', { hwnd: Number(s.windowHandle), bounds: union, path: file });
      screenshots['menu-submenu'] = { path: file, state: s, child };
    } finally {
      menu.closePopup(parent);
      parent.setBounds(before);
    }
  });
  await check('menu keyboard: arrows, Tab, Shift+Tab, Enter, Space and Escape use native inline controls', async () => {
    const menu = Menu.buildFromTemplate(menuTemplate());
    let value = 100;
    const actions = [];
    menu.on('control-action', (a) => {
      actions.push(a.controlId);
      value = a.controlId === 'reset' ? 100 : value + (a.controlId === 'plus' ? 10 : -10);
      menu.getMenuItemById('zoom').controls = zoomControls(value);
      menu.refresh();
    });
    try {
      const s = await openMenu(menu);
      const press = async (vk, modifiers = []) => {
        await native('key', { hwnd: Number(s.windowHandle), vk, modifiers });
        await delay(65);
      };
      const hot = () => menu._getPopupState()[0].rows[0].controls.find((c) => c.hotTracked)?.id;
      await press(0x24);
      await press(0x28);
      await press(0x28);
      assert.equal(hot(), 'minus');
      await press(0x28);
      assert.equal(hot(), 'plus');
      await press(0x0d);
      assert.equal(value, 110);
      await press(0x09);
      assert.equal(hot(), 'reset');
      await press(0x09, [0x10]);
      assert.equal(hot(), 'plus');
      await press(0x20);
      assert.equal(value, 120);
      await press(0x09);
      await press(0x0d);
      assert.equal(value, 100);
      assert.deepEqual(actions, ['plus', 'plus', 'reset']);
      await press(0x1b);
      assert.equal(menu._getPopupState().length, 0);
    } finally {
      menu.closePopup(parent);
    }
  });
  await check(
    'menu icons and selection: shared icon columns, checkbox toggle, exclusive radio and disabled actions',
    async () => {
      const beforePanels = panels.length;
      const clicked = [];
      const menu = Menu.buildFromTemplate([
        { id: 'home', label: '新标签页首页', icon: image('home'), click: () => clicked.push('home') },
        { id: 'sliders', label: '网页尺寸与缩放', icon: image('sliders') },
        { id: 'forward', label: '前进', icon: image('forward-disabled'), enabled: false },
        { label: '在网页中查找', icon: image('search') },
        { id: 'download', label: '下载列表', icon: image('download') },
        { type: 'separator' },
        { id: 'settings', label: '浏览器设置', icon: image('settings') },
        { type: 'separator' },
        { id: 'popout', label: '移至独立窗口', icon: image('popout') },
        { id: 'split', label: '收起工作区（恢复分栏）', icon: image('split') }
      ]);
      const clickItem = async (current, label) => {
        const item = current.items.find((i) => i.label === label);
        assert.ok(item, label);
        await native('click', {
          hwnd: Number(current.windowHandle),
          ...physicalPoint({
            x: Math.round(item.bounds.x + item.bounds.width / 2),
            y: Math.round(item.bounds.y + item.bounds.height / 2)
          })
        });
        await delay(100);
      };
      const appearance = {
        theme: 'light',
        width: 200,
        fontSize: 13,
        rowHeight: 28,
        itemPadding: 9,
        separatorInset: 9,
        separatorSpacing: 11
      };
      try {
        let s = await openMenu(menu, appearance, 250);
        await captureMenu(menu, 'menu-icons-light');
        await clickItem(s, '前进');
        assert.equal(menu._getPopupState().length, 1);
        assert.deepEqual(clicked, []);
        await clickItem(s, '新标签页首页');
        assert.deepEqual(clicked, ['home']);
        assert.equal(menu._getPopupState().length, 0);
        for (const id of ['home', 'sliders', 'forward', 'download', 'settings', 'popout', 'split']) {
          menu.getMenuItemById(id).icon = image(id + (id === 'forward' ? '-dark-disabled' : '-dark'));
        }
        s = await openMenu(menu, { ...appearance, theme: 'dark' }, 250);
        await captureMenu(menu, 'menu-icons-dark');
        menu.closePopup(parent);
        const checks = Menu.buildFromTemplate([
          { id: 'check-toolbar', label: '显示工具栏', type: 'checkbox', checked: true },
          { id: 'check-side', label: '显示侧边栏', type: 'checkbox' },
          { label: '不可用的选项', type: 'checkbox', checked: true, enabled: false },
          { type: 'separator' },
          { id: 'radio-system', label: '跟随系统', type: 'radio', checked: true },
          { id: 'radio-light', label: '浅色', type: 'radio' },
          { id: 'radio-dark', label: '深色', type: 'radio' }
        ]);
        try {
          let current = await openMenu(checks, { ...appearance, width: 260 }, 250);
          await captureMenu(checks, 'menu-check-radio-light');
          await clickItem(current, '显示侧边栏');
          assert.equal(checks.getMenuItemById('check-side').checked, true);
          current = await openMenu(checks, { ...appearance, width: 260 }, 250);
          await clickItem(current, '浅色');
          assert.equal(checks.getMenuItemById('radio-light').checked, true);
          assert.equal(checks.getMenuItemById('radio-system').checked, false);
          assert.equal(checks.getMenuItemById('radio-dark').checked, false);
          current = await openMenu(checks, { ...appearance, width: 260 }, 250);
          const hover = current.items.find((i) => i.label === '浅色').bounds;
          await native('move', {
            hwnd: Number(current.windowHandle),
            ...physicalPoint({ x: Math.round(hover.x + hover.width / 2), y: Math.round(hover.y + hover.height / 2) }),
            keepCursor: true
          });
          await captureMenu(checks, 'menu-check-radio-hover');
          await native('restore', { cursor: originalDesktop.cursor });
          checks.closePopup(parent);
          await openMenu(checks, { ...appearance, width: 260, theme: 'dark' }, 250);
          await captureMenu(checks, 'menu-check-radio-dark');
          checks.closePopup(parent);
          const mixed = Menu.buildFromTemplate([
            { id: 'mixed-check', label: '勾选与图标同时存在', type: 'checkbox', checked: true, icon: image('home') },
            { label: '普通菜单项', icon: image('settings') },
            { label: '未勾选项', type: 'checkbox' }
          ]);
          try {
            await openMenu(mixed, { ...appearance, width: 260 }, 250);
            await captureMenu(mixed, 'menu-mixed-selection-icons');
          } finally {
            mixed.closePopup(parent);
          }
          assert.equal(panels.length, beforePanels);
          assert.equal(webContents.getAllWebContents().length, snapshot.webContentsBefore);
        } finally {
          checks.closePopup(parent);
        }
      } finally {
        menu.closePopup(parent);
      }
    }
  );
  await check(
    'default menu regression: ordinary commands, checkbox, radio, disabled item and native submenu',
    async () => {
      let childClicks = 0;
      const menu = Menu.buildFromTemplate([
        { id: 'check', label: 'Check', type: 'checkbox' },
        { id: 'radio-a', label: 'Radio A', type: 'radio', checked: true },
        { id: 'radio-b', label: 'Radio B', type: 'radio' },
        { type: 'separator' },
        { label: 'Disabled', enabled: false },
        { label: 'Submenu', submenu: [{ label: 'Child', accelerator: 'Ctrl+Shift+F', click: () => childClicks++ }] }
      ]);
      const clickItem = async (s, label) => {
        const item = s.items.find((i) => i.label === label);
        assert.ok(item, label);
        await native('click', {
          hwnd: Number(s.windowHandle),
          ...physicalPoint({
            x: Math.round(item.bounds.x + item.bounds.width / 2),
            y: Math.round(item.bounds.y + item.bounds.height / 2)
          })
        });
        await delay(120);
      };
      try {
        await clickItem(await openMenu(menu, null), 'Check');
        assert.equal(menu.getMenuItemById('check').checked, true);
        assert.equal(menu._getPopupState().length, 0);
        await clickItem(await openMenu(menu, null), 'Radio B');
        assert.equal(menu.getMenuItemById('radio-b').checked, true);
        assert.equal(menu.getMenuItemById('radio-a').checked, false);
        const s = await openMenu(menu, null);
        await clickItem(s, 'Disabled');
        assert.equal(menu._getPopupState().length, 1);
        await captureMenu(menu, 'menu-default');
        await clickItem(s, 'Submenu');
        await native('key', { hwnd: Number(s.windowHandle), vk: 0x27 });
        await native('key', { hwnd: Number(s.windowHandle), vk: 0x0d });
        await delay(100);
        assert.equal(childClicks, 1);
        assert.equal(menu._getPopupState().length, 0);
      } finally {
        menu.closePopup(parent);
      }
    }
  );
  await check('menu lifetime: close callback reopens the root and closing the parent releases its runner', async () => {
    const menu = Menu.buildFromTemplate([
      { id: 'row', label: 'Close', controls: [{ id: 'done', type: 'button', label: 'Done', closeOnClick: true }] }
    ]);
    let callbacks = 0;
    try {
      menu.popup({
        window: parent,
        x: 600,
        y: 82,
        appearance: { theme: 'light' },
        callback: () => {
          callbacks++;
          menu.popup({ window: parent, x: 600, y: 82, appearance: { theme: 'dark' }, callback: () => callbacks++ });
        }
      });
      await delay(180);
      await menuClick(menu, 'done');
      assert.equal(callbacks, 1);
      assert.equal(menu._getPopupState().length, 1);
      menu.refresh();
      menu.closePopup(parent);
      assert.equal(callbacks, 2);
      const child = new BrowserWindow({ width: 360, height: 240, show: false, webPreferences: { sandbox: true } });
      try {
        child.show();
        child.focus();
        menu.popup({ window: child, x: 80, y: 60, appearance: { theme: 'light' } });
        await delay(120);
        assert.equal(menu._getPopupState().length, 1);
        child.destroy();
        await delay(120);
        assert.equal(menu._getPopupState().length, 0);
      } finally {
        if (!child.isDestroyed()) child.destroy();
        parent.focus();
      }
    } finally {
      menu.closePopup();
    }
  });
  await check('locale menu: native submenu horizontal navigation follows application direction', async () => {
    const rtl = /^(ar|fa|he|ur)(-|$)/.test(app.getLocale());
    const menu = Menu.buildFromTemplate(menuTemplate());
    try {
      const s = await openMenu(menu, undefined, 250);
      const item = s.items.find((i) => i.label === '密码和自动填充');
      const menuWindows = async () =>
        (await native('windows')).windows.filter(
          (w) => w.visible && w.class.includes('Chrome_WidgetWin') && w.hwnd !== handle()
        );
      await native('click', {
        hwnd: Number(s.windowHandle),
        ...physicalPoint({
          x: Math.round(item.bounds.x + item.bounds.width / 2),
          y: Math.round(item.bounds.y + item.bounds.height / 2)
        })
      });
      await delay(150);
      await native('key', { hwnd: Number(s.windowHandle), vk: rtl ? 0x27 : 0x25 });
      assert.equal((await menuWindows()).length, 1);
      await native('key', { hwnd: Number(s.windowHandle), vk: rtl ? 0x25 : 0x27 });
      await delay(150);
      const hosts = await menuWindows();
      assert.equal(hosts.length, 2);
      await captureMenu(menu, 'menu-locale');
      const child = hosts.find((w) => w.hwnd !== Number(s.windowHandle));
      const file = path.join(output, 'menu-locale-submenu.png');
      await native('screenshot', { hwnd: child.hwnd, bounds: child.bounds, path: file });
      screenshots['menu-locale-submenu'] = { path: file, nativeWindow: child };
    } finally {
      menu.closePopup(parent);
    }
  });
  await check(
    'scrollbars: list uses a thin rounded arrowless thumb, transparent track, native paging/drag and hover',
    async () => {
      const tree = () => ({
        type: 'column',
        id: 'scrollbar-fixture',
        width: 360,
        gap: 6,
        children: [
          text('scroll-title', '原生滚动条'),
          {
            type: 'list',
            id: 'scroll-list',
            height: 220,
            children: Array.from({ length: 45 }, (_, i) => ({
              type: 'row',
              id: `scroll-row-${i}`,
              height: 32,
              children: [text(`scroll-text-${i}`, `证书字段 ${i + 1}`)]
            }))
          }
        ]
      });
      const p = newPanel(tree());
      const actions = [];
      p.on('action', (a) => actions.push(a));
      const bar = () => node(p, 'scroll-list').scrollbar;
      try {
        await show(p, 130, 100);
        const result = await exerciseScrollbar(
          p,
          bar,
          () => node(p, 'scroll-list').scrollOffset,
          () => scrollCenter(node(p, 'scroll-list').bounds),
          'scrollbar-list'
        );
        const offset = node(p, 'scroll-list').scrollOffset;
        p.update({ content: tree() });
        assert.equal(node(p, 'scroll-list').scrollOffset, offset);
        snapshot.listScrollbar = result;
        assert.equal(actions.length, 0);
        const short = tree();
        short.children[1].children.length = 1;
        p.update({ content: short });
        assert.equal(bar().visible, false);
      } finally {
        p.destroy();
      }
    }
  );
  await focusRingChecks(wc);
  await check('PageInfo: Chromium locale, native security subpage/back and website settings event', async () => {
    let settings;
    const listener = (_e, detail) => {
      settings = detail;
    };
    wc.on('page-info-open-site-settings', listener);
    try {
      const info = wc._getPageInfo(false);
      snapshot.pageInfo = { securityState: info.securityState, presentation: info.presentation };
      assert.ok(info.presentation.summary && info.presentation.settings);
      if (app.getLocale().startsWith('zh')) assert.match(info.presentation.settings, /网站|站点/);
      if (app.getLocale().startsWith('en')) assert.equal(info.presentation.settings, 'Site settings');
      if (app.getLocale().startsWith('ar')) assert.match(info.presentation.settings, /[\u0600-\u06ff]/);
      wc.showPageInfoDialog({ anchorBounds: anchor(120, 76) });
      await delay(220);
      const p = panels.at(-1);
      const rtl = /^(ar|fa|he|ur)(-|$)/.test(app.getLocale());
      assert.equal(node(p, 'page-info-close').bounds.x > node(p, 'page-info-title').bounds.x, !rtl);
      await capturePanel(p, 'page-info-main');
      await click(p, 'page-info-security');
      assert.ok(node(p, 'page-info-description').text);
      await capturePanel(p, 'page-info-security');
      await click(p, 'page-info-back');
      await click(p, 'page-info-site-settings');
      assert.equal(settings.origin, new URL(wc.getURL()).origin);
    } finally {
      wc.removeListener('page-info-open-site-settings', listener);
    }
  });
  await check(
    'PageInfo: real TLS certificate, original Chromium WebUI, independent trees and isolated renderer',
    async () => {
      const preload = path.join(output, 'host-preload.cjs');
      fs.writeFileSync(
        preload,
        "require('electron').contextBridge.exposeInMainWorld('__nativeUiHostPreload', true);\n"
      );
      const preloadId = wc.session.registerPreloadScript({ type: 'frame', filePath: preload });
      registeredPreloads.push({ session: wc.session, id: preloadId });
      const target = process.env.NATIVE_UI_TLS_URL || 'https://example.com/';
      await Promise.race([
        wc.loadURL(target),
        delay(20000).then(() => {
          throw new Error('TLS fixture navigation timed out');
        })
      ]);
      const info = wc._getPageInfo(false);
      assert.equal(await wc.executeJavaScript('globalThis.__nativeUiHostPreload'), true);
      assert.ok(info.certificate);
      assert.ok(info.presentation.chain.length);
      const leaf = info.presentation.chain[0];
      assert.equal(
        leaf.sha256.toLowerCase(),
        new crypto.X509Certificate(info.certificate.data).fingerprint256.replace(/:/g, '').toLowerCase()
      );
      assert.ok(leaf.spki && leaf.fields.length > 5);
      const before = webContents.getAllWebContents().length;
      wc.showPageInfoDialog({ anchorBounds: anchor(120, 76) });
      await delay(220);
      const main = panels.at(-1);
      await capturePanel(main, 'page-info-tls-main');
      await click(main, 'page-info-security');
      await capturePanel(main, 'page-info-tls-security');
      const beforePanels = panels.length;
      await click(main, 'page-info-certificate');
      let cert = await certificateState(wc);
      assert.equal(cert.url, 'chrome://view-cert/');
      assert.equal(cert.dom.process, 'undefined');
      assert.equal(cert.dom.require, 'undefined');
      assert.equal(cert.dom.hostPreload, 'undefined');
      assert.equal(cert.dom.chromeSend, 'function');
      assert.equal(panels.length, beforePanels);
      assert.equal(webContents.getAllWebContents().length, before);
      assert.equal(cert.dom.elements.find((e) => e.id === 'sha256').text.toLowerCase(), leaf.sha256.toLowerCase());
      await captureCertificate(cert, 'certificate-general');
      await certificateClick(cert, cert.dom.elements.find((e) => e.id === 'details-tab').bounds);
      cert = await certificateState(wc, (s) => s.dom?.items?.some((i) => i.detail.val));
      const hierarchy = cert.dom.elements.find((e) => e.id === 'hierarchy');
      const fields = cert.dom.elements.find((e) => e.id === 'cert-fields');
      const value = cert.dom.elements.find((e) => e.id === 'cert-field-value');
      assert.ok(hierarchy.bounds.y + hierarchy.bounds.height < fields.bounds.y);
      assert.ok(fields.bounds.y + fields.bounds.height < value.bounds.y);
      const serial = cert.dom.items.find((i) => i.label === leaf.fields[1].label && i.detail.val);
      assert.ok(serial);
      await certificateClick(cert, serial.bounds);
      cert = await certificateState(
        wc,
        (s) => s.dom?.elements?.find((e) => e.id === 'cert-field-value')?.text === serial.detail.val
      );
      await captureCertificate(cert, 'certificate-details');
      for (const format of [-1, 0, 1, 2, 3, 4]) await certificateExport(cert, format, info.presentation.chain);
      await native('wheel', {
        hwnd: Number(cert.windowHandle),
        ...physicalPoint({
          x: Math.round(cert.contentBounds.x + hierarchy.bounds.x + 30),
          y: Math.round(cert.contentBounds.y + hierarchy.bounds.y + 30)
        }),
        delta: 480
      });
      cert = await certificateState(wc);
      const root = cert.dom.items.find((i) => i.detail.index === info.presentation.chain.length - 1);
      assert.ok(root);
      await certificateClick(cert, root.bounds);
      await certificateState(wc, (s) =>
        s.dom?.items?.some((i) => i.label === root.label && i.detail.index === undefined)
      );
      await native('key', { hwnd: Number(cert.windowHandle), vk: 0x73, modifiers: [0x12], forceActivation: true });
      await delay(160);
      assert.equal((await wc._getCertificateViewerState()).windowHandle, undefined);
      assert.equal(main.isDestroyed(), true);
      nativeTheme.themeSource = 'dark';
      try {
        wc.showPageInfoDialog({ anchorBounds: anchor(120, 76) });
        await delay(160);
        const dark = panels.at(-1);
        await capturePanel(dark, 'page-info-dark');
        await click(dark, 'page-info-security');
        await click(dark, 'page-info-certificate');
        const darkCert = await certificateState(wc);
        await captureCertificate(darkCert, 'certificate-dark');
        wc._closeCertificateViewer();
        await delay(120);
      } finally {
        nativeTheme.themeSource = 'light';
      }
      snapshot.tls = {
        url: wc.getURL(),
        securityState: info.securityState,
        subject: info.certificate.subjectName,
        chainLength: info.presentation.chain.length,
        certificateBackend: 'Chromium WebUI',
        additionalNativeWebContents: 1
      };
      wc.showPageInfoDialog({ anchorBounds: anchor(120, 76) });
      await delay(160);
      const navigating = panels.at(-1);
      await click(navigating, 'page-info-security');
      await click(navigating, 'page-info-certificate');
      await certificateState(wc);
      await wc.loadURL('about:blank');
      await certificateState(wc, (s) => !s.windowHandle);
      assert.equal(navigating.isDestroyed(), true);
      await wc.loadURL('chrome://view-cert/');
      assert.equal(await wc.executeJavaScript('document.querySelector("#sha256").textContent'), '');
      snapshot.tls.navigationClosesViewer = true;
      snapshot.tls.directResourceNavigationHasNoCertificate = true;
    }
  );
}
all()
  .catch((error) => {
    results.push({ name: 'preview runner', ok: false, error: error.stack });
  })
  .finally(async () => {
    activeMenu?.closePopup(parent);
    for (const { session, id } of registeredPreloads) session.unregisterPreloadScript(id);
    destroyPanels();
    if (parent && !parent.isDestroyed()) parent.destroy();
    server?.close();
    if (originalDesktop) await native('restore', originalDesktop).catch(() => {});
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(
      path.join(output, 'results.json'),
      JSON.stringify(
        { summary: { total: results.length, passed: results.length - failed, failed }, results, screenshots, snapshot },
        null,
        2
      )
    );
    app.exit(failed ? 1 : 0);
  });
