// Playwright screenshot generator for vfox-gui.
// The app's frontend calls Tauri `invoke()` commands that don't exist in a
// plain browser. We stub `window.__TAURI_INTERNALS__` with realistic mock data
// BEFORE the app loads (inlined, not closure-captured, so it survives
// addInitScript serialization), so the UI renders fully and we can capture a
// faithful screenshot of both light and dark themes.
//
// Usage: node scripts/screenshot.mjs   (run while `pnpm dev` / vite is up on :1420)
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const URL = "http://localhost:1420/";
const OUT_DIR = "public";
mkdirSync(OUT_DIR, { recursive: true });

// Inline mock — must be self-contained (addInitScript serializes the function,
// closure variables do NOT travel with it).
const inject = () => {
  const M = {
    list_sdks: [
      { name: "nodejs", installed: [{ version: "24.16.0", is_current: true }, { version: "22.11.0", is_current: false }], current: "24.16.0" },
      { name: "python", installed: [{ version: "3.13.12", is_current: true }], current: "3.13.12" },
      { name: "java", installed: [{ version: "25.0.2+10", is_current: true }], current: "25.0.2+10" },
    ],
    list_available_sdks: [
      { name: "nodejs", official: true, installed: true },
      { name: "java", official: true, installed: true },
      { name: "python", official: true, installed: true },
      { name: "golang", official: true, installed: false },
      { name: "rust", official: true, installed: false },
      { name: "bun", official: false, installed: false },
      { name: "deno", official: false, installed: false },
      { name: "php", official: true, installed: false },
      { name: "ruby", official: false, installed: false },
    ],
    refresh_available: [
      { name: "nodejs", official: true, installed: true },
      { name: "java", official: true, installed: true },
    ],
    search_versions: [
      { version: "26.5.0", installed: false, note: "" },
      { version: "24.16.0", installed: true, note: "(lts) [npm 11.13.0]" },
      { version: "24.0.0", installed: false, note: "(lts)" },
      { version: "22.11.0", installed: false, note: "(lts) [npm 10.9.0]" },
      { version: "22.0.0", installed: false, note: "" },
      { version: "20.18.0", installed: false, note: "(lts)" },
      { version: "20.0.0", installed: false, note: "(lts)" },
      { version: "18.20.0", installed: false, note: "" },
    ],
    sdk_disk_usage: [
      { sdk: "nodejs", version: "24.16.0", bytes: 996300000 },
      { sdk: "python", version: "3.13.12", bytes: 1093600000 },
      { sdk: "java", version: "25.0.2+10", bytes: 599200000 },
    ],
    project_history: [],
    app_version: { app: "0.1.0", vfox: "1.0.11" },
    list_snapshots: [],
    detect_project_sdks: [],
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (c) => Promise.resolve(M[c] !== undefined ? M[c] : "ok"),
    listen: () => Promise.resolve(() => {}),
    transformCallback: () => 0,
    convertFileSrc: (p) => p,
  };
};

async function shoot(theme, file) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 660 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(inject);
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.evaluate((t) => {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT_DIR}/${file}` });
  await browser.close();
  console.log(`✓ ${OUT_DIR}/${file}`);
}

await shoot("light", "screenshot-light.png");
await shoot("dark", "screenshot-dark.png");
console.log("done");
