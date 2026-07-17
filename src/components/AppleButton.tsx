import { type CSSProperties, type ReactNode } from "react";

/** macOS Sequoia pill button. Variants: primary (blue fill), success (green fill), ghost (outline).
 *  Hover now shifts the background (Sequoia depth) instead of only dimming opacity. */
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
    primary: { background: "var(--accent)", color: "#fff", border: "none", hoverBg: "var(--accent-hover)" },
    success: { background: "var(--success)", color: "#fff", border: "none", hoverBg: "var(--success-hover, var(--success))" },
    ghost: {
      background: "transparent",
      color: "var(--accent)",
      border: "1px solid var(--hairline-strong)",
      hoverBg: "var(--accent-soft)",
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
        borderRadius: "var(--radius-pill)",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
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
