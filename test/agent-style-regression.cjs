const { app, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agent-style-')));
app.on('window-all-closed', () => {});
const results = [];
const options = { maxNodes: 300, maxFrames: 100, timeoutMs: 5000, pierce: true };
const fixture = path.join(__dirname, '../spec/fixtures/pages/agent-unavailable-style.html');

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
    console.error('FAIL', name, error);
  }
}

async function withPage(fn, url) {
  const win = new BrowserWindow({ show: false });
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'document-user-activation-required'
    }
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const wc = view.webContents;
  try {
    if (url) {
      try {
        await wc.loadURL(url);
      } catch (error) {
        if (error.errno !== -3) throw error;
        if (wc.isLoading()) await once(wc, 'did-stop-loading');
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } else {
      await wc.loadFile(fixture);
    }
    await fn(wc);
  } finally {
    if (!wc.isDestroyed()) wc.close();
    win.destroy();
  }
}

app
  .whenReady()
  .then(async () => {
    for (const method of ['findAgentElements', 'getAgentSnapshot']) {
      await check(`${method}: unavailable styles, hidden and detached targets`, () =>
        withPage(async (wc) => {
          assert.ok((await wc.executeJavaScript('document.body.innerText')).includes('下载'));
          assert.equal(
            await wc.executeJavaScript("getComputedStyle(document.querySelector('#unassigned')).visibility"),
            ''
          );
          const crashes = [];
          wc.on('render-process-gone', (event, details) => crashes.push(details));
          const snapshot =
            method === 'findAgentElements'
              ? await wc.findAgentElements({ text: '下载' }, options)
              : await wc.getAgentSnapshot(options);
          assert.deepEqual(crashes, [], 'renderer crashed');
          assert.equal(snapshot.complete, true, JSON.stringify(snapshot.frames));
          for (const id of ['visible', 'hidden', 'collapsed', 'display-none', 'unassigned']) {
            const selected = await wc.findAgentElements({ selector: '#' + id }, options);
            assert.equal(selected.elements.length, 1, id);
            const item = selected.elements[0];
            assert.equal(item.visible, id === 'visible', id);
            if (id !== 'visible') {
              await assert.rejects(
                wc._prepareAgentTarget(
                  item.target.processId,
                  item.target.routingId,
                  item.target.documentId,
                  item.target.backendNodeId,
                  false,
                  false
                ),
                /TARGET_NOT_VISIBLE/
              );
            } else {
              for (const type of ['mousePressed', 'mouseReleased']) {
                const sent = await wc.dispatchMouseEvent({ target: item.target, type, button: 'left', clickCount: 1 });
                assert.equal(sent.status, 'dispatched', JSON.stringify(sent));
              }
              assert.equal(await wc.executeJavaScript("document.querySelector('#visible').textContent"), 'clicked');
            }
          }
          const [detached] = (await wc.findAgentElements({ selector: '#visible' }, options)).elements;
          await wc.executeJavaScript("document.querySelector('#visible').remove()");
          await assert.rejects(
            wc._prepareAgentTarget(
              detached.target.processId,
              detached.target.routingId,
              detached.target.documentId,
              detached.target.backendNodeId,
              false,
              false
            ),
            /STALE_TARGET/
          );
          assert.ok(await wc.executeJavaScript('document.body.innerText'));
        })
      );
      await check(`${method}: process exit ends pending read promptly`, () =>
        withPage(async (wc) => {
          // Keep the renderer busy so the real native request is pending when killed.
          const busy = wc.executeJavaScript('while (true) {}').catch(() => {});
          const gone = once(wc, 'render-process-gone');
          const started = Date.now();
          const pending =
            method === 'findAgentElements'
              ? wc.findAgentElements({ text: '下载' }, options)
              : wc.getAgentSnapshot(options);
          setTimeout(() => process.kill(wc.getOSProcessId()), 100);
          const result = await pending;
          const elapsed = Date.now() - started;
          await gone;
          console.log(
            'Process-exit observation:',
            JSON.stringify({ elapsed, goneAfterMs: Date.now() - started, frames: result.frames })
          );
          assert.equal(result.complete, false);
          assert.ok(
            result.frames.some((frame) => frame.reason === 'RENDER_PROCESS_GONE'),
            JSON.stringify(result.frames)
          );
          assert.ok(elapsed < 2000, `process exit took ${elapsed}ms`);
          console.log('Exit latency:', elapsed);
          void busy;
        })
      );
      if (process.env.AGENT_STYLE_QQ === '1') {
        await check(`${method}: QQ Windows download page`, () =>
          withPage(async (wc) => {
            const snapshot =
              method === 'findAgentElements'
                ? await wc.findAgentElements({ text: '下载' }, options)
                : await wc.getAgentSnapshot(options);
            assert.ok(!wc.isCrashed(), JSON.stringify(snapshot.frames));
            assert.ok(
              snapshot.frames.some((frame) => frame.status === 'covered' || frame.status === 'partial'),
              JSON.stringify(snapshot.frames)
            );
            assert.ok((await wc.executeJavaScript('document.body.innerText')).includes('下载'));
            assert.equal(await wc.executeJavaScript("document.body.dataset.agentProbe = 'alive'"), 'alive');
          }, 'https://im.qq.com/pcqq/index.shtml')
        );
      }
    }
    if (process.env.AGENT_TEST_REPORT)
      fs.writeFileSync(process.env.AGENT_TEST_REPORT, JSON.stringify(results, null, 2));
    app.exit(results.some((result) => !result.ok) ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
