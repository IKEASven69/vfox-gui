import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { AvailableSdk, Sdk } from "../constants";
import { sdkMeta } from "../constants";
import ProjectScanner from "./ProjectScanner";
import SnapshotPanel from "./SnapshotPanel";

interface Props {
  loading: boolean;
  catalog: AvailableSdk[];
  installedMap: Map<string, Sdk>;
  filteredCatalog: (AvailableSdk & { meta: ReturnType<typeof sdkMeta> })[];
  selected: string | null;
  sdkQuery: string;
  busy: boolean;
  sdksCount: number;
  view: "main" | "settings" | "help";
  onSelect: (name: string) => void;
  onAddPlugin: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, sdk: string, installed: boolean) => void;
  onSdkQueryChange: (q: string) => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onScanInstall: (sdk: string) => void;
  onSnapshotRestored?: () => void;
}

export default function SdkSidebar({
  loading, catalog, installedMap, filteredCatalog, selected,
  sdkQuery, busy, sdksCount, view,
  onSelect, onAddPlugin, onContextMenu,
  onSdkQueryChange, onOpenSettings, onOpenHelp,
  onScanInstall, onSnapshotRestored,
}: Props) {
  const { t } = useTranslation();
  return (
    <aside
      className="w-64 shrink-0 flex flex-col border-r"
      style={{
        background: "var(--sidebar)",
        borderColor: "var(--hairline)",
      }}
    >
      {/* Project scanner */}
      <ProjectScanner busy={busy} onInstallSdk={onScanInstall} />

      {/* Environment snapshots */}
      <SnapshotPanel busy={busy} selectedSdk={selected} onRestored={onSnapshotRestored} />
      {/* Spotlight-style SDK search */}
      <div className="px-4 pt-4 pb-2">
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 glass-input"
          style={{ borderRadius: "var(--radius-sm)" }}
        >
          <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>🔍</span>
          <input
            id="sdk-search-input"
            value={sdkQuery}
            onChange={(e) => onSdkQueryChange(e.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            className="flex-1 bg-transparent outline-none text-[13px]"
            style={{ color: "var(--text)" }}
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-1">
        {loading ? (
          <p className="px-3 py-2 text-[13px]" style={{ color: "var(--text-tertiary)" }}>
            {t("common.loading")}
          </p>
        ) : filteredCatalog.length === 0 ? (
          <p className="px-3 py-2 text-[13px]" style={{ color: "var(--text-tertiary)" }}>
            {catalog.length === 0 ? t("sidebar.noVfox") : t("common.noMatch")}
          </p>
        ) : (
          filteredCatalog.map((c) => (
            <SdkSidebarItem
              key={c.name}
              item={c}
              active={selected === c.name}
              installed={installedMap.get(c.name)}
              busy={busy}
              onSelect={onSelect}
              onAddPlugin={onAddPlugin}
              onContextMenu={onContextMenu}
            />
          ))
        )}
      </nav>

      <footer
        className="px-4 py-2 border-t flex items-center justify-between gap-2"
        style={{ borderColor: "var(--hairline)" }}
      >
        <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
          {t("sidebar.stats", { installed: sdksCount, available: catalog.length })}
        </span>
        <div className="flex items-center gap-1">
          <FooterButton active={view === "settings"} onClick={onOpenSettings} title={t("sidebar.settings")}>
            ⚙
          </FooterButton>
          <FooterButton active={view === "help"} onClick={onOpenHelp} title={t("sidebar.help")}>
            ?
          </FooterButton>
        </div>
      </footer>
    </aside>
  );
}

/** Small icon button for the sidebar footer (settings / help). */
function FooterButton({
  active, onClick, title, children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 flex items-center justify-center text-[14px] transition-colors hover:opacity-80"
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-tertiary)",
        borderRadius: "var(--radius-md)",
      }}
    >
      {children}
    </button>
  );
}

/** Single sidebar row — memoised to avoid re-rendering the entire list. */
const SdkSidebarItem = memo(function SdkSidebarItem({
  item, active, installed, busy,
  onSelect, onAddPlugin, onContextMenu,
}: {
  item: AvailableSdk & { meta: ReturnType<typeof sdkMeta> };
  active: boolean;
  installed: Sdk | undefined;
  busy: boolean;
  onSelect: (name: string) => void;
  onAddPlugin: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, sdk: string, installed: boolean) => void;
}) {
  const { t } = useTranslation();
  const c = item;
  return (
    <div
      onClick={() => installed && onSelect(c.name)}
      onContextMenu={(e) => onContextMenu(e, c.name, !!installed)}
      className="w-full text-left px-2 py-1.5 mb-0.5 flex items-center gap-2.5 transition-colors relative cursor-pointer"
      style={{
        background: active ? "var(--accent-soft)" : "transparent",
        cursor: installed ? "pointer" : "default",
        opacity: installed ? 1 : 0.55,
        borderRadius: "var(--radius-sm)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hairline)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <span
        className="w-6 h-6 flex items-center justify-center text-[10px] font-bold shrink-0"
        style={{ background: c.meta.bg, color: c.meta.fg, borderRadius: "var(--radius-xs)" }}
      >
        {c.meta.label}
      </span>
      <span
        className="font-medium text-[13px] flex-1 flex items-center gap-1.5 min-w-0"
        style={{ color: active ? "var(--accent)" : "var(--text)" }}
      >
        <span className="truncate">{c.meta.name}</span>
        {c.official && (
          <span
            className="shrink-0 text-[10px] font-semibold px-1.5 py-px leading-none"
            style={{ color: "var(--accent)", background: "var(--accent-soft)", borderRadius: "var(--radius-xs)" }}
          >
            {t("common.official")}
          </span>
        )}
      </span>
      {installed?.current ? (
        <span className="text-[11px] truncate max-w-[4.5rem]" style={{ color: "var(--text-tertiary)" }}>
          {installed.current}
        </span>
      ) : !installed ? (
        <button
          onClick={(e) => { e.stopPropagation(); onAddPlugin(c.name); }}
          disabled={busy}
          className="text-[11px] px-2 py-0.5 rounded-full font-medium"
          style={{ background: "var(--accent)", color: "#fff", opacity: busy ? 0.4 : 1 }}
        >
           {t("common.add")}
        </button>
      ) : null}
    </div>
  );
});
