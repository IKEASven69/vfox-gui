import type { Theme } from "../constants";

/** macOS-style segmented control for light / dark / system theme. */
export default function ThemeSwitch({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: "light", icon: "☀️", label: "浅色" },
    { value: "dark", icon: "🌙", label: "深色" },
    { value: "system", icon: "💻", label: "系统" },
  ];
  return (
    <div
      className="flex rounded-[7px] p-0.5 text-[11px] font-medium"
      style={{ background: "var(--card-secondary)", boxShadow: "var(--shadow-sm)" }}
    >
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="flex-1 flex items-center justify-center gap-1 py-1 rounded-[5px] transition-colors"
            style={{
              background: active ? "var(--card)" : "transparent",
              color: active ? "var(--text)" : "var(--text-tertiary)",
              boxShadow: active ? "var(--shadow-sm)" : "none",
            }}
            title={o.label}
          >
            <span style={{ fontSize: 12 }}>{o.icon}</span>
          </button>
        );
      })}
    </div>
  );
}
