import { useRef, useLayoutEffect, useState, type ReactNode } from "react";

interface Option<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

/** filefind-style segmented control with a sliding indicator that animates
 *  between positions. The indicator measures the active button's rect and
 *  transitions left/width for a smooth slide. */
export default function SegmentedControl<T extends string>({
  options, value, onChange, className = "",
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  // Position the indicator under the active button. Runs on mount, on value
  // change, and on resize (so it stays aligned if the layout reflows).
  useLayoutEffect(() => {
    const btn = btnRefs.current[value];
    const container = containerRef.current;
    if (!btn || !container) return;
    const cr = container.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    setIndicator({ left: br.left - cr.left, width: br.width });

    const onResize = () => {
      const cr2 = container.getBoundingClientRect();
      const br2 = btn.getBoundingClientRect();
      setIndicator({ left: br2.left - cr2.left, width: br2.width });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [value, options.length]);

  return (
    <div ref={containerRef} className={`seg-control ${className}`}>
      <div className="seg-indicator" style={{ left: indicator.left, width: indicator.width }} />
      {options.map((o) => (
        <button
          key={o.value}
          ref={(el) => { btnRefs.current[o.value] = el; }}
          className={value === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span style={{ fontSize: 12, marginRight: o.label ? 3 : 0 }}>{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}
