/* Real desktop coverage for DPI resources, crisp placement and capture isolation. */
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.env.VIRTUAL_CURSOR_QUALITY_OUTPUT;
if (!output) throw new Error('Set VIRTUAL_CURSOR_QUALITY_OUTPUT');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-quality-')));
app.on('window-all-closed', () => {});
let owner;
let original;
const results = [];
const measurements = {};
async function native(action, options = {}) {
  const { stdout } = await run(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [
      path.join(__dirname, 'native-panels-win.py'),
      Buffer.from(JSON.stringify({ pid: process.pid, action, ...options })).toString('base64')
    ],
    { windowsHide: true, timeout: 15000 }
  );
  return JSON.parse(stdout);
}
async function check(name, operation) {
  try {
    await operation();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
  }
}
function bitmap(size, color) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = color[2];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[0];
    pixels[index + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size });
}
app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(output, { recursive: true });
    original = await native('windows');
    const work = screen.getPrimaryDisplay().workArea;
    owner = new BrowserWindow({
      x: work.x + 50,
      y: work.y + 50,
      width: 620,
      height: 420,
      webPreferences: { sandbox: true, contextIsolation: true }
    });
    owner.setMenu(null);
    await owner.loadURL('data:text/html,<style>body{margin:0;background:rgb(238,238,238)}</style>');
    const wc = owner.webContents;
    const hwnd = Number(owner.getNativeWindowHandle().readBigUInt64LE());
    await native('move', { hwnd, ...screen.dipToScreenPoint({ x: work.x + 70, y: work.y + 70 }), keepCursor: true });
    await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
    await wc.dispatchMouseEvent({ type: 'mouseMoved', position: { x: 100.25, y: 90.25 } });
    await wait(220);
    await check('default vector cursor rasterizes at the display scale', async () => {
      const state = wc._getVirtualCursorState();
      const scale = state.deviceScaleFactor;
      assert.ok(scale > 0);
      assert.equal(state.imageWidth, 24);
      assert.equal(state.imageHeight, 30);
      assert.ok(
        state.imageRepresentations.some(
          (rep) =>
            Math.abs(rep.scaleFactor - scale) < 0.01 &&
            rep.pixelWidth >= Math.ceil(24 * scale) &&
            rep.pixelHeight >= Math.ceil(30 * scale)
        )
      );
      measurements.default = state;
      await native('screenshot', {
        hwnd,
        bounds: screen.dipToScreenRect(null, owner.getContentBounds()),
        path: path.join(output, 'default-cursor.png')
      });
    });
    await check(
      'custom cursor preserves high-resolution resources and selects the display representation',
      async () => {
        const image = bitmap(16, [255, 0, 0]);
        for (const scaleFactor of [1.25, 1.5, 1.75, 2, 3, 4]) {
          image.addRepresentation({ scaleFactor, buffer: bitmap(Math.round(16 * scaleFactor), [0, 0, 255]).toPNG() });
        }
        wc.setVirtualCursorImage(image);
        await wc.dispatchMouseEvent({ type: 'mouseMoved', position: { x: 140.25, y: 100.25 } });
        await wait(180);
        const state = wc._getVirtualCursorState();
        for (const scale of [1, 1.25, 1.5, 1.75, 2, 3, 4]) {
          assert.ok(
            state.imageRepresentations.some((rep) => rep.scaleFactor === scale && rep.pixelWidth === 16 * scale)
          );
        }
        const origin = owner.getContentBounds();
        const pixel = await native(
          'pixel',
          screen.dipToScreenPoint({
            x: Math.round(origin.x + state.visualX + 8),
            y: Math.round(origin.y + state.visualY + 8)
          })
        );
        assert.deepEqual(pixel.rgb, state.deviceScaleFactor > 1 ? [0, 0, 255] : [255, 0, 0]);
        measurements.custom = state;
        measurements.desktopPixel = pixel;
        const captured = await wc.capturePage({ x: 140, y: 100, width: 16, height: 16 });
        const source = captured.toBitmap();
        assert.deepEqual([...source.subarray(0, 3)], [238, 238, 238], 'Cursor entered renderer capture');
        await native('screenshot', {
          hwnd,
          bounds: screen.dipToScreenRect(null, owner.getContentBounds()),
          path: path.join(output, 'custom-cursor.png')
        });
      }
    );
    await check('fractional input remains exact while only the visual snaps to physical pixels', async () => {
      wc.setVirtualCursorImage(null, { hotspot: { x: 0.25, y: 0.5 } });
      await wc.dispatchMouseEvent({ type: 'mouseMoved', position: { x: 160.375, y: 110.625 } });
      await wait(180);
      const state = wc._getVirtualCursorState();
      assert.equal(state.x, 160.375);
      assert.equal(state.y, 110.625);
      for (const [visual, exact] of [
        [state.visualX, state.x - 0.25],
        [state.visualY, state.y - 0.5]
      ]) {
        const pixel = visual * state.deviceScaleFactor;
        assert.ok(Math.abs(pixel - Math.round(pixel)) < 0.0001);
        assert.ok(Math.abs(visual - exact) <= 0.51 / state.deviceScaleFactor);
      }
      measurements.fractional = state;
      const draws = state.draws;
      await wait(180);
      assert.equal(wc._getVirtualCursorState().draws, draws, 'Stationary cursor continued drawing');
    });
  })
  .catch((error) => results.push({ name: 'quality suite completion', ok: false, error: error.stack }))
  .finally(async () => {
    if (owner && !owner.isDestroyed()) owner.destroy();
    if (original) await native('restore', { foreground: original.foreground, cursor: original.cursor }).catch(() => {});
    const failed = results.filter((result) => !result.ok).length;
    const report = {
      executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
      summary: { total: results.length, passed: results.length - failed, failed },
      results,
      measurements,
      limitations: ['Uses the connected display scale. Mixed-DPI monitor transfer requires separate hardware coverage.']
    };
    fs.writeFileSync(path.join(output, 'quality-results.json'), JSON.stringify(report, null, 2));
    app.exit(failed ? 1 : 0);
  });
