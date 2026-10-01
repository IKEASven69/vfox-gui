// Shared types and constants for vfox-gui.
// SDK colors sourced from `vfox available` (39+ plugins as of vfox 1.0.x).

export interface Version {
  version: string;
  is_current: boolean;
}

export interface Sdk {
  name: string;
  installed: Version[];
  current: string | null;
}

export interface AvailableVersion {
  version: string;
  installed: boolean;
  /** Lowercased tags from vfox search (e.g. "(lts) [npm 11.13.0]"). */
  note?: string;
}

export interface AvailableSdk {
  name: string;
  official: boolean;
  installed: boolean;
}

export interface DiskUsageEntry {
  sdk: string;
  version: string;
  bytes: number;
}

export type VersionScope = "global" | "project";
export type Theme = "light" | "dark" | "system";

// Official display name + brand color for every SDK vfox supports.
// `label` is the short glyph on the icon (≤2 chars for the square).
// `fg` (optional) overrides the glyph color; auto-computed from bg luminance
// when omitted, so light backgrounds (bun, deno) get dark text automatically.
export const SDK_STYLE: Record<string, { name: string; bg: string; label: string; fg?: string }> = {
  // — official vfox plugins —
  nodejs: { name: "Node.js", bg: "#539e43", label: "N" },
  java: { name: "Java", bg: "#e76f00", label: "J" },
  python: { name: "Python", bg: "#3776ab", label: "P" },
  golang: { name: "Go", bg: "#00add8", label: "Go" },
  dotnet: { name: ".NET", bg: "#512bd4", label: ".N" },
  rust: { name: "Rust", bg: "#ce422b", label: "R" },
  bun: { name: "Bun", bg: "#fbf0df", label: "B" },
  deno: { name: "Deno", bg: "#70ffaf", label: "D" },
  php: { name: "PHP", bg: "#777bb4", label: "PHP" },
  ruby: { name: "Ruby", bg: "#cc342d", label: "Rb" },
  flutter: { name: "Flutter", bg: "#02569b", label: "F" },
  dart: { name: "Dart", bg: "#0175c2", label: "D" },
  kotlin: { name: "Kotlin", bg: "#7f52ff", label: "K" },
  scala: { name: "Scala", bg: "#dc322f", label: "Sc" },
  groovy: { name: "Groovy", bg: "#4298b8", label: "Gr" },
  gradle: { name: "Gradle", bg: "#02303a", label: "Gd" },
  maven: { name: "Maven", bg: "#c71a36", label: "Mv" },
  zig: { name: "Zig", bg: "#f7a41d", label: "Z" },
  crystal: { name: "Crystal", bg: "#000000", label: "Cr" },
  elixir: { name: "Elixir", bg: "#4b275f", label: "Ex" },
  erlang: { name: "Erlang", bg: "#a90533", label: "Er" },
  clang: { name: "Clang", bg: "#262d3a", label: "C" },
  cmake: { name: "CMake", bg: "#064f8c", label: "Cm" },
  etcd: { name: "etcd", bg: "#419eda", label: "et" },
  julia: { name: "Julia", bg: "#9558b2", label: "Jl" },
  vlang: { name: "V", bg: "#5d87bf", label: "V" },
  // — community / build tools —
  terraform: { name: "Terraform", bg: "#7b42bc", label: "Tf" },
  kubectl: { name: "kubectl", bg: "#326ce5", label: "k8" },
  protobuf: { name: "Protobuf", bg: "#4285f4", label: "Pb" },
  mongo: { name: "MongoDB", bg: "#47a248", label: "M" },
  vagrant: { name: "Vagrant", bg: "#1563ff", label: "Vg" },
  tomcat: { name: "Tomcat", bg: "#d2af35", label: "Tm" },
  typst: { name: "Typst", bg: "#239dad", label: "Ty" },
  lua: { name: "Lua", bg: "#2c2d72", label: "Lu" },
  make: { name: "Make", bg: "#7b6e8a", label: "Mk" },
  ninja: { name: "Ninja", bg: "#1c2536", label: "Nj" },
  "gcc-arm-none-eabi": { name: "ARM GCC", bg: "#4a4a4a", label: "Ar" },
  grails: { name: "Grails", bg: "#00b140", label: "Gs" },
  mongod: { name: "mongod", bg: "#47a248", label: "Md" },
};

/** Resolve display metadata for an SDK, falling back to a neutral placeholder.
 *  Always returns an `fg` (glyph color) — explicit if set, otherwise chosen by
 *  background luminance so light-tinted icons (bun, deno) stay legible. */
export function sdkMeta(name: string): { name: string; bg: string; label: string; fg: string } {
  const fallback = {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    bg: "#8e8e93",
    label: name.slice(0, 2).toUpperCase(),
  };
  const entry = SDK_STYLE[name] ?? fallback;
  return { ...entry, fg: entry.fg ?? (isLight(entry.bg) ? "#1d1d1f" : "#ffffff") };
}

/** Relative luminance check — returns true for light backgrounds that need
 *  dark foreground text (WCAG-ish perceptual luminance via sRGB weights). */
function isLight(hex: string): boolean {
  const m = hex.replace("#", "");
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  // Perceptual luminance (Rec. 709 weights).
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

/** Format bytes to human-readable string (e.g. "12.3 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 版本比较（semver 风格）：按 '.' 分段数值比较；pre-release（含 '-'）
 *  低于同号正式版；'+build' 元数据忽略；数值段高于字符串段；缺段补 0。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const core = (dash === -1 ? s : s.slice(0, dash)).split("+")[0];
    const pre = dash === -1 ? null : s.slice(dash + 1);
    return {
      segs: core.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : x)) as (number | string)[],
      pre,
    };
  };
  const A = parse(a);
  const B = parse(b);
  const n = Math.max(A.segs.length, B.segs.length);
  for (let i = 0; i < n; i++) {
    const x = A.segs[i] ?? 0;
    const y = B.segs[i] ?? 0;
    let d: number;
    if (typeof x === "number" && typeof y === "number") d = x - y;
    else if (typeof x === "string" && typeof y === "string") d = x < y ? -1 : x > y ? 1 : 0;
    else d = typeof x === "number" ? 1 : -1;
    if (d !== 0) return d;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}

/** 列表里的最高正式版（排除 pre-release——版本串含 '-'，如 -rc/-beta/-snapshot；
 *  graal 等 '-' 后缀的稳定版会被一并排除，属可接受的保守策略）。 */
export function latestStableVersion(versions: { version: string }[]): string | null {
  let best: string | null = null;
  for (const { version } of versions) {
    if (version.includes("-")) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** .tool-versions 的一条锁定（asdf 格式，Rust read_tool_versions 返回）。 */
export interface ToolVersionEntry {
  sdk: string;
  version: string;
}

/** vfox config.yaml 网络区块（proxy 下载代理 + registry 插件注册表镜像）。
 *  其余字段（storage/cache/legacyVersionFile）不暴露，按行编辑保证不受影响。 */
export interface VfoxNetworkConfig {
  proxyEnable: boolean;
  proxyUrl: string;
  registryAddress: string;
  configPath: string;
}

/** 全局包体积趋势的一条采样（Rust record/read_trend_samples）。 */
export interface TrendSample {
  ts: string;
  packagesBytes: number;
  runtimeBytes: number;
}


/** 全局包条目（某 SDK 版本里安装的运行时全局包）。bins 是该包提供的命令行
 *  工具名——卸载风险提示的依据。bytes 为 0 表示体积未知（python 侧 pip 不提供）。 */
export interface GlobalPackageEntry {
  name: string;
  version: string | null;
  bytes: number;
  description: string | null;
  bins: string[];
}

/** 全局包清单报告。warning 非空（"npm-missing" / "pip-failed:<detail>"）时
 *  前端显示黄条并禁用单包操作。 */
export interface GlobalPackagesReport {
  sdk: string;
  version: string;
  runtimeBytes: number;
  packagesBytes: number;
  packages: GlobalPackageEntry[];
  warning: string | null;
}

/** 卸载结果。dryRun 时 wouldRemove 是将删除的绝对路径清单、keyTools 命中
 *  关键 CLI（前端红色强警告）。 */
export interface GlobalUninstallOutcome {
  dryRun: boolean;
  wouldRemove: string[];
  freedBytes: number;
  removed: string[];
  failed: [string, string][];
  keyTools: string[];
}

/** 版本间全局包迁移结果。dryRun 时 migrated 是「将迁移清单」——nodejs 为空
 *  （包数即所选包数），python 为 name==version 行。 */
export interface GlobalMigrateOutcome {
  dryRun: boolean;
  migrated: string[];
  /** 目标已存在同名包而跳过（默认不覆盖） */
  skippedConflict: string[];
  failed: [string, string][];
  /** nodejs：将新增到目标版本的包字节；python 恒 0 */
  freedHintBytes: number;
  keyTools: string[];
  /** 含 .node 原生模块的包（跨 node 版本可能不兼容） */
  nativeModules: string[];
}

/** 卸载版本前的全局包速览。python 侧 pip 不提供每包体积：bytes/top 为空、
 *  仅 count 有值（前端按 bytes>0 决定是否展示体积括注）。 */
export interface GlobalPackagesSummary {
  count: number;
  bytes: number;
  /** 体积前 5（包名, 字节） */
  top: [string, number][];
}
