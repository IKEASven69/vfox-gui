import type { Theme } from "../constants";
import { useTranslation } from "react-i18next";

/** macOS-style segmented control for light / dark / system theme. */
export default function ThemeSwitch({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  const { t: tr } = useTranslation();
  const options: { value: Theme; icon: string; label: string }[] = [
    { value: "light", icon: "☀️", label: tr("theme.light") },
    { value: "dark", icon: "🌙", label: tr("theme.dark") },
    { value: "system", icon: "💻", label: tr("theme.system") },
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
