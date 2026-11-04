# CloudBypass Electron 中文定制文档

本目录为 fork 定制功能的中文说明（与仓库根旁 `main/docs` 同步维护）。

2026-11-04 Windows x64 发行版本为 [`45.0.0-cloudbypass.6`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.6)，本地镜像已提供，安装验证及附件见该版本发布记录。Linux x64 仍使用已有 `45.0.0-cloudbypass.2`；本次不提供 Linux 或 macOS `.6` 包。

| 文档 | 说明 |
|------|------|
| [定制开发编译与更新.md](./定制开发编译与更新.md) | **流程**：改源码、Windows/Linux 编译、发布与升大版本 |
| [定制Electron功能说明.md](./定制Electron功能说明.md) | API、行为、补丁与源码索引 |
| [定制变更简述.md](./定制变更简述.md) | 变更时间线索引 |
| [定制变更详细.md](./定制变更详细.md) | 按次实现背景与验证 |
| [Sec-CH-UA生成逻辑.md](./Sec-CH-UA生成逻辑.md) | 默认 Client Hints 生成算法 |
| [私有镜像.md](./私有镜像.md) | 私有 npm / 二进制镜像 |

英文上游风格 API 文档仍见 `docs/api/`。

- [无需 CDP 的 Agent 自动化](./Agent自动化.md)：页面快照、语义查找、后台可信输入、原生虚拟光标及批量鼠标键盘时间线。
- [原生浮层与网站信息](./原生浮层.md)：Windows x64 `.5` 的历史接口与验收记录，包含 `showPageInfoDialog`、NativePanel 七入口、控件 schema、事件与验收边界。
- [原生界面与菜单定制规划](./原生界面定制规划.md)：PageInfo 本地化、NativePanel 样式、地址建议、下载和悬浮输入，以及独立原生 Menu 样式与行内控件的范围、参考图和验收要求。
- [原生界面定制实现与测试](./原生界面定制实现与测试.md)：Windows `.6` 对应的 NativePanel 样式、原生 Menu 行内控件、Chromium 原版证书查看器及实机截图。安装验证及附件见 [`.6` 发布记录](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.6)。
- [原生多行便笺](./原生多行便笺.md)：早期 Textarea 预览的接口、示例及历史验收；后续随 Windows `.7` 提供，最新整体记录见下一项。
- [原生亚克力与滚动条](./原生亚克力与滚动条.md)：Windows [`45.0.0-cloudbypass.7`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.7) 的 Textarea、系统亚克力、细滚动条与 `overlay`／`gutter` 位置配置；验收通过，准备发布。已发布 `.6` 不包含这些新增能力。
