# DSH-GUI

[![GitHub](https://img.shields.io/badge/GitHub-kipozannaki%2Fdsh--gui-4F8CFF?style=flat-square&logo=github)](https://github.com/kipozannaki/dsh-gui)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/kipozannaki/dsh-gui?style=flat-square)](https://github.com/kipozannaki/dsh-gui/releases)

DeepSeek Harness 的 Windows 桌面客户端 —— **开箱即用**：自动复用系统 Node.js（版本符合要求时免内置运行时），否则使用内置 Node；通过 `npx @deepseek-ai/dsh web` 直接运行上游最新版，无需手动安装任何东西。

> 💡 **macOS 版本正在开发中**，敬请期待。

> 界面：深色现代风格（参考 Codex / Claude Code 设计语言），左侧边栏 + 顶部状态栏 + 嵌入的 DSH Web UI。

## ✨ 功能特性

- 🟢 **自动运行时管理**：优先检测并复用系统 Node.js（≥ 22.19.0 时跳过内置运行时），不满足或缺失时自动使用内置 Node（≥ 22.19.0）；DSH 通过 `npx @deepseek-ai/dsh web` 启动，首次运行自动下载（全程可视化进度）
- 🚀 **免浏览器**：启动后自动在 `127.0.0.1` 拉起 `dsh web` 服务并直接嵌入窗口；端口 3080 被占用时自动改用空闲端口；窗口关闭自动终止 DSH 子进程（进程树清理，不留孤儿）
- 🪟 **桌面 GUI**：Electron 原生窗口，深色现代风格（参考 Codex / Claude Code）；左侧边栏（会话 / 工作区 / 日志）、顶部状态栏（服务状态实时反馈：启动中 / 运行中 / 已停止 / 错误）、自定义窗口控制
- 🎨 **换肤（壁纸透出）**：5 套预设背景主题 + 自定义图片上传；DSH 界面所有白色区域自动透明化，壁纸完整透出而文字保持清晰；「界面透出强度」0-100% 可调，页面切换/动态渲染不失效
- 🖥️ **托盘常驻**：关闭窗口最小化到系统托盘，后台服务继续运行；托盘菜单：显示主窗口 / 在浏览器中打开 / 查看日志 / 完全退出
- 🌏 **国内用户优化**：内置 npmmirror 镜像加速开关（默认开启），npx 下载 DSH 走国内镜像
- 🔑 **首次使用引导**：自动检测 API Key 是否已配置，未配置时提示前往设置页
- 🧩 **npx 集成与一键更新**：DSH 走 npx 本地缓存（启动快、可离线、与用户自己运行的 npx 共享缓存）；上游发新版后，在「设置 → 更新 / 重装 DSH」一键清除缓存并自动重新下载最新版

## 📦 安装与分发

👉 **下载地址**：[GitHub Releases](https://github.com/kipozannaki/dsh-gui/releases)（`DSH-GUI-Setup-1.1.0.exe` / `DSH-GUI-Portable-1.1.0.exe`）

| 产物 | 说明 |
| --- | --- |
| `DSH-GUI-Setup-1.1.0.exe` | NSIS 安装版：安装到系统，自动创建桌面快捷方式与开始菜单快捷方式，可自定义安装目录；数据存于 `%APPDATA%\DSH-GUI\` |
| `DSH-GUI-Portable-1.1.0.exe` | 便携版：免安装、双击即用，可放 U 盘；数据存于 exe 同目录的 `data\` 文件夹 |

卸载：安装版通过「控制面板 / 设置 → 应用」完整卸载程序文件；数据目录默认保留（可选手动删除 `%APPDATA%\DSH-GUI`）。

## 🛠️ 从源码构建

要求：Node.js ≥ 22（本机已装 Node 即可构建；最终产物内置自己的运行时）。

```powershell
# 1. 安装依赖（国内镜像加速）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install

# 2. 下载内置 Node 运行时（v22.x ≥ 22.19.0）
npm run fetch:node

# 3. 生成图标
npm run icons

# 4. 构建（NSIS 安装版 + 便携版）
npm run dist
# 单独构建：npm run dist:installer / npm run dist:portable

# 开发模式运行（不打包）
npm start
```

产物位于 `dist/`：`DSH-GUI-Setup-1.1.0.exe`、`DSH-GUI-Portable-1.1.0.exe`。

## 🧭 首次使用

1. 双击运行 DSH-GUI（安装版或便携版均可）
2. 首次启动通过 npx 自动下载 DSH 最新版——进度条实时显示
3. 服务就绪后自动加载 DSH Web UI，若未配置 API Key 会弹出引导横幅
4. 配置 API Key 后即可开始使用

## 🔧 数据目录

| 模式 | 位置 |
| --- | --- |
| 便携版 | exe 同目录 `data\`（`config.json` 设置、`dsh-home\` DSH 主目录、`logs\` 日志、`themes\` 背景图） |
| 安装版 | `%APPDATA%\DSH-GUI\`（同上结构） |

在「设置 → 服务」中可一键打开数据 / 日志 / DSH 主目录。

## 📄 技术说明

- **桌面框架**：Electron + electron-builder（NSIS 安装版 + portable 便携版）
- **Node 运行时**：启动时探测系统 Node，版本 ≥ 22.19.0 直接复用（npm/npx 同步跟随系统）；否则使用内置运行时（`scripts/fetch-node.mjs` 从 npmmirror 下载官方 Node win-x64 并只解出运行所需文件）
- **DSH 集成**：`main.js` 用 `child_process` 启动 `dsh web --host 127.0.0.1 --port N`；有 npx 缓存时直接运行缓存中的 `@deepseek-ai/dsh`（等价于 `npx @deepseek-ai/dsh web` 解析到的结果，免网络、秒启动、可离线），无缓存时通过 npx 自动下载；端口固定并持久化（保证登录态不丢），被占用时自动改用空闲端口；`DSH_HOME` 优先复用用户 `~/.dsh`（配置 / API Key / 会话与官方 CLI 一致）
- **版本跟随**：不锁定版本，npx 下载最新版后走本地缓存；上游发新版后，在「设置 → 更新 / 重装 DSH」一键清除缓存并自动重新下载最新版
- **安全**：渲染层 `contextIsolation` + 无 `nodeIntegration`，仅通过 preload 桥接白名单 IPC；DSH Web UI 以 `<webview partition="persist:dsh-gui-web">` 隔离加载
- **图标**：`scripts/make-icon.ps1` 使用 GDI+ 抗锯齿绘制（蓝紫渐变 + 字母 + 光泽）

## 📝 更新记录

### v1.1.0（2026-08-20）

**DSH 启动方式全面升级：跟随上游最新版 + 一键更新**

- 🔄 **去版本锁定**：不再锁定 `@deepseek-ai/dsh@0.1.0-rc.6`，统一改为通过 `npx @deepseek-ai/dsh web` 启动官方最新版；复用 npx 本地缓存（启动快、可离线、与用户自己运行的 npx 共享缓存），有缓存时直接运行缓存版本，无需每次联网解析
- 🆕 **「更新 / 重装 DSH」按钮**：位于「设置 → 服务」，一键清除 npx 中的 DSH 缓存并自动重新下载最新版、重启服务——上游发新版后无需等客户端更新
- 📊 **首次运行下载进度可视化**：通过 npx 获取 DSH 时，安装覆盖层实时显示下载进度
- 🏷️ **版本号展示**：About 与底部状态栏显示 DSH 实际版本号（来自 npx 缓存中的 `package.json`）
- 🔧 **端口识别放宽**：不再依赖上游特定输出格式，宽松匹配 `127.0.0.1:<端口>` 即视为就绪，兼容上游输出变化
- 🗑️ **旧版残留清理**：启动时自动清理旧方案残留的 `dsh-runtime` 目录

**重大修复（承接 v1.0.0 之后的修复）**

- 🔑 **复用用户 `~/.dsh` 配置**：DSH 主目录优先指向用户已有的 `~/.dsh`，已配置的 API Key / 会话直接生效，不再重复输入
- 🔐 **服务端口持久化**：实际启动端口固定并持久化保存，DSH 前端登录态（localStorage 按 origin 存储）重启后不丢失

**其他**

- 移除调试用 `cdp-diag` 脚本；README 注明 macOS 版本开发中；CI Release 已存在时跳过覆盖更新

## 🤝 开源协议

[MIT](LICENSE)，与上游 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）保持一致。

## 🔗 相关链接

- **本项目仓库**：[github.com/kipozannaki/dsh-gui](https://github.com/kipozannaki/dsh-gui)（Issues / PR 欢迎）
- **Release 下载**：[github.com/kipozannaki/dsh-gui/releases](https://github.com/kipozannaki/dsh-gui/releases)
- **上游项目**：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

## ⚠️ 免责声明

本项目为社区开源项目，与 DeepSeek 官方无隶属关系；DSH 本体（`@deepseek-ai/dsh`）版权归其原作者所有。
