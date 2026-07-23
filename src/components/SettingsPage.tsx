import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import type { Theme } from "../constants";
import ThemeSwitch from "./ThemeSwitch";
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

/** Small language toggle — English / 中文. */
function LangSwitch() {
  const current = i18n.language?.startsWith("en") ? "en" : "zh";
  return (
    <div className="flex rounded-[6px] p-0.5 text-[11px] font-medium w-[88px]"
      style={{ background: "var(--card-secondary)", boxShadow: "var(--shadow-sm)" }}>
      {(["zh", "en"] as const).map((l) => {
        const active = current === l;
        return (
          <button key={l} onClick={() => i18n.changeLanguage(l)}
            className="flex-1 px-2.5 py-0.5 rounded-[4px] transition-colors"
            style={{
              background: active ? "var(--card)" : "transparent",
              color: active ? "var(--text)" : "var(--text-tertiary)",
              boxShadow: active ? "var(--shadow-sm)" : "none",
            }}>
            {l === "zh" ? "中文" : "EN"}
          </button>
        );
      })}
    </div>
  );
}
