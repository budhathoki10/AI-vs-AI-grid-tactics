// End-to-end smoke test in a real browser: setup → full mock match → result → replay.
// Usage: start the app (`npm run dev` or `npm start`), then `npm run smoke [-- --url=http://127.0.0.1:8787 --out=artifacts]`.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const url = arg("url", "http://127.0.0.1:8787");
const out = arg("out", "artifacts");
const quick = process.argv.includes("--quick");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`  saved ${name}.png`);
};

async function newPage(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  // Fast pacing for the smoke run; same rules and pipeline as a normal match.
  await context.addInitScript(() => {
    if (!localStorage.getItem("uplink-duel.setup.v1"))
      localStorage.setItem(
        "uplink-duel.setup.v1",
        JSON.stringify({
          players: {
            A: { provider: "mock", model: "tactician", name: "Tactician", color: "#4c7dff" },
            B: { provider: "mock", model: "glitch", name: "Glitch", color: "#ff5b3a" },
          },
          mapId: "foundry",
          delayMs: 100,
          turnLimit: 40,
          firstSide: "A",
          seriesGames: 1,
          retries: 2,
          timeoutSec: 90,
        }),
      );
    localStorage.setItem("uplink-duel.muted", "true");
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    // SwiftShader reports GPU stalls whenever a screenshot reads the canvas; those are test-harness noise.
    if (/GPU stall due to ReadPixels/.test(msg.text())) return;
    if (msg.type() === "error" || msg.type() === "warning") errors.push(`[${viewport.width}] ${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`[${viewport.width}] pageerror: ${err.message}`));
  await page.goto(url);
  await page.waitForSelector(".bf-canvas");
  await page.waitForFunction(() => document.querySelector(".status-pill--ok"));
  await page.waitForTimeout(800);
  return page;
}

console.log("desktop 1440×900");
const desktop = await newPage({ width: 1440, height: 900 });
await shot(desktop, "01-setup-desktop");
await desktop.getByRole("button", { name: /Start match/ }).click();
await desktop.waitForSelector(".feed-item .feed-button");
await desktop.waitForTimeout(2500);
await shot(desktop, "02-match-desktop");

// Pause holds the next decision; resume continues.
await desktop.getByRole("button", { name: /Pause/ }).click();
await desktop.waitForSelector(".status-line.is-paused", { timeout: 20000 });
await shot(desktop, "03-paused-desktop");
await desktop.getByRole("button", { name: /Resume/ }).click();

// Inspect the first turn.
await desktop.locator(".feed-item .feed-button").last().click();
await desktop.waitForSelector(".inspector");
await shot(desktop, "04-inspector-desktop");
await desktop.locator(".inspector").getByRole("button", { name: /Close turn details/ }).click();

console.log("  waiting for the match to finish…");
await desktop.waitForSelector(".result", { timeout: quick ? 60_000 : 240_000 });
await desktop.waitForTimeout(600);
await shot(desktop, "05-result-desktop");
const resultText = await desktop.locator(".result-title").textContent();
const detail = await desktop.locator(".result-detail").textContent();
const actions = await desktop.locator(".feed-item .feed-button").count();
console.log(`  result: ${resultText} — ${detail} (${actions} actions)`);

await desktop.getByRole("button", { name: /^Replay$/ }).first().click();
await desktop.waitForSelector(".dock--replay");
await desktop.getByRole("button", { name: /Next turn/ }).click();
await desktop.waitForTimeout(1500);
await desktop.getByRole("button", { name: /Next turn/ }).click();
await desktop.waitForTimeout(1500);
await shot(desktop, "06-replay-desktop");

await desktop.getByRole("button", { name: /History/ }).click();
await desktop.waitForSelector(".history-item");
await shot(desktop, "07-history-desktop");
await desktop.keyboard.press("Escape");

for (const vp of [
  { width: 390, height: 844, name: "mobile" },
  { width: 820, height: 1180, name: "tablet" },
]) {
  console.log(`${vp.name} ${vp.width}×${vp.height}`);
  const page = await newPage({ width: vp.width, height: vp.height });
  await shot(page, `10-setup-${vp.name}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`[${vp.width}] horizontal overflow of ${overflow}px on setup`);
  await page.getByRole("button", { name: /Start match/ }).click();
  await page.waitForSelector(".feed-item .feed-button");
  await page.waitForTimeout(2000);
  await shot(page, `11-match-${vp.name}`);
  const overflow2 = await page.evaluate(() => {
    const extra = document.documentElement.scrollWidth - window.innerWidth;
    if (extra <= 0) return null;
    const culprits = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    return `${extra}px (${culprits.join(", ")})`;
  });
  if (overflow2) errors.push(`[${vp.width}] horizontal overflow on match: ${overflow2}`);
  await page.close();
}

await browser.close();
if (errors.length) {
  console.log(`\n${errors.length} console problem(s):`);
  for (const e of errors) console.log(`  ${e}`);
  process.exitCode = 1;
} else console.log("\nNo console errors or warnings.");
