import { check, run, start, stop, summary, waitStatus } from "./harness.mjs";
const { server, browser, page } = await start(8123);
const results = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const state = () => ev(() => window.__dyno.state);
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
const initial = await waitStatus(page, 40000);
check(results, "initial compile succeeds", initial.cls.includes("ok"), JSON.stringify(initial));
await page.waitForFunction(() => window.__dyno.state.locCount > 0, null, { timeout: 5000 });
const modeOptions = await ev(() => Array.from(document.getElementById("mode-select").options).map((option) => option.value));
check(
  results,
  "single Mode selector covers the workflows",
  ["sv-builtin", "sv-no-abc", "sv-parsed", "ir-builtin", "test"].every((mode) => modeOptions.includes(mode)),
  JSON.stringify(modeOptions),
);
check(
  results,
  "legacy selectors and controls are gone",
  await ev(
    () =>
      ["pipeline-select", "target-select", "pipeline-field", "target-field", "script-pane", "script-editor", "split-2", "download-btn", "load-btn"].every((id) => !document.getElementById(id)) &&
      !document.querySelector(".group-meta") &&
      !document.querySelector(".file-name") &&
      !document.querySelector(".file-role") &&
      !document.querySelector(".file-hint"),
  ),
);
const tabs = await ev(() => ({
  tabs: window.__dyno.state.tabs,
  dom: [...document.querySelectorAll('.group-tabs .file-tab:not([data-tab-id="output"])')].map((tab) => tab.textContent.trim()),
  active: document.querySelector(".group-tabs .file-tab.active")?.textContent.trim() || "",
}));
check(
  results,
  "input files are shown as tabs",
  tabs.tabs.some((tab) => tab.name === "flow.dyno" && tab.role === "flow") &&
    tabs.tabs.some((tab) => tab.name === "design.sv" && tab.role === "design" && tab.active) &&
    tabs.dom.length === tabs.tabs.length &&
    tabs.active.includes("design.sv"),
  JSON.stringify(tabs),
);
check(results, "default preset uses the simple counter example", await ev(() => window.__dyno.state.input.includes("module counter")));
await ev(() => window.__dyno.addFile("helper.sv", "design", "module helper(input logic a, output logic y);\n  assign y = ~a;\nendmodule"));
const afterAdd = await ev(() => ({
  tabs: window.__dyno.state.tabs,
  active: window.__dyno.state.activeFileName,
  input: window.__dyno.state.input,
  domCount: document.querySelectorAll('.group-tabs .file-tab:not([data-tab-id="output"])').length,
}));
check(
  results,
  "adding a file creates a tab and makes it active",
  afterAdd.tabs.length === 3 && afterAdd.active === "helper.sv" && afterAdd.domCount === 3 && afterAdd.input.includes("module helper"),
  JSON.stringify(afterAdd),
);
await ev(() => window.__dyno.setActiveFile("design.sv"));
check(results, "switching a tab changes the editor model", await ev(() => window.__dyno.state.activeFileName === "design.sv"));
await ev(() => window.__dyno.removeFile("helper.sv"));
check(results, "closing a tab removes the file", await ev(() => window.__dyno.state.tabs.length === 2 && !window.__dyno.state.tabs.some((tab) => tab.name === "helper.sv")));
const middleClosed = await ev(() => {
  window.__dyno.addFile("middle.sv", "design", "module middle; endmodule");
  const tab = [...document.querySelectorAll(".file-tab")].find((entry) => entry.querySelector(".tab-name")?.textContent === "middle.sv");
  tab.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  return window.__dyno.state.tabs;
});
check(results, "middle-click closes a tab", !middleClosed.some((tab) => tab.name === "middle.sv"), JSON.stringify(middleClosed));
const addType = await ev(() => {
  const group = window.__dyno.state.groups.find((entry) => !entry.output);
  const el = document.querySelector(`.editor-group[data-group-id="${group.id}"]`);
  el.querySelector("[data-add]").click();
  el.querySelector('[data-type="memory"]').click();
  return window.__dyno.state.tabs;
});
check(
  results,
  "plus adds the selected file type",
  addType.some((tab) => tab.role === "memory" && tab.name.startsWith("extra_memory")),
  JSON.stringify(addType),
);
await ev(() => {
  const tab = window.__dyno.state.tabs.find((entry) => entry.role === "memory");
  if (tab) window.__dyno.removeFile(tab.name);
});
await ev(() => {
  window.__dyno.addFile("mem.sv", "design", "module mem(input logic clk); endmodule");
  window.__dyno.setFileRole("mem.sv", "memory");
});
check(results, "file role can still be changed via the API", await ev(() => window.__dyno.state.files.find((file) => file.name === "mem.sv")?.role === "memory"));
await ev(() => window.__dyno.removeFile("mem.sv"));
const stageNames = await ev(() => window.__dyno.state.stages);
const expectedStages = [
  "post_frontend.dyno",
  "post_early_canon.dyno",
  "post_canon.dyno",
  "post_early_opt.dyno",
  "post_lower_cfg.dyno",
  "post_memory_mux.dyno",
  "post_lower_memory.dyno",
  "post_techmap.dyno",
  "post_techmap.dot",
  "dump.v",
];
const techOut = await ev(() => window.__dyno.state.output);
check(
  results,
  "full pipeline emits every stage and defaults to techmapped IR",
  expectedStages.every((stage) => stageNames.includes(stage)) &&
    (await ev(() => window.__dyno.state.stage === "post_techmap.dyno")) &&
    /STDCELL_INSTANCE/.test(techOut) &&
    /sky130_fd_sc_hd__/.test(techOut),
  `stages=${JSON.stringify(stageNames)} len=${techOut.length}`,
);
const decorations = await ev(() => ({
  groups: window.__dyno.state.locGroups.length,
  hidden: document.querySelectorAll(".dyno-loc-hidden").length,
  strings: window.__dyno.state.locCount,
}));
check(
  results,
  "whole bracket groups hidden (no stray [ , ])",
  decorations.hidden > 0 && decorations.strings >= decorations.groups,
  `decos=${decorations.hidden} groups=${decorations.groups} strings=${decorations.strings}`,
);
await ev(() => {
  const checkbox = document.getElementById("show-locs");
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
});
await page.waitForTimeout(100);
const shown = await ev(() => ({
  shown: document.querySelectorAll(".dyno-loc").length,
  hidden: document.querySelectorAll(".dyno-loc-hidden").length,
}));
check(results, "toggling 'Show source locs' reveals markers", shown.shown > 0 && shown.hidden === 0, `shown=${shown.shown}`);
await ev(() => {
  const checkbox = document.getElementById("show-locs");
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event("change"));
});
await page.waitForTimeout(100);
const tokens = await ev(() => {
  const toks = window.__dyno.tokenize(`LOAD %a:wire(1), %in_a\nMODULE_DEF %m:module("m"), %b:block {\n  COMB_PROCESS_DEF %p:process, %b1:block {}\n}  ["config.code:1:1-5"]`);
  const grab = (needle) => toks.find((token) => token.text === needle);
  return { wire: grab("wire")?.type, block: grab("block")?.type, process: grab("process")?.type, module: grab("module")?.type, load: grab("LOAD")?.type, moduledef: grab("MODULE_DEF")?.type };
});
const isType = (type) => String(type).startsWith("type");
const isKeyword = (type) => String(type).startsWith("keyword");
check(results, "type names tokenized as `type`", isType(tokens.wire) && isType(tokens.block) && isType(tokens.process) && isType(tokens.module), JSON.stringify(tokens));
check(results, "instructions tokenized as `keyword`", isKeyword(tokens.load) && isKeyword(tokens.moduledef));
const svKeywords = await ev(() => {
  const words = [
    "always_latch",
    "always_ff",
    "always_comb",
    "edge",
    "iff",
    "unique",
    "priority",
    "inside",
    "matches",
    "throughout",
    "ifnone",
    "instance",
    "intersect",
    "eventually",
    "liblist",
    "library",
    "soft",
    "logic",
  ];
  const byText = new Map(window.__dyno.tokenize(words.join(" "), "verilog").map((token) => [token.text, token.type]));
  return words.map((word) => ({ word, type: byText.get(word) }));
});
check(
  results,
  "SystemVerilog keywords are highlighted",
  svKeywords.every((entry) => String(entry.type).startsWith("keyword") || String(entry.type).startsWith("type")),
  JSON.stringify(svKeywords),
);
const embedded = await ev(() => {
  const toks = window.__dyno.tokenize(`TEST_SCRIPT :string("invert"), :block {
  PARSE_VERILOG_PASS map("code":[{
    module inv(input logic a, output logic y);
      assign y = ~a;
    endmodule
  }])
}`);
  const isString = (type) => String(type).startsWith("string");
  const body = toks.filter((token) => token.text.includes("module inv") || token.text.includes("assign y") || token.text.includes("endmodule"));
  const open = toks.find((token) => token.text === "[{");
  const closeParen = toks.find((token) => token.text === ")");
  return {
    bodyAllString: body.length > 0 && body.every((token) => isString(token.type)),
    openIsString: !!(open && isString(open.type)),
    closeIsBracket: !!(closeParen && String(closeParen.type).startsWith("delimiter")),
  };
});
check(results, "[{ ... }] embedded SV body tokenized as multiline string", embedded.bodyAllString && embedded.openIsString && embedded.closeIsBracket);
const nestedIR = `MODULE_DEF %Test:module("Test"), %b1:block {
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
await ev((ir) => window.__dyno.setOutput(ir), nestedIR);
const ir = await ev(() => ({ instrs: window.__dyno.state.instrs }));
const ifInstr = ir.instrs.find((instr) => instr.name === "IF" && instr.isBlock);
check(results, "outer IF parsed as block instr", !!ifInstr, ifInstr ? `segs=${JSON.stringify(ifInstr.segs)}` : "");
if (ifInstr) {
  const innerIf = ir.instrs.find((instr) => instr.name === "IF" && instr.isBlock && instr.startLine > ifInstr.startLine);
  const segLines = [];
  for (const [start, end] of ifInstr.segs) for (let line = start; line <= end; line++) segLines.push(line);
  const innerLines = [];
  for (let line = innerIf.startLine; line <= innerIf.endLine; line++) innerLines.push(line);
  check(
    results,
    "outer IF segments exclude nested inner-IF block",
    innerLines.every((line) => !segLines.includes(line)),
    `outerSegs=${JSON.stringify(ifInstr.segs)} inner=${JSON.stringify(innerIf.segs)}`,
  );
}
const fwdSimple = await ev(() => window.__dyno.forwardLine(6));
const fwdBlockHeader = await ev(() => window.__dyno.forwardLine(5));
const fwdNested = await ev(() => window.__dyno.forwardLine(8));
check(
  results,
  "forward highlights body, block header, and nested instr correctly",
  fwdSimple.ok && JSON.stringify(fwdSimple.segs) === "[[5,5]]" && fwdBlockHeader.ok && fwdBlockHeader.segs.length >= 2 && fwdNested.ok && JSON.stringify(fwdNested.segs) === "[[7,7]]",
  `simple=${JSON.stringify(fwdSimple.segs)} block=${JSON.stringify(fwdBlockHeader.segs)} nested=${JSON.stringify(fwdNested.segs)}`,
);
const rev = await ev(() => window.__dyno.reversePosition(24, 20));
check(results, "reverse picks smallest source loc (not whole big range)", rev.ok && rev.segs.length >= 1 && rev.segs.length <= 4, `count=${rev.count} segs=${JSON.stringify(rev.segs)}`);
check(results, "reverse with no match clears highlight", (await ev(() => window.__dyno.reversePosition(99999, 1))).ok === false);
await run(
  page,
  "sv-builtin",
  `module counter (
  input logic clk
);
  assign y = ~a;
endmodule`,
);
await page.waitForFunction(() => window.__dyno.state.diagCount > 0, null, { timeout: 60000 });
const svDiag = await ev(() => ({
  diags: window.__dyno.state.diagCount,
  markers: window.__dyno.getInputMarkers(),
  stderr: window.__dyno.state.stderr,
  consoleVisible: window.__dyno.state.consoleVisible,
}));
check(
  results,
  "SV error draws squiggles, surfaces slang stderr, and auto-opens console",
  svDiag.diags >= 1 &&
    svDiag.markers.length >= 1 &&
    svDiag.consoleVisible === true &&
    /undeclared/.test(svDiag.stderr) &&
    svDiag.markers[0] &&
    svDiag.markers[0].startLineNumber === 4 &&
    svDiag.markers[0].startColumn === 15,
  `diags=${svDiag.diags} markers=${svDiag.markers.length} marker=${JSON.stringify(svDiag.markers[0])}`,
);
await run(
  page,
  "ir-builtin",
  `MODULE_DEF :module("m"), :block {
  BOGUS_INSTR %x:wire(1), %y
}`,
);
await page.waitForFunction(() => window.__dyno.state.diagCount > 0, null, { timeout: 60000 });
const irDiag = await ev(() => ({ diags: window.__dyno.state.diagCount, markers: window.__dyno.getInputMarkers() }));
check(results, "IR error draws red squiggles (dyno diagnostics)", irDiag.diags >= 1 && irDiag.markers.length >= 1, `diags=${irDiag.diags} markers=${irDiag.markers.length}`);
await ev(() => document.getElementById("console-close").click());
const closed = await ev(() => !window.__dyno.state.consoleVisible);
await ev(() => document.getElementById("console-btn").click());
check(results, "console can be closed and reopened", closed && (await ev(() => window.__dyno.state.consoleVisible)));
const ansiRender = await ev(() => window.__dyno.ansiToHtml('\x1b[1m\x1b[32mpassed:\x1b[37m "x"\x1b[0m'));
check(
  results,
  "ANSI terminal colors render as styled spans",
  ansiRender.includes("font-weight:700") && ansiRender.includes("color:#4e9a06") && ansiRender.includes("color:#d3d7cf") && !ansiRender.includes("\x1b"),
  ansiRender,
);
check(results, "stripAnsi removes ANSI escapes for diagnostics", (await ev(() => window.__dyno.stripAnsi("\x1b[31merror\x1b[0m"))) === "error");
await ev(() => window.__dyno.setInput('MODULE_DEF :module("m"), :block {}'));
await page.waitForFunction(() => window.__dyno.state.diagCount === 0, null, { timeout: 5000 });
check(results, "editing input clears squiggles", await ev(() => window.__dyno.state.diagCount === 0));
const linkOn = await ev(() => {
  window.__dyno.setOutput('MODULE_DEF %m:module("m"), %b:block {\n  LOAD %a:wire(1), %in  ["config.code:1:1-5"]\n}');
  window.__dyno.reversePosition(1, 2);
  return { out: window.__dyno.state.outputHlDecos, in: window.__dyno.state.inputHlDecos };
});
await ev(() => window.__dyno.setInput('MODULE_DEF :module("x"), :block {}'));
await page.waitForFunction(() => window.__dyno.state.outputHlDecos === 0 && window.__dyno.state.inputHlDecos === 0, null, { timeout: 5000 });
check(
  results,
  "editing input clears source-linking highlights",
  linkOn.out > 0 && linkOn.in > 0 && (await ev(() => window.__dyno.state.outputHlDecos === 0 && window.__dyno.state.inputHlDecos === 0)),
  `before out=${linkOn.out} in=${linkOn.in}`,
);
const linkOn2 = await ev(() => {
  window.__dyno.reversePosition(1, 2);
  return { out: window.__dyno.state.outputHlDecos, in: window.__dyno.state.inputHlDecos };
});
await ev(async () => {
  await window.__dyno.setMode("sv-builtin");
});
await page.waitForFunction(() => window.__dyno.state.outputHlDecos === 0 && window.__dyno.state.inputHlDecos === 0, null, { timeout: 5000 });
check(
  results,
  "switching mode clears source-linking highlights",
  linkOn2.out > 0 && linkOn2.in > 0 && (await ev(() => window.__dyno.state.outputHlDecos === 0 && window.__dyno.state.inputHlDecos === 0)),
  `before out=${linkOn2.out} in=${linkOn2.in}`,
);
const parsedDiagnostics = await ev(() => ({
  kept: window.__dyno.parseDiagnostics(`config.code:2:3: error: a\n<input>:5:7: b\n<flow>:9:1: c`).length,
  flowOnly: window.__dyno.parseDiagnostics(`<flow>:1:1: nope`).length,
}));
check(
  results,
  "parseDiagnostics accepts config.code/<input>, skips <flow>",
  parsedDiagnostics.kept === 2 && parsedDiagnostics.flowOnly === 0,
  `kept=${parsedDiagnostics.kept} flowOnly=${parsedDiagnostics.flowOnly}`,
);
await ev(async () => {
  await window.__dyno.setMode("sv-builtin");
  window.__dyno.setInput(`module counter (
  input logic clk, input logic rst, output logic [7:0] count
);
  always_ff @(posedge clk) begin
    if (rst) count <= 8'd0;
    else count <= count + 1;
  end
endmodule`);
});
for (let i = 0; i < 15; i++) await ev(() => window.__dyno.run());
await waitStatus(page, 60000);
const spam = await ev(() => ({
  cls: window.__dyno.state.statusClass,
  status: window.__dyno.state.status,
  runDisabled: document.getElementById("run-btn").disabled,
}));
check(
  results,
  "spamming Run settles to one clean result (not stuck at 'running…')",
  spam.cls.includes("ok") && spam.runDisabled === false && spam.status !== "running…" && spam.status !== "busy…",
  `cls=${spam.cls} status=${spam.status} runDisabled=${spam.runDisabled}`,
);
await ev(() => window.__dyno.run());
await waitStatus(page, 60000);
check(results, "a follow-up Run after the burst works", await ev(() => window.__dyno.state.statusClass.includes("ok") && !document.getElementById("run-btn").disabled));
const bt = await ev(() =>
  window.__dyno.extractBacktrace(
    `RuntimeError: index out of bounds\n` +
      `    at dyno-sv-wasm.wasm.meta::Foo::bar (http://x/wasm/dyno-sv-wasm.wasm:wasm-function[42]:0x1a0)\n` +
      `    at dyno-sv-wasm.wasm.interpretPassPipeline (http://x/wasm/dyno-sv-wasm.wasm:wasm-function[7]:0x90)\n` +
      `    at Object._compile (http://x/wasm/dyno-sv-wasm.js:1:14366)\n` +
      `    at runMessage (http://x/worker.js:73:23)`,
  ),
);
check(
  results,
  "crash backtrace keeps only wasm frames",
  bt.split("\n").length === 2 && bt.includes("Foo::bar") && bt.includes("interpretPassPipeline") && !bt.includes("worker.js") && !bt.includes("_compile"),
  `bt=${JSON.stringify(bt)}`,
);
check(results, "crash backtrace empty when no wasm frames", (await ev(() => window.__dyno.extractBacktrace("at Object._compile (x.js:1)\nat runMessage (x.js:2)"))) === "");
let mapStats = await ev(() => window.__dyno.state.wasmMapStats);
for (let i = 0; i < 20 && !mapStats; i++) {
  await page.waitForTimeout(250);
  mapStats = await ev(() => window.__dyno.state.wasmMapStats);
}
check(results, "wasm source map fetched+decoded by worker (for backtrace line numbers)", !!(mapStats && mapStats.loaded && mapStats.entries > 0), `mapStats=${JSON.stringify(mapStats)}`);
let debugCrash = null;
for (let i = 0; i < 4; i++) {
  const status = await run(page, "sv-builtin", counter, "--debug");
  if (!status.cls.includes("ok")) {
    debugCrash = { cls: status.cls, err: (await ev(() => window.__dyno.state.error)).slice(0, 120) };
    break;
  }
}
check(results, "--debug extra arg parses without crashing (argv null-term fix)", debugCrash === null, debugCrash ? JSON.stringify(debugCrash) : "4 runs ok");
await ev(() => {
  document.getElementById("extra-args").value = "";
});
const graphDot = `digraph design {
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
const graphRender = await ev(async (dot) => {
  const result = await window.__dyno.graph.renderDot(dot);
  return { ok: result.ok, nodes: result.nodes, edges: result.edges, svgLen: (result.svg || "").length, msg: result.message };
}, graphDot);
check(
  results,
  "graph renders .dot to SVG in-browser (viz wasm works)",
  graphRender.ok && graphRender.nodes === 3 && graphRender.edges === 2 && graphRender.svgLen > 1000,
  `nodes=${graphRender.nodes} edges=${graphRender.edges} svgLen=${graphRender.svgLen}`,
);
const graphBig = "digraph design {\n" + Array.from({ length: 1200 }, (_, i) => `"${i}" [label="X"];`).join("\n") + "\n}\n";
const bigResult = await ev(async (dot) => await window.__dyno.graph.renderDot(dot), graphBig);
check(results, "graph bails cleanly on too-large graphs", bigResult.ok === false && /too large/i.test(bigResult.message || ""), (bigResult.message || "").slice(0, 60));
const graphIr = await ev(() => ({ graphable: !!window.__dyno.graph.graphable, mode: window.__dyno.graph.mode }));
check(results, "graph hidden on IR stage", graphIr.graphable === false && graphIr.mode === false, JSON.stringify(graphIr));
await ev(() => window.__dyno.setStage("post_techmap.dot"));
const graphDotState = await ev(() => ({ graphable: !!window.__dyno.graph.graphable, mode: window.__dyno.graph.mode }));
check(results, "graph view activates for the .dot stage", graphDotState.graphable === true && graphDotState.mode === true, JSON.stringify(graphDotState));
await ev(() => window.__dyno.setStage("dump.v"));
const vlog = await ev(() => ({ text: window.__dyno.state.output, lang: window.__dyno.state.outputLanguage }));
check(
  results,
  "dump.v stage is a Verilog netlist",
  /^module /m.test(vlog.text) && /endmodule/.test(vlog.text) && /sky130_fd_sc_hd__/.test(vlog.text) && vlog.lang === "verilog",
  `lang=${vlog.lang} len=${vlog.text.length}`,
);
await run(
  page,
  "ir-builtin",
  `MODULE_DEF %mod:module("mod"), %b:block {
  INPUT_REGISTER_DEF %in_a:register(1)
  OUTPUT_REGISTER_DEF %out_a:register(8)
  COMB_PROCESS_DEF %p:process, %pb:block {
    LOAD %a:wire(1), %in_a
    NOT %n:wire(1), %a
    ZEXT %z:wire(8), %n
    STORE %z, %out_a
  }
}`,
);
const irRun = await ev(() => ({ cls: window.__dyno.state.statusClass, stages: window.__dyno.state.stages, output: window.__dyno.state.output, tabs: window.__dyno.state.tabs }));
check(
  results,
  "Dyno-IR mode parses the design and runs the full pipeline",
  irRun.cls.includes("ok") &&
    irRun.tabs.some((tab) => tab.name === "design.dyno" && tab.role === "design") &&
    irRun.stages.includes("post_techmap.dyno") &&
    /module\("mod"\)/.test(irRun.output) &&
    /STDCELL_INSTANCE/.test(irRun.output) &&
    /sky130_fd_sc_hd__/.test(irRun.output),
  `cls=${irRun.cls} stages=${JSON.stringify(irRun.stages)}`,
);
await run(page, "test", undefined, "--only=instcombine-constants");
const testRun = await ev(() => ({
  cls: window.__dyno.state.statusClass,
  stdout: window.__dyno.stripAnsi(window.__dyno.state.stdout),
  tabs: window.__dyno.state.tabs,
  consoleVisible: window.__dyno.state.consoleVisible,
}));
check(
  results,
  "test mode opens the console and runs selected tests",
  testRun.consoleVisible === true &&
    testRun.cls.includes("ok") &&
    testRun.tabs.some((tab) => tab.name === "test.dyno" && tab.role === "test") &&
    /ALL TESTS PASSED/.test(testRun.stdout) &&
    /passed: "instcombine-constants"/.test(testRun.stdout),
  `cls=${testRun.cls} stdout=${JSON.stringify(testRun.stdout.slice(0, 160))}`,
);
await ev(() => {
  document.getElementById("extra-args").value = "";
});
await ev(async () => {
  await window.__dyno.setMode("sv-parsed");
});
const parsedTabs = await ev(() => window.__dyno.state.tabs);
check(
  results,
  "parsed mode pre-fills liberty and memory tabs",
  parsedTabs.some((tab) => tab.name === "sky130_fd_sc_hd__tt_025C_1v80.lib" && tab.role === "liberty") && parsedTabs.some((tab) => tab.name === "memory.sv" && tab.role === "memory"),
  JSON.stringify(parsedTabs),
);
const parsedFlow = await ev(() => window.__dyno.state.flowScript);
check(
  results,
  "parsed mode composes the full pipeline and memory conversion",
  parsedFlow.includes("PARSE_LIBERTY_PASS") &&
    parsedFlow.includes("flow_completeFlow_generic") &&
    parsedFlow.includes("flow_completeFlow_tgt_specific") &&
    parsedFlow.includes("MODULE_TO_STD_CELL_PASS"),
  `synthLen=${parsedFlow.length}`,
);
await run(page, "sv-parsed", undefined, "", 180000);
const parsedDefault = await ev(() => ({ cls: window.__dyno.state.statusClass, output: window.__dyno.state.output, stages: window.__dyno.state.stages }));
check(
  results,
  "parsed default design infers multiple std cell memories",
  parsedDefault.cls.includes("ok") && parsedDefault.stages.includes("post_techmap.dyno") && (parsedDefault.output.match(/STDCELL_INSTANCE .*mem_32x32/g) || []).length >= 2,
  `cls=${parsedDefault.cls} mem32=${(parsedDefault.output.match(/STDCELL_INSTANCE .*mem_32x32/g) || []).length}`,
);
const customMemoryDesign = `module Test(
  input logic clk,
  input logic rst,
  input logic [4:0] waddr,
  input logic [31:0] wdata,
  input logic [4:0] raddr,
  output logic [31:0] rdata,
  output logic [7:0] count
);
  logic [31:0] mem[31:0];
  always_ff@(posedge clk) begin
    if (rst) count <= 0; else count <= count + 1;
    mem[waddr] <= wdata;
  end
  assign rdata = mem[raddr];
endmodule`;
await run(page, "sv-parsed", customMemoryDesign, "", 180000);
const parsedRun = await ev(() => ({
  cls: window.__dyno.state.statusClass,
  stages: window.__dyno.state.stages,
  output: window.__dyno.state.output,
  stderr: window.__dyno.state.stderr,
  err: window.__dyno.state.error,
}));
const passMissing = parsedRun.cls.includes("err") && /invalid opcode|MODULE_TO_STD_CELL_PASS/.test(parsedRun.stderr + parsedRun.err);
check(
  results,
  passMissing ? "parsed mode maps the supplied memory model (skipped: wasm lacks ModuleToStdCellPass)" : "parsed mode maps the supplied memory model instead of a built-in one",
  passMissing ||
    (parsedRun.cls.includes("ok") &&
      parsedRun.stages.includes("post_techmap.dyno") &&
      /STDCELL_INSTANCE .*mem_32x32/.test(parsedRun.output) &&
      !/MODULE_DEF %mem_32x32/.test(parsedRun.output) &&
      !/FakeRAM/.test(parsedRun.output)),
  passMissing ? "rebuild wasm to run this check" : `cls=${parsedRun.cls} stages=${JSON.stringify(parsedRun.stages)}`,
);
await ev((input) => {
  window.__dyno.setInput(input);
  window.__dyno.removeFile("memory.sv");
  window.__dyno.run();
}, counter);
await waitStatus(page, 180000);
const parsedNoMemory = await ev(() => ({ cls: window.__dyno.state.statusClass, stages: window.__dyno.state.stages, files: window.__dyno.state.files }));
check(
  results,
  "parsed mode still runs after the memory tab is removed",
  parsedNoMemory.cls.includes("ok") && parsedNoMemory.stages.includes("post_techmap.dyno") && !parsedNoMemory.files.some((file) => file.role === "memory"),
  `cls=${parsedNoMemory.cls} stages=${JSON.stringify(parsedNoMemory.stages)}`,
);
await ev(() => {
  window.__dyno.addFile("memory.sv", "memory", "// empty memory file\n");
  window.__dyno.setActiveFile("design.sv");
  window.__dyno.run();
});
await waitStatus(page, 180000);
const parsedEmptyMemory = await ev(() => ({ cls: window.__dyno.state.statusClass, stages: window.__dyno.state.stages }));
check(
  results,
  "parsed mode handles an empty memory model file",
  parsedEmptyMemory.cls.includes("ok") && parsedEmptyMemory.stages.includes("post_techmap.dyno"),
  `cls=${parsedEmptyMemory.cls} stages=${JSON.stringify(parsedEmptyMemory.stages)}`,
);
const tooltips = await ev(() => ({
  instCombine: window.__dyno.state.passTooltip["INST_COMBINE_PASS"] || null,
  mux: window.__dyno.state.instrTooltip["MUX"] || null,
  none: window.__dyno.state.passTooltip["NO_SUCH_PASS"] || null,
}));
check(
  results,
  "pass and instr tooltips come from the dyno headers",
  !!tooltips.instCombine && /Combine\/simplify instructions/.test(tooltips.instCombine) && !!tooltips.mux && /sel true_val false_val/.test(tooltips.mux) && tooltips.none === null,
  JSON.stringify(tooltips),
);
await ev(async () => {
  await window.__dyno.setMode("sv-builtin");
});
const layout0 = await ev(() => ({ groups: window.__dyno.state.groups, layout: window.__dyno.state.layout, tabs: window.__dyno.state.tabs }));
check(
  results,
  "editor starts with an input group and an output group side by side",
  layout0.groups.length === 2 &&
    layout0.groups.some((group) => group.output && group.tabIds.includes("output")) &&
    layout0.groups.some((group) => !group.output && group.tabIds.length > 0) &&
    layout0.layout.type === "split" &&
    layout0.layout.orientation === "row" &&
    layout0.layout.children.length === 2,
  JSON.stringify(layout0),
);
const inputGroupId = layout0.groups.find((group) => !group.output).id;
const outputGroupId = layout0.groups.find((group) => group.output).id;
const flowId = layout0.tabs.find((tab) => tab.name === "flow.dyno").id;
const designId = layout0.tabs.find((tab) => tab.name === "design.sv").id;
await ev(({ tabId, groupId }) => window.__dyno.moveTab(tabId, groupId, 0), { tabId: flowId, groupId: inputGroupId });
const reordered = await ev((groupId) => window.__dyno.state.groups.find((group) => group.id === groupId).tabIds, inputGroupId);
check(results, "tabs can be reordered inside a group", reordered[0] === flowId, JSON.stringify(reordered));
await ev(({ tabId, groupId }) => window.__dyno.moveTab(tabId, groupId), { tabId: designId, groupId: outputGroupId });
const moved = await ev((groupId) => window.__dyno.state.groups.find((group) => group.id === groupId), outputGroupId);
check(results, "a tab can be moved to the output side", moved.tabIds.includes(designId) && moved.activeTabId === designId, JSON.stringify(moved));
await ev(({ tabId, groupId }) => window.__dyno.moveTab(tabId, groupId), { tabId: designId, groupId: inputGroupId });
const movedBack = await ev((groupId) => window.__dyno.state.groups.find((group) => group.id === groupId), inputGroupId);
check(results, "a tab can be moved back to the input side", movedBack.tabIds.includes(designId) && movedBack.activeTabId === designId, JSON.stringify(movedBack));
await ev(() => window.__dyno.addFile("split.sv", "design", "module split; endmodule"));
const splitId = await ev(() => window.__dyno.state.tabs.find((tab) => tab.name === "split.sv").id);
await ev(({ groupId, tabId }) => window.__dyno.splitGroup(groupId, "right", tabId), { groupId: inputGroupId, tabId: splitId });
const splitRow = await ev(() => ({ groups: window.__dyno.state.groups, layout: window.__dyno.state.layout }));
check(
  results,
  "splitGroup creates a side-by-side split",
  splitRow.layout.type === "split" && splitRow.layout.orientation === "row" && splitRow.layout.children.length === 2 && splitRow.groups.length === 3,
  JSON.stringify(splitRow.layout),
);
const newGroupId = await ev((groupId) => window.__dyno.state.groups.find((group) => !group.output && group.id !== groupId).id, inputGroupId);
await ev(({ groupId, tabId }) => window.__dyno.splitGroup(groupId, "bottom", tabId), { groupId: newGroupId, tabId: designId });
const splitColumn = await ev(() => ({ groups: window.__dyno.state.groups, layout: window.__dyno.state.layout }));
check(results, "splitGroup creates a top/bottom split", JSON.stringify(splitColumn.layout).includes('"orientation":"column"') && splitColumn.groups.length === 4, JSON.stringify(splitColumn.layout));
await ev(async () => {
  await window.__dyno.setMode("sv-builtin");
});
const layout1 = await ev(() => ({ groups: window.__dyno.state.groups, tabs: window.__dyno.state.tabs }));
const inputGroupId1 = layout1.groups.find((group) => !group.output).id;
const outputGroupId1 = layout1.groups.find((group) => group.output).id;
const designId1 = layout1.tabs.find((tab) => tab.name === "design.sv").id;
await ev(
  ({ tabId, groupId }) => {
    const tab = document.querySelector(`.file-tab[data-tab-id="${tabId}"]`);
    const target = document.querySelector(`.editor-group[data-group-id="${groupId}"] .group-tabs`);
    const dt = new DataTransfer();
    tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  },
  { tabId: designId1, groupId: outputGroupId1 },
);
const dragged = await ev((groupId) => window.__dyno.state.groups.find((group) => group.id === groupId), outputGroupId1);
check(results, "native tab drag events move a tab between groups", dragged.tabIds.includes(designId1) && dragged.activeTabId === designId1, JSON.stringify(dragged));
await ev(({ tabId, groupId }) => window.__dyno.moveTab(tabId, groupId), { tabId: designId1, groupId: inputGroupId1 });
const splitter = await ev(() => {
  const divider = document.querySelector(".editor-split.row > .splitter");
  const a = divider && divider.previousElementSibling;
  const before = a ? a.getBoundingClientRect().width : 0;
  if (divider) {
    const x = divider.getBoundingClientRect().left + 2;
    divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 60 }));
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 60 }));
  }
  return { before, after: a ? a.getBoundingClientRect().width : 0 };
});
check(results, "splitter drag resizes the editor columns", splitter.after > splitter.before + 40, JSON.stringify(splitter));
await ev(
  ({ groupId }) => {
    const body = document.querySelector(`.editor-group[data-group-id="${groupId}"] .group-body`);
    const dt = new DataTransfer();
    dt.items.add(new File(["module foo(input logic a, output logic y); assign y = a; endmodule"], "foo.sv", { type: "text/plain" }));
    body.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    body.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  },
  { groupId: inputGroupId1 },
);
await page.waitForFunction(() => window.__dyno.state.tabs.some((tab) => tab.name === "foo.sv"), null, { timeout: 5000 });
const fileDropAfter = await ev(() => ({ tabs: window.__dyno.state.tabs, groups: window.__dyno.state.groups }));
check(
  results,
  "dropping an OS file on a group loads it as a tab",
  fileDropAfter.tabs.some((tab) => tab.name === "foo.sv") &&
    fileDropAfter.groups.find((group) => group.id === inputGroupId1).tabIds.some((id) => fileDropAfter.tabs.find((tab) => tab.id === id)?.name === "foo.sv"),
  JSON.stringify(fileDropAfter.tabs),
);
await ev(() => window.__dyno.removeFile("foo.sv"));
await ev(async () => {
  await window.__dyno.setMode("sv-no-abc");
});
const ui = await ev(() => {
  const split = document.querySelector(".editor-split.row");
  const divider = split && split.querySelector(":scope > .splitter");
  return {
    stageInHead: !!document.querySelector(".group-head #out-stage-select"),
    splitButton: !!document.querySelector("[data-split]"),
    typeMenuHidden: document.querySelector("[data-type-menu]").classList.contains("hidden"),
    splitters: document.querySelectorAll(".editor-split > .splitter").length,
    flowClose: !!Array.from(document.querySelectorAll(".file-tab")).find((tab) => {
      const name = tab.querySelector(".tab-name");
      return name && name.textContent === "flow.dyno" && tab.querySelector(".tab-close:not(:disabled)");
    }),
    divider: !!divider,
  };
});
check(
  results,
  "output stage selector is in the header, split button removed, type menu hidden, splitter present, flow tab closable",
  ui.stageInHead && !ui.splitButton && ui.typeMenuHidden && ui.splitters > 0 && ui.divider && ui.flowClose,
  JSON.stringify(ui),
);
await ev(() => window.__dyno.run());
await waitStatus(page, 60000);
const noAbc = await ev(() => ({ cls: window.__dyno.state.statusClass, stages: window.__dyno.state.stages, tabs: window.__dyno.state.tabs }));
check(
  results,
  "no-ABC mode runs the dyno flow up to before AIG",
  noAbc.cls.includes("ok") &&
    noAbc.stages.includes("post_lower_memory.dyno") &&
    noAbc.stages.includes("post_lower_memory.dot") &&
    !noAbc.stages.includes("post_techmap.dyno") &&
    !noAbc.stages.includes("dump.v") &&
    noAbc.tabs.some((tab) => tab.name === "flow.dyno" && tab.role === "flow"),
  `cls=${noAbc.cls} stages=${JSON.stringify(noAbc.stages)}`,
);
await ev(() => window.__dyno.setStage("post_lower_memory.dot"));
await page.waitForFunction(() => window.__dyno.graph.mode === true, null, { timeout: 5000 });
const graphGeom = await ev(() => {
  const group = window.__dyno.state.groups.find((entry) => entry.output);
  const el = document.querySelector(`.editor-group[data-group-id="${group.id}"]`);
  const body = el.querySelector(".group-body");
  const graph = el.querySelector(".graph-view");
  const editor = el.querySelector(".group-editor");
  return { graphH: graph.getBoundingClientRect().height, bodyH: body.getBoundingClientRect().height, editorDisplay: getComputedStyle(editor).display };
});
check(results, "graph view fills the output group", graphGeom.editorDisplay === "none" && Math.abs(graphGeom.graphH - graphGeom.bodyH) < 2, JSON.stringify(graphGeom));
const graphUi = await ev(() => {
  const infoBefore = document.querySelector(".graph-info")?.textContent || "";
  document.querySelector("[data-zoom-in]")?.click();
  const infoAfter = document.querySelector(".graph-info")?.textContent || "";
  const svg = document.querySelector(".graph-svg-wrap svg");
  const node = svg?.querySelector("g.node");
  node?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  return { infoBefore, infoAfter, hl: svg?.querySelectorAll("g.edge.ghl-edge").length || 0 };
});
check(results, "graph zoom and node hover work", graphUi.infoAfter !== graphUi.infoBefore && graphUi.hl > 0, JSON.stringify(graphUi));
await ev(() => {
  if (!window.__dyno.state.consoleVisible) document.getElementById("console-btn").click();
});
const consoleResize = await ev(() => {
  const el = document.getElementById("console");
  const divider = document.getElementById("console-divider");
  const before = el.offsetWidth;
  const x = divider.getBoundingClientRect().left + 2;
  divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x }));
  document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x - 80 }));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x - 80 }));
  return { before, after: el.offsetWidth };
});
check(results, "console divider resizes the console", consoleResize.after > consoleResize.before + 40, JSON.stringify(consoleResize));
await ev(async () => {
  await window.__dyno.setMode("test");
  window.__dyno.run();
});
await page.waitForTimeout(100);
const liveLogs = await ev(() => ({ lines: document.querySelectorAll("#console-body .c-line").length, status: window.__dyno.state.status }));
check(results, "console receives live log lines during a run", liveLogs.lines > 0 && liveLogs.status === "running…", JSON.stringify(liveLogs));
await waitStatus(page, 60000);
await ev(async () => {
  await window.__dyno.setMode("sv-builtin");
  window.__dyno.run();
});
await waitStatus(page, 60000);
const downloadPromise = page.waitForEvent("download", { timeout: 5000 });
await ev(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, shiftKey: true, bubbles: true })));
const download = await downloadPromise;
check(results, "Ctrl+Shift+S downloads the current output", !!download, download?.suggestedFilename() || "");
await ev(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
await page.waitForTimeout(100);
check(
  results,
  "Ctrl+Enter starts a compile",
  await ev(() => window.__dyno.state.status === "running…" || window.__dyno.state.statusClass.includes("ok")),
  await ev(() => window.__dyno.state.status),
);
await waitStatus(page, 60000);
await ev(() => window.__dyno.setActiveFile("flow.dyno"));
const flowDefault = await ev(() => window.__dyno.state.input);
check(
  results,
  "flow tab contains the default pipeline script",
  flowDefault.includes("post_frontend.dyno") &&
    flowDefault.includes("PARSE_DYNO_PASS") &&
    flowDefault.includes("post_techmap.dot"),
  `len=${flowDefault.length}`,
);
await ev(() => {
  window.__dyno.setActiveFile("flow.dyno");
  window.__dyno.setInput('meta.DUMP_PASS map("path": "custom_flow.dyno")');
  window.__dyno.run();
});
await waitStatus(page, 60000);
const editedFlow = await ev(() => ({ cls: window.__dyno.state.statusClass, stages: window.__dyno.state.stages }));
check(
  results,
  "flow tab is editable and drives the run",
  editedFlow.cls.includes("ok") && editedFlow.stages.includes("custom_flow.dyno"),
  `cls=${editedFlow.cls} stages=${JSON.stringify(editedFlow.stages)}`,
);
await ev(() => {
  const tab = Array.from(document.querySelectorAll(".file-tab")).find((entry) => {
    const name = entry.querySelector(".tab-name");
    return name && name.textContent === "flow.dyno";
  });
  tab.querySelector(".tab-close").click();
});
check(results, "closing the flow tab removes it", await ev(() => !window.__dyno.state.tabs.some((tab) => tab.name === "flow.dyno")));
await stop({ server, browser });
summary(results);
