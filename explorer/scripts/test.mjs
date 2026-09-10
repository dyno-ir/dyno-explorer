// Verification harness for the Dyno Explorer: serves dist/ and drives the page
// with Playwright, checking the source-loc linking, diagnostics, graph view,
// and run serialization.
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
await new Promise((r) => server.listen(8123, r));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

await page.goto("http://localhost:8123/");
await page.waitForFunction(() => !!window.__dyno, null, { timeout: 30000 });

let initial = null;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  initial = await page.evaluate(() => ({ status: window.__dyno.status, cls: window.__dyno.statusClass }));
  if (String(initial.cls).includes("ok") || String(initial.cls).includes("err")) break;
}
if (!String(initial.cls).includes("ok")) throw new Error("initial compile failed: " + JSON.stringify(initial));
await page.waitForFunction(() => window.__dyno.locCount > 0, null, { timeout: 5000 });

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

// ---- 1. test mode hides Pipeline ----
await page.evaluate(() => window.__dyno.setMode("test"));
check("test mode hides Pipeline selector",
  await page.evaluate(() => document.getElementById("pipeline-field").style.display === "none"));
await page.evaluate(() => window.__dyno.setMode("sv"));
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok"), null, { timeout: 60000 });
check("sv mode shows Pipeline selector",
  await page.evaluate(() => document.getElementById("pipeline-field").style.display === ""));

// ---- 2. whole bracket groups hidden by default, toggle works ----
await page.waitForFunction(() => window.__dyno.locCount > 0, null, { timeout: 5000 });
const d = await page.evaluate(() => {
  const texts = window.__dyno.getLocDecoTexts();
  const groups = window.__dyno.locGroups;
  const strings = window.__dyno.locCount;
  // a hidden decoration must cover the WHOLE bracket group (incl. [ and ]),
  // i.e. its rendered text starts with '[' and ends with ']'
  const allWhole = texts.length > 0 && texts.every((t) => t.startsWith("[") && t.endsWith("]"));
  return { texts, groups: groups.length, strings, allWhole, anyWhole: texts.filter((t) => t.startsWith("[") && t.endsWith("]")).length };
});
check("whole bracket groups hidden (no stray [ , ])",
  d.allWhole && d.texts.length === d.groups && d.groups < d.strings,
  `decos=${d.texts.length} groups=${d.groups} strings=${d.strings} sample=${JSON.stringify(d.texts[0])}`);

await page.evaluate(() => { document.getElementById("show-locs").checked = true; document.getElementById("show-locs").dispatchEvent(new Event("change")); });
await page.waitForTimeout(100);
const on = await page.evaluate(() => ({ shown: document.querySelectorAll(".dyno-loc").length, hidden: document.querySelectorAll(".dyno-loc-hidden").length }));
check("toggling 'Show source locs' reveals markers", on.shown > 0 && on.hidden === 0, `shown=${on.shown}`);
await page.evaluate(() => { document.getElementById("show-locs").checked = false; document.getElementById("show-locs").dispatchEvent(new Event("change")); });
await page.waitForTimeout(100);

// ---- 3. types tokenized as `type` ----
const tok = await page.evaluate(() => {
  const toks = window.__dyno.tokenize(`LOAD %a:wire(1), %in_a\nMODULE_DEF %m:module("m"), %b:block {\n  COMB_PROCESS_DEF %p:process, %b1:block {}\n}  ["config.code:1:1-5"]`);
  const grab = (needle) => toks.find((t) => t.text === needle);
  return {
    wire: grab("wire") && grab("wire").type,
    block: grab("block") && grab("block").type,
    process: grab("process") && grab("process").type,
    module: grab("module") && grab("module").type,
    load: grab("LOAD") && grab("LOAD").type,
    moduledef: grab("MODULE_DEF") && grab("MODULE_DEF").type,
  };
});
console.log("tokens:", JSON.stringify(tok));
const isType = (t) => String(t).startsWith("type");
const isKeyword = (t) => String(t).startsWith("keyword");
check("type names tokenized as `type`", isType(tok.wire) && isType(tok.block) && isType(tok.process) && isType(tok.module),
  JSON.stringify(tok));
check("instructions tokenized as `keyword`", isKeyword(tok.load) && isKeyword(tok.moduledef));

// ---- 3b. `[{ ... }]` embedded SV block is one multiline string literal ----
// In dyno test scripts the SystemVerilog body is written as `map("code":[{ ... }])`.
// Everything between `[{` and `}]` must tokenize as `string` (not get re-tokenized
// as dyno-IR), and the closing `}]` must pop back to root so the trailing `)` etc.
// are brackets again.
const svEmbedTok = await page.evaluate(() => {
  const toks = window.__dyno.tokenize(
`TEST_SCRIPT :string("invert"), :block {
  PARSE_VERILOG_PASS map("code":[{
    module inv(input logic a, output logic y);
      assign y = ~a;
    endmodule
  }])
}`);
  const isStr = (t) => String(t.type).startsWith("string");
  // The whole SV body is one multiline string literal: every token inside the
  // `[{ ... }]` region must be type `string` (not re-tokenized as dyno-IR), so
  // there is no separate `module`/`assign`/`inv` keyword token.
  const bodyString = toks.filter((t) => t.text.includes("module inv") || t.text.includes("assign y") || t.text.includes("endmodule"));
  const bodyAllString = bodyString.length > 0 && bodyString.every((t) => isStr(t));
  // `[{` is the opening delimiter -> its own `string` token.
  const open = toks.find((t) => t.text === "[{");
  // After `}]` the `)` must be back to a bracket, not stuck in string mode.
  const closeParen = toks.find((t) => t.text === ")");
  return {
    bodyAllString, bodyString,
    openIsString: !!(open && isStr(open)),
    // After `}]` the tokenizer must pop back to root, so the `)` is a bracket
    // delimiter again (not still part of the string literal).
    closeIsBracket: !!(closeParen && String(closeParen.type).startsWith("delimiter")),
  };
});
check("[{ ... }] embedded SV body tokenized as multiline string",
  svEmbedTok.bodyAllString && svEmbedTok.openIsString && svEmbedTok.closeIsBracket,
  JSON.stringify(svEmbedTok.bodyString));

// ---- 4-6. parser + forward/reverse with a nested-IF IR ----
const NESTED_IR = `MODULE_DEF %Test:module("Test"), %b1:block {
  COMB_PROCESS_DEF %2:process, %b2:block {
    LOAD %w18:wire(1), %r1  ["config.code:23.9-29.12"]
    ICMP_WNE %w1:wire(1), #1'd0, %w18  ["config.code:23.9-29.12"]
    IF %b3:block, %b4:block, %w29:wire(128), %w1 {
      LOAD %w10:wire(1), %r2  ["config.code:24.11-25.37"]
      IF %b5:block, %b6:block, %w23:wire(128), %w3 {
        YIELD %w2  ["config.code:24.11-25.37"]
      }{
        YIELD %w14  ["config.code:24.11-25.37"]
      }  ["config.code:24.11-25.37"]
      YIELD %w23  ["config.code:23.9-29.12"]
    }{
      YIELD %w28  ["config.code:23.9-29.12"]
    }  ["config.code:23.9-29.12"]
    STORE_DEFER %w29, %r10, %1
  }
}
`;
await page.evaluate((ir) => window.__dyno.setOutput(ir), NESTED_IR);

const ir = await page.evaluate(() => ({ instrs: window.__dyno.instrs }));
const ifInstr = ir.instrs.find((i) => i.name === "IF" && i.isBlock);
check("outer IF parsed as block instr", !!ifInstr, ifInstr ? `segs=${JSON.stringify(ifInstr.segs)}` : "");
if (ifInstr) {
  const innerIf = ir.instrs.find((i) => i.name === "IF" && i.isBlock && i.startLine > ifInstr.startLine);
  const segLines = [];
  for (const [s, e] of ifInstr.segs) for (let L = s; L <= e; L++) segLines.push(L);
  const innerLines = [];
  for (let L = innerIf.startLine; L <= innerIf.endLine; L++) innerLines.push(L);
  check("outer IF segments exclude nested inner-IF block",
    innerLines.every((L) => !segLines.includes(L)),
    `outerSegs=${JSON.stringify(ifInstr.segs)} inner=${JSON.stringify(innerIf.segs)}`);
}

// forward text hover -> innermost instr (not the whole enclosing block)
// NESTED_IR 1-based lines: 1 MODULE_DEF, 2 COMB_PROCESS, 3 LOAD, 4 ICMP, 5 IF(outer),
//   6 LOAD, 7 IF(inner), 8 YIELD, 9 }/, 10 YIELD, 11 } inner close, 12 YIELD, 13 }/, 14 YIELD, 15 } outer close
const fwdSimple = await page.evaluate(() => window.__dyno.forwardLine(6)); // line 6 = LOAD %w10
check("forward on a body instr highlights only that instr",
  fwdSimple.ok && JSON.stringify(fwdSimple.segs) === "[[5,5]]",
  `segs=${JSON.stringify(fwdSimple.segs)}`);

const fwdBlockHeader = await page.evaluate(() => window.__dyno.forwardLine(5)); // line 5 = outer IF header
check("forward on a block header highlights the whole block",
  fwdBlockHeader.ok && fwdBlockHeader.segs.length >= 2,
  `segs=${JSON.stringify(fwdBlockHeader.segs)}`);

const fwdNested = await page.evaluate(() => window.__dyno.forwardLine(8)); // line 8 = inner IF's YIELD
check("forward on nested instr highlights only the nested instr",
  fwdNested.ok && JSON.stringify(fwdNested.segs) === "[[7,7]]",
  `segs=${JSON.stringify(fwdNested.segs)}`);

// reverse: hovering a line covered by the big multi-line loc should pick the
// smallest loc, not the whole enclosing range (so it highlights a few instrs,
// not everything mapped to 23.9-29.12)
const rev = await page.evaluate(() => window.__dyno.reversePosition(24, 20)); // 24 is inside 23.9-29.12 AND a single-line loc 24.11-25.37 / 24:...
check("reverse picks smallest source loc (not whole big range)",
  rev.ok && rev.segs.length >= 1 && rev.segs.length <= 4,
  `count=${rev.count} segs=${JSON.stringify(rev.segs)} loc=${JSON.stringify(rev.loc)}`);
const revMiss = await page.evaluate(() => window.__dyno.reversePosition(99999, 1));
check("reverse with no match clears highlight", revMiss.ok === false);

// ---- 6b. column-granularity source highlighting on the input side ----
// Recompile the counter SV (post_canon emits a single-line loc
// `config.code:10:16-21` for the RHS `count` token). Forward-hovering that
// output instruction should highlight only that column span in the input,
// not the whole line.
await page.evaluate(() => {
  window.__dyno.setMode("sv");
  window.__dyno.setInput(`module counter (
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
endmodule`);
  window.__dyno.run();
});
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok"), null, { timeout: 60000 });
await page.waitForFunction(() => window.__dyno.locCount > 0, null, { timeout: 5000 });
const colTest = await page.evaluate(() => {
  const locs = window.__dyno.locs;
  const idx = locs.findIndex((l) => l.beginLine === 10 && l.beginCol === 16 && l.endLine === 10);
  if (idx < 0) return { ok: false, locs: locs.slice(0, 10) };
  const fwd = window.__dyno.forwardMarker(idx);
  const hl = window.__dyno.getInputHlRanges();
  // at least one highlight on line 10 must be the exact count-token span
  // 16..21 (not the whole line, which would be 1..26 for this 25-char line)
  return { ok: true, fwdOk: fwd.ok, hl };
});
check("forward hover highlights the exact source column range (count token)",
  colTest.ok && colTest.fwdOk && colTest.hl.some((h) => h.sl === 10 && h.sc === 16 && h.ec === 21),
  `hl=${JSON.stringify(colTest.hl)}`);
// reverse: hovering over the `count` token (col 16) in `count <= count + 1`
// should highlight the instr that came from that exact token (LOAD, loc
// 10:16-21); hovering the `+` (col 22) should pick ADD (loc 10:16-25). Column-
// aware, so it is NOT an arbitrary same-line loc.
const revCol = await page.evaluate(() => {
  const h1 = window.__dyno.reversePosition(10, 16); // count
  const hl1 = window.__dyno.getInputHlRanges();
  const h2 = window.__dyno.reversePosition(10, 22); // '+'
  const hl2 = window.__dyno.getInputHlRanges();
  return { h1: { ok: h1.ok, loc: h1.loc }, hl1, h2: { ok: h2.ok, loc: h2.loc }, hl2 };
});
check("reverse hover over `count` picks the count-token loc",
  revCol.h1.ok && revCol.hl1.some((h) => h.sl === 10 && h.sc === 16 && h.ec === 21),
  `loc=${JSON.stringify(revCol.h1.loc)} hl=${JSON.stringify(revCol.hl1)}`);
check("reverse hover over `+` picks the ADD loc, not the count token",
  revCol.h2.ok && revCol.hl2.some((h) => h.sl === 10 && h.sc === 16 && h.ec === 25),
  `loc=${JSON.stringify(revCol.h2.loc)} hl=${JSON.stringify(revCol.hl2)}`);

// ---- 7. console panel (stdout/stderr) + red squiggles under input errors ----
// bad SystemVerilog -> slang diagnostics on stderr, red squiggle under the token
await page.evaluate(() => {
  window.__dyno.setMode("sv");
  window.__dyno.setInput(`module counter (
  input logic clk
);
  assign y = ~a;
endmodule`);
  window.__dyno.run();
});
await page.waitForFunction(() => window.__dyno.diagCount > 0, null, { timeout: 60000 });
const svDiag = await page.evaluate(() => ({
  diags: window.__dyno.diagCount,
  markers: window.__dyno.getInputMarkers(),
  stderr: window.__dyno.stderr,
  consoleVisible: window.__dyno.consoleVisible,
}));
check("SV error draws red squiggles in the input editor",
  svDiag.diags >= 1 && svDiag.markers.length >= 1,
  `diags=${svDiag.diags} markers=${svDiag.markers.length}`);
check("SV error surfaces slang stderr in the console and auto-opens it",
  svDiag.consoleVisible === true && /undeclared/.test(svDiag.stderr),
  `visible=${svDiag.consoleVisible} stderr=${JSON.stringify((svDiag.stderr||"").slice(0,60))}`);
const svMarker = svDiag.markers[0];
check("SV squiggle sits on the right line/column",
  svMarker && svMarker.startLineNumber === 4 && svMarker.startColumn === 15,
  `marker=${JSON.stringify(svMarker)}`);

// bad dyno-IR -> dyno's own diagnostics, also red squiggles
await page.evaluate(() => {
  window.__dyno.setMode("ir");
  window.__dyno.setInput(`MODULE_DEF :module("m"), :block {
  BOGUS_INSTR %x:wire(1), %y
}`);
  window.__dyno.run();
});
await page.waitForFunction(() => window.__dyno.diagCount > 0, null, { timeout: 60000 });
const irDiag = await page.evaluate(() => ({
  diags: window.__dyno.diagCount,
  markers: window.__dyno.getInputMarkers(),
}));
check("IR error draws red squiggles (dyno diagnostics)",
  irDiag.diags >= 1 && irDiag.markers.length >= 1,
  `diags=${irDiag.diags} markers=${irDiag.markers.length}`);

// console toggle open/close
await page.evaluate(() => document.getElementById("console-close").click());
check("console can be closed", await page.evaluate(() => !window.__dyno.consoleVisible));
await page.evaluate(() => document.getElementById("console-btn").click());
check("console can be reopened", await page.evaluate(() => window.__dyno.consoleVisible));

// editing the input clears stale squiggles
await page.evaluate(() => window.__dyno.setInput(`MODULE_DEF :module("m"), :block {}`));
await page.waitForFunction(() => window.__dyno.diagCount === 0, null, { timeout: 5000 });
check("editing input clears squiggles", await page.evaluate(() => window.__dyno.diagCount === 0));

// editing the input also invalidates source-linking highlights (both directions)
const linkOn = await page.evaluate(() => {
  window.__dyno.setOutput(`MODULE_DEF %m:module("m"), %b:block {\n  LOAD %a:wire(1), %in  ["config.code:1:1-5"]\n}`);
  window.__dyno.reversePosition(1, 2); // highlight output segs + input source range
  return { out: window.__dyno.outputHlDecos, in: window.__dyno.inputHlDecos };
});
await page.evaluate(() => window.__dyno.setInput(`MODULE_DEF :module("x"), :block {}`));
await page.waitForFunction(
  () => window.__dyno.outputHlDecos === 0 && window.__dyno.inputHlDecos === 0,
  null, { timeout: 5000 });
const linkCleared = await page.evaluate(
  () => window.__dyno.outputHlDecos === 0 && window.__dyno.inputHlDecos === 0);
check("editing input clears source-linking highlights",
  linkOn.out > 0 && linkOn.in > 0 && linkCleared,
  `before out=${linkOn.out} in=${linkOn.in} cleared=${linkCleared}`);

// switching mode replaces the input (setValue) and must clear source-linking too
const linkOn2 = await page.evaluate(() => {
  window.__dyno.reversePosition(1, 2);
  return { out: window.__dyno.outputHlDecos, in: window.__dyno.inputHlDecos };
});
await page.evaluate(() => window.__dyno.setMode("sv"));
await page.waitForFunction(
  () => window.__dyno.outputHlDecos === 0 && window.__dyno.inputHlDecos === 0,
  null, { timeout: 5000 });
const linkCleared2 = await page.evaluate(
  () => window.__dyno.outputHlDecos === 0 && window.__dyno.inputHlDecos === 0);
check("switching mode clears source-linking highlights",
  linkOn2.out > 0 && linkOn2.in > 0 && linkCleared2,
  `before out=${linkOn2.out} in=${linkOn2.in} cleared=${linkCleared2}`);

// parseDiagnostics unit check: ignores <flow> errors, keeps config.code/<input>
const pd = await page.evaluate(() => ({
  kept: window.__dyno.parseDiagnostics(`config.code:2:3: error: a\n<input>:5:7: b\n<flow>:9:1: c`).length,
  flowOnly: window.__dyno.parseDiagnostics(`<flow>:1:1: nope`).length,
}));
check("parseDiagnostics accepts config.code/<input>, skips <flow>", pd.kept === 2 && pd.flowOnly === 0,
  `kept=${pd.kept} flowOnly=${pd.flowOnly}`);

// ---- 8. spamming Run is safe (serialized, no queued-up / dropped runs) ----
// Runs are serialized on the main thread: extra clicks while busy are ignored,
// so a burst of clicks must settle to a single clean result (never stuck at
// "running…", never a queued pile-up with stale results/timeouts).
await page.evaluate(() => window.__dyno.setMode("sv"));
await page.evaluate(() => window.__dyno.setInput(`module counter (
  input logic clk, input logic rst, output logic [7:0] count
);
  always_ff @(posedge clk) begin
    if (rst) count <= 8'd0;
    else count <= count + 1;
  end
endmodule`));
await page.evaluate(() => window.__dyno.setPipeline("post_lower_memory"));
// Burst of runs while the first is in flight (no await between them).
for (let i = 0; i < 15; i++) await page.evaluate(() => window.__dyno.run());
// Give the single in-flight run time to finish.
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok") || window.__dyno.statusClass.includes("err"), null, { timeout: 60000 });
const spam = await page.evaluate(() => ({
  cls: window.__dyno.statusClass,
  status: window.__dyno.status,
  errorVisible: window.__dyno.errorVisible,
  runDisabled: document.getElementById("run-btn").disabled,
}));
check("spamming Run settles to one clean result (not stuck at 'running…')",
  spam.cls.includes("ok") && spam.runDisabled === false && spam.status !== "running…" && spam.status !== "busy…",
  `cls=${spam.cls} status=${spam.status} errVisible=${spam.errorVisible} runDisabled=${spam.runDisabled}`);
// The Run button must be re-enabled so a follow-up click works.
await page.evaluate(() => window.__dyno.run());
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok") || window.__dyno.statusClass.includes("err"), null, { timeout: 60000 });
const follow = await page.evaluate(() => ({
  cls: window.__dyno.statusClass,
  runDisabled: document.getElementById("run-btn").disabled,
}));
check("a follow-up Run after the burst works",
  follow.cls.includes("ok") && follow.runDisabled === false,
  `cls=${follow.cls} runDisabled=${follow.runDisabled}`);

// ---- 9. crash backtrace extraction ----------------------------------------
// The wasm is built with --profiling-funcs, so a trap's err.stack carries the
// C++ call chain as wasm frames. extractBacktrace must keep only those wasm
// frames (dropping the JS glue / worker frames).
const bt = await page.evaluate(() => window.__dyno.extractBacktrace(
  `RuntimeError: index out of bounds\n` +
  `    at dyno-sv-wasm.wasm.meta::Foo::bar (http://x/wasm/dyno-sv-wasm.wasm:wasm-function[42]:0x1a0)\n` +
  `    at dyno-sv-wasm.wasm.interpretPassPipeline (http://x/wasm/dyno-sv-wasm.wasm:wasm-function[7]:0x90)\n` +
  `    at Object._compile (http://x/wasm/dyno-sv-wasm.js:1:14366)\n` +
  `    at runMessage (http://x/worker.js:73:23)`
));
check("crash backtrace keeps only wasm frames",
  bt.split("\n").length === 2 && bt.includes("Foo::bar") && bt.includes("interpretPassPipeline") && !bt.includes("worker.js") && !bt.includes("_compile"),
  `bt=${JSON.stringify(bt)}`);
const btEmpty = await page.evaluate(() => window.__dyno.extractBacktrace("at Object._compile (x.js:1)\nat runMessage (x.js:2)"));
check("crash backtrace empty when no wasm frames", btEmpty === "", `btEmpty=${JSON.stringify(btEmpty)}`);

// ---- 10. wasm source map loaded (for crash-backtrace line numbers) --------
// The build emits dyno-sv-wasm.wasm.map (-gline-tables-only -gsource-map); the
// worker fetches + decodes it at init so a trap's wasm-function[N]:0x.. offset
// can be turned into [file:line]. If the map wasn't shipped/fetched, the
// backtrace just loses line annotations, so assert it actually arrived.
let mapStats = await page.evaluate(() => window.__dyno.wasmMapStats);
// The mapReady message arrives when the worker finishes init, which can race
// the first settled compile; poll briefly for it.
for (let i = 0; i < 20 && !mapStats; i++) {
  await page.waitForTimeout(250);
  mapStats = await page.evaluate(() => window.__dyno.wasmMapStats);
}
check("wasm source map fetched+decoded by worker (for backtrace line numbers)",
  !!(mapStats && mapStats.loaded && mapStats.entries > 0),
  `mapStats=${JSON.stringify(mapStats)}`);

// ---- 11. Extra args with a value-less flag (--debug) must not crash -------
// The harness builds a synthetic argv for CmdLineArgHandler; it must be
// null-terminated like a real C argv. Run a few compiles with --debug.
await page.evaluate(() => {
  window.__dyno.setMode("sv");
  window.__dyno.setPipeline("post_lower_memory");
  document.getElementById("extra-args").value = "--debug";
});
let debugCrash = null;
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.__dyno.run());
  await page.waitForFunction(() => window.__dyno.statusClass.includes("ok") || window.__dyno.statusClass.includes("err") || window.__dyno.statusClass.includes("crashed"), null, { timeout: 60000 });
  const s = await page.evaluate(() => ({ cls: window.__dyno.statusClass, err: window.__dyno.error }));
  if (!s.cls.includes("ok")) { debugCrash = { cls: s.cls, err: s.err.slice(0,120) }; break; }
}
check("--debug extra arg parses without crashing (argv null-term fix)",
  debugCrash === null, debugCrash ? `crash: ${JSON.stringify(debugCrash)}` : "4 runs ok");
await page.evaluate(() => { document.getElementById("extra-args").value = ""; });

// ---- 12. graph view (dyno-instr .dot -> Graphviz) --------------------------
const GRAPH_DOT = `digraph design {
  graph [rankdir=TB];
  node [shape=box, style="filled,rounded"];
  edge [];
  "1" [label="LOAD", fillcolor="#2e66c4"];
  "2" [label="XOR", fillcolor="#2e8f6a"];
  "1" -> "2";
  "3" [label="STORE", fillcolor="#2e66c4"];
  "2" -> "3";
}
`;
const gRender = await page.evaluate(async (dot) => {
  const r = await window.__dyno.graph.renderDot(dot);
  return { ok: r.ok, nodes: r.nodes, edges: r.edges, svgLen: (r.svg || "").length, msg: r.message };
}, GRAPH_DOT);
check("graph renders .dot to SVG in-browser (viz wasm works)",
  gRender.ok && gRender.nodes === 3 && gRender.edges === 2 && gRender.svgLen > 1000,
  `nodes=${gRender.nodes} edges=${gRender.edges} svgLen=${gRender.svgLen}`);

// too-large graphs bail cleanly instead of trying to lay out 1000s of nodes
const GRAPH_BIG = "digraph design {\n" +
  Array.from({ length: 1200 }, (_, i) => `"${i}" [label="X"];`).join("\n") + "\n}\n";
const gBig = await page.evaluate(async (dot) => await window.__dyno.graph.renderDot(dot), GRAPH_BIG);
check("graph bails cleanly on too-large graphs",
  gBig.ok === false && /too large/i.test(gBig.message || ""),
  (gBig.message || "").slice(0, 60));

// Graph mode is only active for the dyno-instr `.dot` stage; on the default IR
// stage the graph view stays off.
const gIr = await page.evaluate(() => ({
  graphable: !!window.__dyno.graph.graphable,
  mode: window.__dyno.graph.mode,
}));
check("graph hidden on IR stage",
  gIr.graphable === false && gIr.mode === false,
  JSON.stringify(gIr));

// ---- 13. frontend pipeline preset + custom script prefill + tooltips ----
// frontend preset runs no synthesis passes (the SV is parsed by the harness)
// and dumps a post_frontend.dyno stage.
const frontPreset = await page.evaluate(() =>
  Array.from(document.getElementById("pipeline-select").options).map((o) => o.value));
check("frontend preset appears in the pipeline dropdown", frontPreset.includes("frontend"),
  JSON.stringify(frontPreset));

await page.evaluate(() => window.__dyno.setMode("sv"));
await page.evaluate(() => window.__dyno.setInput(`module counter (
  input logic clk, input logic rst, output logic [7:0] count
);
  always_ff @(posedge clk) begin
    if (rst) count <= 8'd0;
    else count <= count + 1;
  end
endmodule`));
await page.evaluate(() => window.__dyno.setPipeline("frontend"));
await page.evaluate(() => window.__dyno.run());
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok"), null, { timeout: 60000 });
const frontStages = await page.evaluate(() =>
  Array.from(document.getElementById("out-stage-select").options).map((o) => o.value));
check("frontend preset emits a post_frontend.dyno stage",
  frontStages.includes("post_frontend.dyno"),
  JSON.stringify(frontStages));

// custom script prefill shows the whole flow (function definitions + passes)
// and ends with CALL flow_completeFlow
const customScript = await page.evaluate(() => {
  window.__dyno.setPipeline("custom");
  return window.__dyno.script;
});
check("custom script prefill shows the whole flow",
  customScript.includes("FUNCTION_DEF %earlyCanonFlow") &&
  customScript.includes("meta.INST_COMBINE_PASS") &&
  customScript.includes("meta.ABC_PASS") &&
  customScript.includes("CALL symbol(\"flow_completeFlow\")"),
  "len=" + customScript.length);

// the prefilled custom script must actually run the complete flow
await page.evaluate(() => window.__dyno.setMode("sv"));
await page.evaluate(() => window.__dyno.setInput(`module counter (
  input logic clk, input logic rst, output logic [7:0] count
);
  always_ff @(posedge clk) begin
    if (rst) count <= 8'd0;
    else count <= count + 1;
  end
endmodule`));
await page.evaluate(() => window.__dyno.setPipeline("custom"));
await page.evaluate(() => window.__dyno.run());
await page.waitForFunction(() => window.__dyno.statusClass.includes("ok"), null, { timeout: 120000 });
const customStages = await page.evaluate(() =>
  Array.from(document.getElementById("out-stage-select").options).map((o) => o.value));
check("custom script runs the complete flow (post_techmap stage present)",
  customStages.includes("post_techmap.dyno"),
  JSON.stringify(customStages));

// tooltip data: pass + instr descriptions from HWDialectPasses.h / HWInstrs.inc
const tt = await page.evaluate(() => ({
  instCombine: window.__dyno.passTooltip["INST_COMBINE_PASS"] || null,
  mux: window.__dyno.instrTooltip["MUX"] || null,
  none: window.__dyno.passTooltip["NO_SUCH_PASS"] || null,
}));
check("pass tooltips come from HWDialectPasses.h",
  !!tt.instCombine && /Combine\/simplify instructions/.test(tt.instCombine),
  JSON.stringify(tt.instCombine));
check("instr tooltips come from HWInstrs.inc",
  !!tt.mux && /sel true_val false_val/.test(tt.mux),
  JSON.stringify(tt.mux));
check("unknown names have no tooltip", tt.none === null, JSON.stringify(tt.none));

await browser.close();
server.close();

console.log("\n=== Summary ===");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
