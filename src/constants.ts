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
