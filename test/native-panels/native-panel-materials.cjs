/* Native Acrylic composition gallery and acceptance; panel rendering uses Views only. */
const { app, BrowserWindow, NativePanel, nativeImage, screen, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.env.NATIVE_PANEL_MATERIALS_OUTPUT;
if (!output) throw new Error('Set NATIVE_PANEL_MATERIALS_OUTPUT to the gallery output directory');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'native-panel-materials-')));
app.on('window-all-closed', () => {});
const results = [];
const captures = [];
let owner;
let panel;
let original;
async function native(action, options = {}) {
  const request = { action, pid: process.pid, ...options };
  const { stdout } = await run(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [path.join(__dirname, 'native-panels-win.py'), Buffer.from(JSON.stringify(request)).toString('base64')],
    { windowsHide: true, timeout: 15000 }
  );
  return JSON.parse(stdout);
}
function icon(dark, kind = 'tab') {
  const size = 20;
  const bitmap = Buffer.alloc(size * size * 4);
  const value = dark ? 224 : 70;
  for (let y = 3; y < 17; y++) {
    for (let x = 3; x < 17; x++) {
      if (x === 3 || x === 16 || y === 3 || y === 16 || (kind === 'tab' && y === 6)) {
        const i = (y * size + x) * 4;
        bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = value;
        bitmap[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}
function content(dark) {
  const titles = ['NativePanel 交互方案', '设计系统更新', '本周阅读'];
  const details = ['当前工作区 · 文档', '设计资源 · 最近访问', '个人收藏 · 8 个标签'];
  return {
    type: 'column',
    id: 'root',
    width: 392,
    gap: 14,
    children: [
      {
        type: 'row',
        id: 'heading',
        gap: 8,
        children: [
          { type: 'text', id: 'title', text: '网页与工作区', flex: 1, style: { fontSize: 18, fontWeight: 'medium' } },
          { type: 'button', id: 'manage', text: '管理', variant: 'plain', style: { color: '$muted' } }
        ]
      },
      {
        type: 'input',
        id: 'search',
        placeholder: '搜索标签、地址或工作区',
        height: 40,
        navigationTarget: 'results',
        accessibleName: '搜索标签、地址或工作区'
      },
      { type: 'text', id: 'section', text: '最近访问', muted: true, style: { fontSize: 12, paddingLeft: 8 } },
      {
        type: 'list',
        id: 'results',
        height: 196,
        gap: 4,
        children: titles.map((title, i) => ({
          type: 'item',
          id: 'result-' + i,
          height: 60,
          selected: i === 1,
          accessibleName: title,
          style: { radius: 7, paddingLeft: 10, paddingRight: 10 },
          children: [
            { type: 'icon', id: 'icon-' + i, image: icon(dark), width: 20, height: 20 },
            {
              type: 'column',
              id: 'copy-' + i,
              flex: 1,
              gap: 4,
              children: [
                { type: 'text', id: 'name-' + i, text: title, singleLine: true, style: { fontSize: 14 } },
                {
                  type: 'text',
                  id: 'detail-' + i,
                  text: details[i],
                  singleLine: true,
                  muted: true,
                  style: { fontSize: 12 }
                }
              ]
            },
            {
              type: 'iconButton',
              id: 'row-action-' + i,
              image: icon(dark, 'square'),
              iconSize: 16,
              accessibleName: '更多操作',
              hoverOnly: true,
              width: 28,
              height: 28
            }
          ]
        }))
      },
      { type: 'column', id: 'divider', height: 1, style: { background: '$subtleBorder' }, children: [] },
      {
        type: 'row',
        id: 'footer',
        children: [
          { type: 'button', id: 'new-workspace', text: '新建工作区', variant: 'plain' },
          { type: 'text', id: 'shortcut', text: 'Ctrl+K', muted: true, flex: 1, style: { align: 'end', fontSize: 12 } }
        ]
      }
    ]
  };
}
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
  }
}
app
  .whenReady()
  .then(async () => {
    original = await native('windows');
    fs.mkdirSync(output, { recursive: true });
    const work = screen.getPrimaryDisplay().workArea;
    owner = new BrowserWindow({
      x: work.x + 40,
      y: work.y + 40,
      width: 800,
      height: 660,
      backgroundColor: '#DFE7EF',
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    await owner.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`<!doctype html>
    <style>body{margin:0;background:#E6EAF0;font:16px "Segoe UI",sans-serif;color:#18263A}
    main{display:flex;height:660px}section{width:33.333%;padding:30px;box-sizing:border-box}
    section:nth-child(1){background:#6B93B8}section:nth-child(2){background:#E4C990}section:nth-child(3){background:#8AB9A8}
    h1{font-size:27px;font-weight:500;margin:0 0 20px}p{line-height:1.9}</style>
    <main><section><h1>工作区</h1><p>页面内容保持实时运行<br>文档与阅读<br>最近打开的标签</p></section>
    <section><h1>设计笔记</h1><p>清晰的层次<br>恰当的留白<br>自然的交互反馈</p></section>
    <section><h1>阅读清单</h1><p>本周关注<br>共享资料<br>稍后继续</p></section></main>`)
    );
    const contents = webContents.getAllWebContents().length;
    for (const mode of ['light', 'dark']) {
      for (const material of ['acrylic', 'none']) {
        const name = `${mode}-${material}`;
        await check(name + ' native material composition', async () => {
          if (panel) panel.destroy();
          panel = new NativePanel({
            parent: owner,
            focusMode: 'input',
            dismissOnOutsideClick: false,
            backgroundMaterial: material,
            radius: 12,
            contentInset: 16,
            theme: {
              mode,
              background: mode === 'dark' ? '#242424' : '#F3F3F3',
              text: mode === 'dark' ? '#F3F3F3' : '#202020',
              muted: mode === 'dark' ? '#C4C4C4' : '#616161',
              border: mode === 'dark' ? '#28FFFFFF' : '#22000000',
              fontSize: 14
            },
            content: content(mode === 'dark')
          });
          panel.show({ anchorBounds: { x: work.x + 220, y: work.y + 100, width: 20, height: 20 } });
          panel.focus('search');
          await wait(180);
          const bounds = panel.getBounds('name-0');
          await native('move', {
            hwnd: Number(panel.getDiagnostics().windowHandle),
            ...screen.dipToScreenPoint({ x: Math.round(bounds.x + 20), y: Math.round(bounds.y + 10) }),
            keepCursor: true
          });
          await wait(120);
          const diagnostic = panel.getDiagnostics();
          if (!diagnostic.controls.find((node) => node.id === 'result-0').hovered) {
            captures.push({ name: name + '-hover-observation', diagnostic, desktop: await native('windows') });
          }
          assert.equal(webContents.getAllWebContents().length, contents);
          const input = diagnostic.controls.find((node) => node.id === 'search');
          if (material === 'acrylic' && !app.commandLine.hasSwitch('force-high-contrast')) {
            assert.equal(input.style.background, mode === 'dark' ? '#30000000' : '#88FFFFFF');
            assert.ok(diagnostic.controls.find((node) => node.id === 'result-0').hovered);
            assert.ok(!diagnostic.controls.find((node) => node.id === 'root').style.background);
          }
          const imagePath = path.join(output, name + '.png');
          await native('screenshot', {
            hwnd: Number(diagnostic.windowHandle),
            bounds: screen.dipToScreenRect(null, diagnostic.bounds),
            path: imagePath
          });
          captures.push({ name, screenshot: imagePath, diagnostic });
        });
      }
    }
  })
  .catch((error) => results.push({ name: 'gallery completion', ok: false, error: error.stack }))
  .finally(async () => {
    if (panel && !panel.isDestroyed()) panel.destroy();
    if (owner && !owner.isDestroyed()) owner.destroy();
    if (original) await native('restore', { foreground: original.foreground, cursor: original.cursor }).catch(() => {});
    const failed = results.filter((result) => !result.ok).length;
    fs.writeFileSync(
      path.join(output, 'materials-results.json'),
      JSON.stringify(
        {
          executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
          summary: { total: results.length, passed: results.length - failed, failed },
          results,
          captures,
          limitations: [
            'DWM controls Acrylic availability and opacity; captures record applied material and fallback reason.',
            'Color and font assertions do not substitute for human screen-reader evaluation.'
          ]
        },
        null,
        2
      )
    );
    app.exit(failed ? 1 : 0);
  });
