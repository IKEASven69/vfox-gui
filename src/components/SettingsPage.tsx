import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  const [version, setVersion] = useState<{ app: string; vfox: string } | null>(null);

  useEffect(() => {
    invoke<{ app: string; vfox: string }>("app_version")
      .then(setVersion)
      .catch(() => setVersion({ app: "?", vfox: "?" }));
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 space-y-7">
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">设置</h2>
      </header>

      {/* Appearance */}
      <section>
        <SectionLabel>外观</SectionLabel>
        <Card>
          <Row label="主题" hint="选择浅色、深色，或跟随系统">
            <div className="w-48">
              <ThemeSwitch value={theme} onChange={onThemeChange} />
            </div>
          </Row>
        </Card>
      </section>

      {/* Updates */}
      <section>
        <SectionLabel>更新</SectionLabel>
        <Card>
          <Row label="检查应用更新" hint="检查 vfox-gui 是否有新版本">
            <AppleButton variant="primary" disabled={busy} onClick={onCheckUpdate}>
              检查更新
            </AppleButton>
          </Row>
          <Divider />
          <Row label="更新 vfox CLI" hint="升级 vfox 命令行工具到最新版本">
            <AppleButton variant="ghost" disabled={busy} onClick={onVfoxUpdate}>
              更新 vfox
            </AppleButton>
          </Row>
        </Card>
      </section>

      {/* About */}
      <section>
        <SectionLabel>关于</SectionLabel>
        <Card>
          <Row label="vfox-gui 版本">
            <code style={{ color: "var(--text-secondary)" }}>{version?.app ?? "…"}</code>
          </Row>
          <Divider />
          <Row label="vfox 版本">
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
