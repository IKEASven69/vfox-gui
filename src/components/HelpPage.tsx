import { openUrl } from "@tauri-apps/plugin-opener";

/** In-app help: usage guide, shortcuts, about, FAQ. */
export default function HelpPage() {
  return (
    <div className="flex-1 overflow-y-auto px-8 py-8 space-y-7" style={{ maxWidth: 720 }}>
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">帮助</h2>
      </header>

      {/* Usage guide */}
      <section>
        <SectionLabel>使用说明</SectionLabel>
        <div className="space-y-3 text-[13px]" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <GuideItem title="安装版本">
            在左侧选择一个 SDK，在「可安装」区域找到需要的版本，点击「安装」。安装过程会显示下载进度和速度，大版本可能需要几分钟。
          </GuideItem>
          <GuideItem title="切换版本">
            在「已安装」区域点击「切换」按钮，即可把该 SDK 的全局默认版本切换过去。切换是即时生效的。
          </GuideItem>
          <GuideItem title="卸载版本">
            点击「卸载」会弹出确认对话框，确认后删除该版本。卸载不可撤销。
          </GuideItem>
          <GuideItem title="项目作用域">
            在顶部切换到「项目」作用域，选择一个项目目录，版本选择会写入该目录的
            <code className="mx-1">.tool-versions</code> 文件，仅对该项目生效（不影响全局版本）。
            已有的其他 SDK 条目会保留，只更新你切换的那一个。每次切换还会记录到
            <code className="mx-1">.vfox-history.json</code>，在下方显示版本演进历史。
          </GuideItem>
          <GuideItem title="环境快照">
            在侧边栏「环境快照」保存当前 SDK 的版本组合。「存当前」只保存选中 SDK（如
            <code className="mx-1">java@25</code>），恢复时只动它；
            「存全部」保存所有 SDK，恢复时还原整套环境。
          </GuideItem>
          <GuideItem title="扫描项目">
            clone 了别人的项目不知道要装什么？点「扫描项目」选择项目目录，自动检测需要的 SDK：
            <code className="mx-1">package.json</code>→Node.js、
            <code className="mx-1">go.mod</code>→Go、
            <code className="mx-1">Cargo.toml</code>→Rust、
            <code className="mx-1">requirements.txt</code>→Python 等。
            检测到的 SDK 旁有「添加」按钮，一键安装缺少的插件。
          </GuideItem>
        </div>
      </section>

      {/* Shortcuts */}
      <section>
        <SectionLabel>快捷键</SectionLabel>
        <div className="rounded-[12px] overflow-hidden" style={{ background: "var(--card)", boxShadow: "var(--shadow-sm)" }}>
          <ShortcutRow keys={["Esc"]} desc="关闭当前弹窗（确认框、更新框、右键菜单）" last={false} />
          <ShortcutRow keys={["Ctrl", "F"]} desc="聚焦左侧 SDK 搜索框" last={false} />
          <ShortcutRow keys={["Ctrl", ","]} desc="打开设置页" last={false} />
          <ShortcutRow keys={["Ctrl", "/"]} desc="打开帮助页" last={true} />
        </div>
      </section>

      {/* FAQ */}
      <section>
        <SectionLabel>常见问题</SectionLabel>
        <div className="space-y-3 text-[13px]" style={{ color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <FaqItem q="切换版本后，终端里命令没生效？">
            需要打开一个<strong className="text-[var(--text)]">新的</strong>终端窗口，旧窗口的环境变量不会自动更新。
            如果新窗口也不行，说明 vfox 的 shell hook 没装好，运行
            <code className="mx-1">vfox add &lt;shell&gt;</code> 安装（如 vfox add bash / powershell）。
          </FaqItem>
          <FaqItem q="切换到某个版本后，命令找不到（如 java）？">
            该版本可能是损坏的（下载或解压中断）。在 GUI 里卸载它再重新安装即可。可以在「关于 → vfox 版本」确认 CLI 正常。
          </FaqItem>
          <FaqItem q="卸载按钮点了没反应？">
            已在最新版修复。如果仍有问题，可能是该版本目录残留，卸载会自动清理残留目录。
          </FaqItem>
          <FaqItem q="出现「current shell lacks hook support」警告？">
            这是正常的。GUI 进程本身没有 shell hook，vfox 会自动回退到全局作用域，不影响功能。
          </FaqItem>
        </div>
      </section>

      {/* About / links */}
      <section>
        <SectionLabel>关于</SectionLabel>
        <div className="flex flex-wrap gap-2">
          <LinkButton onClick={() => openUrl("https://github.com/version-fox/vfox")}>
            vfox 官方仓库
          </LinkButton>
          <LinkButton onClick={() => openUrl("https://vfox.lhan.me")}>
            vfox 文档
          </LinkButton>
        </div>
        <p className="text-[11px] mt-3" style={{ color: "var(--text-tertiary)" }}>
          vfox-gui — 一个 vfox 版本管理器的轻量图形界面。
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
