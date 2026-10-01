import type { CSSProperties } from "react";
import { BRAND_GLYPHS, type BrandGlyph } from "../brand-icons.gen";

export function brandIconFor(name: string): BrandGlyph | undefined {
  return BRAND_GLYPHS[name];
}

/** 官方品牌色的感知亮度（Rec.709 权重，0-1）。决定垫子明暗档位。 */
function brandLuminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 垫子档位按官方色亮度实测分布定阈值：0.30 以下全黑/深海军（rust/bun/deno/
 *  crystal/java/lua/elixir/erlang/llvm/maven/dotnet 官方色即深色）配浅垫；
 *  0.62 以上亮黄（zig/tomcat）配深垫；其余中间调配中性垫。图标本体永远官方原色。 */
function matClassFor(hex: string): string {
  const lum = brandLuminance(hex);
  return lum < 0.3 ? "brand-mat-dark-glyph"
    : lum > 0.62 ? "brand-mat-light-glyph"
    : "brand-mat-mid-glyph";
}

/** 官方品牌图标：path 用官方形状、fill 用官方品牌色，**颜色不做任何主题适配**。
 *  可读性靠垫子（见 matClassFor），无官方图的 SDK 返回 null 由调用方回落字母。 */
export default function BrandIcon({ name, size = 26 }: { name: string; size?: number }) {
  const icon = brandIconFor(name);
  if (!icon) return null;
  const glyph = Math.round(size * 0.62);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, Math.round(size * 0.24)),
  };
  return (
    <span className={`brand-mat ${matClassFor(icon.hex)}`} style={style} aria-hidden>
      <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill={"#" + icon.hex}>
        <path d={icon.path} />
      </svg>
    </span>
  );
}
