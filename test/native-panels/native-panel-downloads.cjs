/* Reference download flyout, rendered entirely by NativePanel. Host supplies business actions. */
const { app, BrowserWindow, NativePanel, Menu, nativeImage, screen, webContents } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.env.NATIVE_PANEL_DOWNLOADS_OUTPUT;
if (!output) throw new Error('Set NATIVE_PANEL_DOWNLOADS_OUTPUT');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'native-download-panel-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let owner;
let panel;
let original;
const results = [];
const captures = [];
async function native(action, options = {}) {
  const request = { pid: process.pid, action, ...options };
  const { stdout } = await run(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [path.join(__dirname, 'native-panels-win.py'), Buffer.from(JSON.stringify(request)).toString('base64')],
    { windowsHide: true, timeout: 15000 }
  );
  return JSON.parse(stdout);
}
function toolbarIcon(kind, dark) {
  const segments = [];
  const dots = [];
  const add = (...points) => points.slice(1).forEach((point, index) => segments.push([points[index], point]));
  const circle = (x, y, radius, start = 0, end = Math.PI * 2) => {
    const points = Array.from({ length: 65 }, (_, i) => [
      x + radius * Math.cos(start + ((end - start) * i) / 64),
      y + radius * Math.sin(start + ((end - start) * i) / 64)
    ]);
    add(...points);
  };
  if (kind === 'search') {
    circle(10, 10, 7);
    add([15.2, 15.2], [21, 21]);
  }
  if (kind === 'folder') {
    add(
      [2, 7],
      [2, 20],
      [3, 21],
      [21, 21],
      [22, 20],
      [22, 8],
      [21, 7],
      [11, 7],
      [8, 4],
      [3, 4],
      [2, 5],
      [2, 7],
      [11, 7]
    );
  }
  if (kind === 'more') dots.push([4, 12, 1.5], [12, 12, 1.5], [20, 12, 1.5]);
  if (kind === 'retry') {
    circle(12, 12, 8, 0.2, Math.PI * 1.85);
    add([20, 3], [20, 9], [14, 9]);
  }
  const factor = 3,
    size = 24 * factor;
  const buffer = Buffer.alloc(size * size * 4);
  const ink = dark ? 240 : 38;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / factor,
        y = (py + 0.5) / factor;
      let distance = Infinity;
      for (const [a, b] of segments) {
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
        distance = Math.min(distance, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) - 0.7);
      }
      for (const [cx, cy, r] of dots) distance = Math.min(distance, Math.hypot(x - cx, y - cy) - r);
      const alpha = Math.max(0, Math.min(1, 0.5 - distance * factor)) * 255;
      const offset = (py * size + px) * 4;
      buffer[offset] = buffer[offset + 1] = buffer[offset + 2] = Math.round((ink * alpha) / 255);
      buffer[offset + 3] = Math.round(alpha);
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size, scaleFactor: factor });
}
async function description(dark) {
  const mp4 = path.join(profile, 'video.mp4');
  const zip = path.join(profile, 'archive.zip');
  fs.writeFileSync(mp4, '');
  fs.writeFileSync(zip, '');
  const [exeIcon, videoIcon, zipIcon] = await Promise.all([
    app.getFileIcon(process.execPath, { size: 'normal' }),
    app.getFileIcon(mp4, { size: 'normal' }),
    app.getFileIcon(zip, { size: 'normal' })
  ]);
  const foreground = dark ? '#F3F3F3' : '#202020';
  const muted = dark ? '#B5B5B5' : '#737373';
  const action = (id, kind, label) => ({
    type: 'iconButton',
    id,
    image: toolbarIcon(kind, dark),
    accessibleName: label,
    iconSize: 24,
    width: 36,
    height: 36,
    style: { radius: 8 }
  });
  return {
    type: 'column',
    id: 'downloads',
    width: 480,
    gap: 0,
    children: [
      {
        type: 'row',
        id: 'header',
        height: 52,
        gap: 10,
        style: { paddingLeft: 12, paddingRight: 4 },
        children: [
          { type: 'text', id: 'heading', text: '下载', flex: 1, style: { fontSize: 22, fontWeight: 'bold' } },
          action('open-folder', 'folder', '打开下载文件夹'),
          action('search-downloads', 'search', '搜索下载'),
          action('more-downloads', 'more', '更多操作')
        ]
      },
      { type: 'column', id: 'header-divider', height: 1, style: { background: '$subtleBorder' }, children: [] },
      {
        type: 'list',
        id: 'files',
        height: 294,
        gap: 6,
        style: { paddingTop: 8 },
        children: [
          {
            type: 'item',
            id: 'complete',
            height: 76,
            gap: 10,
            accessibleName: 'QQ 下载完成',
            style: { radius: 16, align: 'start', paddingTop: 13, paddingBottom: 10, paddingLeft: 12, paddingRight: 12 },
            children: [
              { type: 'icon', id: 'exe-icon', image: exeIcon, width: 26, height: 26 },
              {
                type: 'column',
                id: 'complete-copy',
                flex: 1,
                gap: 5,
                children: [
                  {
                    type: 'text',
                    id: 'exe-name',
                    text: 'QQ_9.9.37_261103_x64_01.exe',
                    singleLine: true,
                    style: { fontSize: 17 }
                  },
                  {
                    type: 'text',
                    id: 'open-file',
                    text: '打开文件',
                    linkRange: { start: 0, end: 4 },
                    style: { fontSize: 15, linkColor: foreground }
                  }
                ]
              }
            ]
          },
          {
            type: 'item',
            id: 'deleted',
            height: 76,
            gap: 10,
            accessibleName: '视频文件已删除',
            style: { radius: 16, align: 'start', paddingTop: 13, paddingBottom: 10, paddingLeft: 12, paddingRight: 12 },
            children: [
              { type: 'icon', id: 'video-icon', image: videoIcon, width: 26, height: 26 },
              {
                type: 'column',
                id: 'deleted-copy',
                flex: 1,
                gap: 6,
                children: [
                  {
                    type: 'text',
                    id: 'video-name',
                    text: '67cf70c2101d7a7dc2afddc3.mp4',
                    singleLine: true,
                    style: { fontSize: 17, color: muted, textDecoration: 'line-through' }
                  },
                  { type: 'text', id: 'deleted-status', text: '已删除', style: { fontSize: 15, color: muted } }
                ]
              }
            ]
          },
          {
            type: 'item',
            id: 'cancelled',
            height: 108,
            gap: 10,
            accessibleName: '压缩包下载已取消',
            style: {
              radius: 16,
              align: 'start',
              paddingTop: 13,
              paddingBottom: 12,
              paddingLeft: 12,
              paddingRight: 12,
              hover: { background: dark ? '#24FFFFFF' : '#E0E0E0' }
            },
            children: [
              { type: 'icon', id: 'zip-icon', image: zipIcon, width: 26, height: 26 },
              {
                type: 'column',
                id: 'cancelled-copy',
                flex: 1,
                gap: 6,
                children: [
                  {
                    type: 'text',
                    id: 'zip-name',
                    text: 'lineage-14.1-20180613-UNOFFICIAL-c7proltedd (1).zip',
                    maxLines: 2,
                    style: { fontSize: 17, lineHeight: 25 }
                  },
                  { type: 'text', id: 'cancelled-status', text: '已取消', style: { fontSize: 15, color: muted } }
                ]
              },
              {
                type: 'column',
                id: 'retry-slot',
                height: 82,
                justify: 'center',
                width: 34,
                children: [
                  {
                    ...action('retry-download', 'retry', '重试下载'),
                    height: 34,
                    width: 34,
                    style: { radius: 8, background: dark ? '#20FFFFFF' : '#C6C6C6', paddingTop: 0, paddingBottom: 0 }
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        type: 'row',
        id: 'footer',
        height: 46,
        style: { paddingTop: 8 },
        children: [
          {
            type: 'button',
            id: 'show-all',
            text: '查看更多',
            variant: 'outlined',
            style: {
              fontSize: 15,
              radius: 8,
              borderColor: '$subtleBorder',
              borderWidth: 1,
              paddingTop: 5,
              paddingBottom: 5,
              paddingLeft: 12,
              paddingRight: 12
            }
          }
        ]
      }
    ]
  };
}
app
  .whenReady()
  .then(async () => {
    original = await native('windows');
    fs.mkdirSync(output, { recursive: true });
    const work = screen.getPrimaryDisplay().workArea;
    owner = new BrowserWindow({
      x: work.x + 30,
      y: work.y + 30,
      width: 860,
      height: 700,
      backgroundColor: '#EEF1F5',
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    await owner.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<style>body{margin:0;display:flex;background:#EDF1F4;font:20px sans-serif;color:#38475C}div{width:33.33%;height:700px;box-sizing:border-box;padding:30px}div:nth-child(1){background:#9DBDD1}div:nth-child(2){background:#E6CEA5}div:nth-child(3){background:#A3C5B4}</style><div>下载记录</div><div>浏览器工作区</div><div>阅读与收藏</div>'
        )
    );
    const count = webContents.getAllWebContents().length;
    for (const [mode, material] of [
      ['light', 'none'],
      ['light', 'acrylic'],
      ['dark', 'acrylic']
    ]) {
      const name = 'downloads-' + mode + '-' + material;
      try {
        if (panel) panel.destroy();
        panel = new NativePanel({
          parent: owner,
          content: await description(mode === 'dark'),
          radius: 20,
          contentInset: 12,
          backgroundMaterial: material,
          dismissOnOutsideClick: false,
          theme: {
            mode,
            background: mode === 'light' ? '#FFFFFF' : '#252525',
            text: mode === 'light' ? '#202020' : '#F3F3F3',
            muted: mode === 'light' ? '#737373' : '#B5B5B5',
            fontFamily: 'Segoe UI',
            fontSize: 15,
            border: mode === 'light' ? '#10000000' : '#20FFFFFF'
          }
        });
        panel.on('context-menu', (action) =>
          panel.popupMenu(Menu.buildFromTemplate([{ label: '重试下载' }, { label: '从列表中移除' }]), {
            id: action.id,
            x: action.anchor.x,
            y: action.anchor.y,
            sourceType: action.sourceType
          })
        );
        panel.show({ anchorBounds: { x: work.x + 160, y: work.y + 80, width: 24, height: 24 } });
        await wait(150);
        const target = panel.getBounds('retry-download');
        await native('move', {
          hwnd: Number(panel.getDiagnostics().windowHandle),
          ...screen.dipToScreenPoint({
            x: Math.round(target.x + target.width / 2),
            y: Math.round(target.y + target.height / 2)
          }),
          keepCursor: true
        });
        await wait(140);
        const state = panel.getDiagnostics();
        assert.equal(state.controls.find((node) => node.id === 'cancelled').hovered, true);
        assert.equal(state.controls.find((node) => node.id === 'video-name').style.textDecoration, 'line-through');
        assert.ok(panel.getBounds('zip-name').height >= 40);
        assert.equal(webContents.getAllWebContents().length, count);
        const file = path.join(output, name + '.png');
        await native('screenshot', {
          hwnd: Number(state.windowHandle),
          bounds: screen.dipToScreenRect(null, state.bounds),
          path: file
        });
        const materialState = await native('material', { hwnd: Number(state.windowHandle) });
        const body = state.contentBounds;
        const points = [
          { x: body.x + 1, y: body.y + 1 },
          { x: body.x + body.width - 2, y: body.y + 1 },
          { x: body.x + 1, y: body.y + body.height - 2 },
          { x: body.x + body.width - 2, y: body.y + body.height - 2 },
          { x: body.x + body.width / 2, y: body.y - 12 },
          { x: body.x + body.width / 2, y: body.y + body.height + 3 }
        ].map((point) => screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) }));
        const visiblePixels = [];
        for (const point of points) {
          assert.notEqual((await native('hit', point)).root, Number(state.windowHandle));
          visiblePixels.push((await native('pixel', point)).rgb);
        }
        panel.hide();
        await wait(90);
        const hiddenPixels = [];
        for (const point of points) hiddenPixels.push((await native('pixel', point)).rgb);
        const changes = visiblePixels.map((rgb, index) =>
          rgb.map((value, channel) => hiddenPixels[index][channel] - value)
        );
        for (const change of changes.slice(0, 5)) {
          assert.ok(Math.max(...change.map(Math.abs)) <= 8, 'Blur or tint escaped the rounded material clip');
        }
        assert.ok(changes[5].reduce((sum, value) => sum + value, 0) > 3, 'Exterior shadow is missing');
        if (state.backgroundMaterialApplied === 'acrylic') {
          assert.equal(state.materialBackend, 'composition-host-backdrop');
          assert.ok(state.backdropWindowHandle && state.backdropWindowHandle !== '0');
        }
        const hiddenWindows = (await native('windows')).windows;
        for (const handle of [state.windowHandle, state.shadowWindowHandle, state.backdropWindowHandle].filter(
          Boolean
        )) {
          assert.ok(
            !hiddenWindows.find((window) => window.hwnd === Number(handle))?.visible,
            'Hidden panel retained a visible surface'
          );
        }
        panel.update({ radius: 48, shadow: false });
        panel.show({ anchorBounds: { x: work.x + 160, y: work.y + 80, width: 24, height: 24 } });
        await wait(90);
        const resized = panel.getDiagnostics();
        assert.deepEqual(resized.bounds, resized.contentBounds);
        const corner = screen.dipToScreenPoint({ x: resized.bounds.x + 2, y: resized.bounds.y + 2 });
        assert.notEqual((await native('hit', corner)).root, Number(resized.windowHandle));
        panel.update({ backgroundMaterial: 'none' });
        assert.equal(panel.getDiagnostics().backgroundMaterialApplied, 'none');
        if (state.backdropWindowHandle) {
          assert.ok(
            !(await native('windows')).windows.some((window) => window.hwnd === Number(state.backdropWindowHandle)),
            'Disabling Acrylic retained its native material window'
          );
        }
        panel.update({ backgroundMaterial: material, radius: 20, shadow: true });
        panel.hide();
        captures.push({
          name,
          screenshot: file,
          state,
          materialState,
          geometry: { points, visiblePixels, hiddenPixels, changes }
        });
        results.push({ name, ok: true });
      } catch (error) {
        results.push({ name, ok: false, error: error.stack });
      }
    }
  })
  .catch((error) => results.push({ name: 'download gallery completion', ok: false, error: error.stack }))
  .finally(async () => {
    if (panel && !panel.isDestroyed()) panel.destroy();
    if (owner && !owner.isDestroyed()) owner.destroy();
    if (original) await native('restore', { foreground: original.foreground, cursor: original.cursor }).catch(() => {});
    const failed = results.filter((result) => !result.ok).length;
    fs.writeFileSync(
      path.join(output, 'downloads-results.json'),
      JSON.stringify(
        {
          executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
          summary: { total: results.length, passed: results.length - failed, failed },
          results,
          captures,
          notes: [
            'Layout references the user-provided browser download flyout.',
            'File-type icons come from Windows. Download/open/retry business operations are supplied by the host application.',
            'DWM owns material availability and opacity; each capture includes the actual applied state.'
          ]
        },
        null,
        2
      )
    );
    app.exit(failed ? 1 : 0);
  });
