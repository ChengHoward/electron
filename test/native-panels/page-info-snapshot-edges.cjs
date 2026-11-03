/* Run with the newly compiled Electron; isolated PageInfo reentrancy checks. */
const { app, BaseWindow, NativePanel, WebContentsView, session, webContents } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-page-info-edges-'));
app.setPath('userData', profile);
const reportPath = process.env.NATIVE_PAGE_INFO_REPORT || path.join(profile, 'results.json');
const results = [];
const views = new Set();
const windows = new Set();
const panels = new Set();
const anchorBounds = { x: 100, y: 100, width: 24, height: 24 };
const lifetimeEvents = [
  'did-start-navigation',
  'did-navigate',
  'did-navigate-in-page',
  'destroyed',
  'render-process-gone',
  '-owner-window-changed',
  '-page-info-security-state-changed'
];
let origin;
let parent;
let alternate;
let finished = false;
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>PageInfo snapshot edges</title><input id="field">');
});

async function check(name, run) {
  const start = Date.now();
  try {
    await run();
    results.push({ name, ok: true, elapsedMs: Date.now() - start });
  } catch (error) {
    results.push({ name, ok: false, error: error.stack, elapsedMs: Date.now() - start });
  } finally {
    session.defaultSession.setPermissionCheckHandler(null);
  }
}

async function page() {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  views.add(view);
  parent.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 300, height: 200 });
  await view.webContents.loadURL(`${origin}/page`);
  return view;
}

function move(view, target) {
  const current = view.webContents._getOwnerWindowId() === parent.id ? parent : alternate;
  current.contentView.removeChildView(view);
  target.contentView.addChildView(view);
}

function listenerCounts(contents) {
  return lifetimeEvents.map((event) => [event, contents.listenerCount(event)]);
}

function capturePanel(contents, options = {}) {
  const originalShow = NativePanel.prototype.show;
  let captured;
  NativePanel.prototype.show = function (...args) {
    captured = this;
    panels.add(this);
    return originalShow.apply(this, args);
  };
  try {
    assert.equal(contents.showPageInfoDialog({ anchorBounds, ...options }), true);
  } finally {
    NativePanel.prototype.show = originalShow;
  }
  assert.ok(captured, 'The public PageInfo method must use a native panel');
  return captured;
}

async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(NativePanel.isSupported(), true);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  // Hidden parents isolate security/lifetime checks from desktop interaction.
  parent = new BaseWindow({ show: false, width: 400, height: 300 });
  alternate = new BaseWindow({ show: false, width: 400, height: 300 });
  windows.add(parent);
  windows.add(alternate);

  await check('Snapshot without permission checks has no host callback side effects', async () => {
    const view = await page();
    let calls = 0;
    session.defaultSession.setPermissionCheckHandler(() => {
      calls++;
      return false;
    });
    const info = view.webContents._getPageInfo(false);
    assert.equal(calls, 0);
    assert.equal(info.url, `${origin}/page`);
    assert.equal(info.ownerWindowId, parent.id);
    assert.equal(info.securityState, 'insecure');
    assert.equal(typeof info.documentId, 'string');
    assert.ok(info.documentId.length);
    assert.deepEqual(info.permissions, []);
  });

  await check('Same URL reload replaces document identity and closes the previous PageInfo', async () => {
    const view = await page();
    const contents = view.webContents;
    const before = contents._getPageInfo(false);
    const panel = capturePanel(contents, { siteUrl: before.url });
    const loaded = once(contents, 'did-finish-load');
    contents.reload();
    await loaded;
    const after = contents._getPageInfo(false);
    assert.equal(after.url, before.url);
    assert.notEqual(after.documentId, before.documentId);
    assert.equal(panel.isDestroyed(), true);
  });

  await check(
    'Permission-requested asynchronous destruction invalidates snapshots after the destroyed event',
    async () => {
      const view = await page();
      const contents = view.webContents;
      const before = contents._getPageInfo(false);
      const destroyed = once(contents, 'destroyed');
      let fired = false;
      session.defaultSession.setPermissionCheckHandler(() => {
        if (!fired) {
          fired = true;
          contents.destroy();
        }
        return false;
      });
      let snapshot;
      try {
        snapshot = contents._getPageInfo();
      } catch (error) {
        assert.match(error.message, /Page changed|destroyed/i);
      }
      assert.equal(fired, true);
      // WebContents.destroy() normally posts deletion to the UI thread. Until
      // that task runs, returning the still-live committed snapshot is valid.
      if (snapshot) {
        assert.equal(snapshot.documentId, before.documentId);
        assert.equal(snapshot.url, before.url);
        assert.equal(snapshot.ownerWindowId, before.ownerWindowId);
      }
      await destroyed;
      assert.equal(contents.isDestroyed(), true);
      assert.throws(() => contents._getPageInfo(), /destroyed/i);
    }
  );

  await check(
    'Permission check reentering a host transfer rejects the old snapshot without replacing WebContents',
    async () => {
      const view = await page();
      const contents = view.webContents;
      const before = contents._getPageInfo(false);
      const ids = webContents
        .getAllWebContents()
        .map((item) => item.id)
        .sort((a, b) => a - b);
      let fired = false;
      session.defaultSession.setPermissionCheckHandler(() => {
        if (!fired) {
          fired = true;
          move(view, alternate);
        }
        return false;
      });
      assert.throws(() => contents._getPageInfo(), /Page changed/i);
      assert.equal(fired, true);
      const after = contents._getPageInfo(false);
      assert.equal(after.ownerWindowId, alternate.id);
      assert.equal(after.documentId, before.documentId);
      assert.deepEqual(
        webContents
          .getAllWebContents()
          .map((item) => item.id)
          .sort((a, b) => a - b),
        ids
      );
    }
  );

  await check(
    'Public PageInfo is invalidated when permission-requested asynchronous destruction completes',
    async () => {
      const view = await page();
      const contents = view.webContents;
      const destroyed = once(contents, 'destroyed');
      let settings = 0;
      contents.on('page-info-open-site-settings', () => {
        settings++;
      });
      let fired = false;
      session.defaultSession.setPermissionCheckHandler(() => {
        if (!fired) {
          fired = true;
          contents.destroy();
        }
        return false;
      });
      const originalShow = NativePanel.prototype.show;
      const captured = [];
      NativePanel.prototype.show = function (...args) {
        captured.push(this);
        panels.add(this);
        return originalShow.apply(this, args);
      };
      try {
        try {
          assert.equal(contents.showPageInfoDialog({ anchorBounds }), true);
        } catch (error) {
          assert.match(error.message, /Page changed|destroyed/i);
        }
        assert.equal(fired, true);
      } finally {
        NativePanel.prototype.show = originalShow;
      }
      await destroyed;
      assert.equal(contents.isDestroyed(), true);
      for (const panel of captured) {
        assert.equal(panel.isDestroyed(), true);
        panel.emit('action', { id: 'page-info-site-settings', type: 'click' });
      }
      assert.equal(settings, 0);
      assert.throws(() => contents.showPageInfoDialog({ anchorBounds }), /destroyed/i);
    }
  );

  await check('Public PageInfo rejects an away-and-back transfer during permission checks', async () => {
    const view = await page();
    const contents = view.webContents;
    const before = listenerCounts(contents);
    let fired = false;
    session.defaultSession.setPermissionCheckHandler(() => {
      if (!fired) {
        fired = true;
        move(view, alternate);
        move(view, parent);
      }
      return false;
    });
    assert.throws(() => contents.showPageInfoDialog({ anchorBounds }), /Page changed/i);
    assert.equal(fired, true);
    assert.equal(contents._getOwnerWindowId(), parent.id);
    assert.deepEqual(listenerCounts(contents), before);
  });

  await check('Closed PageInfo ignores a late settings action and cleans all lifetime listeners', async () => {
    const view = await page();
    const contents = view.webContents;
    const before = listenerCounts(contents);
    let settings = 0;
    contents.on('page-info-open-site-settings', () => {
      settings++;
    });
    const panel = capturePanel(contents);
    panel.destroy();
    // Deliberately inject a queued JS action; this does not simulate a physical click.
    panel.emit('action', { id: 'page-info-site-settings', type: 'click' });
    assert.equal(settings, 0);
    assert.deepEqual(listenerCounts(contents), before);
  });
}

function finish(error) {
  if (finished) return;
  finished = true;
  if (error) results.push({ name: 'setup/completion', ok: false, error: error.stack });
  try {
    session.defaultSession.setPermissionCheckHandler(null);
  } catch {}
  for (const panel of panels) {
    try {
      panel.destroy();
    } catch {}
  }
  for (const view of views) {
    try {
      if (!view.webContents.isDestroyed()) view.webContents.destroy();
    } catch {}
  }
  for (const window of windows) {
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {}
  }
  server.closeAllConnections();
  server.close();
  const failed = results.filter((item) => !item.ok).length;
  const report = {
    suite: 'page-info-snapshot-edges',
    executable: process.execPath,
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    completedAtUtc: new Date().toISOString(),
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    summary: { total: results.length, passed: results.length - failed, failed },
    limitations: ['Hidden-window snapshot and lifetime checks; no physical input or IME acceptance is claimed.'],
    results
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report.summary, reportPath }));
  app.exit(failed ? 1 : 0);
}

app.on('window-all-closed', () => {});
app
  .whenReady()
  .then(main)
  .then(() => finish())
  .catch(finish);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
setTimeout(() => finish(new Error('PageInfo edge checks exceeded 30 seconds')), 30000).unref();
