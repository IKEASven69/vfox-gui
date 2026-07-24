import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";

/** macOS-style traffic light title bar. Replaces the native window chrome
 *  (decorations: false) with custom close/minimize/maximize dots + drag area.
 *  The fluid glass background layers live here too so they're always present. */
export default function TitleBar() {
  const { t } = useTranslation();
  const win = getCurrentWindow();

  return (
    <>
      {/* ── Liquid glass background layers (behind all content) ── */}
      {/* SVG filters for fluid displacement + noise */}
      <svg style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="liquid-filter">
            <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves={3} seed="3" result="noise">
              <animate attributeName="baseFrequency" values="0.009;0.013;0.009" dur="12s" repeatCount="indefinite" />
              <animate attributeName="seed" values="3;7;3" dur="24s" repeatCount="indefinite" />
            </feTurbulence>
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

      {/* ── Traffic light title bar ── */}
      <div className="titlebar">
        <div className="traffic-lights">
          <button className="tl-dot close" onClick={() => win.close()} title={t("common.close")} />
          <button className="tl-dot minimize" onClick={() => win.minimize()} title={t("common.close")} />
          <button className="tl-dot maximize" onClick={() => win.toggleMaximize()} title="Maximize" />
        </div>
        <span className="title-text">vfox</span>
      </div>
    </>
  );
}
