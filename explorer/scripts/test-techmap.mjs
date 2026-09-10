// Browser check: run the post_techmap preset (which ends at the ABC/techmap
// stage) and confirm it compiles to a techmapped netlist, proving in-process
// ABC works in the browser.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const MIME = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".wasm":"application/wasm",".data":"application/octet-stream",".map":"application/json",".ttf":"font/ttf" };

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    let p = decodeURIComponent(u.pathname);
    if (p === "/") p = "/index.html";
    const f = join(ROOT, p);
    const st = await stat(f).catch(() => null);
    if (!st || st.isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(f));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise((r) => server.listen(8124, r));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
page.on("console", (m) => { const t = m.text(); if (/Error|error|FATAL|crash|abort/i.test(t)) console.log("  [console]", t.slice(0,200)); });

await page.goto("http://localhost:8124/");
await page.waitForFunction(() => !!window.__dyno, null, { timeout: 30000 });

// Wait for the auto-run boot to settle first, else our run below is dropped as
// "busy" (in-flight guard) and we'd read the stale boot result.
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => window.__dyno.statusClass);
  if (String(c).includes("ok") || String(c).includes("err")) break;
}

const counter = `module counter (
  input logic clk,
  input logic rst,
  output logic [7:0] count
);
  always_ff @(posedge clk) begin
    if (rst)
      count <= 8'd0;
    else
      count <= count + 1;
  end
endmodule
`;

await page.evaluate(() => window.__dyno.setPipeline("post_techmap"));
const pipeVal = await page.evaluate(() => document.getElementById("pipeline-select").value);
console.log("pipeline-select value:", pipeVal);
await page.evaluate((t) => window.__dyno.setInput(t), counter);
await page.waitForFunction((t) => window.__dyno.input === t, counter, { timeout: 5000 });
await page.evaluate(() => window.__dyno.run());

let status = null;
for (let i = 0; i < 180; i++) {
  await page.waitForTimeout(1000);
  const cls = await page.evaluate(() => window.__dyno.statusClass);
  if (String(cls).includes("ok") || String(cls).includes("err")) {
    status = await page.evaluate((c) => ({ s: window.__dyno.status, c }), cls);
    break;
  }
}
console.log("status:", JSON.stringify(status));
console.log("error bar:", await page.evaluate(() => window.__dyno.error));
console.log("console visible:", await page.evaluate(() => window.__dyno.consoleVisible));
console.log("stdout:", (await page.evaluate(() => window.__dyno.stdout) || "").slice(-300).replace(/\n/g, " | "));
console.log("stderr:", (await page.evaluate(() => window.__dyno.stderr) || "").slice(-300).replace(/\n/g, " | "));

const stageInfo = await page.evaluate(() => {
  const sel = document.getElementById("out-stage-select");
  return { opts: Array.from(sel.options).map((o) => o.value) };
});
console.log("stage options:", JSON.stringify(stageInfo.opts));
const techName = stageInfo.opts.find((n) => n.endsWith("out.dyno"));
if (!techName) throw new Error("out.dyno (techmap) stage missing");

await page.evaluate((name) => {
  const sel = document.getElementById("out-stage-select");
  sel.value = name;
  sel.dispatchEvent(new Event("change"));
}, techName);
const output = await page.evaluate(() => window.__dyno.output);
const markers = (() => {
  const c = (re) => (output.match(re) || []).length;
  return { LUT: c(/LUT /g), STDCELL: c(/STDCELL_INSTANCE/g), sky130: c(/sky130/g) };
})();
console.log("out.dyno markers:", JSON.stringify(markers), "len:", output.length);

// ---- Verilog output via DUMP_VERILOG_PASS (after techmap / ABC) ----
// post_techmap ends with DUMP_VERILOG_PASS, so a `dump.v` stage (the
// techmapped netlist) should be present alongside out.dyno.
const vlogName = stageInfo.opts.find((n) => n.endsWith(".v"));
if (!vlogName) throw new Error("dump.v (Verilog netlist) stage missing");
await page.evaluate((name) => {
  const sel = document.getElementById("out-stage-select");
  sel.value = name;
  sel.dispatchEvent(new Event("change"));
}, vlogName);
const vlog = await page.evaluate(() => ({
  text: window.__dyno.output,
  lang: window.__dyno.outputLanguage,
}));
const vMarkers = (() => {
  const c = (re) => (vlog.text.match(re) || []).length;
  return { module: c(/^module /gm), endmodule: c(/endmodule/g), assign: c(/^assign /gm), inst: c(/sky130_fd_sc_hd__/g) };
})();
console.log("dump.v markers:", JSON.stringify(vMarkers), "len:", vlog.text.length);

await browser.close();
server.close();

if (pipeVal !== "post_techmap") throw new Error("pipeline not set to post_techmap: " + pipeVal);
if (!String(status?.c).includes("ok")) throw new Error("post_techmap compile failed: " + JSON.stringify(status));
if (!markers.LUT && !markers.STDCELL) throw new Error("techmap markers not found in out.dyno");
if (!vMarkers.module || !vMarkers.endmodule) throw new Error("dump.v is not a Verilog module");
if (!vMarkers.inst) throw new Error("dump.v has no stdcell instances (netlist empty)");
if (vlog.lang !== "verilog") throw new Error("output editor language for .v stage is " + vlog.lang);
console.log("OK: post_techmap (full flow incl. in-process ABC) compiled in browser; dump.v Verilog netlist emitted");
