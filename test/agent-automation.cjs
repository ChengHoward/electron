const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

app.commandLine.appendSwitch('site-per-process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-agent-')));
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let focusMonitor;
const focusReport = path.join(app.getPath('userData'), 'foreground-monitor.json');
async function startFocusMonitor() {
  if (process.platform !== 'win32') return;
  focusMonitor = spawn(
    process.env.AGENT_PYTHON || 'python',
    [path.join(__dirname, 'agent-foreground-monitor.py'), String(process.pid), focusReport],
    { windowsHide: true, stdio: 'ignore' }
  );
  let launchError;
  focusMonitor.on('error', (error) => {
    launchError = error;
  });
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (fs.existsSync(focusReport) && JSON.parse(fs.readFileSync(focusReport, 'utf8')).ready) return;
    await delay(50);
  }
  throw new Error('Foreground activation monitor did not start');
}
function assertNoActivation() {
  assert.equal(win.isFocused(), false, 'test window obtained system focus');
  if (process.platform === 'win32') {
    const report = JSON.parse(fs.readFileSync(focusReport, 'utf8'));
    assert.equal(report.activations.length, 0, 'test process became foreground: ' + JSON.stringify(report.activations));
  }
}
const form = `<div id="host"></div><script>
const root = document.querySelector('#host').attachShadow({mode:'closed'});
root.innerHTML = '<label for="name">Customer name</label><input id="name" value="Initial" aria-describedby="help" aria-errormessage="err" aria-invalid="true"><span id="help">Enter full name</span><span id="err" role="alert">Name required</span><label><input id="check" type="checkbox" checked>Accept terms</label><input type="radio" aria-label="Choice" checked><button disabled>Disabled action</button><button id="button">Submit form</button><select aria-label="Plan"><option>Basic</option><option selected>Pro</option></select><input type="password" value="SECRET">';
window.events=[];
window.blockInput=false;
root.querySelector('#name').addEventListener('keypress',e=>{if(window.blockInput)e.preventDefault()});
for(const type of ['keydown','keyup','input','mousedown','mouseup','click','touchstart','touchend']) root.addEventListener(type,e=>events.push({type,trusted:e.isTrusted,id:e.target.id}));
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/form') return res.end(form);
  res.end(
    `<label>Main input<input value="main"></label><div id="open"></div><script>document.querySelector('#open').attachShadow({mode:'open'}).innerHTML='<input aria-label="Open shadow input" value="open">'</script><iframe src="http://localhost:${server.address().port}/form"></iframe><iframe src="/form"></iframe>`
  );
});
let win;
async function check(name, fn) {
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Acceptance step timed out')), 15000);
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
async function snapshot() {
  let value;
  for (let i = 0; i < 20; i++) {
    value = await win.webContents.getAgentSnapshot({ maxNodes: 500 });
    if (value.frames.length === 3 && value.frames.every((f) => f.status === 'covered')) return value;
    await delay(100);
  }
  return value;
}
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    win = new BrowserWindow({
      show: false,
      x: -10000,
      y: -10000,
      width: 1000,
      height: 800,
      webPreferences: { sandbox: true }
    });
    const wc = win.webContents;
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await startFocusMonitor();
    let target;
    await check('native snapshot covers cross-site OOPIF and closed shadow controls', async () => {
      const snap = await snapshot();
      assert.equal(snap.complete, true, JSON.stringify(snap.frames));
      const cross = snap.frames.find((f) => f.url.includes('localhost'));
      assert.ok(cross && cross.processId !== wc.mainFrame.processId, 'fixture must be OOPIF');
      const input = snap.elements.find((e) => e.target.processId === cross.processId && e.value === 'Initial');
      assert.ok(input, 'closed input missing');
      assert.equal(input.name, 'Customer name');
      assert.equal(input.errorText, 'Name required');
      assert.equal(input.descriptionText, 'Enter full name');
      target = input.target;
      assert.ok(snap.elements.some((e) => e.checked === 'true'));
      assert.ok(snap.elements.some((e) => e.selected && e.text === 'Pro'));
      assert.ok(
        snap.elements.some(
          (e) => e.name === 'Plan' && e.options?.some((option) => option.selected && option.value === 'Pro')
        )
      );
      assert.ok(snap.elements.some((e) => e.disabled && e.name === 'Disabled action'));
      assert.ok(!JSON.stringify(snap).includes('SECRET'), 'password leaked');
      assert.ok(snap.elements.some((e) => e.value === 'open' && e.name === 'Open shadow input'));
      assert.equal(wc.debugger.isAttached(), false);
    });
    await check('existing cross-document selector returns Agent semantics and target identity', async () => {
      const found = await wc.querySelectorAcrossDocuments('iframe[src*="localhost"] >>> #name');
      assert.ok(found);
      assert.equal(found.target.processId, target.processId);
      const semantic = await wc.findAgentElements({ name: 'Customer name' });
      assert.equal(semantic.complete, true);
      assert.ok(
        semantic.elements.some(
          (element) =>
            element.target.processId === found.target.processId &&
            element.target.routingId === found.target.routingId &&
            element.target.documentId === found.target.documentId &&
            element.target.backendNodeId === found.target.backendNodeId
        )
      );
    });
    await check('keyboard targets main document, same-process iframe and open shadow independently', async () => {
      const snap = await snapshot();
      const inputs = [
        snap.elements.find((e) => e.value === 'main'),
        snap.elements.find((e) => e.value === 'Initial' && e.target.processId === wc.mainFrame.processId),
        snap.elements.find((e) => e.value === 'open')
      ];
      for (const input of inputs) {
        assert.ok(input);
        const sent = await wc.dispatchKeyEvent({ target: input.target, type: 'char', text: 'Y' });
        assert.equal(sent.status, 'dispatched', JSON.stringify(sent));
        const after = await snapshot();
        const updated = after.elements.find(
          (e) =>
            e.target.processId === input.target.processId &&
            e.target.routingId === input.target.routingId &&
            e.backendNodeId === input.backendNodeId
        );
        assert.ok(updated.value.includes('Y'));
      }
      assertNoActivation();
    });
    for (const mode of ['hidden', 'visible-unfocused']) {
      await check(`${mode}: trusted keyboard and mouse without foreground activation`, async () => {
        if (mode === 'visible-unfocused') {
          win.showInactive();
          await delay(100);
          assertNoActivation();
        }
        assert.ok(target, 'input target missing');
        const key = await wc.dispatchKeyEvent({ target, type: 'char', text: 'X' });
        assert.equal(key.status, 'dispatched', JSON.stringify(key));
        await delay(150);
        const found = await wc.findAgentElements({ name: 'Customer name' });
        assert.ok(found.elements.some((e) => e.target.processId === target.processId && e.value.includes('X')));
        const button = (await wc.findAgentElements({ name: 'Submit form' })).elements.find(
          (e) => e.target.processId === target.processId
        );
        const clicked = await wc.clickElement({ target: button.target });
        assert.equal(clicked.status, 'dispatched', JSON.stringify(clicked));
        await delay(100);
        const frame = wc.mainFrame.framesInSubtree.find((f) => f.processId === target.processId);
        const events = await frame.executeJavaScript('window.events');
        assert.ok(
          events.some((e) => e.type === 'input' && e.trusted),
          JSON.stringify(events)
        );
        assert.ok(
          events.some((e) => e.type === 'click' && e.trusted && e.id === 'button'),
          JSON.stringify({ events, clicked })
        );
        const checkbox = (await wc.findAgentElements({ name: 'Accept terms' })).elements.find(
          (e) => e.target.processId === target.processId && e.tagName === 'input'
        );
        const toggled = await wc.clickElement({ target: checkbox.target });
        assert.equal(toggled.status, 'dispatched', JSON.stringify(toggled));
        const checkedAfter = (await wc.findAgentElements({ name: 'Accept terms' })).elements.find(
          (e) => e.target.backendNodeId === checkbox.backendNodeId && e.target.processId === target.processId
        );
        assert.notEqual(checkedAfter.checked, checkbox.checked, 'checkbox state did not change');
        assertNoActivation();
        assert.equal(win.isFocused(), false);
      });
    }
    await check('select keyboard updates selection and pointer native-popup requests fail explicitly', async () => {
      win.hide();
      const select = (await wc.findAgentElements({ name: 'Plan' })).elements.find(
        (e) => e.target.processId === target.processId && e.tagName === 'select'
      );
      const event = { target: select.target, key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };
      const down = await wc.dispatchKeyEvent({ ...event, type: 'rawKeyDown' });
      assert.equal(down.status, 'dispatched', JSON.stringify(down));
      await wc.dispatchKeyEvent({ ...event, type: 'keyUp' });
      const after = (await wc.findAgentElements({ name: 'Plan' })).elements.find(
        (e) => e.target.processId === target.processId && e.tagName === 'select'
      );
      assert.equal(after.value, 'Basic');
      assert.ok(after.options.some((option) => option.selected && option.value === 'Basic'));
      const popup = await wc.clickElement({ target: select.target });
      assert.equal(popup.status, 'failed');
      assert.equal(popup.reason, 'TARGET_NATIVE_POPUP_UNSUPPORTED');
      assertNoActivation();
    });
    await check('trusted touch routing in OOPIF', async () => {
      win.hide();
      const button = (await wc.findAgentElements({ name: 'Submit form' })).elements.find(
        (e) => e.target.processId === target.processId
      );
      const start = await wc.dispatchTouchEvent({
        target: button.target,
        type: 'touchStart',
        touchPoints: [{ id: 0, offset: { x: 10, y: 10 } }]
      });
      assert.equal(start.status, 'dispatched', JSON.stringify(start));
      const end = await wc.dispatchTouchEvent({ target: button.target, type: 'touchEnd', touchPoints: [] });
      assert.equal(end.status, 'dispatched', JSON.stringify(end));
      await delay(100);
      const frame = wc.mainFrame.framesInSubtree.find((f) => f.processId === target.processId);
      const events = await frame.executeJavaScript('window.events');
      assert.ok(events.some((e) => e.type === 'touchstart' && e.trusted && e.id === 'button'));
      assertNoActivation();
    });
    await check('preventDefault does not get reported as an input dispatch failure', async () => {
      const frame = wc.mainFrame.framesInSubtree.find((f) => f.processId === target.processId);
      const previous = (await wc.findAgentElements({ name: 'Customer name' })).elements.find(
        (e) => e.target.processId === target.processId
      ).value;
      await frame.executeJavaScript('window.blockInput=true');
      const outcome = await wc.dispatchKeyEvent({ target, type: 'char', text: 'Z' });
      assert.equal(outcome.status, 'dispatched', JSON.stringify(outcome));
      const after = (await wc.findAgentElements({ name: 'Customer name' })).elements.find(
        (e) => e.target.processId === target.processId
      ).value;
      assert.equal(after, previous, 'fixture did not cancel text insertion');
      await frame.executeJavaScript('window.blockInput=false');
    });
    await check('partial snapshots explicitly report uncovered frames and truncation', async () => {
      const snap = await wc.getAgentSnapshot({ maxNodes: 1, maxFrames: 1 });
      assert.equal(snap.complete, false);
      assert.equal(snap.truncated, true);
      assert.ok(snap.frames.some((f) => f.status === 'skipped'));
    });
    await check('failed iframe loads are explicit coverage failures', async () => {
      await wc.executeJavaScript(`new Promise(resolve => {
        const iframe = document.createElement('iframe');
        iframe.id = 'agent-error-frame';
        iframe.onload = resolve;
        iframe.src = 'http://127.0.0.1:1/';
        document.body.appendChild(iframe);
      })`);
      const snap = await wc.getAgentSnapshot();
      assert.equal(snap.complete, false);
      assert.ok(
        snap.frames.some((frame) => frame.status === 'failed' && frame.reason === 'FRAME_LOAD_FAILED'),
        JSON.stringify(snap.frames)
      );
      await wc.executeJavaScript("document.querySelector('#agent-error-frame').remove()");
    });
    await check('stale targets fail instead of operating on a new document', async () => {
      await win.loadURL('about:blank');
      const result = await wc.dispatchKeyEvent({ target, type: 'char', text: 'bad' });
      assert.equal(result.status, 'failed');
      assert.ok(result.reason);
    });
    fs.writeFileSync(
      process.env.AGENT_TEST_REPORT || path.join(os.tmpdir(), 'electron-agent-results.json'),
      JSON.stringify(results, null, 2)
    );
    assertNoActivation();
    if (process.platform === 'win32' && process.env.AGENT_TEST_REPORT) {
      fs.copyFileSync(focusReport, process.env.AGENT_TEST_REPORT + '.focus.json');
    }
    focusMonitor?.kill();
    win.destroy();
    server.close();
    app.exit(results.some((r) => !r.ok) ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    focusMonitor?.kill();
    app.exit(1);
  });
