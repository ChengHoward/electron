# CloudBypass Electron 定制功能说明

<!-- cloudbypass.9-current-start -->
当前 Windows x64 分发目标为 `45.0.0-cloudbypass.9`；保持 `.8` 定制接口兼容。同版本补充启用证书查看器自身标题栏拖动，当前构建证书窗口测试 **18/18**。首次 `.9` 构建的核心 **55/55**、独立跨 frame **7/7** 及类型检查保留为历史证据，未冒充本次二进制重测结果；具体摘要与范围见文末两节。打包、安装与发布结果按对应报告另外记录。
<!-- cloudbypass.9-current-end -->
| 项 | 内容 |
|----|------|
| 文档版本 | 1.2 |
| 更新日期 | 2026-11-04 |
| 基线分支 | `45-x-y`（Chromium `156.0.8078.36`） |
| 源码仓库 | [ChengHoward/electron](https://github.com/ChengHoward/electron) |
| 参考提交 | 见 [定制变更简述.md](./定制变更简述.md) 最近条目 |

本文档描述相对上游 Electron 的**定制 API、行为差异、Chromium 补丁与源码位置**，面向使用方与二次编译维护者。

变更流水账见 [定制变更简述.md](./定制变更简述.md) / [定制变更详细.md](./定制变更详细.md)。开发、编译和升版本见 [定制开发编译与更新.md](./定制开发编译与更新.md)。私有 npm / 二进制镜像见下文 **§7.2** 与 [私有镜像.md](./私有镜像.md)。

---

历史 .8 概要（保留原记录）：本文当前输入/点击示例按 Windows `.8` 接口整理，本构建核心 4 组 55 项及公开类型检查通过。其中 1 次核心真实光标采样受并发系统输入影响未能判定，未记为该采样通过。独立跨 frame 5 项为 3 通过、2 失败、0 无法判定，**尚未达到完整跨 frame 连续性**。发行包与安装记录见 [Windows x64 `.8` 发行页](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.8)、随附 `automation-build-manifest.json` 及安装/公开下载验证报告；安装与下载结果按各自报告单独记录。历史 `.4`–`.7` 的接口与证据保留在各版本记录。统一配置、默认值、状态、破坏性迁移及范围见 [Agent 自动化](./Agent自动化.md#自动化配置输入隔离与持续渲染windows-8)。

## 1. 概述

本 fork 在上游 Electron 之上增强以下能力，目标是**在不依赖 `webContents.debugger` 的前提下，贴近 Chrome DevTools Protocol（CDP）的实用行为**，并补充指纹 / 网络相关能力：

1. **User-Agent / Client Hints 覆盖** — 对齐 CDP `Emulation.setUserAgentOverride`（含请求头、跨域 iframe、`navigator.platform`、`Sec-CH-UA-*`）
2. **可信输入** — 新增 `dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent` / `cancelDragging`，对齐 CDP `Input.*`（无需 debugger）
3. **隐藏 `window.chrome`** — 经 `setUserAgent(ua, { hideChrome: true })` 控制网页主世界是否暴露该对象（可运行时切换）
4. **穿 closed shadow 的 DOM 自动化** — `querySelectorDeep` / `getNodeBoxModel` / `clickElement`（Blink C++，无 attach）
5. **`session.fetch` / `net.fetch` 请求头保序** — 绕过 WHATWG `Headers` 字母序；可选 `headerOrder` 强制线上顺序
6. **`loadURLWithResponse`** — 导航到指定 http(s) URL，主文档返回自定义正文（per-WC，不影响同 Session 其它窗口；不注册 `protocol.handle`）

| 能力 | 上游 Electron | 本定制 |
|------|---------------|--------|
| `session` / `webContents.setUserAgent` 改请求头 | 不完整，跨域 iframe 易不一致 | 浏览器侧强制改写 + NavigationEntry 继承 |
| 跨域 OOPIF 的 `navigator.userAgent` | 常忽略覆盖 | Chromium 补丁修复 |
| `navigator.platform` / `userAgentData` / `Sec-CH-UA-*` | 不支持经 `setUserAgent` 配置 | 支持 CDP 风格 options；可用 `null` 关闭 CH |
| 可信输入（`isTrusted === true`）并使用明确的 position/offset 坐标 | 需 debugger，或用不兼容的 `sendInputEvent` | `dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent`，无需 attach |
| 隐藏网页 `window.chrome` | 无 | `setUserAgent(ua, { hideChrome: true })` |
| 穿 closed shadow 的元素查找 / 盒模型 / 点击 | 需 debugger CDP DOM，或页面 JS（穿不了 closed） | `querySelectorDeep` / `getNodeBoxModel` / `clickElement`，Blink C++，无 attach |
| `ses.fetch` / `net.fetch` 自定义请求头顺序 | 经 `Request`→`Headers` 后按名字字节序发出 | 保插入序；可选 `headerOrder` 强制顺序 |
| 导航指定 URL、主文档自定义正文 | 需自管 `protocol.handle`（Session 级易误伤） | `loadURLWithResponse`：per-WC 短路，子资源仍出网 |

---

## 2. 功能一览

| 功能 | API | 类型 |
|------|-----|------|
| UA 字符串 + 可选 Accept-Language / platform / Client Hints | `ses.setUserAgent` / `contents.setUserAgent` | 增强既有 API |
| 禁用 UA Client Hints | `setUserAgent(ua, { userAgentMetadata: null })` | 增强 |
| 隐藏 `window.chrome` | `setUserAgent(ua, { hideChrome: true })` | 增强 |
| CDP 风格鼠标事件 | `contents.dispatchMouseEvent(mouseEvent)` | **新增 API** |
| CDP 风格键盘事件 | `contents.dispatchKeyEvent(keyEvent)` | **新增 API** |
| CDP 风格触摸事件 | `contents.dispatchTouchEvent(touchEvent)` | **新增 API** |
| 取消页面拖拽 | `contents.cancelDragging()` | **新增 API** |
| 穿 shadow 查找元素 | `contents.querySelectorDeep(selector[, options])` | **新增 API** |
| 节点盒模型 | `contents.getNodeBoxModel(backendNodeId[, options])` | **新增 API** |
| 按选择器可信点击 | `contents.clickElement(options)` | **新增 API** |
| fetch 请求头保序 / 强制顺序 | `ses.fetch` / `net.fetch` 的 `headerOrder` | **增强既有 API** |
| 导航到 URL + 自定义主文档响应 | `contents.loadURLWithResponse(url, response)` | **新增 API** |
| OOPIF 继承 UA | （无新 API，行为修复） | Chromium 补丁 |

---

## 3. API 参考

### 3.1 `ses.setUserAgent(userAgent[, options])`

- **模块**：`session`
- **作用域**：整个 session；会更新 NetworkContext，并广播到**已有**同 session 的 `WebContents`；之后新建的 `WebContents` 也会继承

**参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `userAgent` | `string` | 覆盖用的 UA 字符串；空字符串表示清除覆盖 |
| `options` | `string` \| `UserAgentOverrideOptions` | 可选。字符串时为旧版 Accept-Language；对象时见下表 |

**`UserAgentOverrideOptions`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `platform` | `string` | 覆盖 `navigator.platform`（如 `"Win32"`）。空或省略表示不覆盖 |
| `hideChrome` | `boolean` | `true`：网页主世界隐藏 `window.chrome`；默认 `false`。可再次调用切换 |
| `acceptLanguage` | `string` | Accept-Language，如 `"en-US,fr,de"`。别名：`acceptLanguages` |
| `userAgentMetadata` | `UserAgentMetadata` \| `null` | 见下节。省略：使用构建默认 metadata；`null`：不发送 `Sec-CH-UA-*` |

**`UserAgentMetadata`**（对齐 CDP；缺省字段由 Electron 默认 metadata 填充）

| 字段 | 类型 | 对应 |
|------|------|------|
| `brands` | `{ brand, version }[]` | `Sec-CH-UA` / `navigator.userAgentData.brands` |
| `fullVersionList` | `{ brand, version }[]` | `Sec-CH-UA-Full-Version-List` |
| `fullVersion` | `string` | `Sec-CH-UA-Full-Version` |
| `platform` | `string` | `Sec-CH-UA-Platform`（如 `"Windows"`，**不是** `navigator.platform`） |
| `platformVersion` | `string` | `Sec-CH-UA-Platform-Version` |
| `architecture` | `string` | `Sec-CH-UA-Arch` |
| `model` | `string` | `Sec-CH-UA-Model` |
| `mobile` | `boolean` | `Sec-CH-UA-Mobile` |
| `bitness` | `string` | `Sec-CH-UA-Bitness` |
| `wow64` | `boolean` | `Sec-CH-UA-Wow64` |
| `formFactors` | `string[]` | `Sec-CH-UA-Form-Factors` |

**示例**

```js @ts-type={windowsUA:string}
const { session } = require('electron')

// 旧用法（兼容）
session.defaultSession.setUserAgent('MyAgent/1.0', 'en-US,fr,de')

// 仅 UA（Client Hints 用本机构建默认值，可能与伪装 OS 不一致）
session.defaultSession.setUserAgent(windowsUA)

// CDP 风格：UA + platform + Sec-CH
session.defaultSession.setUserAgent(windowsUA, {
  platform: 'Win32',
  acceptLanguage: 'en-US',
  userAgentMetadata: {
    brands: [
      { brand: 'Chromium', version: '120' },
      { brand: 'Google Chrome', version: '120' },
      { brand: 'Not=A?Brand', version: '99' }
    ],
    fullVersionList: [
      { brand: 'Chromium', version: '120.0.6099.109' },
      { brand: 'Google Chrome', version: '120.0.6099.109' },
      { brand: 'Not=A?Brand', version: '10.0.1.4' }
    ],
    fullVersion: '120.0.6099.109',
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false,
    formFactors: ['Desktop']
  }
})

// 保留自定义 UA，关闭 Sec-CH-UA-*
session.defaultSession.setUserAgent('MyAgent/1.0', { userAgentMetadata: null })

// 隐藏网页 window.chrome（可与 platform / metadata 同传）
session.defaultSession.setUserAgent(windowsUA, {
  platform: 'Win32',
  hideChrome: true
})
```

### 3.2 `contents.setUserAgent(userAgent[, options])`

- **模块**：`webContents`（及 `<webview>` 对应接口）
- **作用域**：当前页面；`options` 形态与 session 相同（第二参为对象时不支持「仅字符串 Accept-Language」以外的 session 旧习惯——字符串仍可解析为 acceptLanguage）

行为与 session 路径共用同一套应用逻辑（NavigationEntry 标记、`override_in_new_tabs`、metadata / platform、`SyncRendererPrefs`）。

### 3.3 `contents.dispatchMouseEvent(mouseEvent)`

- **返回**：`Promise<AgentDispatchResult>`（派发结果，页面动作需另行确认）
- **对齐**：CDP `Input.dispatchMouseEvent`
- **无需** `webContents.debugger.attach()`

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | `mousePressed` \| `mouseReleased` \| `mouseMoved` \| `mouseWheel` |
| `position` | `{ x, y }` | 无 target 时必需，主视口 CSS 坐标 |
| `target` / `offset` | `AgentTarget` / `{ x, y }` | 目标定位及可选元素内 CSS 偏移；与 position 互斥 |
| `modifiers` | `number` | 可选。Alt=1, Ctrl=2, Meta=4, Shift=8，默认 0 |
| `button` | `string` | 可选。`none` \| `left` \| `middle` \| `right` \| `back` \| `forward` |
| `buttons` | `number` | 可选。当前按下按钮位域，默认 0 |
| `clickCount` | `number` | 可选。默认 0 |
| `deltaX` / `deltaY` | `number` | `mouseWheel` 时使用 |
| `timestamp` | `number` | 可选。Unix epoch 秒（可小数），默认当前时间 |
| `pointerType` | `string` | 可选。`mouse` \| `pen`，默认 `mouse` |
| `force` | `number` | 可选。归一化压力 `[0,1]`，默认 0（触控笔） |
| `tangentialPressure` | `number` | 可选。切向压力 `[-1,1]`，默认 0 |
| `tiltX` / `tiltY` | `number` | 可选。笔倾斜角度 `[-90,90]`，默认 0 |
| `twist` | `number` | 可选。笔绕轴旋转度 `[0,359]`，默认 0 |

**示例**

```js @ts-type={win:Electron.BrowserWindow}
await win.webContents.dispatchMouseEvent({
  type: 'mousePressed',
  position: { x: 100, y: 200 },
  button: 'left',
  clickCount: 1
})
await win.webContents.dispatchMouseEvent({
  type: 'mouseReleased',
  position: { x: 100, y: 200 },
  button: 'left',
  clickCount: 1
})
```

**对比**

| | debugger CDP | `dispatchMouseEvent` | `sendInputEvent` | `element.click()` |
|--|-------------|----------------------|------------------|-------------------|
| 需 attach | 是 | 否 | 否 | 否 |
| `isTrusted` | true | true | true | false |
| OOPIF 坐标路由 | 有 | 有 | 弱 | 节点直达 |
| 参数风格 | CDP | position/offset 坐标 + 其余 CDP 字段 | Electron 自有 | DOM |

### 3.4 `contents.dispatchKeyEvent(keyEvent)`

- **返回**：`Promise<AgentDispatchResult>`（派发结果，页面动作需另行确认）
- **对齐**：CDP `Input.dispatchKeyEvent`
- **无需** `webContents.debugger.attach()`
- 投递到**焦点** RenderWidget（`GetFocusedRenderWidgetHost`）

主要字段：`type`（`keyDown` / `keyUp` / `rawKeyDown` / `char`）、`modifiers`、`text` / `unmodifiedText`、`code` / `key`、`windowsVirtualKeyCode`、`commands` 等（同 CDP，均为选配除 `type`）。

```js @ts-type={win:Electron.BrowserWindow}
await win.webContents.dispatchKeyEvent({
  type: 'keyDown',
  key: 'a',
  code: 'KeyA',
  windowsVirtualKeyCode: 65,
  text: 'a',
  unmodifiedText: 'a'
})
await win.webContents.dispatchKeyEvent({
  type: 'char',
  key: 'a',
  code: 'KeyA',
  windowsVirtualKeyCode: 65,
  text: 'a',
  unmodifiedText: 'a'
})
await win.webContents.dispatchKeyEvent({
  type: 'keyUp',
  key: 'a',
  code: 'KeyA',
  windowsVirtualKeyCode: 65
})
```

> 插入任意文本仍可用既有 `contents.insertText(text)`（渲染进程 IME CommitText），语义接近 CDP `Input.insertText`。

### 3.5 `contents.dispatchTouchEvent(touchEvent)`

- **返回**：`Promise<AgentDispatchResult>`（派发结果，页面动作需另行确认）
- **对齐**：CDP `Input.dispatchTouchEvent`（WebTouch + TouchEmulator 注入路径）
- 序列须以 `touchStart` 开始；`touchStart`/`touchMove` 的 `touchPoints` 非空；`touchCancel` 须为空数组

```js @ts-type={win:Electron.BrowserWindow}
await win.webContents.dispatchTouchEvent({
  type: 'touchStart',
  touchPoints: [{ id: 0, position: { x: 100, y: 200 } }]
})
await win.webContents.dispatchTouchEvent({
  type: 'touchEnd',
  touchPoints: []
})
```

### 3.6 `contents.cancelDragging()`

- **返回**：`Promise<void>`
- **对齐**：CDP `Input.cancelDragging`（无 debugger 拖拽状态机时为 best-effort：`DragSourceSystemDragEnded`）

### 3.7 `hideChrome`（`setUserAgent` options）

- **配置位置**：`ses.setUserAgent` / `contents.setUserAgent` 的 options
- **类型**：`boolean`，默认 `false`
- **作用**：为 `true` 时，网页主世界不暴露 `window.chrome`（`typeof chrome === 'undefined'`）
- **不影响**：扩展页、content script 等仍需要 `chrome.*` 的上下文
- **运行时**：可再次 `setUserAgent` 切换（经 `RendererPreferences` + `SyncRendererPrefs`）
- **与真 Chrome**：本版仅隐藏，不伪造 `chrome.app` / `csi` / `loadTimes`

**示例**

```js @ts-type={myUA:string}
session.defaultSession.setUserAgent(myUA, { hideChrome: true })
// 之后恢复显示：
session.defaultSession.setUserAgent(myUA, { hideChrome: false })
```

### 3.8 `ses.fetch` / `net.fetch`：请求头保序与 `headerOrder`

- **模块**：`session` / `net`（`net.fetch` = 默认 session 的便捷封装）
- **动机**：上游实现会 `new Request` → 迭代 WHATWG `Headers`（规范 **sort-and-combine**，近似字母序），导致自定义头线上顺序与写入顺序不一致，难以贴近页面导航头序
- **本定制**：写 `ClientRequest` 时**不再**依赖已排序的 `req.headers` 迭代；改为按 `init.headers` 的对象键序 / 数组序写入；可选 `headerOrder` 再强制重排

**`init` 扩展字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `bypassCustomProtocolHandlers` | `boolean` | 上游已有：绕过 `protocol.handle` |
| `headerOrder` | `string[]` | **本定制**。按该名字列表（大小写不敏感）决定自定义头发出顺序；未列出的头接在后面，保持相对原序 |

**行为要点**

| 情况 | 行为 |
|------|------|
| 未传 `headerOrder`，`headers` 为普通对象 / 键值数组 | 按**插入顺序**发出 |
| `headers` 已是 `Headers` 实例 | 仍为规范排序结果（无法恢复插入序）；需要序请改用对象/数组或配合 `headerOrder` |
| 传了 `headerOrder` | 先按列表输出命中的头，其余按原相对顺序追加 |
| 调用方已设 `sec-fetch-mode` | 不再自动前置默认 `Sec-Fetch-Mode`（避免打乱顺序） |

**不可控（网络栈后补，不在 `headerOrder` 内）**

- `Accept-Encoding`、`Cookie`、`priority`（H2 优先级头，如 `u=4, i`）等常由 Chromium 在自定义头之后追加
- 伪头 `:method` / `:authority` / `:scheme` / `:path` 仍由 H2 规则决定
- 与页面导航完全一致还需另控请求优先级等（当前**未**做）；TLS/JA3 也不保证与 `loadURL` 相同

**示例**

```js @ts-type={myUA:string}
const { session } = require('electron')

const navLike = {
  'upgrade-insecure-requests': '1',
  'user-agent': myUA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'accept-language': 'zh-CN'
}

const res = await session.defaultSession.fetch('https://example.com/', {
  headers: navLike,
  headerOrder: [
    'upgrade-insecure-requests',
    'user-agent',
    'accept',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-user',
    'sec-fetch-dest',
    'accept-language'
  ]
})
```

上游风格说明见 `src/electron/docs/api/session.md`（`ses.fetch`）、`net.md`（`net.fetch`）。

### 3.9 `contents.querySelectorDeep(selector[, options])`

- **返回**：`Promise<DomElementInfo | null>`
- **实现**：Blink C++（经 mojom），**无需** `debugger.attach()`，也**不依赖**页面 JS
- **能力**：可进入 **closed** author shadow（页面脚本不可见）；选择器支持 `>>>` 进入 shadow

**`options`**

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pierce` | `boolean` | `true` | 是否搜索嵌套 open/closed author shadow |
| `scrollIntoView` | `boolean` | `false` | 测量前是否滚入视口 |

**`DomElementInfo`（主要字段）**：`backendNodeId`、`tagName`、`bounds`、以及相对主框视口的 `x` / `y` / `width` / `height`（与 `dispatchMouseEvent` 同一坐标系）。

```js @ts-type={win:Electron.BrowserWindow}
const el = await win.webContents.querySelectorDeep('my-button >>> #submit')
if (el) {
  await win.webContents.dispatchMouseEvent({
    type: 'mousePressed',
    position: { x: el.x + el.width / 2, y: el.y + el.height / 2 },
    button: 'left',
    clickCount: 1
  })
  await win.webContents.dispatchMouseEvent({
    type: 'mouseReleased',
    position: { x: el.x + el.width / 2, y: el.y + el.height / 2 },
    button: 'left',
    clickCount: 1
  })
}
```

### 3.10 `contents.getNodeBoxModel(backendNodeId[, options])`

- **返回**：`Promise<DomBoxModel | null>`（节点已失效则为 `null`）
- **`backendNodeId`**：来自 `querySelectorDeep` 或 CDP DOM
- 坐标同样为相对主框视口的 CSS 像素

### 3.11 `contents.clickElement(options)`

- **返回**：`Promise<AgentDispatchResult>`（派发结果，页面动作需另行确认）
- **作用**：按与 `querySelectorDeep` 相同规则查找元素，在中心点派发可信 press+release（同 `dispatchMouseEvent` 管线）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pierce` | `boolean` | `true` | 穿 shadow |
| `scrollIntoView` | `boolean` | `true` | 点击前滚入视口 |
| `button` | `string` | `left` | 鼠标键 |
| `clickCount` | `number` | `1` | 点击次数 |
| `modifiers` | `number` | `0` | Alt=1, Ctrl=2, Meta=4, Shift=8 |

```js @ts-type={win:Electron.BrowserWindow}
await win.webContents.clickElement({ selector: '#login', pierce: true })
await win.webContents.clickElement({ selector: 'x-card >>> button.primary' })
```

### 3.12 `contents.loadURLWithResponse(url, response)`

- **返回**：`Promise<void>`（生命周期同 `loadURL`）
- **作用**：导航到 `url`（须 `http:` / `https:`），**主文档**使用你提供的响应，**不出网**；子资源仍走真实网络
- **隔离**：override 挂在**本 WebContents**；同 Session 其它 WC 不受影响
- **不**注册 / 覆盖 `protocol.handle`
- **不接受** `loadURL` 的 options（`extraHeaders` / `postData` / `httpReferrer` 等）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `statusCode` | `number` | `200` | HTTP 状态码 |
| `headers` | `Record<string, string>` | — | 响应头（建议含 `content-type`） |
| `body` | `string` \| `Buffer` | `''` | 主文档正文 |

```js @ts-type={win:Electron.BrowserWindow}
await win.webContents.loadURLWithResponse('https://example.com/app', {
  statusCode: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: '<!doctype html><h1>hello</h1>'
})
```

实现要点：`NavigationResponseOverrideRegistry` + `ProxyingURLLoaderFactory::CreateLoaderAndStart` 命中后走 `ElectronURLLoaderFactory::SendContents`。

---

## 4. 行为说明

### 4.1 User-Agent 生效通道

定制后 UA 覆盖走双通道（贴近 CDP）：

1. **请求头**：`UserAgentURLLoaderThrottle` 在 `WillStartRequest` / `WillRedirectRequest` 强制写入 `User-Agent`
2. **页面脚本**：`SetUserAgentOverride` + RendererPreferences；跨域 OOPIF 依赖 Chromium 补丁 `fix_allow_ua_override_when_main_frame_is_remote.patch`

### 4.2 请求头与 Client Hints

| 请求头 | 何时更新 |
|--------|----------|
| `User-Agent` | 设置非空 UA 后始终覆盖 |
| `Accept-Language` | 提供了 `acceptLanguage` / 旧版第二参字符串时 |
| `Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` 等 | 由 `userAgentMetadata` 决定；高熵头通常还需站点 `Accept-CH` |
| （无对应头）`options.platform` | 仅影响 `navigator.platform`，不进 HTTP |

| `userAgentMetadata` | 结果 |
|---------------------|------|
| 省略 | 使用本机构建默认 metadata（Linux 上伪装 Windows UA 时容易与 CH 不一致） |
| `null` | **不发送** `Sec-CH-UA-*`（UA 字符串仍生效） |
| 对象 | 按字段覆盖；未给字段用默认值填充 |

### 4.3 伪装操作系统时的注意点

`setUserAgent` **不能**伪装 WebGL/字体/语音包等指纹面。若仅改 UA 字符串、不配 `platform` 与 `userAgentMetadata`，常见泄漏为：

- `User-Agent` 声称 Windows，而 `Sec-CH-UA-Platform` / `navigator.platform` 仍为 Linux

完整伪装至少应保证 UA 字符串、`options.platform`、`userAgentMetadata`（尤其 `platform` / brands / 版本）彼此一致。

### 4.4 `dispatchMouseEvent` 坐标

无 target 时的 `position` 相对**主框视口** CSS 像素，带 target 时使用元素内 `offset`；按 zoom / page scale 换算；通过 `GetRenderWidgetHostAtPointAsynchronously` 路由到含 OOPIF 在内的正确 widget。

### 4.5 `querySelectorDeep` / `clickElement` 与页面 JS 的差异

| | 页面 `querySelector` | 本定制 API |
|--|----------------------|------------|
| closed shadow | 不可见 | 默认可穿（`pierce: true`） |
| 执行位置 | 渲染进程 JS | Blink C++（主进程 API → 渲染服务） |
| 需 debugger | 否 | 否 |

`>>>` 为进入 author shadow 的约定分隔符（非标准 CSS）；与 CDP `pierce` 语义接近。

### 4.6 fetch 头序 vs 页面导航

用 peet.ws 一类 TLS/HTTP 回显可验证：`headerOrder` 可使**调用方给出的自定义头块**与导航同序；`Accept-Encoding` / `priority` 等后补头仍可能与导航不同（位置或取值）。这不改变 Session Cookie / 代理 / UA 的共用。

---

## 5. Chromium 补丁

登记于 `src/electron/patches/chromium/.patches`：

| 补丁文件 | 作用 |
|----------|------|
| `fix_allow_ua_override_when_main_frame_is_remote.patch` | OOPIF 进程主框为 `WebRemoteFrame` 时仍启用 UA 覆盖 |
| `feat_navigator_platform_override_in_renderer_preferences.patch` | `RendererPreferences.navigator_platform_override` → `navigator.platform` |
| `feat_hide_chrome_in_renderer_preferences.patch` | `RendererPreferences.hide_chrome` + 网页上下文跳过 `window.chrome` |

构建时由 Electron 的 patch 流程自动应用到 Chromium 树；无需在业务项目中单独打补丁。

关联上游问题：[electron#40374](https://github.com/electron/electron/issues/40374)、[electron#40990](https://github.com/electron/electron/issues/40990)、[crbug.com/426555](https://crbug.com/426555)。

---

## 6. Electron 源码改动清单

| 路径 | 说明 |
|------|------|
| `shell/browser/net/user_agent_url_loader_throttle.{h,cc}` | 强制改写请求 `User-Agent` |
| `shell/browser/user_agent_options.{h,cc}` | 解析 CDP 风格 options / metadata / `hideChrome` |
| `shell/browser/api/electron_api_session.cc` | session `setUserAgent` 增强与广播 |
| `shell/browser/api/electron_api_web_contents.{h,cc}` | `setUserAgent` 增强；CDP 输入；DOM 查找 / 点击 |
| `shell/common/api/api.mojom` + `shell/renderer/electron_api_service_impl.*` | 渲染侧 DOM 查询 / 盒模型 |
| `shell/browser/electron_browser_context.{h,cc}` | 持久化 platform / hideChrome / metadata / acceptLanguage |
| `shell/browser/electron_browser_client.cc` | 挂载 UA throttle |
| `shell/renderer/electron_render_frame_observer.cc` | 主世界保险删除 `window.chrome` |
| `lib/browser/api/net-fetch.ts` | `ses.fetch` / `net.fetch` 头保序与 `headerOrder` |
| `lib/browser/api/session.ts` | `fetch` init 类型含 `headerOrder` |
| `lib/browser/api/web-contents.ts` / `browser-window.ts` | `loadURLWithResponse` JS 封装 |
| `shell/browser/net/navigation_response_override_registry.{h,cc}` | per-WC 一次性主文档假响应登记 |
| `shell/browser/net/proxying_url_loader_factory.cc` | CreateLoaderAndStart 命中短路 |
| `filenames.gni` | 登记新源文件 |
| `docs/api/session.md` / `net.md` / `web-contents.md` | API 文档 |
| `docs/api/structures/user-agent-*.md` / `dom-*.md` / `*-selector-*.md` | 结构体文档 |
| `spec/api-session-spec.ts` / `api-web-contents-spec.ts` | 规格测试 |

上游 API 文档路径（随源码）：`src/electron/docs/api/`。

### 6.1 已讨论、尚未落地

| 能力 | 状态 | 备注 |
|------|------|------|
| fetch 对齐导航的 `priority` / AE·AL 顺序 | **搁置** | 可用 `net` 的 `priority: 'highest'` 等减轻差距；完整对齐需更深网络栈改动 |

---

## 7. 构建与获取

### 7.1 从源码构建

使用本 fork 的 `43-x-y`（或包含上述提交的分支），按 Electron build-tools 流程：

```text
e sync
e build electron:electron_dist_zip
```

- Windows x64：当前 `e` 配置下 `out/Release` 即为 x64 产物
- Linux：需在 Linux 主机或 WSL2（源码置于 Linux 文件系统）上编译；不可从 Windows 交叉编译

Linux 容器化编译可参考仓库内 `xbuild/`。

### 7.2 私有 npm / 二进制镜像

定制 Electron 通过 Cloudflare Tunnel 对外提供 **npm 包** 与 **预编译二进制**，业务项目用 yarn/npm 安装时走该仓库，而不是官方 npm / GitHub Releases。

| 项 | 值 |
|----|-----|
| 公网域名 | `https://mirror.cloudbypass.com/electron` |
| npm registry | `https://mirror.cloudbypass.com/electron/npm/` |
| 包名 | `electron` |
| Windows x64 安装示例版本 | [`45.0.0-cloudbypass.6`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.6)（2026-11-04 发行版本，安装验证及附件见发布记录）；Linux x64 仍为已有 `45.0.0-cloudbypass.2`。 |
| 本机服务目录 | 仓库旁 `mirror/`（默认端口 `8787`） |

安装时有两段下载，都须指向本镜像：

1. **npm 包**（`package.json` / tarball / registry）
2. **二进制 zip**（`postinstall` 里 `@electron/get` 按 `electron_mirror` 拼接 URL）

#### URL 约定

| 用途 | URL |
|------|-----|
| 健康检查 | `https://mirror.cloudbypass.com/electron/healthz` |
| npm 元数据 | `https://mirror.cloudbypass.com/electron/npm/electron` |
| npm tarball | `https://mirror.cloudbypass.com/electron/npm/electron/-/electron-{version}.tgz` |
| 二进制 | `https://mirror.cloudbypass.com/electron/v{version}/electron-v{version}-{platform}-{arch}.zip` |
| 校验和 | `https://mirror.cloudbypass.com/electron/v{version}/SHASUMS256.txt` |

`@electron/get` 实际 URL：

```text
{electron_mirror}{electron_custom_dir}/{filename}
```

Windows `.6` 的 URL 示例：`https://mirror.cloudbypass.com/electron/v45.0.0-cloudbypass.6/electron-v45.0.0-cloudbypass.6-win32-x64.zip`。本地镜像已提供，安装验证及附件见 [发布记录](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.6)。

#### 业务项目配置（推荐）

**1. 项目根目录 `.npmrc`**

```ini
# 普通依赖仍走官方 npm
registry=https://registry.npmjs.org/

# Electron 二进制镜像（@electron/get / install.js）
electron_mirror=https://mirror.cloudbypass.com/electron/
electron_custom_dir=v{{ version }}

# 定制构建校验和与官方不同，必须用远端 SHASUMS256.txt
electron_use_remote_checksums=1
```

也可等价设置环境变量（Yarn v1 / npm 均可读）：

```powershell
$env:ELECTRON_MIRROR="https://mirror.cloudbypass.com/electron/"
$env:ELECTRON_CUSTOM_DIR="v{{ version }}"
$env:ELECTRON_USE_REMOTE_CHECKSUMS="1"
```

**2. `package.json` 依赖版本**

下方为 Windows `.6` 安装示例，版本号须与镜像实际提供的产物一致；Linux x64 仍使用 `45.0.0-cloudbypass.2`：

```json
{
  "devDependencies": {
    "electron": "45.0.0-cloudbypass.6"
  }
}
```

**3. 安装（仅 electron 走私有 registry）**

```bash
yarn add electron@45.0.0-cloudbypass.6 --registry https://mirror.cloudbypass.com/electron/npm/
```

不要把全局 `registry` 永久改成镜像，以免其它依赖解析失败。

#### 可选：直接依赖 tarball

不经过 registry 元数据，适合 CI 锁死 URL：

```json
{
  "devDependencies": {
    "electron": "https://mirror.cloudbypass.com/electron/npm/electron/-/electron-45.0.0-cloudbypass.6.tgz"
  }
}
```

```bash
yarn
```

二进制仍由 `postinstall` 按 `.npmrc` 中的 `electron_mirror` 下载。

#### Yarn Berry (v2+)

安装时可临时指定 registry：

```bash
YARN_NPM_REGISTRY_SERVER=https://mirror.cloudbypass.com/electron/npm/ yarn add electron@45.0.0-cloudbypass.6
```

`electron_mirror` / `electron_use_remote_checksums` 仍需通过 `.npmrc` 或环境变量提供（Electron 的 install 脚本读的是 npm config / env）。

#### 镜像侧运维（维护者）

```powershell
cd <repo>/mirror
.\run.ps1 -Publish       # 从 out/Release/dist.zip 发布 npm + 二进制
.\run.ps1 -SetupTunnel   # 首次配置 mirror.cloudbypass.com
.\run.ps1                # HTTP + Tunnel（未配置 Tunnel 时降级为本机）
.\run.ps1 -LocalOnly     # 仅 http://127.0.0.1:8787
```

发布前在 `mirror/config.json` 中设置 `version`（及平台 `platform` / `arch`）。更细的目录与发布说明见 [私有镜像.md](./私有镜像.md) 与仓库 `mirror/README.md`。

---

## 8. 兼容性

| 项 | 说明 |
|----|------|
| 旧 `ses.setUserAgent(ua, acceptLanguages: string)` | 保持兼容 |
| 仅调用 `setUserAgent(ua)` | UA 与请求头生效；CH 用默认 metadata |
| 上游未定制的 API | 行为与对应上游版本一致 |
| TypeScript | 以构建生成的 `electron.d.ts` 为准；结构体含 `UserAgentOverrideOptions` 等 |

---

## 9. 验证清单

编译安装定制 Electron 后建议确认：

1. `setUserAgent('X')` 后顶层与跨域 iframe：`navigator.userAgent === 'X'`，请求头 `User-Agent: X`
2. 带 `platform: 'Win32'` 时 `navigator.platform === 'Win32'`
3. 自定义 `userAgentMetadata.brands` 出现在 `navigator.userAgentData.brands`
4. `{ userAgentMetadata: null }` 时请求无 `sec-ch-ua*`（在会附带 CH 的场景下）
5. `dispatchMouseEvent` 点击后目标元素事件 `isTrusted === true`，跨域 iframe 内坐标可命中
6. `dispatchKeyEvent` 可向焦点输入框写入字符；`dispatchTouchEvent` 可完成 touchStart→touchEnd
7. `setUserAgent(ua, { hideChrome: true })` 后页面 `typeof chrome === 'undefined'`；`hideChrome: false` 恢复；与 platform / metadata 可同传
8. `querySelectorDeep('host >>> #inner')` 能命中 closed shadow 内节点；`clickElement` 触发的点击 `isTrusted === true`
9. `ses.fetch(url, { headers, headerOrder })`：TLS/HTTP 回显（如 peet.ws）中自定义头顺序与 `headerOrder` 一致；对象键故意打乱时仍以 `headerOrder` 为准
10. `loadURLWithResponse`：`getURL()` / origin 为目标站；页面正文为自定义 HTML；同 Session 另一 WC 真导航不受影响；全程无 `protocol.handle`

自动化：`spec/api-session-spec.ts`、`spec/api-web-contents-spec.ts` 中相关用例。

---

## 10. 文档索引

| 文档 | 用途 |
|------|------|
| 本文 | 定制功能标准说明（使用 + 维护） |
| [Sec-CH-UA生成逻辑.md](./Sec-CH-UA生成逻辑.md) | 默认 `Sec-CH-UA` / GREASE / 打乱算法与版本对照表 |
| [定制变更简述.md](./定制变更简述.md) | 变更索引表 |
| [定制变更详细.md](./定制变更详细.md) | 按次记录的实现背景与验证 |
| [私有镜像.md](./私有镜像.md) | 私有 npm / 二进制镜像运维摘要 |
| 本文 §7.2 | 业务侧 yarn/npm 配置与 URL 约定 |
| `mirror/README.md` | 镜像服务完整说明 |
| `src/electron/docs/api/session.md` | 上游风格 API 文档 |
| `src/electron/docs/api/web-contents.md` | 含 CDP 输入与 `querySelectorDeep` / `clickElement` 等 |
| `src/electron/docs/api/session.md` / `net.md` | 含 `headerOrder` |
| `src/electron/docs/api/structures/user-agent-*.md` | options / metadata 结构 |
| `src/electron/docs/api/structures/dom-*.md` 等 | DOM 自动化结构体 |

## 2026-11-03：原生虚拟光标与批量输入（.4）

新增 `setVirtualCursorEnabled`、`setVirtualCursorImage`、`setVirtualCursorFrameRate`、`dispatchInputSequence`。Windows 原生 UI 光标与页面截图隔离；支持独立阻断真实指针/键盘、限帧、鼠标键盘统一 atMs 时间线、有界焦点确认、取消及失败清理。完整参数、实测和未覆盖硬件边界见 [Agent 自动化](./Agent自动化.md)。本版本同时包含 clickSelector 修复；不新增页面自动化标识，不承诺行为无法识别。

## 2026-11-04：原生网站信息与 NativePanel（Windows .5）

状态：**编译与验收通过**。Windows x64 发行版本为 [`45.0.0-cloudbypass.5`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.5)；原生浮层 42 项与既有功能 46 项回归合计 **88/88** 通过。Linux x64 仍为已有 `.2`。完整接口、schema、事件、源码入口与验收边界见 [原生浮层](./原生浮层.md)。

本轮新增 `webContents.showPageInfoDialog`、`new NativePanel`、`NativePanel.isSupported`、`panel.show`、`panel.update`、`panel.hide`、`panel.destroy` 七个公开入口，使用浏览器主进程中的原生控件覆盖 `WebContentsView` 并可伸出父窗，不创建额外网页或渲染进程。首版目标为 Windows x64，必须运行时探测；历史二进制不能由本文推断支持。

网站信息读取已提交导航项的真实 SSL/TLS 和证书。已接入的 `permissionCheckHandler` 只反映当前预授权检查，`false` 不能视为永久拒绝；修改许可通过 `page-info-open-site-settings(event, { url, origin })` 交宿主既有站点设置逻辑处理，不引入 Chrome Profile。

实现入口为 `lib/browser/api/native-panel.ts`、`shell/browser/api/electron_api_native_panel.{h,cc}`、`shell/browser/ui/views/native_panel.{h,cc}`、`lib/browser/api/web-contents.ts` 和 `shell/browser/api/electron_api_web_contents.{h,cc}`。面板开关不改变虚拟光标、`dispatchInputSequence` 或真实输入保护；输入命中探测/设置及持续绘制租约三个可选接口未增加。编译和原生窗口验收仍在进行，不能用静态检查替代物理输入、中文 IME、混合 DPI 与资源释放验证。

## 2026-11-04：原生界面与菜单定制（Windows .6）

2026-11-04 Windows x64 发行版本为 [`45.0.0-cloudbypass.6`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.6)，本地镜像已提供，安装验证及附件见该版本发布记录。Linux x64 仍为已有 `.2`；本次没有 Linux 或 macOS `.6` 包，不能由 Windows 结果推断其他平台支持。

NativePanel 在原有入口上增加 `item`、`iconButton`、`button.variant`、交互状态样式、四边内边距、无边框输入、文字宽度与省略、UTF-16 高亮范围、行内链接及宿主控制的选中态。整行与内部按钮独立回传动作，稳定 id 的更新保留焦点、草稿、IME 组合和滚动位置。列表和外层溢出区使用灰色圆头滑块及上下箭头。

原生菜单继续使用 `Menu` 和 Chromium MenuRunner，提供 `menu.popup({ appearance })`、`MenuItem.controls`、`menu.refresh()` 及根菜单的 `control-action`。支持主题、最小宽度、行高、圆角、留白、图标和分段按钮；行内按钮可持续点击而不关闭菜单。打开期间可刷新文字、图标与可用状态，控件 id、类型、数量和分组结构保持不变。菜单不使用 NativePanel，未启用定制的菜单保留原有行为。

`showPageInfoDialog` 主面板和安全子页使用原生 Views 与 Chromium 语言资源。证书窗口复用 Chromium 原版 `chrome://view-cert` HTML、CSS、TypeScript、证书树和五种导出格式，单独使用一个隔离的 WebContents，不运行 Node 或宿主 preload。其他原生面板和菜单不增加网页渲染器。网站设置继续通过事件交宿主处理，本轮没有 Cookie 管理或完整站点权限设置页。

下载记录、地址建议、悬浮输入和菜单内容由宿主提供；本轮只提供原生展示与显式动作接口。方法、参数、主题、截图及本地验收范围见 [原生界面定制实现与测试](./原生界面定制实现与测试.md)，原始需求见 [定制规划](./原生界面定制规划.md)。

## 2026-11-04：自动化配置与输入隔离（Windows .8）

本文当前输入/点击示例按 Windows `.8` 接口整理，本构建核心 4 组 55 项及公开类型检查通过。其中 1 次核心真实光标采样受并发系统输入影响未能判定，未记为该采样通过。独立跨 frame 5 项为 3 通过、2 失败、0 无法判定，**尚未达到完整跨 frame 连续性**。发行包与安装记录见 [Windows x64 `.8` 发行页](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.8)、随附 `automation-build-manifest.json` 及安装/公开下载验证报告；安装与下载结果按各自报告单独记录。历史 `.4`–`.7` 的接口与证据保留在各版本记录。统一配置、默认值、状态、破坏性迁移及范围见 [Agent 自动化](./Agent自动化.md#自动化配置输入隔离与持续渲染windows-8)。

新增 `setAutomationOptions`、`getAutomationState`、`resetAutomationOptions`；`isolateInput`、真实指针/键盘屏蔽、`keepRendering` 与 `virtualCursor` 分别配置。保留 `setVirtualCursorImage` / `setVirtualCursorFrameRate`，移除 `setVirtualCursorEnabled`。点击迁移至单对象 `clickElement`，鼠标与触摸坐标使用 `position` / `offset`，单事件与点击统一返回 `AgentDispatchResult`。本版同时修正“证书查看器”简体中文标题；证书窗口跟随拖动尚未修复。

核心 4 组：automation-options **10/10**；input-sequence **25/25**；agent **11/11**；click **9/9**，合计 **55/55**。公开类型生成及 TypeScript smoke 通过。

上述通过计数仅属于核心四组，独立跨 frame 的五项检查另列，不隐藏其中的失败。没有整套重跑多语言原生菜单截图。输入 suite 显式跳过完整性能矩阵，跳过明细保留在其原始报告中。本次 Windows 结果不扩展到 Linux、macOS、系统输入法或未列出的硬件场景。

核心 automation-options 的独立真实光标采样状态为 `inconclusive_concurrent_system_input`：lastInputTick `291938765` → `291941937`，光标 `{"x": 843, "y": 364}` → `{"x": 857, "y": 413}`。这次采样不能据此判定真实光标未移动；该 case 的焦点、保活和 OOPIF 输入断言通过。核心用例计数与此采样结论分别记录，不能把 55/55 扩写为所有测量均已通过。

从未显示过且已挂载的 WebContentsView：动画计数 `314` → `336`（185ms）；截图前计数 `336` → `381`，之后为 `409`。对应 case 的相邻截图像素差异断言通过，证明这次实际观察到截图调用前动画推进与新像素。

上述核心真实光标采样的未判定结果，与下方独立跨 frame 报告中的通过/失败/无法判定计数分别保留。

核心配置实际报告：`D:/electron/edist-publish/automation-release-45.0.0-cloudbypass.8/automation-options-results.json`。

发行包与安装记录见 [Windows x64 `.8` 发行页](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.8)、随附 `automation-build-manifest.json` 及安装/公开下载验证报告；安装与下载结果按各自报告单独记录。

原始运行数据、收据、焦点记录、类型及证书资源核验随附于 `automation-runtime-reports.zip`，包括独立跨 frame 的两个已知失败，核心通过计数不代表全部检查通过。

### 独立跨 frame 连续性实测

独立跨 frame 5 项为 3 通过、2 失败、0 无法判定，**尚未达到完整跨 frame 连续性**。该组独立于上面的核心四组计数，保留全部失败或无法判定结果，不把核心通过数写成全部验收通过。

实际进程拓扑：main：OS PID `1640316`，Chromium processId `4`、routingId `1`；same：OS PID `1640316`，Chromium processId `4`、routingId `4`；cross：OS PID `1640768`，Chromium processId `5`、routingId `6`。

- 跨主文档、同进程 iframe、OOPIF 的轨迹及虚拟光标位置：**通过**。
- iframe 进入/退出事件及 CSS hover 清理：**失败**。
- 跨边界持键拖动、显式捕获与释放：**失败**。
- 主/子文档滚动及 125% 缩放后的坐标一致性：**通过**。
- 可信输入、真实系统光标和前台窗口稳定性：**通过**。

边界事件缺口：cross exit 缺少 `mouseout`、`mouseleave`、`pointerout`、`pointerleave`。

这次报告中的两个 iframe 最终 CSS `:hover` 均已清空；不能把退出事件缺失描述成 CSS hover 残留。

拖动缺口（explicit-OOPIF-capture-drag）：捕获后的移动改投其他文档 9 次；捕获/释放不完整 1 次。原 OOPIF 捕获/释放观察：`{"got": false, "lost": false, "stillActive": false, "receivedMouseup": false}`。按下后/下一步移动的 hasPointerCapture 分别为 `true` / `false`。

实际运行版本：Electron `45.0.0-beta.5`、Chromium `156.0.8078.36`、Node ABI `150`。可执行文件 SHA-256：`6e0844ec5fd9bf77b0010c9c1aacfcfea93fb2b1539de2a4be9b1dd5cddf250d`。

独立报告：`D:/electron/edist-publish/automation-release-45.0.0-cloudbypass.8/cross-frame-results.json`。同一测试的完整事件、采样及失败明细保留在报告中；真实硬件指针、触摸笔、其他 DPI 或更复杂嵌套结构不由这五项自动外推。

<!-- cloudbypass.9-continuity-start -->
## 跨 frame 光标连续性修复（Windows .9）

本节记录 `.9` 首次发布构建（可执行文件摘要 `b8f007...`），同版本证书拖动补充另见下一节；前文 `.8` 及更早内容保留为历史证据。**该构建实际七项全部通过，`meetsFullCrossFrameContinuity: true`；在下列七项覆盖范围内达到完整跨 frame 光标连续性。** 核心四组通过数与跨 frame 七项分别统计。

### 兼容方式与内部修复

保持 `.8` 定制方法名称、参数、可选配置和返回结构不变。`setAutomationOptions`、`getAutomationState`、`resetAutomationOptions`、输入/点击及输入序列方法继续使用现有调用方式，`setVirtualCursorImage` 和 `setVirtualCursorFrameRate` 保留；无新增必需配置。公开类型摘要与 `.8` 相同，使用方无需修改现有调用。

鼠标事件经过 Chromium 原生跨 frame 路由管理进入/离开和捕获。移动事件依据实际按住按钮构造底层 `button` 与 modifiers，按下/释放保留其它仍按住的按钮。目标引用继续执行原有文档与节点有效性检查；捕获期间移动和释放遵循原生捕获目标，释放后恢复命中路由。虚拟光标的显示位置仍跟随实际自动化指针位置。

按下和抬起等待实际目标确认，使下一次投递使用更新后的捕获状态；序列移动在入队后继续，保持原有高频投递能力。浏览器内部确认标识区分重复公开时间戳，不改变公开事件时间。OOPIF 元素查询在跨视图变换前后正确换算物理像素与 DIP，使根视口 CSS 坐标与滚动、缩放后的实际输入位置一致。

### 本次运行证据

实际测试时间：2026-11-05 02:30:42 UTC+08:00。分发目标 `45.0.0-cloudbypass.9`；运行内核 Electron `45.0.0-beta.5`、Chromium `156.0.8078.36`、Node `24.22.0`、Node ABI `150`。

可执行文件 SHA-256：`b8f007624ec65f757eca20ca99e22a9af4aea923618875e58161924f1495136b`。

公开 `electron.d.ts` SHA-256：`e622d6eacb9b824210591a52b512bff3ba83e40a3cf66aa0d196914f46c1bf41`，与 `.8` 完全相同。

核心四组：automation-options **10/10**；input-sequence **25/25**；agent **11/11**；click **9/9**，合计 **55/55**；公开类型生成与相关 TypeScript 检查通过。独立跨 frame 为 **7 通过、0 失败、0 无法判定**。

1. **通过**：主文档、同进程 iframe、OOPIF 连续移动与虚拟光标位置（实际用例：`continuous main/same-process/OOPIF root-viewport movement and virtual cursor position`）。
2. **通过**：两个 iframe 的进入/离开事件与 CSS hover 清理（实际用例：`both iframe documents receive entry and exit events and release CSS hover`）。
3. **通过**：跨 frame 按住拖拽、显式捕获及 mouseup 清理（实际用例：`held-button drag across frame borders preserves buttons, explicit capture and mouseup cleanup`）。
4. **通过**：position/target 捕获、多键操作与快速连续派发（实际用例：`raw and target input preserve capture through release, chorded buttons and rapid queued dispatch`）。
5. **通过**：iframe 导航、移除和完整重置后的捕获清理及后续输入（实际用例：`frame navigation, removal and reset clear invalid capture and allow subsequent input`）。
6. **通过**：主文档/子文档滚动、125% 缩放后的 CSS/client/page/screen 坐标（实际用例：`CSS viewport/client/page/screen coordinates agree after root/child scrolling and 125 percent zoom`）。
7. **通过**：可信事件、真实系统光标与前台窗口稳定性（实际用例：`all observed input is trusted and automation leaves the system pointer and foreground unchanged`）。

本次实际进程拓扑：main：OS PID `1724116`、Chromium processId `4`、routingId `1`；same：OS PID `1724116`、Chromium processId `4`、routingId `4`；cross：OS PID `1725180`、Chromium processId `5`、routingId `6`。

核心配置报告单列的真实光标采样原值如下；若包含 `inconclusive_concurrent_system_input`，仅表示该采样受并发系统输入影响未能判定，不能扩写为采样通过。独立跨 frame 第七项按自身事件、真实光标和前台记录判断，与核心采样分开。

- `{"status":"passed","before":{"lastInputTick":296642453,"lastInputTickBeforeCursor":296642453,"cursor":{"x":1536,"y":864},"coherentSnapshot":true,"coordinateSpace":"GetCursorPos"},"after":{"lastInputTick":296642453,"lastInputTickBeforeCursor":296642453,"cursor":{"x":1536,"y":864},"coherentSnapshot":true,"coordinateSpace":"GetCursorPos"}}`

本次核心与独立报告位于 `D:/electron/edist-publish/automation-release-45.0.0-cloudbypass.9`；跨 frame 报告 SHA-256 为 `e803e7aff31493fda977090dd6af2a043a8287110bb29108817e419dea96c2ee`。完整事件、轨迹、坐标、捕获和清理数据以实际 JSON 为准；发行附件应收录本次记录。

### 修复前历史与适用范围

修复前 `.8` 的独立五项记录仍为 **3 通过、2 失败、0 无法判定**，`meetsFullCrossFrameContinuity: false`。该历史构建缺少 OOPIF 的退出事件，显式捕获未形成完整捕获/释放流程；历史可执行文件摘要为 `6e0844ec5fd9bf77b0010c9c1aacfcfea93fb2b1539de2a4be9b1dd5cddf250d`，报告见 `D:/electron/edist-publish/automation-release-45.0.0-cloudbypass.8/cross-frame-results.json`。这些旧计数不用于证明 `.9`，其原始文档和报告不覆盖、不改写。

本次结论覆盖 Windows x64 上同一 WebContents 的主文档、同进程 iframe、跨域 OOPIF，以及以上七项实际场景。尚未验证的硬件、其它系统/DPI、任意复杂嵌套、系统休眠及渲染进程/GPU 故障不由这些结果自动外推。页面可以观察事件、焦点和操作时序，本功能不承诺网页绝对无法识别自动化。发行包、安装、源码发布和下载核验分别以 manifest 与对应报告记录，本节本身不表示这些发布步骤已完成。
<!-- cloudbypass.9-continuity-end -->

## 证书查看器拖动补充（Windows .9 同版本覆盖）

2026-11-05 的补充仅启用 `WebDialogView` 自身标题栏拖动；保留独立桌面 HWND、来源窗口的 parent/owner、非模态行为和导航/销毁关闭逻辑，不改变定制方法或公开类型。

当前可执行文件 SHA-256：`714ba8c41bb56f1ae05257d8170b41dc3c5869d9694c5ebf49c74e13b8e5cc19`。实际运行版本仍为 Electron `45.0.0-beta.5`、Chromium `156.0.8078.36`、Node `24.22.0`、ABI `150`；公开类型摘要仍为 `e622d6eacb9b824210591a52b512bff3ba83e40a3cf66aa0d196914f46c1bf41`。

同一冻结测试分别运行于首次 `.9` 和修正版：基线 **15/18**，三个失败均为查看器自身标题没有 `HTCAPTION`；修正版 **18/18**。覆盖有框 BrowserWindow、无框 BrowserWindow、无框 BaseWindow + WebContentsView，使用网站信息公开入口真实点击打开证书，再执行来源与查看器的真实标题栏拖动，核对原生坐标、owner、中文标题、渲染隔离、缩放/最大化/还原、最小化/层级和导航/销毁关闭。

来源拖动时查看器保持原位，在基线和修正版中都成立；原反馈“随来源窗口移动”尚未复现，不能把本次标题栏修正描述成该现象的根因修复。仅有一块 175% 缩放显示器，跨屏与混合 DPI 明确未覆盖；DevTools 的系统证书对话框属于另一实现。本次未重复执行历史核心 55 项和跨 frame 7 项，历史报告仍绑定原可执行文件。实际运行报告及对应源码随 `certificate-window-reports.zip` 提供；安装和发布另见当前 manifest。
