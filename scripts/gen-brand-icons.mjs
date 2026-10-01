// 从 simple-icons 官方包提取项目用到的 SDK 图标（path + 官方品牌色），
// 生成 src/brand-icons.gen.ts——运行时零依赖、bundle 只含实际用到的图标。
// 新增 SDK 图标：在 SDK_SLUGS 加一行映射，重跑 `node scripts/gen-brand-icons.mjs`。
import { writeFileSync } from "node:fs";
import * as si from "simple-icons";

const SDK_SLUGS = {
  nodejs: "nodedotjs",
  java: "openjdk",
  python: "python",
  golang: "go",
  dotnet: "dotnet",
  rust: "rust",
  bun: "bun",
  deno: "deno",
  php: "php",
  ruby: "ruby",
  flutter: "flutter",
  dart: "dart",
  kotlin: "kotlin",
  scala: "scala",
  groovy: "apachegroovy",
  gradle: "gradle",
  maven: "apachemaven",
  zig: "zig",
  crystal: "crystal",
  elixir: "elixir",
  erlang: "erlang",
  clang: "llvm", // clang 隶属 LLVM 项目
  cmake: "cmake",
  etcd: "etcd",
  julia: "julia",
  vlang: "v",
  terraform: "terraform",
  kubectl: "kubernetes",
  mongo: "mongodb",
  vagrant: "vagrant",
  tomcat: "apachetomcat",
  typst: "typst",
  lua: "lua",
  make: "gnu", // GNU Make
  "gcc-arm-none-eabi": "arm",
};

const slugExport = (slug) =>
  "si" + slug.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

const out = [
  "/* eslint-disable */",
  "// 由 scripts/gen-brand-icons.mjs 从 simple-icons（官方 path + 官方品牌色）生成，勿手改。",
  "// 官方色不做主题适配：深色 logo（rust/bun/deno/crystal… 官方色即黑）配浅垫子保证可读。",
  "export interface BrandGlyph {",
  "  title: string;",
  "  hex: string;",
  "  path: string;",
  "}",
  "",
  "export const BRAND_GLYPHS: Record<string, BrandGlyph> = {",
];
let total = 0;
for (const [sdk, slug] of Object.entries(SDK_SLUGS)) {
  const icon = si[slugExport(slug)];
  if (!icon) {
    console.error(`MISSING: ${sdk} -> ${slug}`);
    process.exit(1);
  }
  total += icon.path.length;
  out.push(`  ${JSON.stringify(sdk)}: { title: ${JSON.stringify(icon.title)}, hex: ${JSON.stringify(icon.hex)}, path: ${JSON.stringify(icon.path)} },`);
}
out.push("};");
writeFileSync("src/brand-icons.gen.ts", out.join("\n") + "\n");
console.log(`generated ${Object.keys(SDK_SLUGS).length} glyphs, ${total} chars of paths`);
