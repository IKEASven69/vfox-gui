import { useEffect } from "react";
import AppleButton from "./AppleButton";

/** Apple-style confirmation dialog — non-blocking overlay. */
export default function ConfirmDialog({
  state,
  onClose,
}: {
  state: {
    title: string;
    message: string;
    confirmLabel: string;
    destructive: boolean;
    pending: () => Promise<void>;
  };
  onClose: () => void;
}) {
  // Esc dismisses (same as clicking the backdrop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={onClose}
    >
      <div
        className="w-[20rem] rounded-[14px] p-5 modal-enter"
        style={{ background: "var(--card)", boxShadow: "var(--shadow-overlay)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--text)" }}>
          {state.title}
        </h3>
        <p className="text-[13px] mb-4" style={{ color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {state.message}
        </p>
        <div className="flex justify-end gap-2">
          <AppleButton variant="ghost" onClick={onClose}>取消</AppleButton>
          <AppleButton
            variant={state.destructive ? "ghost" : "primary"}
            onClick={async () => {
              onClose();
              await state.pending();
            }}
          >
            <span style={{ color: state.destructive ? "var(--danger)" : undefined }}>
              {state.confirmLabel}
            </span>
          </AppleButton>
        </div>
      </div>
    </div>
  );
}
