# 计划:全局包管理(查看/卸载 node_modules 等运行时全局包)

> 起因:磁盘占用页显示 nodejs 24.18 占 1.3G,用户却看不到里面是什么——真相是 node 本体 90M + 全局包 1.2G(@opencode 395M、@deepseek-ai/dsh 272M…),GUI 完全不可见也无法清理。目标:**版本详情里展示该版本的全局包清单与体积拆分,支持安全卸载**。

## 现状事实(已勘察,2026-10-01)

- 体积来源:`~/.vfox/cache/nodejs/v-<ver>/nodejs-<ver>/node_modules/`(非活跃版本);活跃版本物化在 `~/.vfox/sdks/nodejs/node_modules`(同一份内容,bin shim 在 sdks 目录)。
- 已有可复用:`commands.rs` 的 `sdk_disk_usage()`/`dir_size()`、`vfox.rs` 的 `vfox_home()`;前端 `SdkDetail.tsx`(版本列表展示)、`ConfirmDialog.tsx`、i18n(zh/en)。
- 已知坑(本机真实发生过):npm 全局树会损坏(npm-prefix.js 丢失→npm 全挂);`npm -g` 只作用于**活跃版本**,对非活跃版本必须 `--prefix`;卸错包会把用户 CLI 工具干掉(如 dsh/pnpm)。

## 设计

### 1. Rust 命令层(src-tauri/src/commands.rs)

```
global_packages(sdk, version) -> Vec<GlobalPackageEntry>
  // nodejs:扫 <ver_dir>/node_modules 顶层 + 各自 package.json(name/version/description/bin),
  //         @scope/ 目录展开为 @scope/name;体积用现有 dir_size()
  // python:<ver_dir>/python.exe -m pip list --format=json(非活跃版本直接跑该路径的解释器)
  // 活跃版本扫 sdks 目录,非活跃扫 cache 目录(与 vfox use 的物化逻辑一致)
  // 返回失败原因(树损坏/解释器缺失)作为 Err 给前端降级显示

global_uninstall(sdk, version, packages, dry_run) -> UninstallResult
  // dry_run=true 只返回将删除的目录/文件/受影响 bin,不执行
  // nodejs:npm remove -g --prefix <ver_dir> <pkgs>;npm 不可用(损坏)时 fallback:
  //        直接删 node_modules/<pkg> + 对应 bin shim(先 dry_run 列出)
  // python:<python.exe> -m pip uninstall -y <pkgs>
```

`GlobalPackageEntry { name, version, bytes, description, bins: Vec<String> }`——**bins 很关键**,是风险提示的依据。

### 2. 前端(src/)

- `SdkDetail.tsx`:版本行展开新增「全局包」子面板——列表(图标可选复用 SDK_ICON 思路/名称/版本/体积/描述),默认按体积降序,顶部汇总条:`运行时本体 90.4 MB · 全局包 1.21 GB · 共 1.3 GB`。
- 多选 checkbox + 批量卸载按钮;走 `ConfirmDialog`,文案包含:将释放的空间、**将消失的命令行工具(bins)**、活跃版本警告。
- `constants.ts` 加 TS 类型;`App.tsx` 加 invoke 封装;`locales/zh.json`/`en.json` 补 key。

### 3. 安全规则(必须做,防用户把工具链卸瘫)

- 禁卸名单直接拒绝:`npm`(nodejs 自身);`pip/setuptools`(python 自身)。
- bins 命中已知关键工具(pnpm/corepack/dsh/opencli…)→ 红色强警告二次确认。
- 每次卸载前先 dry_run,确认框展示实际将删内容;卸载完成自动刷新 `sdk_disk_usage` 与列表。
- node_modules 损坏检测(顶层 npm 目录缺 package.json / npm 命令失败)→ 面板顶部黄条:"该版本全局包树已损坏,建议整版本重装或 vfox uninstall",禁用单包卸载、只给整版本操作(已有 remove_version)。

## 里程碑(每步独立可发)

- **M1 只读展示**(零风险先上):`global_packages` 命令 + SdkDetail 子面板 + 体积拆分汇总。验收:对 24.18 能列出 @opencode 395M/@deepseek-ai 272M…;24.21 显示空态;活跃/非活跃版本路径都正确。
- **M2 卸载**:python 先行(pip 语义最简单);nodejs 走 `npm remove -g --prefix`;dry-run 预览 + 确认 + 禁卸名单。验收:卸一个测试包后体积与列表刷新;卸 dsh 前出现红色警告。
- **M3 打磨**:损坏树降级、批量操作进度、其他运行时(gem/cargo 按同一接口扩展)、可选"全局包体积趋势"。

## 涉及文件

`src-tauri/src/commands.rs`(新命令)、`src-tauri/src/lib.rs`(注册)、`src/constants.ts`(类型)、`src/components/SdkDetail.tsx`(面板)、`src/App.tsx`(invoke/状态)、`src/locales/*`(文案)、复用 `ConfirmDialog.tsx`。
