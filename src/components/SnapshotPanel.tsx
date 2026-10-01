import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
// 别名导入：组件内有局部 save(scope) 保存函数，避免遮蔽
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import ConfirmDialog from "./ConfirmDialog";

interface SnapshotInfo {
  name: string;
  sdk_count: number;
}

interface Props {
  busy: boolean;
  /** Currently selected SDK — used for the "save current only" action. */
  selectedSdk: string | null;
  /** Called after a successful restore so the parent can refresh SDK state. */
  onRestored?: () => void;
  /** 恢复快照期间置位 App 级 busy：后端在逐个执行 `vfox use --global`，
   *  此时主区域的安装/切换/卸载若仍可点，会并发修改注册表和 symlink。 */
  onBusyChange?: (b: boolean) => void;
}

/** Environment snapshot manager — save/restore SDK version combinations.
 *  Two save modes: "current" stores just the selected SDK (restoring touches
 *  only it); "all" stores every SDK (restoring replays the full environment). */
export default function SnapshotPanel({ busy, selectedSdk, onRestored, onBusyChange }: Props) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshots(await invoke<SnapshotInfo[]>("list_snapshots"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 与 App 层同款：连续操作时清掉上一个计时器，卸载时不再 setState
  const msgTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (msgTimerRef.current !== null) window.clearTimeout(msgTimerRef.current);
  }, []);
  const flash = useCallback((m: string) => {
    setMsg(m);
    if (msgTimerRef.current !== null) window.clearTimeout(msgTimerRef.current);
    msgTimerRef.current = window.setTimeout(() => setMsg(null), 3000);
  }, []);

  const save = async (scope: "current" | "all") => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const only = scope === "current" ? selectedSdk : null;
      flash(await invoke<string>("save_snapshot", { name: name.trim(), onlySdk: only }));
      setName("");
      await load();
    } catch (e) {
      flash(String(e));
    } finally {
      setSaving(false);
    }
  };

  const doRestore = useCallback(async (n: string) => {
    setSaving(true);
    onBusyChange?.(true);
    try {
      flash(await invoke<string>("restore_snapshot", { name: n }));
      // Tell the parent to reload SDK state so version labels reflect the
      // restored versions — without this the UI looks unchanged after restore.
      onRestored?.();
    } catch (e) {
      flash(t("snapshot.error", { error: String(e) }));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }, [onRestored, onBusyChange]);

  // 删除走确认弹窗（与其他破坏性操作一致），失败不再静默吞掉
  const doDelete = useCallback(async (n: string) => {
    try {
      await invoke("delete_snapshot", { name: n });
      flash(t("snapshot.deleted", { name: n }));
      await load();
    } catch (e) {
      flash(String(e));
    }
  }, [flash, load, t]);

  // C4：导出——存一个副本到用户所选路径（快照原件不动）
  const doExport = useCallback(async (n: string) => {
    try {
      const dest = await saveDialog({
        defaultPath: `${n}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!dest) return;
      flash(await invoke<string>("export_snapshot", { name: n, destPath: dest }));
    } catch (e) {
      flash(String(e));
    }
  }, [flash]);

  // C4：导入——选外部快照 JSON，校验结构后落进快照目录（重名自动加后缀）
  const doImport = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof picked !== "string") return;
      const imported = await invoke<string>("import_snapshot", { srcPath: picked });
      flash(t("snapshot.imported", { name: imported }));
      await load();
    } catch (e) {
      flash(String(e));
    }
  }, [flash, load, t]);

  return (
    <div className="px-4 py-3 border-b" style={{ borderColor: "var(--hairline)" }}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}
          title={t("snapshot.saveHint")}>
          {t("snapshot.saveTitle")}
        </p>
        {/* C4：导入外部快照文件 */}
        <button
          onClick={doImport}
          disabled={busy || saving}
          className="text-[12px] leading-none px-1.5 py-0.5 rounded-full font-medium disabled:opacity-30 hover:bg-[var(--hairline)] transition-opacity"
          style={{ color: "var(--accent)" }}
          title={t("snapshot.importHint")}
          aria-label={t("snapshot.importHint")}
        >
          ⇧
        </button>
      </div>

      {/* Save form — name on its own row, then two equal-width buttons below.
          Stacked so the narrow sidebar never squeezes buttons unevenly. */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // 回车复用"保存当前 SDK"按钮的禁用条件：selectedSdk 为空时回车
          // 会绕过按钮禁用、把 null 传成 onlySdk 等价于"保存全部"
          if (e.key === "Enter" && selectedSdk && !busy && !saving) save("current");
        }}
        placeholder={t("sidebar.snapshotPlaceholder")}
        className="w-full bg-transparent outline-none text-[12px] px-2 py-1.5 rounded-[6px] mb-1.5 glass-input"
        style={{ color: "var(--text)" }}
        disabled={busy || saving}
      />
      <div className="flex gap-1.5 mb-2">
        <button
          onClick={() => save("current")}
          disabled={busy || saving || !name.trim() || !selectedSdk}
          className="flex-1 text-[11px] py-1.5 rounded-[6px] font-medium disabled:opacity-30 transition-opacity text-center"
          style={{ background: "var(--accent)", color: "#fff", backdropFilter: "blur(10px)" }}
          title={selectedSdk ? t("snapshot.saveSdkHint", { sdk: selectedSdk }) : t("snapshot.pickSdkHint")}
        >
           {t("snapshot.saveCurrent")}
        </button>
        <button
          onClick={() => save("all")}
          disabled={busy || saving || !name.trim()}
          className="flex-1 text-[11px] py-1.5 rounded-[6px] font-medium disabled:opacity-30 transition-opacity text-center"
          style={{ background: "var(--glass-ghost-bg)", color: "var(--text-secondary)", border: "0.5px solid var(--glass-border)", backdropFilter: "blur(10px)" }}
          title={t("snapshot.saveAllHint")}
        >
           {t("snapshot.saveAll")}
        </button>
      </div>

      {msg && (
        <p className="text-[10px] mb-1.5 px-1" style={{ color: "var(--text-secondary)" }}>{msg}</p>
      )}

      {/* List */}
      {snapshots.length === 0 ? (
        <p className="text-[11px] px-1" style={{ color: "var(--text-tertiary)" }}>{t("sidebar.noSnapshots")}</p>
      ) : (
        <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
          {snapshots.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 px-2 py-0.5 rounded-[4px] glass-row"
            >
              <span className="text-[12px] flex-1 truncate" style={{ color: "var(--text)" }}>
                {s.name}
                <span className="ml-1" style={{ color: "var(--text-tertiary)", fontSize: 10 }}>
                  ({s.sdk_count})
                </span>
              </span>
              <button
                onClick={() => setRestoreConfirm(s.name)}
                disabled={busy || saving}
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium disabled:opacity-30 transition-opacity"
                style={{ color: "var(--accent)" }}
                title={t("snapshot.restoreHint")}
              >
                {t("snapshot.restoreButton")}
              </button>
              {/* C4：导出该快照的 JSON 副本 */}
              <button
                onClick={() => doExport(s.name)}
                disabled={busy || saving}
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium disabled:opacity-30 opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--accent)" }}
                title={t("snapshot.exportHint")}
                aria-label={t("snapshot.exportHint")}
              >
                ⇓
              </button>
              <button
                onClick={() => setDeleteConfirm(s.name)}
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--danger)" }}
                title={t("sidebar.deleteSnapshot")}
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Restore confirmation — reuses the styled ConfirmDialog. */}
      {restoreConfirm && (
        <ConfirmDialog
          state={{
            title: t("snapshot.restoreConfirm") + `「${restoreConfirm}」`,
            message: t("snapshot.restoreMessage"),
            confirmLabel: t("snapshot.restoreButton"),
            destructive: false,
            pending: async () => { await doRestore(restoreConfirm); },
          }}
          onClose={() => setRestoreConfirm(null)}
        />
      )}

      {/* Delete confirmation — 快照也是用户数据，卸载/恢复都有确认，
          删除不该一键即删 */}
      {deleteConfirm && (
        <ConfirmDialog
          state={{
            title: t("snapshot.deleteConfirm") + `「${deleteConfirm}」`,
            message: t("snapshot.deleteMessage"),
            confirmLabel: t("common.delete"),
            destructive: true,
            pending: async () => { await doDelete(deleteConfirm); },
          }}
          onClose={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}

