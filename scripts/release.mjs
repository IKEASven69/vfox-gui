#!/usr/bin/env node
// Release helper — bumps the version everywhere, commits, tags, and pushes.
// Usage: node scripts/release.mjs 0.3.0
//
// This exists so the version-in-three-files step can't be forgotten (the bug
// where tauri.conf.json stayed at 0.1.0 while tags raced ahead to 0.2.x).
import { readFileSync, writeFileSync } from "fs";

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error("Usage: node scripts/release.mjs <version>   (e.g. 0.3.0)");
  process.exit(1);
}

// Files that must carry the version in sync. Each entry knows how to read and
// rewrite its own version line.
const targets = [
  {
    file: "package.json",
    bump: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${newVersion}"`),
  },
  {
    file: "src-tauri/tauri.conf.json",
    bump: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${newVersion}"`),
  },
  {
    file: "src-tauri/Cargo.toml",
    bump: (src) => src.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVersion}"`),
  },
];

console.log(`→ Bumping version to ${newVersion}`);
for (const t of targets) {
  const src = readFileSync(t.file, "utf8");
  const next = t.bump(src);
  if (next === src) {
    console.error(`✗ ${t.file}: version line not found — aborting`);
    process.exit(1);
  }
  writeFileSync(t.file, next);
  console.log(`  ✓ ${t.file}`);
}

console.log(`\nNext steps:`);
console.log(`  cargo generate-lockfile   # refresh Cargo.lock version`);
console.log(`  git add -A && git commit -m "chore: release v${newVersion}"`);
console.log(`  git tag v${newVersion} && git push origin main v${newVersion}`);
