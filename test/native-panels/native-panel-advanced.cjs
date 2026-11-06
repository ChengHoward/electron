/* .11 native framework acceptance. All pointer/key actions use the PID-restricted OS driver. */
const { app, BaseWindow, NativePanel, Menu, nativeImage, screen, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const measurements = {};
let owner;
let desktop;
let panel;
const panels = new Set();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'native-panel-advanced-')));
const reportPath =
  process.env.NATIVE_PANEL_ADVANCED_REPORT || path.join(__dirname, 'native-panel-advanced-results.json');
app.on('window-all-closed', () => {});
async function native(action, options = {}) {
  const hwnd = options.hwnd ?? (panel && !panel.isDestroyed() ? Number(panel.getDiagnostics().windowHandle) : 0);
  const body = { pid: process.pid, action, hwnd, ...options };
  const { stdout } = await run(
    process.env.NATIVE_PANELS_PYTHON || 'python',
    [path.join(__dirname, 'native-panels-win.py'), Buffer.from(JSON.stringify(body)).toString('base64')],
    { windowsHide: true, timeout: 15000 }
  );
  return JSON.parse(stdout);
}
async function until(predicate, message) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(message);
}
async function check(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, ok: false, error: error.stack });
    console.log('FAIL', name, error.stack);
  }
}
const node = (id) => panel.getDiagnostics().controls.find((control) => control.id === id);
const image = () => nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 });
const row = (id, text = id) => ({
  type: 'item',
  id,
  height: 40,
  accessibleName: text,
  style: { radius: 0, paddingLeft: 12, hover: { background: '#19324B', color: '#FFFFFF' } },
  children: [
    { type: 'icon', id: id + '-icon', image: image(), width: 16, height: 16 },
    { type: 'text', id: id + '-text', text, flex: 1 },
    { type: 'iconButton', id: id + '-button', image: image(), accessibleName: 'Row action', hoverOnly: true }
  ]
});
function create(content, options = {}) {
  const value = new NativePanel({
    parent: owner,
    content,
    dismissOnOutsideClick: false,
    focusMode: 'input',
    ...options
  });
  panels.add(value);
  return value;
}
async function show(value = panel, x) {
  const work = screen.getPrimaryDisplay().workArea;
  value.show({ anchorBounds: { x: x ?? work.x + 80, y: work.y + 80, width: 24, height: 24 } });
  await wait(120);
}
async function move(id, click = false, button = 'left') {
  const bounds = panel.getBounds(id);
  assert.ok(bounds, 'Materialized target ' + id);
  const point = screen.dipToScreenPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  });
  await native(click ? 'click' : 'move', { ...point, keepCursor: true, button });
  await wait(65);
}
async function key(vk, modifiers = []) {
  await native('key', { vk, modifiers });
  await wait(50);
}
app
  .whenReady()
  .then(async () => {
    desktop = await native('windows', { hwnd: 0 });
    const work = screen.getPrimaryDisplay().workArea;
    owner = new BaseWindow({ x: work.x + 30, y: work.y + 30, width: 850, height: 650 });
    await check('capability and composition helpers create no WebContents', () => {
      const before = webContents.getAllWebContents().length;
      const capabilities = NativePanel.getCapabilities();
      assert.equal(capabilities.apiVersion, 2);
      assert.equal(capabilities.createsWebContents, false);
      assert.ok(capabilities.features.includes('virtual-list'));
      assert.deepEqual(
        NativePanel.createElement(
          'column',
          { id: 'composed' },
          NativePanel.createElement('text', { id: 'composed-title', text: 'Native' })
        ).children[0].text,
        'Native'
      );
      assert.equal(webContents.getAllWebContents().length, before);
    });
    panel = create({
      type: 'column',
      id: 'root',
      width: 380,
      gap: 8,
      children: [
        { type: 'input', id: 'query', navigationTarget: 'results', placeholder: 'Search' },
        { type: 'list', id: 'results', height: 160, gap: 0, children: [row('first'), row('second'), row('third')] }
      ]
    });
    await show();
    const actions = [];
    panel.on('action', (action) => actions.push(action));
    await check('hover includes text, icons and independent nested buttons', async () => {
      for (const id of ['first-text', 'first-icon', 'first-button']) {
        await move(id);
        try {
          await until(() => node('first').hovered, 'Row hover missing over ' + id);
        } catch (error) {
          const actual = await native('windows');
          measurements.hoverFailure = {
            id,
            desktop: actual,
            diagnostic: panel.getDiagnostics(),
            hit: await native('hit', actual.cursor)
          };
          throw error;
        }
        assert.equal(node('first-text').style.color, '#FFFFFF');
        const bounds = panel.getBounds('first');
        const point = screen.dipToScreenPoint({ x: Math.round(bounds.x + 3), y: Math.round(bounds.y + 8) });
        const sample = await native('pixel', point);
        assert.deepEqual(sample.rgb, [25, 50, 75], 'Actual hover background over ' + id);
      }
      await move('second-text');
      await until(() => !node('first').hovered && node('second').hovered, 'Sibling hover did not transition');
    });
    await check('opening under a stationary pointer initializes descendant hover', async () => {
      const bounds = panel.getBounds('first-text');
      const point = screen.dipToScreenPoint({
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2)
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        panel.hide();
        await native('move', { hwnd: Number(panel.getDiagnostics().parentWindowHandle), ...point, keepCursor: true });
        await show();
        const actual = await native('windows');
        assert.deepEqual(actual.cursor, point, 'The desktop pointer moved during hover initialization');
        await until(() => node('first').hovered, 'Stationary pointer did not initialize row hover');
      }
    });
    await check('decorative label clicks execute the row and child buttons execute independently', async () => {
      actions.length = 0;
      await move('first-text', true);
      assert.deepEqual(
        actions.filter((a) => a.type === 'click').map((a) => a.id),
        ['first']
      );
      actions.length = 0;
      await move('first-button', true);
      assert.deepEqual(
        actions.filter((a) => a.type === 'click').map((a) => a.id),
        ['first-button']
      );
    });
    await check('dragging a pressed row outside cancels its click', async () => {
      const from = panel.getBounds('first-text');
      const to = panel.getBounds('second-text');
      actions.length = 0;
      await native('drag', {
        ...screen.dipToScreenPoint({ x: Math.round(from.x + 8), y: Math.round(from.y + 8) }),
        end: screen.dipToScreenPoint({ x: Math.round(to.x + 8), y: Math.round(to.y + 8) }),
        keepCursor: true
      });
      assert.equal(actions.filter((a) => a.type === 'click').length, 0);
    });
    await check('right-click resolves a descendant to its row without executing it', async () => {
      actions.length = 0;
      await move('first-text', true, 'right');
      assert.deepEqual(
        actions.filter((a) => a.type === 'context-menu').map((a) => a.id),
        ['first']
      );
      assert.equal(actions.filter((a) => a.type === 'click').length, 0);
      assert.equal(actions[0].sourceType, 'mouse');
      assert.equal(actions[0].revision, panel.revision);
    });
    await check('menu key and Shift+F10 invoke the focused row context', async () => {
      assert.equal(panel.focus('second'), true);
      actions.length = 0;
      await key(0x5d);
      await key(0x79, [0x10]);
      assert.deepEqual(
        actions.filter((a) => a.type === 'context-menu').map((a) => a.id),
        ['second', 'second']
      );
      assert.ok(actions.every((a) => a.sourceType === 'keyboard'));
    });
    await check('native editor retains its editing menu without row context actions', async () => {
      actions.length = 0;
      await move('query', true, 'right');
      await key(0x1b);
      assert.equal(actions.filter((a) => a.type === 'context-menu').length, 0);
    });
    await check('nearest context target and explicit inheritance stop are honored', async () => {
      panel.applyPatch([{ op: 'set', id: 'first-button', properties: { contextMenu: true } }]);
      actions.length = 0;
      await move('first-button', true, 'right');
      assert.equal(actions.at(-1).id, 'first-button');
      panel.applyPatch([
        { op: 'set', id: 'first', properties: { contextMenu: false } },
        { op: 'set', id: 'first-button', properties: { contextMenu: false } }
      ]);
      actions.length = 0;
      await move('first-text', true, 'right');
      assert.equal(actions.length, 0);
      panel.applyPatch([{ op: 'set', id: 'first', properties: { contextMenu: true } }]);
    });
    await check('active-item navigation retains text focus and Enter executes only the active row', async () => {
      assert.equal(panel.focus('query'), true);
      panel.setActiveItem(null);
      await key(0x28);
      assert.equal(panel.getDiagnostics().activeId, 'first');
      assert.equal(panel.getDiagnostics().focusedId, 'query');
      await key(0x23);
      assert.equal(panel.getDiagnostics().activeId, 'third');
      actions.length = 0;
      await key(0x0d);
      assert.deepEqual(
        actions.filter((a) => a.type === 'click').map((a) => a.id),
        ['third']
      );
      assert.equal(node('third').selected, false);
    });
    await check('node transactions preserve native drafts and reject late or invalid batches atomically', async () => {
      measurements.focusBeforeDraft = { returned: panel.focus('query'), state: panel.getDiagnostics() };
      await wait(60);
      measurements.focusAfterSettling = panel.getDiagnostics();
      await key(0x41, [0x11]);
      measurements.focusAfterSelectAll = panel.getDiagnostics();
      await native('text', { text: '中文草稿' });
      await wait(80);
      measurements.draftBeforePatch = panel.getDiagnostics();
      const revision = panel.revision;
      assert.equal(
        panel.applyPatch([{ op: 'set', id: 'second-text', properties: { text: 'Changed' } }], {
          expectedRevision: revision
        }),
        true
      );
      measurements.draftAfterPatch = panel.getDiagnostics();
      assert.equal(node('query').value, '中文草稿');
      assert.equal(
        panel.applyPatch([{ op: 'set', id: 'second-text', properties: { text: 'Late' } }], {
          expectedRevision: revision
        }),
        false
      );
      assert.equal(node('second-text').text, 'Changed');
      const current = panel.revision;
      assert.throws(() =>
        panel.applyPatch([
          { op: 'set', id: 'second-text', properties: { text: 'Partial' } },
          { op: 'insert', id: 'results', index: 0, node: row('second') }
        ])
      );
      assert.equal(panel.revision, current);
      assert.equal(node('second-text').text, 'Changed');
      panel.update({ content: { type: 'text', id: 'revised', text: 'New' }, revision: 100 });
      assert.equal(panel.revision, 100);
      assert.equal(panel.update({ content: { type: 'text', id: 'late', text: 'Old' }, revision: 99 }), false);
      assert.ok(node('revised'));
    });
    await check('shared styles, color tokens and inherited fonts apply to native descendants', async () => {
      panel.update({
        theme: {
          mode: 'light',
          tokens: { ink: '#123456' },
          styles: { section: { color: '$ink', fontSize: 19, fontWeight: 'bold' } }
        },
        content: {
          type: 'column',
          id: 'styled',
          width: 300,
          styleName: 'section',
          children: [{ type: 'text', id: 'styled-label', text: 'Inherited' }]
        }
      });
      assert.equal(node('styled-label').fontSize, 19);
      assert.equal(node('styled-label').fontWeight, 700);
      assert.equal(node('styled-label').style.color, '#123456');
      const before = panel.revision;
      assert.throws(() =>
        panel.update({
          theme: { tokens: { a: '$b', b: '$a' } },
          content: {
            type: 'text',
            id: 'cycle',
            text: 'Invalid',
            style: { color: '$a' }
          }
        })
      );
      assert.equal(panel.revision, before);
      assert.ok(node('styled-label'));
      assert.throws(() => panel.applyPatch([{ op: 'set', id: 'styled-label', properties: { styleName: 'missing' } }]));
    });
    await check('wrapping and min/max constraints are reflected in actual node geometry', async () => {
      panel.update({
        content: {
          type: 'row',
          id: 'wrapped',
          width: 220,
          wrap: true,
          gap: 8,
          minHeight: 20,
          maxHeight: 160,
          children: [0, 1, 2].map((i) => ({
            type: 'button',
            id: 'wrap-' + i,
            width: 100,
            height: 32,
            text: 'Button ' + i
          }))
        }
      });
      await wait(80);
      assert.ok(panel.getBounds('wrap-2').y > panel.getBounds('wrap-0').y);
      assert.ok(panel.getBounds('wrapped').height <= 160);
      assert.throws(() =>
        panel.update({ content: { type: 'text', id: 'bad-size', text: 'x', minWidth: 200, maxWidth: 100 } })
      );
    });
    await check('readonly/password/validation/busy fields use native controls and safe diagnostics', async () => {
      panel.update({
        content: {
          type: 'column',
          id: 'editors',
          width: 320,
          children: [
            { type: 'input', id: 'readonly', value: 'Fixed', readOnly: true },
            { type: 'input', id: 'password', value: 'secret', password: true },
            {
              type: 'input',
              id: 'invalid',
              invalid: true,
              accessibleDescription: 'Enter a valid value',
              style: { invalid: { color: '#A00000' } }
            },
            { type: 'button', id: 'busy', text: 'Working', busy: true }
          ]
        }
      });
      panel.focus('readonly');
      await native('text', { text: 'ignored' });
      assert.equal(node('readonly').value, 'Fixed');
      assert.equal(node('password').value, '');
      assert.equal(node('invalid').invalid, true);
      assert.equal(node('invalid').style.color, '#A00000');
      assert.equal(node('busy').enabled, false);
    });
    await check('auto-growing textarea wraps and stops at its configured maximum', async () => {
      panel.update({
        content: {
          type: 'textarea',
          id: 'growing',
          width: 280,
          autoGrow: true,
          minHeight: 40,
          maxHeight: 120,
          value: 'One line',
          submitOnEnter: false
        }
      });
      const first = panel.getBounds('growing').height;
      panel.applyPatch([
        { op: 'set', id: 'growing', properties: { value: Array(20).fill('Line of text').join('\n') } }
      ]);
      assert.ok(panel.getBounds('growing').height > first);
      assert.ok(panel.getBounds('growing').height <= 120);
    });
    await check('selectable text and multiple independent inline links are native', async () => {
      panel.update({
        content: {
          type: 'column',
          id: 'rich',
          width: 320,
          children: [
            { type: 'text', id: 'copyable', text: 'Native selectable text', selectable: true, maxLines: 2 },
            {
              type: 'text',
              id: 'links',
              text: 'First and Second',
              links: [
                { id: 'first-link', start: 0, end: 5 },
                { id: 'second-link', start: 10, end: 16 }
              ]
            }
          ]
        }
      });
      await wait(80);
      measurements.richText = panel.getDiagnostics();
      const links = node('links').linkBounds;
      assert.equal(links.length, 2);
      actions.length = 0;
      const b = links[1];
      await native('click', {
        ...screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }),
        keepCursor: true
      });
      assert.equal(actions.at(-1).linkId, 'second-link');
      assert.throws(() =>
        panel.update({
          content: {
            type: 'text',
            id: 'overlap',
            text: 'abcd',
            links: [
              { id: 'a', start: 0, end: 3 },
              { id: 'b', start: 2, end: 4 }
            ]
          }
        })
      );
    });
    await check('virtual list materializes bounded native controls and reveals distant rows', async () => {
      const before = webContents.getAllWebContents().length;
      const start = Date.now();
      panel.update({
        theme: 'light',
        content: {
          type: 'list',
          id: 'virtual',
          width: 340,
          height: 240,
          virtual: { itemHeight: 32, overscan: 3 },
          children: Array.from({ length: 10000 }, (_, i) => ({
            type: 'item',
            id: 'v-' + i,
            children: [{ type: 'text', id: 'vt-' + i, text: 'Result ' + i }]
          }))
        }
      });
      await wait(100);
      measurements.virtual10000RowsInitialMs = Date.now() - start;
      assert.ok(panel.getDiagnostics().controls.length < 80);
      assert.equal(panel.getBounds('v-9000'), null);
      assert.equal(panel.scrollTo('v-9000'), true);
      await wait(100);
      assert.ok(panel.getBounds('v-9000'));
      assert.ok(node('virtual').virtualStart > 8900);
      assert.ok(panel.getDiagnostics().controls.length < 80);
      assert.equal(webContents.getAllWebContents().length, before);
      assert.equal(panel.setActiveItem('v-9999'), true);
      assert.equal(panel.getDiagnostics().activeId, 'v-9999');
      panel.scrollListTo('virtual', 0);
      await wait(150);
      assert.ok(node('v-0'));
      assert.equal(panel.getBounds('v-9999'), null);
      assert.throws(
        () =>
          panel.update({
            content: {
              type: 'list',
              id: 'oversized',
              height: 1000,
              virtual: { itemHeight: 1 },
              children: Array.from({ length: 1200 }, (_, index) => ({
                type: 'item',
                id: 'large-' + index,
                children: [{ type: 'text', id: 'large-text-' + index, text: 'Too many mounted controls' }]
              }))
            }
          }),
        /mounted node limit/
      );
      assert.ok(node('v-0'), 'Rejected virtual viewport changed the current tree');
    });
    await check('keyed list updates preserve the first visible item rather than its old pixel offset', async () => {
      panel.update({
        content: {
          type: 'list',
          id: 'stable',
          width: 320,
          height: 160,
          gap: 0,
          children: Array.from({ length: 40 }, (_, i) => ({
            type: 'item',
            id: 's-' + i,
            height: 32,
            children: [{ type: 'text', id: 'st-' + i, text: 'Row ' + i }]
          }))
        }
      });
      panel.scrollListTo('stable', 320);
      await wait(70);
      const y = panel.getBounds('s-10').y;
      panel.applyPatch([
        { op: 'insert', id: 'stable', index: 0, node: { type: 'item', id: 'inserted', height: 32, children: [] } }
      ]);
      assert.equal(panel.getBounds('s-10').y, y);
    });
    await check('native accessibility roles/descriptions/announcements remain available', () => {
      panel.update({
        content: {
          type: 'column',
          id: 'accessible',
          width: 320,
          role: 'group',
          accessibleDescription: 'Search settings',
          children: [{ type: 'text', id: 'status', text: 'Ready', role: 'status' }]
        }
      });
      assert.equal(node('accessible').role, 'group');
      assert.equal(node('accessible').accessibleDescription, 'Search settings');
      panel.announce('Ready');
      panel.announce('Validation failed', true);
    });
    await check('owned menus stay associated and target removal closes them', async () => {
      panel.update({
        content: { type: 'column', id: 'menus', width: 320, children: [row('menu-row'), row('menu-other')] }
      });
      const menu = Menu.buildFromTemplate([{ label: 'Native action', click() {} }]);
      panel.popupMenu(menu, { id: 'menu-row' });
      await wait(100);
      assert.equal(panel.getDiagnostics().visible, true);
      assert.equal(panel.getDiagnostics().menuOpen, true);
      await key(0x1b);
      await until(() => !panel.getDiagnostics().menuOpen, 'Menu did not close');
      assert.equal(panel.getDiagnostics().visible, true);
      panel.popupMenu(menu, { id: 'menu-row' });
      await wait(60);
      panel.applyPatch([{ op: 'remove', id: 'menu-row' }]);
      await until(() => !panel.getDiagnostics().menuOpen, 'Removed target retained menu');
    });
    await check('related child panels follow ancestor visibility and destruction', async () => {
      const child = create(
        { type: 'text', id: 'child-text', text: 'Related details', width: 180 },
        { parentPanel: panel }
      );
      await show(child, work.x + 500);
      assert.equal(child.getDiagnostics().visible, true);
      child.hide();
      await wait(80);
      assert.equal((await native('windows')).foreground, Number(panel.getDiagnostics().windowHandle));
      await show(child, work.x + 500);
      panel.hide();
      assert.equal(child.getDiagnostics().visible, false);
      await show();
      await show(child, work.x + 500);
      panel.destroy();
      assert.equal(child.isDestroyed(), true);
    });
  })
  .catch((error) => {
    results.push({ name: 'suite completion', ok: false, error: error.stack });
  })
  .finally(async () => {
    for (const value of panels) if (!value.isDestroyed()) value.destroy();
    if (owner && !owner.isDestroyed()) owner.destroy();
    if (desktop) {
      await native('restore', { hwnd: 0, foreground: desktop.foreground, cursor: desktop.cursor }).catch(() => {});
    }
    const failed = results.filter((result) => !result.ok).length;
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          suite: 'native-panel-advanced',
          versions: process.versions,
          executableSha256: crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
          summary: { total: results.length, passed: results.length - failed, failed },
          results,
          measurements,
          limitations: [
            'Hardware touch/pen and screen-reader spoken output are not exercised by this suite.',
            'Real IME candidate coverage is recorded by the independent existing native-panel suite.'
          ]
        },
        null,
        2
      )
    );
    app.exit(failed ? 1 : 0);
  });
