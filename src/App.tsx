import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
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
import TitleBar from "./components/TitleBar";
import "./App.css";

type View = "main" | "settings" | "help";

export default function App() {
  const { t } = useTranslation();
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
        const input = document.querySelector<HTMLInputElement>('#sdk-search-input');
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
      title: t("project.pickDirectory"),
    });
    if (selectedDir && typeof selectedDir === "string") {
      setProjectPath(selectedDir);
    } else if (!projectPath) {
      // 取消选择只在从未选过目录时退回全局；已有项目路径的"重选后取消"
      // 应保持原状态，跳回全局与用户意图相反
      setVersionScope("global");
    }
  }, [projectPath, t]);

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

  // 可用版本列表请求序号：防快速切换 SDK 时旧响应覆盖新响应
  const availableSeqRef = useRef(0);

  const loadAvailable = useCallback(async (sdk: string) => {
    // 请求序号守卫：search_versions 是网络调用，快速切换 SDK 时旧的慢响应
    // 后到会覆盖新 SDK 的列表（标题与内容错位）
    const seq = ++availableSeqRef.current;
    setSearchLoading(true);
    setAvailable([]);
    try {
      const r = await invoke<AvailableVersion[]>("search_versions", { sdk });
      if (seq !== availableSeqRef.current) return;
      setAvailable(r);
    } catch (e) {
      if (seq !== availableSeqRef.current) return;
      setError(t("detail.searchFailed", { error: String(e) }));
    } finally {
      if (seq === availableSeqRef.current) setSearchLoading(false);
    }
  }, [t]);

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
  // toast 计时器句柄：连续操作时互相覆盖会让第二条提前消失
  const toastTimerRef = useRef<number | null>(null);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    // 连续 flash 时清掉上一个计时器，否则第一条的计时器会把第二条
    // toast 提前清空
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  // ── actions ──
  const handleUse = useCallback(async (sdk: string, version: string) => {
    setBusy(true); setBusyLabel(t("progress.switching", { version })); setError(null);
    try {
      // 后端返回值可能带 ⚠️ 警告（如项目 .tool-versions 写入失败），
      // 必须展示；其余情况保持简洁的成功文案
      const msg = await invoke<string>("use_version", { sdk, version, scope: versionScope,
        projectPath: versionScope === "project" ? projectPath : null });
      const warn = (msg || "").split("\n").find((l) => l.includes("⚠️"));
      if (warn) {
        flash(warn);
        setError(warn.replace("⚠️ ", ""));
      } else {
        flash(`${sdk} → ${version}`);
      }
      await refresh();
      markAvailable(version, true);
      // 刚发生的切换要立刻出现在项目版本时间线里（此前只依赖
      // projectPath 变化才刷新，切完看不到直到重选目录）
      void loadHistory();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [t, versionScope, projectPath, flash, refresh, markAvailable, loadHistory]);

  // ── install cancellation ──
  // 用户点了取消后，install_version 会因进程被杀而以错误结束；用这个
  // ref 区分「主动取消」和「真失败」，前者给 toast 不给错误横幅。
  const cancelRequestedRef = useRef(false);

  const handleInstall = useCallback(async (sdk: string, version: string) => {
    setBusy(true); setBusyLabel(t("progress.installing", { sdk, version }));
    setInstallProgress({ percent: null, speed: null, phase: "starting" });
    cancelRequestedRef.current = false;
    setError(null);
    try {
      await invoke("install_version", { sdk, version });
      flash(t("toast.installed", { version }));
      await refresh();
      markAvailable(version, true);
      // Reload disk usage so the new version's size shows up immediately.
      loadDiskUsage();
    } catch (e) {
      if (cancelRequestedRef.current) flash(t("toast.installCancelled"));
      else setError(String(e));
    }
    finally { setBusy(false); setBusyLabel(null); setInstallProgress(null); }
  }, [t, flash, refresh, markAvailable, loadDiskUsage]);

  const handleCancelInstall = useCallback(async () => {
    cancelRequestedRef.current = true;
    try {
      await invoke<boolean>("cancel_install");
    } catch {
      // 取消动作本身失败（如没有正在运行的安装）——不打断用户，
      // 安装若仍在进行会按正常流程结束。
      cancelRequestedRef.current = false;
    }
  }, []);

  const handleRemove = useCallback(async (sdk: string, version: string) => {
    setConfirmState({
      title: t("confirm.uninstallTitle", { sdk, version }),
      message: t("confirm.uninstallMessage"),
      confirmLabel: t("confirm.uninstallConfirm"), destructive: true,
      pending: async () => {
        setBusy(true); setBusyLabel(t("progress.uninstalling", { version })); setError(null);
        try {
          await invoke("remove_version", { sdk, version });
          flash(t("toast.uninstalled", { version }));
          await refresh();
          markAvailable(version, false);
          loadDiskUsage();
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); setBusyLabel(null); }
      },
    });
  }, [t, flash, refresh, markAvailable, loadDiskUsage]);

  const handleAddPlugin = useCallback(async (name: string) => {
    setBusy(true); setBusyLabel(t("progress.addingPlugin", { name })); setError(null);
    try {
      await invoke("add_plugin", { name });
      flash(t("toast.pluginAdded", { name: sdkMeta(name).name }));
      await refresh();
      setSelected(name);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [t, flash, refresh]);

  const handleRemovePlugin = useCallback(async (name: string) => {
    setCtxMenu(null);
    setConfirmState({
      title: t("confirm.removePluginTitle", { name: sdkMeta(name).name }),
      message: t("confirm.removePluginMessage"),
      confirmLabel: t("confirm.removePluginConfirm"), destructive: true,
      pending: async () => {
        setBusy(true); setBusyLabel(t("progress.removingPlugin", { name })); setError(null);
        try {
          await invoke("remove_plugin", { name });
          flash(t("toast.pluginRemoved", { name: sdkMeta(name).name }));
          await refresh();
        } catch (e) { setError(String(e)); }
        finally { setBusy(false); setBusyLabel(null); }
      },
    });
  }, [t, flash, refresh]);

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
    setBusy(true); setBusyLabel(t("progress.updatingVfox")); setError(null);
    try {
      flash(await invoke<string>("vfox_update") || t("toast.vfoxUpdated"));
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); setBusyLabel(null); }
  }, [t, flash, refresh]);

  // ── tray action listener (must be after checkForUpdate/handleVfoxUpdate) ──
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<string>("tray://action", (e) => {
      if (e.payload === "check_update") checkForUpdate();
      else if (e.payload === "update_vfox") handleVfoxUpdate();
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [checkForUpdate, handleVfoxUpdate]);

  // ── 启动静默检查更新 ──
  // 此前入口藏在 设置→检查更新 两层深处，多数用户永远不知道有新版。
  // 静默检查：有更新只 toast 轻提示，不弹窗不打断（要装去设置页或托盘点
  // 「检查应用更新」）。失败静默——启动时的更新检查不该变成报错。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const upd = await check();
        if (!cancelled && upd?.available) {
          flash(t("toast.updateAvailable", { version: upd.version }));
        }
      } catch { /* 静默 */ }
    })();
    return () => { cancelled = true; };
    // 仅启动一次；flash 为稳定引用，t 取挂载时语言即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSdkContextMenu = useCallback((e: React.MouseEvent, sdk: string, installed: boolean) => {
    e.preventDefault();
    setCtxMenu({ sdk, x: e.clientX, y: e.clientY, installed });
  }, []);

  // ── render ──
  return (
    <div className="flex flex-col h-screen" style={{ background: "transparent" }}>
      <TitleBar />
      <div className="flex flex-1 min-h-0">
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
        onSnapshotBusy={(b) => {
          // 快照恢复期间置位全局 busy：后端在逐个执行 vfox use，
          // 此时主区域的安装/切换/卸载必须禁用，防止并发改注册表
          setBusy(b);
          setBusyLabel(b ? t("snapshot.restoring") : null);
        }}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {busyLabel && (
          <ProgressBar
            label={busyLabel}
            install={installProgress}
            onCancel={installProgress ? handleCancelInstall : undefined}
          />
        )}

        {/* 设置/帮助页也需要展示错误：此前只有详情页渲染 error，在设置页
            点"更新 vfox"失败后界面毫无反应 */}
        {(view === "settings" || view === "help") && error && (
          <div
            className="mx-8 mt-4 mb-2 px-4 py-3 text-[12px] flex items-start justify-between gap-3 shrink-0"
            style={{ background: "var(--danger-soft)", color: "var(--danger)", borderRadius: "var(--radius-md)", backdropFilter: "blur(10px)" }}
          >
            <pre className="whitespace-pre-wrap font-mono m-0 flex-1">{error}</pre>
            <button
              onClick={() => setError(null)}
              className="shrink-0 text-[12px] font-medium px-2.5 py-1 rounded-full"
              style={{ background: "var(--danger)", color: "#fff", border: "none" }}
            >
              ✕
            </button>
          </div>
        )}

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
                  {t("empty.noVfox")}
                </p>
                <p className="text-[13px] max-w-xs leading-relaxed">
                  {t("empty.noVfoxDesc").split("vfox available").map((part, i) => (
                    i === 0 ? part : <><code className="mx-1">vfox available</code>{part}</>
                  ))}
                </p>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => openUrl("https://vfox.lhan.me/install.html")}
                    className="text-[13px] font-medium px-4 py-1.5 rounded-full"
                    style={{ background: "var(--accent)", color: "#fff" }}>
                    {t("empty.installVfox")}
                  </button>
                  <button onClick={() => { setError(null); setLoading(true); refresh(); }}
                    className="text-[13px] font-medium px-4 py-1.5 rounded-full"
                    style={{ border: "1px solid var(--hairline-strong)", color: "var(--text-secondary)" }}>
                    {t("empty.recheck")}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[14px]">{t("empty.selectSdk")}</p>
            )}
          </div>
        )}
      </main>
      </div>{/* end flex-1 sidebar+main row */}

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
