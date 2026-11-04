const { app, BrowserWindow, nativeImage, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.commandLine.appendSwitch('site-per-process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-sequence-')));
const results = [];
const measurements = [];
const skipPerformance = process.env.INPUT_TEST_SKIP_PERFORMANCE === '1';
const skipped = [];
let win;
let wc;
let baseline;
const fixture = `<style>html,body{margin:0;background:rgb(12,34,56);color:white}input,button{display:block;width:180px;height:30px;margin:8px}iframe{width:240px;height:170px;border:0}</style>
<input id="first" aria-label="First"><input id="second" aria-label="Second"><input disabled id="disabled" aria-label="Disabled"><button id="button">Action</button><div id="plain">Unfocusable</div><div id="host"></div>
<script>
window.events=[];window.steal=false;
const closed=document.querySelector('#host').attachShadow({mode:'closed'});
closed.innerHTML='<input aria-label="Closed" id="closed">';
for(const target of [document,closed]) for(const type of ['mousemove','mousedown','mouseup','click','keydown','keyup','keypress','input','focusin'])target.addEventListener(type,e=>{if(events.length<20000)events.push({type,id:e.target.id,trusted:e.isTrusted,key:e.key,buttons:e.buttons,value:e.target.value})});
document.querySelector('#first').addEventListener('focus',()=>{if(steal)document.querySelector('#second').focus()});
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    fixture +
      (req.url === '/'
        ? `<iframe src="/child"></iframe><iframe src="http://localhost:${server.address().port}/child"></iframe>`
        : '')
  );
});
async function check(name, fn) {
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Test timed out')), 18000);
      })
    ]);
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
    console.error('FAIL', name, error);
  } finally {
    clearTimeout(timer);
  }
}
const inspect = (expression) => wc.executeJavaScript(expression);
async function target(name, frame = 'main') {
  const snap = await wc.getAgentSnapshot({ maxNodes: 300 });
  const matched = snap.elements.find(
    (element) =>
      element.name === name &&
      (frame === 'main'
        ? element.target.routingId === wc.mainFrame.routingId && element.target.processId === wc.mainFrame.processId
        : frame === 'cross'
          ? element.target.processId !== wc.mainFrame.processId
          : element.target.processId === wc.mainFrame.processId && element.target.routingId !== wc.mainFrame.routingId)
  );
  assert.ok(matched, `Missing ${name}/${frame}: ${JSON.stringify(snap.frames)}`);
  return matched.target;
}
const mouse = (type, atMs = 0, options = {}) => {
  const { x = 350, y = 60, ...rest } = options;
  return { kind: 'mouse', type, atMs, ...rest, [rest.target ? 'offset' : 'position']: { x, y } };
};
const key = (type, atMs = 0, options = {}) => ({ kind: 'key', type, atMs, ...options });
const moves = (count, duration = 1000) =>
  Array.from({ length: count }, (_, i) =>
    mouse('mouseMoved', (duration * i) / (count - 1), { x: 320 + (i % 200), y: 40 + (i % 100) })
  );
async function completed(steps, options) {
  const result = await wc.dispatchInputSequence(steps, options);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.dispatchedCount, steps.length);
  assert.equal(result.lastDispatchedIndex, steps.length - 1);
  assert.equal(result.stoppedIndex, null);
  return result;
}
async function native(action, x = 0, y = 0) {
  const handle = win.getNativeWindowHandle().readBigUInt64LE();
  const { stdout } = await run(
    process.env.AGENT_PYTHON || 'python',
    [path.join(__dirname, 'input-sequence-native-win.py'), action, String(handle), String(x), String(y)],
    { windowsHide: true }
  );
  await delay(120);
  return stdout ? JSON.parse(stdout) : null;
}
async function markerState() {
  return inspect(
    `({window:Reflect.ownKeys(window).map(String).sort(),navigator:Reflect.ownKeys(navigator).map(String).sort(),prototype:Reflect.ownKeys(Navigator.prototype).map(String).sort(),webdriver:navigator.webdriver,descriptor:String(Object.getOwnPropertyDescriptor(Navigator.prototype,'webdriver')?.get),dom:document.documentElement.outerHTML})`
  );
}
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    win = new BrowserWindow({
      show: false,
      frame: false,
      x: 130,
      y: 100,
      width: 720,
      height: 520,
      webPreferences: { sandbox: true }
    });
    wc = win.webContents;
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await delay(300);
    baseline = await markerState();
    await check('public methods and strict cursor validation', async () => {
      for (const name of [
        'setAutomationOptions',
        'getAutomationState',
        'resetAutomationOptions',
        'setVirtualCursorImage',
        'setVirtualCursorFrameRate',
        'dispatchInputSequence'
      ]) {
        assert.equal(typeof wc[name], 'function');
      }
      for (const fps of [-1, 0.5, NaN, Infinity, '30', true, 1001]) {
        assert.throws(() => wc.setVirtualCursorFrameRate(fps));
      }
      for (const image of ['', 'https://example.com/cursor.png', {}, nativeImage.createEmpty()]) {
        assert.throws(() => wc.setVirtualCursorImage(image));
      }
      assert.throws(() => wc.setVirtualCursorImage(null, { hotspot: { x: -1, y: 0 } }));
      await assert.rejects(wc.setAutomationOptions({ virtualCursor: { enabled: 'true' } }));
      assert.equal(wc.setVirtualCursorEnabled, undefined);
      assert.equal(wc.clickSelector, undefined);
      await assert.rejects(wc.dispatchMouseEvent({ type: 'mouseMoved', x: 1, y: 2 }));
      await assert.rejects(wc.setAutomationOptions({ unknown: true }));
    });
    await check('invalid sequences reject before dispatch and remain side effect free', async () => {
      const before = await inspect('events.length');
      for (const steps of [
        [],
        [mouse('mouseMoved', -1)],
        [mouse('mouseMoved', 10), mouse('mouseMoved', 0)],
        [mouse('mouseMoved', 0, { x: NaN })],
        [mouse('mousePressed', 0, { button: 'left' })],
        [key('keyUp', 0, { key: 'A' })],
        [key('char', 0, { text: '\ud800' })],
        [mouse('mouseMoved', 0, { timestamp: 1 })],
        [mouse('mouseMoved', 0, { _sequenceId: 1 })],
        Array(10001).fill(mouse('mouseMoved'))
      ]) {
        await assert.rejects(wc.dispatchInputSequence(steps));
      }
      assert.equal(await inspect('events.length'), before);
      await assert.rejects(wc._runInputSequence([null], {}, 123));
    });
    await check('hidden mixed click and keyboard uses trusted input without activation', async () => {
      const first = await target('First');
      const result = await completed([
        mouse('mousePressed', 0, { target: first, x: 8, y: 8, button: 'left', clickCount: 1 }),
        mouse('mouseReleased', 0, { target: first, x: 8, y: 8, button: 'left', clickCount: 1 }),
        key('keyDown', 0, { target: first, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 }),
        key('char', 0, { target: first, text: 'a' }),
        key('keyUp', 0, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      ]);
      assert.equal(result.mouseCount, 2);
      assert.equal(result.keyCount, 3);
      assert.equal(await inspect("document.querySelector('#first').value"), 'a');
      const events = await inspect('events');
      assert.ok(events.some((e) => e.type === 'click'));
      assert.ok(events.every((e) => e.trusted));
      assert.equal(win.isFocused(), false);
    });
    await check('same-process iframe, OOPIF and closed shadow keyboard targets', async () => {
      for (const [name, frame] of [
        ['First', 'same'],
        ['First', 'cross'],
        ['Closed', 'main']
      ]) {
        const input = await target(name, frame);
        await completed([key('char', 0, { target: input, text: 'Z' })]);
        const snap = await wc.getAgentSnapshot();
        assert.ok(
          snap.elements.some(
            (e) => e.backendNodeId === input.backendNodeId && e.target.processId === input.processId && e.value === 'Z'
          )
        );
      }
      assert.equal(win.isFocused(), false);
    });
    await check('Tab moves focus and keyup/char follows the new focus', async () => {
      const first = await target('First');
      await completed([
        key('keyDown', 0, { target: first, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }),
        key('keyUp', 0, { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }),
        key('char', 0, { text: 'T' })
      ]);
      assert.equal(await inspect('document.activeElement.id'), 'second');
      assert.equal(await inspect("document.querySelector('#second').value"), 'T');
    });
    await check('disabled or unfocusable target fails promptly without typing', async () => {
      const input = await target('Disabled');
      const result = await wc.dispatchInputSequence([key('char', 0, { target: input, text: 'NO' })], {
        focusTimeoutMs: 200
      });
      assert.equal(result.status, 'failed');
      assert.match(result.reason, /DISABLED|FOCUS/);
      assert.equal(result.dispatchedCount, 0);
      assert.ok(result.executionMs < 1000);
      await inspect("document.querySelector('#first').blur();steal=true");
      const stolen = await wc.dispatchInputSequence([key('char', 0, { target: await target('First'), text: 'NO' })], {
        focusTimeoutMs: 200
      });
      assert.equal(stolen.status, 'failed');
      assert.match(stolen.reason, /FOCUS/);
      assert.equal(stolen.dispatchedCount, 0);
      await inspect('steal=false');
    });
    await check('abort releases owned buttons and prevents later scheduled input', async () => {
      const controller = new AbortController();
      const pending = wc.dispatchInputSequence(
        [
          mouse('mousePressed', 0, { button: 'left' }),
          mouse('mouseMoved', 2000),
          mouse('mouseReleased', 2100, { button: 'left' })
        ],
        { signal: controller.signal }
      );
      await delay(120);
      controller.abort();
      const result = await pending;
      assert.equal(result.status, 'cancelled');
      assert.equal(result.reason, 'ABORTED');
      assert.equal(result.dispatchedCount, 1);
      assert.equal(result.cleanup.dispatched, 1);
      assert.equal(result.cleanup.failed, 0);
      assert.ok(result.executionMs < 1000);
      await completed([mouse('mouseMoved')]);
    });
    await check('lost target focus has a finite timeout and never types into the wrong field', async () => {
      const first = await target('First');
      const before = await inspect("document.querySelector('#second').value");
      await inspect(
        "document.querySelector('#first').addEventListener('input',()=>document.querySelector('#second').focus(),{once:true})"
      );
      const result = await wc.dispatchInputSequence(
        [key('char', 0, { target: first, text: 'Q' }), key('char', 0, { target: first, text: 'BAD' })],
        { focusTimeoutMs: 80, maxLatenessMs: 500 }
      );
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'FOCUS_TIMEOUT');
      assert.equal(result.dispatchedCount, 1);
      assert.equal(result.stoppedIndex, 1);
      assert.ok(result.executionMs < 700);
      assert.equal(await inspect("document.querySelector('#second').value"), before);
    });
    await check('input arrays are copied before enqueue and already aborted jobs do no work', async () => {
      const blocker = wc.dispatchInputSequence([mouse('mouseMoved', 150)]);
      const steps = [mouse('mouseMoved', 0, { x: 370, y: 65 })];
      const pending = wc.dispatchInputSequence(steps);
      steps[0].position.x = 999;
      steps.push(mouse('mouseMoved'));
      await blocker;
      const result = await pending;
      assert.equal(result.dispatchedCount, 1);
      const controller = new AbortController();
      controller.abort();
      const cancelled = await wc.dispatchInputSequence([mouse('mouseMoved')], { signal: controller.signal });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.dispatchedCount, 0);
    });
    await check('cross-site click processing barrier completes before following keyboard input', async () => {
      const first = await target('First', 'cross');
      await completed([
        mouse('mousePressed', 0, { target: first, x: 10, y: 10, button: 'left', clickCount: 1 }),
        mouse('mouseReleased', 0, { target: first, x: 10, y: 10, button: 'left', clickCount: 1 }),
        key('char', 0, { text: 'C' })
      ]);
      const snap = await wc.getAgentSnapshot();
      assert.ok(
        snap.elements.some(
          (element) =>
            element.backendNodeId === first.backendNodeId &&
            element.target.processId === first.processId &&
            element.value.includes('C')
        )
      );
    });
    await check('queue cancel, queue timeout and sync conflict are bounded', async () => {
      const first = wc.dispatchInputSequence([mouse('mouseMoved', 350)]);
      await delay(40);
      assert.throws(() => wc.sendInputEvent({ type: 'mouseMove', x: 30, y: 30 }), /INPUT_SEQUENCE_BUSY/);
      const controller = new AbortController();
      const second = wc.dispatchInputSequence([mouse('mouseMoved')], { signal: controller.signal });
      const third = wc.dispatchInputSequence([mouse('mouseMoved')], { queueTimeoutMs: 40 });
      controller.abort();
      assert.equal((await second).status, 'cancelled');
      assert.equal((await third).reason, 'QUEUE_TIMEOUT');
      assert.equal((await first).status, 'completed');
    });
    await check('excessive lateness stops the batch instead of replaying all overdue points', async () => {
      const result = await wc.dispatchInputSequence(moves(1000, 1), { maxLatenessMs: 1 });
      assert.equal(result.status, 'failed');
      assert.match(result.reason, /MAX_LATENESS_EXCEEDED/);
      assert.ok(result.dispatchedCount < 1000);
      assert.equal(result.stoppedIndex, result.dispatchedCount);
    });
    await check('execution deadline returns partial counters and cleanup', async () => {
      const result = await wc.dispatchInputSequence(
        [mouse('mousePressed', 0, { button: 'left' }), mouse('mouseReleased', 200, { button: 'left' })],
        { timeoutMs: 250 }
      );
      // The normal path also proves paired drag state reaches the final release.
      assert.equal(result.status, 'completed');
      assert.equal(result.dispatchedCount, 2);
      const first = await target('First');
      await inspect(
        "document.querySelector('#first').addEventListener('keydown',()=>{const end=performance.now()+250;while(performance.now()<end){}},{once:true})"
      );
      const timed = await wc.dispatchInputSequence(
        [key('keyDown', 0, { target: first, key: 'a', code: 'KeyA' }), key('keyUp', 0, { key: 'a', code: 'KeyA' })],
        { timeoutMs: 60, focusTimeoutMs: 500 }
      );
      assert.equal(timed.status, 'failed');
      assert.equal(timed.reason, 'TIMEOUT');
      assert.equal(timed.dispatchedCount, 1);
      assert.ok(timed.executionMs < 1500);
    });
    await check('cursor state updates for all native entry points and keyboard leaves it still', async () => {
      await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
      await wc.dispatchMouseEvent({ type: 'mouseMoved', position: { x: 410.5, y: 80.25 } });
      let state = wc._getVirtualCursorState();
      assert.ok(Math.abs(state.x - 410.5) < 0.001);
      assert.ok(Math.abs(state.y - 80.25) < 0.001);
      await completed([key('char', 0, { target: await target('First'), text: 'K' })]);
      assert.equal(wc._getVirtualCursorState().x, state.x);
      await wc.clickElement({ selector: '#button' });
      state = wc._getVirtualCursorState();
      assert.ok(state.x < 200);
      assert.equal(state.buttons, 0);
      wc.sendInputEvent({ type: 'mouseMove', x: 340, y: 100 });
      assert.equal(wc._getVirtualCursorState().x, 340);
    });
    await check('1000 points per second preserve all dispatches across cursor frame caps', async () => {
      win.showInactive();
      await delay(300);
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      }
      wc.setVirtualCursorImage(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
      measurements.push({
        group: 'environment',
        cpu: os.cpus()[0].model,
        logicalProcessors: os.cpus().length,
        os: os.release(),
        versions: process.versions,
        display: screen.getPrimaryDisplay(),
        cursorPixels: { width: 16, height: 16 },
        gpu: app.getGPUFeatureStatus()
      });
      if (skipPerformance)
        skipped.push({
          name: 'cursor frame-cap performance matrix',
          reason: 'INPUT_TEST_SKIP_PERFORMANCE=1; representative 30fps functional case retained',
          frameRates: [15, 60, 120, 0]
        });
      for (const fps of skipPerformance ? [30] : [15, 30, 60, 120, 0]) {
        wc.setVirtualCursorFrameRate(fps);
        const before = wc._getVirtualCursorState();
        const cpu = process.cpuUsage();
        const receivedBefore = await inspect("events.filter(event=>event.type==='mousemove').length");
        const result = await completed(moves(1000), { maxLatenessMs: 1000 });
        await delay(150);
        const state = wc._getVirtualCursorState();
        const used = process.cpuUsage(cpu);
        assert.equal(state.x, 519);
        assert.equal(state.y, 139);
        assert.ok(state.draws > before.draws, JSON.stringify(state));
        if (state.refreshRate) {
          assert.ok(
            state.draws - before.draws >= Math.min(fps || state.refreshRate, state.refreshRate) * 0.7,
            JSON.stringify({ fps, before, state })
          );
        }
        if (fps) {
          assert.ok(state.draws - before.draws <= Math.ceil(fps * 1.2) + 2, JSON.stringify({ fps, before, state }));
        }
        assert.ok(state.paints - before.paints <= 2, 'movement must reuse the cursor image');
        measurements.push({
          fps,
          draws: state.draws - before.draws,
          browserCpuMs: (used.user + used.system) / 1000,
          pageMouseMoves: (await inspect("events.filter(event=>event.type==='mousemove').length")) - receivedBefore,
          result
        });
      }
      const state = wc._getVirtualCursorState();
      await delay(250);
      assert.equal(wc._getVirtualCursorState().draws, state.draws);
      assert.equal(wc._getVirtualCursorState().pending, false);
    });
    await check('browser UI cursor is visible while capturePage remains clean', async () => {
      const wasAlwaysOnTop = win.isAlwaysOnTop();
      try {
        // showInactive() preserves focus but does not guarantee unobscured
        // desktop pixels. Elevate only this fixture for the composition check.
        win.setAlwaysOnTop(true);
        win.showInactive();
        win.moveTop();
        wc.setVirtualCursorFrameRate(30);
        await completed([mouse('mouseMoved', 0, { x: 400, y: 50 })]);
        await delay(250);
        const pixel = await native('pixel', 408, 58);
        measurements.push({ group: 'visible-cursor-native-hit', pixel });
        assert.deepEqual(pixel.rgb, [255, 0, 0], JSON.stringify({ pixel, state: wc._getVirtualCursorState() }));
        const capture = await wc.capturePage({ x: 400, y: 50, width: 16, height: 16 });
        const bitmap = capture.toBitmap();
        const offset = (8 * capture.getSize().width + 8) * 4;
        assert.deepEqual([...bitmap.subarray(offset, offset + 3)], [56, 34, 12]);
        await wc.resetAutomationOptions();
        await delay(150);
        assert.deepEqual((await native('pixel', 408, 58)).rgb, [12, 34, 56]);
      } finally {
        if (!win.isDestroyed()) win.setAlwaysOnTop(wasAlwaysOnTop);
      }
    });
    if (skipPerformance) {
      skipped.push({
        name: 'five second input baseline and cursor CPU comparison',
        reason: 'INPUT_TEST_SKIP_PERFORMANCE=1'
      });
    } else
      await check('five second input baseline and cursor CPU comparison', async () => {
        for (const enabled of [false, true]) {
          await wc.setAutomationOptions({ virtualCursor: { enabled: enabled } });
          wc.setVirtualCursorFrameRate(30);
          const cpu = process.cpuUsage();
          const start = performance.now();
          let dispatched = 0;
          for (let repeat = 0; repeat < 5; repeat++) dispatched += (await completed(moves(1000))).dispatchedCount;
          const usage = process.cpuUsage(cpu);
          measurements.push({
            group: enabled ? 'cursor30' : 'input-only',
            dispatched,
            wallMs: performance.now() - start,
            browserCpuMs: (usage.user + usage.system) / 1000
          });
        }
        await wc.resetAutomationOptions();
      });
    await check('physical pointer gate precedes WebContents callbacks and preserves injected input', async () => {
      let physical = 0;
      const listener = () => physical++;
      wc.on('before-mouse-event', listener);
      try {
        await wc.setAutomationOptions({
          blockRealPointer: false,
          blockRealKeyboard: false,
          virtualCursor: { enabled: true }
        });
        await native('mouse', 80, 190);
        const open = await inspect('events.length');
        assert.ok(physical > 0, 'Windows messages did not reach native mouse entry');
        physical = 0;
        await wc.setAutomationOptions({ blockRealPointer: true, virtualCursor: { enabled: true } });
        await native('mouse', 80, 190);
        assert.equal(physical, 0);
        assert.equal(await inspect('events.length'), open);
        assert.ok(wc._getVirtualCursorState().blockedPointer > 0);
        await completed([mouse('mousePressed', 0, { button: 'left' }), mouse('mouseReleased', 0, { button: 'left' })]);
        assert.ok((await inspect('events.length')) > open);
      } finally {
        wc.removeListener('before-mouse-event', listener);
        await wc.resetAutomationOptions();
      }
    });
    await check(
      'physical keyboard gate is independent, injected keys continue and disable restores input',
      async () => {
        let callbacks = 0;
        const listener = () => callbacks++;
        wc.on('before-input-event', listener);
        try {
          const first = await target('First');
          await completed([key('char', 0, { target: first, text: 'I' })]);
          await wc.setAutomationOptions({
            blockRealPointer: true,
            blockRealKeyboard: false,
            virtualCursor: { enabled: true }
          });
          callbacks = 0;
          await native('key');
          assert.ok(callbacks > 0, 'Windows messages did not reach keyboard entry');
          callbacks = 0;
          const before = await inspect("document.querySelector('#first').value");
          await wc.setAutomationOptions({ blockRealKeyboard: true, virtualCursor: { enabled: true } });
          await native('key');
          assert.equal(callbacks, 0);
          assert.equal(await inspect("document.querySelector('#first').value"), before);
          await completed([key('char', 0, { target: first, text: 'J' })]);
          assert.equal(await inspect("document.querySelector('#first').value"), before + 'J');
          await wc.resetAutomationOptions();
          callbacks = 0;
          await native('key');
          assert.ok(callbacks > 0);
          assert.equal(wc._getVirtualCursorState().blockRealPointer, false);
          assert.equal(wc._getVirtualCursorState().blockRealKeyboard, false);
        } finally {
          wc.removeListener('before-input-event', listener);
          await wc.resetAutomationOptions();
        }
      }
    );
    await check('hidden cursor does not render or poll and resumes with latest position', async () => {
      await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
      win.hide();
      await delay(150);
      const before = wc._getVirtualCursorState();
      await completed(moves(100, 250));
      await delay(150);
      const hidden = wc._getVirtualCursorState();
      assert.equal(hidden.draws, before.draws);
      assert.equal(hidden.pending, false);
      win.showInactive();
      await delay(250);
      assert.ok(wc._getVirtualCursorState().draws > hidden.draws);
      await wc.resetAutomationOptions();
    });
    await check('automation configuration preserves omitted flags and resets atomically', async () => {
      await wc.setAutomationOptions({ blockRealPointer: true, virtualCursor: { enabled: true } });
      await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
      assert.equal(wc._getVirtualCursorState().blockRealPointer, true);
      await wc.setAutomationOptions({ blockRealKeyboard: true, virtualCursor: { enabled: true } });
      assert.equal(wc._getVirtualCursorState().blockRealPointer, true);
      assert.equal(wc._getVirtualCursorState().blockRealKeyboard, true);
      await wc.setAutomationOptions({ blockRealPointer: false, virtualCursor: { enabled: true } });
      assert.equal(wc._getVirtualCursorState().blockRealKeyboard, true);
      const changes = await Promise.allSettled([
        wc.setAutomationOptions({ blockRealPointer: true, virtualCursor: { enabled: true } }),
        wc.resetAutomationOptions()
      ]);
      assert.equal(changes[1].status, 'fulfilled');
      assert.equal(wc._getVirtualCursorState().enabled, false);
      await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
      assert.equal(wc._getVirtualCursorState().blockRealPointer, false);
      assert.equal(wc._getVirtualCursorState().blockRealKeyboard, false);
      wc.setVirtualCursorImage(null);
      await wc.resetAutomationOptions();
    });
    await check('new APIs leave browser automation markers unchanged', async () => {
      const after = await markerState();
      for (const field of ['window', 'navigator', 'prototype', 'webdriver', 'descriptor']) {
        assert.deepEqual(after[field], baseline[field], field);
      }
      // Fixture values and focus may change; no element or attribute is installed by the APIs.
      assert.equal(after.dom.replace(/ value="[^"]*"/g, ''), baseline.dom.replace(/ value="[^"]*"/g, ''));
      assert.equal(wc.debugger.isAttached(), false);
      assert.equal(after.webdriver, false);
      for (const flag of ['enable-automation', 'remote-debugging-port', 'remote-debugging-pipe']) {
        assert.equal(app.commandLine.hasSwitch(flag), false, flag);
      }
      assert.ok((await inspect('events')).every((event) => event.trusted));
    });
    await check('CDP surface screenshots exclude the native cursor in full and cropped captures', async () => {
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i + 2] = 255;
        pixels[i + 3] = 255;
      }
      wc.setVirtualCursorImage(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
      await wc.setAutomationOptions({ virtualCursor: { enabled: true } });
      await completed([mouse('mouseMoved', 0, { x: 400, y: 50 })]);
      await delay(120);
      // Only the acceptance test attaches CDP to inspect the existing capture route.
      // None of the production input or cursor methods attaches a debugger.
      wc.debugger.attach('1.3');
      try {
        for (const clip of [undefined, { x: 400, y: 50, width: 16, height: 16, scale: 1 }]) {
          const response = await wc.debugger.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            ...(clip ? { clip } : {})
          });
          const capture = nativeImage.createFromBuffer(Buffer.from(response.data, 'base64'));
          const point = clip ? [8, 8] : [408, 58];
          const offset = (point[1] * capture.getSize().width + point[0]) * 4;
          assert.deepEqual([...capture.toBitmap().subarray(offset, offset + 3)], [56, 34, 12]);
        }
      } finally {
        wc.debugger.detach();
        await wc.resetAutomationOptions();
      }
    });
    await check('separate WebContents keep independent cursor state and scheduling', async () => {
      const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await other.loadURL(`http://127.0.0.1:${server.address().port}/child`);
        await other.webContents.setAutomationOptions({ blockRealPointer: true, virtualCursor: { enabled: true } });
        const main = wc.dispatchInputSequence([mouse('mouseMoved', 400, { x: 410, y: 70 })]);
        const second = await other.webContents.dispatchInputSequence([mouse('mouseMoved', 40, { x: 90, y: 50 })]);
        assert.equal(second.status, 'completed');
        assert.equal((await main).status, 'completed');
        assert.ok(Math.abs(other.webContents._getVirtualCursorState().x - 90) < 0.001);
        assert.equal(wc._getVirtualCursorState().blockRealPointer, false);
        assert.equal(other.isFocused(), false);
      } finally {
        other.destroy();
      }
    });
    await check('navigation cancels active input and no old steps enter a new document', async () => {
      const pending = wc.dispatchInputSequence([mouse('mouseMoved'), mouse('mouseMoved', 2000)]);
      await delay(80);
      await win.loadURL(`http://127.0.0.1:${server.address().port}/child`);
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'DOCUMENT_CHANGED');
      assert.equal(result.dispatchedCount, 1);
      assert.equal(await inspect('events.length'), 0);
      await completed([mouse('mouseMoved')]);
    });
    await check('destroying a WebContents settles its running job', async () => {
      const temporary = new BrowserWindow({ show: false });
      await temporary.loadURL('about:blank');
      const pending = temporary.webContents.dispatchInputSequence([mouse('mouseMoved', 1000)]);
      await delay(30);
      temporary.destroy();
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'WEBCONTENTS_DESTROYED');
    });
  })
  .catch((error) => {
    results.push({ name: 'fixture setup', ok: false, error: error.stack });
    console.error(error);
  })
  .finally(() => {
    fs.writeFileSync(
      process.env.INPUT_TEST_REPORT || path.join(app.getPath('userData'), 'results.json'),
      JSON.stringify(
        {
          suite: {
            name: 'input-sequence',
            performanceSkipped: skipPerformance,
            executedCases: results.length,
            skipped
          },
          results,
          measurements
        },
        null,
        2
      )
    );
    if (win && !win.isDestroyed()) win.destroy();
    server.close();
    app.exit(results.some((r) => !r.ok) ? 1 : 0);
  });
