// Copyright (c) 2026 Electron Customizations.
// Use of this source code is governed by the MIT license.
const { app, BaseWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const output = process.env.SCROLLBAR_CORNERS_VISUAL_OUTPUT;
if (!output || !path.isAbsolute(output)) throw Error('Set absolute SCROLLBAR_CORNERS_VISUAL_OUTPUT');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 680, height: 560, frame: false, backgroundColor: '#ff00ff', alwaysOnTop: true });
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 40, y: 40, width: 600, height: 480 });
  win.show();
  win.focus();
  const cases = [
    [8, 'vertical', false], [12, 'vertical', false], [12, 'vertical', true],
    [16, 'vertical', false], [12, 'horizontal', false], [12, 'both', false],
    [48, 'both', false], [12, 'vertical', false, 4], [12, 'vertical', false, 6],
    [12, 'vertical', false, 32], [12, 'horizontal', false, 6], [12, 'both', false, 6]
  ];
  const reports = [];
  for (const [radius, axis, atEnd, inset] of cases) {
    const name = `r${radius}-${axis}-${atEnd ? 'end' : 'start'}-${inset === undefined ? 'auto' : 'inset' + inset}`;
    view.setBorderRadius(radius, inset === undefined ? undefined : { scrollbarInset: inset });
    const html = `<!doctype html><meta charset="utf-8"><style>
      html { background: #f8f8f8; overflow-x: ${axis === 'vertical' ? 'hidden' : 'scroll'}; overflow-y: ${axis === 'horizontal' ? 'hidden' : 'scroll'} }
      body { margin: 0; width: ${axis === 'vertical' ? 400 : 1800}px; height: ${axis === 'horizontal' ? 200 : 1800}px; font: 16px sans-serif; color: #333 }
      p { position: fixed; left: 40px; top: 50px }
    </style><p>desktop.3 / avoidance enabled / radius ${radius} / inset ${inset === undefined ? 'auto' : inset}</p>`;
    await view.webContents.loadURL('data:text/html,' + encodeURIComponent(html));
    if (atEnd) await view.webContents.executeJavaScript('scrollTo(1800,1800)');
    await wait(1800);
    const rendererImage = path.join(output, name + '-renderer.png');
    fs.writeFileSync(rendererImage, (await view.webContents.capturePage()).toPNG());
    const capture = spawnSync(process.env.SCROLLBAR_CORNERS_PYTHON || 'python', [
      path.join(__dirname, 'capture-scrollbar-corners.py'),
      win.getNativeWindowHandle().readBigUInt64LE().toString(),
      path.join(output, name + '-native.png'), rendererImage
    ], { encoding: 'utf8', windowsHide: true });
    console.log(capture.stdout);
    if (capture.status !== 0) throw Error(capture.stderr || capture.stdout);
    reports.push(JSON.parse(capture.stdout));
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    total: reports.length,
    passed: reports.filter(report => report.inkPixelsOutsideHostMask === 0).length,
    reports
  }, null, 2));
  view.webContents.close();
  win.destroy();
  app.exit();
}).catch(error => { console.error(error); app.exit(1); });
