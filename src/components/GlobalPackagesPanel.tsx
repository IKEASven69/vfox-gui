import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type {
  GlobalMigrateOutcome,
  GlobalPackageEntry,
  GlobalPackagesReport,
  GlobalUninstallOutcome,
  TrendSample,
} from "../constants";
import { formatBytes } from "../constants";
import ConfirmDialog from "./ConfirmDialog";

/** 与 Rust 侧 PROTECTED_PACKAGES 对齐：内置组件禁卸/禁迁移。 */
const PROTECTED = new Set(["npm", "corepack", "npx", "pip", "setuptools", "wheel"]);

interface Props {
  sdk: string;
  version: string;
  isCurrent: boolean;
  /** 其余已装版本（迁移源候选；bytes 来自磁盘占用统计，可能缺） */
  otherVersions: { version: string; bytes?: number }[];
  /** 卸载成功后通知父级刷新磁盘占用。 */
  onBytesChanged: () => void;
}

/** 版本详情的「全局包」子面板：清单 + 体积拆分 + 安全卸载 + 从其他版本导入。
 *  安全闸门顺序 = 后端 dry_run 拿将删/将迁清单 → 确认框 → 真实执行 →
 *  刷新面板与磁盘占用。迁移入口只出现在当前活跃版本（方向固定 旧 → 当前）。 */
export default function GlobalPackagesPanel({ sdk, version, isCurrent, otherVersions, onBytesChanged }: Props) {
  const { t } = useTranslation();
  const [report, setReport] = useState<GlobalPackagesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState(false);
  const [confirming, setConfirming] = useState<GlobalUninstallOutcome | null>(null);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);
  // ── 从其他版本导入（仅当前活跃版本面板） ──
  const [importOpen, setImportOpen] = useState(false);
  const [pkgCounts, setPkgCounts] = useState<Record<string, number>>({});
  const [sourceVersion, setSourceVersion] = useState<string | null>(null);
  const [sourceReport, setSourceReport] = useState<GlobalPackagesReport | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  const [migrating, setMigrating] = useState(false);
  const [importConfirming, setImportConfirming] = useState<GlobalMigrateOutcome | null>(null);
  // ── 体积历史（C5，可折叠） ──
  const [trendOpen, setTrendOpen] = useState(false);
  const [trend, setTrend] = useState<TrendSample[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    try {
      const rep = await invoke<GlobalPackagesReport>("global_packages", { sdk, version });
      setReport(rep);
      // C5：每次成功加载记一笔体积采样（本地 JSONL，失败静默——纯增值功能）
      invoke("record_trend_sample", {
        sdk,
        version,
        packagesBytes: rep.packagesBytes,
        runtimeBytes: rep.runtimeBytes,
      }).catch(() => { /* 采样失败不影响面板 */ });
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sdk, version]);

  useEffect(() => { void load(); }, [load]);

  const corrupt = report?.warning === "npm-missing";
  const pipFailDetail = report?.warning?.startsWith("pip-failed:")
    ? report.warning.slice("pip-failed:".length)
    : null;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectedNames = useMemo(
    () => [...selected].filter((n) => report?.packages.some((p) => p.name === n)),
    [selected, report],
  );

  const doDryRun = useCallback(async () => {
    if (selectedNames.length === 0 || uninstalling) return;
    setUninstalling(true);
    try {
      const outcome = await invoke<GlobalUninstallOutcome>("global_uninstall", {
        sdk, version, packages: selectedNames, dryRun: true,
      });
      setConfirming(outcome);
    } catch (e) {
      setMsg({ text: String(e), danger: true });
    } finally {
      setUninstalling(false);
    }
  }, [sdk, version, selectedNames, uninstalling]);

  const doReal = useCallback(async () => {
    setUninstalling(true);
    try {
      const outcome = await invoke<GlobalUninstallOutcome>("global_uninstall", {
        sdk, version, packages: selectedNames, dryRun: false,
      });
      if (outcome.removed.length > 0) {
        setMsg({
          text: t("detail.gpDone", {
            count: outcome.removed.length,
            bytes: formatBytes(outcome.freedBytes),
          }),
        });
      }
      if (outcome.failed.length > 0) {
        setMsg({
          text: t("detail.gpFailed", { count: outcome.failed.length, first: outcome.failed[0][1] }),
          danger: true,
        });
      }
      setConfirming(null);
      setSelected(new Set());
      await load();
      onBytesChanged();
    } catch (e) {
      setMsg({ text: String(e), danger: true });
    } finally {
      setUninstalling(false);
    }
  }, [sdk, version, selectedNames, load, onBytesChanged, t]);

  const affectedBins = useMemo(() => {
    if (!confirming) return [];
    const bins = new Set<string>();
    for (const p of report?.packages ?? []) {
      if (selectedNames.includes(p.name)) p.bins.forEach((b) => bins.add(b));
    }
    return [...bins];
  }, [confirming, report, selectedNames]);

  // ── 从其他版本导入 ──
  // 展开时并行取各候选版本的包数（read_dir 顶层，毫秒级）
  useEffect(() => {
    if (!importOpen) return;
    let alive = true;
    for (const v of otherVersions) {
      invoke<number>("global_packages_count", { sdk, version: v.version })
        .then((n) => { if (alive) setPkgCounts((prev) => ({ ...prev, [v.version]: n })); })
        .catch(() => { /* 计数失败显示 ？，不阻塞选择器 */ });
    }
    return () => { alive = false; };
  }, [importOpen, otherVersions, sdk]);

  const pickSource = useCallback(async (v: string) => {
    setSourceVersion(v || null);
    setSourceReport(null);
    setImportSelected(new Set());
    setImportConfirming(null);
    if (!v) return;
    setSourceLoading(true);
    try {
      const rep = await invoke<GlobalPackagesReport>("global_packages", { sdk, version: v });
      setSourceReport(rep);
      // 默认全选（内置组件置灰不可选）
      setImportSelected(new Set(rep.packages.filter((p) => !PROTECTED.has(p.name)).map((p) => p.name)));
    } catch (e) {
      setMsg({ text: String(e), danger: true });
    } finally {
      setSourceLoading(false);
    }
  }, [sdk]);

  const toggleImport = (name: string) => {
    setImportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const importSelectedNames = useMemo(
    () => [...importSelected].filter((n) => sourceReport?.packages.some((p) => p.name === n)),
    [importSelected, sourceReport],
  );

  const doImportDryRun = useCallback(async () => {
    if (!sourceVersion || importSelectedNames.length === 0 || migrating) return;
    setMigrating(true);
    try {
      const outcome = await invoke<GlobalMigrateOutcome>("global_migrate", {
        sdk, fromVersion: sourceVersion, toVersion: version,
        packages: importSelectedNames, dryRun: true,
      });
      setImportConfirming(outcome);
    } catch (e) {
      setMsg({ text: String(e), danger: true });
    } finally {
      setMigrating(false);
    }
  }, [sdk, sourceVersion, version, importSelectedNames, migrating]);

  const doImportReal = useCallback(async () => {
    if (!sourceVersion) return;
    setMigrating(true);
    try {
      const outcome = await invoke<GlobalMigrateOutcome>("global_migrate", {
        sdk, fromVersion: sourceVersion, toVersion: version,
        packages: importSelectedNames, dryRun: false,
      });
      if (outcome.migrated.length > 0) {
        setMsg({ text: t("detail.gpImportDone", { count: outcome.migrated.length }) });
      }
      if (outcome.failed.length > 0) {
        setMsg({
          text: t("detail.gpImportFailed", { count: outcome.failed.length, first: outcome.failed[0][1] }),
          danger: true,
        });
      }
      setImportConfirming(null);
      setImportSelected(new Set());
      await load();
      onBytesChanged();
    } catch (e) {
      setMsg({ text: String(e), danger: true });
    } finally {
      setMigrating(false);
    }
  }, [sdk, sourceVersion, version, importSelectedNames, load, onBytesChanged, t]);

  // ── 体积历史（C5）：展开时按需读近 30 条采样 ──
  const toggleTrend = useCallback(async () => {
    const next = !trendOpen;
    setTrendOpen(next);
    if (next && trend === null) {
      try {
        setTrend(await invoke<TrendSample[]>("read_trend_samples", { sdk, version }));
      } catch {
        setTrend([]);
      }
    }
  }, [trendOpen, trend, sdk, version]);

  return (
    <div
      className="mx-2 mb-2 px-3 py-2.5 text-[12px]"
      style={{ background: "var(--card)", borderRadius: "var(--radius-sm)", border: "1px solid var(--hairline)" }}
    >
      {loading && <span style={{ color: "var(--text-tertiary)" }}>{t("detail.gpLoading")}</span>}
      {loadError && <span style={{ color: "var(--danger)" }}>{loadError}</span>}

      {report && (
        <>
          {/* 汇总条 */}
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="font-medium" style={{ color: "var(--text)" }}>
              {t("detail.gpTitle")}
            </span>
            <span style={{ color: "var(--text-tertiary)" }}>
              {t("detail.gpSummary", {
                runtime: formatBytes(report.runtimeBytes),
                packages: formatBytes(report.packagesBytes),
                total: formatBytes(report.runtimeBytes + report.packagesBytes),
              })}
            </span>
          </div>

          {corrupt && (
            <div className="px-2.5 py-1.5 mb-1.5 rounded-[6px]"
              style={{ background: "var(--warning-soft, rgba(255,180,0,.12))", color: "var(--warning, #e6a700)" }}>
              {t("detail.gpCorrupt")}
            </div>
          )}
          {pipFailDetail && (
            <div className="px-2.5 py-1.5 mb-1.5 rounded-[6px]"
              style={{ background: "var(--warning-soft, rgba(255,180,0,.12))", color: "var(--warning, #e6a700)" }}>
              {t("detail.gpPipFailed", { detail: pipFailDetail })}
            </div>
          )}

          {/* 从其他版本导入：入口只放在当前活跃版本面板（方向固定 旧 → 当前） */}
          {isCurrent && otherVersions.length > 0 && (
            <div className="flex items-center gap-2 mb-1.5">
              <button
                onClick={() => setImportOpen((o) => !o)}
                className="text-[11px] px-2.5 py-1 rounded-full font-medium transition-opacity"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {importOpen ? t("detail.gpImportClose") : t("detail.gpImportBtn")}
              </button>
              {importOpen && (
                <select
                  value={sourceVersion ?? ""}
                  onChange={(e) => void pickSource(e.target.value)}
                  className="text-[11px] px-2 py-1 outline-none"
                  style={{
                    background: "var(--card)", color: "var(--text)",
                    border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)",
                  }}
                >
                  <option value="">{t("detail.gpImportPickSource")}</option>
                  {otherVersions.map((v) => (
                    <option key={v.version} value={v.version}>
                      {t("detail.gpImportSourceOption", {
                        version: v.version,
                        count: pkgCounts[v.version] ?? "…",
                        bytes: v.bytes != null ? formatBytes(v.bytes) : "?",
                      })}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* 源版本包清单：默认全选（内置组件置灰），勾选后走双闸门迁移 */}
          {importOpen && sourceVersion && (
            <div className="mb-1.5 px-2 py-1.5"
              style={{ background: "var(--hairline)", borderRadius: "var(--radius-xs)" }}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] min-w-0 truncate" style={{ color: "var(--text-secondary)" }}>
                  {sourceLoading
                    ? t("detail.gpImportSourceLoading", { version: sourceVersion })
                    : t("detail.gpImportSourceTitle", { version: sourceVersion, count: sourceReport?.packages.length ?? 0 })}
                </span>
                {sourceReport && sourceReport.packages.length > 0 && (
                  <button
                    onClick={doImportDryRun}
                    disabled={migrating || importSelectedNames.length === 0}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-full font-medium disabled:opacity-30 transition-opacity"
                    style={{ background: "var(--accent)", color: "#fff" }}
                  >
                    {t("detail.gpImportGo", { count: importSelectedNames.length })}
                  </button>
                )}
              </div>
              {sourceReport && sourceReport.packages.length === 0 && (
                <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>{t("detail.gpEmpty")}</div>
              )}
              {sourceReport && sourceReport.packages.length > 0 && (
                <div className="max-h-[160px] overflow-y-auto">
                  {sourceReport.packages.map((p: GlobalPackageEntry) => {
                    const isProtected = PROTECTED.has(p.name);
                    return (
                      <label
                        key={p.name}
                        className="flex items-center gap-2.5 px-1 py-1 rounded-[4px] cursor-pointer"
                        style={{ opacity: isProtected ? 0.5 : 1 }}
                      >
                        <input
                          type="checkbox"
                          checked={importSelected.has(p.name)}
                          disabled={isProtected}
                          onChange={() => toggleImport(p.name)}
                          title={isProtected ? t("detail.gpProtected") : undefined}
                          className="shrink-0"
                        />
                        <code className="min-w-0 flex-1 truncate" style={{ color: "var(--text)" }}>{p.name}</code>
                        {p.version && (
                          <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>{p.version}</span>
                        )}
                        <span className="shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                          {p.bytes > 0 ? formatBytes(p.bytes) : t("detail.gpUnknownSize")}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {report.packages.length === 0 ? (
            <div style={{ color: "var(--text-tertiary)" }}>{t("detail.gpEmpty")}</div>
          ) : (
            <div className="max-h-[220px] overflow-y-auto">
              {report.packages.map((p: GlobalPackageEntry) => {
                const isProtected = PROTECTED.has(p.name);
                const checked = selected.has(p.name);
                return (
                  <label
                    key={p.name}
                    className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-[4px] cursor-pointer hover:bg-[var(--hairline)]"
                    style={{ opacity: isProtected ? 0.55 : 1 }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={corrupt || isProtected}
                      onChange={() => toggle(p.name)}
                      title={isProtected ? t("detail.gpProtected") : undefined}
                      className="shrink-0"
                    />
                    <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
                      <code className="shrink-0 max-w-[52%] truncate" style={{ color: "var(--text)" }}>{p.name}</code>
                      {p.version && (
                        <span className="shrink-0" style={{ color: "var(--text-tertiary)" }}>{p.version}</span>
                      )}
                      {p.description && (
                        <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text-tertiary)" }}>
                          {p.description}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                      {p.bytes > 0 ? formatBytes(p.bytes) : t("detail.gpUnknownSize")}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {report.packages.length > 0 && (
            <div className="flex items-center justify-end gap-2 mt-1.5">
              {msg && (
                <span className="flex-1 truncate" style={{ color: msg.danger ? "var(--danger)" : "var(--text-tertiary)" }}>
                  {msg.text}
                </span>
              )}
              <button
                onClick={doDryRun}
                disabled={uninstalling || corrupt || selectedNames.length === 0}
                className="text-[11px] px-2.5 py-1 rounded-full font-medium disabled:opacity-30 transition-opacity"
                style={{ background: "var(--danger-soft, rgba(255,80,80,.12))", color: "var(--danger)" }}
              >
                {t("detail.gpUnloadBtn", { count: selectedNames.length })}
              </button>
            </div>
          )}

          {/* C5：体积历史（可折叠）——时间 | 全局包 | 运行时 | 与上次差值 */}
          <div className="mt-1.5 pt-1.5" style={{ borderTop: "1px solid var(--hairline)" }}>
            <button
              onClick={() => void toggleTrend()}
              className="text-[11px] font-medium transition-opacity hover:opacity-80"
              style={{ color: "var(--text-tertiary)" }}
            >
              {trendOpen ? "▾ " : "▸ "}
              {t("detail.gpTrendTitle")}
            </button>
            {trendOpen && (
              trend === null ? (
                <span className="ml-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {t("common.loading")}
                </span>
              ) : trend.length === 0 ? (
                <div className="mt-1 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {t("detail.gpTrendEmpty")}
                </div>
              ) : (
                <div className="mt-1">
                  <div className="flex gap-3 text-[10px] font-semibold uppercase tracking-wide px-1"
                    style={{ color: "var(--text-tertiary)" }}>
                    <span className="w-24 shrink-0">{t("detail.gpTrendColTime")}</span>
                    <span className="flex-1 text-right">{t("detail.gpTrendColPkgs")}</span>
                    <span className="w-20 text-right shrink-0">{t("detail.gpTrendColRuntime")}</span>
                    <span className="w-20 text-right shrink-0">{t("detail.gpTrendColDelta")}</span>
                  </div>
                  {trend.map((s, i) => {
                    const delta = i > 0 ? s.packagesBytes - trend[i - 1].packagesBytes : null;
                    return (
                      <div key={`${s.ts}-${i}`} className="flex gap-3 text-[11px] px-1 py-0.5 tabular-nums"
                        style={{ color: "var(--text-secondary)" }}>
                        <span className="w-24 shrink-0 truncate">{s.ts}</span>
                        <span className="flex-1 text-right">{formatBytes(s.packagesBytes)}</span>
                        <span className="w-20 text-right shrink-0">{formatBytes(s.runtimeBytes)}</span>
                        <span className="w-20 text-right shrink-0" style={{
                          color: delta == null || delta === 0 ? "var(--text-tertiary)"
                            : delta > 0 ? "var(--warning, #e6a700)" : "var(--success, #34a853)",
                        }}>
                          {delta == null ? "—"
                            : delta === 0 ? "·"
                            : delta > 0 ? `↑ ${formatBytes(delta)}`
                            : `↓ ${formatBytes(-delta)}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        </>
      )}

      {confirming && (
        <ConfirmDialog
          state={{
            title: t("detail.gpConfirmTitle", { count: selectedNames.length }),
            message: [
              t("detail.gpConfirmBody", {
                count: confirming.wouldRemove.length,
                bytes: formatBytes(confirming.freedBytes),
              }),
              affectedBins.length > 0
                ? t("detail.gpConfirmBins", { bins: affectedBins.join(", ") })
                : null,
              confirming.keyTools.length > 0
                ? "⚠ " + t("detail.gpConfirmKeyTools", { names: confirming.keyTools.join(", ") })
                : null,
              isCurrent ? t("detail.gpConfirmCurrent") : null,
            ].filter(Boolean).join("\n"),
            confirmLabel: t("detail.gpUnloadBtn", { count: selectedNames.length }),
            destructive: true,
            pending: doReal,
          }}
          onClose={() => setConfirming(null)}
        />
      )}

      {/* 迁移确认框（双闸门第二道）：包数/新增体积/将出现的命令/原生模块警告 */}
      {importConfirming && (
        <ConfirmDialog
          state={{
            title: t("detail.gpImportConfirmTitle", { count: importSelectedNames.length }),
            message: [
              t("detail.gpImportConfirmBody", {
                from: sourceVersion ?? "",
                bytes: formatBytes(importConfirming.freedHintBytes),
              }),
              sdk === "python" && importConfirming.migrated.length > 0
                ? t("detail.gpImportConfirmPip", {
                    list: importConfirming.migrated.slice(0, 8).join(", ") +
                      (importConfirming.migrated.length > 8 ? " …" : ""),
                  })
                : null,
              importConfirming.skippedConflict.length > 0
                ? t("detail.gpImportConfirmConflict", { names: importConfirming.skippedConflict.join(", ") })
                : null,
              importConfirming.keyTools.length > 0
                ? t("detail.gpImportConfirmBins", { bins: importConfirming.keyTools.join(", ") })
                : null,
              importConfirming.nativeModules.length > 0
                ? "⚠ " + t("detail.gpImportConfirmNative", { names: importConfirming.nativeModules.join(", ") })
                : null,
            ].filter(Boolean).join("\n"),
            confirmLabel: t("detail.gpImportGo", { count: importSelectedNames.length }),
            destructive: false,
            pending: doImportReal,
          }}
          onClose={() => setImportConfirming(null)}
        />
      )}
    </div>
  );
}
