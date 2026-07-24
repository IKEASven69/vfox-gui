import { memo } from "react";
import { useTranslation } from "react-i18next";

interface Entry {
  sdk: string;
  version: string;
  date: string;
  from: string | null;
}

interface Props {
  entries: Entry[];
}

/**
 * Project version history — shows the timeline of SDK version changes made in
 * the selected project directory (recorded in `.vfox-history.json`). Each row
 * is one switch: which SDK, to which version, when, and from what previous
 * version. Newest first.
 *
 * Only rendered when a project scope is active; otherwise hidden.
 */
export default function ProjectHistory({ entries }: Props) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider px-1" style={{ color: "var(--text-tertiary)" }}>
        {t("project.history")}
      </p>
      {entries.length === 0 ? (
        <p className="text-[12px] px-1.5 py-2" style={{ color: "var(--text-tertiary)" }}>
          {t("project.noHistory")}
        </p>
      ) : (
        <div className="rounded-[12px] overflow-hidden glass-list">
          {entries.map((e, i) => (
            <HistoryRow key={`${e.sdk}-${e.date}-${i}`} entry={e} first={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

const HistoryRow = memo(function HistoryRow({
  entry, first,
}: {
  entry: Entry;
  first: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2"
      style={{ borderTop: first ? "none" : "1px solid var(--hairline)" }}
    >
      {/* Dot — accent for the most recent change, muted for older ones */}
      <div
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: first ? "var(--accent)" : "var(--text-tertiary)" }}
      />
      <code className="text-[12px] font-medium shrink-0" style={{ color: "var(--text)" }}>
        {entry.sdk}
      </code>
      {/* Version transition: from → to, or just "→ to" for the first use */}
      <span className="text-[12px] flex items-center gap-1.5 min-w-0">
        {entry.from && (
          <>
            <code style={{ color: "var(--text-tertiary)" }}>{entry.from}</code>
            <span style={{ color: "var(--text-tertiary)" }}>→</span>
          </>
        )}
        <code style={{ color: "var(--accent)" }}>{entry.version}</code>
      </span>
      {entry.date && (
        <span className="text-[10px] shrink-0 ml-auto" style={{ color: "var(--text-tertiary)" }}>
          {entry.date}
        </span>
      )}
    </div>
  );
});
