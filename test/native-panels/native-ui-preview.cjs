/* Real native UI acceptance and screenshots. Run with the newly built Electron. */
const { app, BrowserWindow, NativePanel, Menu, nativeImage, nativeTheme, screen, webContents } = require('electron');
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
  await native('key', { hwnd: Number(panelState(panel).windowHandle), vk, modifiers });
  await delay(80);
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
  const suffix = ['pem', 'pem', 'der', 'p7c', 'p7c'][format];
  const file = path.join(output, `certificate-export-${format}.${suffix}`);
  fs.rmSync(file, { force: true });
  await native('click', { hwnd: dialog.hwnd, ...point(filename) });
  await native('key', { hwnd: dialog.hwnd, vk: 0x41, modifiers: [0x11] });
  await native('text', { hwnd: dialog.hwnd, text: file });
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
    'scrollbars: rounded gray thumb, arrows, track paging, native drag, hover and stable scroll updates',
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
      const center = (r) => physicalPoint({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      const bar = () => node(p, 'scroll-list').scrollbar;
      const press = async (r) => {
        await native('click', { hwnd: Number(panelState(p).windowHandle), ...center(r) });
        await delay(80);
      };
      try {
        await show(p, 130, 100);
        assert.equal(bar().bounds.width, 15);
        assert.equal(bar().visible, true);
        await native('move', {
          hwnd: Number(panelState(p).windowHandle),
          ...center(node(p, 'scroll-title').bounds),
          keepCursor: true
        });
        await delay(100);
        assert.deepEqual((await native('pixel', center(bar().thumb))).rgb, [141, 141, 141]);
        await capturePanel(p, 'scrollbar-light');
        await press(bar().next);
        const down = node(p, 'scroll-list').scrollOffset;
        assert.ok(down > 0);
        await press(bar().previous);
        assert.ok(node(p, 'scroll-list').scrollOffset < down);
        const b = bar();
        await press({ x: b.bounds.x, y: b.thumb.y + b.thumb.height + 30, width: b.bounds.width, height: 15 });
        assert.ok(node(p, 'scroll-list').scrollOffset > down);
        const dragging = bar();
        await native('drag', {
          hwnd: Number(panelState(p).windowHandle),
          ...center(dragging.thumb),
          end: physicalPoint({
            x: Math.round(dragging.bounds.x + dragging.bounds.width / 2),
            y: Math.round(dragging.next.y - 2)
          })
        });
        await delay(100);
        assert.ok(node(p, 'scroll-list').scrollOffset > bar().maximum * 0.9);
        const offset = node(p, 'scroll-list').scrollOffset;
        p.update({ content: tree() });
        assert.equal(node(p, 'scroll-list').scrollOffset, offset);
        await native('move', { hwnd: Number(panelState(p).windowHandle), ...center(bar().thumb), keepCursor: true });
        await delay(150);
        assert.deepEqual((await native('pixel', center(bar().thumb))).rgb, [112, 112, 112]);
        await capturePanel(p, 'scrollbar-hover');
        p.update({ theme: 'dark' });
        await capturePanel(p, 'scrollbar-dark');
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
