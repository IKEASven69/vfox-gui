import { memo } from "react";
import type { AvailableVersion, DiskUsageEntry, Sdk, VersionScope } from "../constants";
import { sdkMeta, formatBytes } from "../constants";
import AppleButton from "./AppleButton";
import ScopeSwitch from "./ScopeSwitch";
import GroupedList, { Row, SectionLabel, EmptyHint, Tag } from "./GroupedList";
import ProjectHistory from "./ProjectHistory";

interface Props {
  currentSdk: Sdk;
  filteredVersions: AvailableVersion[];
  diskUsage: DiskUsageEntry[];
  history: { sdk: string; version: string; date: string; from: string | null }[];
  searchLoading: boolean;
  versionQuery: string;
  busy: boolean;
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
  searchLoading, versionQuery, busy, error,
  versionScope, projectPath,
  onVersionQueryChange, onScopeChange, onPickProject,
  onUse, onInstall, onRemove, onRefresh, onRetry,
}: Props) {
  return (
    <>
      {/* Header */}
      <header className="px-8 pt-8 pb-5 flex items-center gap-4">
        <IconBadge name={currentSdk.name} size="lg" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[28px] font-semibold tracking-tight leading-tight">
            {sdkMeta(currentSdk.name).name}
          </h2>
          {currentSdk.current && (
            <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              当前{" "}
              <code style={{ color: "var(--accent)" }}>{currentSdk.current}</code>
              {versionScope === "project" && projectPath && (
                <span
                  className="ml-1.5 text-[11px] px-1.5 py-px rounded font-medium"
                  style={{ background: "var(--ember)", color: "#fff" }}
                  title={projectPath}
                >
                  项目
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
          title="刷新"
        >
          <RefreshIcon spinning={busy} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8 space-y-7">
        {/* Installed versions */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>已安装</SectionLabel>
            <ScopeSwitch value={versionScope} onChange={onScopeChange}
              projectPath={projectPath} onPickProject={onPickProject} />
          </div>
          {currentSdk.installed.length === 0 ? (
            <EmptyHint>尚未安装任何版本</EmptyHint>
          ) : (
            <GroupedList>
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
                    busy={busy}
                    onUse={() => onUse(v.version)}
                    onRemove={() => onRemove(v.version)}
                  />
                );
              })}
            </GroupedList>
          )}
        </section>

        {/* Available versions */}
        <section>
          <SectionLabel>可安装</SectionLabel>
          <div
            className="flex items-center gap-2 rounded-[8px] px-3 py-1.5 mb-2"
            style={{ background: "var(--card)", boxShadow: "var(--shadow-sm)" }}
          >
            <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>🔍</span>
            <input
              value={versionQuery}
              onChange={(e) => onVersionQueryChange(e.target.value)}
              placeholder="搜索版本（如 lts、20 lts、installed）…"
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: "var(--text)" }}
            />
          </div>
          {searchLoading ? (
            <EmptyHint>查询可用版本中…</EmptyHint>
          ) : filteredVersions.length === 0 ? (
            <EmptyHint>无匹配版本</EmptyHint>
          ) : (
            <GroupedList scrollable>
              {filteredVersions.map((v) => (
                <AvailableRow
                  key={v.version}
                  version={v.version}
                  installed={v.installed}
                  busy={busy}
                  onInstall={() => onInstall(v.version)}
                />
              ))}
            </GroupedList>
          )}
        </section>

        {/* Error */}
        {error && (
          <div
            className="rounded-[10px] px-4 py-3 text-[12px] flex items-start justify-between gap-3"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            <pre className="whitespace-pre-wrap font-mono m-0 flex-1">{error}</pre>
            <button
              onClick={onRetry}
              className="shrink-0 text-[12px] font-medium px-2.5 py-1 rounded-full"
              style={{ background: "var(--danger)", color: "#fff" }}
            >
              重试
            </button>
          </div>
        )}

        {/* Project version history — only shown when a project dir is selected */}
        {versionScope === "project" && projectPath && (
          <section>
            <ProjectHistory entries={history} />
          </section>
        )}
      </div>
    </>
  );
}

// ── small presentational pieces ──

export function IconBadge({ name, size }: { name: string; size?: "sm" | "lg" }) {
  const m = sdkMeta(name);
  const dim = size === "lg" ? "w-14 h-14 rounded-[14px] text-[22px]" : "w-8 h-8 rounded-[8px] text-[13px]";
  return (
    <span
      className={`${dim} flex items-center justify-center font-bold shrink-0`}
      style={{ background: m.bg, color: m.fg }}
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
  return (
    <Row>
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            background: isCurrent ? "var(--success)" : "var(--text-tertiary)",
            opacity: isCurrent ? 1 : 0.35,
          }}
        />
        <code className="text-[15px]">{version}</code>
        {isCurrent && <Tag color="success">当前</Tag>}
      </div>
      <div className="flex items-center gap-3">
        {usage && usage.bytes > 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
            {formatBytes(usage.bytes)}
          </span>
        )}
        <div className="flex gap-1.5">
          {!isCurrent && (
            <AppleButton variant="primary" disabled={busy} onClick={onUse}>切换</AppleButton>
          )}
          <AppleButton variant="ghost" disabled={busy} onClick={onRemove}>卸载</AppleButton>
        </div>
      </div>
    </Row>
  );
});

const AvailableRow = memo(function AvailableRow({
  version, installed, busy, onInstall,
}: {
  version: string; installed: boolean; busy: boolean; onInstall: () => void;
}) {
  return (
    <Row>
      <div className="flex items-center gap-3">
        <code className="text-[15px]">{version}</code>
        {installed && (
          <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>已安装</span>
        )}
      </div>
      {!installed && (
        <AppleButton variant="success" disabled={busy} onClick={onInstall}>安装</AppleButton>
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
