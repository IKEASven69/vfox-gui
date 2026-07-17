import { type CSSProperties, type ReactNode } from "react";

/** Apple-style pill button. Variants: primary (blue fill), success (green fill), ghost (outline). */
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
  const styles: Record<string, CSSProperties> = {
    primary: { background: "var(--accent)", color: "#fff", border: "none" },
    success: { background: "var(--success)", color: "#fff", border: "none" },
    ghost: {
      background: "transparent",
      color: "var(--accent)",
      border: "1px solid var(--hairline-strong)",
    },
  };
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="text-[12px] px-3 py-[5px] rounded-full font-medium transition-opacity"
      style={{
        ...styles[variant],
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => !disabled && (e.currentTarget.style.opacity = "0.85")}
      onMouseLeave={(e) => !disabled && (e.currentTarget.style.opacity = "1")}
    >
      {children}
    </button>
  );
}
