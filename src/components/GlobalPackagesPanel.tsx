import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { GlobalPackageEntry, GlobalPackagesReport, GlobalUninstallOutcome } from "../constants";
import { formatBytes } from "../constants";
import ConfirmDialog from "./ConfirmDialog";

/** 与 Rust 侧 PROTECTED_PACKAGES 对齐：内置组件禁卸。 */
const PROTECTED = new Set(["npm", "corepack", "npx", "pip", "setuptools", "wheel"]);

interface Props {
  sdk: string;
  version: string;
  isCurrent: boolean;
  /** 卸载成功后通知父级刷新磁盘占用。 */
  onBytesChanged: () => void;
}

/** 版本详情的「全局包」子面板：清单 + 体积拆分 + 安全卸载。
 *  安全闸门顺序 = 后端 dry_run 拿将删清单 → 确认框（含将消失的命令、
 *  关键工具红警告、释放体积）→ 真实执行 → 刷新面板与磁盘占用。 */
export default function GlobalPackagesPanel({ sdk, version, isCurrent, onBytesChanged }: Props) {
  const { t } = useTranslation();
  const [report, setReport] = useState<GlobalPackagesReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState(false);
  const [confirming, setConfirming] = useState<GlobalUninstallOutcome | null>(null);
  const [msg, setMsg] = useState<{ text: string; danger?: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());
    try {
      setReport(await invoke<GlobalPackagesReport>("global_packages", { sdk, version }));
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
    </div>
  );
}
