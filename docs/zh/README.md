# CloudBypass Electron 中文定制文档

本目录为 fork 定制功能的中文说明（与仓库根旁 `main/docs` 同步维护）。

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
- [原生浮层与网站信息](./原生浮层.md)：`showPageInfoDialog`、NativePanel 七入口、控件 schema、事件与验收边界。Windows x64 发行版本 [`45.0.0-cloudbypass.5`](https://github.com/ChengHoward/edist/releases/tag/v45.0.0-cloudbypass.5) 已通过编译与验收并在本地镜像提供；Linux 仍为已有 `.2`。
