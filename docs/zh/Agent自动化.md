# 无需 CDP 的 Agent 自动化

本说明对应 Windows x64 定制分发版本 `45.0.0-cloudbypass.4`，包含原生 Agent、clickSelector 修复、批量输入和虚拟光标。二进制内部上游版本仍为 `45.0.0-beta.5`；此前发布版本不据此认定支持，Linux 本次未编译验证。

## API 范围

新增 `webContents.getAgentSnapshot(options)` 和 `findAgentElements(query, options)`；增强 `dispatchMouseEvent`、`dispatchKeyEvent`、`dispatchTouchEvent`、`clickSelector`、`querySelectorAcrossDocuments`，共涉及七个公开方法。此外新增 `setVirtualCursorEnabled`、`setVirtualCursorImage`、`setVirtualCursorFrameRate`、`dispatchInputSequence` 四个公开方法，参数、资源边界及验收记录见本文后半部分。内部通信方法不属于公开 API。

读取通过浏览器进程枚举当前页面的框架，再经原生 Mojo 接口进入每个框架的 Blink DOM 和可访问性对象。支持主文档、同源 iframe、跨域 OOPIF，以及开放和封闭的作者 Shadow DOM。不连接 debugger、不执行页面 JavaScript 来实现自动化，不要求远程调试端口。

## 页面快照

```js
const snapshot = await win.webContents.getAgentSnapshot({
  maxNodes: 1000,
  maxFrames: 100,
  timeoutMs: 5000,
  pierce: true
});
```

返回 `elements`、`frames`、`complete`、`truncated` 和 `truncationReasons`。元素是扁平列表，携带框架与文档身份及 parentBackendNodeId（含 Shadow host 边界）；不能按列表位置推断 DOM 父子关系。

- 元素信息：`tagName`、`type`、Chromium AX `role`、可访问名称 `name`、直接文本 `text`、`labelText`、`description`、`descriptionText`、`errorText`、`placeholder`。
- 当前表单状态（含可编辑文本区域的 value）：`value`、`disabled`、`readOnly`、`checked`、`selected`、`expanded`、`focused`、`invalid`。AX 状态采用 Chromium 的枚举字符串，例如 `checked: 'true'`；属性缺失不等于 false。
- 下拉框直接返回 options 列表（包含 label、text、value、selected、disabled），option 也分别出现在快照中；单个下拉框超过 1000 项时明确报告 MAX_OPTIONS 截断。错误提示通过 `aria-errormessage`、说明通过 `aria-describedby` 关联；alert/status 等状态文本也作为页面元素读取。
- 密码和文件输入框的 value 默认置空，并标记 `valueRedacted`。不把脚本、样式源码混入祖先元素文本。
- `bounds` 为 Blink 返回的局部布局坐标，可能包含设备缩放；带 target 的输入会在原生设备缩放信息的基础上转换为 RenderWidget 输入坐标；`visible` 是布局/样式可见性，不承诺元素没有被其他元素遮挡。真正执行操作时会重新解析和检查目标。

`target` 包含 webContentsId、processId、routingId、documentId、backendNodeId。它是当前文档内的定位引用，不是可跨导航持久保存的业务 ID。导航、移除节点或框架销毁后，应重新获取快照。

## 查找与覆盖状态

```js
const found = await win.webContents.findAgentElements({
  name: 'Customer name',
  disabled: false
});
```

支持 role、name、text、label、disabled、checked、selected 和 selector；字符串 name/text/label 为区分大小写的包含匹配。selector 是每个文档/Shadow tree 范围内的 CSS 选择器。返回完整快照相同的覆盖字段，elements 仅保留匹配项；没有匹配项且 `complete: false` 时，不能推断整个页面不存在目标。

现有跨文档选择器路径仍可复用：

```js
const result = await win.webContents.querySelectorAcrossDocuments(
  'iframe >>> input',
  { agentInfo: true }
);
```

该模式保留旧接口的首个匹配语义，再从快照获取对应元素的语义信息。未指定 agentInfo 时保留原有返回值。

每个框架有 covered、partial、failed 或 skipped 状态及原因。达到节点、框架、时间、遍历深度、访问节点数或输出字节上限时显式报告截断。单框架目前有 100ms DOM 遍历预算、128 层深度、20000 个访问节点、2MiB 元素输出上限。全局默认最多 1000 个输出元素、100 个框架、5000ms；可配置的硬上限分别为 5000、1000、30000ms。限制不代表页面的真实大小；AX 初始化等原生工作不能被 JavaScript 超时抢占。

跨进程读取不是整个页面的原子事务。页面在读取过程中仍可能变化，输入时必须重新校验 target。

## 后台可信输入

```js
const field = found.elements[0];
if (!field) throw new Error('没有找到输入框，请检查覆盖状态');

const dispatched = await win.webContents.dispatchKeyEvent({
  target: field.target,
  type: 'char',
  text: 'A'
});

// 必须重新读取，确认值是否实际改变。
const after = await win.webContents.findAgentElements({ name: 'Customer name' });
```

当前 `dispatchKeyEvent` 单事件的 `text` 和 `unmodifiedText` 分别最多为 3 个 UTF-16 单元：原生缓冲区容量为 4，需保留结尾空字符。长文本须由调用方按字符边界拆成多次事件，不能拆开代理对；该接口不等同整段文本插入或真实输入法组合输入。

`target` 模式将事件路由到目标框架的 RenderWidget，不依赖系统前台窗口或 compositor 的跨进程命中路由。键盘操作先设置目标的页面内部焦点；不会调用 BrowserWindow.show/focus，也不会通过临时激活窗口完成输入。

鼠标的 x/y、触摸点的 x/y 在 target 模式下表示相对目标元素的 CSS 像素偏移；鼠标省略坐标时使用元素中心。多点触摸应属于同一目标框架，touchStart/touchMove 必须提供触摸点；touchEnd/touchCancel 可使用空数组。触摸序列必须持续使用同一 target。

```js
const buttons = await win.webContents.findAgentElements({ name: 'Submit form' });
await win.webContents.clickSelector('', { target: buttons.elements[0].target });
```

输入期间暂时关闭后台节流，并获取保持隐藏的渲染保活作用域。它不生成截图文件、不显示或激活窗口；输入队列屏障不等待屏幕实际呈现，完成后释放作用域并恢复设置。鼠标按下/释放、键盘按下/释放、触摸开始/结束之间保持序列状态；不完整序列有恢复节流的超时保护。隐藏和未聚焦能力以带 target 的调用为准，旧坐标接口保持兼容。

返回：

- `status: 'dispatched'`：事件已交给原生输入通道，**不代表页面操作成功**。
- `status: 'failed'`：解析或派发前失败，包含 target-resolution、frame-routing 或 event-dispatch 阶段、原因及阶段记录。
- 已派发但处理屏障超时/失败时，仍返回 dispatched，并附 `deliveryWarning`，不误报为“未发送”。

页面调用 preventDefault、收到事件后不改变状态等情形，由 Agent 重新读取快照判断。没有“页面未消费”这个公开结果状态。

失效文档/节点、失效框架、禁用元素、不可见或被遮挡的目标、无法聚焦的键盘目标、触摸目标不一致等应提供明确原因。显式启用 offscreen 渲染的 WebContents 暂不支持带 target 的输入，会返回 OFFSCREEN_AGENT_INPUT_UNSUPPORTED；它与普通 BrowserWindow 的隐藏状态不同。系统文件选择器、系统权限窗口不属于此输入 API；可信事件也不保证解除网站或浏览器的所有用户激活限制。

## 验收与构建

验收入口：`test/agent-automation.cjs`。测试使用两个站点的 iframe 和封闭 Shadow DOM 表单，分别检查快照、输入值/控件状态、可信事件、后台输入、前台窗口保持、截断及失效引用。测试夹具允许用页面脚本记录/断言结果；功能实现本身不依赖页面脚本或 CDP。

在现有 `out/Release` 上增量编译，保留缓存：

```powershell
cd D:\electron\main\src
ninja -C out/Release electron:electron_dist_zip
```

验证通过后再为新定制版本命名、发布。此前版本功能文档不应被改写成已经包含本次功能。

### 原生控件限制

为避免系统弹窗抢占焦点，带 target 的鼠标/触摸操作不打开原生 select 菜单；select 可用不带 Alt 的 ArrowUp/ArrowDown/Home/End/Tab 键操作，并重新读取 value/options 确认结果。文件、颜色、日期和时间选择器返回 TARGET_NATIVE_POPUP_UNSUPPORTED；文件输入可使用现有 setFileInputFiles。网页脚本自行创建的窗口、对话框及权限 UI 仍需由宿主的窗口/对话框策略接管。

## 实施记录与后续规划

### clickSelector 参数与行为一致性

登记日期：2026-11-03。状态：已完成 Windows 增量编译及 9 项运行验收；包含于本次 .4 分发版本。

此前带 `target` 的 `clickSelector` 在 JS 封装中固定使用 `button: 'left'` 和 `clickCount: 1`，未传递调用者提供的 `button`、`clickCount`、`modifiers`。已修改 `lib/browser/api/web-contents.ts` 的封装及对应原生派发路径。

实现内容：

- 两种调用方式均使用传入的 `button`、`clickCount`、`modifiers`，省略时沿用左键、1 次、无修饰键。原生 selector 路径同时修正释放事件的 `buttons`，使其不再保留按下位。
- `clickCount` 支持 1 至 3，代表完整按下/释放组数，每组事件计数递增。双击包含两次 `click` 及一次 `dblclick`；三击发送三组事件。
- `target` 模式将整个点击序列串行排队，其他 target 操作不能插入其按下/释放之间；保留序列中的派发警告，中途失败时标记可能已发送的部分序列。
- `scrollIntoView: false` 在 `target` 模式下也不滚动页面；不可命中的目标返回失败。`pierce` 仅用于 selector 搜索，已解析的 `target` 不执行选择器搜索。选项类型及按钮、计数、修饰键范围在输入前校验。
- 同进程 iframe 的点击命中检查使用其 local root 共享的输入组件，避免因子 frame 没有独立组件而错误返回 `WIDGET_UNAVAILABLE`。

验收条件：

- 验证默认左键、右键和修饰键组合的事件序列、`button` / `buttons`、修饰键标记及 `isTrusted`，并覆盖约定的点击计数与双击行为。
- 覆盖主文档、跨域 iframe 和 closed Shadow DOM，以及隐藏和未聚焦窗口；确认输入期间系统前台窗口保持不变。
- 回归原有 selector 调用方式、失效 target 的失败结果，以及 `dispatched` 仅表示派发、不表示页面操作成功的返回语义。

验收入口：`test/click-selector.cjs`，9 项专项测试全部通过；回归入口：`test/agent-automation.cjs`，原有 11 项测试全部通过，系统前台激活 0 次。TypeScript 检查、JS 检查、格式检查及 Windows `electron` 增量编译通过。

运行记录位于 `D:\electron\tmp\click-selector-results.json`、`click-selector-agent-regression-results.json` 及对应日志。本地新程序为 `D:\electron\main\src\out\Release\electron.exe`；没有重新打包 `dist.zip`，没有修改发布版本或更新镜像及 GitHub。本次按用户要求在 clickSelector 修复和验证后停下，不继续虚拟光标开发或发布。

### 原生虚拟光标：自动化调试可视化

登记日期：2026-11-03。状态：已实现并通过 Windows 运行验收；截图隔离、限帧与单窗口吞吐已测试，覆盖边界见最后的验收记录。

用途：供自动化开发者在 WebContents 的可见界面上观察指针位置及按下/释放状态。用户确认采用非 DOM 实现，页面截图（`webContents.capturePage()`、CDP 页面截图等）不得包含虚拟光标，同时尽量降低性能开销。系统桌面截图、窗口捕获和录屏不属于此次截图隔离范围。

新增 `webContents.setVirtualCursorEnabled(enabled, options?): Promise<void>`，默认关闭。首版覆盖当前 Windows 的普通窗口及 WebContentsView，显示默认箭头或自定义静态图片，以及按键状态。`options.blockRealPointer` 为可选布尔值，首次开启时默认 `false`；设为 `true` 时，在虚拟光标开启期间阻断操作系统指针输入对该 WebContents 的干扰。已开启时再次传 `true` 并省略该选项，保留当前设置，避免无参重复开启意外解除阻断；显式传 `false` 才在保持显示的同时解除阻断。关闭虚拟光标时自动解除并重置本功能的阻断配置，不改变宿主原有的其他输入策略。

同时支持 `options.blockRealKeyboard`，为可选布尔值，首次开启时默认 `false`；与 blockRealPointer 独立配置，运行中省略某项时保留该项当前值，显式设置才更新。关闭虚拟光标时解除并重置两项阻断配置，再次开启省略时均为 false。此选项纳入本次待实现范围，复用同一开启方法，不新增公开方法。

调用方须等待 Promise 完成后才认为新模式已生效：原生入口完成切换，并按已验证的屏障和状态处理规则处置在途真实输入；不能仅设置一个布尔值就宣称输入已隔离，也不能把 PingMainThread 等调用本身视为完整排空所有输入队列的证明。该完成信号不等待光标真正呈现在屏幕上。配置校验、图层准备或输入隔离失败时保留或恢复此前的有效模式并返回错误，不留下无可见光标却锁住真实输入的半成功状态；关闭及销毁路径必须能解除本功能的阻断。

真实指针阻断的拟议调用形式：

```text
await wc.setVirtualCursorEnabled(true, { blockRealPointer: true });
// 自动化鼠标输入和批量轨迹仍可执行，虚拟光标照常显示。
await wc.setVirtualCursorEnabled(true, {
  blockRealPointer: true, blockRealKeyboard: true
});
// 同时阻断命中该 WebContents 的真实指针和键盘输入。
await wc.setVirtualCursorEnabled(true, {
  blockRealPointer: false, blockRealKeyboard: false
});
// 保持虚拟光标显示，恢复真实指针和键盘输入。
await wc.setVirtualCursorEnabled(false);
// 关闭虚拟光标，同时解除本功能的两类真实输入阻断。
```

blockRealPointer 针对来自系统 UI 输入通道的鼠标、触控板、触摸与笔输入及其派生指针操作，不根据硬件设备或 `isTrusted` 判断来源。真实键盘由 blockRealKeyboard 单独控制。目标是阻断命中该 WebContents 的真实指针输入及其引发的页面操作、事件和 hover 状态变化，不是禁止网页脚本、网络或其他窗口活动引发的所有页面事件；真实系统光标仍可在桌面和其他窗口正常使用。

blockRealKeyboard 针对当前焦点位于该 WebContents（含子框架）时，从系统原生通道进入的按下、释放、重复按键、字符、死键、IME 组合及提交文字、原生编辑命令等入口；在进入页面及 WebContents 的输入回调前拦截，不能只屏蔽 keyDown/keyUp 而让系统字符、输入法提交或默认编辑操作继续生效。自动化 dispatchKeyEvent、dispatchInputSequence 的键盘步骤和既有宿主键盘派发入口继续按原能力工作。原生门禁不逐事件执行页面脚本或产生额外 IPC，不以 isTrusted 区分两类输入。

真实键盘阻断仅针对该 WebContents，不是系统全局键盘锁，也不代表禁止宿主菜单、其他窗口或操作系统快捷键；宿主的取消、关闭等控制入口须保持可用。输入法和既有真实持键状态在模式切换时按明确的生效边界处理；不能让旧系统输入的尾部或自动重复事件在启用后泄漏，也不能在解除阻断时把之前缓存的文字或按键回放到页面。未验证的平台或输入通道须明确报告不支持。

阻断须在浏览器进程原生输入入口、进入网页和相关输入回调之前完成，覆盖鼠标移动、进入/离开、按下/释放、滚轮、触控板滚动/惯性/手势、触摸/笔及系统拖放入口；不能仅通过页面 DOM 的 preventDefault/stopPropagation、透明页面遮罩或隐藏系统光标实现。核验原生点击造成的页面内部焦点、选择、右键菜单、拖放和浏览器默认行为，不能只检查 click 事件是否消失。

自动化 `dispatchMouseEvent`、`dispatchInputSequence` 中的鼠标步骤、`clickSelector`、鼠标 `sendInputEvent` 保留各自已支持的派发能力，并正常更新虚拟光标；既有键盘/触摸 API 及混合序列中的键盘步骤同样不受两项真实输入阻断选项影响，键盘输入不移动光标。使用原生入口或内部执行上下文区分系统输入与宿主 API 输入，不向页面或调用参数暴露可冒充来源的开关，也不依赖 DOM `isTrusted` 区分。仅在共享派发路径统一拒绝所有事件会误伤自动化输入，不能作为实现。

阻断按 WebContents 生效，覆盖主文档、跨域 iframe、Shadow DOM 及视图替换、导航后的新文档；不将事件穿透给下层窗口，不全局禁用系统鼠标，不阻断宿主其他界面。不要用 BrowserWindow 的 setIgnoreMouseEvents 替代该功能，其窗口穿透行为与需求不同。切换时明确生效边界，妥善处理已有按键状态、指针捕获、惯性和系统拖放；不能承诺撤销已送达网页的事件，也不能在切换后透传旧真实输入序列的尾部。

新增 `webContents.setVirtualCursorImage(image, options?)`，其中 `image` 仅接受 `NativeImage` 或 `null`，`options.hotspot` 指定图像逻辑坐标（DIP）内的点击热点，默认 `{ x: 0, y: 0 }`；传 `null` 恢复默认箭头。调用方可通过 `nativeImage.createFromBuffer(pngBuffer)` 从内存构造图片，再动态替换，无需关闭或重新开启光标。

新增 `webContents.setVirtualCursorFrameRate(fps)`，设置当前 WebContents 的光标渲染帧率上限。默认 `0`，表示在有状态变化时跟随实际合成帧率；正整数表示每秒最多更新该次数，例如 15、30、60、120。参数须为非负安全整数，拒绝负数、小数、NaN、Infinity 及其他类型。设置的是上限，不保证实际帧率；实际更新还受显示刷新率、可见性和系统负载限制。

帧率配置可在运行中修改，不重启或打断轨迹，不改变输入事件的派发时间和顺序。每个 WebContents 独立保存配置，仅驻留内存。禁用光标或隐藏窗口时不持续运行刷新定时器；再次启用或恢复可见时使用当前配置显示最新状态。

用户要求运行时数据仅驻留内存：图片、热点、位置、按键状态保存在进程内存和绘制所需的 GPU 资源中，功能本身不读写图片文件、不创建临时文件、不持久化配置。图片接口明确拒绝文件路径和 URL，避免通用图像转换器隐式读取文件。每个 WebContents 独立保存配置，销毁后释放，应用重启后恢复默认。

实现约束：

- 在浏览器进程管理每个 WebContents 独立的原生光标控制器，使用宿主 UI 合成图层绘制；光标图层位于网页内容 Surface 之外，不进入网页渲染及页面截图所读取的 Surface。不能仅凭“非 DOM”就认定截图必然排除光标，必须验证实际图层挂载及采集路径。
- 图层不参与页面命中测试，不抢焦点，不移动系统鼠标；保持现有事件派发及返回语义。
- `dispatchMouseEvent`、`clickSelector` 的 selector/target 两条路径共用位置和按键状态更新逻辑，并接入现有 `sendInputEvent` 鼠标路径及下述批量轨迹入口；使用实际派发点统一转换坐标，覆盖跨域 iframe、页面缩放和设备缩放。查询及键盘接口不移动光标。
- 光标移动只更新缓存图像的图层位置/变换；外观或设备缩放变化时才更新绘制内容。避免为光标触发网页布局、页面重绘、截图读回或逐事件新增跨进程通信。
- 每个宿主 API 鼠标步骤只更新控制器内存中的最新坐标、按钮及 dirty 状态；真正的图层 SetTransform/SetBounds 和绘制提交仅在允许的合成帧内发生，等待中的刷新任务最多一个。不能每点修改图层并触发提交后，再用额外定时器声称限制了绘制帧率。虚拟光标仅跟随宿主 API 的鼠标输入，未被阻断的真实指针也不覆写其坐标或按钮状态。
- 设置图片时校验非空、解码尺寸、资源大小及热点范围，保存稳定的图像快照；只在图片或必要的缩放资源变化时准备绘制资源，不在每次移动时重复解码、缩放或上传纹理。热点只影响图像相对实际输入点的绘制偏移，不改变页面收到的输入坐标。
- 替换图片后及时释放旧绘制资源；禁用时释放图层和 GPU 绘制资源，可在有界内存中保留自定义图片配置供再次开启使用；传 `null` 或销毁 WebContents 时释放对应的自定义图片配置。
- 按需更新，无持续轮询和常驻动画定时器；高频移动的可视位置同时受合成帧率与配置上限限制，每帧最多更新一次，仅显示最近实际派发的位置，不提前显示尚未执行的规划坐标。只合并显示位置，不因光标限帧丢弃或延迟输入事件，不丢失按下/释放的逻辑状态；同一显示帧内完成按下和释放时，不承诺两种外观各显示一帧。
- 隐藏或最小化时停止光标绘制，只保留最新状态；恢复可见后显示最新位置。关闭功能后取消待更新任务并释放图层及专用观察资源，不为光标持续生成合成帧。
- 管理视图替换、导航、尺寸变化、裁剪和销毁，避免图层残留或越出所属 WebContents。离屏输出不绘制虚拟光标。
- 页面截图隔离通过图层归属实现，不在截图前临时隐藏、截图后恢复，避免闪烁和并发截图竞态。

验收条件：

- 开启后窗口内可见光标；在静态测试页面上，开关前后 `capturePage()`、CDP `Page.captureScreenshot` 的全视口及裁剪截图像素一致，移动或按下光标时同样成立；补充超出视口的页面截图路径验证。
- 验证主文档、跨域 iframe、closed Shadow DOM 和不同缩放下，显示落点与页面收到的输入位置一致，页面 DOM 结构不因光标功能改变。
- 覆盖内存图片设置、透明背景、动态替换、热点偏移、恢复默认、非法图片和缩放；验证自定义图片同样不进入页面截图，运行时无图片文件读写或临时文件，重复替换和销毁后资源不会持续增长。
- 对照关闭/开启状态，测量静止、连续高频移动、点击、隐藏及多个 WebContents 场景的 CPU/GPU 开销、合成帧和输入延迟；确认待更新任务有界、静止时无光标驱动的周期刷新、隐藏时停绘。性能结果实测后记录，不预先承诺零开销或未经测量的百分比。
- 验证自动、15、30、60、120fps 上限和执行中切换；在输入序列相同的条件下，降低光标帧率不得改变计划坐标、输入顺序或主动降低输入派发频率。30fps 和 60fps 的更新间隔分别约为 33.3ms、16.7ms，只用于说明显示采样间隔，不作为端到端延迟承诺。
- 通过原生图层更新及合成提交的统计验证限帧真正生效，不能只计应用层定时器回调。连续 1000 点/秒下刷新任务不堆积；未启用真实指针阻断时，真实鼠标移动不改变虚拟光标的自动化位置。
- 验证批量轨迹中的移动、按下、拖动、释放及最终落点；低帧率下保留正确的最新位置和按键状态。轨迹结束后在下一个允许的合成帧显示最终状态；未启用虚拟光标时，轨迹仍可独立执行。
- 验证 `blockRealPointer` 默认关闭、开启时阻断、运行中切换及关闭虚拟光标后的恢复；在明确生效边界之后，用真实系统输入通道测试移动、进出、所有鼠标按钮、滚轮、触控板、触摸/笔和外部拖放。确认页面无这些输入产生的 pointer/mouse/touch/wheel/contextmenu/drag 事件、hover/选择/滚动变化和意外内部焦点操作，宿主也不为被拦截输入触发 WebContents 的输入回调；不以页面脚本伪造的事件充当真实输入测试。
- 阻断开启时同时运行 API 点击、拖动和 1000 点轨迹，验证其既有可信输入能力及虚拟光标位置、按钮状态、截图隔离均正常；覆盖 OOPIF、closed Shadow DOM、缩放、导航、视图更换、已有捕获和在途输入，确认其他 WebContents、宿主界面及下层窗口没有被误操作。若某个平台或入口尚未满足阻断要求，须明确报告不支持，不能声称已实现全面阻断。
- 验证重复开启保留阻断、显式解除、关闭后重新开启使用默认阻断值，以及启用失败时的配置回退；在等待模式切换期间持续发送真实输入，确认 await 生效边界之后没有此前在途的指针事件尾部泄漏。验证销毁、渲染进程退出及部分资源初始化失败时无残留图层或输入锁。
- 验证两项真实输入阻断的四种组合、运行中独立修改和省略字段保留配置，确认首次及关闭后重新开启均使用默认 false。真实键盘验收覆盖按下/释放、自动重复、组合键、死键、中文 IME 组合和提交、字符与原生编辑命令；检查页面的 keydown/keyup、composition、beforeinput/input 和表单值/选择状态，以及宿主 WebContents 输入回调，确认无被拦截系统输入的泄漏。
- 在两个阻断选项均开启时运行鼠标键盘混合序列，验证自动化字符输入、组合键、Tab 焦点迁移及虚拟光标正常；覆盖 iframe 焦点切换、启用时已有按键或输入法组合、取消及销毁。确认其他 WebContents、宿主控制入口和系统快捷键仍可使用，关闭后不重放缓存的系统输入，屏蔽能力不被描述成对所有外部活动的全局隔离。

本项已经实现并完成本文列出的自动验收；详细设计中的硬件及异常场景并不据此全部视为实测通过，见最后的验收范围。

### 批量输入序列：鼠标轨迹与键盘统一时间线

登记日期：2026-11-03。状态：已实现并通过 Windows 运行验收。以下接口包含于本次 .4 分发版本，吞吐与调度测量见最后的验收记录。

新增 `webContents.dispatchInputSequence(steps, options?)`，接受预规划的鼠标、键盘混合对象数组。每个对象包含统一的 `atMs` 和 `kind`：`kind: 'mouse'` 使用坐标和 `dispatchMouseEvent` 配置，`kind: 'key'` 使用 `dispatchKeyEvent` 配置且不要求 x/y。覆盖连续移动、点击、拖动、滚轮、字符输入、按键及鼠标键盘组合操作，支持上千个坐标点及 1 CSS 像素步长，不根据点数自动抽样、插值或修改轨迹。

此前讨论的 `dispatchMouseSequence` 尚未实现，正式规划用 `dispatchInputSequence` 替代，不新增同功能别名或独立键盘调度器。纯鼠标、纯键盘及混合输入共用同一个原生时间轴、队列和取消机制；公开新增方法总数仍为 4 个，即三个虚拟光标配置方法和一个批量输入方法。

以下为拟议调用形式：

```text
await wc.dispatchInputSequence([
  { atMs: 0,  kind: 'mouse', type: 'mouseMoved',    x: 100, y: 100 },
  { atMs: 20, kind: 'mouse', type: 'mousePressed',  x: 100, y: 100,
    button: 'left', buttons: 1, clickCount: 1 },
  { atMs: 28, kind: 'mouse', type: 'mouseMoved',    x: 101, y: 100, buttons: 1 },
  { atMs: 36, kind: 'mouse', type: 'mouseMoved',    x: 102, y: 100, buttons: 1 },
  { atMs: 50, kind: 'mouse', type: 'mouseReleased', x: 102, y: 100,
    button: 'left', buttons: 0, clickCount: 1 }
]);
```

鼠标与键盘混合示例，`fieldTarget` 为已通过快照获取的输入框引用：

```text
await wc.dispatchInputSequence([
  { atMs: 0, kind: 'mouse', type: 'mousePressed', target: fieldTarget,
    x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 },
  { atMs: 8, kind: 'mouse', type: 'mouseReleased', target: fieldTarget,
    x: 5, y: 5, button: 'left', buttons: 0, clickCount: 1 },
  { atMs: 20, kind: 'key', type: 'char', target: fieldTarget, text: 'A' },
  { atMs: 40, kind: 'key', type: 'keyDown', target: fieldTarget,
    key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  { atMs: 48, kind: 'key', type: 'keyUp', target: fieldTarget,
    key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
]);
```

参数和时间语义：

- `kind` 必填，首版仅接受 `mouse` 或 `key`，与各自的事件 `type` 分开；使用区分类型的参数结构校验，键盘步骤不要求鼠标坐标，不能把键盘事件传入鼠标派发器。触摸序列不在本次批量接口范围内，既有单事件触摸接口继续保留。
- `atMs` 为相对轨迹实际开始执行时刻的毫秒偏移，不是距前一个点的间隔。轨迹出队并完成初始准备后，才确定统一的单调时钟起点；排队和准备时间单独记录，不消耗预规划时间。
- `atMs` 必须为有限、非负、非递减的数值；相同时间按数组顺序执行，不为每个相同时间的点人为增加延迟。允许小数毫秒表达计划，但不承诺亚毫秒或硬实时精度。
- 保留 `atMs` 作为唯一调度时间字段。按间隔生成的路径应在提交前累加转换，例如间隔 `0、8、8、8ms` 转成偏移 `0、8、16、24ms`。两种规划方式均可用统一起点调度；避免每步执行完成后再等待一个间隔，从而累计执行耗时。
- 沿用 `type`、`button`、`buttons`、`modifiers`、`clickCount`、`deltaX`、`deltaY`、`pointerType`、压力及笔倾角等现有字段与校验规则；移动类型必须显式写为 `mouseMoved`。按键状态由轨迹明确给出，滚轮仍须提供两个 delta。单个事件的 `clickCount` 沿用原派发语义，不因此自动扩展成多组点击。
- 键盘步骤沿用 `dispatchKeyEvent` 的 `keyDown`、`rawKeyDown`、`keyUp`、`char` 及 `key`、`code`、`text`、`unmodifiedText`、`modifiers`、虚拟键码、`autoRepeat`、`location`、`isKeypad`、`isSystemKey`、`commands` 等实际支持字段和限制。按键、字符及编辑命令保持原语义，不把一次 keyDown 自动解释为完整输入或按下/释放组；字符输入不等同真实输入法的 composition 流程，文本长度与编码沿用现有单事件限制。
- Ctrl/Shift/Alt/Meta 的按下与释放可跨越鼠标步骤，修饰键位及鼠标 buttons 状态须与序列一致；执行前校验明显冲突的状态，并追踪本序列持有的按键及鼠标按钮，不能只给某个事件添加 modifiers 就声称发送了完整组合键序列。省略 modifiers 或 buttons 时，可从本序列已显式按下的状态推导；显式提供时必须与本序列持有的状态相容。沿用单事件接口的 modifiers 标记不代表序列拥有对应按键，不能因此在清理时释放外部输入持有的键。
- 首版每个序列须自行闭合显式的按下/释放，不跨两次调用延续按住状态；提交前拒绝未配对的鼠标按下、普通键或修饰键按下/释放，重复 keyDown 须遵循 autoRepeat 规则，char 不要求独立配对。正常完成也检查状态账本，不能仅在取消或失败时清理。真实输入、其他宿主入口或调用前残留状态若会造成所有权冲突，须明确失败，不能假定系统输入状态已知或任意释放外部按键。
- 现有 `timestamp` 仅表示事件时间戳，不负责等待。首版轨迹对象不接受独立的 `timestamp`，由调度器在实际派发时使用当前时间生成事件时间戳；计划时间与实际派发时间分别记录。
- 无 `target` 时，x/y 为顶层 viewport 的 CSS 像素坐标；有 `target` 时沿用相对目标元素的 CSS 像素偏移语义。坐标必须是有限数值，保留小数，不逐点强制取整。页面缩放、设备缩放和图片热点仅由各自的转换层处理；1 CSS 像素不等于所有缩放下的 1 屏幕物理像素。
- 每个对象可使用现有 `target` 配置；批内复用已验证的框架信息，在目标或框架改变等必要边界重新准备。拖动期间维持正确的按钮、路由和指针捕获语义，不因跨越 iframe 或 Shadow DOM 而强制把事件目标改为该点所在的元素。
- 键盘显式 target 在按键序列开始或明确切换输入目标时准备并设置页面内部焦点，不激活系统窗口；无 target 时沿用当前焦点的既有路由及能力边界，不承诺隐藏窗口的无目标输入。不在每个 keyUp 或 char 前无条件重复聚焦；Tab 等默认操作迁移焦点后，后续无 target 的字符及释放事件按当前有效焦点路由，不能强行发送回原元素或复用已经失效的框架。按住期间显式切换 target 与正常焦点迁移的处理必须区分，并验证跨 iframe 情形。[UI Events 焦点与按键规则](https://www.w3.org/TR/uievents/)
- `options` 规划包含 `signal`、`queueTimeoutMs`、`timeoutMs`、`focusTimeoutMs` 和 `maxLatenessMs`。排队超时从完成纯参数校验并接受任务时开始计时；执行超时从出队进入准备阶段开始，涵盖准备、调度和必要处理屏障；focusTimeoutMs 为单次依赖目标焦点确认的最大等待时长，必须有有限且为正数的默认值，不允许无限等待或关闭此限制；迟到量从准备后的统一起点与 atMs 计算。各预算分别统计，不能在长时间排队后把序列作为刚提交而无限续期。
- 点数、计划总时长、编码后字节量、累计排队任务数及总字节量均须设置硬上限，包含键盘 text/commands 的变长数据；各默认值与允许范围在编码前固定并写入参数说明，至少覆盖 1000 点和 1000 点/秒的验收场景。执行前完成不改变页面的参数、大小和配对校验并复制数组；预校验不得聚焦、滚动或派发事件，实时目标有效性与页面状态在真正执行时另行检查。

执行与资源约束：

- 一次提交整条轨迹，在浏览器进程原生调度；共享事件构造、校验和可信输入派发逻辑，不逐点从 JS 调用完整的公开接口、重复创建跨进程目标查询及等待屏障。不能直接去掉必要的文档身份和路由有效性检查来换取吞吐量。
- “按序派发”不等于前一步的页面默认行为已经完成。点击之后输入、Tab 焦点迁移、跨框架或显式 target 切换等依赖边界须在有界的原生处理屏障后确认目标/焦点，不能只靠两个 atMs 相差几毫秒或沿不同进程通道提交的先后顺序推断；连续无依赖的移动不逐点等待屏障。等待导致的迟到计入统计和 maxLatenessMs，无法确认依赖时停止，不强行赶时间执行到错误控件。
- 焦点确认不得卡住调度器或无限阻塞 Promise。目标已不可见、禁用、失效或原生聚焦已明确失败时立即终止，使用 TARGET_NOT_FOCUSABLE、STALE_TARGET 等明确错误；只有焦点可能异步就位时才允许有界等待。等待最多为 focusTimeoutMs，并同时受整体剩余执行时间及该步骤允许迟到预算约束；先到达的限制立即结束等待，不能每次重试或改焦点时重置预算。
- 焦点等待超时返回 `status: 'failed'`、`reason: 'FOCUS_TIMEOUT'`；等待结束后焦点明确落在错误目标且不应继续等待时使用 FOCUS_NOT_REACHED。结果包含 stoppedIndex、dispatchedCount、lastDispatchedIndex 和必要的目标/焦点诊断，不继续派发该失败步骤或之后的字符及按键，不自动重试或重放之前的点击；本序列已持有的按钮及按键仍走有界清理流程。执行中的这些异常采用统一的结构化失败结果，不能只返回 false、空值或永不结束的等待。
- 焦点成功须对应步骤声明的预期目标及有效框架，不能把任意元素处于焦点状态当作指定输入框已就位；定向文字输入应明确提供 target。未指定目标的页面级按键或快捷键仍按当前焦点语义处理，不因焦点位于 body 等普通元素就一律失败，也不据此保证文字已进入某个业务输入框。
- 使用单调时钟的“起点 + atMs”确定每个截止时刻，始终按序执行；每条轨迹只保留有界的待调度任务，不为上千个点分别创建常驻定时器，不忙等或长期阻塞浏览器 UI 线程。
- `signal` 在提交时已取消则不进入执行队列、不准备目标，返回零派发的取消结果；排队中取消能移除任务，执行中取消通过独立的原生控制路径通知当前任务，不能把取消动作排在被取消的长序列之后。主进程桥接 AbortSignal 与内部任务标识，不逐点传递 signal，任务结束后移除监听和注册项，不新增公开取消方法。
- 默认不在自身输入队列中丢点或合并事件。系统落后时采用有界追赶和主动让出执行机会；超过允许的迟到量或整体超时则停止并报告，不能无界突发派发全部过期点或静默跳点。停止前尚未派发的点不再继续执行。
- 同一 WebContents 的输入序列串行执行，与现有 target 操作队列整合；整个鼠标键盘混合序列保持独占，其他异步鼠标和键盘操作排队，不能分设两条独立队列导致跨设备步骤乱序。同步 `sendInputEvent` 若无法兼容排队，序列运行时的冲突调用须在派发前明确拒绝；没有序列运行时保持原行为。不同 WebContents 可独立执行，逐窗口验证资源增长。
- 导航、框架或目标销毁、目标失效时停止；页面滚动、布局或缩放变化后，不静默复用已经失效的坐标转换。坐标模式继续按 viewport 点命中，target 模式须重新核验目标和转换，不能保证预规划路径仍对应原业务控件。
- 渲染进程退出或无法继续处理输入时停止；系统睡眠恢复后取消尚未完成的序列，不能将休眠期间到期的点集中补发。普通隐藏/最小化只停止光标绘制，输入是否继续仍按既有后台能力及序列超时处理，不把隐藏等同休眠。
- 支持取消和失败清理；仅在原文档及路由仍有效时，尽力释放本序列持有的鼠标按钮、按键和修饰键，并记录清理结果，不向新文档补发旧序列事件。恢复后台节流及保活状态，释放队列和调度资源。后台输入继续遵循现有 target 模式能力边界，不据此扩大离屏模式支持范围。
- 轨迹、状态及调度数据仅驻留内存，不读写轨迹文件或临时文件，不逐点输出日志、进度 IPC 或完整回执；必要诊断采用有界汇总，避免诊断本身成为高频瓶颈。
- 结果汇总至少包含已派发步骤数、鼠标和键盘各自的计数、最后派发或停止的索引、执行耗时、调度迟到量和失败或取消原因；部分派发后失败不得描述成整批未执行。完成仅表示所有步骤已交给输入通道，不代表网页操作成功或每个步骤均触发了独立回调，已经派发的事件不可回滚。
- 统一结果契约：参数、资源限制或配对校验错误在入队前拒绝 Promise，且无页面操作；接受任务后的完成、取消或运行失败返回结构化结果，status 分别为 completed、cancelled、failed。返回 dispatchedCount、lastDispatchedIndex（零派发时为 null）、stoppedIndex、reason、排队/准备/执行耗时、迟到汇总以及 cleanup 结果；任务标识在内部使用。清理事件计数与用户步骤分开，清理失败须报告，不能直接声称状态已恢复。完成统计不把尝试派发当作确认入通道，也不因最终页面状态未知而自动重放序列。

与虚拟光标的同步及事件接收边界：

- 实际派发鼠标事件时同步更新光标控制器的坐标与鼠标按钮状态，采用同一坐标转换结果，避免输入位置和显示位置各自计算产生偏差；键盘步骤不移动或重置虚拟光标。绘制更新及光标帧率不成为鼠标或键盘派发的等待条件。
- 一秒内派发 1000 个点时，60Hz 合成最多呈现约 60 次位置更新，30fps 上限最多约 30 次；显示最新实际位置，不预先推进到规划终点，也不要求每个输入点各占一个显示帧。把全部点安排在极短时间内时，视觉上可能直接到达终点。
- 区分调用方提交点数、原生派发点数、网页收到的移动回调数及其可获取的合并事件数。Chromium 可能合并移动事件；本接口自身不丢点不等于网页必然逐点收到 1000 次回调。若要求逐点触发网页处理，应作为单独能力评估和验收，首版不预先承诺。
- `blockRealPointer` 仅阻断系统指针入口，`blockRealKeyboard` 独立控制真实键盘；两者均不阻断混合序列的自动化输入。只开启前者时仍可能受到真实键盘干扰，同时开启两者也不代表能阻止其他窗口活动、系统焦点变化或页面自身行为；路由、目标检查和取消规则仍须执行。

验收条件：

- 验证 1000 点及更多点、1 CSS 像素步长、小数坐标、相同 atMs、长短间隔、移动、按下、拖动、释放、滚轮及修饰键；覆盖非法参数和提交后修改数组，确认校验失败时尚无输入发生。
- 验证纯键盘及“点击输入框、输入字符、按下并释放 Enter”的混合序列、Ctrl/Shift 加鼠标点击或拖动、组合键、重复按键、Tab 焦点迁移和编辑命令；同一 atMs 的跨设备步骤严格按数组顺序派发。分别检查可信事件、输入值/选择状态和页面实际反馈，不仅检查公开接口返回成功。
- 验证取消或失败发生在鼠标按下、普通键及修饰键按下之后时的部分结果和尽力释放，覆盖无目标焦点路由、显式目标、iframe 切换、无效 kind 和跨类型参数错误；确认键盘步骤不移动虚拟光标，真实指针阻断不会误伤自动化键盘。
- 验证同一 atMs 的点击到键盘输入、Tab 到下一字段及跨 iframe 的焦点依赖，确认不会输入到前一个字段；检查受屏障影响的迟到与超时结果。覆盖预先取消、排队中取消、满队列、未闭合序列、外部持键冲突、渲染进程退出、休眠恢复和清理失败，确认不会继续派发、无界堆积、释放他人的键或重放已经完成的步骤。
- 验证点击后没有获得预期焦点、目标拒绝聚焦、脚本持续抢焦点、目标在等待中移除或导航、延迟就位及渲染进程不响应时，Promise 均在预算内结束并返回明确失败、取消或超时原因；确认失败步骤后的键盘事件为零、既有点击的部分派发计数正确。还需验证 body 上的合法无目标快捷键不会被误报为焦点失败。
- 分别记录计划与实际派发时间、最大及 p50/p95/p99 迟到量，验证统一起点调度和每批任务有界；覆盖 CPU 忙碌、受限追赶、超时、取消、排队和其他入口并发冲突。
- 覆盖主文档、跨域 iframe、closed Shadow DOM、页面及设备缩放、隐藏和可见未聚焦窗口；验证导航、移除目标和窗口销毁时的停止、部分结果及资源恢复，不激活系统前台窗口。
- 对照虚拟光标关闭、开启及不同帧率上限，核对同一轨迹的派发顺序、坐标、按键状态、最终落点及页面截图隔离；分别报告提交、派发和页面接收数量，不以屏幕显示帧数代替事件数量。

本项已经实现并完成本文列出的自动验收；详细设计中的硬件及异常场景并不据此全部视为实测通过，见最后的验收范围。

### 实施前参数定稿与调整清单

登记日期：2026-11-03。状态：已按下方固定参数实现；本清单不额外新增公开方法。

- 固定并公布每批最大步骤数、最大计划时长、序列字节量、单个 WebContents 的累计排队任务及字节上限，同时纳入键盘文本和命令的变长数据；超限在页面操作发生前拒绝。
- 固定 queueTimeoutMs、timeoutMs、focusTimeoutMs、maxLatenessMs 的默认值、范围及是否允许关闭限制，分别对应排队等待、准备及执行、单次焦点确认、相对 atMs 的迟到。其中 focusTimeoutMs 必须有限且为正，不允许关闭；任何焦点确认同时受整体执行时限约束。具体数值以“已实现的接口参数与资源边界”为准；不以性能预估代替限值。
- 固定 setVirtualCursorEnabled 的 Promise 生效边界、重复调用规则、两类真实输入阻断的原子切换与失败回退；取消或关闭不被正在执行的长序列阻塞。
- 固定点击/Tab/跨框架后的焦点依赖、序列内按下与释放的配对、状态所有权和正常结束/失败/取消的恢复规则；不能仅凭事件按序提交就声称页面处理已完成。
- 固定 char 文本长度与拆分边界、kind 的类型校验、无副作用预校验和运行时目标检查，保留统一 atMs 调度；不增加含义重叠的间隔或独立事件 timestamp 调度字段。
- 固定 completed/cancelled/failed 与入队前参数拒绝的结果契约、部分派发计数及 cleanup 结果；调用方可以判断执行到哪一步，但不能把失败理解成整批未发送或可无条件重试。
- 固定只缓存输入状态、按帧实际提交图层的位置更新流程，并按实际图层提交统计检验限帧；性能预算与实现及运行验收状态分别维护。

### 已实现的接口参数与资源边界

本节为本次实现的参数定稿；实际运行验收及分发版本另见下方记录。公开新增方法为 `setVirtualCursorEnabled`、`setVirtualCursorImage`、`setVirtualCursorFrameRate` 和 `dispatchInputSequence`，目前虚拟光标仅支持 Windows 的普通 WebContents 视图；其他平台明确返回 VIRTUAL_CURSOR_PLATFORM_UNSUPPORTED。离屏视图和 guest 不支持开启光标。

```js
await wc.setVirtualCursorEnabled(true, {
  blockRealPointer: true,
  blockRealKeyboard: true
});
wc.setVirtualCursorImage(image, { hotspot: { x: 2, y: 2 } });
wc.setVirtualCursorFrameRate(30); // 0 为自动；不影响输入频率
const result = await wc.dispatchInputSequence([
  { kind: 'mouse', atMs: 0, type: 'mouseMoved', x: 20, y: 30 },
  { kind: 'mouse', atMs: 5, type: 'mousePressed', x: 20, y: 30, button: 'left', clickCount: 1 },
  { kind: 'mouse', atMs: 10, type: 'mouseReleased', x: 20, y: 30, button: 'left', clickCount: 1 },
  { kind: 'key', atMs: 10, type: 'char', target: input.target, text: 'A' }
], { signal, focusTimeoutMs: 1000, maxLatenessMs: 250 });
await wc.setVirtualCursorEnabled(false);
```

- 光标帧率为整数 0–1000，实际不超过合成器刷新率；图片仅接受非空 NativeImage 或 null，null 恢复默认箭头。图片尺寸为 1–512 DIP，热点为图片内的有限 DIP 坐标。调用时复制 1x 表示到不可变内存，不保存文件，也不保留可变图片引用。
- 每批 1–10000 步，atMs 为 0–60000ms 的非递减有限数，同一时间保持数组顺序；最大 JSON 编码量为 4MiB。每个 WebContents 同时最多接受 16 个序列、累计 8MiB 编码量。编码量上限不等于解码后总内存占用。
- queueTimeoutMs 默认 10000ms，允许 1–120000ms；timeoutMs 默认 max(30000, 最后 atMs + 5000)，允许 1–120000ms，且不能小于最后 atMs；focusTimeoutMs 默认 1000ms，允许 1–10000ms；maxLatenessMs 默认 250ms，允许 1–5000ms。均不可设为无限或 0；单次依赖同时受焦点、整体执行和迟到预算约束。
- 参数复制与纯校验在入队前完成，排队时取消会实际移除任务。统一单调时间起点在出队并初始化原生调度器后建立，逐步目标准备计入 executionMs 和迟到量；目前没有独立的批前准备阶段，preparationMs 为 0。执行耗时包含有界清理。
- 鼠标 x/y 保留小数，范围为 ±1000000；键盘 char 每步最多 3 个 UTF-16 代码单元，不接受孤立代理项，调用方应按 Unicode 字符边界拆分长文本。commands 最多 32 项，每项最多 128 个字符。每批须闭合自身按下/释放，不允许跨批持键。独立 Agent 操作仍持有输入保活状态时，序列返回 INPUT_STATE_BUSY，不接管其持键状态。
- Promise 入队前参数错误会 reject；已接受任务返回 completed/cancelled/failed。结果包含 dispatchedCount、mouseCount、keyCount、lastDispatchedIndex、stoppedIndex、queueMs、preparationMs、executionMs、lateness 的 p50/p95/p99/max 和 cleanup 的 dispatched/failed。零派发的 lastDispatchedIndex 以及正常完成的 stoppedIndex 为 null。取消、超时或失焦不会继续输入，也不会自动重放。
- 配置切换等待 Blink MainThreadEventQueue 的有界原生屏障；超时恢复原配置。新切换可覆盖旧切换，旧调用会返回 VIRTUAL_CURSOR_CONFIGURATION_SUPERSEDED，旧超时不能覆盖较新的配置。屏障证明所覆盖队列的顺序，不把它描述为系统所有通道都已无限排空。

### 不增加页面自动化标识的验收要求

新增方法必须沿用原生输入与浏览器 UI 合成路径，不向 DOM、window、navigator 或页面原型安装自动化属性、节点、脚本或桥接对象；不附加 debugger，不启用 enable-automation、remote-debugging-port、remote-debugging-pipe 等自动化或调试启动参数，不改变 navigator.webdriver。使用相同测试页面比较调用前后的属性、DOM 和相关属性描述符，并检查主进程调试器状态及输入事件 isTrusted。虚拟光标图层、轨迹和诊断状态仅保存在浏览器进程，页面不可通过新增接口读取。

这里的保证范围为“这些方法不引入额外的自动化标识”，不承诺行为分析无法识别轨迹，也不伪造浏览器身份或改写网页的检测结果。验收须分别记录页面标识检查与可信输入检查的实际结果。

### 光标与批量轨迹的性能预算及测量

登记日期：2026-11-03。状态：工程预算，已有下方单次对照测量；下列预算数字不作为二进制已达到的性能指标。

基准场景：Windows 单窗口、64 × 64 实际像素的静态光标图片、硬件加速开启、每秒 1000 个轨迹点、60Hz 合成；再分别测试 15、30、60、120fps 上限和自动模式。区分总点数与每秒点数，1000 点在 1 秒内和在 10 秒内完成属于不同负载。

- 图片原始 RGBA 数据为 `64 × 64 × 4 = 16384` 字节，即 16KiB；实际还包含 NativeImage 快照、纹理对齐、图层和合成器等资源，不以原始图片大小代表总内存增量。高 DPI 下按实际像素尺寸另算。
- 若原生每点结构按 64 至 128 字节预算，1000 点的原生数组约为 62.5 至 125KiB；这是紧凑鼠标结构的预算，混合序列还须计入键盘文本和命令等变长数据。另测 JS 对象、数组复制、队列和统计数据占用，并验证长序列及重复执行后的峰值和回落。
- 可暂给轨迹调度及虚拟光标状态、绘制提交的新增 CPU 工作预留每秒约 10ms，约为 1% 单核时间，作为待验证的设计预算。此预算不包含原有原生输入派发、网页脚本及页面渲染，不保证总 CPU 增量低于 1%，也不预先为 GPU 占用给出百分比。
- 网页输入处理成本单独测量。例如页面实际每秒处理 1000 次移动回调、每次耗时 0.1ms，则仅回调就需约 100ms CPU 时间，即 10% 单核时间；此为条件算例，不是吞吐实测。
- 静态页面可能因光标移动持续唤起合成器，耗电相对静止时增加；已有持续动画页面的增量不同。软件渲染、高 DPI、大图片、多个可见 WebContents 等场景分别记录，不外推单窗口结果。

测量按基线、不启用光标的批量轨迹、相同轨迹启用光标分组对照，分离输入调度、网页处理及可视化增量。覆盖空闲、静态页面持续移动、页面有轻量或重型事件处理、点击拖动、隐藏/最小化、恢复可见和多个 WebContents；记录硬件、系统、电源模式、实际显示刷新率、DPI、图片尺寸、页面负载、构建版本、轨迹内容与持续时间。

记录各进程 CPU 时间、可用的 GPU 时间或占用、内存和 GPU 资源、实际合成与光标更新次数、队列峰值、计划到实际派发的迟到量，以及页面接收和可见显示延迟。15/30/60/120fps 限帧分别比较总资源及延迟，不能把调度迟到、网页回调延迟和光标显示延迟混成一个指标。

确认静止时无光标驱动的周期刷新、隐藏时停止绘制、未启用光标时不保留专用刷新任务；对反复切换帧率、替换图片、取消轨迹和销毁窗口检查资源回落。验收后用实测结果更新预算与限制；不得将预估、设计目标或接口存在性写成性能验证通过。

### Windows 运行验收记录（45.0.0-cloudbypass.4）

Windows 增量构建及类型检查通过。`test/input-sequence.cjs` 共 26/26 项通过；clickSelector 为 9/9，原有 Agent 为 11/11，总计 46 项运行验收通过。原有后台 Agent 的系统前台激活监测为 0 次。

测量环境：Windows 10.0.26100；AMD Ryzen 9 7900X 12-Core Processor，24 个逻辑处理器；主显示器 120Hz，scaleFactor=1.75；硬件合成状态 enabled。实际测试图片源为 16×16 像素、显示尺寸为 16×16 DIP，普通可见窗口和轻量事件记录页；这与上方 64×64 工程预算场景不同。

各档每批均提交并确认派发 1000 步，计划时长 1000ms。绘制数的采样另含结束后的 150ms 最终帧等待，不能视为恰好一秒内的帧数；页面 mousemove 数是浏览器合并后的回调数：

- fps=15：执行 1003.11ms，光标图层更新 16 次，页面 mousemove 697 次；确认派发迟到 p95=11.34ms，max=16.20ms。
- fps=30：执行 1003.25ms，光标图层更新 31 次，页面 mousemove 771 次；确认派发迟到 p95=7.67ms，max=15.56ms。
- fps=60：执行 1006.17ms，光标图层更新 61 次，页面 mousemove 870 次；确认派发迟到 p95=7.20ms，max=8.26ms。
- fps=120：执行 1002.21ms，光标图层更新 122 次，页面 mousemove 912 次；确认派发迟到 p95=7.17ms，max=8.09ms。
- fps=0：执行 1000.55ms，光标图层更新 122 次，页面 mousemove 901 次；确认派发迟到 p95=7.16ms，max=8.12ms。

5 秒组对照：仅输入 5000 步，浏览器进程 CPU 时间 797ms / 5036ms 墙钟；开启 30fps 光标 5000 步，CPU 时间 766ms / 5042ms。单次测量含既有输入路由及浏览器工作，不包含渲染进程/GPU 的总成本，也未独立分离纯调度器 CPU，不能证明每秒 10ms 或低于 1% 单核预算已达到，不能把两组差值当作稳定的光标独占成本。

已验证：隐藏窗口混合可信输入、同进程 iframe/OOPIF/closed Shadow DOM、点击后输入及 Tab 焦点迁移、失焦有界失败、取消与有界清理、队列超时、迟到终止、导航/销毁停止、数组复制、多 WebContents 独立执行、输入阻断独立切换、空闲与隐藏无光标刷新任务、截图隔离和公开类型导入。

截图验收同时使用 Windows 桌面像素、capturePage 裁剪、CDP 全视口和裁剪截图；页面截图取样保持背景像素，桌面像素可见自定义光标。只有隔离的截图验收步骤主动附加 CDP，结束即解除；生产方法不附加 debugger。

自动化标识验收通过：调用前后 window/navigator/Navigator.prototype 属性、webdriver 描述符和 DOM 一致；navigator.webdriver 为 false；生产调用期间无 debugger 附加、无自动化或远程调试启动开关；测试页收到的输入均为 isTrusted。这里验证的是“不新增页面标识”，不承诺行为分析无法识别。

真实输入运行测试通过 Windows 原生消息入口，覆盖鼠标移动/点击、按键/字符以及 WebContents 输入回调拦截；不使用 DOM 合成事件代替原生输入。触摸/笔物理设备、触控板惯性、真实中文 IME 组合及硬件拖放、系统睡眠恢复、其他 DPI 比例及多屏迁移和 GPU 独立开销未在本机自动验收中完整实测。对应入口已接入原生门禁或生命周期处理，但不把代码检查写成全部硬件通道验收通过。Linux/macOS 虚拟光标明确不支持。

复现：使用本版本 electron.exe 启动 `test/input-sequence.cjs`、`test/click-selector.cjs`、`test/agent-automation.cjs`；INPUT_TEST_REPORT 指定结构化结果文件，AGENT_PYTHON 指定 Python 解释器。完整 JSON 结果与构建 manifest 随分发 Release 提供。
