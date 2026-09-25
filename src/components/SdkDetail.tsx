import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AvailableVersion, DiskUsageEntry, Sdk, VersionScope } from "../constants";
import { sdkMeta, formatBytes } from "../constants";
import AppleButton from "./AppleButton";
import ScopeSwitch from "./ScopeSwitch";
import GroupedList, { Row, SectionLabel, EmptyHint, Tag } from "./GroupedList";
import ProjectHistory from "./ProjectHistory";

/** 错误横幅默认展示的行数，其余折叠到『展开全部』后面。 */
const ERROR_PREVIEW_LINES = 3;

interface Props {
  currentSdk: Sdk;
  filteredVersions: AvailableVersion[];
  diskUsage: DiskUsageEntry[];
  history: { sdk: string; version: string; date: string; from: string | null }[];
  searchLoading: boolean;
  versionQuery: string;
  /** 全局 busy（快照恢复 / 更新 vfox 等）——刷新按钮转圈用。 */
  busy: boolean;
  /** 本 SDK 的操作是否被锁：该 SDK 有进行中的操作计数，或全局操作进行中。 */
  sdkBusy: boolean;
  error: string | null;
  versionScope: VersionScope;
  projectPath: string | null;
  onVersionQueryChange: (q: string) => void;
  onScopeChange: (s: VersionScope) => void;
  onPickProject: () => void;
  onUse: (version: string) => void;
  onInstall: (version: string) => void;
  onRemove: (version: string) => void;
  onRefresh: () => void;
  onRetry: () => void;
}

export default function SdkDetail({
  currentSdk, filteredVersions, diskUsage, history,
  searchLoading, versionQuery, busy, sdkBusy, error,
  versionScope, projectPath,
  onVersionQueryChange, onScopeChange, onPickProject,
  onUse, onInstall, onRemove, onRefresh, onRetry,
}: Props) {
  const { t } = useTranslation();
  // 错误折叠：vfox 失败时的原始 CLI 输出可能有几十上百行，全量 <pre> 会把
  // 详情页撑爆。默认只显示前 3 行 + 剩余行数提示，可『展开全部』。
  const [errorExpanded, setErrorExpanded] = useState(false);
  // 新错误到来时回到折叠态（否则上一次的展开状态会延续到新错误）。
  useEffect(() => { setErrorExpanded(false); }, [error]);
  const errorLines = useMemo(
    () => (error ? error.replace(/\r/g, "").trim().split("\n") : []),
    [error]
  );
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <header className="px-8 pt-8 pb-5 flex items-center gap-4 shrink-0">
        <IconBadge name={currentSdk.name} size="lg" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[28px] font-semibold leading-tight" style={{ letterSpacing: "var(--tracking-tight)" }}>
            {sdkMeta(currentSdk.name).name}
          </h2>
          {currentSdk.current && (
            <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {t("detail.current")}{" "}
              <code style={{ color: "var(--accent)" }}>{currentSdk.current}</code>
              {versionScope === "project" && projectPath && (
                <span
                  className="ml-1.5 text-[11px] px-1.5 py-px font-medium"
                  style={{ background: "var(--ember)", color: "#fff", borderRadius: "var(--radius-xs)", backdropFilter: "blur(10px)" }}
                  title={projectPath}
                >
                  {t("detail.project")}
                </span>
              )}
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-opacity disabled:opacity-30 hover:bg-[var(--hairline)]"
          style={{ color: "var(--text-tertiary)" }}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <RefreshIcon spinning={busy} />
        </button>
      </header>

      {/* Content area: two side-by-side columns (已安装 | 可安装), each with its
          own header + internally scrolling list. Both get full height — no more
          squeezing. The whole window never scrolls. */}
      <div className="flex-1 flex gap-5 px-8 pb-8 min-h-0">
        {/* ── Left column: installed versions ── */}
        <section className="flex flex-col min-h-0" style={{ flex: "1 1 0%", minWidth: 0 }}>
          <div className="flex items-center justify-between mb-2 shrink-0">
            <SectionLabel>{t("detail.installedCount", { count: currentSdk.installed.length })}</SectionLabel>
            <ScopeSwitch value={versionScope} onChange={onScopeChange}
              projectPath={projectPath} onPickProject={onPickProject} />
          </div>
          {currentSdk.installed.length === 0 ? (
            <EmptyHint>{t("detail.noInstalled")}</EmptyHint>
          ) : (
            <GroupedList scrollable>
              {currentSdk.installed.map((v) => {
                const usage = diskUsage.find(
                  (d) => d.sdk === currentSdk.name && d.version === v.version
                );
                return (
                  <VersionRow
                    key={v.version}
                    version={v.version}
                    isCurrent={v.is_current}
                    usage={usage}
                    busy={sdkBusy}
                    onUse={() => onUse(v.version)}
                    onRemove={() => onRemove(v.version)}
                  />
                );
              })}
            </GroupedList>
          )}
        </section>

        {/* ── Right column: available versions ── */}
        <section className="flex flex-col min-h-0" style={{ flex: "1 1 0%", minWidth: 0 }}>
          <div className="mb-2 shrink-0">
            <SectionLabel>{t("detail.available")}</SectionLabel>
          </div>
          <div
            className="flex items-center gap-2 px-3 py-1.5 mb-2 shrink-0 glass-input"
            style={{ borderRadius: "var(--radius-sm)" }}
          >
            <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>🔍</span>
            <input
              value={versionQuery}
              onChange={(e) => onVersionQueryChange(e.target.value)}
              placeholder={t("detail.versionSearchPlaceholder")}
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: "var(--text)" }}
            />
          </div>
          {searchLoading ? (
            <EmptyHint>{t("detail.searching")}</EmptyHint>
          ) : filteredVersions.length === 0 ? (
            <EmptyHint>{t("detail.noVersionMatch")}</EmptyHint>
          ) : (
            <GroupedList scrollable>
              {filteredVersions.map((v) => (
                <AvailableRow
                  key={v.version}
                  version={v.version}
                  installed={v.installed}
                  note={v.note}
                  busy={sdkBusy}
                  onInstall={() => onInstall(v.version)}
                />
              ))}
            </GroupedList>
          )}
        </section>
      </div>

      {/* Error banner — full width below the two columns. Collapsed by
          default: only the first 3 lines + a "N more lines" hint, with an
          expand toggle (raw CLI dumps can be 100+ lines and bury the UI). */}
      {error && (
        <div
          className="mx-8 mb-6 px-4 py-3 text-[12px] flex items-start justify-between gap-3 shrink-0"
          style={{ background: "var(--danger-soft)", color: "var(--danger)", borderRadius: "var(--radius-md)", backdropFilter: "blur(10px)" }}
        >
          <div className="flex-1 min-w-0">
            <pre className="whitespace-pre-wrap font-mono m-0">
              {(errorExpanded || errorLines.length <= ERROR_PREVIEW_LINES
                ? errorLines
                : errorLines.slice(0, ERROR_PREVIEW_LINES)
              ).join("\n")}
            </pre>
            {errorLines.length > ERROR_PREVIEW_LINES && (
              <div className="flex items-center gap-2.5 mt-1.5">
                {!errorExpanded && (
                  <span style={{ opacity: 0.8 }}>
                    {t("detail.errorCollapsedHint", { count: errorLines.length - ERROR_PREVIEW_LINES })}
                  </span>
                )}
                <button
                  onClick={() => setErrorExpanded((v) => !v)}
                  className="text-[11px] font-medium px-2 py-0.5 rounded-full transition-opacity hover:opacity-80"
                  style={{ border: "1px solid var(--danger)", background: "transparent" }}
                >
                  {errorExpanded ? t("detail.errorCollapse") : t("detail.errorExpand")}
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onRetry}
            className="shrink-0 text-[12px] font-medium px-2.5 py-1 rounded-full"
            style={{ background: "var(--danger)", color: "#fff", backdropFilter: "blur(10px)" }}
          >
               {t("common.retry")}
          </button>
        </div>
      )}

      {/* Project version history — only shown when a project dir is selected */}
      {versionScope === "project" && projectPath && (
        <div className="mx-8 mb-6 shrink-0">
          <ProjectHistory entries={history} />
        </div>
      )}
    </div>
  );
}

// ── small presentational pieces ──

export function IconBadge({ name, size }: { name: string; size?: "sm" | "lg" }) {
  const m = sdkMeta(name);
  const dim = size === "lg" ? "w-14 h-14 text-[22px]" : "w-8 h-8 text-[13px]";
  const radius = size === "lg" ? "var(--radius-lg)" : "var(--radius-sm)";
  return (
    <span
      className={`${dim} flex items-center justify-center font-bold shrink-0`}
      style={{ background: m.bg, color: m.fg, borderRadius: radius }}
    >
      {m.label}
    </span>
  );
}

const VersionRow = memo(function VersionRow({
  version, isCurrent, usage, busy,
  onUse, onRemove,
}: {
  version: string; isCurrent: boolean;
  usage: DiskUsageEntry | undefined;
  busy: boolean; onUse: () => void; onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Row>
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: isCurrent ? "var(--success)" : "var(--text-tertiary)",
            opacity: isCurrent ? 1 : 0.35,
          }}
        />
        <code className="text-[15px] truncate">{version}</code>
        {isCurrent && <Tag color="success">{t("detail.current")}</Tag>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {usage && usage.bytes > 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {formatBytes(usage.bytes)}
          </span>
        )}
        <div className="flex gap-1.5">
          {!isCurrent && (
            <AppleButton variant="primary" disabled={busy} onClick={onUse}>{t("detail.switch")}</AppleButton>
          )}
          {/* 当前使用中的版本禁止卸载：卸载 active 版本会留下悬空 symlink
              和指向已删目录的 PATH，shell 里直接报错 */}
          <AppleButton
            variant="ghost"
            disabled={busy || isCurrent}
            onClick={onRemove}
            title={isCurrent ? t("detail.uninstallCurrentHint") : undefined}
          >
            {t("detail.uninstall")}
          </AppleButton>
        </div>
      </div>
    </Row>
  );
});

const AvailableRow = memo(function AvailableRow({
  version, installed, note, busy, onInstall,
}: {
  version: string; installed: boolean; note?: string; busy: boolean; onInstall: () => void;
}) {
  // The note from `vfox search` looks like "(lts) [npm 11.13.0] (installed)".
  // Pull out the LTS / pre-release tags and the [npm ...] extra separately so
  // we can style them distinctly instead of dumping a raw string.
  const tags: string[] = [];
  const npmMatch = note?.match(/\[(.*?)\]/);
  const { t } = useTranslation();
  if (note?.match(/\(lts\)|lts/i)) tags.push("LTS");
          if (note?.match(/\(pre-release\)|pre-release/i)) tags.push(t("detail.preRelease"));
  const npm = npmMatch?.[1];
  return (
    <Row>
      <div className="flex items-center gap-2.5 min-w-0">
        <code className="text-[15px] shrink-0">{version}</code>
        {tags.map((t) => (
          <span key={t} className="text-[10px] px-1.5 py-px font-medium shrink-0"
            style={{ background: "var(--success-soft)", color: "var(--success)", borderRadius: "var(--radius-xs)" }}>
            {t}
          </span>
        ))}
        {npm && (
          <span className="text-[11px] truncate" style={{ color: "var(--text-tertiary)" }}>
            {npm}
          </span>
        )}
        {installed && (
          <span className="text-[11px] shrink-0" style={{ color: "var(--text-tertiary)" }}>{t("common.installed")}</span>
        )}
      </div>
      {!installed && (
        <AppleButton variant="success" disabled={busy} onClick={onInstall}>{t("detail.install")}</AppleButton>
      )}
    </Row>
  );
});

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={spinning ? "vfox-spin" : ""}
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
