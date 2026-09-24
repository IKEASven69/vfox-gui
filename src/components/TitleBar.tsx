import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Custom title bar replacing the native chrome (decorations: false).
 *  Window controls position adapts to OS: right on Windows/Linux, left on macOS.
 *  The fluid glass background layers live here too so they're always present. */
export default function TitleBar() {
  const { t } = useTranslation();
  const win = getCurrentWindow();

  return (
    <>
      {/* ── Liquid glass background layers (behind all content) ── */}
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="liquid-filter">
            {/* baseFrequency/seed 不做 SMIL 动画：feTurbulence 参数每帧变化会
                持续重算滤镜并强制上层 backdrop-filter 重新采样——窗口静止时
                GPU 也不降载，且 prefers-reduced-motion 管不到 SMIL。
                动感交给 .fluid-blob 的 CSS transform 漂移（合成器友好）。 */}
            <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves={3} seed="3" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="35" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="noise-filter">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves={3} seed="5" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>
      </svg>
      <div className="fluid-blob b1" />
      <div className="fluid-blob b2" />
      <div className="fluid-blob b3" />
      <div className="fluid-blob b4" />
      <div className="glass-overlay" />
      <div className="glass-noise" />

      {/* ── Title bar ── */}
      {/* data-tauri-drag-region：Tauri 官方拖拽机制，与 CSS app-region 并用
          （后者管触摸/笔输入，前者保证未来放开 macOS/Linux 构建时仍可拖动）。
          属性只认事件直接命中的元素，因此标题文本也要带上。 */}
      <div
        className="titlebar"
        data-tauri-drag-region
        onDoubleClick={() => win.toggleMaximize()}
      >
        {/* macOS: dots on the left; Windows/Linux: dots on the right */}
        {isMac && <TrafficLights win={win} t={t} />}
        <span className="title-text" data-tauri-drag-region>vfox</span>
        <div style={{ flex: 1 }} data-tauri-drag-region />
        {!isMac && <TrafficLights win={win} t={t} />}
      </div>
    </>
  );
}

function TrafficLights({
  win, t,
}: {
  win: ReturnType<typeof getCurrentWindow>;
  t: (k: string) => string;
}) {
  // Windows: minimize → maximize → close (left to right, right side of window)
  // macOS:   close → minimize → maximize (left side of window, traffic lights)
  if (isMac) {
    return (
      <div className="traffic-lights">
        <button className="tl-dot close" onClick={() => win.close()} title={t("common.close")} />
        <button className="tl-dot minimize" onClick={() => win.minimize()} title={t("common.minimize")} />
        <button className="tl-dot maximize" onClick={() => win.toggleMaximize()} title={t("common.maximize")} />
      </div>
    );
  }
  return (
    <div className="traffic-lights">
      <button className="tl-dot minimize" onClick={() => win.minimize()} title={t("common.minimize")} />
      <button className="tl-dot maximize" onClick={() => win.toggleMaximize()} title={t("common.maximize")} />
      <button className="tl-dot close" onClick={() => win.close()} title={t("common.close")} />
    </div>
  );
}

