import { type ReactNode } from "react";

/** Right-click context menu for sidebar SDK items. Position is clamped to the
 *  viewport so the menu never overflows off-screen. */
export default function ContextMenu({
  x, y, installed, onView, onAdd, onRemove,
}: {
  x: number; y: number;
  installed: boolean;
  onView: () => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const MENU_W = 160;
  const MENU_H = 120;
  const clampedX = Math.min(x, window.innerWidth - MENU_W - 8);
  const clampedY = Math.min(y, window.innerHeight - MENU_H - 8);
  return (
    <div
      className="fixed z-50 rounded-[10px] py-1 min-w-[140px] modal-enter"
      style={{
        left: Math.max(8, clampedX), top: Math.max(8, clampedY),
        background: "var(--card)",
        boxShadow: "var(--shadow-overlay)",
        border: "1px solid var(--hairline)",
      }}
    >
      {installed ? (
        <>
          <ContextMenuItem onClick={onView}>查看详情</ContextMenuItem>
          <ContextMenuItem destructive onClick={onRemove}>移除插件…</ContextMenuItem>
        </>
      ) : (
        <ContextMenuItem onClick={onAdd}>添加插件</ContextMenuItem>
      )}
    </div>
  );
}

function ContextMenuItem({
  children, onClick, destructive,
}: {
  children: ReactNode; onClick: () => void; destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 text-[13px] transition-colors"
      style={{ color: destructive ? "var(--danger)" : "var(--text)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = destructive ? "var(--danger-soft)" : "var(--hairline)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
