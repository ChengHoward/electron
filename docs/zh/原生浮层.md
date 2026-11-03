# 原生浮层与网站信息

日期：2026-11-04。状态：**编译与验收通过**。Windows x64 发行版本：[`45.0.0-cloudbypass.5`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.5)。

本文说明本轮 Electron 定制的接口、原生实现和验收边界。历史发行包不因此自动具备这些能力；获取新二进制后，应同时核对构建标识、匹配的类型文件和运行时能力。

## 1. 范围与平台

本轮新增七个公开入口：`webContents.showPageInfoDialog`、`new NativePanel`、`NativePanel.isSupported`、`panel.show`、`panel.update`、`panel.hide` 和 `panel.destroy`。`action`、`dismissed`、`closed` 沿用 EventEmitter 事件。

本轮发行平台为 **Windows x64**。`NativePanel.isSupported()` 检查实际运行时与平台，其余平台返回 `false`。网站信息使用同一原生面板实现，不支持的平台返回 `false`。非法参数、已销毁的页面和无有效宿主仍报告明确错误，不以“不支持”掩盖调用错误。

界面由浏览器主进程中的 Chromium Views 原生控件绘制。面板不创建 `WebContents`、网页渲染进程、DOM 或 CSS 文档，能覆盖所属窗口的 `WebContentsView`，并能伸出父窗口。树描述是控件数据，不能直接传入 HTML、Vue DOM 或 CSS。

普通操作菜单继续使用已有 `Menu.buildFromTemplate`、`Menu.popup` 和 `Menu.closePopup`。已有 `View.setBorderRadius`、`WebContentsView` 跨窗移动、虚拟光标和 `dispatchInputSequence` 不变。

## 2. 网站信息

```text
webContents.showPageInfoDialog({
  anchorBounds: { x, y, width, height },
  siteUrl?: string
}): boolean
```

`anchorBounds` 是触发按钮的**屏幕 DIP** 矩形，坐标必须有限，宽高必须大于零。屏幕 DIP 不是物理像素，也不是父窗口内的 CSS 坐标。调用方负责根据界面缩放和窗口内容区原点计算坐标，不能重复乘系统缩放因子。

`siteUrl` 可省略。显示内容始终来自当前已提交文档；传入 `siteUrl` 时只用于校验，必须是绝对 URL，且与已提交主文档的来源相同。不透明来源不能通过两个字符串都为 `null` 的方式判为同源。面板不会把调用方传入的地址当成真实安全信息。

返回 `true` 表示已创建并请求显示面板，平台不支持时返回 `false`。没有已提交导航的页面不提供网站信息。每个页面只保留一个网站信息面板，再次打开会释放旧实例。

### 2.1 真实连接与证书

内部 `_getPageInfo(includePermissions?)` 从 `NavigationController` 的 **last committed entry** 读取 URL、`SSLStatus`、TLS 协议、密码套件和证书；返回文档 token、导航项 id 与真实宿主窗口 id，用于核对目标是否仍然有效。它不是稳定的公开 API。

安全状态区分已验证的加密连接、HTTP、证书错误、混合内容、过时 TLS、错误文档与缺少连接信息。仅有 `https:` 字符串、合成响应或尚未提交的目标 URL，不能证明连接安全。证书摘要包括主体、颁发者、有效期和 SHA-256 指纹。

读取旧已提交文档时，不借用待提交目的地的证书。主文档导航开始、同 URL 重新加载、同文档导航、页面销毁或跨窗转移会使旧面板失效。可见安全状态变化也会关闭旧面板，避免动态混合内容出现后仍保留旧的安全结论。

### 2.2 已接入权限与网站设置

只在 Session 已设置 `permissionCheckHandler` 时，读取 `ElectronPermissionManager` 对当前主文档的预授权检查。目前包括定位、麦克风、摄像头、通知、剪贴板读取和 MIDI SysEx。

检查返回 `true` 表示该次应用检查允许，不能等同于永久授权或操作系统权限已开启；返回 `false` 只表示**尚未预先允许，申请时仍由应用决定**，不能显示成永久拒绝。没有检查处理器时，说明权限由应用在请求时处理，不把 Electron 的默认检查返回值冒充持久化站点设置。

本轮不建立 Chrome `Profile` 或 Chrome 站点设置数据库，也不在面板内部写入永久许可。点击“Website settings”按钮时发出：

```js @ts-type={contents:Electron.WebContents}
contents.on('page-info-open-site-settings', (event, details) => {
  // details.url：已提交的真实 URL；details.origin：已提交文档的来源。
  // 由宿主打开自己的站点设置，并调用既有权限管理逻辑。
})
```

发出事件前再次核对文档 token、导航项、URL 和宿主。已经关闭、导航或移窗的面板不能通过迟到动作操作新页面。权限检查处理器属于宿主 JavaScript，可能重入导航、销毁或转移；读取过程中发生这些变化时会报错，丢弃不一致的快照。

## 3. 创建 NativePanel

```js
const { app, BaseWindow, NativePanel } = require('electron')

app.whenReady().then(() => {
  const parent = new BaseWindow({ width: 900, height: 650 })
  if (!NativePanel.isSupported()) return

  const panel = new NativePanel({
    parent,
    // sourceWebContents: contents, // 可选；必须属于 parent。
    content: {
      type: 'column',
      id: 'root',
      width: 320,
      padding: 12,
      gap: 8,
      children: [
        { type: 'text', id: 'status', text: '正在运行' },
        { type: 'button', id: 'pause', text: '暂停' }
      ]
    },
    theme: 'system',
    radius: 12,
    shadow: true,
    focusMode: 'menu',
    dismissOnOutsideClick: true,
    dismissOnEscape: true
  })

  panel.on('action', (action) => {
    if (action.id === 'pause' && action.type === 'click') {
      // 只有此处显式调用业务控制器，才执行暂停。
    }
  })
  panel.on('closed', () => {
    // 清理宿主持有的引用。
  })
  panel.show({ anchorBounds: { x: 400, y: 120, width: 28, height: 28 } })
})
```

构造只能在 `app` ready 后调用。`parent` 必填，必须是有效的 `BaseWindow` 或 `BrowserWindow`；实例不能在生命周期中更换父窗口。可选 `sourceWebContents` 必须是属于该父窗口的有效页面，绑定后主文档导航、重载、页面销毁、渲染进程丢失或宿主转移会销毁面板。需要操作新文档时重新创建实例。

`focusMode` 为 `none`、`menu` 或 `input`，默认 `menu`。`none` 用于不激活窗口的提示；`menu` 启用菜单式键盘导航；`input` 用于文本输入和原生输入法。外部点击和 Esc 关闭默认开启，IME 组合输入优先处理 Esc。

## 4. 控件树 schema

所有节点必须具有稳定、非空且全树唯一的 `id` 和有效 `type`。公共属性为 `disabled`、`visible`、`width`、`height`、`flex` 和 `tooltip`。布局和尺寸使用 DIP。

- `row`、`column`：必须提供有序 `children`，可设置 `gap`、`padding`；分别进行横向和纵向布局。
- `list`：原生滚动列表，必须提供 `children`，可设置 `gap`、`padding`；默认高度为 240 DIP。
- `text`：必须提供 `text`，可设置 `muted`、`fontSize`。
- `icon`：必须提供非空 `NativeImage` 类型的 `image`，不能传图片 URL 或 CSS 图标。
- `button`：必须提供 `text`，点击回传 `click`。
- `toggle`：必须提供 `text` 和布尔值 `checked`，切换回传 `change`。
- `input`：单行输入，可设置 `value`、`placeholder`、整数 `maxLength`；编辑回传 `change`，Enter 提交回传 `submit`。
- `option`：必须提供 `items`；每项包含唯一 `id`、`label`，可设置字符串 `value` 和 `disabled`。项值默认使用项 id；控件 `value` 指定当前项，选择回传 `change`。
- `separator`：分隔线，没有专属属性。
- `progress`：必须提供 `value`，取值为 0 至 1；`-1` 表示不确定进度。

根节点默认首选宽度为 320 DIP。树最多 2,000 个节点，最大嵌套深度为 32，id 最长 256 字符。重复 id、未知字段、类型不匹配、非法数值与不适用于该节点的属性会被拒绝。

更新时传入完整的新树，同时保留仍代表同一控件的 id 和 type。稳定控件应保留焦点、未提交输入和滚动位置；明确改变控件值才更新其值。更换 id 或 type 表示替换对应控件。

## 5. 主题

`theme` 可直接使用 `system`、`light`、`dark`，或使用对象：

```ts
type NativePanelTheme = {
  mode?: 'system' | 'light' | 'dark'
  background?: string
  text?: string
  muted?: string
  accent?: string
  border?: string
  fontFamily?: string
  fontSize?: number
}
```

颜色使用 `#RRGGBB` 或 `#AARRGGBB`；字体大小为 6 至 96 DIP。未指定字段使用所选原生主题默认值，不支持 CSS 选择器、任意样式声明或颜色名称。默认圆角为 12 DIP，阴影默认开启。主题和圆角更新复用原生面板，不为主题变化创建新的网页渲染器。

## 6. 显示、更新、隐藏和销毁

```text
NativePanel.isSupported(): boolean

panel.show({
  anchorBounds: { x, y, width, height },
  placement?: 'auto' | 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
}): void

panel.update({
  content?: NativePanelContent,
  anchorBounds?: { x, y, width, height },
  theme?: NativePanelTheme | 'system' | 'light' | 'dark',
  radius?: number,
  shadow?: boolean
}): void

panel.hide(): void
panel.destroy(): void
```

`show` 显示或复用实例。锚点采用屏幕 DIP，空间不足时翻转、贴边并限制高度，内容通过原生滚动访问。父窗口移动会带动锚点；触发按钮在窗口内移动或界面 zoom 改变时，宿主用 `update` 提交新矩形。

`update` 只提交需要改变的顶层字段；`content` 是完整替换的控件描述，`theme` 是本次主题配置。先校验完整 patch，再修改原生状态；校验失败不会仅应用其中一部分。内容和主题更新不重建整个面板。

`hide` 结束当前交互、隐藏面板并按当前前台状态恢复有效焦点，保留实例以供下次 `show`。程序调用 `hide` 不发出 `dismissed`。隐藏后释放外部点击监听，不保留无用途的全局鼠标监控。

`destroy` 释放原生窗口、控件和监听，重复调用安全，只发出一次 `closed`。销毁后的实例不能再次 `show` 或 `update`。父窗口销毁会自动销毁从属面板。面板不单独进入任务栏或 Alt+Tab 列表；父窗口隐藏或最小化时收起。

## 7. 事件和输入隔离

```ts
declare const panel: Electron.NativePanel

panel.on('action', (action: { id: string; type: 'click' | 'change' | 'submit'; value?: string | boolean }) => {})

panel.on('dismissed', (details: { reason: 'outside-click' | 'escape' | 'blur' | 'parent-hidden' }) => {})

panel.on('closed', () => {})
```

这些事件不额外传递 Electron `event` 参数。`action` 只回传控件 id、动作和值，实际业务由宿主执行。`dismissed` 表示交互收起，实例可复用；`closed` 表示实例已经释放。

打开、鼠标进入、搜索输入、主题变化、失焦、隐藏或关闭面板，都不会隐式请求人工接管，也不会调用页面的 pause、abort、reload 或 transfer。面板不捕获或隐藏底层网页，网页视频、动画和既有 Agent 输入链继续使用原文档。

面板原生输入与网页定向输入分别路由；现有虚拟光标、`dispatchInputSequence` 与真实指针/键盘输入保护保持原有策略。恢复焦点不解除输入保护。圆角、透明角部和阴影的命中由原生浮层内部处理，不设置整个主窗口穿透，不重放点击来模拟穿透。

## 8. 实现入口

- `lib/browser/api/native-panel.ts`：公开类、schema 校验、主题、页面和窗口生命周期。
- `shell/browser/api/electron_api_native_panel.{h,cc}`：原生绑定、完整 patch 解析、事件桥接。
- `shell/browser/ui/views/native_panel.{h,cc}`：Windows Views 窗口、布局和控件、稳定 id 更新、滚动、焦点、IME、命中与关闭。
- `lib/browser/api/web-contents.ts`：`showPageInfoDialog`、网站信息控件树、来源校验和网站设置事件。
- `shell/browser/api/electron_api_web_contents.{h,cc}`：已提交文档的安全快照、宿主 id、移窗和安全状态失效通知。
- `lib/browser/api/module-list.ts`、`shell/common/node_bindings.cc`、`filenames.gni`：模块导出、原生注册和构建入口。
- `docs/api/native-panel.md`、`docs/api/structures/native-panel-*.md`、`docs/api/web-contents.md` 与生成的 `electron.d.ts`：公开接口和类型。

## 9. 本轮未增加的可选接口

本轮没有增加 `BrowserWindow.isInputShapeSupported()`、`win.setInputShape(rects)` 和 `webContents.setPageCapturePaintLeaseEnabled(enabled)`。浮层圆角命中由 NativePanel 内部处理；普通面板不依赖后台持续捕获租约。既有 `setShape` 会同时影响绘制，不能当作独立的输入命中区域接口。

## 10. 验收状态和边界

本次 Windows x64 `45.0.0-cloudbypass.5` **编译与验收通过**。本地镜像已提供该版本，实际 npm 安装、运行和公开类型检查通过。下方结论对应本次最终可执行文件与 ZIP，不扩展到历史发行包或其他平台。

已完成的静态检查包括浏览器侧 TypeScript、目标脚本 lint、C++ 格式与差异检查。网站信息的脚本生命周期模拟已覆盖非法参数、来源不符、导航、移窗、安全状态变化、关闭后的迟到动作、替换旧面板、权限查询重入与监听清理；这不能替代真实原生窗口验证。

### 2026-11-04 发行验收记录

- 平台：Windows x64；二进制内部上游版本为 `45.0.0-beta.5`，分发版本为 `45.0.0-cloudbypass.5`，两者不能混用。
- 最终可执行文件 SHA-256：`f90012a6148b748301b3ba79b50bbe8d89feafd0085c87d98bff3947d5c82dbd`。从本地镜像实际安装得到的可执行文件校验和与此一致。
- Windows x64 ZIP SHA-256：`bf86a89be1a2578ea30fbf48d2f34082dd31938acda0cbc98b67f688c90c9ece`。ZIP 与可执行文件是不同产物，校验和不能互换。
- GN 六个构建目标全部通过。原生面板主验收 **35/35**，PageInfo 文档身份和重入边界补测 **7/7**，合计 **42/42**，并使用最终二进制再次独立复验通过。
- 既有 Agent **11/11**、输入 **26/26**、clickSelector **9/9**，共 **46/46** 回归通过；与本次原生浮层验收合计 **88/88**。输入像素测试补充了 HWND/PID 前置验证，该测试修订未改动业务内核。
- 实测环境为单显示器、175% 缩放。执行了物理鼠标键盘交互，并使用 Microsoft Pinyin 真实组合输入提交“你好”；该结果不是仅注入 Unicode 字符或脚本模拟。
- 验收涵盖覆盖网页与窗口外显示、网页持续重绘、无新增面板 WebContents、稳定控件更新、焦点与滚动保留、圆角和阴影命中、页面导航/重载/移窗失效、权限检查重入、迟到动作及资源释放。
- 本次重新生成 light、dark、option-open、page-info 四张截图，均对应上述最终可执行文件 SHA-256。
- 从 `127.0.0.1:8787` 的本地镜像安装 `45.0.0-cloudbypass.5` npm 包后，实际运行 smoke 与公开类型检查均通过。发行版本见本文开头的链接；校验与运行结论以对应产物及原始报告为准。

### 尚未实测的设备与交互

混合 DPI、多显示器、触控笔、触控板惯性滚动和读屏语音均未实测。中文输入法的实测只覆盖上述 Microsoft Pinyin 环境，不能推断所有输入法、候选窗口和设备组合均已验证。其他平台没有本次 `.5` 二进制；Linux 仍为已有 `.2`，不据 Windows 结果认定支持原生面板。
