import { type ReactNode } from "react";

/** Liquid-glass grouped list — translucent container, rows separated by
 *  hairlines. Glass style uses backdrop-filter + semi-transparent bg instead
 *  of heavy shadows (filefind approach). */
export default function GroupedList({
  children,
  scrollable,
}: {
  children: ReactNode;
  scrollable?: boolean;
}) {
  return (
    <div
      className="card-enter glass-list"
      style={{
        borderRadius: "var(--radius-card)",
        // Translucent glass surface — uses CSS var so dark mode auto-adapts.
        background: "var(--glass-surface)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        border: "0.5px solid var(--glass-border)",
        boxShadow: "var(--shadow-sm)",
        // When scrollable, fill the flex parent and scroll internally so long
        // lists scroll inside the card instead of pushing the whole window.
        flex: scrollable ? "1 1 0%" : undefined,
        minHeight: 0,
        overflowY: scrollable ? "auto" : undefined,
      }}
    >
      {Array.isArray(children)
        ? children.map((child, i) => (
            <div
              key={i}
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--hairline)" }}
            >
              {child}
            </div>
          ))
        : children}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">{children}</div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3
      className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1"
      style={{ color: "var(--text-tertiary)" }}
    >
      {children}
    </h3>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <p className="text-[13px] px-1 py-2" style={{ color: "var(--text-tertiary)" }}>
      {children}
    </p>
  );
}

export function Tag({ children, color }: { children: ReactNode; color: "success" }) {
  const map = { success: { bg: "var(--success-soft)", fg: "var(--success)" } };
  return (
    <span
      className="text-[11px] px-1.5 py-0.5 font-medium"
      style={{ background: map[color].bg, color: map[color].fg, borderRadius: "var(--radius-xs)" }}
    >
      {children}
    </span>
  );
}
