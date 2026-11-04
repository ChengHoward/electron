const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

app.commandLine.appendSwitch('site-per-process');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'electron-cross-frame-')));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const destination = process.env.CROSS_FRAME_TEST_REPORT || path.join(app.getPath('userData'), 'results.json');
const focusPath = path.join(app.getPath('userData'), 'foreground.json');
const results = [];
const runs = {};
const frames = new Map();
const physicalSamples = [];
const mouseButtonBits = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
const expectedChecks = 7;
const automationOptions = { isolateInput: true, blockRealPointer: true, blockRealKeyboard: true, keepRendering: true,
  virtualCursor: { enabled: true, frameRate: 60 } };
let win;
let wc;
let monitor;
let lastPoint = { x: 30, y: 30 };
let pressed = 0;
let finished = false;
let origin;
let topology;
let initialCursor;
let initialActivity;
let hoverGeometry;

const recorder = (role) => `<script>
window.frameRole=${JSON.stringify(role)};window.phase='initial';window.events=[];window.eventSequence=0;
window.captureNextDown=false;window.lastPointerId=null;window.captureErrors=[];
window.fixtureDocumentId=performance.timeOrigin+':'+Math.random();
document.addEventListener('contextmenu',event=>event.preventDefault());
function describe(node){if(!node)return null;return (node.nodeName||'window')+(node.id?'#'+node.id:'')}
for(const at of ['window','document'])for(const type of [
'pointermove','pointerover','pointerout','pointerenter','pointerleave','pointerdown','pointerup','pointercancel',
'gotpointercapture','lostpointercapture','mousemove','mouseover','mouseout','mouseenter','mouseleave',
'mousedown','mouseup','click','dragstart','drag','dragenter','dragleave','dragover','drop','dragend']) {
  (at==='window'?window:document).addEventListener(type,event=>{
    if(window.events.length>=10000)return;
    window.events.push({sequence:++window.eventSequence,phase:window.phase,frame:window.frameRole,listener:at,
      type:event.type,target:describe(event.target),relatedTarget:describe(event.relatedTarget),
      clientX:event.clientX,clientY:event.clientY,pageX:event.pageX,pageY:event.pageY,
      screenX:event.screenX,screenY:event.screenY,offsetX:event.offsetX,offsetY:event.offsetY,
      movementX:event.movementX,movementY:event.movementY,buttons:event.buttons,button:event.button,
      pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,
      trusted:event.isTrusted,timeStamp:event.timeStamp,wallTime:Date.now(),
      scrollX:window.scrollX,scrollY:window.scrollY});
  },true);
}
document.addEventListener('pointerdown',event=>{
  window.lastPointerId=event.pointerId;
  if(window.captureNextDown){window.captureNextDown=false;try{document.querySelector('#surface').setPointerCapture(event.pointerId)}catch(error){captureErrors.push(String(error))}}
});
window.readTestState=()=>({role:frameRole,documentId:fixtureDocumentId,events:[...events],hover:[...document.querySelectorAll(':hover')].map(describe),
  scrollX,scrollY,innerWidth,innerHeight,devicePixelRatio,captureErrors:[...captureErrors],
  captureActive:lastPointerId!==null&&document.querySelector('#surface').hasPointerCapture(lastPointerId)});
</script>`;
const style = `<style>
html,body{margin:0;padding:0;width:1500px;height:1200px;scrollbar-width:none;user-select:none}
::-webkit-scrollbar{display:none}
#surface{position:absolute;left:0;top:0;width:1500px;height:1200px;background:rgb(30,55,80)}
#surface:hover{background:rgb(45,75,105)}
/* A visible target anchor avoids scrolling the oversized surface during the
   target API's preparation. The surface remains the pointer capture owner. */
#routing-target{position:absolute;left:20px;top:20px;width:100px;height:100px}
#coordinate-target{position:fixed;left:12px;top:10px;width:48px;height:40px}
iframe{position:absolute;z-index:2;box-sizing:content-box;background:white}
#same{left:120px;top:110px;width:230px;height:180px;border:6px solid rgb(180,80,40)}
#cross{left:440px;top:150px;width:260px;height:170px;border:10px solid rgb(40,170,100)}
</style>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const role = req.url.startsWith('/same') ? 'same' : req.url.startsWith('/cross') ? 'cross' : 'main';
  res.end(style + `<div id="surface"><div id="routing-target" data-frame-role="${role}"></div><div id="coordinate-target" data-frame-role="${role}"></div></div>` + (role === 'main'
    ? `<iframe id="same" src="/same"></iframe><iframe id="cross" src="http://localhost:${server.address().port}/cross"></iframe>` : '') + recorder(role));
});

function closeTo(actual, expected, tolerance = 1.6) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(`${label} timed out`);
}
async function check(name, action, timeout = 22000) {
  const started = Date.now();
  try {
    const detail = await bounded(action(), timeout, name);
    const inconclusive = detail?.verdict === 'inconclusive_concurrent_system_input';
    results.push({ name, ok: !inconclusive, status: inconclusive ? 'inconclusive' : 'passed', elapsedMs: Date.now() - started, detail });
    console.log(inconclusive ? 'INCONCLUSIVE' : 'PASS', name);
  } catch (error) {
    results.push({ name, ok: false, elapsedMs: Date.now() - started, error: error.stack || String(error) });
    console.error('FAIL', name, error.message);
  }
}
async function flush() {
  // Inspection barrier only: production input still enters solely through the
  // public dispatchMouseEvent(position/target) API and real Chromium routing.
  await bounded(Promise.all([...frames.values()].map((frame) => wc._flushAgentInput(frame.processId, frame.routingId))), 2500, 'frame input processing');
}
async function readAll() {
  return Object.fromEntries(await Promise.all([...frames].map(async ([role, frame]) =>
    [role, await frame.executeJavaScript('window.readTestState()')])));
}
async function refreshFrames(expectedRoles = ['main', 'same', 'cross'], changedCrossDocument) {
  await until(async () => {
    const next = new Map();
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        // Navigation may destroy a document while its inspection is in flight.
        // Bound each probe so a retired frame cannot stall the readiness loop.
        const state = await bounded(frame.executeJavaScript('window.readTestState?.()'), 500, 'fixture document probe');
        if (state) next.set(state.role, { frame, documentId: state.documentId });
      } catch {}
    }
    if (next.size !== expectedRoles.length || expectedRoles.some((role) => !next.has(role)) ||
      (changedCrossDocument && next.get('cross')?.documentId === changedCrossDocument)) return false;
    frames.clear();
    for (const [role, entry] of next) frames.set(role, entry.frame);
    return true;
  }, 'fixture frame documents ready', 5000);
}
async function beginPhase(name) {
  await Promise.all([...frames.values()].map((frame) => frame.executeJavaScript(
    `window.phase=${JSON.stringify(name)};window.events=[];window.eventSequence=0;window.captureErrors=[];`
  )));
}
async function geometry() {
  return wc.executeJavaScript(`(()=>{
    const output={scrollX,scrollY,innerWidth,innerHeight,devicePixelRatio,frames:{}};
    for(const id of ['same','cross']){
      const element=document.querySelector('#'+id),rect=element.getBoundingClientRect();
      output.frames[id]={outer:{x:rect.left,y:rect.top,width:rect.width,height:rect.height},
        content:{x:rect.left+element.clientLeft,y:rect.top+element.clientTop,width:element.clientWidth,height:element.clientHeight},
        borderLeft:element.clientLeft,borderTop:element.clientTop};
    }
    return output;
  })()`);
}
function roleAt(point, layout) {
  for (const [role, box] of Object.entries(layout.frames)) {
    const rect = box.content;
    if (point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height) return role;
  }
  return 'main';
}
function eventCoordinates(point, role, layout, state) {
  const rect = role === 'main' ? { x: 0, y: 0 } : layout.frames[role].content;
  const client = { x: point.x - rect.x, y: point.y - rect.y };
  return { client, page: { x: client.x + state.scrollX, y: client.y + state.scrollY } };
}
function interpolate(anchors, maxStep = 35) {
  const output = [{ ...anchors[0] }];
  for (let index = 1; index < anchors.length; index++) {
    const start = anchors[index - 1], end = anchors[index];
    const count = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / maxStep));
    for (let step = 1; step <= count; step++) {
      output.push({
        x: start.x + (end.x - start.x) * step / count,
        y: start.y + (end.y - start.y) * step / count
      });
    }
  }
  return output;
}
async function send(type, point, buttons = 0, extra = {}) {
  const before = await readAll();
  const realBefore = screen.getCursorScreenPoint();
  const input = { type, ...(!extra.target ? { position: point } : {}), buttons, ...extra };
  const dispatched = await wc.dispatchMouseEvent(input);
  assert.equal(dispatched.status, 'dispatched', JSON.stringify(dispatched));
  if (type === 'mousePressed') pressed |= mouseButtonBits[extra.button] || 0;
  if (type === 'mouseReleased') pressed &= ~(mouseButtonBits[extra.button] || 0);
  lastPoint = { ...point };
  await flush();
  await delay(20); // Give the native 60 Hz cursor layer a frame between samples.
  const after = await readAll();
  const realAfter = screen.getCursorScreenPoint();
  physicalSamples.push({ type, point, before: realBefore, after: realAfter });
  const received = {};
  for (const role of frames.keys()) received[role] = after[role].events.slice(before[role].events.length);
  return { type, position: point, input, buttons, dispatched, cursor: wc.getAutomationState().virtualCursor, received, state: after };
}
async function releaseHeld() {
  for (const [button, bit] of Object.entries(mouseButtonBits)) {
    if (pressed & bit) await send('mouseReleased', lastPoint, pressed & ~bit, { button });
  }
}
function documentEvents(sample, role, type) {
  return sample.received[role].filter((event) => event.listener === 'document' && event.type === type);
}
function assertCapturedMove(sample, role, buttons, layout) {
  const moves = Object.entries(sample.received).flatMap(([frame, events]) =>
    events.filter((event) => event.listener === 'document' && event.type === 'pointermove').map((event) => ({ frame, event })));
  assert.ok(moves.some((item) => item.frame === role), `Captured move missing from ${role}`);
  assert.ok(moves.every((item) => item.frame === role && item.event.buttons === buttons),
    `Captured move escaped or changed buttons: ${JSON.stringify(moves)}`);
  assert.equal(sample.state[role].captureActive, true, 'Capture was cleared while buttons remained held');
  if (layout) {
    const expected = eventCoordinates(sample.position, role, layout, sample.state[role]);
    for (const { event } of moves) {
      assert.ok(closeTo(event.clientX, expected.client.x) && closeTo(event.clientY, expected.client.y) &&
        closeTo(event.pageX, expected.page.x) && closeTo(event.pageY, expected.page.y),
      `Captured coordinates changed basis: ${JSON.stringify({ event, expected })}`);
    }
  }
}
async function captureSurface(run, point, extra = {}) {
  await frames.get('cross').executeJavaScript('window.captureNextDown=true');
  run.samples.push(await send('mouseMoved', point, 0, extra));
  run.samples.push(await send('mousePressed', point, 1, { ...extra, button: 'left', clickCount: 1 }));
  const pending = run.samples.at(-1).state.cross;
  assert.equal(pending.captureErrors.length, 0, JSON.stringify(pending.captureErrors));
  assert.equal(pending.captureActive, true, 'setPointerCapture was not accepted');
  const moved = await send('mouseMoved', { x: point.x + 3, y: point.y + 2 }, 1,
    extra.target ? { ...extra, offset: { x: extra.offset.x + 3, y: extra.offset.y + 2 } } : extra);
  run.samples.push(moved);
  assertCapturedMove(moved, 'cross', 1);
  assert.equal(moved.state.cross.events.filter((event) => event.listener === 'document' && event.type === 'gotpointercapture').length, 1,
    'Pending capture did not produce exactly one gotpointercapture');
}
async function targetAt(selector, point) {
  const element = await wc.querySelectorAcrossDocuments(selector);
  assert.ok(element?.target, `No target for ${selector}`);
  return { target: element.target, offset: { x: point.x - element.x, y: point.y - element.y } };
}
async function startMonitor() {
  assert.equal(process.platform, 'win32', 'Windows cross-frame acceptance only');
  monitor = spawn(process.env.AGENT_PYTHON || 'python', [path.join(__dirname, 'agent-foreground-monitor.py'), String(process.pid), focusPath],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error;
  let stderr = '';
  monitor.on('error', (failure) => { error = failure; });
  monitor.stderr.on('data', (chunk) => { stderr += chunk; });
  await until(() => {
    if (error) throw error;
    if (monitor.exitCode !== null) throw new Error(`Foreground monitor exited: ${stderr}`);
    return fs.existsSync(focusPath) && JSON.parse(fs.readFileSync(focusPath, 'utf8')).ready;
  }, 'foreground monitor startup', 5000);
}
function activitySnapshot() {
  const sample = spawnSync(process.env.AGENT_PYTHON || 'python', [path.join(__dirname, 'agent-input-activity-win.py')],
    { windowsHide: true, encoding: 'utf8', timeout: 4000 });
  if (sample.status !== 0) throw new Error(`Input activity snapshot failed: ${sample.error?.message || sample.stderr}`);
  return JSON.parse(sample.stdout);
}
function versionMetadata() {
  const repo = path.resolve(__dirname, '..');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 4000 });
    return result.status === 0 ? result.stdout.trim() : { error: result.error?.message || result.stderr.trim() };
  };
  const executable = fs.statSync(process.execPath);
  return {
    distributionTarget: process.env.CROSS_FRAME_DISTRIBUTION_TARGET || '45.0.0-cloudbypass.9',
    distributionState: 'runtime capability test; packaging, commit and publication are verified separately',
    appVersion: app.getVersion(), versions: { ...process.versions }, executablePath: process.execPath,
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    executableSize: executable.size, executableModified: executable.mtime.toISOString(),
    sourceHEAD: git(['rev-parse', 'HEAD']), sourceDirty: git(['status', '--porcelain', '--untracked-files=no']),
    testSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  };
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) results.push({ name: 'test infrastructure', ok: false, error: error.stack || String(error) });
  try {
    if (pressed && wc && !wc.isDestroyed()) await bounded(releaseHeld(), 2500, 'final mouse release');
  } catch (cleanupError) { results.push({ name: 'final mouse release', ok: false, error: String(cleanupError) }); }
  const focus = fs.existsSync(focusPath) ? JSON.parse(fs.readFileSync(focusPath, 'utf8')) : null;
  const report = {
    recordedAt: new Date().toISOString(), platform: process.platform, ...versionMetadata(),
    topology, results, runs, physicalSamples, foreground: focus,
    coordinateContract: { publicInput: 'main viewport CSS pixels', virtualCursorState: 'root view DIP; expected CSS position * zoom',
      eventClient: 'receiving document viewport CSS pixels', eventPage: 'receiving document page CSS pixels',
      eventScreen: 'desktop DIP', processing: 'native per-frame PingMainThread barriers; never DOM/CDP dispatch' },
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok && result.status !== 'inconclusive').length,
    inconclusive: results.filter((result) => result.status === 'inconclusive').length,
    expectedChecks,
    meetsFullCrossFrameContinuity: results.length === expectedChecks && results.every((result) => result.ok)
  };
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2));
    if (focus) fs.copyFileSync(focusPath, destination + '.focus.json');
  } catch (writeError) { console.error(writeError); report.failed++; }
  monitor?.kill();
  if (win && !win.isDestroyed()) win.destroy();
  server.close();
  console.log(`${report.passed} passed; ${report.failed} failed; ${report.inconclusive} inconclusive; full cross-frame continuity: ${report.meetsFullCrossFrameContinuity}`);
  console.log(`Report: ${destination}`);
  app.exit(report.failed || report.inconclusive ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('Cross-frame suite exceeded 170 seconds')), 170000);
watchdog.unref();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  win = new BrowserWindow({ show: false, frame: false, x: 100, y: 90, width: 1100, height: 720, webPreferences: { sandbox: true } });
  wc = win.webContents;
  await win.loadURL(origin);
  await until(() => wc.mainFrame.framesInSubtree.length === 3, 'three fixture documents');
  for (const frame of wc.mainFrame.framesInSubtree) {
    const role = await frame.executeJavaScript('window.frameRole');
    frames.set(role, frame);
  }
  for (const role of ['main', 'same', 'cross']) assert.ok(frames.has(role), `Missing ${role} frame`);
  topology = [...frames].map(([role, frame]) => ({ role, url: frame.url, processId: frame.processId, osProcessId: frame.osProcessId, routingId: frame.routingId }));
  assert.equal(frames.get('main').processId, frames.get('same').processId, 'same-origin iframe is not same-process');
  assert.notEqual(frames.get('main').processId, frames.get('cross').processId, 'Cross-origin iframe is not an OOPIF');
  await startMonitor();
  initialCursor = screen.getCursorScreenPoint();
  initialActivity = activitySnapshot();
  win.setAlwaysOnTop(true, 'floating');
  win.showInactive();
  await wc.setAutomationOptions(automationOptions);
  await delay(100);
  hoverGeometry = await geometry();

  await check('continuous main/same-process/OOPIF root-viewport movement and virtual cursor position', async () => {
    await beginPhase('hover-path');
    const same = hoverGeometry.frames.same.content, cross = hoverGeometry.frames.cross.content;
    const points = interpolate([
      { x: 40, y: 60 }, { x: same.x - 12, y: same.y + 60 }, { x: same.x + 2, y: same.y + 60 },
      { x: same.x + 70, y: same.y + 60 }, { x: same.x + same.width - 2, y: same.y + 60 },
      { x: same.x + same.width + 14, y: same.y + 60 }, { x: cross.x - 16, y: cross.y + 60 },
      { x: cross.x + 2, y: cross.y + 60 }, { x: cross.x + 90, y: cross.y + 60 },
      { x: cross.x + cross.width - 2, y: cross.y + 60 }, { x: cross.x + cross.width + 24, y: cross.y + 60 }
    ]);
    const run = runs.hover = { geometry: hoverGeometry, samples: [], errors: [] };
    let previous;
    for (const point of points) {
      const sample = await send('mouseMoved', point);
      run.samples.push(sample);
      const role = roleAt(point, hoverGeometry);
      const received = sample.received[role].filter((event) => event.type === 'mousemove' && event.listener === 'document');
      if (!received.length) run.errors.push({ kind: 'missing-move', expectedFrame: role, point });
      if (!closeTo(sample.cursor.x, point.x) || !closeTo(sample.cursor.y, point.y)) run.errors.push({ kind: 'cursor-coordinate', point, cursor: sample.cursor });
      if (previous && (!closeTo(sample.cursor.x - previous.cursor.x, point.x - previous.position.x) ||
        !closeTo(sample.cursor.y - previous.cursor.y, point.y - previous.position.y))) run.errors.push({ kind: 'cursor-jump', point, previous: previous.position });
      previous = sample;
    }
    run.finalDocuments = await readAll();
    run.cursorDraws = wc.getAutomationState().virtualCursor;
    assert.equal(run.cursorDraws.enabled, true);
    assert.ok(run.cursorDraws.draws > 0, 'Virtual cursor layer never updated');
    assert.equal(run.errors.length, 0, JSON.stringify(run.errors.slice(0, 8)));
    return { points: points.length, framesVisited: [...new Set(points.map((point) => roleAt(point, hoverGeometry)))], cursorDraws: run.cursorDraws.draws };
  });

  await check('both iframe documents receive entry and exit events and release CSS hover', async () => {
    assert.ok(runs.hover?.finalDocuments, 'Hover path did not produce evidence');
    const detail = {};
    const failures = [];
    for (const role of ['same', 'cross']) {
      const state = runs.hover.finalDocuments[role];
      const types = state.events.filter((event) => event.listener === 'document').map((event) => event.type);
      const entry = ['mouseover', 'mouseenter', 'pointerover', 'pointerenter'].map((type) => [type, types.includes(type)]);
      const exit = ['mouseout', 'mouseleave', 'pointerout', 'pointerleave'].map((type) => [type, types.includes(type)]);
      detail[role] = { entry: Object.fromEntries(entry), exit: Object.fromEntries(exit), finalHover: state.hover };
      for (const [type, present] of [...entry, ...exit]) if (!present) failures.push(`${role}: missing ${type}`);
      if (state.hover.some((node) => node.includes('#surface'))) failures.push(`${role}: surface stayed :hover after exit`);
    }
    runs.boundaries = { detail, failures };
    assert.equal(failures.length, 0, failures.join('; '));
    return detail;
  });

  await check('held-button drag across frame borders preserves buttons, explicit capture and mouseup cleanup', async () => {
    const layout = await geometry();
    const cross = layout.frames.cross.content, same = layout.frames.same.content;
    const start = { x: cross.x + 70, y: cross.y + 60 };
    const route = interpolate([start, { x: cross.x - 25, y: cross.y + 60 },
      { x: same.x + 80, y: same.y + 70 }, { x: 50, y: 65 }], 65);
    const failures = [];
    runs.drag = {};
    for (const capture of [false, true]) {
      const phase = capture ? 'explicit-OOPIF-capture-drag' : 'ordinary-held-drag';
      await beginPhase(phase);
      const run = runs.drag[phase] = { samples: [], failures: [], explicitCapture: capture };
      await frames.get('cross').executeJavaScript(`window.captureNextDown=${capture}`);
      try {
        run.samples.push(await send('mouseMoved', start));
        run.samples.push(await send('mousePressed', start, 1, { button: 'left', clickCount: 1 }));
        // Process pending pointer capture in its original widget before leaving.
        run.samples.push(await send('mouseMoved', { x: start.x + 3, y: start.y + 2 }, 1));
        if (capture) {
          const established = run.samples.at(-1);
          if (!established.state.cross.captureActive ||
            !established.state.cross.events.some((event) => event.listener === 'document' && event.type === 'gotpointercapture')) {
            run.failures.push({ kind: 'capture-never-established', state: established.state.cross });
          }
        }
        for (const point of route.slice(1)) {
          const sample = await send('mouseMoved', point, 1);
          run.samples.push(sample);
          const moves = Object.values(sample.received).flat().filter((event) => event.listener === 'document' && event.type === 'mousemove');
          if (!moves.length || moves.some((event) => event.buttons !== 1)) run.failures.push({ kind: 'held-buttons', point, moves });
          if (capture && !sample.received.cross.some((event) => event.type === 'pointermove')) run.failures.push({ kind: 'captured-move-routed-away', point });
          if (capture && Object.entries(sample.received).some(([role, events]) => role !== 'cross' &&
            events.some((event) => event.listener === 'document' && event.type === 'pointermove'))) {
            run.failures.push({ kind: 'captured-move-leaked-to-other-document', point });
          }
          if (!sample.cursor.buttons) run.failures.push({ kind: 'cursor-lost-button', point });
        }
        run.samples.push(await send('mouseReleased', lastPoint, 0, { button: 'left', clickCount: 1 }));
        run.finalDocuments = await readAll();
        const originalEvents = run.finalDocuments.cross.events;
        run.originalOopifReceivedMouseup = originalEvents.some((event) => event.type === 'mouseup');
        run.originalOopifCapture = {
          got: originalEvents.some((event) => event.type === 'gotpointercapture'),
          lost: originalEvents.some((event) => event.type === 'lostpointercapture'),
          stillActive: run.finalDocuments.cross.captureActive
        };
        if (capture && (!run.originalOopifReceivedMouseup || !run.originalOopifCapture.got ||
          !run.originalOopifCapture.lost || run.originalOopifCapture.stillActive)) run.failures.push({ kind: 'capture-or-release-incomplete', state: run.originalOopifCapture, originalOopifReceivedMouseup: run.originalOopifReceivedMouseup });
        if (wc.getAutomationState().virtualCursor.buttons !== 0) run.failures.push({ kind: 'cursor-button-stuck' });
      } finally {
        await releaseHeld();
        await frames.get('cross').executeJavaScript(`window.phase=${JSON.stringify(phase + ':forced-cleanup')};
          if(lastPointerId!==null&&document.querySelector('#surface').hasPointerCapture(lastPointerId))document.querySelector('#surface').releasePointerCapture(lastPointerId);`);
        await flush();
      }
      failures.push(...run.failures.map((failure) => ({ phase, ...failure })));
    }
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 8)));
    return { ordinary: runs.drag['ordinary-held-drag'].originalOopifReceivedMouseup,
      explicit: runs.drag['explicit-OOPIF-capture-drag'].originalOopifCapture };
  });

  await check('raw and target input preserve capture through release, chorded buttons and rapid queued dispatch', async () => {
    const layout = await geometry();
    const cross = layout.frames.cross.content;
    const start = { x: cross.x + 70, y: cross.y + 60 };
    const outside = { x: 50, y: 65 };
    const same = layout.frames.same.content;
    const insideSame = { x: same.x + 60, y: same.y + 50 };
    const run = runs.captureTransitions = { geometry: layout, scenarios: [], failures: [] };
    for (const mode of ['position', 'target']) {
      for (const operation of ['explicit-release', 'chorded-buttons', 'rapid-queue']) {
        const phase = `${mode}-${operation}`;
        const scenario = { phase, samples: [] };
        run.scenarios.push(scenario);
        await beginPhase(phase);
        try {
          const crossExtra = mode === 'target' ? await targetAt('#routing-target[data-frame-role="cross"]', start) : {};
          const outsideExtra = mode === 'target' ? await targetAt('#routing-target[data-frame-role="main"]', outside) : {};
          if (operation === 'rapid-queue') {
            scenario.samples.push(await send('mouseMoved', start, 0, crossExtra));
            await frames.get('cross').executeJavaScript('window.captureNextDown=true');
            const before = await readAll();
            const realBefore = screen.getCursorScreenPoint();
            const inCross = { x: start.x + 4, y: start.y + 3 };
            const sameExtra = mode === 'target' ? await targetAt('#routing-target[data-frame-role="same"]', insideSame) : {};
            scenario.publicTimestamp = Date.now() / 1000;
            const inputs = [
              { type: 'mousePressed', point: start, buttons: 1, extra: { ...crossExtra, button: 'left' } },
              // The target batch deliberately follows a queued raw move with
              // a target move at a different position and the same timestamp.
              { type: 'mouseMoved', point: inCross, buttons: 1, extra: {} },
              { type: 'mouseMoved', point: insideSame, buttons: 1, extra: sameExtra },
              { type: 'mouseMoved', point: outside, buttons: 1, extra: outsideExtra },
              { type: 'mouseReleased', point: outside, buttons: 0, extra: { ...outsideExtra, button: 'left' } }
            ];
            // Submit together without inspection barriers or sleeps between
            // calls. Coalescing may merge moves, but cannot redirect capture.
            scenario.queuedInputs = inputs.map(({ type, point, buttons, extra }) =>
              ({ type, ...(!extra.target ? { position: point } : {}), buttons, timestamp: scenario.publicTimestamp, ...extra }));
            pressed = 1;
            lastPoint = outside;
            scenario.queuedResults = await Promise.all(scenario.queuedInputs.map((input) => wc.dispatchMouseEvent(input)));
            assert.ok(scenario.queuedResults.every((result) => result.status === 'dispatched'), JSON.stringify(scenario.queuedResults));
            pressed = 0;
            await flush();
            const after = await readAll();
            const realAfter = screen.getCursorScreenPoint();
            physicalSamples.push({ type: 'rapid-queue', mode, before: realBefore, after: realAfter });
            const received = Object.fromEntries([...frames.keys()].map((role) => [role, after[role].events.slice(before[role].events.length)]));
            const batch = { received, state: after, cursor: wc.getAutomationState().virtualCursor };
            scenario.batch = batch;
            const crossEvents = received.cross.filter((event) => event.listener === 'document');
            const got = crossEvents.filter((event) => event.type === 'gotpointercapture');
            const lost = crossEvents.filter((event) => event.type === 'lostpointercapture');
            assert.equal(got.length, 1, 'Rapid input never established capture');
            assert.equal(lost.length, 1, 'Rapid input did not release capture exactly once');
            assert.ok(crossEvents.some((event) => event.type === 'pointermove' && event.buttons === 1), 'Rapid capture received no held move');
            if (mode === 'target') {
              const expected = eventCoordinates(insideSame, 'cross', layout, after.cross);
              scenario.targetMoveAfterQueuedRaw = { position: insideSame, expected };
              assert.ok(crossEvents.some((event) => event.type === 'pointermove' && event.buttons === 1 &&
                closeTo(event.clientX, expected.client.x) && closeTo(event.clientY, expected.client.y)),
              'Target move after queued raw input did not complete at its own coordinates');
            }
            assert.ok(Object.entries(received).every(([role, events]) => role === 'cross' ||
              !events.some((event) => event.listener === 'document' && ['pointermove', 'mouseup'].includes(event.type))),
            'Rapid captured move/up escaped to another document');
            const up = crossEvents.filter((event) => event.type === 'pointerup');
            assert.equal(up.length, 1, 'Rapid pointerup did not reach original OOPIF');
            assert.ok(got[0].sequence < up[0].sequence && up[0].sequence < lost[0].sequence, 'Capture lifecycle event order is inconsistent');
            assert.equal(after.cross.captureActive, false);
            assert.equal(batch.cursor.buttons, 0);
          } else {
            await captureSurface(scenario, start, crossExtra);
            if (operation === 'explicit-release') {
              const captured = await send('mouseMoved', outside, 1, outsideExtra);
              scenario.samples.push(captured);
              assertCapturedMove(captured, 'cross', 1, layout);
              await frames.get('cross').executeJavaScript('document.querySelector("#surface").releasePointerCapture(lastPointerId)');
              await flush();
              const restored = await send('mouseMoved', { x: outside.x + 4, y: outside.y + 3 }, 1,
                mode === 'target' ? { ...outsideExtra, offset: { x: outsideExtra.offset.x + 4, y: outsideExtra.offset.y + 3 } } : {});
              scenario.samples.push(restored);
              assert.equal(restored.state.cross.captureActive, false);
              assert.equal(restored.state.cross.events.filter((event) => event.listener === 'document' && event.type === 'lostpointercapture').length, 1,
                'Explicit release did not deliver lostpointercapture');
              assert.ok(documentEvents(restored, 'main', 'pointermove').some((event) => event.buttons === 1), 'Hit testing did not resume after release');
              assert.equal(documentEvents(restored, 'cross', 'pointermove').length, 0, 'Released OOPIF still received moves');
              scenario.samples.push(await send('mouseReleased', lastPoint, 0, { ...outsideExtra, button: 'left' }));
            } else {
              scenario.samples.push(await send('mousePressed', start, 3, { ...crossExtra, button: 'right' }));
              const partial = await send('mouseReleased', start, 2, { ...crossExtra, button: 'left' });
              scenario.samples.push(partial);
              assert.equal(partial.state.cross.captureActive, true, 'Releasing one of two buttons cleared capture');
              assert.equal(partial.state.cross.events.filter((event) => event.listener === 'document' && event.type === 'lostpointercapture').length, 0);
              const captured = await send('mouseMoved', outside, 2, outsideExtra);
              scenario.samples.push(captured);
              assertCapturedMove(captured, 'cross', 2, layout);
              const final = await send('mouseReleased', outside, 0, { ...outsideExtra, button: 'right' });
              scenario.samples.push(final);
              assert.ok(documentEvents(final, 'cross', 'mouseup').some((event) => event.button === 2 && event.buttons === 0),
                'Final right-button release missed capture owner');
              assert.equal(documentEvents(final, 'main', 'mouseup').length, 0, 'Captured mouseup leaked to main document');
              assert.equal(final.state.cross.captureActive, false);
              assert.equal(final.state.cross.events.filter((event) => event.listener === 'document' && event.type === 'lostpointercapture').length, 1);
            }
            assert.equal(wc.getAutomationState().virtualCursor.buttons, 0, 'Virtual cursor retained released buttons');
          }
          scenario.finalDocuments = await readAll();
        } catch (error) {
          scenario.error = error.stack || String(error);
          run.failures.push({ phase, error: String(error) });
        } finally {
          scenario.finalDocuments ||= await readAll();
          await releaseHeld();
          await frames.get('cross').executeJavaScript('if(lastPointerId!==null&&document.querySelector("#surface").hasPointerCapture(lastPointerId))document.querySelector("#surface").releasePointerCapture(lastPointerId)');
          await flush();
        }
      }
    }
    assert.equal(run.failures.length, 0, JSON.stringify(run.failures));
    return { scenarios: run.scenarios.map((scenario) => scenario.phase), rapidDispatchIncludesInspectionBarriers: false };
  }, 40000);

  await check('frame navigation, removal and reset clear invalid capture and allow subsequent input', async () => {
    const run = runs.captureLifecycle = { scenarios: [], failures: [] };
    for (const operation of ['navigation', 'removal', 'reset']) {
      const phase = `capture-owner-${operation}`;
      const scenario = { phase, samples: [], documentSnapshots: [] };
      run.scenarios.push(scenario);
      await beginPhase(phase);
      try {
        const layout = await geometry();
        const cross = layout.frames.cross.content;
        const start = { x: cross.x + 70, y: cross.y + 60 };
        const outside = { x: 50, y: 65 };
        await captureSurface(scenario, start);
        scenario.documentSnapshots.push(await readAll());
        if (operation === 'navigation') {
          const oldDocument = scenario.samples.at(-1).state.cross.documentId;
          scenario.oldDocumentId = oldDocument;
          await wc.executeJavaScript(`document.querySelector('#cross').src='http://localhost:${server.address().port}/cross?capture-navigation=1'`);
          await refreshFrames(['main', 'same', 'cross'], oldDocument);
        } else if (operation === 'removal') {
          await wc.executeJavaScript('document.querySelector("#cross").remove()');
          await refreshFrames(['main', 'same']);
        } else {
          await wc.resetAutomationOptions();
          pressed = 0;
          await flush();
          const resetDocuments = await readAll();
          scenario.documentSnapshots.push(resetDocuments);
          scenario.resetState = wc.getAutomationState();
          assert.equal(scenario.resetState.virtualCursor.buttons, 0, 'Reset retained virtual buttons');
          assert.equal(resetDocuments.cross.captureActive, false, 'Reset retained DOM pointer capture');
          await wc.setAutomationOptions(automationOptions);
        }
        const afterMutation = await readAll();
        scenario.documentSnapshots.push(afterMutation);
        scenario.framesAfterMutation = [...frames].map(([role, frame]) => ({ role, url: frame.url,
          processId: frame.processId, osProcessId: frame.osProcessId, routingId: frame.routingId }));
        if (operation !== 'reset' && afterMutation.cross) {
          assert.equal(afterMutation.cross.captureActive, false, 'Replacement document inherited capture');
          assert.ok(!afterMutation.cross.events.some((event) => ['mouseup', 'pointerup'].includes(event.type)),
            'Old input cleanup leaked a release into the replacement document');
        }
        // Frame navigation/removal need not change the physically held-button
        // model. Explicit release and the next button-free move must recover.
        if (pressed) scenario.samples.push(await send('mouseReleased', outside, 0, { button: 'left' }));
        const recovered = await send('mouseMoved', outside, 0);
        scenario.samples.push(recovered);
        assert.ok(documentEvents(recovered, 'main', 'pointermove').some((event) => event.buttons === 0), 'Input stayed routed to an invalid capture owner');
        assert.equal(wc.getAutomationState().virtualCursor.buttons, 0, 'Released input state survived owner lifecycle change');
        scenario.finalDocuments = await readAll();
      } catch (error) {
        scenario.error = error.stack || String(error);
        run.failures.push({ phase, error: String(error) });
      } finally {
        scenario.finalDocuments ||= await readAll();
        await releaseHeld();
        await wc.setAutomationOptions(automationOptions);
        if (operation === 'removal') {
          await wc.executeJavaScript(`if(!document.querySelector('#cross')){
            const frame=document.createElement('iframe');frame.id='cross';frame.src='http://localhost:${server.address().port}/cross';document.body.append(frame);
          }`);
          await refreshFrames();
        }
        if (frames.has('cross')) await frames.get('cross').executeJavaScript('if(lastPointerId!==null&&document.querySelector("#surface").hasPointerCapture(lastPointerId))document.querySelector("#surface").releasePointerCapture(lastPointerId)');
        await flush();
      }
    }
    assert.equal(run.failures.length, 0, JSON.stringify(run.failures));
    return { scenarios: run.scenarios.map((scenario) => scenario.phase), resetRestoresInput: true };
  }, 35000);

  await check('CSS viewport/client/page/screen coordinates agree after root/child scrolling and 125 percent zoom', async () => {
    wc.setZoomFactor(1.25);
    await wc.executeJavaScript('window.scrollTo(35,45)');
    await Promise.all(['same', 'cross'].map((role) => frames.get(role).executeJavaScript('window.scrollTo(17,23)')));
    await delay(100);
    await beginPhase('scroll-and-zoom');
    const layout = await geometry();
    const zoom = wc.getZoomFactor();
    const content = win.getContentBounds();
    const run = runs.coordinates = { geometry: layout, zoom, contentBounds: content, samples: [], errors: [] };
    const points = [{ x: 30.5, y: 35.5 }, ...['same', 'cross'].flatMap((role) => {
      const rect = layout.frames[role].content;
      return [{ x: rect.x + 12.5, y: rect.y + 24.5 }, { x: rect.x + 75.5, y: rect.y + 82.5 }];
    }), { x: 760.5, y: 390.5 }];
    for (const point of points) {
      const sample = await send('mouseMoved', point);
      run.samples.push(sample);
      const role = roleAt(point, layout);
      const event = sample.received[role].filter((item) => item.listener === 'document' && item.type === 'mousemove').at(-1);
      const expected = eventCoordinates(point, role, layout, sample.state[role]);
      sample.expected = { frame: role, ...expected, screen: { x: content.x + point.x * zoom, y: content.y + point.y * zoom },
        cursor: { x: point.x * zoom, y: point.y * zoom } };
      if (!event) run.errors.push({ kind: 'missing-move', role, point });
      else {
        for (const [field, value] of Object.entries({ clientX: expected.client.x, clientY: expected.client.y,
          pageX: expected.page.x, pageY: expected.page.y, screenX: sample.expected.screen.x, screenY: sample.expected.screen.y })) {
          if (!closeTo(event[field], value, field.startsWith('screen') ? 2.6 : 1.6)) run.errors.push({ kind: 'event-coordinate', role, point, field, expected: value, actual: event[field] });
        }
      }
      if (!closeTo(sample.cursor.x, point.x * zoom) || !closeTo(sample.cursor.y, point.y * zoom)) run.errors.push({ kind: 'cursor-coordinate', role, point, actual: sample.cursor });
    }
    for (const role of ['main', 'same', 'cross']) {
      const selector = `#coordinate-target[data-frame-role="${role}"]`;
      const targetInfo = await wc.querySelectorAcrossDocuments(selector);
      assert.ok(targetInfo?.target, `No scrolled target in ${role}`);
      const beforeLayout = await geometry();
      const beforeRect = await frames.get(role).executeJavaScript(`(()=>{
        const rect=document.querySelector('#coordinate-target').getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      })()`);
      const offset = { x: 17.5, y: 19.5 };
      const origin = role === 'main' ? { x: 0, y: 0 } : beforeLayout.frames[role].content;
      const point = { x: origin.x + beforeRect.x + offset.x, y: origin.y + beforeRect.y + offset.y };
      if (!closeTo(targetInfo.x, origin.x + beforeRect.x) || !closeTo(targetInfo.y, origin.y + beforeRect.y)) {
        run.errors.push({ kind: 'target-query-coordinate', role, targetInfo, origin, beforeRect });
      }
      const sample = await send('mouseMoved', point, 0, { target: targetInfo.target, offset });
      run.samples.push(sample);
      const currentLayout = await geometry();
      const currentRect = await frames.get(role).executeJavaScript(`(()=>{
        const rect=document.querySelector('#coordinate-target').getBoundingClientRect();
        return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      })()`);
      const currentOrigin = role === 'main' ? { x: 0, y: 0 } : currentLayout.frames[role].content;
      const currentPoint = { x: currentOrigin.x + currentRect.x + offset.x, y: currentOrigin.y + currentRect.y + offset.y };
      const expected = eventCoordinates(currentPoint, role, currentLayout, sample.state[role]);
      const currentContent = win.getContentBounds();
      sample.coordinateMode = 'target';
      sample.targetInfo = targetInfo;
      sample.geometryBefore = beforeLayout;
      sample.geometryAfter = currentLayout;
      sample.targetRectBefore = beforeRect;
      sample.targetRectAfter = currentRect;
      sample.expected = { frame: role, root: currentPoint, ...expected,
        screen: { x: currentContent.x + currentPoint.x * zoom, y: currentContent.y + currentPoint.y * zoom },
        cursor: { x: currentPoint.x * zoom, y: currentPoint.y * zoom } };
      const event = sample.received[role].filter((item) => item.listener === 'document' && item.type === 'mousemove').at(-1);
      if (!event) run.errors.push({ kind: 'target-missing-move', role, point });
      else {
        for (const [field, value] of Object.entries({ clientX: expected.client.x, clientY: expected.client.y,
          pageX: expected.page.x, pageY: expected.page.y, screenX: sample.expected.screen.x, screenY: sample.expected.screen.y })) {
          if (!closeTo(event[field], value, field.startsWith('screen') ? 2.6 : 1.6)) run.errors.push({ kind: 'target-event-coordinate', role, field, expected: value, actual: event[field] });
        }
      }
      if (!closeTo(sample.cursor.x, sample.expected.cursor.x) || !closeTo(sample.cursor.y, sample.expected.cursor.y)) {
        run.errors.push({ kind: 'target-cursor-coordinate', role, expected: sample.expected.cursor, actual: sample.cursor });
      }
    }
    run.finalDocuments = await readAll();
    assert.equal(zoom, 1.25);
    assert.ok(layout.scrollX > 0 && layout.scrollY > 0, 'Root scroll did not take effect');
    assert.equal(run.errors.length, 0, JSON.stringify(run.errors.slice(0, 12)));
    return { zoom, rootScroll: { x: layout.scrollX, y: layout.scrollY }, points: points.length, targetPoints: 3 };
  });

  await check('all observed input is trusted and automation leaves the system pointer and foreground unchanged', async () => {
    const allEvents = [];
    for (const run of [runs.hover, runs.coordinates, ...Object.values(runs.drag || {})]) {
      for (const state of Object.values(run?.finalDocuments || {})) allEvents.push(...state.events);
    }
    for (const run of [...(runs.captureTransitions?.scenarios || []), ...(runs.captureLifecycle?.scenarios || [])]) {
      for (const documents of [...(run.documentSnapshots || []), run.finalDocuments].filter(Boolean)) {
        for (const state of Object.values(documents)) allEvents.push(...state.events);
      }
    }
    const untrusted = allEvents.filter((event) => !event.trusted);
    const pointerChanges = physicalSamples.filter((sample) => sample.before.x !== sample.after.x || sample.before.y !== sample.after.y);
    const finalCursor = screen.getCursorScreenPoint();
    const finalActivity = activitySnapshot();
    const foreground = JSON.parse(fs.readFileSync(focusPath, 'utf8'));
    runs.system = { initialCursor, finalCursor, initialActivity, finalActivity, pointerChanges, untrusted, foreground, observedEvents: allEvents.length };
    assert.ok(allEvents.length > 0, 'No DOM input evidence');
    assert.equal(untrusted.length, 0, 'Untrusted input was observed');
    assert.equal(win.isFocused(), false);
    assert.equal(foreground.activations.length, 0, 'Test Electron process became foreground');
    assert.equal(wc.debugger.isAttached(), false);
    if (!initialActivity.coherentSnapshot || !finalActivity.coherentSnapshot || initialActivity.lastInputTick !== finalActivity.lastInputTick) {
      return { verdict: 'inconclusive_concurrent_system_input', observedEvents: allEvents.length,
        observedSystemPointerChanges: pointerChanges.length, foregroundActivations: 0, initialActivity, finalActivity };
    }
    assert.deepEqual(finalActivity.cursor, initialActivity.cursor, 'System cursor moved while last-input tick stayed unchanged');
    assert.equal(pointerChanges.length, 0, 'System cursor changed during dispatch without concurrent system input');
    return { verdict: 'passed', observedEvents: allEvents.length, observedSystemPointerChanges: 0, foregroundActivations: 0,
      initialActivity, finalActivity };
  });
  await finish();
}).catch(finish);
