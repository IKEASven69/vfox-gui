# 贡献指南

感谢参与 vfox-gui 开发！本文档面向维护者和贡献者。

## 开发环境

```bash
# 环境要求
# - Rust 1.70+
# - Node.js 20+
# - pnpm
# - vfox（已配置 shell hook）

pnpm install
pnpm tauri dev       # 启动开发服务器 + 热重载
pnpm tauri build     # 构建生产安装包
```

## 构建

### 标准构建

```bash
pnpm tauri build
# → src-tauri/target/release/bundle/nsis/vfox-gui_x64-setup.exe
```

### 便携版构建

```bash
pnpm tauri build
pwsh scripts/portable.ps1
# → dist-portable/vfox-gui-portable-x64.zip
```

## 发布

> ⚠️ 以下内容仅限仓库维护者。

推送 tag 触发 GitHub Actions 自动构建并发布到 Releases：

```bash
git tag v0.2.0
git push origin v0.2.0
```

发布前需在仓库 **Settings → Secrets and variables → Actions** 中配置：

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | `src-tauri/.tauri/vfox-gui.key` 的内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时的密码 |

⚠️ **私钥必须妥善保管**。私钥丢失后，已安装旧版本的用户将无法收到自动更新。

### 重新生成签名密钥（仅当密钥丢失且无可挽回时）

```bash
pnpm tauri signer generate -w src-tauri/.tauri/vfox-gui.key
# 将输出的公钥填入 tauri.conf.json 的 plugins.updater.pubkey
# 私钥文件已被 .gitignore 忽略，切勿提交
```

注意：换新密钥后，旧版本的用户必须手动重新下载安装新版本，无法通过自动更新升级。

## 项目结构

```
src/
├── constants.ts           # SDK 色板、类型定义、工具函数
├── App.tsx                # 根组件（状态管理 + 业务逻辑）
├── App.css                # Apple 设计令牌 + 全局样式
└── components/
    ├── SdkSidebar.tsx     # 侧边栏（搜索 + SDK 列表）
    ├── SdkDetail.tsx      # 主内容区（已安装 + 可安装版本）
    ├── SettingsPage.tsx   # 设置页（主题 / 更新 / 关于）
    ├── HelpPage.tsx       # 帮助页（使用说明 / 快捷键 / FAQ）
    ├── SnapshotPanel.tsx  # 环境快照（保存 / 恢复）
    ├── ProjectScanner.tsx # 项目 SDK 检测
    ├── VersionTimeline.tsx# 版本时间线
    ├── ScopeSwitch.tsx    # 全局 / 项目作用域切换
    ├── AppleButton.tsx    # 药丸按钮
    ├── ThemeSwitch.tsx    # 主题切换
    ├── GroupedList.tsx    # macOS 分组列表
    ├── ProgressBar.tsx    # 下载进度条
    ├── ConfirmDialog.tsx  # 确认弹窗
    ├── UpdateModal.tsx    # 更新弹窗
    └── ContextMenu.tsx    # 右键菜单
src-tauri/
├── src/
│   ├── main.rs            # Tauri 入口
│   ├── lib.rs             # 插件注册 + 命令注册 + 系统托盘
│   ├── commands.rs        # 后端命令（vfox CLI 调用 + 流式进度 + 快照）
│   └── vfox.rs            # 文件系统读取（已安装版本、符号链接解析）
├── tauri.conf.json        # 窗口 / 打包 / 更新配置
└── capabilities/          # 权限声明
```
