import { useEffect } from "react";
import AppleButton from "./AppleButton";

/** App self-update modal (tauri-plugin-updater). */
export default function UpdateModal({
  state,
  onClose,
  onInstall,
}: {
  state:
    | { kind: "checking" }
    | { kind: "available"; version: string; notes: string }
    | { kind: "none" }
    | { kind: "downloading"; pct: number }
    | { kind: "error"; msg: string };
  onClose: () => void;
  onInstall: () => void;
}) {
  // Esc dismisses unless a download is in flight (can't safely interrupt).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.kind !== "downloading") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.kind, onClose]);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={state.kind === "downloading" ? undefined : onClose}
    >
      <div
        className="w-[22rem] rounded-[14px] p-5 modal-enter"
        style={{ background: "var(--card)", boxShadow: "var(--shadow-overlay)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {state.kind === "checking" && (
          <div className="flex flex-col items-center gap-3 py-2">
            <Spinner />
            <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>正在检查更新…</p>
          </div>
        )}
        {state.kind === "none" && (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <span className="text-[32px]">✅</span>
            <p className="text-[14px]" style={{ color: "var(--text)" }}>已是最新版本</p>
          </div>
        )}
        {state.kind === "available" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[28px]">⬇️</span>
              <div>
                <p className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
                  发现新版本 <code style={{ color: "var(--accent)" }}>{state.version}</code>
                </p>
              </div>
            </div>
            {state.notes && (
              <pre
                className="text-[12px] whitespace-pre-wrap max-h-40 overflow-y-auto px-3 py-2 rounded-[8px]"
                style={{ background: "var(--card-secondary)", color: "var(--text-secondary)" }}
              >
                {state.notes}
              </pre>
            )}
            <div className="flex justify-end gap-2 mt-1">
              <AppleButton variant="ghost" onClick={onClose}>稍后</AppleButton>
              <AppleButton variant="primary" onClick={onInstall}>下载并安装</AppleButton>
            </div>
          </div>
        )}
        {state.kind === "downloading" && (
          <div className="flex flex-col gap-3 py-3">
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                正在下载并安装更新… {state.pct}%
              </span>
            </div>
            {/* Determinate bar — reuses the same look as the install ProgressBar. */}
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--hairline-strong)" }}>
              <div className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${state.pct}%`, background: "var(--accent)" }} />
            </div>
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>完成后将自动重启应用</p>
          </div>
        )}
        {state.kind === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[24px]">⚠️</span>
              <p className="text-[14px] font-medium" style={{ color: "var(--danger)" }}>检查更新失败</p>
            </div>
            <pre className="text-[12px] whitespace-pre-wrap px-3 py-2 rounded-[8px]" style={{ background: "var(--card-secondary)", color: "var(--text-secondary)" }}>
              {state.msg}
            </pre>
            <div className="flex justify-end gap-2">
              <AppleButton variant="ghost" onClick={onClose}>关闭</AppleButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="vfox-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: "var(--accent)" }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
