import type { CSSProperties } from "react";
import { BRAND_GLYPHS, type BrandGlyph } from "../brand-icons.gen";

export function brandIconFor(name: string): BrandGlyph | undefined {
  return BRAND_GLYPHS[name];
}

/** 官方品牌图标：path 用官方形状、fill 用官方品牌色，**颜色不做任何主题适配**，
 *  无垫直出（GitHub README 的呈现方式）。唯一的例外是官方色纯黑/近黑的 8 个
 *  logo（生成脚本标 black: true）：暗色主题黑上黑物理不可见，保留浅色垫子
 *  （官方式展示面，Rust/Bun 官网自己就是浅底黑 logo）；浅色主题无垫直出官方黑。
 *  无官方图的 SDK 返回 null 由调用方回落字母。 */
export default function BrandIcon({ name, size = 18 }: { name: string; size?: number }) {
  const icon = brandIconFor(name);
  if (!icon) return null;
  const style: CSSProperties = {
    width: size,
    height: size,
    // 垫子（仅暗色主题的 8 个黑 logo 可见）保持圆角；无垫时透明不可见。
    borderRadius: Math.max(6, Math.round(size * 0.24)),
  };
  return (
    <span
      className={icon.black ? "brand-icon brand-mat-black-logo" : "brand-icon"}
      style={style}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill={"#" + icon.hex}>
        <path d={icon.path} />
      </svg>
    </span>
  );
}
