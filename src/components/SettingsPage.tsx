import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import type { Theme, VfoxNetworkConfig } from "../constants";
import ThemeSwitch from "./ThemeSwitch";
import SegmentedControl from "./SegmentedControl";
import AppleButton from "./AppleButton";

interface Props {
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onCheckUpdate: () => void;
  onVfoxUpdate: () => void;
  busy: boolean;
}

/** About / settings overlay covering the main area. */
export default function SettingsPage({
  theme, onThemeChange, onCheckUpdate, onVfoxUpdate, busy,
}: Props) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<{ app: string; vfox: string } | null>(null);

  useEffect(() => {
    invoke<{ app: string; vfox: string }>("app_version")
      .then(setVersion)
      .catch(() => setVersion({ app: "?", vfox: "?" }));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 space-y-7">
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">{t("settings.title")}</h2>
      </header>

      {/* Appearance */}
      <section>
        <SectionLabel>{t("settings.theme")}</SectionLabel>
        <Card>
          <Row label={t("settings.themeLabel")} hint={t("settings.themeHint")}>
            <div className="w-48">
              <ThemeSwitch value={theme} onChange={onThemeChange} />
            </div>
          </Row>
          <Divider />
          <Row label="Language / 语言" hint="English / 中文">
            <LangSwitch />
          </Row>
        </Card>
      </section>

      <NetworkSection />

      {/* Updates */}
      <section>
        <SectionLabel>{t("settings.updates")}</SectionLabel>
        <Card>
          <Row label={t("settings.checkAppUpdate")} hint={t("settings.checkAppHint")}>
            <AppleButton variant="primary" disabled={busy} onClick={onCheckUpdate}>
              {t("sidebar.checkUpdate")}
            </AppleButton>
          </Row>
          <Divider />
          <Row label={t("settings.updateVfox")} hint={t("settings.updateVfoxHint")}>
            <AppleButton variant="ghost" disabled={busy} onClick={onVfoxUpdate}>
              {t("sidebar.updateVfox")}
            </AppleButton>
          </Row>
        </Card>
      </section>

      {/* About */}
      <section>
        <SectionLabel>{t("settings.about")}</SectionLabel>
        <Card>
          <Row label={t("settings.vfoxGuiVersion")}>
            <code style={{ color: "var(--text-secondary)" }}>{version?.app ?? "…"}</code>
          </Row>
          <Divider />
          <Row label={t("settings.vfoxVersion")}>
            <code style={{ color: "var(--text-secondary)" }}>{version?.vfox ?? "…"}</code>
          </Row>
        </Card>
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1"
      style={{ color: "var(--text-tertiary)" }}>
      {children}
    </h3>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] overflow-hidden"
      style={{ background: "var(--card)", boxShadow: "var(--shadow-sm)" }}>
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <div className="min-w-0">
        <div className="text-[13px] font-medium" style={{ color: "var(--text)" }}>{label}</div>
        {hint && <div className="text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "var(--hairline)", margin: "0 16px" }} />;
}

/** Small language toggle — English / 中文 with sliding indicator. */
function LangSwitch() {
  const current = i18n.language?.startsWith("en") ? "en" : "zh";
  return (
    <div style={{ width: "120px" }}>
      <SegmentedControl
        value={current}
        onChange={(v) => {
          i18n.changeLanguage(v);
          // 同步托盘菜单/提示/窗口标题（Rust 侧只在启动时按持久化语言构建，
          // 不通知它就停留在上次启动的语言）
          invoke("set_app_language", { lang: v }).catch(console.error);
        }}
        options={[
          { value: "zh", label: "中文" },
          { value: "en", label: "EN" },
        ]}
      />
    </div>
  );
}

/** vfox 网络配置（C3）：proxy 下载代理 + registry 插件注册表镜像。
 *  直接读写 vfox 自己的 config.yaml（按行编辑，注释与其余字段不动），
 *  保存后对下一次 vfox 调用生效。 */
function NetworkSection() {
  const { t } = useTranslation();
  const [net, setNet] = useState<VfoxNetworkConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<VfoxNetworkConfig>("read_vfox_network_config")
      .then((c) => setNet(c))
      .catch((e) => setError(String(e)));
  }, []);

  const save = useCallback(async () => {
    if (!net || saving) return;
    setSaving(true);
    setError(null);
    try {
      const p = await invoke<string>("write_vfox_network_config", {
        proxyEnable: net.proxyEnable,
        proxyUrl: net.proxyUrl,
        registryAddress: net.registryAddress,
      });
      setSavedPath(p);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [net, saving]);

  const edit = (patch: Partial<VfoxNetworkConfig>) => {
    setNet((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
    setSavedPath(null);
  };

  return (
    <section>
      <SectionLabel>{t("settings.network")}</SectionLabel>
      <Card>
        {!net ? (
          <Row label={error ? t("settings.networkLoadFailed") : t("common.loading")}>
            <span />
          </Row>
        ) : (
          <>
            <Row label={t("settings.proxyEnable")} hint={t("settings.proxyEnableHint")}>
              <div className="w-32">
                <SegmentedControl
                  value={net.proxyEnable ? "on" : "off"}
                  onChange={(v) => edit({ proxyEnable: v === "on" })}
                  options={[
                    { value: "off", label: t("settings.proxyOff") },
                    { value: "on", label: t("settings.proxyOn") },
                  ]}
                />
              </div>
            </Row>
            <Divider />
            <Row label={t("settings.proxyUrl")} hint={t("settings.proxyUrlHint")}>
              <input
                value={net.proxyUrl}
                onChange={(e) => edit({ proxyUrl: e.target.value })}
                placeholder="http://127.0.0.1:7890"
                disabled={!net.proxyEnable}
                className="w-64 bg-transparent outline-none text-[12px] px-2 py-1.5 rounded-[6px] glass-input disabled:opacity-40"
                style={{ color: "var(--text)" }}
              />
            </Row>
            <Divider />
            <Row label={t("settings.registryAddress")} hint={t("settings.registryHint")}>
              <input
                value={net.registryAddress}
                onChange={(e) => edit({ registryAddress: e.target.value })}
                placeholder="https://…"
                className="w-64 bg-transparent outline-none text-[12px] px-2 py-1.5 rounded-[6px] glass-input"
                style={{ color: "var(--text)" }}
              />
            </Row>
            <Divider />
            <Row
              label={t("settings.networkSave")}
              hint={savedPath ? t("settings.networkSaved", { path: savedPath }) : undefined}
            >
              <div className="flex items-center gap-2">
                {error && <span className="text-[11px]" style={{ color: "var(--danger)" }}>{error}</span>}
                <AppleButton variant="primary" disabled={!dirty || saving} onClick={save}>
                  {t("common.ok")}
                </AppleButton>
              </div>
            </Row>
          </>
        )}
      </Card>
    </section>
  );
}
