import { type CSSProperties, type ReactNode } from "react";

/** Liquid-glass pill button — translucent fills that blend with the glass
 *  background, not flat opaque colors. Variants:
 *  - primary: translucent blue glass (for "switch" / confirm)
 *  - success: translucent green glass (for "install")
 *  - ghost: clear glass outline (for secondary actions) */
export default function AppleButton({
  children,
  onClick,
  disabled,
  variant = "ghost",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "success" | "ghost";
}) {
  const styles: Record<string, CSSProperties & { hoverBg?: string }> = {
    primary: {
      background: "var(--accent)",
      color: "#fff",
      border: "none",
      backdropFilter: "blur(10px)",
      hoverBg: "var(--accent-hover)",
    },
    success: {
      background: "var(--success)",
      color: "#fff",
      border: "none",
      backdropFilter: "blur(10px)",
      hoverBg: "var(--success)",
    },
    ghost: {
      background: "var(--glass-ghost-bg)",
      color: "var(--accent)",
      border: "0.5px solid var(--glass-border)",
      backdropFilter: "blur(10px)",
      hoverBg: "var(--glass-ghost-hover)",
    },
  };
  const s = styles[variant];
  const { hoverBg, ...base } = s;
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="text-[12px] px-3 py-[5px] font-medium"
      style={{
        ...base,
        WebkitBackdropFilter: base.backdropFilter,
        borderRadius: "var(--radius-pill)",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.18s cubic-bezier(0.2,0.8,0.2,1), opacity 0.18s",
      }}
      onMouseEnter={(e) => {
        if (!disabled && hoverBg) e.currentTarget.style.background = hoverBg;
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.background = base.background as string;
      }}
    >
      {children}
    </button>
  );
}

