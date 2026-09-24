// vfox-gui — a lightweight Tauri front-end for the vfox version manager.
// See the `vfox` and `commands` modules for the data layer and the
// frontend-facing command surface.

mod commands;
mod vfox;

use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager,
};

/// 持久化的 UI 语言（托盘菜单/窗口标题在 Rust 侧，只在启动时构建一次，
/// 不持久化就永远停留在上次启动的语言）。默认中文，与 webview 侧的
/// localStorage("vfox-lang") 由前端在切换时同步写入。
fn persisted_lang() -> String {
    std::fs::read_to_string(crate::vfox::vfox_home().join("gui-lang"))
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| s == "en" || s == "zh")
        .unwrap_or_else(|| "zh".into())
}

fn window_title(lang: &str) -> &'static str {
    if lang == "en" { "vfox — Version Manager" } else { "vfox — 版本管理器" }
}

/// 按语言构建托盘菜单（id 固定，事件处理与语言无关）。
fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let t = |zh: &'static str, en: &'static str| -> &'static str {
        if lang == "en" { en } else { zh }
    };
    let show = MenuItemBuilder::with_id("show", t("显示窗口", "Show Window")).build(app)?;
    let hide = MenuItemBuilder::with_id("hide", t("隐藏窗口", "Hide Window")).build(app)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let check_update =
        MenuItemBuilder::with_id("check_update", t("检查应用更新", "Check for Updates")).build(app)?;
    let update_vfox =
        MenuItemBuilder::with_id("update_vfox", t("更新 vfox CLI", "Update vfox CLI")).build(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", t("退出", "Quit")).build(app)?;

    MenuBuilder::new(app)
        .item(&show)
        .item(&hide)
        .item(&sep1)
        .item(&check_update)
        .item(&update_vfox)
        .item(&sep2)
        .item(&quit)
        .build()
}

/// 把菜单/提示/窗口标题套用到托盘（启动时与语言切换时共用）。
fn apply_tray(app: &AppHandle, tray: &TrayIcon, lang: &str) {
    if let Ok(menu) = build_tray_menu(app, lang) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(window_title(lang)));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(window_title(lang));
    }
}

/// 供 set_app_language 命令拿到的托盘句柄（TrayIcon 内部是 Arc，克隆廉价）。
pub(crate) struct TrayHandle(pub TrayIcon);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // ── System Tray ──
            let lang = persisted_lang();
            let app_handle = app.handle().clone();

            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref();
                    match id {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        // Forward to the frontend so it can run the same handler
                        // as the in-app button (opens the update modal etc.).
                        "check_update" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let _ = app.emit("tray://action", "check_update");
                        }
                        "update_vfox" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            let _ = app.emit("tray://action", "update_vfox");
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left, ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            apply_tray(&app_handle, &tray, &lang);
            app.manage(TrayHandle(tray));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray instead of closing.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sdks,
            commands::list_available_sdks,
            commands::refresh_available,
            commands::use_version,
            commands::install_version,
            commands::remove_version,
            commands::add_plugin,
            commands::remove_plugin,
            commands::search_versions,
            commands::sdk_disk_usage,
            commands::vfox_update,
            commands::detect_project_sdks,
            commands::save_snapshot,
            commands::list_snapshots,
            commands::delete_snapshot,
            commands::restore_snapshot,
            commands::project_history,
            commands::app_version,
            commands::set_app_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
