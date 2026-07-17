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
use std::io::Read;
use std::process::Command;
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
/// Kept synchronous: it only reads the filesystem (<50ms) and the frontend
/// consumes the Vec directly (no Result wrapper).
#[tauri::command]
pub fn list_sdks() -> Vec<Sdk> {
    vfox::list_sdks()
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
        // Always run global use — this updates the Windows registry.
        let result = run_vfox(&["use", &target, "--global"], /*tolerate_shell_err*/ true);

        // For project scope, write .tool-versions ourselves. vfox's --project
        // requires a shell hook (IsHookEnv), which a GUI process can't provide.
        // Writing the file directly is more reliable. Surface write errors so
        // the user knows the project pin didn't happen (was silently dropped).
        if is_project {
            match proj_dir {
                Some(ref dir) => {
                    if let Err(e) = write_tool_versions(dir, &sdk, &version) {
                        // Don't fail the whole command (global use succeeded),
                        // but append a warning the frontend can show.
                        return result.map(|ok| format!("{}\n⚠️ 项目 .tool-versions 写入失败: {}", ok, e));
                    }
                    // Record this version change in the project history so the
                    // timeline view can show how the project's SDK versions
                    // evolved. Errors here are non-fatal (best-effort logging).
                    let _ = append_history(dir, &sdk, &version);
                }
                None => {
                    return result.map(|ok| format!("{}\n⚠️ 未选择项目目录，跳过 .tool-versions 写入", ok));
                }
            }
        }

        result
    })
    .await
    .map_err(|e| format!("后台任务失败: {}", e))?
}

/// Write or update a `.tool-versions` file in the project directory.
/// Format: `<sdk> <version>`, one per line. Existing entries for other SDKs
/// are preserved; the entry for `sdk` is replaced if it already exists.
fn write_tool_versions(dir: &str, sdk: &str, version: &str) -> Result<(), String> {
    use std::io::{BufRead, Write};
    let path = std::path::Path::new(dir).join(".tool-versions");

    let mut lines: Vec<String> = Vec::new();
    let mut found = false;
    if path.exists() {
        if let Ok(file) = std::fs::File::open(&path) {
            for line in std::io::BufReader::new(file).lines() {
                let line = line.unwrap_or_default();
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    lines.push(line);
                } else if trimmed.starts_with(&format!("{} ", sdk)) {
                    lines.push(format!("{} {}", sdk, version));
                    found = true;
                } else {
                    lines.push(line);
                }
            }
        }
    }
    if !found {
        lines.push(format!("{} {}", sdk, version));
    }

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("无法创建 .tool-versions: {}", e))?;
    for l in &lines {
        writeln!(file, "{}", l).map_err(|e| format!("写入失败: {}", e))?;
    }
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

/// Current timestamp as "YYYY-MM-DD HH:MM" (no chrono dependency — format by hand).
fn chrono_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert epoch seconds to UTC date-time via the civil-from-days algorithm.
    let days = (secs / 86400) as i64;
    let secs_of_day = (secs % 86400) as i64;
    let (y, m, d) = civil_from_days(days + 719468);
    let hh = secs_of_day / 3600;
    let mm = (secs_of_day % 3600) / 60;
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, hh, mm)
}

/// Howard Hinnant's civil-from-days algorithm. Returns (year, month, day).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
    let doe = (z - era * 146097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
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
    sdk: String,
    version: String,
) -> Result<String, String> {
    let target = format!("{}@{}", sdk, version);
    let sdk_check = sdk.clone();
    let version_check = version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let out = run_vfox_streaming(&["install", &target], true, &app)?;
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
        if out.is_err() {
            let dir = crate::vfox::vfox_home()
                .join("cache")
                .join(&sdk_for_fallback)
                .join(format!("v-{}", version_for_fallback));
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
                return Ok(format!("已清理残留目录: {}", dir.display()));
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
        run_vfox(&["upgrade"], false)
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
    // Build the command outside the thread so spawn errors surface directly.
    let mut cmd = Command::new("vfox");
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

    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(result) => result,
        Err(_) => Err("vfox 执行超时（60秒），可能卡住了。".to_string()),
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
fn run_vfox_streaming(args: &[&str], tolerate_shell_err: bool, app: &AppHandle) -> Result<String, String> {
    let mut cmd = Command::new("vfox");
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .env("__VFOX_SHELL", "1");

    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(std::process::ExitStatus, Vec<u8>), String>>();
    let child = cmd.spawn().map_err(|e| format!("无法启动 vfox: {}", e))?;
    // Remember the PID so we can kill it from the timeout branch (the Child
    // itself moves into the worker thread).
    let pid = child.id();

    let mut child_moved = child;
    let worker = std::thread::spawn(move || {
        let result = (|| -> Result<(std::process::ExitStatus, Vec<u8>), String> {
            let mut stderr = child_moved.stderr.take().expect("stderr piped");
            let mut stdout = child_moved.stdout.take().expect("stdout piped");

            // Drain stdout fully in a helper thread.
            let stdout_handle = std::thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = stdout.read_to_end(&mut buf);
                buf
            });

            // Drain stderr incrementally, emitting progress events.
            let mut err_buf = [0u8; 1024];
            let mut pending = String::new();
            loop {
                let n = match stderr.read(&mut err_buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                pending.push_str(&String::from_utf8_lossy(&err_buf[..n]));
                while let Some(idx) = pending.find(|c| c == '\r' || c == '\n') {
                    let line: String = pending.drain(..idx).collect();
                    if !pending.is_empty() {
                        pending.remove(0);
                    }
                    let clean = strip_ansi(&line);
                    if clean.trim().is_empty() {
                        continue;
                    }
                    if let Some(prog) = parse_progress(&clean) {
                        let _ = app.emit(INSTALL_PROGRESS_EVENT, prog);
                    }
                }
            }
            if !pending.trim().is_empty() {
                let clean = strip_ansi(&pending);
                if let Some(prog) = parse_progress(&clean) {
                    let _ = app.emit(INSTALL_PROGRESS_EVENT, prog);
                }
            }

            let stdout_bytes = stdout_handle.join().unwrap_or_default();
            let status = child_moved.wait().map_err(|e| format!("等待 vfox 退出失败: {}", e))?;
            Ok((status, stdout_bytes))
        })();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(Ok((status, stdout_bytes))) => {
            let mut combined = String::new();
            if !stdout_bytes.is_empty() {
                combined.push_str(&String::from_utf8_lossy(&stdout_bytes));
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
            // reads unblock and the thread can wind down. We use `taskkill` on
            // Windows (kills the whole tree) / `kill` elsewhere.
            #[cfg(windows)]
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).spawn();
            #[cfg(not(windows))]
            let _ = Command::new("kill").args(["-9", &pid.to_string()]).spawn();
            let _ = worker.join();
            Err("vfox 安装超时（10 分钟），可能网络卡住。".to_string())
        }
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut sdks = crate::vfox::list_sdks();
        if let Some(sdk) = &only_sdk {
            sdks.retain(|s| &s.name == sdk);
        }
        // Only persist SDKs that have a current version — restoring one with
        // no selection would be a no-op anyway.
        sdks.retain(|s| s.current.is_some());
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
