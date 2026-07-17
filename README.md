# vfox-gui

[![License](https://img.shields.io/github/license/IKEASven69/vfox-gui)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-ffc131?logo=tauri)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)

[vfox](https://github.com/version-fox/vfox) 版本管理器的桌面图形界面。浏览所有可安装的 SDK、一键安装/卸载/切换版本，再也不用记 CLI 命令。

<!-- 截图占位：截一张应用界面图保存为 public/screenshot.png 后取消注释
<p align="center">
  <img src="public/screenshot.png" alt="vfox-gui screenshot" width="720" />
</p>
-->

## ✨ 功能

- **📦 SDK 浏览**：侧边栏列出所有 vfox 支持的 SDK（Node.js、Python、Go、Rust、Java…），官方插件带 `官方` 标识
- **⚡ 一键操作**：安装、卸载、切换版本 —— 全部在 UI 中完成，安装时实时显示下载进度
- **🔍 模糊搜索**：侧边栏搜 SDK，详情页搜版本（支持 `lts`、`installed` 等标签）
- **💾 环境快照**：保存当前 SDK 版本组合，一键恢复（支持单 SDK 或全量）
- **📊 磁盘占用**：每个已安装版本旁显示磁盘大小
- **🎯 项目级切换**：选择项目目录，版本写入 `.tool-versions`，仅对该项目生效
- **📂 扫描项目**：选择项目目录，自动检测需要的 SDK（package.json→Node.js、go.mod→Go、Cargo.toml→Rust…），一键安装缺少的
- **🕘 项目版本历史**：记录项目每次切换版本的时间线，回溯 SDK 版本演进
- **🌓 暗色模式**：浅色 / 深色 / 跟随系统，自动记忆
- **🔄 自动更新**：内置应用更新 + vfox CLI 更新
- **🍎 Apple 设计**：圆角卡片、毛玻璃侧边栏、仅一个蓝色强调色

## 📥 安装

### 方式一：安装包（推荐）

从 [Releases](https://github.com/IKEASven69/vfox-gui/releases) 下载 `*-setup.exe`，双击安装。

### 方式二：便携版

从 Releases 下载 `*-portable-x64.zip`，解压后双击 `vfox-gui.exe` 即可运行。无需安装，不写注册表，可放 U 盘。

### 前提条件

- 已安装 [vfox](https://github.com/version-fox/vfox) 并至少添加了一个插件
- Windows 10+ (64-bit)

> 没装 vfox？打开 vfox-gui 后会提示并提供安装链接。

## 🛠️ 从源码运行

```bash
pnpm install
pnpm tauri dev       # 启动开发服务器 + 热重载
```

需要 Rust 1.70+、Node.js 20+、pnpm。详细的项目结构与构建说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 技术栈

| 层 | 技术 |
|----|------|
| 桌面框架 | [Tauri 2](https://tauri.app) (Rust) |
| UI | [React 19](https://react.dev) + TypeScript |
| 样式 | [Tailwind CSS v4](https://tailwindcss.com) + CSS 自定义属性 |
| 构建 | [Vite 7](https://vite.dev) |

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl` / `Cmd` + `F` | 聚焦 SDK 搜索框 |
| `Ctrl` / `Cmd` + `,` | 打开设置 |
| `Ctrl` / `Cmd` + `/` | 打开帮助 |
| `Esc` | 关闭弹窗 |

## 🤝 贡献

欢迎提交 Issue 和 PR。开发与发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 📄 License

MIT © [vfox-gui contributors](https://github.com/IKEASven69/vfox-gui/graphs/contributors)
