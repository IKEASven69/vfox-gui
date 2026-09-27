# 发布到 winget（Windows Package Manager）

本目录的 `packaging/winget/` 存放 vfox-gui 的 winget 清单**模板**。目标是让用户可以：

```powershell
winget install IKEASven69.vfox-gui
```

> ⚠️ 本文档描述的是准备与提交流程。**清单模板只在本仓库维护，仓库本身不持有
> winget-pkgs 的直接写权限——一切变更都必须走 PR，且需要包作者（IKEASven69）
> 本人或授权者操作。**

## 前提

1. 版本已通过 `release.yml` 正式发布（tag `v<version>`），Release 里有
   `vfox-gui_<version>_x64-setup.exe`。
2. 本地安装了 [wingetcreate](https://github.com/microsoft/winget-create)
   （`winget install Microsoft.WingetCreate`）并完成 GitHub 登录
   （`wingetcreate token` 或首次提交时浏览器授权）。

## 方式 A：wingetcreate 自动化（推荐）

### 首次提交（新包）

```powershell
wingetcreate new https://github.com/IKEASven69/vfox-gui/releases/download/v<version>/vfox-gui_<version>_x64-setup.exe
```

- wingetcreate 会下载安装器、计算 SHA256，交互式询问 Publisher / Name /
  Description 等元数据——**直接照抄 `packaging/winget/` 里四个模板的对应字段**，
  保持文案一致。
- Identifier 必须填 `IKEASven69.vfox-gui`。**一经合并永久不可更改**，改名只能发新包。
- 确认后 wingetcreate 自动 fork `microsoft/winget-pkgs`、建分支、提交并开 PR
  ——这就是官方的**自动化 PR 模板**流程：PR 标题自动生成为
  `Add IKEASven69.vfox-gui version <version>`，PR 描述使用 winget-pkgs 的
  标准模板（新包需勾选 "New package" 等检查项），无需手工排版。

### 后续版本更新

```powershell
wingetcreate update IKEASven69.vfox-gui -u https://github.com/IKEASven69/vfox-gui/releases/download/v<version>/vfox-gui_<version>_x64-setup.exe -v <version>
```

- 自动定位上一个版本的清单、替换版本号 / URL / SHA256，同样走自动化 PR。
- 本地校验生成的清单：`winget validate --manifest <清单目录>`。

## 方式 B：手动提交

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)，从
   `master` 拉分支（命名习惯 `version-<version>`）。
2. 新建目录（路径首字母按 Identifier 首字母分桶）：
   `manifests/i/IKEASven69/vfox-gui/<version>/`
3. 把 `packaging/winget/` 的四个 YAML 复制进去，替换所有占位：
   - 全部文件的 `PackageVersion`（以 `src-tauri/tauri.conf.json` 为准）
   - `installer` 清单的 `InstallerUrl` / `InstallerSha256`（计算方法见文件头注释）
4. 本地验证：`winget validate --manifest manifests/i/IKEASven69/vfox-gui/<version>`
   （也可用 `winget settings` 开发者模式后 `winget install --manifest` 实测安装）。
5. Commit 信息用约定格式：`Add IKEASven69.vfox-gui version <version>`（更新时
   用 `New version: <version>`）。
6. 向 `microsoft/winget-pkgs@master` 发 PR，按仓库 PR 模板勾选对应项。
   提交后 Azure Pipeline 会自动验证清单，通过后由维护者/自动化审核合并
   （新包通常几小时到几天）。

## 注意事项（踩坑清单）

| 事项 | 说明 |
|------|------|
| **版本一致性** | `PackageVersion` = `tauri.conf.json` 的 `version` = release tag 去掉 `v`。三处不一致会在 `release.yml` 的 tag 校验或 winget 验证中失败 |
| **URL 永久性** | `InstallerUrl` 必须用带版本号的 `releases/download/v<version>/…`，禁止 `releases/latest/download/…`（会漂移，审核必打回） |
| **只放 Windows 资产** | winget 只收 Windows 安装器；macOS 的 `*.dmg` / `*.app` 不进 winget，走 Release 页分发 |
| **静默安装** | Tauri 的 NSIS 安装器原生支持 `/S`（安装/卸载），winget 无需 `InstallerSwitches` |
| **Scope** | `installMode: currentUser` → 清单里 `Scope: user`；将来若加 `both` 模式需拆成 user/machine 两个 installer 条目 |
| **ProductCode 等** | 不要手填 `ProductCode` / `AppsAndFeaturesEntries`，让 wingetcreate 抓真实注册表值；填错会破坏升级链 |
| **提交后** | 合并有延迟属正常；重复提交同一版本会被拒——版本一旦入库不可覆盖，只能发新版本 |

## 相关分发渠道备忘

- **macOS**：Release 的 `*.dmg` 直接下载安装。当前未配置 Apple 开发者证书，
  dmg 未签名——首次打开需右键 → 打开绕过 Gatekeeper；签名/公证（`APPLE_*`
  secrets）是后续工作（见 `release.yml` 内注释）。
- **自动更新**：winget 渠道安装的应用同样受应用内更新器管理（`latest.json`），
  两套更新互不冲突，但建议文档引导用户只用其一。
