// Tauri commands — the bridge between the React frontend and the Rust backend.
//
// Read commands hit the filesystem directly (see `vfox` module); action
// commands shell out to the `vfox` CLI because those mutate state and must go
// through vfox's own logic (symlink updates, env var writes, etc.).
//
// A wrinkle: `vfox use` always tries to spawn a new interactive shell after
// applying its change, which fails (exit 125) when run non-interactively from
// a GUI process. That failure is harmless — the version switch already
// succeeded — so we treat it as success rather than an error.

use crate::vfox::{self, Sdk};
use serde::Serialize;
use std::path::Path;
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// How long the `vfox available` result stays cached. `vfox available` hits
/// the network (it queries the plugin registry), so on every sidebar refresh
/// it would otherwise stall the UI for a second or two. Five minutes is a good
/// trade-off: fresh enough to see newly published plugins, cheap enough that
/// navigating around the app stays instant.
const AVAILABLE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

/// Cached output of `vfox available` + the time it was fetched. Mutex-wrapped
/// so concurrent reads from the frontend are safe; lazily initialized.
static AVAILABLE_CACHE: Mutex<Option<(Instant, Vec<AvailableSdk>)>> = Mutex::new(None);

/// Frontend event name for streaming install progress.
pub const INSTALL_PROGRESS_EVENT: &str = "vfox://install-progress";

/// 安装取消槽：记录当前**所有**正在安装的 vfox 子进程 PID，供
/// `cancel_install` 杀进程用。Arc 包一层是因为 `install_version` 的
/// spawn_blocking 闭包需要 'static 生命周期，State 的借用进不去。
/// busy 收窄后允许对不同 SDK 并发安装——单槽只留最后登记的 PID，
/// 取消时第一个安装就永远杀不到了，所以是集合。
#[derive(Default)]
pub struct InstallSlot(std::sync::Arc<Mutex<std::collections::HashSet<u32>>>);

impl InstallSlot {
    /// 克隆内部句柄，供移进后台线程的闭包使用。
    fn handle(&self) -> std::sync::Arc<Mutex<std::collections::HashSet<u32>>> {
        std::sync::Arc::clone(&self.0)
    }
}

/// 取消当前安装：把槽里登记的所有安装进程整棵杀掉（vfox 可能带起
/// 解压/安装器子进程，`/T` 必须带）。并发安装时一并取消——进度条只有
/// 一条，取消语义就是「停掉正在跑的安装」。返回是否真的杀了（没有
/// 正在运行的安装时返回 false，前端据此作废取消意图）。
#[tauri::command]
pub fn cancel_install(slot: tauri::State<'_, InstallSlot>) -> Result<bool, String> {
    // 先原子取走全部 PID 再杀：杀的过程中新登记的安装不会被误杀，
    // 已取走 PID 的安装结束后再 remove 也只是 no-op。
    let pids = {
        let mut guard = slot.0.lock().map_err(|_| "安装状态锁中毒".to_string())?;
        std::mem::take(&mut *guard)
    };
    if pids.is_empty() {
        return Ok(false);
    }
    for pid in pids {
        kill_pid(pid);
    }
    Ok(true)
}

/// 杀掉整棵进程树。Windows 用 taskkill /T /F（也复用于安装超时分支），
/// 其他平台退回 `kill -9`。
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = spawn_quiet("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    #[cfg(not(windows))]
    let _ = spawn_quiet("kill").arg("-9").arg(pid.to_string()).output();
}

/// One progress update emitted to the frontend during `vfox install`.
/// `phase` distinguishes download (with a percent) from post-download steps
/// (extract/install) that vfox reports without a number.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InstallProgress {
    pub percent: Option<u8>,
    pub speed: Option<String>,
    pub phase: String,
    pub message: Option<String>,
}

/// Every SDK vfox manages, with installed versions and the current pick.
/// async + spawn_blocking：Tauri 2 里同步 command 默认在主线程执行，而这个
/// 命令要 read_dir 整个 plugin+cache 树——冷启动或杀软实时扫描时会卡 UI。
/// 成功路径返回 Vec（前端无需处理 Result），仅 JoinError 走 Err。
#[tauri::command]
pub async fn list_sdks() -> Result<Vec<Sdk>, String> {
    tauri::async_runtime::spawn_blocking(vfox::list_sdks)
        .await
        .map_err(|e| format!("后台任务失败: {}", e))
}

/// Switch the active version: `vfox use <sdk>@<version>`.
///
/// Runs `vfox use --global` to update the system registry (always — the GUI
/// has no shell hook, so `--project` would be ignored by vfox anyway). For
/// project scope we additionally write a `.tool-versions` file into the
/// user-chosen project directory so IDEs / terminal sessions pick it up.
/// See module docs on why a non-zero exit may still be a success.
#[tauri::command]
pub async fn use_version(
    sdk: String,
    version: String,
    scope: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let target = format!("{}@{}", sdk, version);
    let is_project = scope == "project";
    let proj_dir = project_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        // Project scope: ONLY write .tool-versions — do NOT touch the global
        // version. The .tool-versions file is the standard project-level pin
        // that IDEs and vfox-hooked shells read. Changing global here would
        // contradict the UI promise "仅对该项目生效（不影响全局版本）".
        if is_project {
            return match proj_dir {
                Some(ref dir) => {
                    if let Err(e) = write_tool_versions(dir, &sdk, &version) {
                        return Err(format!("项目 .tool-versions 写入失败: {}", e));
                    }
                    // Record this version change in the project history.
                    let _ = append_history(dir, &sdk, &version);
                    Ok(format!("已为项目设置 {}@{}", sdk, version))
                }
                None => Err("未选择项目目录".to_string()),
            };
        }

        // Global scope: run `vfox use --global` to update the registry/symlink.
        let result = run_vfox(&["use", &target, "--global"], /*tolerate_shell_err*/ true);

        result
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Write or update a `.tool-versions` file in the project directory.
/// Format: `<sdk> <version>`, one per line. Existing entries for other SDKs
/// are preserved; the entry for `sdk` is replaced if it already exists.
///
/// 写入必须原子化且读失败必须中止：旧实现 `File::open` 失败时静默拿到空
/// 列表再截断重写，会把其他 SDK 的条目全部抹掉（杀软/IDE 短暂持锁时触发）。
fn write_tool_versions(dir: &str, sdk: &str, version: &str) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let path = std::path::Path::new(dir).join(".tool-versions");

    let mut lines: Vec<String> = Vec::new();
    let mut found = false;
    if path.exists() {
        // 读失败直接报错中止，绝不带着空列表去截断重写
        let file = std::fs::File::open(&path)
            .map_err(|e| format!("无法读取现有 .tool-versions（为防清空已中止写入）: {}", e))?;
        for line in std::io::BufReader::new(file).lines() {
            let line = line.map_err(|e| format!("读取 .tool-versions 出错: {}", e))?;
            // 去掉可能存在的 BOM（否则首行条目匹配不上，会追加出重复行）
            let line = line.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(line);
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                lines.push(line);
            } else if trimmed.split_whitespace().next() == Some(sdk) {
                lines.push(format!("{} {}", sdk, version));
                found = true;
            } else {
                lines.push(line);
            }
        }
    }
    if !found {
        lines.push(format!("{} {}", sdk, version));
    }

    let mut content = String::new();
    for l in &lines {
        content.push_str(l);
        content.push('\n');
    }
    // 先写临时文件再 rename（Windows 上 fs::rename 会替换既有文件），
    // 中途崩溃/断电只会留下 .tmp 残留，不会留下半个清单
    let tmp = path.with_extension("tool-versions.tmp");
    {
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| format!("无法创建临时文件 {}: {}", tmp.display(), e))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("写入 .tool-versions 失败: {}", e))?;
        file.flush().map_err(|e| format!("刷新 .tool-versions 失败: {}", e))?;
    }
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("替换 .tool-versions 失败（内容保留在 {}）: {}", tmp.display(), e))?;
    Ok(())
}

/// Append a version-change event to the project's `.vfox-history.json`.
/// Each entry records which SDK switched to which version, when, and from
/// what previous version (if any). This powers the "project version timeline"
/// view — the evolution of SDK versions a project has used over time.
fn append_history(dir: &str, sdk: &str, version: &str) -> Result<(), String> {
    let path = std::path::Path::new(dir).join(".vfox-history.json");
    let now = chrono_now();

    // Read existing entries (array of objects), or start fresh.
    let mut entries: Vec<serde_json::Value> = read_json_file(&path)
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();

    // Find the previous version for this SDK (last entry with same sdk name).
    let prev = entries
        .iter()
        .rev()
        .find(|e| e.get("sdk").and_then(|s| s.as_str()) == Some(sdk))
        .and_then(|e| e.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()));

    // Only record if the version actually changed (skip no-op switches).
    if prev.as_deref() == Some(version) {
        return Ok(());
    }

    let mut entry = serde_json::Map::new();
    entry.insert("sdk".into(), serde_json::Value::String(sdk.into()));
    entry.insert("version".into(), serde_json::Value::String(version.into()));
    entry.insert("date".into(), serde_json::Value::String(now));
    if let Some(p) = prev {
        entry.insert("from".into(), serde_json::Value::String(p));
    }
    entries.push(serde_json::Value::Object(entry));

    // Cap history at 200 entries to keep the file bounded.
    if entries.len() > 200 {
        entries = entries.split_off(entries.len() - 200);
    }

    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化历史失败: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("写入历史失败: {}", e))?;
    Ok(())
}

/// Current **local** timestamp as "YYYY-MM-DD HH:MM".
///
/// 此前手写历法算法输出的是 UTC——UTC+8 用户的项目版本时间线全部差
/// 8 小时，函数名却叫 chrono_now 暗示本地时间。用 chrono 的 Local 修正。
fn chrono_now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// Install a new SDK version: `vfox install <sdk>@<version>`.
///
/// Unlike the other commands, this one streams `vfox`'s download progress to
/// the frontend via [`INSTALL_PROGRESS_EVENT`], because downloads can take
/// minutes and a bare spinner gives no feedback. vfox writes its progress bar
/// to stderr as `\r`-delimited segments like
///   `Downloading...  42% [====>] (385 kB/s) [37s:47s]`.
///
/// **Post-install verification**: vfox can exit 0 yet fail to install (e.g. a
/// version listed by `vfox search` has no Windows installer — it prints
/// "failed to install" but returns success). So after the command returns we
/// re-read the filesystem and error if the version didn't actually land.
#[tauri::command]
pub async fn install_version(
    app: AppHandle,
    slot: tauri::State<'_, InstallSlot>,
    sdk: String,
    version: String,
) -> Result<String, String> {
    let target = format!("{}@{}", sdk, version);
    let sdk_check = sdk.clone();
    let version_check = version.clone();
    // 取消槽句柄随闭包进后台线程：run_vfox_streaming 在 spawn 后登记
    // PID，退出前清掉，保证槽里永远只有"正在跑"的 PID。
    let cancel_slot = slot.handle();
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_vfox_streaming(&["install", &target], true, &app, &cancel_slot)?;
        // vfox exits 0 even on failure — verify the version actually exists on
        // disk now. If it doesn't, surface the real error instead of pretending
        // success (the "安装显示成功但实际没装上" bug).
        let installed = crate::vfox::list_sdks()
            .into_iter()
            .find(|s| s.name == sdk_check)
            .map(|s| s.installed.iter().any(|v| v.version == version_check))
            .unwrap_or(false);
        if installed {
            Ok(out)
        } else {
            // Extract the meaningful error line from vfox's output if present.
            let detail = out
                .lines()
                .find(|l| l.contains("failed to install") || l.contains("error"))
                .unwrap_or("版本可能不存在或没有对应平台的安装包");
            Err(format!("安装失败: {}", detail))
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Remove an installed version: `vfox remove <sdk>@<version>`.
///
/// Passes `-y` so vfox skips its interactive confirmation — in a GUI there's
/// no stdin to confirm with, so without it vfox prints the "use -y" warning
/// and does nothing (the "卸载没反应" bug). When vfox itself reports the
/// version as "not installed" (a known vfox inconsistency for partially-
/// installed/orphaned versions), we fall back to deleting the cache dir
/// directly so the UI still reflects reality.
#[tauri::command]
pub async fn remove_version(sdk: String, version: String) -> Result<String, String> {
    let target = format!("{}@{}", sdk, version);
    let sdk_for_fallback = sdk.clone();
    let version_for_fallback = version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // `vfox uninstall` is the SDK version removal command (NB: `vfox remove`
        // deletes the whole plugin). It needs no confirmation flag.
        let out = run_vfox(&["uninstall", &target], false);
        // Fallback: vfox's registry can disagree with the filesystem for
        // partially-installed/orphaned version dirs (uninstall reports an error
        // but the dir still exists). If so, remove the dir directly so the
        // version disappears from `list_sdks` (which reads the filesystem).
        // 超时等与"未安装"状态不一致无关的失败不做直删兜底——绕过 vfox
        // 注册表删目录会造成 GUI 与 CLI 显示分裂。
        if let Err(e) = &out {
            if !e.contains("超时") {
                let dir = crate::vfox::vfox_home()
                    .join("cache")
                    .join(&sdk_for_fallback)
                    .join(format!("v-{}", version_for_fallback));
                if dir.exists() {
                    let _ = std::fs::remove_dir_all(&dir);
                    return Ok(format!("已清理残留目录: {}", dir.display()));
                }
            }
        }
        out
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Add a new plugin: `vfox add <name>`.
///
/// Note: `vfox add` accepts NO flags (`-y` is rejected with "flag provided
/// but not defined"). It is non-interactive when the plugin name resolves, so
/// no confirmation skip is needed.
#[tauri::command]
pub async fn add_plugin(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_vfox(&["add", &name], false))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Remove an SDK plugin: `vfox remove <name>`. `-y` skips the prompt.
/// Only removes the plugin metadata — installed versions stay on disk
/// so the user can re-add the plugin later without re-downloading.
#[tauri::command]
pub async fn remove_plugin(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_vfox(&["remove", &name, "-y"], false))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Calculate total disk usage (bytes) for each installed SDK version.
/// Walks `cache/<sdk>/v-<version>/` directories, summing file sizes.
/// Returns a flat map of "<sdk>@<version>" → bytes, sorted largest first.
#[tauri::command]
pub async fn sdk_disk_usage() -> Result<Vec<DiskUsageEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let home = crate::vfox::vfox_home();
        let cache = home.join("cache");
        let mut entries: Vec<DiskUsageEntry> = Vec::new();

        let sdk_dirs = match std::fs::read_dir(&cache) {
            Ok(d) => d.filter_map(|e| e.ok()).collect::<Vec<_>>(),
            Err(_) => return Ok(entries),
        };

        for sdk_entry in sdk_dirs {
            let sdk_path = sdk_entry.path();
            if !sdk_path.is_dir() {
                continue;
            }
            let sdk_name = match sdk_path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };

            let ver_dirs = match std::fs::read_dir(&sdk_path) {
                Ok(d) => d.filter_map(|e| e.ok()).collect::<Vec<_>>(),
                Err(_) => continue,
            };

            for ver_entry in ver_dirs {
                let ver_path = ver_entry.path();
                if !ver_path.is_dir() {
                    continue;
                }
                let dirname = match ver_path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                // Only count `v-<version>` directories.
                let version = match dirname.strip_prefix("v-") {
                    Some(v) => v.to_string(),
                    None => continue,
                };

                let bytes = dir_size(&ver_path);
                entries.push(DiskUsageEntry {
                    sdk: sdk_name.clone(),
                    version,
                    bytes,
                });
            }
        }

        // Sort largest first.
        entries.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        Ok(entries)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Recursively sum the size of all files under a directory.
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() {
                total += dir_size(&p);
            } else if let Ok(meta) = p.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// A single disk-usage row returned to the frontend.
#[derive(Debug, serde::Serialize)]
pub struct DiskUsageEntry {
    pub sdk: String,
    pub version: String,
    pub bytes: u64,
}

/// Update the vfox CLI itself via `vfox upgrade`.
///
/// `vfox upgrade` rewrites the binary in place and is non-interactive (no
/// flags). NB: `vfox update` is the *plugin* update command and rejects
/// `--yes`; the self-update command is `vfox upgrade`. Runs with a longer
/// timeout (120s) because the download can be slow.
#[tauri::command]
pub async fn vfox_update() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        run_vfox_with_timeout(&["upgrade"], false, Duration::from_secs(120))
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Return version info for the About panel: the app version (compiled in from
/// Cargo) and the installed vfox CLI version (parsed from `vfox --version`).
#[derive(Debug, serde::Serialize)]
pub struct VersionInfo {
    pub app: String,
    pub vfox: String,
}

#[tauri::command]
pub async fn app_version() -> Result<VersionInfo, String> {
    let app = env!("CARGO_PKG_VERSION").to_string();
    let vfox = tauri::async_runtime::spawn_blocking(|| {
        // `vfox --version` prints "vfox version 1.0.11". Take the last token.
        run_vfox(&["--version"], false)
            .ok()
            .and_then(|s| s.split_whitespace().last().map(|s| s.to_string()))
            .unwrap_or_else(|| "未知".to_string())
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?;
    Ok(VersionInfo { app, vfox })
}

/// Every SDK vfox *can* manage (from `vfox available`), with whether the
/// plugin is already installed. Used to populate the sidebar so users can add
/// new SDK types without touching the CLI.
///
/// Results are cached for [`AVAILABLE_CACHE_TTL`] because `vfox available` is a
/// network call; `installed` flags are recomputed each time from the filesystem
/// (cheap) so the cache never shows a stale install state.
#[tauri::command]
pub async fn list_available_sdks() -> Result<Vec<AvailableSdk>, String> {
    // Serve from cache if fresh.
    if let Ok(guard) = AVAILABLE_CACHE.lock() {
        if let Some((fetched_at, cached)) = guard.as_ref() {
            if fetched_at.elapsed() < AVAILABLE_CACHE_TTL {
                return Ok(recompute_installed(cached));
            }
        }
    }
    fetch_available(/*force*/ false).await
}

/// Force a refresh of the available-SDK cache, bypassing the TTL. The frontend
/// can call this after adding a plugin (so the new plugin appears immediately)
/// or from a manual "refresh" action.
#[tauri::command]
pub async fn refresh_available() -> Result<Vec<AvailableSdk>, String> {
    fetch_available(/*force*/ true).await
}

/// Run `vfox available`, parse it, cache the raw plugin list, and return the
/// list with live `installed` flags. `force` ignores an in-flight freshness.
async fn fetch_available(force: bool) -> Result<Vec<AvailableSdk>, String> {
    let _ = force; // always fetches; the TTL check happens in the caller
    let output = tauri::async_runtime::spawn_blocking(|| run_vfox(&["available"], false))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))??;

    let parsed = parse_available(&output);

    // Cache the parsed plugin list (without installed flags — those are
    // recomputed per call so the cache stays correct after installs/removes).
    if let Ok(mut guard) = AVAILABLE_CACHE.lock() {
        let names_only: Vec<AvailableSdk> = parsed
            .iter()
            .map(|a| AvailableSdk {
                name: a.name.clone(),
                official: a.official,
                installed: false,
            })
            .collect();
        *guard = Some((Instant::now(), names_only));
    }
    Ok(recompute_installed(&parsed))
}

/// Parse `vfox available` output into a list of plugins.
/// Lines look like "  bun   ✗ https://..." — name is the first whitespace
/// token; the second is ✓ (official) or ✗ (community). Output is assumed
/// already ANSI-stripped (see `run_vfox`).
fn parse_available(output: &str) -> Vec<AvailableSdk> {
    let mut out: Vec<AvailableSdk> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("AVAILABLE") || trimmed.starts_with("Use ") {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let name = match parts.next() {
            Some(n) => n.to_string(),
            None => continue,
        };
        let official = parts.next().map(|m| m.contains('✓')).unwrap_or(false);
        out.push(AvailableSdk {
            name,
            official,
            installed: false,
        });
    }
    out
}

/// Stamp the current `installed` flags onto a plugin list by reading the
/// filesystem. Kept separate from parsing so the cache can be reused while
/// install state changes.
fn recompute_installed(plugins: &[AvailableSdk]) -> Vec<AvailableSdk> {
    let installed: std::collections::HashSet<String> =
        vfox::list_sdks().into_iter().map(|s| s.name).collect();
    plugins
        .iter()
        .map(|a| AvailableSdk {
            name: a.name.clone(),
            official: a.official,
            installed: installed.contains(&a.name),
        })
        .collect()
}

#[derive(Debug, serde::Serialize)]
pub struct AvailableSdk {
    pub name: String,
    pub official: bool,
    pub installed: bool,
}

/// List versions available to install: `vfox search <sdk>`. Returns parsed
/// version strings (newest first), each tagged with whether it's installed.
#[tauri::command]
pub async fn search_versions(sdk: String) -> Result<Vec<AvailableVersion>, String> {
    let sdk_for_search = sdk.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        run_vfox(&["search", &sdk_for_search], false)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))??;
    let installed = vfox::list_sdks()
        .into_iter()
        .find(|s| s.name == sdk)
        .map(|s| {
            s.installed
                .into_iter()
                .map(|v| v.version)
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();

    // `vfox search` prints lines like " - 24.16.0 (LTS) [npm 11.13.0] (installed)".
    // We keep the bare version token plus a lowercase `note` of the parenthesised
    // tags (e.g. "lts", "installed") so the frontend can fuzzy-match on them.
    let mut out: Vec<AvailableVersion> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        let token = match trimmed.strip_prefix("- ") {
            Some(rest) => rest.trim_start(),
            None => continue,
        };
        let mut parts = token.split_whitespace();
        // Version is the first whitespace-delimited token.
        if let Some(ver) = parts.next() {
            // Collect remaining tokens (e.g. "(LTS)", "[npm 11.13.0]", "(installed)")
            // and lowercase them into a searchable note string.
            let note: String = parts.collect::<Vec<_>>().join(" ").to_lowercase();
            out.push(AvailableVersion {
                version: ver.to_string(),
                installed: installed.contains(ver),
                note,
            });
        }
    }
    Ok(out)
}

#[derive(Debug, serde::Serialize)]
pub struct AvailableVersion {
    pub version: String,
    pub installed: bool,
    /// Lowercased trailing tags from `vfox search` output, e.g. "(lts) [npm ...]".
    /// Used by the frontend for fuzzy search (so "lts" matches LTS releases).
    #[serde(default)]
    pub note: String,
}

/// Run `vfox` with args, returning combined stdout+stderr. Has a hard timeout
/// so a hung `vfox` can never freeze the UI.
///
/// Implementation note: we spawn vfox in a background thread and call
/// `wait_with_output()`, which drains stdout/stderr concurrently with waiting.
/// Doing `try_wait` in a poll loop while pipes are `Stdio::piped()` would
/// deadlock once vfox fills the OS pipe buffer (~4KB) — that was the original
/// "切换卡死" bug.
///
/// When `tolerate_shell_err` is true, a non-zero exit is treated as success if
/// the output shows the version switch itself worked (the only failure being
/// vfox's attempt to spawn a new shell, which can't happen in a GUI).
fn run_vfox(args: &[&str], tolerate_shell_err: bool) -> Result<String, String> {
    run_vfox_with_timeout(args, tolerate_shell_err, Duration::from_secs(60))
}

/// 构造不闪控制台窗口的子进程命令（issue #1）。
///
/// Windows 上 GUI（窗口子系统）进程 spawn 控制台程序（vfox / taskkill）
/// 时系统会为其分配新控制台——表现为每次点击都闪一个黑色 cmd 窗口。
/// 加 CREATE_NO_WINDOW 标志抑制。
fn spawn_quiet(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Same as `run_vfox` but with a custom timeout. Used by `vfox upgrade`
/// (downloads the new binary — can be slow) which needs more than the default.
fn run_vfox_with_timeout(
    args: &[&str],
    tolerate_shell_err: bool,
    timeout: Duration,
) -> Result<String, String> {
    // Build the command outside the thread so spawn errors surface directly.
    let mut cmd = spawn_quiet("vfox");
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // No inherited stdin — vfox won't block waiting on one.
        .stdin(std::process::Stdio::null());

    // Critical: after applying a version, `vfox use` calls shell.Open(ppid),
    // which reads the *parent* process's command line and spawns it as a "new
    // shell". From a GUI that parent is vfox-gui.exe itself — so it relaunches
    // the app and hangs. vfox skips that step when IsHookEnv() is true, which
    // is gated on the `__VFOX_SHELL` env var being non-empty (see vfox's
    // internal/env/flag.go). Setting it makes `use` return right after the
    // registry/symlink update — exactly what a GUI needs.
    cmd.env("__VFOX_SHELL", "1");

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = cmd
            .output()
            .map_err(|e| format!("无法启动 vfox: {}", e))
            .and_then(|out| {
                let status = out.status;
                let mut combined = String::new();
                if !out.stdout.is_empty() {
                    combined.push_str(&String::from_utf8_lossy(&out.stdout));
                }
                if !out.stderr.is_empty() {
                    if !combined.is_empty() {
                        combined.push('\n');
                    }
                    combined.push_str(&String::from_utf8_lossy(&out.stderr));
                }
                // vfox emits ANSI color codes even when stdout isn't a TTY, so
                // lines come out as "\x1b[36mbun \x1b[0m ...". Strip them here so
                // downstream parsing sees clean names — otherwise the sidebar
                // shows mojibake and installed-SDK detection breaks (the
                // ANSI-laden key never matches the filesystem's clean name).
                let combined = strip_ansi(&combined);
                if status.success() {
                    Ok(combined)
                } else if tolerate_shell_err && combined.contains("open a new shell") {
                    Ok(combined)
                } else {
                    Err(if combined.trim().is_empty() {
                        format!("vfox 退出码 {:?}", status.code())
                    } else {
                        combined
                    })
                }
            });
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => Err(format!("vfox 执行超时（{}秒），可能卡住了。", timeout.as_secs())),
    }
}

/// Run `vfox`, streaming stderr line-by-line to the frontend as progress
/// events. Used for `install` (long downloads). stdout/stderr are still
/// captured for the final result string, but stderr is drained incrementally
/// so each `\r`-delimited progress update is parsed and emitted as it arrives.
///
/// Has a 10-minute hard timeout so a hung download can never freeze the UI
/// forever. The whole child+drain runs in a worker thread; we wait on a
/// channel with the timeout and kill the child if it expires.
///
/// `cancel_slot` 登记子进程 PID（前端 `cancel_install` 据此杀安装）；
/// 所有退出路径都会移除自己的 PID，不留陈旧条目。
fn run_vfox_streaming(
    args: &[&str],
    tolerate_shell_err: bool,
    app: &AppHandle,
    cancel_slot: &std::sync::Arc<Mutex<std::collections::HashSet<u32>>>,
) -> Result<String, String> {
    let mut cmd = spawn_quiet("vfox");
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .env("__VFOX_SHELL", "1");

    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(std::process::ExitStatus, Vec<u8>, String), String>>();
    let child = cmd.spawn().map_err(|e| format!("无法启动 vfox: {}", e))?;
    // Remember the PID so we can kill it from the timeout branch (the Child
    // itself moves into the worker thread).
    let pid = child.id();
    // 登记到取消槽；后续所有退出路径统一在函数尾部移除自己的 PID。
    if let Ok(mut guard) = cancel_slot.lock() {
        guard.insert(pid);
    }

    let mut child_moved = child;
    let worker = std::thread::spawn(move || {
        let result = (|| -> Result<(std::process::ExitStatus, Vec<u8>, String), String> {
            let mut stderr = child_moved.stderr.take().expect("stderr piped");
            let mut stdout = child_moved.stdout.take().expect("stdout piped");

            // Drain stdout fully in a helper thread.
            let stdout_handle = std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = stdout.read_to_end(&mut buf);
                buf
            });

            // Drain stderr incrementally, emitting progress events.
            // vfox 的错误信息（"failed to install" 等）打在 stderr——必须
            // 原文累积并随返回值透传，否则前端永远只能看到兜底文案。
            // 缓冲原始字节、只在完整行边界做 UTF-8 解码：1024 字节块边界
            // 可能切在中文等多字节字符中间，逐块 lossy 会插入 U+FFFD 乱码。
            let mut err_buf = [0u8; 1024];
            let mut pending: Vec<u8> = Vec::new();
            let mut stderr_text = String::new();
            let mut throttle = ProgressThrottle::default();
            loop {
                let n = match stderr.read(&mut err_buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                pending.extend_from_slice(&err_buf[..n]);
                while let Some(idx) = pending.iter().position(|&b| b == b'\r' || b == b'\n') {
                    let line_bytes: Vec<u8> = pending.drain(..idx).collect();
                    pending.remove(0); // 行结束符
                    let clean = strip_ansi(&String::from_utf8_lossy(&line_bytes));
                    if clean.trim().is_empty() {
                        continue;
                    }
                    stderr_text.push_str(&clean);
                    stderr_text.push('\n');
                    if let Some(prog) = parse_progress(&clean) {
                        if let Some(emit_now) = throttle.push(prog) {
                            let _ = app.emit(INSTALL_PROGRESS_EVENT, emit_now);
                        }
                    }
                }
            }
            if pending.iter().any(|&b| !b.is_ascii_whitespace()) {
                let clean = strip_ansi(&String::from_utf8_lossy(&pending));
                stderr_text.push_str(&clean);
                stderr_text.push('\n');
                if let Some(prog) = parse_progress(&clean) {
                    if let Some(emit_now) = throttle.push(prog) {
                        let _ = app.emit(INSTALL_PROGRESS_EVENT, emit_now);
                    }
                }
            }
            // 流结束：补发窗口内挂起的最后一帧（否则终态可能永远发不出去）
            if let Some(emit_now) = throttle.take_pending() {
                let _ = app.emit(INSTALL_PROGRESS_EVENT, emit_now);
            }

            let stdout_bytes = stdout_handle.join().unwrap_or_default();
            let status = child_moved.wait().map_err(|e| format!("等待 vfox 退出失败: {}", e))?;
            Ok((status, stdout_bytes, stderr_text))
        })();
        let _ = tx.send(result);
    });

    let result = match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(Ok((status, stdout_bytes, stderr_text))) => {
            let mut combined = String::new();
            if !stdout_bytes.is_empty() {
                combined.push_str(&String::from_utf8_lossy(&stdout_bytes));
            }
            if !stderr_text.trim().is_empty() {
                combined.push_str(&stderr_text);
            }
            if status.success() || (tolerate_shell_err && combined.contains("open a new shell")) {
                Ok(combined)
            } else {
                Err(if combined.trim().is_empty() {
                    format!("vfox 退出码 {:?}", status.code())
                } else {
                    combined
                })
            }
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            // Timeout — kill the process tree by PID so the worker's blocking
            // reads unblock and the thread can wind down.
            kill_pid(pid);
            let _ = worker.join();
            Err("vfox 安装超时（10 分钟），可能网络卡住。".to_string())
        }
    };
    // 无论正常结束、被取消还是超时，退出前都从取消槽移除自己，避免
    // cancel_install 杀到陈旧 PID。PID 已被 cancel_install 取走时是 no-op。
    if let Ok(mut guard) = cancel_slot.lock() {
        guard.remove(&pid);
    }
    result
}

/// 进度事件节流间隔。vfox 的下载条每个 `\r` 段都会更新（快速网络下每秒
/// 几十次），而 percent 几乎逐帧变化——每个事件都 emit 会把 IPC 打爆、
/// webview 侧 setState 风暴。100ms（≈10fps）肉眼够顺。
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// 安装进度事件的发射节流器。
///
/// 规则：
/// - **相同 percent+phase 不重发**（重复帧直接丢弃）；
/// - 不同的 percent/phase 也要距上次发射 ≥ [`PROGRESS_EMIT_INTERVAL`]；
///   窗口内到达的最新一帧先挂起（覆盖旧挂起），窗口过后或流结束时补发，
///   保证「最后一个状态」（如 100%、Installing 阶段）不会丢。
#[derive(Default)]
struct ProgressThrottle {
    last_emit_at: Option<Instant>,
    last_sig: Option<(Option<u8>, String)>,
    pending: Option<InstallProgress>,
}

impl ProgressThrottle {
    /// 记录一条解析出的进度。返回 `Some(..)` 表示**现在**应当 emit
    /// （emit 动作由调用方执行，便于脱离 AppHandle 单测）。
    fn push(&mut self, p: InstallProgress) -> Option<InstallProgress> {
        let sig = (p.percent, p.phase.clone());
        if self.last_sig.as_ref() == Some(&sig) {
            return None; // 重复帧：相同 percent+phase，丢弃
        }
        let due = self
            .last_emit_at
            .map(|t| t.elapsed() >= PROGRESS_EMIT_INTERVAL)
            .unwrap_or(true);
        if due {
            self.last_emit_at = Some(Instant::now());
            self.last_sig = Some(sig);
            self.pending = None;
            Some(p)
        } else {
            // 窗口内：挂起最新一帧，等窗口结束或流末尾补发。
            // 挂起的帧与 last_sig 不同，所以不会被上面的重复帧规则误杀。
            self.pending = Some(p);
            None
        }
    }

    /// 取出挂起的帧（流结束/窗口过后补发）。返回 `Some(..)` 表示应 emit。
    fn take_pending(&mut self) -> Option<InstallProgress> {
        let p = self.pending.take()?;
        self.last_sig = Some((p.percent, p.phase.clone()));
        self.last_emit_at = Some(Instant::now());
        Some(p)
    }
}

/// Parse one line of vfox install output into a progress event.
/// Recognized shapes (after ANSI stripping):
///   `Downloading...  42% [====>] (385 kB/s) [37s:47s]`  → download 42%
///   `Preinstalling nodejs@22.0.0...`                     → preinstall phase
///   `Installing...` / `Postinstalling...`                → install phase
/// Anything unrecognized (e.g. a plain log line) returns None so it isn't
/// emitted as a progress update.
fn parse_progress(line: &str) -> Option<InstallProgress> {
    let trimmed = line.trim();
    // Download line: extract the integer percent and the speed in parens.
    if trimmed.starts_with("Downloading") {
        let percent = find_percent(trimmed);
        let speed = trimmed
            .find('(')
            .and_then(|s| trimmed[s + 1..].find(')').map(|e| trimmed[s + 1..s + 1 + e].to_string()));
        return Some(InstallProgress {
            percent,
            speed,
            phase: "downloading".to_string(),
            message: None,
        });
    }
    if trimmed.starts_with("Preinstalling") {
        return Some(InstallProgress {
            percent: None,
            speed: None,
            phase: "preinstall".to_string(),
            message: Some(trimmed.trim_end_matches("...").to_string()),
        });
    }
    if trimmed.starts_with("Installing") || trimmed.starts_with("Postinstalling") {
        return Some(InstallProgress {
            percent: None,
            speed: None,
            phase: "installing".to_string(),
            message: Some(trimmed.trim_end_matches("...").to_string()),
        });
    }
    None
}

/// Pull the first `N%` integer out of a string like `Downloading...  42% ...`.
fn find_percent(s: &str) -> Option<u8> {
    let pct = s.find('%')?;
    // Walk back from the '%' to the start of the digits.
    let mut start = pct;
    let bytes = s.as_bytes();
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    s[start..pct].parse::<u8>().ok()
}

/// Strip ANSI escape sequences (CSI: `ESC [ ... letter`, plus the OSC form
/// `ESC ] ... BEL`) from a string. vfox colorizes its output unconditionally,
/// even when piped, so this is needed to parse names out of `vfox available`.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // ESC = 0x1B
        if bytes[i] == 0x1B {
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                // CSI: ESC [ <params> <intermediate>* <final>
                i += 1;
                while i < bytes.len() && !(0x40..=0x7E).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1; // consume the final byte
                }
            } else if i < bytes.len() && bytes[i] == b']' {
                // OSC: ESC ] ... BEL (0x07) or ST (ESC \)
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1B && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            } else {
                // Lone ESC or other escape (e.g. ESC followed by a single char);
                // just drop it and let the loop continue.
            }
        } else {
            // Safe to push: we only advance i at char boundaries below.
            // Find the end of this char to stay utf8-correct.
            let ch_end = next_char_boundary(bytes, i);
            out.push_str(&s[i..ch_end]);
            i = ch_end;
        }
    }
    out
}

/// Return the byte index of the next char boundary after `start`.
fn next_char_boundary(bytes: &[u8], start: usize) -> usize {
    // UTF-8 continuation bytes are 10xxxxxx (0x80..0xBF). Step forward until we
    // pass all of them; that lands on the start of the next char.
    let mut j = start + 1;
    while j < bytes.len() && (0x80..0xC0).contains(&bytes[j]) {
        j += 1;
    }
    j
}

/// Scan a project directory for known SDK config files and return a list of
/// detected SDKs with their required versions. Returns nothing if no known files
/// are found (empty vec = no detection, not an error).
#[tauri::command]
pub async fn detect_project_sdks(dir: String) -> Result<Vec<ProjectSdkDetection>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_project_sdks_sync(std::path::Path::new(&dir)))
        .await
        .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Synchronous core of project-SDK detection, separated so unit tests can call
/// it directly without a Tauri runtime.
fn detect_project_sdks_sync(root: &std::path::Path) -> Result<Vec<ProjectSdkDetection>, String> {
    let mut detections: Vec<ProjectSdkDetection> = Vec::new();

    if !root.is_dir() {
        return Err("路径不是目录".to_string());
    }

    // ── Node.js ──
    // A package.json IS a Node project even without an engines field, so we
    // always report it (version known only if engines.node / .nvmrc exists).
    let node_ver = read_json_file(&root.join("package.json"))
        .and_then(|pkg| extract_node_version(&pkg))
        .or_else(|| {
            // Fall back to .nvmrc / .node-version if package.json had no version.
            read_first_line(&root.join(".nvmrc"))
                .or_else(|| read_first_line(&root.join(".node-version")))
            });
    let has_pkg = root.join("package.json").exists();
    let has_nvm = root.join(".nvmrc").exists() || root.join(".node-version").exists();
    if has_pkg || has_nvm {
        let source = if has_pkg { "package.json" } else { ".nvmrc" };
        detections.push(ProjectSdkDetection {
            sdk: "nodejs".into(),
            label: "Node.js".into(),
            required_version: node_ver.clone(),
            suggestion: match &node_ver {
                Some(v) => format!("建议安装 Node.js {}", v),
                None => "检测到 Node.js 项目，建议安装最新 LTS".into(),
            },
            source: source.into(),
        });
    }

    // ── Go ──
        if root.join("go.mod").exists() {
            // go.mod: "module foo" then "go 1.22"
            let full = std::fs::read_to_string(&root.join("go.mod")).unwrap_or_default();
            if let Some(ver) = full.lines().find(|l| l.starts_with("go ")) {
                let v = ver.trim_start_matches("go ").trim().to_string();
                detections.push(ProjectSdkDetection {
                    sdk: "golang".into(),
                    label: "Go".into(),
                    required_version: Some(v.clone()),
                    suggestion: format!("建议安装 Go {}", v),
                    source: "go.mod".into(),
                });
            } else {
                detections.push(ProjectSdkDetection {
                    sdk: "golang".into(),
                    label: "Go".into(),
                    required_version: None,
                    suggestion: "检测到 Go 项目，建议安装最新稳定版".into(),
                    source: "go.mod".into(),
                });
            }
        }

        // ── Rust ──
        if root.join("Cargo.toml").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "rust".into(),
                label: "Rust".into(),
                required_version: None,
                suggestion: "检测到 Rust 项目，建议安装最新稳定版".into(),
                source: "Cargo.toml".into(),
            });
        }

        // ── Python ──
        for f in &[".python-version", "Pipfile", "pyproject.toml", "requirements.txt"] {
            if root.join(f).exists() {
                let ver = read_first_line(&root.join(".python-version"));
                detections.push(ProjectSdkDetection {
                    sdk: "python".into(),
                    label: "Python".into(),
                    required_version: ver,
                    suggestion: format!("{} 检测到 Python 项目", f),
                    source: f.to_string(),
                });
                break; // only one Python entry
            }
        }

        // ── Java (Gradle Groovy / Maven) ──
        // NB: build.gradle.kts is handled by the Kotlin block below — a .kts
        // build file is a Kotlin project, not a plain Java one, so we exclude
        // it here to avoid duplicate Java+Kotlin detections.
        if root.join("build.gradle").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "java".into(),
                label: "Java".into(),
                required_version: None,
                suggestion: "检测到 Gradle 项目，建议安装 Java 21 LTS".into(),
                source: "build.gradle".into(),
            });
        } else if root.join("pom.xml").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "java".into(),
                label: "Java".into(),
                required_version: None,
                suggestion: "检测到 Maven 项目，建议安装 Java 21 LTS".into(),
                source: "pom.xml".into(),
            });
        }

        // ── .NET ──
        for f in &["*.csproj", "*.fsproj", "*.sln"] {
            if glob_file_exists(root, f) {
                detections.push(ProjectSdkDetection {
                    sdk: "dotnet".into(),
                    label: ".NET".into(),
                    required_version: None,
                    suggestion: "检测到 .NET 项目，建议安装最新 LTS".into(),
                    source: f.to_string(),
                });
                break;
            }
        }

        // ── Flutter / Dart ──
        if root.join("pubspec.yaml").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "flutter".into(),
                label: "Flutter".into(),
                required_version: None,
                suggestion: "检测到 Flutter/Dart 项目，建议安装最新稳定版".into(),
                source: "pubspec.yaml".into(),
            });
        }

        // ── Zig ──
        if root.join("build.zig").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "zig".into(),
                label: "Zig".into(),
                required_version: None,
                suggestion: "检测到 Zig 项目，建议安装最新稳定版".into(),
                source: "build.zig".into(),
            });
        }

        // ── Ruby ──
        for f in &["Gemfile", ".ruby-version"] {
            if root.join(f).exists() {
                detections.push(ProjectSdkDetection {
                    sdk: "ruby".into(),
                    label: "Ruby".into(),
                    required_version: read_first_line(&root.join(".ruby-version")),
                    suggestion: format!("{} 检测到 Ruby 项目", f),
                    source: f.to_string(),
                });
                break;
            }
        }

        // ── PHP ──
        if root.join("composer.json").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "php".into(),
                label: "PHP".into(),
                required_version: None,
                suggestion: "检测到 PHP 项目，建议安装最新稳定版".into(),
                source: "composer.json".into(),
            });
        }

        // ── Deno ──
        if root.join("deno.json").exists() || root.join("deno.jsonc").exists() {
            detections.push(ProjectSdkDetection {
                sdk: "deno".into(),
                label: "Deno".into(),
                required_version: None,
                suggestion: "检测到 Deno 项目，建议安装最新稳定版".into(),
                source: "deno.json".into(),
            });
        }

        // ── Kotlin ──
        if glob_file_exists(root, "*.gradle.kts") {
            detections.push(ProjectSdkDetection {
                sdk: "kotlin".into(),
                label: "Kotlin".into(),
                required_version: None,
                suggestion: "检测到 Kotlin 项目，建议安装最新稳定版".into(),
                source: "*.gradle.kts".into(),
            });
        }

        Ok(detections)
}

/// A single SDK detection result from scanning a project directory.
#[derive(Debug, serde::Serialize)]
pub struct ProjectSdkDetection {
    pub sdk: String,
    pub label: String,
    pub required_version: Option<String>,
    pub suggestion: String,
    pub source: String,
}

/// Read the first non-empty line of a file, trimmed.
fn read_first_line(path: &std::path::Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    s.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
}

/// Read a JSON file into a serde_json::Value, returning None on any error.
fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Extract the Node.js version from a package.json value.
/// Checks `engines.node` and `volta.node`.
fn extract_node_version(pkg: &serde_json::Value) -> Option<String> {
    if let Some(v) = pkg.get("engines").and_then(|e| e.get("node")) {
        // Strip semver operators like ">=20.0.0" → "20.0.0"
        return Some(v.as_str()?.trim_start_matches(&['^', '~', '>', '=', '<'][..]).to_string());
    }
    if let Some(v) = pkg.get("volta").and_then(|e| e.get("node")) {
        return Some(v.as_str()?.to_string());
    }
    None
}

/// Check if a file matching a glob pattern exists in the directory.
/// Supports `*.ext` patterns, including multi-dot extensions like
/// `*.gradle.kts` (where `Path::extension()` would wrongly return only `kts`).
fn glob_file_exists(dir: &std::path::Path, pattern: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        let dot_suffix = format!(".{}", suffix);
        if let Ok(entries) = std::fs::read_dir(dir) {
            return entries.filter_map(|e| e.ok()).any(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                // Match the full dotted suffix so `*.gradle.kts` works.
                name.ends_with(&dot_suffix)
            });
        }
    }
    false
}

/// Save current SDK versions as a named snapshot. Snapshots are stored in
/// `~/.version-fox/snapshots/<name>.json`.
///
/// If `only_sdk` is given (e.g. `"java"`), only that SDK is saved — so a later
/// restore touches just that one tool, leaving nodejs/python/etc. untouched.
/// When omitted, all SDKs with a selected version are saved (full environment).
#[tauri::command]
pub async fn save_snapshot(name: String, only_sdk: Option<String>) -> Result<String, String> {
    validate_snapshot_name(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut sdks = crate::vfox::list_sdks();
        if let Some(sdk) = &only_sdk {
            sdks.retain(|s| &s.name == sdk);
        }
        // Only persist SDKs that have a current version — restoring one with
        // no selection would be a no-op anyway.
        sdks.retain(|s| s.current.is_some());
        // Refuse to save an empty snapshot — it would lie to the user ("saved")
        // and restore would do nothing. This happens when saving a single SDK
        // that has versions installed but none currently selected.
        if sdks.is_empty() {
            return Err(match &only_sdk {
                Some(s) => format!("无法保存：{} 没有当前选中的版本（先切换到一个版本再保存）", s),
                None => "无法保存：没有已选中版本的 SDK".to_string(),
            });
        }
        let snap_dir = crate::vfox::vfox_home().join("snapshots");
        std::fs::create_dir_all(&snap_dir)
            .map_err(|e| format!("无法创建快照目录: {}", e))?;

        let path = snap_dir.join(format!("{}.json", &name));
        let json = serde_json::to_string_pretty(&sdks)
            .map_err(|e| format!("序列化失败: {}", e))?;
        std::fs::write(&path, &json)
            .map_err(|e| format!("写入失败: {}", e))?;

        Ok(match &only_sdk {
            Some(s) => format!("快照「{}」已保存（仅 {}）", name, s),
            None => format!("快照「{}」已保存（{} 个 SDK）", name, sdks.len()),
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// 持久化 UI 语言并重建托盘菜单/提示/窗口标题。
///
/// 托盘和窗口标题在 Rust 侧、只在启动时按持久化语言构建一次；前端切语言
/// 时必须调用此命令同步，否则托盘停留在上次启动的语言。
/// 同步命令（主线程执行）——托盘/菜单 API 要求。
#[tauri::command]
pub fn set_app_language(
    app: AppHandle,
    tray: tauri::State<'_, crate::TrayHandle>,
    lang: String,
) -> Result<(), String> {
    if lang != "zh" && lang != "en" {
        return Err(format!("不支持的语言: {lang}"));
    }
    std::fs::write(crate::vfox::vfox_home().join("gui-lang"), &lang)
        .map_err(|e| format!("持久化语言设置失败: {e}"))?;
    crate::apply_tray(&app, &tray.0, &lang);
    Ok(())
}

/// 快照名称校验：名称会被拼进 `snapshots/<name>.json`，不做校验时
/// `..\..\x` 这类输入可以穿越到快照目录外写/删任意 .json 文件。
fn validate_snapshot_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("快照名称不能为空".into());
    }
    if name.chars().count() > 100 {
        return Err("快照名称过长（最多 100 字符）".into());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("快照名称不能包含路径分隔符（/ 或 \\）".into());
    }
    const INVALID: &[char] = &[':', '*', '?', '"', '<', '>', '|'];
    if name.chars().any(|c| INVALID.contains(&c) || c.is_control()) {
        return Err("快照名称包含文件名非法字符（: * ? \" < > | 或控制字符）".into());
    }
    Ok(())
}

/// List all saved snapshots with their SDK counts.
#[tauri::command]
pub async fn list_snapshots() -> Result<Vec<SnapshotInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let snap_dir = crate::vfox::vfox_home().join("snapshots");
        if !snap_dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&snap_dir) {
            for e in entries.filter_map(|e| e.ok()) {
                let path = e.path();
                if path.extension().map(|x| x == "json").unwrap_or(false) {
                    let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    let count = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                        .and_then(|v| v.as_array().map(|a| a.len()))
                        .unwrap_or(0);
                    out.push(SnapshotInfo {
                        name,
                        sdk_count: count as u32,
                    });
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

#[derive(Debug, serde::Serialize)]
pub struct SnapshotInfo {
    pub name: String,
    pub sdk_count: u32,
}

/// Delete a named snapshot.
#[tauri::command]
pub async fn delete_snapshot(name: String) -> Result<String, String> {
    validate_snapshot_name(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::vfox::vfox_home()
            .join("snapshots")
            .join(format!("{}.json", &name));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("删除失败: {}", e))?;
            Ok(format!("快照「{}」已删除", name))
        } else {
            Err(format!("快照「{}」不存在", name))
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Restore SDK versions from a named snapshot.
///
/// Reads `<name>.json` (the format written by `save_snapshot` — a serialized
/// `Vec<Sdk>`), then runs `vfox use <sdk>@<version> --global` for each SDK that
/// has a current version in the snapshot. SDKs whose version isn't installed
/// locally are skipped (counted as `skipped`) rather than failing the restore.
/// Returns a human-readable summary.
#[tauri::command]
pub async fn restore_snapshot(name: String) -> Result<String, String> {
    validate_snapshot_name(&name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::vfox::vfox_home()
            .join("snapshots")
            .join(format!("{}.json", &name));
        if !path.exists() {
            return Err(format!("快照「{}」不存在", name));
        }
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取快照失败: {}", e))?;
        let snap: Vec<SdkSnapshotEntry> = serde_json::from_str(&json)
            .map_err(|e| format!("解析快照失败: {}", e))?;

        // Build the set of locally-installed versions so we can skip restores
        // for versions that aren't present.
        let current_sdks = crate::vfox::list_sdks();
        let installed: std::collections::HashMap<String, std::collections::HashSet<String>> =
            current_sdks
                .iter()
                .map(|s| {
                    (
                        s.name.clone(),
                        s.installed.iter().map(|v| v.version.clone()).collect(),
                    )
                })
                .collect();

        let mut applied = 0u32;
        let mut skipped = 0u32;
        for entry in &snap {
            let Some(target_ver) = &entry.current else { continue };
            let have = installed.get(&entry.name);
            let installed_ok = have.map(|set| set.contains(target_ver)).unwrap_or(false);
            if !installed_ok {
                skipped += 1;
                continue;
            }
            let target = format!("{}@{}", entry.name, target_ver);
            // Best-effort: a single failed `use` shouldn't abort the whole restore.
            if run_vfox(&["use", &target, "--global"], true).is_ok() {
                applied += 1;
            } else {
                skipped += 1;
            }
        }
        Ok(format!(
            "快照「{}」已恢复（{} 个已应用，{} 个跳过）",
            name, applied, skipped
        ))
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// One entry in a snapshot file — mirrors the subset of `vfox::Sdk` we need.
#[derive(Debug, serde::Deserialize)]
struct SdkSnapshotEntry {
    name: String,
    current: Option<String>,
}

/// Read a project's version-change history (`.vfox-history.json`), recorded by
/// [`append_history`] each time the user switches a version in project scope.
/// Returns entries newest-first so the timeline shows the most recent change
/// at the top. Powers the "project version timeline" view.
#[tauri::command]
pub async fn project_history(project_path: String) -> Result<Vec<HistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&project_path).join(".vfox-history.json");
        let entries: Vec<serde_json::Value> = read_json_file(&path)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        // Parse into typed entries, newest first.
        let mut out: Vec<HistoryEntry> = entries
            .iter()
            .filter_map(|e| {
                Some(HistoryEntry {
                    sdk: e.get("sdk")?.as_str()?.to_string(),
                    version: e.get("version")?.as_str()?.to_string(),
                    date: e.get("date").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                    from: e.get("from").and_then(|d| d.as_str()).map(|s| s.to_string()),
                })
            })
            .collect();
        out.reverse(); // newest first
        Ok(out)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

#[derive(Debug, serde::Serialize)]
pub struct HistoryEntry {
    pub sdk: String,
    pub version: String,
    pub date: String,
    pub from: Option<String>,
}

// ── 全局包管理（查看/安全卸载运行时全局包，见 docs/PLAN-global-packages.md）──

/// 单个全局包条目。`bins` 是风险提示的依据：卸掉带 CLI 的包会把用户的
/// 命令行工具一起干掉（如 pnpm/dsh）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPackageEntry {
    pub name: String,
    pub version: Option<String>,
    pub bytes: u64,
    pub description: Option<String>,
    pub bins: Vec<String>,
}

/// 全局包清单报告。`warning` 为降级提示代码（"npm-missing"=全局包树损坏，
/// "pip-failed:<detail>"=pip 列举失败），前端映射成黄条文案并禁用单包操作。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPackagesReport {
    pub sdk: String,
    pub version: String,
    /// 运行时本体字节数（版本目录总大小 − 全局包大小）
    pub runtime_bytes: u64,
    pub packages_bytes: u64,
    pub packages: Vec<GlobalPackageEntry>,
    pub warning: Option<String>,
}

/// 卸载结果。dry_run 时 `would_remove` 列出将删除的文件/目录绝对路径、
/// `key_tools` 列出命中关键 CLI 的 bins（前端红色强警告）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalUninstallOutcome {
    pub dry_run: bool,
    pub would_remove: Vec<String>,
    pub freed_bytes: u64,
    pub removed: Vec<String>,
    pub failed: Vec<(String, String)>,
    pub key_tools: Vec<String>,
}

/// 内置组件禁卸名单：卸掉会废掉运行时自身（sdk → 包名列表）。
const PROTECTED_PACKAGES: &[(&str, &[&str])] = &[
    ("nodejs", &["npm", "corepack", "npx"]),
    ("python", &["pip", "setuptools", "wheel"]),
];

/// 命中即红色强警告的关键 CLI 工具（bins 出现这些名字时用户大概率在别处依赖它）。
const KEY_TOOL_BINS: &[&str] = &[
    "pnpm", "yarn", "tsc", "tsx", "eslint", "prettier", "prisma", "vite",
    "next", "vercel", "netlify", "expo", "jest", "vitest", "playwright",
];

fn protected_reason(sdk: &str, package: &str) -> Option<&'static str> {
    PROTECTED_PACKAGES
        .iter()
        .find(|(s, _)| *s == sdk)
        .and_then(|(_, list)| {
            list.contains(&package).then_some("内置组件，卸载会损坏运行时自身")
        })
}

fn key_tools_in(bins: &[String]) -> Vec<String> {
    bins.iter()
        .filter(|b| KEY_TOOL_BINS.contains(&b.as_str()))
        .cloned()
        .collect()
}

/// nodejs 运行时根里的 node 可执行文件（unix 物化在 bin/ 下）。
fn node_exe(runtime_root: &Path) -> std::path::PathBuf {
    if cfg!(windows) {
        runtime_root.join("node.exe")
    } else {
        runtime_root.join("bin").join("node")
    }
}

fn python_exe(runtime_root: &Path) -> std::path::PathBuf {
    if cfg!(windows) {
        runtime_root.join("python.exe")
    } else {
        runtime_root.join("bin").join("python3")
    }
}

/// 从 package.json 的 bin 字段提取命令名：对象形态取 keys，字符串形态
/// （单命令包）取包名本身。解析失败返回空。
fn bins_from_manifest(manifest: &serde_json::Value, package_name: &str) -> Vec<String> {
    match manifest.get("bin") {
        Some(serde_json::Value::Object(map)) => map.keys().cloned().collect(),
        Some(serde_json::Value::String(_)) => vec![package_name.to_string()],
        _ => Vec::new(),
    }
}

/// node_modules 里的包名 → 磁盘目录（@scope/name 两段展开）。
fn pkg_dir_for(nm: &Path, package: &str) -> std::path::PathBuf {
    if let Some(rest) = package.strip_prefix('@') {
        let mut p = nm.to_path_buf();
        for (i, seg) in rest.split('/').enumerate() {
            p = p.join(if i == 0 { format!("@{seg}") } else { seg.to_string() });
        }
        p
    } else {
        nm.join(package)
    }
}

/// 单遍扫描 nodejs 运行时树的产出：运行时本体字节数、每包字节数、包清单。
/// 替代旧「dir_size(root) 全树一遍 + 每包 dir_size 各一遍 ≈2.3 遍」的做法。
struct NodeModulesScan {
    /// root 下不计入任何包的字节（node.exe、bin shim、散文件、.bin/…）
    runtime_bytes: u64,
    /// 所有包字节合计
    packages_bytes: u64,
    /// 包清单（按体积降序）
    packages: Vec<GlobalPackageEntry>,
    /// npm 缺失 → "npm-missing"（树损坏，前端黄条禁用单包操作）
    corrupt: Option<String>,
}

/// 遍历位置上下文：决定字节归属与子目录语义。
#[derive(Clone, Copy)]
enum WalkCtx {
    /// node_modules 子树之外，或 node_modules 里的散文件/隐藏目录——字节归运行时本体
    Runtime,
    /// node_modules 目录本身——直接子目录是包或 @scope 容器
    NmRoot,
    /// node_modules/@scope 容器——直接子目录是包
    NmScope,
    /// 某个包内部——一切字节计入该包（含其嵌套的 node_modules）
    Package(usize),
}

impl NodeModulesScan {
    /// 进入包目录顶层时顺手解析 package.json（name/version/description/bin）。
    /// 解析失败回落目录名（@scope 包回落 "@scope/name"），与旧逻辑一致。
    fn register_package(&mut self, dir: &Path, fallback_name: String) -> usize {
        let manifest_text = std::fs::read_to_string(dir.join("package.json")).unwrap_or_default();
        let manifest: serde_json::Value = serde_json::from_str(&manifest_text).unwrap_or_default();
        let name = manifest
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or(fallback_name);
        let bins = bins_from_manifest(&manifest, &name);
        self.packages.push(GlobalPackageEntry {
            name,
            version: manifest.get("version").and_then(|v| v.as_str()).map(String::from),
            bytes: 0,
            description: manifest.get("description").and_then(|v| v.as_str()).map(String::from),
            bins,
        });
        self.packages.len() - 1
    }
}

/// 单遍递归走树：字节按路径前缀实时归属——node_modules/&lt;top&gt; 与
/// node_modules/@scope/&lt;top&gt; 下的字节计入该包，其余计入运行时本体。
/// `root == nm` 时直接从 node_modules 层开始（旧 scan_node_modules 的语义：
/// 只产出包清单，不含运行时本体字节）。
fn scan_node_tree(root: &Path, nm: &Path) -> NodeModulesScan {
    let mut scan = NodeModulesScan {
        runtime_bytes: 0,
        packages_bytes: 0,
        packages: Vec::new(),
        corrupt: (!nm.join("npm").join("package.json").is_file())
            .then(|| "npm-missing".to_string()),
    };
    fn walk(dir: &Path, ctx: WalkCtx, nm: &Path, scan: &mut NodeModulesScan) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            // 一次 metadata 同时取类型与大小（穿透符号链接，语义同 dir_size）
            let Ok(meta) = path.metadata() else { continue };
            if meta.is_dir() {
                let next = match ctx {
                    WalkCtx::Runtime => {
                        if path == nm { WalkCtx::NmRoot } else { WalkCtx::Runtime }
                    }
                    WalkCtx::NmRoot => {
                        let fname = entry.file_name().to_string_lossy().into_owned();
                        if fname.starts_with('@') {
                            WalkCtx::NmScope
                        } else if fname.starts_with('.') {
                            // .bin / .package-lock.json 之类：不是包，字节归运行时本体
                            WalkCtx::Runtime
                        } else {
                            WalkCtx::Package(scan.register_package(&path, fname))
                        }
                    }
                    WalkCtx::NmScope => {
                        let sub = entry.file_name().to_string_lossy().into_owned();
                        let scope = dir
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                        WalkCtx::Package(scan.register_package(&path, format!("{scope}/{sub}")))
                    }
                    WalkCtx::Package(i) => WalkCtx::Package(i),
                };
                walk(&path, next, nm, scan);
            } else if let WalkCtx::Package(i) = ctx {
                scan.packages[i].bytes += meta.len();
            } else {
                scan.runtime_bytes += meta.len();
            }
        }
    }
    let start = if root == nm { WalkCtx::NmRoot } else { WalkCtx::Runtime };
    walk(root, start, nm, &mut scan);
    scan.packages.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    scan.packages_bytes = scan.packages.iter().map(|p| p.bytes).sum();
    scan
}

/// nodejs 全局包卸载：优先走该版本自带的 npm（`npm remove -g --prefix`，
/// 会连带清理 bin shim）；npm 损坏时降级为直删包目录 + bin shim（先经
/// dry_run 列出）。bin shim 在 Windows 是 `<bin>`/`<bin>.cmd`/`<bin>.ps1` 一组。
fn nodejs_uninstall(
    runtime_root: &Path,
    nm: &Path,
    packages: &[String],
    dry_run: bool,
    outcome: &mut GlobalUninstallOutcome,
) {
    let node = node_exe(runtime_root);
    let npm_cli = nm.join("npm").join("bin").join("npm-cli.js");
    let npm_usable = node.is_file() && npm_cli.is_file();

    let mut pkg_dirs: Vec<(String, std::path::PathBuf)> = Vec::new();
    for pkg in packages {
        let dir = pkg_dir_for(nm, pkg);
        if !dir.is_dir() {
            outcome.failed.push((pkg.clone(), "未安装".into()));
        } else {
            pkg_dirs.push((pkg.clone(), dir));
        }
    }

    // 收集受影响 bins 与将删除的路径（dry_run 与真实路径共用）
    for (pkg, dir) in &pkg_dirs {
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("package.json")).unwrap_or_default(),
        )
        .unwrap_or_default();
        let bins = bins_from_manifest(&manifest, pkg);
        outcome.key_tools.extend(key_tools_in(&bins));
        outcome.freed_bytes += dir_size(dir);
        outcome.would_remove.push(dir.to_string_lossy().into_owned());
        for bin in &bins {
            for shim in bin_shims(runtime_root, bin) {
                if shim.exists() {
                    outcome.would_remove.push(shim.to_string_lossy().into_owned());
                }
            }
        }
    }

    if dry_run {
        return;
    }

    if npm_usable {
        let root_str = runtime_root.to_string_lossy().into_owned();
        let mut args: Vec<String> = vec![
            npm_cli.to_string_lossy().into_owned(),
            "remove".into(),
            "-g".into(),
            "--prefix".into(),
            root_str,
            "--no-audit".into(),
            "--no-fund".into(),
        ];
        args.extend(pkg_dirs.iter().map(|(p, _)| p.clone()));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match run_capture(&node.to_string_lossy(), &arg_refs, Duration::from_secs(300)) {
            Ok(_) => {
                for (pkg, _) in &pkg_dirs {
                    outcome.removed.push(pkg.clone());
                }
                return;
            }
            Err(e) => outcome.failed.push(("npm".into(), format!("npm remove 失败: {e}"))),
        }
    }

    // 降级：直删包目录与 bin shim（树已损坏时 npm 自身跑不动）
    for (pkg, dir) in &pkg_dirs {
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("package.json")).unwrap_or_default(),
        )
        .unwrap_or_default();
        let bins = bins_from_manifest(&manifest, pkg);
        match std::fs::remove_dir_all(dir) {
            Ok(()) => {
                for bin in &bins {
                    for shim in bin_shims(runtime_root, bin) {
                        let _ = std::fs::remove_file(&shim);
                    }
                }
                outcome.removed.push(pkg.clone());
            }
            Err(e) => outcome.failed.push((pkg.clone(), format!("删除失败: {e}"))),
        }
    }
}

/// bin 名在运行时根的 shim 文件组（Windows 三件套 + unix 裸名）。
fn bin_shims(runtime_root: &Path, bin: &str) -> Vec<std::path::PathBuf> {
    if cfg!(windows) {
        vec![
            runtime_root.join(bin),
            runtime_root.join(format!("{bin}.cmd")),
            runtime_root.join(format!("{bin}.ps1")),
        ]
    } else {
        vec![runtime_root.join("bin").join(bin)]
    }
}

/// python 全局包列举：用该版本自己的解释器跑 `pip list --format=json`。
/// 体积 pip 不提供，M1 显示为未知（0）。
fn python_list_packages(runtime_root: &Path) -> Result<Vec<GlobalPackageEntry>, String> {
    let py = python_exe(runtime_root);
    if !py.is_file() {
        return Err("解释器不存在".into());
    }
    let out = run_capture(
        &py.to_string_lossy(),
        &["-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
        Duration::from_secs(120),
    )?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(out.trim())
        .map_err(|e| format!("pip 输出解析失败: {e}"))?;
    Ok(parsed
        .into_iter()
        .map(|v| GlobalPackageEntry {
            name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
            version: v.get("version").and_then(|n| n.as_str()).map(String::from),
            bytes: 0,
            description: None,
            bins: Vec::new(),
        })
        .filter(|p| !p.name.is_empty())
        .collect())
}

/// 查看某版本的全局包清单与体积拆分。活跃版本扫 `sdks/<sdk>`（物化体），
/// 非活跃扫 cache 目录。`warning` 非空时前端显示黄条并禁用单包操作。
#[tauri::command]
pub async fn global_packages(sdk: String, version: String) -> Result<GlobalPackagesReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::vfox::runtime_root_for(&sdk, &version)
            .ok_or_else(|| format!("未找到 {sdk}@{version} 的安装目录"))?;
        match sdk.as_str() {
            "nodejs" => {
                let nm = root.join("node_modules");
                // 单遍走树：运行时本体与每包字节一次产出（不再 dir_size 全树 + 每包各一遍）
                let scan = if nm.is_dir() {
                    scan_node_tree(&root, &nm)
                } else {
                    NodeModulesScan {
                        runtime_bytes: dir_size(&root),
                        packages_bytes: 0,
                        packages: Vec::new(),
                        corrupt: Some("npm-missing".to_string()),
                    }
                };
                Ok(GlobalPackagesReport {
                    sdk,
                    version,
                    runtime_bytes: scan.runtime_bytes,
                    packages_bytes: scan.packages_bytes,
                    packages: scan.packages,
                    warning: scan.corrupt,
                })
            }
            "python" => {
                let runtime_bytes = dir_size(&root);
                let (packages, warning) = match python_list_packages(&root) {
                    Ok(mut list) => {
                        list.sort_by(|a, b| a.name.cmp(&b.name));
                        (list, None)
                    }
                    Err(e) => (Vec::new(), Some(format!("pip-failed:{e}"))),
                };
                Ok(GlobalPackagesReport {
                    sdk,
                    version,
                    runtime_bytes,
                    packages_bytes: 0,
                    packages,
                    warning,
                })
            }
            other => Err(format!("暂不支持 {other} 生态的全局包查看")),
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// 卸载全局包。**必须先 dry_run=true 拿到将删清单再真实执行**——前端确认框
/// 展示的就是 dry_run 结果。内置组件（npm/pip 等）直接拒绝。
#[tauri::command]
pub async fn global_uninstall(
    sdk: String,
    version: String,
    packages: Vec<String>,
    dry_run: bool,
) -> Result<GlobalUninstallOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut outcome = GlobalUninstallOutcome {
            dry_run,
            would_remove: Vec::new(),
            freed_bytes: 0,
            removed: Vec::new(),
            failed: Vec::new(),
            key_tools: Vec::new(),
        };
        for pkg in &packages {
            if let Some(reason) = protected_reason(&sdk, pkg) {
                outcome.failed.push((pkg.clone(), reason.into()));
            }
        }
        let allowed: Vec<String> = packages
            .iter()
            .filter(|p| !outcome.failed.iter().any(|(f, _)| f == *p))
            .cloned()
            .collect();
        if allowed.is_empty() {
            return Ok(outcome);
        }

        let root = crate::vfox::runtime_root_for(&sdk, &version)
            .ok_or_else(|| format!("未找到 {sdk}@{version} 的安装目录"))?;
        match sdk.as_str() {
            "nodejs" => {
                let nm = root.join("node_modules");
                nodejs_uninstall(&root, &nm, &allowed, dry_run, &mut outcome);
            }
            "python" => {
                let py = python_exe(&root);
                if !py.is_file() {
                    for pkg in &allowed {
                        outcome.failed.push((pkg.clone(), "解释器不存在".into()));
                    }
                    return Ok(outcome);
                }
                if dry_run {
                    outcome.freed_bytes = 0; // pip 不提供每包体积
                } else {
                    let mut args: Vec<String> = vec![
                        "-m".into(),
                        "pip".into(),
                        "uninstall".into(),
                        "-y".into(),
                        "--disable-pip-version-check".into(),
                    ];
                    args.extend(allowed.iter().cloned());
                    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                    match run_capture(&py.to_string_lossy(), &arg_refs, Duration::from_secs(300)) {
                        Ok(_) => outcome.removed.extend(allowed),
                        Err(e) => {
                            for pkg in &allowed {
                                outcome.failed.push((pkg.clone(), e.clone()));
                            }
                        }
                    }
                }
            }
            other => {
                for pkg in &allowed {
                    outcome.failed.push((pkg.clone(), format!("暂不支持 {other} 生态")));
                }
            }
        }
        outcome.key_tools.sort();
        outcome.key_tools.dedup();
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// 带超时地跑一个子进程并捕获 stdout（stderr 丢弃）。超时会杀进程树。
fn run_capture(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = spawn_quiet(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法启动 {program}: {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let mut err = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = stderr.read_to_string(&mut err);
        let _ = tx.send((out, err));
    });
    match rx.recv_timeout(timeout) {
        Ok((out, err)) => {
            let status = child.wait().map_err(|e| format!("等待退出失败: {e}"))?;
            if status.success() {
                Ok(out)
            } else {
                let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("; ");
                Err(format!("退出码 {:?}{}", status.code(), if tail.is_empty() { String::new() } else { format!(": {tail}") }))
            }
        }
        Err(_) => {
            let pid = child.id();
            #[cfg(windows)]
            let _ = spawn_quiet("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
            #[cfg(not(windows))]
            let _ = spawn_quiet("kill").arg("-9").arg(pid.to_string()).output();
            let _ = child.wait();
            Err("执行超时".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_csi() {
        // 16 padding spaces + 1 separator space = 17 between "bun" and "✗".
        let raw = "\x1b[36mbun                \x1b[0m \x1b[91m✗\x1b[0m  https://x";
        assert_eq!(strip_ansi(raw), "bun                 ✗  https://x");
    }

    #[test]
    fn strip_ansi_preserves_utf8() {
        // The ✗ / ✓ markers are multibyte UTF-8; they must survive intact.
        assert_eq!(strip_ansi("\x1b[92m✓\x1b[0m"), "✓");
        assert_eq!(strip_ansi("\x1b[91m✗\x1b[0m"), "✗");
    }

    #[test]
    fn strip_ansi_plain_untouched() {
        assert_eq!(strip_ansi("nodejs 24.16.0"), "nodejs 24.16.0");
    }

    #[test]
    fn parse_available_line_after_strip() {
        let raw = "  \x1b[36mnodejs             \x1b[0m \x1b[92m✓\x1b[0m  https://...";
        let clean = strip_ansi(raw.trim());
        let mut parts = clean.split_whitespace();
        assert_eq!(parts.next(), Some("nodejs"));
        assert_eq!(parts.next(), Some("✓"));
    }

    #[test]
    fn parse_download_progress_percent_and_speed() {
        // Real vfox line shape (after ANSI strip), with a bar + speed + ETA.
        let line = "Downloading...  42% [=======>] (385 kB/s) [37s:47s]";
        let prog = parse_progress(line).expect("should parse");
        assert_eq!(prog.phase, "downloading");
        assert_eq!(prog.percent, Some(42));
        assert_eq!(prog.speed.as_deref(), Some("385 kB/s"));
    }

    #[test]
    fn parse_download_progress_double_digit() {
        let prog = parse_progress("Downloading...  7% [>] (218 kB/s) [1s:2m23s]").unwrap();
        assert_eq!(prog.percent, Some(7));
    }

    #[test]
    fn parse_preinstall_phase() {
        let prog = parse_progress("Preinstalling nodejs@22.0.0...").unwrap();
        assert_eq!(prog.phase, "preinstall");
        assert_eq!(prog.percent, None);
        assert_eq!(prog.message.as_deref(), Some("Preinstalling nodejs@22.0.0"));
    }

    #[test]
    fn parse_install_phase() {
        let prog = parse_progress("Installing...").unwrap();
        assert_eq!(prog.phase, "installing");
        assert!(prog.percent.is_none());
    }

    #[test]
    fn parse_unrecognized_returns_none() {
        assert!(parse_progress("some random log line").is_none());
        assert!(parse_progress("").is_none());
    }

    fn dl(pct: u8) -> InstallProgress {
        InstallProgress {
            percent: Some(pct),
            speed: Some("1 MB/s".into()),
            phase: "downloading".to_string(),
            message: None,
        }
    }

    #[test]
    fn throttle_drops_duplicate_sig() {
        // 相同 percent+phase 的重复帧：第一次发射，之后全部丢弃。
        let mut th = ProgressThrottle::default();
        assert!(th.push(dl(42)).is_some(), "first frame must emit");
        assert!(th.push(dl(42)).is_none(), "duplicate frame must be dropped");
        assert!(th.push(dl(42)).is_none());
    }

    #[test]
    fn throttle_holds_distinct_sig_within_window() {
        // 窗口内的新帧不立即发射，而是挂起；流结束时补发最新的那帧。
        let mut th = ProgressThrottle::default();
        assert!(th.push(dl(1)).is_some(), "first frame emits immediately");
        assert!(th.push(dl(2)).is_none(), "within window: held, not emitted");
        assert!(th.push(dl(3)).is_none(), "newer frame replaces the held one");
        let flushed = th.take_pending().expect("held frame must flush at end");
        assert_eq!(flushed.percent, Some(3), "the NEWEST held frame wins");
        assert!(th.take_pending().is_none(), "flush is one-shot");
    }

    #[test]
    fn throttle_emits_after_window_elapses() {
        // 伪造「上次发射在 200ms 前」：新帧应立即发射而不是挂起。
        let mut th = ProgressThrottle::default();
        th.push(dl(1));
        th.last_emit_at = Instant::now().checked_sub(Duration::from_millis(200));
        assert!(th.push(dl(2)).is_some(), "window elapsed: emit immediately");
    }

    #[test]
    fn throttle_pending_survives_duplicate_push() {
        // 挂起 3% 后又来一帧与已发射的 1% 相同：重复帧不得清掉挂起的 3%。
        let mut th = ProgressThrottle::default();
        th.push(dl(1));
        th.push(dl(3)); // held
        assert!(th.push(dl(1)).is_none(), "duplicate of EMITTED frame dropped");
        assert_eq!(th.take_pending().unwrap().percent, Some(3));
    }

    #[test]
    fn history_records_changes_and_skips_noop() {
        let tmp = std::env::temp_dir().join("vfox_history_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let dir = tmp.to_str().unwrap();

        // First switch: nodejs 16 → no "from" field.
        append_history(dir, "nodejs", "16.20.0").unwrap();
        // Second switch: nodejs 16 → 18, should record "from": "16.20.0".
        append_history(dir, "nodejs", "18.20.0").unwrap();
        // No-op: same version again → must NOT add a duplicate entry.
        append_history(dir, "nodejs", "18.20.0").unwrap();
        // Different SDK: python, independent history line.
        append_history(dir, "python", "3.11.0").unwrap();

        let json = std::fs::read_to_string(tmp.join(".vfox-history.json")).unwrap();
        let arr: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        // 3 entries: nodejs 16, nodejs 18, python 3.11 (the no-op was skipped).
        assert_eq!(arr.len(), 3, "no-op switch must be skipped");
        assert_eq!(arr[0].get("version").unwrap().as_str(), Some("16.20.0"));
        assert!(arr[0].get("from").is_none(), "first switch has no 'from'");
        assert_eq!(arr[1].get("from").unwrap().as_str(), Some("16.20.0"));
        assert_eq!(arr[2].get("sdk").unwrap().as_str(), Some("python"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_multidot_extension() {
        // `*.gradle.kts` must match `build.gradle.kts`. The old code used
        // Path::extension() which returns only `kts`, so it never matched.
        let tmp = std::env::temp_dir().join("vfox_gui_glob_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("build.gradle.kts"), b"").unwrap();
        std::fs::write(tmp.join("settings.gradle.kts"), b"").unwrap();
        std::fs::write(tmp.join("app.csproj"), b"").unwrap();
        assert!(glob_file_exists(&tmp, "*.gradle.kts"), "multi-dot ext must match");
        assert!(glob_file_exists(&tmp, "*.csproj"), "single-dot ext still works");
        assert!(!glob_file_exists(&tmp, "*.gradle"), "should not false-match .kts files");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod scanner_tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("vfox_scan_{}", name));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn pkg_json_without_engines_still_reports_node() {
        // package.json with no engines.node must still report Node.js.
        let d = tmp("pkg");
        fs::write(d.join("package.json"), r#"{"name":"x"}"#).unwrap();
        let res = detect_project_sdks_sync(&d).unwrap();
        assert!(res.iter().any(|x| x.sdk == "nodejs"), "must report nodejs");
        assert!(res.iter().all(|x| x.sdk != "java"), "no gradle → no java");
    }

    #[test]
    fn kotlin_kts_does_not_duplicate_java() {
        // build.gradle.kts → Kotlin only, not Java+Kotlin.
        let d = tmp("kts");
        fs::write(d.join("build.gradle.kts"), "plugins {}").unwrap();
        let res = detect_project_sdks_sync(&d).unwrap();
        assert!(res.iter().any(|x| x.sdk == "kotlin"), "must report kotlin");
        assert!(!res.iter().any(|x| x.sdk == "java"), "must not duplicate as java");
    }

    #[test]
    fn gradle_groovy_reports_java() {
        // build.gradle (Groovy) → Java.
        let d = tmp("gradle");
        fs::write(d.join("build.gradle"), "apply plugin: 'java'").unwrap();
        let res = detect_project_sdks_sync(&d).unwrap();
        assert!(res.iter().any(|x| x.sdk == "java"));
    }

    #[test]
    fn multi_language_project() {
        // A project with several language markers detects all of them.
        let d = tmp("multi");
        fs::write(d.join("package.json"), r#"{"engines":{"node":">=20"}} "#).unwrap();
        fs::write(d.join("go.mod"), "module x\ngo 1.22\n").unwrap();
        fs::write(d.join("requirements.txt"), "flask\n").unwrap();
        let res = detect_project_sdks_sync(&d).unwrap();
        let sdks: Vec<_> = res.iter().map(|x| x.sdk.as_str()).collect();
        assert!(sdks.contains(&"nodejs"));
        assert!(sdks.contains(&"golang"));
        assert!(sdks.contains(&"python"));
    }

    #[test]
    fn tool_versions_creates_new() {
        let d = tmp("tv_new");
        write_tool_versions(d.to_str().unwrap(), "java", "21.0.10-graal").unwrap();
        let content = fs::read_to_string(d.join(".tool-versions")).unwrap();
        assert_eq!(content.trim(), "java 21.0.10-graal");
    }

    #[test]
    fn tool_versions_preserves_other_sdks() {
        // Writing java must not clobber an existing nodejs entry.
        let d = tmp("tv_keep");
        fs::write(d.join(".tool-versions"), "nodejs 24.16.0\npython 3.13.12\n").unwrap();
        write_tool_versions(d.to_str().unwrap(), "java", "25.0.2+10").unwrap();
        let content = fs::read_to_string(d.join(".tool-versions")).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert!(lines.contains(&"nodejs 24.16.0"), "nodejs entry must survive");
        assert!(lines.contains(&"python 3.13.12"), "python entry must survive");
        assert!(lines.contains(&"java 25.0.2+10"), "java entry must be added");
    }

    #[test]
    fn tool_versions_updates_existing() {
        // Re-writing the same SDK replaces the old version, doesn't duplicate.
        let d = tmp("tv_update");
        fs::write(d.join(".tool-versions"), "java 21.0.10-graal\n").unwrap();
        write_tool_versions(d.to_str().unwrap(), "java", "25.0.2+10").unwrap();
        let content = fs::read_to_string(d.join(".tool-versions")).unwrap();
        let count = content.matches("java ").count();
        assert_eq!(count, 1, "must replace, not duplicate");
        assert!(content.contains("25.0.2+10"));
        assert!(!content.contains("21.0.10-graal"));
    }
}

#[cfg(test)]
mod global_packages_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bins_from_manifest_object_string_and_missing() {
        let obj = json!({ "name": "opencode", "bin": { "opencode": "cli.js", "oc": "cli.js" } });
        let mut bins = bins_from_manifest(&obj, "opencode");
        bins.sort(); // 对象键序无语义
        assert_eq!(bins, vec!["oc", "opencode"]);

        let single = json!({ "name": "dsh", "bin": "cli.js" });
        assert_eq!(bins_from_manifest(&single, "dsh"), vec!["dsh"]);

        let none = json!({ "name": "left-pad" });
        assert!(bins_from_manifest(&none, "left-pad").is_empty());
    }

    #[test]
    fn protected_packages_are_rejected_others_pass() {
        assert!(protected_reason("nodejs", "npm").is_some());
        assert!(protected_reason("nodejs", "corepack").is_some());
        assert!(protected_reason("python", "pip").is_some());
        assert!(protected_reason("python", "setuptools").is_some());
        assert!(protected_reason("nodejs", "express").is_none());
        assert!(protected_reason("python", "requests").is_none());
        assert!(protected_reason("golang", "npm").is_none(), "名单按生态隔离");
    }

    #[test]
    fn pkg_dir_resolves_scoped_packages() {
        let nm = Path::new("D:/x/node_modules");
        assert_eq!(pkg_dir_for(nm, "lodash"), nm.join("lodash"));
        assert_eq!(
            pkg_dir_for(nm, "@opencode/cli"),
            nm.join("@opencode").join("cli")
        );
    }

    #[test]
    fn key_tool_bins_are_detected() {
        let hits = key_tools_in(&["pnpm".into(), "mycli".into(), "prisma".into()]);
        assert_eq!(hits, vec!["pnpm".to_string(), "prisma".to_string()]);
        assert!(key_tools_in(&["mycli".into()]).is_empty());
    }

    #[test]
    fn scan_node_tree_expands_scope_and_flags_corruption() {
        let root = std::env::temp_dir().join("vfox_gpkg_scan");
        let _ = std::fs::remove_dir_all(&root);
        let nm = root.join("node_modules");
        std::fs::create_dir_all(nm.join("@scope").join("pkg")).unwrap();
        std::fs::create_dir_all(nm.join("plain")).unwrap();
        std::fs::create_dir_all(nm.join(".bin")).unwrap();
        std::fs::write(
            nm.join("@scope").join("pkg").join("package.json"),
            r#"{"name":"@scope/pkg","version":"1.0.0","bin":{"sc":"a.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            nm.join("plain").join("package.json"),
            r#"{"name":"plain","version":"2.0.0","description":"d"}"#,
        )
        .unwrap();

        // root == nm：旧 scan_node_modules 的语义（只产出包清单，不含运行时本体）
        let scan = scan_node_tree(&nm, &nm);
        // npm 缺失 → 树损坏
        assert_eq!(scan.corrupt.as_deref(), Some("npm-missing"));
        assert_eq!(scan.packages.len(), 2);
        let scoped = scan.packages.iter().find(|e| e.name == "@scope/pkg").unwrap();
        assert_eq!(scoped.bins, vec!["sc".to_string()]);
        assert!(scan.packages.iter().all(|e| e.name != ".bin"));

        // npm 在场 → 无损坏告警
        std::fs::create_dir_all(nm.join("npm")).unwrap();
        std::fs::write(
            nm.join("npm").join("package.json"),
            r#"{"name":"npm","version":"10.0.0"}"#,
        )
        .unwrap();
        let scan = scan_node_tree(&nm, &nm);
        assert!(scan.corrupt.is_none());
        assert_eq!(scan.packages.len(), 3);
        assert!(scan.packages[0].bytes >= scan.packages[scan.packages.len() - 1].bytes, "按体积降序");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_node_tree_single_pass_splits_runtime_and_packages() {
        let root = std::env::temp_dir().join("vfox_gpkg_singlepass");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let nm = root.join("node_modules");
        // 运行时本体：node.exe（node_modules 之外）
        std::fs::write(root.join("node.exe"), vec![0u8; 100]).unwrap();
        let npm_manifest = r#"{"name":"npm","version":"10.0.0"}"#;
        // npm：含嵌套 node_modules——深层字节也计入 npm 包本体
        std::fs::create_dir_all(nm.join("npm").join("lib")).unwrap();
        std::fs::create_dir_all(nm.join("npm").join("node_modules").join("dep")).unwrap();
        std::fs::write(nm.join("npm").join("package.json"), npm_manifest).unwrap();
        std::fs::write(nm.join("npm").join("lib").join("cli.js"), vec![0u8; 40]).unwrap();
        std::fs::write(nm.join("npm").join("node_modules").join("dep").join("x.js"), vec![0u8; 6]).unwrap();
        // typescript：description + bin 对象形态
        let ts_manifest =
            r#"{"name":"typescript","version":"5.5.0","description":"TS","bin":{"tsc":"bin/tsc","tsserver":"bin/tss"}}"#;
        std::fs::create_dir_all(nm.join("typescript").join("lib")).unwrap();
        std::fs::write(nm.join("typescript").join("package.json"), ts_manifest).unwrap();
        std::fs::write(nm.join("typescript").join("lib").join("tsc.js"), vec![0u8; 200]).unwrap();
        // @scope 包
        let scoped_manifest = r#"{"name":"@scope/pkg","version":"1.0.0"}"#;
        std::fs::create_dir_all(nm.join("@scope").join("pkg")).unwrap();
        std::fs::write(nm.join("@scope").join("pkg").join("package.json"), scoped_manifest).unwrap();
        std::fs::write(nm.join("@scope").join("pkg").join("i.js"), vec![0u8; 30]).unwrap();
        // 非包字节：.bin、.package-lock.json（隐藏路径归运行时本体）
        std::fs::create_dir_all(nm.join(".bin")).unwrap();
        std::fs::write(nm.join(".bin").join("tsc.cmd"), vec![0u8; 4]).unwrap();
        std::fs::write(nm.join(".package-lock.json"), vec![0u8; 20]).unwrap();

        let scan = scan_node_tree(&root, &nm);
        assert!(scan.corrupt.is_none());
        let named = |n: &str| scan.packages.iter().find(|p| p.name == n).unwrap();
        assert_eq!(scan.packages.len(), 3, "npm/typescript/@scope/pkg，无 .bin");
        let npm_total = npm_manifest.len() as u64 + 40 + 6;
        let ts_total = ts_manifest.len() as u64 + 200;
        let scoped_total = scoped_manifest.len() as u64 + 30;
        assert_eq!(named("npm").bytes, npm_total, "嵌套 node_modules 与包自身 package.json 计入 npm");
        assert_eq!(named("typescript").bytes, ts_total);
        assert_eq!(named("@scope/pkg").bytes, scoped_total);
        assert_eq!(scan.packages_bytes, npm_total + ts_total + scoped_total);
        assert_eq!(scan.runtime_bytes, 124, "node.exe 100 + .bin 4 + lock 20");
        let ts = named("typescript");
        assert_eq!(ts.bins, vec!["tsc".to_string(), "tsserver".to_string()]);
        assert_eq!(ts.description.as_deref(), Some("TS"));
        assert_eq!(ts.version.as_deref(), Some("5.5.0"));
        assert_eq!(scan.packages[0].name, "typescript", "按体积降序");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod global_uninstall_tests {
    use super::*;
    use std::fs;

    /// 搭一个最小 nodejs 运行时根：node.exe 缺失（npm 不可用 → 走直删降级），
    /// 一个带 bin 的包 + 三件套 shim。验证 dry_run 不动盘、真实执行删干净。
    #[test]
    fn nodejs_uninstall_fallback_dry_run_then_real() {
        let root = std::env::temp_dir().join(format!("vfox_gp_uninstall_{}", std::process::id()));
        let nm = root.join("node_modules");
        let pkg = nm.join("fake-cli");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(
            pkg.join("package.json"),
            r#"{"name":"fake-cli","version":"1.0.0","bin":{"fake-cli":"run.js"}}"#,
        )
        .unwrap();
        fs::write(pkg.join("run.js"), "console.log(1)").unwrap();
        // Windows shim 三件套 + unix 裸名（都写上，测试按平台只断言存在的被删）
        for shim in bin_shims(&root, "fake-cli") {
            fs::write(&shim, "@echo off").unwrap();
        }

        // dry_run：列出将删路径与释放体积，但不动盘
        let mut outcome = GlobalUninstallOutcome {
            dry_run: true, would_remove: vec![], freed_bytes: 0,
            removed: vec![], failed: vec![], key_tools: vec![],
        };
        nodejs_uninstall(&root, &nm, &["fake-cli".into()], true, &mut outcome);
        assert!(outcome.removed.is_empty(), "dry_run 不得真删");
        assert_eq!(outcome.failed.len(), 0);
        assert!(outcome.freed_bytes > 0);
        assert!(outcome.would_remove.iter().any(|p| p.ends_with("fake-cli")));
        assert!(bin_shims(&root, "fake-cli").iter().all(|s| s.exists()), "dry_run 不得删 shim");
        assert!(outcome.key_tools.is_empty());

        // 真实执行（node.exe 缺失 → 降级直删）：包目录与 shim 全部消失
        let mut outcome = GlobalUninstallOutcome {
            dry_run: false, would_remove: vec![], freed_bytes: 0,
            removed: vec![], failed: vec![], key_tools: vec![],
        };
        nodejs_uninstall(&root, &nm, &["fake-cli".into()], false, &mut outcome);
        assert_eq!(outcome.removed, vec!["fake-cli".to_string()]);
        assert_eq!(outcome.failed.len(), 0);
        assert!(!pkg.exists(), "包目录应被删除");
        for shim in bin_shims(&root, "fake-cli") {
            assert!(!shim.exists(), "shim 应被删除: {}", shim.display());
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nodejs_uninstall_reports_missing_package() {
        let root = std::env::temp_dir().join(format!("vfox_gp_missing_{}", std::process::id()));
        let nm = root.join("node_modules");
        fs::create_dir_all(&nm).unwrap();
        let mut outcome = GlobalUninstallOutcome {
            dry_run: false, would_remove: vec![], freed_bytes: 0,
            removed: vec![], failed: vec![], key_tools: vec![],
        };
        nodejs_uninstall(&root, &nm, &["not-installed".into()], false, &mut outcome);
        assert!(outcome.removed.is_empty());
        assert_eq!(outcome.failed[0].0, "not-installed");
        assert_eq!(outcome.failed[0].1, "未安装");
        let _ = fs::remove_dir_all(&root);
    }
}
