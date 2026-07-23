import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";

interface Detection {
  sdk: string;
  label: string;
  required_version: string | null;
  suggestion: string;
  source: string;
}

interface Props {
  busy: boolean;
  onInstallSdk: (sdk: string) => void;
}

/** Project scanner — pick a directory, detect required SDKs, one-click install. */
export default function ProjectScanner({ busy, onInstallSdk }: Props) {
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
  }, []);

  const handleAdd = useCallback(async (sdk: string) => {
    await onInstallSdk(sdk);
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
            const isAdded = added.has(d.sdk);
            return (
              <div
                key={d.sdk}
                className="flex items-center gap-2 px-2 py-1 rounded-[6px]"
                style={{ background: "var(--card)" }}
              >
                <span className="text-[12px] flex-1 truncate" style={{ color: "var(--text)" }}>
                  <span className="font-medium">{d.label}</span>
                  {d.required_version && (
                    <span className="ml-1" style={{ color: "var(--text-tertiary)" }}>
                      {d.required_version}
                    </span>
                  )}
                </span>
                {isAdded ? (
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
                    style={{ color: "var(--success)" }}
                  >
                    ✓ {t("sidebar.added")}
                  </span>
                ) : (
                  <button
                    onClick={() => handleAdd(d.sdk)}
                    disabled={busy}
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 disabled:opacity-40"
                    style={{ background: "var(--success)", color: "#fff" }}
                  >
                    {t("sidebar.addSdk")}
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
