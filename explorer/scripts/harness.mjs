import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { listen } from "./static-server.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
export async function start(port) {
  const server = await listen(ROOT, port);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("  [pageerror]", error.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !!window.__dyno, null, { timeout: 30000 });
  return { server, browser, page };
}
export async function stop({ server, browser }) {
  await browser.close();
  server.close();
}
export async function waitStatus(page, timeout = 60000) {
  await page.waitForFunction(
    () => {
      const cls = window.__dyno.state.statusClass;
      return cls.includes("ok") || cls.includes("err") || cls.includes("crashed");
    },
    null,
    { timeout },
  );
  return page.evaluate(() => ({
    status: window.__dyno.state.status,
    cls: window.__dyno.state.statusClass,
  }));
}
export async function run(page, mode, input, extra = "", timeout = 60000) {
  await page.evaluate(
    async ({ mode, input, extra }) => {
      if (mode) await window.__dyno.setMode(mode);
      if (input !== undefined) window.__dyno.setInput(input);
      document.getElementById("extra-args").value = extra;
      window.__dyno.run();
    },
    { mode, input, extra },
  );
  return waitStatus(page, timeout);
}
export function check(results, name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}
export function summary(results) {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n=== Summary ===\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}
