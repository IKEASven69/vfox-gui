import { useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  Sdk, AvailableVersion, AvailableSdk,
  DiskUsageEntry, VersionScope, Theme,
} from "./constants";
import { sdkMeta } from "./constants";
import SdkSidebar from "./components/SdkSidebar";
import SdkDetail from "./components/SdkDetail";
import SettingsPage from "./components/SettingsPage";
import HelpPage from "./components/HelpPage";
import ProgressBar from "./components/ProgressBar";
import ConfirmDialog from "./components/ConfirmDialog";
import UpdateModal from "./components/UpdateModal";
import ContextMenu from "./components/ContextMenu";
import "./App.css";

type View = "main" | "settings" | "help";

export default function App() {
  // ── core state ──
  const [sdks, setSdks] = useState<Sdk[]>([]);
  const [catalog, setCatalog] = useState<AvailableSdk[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // Which page the main area shows. Selecting an SDK returns to "main".
  const [view, setView] = useState<View>("main");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{
    percent: number | null; speed: string | null; phase: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [available, setAvailable] = useState<AvailableVersion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [versionQuery, setVersionQuery] = useState("");
  const [sdkQuery, setSdkQuery] = useState("");
  const [diskUsage, setDiskUsage] = useState<DiskUsageEntry[]>([]);
  const [versionScope, setVersionScope] = useState<VersionScope>("global");
  const [projectPath, setProjectPath] = useState<string | null>(null);
  // Project version-change history (from .vfox-history.json). Only populated
  // when a project directory is selected — shows how the project's SDK
  // versions evolved over time.
  const [history, setHistory] = useState<{
    sdk: string; version: string; date: string; from: string | null;
  }[]>([]);

  // ── confirm dialog ──
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string;
    destructive: boolean; pending: () => Promise<void>;
  } | null>(null);

  // ── context menu ──
  const [ctxMenu, setCtxMenu] = useState<{
    sdk: string; x: number; y: number; installed: boolean;
  } | null>(null);

  // ── updater state ──
  const [updateState, setUpdateState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "available"; version: string; notes: string }
    | { kind: "none" }
    | { kind: "downloading"; pct: number }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  // ── theme ──
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("vfox-theme") as Theme) || "system"
  );

  // ── derived (memoised so memo'd children don't re-render needlessly) ──
  const installedMap = useMemo(
    () => new Map(sdks.map((s) => [s.name, s])),
    [sdks]
  );
  const currentSdk = useMemo(
    () => sdks.find((s) => s.name === selected) || null,
    [sdks, selected]
  );

  const filteredCatalog = useMemo(
    () =>
      catalog
        .map((c) => ({ ...c, meta: sdkMeta(c.name) }))
        .filter((c) =>
          sdkQuery
            ? c.name.includes(sdkQuery.trim().toLowerCase()) ||
              c.meta.name.toLowerCase().includes(sdkQuery.trim().toLowerCase())
            : true
        )
        // Installed SDKs first (most relevant), then alphabetical by display name.
        .sort((a, b) => {
          const aInst = installedMap.has(a.name) ? 0 : 1;
          const bInst = installedMap.has(b.name) ? 0 : 1;
          if (aInst !== bInst) return aInst - bInst;
          return a.meta.name.localeCompare(b.meta.name);
        }),
    [catalog, sdkQuery, installedMap]
  );

  const filteredVersions = useMemo(() => {
    const q = versionQuery.trim().toLowerCase();
    if (!q) return available;
    // Fuzzy: space-separated terms are AND-ed; each term matches against the
    // version OR its note tags (so "lts", "20 lts", " installed" all work).
    const terms = q.split(/\s+/);
    return available.filter((v) => {
      const hay = `${v.version} ${v.note ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [available, versionQuery]);

  // Selecting an SDK leaves the settings/help page and shows its detail.
  const selectSdk = useCallback((name: string) => {
    setSelected(name);
    setView("main");
  }, []);

  // ── theme effect ──
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    localStorage.setItem("vfox-theme", theme);
  }, [theme]);

  // ── install progress listener ──
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    // cancelled guards the race where the component unmounts before the
    // listen() promise resolves — without it the listener would leak.
    let cancelled = false;
    listen<{ percent: number | null; speed: string | null; phase: string; message: string | null }>(
      "vfox://install-progress",
      (e) => {
        const { percent, speed, phase, message } = e.payload;
        setInstallProgress({ percent, speed, phase });
        if (message) setBusyLabel(message + "…");
      }
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── context menu dismiss ──
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    document.addEventListener("click", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [ctxMenu]);

  // ── global keyboard shortcuts ──
  // Ctrl/Cmd+F focuses the SDK search; Ctrl/Cmd+, opens settings;
  // Ctrl/Cmd+/ opens help. Esc is handled per-overlay (dialogs/menu).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('input[placeholder="搜索 SDK"]');
        input?.focus();
      } else if (e.key === ",") {
        e.preventDefault();
        setView("settings");
      } else if (e.key === "/") {
        e.preventDefault();
        setView("help");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── project directory picker ──
  const pickProjectDir = useCallback(async () => {
    const selectedDir = await open({
      directory: true, multiple: false,
      title: "选择项目目录 — .tool-versions 将写入此目录",
    });
    if (selectedDir && typeof selectedDir === "string") {
      setProjectPath(selectedDir);
    } else {
      setVersionScope("global");
    }
  }, []);

  useEffect(() => {
    if (versionScope === "project" && !projectPath) pickProjectDir();
  }, [versionScope, projectPath, pickProjectDir]);

  // ── data loading ──
  const refresh = useCallback(async () => {
    try {
      // list_sdks reads the filesystem and never throws (empty if vfox is
      // absent). list_available_sdks shells out to `vfox available` and WILL
      // fail if vfox isn't installed — we tolerate that so a missing vfox
      // shows the friendly empty state instead of an error banner.
      const list = await invoke<Sdk[]>("list_sdks");
      let cat: AvailableSdk[] = [];
      try {
        cat = await invoke<AvailableSdk[]>("list_available_sdks");
      } catch {
        // vfox not installed / not on PATH → empty catalog triggers the
        // "未检测到 vfox" guide in the main area.
      }
      setSdks(list);
      setCatalog(cat);
      setSelected((prev) => {
        if (prev && list.some((s) => s.name === prev)) return prev;
        return list.length > 0 ? list[0].name : null;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const loadAvailable = useCallback(async (sdk: string) => {
    setSearchLoading(true);
    setAvailable([]);
    try {
      setAvailable(await invoke<AvailableVersion[]>("search_versions", { sdk }));
    } catch (e) {
      setError(`获取可用版本失败: ${e}`);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const loadDiskUsage = useCallback(async () => {
    try {
      setDiskUsage(await invoke<DiskUsageEntry[]>("sdk_disk_usage"));
    } catch { /* non-critical */ }
  }, []);

  const loadHistory = useCallback(async () => {
    // Project history only makes sense when a project directory is selected.
    if (!projectPath) { setHistory([]); return; }
    try {
      setHistory(await invoke<{
        sdk: string; version: string; date: string; from: string | null;
      }[]>("project_history", { projectPath }));
    } catch { setHistory([]); }
  }, [projectPath]);

  useEffect(() => {
    if (!selected) { setAvailable([]); setDiskUsage([]); return; }
    setVersionQuery("");
    loadAvailable(selected);
    loadDiskUsage();
  }, [selected, loadAvailable, loadDiskUsage]);

  // Reload project history when the project directory changes.
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const markAvailable = useCallback((version: string, installed: boolean) => {
    setAvailable((prev) => prev.map((v) => (v.version === version ? { ...v, installed } : v)));
  }, []);

  // ── toast ──
  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  // ── actions ──
  const handleUse = useCallback(async (sdk: string, version: string) => {
    setBusy(true); setBusyLabel(`切换到 ${version}…`); setError(null);
    try {
      await invoke("use_version", { sdk, version, scope: versionScope,
        projectPath: versionScope === "project" ? projectPath : null });
      flash(`${sdk} → ${version}`);
      await refresh();
      markAvailable(version, true);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [versionScope, projectPath, flash, refresh, markAvailable]);

  const handleInstall = useCallback(async (sdk: string, version: string) => {
    setBusy(true); setBusyLabel(`安装 ${sdk}@${version}…（可能需要几分钟）`);
    setInstallProgress({ percent: null, speed: null, phase: "starting" });
    setError(null);
    try {
      await invoke("install_version", { sdk, version });
      flash(`已安装 ${version}`);
      await refresh();
      markAvailable(version, true);
      // Reload disk usage so the new version's size shows up immediately.
      loadDiskUsage();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); setInstallProgress(null); }
  }, [flash, refresh, markAvailable, loadDiskUsage]);

  const handleRemove = useCallback(async (sdk: string, version: string) => {
    setConfirmState({
      title: `卸载 ${sdk}@${version}`,
      message: "确定要卸载这个版本吗？此操作无法撤销。",
      confirmLabel: "卸载", destructive: true,
      pending: async () => {
        setBusy(true); setBusyLabel(`卸载 ${version}…`); setError(null);
        try {
          await invoke("remove_version", { sdk, version });
          flash(`已卸载 ${version}`);
          await refresh();
          markAvailable(version, false);
          loadDiskUsage();
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); setBusyLabel(null); }
      },
    });
  }, [flash, refresh, markAvailable, loadDiskUsage]);

  const handleAddPlugin = useCallback(async (name: string) => {
    setBusy(true); setBusyLabel(`添加插件 ${name}…`); setError(null);
    try {
      await invoke("add_plugin", { name });
      flash(`已添加 ${sdkMeta(name).name}`);
      await refresh();
      setSelected(name);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [flash, refresh]);

  const handleRemovePlugin = useCallback(async (name: string) => {
    setCtxMenu(null);
    setConfirmState({
      title: `移除 ${sdkMeta(name).name} 插件`,
      message: "确定要移除这个 SDK 插件吗？已安装的版本会保留在磁盘上。",
      confirmLabel: "移除", destructive: true,
      pending: async () => {
        setBusy(true); setBusyLabel(`移除插件 ${name}…`); setError(null);
        try {
          await invoke("remove_plugin", { name });
          flash(`已移除 ${sdkMeta(name).name}`);
          await refresh();
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); setBusyLabel(null); }
      },
    });
  }, [flash, refresh]);

  const handleRefresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await invoke<AvailableSdk[]>("refresh_available");
      await refresh();
      if (selected) loadAvailable(selected);
      loadDiskUsage();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [selected, refresh, loadAvailable, loadDiskUsage]);

  // ── updater ──
  const checkForUpdate = useCallback(async () => {
    setUpdateState({ kind: "checking" });
    try {
      const upd = await check();
      if (upd?.available) setUpdateState({ kind: "available", version: upd.version, notes: upd.body || "" });
      else setUpdateState({ kind: "none" });
    } catch (e) { setUpdateState({ kind: "error", msg: String(e) }); }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    try {
      const upd = await check();
      if (!upd?.available) { setUpdateState({ kind: "none" }); return; }
      setUpdateState({ kind: "downloading", pct: 0 });
      // Accumulate downloaded bytes against the total from `Started` so `pct`
      // is a real 0–100 percent, not a raw chunk byte count.
      let total = 0;
      let downloaded = 0;
      await upd.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          total = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          setUpdateState({ kind: "downloading", pct });
        } else if (event.event === "Finished") {
          setUpdateState({ kind: "downloading", pct: 100 });
        }
      });
      await relaunch();
    } catch (e) { setUpdateState({ kind: "error", msg: String(e) }); }
  }, []);

  const handleVfoxUpdate = useCallback(async () => {
    setBusy(true); setBusyLabel("正在更新 vfox CLI…"); setError(null);
    try {
      flash(await invoke<string>("vfox_update") || "vfox 已更新到最新版本");
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [flash, refresh]);

  const handleSdkContextMenu = useCallback((e: React.MouseEvent, sdk: string, installed: boolean) => {
    e.preventDefault();
    setCtxMenu({ sdk, x: e.clientX, y: e.clientY, installed });
  }, []);

  // ── render ──
  return (
    <div className="flex h-screen" style={{ background: "var(--bg)" }}>
      <SdkSidebar
        loading={loading} catalog={catalog}
        installedMap={installedMap} filteredCatalog={filteredCatalog}
        selected={selected} sdkQuery={sdkQuery} busy={busy}
        sdksCount={sdks.length} view={view}
        onSelect={selectSdk} onAddPlugin={handleAddPlugin}
        onContextMenu={handleSdkContextMenu}
        onSdkQueryChange={setSdkQuery}
        onOpenSettings={() => setView("settings")}
        onOpenHelp={() => setView("help")}
        onScanInstall={handleAddPlugin}
        onSnapshotRestored={refresh}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {busyLabel && <ProgressBar label={busyLabel} install={installProgress} />}

        {view === "settings" ? (
          <SettingsPage
            theme={theme} onThemeChange={setTheme}
            onCheckUpdate={checkForUpdate} onVfoxUpdate={handleVfoxUpdate}
            busy={busy}
          />
        ) : view === "help" ? (
          <HelpPage />
        ) : currentSdk ? (
          <SdkDetail
            currentSdk={currentSdk}
            filteredVersions={filteredVersions} diskUsage={diskUsage}
            history={history}
            searchLoading={searchLoading} versionQuery={versionQuery}
            busy={busy} error={error}
            versionScope={versionScope} projectPath={projectPath}
            onVersionQueryChange={setVersionQuery}
            onScopeChange={setVersionScope}
            onPickProject={pickProjectDir}
            onUse={(v) => handleUse(currentSdk.name, v)}
            onInstall={(v) => handleInstall(currentSdk.name, v)}
            onRemove={(v) => handleRemove(currentSdk.name, v)}
            onRefresh={handleRefresh}
            onRetry={() => { setError(null); setLoading(true); refresh(); }}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8"
            style={{ color: "var(--text-tertiary)" }}>
            {catalog.length === 0 ? (
              <>
                <span className="text-[40px] mb-1">🦊</span>
                <p className="text-[15px] font-medium" style={{ color: "var(--text-secondary)" }}>
                  未检测到 vfox
                </p>
                <p className="text-[13px] max-w-xs leading-relaxed">
                  请先安装 vfox 版本管理器，安装后在终端确认
                  <code className="mx-1">vfox available</code> 可正常运行，再点重新检测。
                </p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => openUrl("https://vfox.lhan.me/install.html")}
                    className="text-[13px] font-medium px-4 py-1.5 rounded-full"
                    style={{ background: "var(--accent)", color: "#fff" }}>
                    安装 vfox
                  </button>
                  <button onClick={() => { setError(null); setLoading(true); refresh(); }}
                    className="text-[13px] font-medium px-4 py-1.5 rounded-full"
                    style={{ border: "1px solid var(--hairline-strong)", color: "var(--text-secondary)" }}>
                    重新检测
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[14px]">从左侧选择一个 SDK</p>
            )}
          </div>
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-[13px] font-medium"
          style={{ background: "rgba(0,0,0,0.82)", color: "#fff", boxShadow: "var(--shadow-overlay)" }}>
          {toast}
        </div>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu {...ctxMenu}
          onView={() => { setSelected(ctxMenu.sdk); setCtxMenu(null); }}
          onAdd={() => { handleAddPlugin(ctxMenu.sdk); setCtxMenu(null); }}
          onRemove={() => handleRemovePlugin(ctxMenu.sdk)}
        />
      )}

      {/* Confirm dialog */}
      {confirmState && <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />}

      {/* Update modal */}
      {updateState.kind !== "idle" && (
        <UpdateModal state={updateState} onClose={() => setUpdateState({ kind: "idle" })}
          onInstall={downloadAndInstall} />
      )}
    </div>
  );
}
