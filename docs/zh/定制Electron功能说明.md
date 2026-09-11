# CloudBypass Electron 定制功能说明

| 项 | 内容 |
|----|------|
| 文档版本 | 1.2 |
| 更新日期 | 2026-09-11 |
| 基线分支 | `43-x-y`（Chromium `150.0.7871.129`） |
| 源码仓库 | [ChengHoward/electron](https://github.com/ChengHoward/electron) |
| 参考提交 | 见 [定制变更简述.md](./定制变更简述.md) 最近条目 |

本文档描述相对上游 Electron 的**定制 API、行为差异、Chromium 补丁与源码位置**，面向使用方与二次编译维护者。

变更流水账见 [定制变更简述.md](./定制变更简述.md) / [定制变更详细.md](./定制变更详细.md)。私有 npm / 二进制镜像见下文 **§7.2** 与 [私有镜像.md](./私有镜像.md)。

---

## 1. 概述

本 fork 在上游 Electron 之上增强以下能力，目标是**在不依赖 `webContents.debugger` 的前提下，贴近 Chrome DevTools Protocol（CDP）的实用行为**，并补充指纹 / 网络相关能力：

1. **User-Agent / Client Hints 覆盖** — 对齐 CDP `Emulation.setUserAgentOverride`（含请求头、跨域 iframe、`navigator.platform`、`Sec-CH-UA-*`）
2. **可信输入** — 新增 `dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent` / `cancelDragging`，对齐 CDP `Input.*`（无需 debugger）
3. **隐藏 `window.chrome`** — 经 `setUserAgent(ua, { hideChrome: true })` 控制网页主世界是否暴露该对象（可运行时切换）
4. **穿 closed shadow 的 DOM 自动化** — `querySelectorDeep` / `getNodeBoxModel` / `clickSelector`（Blink C++，无 attach）
5. **`session.fetch` / `net.fetch` 请求头保序** — 绕过 WHATWG `Headers` 字母序；可选 `headerOrder` 强制线上顺序

| 能力 | 上游 Electron | 本定制 |
|------|---------------|--------|
| `session` / `webContents.setUserAgent` 改请求头 | 不完整，跨域 iframe 易不一致 | 浏览器侧强制改写 + NavigationEntry 继承 |
| 跨域 OOPIF 的 `navigator.userAgent` | 常忽略覆盖 | Chromium 补丁修复 |
| `navigator.platform` / `userAgentData` / `Sec-CH-UA-*` | 不支持经 `setUserAgent` 配置 | 支持 CDP 风格 options；可用 `null` 关闭 CH |
| 可信输入（`isTrusted === true`）且参数同 CDP | 需 debugger，或用不兼容的 `sendInputEvent` | `dispatchMouseEvent` / `dispatchKeyEvent` / `dispatchTouchEvent`，无需 attach |
| 隐藏网页 `window.chrome` | 无 | `setUserAgent(ua, { hideChrome: true })` |
| 穿 closed shadow 的元素查找 / 盒模型 / 点击 | 需 debugger CDP DOM，或页面 JS（穿不了 closed） | `querySelectorDeep` / `getNodeBoxModel` / `clickSelector`，Blink C++，无 attach |
| `ses.fetch` / `net.fetch` 自定义请求头顺序 | 经 `Request`→`Headers` 后按名字字节序发出 | 保插入序；可选 `headerOrder` 强制顺序 |

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
| 按选择器可信点击 | `contents.clickSelector(selector[, options])` | **新增 API** |
| fetch 请求头保序 / 强制顺序 | `ses.fetch` / `net.fetch` 的 `headerOrder` | **增强既有 API** |
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

```js
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
  hideChrome: true,
})
```

### 3.2 `contents.setUserAgent(userAgent[, options])`

- **模块**：`webContents`（及 `<webview>` 对应接口）
- **作用域**：当前页面；`options` 形态与 session 相同（第二参为对象时不支持「仅字符串 Accept-Language」以外的 session 旧习惯——字符串仍可解析为 acceptLanguage）

行为与 session 路径共用同一套应用逻辑（NavigationEntry 标记、`override_in_new_tabs`、metadata / platform、`SyncRendererPrefs`）。

### 3.3 `contents.dispatchMouseEvent(mouseEvent)`

- **返回**：`Promise<void>`
- **对齐**：CDP `Input.dispatchMouseEvent`
- **无需** `webContents.debugger.attach()`

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | `mousePressed` \| `mouseReleased` \| `mouseMoved` \| `mouseWheel` |
| `x` | `number` | 相对主框视口的 CSS 像素 X |
| `y` | `number` | 相对主框视口的 CSS 像素 Y |
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

```js
await win.webContents.dispatchMouseEvent({
  type: 'mousePressed',
  x: 100,
  y: 200,
  button: 'left',
  clickCount: 1
})
await win.webContents.dispatchMouseEvent({
  type: 'mouseReleased',
  x: 100,
  y: 200,
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
| 参数风格 | CDP | CDP | Electron 自有 | DOM |

### 3.4 `contents.dispatchKeyEvent(keyEvent)`

- **返回**：`Promise<void>`
- **对齐**：CDP `Input.dispatchKeyEvent`
- **无需** `webContents.debugger.attach()`
- 投递到**焦点** RenderWidget（`GetFocusedRenderWidgetHost`）

主要字段：`type`（`keyDown` / `keyUp` / `rawKeyDown` / `char`）、`modifiers`、`text` / `unmodifiedText`、`code` / `key`、`windowsVirtualKeyCode`、`commands` 等（同 CDP，均为选配除 `type`）。

```js
await win.webContents.dispatchKeyEvent({
  type: 'keyDown', key: 'a', code: 'KeyA',
  windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a'
})
await win.webContents.dispatchKeyEvent({
  type: 'char', key: 'a', code: 'KeyA',
  windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a'
})
await win.webContents.dispatchKeyEvent({
  type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65
})
```

> 插入任意文本仍可用既有 `contents.insertText(text)`（渲染进程 IME CommitText），语义接近 CDP `Input.insertText`。

### 3.5 `contents.dispatchTouchEvent(touchEvent)`

- **返回**：`Promise<void>`
- **对齐**：CDP `Input.dispatchTouchEvent`（WebTouch + TouchEmulator 注入路径）
- 序列须以 `touchStart` 开始；`touchStart`/`touchMove` 的 `touchPoints` 非空；`touchCancel` 须为空数组

```js
await win.webContents.dispatchTouchEvent({
  type: 'touchStart', touchPoints: [{ x: 100, y: 200 }]
})
await win.webContents.dispatchTouchEvent({
  type: 'touchEnd', touchPoints: [{ x: 100, y: 200 }]
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

```js
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

```js
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

```js
const el = await win.webContents.querySelectorDeep('my-button >>> #submit')
if (el) {
  await win.webContents.dispatchMouseEvent({
    type: 'mousePressed',
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
    button: 'left',
    clickCount: 1
  })
  await win.webContents.dispatchMouseEvent({
    type: 'mouseReleased',
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
    button: 'left',
    clickCount: 1
  })
}
```

### 3.10 `contents.getNodeBoxModel(backendNodeId[, options])`

- **返回**：`Promise<DomBoxModel | null>`（节点已失效则为 `null`）
- **`backendNodeId`**：来自 `querySelectorDeep` 或 CDP DOM
- 坐标同样为相对主框视口的 CSS 像素

### 3.11 `contents.clickSelector(selector[, options])`

- **返回**：`Promise<void>`
- **作用**：按与 `querySelectorDeep` 相同规则查找元素，在中心点派发可信 press+release（同 `dispatchMouseEvent` 管线）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pierce` | `boolean` | `true` | 穿 shadow |
| `scrollIntoView` | `boolean` | `true` | 点击前滚入视口 |
| `button` | `string` | `left` | 鼠标键 |
| `clickCount` | `number` | `1` | 点击次数 |
| `modifiers` | `number` | `0` | Alt=1, Ctrl=2, Meta=4, Shift=8 |

```js
await win.webContents.clickSelector('#login', { pierce: true })
await win.webContents.clickSelector('x-card >>> button.primary')
```

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

坐标相对**主框视口** CSS 像素，并按 zoom / page scale 换算；通过 `GetRenderWidgetHostAtPointAsynchronously` 路由到含 OOPIF 在内的正确 widget。

### 4.5 `querySelectorDeep` / `clickSelector` 与页面 JS 的差异

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
| `filenames.gni` | 登记新源文件 |
| `docs/api/session.md` / `net.md` / `web-contents.md` | API 文档 |
| `docs/api/structures/user-agent-*.md` / `dom-*.md` / `*-selector-*.md` | 结构体文档 |
| `spec/api-session-spec.ts` / `api-web-contents-spec.ts` | 规格测试 |

上游 API 文档路径（随源码）：`src/electron/docs/api/`。

### 6.1 已讨论、尚未落地

| 能力 | 状态 | 备注 |
|------|------|------|
| `loadURL(url, { responseOverride })` | **搁置** | 导航到指定 URL、主文档返回指定正文；推荐 per-WC/导航在 `ProxyingURLLoaderFactory` 挂接，避免 Session 级 `protocol.handle` 影响其它 WC |
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
| 公网域名 | `https://electron.cloudbypass.com` |
| npm registry | `https://electron.cloudbypass.com/npm/` |
| 包名 | `electron` |
| 当前示例版本 | `41.0.0-cloudbypass.2`（以镜像实际发布为准） |
| 本机服务目录 | 仓库旁 `mirror/`（默认端口 `8787`） |

安装时有两段下载，都须指向本镜像：

1. **npm 包**（`package.json` / tarball / registry）
2. **二进制 zip**（`postinstall` 里 `@electron/get` 按 `electron_mirror` 拼接 URL）

#### URL 约定

| 用途 | URL |
|------|-----|
| 健康检查 | `https://electron.cloudbypass.com/healthz` |
| npm 元数据 | `https://electron.cloudbypass.com/npm/electron` |
| npm tarball | `https://electron.cloudbypass.com/npm/electron/-/electron-{version}.tgz` |
| 二进制 | `https://electron.cloudbypass.com/v{version}/electron-v{version}-{platform}-{arch}.zip` |
| 校验和 | `https://electron.cloudbypass.com/v{version}/SHASUMS256.txt` |

`@electron/get` 实际 URL：

```text
{electron_mirror}{electron_custom_dir}/{filename}
```

例如：`https://electron.cloudbypass.com/v41.0.0-cloudbypass.2/electron-v41.0.0-cloudbypass.2-win32-x64.zip`

#### 业务项目配置（推荐）

**1. 项目根目录 `.npmrc`**

```ini
# 普通依赖仍走官方 npm
registry=https://registry.npmjs.org/

# Electron 二进制镜像（@electron/get / install.js）
electron_mirror=https://electron.cloudbypass.com/
electron_custom_dir=v{{ version }}

# 定制构建校验和与官方不同，必须用远端 SHASUMS256.txt
electron_use_remote_checksums=1
```

也可等价设置环境变量（Yarn v1 / npm 均可读）：

```powershell
$env:ELECTRON_MIRROR="https://electron.cloudbypass.com/"
$env:ELECTRON_CUSTOM_DIR="v{{ version }}"
$env:ELECTRON_USE_REMOTE_CHECKSUMS="1"
```

**2. `package.json` 依赖版本**

版本号须与镜像已发布版本一致：

```json
{
  "devDependencies": {
    "electron": "41.0.0-cloudbypass.2"
  }
}
```

**3. 安装（仅 electron 走私有 registry）**

```bash
yarn add electron@41.0.0-cloudbypass.2 --registry https://electron.cloudbypass.com/npm/
```

不要把全局 `registry` 永久改成镜像，以免其它依赖解析失败。

#### 可选：直接依赖 tarball

不经过 registry 元数据，适合 CI 锁死 URL：

```json
{
  "devDependencies": {
    "electron": "https://electron.cloudbypass.com/npm/electron/-/electron-41.0.0-cloudbypass.1.tgz"
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
YARN_NPM_REGISTRY_SERVER=https://electron.cloudbypass.com/npm/ yarn add electron@41.0.0-cloudbypass.1
```

`electron_mirror` / `electron_use_remote_checksums` 仍需通过 `.npmrc` 或环境变量提供（Electron 的 install 脚本读的是 npm config / env）。

#### 镜像侧运维（维护者）

```powershell
cd <repo>/mirror
.\run.ps1 -Publish       # 从 out/Release/dist.zip 发布 npm + 二进制
.\run.ps1 -SetupTunnel   # 首次绑定 electron.cloudbypass.com
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
8. `querySelectorDeep('host >>> #inner')` 能命中 closed shadow 内节点；`clickSelector` 触发的点击 `isTrusted === true`
9. `ses.fetch(url, { headers, headerOrder })`：TLS/HTTP 回显（如 peet.ws）中自定义头顺序与 `headerOrder` 一致；对象键故意打乱时仍以 `headerOrder` 为准

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
| `src/electron/docs/api/web-contents.md` | 含 CDP 输入与 `querySelectorDeep` / `clickSelector` 等 |
| `src/electron/docs/api/session.md` / `net.md` | 含 `headerOrder` |
| `src/electron/docs/api/structures/user-agent-*.md` | options / metadata 结构 |
| `src/electron/docs/api/structures/dom-*.md` 等 | DOM 自动化结构体 |
