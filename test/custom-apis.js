const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[custom] ${mark} ${name}${detail ? ' — ' + detail : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error && error.stack ? error.message : String(error));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await delay(40);
  }
  return null;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function openWindow(html) {
  const win = new BrowserWindow({
    show: true,
    width: 480,
    height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

async function testDomApis() {
  const html = `<!DOCTYPE html>
<div id="host"></div>
<iframe class="a" srcdoc="<p>none</p>"></iframe>
<iframe class="b" srcdoc="<div id=&quot;host&quot;></div><script>const host=document.getElementById('host');const root=host.attachShadow({mode:'closed'});root.innerHTML='<input type=&quot;checkbox&quot; id=&quot;box&quot;>';</script>"></iframe>
<script>
  const host = document.getElementById('host');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<button id="inner" style="position:absolute;left:40px;top:40px;width:120px;height:40px">go</button>';
  root.getElementById('inner').addEventListener('click', (e) => { window.__clicked = e.isTrusted; });
</script>`;
  const win = await openWindow(html);
  const wc = win.webContents;
  try {
    await wc.executeJavaScript(`new Promise((resolve) => {
      const frame = document.querySelector('iframe.b');
      const ready = () => {
        const host = frame.contentDocument && frame.contentDocument.getElementById('host');
        if (host) resolve(true);
      };
      if (frame.contentDocument && frame.contentDocument.getElementById('host')) ready();
      else frame.addEventListener('load', ready, { once: true });
    })`);

    const viaPage = await wc.executeJavaScript('document.querySelector("#inner")');
    assert(viaPage === null, '页面脚本不应看到 closed shadow 内的按钮');

    const el = await wc.querySelectorDeep('#inner');
    assert(el && el.tagName.toLowerCase() === 'button', 'querySelectorDeep 未找到 closed shadow 按钮');
    assert(el.width > 0 && el.height > 0, '元素尺寸为 0');
    assert(wc.debugger.isAttached() === false, '查询时附加了 debugger');

    const box = await wc.getNodeBoxModel(el.backendNodeId);
    assert(box && box.backendNodeId === el.backendNodeId, 'getNodeBoxModel 未返回同一节点');

    const pierced = await wc.querySelectorDeep('#host >>> .x', { pierce: false }).catch(() => null);
    const spanHost = `<span class="x">hi</span>`;
    await wc.executeJavaScript(`(() => {
      const host = document.createElement('div');
      host.id = 'span-host';
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = ${JSON.stringify(spanHost)};
    })()`);
    const byPierce = await wc.querySelectorDeep('#span-host >>> .x', { pierce: false });
    assert(byPierce && byPierce.tagName.toLowerCase() === 'span', '>>> 未进入 closed shadow');

    const missedDeep = await wc.querySelectorDeep('iframe.b input[type="checkbox"]');
    assert(missedDeep === null, 'querySelectorDeep 不应进入 iframe');

    const across = await wc.querySelectorAcrossDocuments('iframe.b input[type="checkbox"]');
    assert(across && across.tagName.toLowerCase() === 'input', '跨文档查询未找到 iframe 内复选框');
    assert(across.width > 0 && across.height > 0, '跨文档元素尺寸为 0');

    const wrongFrame = await wc.querySelectorAcrossDocuments('iframe.a input[type="checkbox"]');
    assert(wrongFrame === null, '点名了 iframe.a 时不应落到 iframe.b');

    const implicit = await wc.querySelectorAcrossDocuments('input[type="checkbox"]');
    assert(implicit && implicit.tagName.toLowerCase() === 'input', '未写 iframe 时没有搜到子文档');

    await wc.clickSelector('#inner');
    const trusted = await waitFor(() => wc.executeJavaScript('window.__clicked === true'));
    assert(trusted, 'clickSelector 没有产生可信点击');
    assert(wc.debugger.isAttached() === false, '点击时附加了 debugger');
  } finally {
    win.destroy();
  }
}

async function testMouseAndKey() {
  const html = `<!DOCTYPE html>
<button id="b" style="position:absolute;left:40px;top:40px;width:120px;height:40px">click</button>
<input id="i" style="position:absolute;left:40px;top:120px" />
<script>
  document.getElementById('b').addEventListener('click', (e) => { window.__mouse = e.isTrusted; });
  document.getElementById('i').addEventListener('input', (e) => { window.__text = e.target.value; });
</script>`;
  const win = await openWindow(html);
  const wc = win.webContents;
  try {
    await wc.dispatchMouseEvent({ type: 'mousePressed', x: 100, y: 60, button: 'left', clickCount: 1 });
    await wc.dispatchMouseEvent({ type: 'mouseReleased', x: 100, y: 60, button: 'left', clickCount: 1 });
    const clicked = await waitFor(() => wc.executeJavaScript('window.__mouse === true'));
    assert(clicked, 'dispatchMouseEvent 没有产生可信点击');

    await wc.executeJavaScript('document.getElementById("i").focus()');
    await wc.dispatchKeyEvent({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: 'a',
      unmodifiedText: 'a'
    });
    await wc.dispatchKeyEvent({
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    });
    const typed = await waitFor(async () => {
      const value = await wc.executeJavaScript('window.__text || ""');
      return value ? value : null;
    });
    assert(typed, 'dispatchKeyEvent 没有把字符送进输入框，当前值 ' + JSON.stringify(await wc.executeJavaScript('({ text: window.__text, active: document.activeElement && document.activeElement.id })')));
    assert(typeof wc.dispatchTouchEvent === 'function', '缺少 dispatchTouchEvent');
    assert(typeof wc.cancelDragging === 'function', '缺少 cancelDragging');
  } finally {
    win.destroy();
  }
}

async function testUserAgentAndDialogs() {
  const win = new BrowserWindow({ show: true, width: 480, height: 320 });
  const wc = win.webContents;
  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CustomElectron/45';
    await wc.setUserAgent(ua, { platform: 'CustomPlatform', hideChrome: true });
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!DOCTYPE html><title>ua</title>'));
    let hidden;
    try {
      hidden = await wc.executeJavaScript('({ chrome: typeof chrome, platform: navigator.platform, ua: navigator.userAgent })');
    } catch (error) {
      const alive = await wc.executeJavaScript('1+1').catch((err) => 'dead:' + err.message);
      throw new Error('读取 UA 状态失败: ' + error.message + '；页面 ' + alive);
    }
    assert(hidden.chrome === 'undefined', 'hideChrome 后 window.chrome 仍存在: ' + hidden.chrome);
    assert(hidden.platform === 'CustomPlatform', 'navigator.platform = ' + hidden.platform);
    assert(String(hidden.ua).includes('CustomElectron/45'), 'userAgent 未生效');

    await wc.setUserAgent(ua, { hideChrome: false, platform: 'Win32' });
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!DOCTYPE html><title>ua2</title>'));
    const restored = await wc.executeJavaScript(`(() => {
      const app = chrome.app;
      const before = app.isInstalled;
      app.isInstalled = true;
      const lt = chrome.loadTimes();
      const csi = chrome.csi();
      return {
        chrome: typeof chrome,
        loadTimes: typeof chrome.loadTimes,
        csi: typeof chrome.csi,
        isInstalled: app.isInstalled,
        assignmentIgnored: app.isInstalled === before,
        getDetails: app.getDetails(),
        getIsInstalled: app.getIsInstalled(),
        runningState: app.runningState(),
        requestTime: lt && typeof lt.requestTime,
        navigationType: lt && typeof lt.navigationType,
        startE: csi && typeof csi.startE,
        pageT: csi && typeof csi.pageT,
        tran: csi && typeof csi.tran
      };
    })()`);
    assert(restored.chrome === 'object', '关闭 hideChrome 后 chrome 未恢复: ' + restored.chrome);
    assert(restored.loadTimes === 'function', 'chrome.loadTimes 不是函数');
    assert(restored.csi === 'function', 'chrome.csi 不是函数');
    assert(restored.isInstalled === false, 'chrome.app.isInstalled 应保持 false，实际 ' + restored.isInstalled);
    assert(restored.assignmentIgnored === true, 'chrome.app.isInstalled 赋值生效了');
    assert(restored.getDetails === null, 'chrome.app.getDetails() 应返回 null');
    assert(restored.getIsInstalled === false, 'chrome.app.getIsInstalled() 应返回 false');
    assert(restored.runningState === 'cannot_run', 'runningState = ' + restored.runningState);
    assert(restored.requestTime === 'number', 'loadTimes().requestTime 不是 number');
    assert(restored.navigationType === 'string', 'loadTimes().navigationType 不是 string');
    assert(restored.startE === 'number', 'csi().startE 不是 number');
    assert(restored.pageT === 'number', 'csi().pageT 不是 number');
    assert(restored.tran === 'number', 'csi().tran 不是 number');
    const installState = await wc.executeJavaScript(
      'new Promise((resolve) => chrome.app.installState(resolve))'
    );
    assert(installState === 'not_installed', 'installState = ' + installState);

    await wc.setUserAgent(ua, {
      platform: 'Win32',
      hideChrome: false,
      acceptLanguage: 'en-US,en;q=0.9,fr;q=0.8'
    });
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!DOCTYPE html><title>lang</title>'));
    const languages = await wc.executeJavaScript('navigator.languages.join(",")');
    assert(languages === 'en-US,en,fr', 'navigator.languages = ' + languages);

    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<button id="ask" style="position:absolute;left:40px;top:40px;width:120px;height:40px">ask</button>
<script>
  document.getElementById('ask').addEventListener('click', () => {
    try {
      window.__confirm = confirm('ask');
      window.__prompt = prompt('ask', 'def');
    } catch (e) {
      window.__promptError = String(e);
    }
  });
</script>`));
    let seen = [];
    wc.setJsDialogHandler((details) => {
      seen.push({ type: details.type, message: details.message });
      return { accept: true, promptText: 'typed-by-handler' };
    });
    await wc.dispatchMouseEvent({ type: 'mousePressed', x: 100, y: 60, button: 'left', clickCount: 1 });
    await wc.dispatchMouseEvent({ type: 'mouseReleased', x: 100, y: 60, button: 'left', clickCount: 1 });
    const prompted = await waitFor(async () => {
      const state = await wc.executeJavaScript('({ confirm: window.__confirm, prompt: window.__prompt, error: window.__promptError })');
      if (seen.length >= 2 || state.error) return state;
      return null;
    });
    assert(seen.length === 2 && seen[0].type === 'confirm' && seen[1].type === 'prompt', '对话框序列 = ' + JSON.stringify(seen) + ' page=' + JSON.stringify(prompted));
    assert(prompted && prompted.confirm === true && prompted.prompt === 'typed-by-handler', '对话框结果 = ' + JSON.stringify(prompted));
    assert(wc.debugger.isAttached() === false, '对话框处理附加了 debugger');
  } finally {
    win.destroy();
  }
}

async function testLoadURLWithResponse() {
  const win = new BrowserWindow({ show: false, width: 480, height: 320 });
  const wc = win.webContents;
  try {
    await wc.loadURLWithResponse('https://example.com/app', {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!DOCTYPE html><h1 id="m">synthetic-body</h1>'
    });
    const text = await wc.executeJavaScript('document.getElementById("m") && document.getElementById("m").textContent');
    const href = await wc.executeJavaScript('location.href');
    assert(text === 'synthetic-body', '页面正文 = ' + text);
    assert(href.startsWith('https://example.com/app'), '地址 = ' + href);
  } finally {
    win.destroy();
  }
}

async function testFileInput() {
  const win = new BrowserWindow({ show: false, width: 480, height: 320 });
  const wc = win.webContents;
  const file = path.join(os.tmpdir(), 'electron-custom-file-input.txt');
  fs.writeFileSync(file, 'file-input-ok');
  try {
    assert(typeof wc.setFileInputFiles === 'function', 'webContents.setFileInputFiles 未注册');
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<input id="f" type="file">'));
    await wc.setFileInputFiles('input[type="file"]', [file]);
    const name = await wc.executeJavaScript('document.querySelector("input").files[0] && document.querySelector("input").files[0].name');
    assert(name === path.basename(file), '选中的文件名 = ' + name);
  } finally {
    win.destroy();
    fs.rmSync(file, { force: true });
  }
}

async function testHeaderOrder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const names = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) names.push(req.rawHeaders[i]);
    seen.push(names);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const port = await listen(server);
  try {
    await session.defaultSession.fetch(`http://127.0.0.1:${port}/order`, {
      headers: { 'X-Zed': '1', 'X-Aaa': '2', 'X-Mid': '3' },
      headerOrder: ['X-Mid', 'X-Zed', 'X-Aaa']
    });
    const names = (seen[0] || []).map((name) => name.toLowerCase());
    const mid = names.indexOf('x-mid');
    const zed = names.indexOf('x-zed');
    const aaa = names.indexOf('x-aaa');
    assert(mid !== -1 && zed !== -1 && aaa !== -1, '请求头未到达: ' + names.join(','));
    assert(mid < zed && zed < aaa, '顺序是 ' + names.join(','));
  } finally {
    await closeServer(server);
  }
}

async function testHttpProxyAuth() {
  const username = 'user';
  const password = 'p@ss word';
  const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const auths = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'] || '';
    auths.push(auth);
    if (auth !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="custom"', 'Content-Length': 0 });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('proxy-ok');
  });
  const port = await listen(server);
  const ses = session.fromPartition('custom-http-proxy');
  try {
    await ses.setProxy({
      proxyRules: `http://wrong:wrong@127.0.0.1:${port}`,
      username,
      password
    });
    const resolved = await ses.resolveProxy('http://example.com/');
    assert(!resolved.includes(password) && !resolved.includes('wrong'), 'resolveProxy 泄露了凭据: ' + resolved);
    await ses.closeAllConnections();
    const response = await ses.fetch('http://example.com/custom-proxy', { signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    assert(response.ok && text === 'proxy-ok', '代理响应 = ' + response.status + ' ' + text);
    assert(auths.includes(expected), '代理没有收到显式 username/password');
  } finally {
    await closeServer(server);
  }
}

function startSocks5(username, password) {
  const report = { methods: [], user: '', pass: '' };
  const server = net.createServer((socket) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (stage === 'greeting') {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          report.methods = methods;
          buf = buf.subarray(2 + buf[1]);
          socket.write(Buffer.from([0x05, methods.includes(0x02) ? 0x02 : 0xff]));
          if (!methods.includes(0x02)) {
            socket.end();
            return;
          }
          stage = 'auth';
        }
        if (stage === 'auth') {
          if (buf.length < 2 || buf.length < 2 + buf[1] + 1) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1 + buf[2 + ulen]) return;
          report.user = buf.subarray(2, 2 + ulen).toString();
          const plen = buf[2 + ulen];
          report.pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          const ok = report.user === username && report.pass === password;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = 'connect';
        }
        if (stage === 'connect') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let need = 4 + 2;
          if (atyp === 0x01) need += 4;
          else if (atyp === 0x04) need += 16;
          else if (atyp === 0x03) need += 1 + buf[4];
          else return;
          if (buf.length < need) return;
          buf = buf.subarray(need);
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'http';
        }
        if (stage === 'http' && buf.includes(Buffer.from('\r\n\r\n'))) {
          const body = 'socks-ok';
          socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
          stage = 'done';
        }
      } catch (error) {
        socket.destroy(error);
      }
    });
  });
  return listen(server).then((port) => ({ server, port, report }));
}

async function testSocks5ProxyAuth() {
  const username = 'sockuser';
  const password = 'sock pass';
  const { server, port, report } = await startSocks5(username, password);
  const ses = session.fromPartition('custom-socks-proxy');
  try {
    await ses.setProxy({
      proxyRules: `socks5://127.0.0.1:${port}`,
      username,
      password
    });
    const resolved = await ses.resolveProxy('http://example.com/');
    assert(!resolved.toLowerCase().includes(password) && !resolved.includes(username), 'resolveProxy 泄露了 SOCKS 凭据: ' + resolved);
    await ses.closeAllConnections();
    const response = await ses.fetch('http://example.com/custom-socks', { signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    assert(response.ok && text === 'socks-ok', 'SOCKS 响应 = ' + response.status + ' ' + text);
    assert(report.methods.length === 1 && report.methods[0] === 0x02, '客户端方法列表 = ' + report.methods.join(','));
    assert(report.user === username && report.pass === password, 'SOCKS 认证用户名不匹配');
  } finally {
    await closeServer(server);
  }
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  await check('querySelectorDeep / getNodeBoxModel / clickSelector / querySelectorAcrossDocuments', testDomApis);
  await check('dispatchMouseEvent / dispatchKeyEvent', testMouseAndKey);
  await check('setUserAgent hideChrome 与 setJsDialogHandler', testUserAgentAndDialogs);
  await check('loadURLWithResponse', testLoadURLWithResponse);
  await check('setFileInputFiles', testFileInput);
  await check('session.fetch headerOrder', testHeaderOrder);
  await check('HTTP 代理 username/password', testHttpProxyAuth);
  await check('SOCKS5 代理 username/password', testSocks5ProxyAuth);

  const failed = results.filter((item) => !item.ok);
  console.log(`[custom] 结果 ${results.length - failed.length}/${results.length}`);
  app.exit(failed.length ? 1 : 0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
