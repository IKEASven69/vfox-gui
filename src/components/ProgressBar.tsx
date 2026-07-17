/** Slim progress bar pinned to the top of the main area.
 *  When `install` carries a download percent it renders a determinate bar;
 *  otherwise it falls back to an indeterminate spinner + label. */
export default function ProgressBar({
  label,
  install,
}: {
  label: string;
  install?: { percent: number | null; speed: string | null; phase: string } | null;
}) {
  const pct = install?.percent ?? null;
  const downloading = install?.phase === "downloading" && pct !== null;
  return (
    <div
      className="shrink-0 flex flex-col gap-1.5 px-8 py-2 border-b"
      style={{ borderColor: "var(--hairline)", background: "var(--card-secondary)" }}
    >
      <div className="flex items-center gap-2.5">
        {!downloading && (
          <svg
            className="vfox-spin shrink-0"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            style={{ color: "var(--accent)" }}
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
        <span className="text-[12px] flex-1" style={{ color: "var(--text-secondary)" }}>
          {downloading ? `下载中 ${pct}%` : label}
        </span>
        {downloading && install?.speed && (
          <span className="text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
            {install.speed}
          </span>
        )}
      </div>
      {downloading && (
        <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--hairline-strong)" }}>
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${pct}%`, background: "var(--accent)" }}
          />
        </div>
      )}
    </div>
  );
}
