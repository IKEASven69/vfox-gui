import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import type { Sdk } from "../constants";

interface Detection {
  sdk: string;
  label: string;
  required_version: string | null;
  suggestion: string;
  source: string;
}

interface Props {
  busy: boolean;
  /** 当前已安装插件的 SDK 表——决定按钮是『添加』还是『安装 x.y.z』。 */
  installedMap: Map<string, Sdk>;
  onInstallSdk: (sdk: string, version: string | null) => void;
}

/** Project scanner — pick a directory, detect required SDKs, one-click install. */
export default function ProjectScanner({ busy, installedMap, onInstallSdk }: Props) {
  const { t } = useTranslation();
  const [detections, setDetections] = useState<Detection[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SDKs added during this scan session — disables their button so the user
  // can't double-add (which would fail with "already installed").
  const [added, setAdded] = useState<Set<string>>(new Set());

  const handleScan = useCallback(async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: t("project.pickDirectory"),
    });
    if (!dir || typeof dir !== "string") return;

    setScanning(true);
    setError(null);
    setDetections([]);
    setAdded(new Set());
    try {
      const result = await invoke<Detection[]>("detect_project_sdks", { dir });
      setDetections(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [t]);

  const handleAdd = useCallback(async (sdk: string, version: string | null) => {
    await onInstallSdk(sdk, version);
    // Mark as added so the button shows "已添加" and can't be re-clicked.
    setAdded((prev) => new Set(prev).add(sdk));
  }, [onInstallSdk]);

  return (
    <div className="px-4 pt-2 pb-3 border-b" style={{ borderColor: "var(--hairline)" }}>
      <button
        onClick={handleScan}
        disabled={busy || scanning}
        title={t("sidebar.scanHint")}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors disabled:opacity-40"
        style={{
          background: "var(--accent-soft)",
          color: "var(--accent)",
        }}
      >
        {scanning ? (
          <>
            <svg className="vfox-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("sidebar.scanning")}
          </>
        ) : (
          <>{t("sidebar.scanProject")}</>
        )}
      </button>

      {error && (
        <p className="text-[11px] mt-1.5 px-1" style={{ color: "var(--danger)" }}>{error}</p>
      )}

      {detections.length > 0 && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider px-1" style={{ color: "var(--text-tertiary)" }}>
            {t("sidebar.detectedCount", { count: detections.length })}
          </p>
          {detections.map((d) => {
            const pluginInstalled = installedMap.has(d.sdk);
            // 检测到的版本是否已装（插件在且版本号在已装列表里）。
            const versionInstalled = Boolean(
              pluginInstalled &&
              d.required_version &&
              installedMap.get(d.sdk)!.installed.some((v) => v.version === d.required_version)
            );
            // 插件已装且没检测到具体版本 → 无事可做，也显示已就绪。
            const isDone = added.has(d.sdk) || versionInstalled ||
              (pluginInstalled && !d.required_version);
            return (
              <div
                key={d.sdk}
                className="flex items-center gap-2 px-2 py-1 glass-row"
                style={{ borderRadius: "var(--radius-sm)" }}
              >
                <span className="text-[12px] flex-1 truncate" style={{ color: "var(--text)" }}>
                  <span className="font-medium">{d.label}</span>
                  {d.required_version && (
                    <span className="ml-1" style={{ color: "var(--text-tertiary)" }}>
                      {d.required_version}
                    </span>
                  )}
                </span>
                {isDone ? (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
                    style={{ color: "var(--success)" }}
                  >
                    ✓ {t("common.installed")}
                  </span>
                ) : (
                  <button
                    onClick={() => handleAdd(d.sdk, d.required_version)}
                    disabled={busy}
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 disabled:opacity-40"
                    style={{ background: "var(--success)", color: "#fff", backdropFilter: "blur(10px)" }}
                  >
                    {d.required_version && pluginInstalled
                      ? t("sidebar.installVersion", { version: d.required_version })
                      : t("sidebar.addSdk")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
