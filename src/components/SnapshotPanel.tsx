import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
}

/** Environment snapshot manager — save/restore SDK version combinations.
 *  Two save modes: "current" stores just the selected SDK (restoring touches
 *  only it); "all" stores every SDK (restoring replays the full environment). */
export default function SnapshotPanel({ busy, selectedSdk, onRestored }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshots(await invoke<SnapshotInfo[]>("list_snapshots"));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const save = async (scope: "current" | "all") => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const only = scope === "current" ? selectedSdk : null;
      flash(await invoke<string>("save_snapshot", { name: name.trim(), onlySdk: only }));
      setName("");
      await load();
    } catch (e) {
      flash(`错误: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const doRestore = useCallback(async (n: string) => {
    setSaving(true);
    try {
      flash(await invoke<string>("restore_snapshot", { name: n }));
      // Tell the parent to reload SDK state so version labels reflect the
      // restored versions — without this the UI looks unchanged after restore.
      onRestored?.();
    } catch (e) {
      flash(`恢复失败: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [onRestored]);

  const handleDelete = async (n: string) => {
    try {
      await invoke("delete_snapshot", { name: n });
      await load();
    } catch { /* ignore */ }
  };

  return (
    <div className="px-4 py-3 border-b" style={{ borderColor: "var(--hairline)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-tertiary)" }}
        title="保存当前 SDK 版本组合，日后一键恢复。单 SDK 快照恢复时只动那一个，全量快照恢复全部。">
        环境快照
      </p>

      {/* Save form — name on its own row, then two equal-width buttons below.
          Stacked so the narrow sidebar never squeezes buttons unevenly. */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save("current")}
        placeholder="快照名称…"
        className="w-full bg-transparent outline-none text-[12px] px-2 py-1.5 rounded-[6px] mb-1.5"
        style={{ background: "var(--card)", color: "var(--text)" }}
        disabled={busy || saving}
      />
      <div className="flex gap-1.5 mb-2">
        <button
          onClick={() => save("current")}
          disabled={busy || saving || !name.trim() || !selectedSdk}
          className="flex-1 text-[11px] py-1.5 rounded-[6px] font-medium disabled:opacity-30 transition-opacity text-center"
          style={{ background: "var(--accent)", color: "#fff" }}
          title={selectedSdk ? `仅保存当前选中的 ${selectedSdk}，恢复时只影响它` : "先在左侧选择一个 SDK"}
        >
          保存当前 SDK
        </button>
        <button
          onClick={() => save("all")}
          disabled={busy || saving || !name.trim()}
          className="flex-1 text-[11px] py-1.5 rounded-[6px] font-medium disabled:opacity-30 transition-opacity text-center"
          style={{ background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--hairline-strong)" }}
          title="保存所有已安装 SDK 的当前版本，恢复时还原全部"
        >
          保存全部
        </button>
      </div>

      {msg && (
        <p className="text-[10px] mb-1.5 px-1" style={{ color: "var(--text-secondary)" }}>{msg}</p>
      )}

      {/* List */}
      {snapshots.length === 0 ? (
        <p className="text-[11px] px-1" style={{ color: "var(--text-tertiary)" }}>暂无快照</p>
      ) : (
        <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
          {snapshots.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5 px-2 py-0.5 rounded-[4px]"
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hairline)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
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
                title="恢复此快照"
              >
                恢复
              </button>
              <button
                onClick={() => handleDelete(s.name)}
                className="text-[10px] px-1.5 py-0.5 rounded-full font-medium opacity-50 hover:opacity-100 transition-opacity"
                style={{ color: "var(--danger)" }}
                title="删除快照"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Restore confirmation — reuses the styled ConfirmDialog. */}
      {restoreConfirm && (
        <ConfirmDialog
          state={{
            title: `恢复快照「${restoreConfirm}」`,
            message: "将切换回快照保存时的版本。单 SDK 快照只影响该 SDK，全部快照会恢复所有 SDK。",
            confirmLabel: "恢复",
            destructive: false,
            pending: async () => { await doRestore(restoreConfirm); },
          }}
          onClose={() => setRestoreConfirm(null)}
        />
      )}
    </div>
  );
}

