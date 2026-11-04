// Native integration checks. Page scripts only record events in the fixture.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

app.commandLine.appendSwitch('site-per-process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-click-selector-')));
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixture = (frames) => `<!doctype html><style>
body{margin:16px;height:2200px}button{padding:8px;margin:4px}
iframe{display:block;width:540px;height:160px;border:0}
</style><button id="a">Action A</button><button id="b">Action B</button>
<div id="host"></div><button id="far" style="position:absolute;top:1800px">Far action</button>
${frames || ''}<script>
const shadow=document.querySelector('#host').attachShadow({mode:'closed'});
shadow.innerHTML='<button id="shadow" style="padding:8px">Shadow action</button>';
window.events=[];
for(const root of [document,shadow]) for(const type of ['mousedown','mouseup','click','dblclick','auxclick','contextmenu']) {
  root.addEventListener(type,e=>{
    if(e.target.tagName!=='BUTTON') return;
    events.push({type,id:e.target.id,button:e.button,buttons:e.buttons,detail:e.detail,
      ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,trusted:e.isTrusted});
    if(type==='contextmenu'||type==='auxclick'||(type==='mousedown'&&e.button===1)) e.preventDefault();
  });
}
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const port = server.address().port;
  res.end(
    fixture(
      req.url === '/' ? `<iframe src="/child"></iframe><iframe src="http://localhost:${port}/child"></iframe>` : ''
    )
  );
});
let win;
let focusEvents = 0;
async function check(name, run) {
  let timer;
  try {
    await Promise.race([
      run(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Click test timed out')), 20000);
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
function frameFor(target) {
  return win.webContents.mainFrame.framesInSubtree.find(
    (frame) => frame.processId === target.processId && frame.routingId === target.routingId
  );
}
async function shadowTargets() {
  for (let attempt = 0; attempt < 30; ++attempt) {
    const found = await win.webContents.findAgentElements({ selector: '#shadow' });
    if (found.complete && found.frames.length === 3 && found.elements.length === 3) return found.elements;
    await delay(100);
  }
  throw new Error('Fixture did not cover all three documents');
}
async function recordedClick(target, options = {}) {
  const frame = target ? frameFor(target) : win.webContents.mainFrame;
  await frame.executeJavaScript('window.events=[];null');
  const result = await win.webContents.clickElement({
    ...options,
    ...(target ? { target } : { selector: target ? '' : '#host >>> #shadow' })
  });
  assert.equal(result.status, 'dispatched', JSON.stringify(result));
  await win.webContents._flushAgentInput(frame.processId, frame.routingId);
  return frame.executeJavaScript('window.events');
}
function assertPressRelease(events, button, mask, count = 1, modifiers = 0) {
  const pointer = events.filter((event) => ['mousedown', 'mouseup'].includes(event.type));
  assert.equal(pointer.length, count * 2, JSON.stringify(events));
  for (let i = 0; i < pointer.length; ++i) {
    const event = pointer[i];
    assert.equal(event.type, i % 2 ? 'mouseup' : 'mousedown');
    assert.equal(event.button, button);
    assert.equal(event.buttons, i % 2 ? 0 : mask);
    assert.equal(event.detail, Math.floor(i / 2) + 1);
    assert.equal(event.ctrl, !!(modifiers & 2));
    assert.equal(event.shift, !!(modifiers & 8));
    assert.equal(event.alt, !!(modifiers & 1));
    assert.equal(event.meta, !!(modifiers & 4));
    assert.equal(event.trusted, true);
  }
}
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    win = new BrowserWindow({ show: false, width: 720, height: 720, x: 80, y: 80, webPreferences: { sandbox: true } });
    win.on('focus', () => ++focusEvents);
    const wc = win.webContents;
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    win.showInactive();
    const targets = await shadowTargets();
    assert.ok(
      targets.some((item) => item.target.processId !== wc.mainFrame.processId),
      'OOPIF missing'
    );
    await check('default target click is trusted in main, same-site and OOPIF closed shadow', async () => {
      for (const { target } of targets) assertPressRelease(await recordedClick(target), 0, 1);
    });
    await check('selector and target preserve every mouse button and Ctrl+Shift', async () => {
      for (const target of [null, ...targets.map((item) => item.target)]) {
        for (const [button, domButton, mask] of [
          ['left', 0, 1],
          ['middle', 1, 4],
          ['right', 2, 2],
          ['back', 3, 8],
          ['forward', 4, 16]
        ]) {
          assertPressRelease(await recordedClick(target, { button, modifiers: 10 }), domButton, mask, 1, 10);
        }
      }
    });
    await check('double and triple clicks send complete ordered pairs and dblclick', async () => {
      for (const target of [null, ...targets.map((item) => item.target)]) {
        for (const count of [2, 3]) {
          const events = await recordedClick(target, { clickCount: count });
          assertPressRelease(events, 0, 1, count);
          assert.deepEqual(
            events.filter((event) => event.type === 'click').map((event) => event.detail),
            Array.from({ length: count }, (unused, index) => index + 1)
          );
          assert.equal(events.filter((event) => event.type === 'dblclick' && event.trusted).length, 1);
        }
      }
    });
    await check('target click sequences cannot interleave with another target click', async () => {
      const a = (await wc.findAgentElements({ selector: '#a' })).elements.find(
        (item) => item.target.routingId === wc.mainFrame.routingId
      );
      const b = (await wc.findAgentElements({ selector: '#b' })).elements.find(
        (item) => item.target.routingId === wc.mainFrame.routingId
      );
      await wc.mainFrame.executeJavaScript('window.events=[];null');
      const outcomes = await Promise.all([
        wc.clickElement({ target: a.target, clickCount: 2 }),
        wc.clickElement({ target: b.target })
      ]);
      assert.ok(
        outcomes.every((outcome) => outcome.status === 'dispatched'),
        JSON.stringify(outcomes)
      );
      const events = await wc.mainFrame.executeJavaScript('window.events');
      assert.deepEqual(
        events.filter((event) => ['mousedown', 'mouseup'].includes(event.type)).map((event) => [event.id, event.type]),
        [
          ['a', 'mousedown'],
          ['a', 'mouseup'],
          ['a', 'mousedown'],
          ['a', 'mouseup'],
          ['b', 'mousedown'],
          ['b', 'mouseup']
        ]
      );
    });
    await check('invalid click options reject before dispatch in both modes', async () => {
      const invalid = [
        { button: 'none' },
        { button: '__proto__' },
        { clickCount: 0 },
        { clickCount: 4 },
        { clickCount: 1.5 },
        { clickCount: NaN },
        { modifiers: -1 },
        { modifiers: 16 },
        { modifiers: 1.5 },
        { scrollIntoView: 'false' },
        { pierce: 0 }
      ];
      for (const target of [null, targets[0].target]) {
        const frame = target ? frameFor(target) : wc.mainFrame;
        await frame.executeJavaScript('window.events=[];null');
        for (const options of invalid) {
          await assert.rejects(
            wc.clickElement({ ...options, ...(target ? { target } : { selector: '#host >>> #shadow' }) }),
            /Invalid|must/
          );
        }
        assert.deepEqual(await frame.executeJavaScript('window.events'), []);
      }
    });
    await check('target scrollIntoView false does not scroll or click an offscreen element', async () => {
      const far = (await wc.findAgentElements({ selector: '#far' })).elements.find(
        (item) => item.target.routingId === wc.mainFrame.routingId
      );
      await wc.mainFrame.executeJavaScript('window.scrollTo(0,0);window.events=[];null');
      const blocked = await wc.clickElement({ target: far.target, scrollIntoView: false });
      assert.equal(blocked.status, 'failed', JSON.stringify(blocked));
      assert.equal(await wc.mainFrame.executeJavaScript('window.scrollY'), 0);
      assert.deepEqual(await wc.mainFrame.executeJavaScript('window.events'), []);
      const clicked = await wc.clickElement({ target: far.target, scrollIntoView: true });
      assert.equal(clicked.status, 'dispatched', JSON.stringify(clicked));
      assert.ok(await wc.mainFrame.executeJavaScript('window.scrollY>0'));
      assertPressRelease(await wc.mainFrame.executeJavaScript('window.events'), 0, 1);
      await wc.mainFrame.executeJavaScript('window.scrollTo(0,0);null');
    });
    await check('pierce only controls selector lookup, not a previously resolved target', async () => {
      const missing = await wc.clickElement({ selector: '#shadow', pierce: false });
      assert.equal(missing.status, 'failed');
      assert.match(missing.reason, /No node found/);
      assertPressRelease(await recordedClick(targets[0].target, { pierce: false }), 0, 1);
    });
    await check('target clicks remain trusted while hidden and do not activate the window', async () => {
      win.hide();
      for (const { target } of targets) assertPressRelease(await recordedClick(target, { modifiers: 2 }), 0, 1, 1, 2);
      assert.equal(win.isFocused(), false);
      assert.equal(focusEvents, 0);
    });
    await check('stale target fails without redirecting the click to a replacement node', async () => {
      const a = (await wc.findAgentElements({ selector: '#a' })).elements.find(
        (item) => item.target.routingId === wc.mainFrame.routingId
      );
      await wc.mainFrame.executeJavaScript(
        "document.querySelector('#a').outerHTML='<button id=\"a\">Replacement</button>';window.events=[];null"
      );
      const result = await wc.clickElement({ target: a.target });
      assert.equal(result.status, 'failed');
      assert.deepEqual(await wc.mainFrame.executeJavaScript('window.events'), []);
    });
    fs.writeFileSync(
      process.env.CLICK_TEST_REPORT || path.join(os.tmpdir(), 'electron-click-selector-results.json'),
      JSON.stringify(results, null, 2)
    );
    win.destroy();
    server.close();
    app.exit(results.every((result) => result.ok) ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
