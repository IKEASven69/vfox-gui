import { Trans, useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

/** In-app help: usage guide, shortcuts, FAQ, about. */
export default function HelpPage() {
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 space-y-7" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">{t("help.title")}</h2>
      </header>

      <section>
        <SectionLabel>{t("help.usageGuide")}</SectionLabel>
        <div className="space-y-3 text-[13px]" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <GuideItem title={t("help.installVersion")}>
            <Trans i18nKey="help.installVersionDesc" />
          </GuideItem>
          <GuideItem title={t("help.switchVersion")}>
            <Trans i18nKey="help.switchVersionDesc" />
          </GuideItem>
          <GuideItem title={t("help.uninstallVersion")}>
            <Trans i18nKey="help.uninstallVersionDesc" />
          </GuideItem>
          <GuideItem title={t("help.projectScope")}>
            <Trans i18nKey="help.projectScopeDesc">
              <code className="mx-1">.tool-versions</code>
              <code className="mx-1">.vfox-history.json</code>
            </Trans>
          </GuideItem>
          <GuideItem title={t("help.snapshots")}>
            <Trans i18nKey="help.snapshotsDesc">
              <code className="mx-1">java@25</code>
            </Trans>
          </GuideItem>
          <GuideItem title={t("help.scanProject")}>
            <Trans i18nKey="help.scanProjectDesc">
              <code className="mx-1">package.json</code>
              <code className="mx-1">go.mod</code>
              <code className="mx-1">Cargo.toml</code>
              <code className="mx-1">requirements.txt</code>
            </Trans>
          </GuideItem>
        </div>
      </section>

      <section>
        <SectionLabel>{t("help.shortcuts")}</SectionLabel>
        <div className="rounded-[12px] overflow-hidden" style={{ background: "var(--card)", boxShadow: "var(--shadow-sm)" }}>
          <ShortcutRow keys={["Esc"]} desc={t("help.escDesc")} last={false} />
          <ShortcutRow keys={["Ctrl", "F"]} desc={t("help.ctrlFDesc")} last={false} />
          <ShortcutRow keys={["Ctrl", ","]} desc={t("help.ctrlCommaDesc")} last={false} />
          <ShortcutRow keys={["Ctrl", "/"]} desc={t("help.ctrlSlashDesc")} last={true} />
        </div>
      </section>

      <section>
        <SectionLabel>{t("help.faq")}</SectionLabel>
        <div className="space-y-3 text-[13px]" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <FaqItem q={t("help.faq1q")}>
            <Trans i18nKey="help.faq1a">
              <strong className="text-[var(--text)]" />
              <code className="mx-1" />
            </Trans>
          </FaqItem>
          <FaqItem q={t("help.faq2q")}>
            <Trans i18nKey="help.faq2a" />
          </FaqItem>
          <FaqItem q={t("help.faq3q")}>
            <Trans i18nKey="help.faq3a" />
          </FaqItem>
          <FaqItem q={t("help.faq4q")}>
            <Trans i18nKey="help.faq4a" />
          </FaqItem>
        </div>
      </section>

      <section>
        <SectionLabel>{t("help.links")}</SectionLabel>
        <div className="flex flex-wrap gap-2">
          <LinkButton onClick={() => openUrl("https://github.com/version-fox/vfox")}>
            {t("help.vfoxRepo")}
          </LinkButton>
          <LinkButton onClick={() => openUrl("https://vfox.lhan.me")}>
            {t("help.vfoxDocs")}
          </LinkButton>
        </div>
        <p className="text-[11px] mt-3" style={{ color: "var(--text-tertiary)" }}>
          {t("help.footer")}
        </p>
      </section>
    </div>
  );
}

function GuideItem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="shrink-0 mt-px" style={{ color: "var(--accent)" }}>▸</span>
      <div>
        <span className="font-medium" style={{ color: "var(--text)" }}>{title}：</span>
        {children}
      </div>
    </div>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-medium mb-1" style={{ color: "var(--text)" }}>Q：{q}</div>
      <div style={{ color: "var(--text-secondary)" }}>{children}</div>
    </div>
  );
}

function ShortcutRow({ keys, desc, last }: { keys: string[]; desc: string; last: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5"
      style={{ borderTop: last ? "1px solid transparent" : "none" }}>
      <span className="text-[13px]" style={{ color: "var(--text)" }}>{desc}</span>
      <div className="flex gap-1">
        {keys.map((k) => (
          <kbd key={k} className="text-[11px] px-1.5 py-0.5 rounded font-mono font-medium"
            style={{ background: "var(--card-secondary)", color: "var(--text-secondary)", border: "1px solid var(--hairline)" }}>
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function LinkButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="text-[12px] px-3 py-1.5 rounded-full font-medium transition-opacity hover:opacity-70"
      style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
      {children}
    </button>
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
