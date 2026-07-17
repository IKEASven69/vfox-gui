// Playwright screenshot generator for vfox-gui.
// The app's frontend calls Tauri `invoke()` commands that don't exist in a
// plain browser. We stub `@tauri-apps/api/core`'s invoke + event listeners
// with realistic mock data BEFORE the app loads, so the UI renders fully and
// we can capture a faithful screenshot of both light and dark themes.
//
// Usage: node scripts/screenshot.mjs   (run while `pnpm dev` / vite is up on :1420)
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const URL = "http://localhost:1420/";
const OUT_DIR = "public";
mkdirSync(OUT_DIR, { recursive: true });

// ---- mock data shapes mirror src/constants.ts interfaces ----
const mockSdks = [
  {
    name: "nodejs",
    installed: [
      { version: "24.16.0", is_current: true },
      { version: "22.11.0", is_current: false },
      { version: "20.18.0", is_current: false },
    ],
    current: "24.16.0",
  },
  {
    name: "python",
    installed: [
      { version: "3.13.12", is_current: true },
      { version: "3.12.7", is_current: false },
    ],
    current: "3.13.12",
  },
  {
    name: "java",
    installed: [
      { version: "25.0.2+10", is_current: true },
      { version: "21.0.10-graal", is_current: false },
    ],
    current: "25.0.2+10",
  },
];

const mockCatalog = [
  { name: "nodejs", official: true, installed: true },
  { name: "java", official: true, installed: true },
  { name: "python", official: true, installed: true },
  { name: "golang", official: true, installed: false },
  { name: "rust", official: true, installed: false },
  { name: "bun", official: false, installed: false },
  { name: "deno", official: false, installed: false },
  { name: "php", official: true, installed: false },
  { name: "ruby", official: false, installed: false },
  { name: "dotnet", official: true, installed: false },
];

const mockAvailable = [
  { version: "26.5.0", installed: false, note: "" },
  { version: "24.16.0", installed: true, note: "(lts)" },
  { version: "24.0.0", installed: false, note: "(lts)" },
  { version: "22.11.0", installed: true, note: "(lts)" },
  { version: "22.0.0", installed: false, note: "" },
  { version: "20.18.0", installed: true, note: "(lts)" },
  { version: "20.0.0", installed: false, note: "(lts)" },
  { version: "18.20.0", installed: false, note: "" },
];

const mockDiskUsage = [
  { sdk: "nodejs", version: "24.16.0", bytes: 996300000 },
  { sdk: "nodejs", version: "22.11.0", bytes: 958000000 },
  { sdk: "nodejs", version: "20.18.0", bytes: 921000000 },
  { sdk: "python", version: "3.13.12", bytes: 1093600000 },
  { sdk: "python", version: "3.12.7", bytes: 1042000000 },
  { sdk: "java", version: "25.0.2+10", bytes: 599200000 },
  { sdk: "java", version: "21.0.10-graal", bytes: 542000000 },
];

// invoke(command, args) → mock result. Only the commands called on initial load
// need real data; actions return benign strings.
const mockInvoke = (cmd) => {
  switch (cmd) {
    case "list_sdks": return mockSdks;
    case "list_available_sdks": return mockCatalog;
    case "search_versions": return mockAvailable;
    case "sdk_disk_usage": return mockDiskUsage;
    case "project_history": return [];
    case "app_version": return { app: "0.1.0", vfox: "1.0.11" };
    default: return "ok";
  }
};

const injectMock = () => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => Promise.resolve(mockInvoke(cmd)),
    // listen: no-op that returns an unlisten function
    listen: () => Promise.resolve(() => {}),
    transformCallback: () => 0,
    convertFileSrc: (p) => p,
  };
};

async function shoot(theme, file) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1000, height: 660 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript(injectMock);
  await page.goto(URL, { waitUntil: "networkidle" });
  // Apply theme before screenshot.
  await page.evaluate((t) => {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, theme);
  // Give React + animations a moment to settle.
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/${file}`, fullPage: false });
  await browser.close();
  console.log(`✓ ${OUT_DIR}/${file}`);
}

await shoot("light", "screenshot-light.png");
await shoot("dark", "screenshot-dark.png");
console.log("done");
