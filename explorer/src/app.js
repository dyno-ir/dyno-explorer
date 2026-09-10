import * as monaco from "monaco-editor";
import { FLOW_DYNO, PRESETS } from "./presets.js";
import { renderDotGraph } from "./graph.js";
import { PASS_DESCRIPTIONS, INSTR_DESCRIPTIONS } from "./tooltips.js";
import "./styles.css";

// ---- Monaco workers (basic editing only; no language-service workers needed) --
self.MonacoEnvironment = {
  getWorker: () => new Worker("editor.worker.js"),
};

// ---- dyno-IR Monarch language ---------------------------------------------
monaco.languages.register({ id: "dynoir" });
// Case-based regexes mirror dyno-syntax-highlight's tmLanguage.json, so new
// instruction/type names are colored without editing this table.
monaco.languages.setMonarchTokensProvider("dynoir", {
  defaultToken: "",
  symbols: /[=><!~?:&|+\-*/^%#]+/,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/\[\{/, "string", "@svString"],            // [{"code":[{ ... }]} -> embedded SV block as a multiline string
      [/[{}()[\]]/, "@brackets"],
      [/%[a-zA-Z0-9_.]+\b/, "identifier"],      // %reg / %type values
      [/\b[A-Z_][A-Z0-9_]*\b/, "keyword"],      // instructions & storage types
      [/\b[a-z_][a-z0-9_]*\b/, "type"],         // block/register/wire/... (like vscode's entity.name.namespace)
      [/(\d+)?'[sS]?[wdhobWDHOB][xXzZ0-9a-fA-F_]*/, "number"],
      [/\d+/, "number"],
      [/"/, "string", "@string"],
      [/\$/, "operator"],
    ],
    comment: [[/\/\*/, "comment", "@push"], [/\*\//, "comment", "@pop"], [/[^*/]+/, "comment"], [/[*/]/, "comment"]],
    string: [[/[^\\"]+/, "string"], [/"/, "string", "@pop"]],
    // Embedded SV block: up to the closing "}]" is one multiline string literal
    // so the body isn't re-tokenized as dyno-IR.
    svString: [
      [/\}\]/, "string", "@pop"],
      [/[\s\S]/, "string"],
    ],
  },
});

// Hover tooltips for pass / instruction names in dyno-IR text.
monaco.languages.registerHoverProvider("dynoir", {
  provideHover(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const desc = PASS_DESCRIPTIONS[word.word] || INSTR_DESCRIPTIONS[word.word];
    if (!desc) return null;
    return {
      range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
      contents: [{ value: desc }],
    };
  },
});

// ---- Verilog language (basic) ---------------------------------------------
monaco.languages.register({ id: "verilog" });
monaco.languages.setMonarchTokensProvider("verilog", {
  defaultToken: "",
  keywords: [
    "module", "endmodule", "input", "output", "inout", "wire", "reg", "logic",
    "assign", "always", "always_ff", "always_comb", "begin", "end", "if",
    "else", "case", "endcase", "posedge", "negedge", "parameter", "localparam",
    "integer", "genvar", "generate", "endgenerate", "initial", "function",
    "endfunction", "task", "endtask", "typedef", "enum", "struct", "union",
    "packed", "signed", "unsigned", "import", "package", "endpackage",
    "for", "while", "return", "break", "continue", "default",
  ],
  typeKeywords: ["logic", "bit", "byte", "int", "integer", "shortint", "longint", "real", "wire", "reg", "tri"],
  number: /[\d_]+[xXzZ]?|'[sS]?[01xXzZ]+|'[sS]?[hH][0-9a-fA-F_]+|'[sS]?[dD][0-9_]+|'[sS]?[oO][0-7_]+|'[sS]?[bB][01xXzZ_]+/,
  symbols: /[=><!~?:&|+\-*/^%#]+/,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/`[a-zA-Z_$][\w$]*/, "predefined"],
      [/[a-zA-Z_$][\w$]*/, {
        cases: { "@keywords": "keyword", "@typeKeywords": "type", "@default": "identifier" },
      }],
      [/(\d+)?'[sS]?[wdhobWDHOB][0-9a-fA-FxXzZ_]*/, "number"],
      [/\d+/, "number"],
      [/"/, "string", "@string"],
      [/\$[a-zA-Z_$][\w$]*/, "keyword"],
    ],
    comment: [[/\/\*/, "comment", "@push"], [/\*\//, "comment", "@pop"], [/[^*/]+/, "comment"], [/[*/]/, "comment"]],
    string: [[/[^"\\]/, "string"], [/\\./, "string.escape"], [/"/, "string", "@pop"]],
  },
});

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const modeSelect = $("mode-select");
const pipelineSelect = $("pipeline-select");
const outStageSelect = $("out-stage-select");
const runBtn = $("run-btn");
const downloadBtn = $("download-btn");
const statusEl = $("status");
const errorbar = $("errorbar");
const inputTitle = $("input-title");
const consoleBtn = $("console-btn");
const consoleEl = $("console");
const consoleBody = $("console-body");
const consoleClose = $("console-close");
const extraArgsInput = $("extra-args");
const graphView = $("graph-view");
const graphInfo = $("graph-info");
const graphScroll = $("graph-scroll");
const graphSvgWrap = $("graph-svg-wrap");
const graphZoomInBtn = $("graph-zoom-in");
const graphZoomOutBtn = $("graph-zoom-out");
const graphZoomFitBtn = $("graph-zoom-fit");
const graphZoom1Btn = $("graph-zoom-1");

// ---- Sample inputs / default script --------------------------------------
const SAMPLE_SV = `module counter (
  input logic clk,
  input logic rst,
  output logic[7:0] count
);
  always_ff@(posedge clk) begin
    if (rst)
      count <= 8'd0;
    else
      count <= count + 1;
  end
endmodule
`;

const SAMPLE_IR = `MODULE_DEF :module("mod"), :block {
  INPUT_REGISTER_DEF %in_a:register(1)
  OUTPUT_REGISTER_DEF %out_a:register(8)
  COMB_PROCESS_DEF :process, :block {
    LOAD %a:wire(1), %in_a
    NOT %n:wire(1), %a
    ZEXT %z:wire(8), %n
    STORE %z, %out_a
  }
}
`;

const SAMPLE_TEST = `// dyno-sv test code. Run with the "dyno-sv test" mode.
// Mirrors tools/dyno-test/dyno-ir/test.dyno syntax.
TEST_SCRIPT :string("invert"), :block {
  PARSE_VERILOG_PASS map("code":[{
    module inv(input logic a, output logic y);
      assign y = ~a;
    endmodule
  }])
  meta.INST_COMBINE_PASS
  meta.ASSERT_EXISTS_PASS map("regex": "NOT")
}
`;

// The whole flow is shown (editable) and run via flow_completeFlow.
const DEFAULT_SCRIPT =
  "// Custom dyno pass pipeline. The full flow is shown below; edit it, or " +
  "CALL a flow_* function.\n" +
  FLOW_DYNO +
  "\n\n// Run the complete flow:\nCALL symbol(\"flow_completeFlow\")\n";

// ---- Editors --------------------------------------------------------------
const inputEditor = monaco.editor.create($("input-editor"), {
  value: SAMPLE_SV,
  language: "verilog",
  theme: "vs-dark",
  minimap: { enabled: false },
  automaticLayout: true,
  fontSize: 13,
});
const scriptEditor = monaco.editor.create($("script-editor"), {
  value: DEFAULT_SCRIPT,
  language: "dynoir",
  theme: "vs-dark",
  minimap: { enabled: false },
  automaticLayout: true,
  fontSize: 13,
});
const outputEditor = monaco.editor.create($("output-editor"), {
  value: "",
  language: "dynoir",
  theme: "vs-dark",
  readOnly: true,
  minimap: { enabled: false },
  automaticLayout: true,
  fontSize: 13,
});

// Ctrl+D duplicates the current line (overrides Monaco's default binding).
monaco.editor.addKeybindingRule({
  keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD,
  command: "editor.action.duplicateSelection",
});

// ---- Pipeline presets -----------------------------------------------------
const PIPELINES = [
  ...PRESETS.map((p) => ({ key: p.key, label: p.label, runner: p.runner })),
  { key: "custom", label: "Custom script", runner: null },
];

function populateSelects() {
  pipelineSelect.innerHTML = "";
  for (const p of PIPELINES) {
    const opt = document.createElement("option");
    opt.value = p.key;
    opt.textContent = p.label;
    pipelineSelect.appendChild(opt);
  }
  pipelineSelect.value = "post_canon";
}
populateSelects();

// ---- Worker management -----------------------------------------------------
let worker = null;
let runSeq = 0;
let inFlight = false;   // a compile/test run is currently executing
let activeTimeout = null;
let currentOnMessage = null; // per-run handler; the dispatcher routes mapReady around it
let wasmMapStats = null;      // { loaded, entries } from the worker's source-map decode

function spawnWorker() {
  worker = new Worker("worker.js", { type: "module" });
  worker.onerror = (e) => {
    statusEl.textContent = "worker error";
    statusEl.className = "status err";
  };
  worker.onmessage = (e) => {
    if (e.data && e.data.type === "mapReady") {
      wasmMapStats = e.data;
      return;
    }
    if (currentOnMessage) currentOnMessage(e);
  };
}

function killWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

const COMPILE_TIMEOUT_MS = 60000;

function settleRun() {
  inFlight = false;
  runBtn.disabled = false;
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
}

function runCompile() {
  // Serialize runs: extra clicks are ignored until the current run settles.
  if (inFlight) {
    statusEl.textContent = "busy…";
    statusEl.className = "status";
    return;
  }
  inFlight = true;
  runBtn.disabled = true;

  const seq = ++runSeq;
  const mode = modeSelect.value;
  const pipelineKey = pipelineSelect.value;

  const input = inputEditor.getValue();
  const flow = buildFlow(mode, pipelineKey);

  statusEl.textContent = "running…";
  statusEl.className = "status";
  errorbar.style.display = "none";
  errorbar.textContent = "";
  clearInputMarkers(); // stale squiggles no longer line up (also cleared on edit)
  clearConsole();


  if (!worker) spawnWorker();

  const id = "run" + seq;
  const t0 = performance.now();
  let settled = false;

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    settleRun();
    killWorker();
    statusEl.textContent = "timed out";
    statusEl.className = "status err";
    showError("Compilation timed out (>" + COMPILE_TIMEOUT_MS / 1000 + "s).\n" +
      "The wasm module was terminated. It may be stuck on this input — try a smaller design or an earlier pipeline stage.");
  }, COMPILE_TIMEOUT_MS);
  activeTimeout = timeout;

  const onMessage = (e) => {
    if (e.data.id !== id) return;
    // Incremental console line streamed live during the (blocking) wasm call.
    if (e.data.type === "log") {
      appendConsoleLine(e.data.stream, e.data.text);
      consoleBtn.classList.toggle("has-output", e.data.stream === "stdout");
      consoleBtn.classList.toggle("has-error", e.data.stream === "stderr");
      return;
    }
    if (settled) return;
    settled = true;
    settleRun();
    currentOnMessage = null;
    const elapsed = Math.round(performance.now() - t0);
    if (e.data.ok) {
      statusEl.textContent = elapsed + " ms";
      statusEl.className = "status ok";
      handleResult(mode, e.data.result, e.data);
    } else {
      statusEl.textContent = "error";
      statusEl.className = "status err";
      // `bt` is the worker-resolved backtrace (wasm offsets -> [file:line]);
      // fall back to the raw stack when the source map wasn't available.
      const bt = e.data.bt || extractBacktrace(e.data.stack);
      showError(formatError(e.data.error, mode, elapsed, bt));
      // Surface captured stderr (the real diagnostics) + red squiggles.
      setConsoleState(e.data.stdout, e.data.stderr, e.data.lines);
      lastDiags = parseDiagnostics(e.data.stderr);
      applyInputDiagnostics();
      if (e.data.crashed) { // worker already closed; spawn fresh for next run
        worker = null;
        statusEl.textContent = "crashed";
        statusEl.className = "status err";
      }
    }
  };
  currentOnMessage = onMessage;

  worker.postMessage({
    id,
    cmd: mode === "test" ? "test" : "compile",
    flow,
    input,
    kind: mode,
    extraArgs: extraArgsInput.value,
  });
}

function buildFlow(mode, pipelineKey) {
  if (mode === "test") return FLOW_DYNO; // test block drives execution
  // Custom script contains the flow itself (prefilled with the whole flow).
  if (pipelineKey === "custom") return scriptEditor.getValue();
  const preset = PRESETS.find((p) => p.key === pipelineKey);
  return FLOW_DYNO + "\n" + preset.runner;
}

// ---- Result handling -------------------------------------------------------
let lastCompile = null; // { stages:[{name,text}] }
let userPickedStage = false; // true once the user manually changes the stage select

function handleResult(mode, jsonStr, msg) {
  const jsStdout = (msg && msg.stdout) || "";
  const jsStderr = (msg && msg.stderr) || "";
  if (mode === "test") {
    // Test output isn't IR, so it goes to the console (the C++ side prints it
    // to stdout like the native dyno-sv driver); the output editor stays empty.
    lastCompile = null;
    outStageSelect.innerHTML = "";
    monaco.editor.setModelLanguage(outputEditor.getModel(), "plaintext");
    outputEditor.setValue("");
    renderLocs();
    setConsoleState(jsStdout, jsStderr, msg.lines, true);
    lastDiags = parseDiagnostics(jsStderr);
    applyInputDiagnostics();
    const output = jsStdout + jsStderr;
    if (/FATAL ERROR|TESTS FAILED/i.test(output) && !/ALL TESTS PASSED/i.test(output)) {
      showError("Tests failed.");
    }
    return;
  }
  monaco.editor.setModelLanguage(outputEditor.getModel(), "dynoir");
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    outputEditor.setValue(jsonStr);
    showError("dyno returned a non-JSON result (likely a crash).");
    setConsoleState(jsStdout, jsStderr, msg.lines);
    lastDiags = parseDiagnostics(jsStderr);
    applyInputDiagnostics();
    return;
  }
  lastCompile = data;
  // Terminal output (stdout + stderr) is captured entirely at the JS level by
  // the worker's print/printErr callbacks (fd 1/2) and streamed live; the JSON
  // carries only {stages, final}. A fatal error aborts the module and surfaces
  // via the worker's crash path, not via the JSON.
  // A clean post_techmap run always emits a lot of ABC/liberty chatter on
  // stdout. Don't auto-open the console for that noise unless the user asked
  // for debug output via extra args (errors still auto-open via the error path).
  const quietConsole =
    pipelineSelect.value === "post_techmap" && extraArgsInput.value.trim() === "";
  setConsoleState(jsStdout, jsStderr, msg.lines, !quietConsole);
  lastDiags = parseDiagnostics(lastConsole.stderr);
  applyInputDiagnostics();
  // Populate output-stage selector. Selecting a .dot stage shows the graph.
  const stages = data.stages || [];
  const prevStage = outStageSelect.value;
  outStageSelect.innerHTML = "";
  for (const s of stages) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name.endsWith(".v")
      ? "Verilog netlist (" + s.name + ")"
      : s.name.endsWith(".dot")
        ? "Instr graph (" + s.name + ")"
        : s.name;
    outStageSelect.appendChild(opt);
  }
  // Default to out.dyno, else the dyno-instr graph (.dot), else the Verilog
  // netlist (.v).
  const stageNames = stages.map((s) => s.name);
  const defaultStage =
    (stageNames.includes("out.dyno") ? "out.dyno" : undefined) ||
    stageNames.find((n) => n.endsWith(".dot")) ||
    stageNames.find((n) => n.endsWith(".v")) ||
    stageNames[0];
  if (userPickedStage && stageNames.includes(prevStage)) {
    outStageSelect.value = prevStage;
  } else {
    outStageSelect.value = defaultStage;
    userPickedStage = false;
  }
  updateOutputView();
}

function currentOutputText() {
  const st = (lastCompile && lastCompile.stages || []).find((s) => s.name === outStageSelect.value);
  return st ? st.text : "";
}

// A .v stage is a Verilog netlist (from DUMP_VERILOG_PASS) and a .dot stage is
// a graphviz graph (from DUMP_DOT_PASS) rather than dyno-IR. Pick the right
// Monaco language so it syntax-highlights (and disables the dyno-IR source-loc
// linking, which doesn't apply to netlist / dot output).
function currentStageLanguage() {
  const v = outStageSelect.value;
  if (v && v.endsWith(".v")) return "verilog";
  if (v && v.endsWith(".dot")) return "plaintext";
  return "dynoir";
}

function updateOutputView() {
  const lang = currentStageLanguage();
  monaco.editor.setModelLanguage(outputEditor.getModel(), lang);
  outputEditor.setValue(currentOutputText());
  renderLocs();
  if (isGraphStage()) {
    setGraphViewVisible(true);
    updateGraphView();
  } else {
    setGraphViewVisible(false);
  }
}

// ---- Graph view (dyno-instr .dot -> Graphviz) ------------------------------
// A `.dot` stage is a dyno-instr graph, rendered in-browser via @viz-js/viz;
// IR stages keep the Monaco editor. The SVG is wrapped in a box that gets a
// `translate(...) scale(...)` transform; pan/zoom just update it.
let graphMode = false; // graph view is shown (over the Monaco editor)
let graphZoom = 1;
let graphTx = 0;
let graphTy = 0;
let graphSvgW = 0;
let graphSvgH = 0;
let graphSeq = 0; // guards against stale async renders
let dragging = false;
let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };

function isGraphStage() {
  return outStageSelect.value && outStageSelect.value.endsWith(".dot");
}

function setGraphViewVisible(show) {
  graphMode = show;
  // Hide the whole editor wrapper, not just the inner Monaco node.
  $("output-editor").style.display = show ? "none" : "";
  graphView.style.display = show ? "flex" : "none";
}

function escapeHtmlGraph(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function applyGraphTransform() {
  const svg = graphSvgWrap.querySelector("svg");
  if (!svg) return;
  graphSvgWrap.style.transform =
    `translate(${graphTx}px, ${graphTy}px) scale(${graphZoom})`;
  graphInfo.textContent = graphInfo.textContent
    .replace(/\s+\d+%$/, "") + " " + Math.round(graphZoom * 100) + "%";
}

// Zoom about a viewport point (cx, cy), keeping that point stationary.
function zoomAbout(factor, cx, cy) {
  const newZoom = Math.min(20, Math.max(0.02, graphZoom * factor));
  const f = newZoom / graphZoom;
  graphZoom = newZoom;
  graphTx = cx - (cx - graphTx) * f;
  graphTy = cy - (cy - graphTy) * f;
  applyGraphTransform();
}

function graphCenter() {
  const r = graphScroll.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

async function updateGraphView() {
  if (!isGraphStage()) return;
  const seq = ++graphSeq;
  const text = currentOutputText();
  graphInfo.textContent = "rendering…";
  const res = await renderDotGraph(text);
  if (!isGraphStage() || seq !== graphSeq) return; // stage changed / re-rendered while awaiting
  if (res.ok) {
    graphSvgWrap.innerHTML = res.svg;
    const svg = graphSvgWrap.querySelector("svg");
    const vb = svg && svg.viewBox ? svg.viewBox.baseVal : null;
    graphSvgW = (svg && parseFloat(svg.getAttribute("width"))) || (vb ? vb.width : 0);
    graphSvgH = (svg && parseFloat(svg.getAttribute("height"))) || (vb ? vb.height : 0);
    graphZoom = 1;
    graphTx = 0;
    graphTy = 0;
    graphSvgWrap.style.transform = "";
    graphInfo.textContent =
      res.module + " · " + res.nodes + " nodes · " + (res.edges ?? 0) + " edges";
    graphFitZoom();
    attachGraphHover();
  } else {
    graphSvgWrap.innerHTML = '<div class="graph-msg">' + escapeHtmlGraph(res.message) + "</div>";
    graphInfo.textContent = res.message;
  }
}

function graphFitZoom() {
  if (!graphSvgW || !graphSvgH) return;
  const availW = Math.max(40, graphScroll.clientWidth - 32);
  const availH = Math.max(40, graphScroll.clientHeight - 32);
  const z = Math.min(availW / graphSvgW, availH / graphSvgH, 1);
  graphZoom = Math.max(0.02, z || 1);
  graphTx = (graphScroll.clientWidth - graphSvgW * graphZoom) / 2;
  graphTy = (graphScroll.clientHeight - graphSvgH * graphZoom) / 2;
  applyGraphTransform();
}

graphScroll.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("a")) return;
  dragging = true;
  dragStart = { x: e.clientX, y: e.clientY, tx: graphTx, ty: graphTy };
  graphScroll.setPointerCapture(e.pointerId);
  graphScroll.style.cursor = "grabbing";
  e.preventDefault();
});
graphScroll.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  graphTx = dragStart.tx + (e.clientX - dragStart.x);
  graphTy = dragStart.ty + (e.clientY - dragStart.y);
  applyGraphTransform();
});
const endGraphDrag = () => {
  if (!dragging) return;
  dragging = false;
  graphScroll.style.cursor = "grab";
};
graphScroll.addEventListener("pointerup", endGraphDrag);
graphScroll.addEventListener("pointercancel", endGraphDrag);

graphScroll.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = graphScroll.getBoundingClientRect();
  zoomAbout(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

graphZoomInBtn.addEventListener("click", () => {
  const [cx, cy] = graphCenter();
  const r = graphScroll.getBoundingClientRect();
  zoomAbout(1.25, cx - r.left, cy - r.top);
});
graphZoomOutBtn.addEventListener("click", () => {
  const [cx, cy] = graphCenter();
  const r = graphScroll.getBoundingClientRect();
  zoomAbout(1 / 1.25, cx - r.left, cy - r.top);
});
graphZoom1Btn.addEventListener("click", () => {
  graphZoom = 1;
  graphTx = (graphScroll.clientWidth - graphSvgW) / 2;
  graphTy = (graphScroll.clientHeight - graphSvgH) / 2;
  applyGraphTransform();
});
graphZoomFitBtn.addEventListener("click", graphFitZoom);

// Highlight an SVG node's connections on hover. The graphviz SVG has one
// <g class="node"> per node (title = node id) and one <g class="edge"> per
// edge (title = "from->to"). Hovering a node highlights its incident edges;
// hovering an edge highlights just that edge. Nothing is dimmed.
function attachGraphHover() {
  const svg = graphSvgWrap.querySelector("svg");
  if (!svg || svg.dataset.ghl) return;
  svg.dataset.ghl = "1";
  const nodeGs = [...svg.querySelectorAll("g.node")];
  const edgeGs = [...svg.querySelectorAll("g.edge")];
  if (!nodeGs.length || !edgeGs.length) return;
  const byNode = new Map(); // node id -> incident edge groups
  const add = (id, g) => {
    const arr = byNode.get(id) || [];
    arr.push(g);
    byNode.set(id, arr);
  };
  for (const g of edgeGs) {
    const t = (g.querySelector("title") || {}).textContent || "";
    const [a, b] = t.split("->");
    if (!a || !b) continue;
    add(a.split(":")[0].trim(), g);
    add(b.split(":")[0].trim(), g);
    // widen the hover hit area with a transparent copy of the edge path
    const p = g.querySelector("path");
    if (p) {
      const hit = p.cloneNode(true);
      hit.removeAttribute("marker-end");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "14");
      hit.setAttribute("fill", "none");
      g.appendChild(hit);
    }
  }
  for (const g of nodeGs) {
    const id = ((g.querySelector("title") || {}).textContent || "").trim();
    const conn = byNode.get(id) || [];
    g.addEventListener("mouseenter", () => conn.forEach((e) => e.classList.add("ghl-edge")));
    g.addEventListener("mouseleave", () => conn.forEach((e) => e.classList.remove("ghl-edge")));
  }
  for (const g of edgeGs) {
    g.addEventListener("mouseenter", () => g.classList.add("ghl-edge"));
    g.addEventListener("mouseleave", () => g.classList.remove("ghl-edge"));
  }
}

// ---- Source-loc linking ----------------------------------------------------
// Each IR instruction carries source-loc markers like ["config.code:8:7-20"]
// (single line) or ["config.code:7.5-10.26"] (multi-line). We parse the output
// into instructions (excluding nested blocks) so hovering a marker highlights
// the instruction and its source lines in the input, and vice versa.

let locRanges = [];    // {start,end,beginLine,beginCol,endLine,endCol,line,instr} marker spans
let locGroups = [];    // {start,end} whole "["..."]" groups (incl. brackets/commas)
let instrs = [];        // {name,startLine,endLine,isBlock,locs,segments}
let innermostByLine = []; // 0-based line -> innermost instr covering it (forward hover)
let outputLocDecos = [];
let outputHlDecos = [];
let inputHlDecos = [];
let showLocs = false;   // render the ["..."] markers (hidden by default)

function extractLocsFromLine(line) {
  const locs = [];
  // multiline: "file:line.col-eline.ecol" (endCol is one-past exclusive)
  let re = /"([^":]+):(\d+)\.(\d+)-(\d+)\.(\d+)"/g;
  let m;
  while ((m = re.exec(line)))
    locs.push({ beginLine: +m[2], beginCol: +m[3], endLine: +m[4], endCol: +m[5] });
  // single: "file:line:col-col"
  re = /"([^":]+):(\d+):(\d+)-(\d+)"/g;
  while ((m = re.exec(line)))
    locs.push({ beginLine: +m[2], beginCol: +m[3], endLine: +m[2], endCol: +m[4] });
  // single no-end: "file:line:col"
  re = /"([^":]+):(\d+):(\d+)"/g;
  while ((m = re.exec(line)))
    locs.push({ beginLine: +m[2], beginCol: +m[3], endLine: +m[2], endCol: +m[3] });
  return locs;
}

function collectLocs(text) {
  const locs = [];
  // multiline: "file:line.col-eline.ecol"
  let re = /"([^":]+):(\d+)\.(\d+)-(\d+)\.(\d+)"/g;
  let m;
  while ((m = re.exec(text))) {
    locs.push({ start: m.index, end: m.index + m[0].length, beginLine: +m[2], beginCol: +m[3], endLine: +m[4], endCol: +m[5] });
  }
  // single: "file:line:col-col"
  re = /"([^":]+):(\d+):(\d+)-(\d+)"/g;
  while ((m = re.exec(text))) {
    locs.push({ start: m.index, end: m.index + m[0].length, beginLine: +m[2], beginCol: +m[3], endLine: +m[2], endCol: +m[4] });
  }
  // single no-end: "file:line:col"
  re = /"([^":]+):(\d+):(\d+)"/g;
  while ((m = re.exec(text))) {
    locs.push({ start: m.index, end: m.index + m[0].length, beginLine: +m[2], beginCol: +m[3], endLine: +m[2], endCol: +m[3] });
  }
  locs.sort((a, b) => a.start - b.start);
  return locs;
}

// Collect whole "[...]" groups (incl. brackets & commas) so they can be hidden
// entirely; hiding just the strings would leave stray "[ , ]".
function collectLocGroups(text) {
  const groups = [];
  let re = /\["[^"]*"(?:\s*,\s*"[^"]*")*\]\s*$/gm;
  let m;
  while ((m = re.exec(text))) groups.push({ start: m.index, end: m.index + m[0].length });
  re = /\[\]/g;
  while ((m = re.exec(text))) groups.push({ start: m.index, end: m.index + 2 });
  return groups;
}

// Parse IR into instructions. Simple instrs occupy one line; block instrs
// (IF/WHILE/defs) span from their header line to their closing brace.
function parseInstrs(text) {
  const lines = text.split("\n");
  const all = [];
  const stack = []; // {name,startLine,depth,isBlock}
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("//")) continue;
    const locs = extractLocsFromLine(t);
    if (t.startsWith("}{")) continue;            // else-block separator
    if (t.startsWith("}")) {                     // close innermost block instr
      const e = stack.pop();
      if (e) { e.endLine = i; e.locs = locs; all.push(e); }
      continue;
    }
    const name = (t.match(/^\S+/) || [""])[0];
    const isBlock = /{\s*$/.test(t);
    if (isBlock) {
      stack.push({ name, startLine: i, depth: stack.length, isBlock: true });
    } else {
      all.push({ name, startLine: i, endLine: i, depth: stack.length, isBlock: false, locs });
    }
  }
  while (stack.length) {                          // close any unclosed blocks
    const e = stack.pop();
    e.endLine = lines.length - 1;
    all.push(e);
  }
  all.sort((a, b) => a.startLine - b.startLine);
  for (const inst of all) {
    inst.segments = inst.isBlock
      ? computeSegments(inst, all)
      : [[inst.startLine, inst.endLine]];
  }
  return all;
}

// Highlight segments for a block instr = its full extent minus nested block
// instrs (avoids overlapping/z-fighting highlights on hover).
function computeSegments(inst, all) {
  const nested = all
    .filter((n) => n.isBlock && n.depth > inst.depth &&
      n.startLine >= inst.startLine && n.endLine <= inst.endLine)
    .sort((a, b) => a.startLine - b.startLine);
  const segs = [];
  let cursor = inst.startLine;
  for (const n of nested) {
    if (n.startLine > cursor) segs.push([cursor, n.startLine - 1]);
    cursor = Math.max(cursor, n.endLine + 1);
  }
  if (cursor <= inst.endLine) segs.push([cursor, inst.endLine]);
  return segs;
}

// Merge multiple segment lists into one set of non-overlapping ranges.
function mergeSegments(segLists) {
  const ranges = [];
  for (const segs of segLists) for (const [s, e] of segs) ranges.push([s, e]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function renderLocs() {
  const model = outputEditor.getModel();
  if (!model) { locRanges = []; locGroups = []; instrs = []; clearOutputHl(); clearInputHl(); return; }
  const text = model.getValue();
  instrs = parseInstrs(text);
  // precompute innermost instr per output line for O(1) forward hover
  innermostByLine = new Array(text.split("\n").length).fill(null);
  for (const inst of instrs) {
    const size = inst.endLine - inst.startLine;
    for (const [s, e] of inst.segments) {
      for (let L = s; L <= e; L++) {
        const cur = innermostByLine[L];
        if (!cur || size < cur.endLine - cur.startLine) innermostByLine[L] = inst;
      }
    }
  }
  locRanges = collectLocs(text);
  locGroups = collectLocGroups(text);
  const byEnd = new Map();
  for (const inst of instrs) byEnd.set(inst.endLine, inst);
  for (const l of locRanges) {
    l.line = model.getPositionAt(l.start).lineNumber;
    l.instr = byEnd.get(l.line);
  }
  outputHlDecos = outputEditor.deltaDecorations(outputHlDecos, []);
  inputHlDecos = inputEditor.deltaDecorations(inputHlDecos, []);
  updateLocDecos();
}

function updateLocDecos() {
  const model = outputEditor.getModel();
  if (!model) return;
  const decos = [];
  if (showLocs) {
    // show: underline each quoted "..." marker
    for (const l of locRanges) {
      const start = model.getPositionAt(l.start);
      const end = model.getPositionAt(l.end);
      decos.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: { inlineClassName: "dyno-loc" },
      });
    }
  } else {
    // hidden (default): collapse the entire "[...]" group
    for (const g of locGroups) {
      const start = model.getPositionAt(g.start);
      const end = model.getPositionAt(g.end);
      decos.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: { inlineClassName: "dyno-loc-hidden" },
      });
    }
  }
  outputLocDecos = outputEditor.deltaDecorations(outputLocDecos, decos);
}

// Convert a [beginLine, endLine, beginCol, endCol] span (1-based, endCol is
// monaco-exclusive) into a Monaco Range for the input editor, clamped to the
// source lines so a degenerate/overrunning loc never throws.
function inputSpanToRange(b, e, bc, ec) {
  const model = inputEditor.getModel();
  const lineCount = model ? model.getLineCount() : 1;
  // clamp lines into the model (a loc can reference lines past the end, e.g.
  // synthetic/old source); monaco's getLineMaxColumn throws out of range.
  const bLine = Math.max(1, Math.min(b | 0, lineCount));
  const eLine = Math.max(bLine, Math.min(e | 0, lineCount));
  const maxBC = model ? model.getLineMaxColumn(bLine) : 1;
  const maxEC = model ? model.getLineMaxColumn(eLine) : 1;
  let bcC = bc && bc > 0 ? Math.min(bc, maxBC) : 1;
  let ecC = ec && ec > 0 ? Math.min(ec, maxEC) : maxEC;
  if (ecC <= bcC) ecC = Math.min(bcC + 1, maxEC + 1);
  return new monaco.Range(bLine, bcC, eLine, ecC);
}

// Ranges are either column spans [beginLine, endLine, beginCol, endCol] or
// plain line spans [beginLine, endLine] (whole-line fallback).
function highlightInputRanges(ranges) {
  const decos = [];
  for (const r of ranges) {
    const [b, e, bc, ec] = r;
    if (bc && ec) {
      decos.push({ range: inputSpanToRange(b, e, bc, ec), options: { className: "dyno-hl" } });
    } else {
      for (let L = b; L <= e; L++) {
        decos.push({ range: new monaco.Range(L, 1, L, 1), options: { isWholeLine: true, className: "dyno-hl" } });
      }
    }
  }
  inputHlDecos = inputEditor.deltaDecorations(inputHlDecos, decos);
}

function clearInputHl() {
  inputHlDecos = inputEditor.deltaDecorations(inputHlDecos, []);
}

function highlightOutputSegments(segs) {
  const decos = segs.map(([s, e]) => ({
    range: new monaco.Range(s + 1, 1, e + 1, 1),
    options: { isWholeLine: true, className: "dyno-out-hl" },
  }));
  outputHlDecos = outputEditor.deltaDecorations(outputHlDecos, decos);
}

function clearOutputHl() {
  outputHlDecos = outputEditor.deltaDecorations(outputHlDecos, []);
}

// column-aware [beginLine,endLine,beginCol,endCol] spans per source loc of an
// instruction (each loc's exact start line/col .. end line/col)
function instrSourceRanges(inst) {
  return (inst.locs || []).map((l) => [
    l.beginLine,
    Math.max(l.beginLine, l.endLine),
    l.beginCol,
    l.endCol,
  ]);
}

// union of [beginLine,endLine] source ranges referenced by an instruction
function instrSourceLines(inst) {
  const ranges = inst.locs
    .map((l) => [l.beginLine, Math.max(l.beginLine, l.endLine)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

// innermost instruction whose highlight segments contain this output line
// (so hovering a nested instr highlights just it, not the whole enclosing block)
function innermostInstrAtLine(line) {
  return line >= 0 && line < innermostByLine.length ? innermostByLine[line] : null;
}

// Does a loc's span cover the character at (line, column)? endCol is
// monaco-exclusive; on intermediate lines of a multi-line loc the whole line
// is covered (the loc has no column info there).
function locCovers(loc, line, column) {
  if (line < loc.beginLine || line > loc.endLine) return false;
  const cs = line === loc.beginLine ? (loc.beginCol || 1) : 1;
  const ce = line === loc.endLine ? (loc.endCol || loc.beginCol || cs) : Number.MAX_SAFE_INTEGER;
  return column >= cs && column < ce;
}

// Character-extent of a loc on the given line, used as the "smallest" metric
// when several locs cover the same character.
function locSpanOnLine(loc, line) {
  const cs = line === loc.beginLine ? (loc.beginCol || 1) : 1;
  const ce = line === loc.endLine ? (loc.endCol || loc.beginCol || cs) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, ce - cs);
}

// Smallest source loc covering the character at (line, column), plus the instrs
// that share it. Column-aware so hovering a specific token picks the instr that
// came from exactly that token, not an arbitrary same-line loc.
function smallestLocAtPosition(line, column) {
  let minSpan = Infinity;
  const hits = [];
  for (const inst of instrs) {
    for (const loc of inst.locs) {
      if (!locCovers(loc, line, column)) continue;
      const span = locSpanOnLine(loc, line);
      hits.push({ inst, loc, span });
      if (span < minSpan) minSpan = span;
    }
  }
  if (!hits.length) return null;
  const best = hits.filter((h) => h.span === minSpan);
  return { loc: best[0].loc, insts: [...new Set(best.map((h) => h.inst))] };
}



// ---- Console panel (combined dyno stdout/stderr, streamed live) ------------
const MAX_LOG_LINES = 10000;
// `lines` interleaves stdout and stderr in emission order (one combined console,
// like a terminal); `stdout`/`stderr` are kept as joined strings for the hooks.
let lastConsole = { stdout: "", stderr: "", lines: [] };
let consoleOpen = false;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Append a line as it streams in from the worker (the wasm call is synchronous,
// so this gives live feedback). Capped at MAX_LOG_LINES.
function appendConsoleLine(stream, text) {
  const div = document.createElement("div");
  div.className = "c-line " + (stream === "stderr" ? "c-stderr" : "c-stdout");
  div.textContent = stream === "stderr" ? stripAnsi(text) : text;
  consoleBody.appendChild(div);
  while (consoleBody.childElementCount > MAX_LOG_LINES)
    consoleBody.removeChild(consoleBody.firstChild);
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

function clearConsole() {
  lastConsole = { stdout: "", stderr: "", lines: [] };
  consoleBody.innerHTML = "";
}

// Fallback: build an ordered line list from separate stdout/stderr strings
// (used when no interleaved capture is available).
function buildLines(stdout, stderr) {
  const lines = [];
  if (stdout)
    lines.push(...stdout.split("\n").map((text) => ({ stream: "stdout", text })));
  if (stderr)
    lines.push(...stderr.split("\n").map((text) => ({ stream: "stderr", text })));
  return lines;
}

// Render the authoritative console state from lastConsole.lines.
function renderConsole() {
  const lines = lastConsole.lines;
  if (!lines.length) {
    consoleBody.innerHTML = '<div class="c-empty">(no output)</div>';
    consoleBody.scrollTop = consoleBody.scrollHeight;
    return;
  }
  const parts = [];
  const start = Math.max(0, lines.length - MAX_LOG_LINES);
  if (start > 0)
    parts.push(
      '<div class="c-trunc">… truncated, keeping last ' +
        MAX_LOG_LINES + " lines</div>"
    );
  for (let i = start; i < lines.length; i++) {
    const { stream, text } = lines[i];
    const cls = stream === "stderr" ? "c-stderr" : "c-stdout";
    const rendered = stream === "stderr" ? escapeHtml(stripAnsi(text)) : escapeHtml(text);
    parts.push('<div class="c-line ' + cls + '">' + rendered + "</div>");
  }
  consoleBody.innerHTML = parts.join("");
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

function setConsoleState(stdout, stderr, lines, autoOpen = true) {
  lastConsole = {
    stdout: stdout || "",
    stderr: stderr || "",
    lines: (lines && lines.length ? lines : buildLines(stdout || "", stderr || "")),
  };
  const hasOut = !!lastConsole.lines.length;
  consoleBtn.classList.toggle("has-output", !!lastConsole.stdout && !lastConsole.stderr);
  consoleBtn.classList.toggle("has-error", !!lastConsole.stderr);
  if (autoOpen && hasOut) openConsole();
  renderConsole();
}

function openConsole() {
  consoleOpen = true;
  consoleEl.style.display = "flex";
  $("console-divider").style.display = "flex";
}
function closeConsole() {
  consoleOpen = false;
  consoleEl.style.display = "none";
  $("console-divider").style.display = "none";
}

// ---- Input diagnostics (red squiggles from stderr) -----------------------
// slang (Verilog) and dyno (IR) print `file:line:col: message` to stderr.
// The frontend maps to "config.code" (SV) / "<input>" (IR), so we accept only
// those; "<flow>" errors are pipeline-script errors and are skipped.
function parseDiagnostics(text) {
  const diags = [];
  const clean = stripAnsi(text);
  const re = /(?:^|\n)\s*([^:\n]+):(\d+):(\d+)(?:-(\d+))?:(?:\s*)([^\n]*)/g;
  let m;
  while ((m = re.exec(clean))) {
    const file = m[1].trim();
    if (file !== "config.code" && file !== "<input>") continue;
    const line = +m[2];
    const colStart = +m[3];
    const colEnd = m[4] ? +m[4] : null;
    const message = m[5].trim();
    if (!line) continue;
    diags.push({ file, line, colStart, colEnd, message });
  }
  return diags;
}

let lastDiags = [];
let lastDiagCount = 0;

// 1-based col -> [startCol,endCol) of the token starting there. Stop at
// whitespace or punctuation that terminates a token, so a squiggle doesn't
// swallow a trailing `)` (e.g. `rst2)` marks just `rst2`).
function tokenExtent(lineText, col) {
  let end = col - 1;
  const stop = /\s|[()\[\]{};,.:]/;
  while (end < lineText.length && !stop.test(lineText[end])) end++;
  return { start: col, end: end + 1 };
}

function applyInputDiagnostics() {
  const model = inputEditor.getModel();
  if (!model) { lastDiagCount = 0; return; }
  const lines = model.getValue().split("\n");
  const markers = [];
  for (const d of lastDiags) {
    if (d.line < 1 || d.line > lines.length) continue;
    const lineText = lines[d.line - 1];
    const range = d.colEnd
      ? { start: d.colStart, end: d.colEnd + 1 }
      : tokenExtent(lineText, d.colStart);
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: d.line,
      startColumn: range.start,
      endLineNumber: d.line,
      endColumn: Math.max(range.end, range.start + 1),
      message: d.message,
    });
  }
  monaco.editor.setModelMarkers(model, "dyno", markers);
  lastDiagCount = markers.length;
}

function clearInputMarkers() {
  const model = inputEditor.getModel();
  if (model) monaco.editor.setModelMarkers(model, "dyno", []);
  lastDiags = [];
  lastDiagCount = 0;
}

// ---- forward: hover/click an instruction -> highlight it + its source lines ----
outputEditor.onMouseDown((e) => {
  const pos = e.target.position;
  if (!pos) return;
  const inst = innermostInstrAtLine(pos.lineNumber - 1);
  if (inst) {
    highlightOutputSegments(inst.segments);
    highlightInputRanges(instrSourceRanges(inst));
  }
});

outputEditor.onMouseMove((e) => {
  const pos = e.target.position;
  if (!pos) { clearOutputHl(); clearInputHl(); return; }
  const inst = innermostInstrAtLine(pos.lineNumber - 1);
  if (inst) {
    highlightOutputSegments(inst.segments);
    highlightInputRanges(instrSourceRanges(inst));
  } else {
    clearOutputHl();
    clearInputHl();
  }
});
outputEditor.onMouseLeave(() => { clearOutputHl(); clearInputHl(); });

// ---- reverse: hover a source line -> highlight the instr that made it ----
inputEditor.onMouseMove((e) => {
  const pos = e.target.position;
  if (!pos) { clearOutputHl(); clearInputHl(); return; }
  const hit = smallestLocAtPosition(pos.lineNumber, pos.column);
  if (hit) {
    highlightOutputSegments(mergeSegments(hit.insts.map((i) => i.segments)));
    highlightInputRanges([[hit.loc.beginLine, Math.max(hit.loc.beginLine, hit.loc.endLine), hit.loc.beginCol, hit.loc.endCol]]);
  } else {
    clearOutputHl();
    clearInputHl();
  }
});
inputEditor.onMouseLeave(() => { clearOutputHl(); clearInputHl(); });

// Pull just the wasm frames out of a trap's JS stack (the C++ call chain, kept
// by --profiling-funcs); JS glue/worker frames are dropped.
function extractBacktrace(stack) {
  if (!stack) return "";
  const frames = String(stack)
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        /\S+\.wasm(\s|:|$)/.test(l) &&
        /wasm-function\[\d+\]/.test(l)
    )
    // Drop the `@http://...wasm:` URL noise but keep the demangled C++
    // function name + wasm frame token (e.g. `interpretPassPipeline  wasm-function[7]:0x90`).
    .map((l) => {
      const wtok = (l.match(/wasm-function\[\d+\]:0x[0-9a-fA-F]+/) || [""])[0];
      let fn = l.split("@")[0];
      const v8 = l.match(/^at\s+(\S+)\s+\(/);
      if (v8) fn = v8[1];
      fn = fn.replace(/^dyno-sv-wasm\.wasm\./, "");
      return (fn && fn !== wtok ? fn + "  " : "") + wtok;
    })
    .filter(Boolean);
  return frames.length ? frames.join("\n") : "";
}

function formatError(raw, mode, elapsed, bt) {
  let msg = raw || "unknown error";
  if (elapsed != null) msg += `\n(terminated after ${elapsed} ms)`;
  // A wasm trap / assertion / memory fault is a crash inside dyno, not a page
  // bug; surface it as such so the user isn't misled into a JS error.
  if (
    mode !== "test" &&
    /assert|Aborted|out of bounds|memory access|unreachable|RuntimeError|trap|stack overflow/i.test(
      msg
    )
  ) {
    msg += "\n\nDyno crashed on this input (internal dyno error).";
    if (bt) {
      msg +=
        "\n\nC++ backtrace (deepest frame first, line numbers via wasm source map):\n" +
        bt;
    }
  }
  return msg;
}

function showError(msg) {
  errorbar.style.display = "block";
  errorbar.innerHTML = '<div class="err-title">Error</div>' +
    msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
}

function setScriptPaneVisible(show) {
  $("script-pane").style.display = show ? "flex" : "none";
  $("split-2").style.display = show ? "" : "none";
}

function setInputMode(mode) {
  if (mode === "sv") {
    inputTitle.textContent = "Input: SystemVerilog";
    inputEditor.setValue(SAMPLE_SV);
    monaco.editor.setModelLanguage(inputEditor.getModel(), "verilog");
    setScriptPaneVisible(false);
  } else if (mode === "ir") {
    inputTitle.textContent = "Input: Dyno-IR";
    inputEditor.setValue(SAMPLE_IR);
    monaco.editor.setModelLanguage(inputEditor.getModel(), "dynoir");
    setScriptPaneVisible(false);
  } else { // test
    inputTitle.textContent = "Input: Dyno-IR test code";
    inputEditor.setValue(SAMPLE_TEST);
    monaco.editor.setModelLanguage(inputEditor.getModel(), "dynoir");
    setScriptPaneVisible(false);
  }
  $("pipeline-field").style.display = mode === "test" ? "none" : "";
}

// ---- Event wiring ---------------------------------------------------------
runBtn.addEventListener("click", runCompile);
downloadBtn.addEventListener("click", () => {
  const blob = new Blob([currentOutputText()], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "dyno-output.dyno";
  a.click();
  URL.revokeObjectURL(a.href);
});
pipelineSelect.addEventListener("change", () => {
  setScriptPaneVisible(pipelineSelect.value === "custom");
});
outStageSelect.addEventListener("change", () => {
  userPickedStage = true;
  updateOutputView();
});
modeSelect.addEventListener("change", () => setInputMode(modeSelect.value));
$("show-locs").addEventListener("change", () => {
  showLocs = $("show-locs").checked;
  updateLocDecos();
});
consoleBtn.addEventListener("click", () => {
  if (consoleOpen) closeConsole(); else openConsole();
});
consoleClose.addEventListener("click", closeConsole);

// ---- resizable columns ---------------------------------------------------
// Drag a `.splitter` to resize the column before it in a flex row; the
// before-column is locked to a pixel width and the rest flex to fill.
function makeSplitter(divider, beforeEl, minWidth) {
  divider.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = beforeEl.offsetWidth;
    const min = minWidth || 140;
    const onMove = (ev) => {
      const w = Math.max(min, startW + (ev.clientX - startX));
      beforeEl.style.flexGrow = "0";
      beforeEl.style.flexShrink = "0";
      beforeEl.style.flexBasis = w + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// Editor columns: input | script | output (script pane hidden unless "Custom").
makeSplitter($("split-1"), $("input-pane"));
makeSplitter($("split-2"), $("script-pane"));

// Console divider: drag left -> wider console, drag right -> narrower.
$("console-divider").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = consoleEl.offsetWidth;
  const onMove = (ev) => {
    const w = Math.max(220, Math.min(startW + (startX - ev.clientX), window.innerWidth - 260));
    consoleEl.style.width = w + "px";
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Editing (or switching mode, which replaces the input) invalidates the
// diagnostics and both directions of the source-linking highlight.
inputEditor.getModel().onDidChangeContent(() => {
  clearInputMarkers();
  clearInputHl();
  clearOutputHl();
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s")) {
    e.preventDefault();
    runCompile();
  }
});

// ---- Test / debug hook ----------------------------------------------------
window.__dyno = {
  get output() { return outputEditor.getValue(); },
  setInput: (t) => inputEditor.setValue(t),
  get input() { return inputEditor.getValue(); },
  setMode: (m) => { modeSelect.value = m; setInputMode(m); },
  setPipeline: (k) => { pipelineSelect.value = k; setScriptPaneVisible(k === "custom"); },
  get script() { return scriptEditor.getValue(); },
  run: () => runCompile(),
  get status() { return statusEl.textContent; },
  get statusClass() { return statusEl.className; },
  get error() { return errorbar.textContent; },
  get errorVisible() { return errorbar.style.display; },
  extractBacktrace: (s) => extractBacktrace(s),
  get wasmMapStats() { return wasmMapStats; }, // worker's source-map decode stats
  get locCount() { return locRanges.length; },
  get outputLanguage() {
    const m = outputEditor.getModel();
    return m ? m.getLanguageId() : "";
  },
  get outputLocDecos() { return outputLocDecos.length; },
  get outputHlDecos() { return outputHlDecos.length; },
  get inputHlDecos() { return inputHlDecos.length; },
  // ---- console / diagnostics hooks ----
  get stdout() { return lastConsole.stdout; },
  get stderr() { return lastConsole.stderr; },
  get consoleVisible() { return consoleOpen; },
  get diagCount() { return lastDiagCount; },
  parseDiagnostics: (t) => parseDiagnostics(t),
  getInputMarkers: () => {
    const model = inputEditor.getModel();
    return model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
  },
  // test hook: feed output text directly and re-parse
  setOutput: (t) => { outputEditor.setValue(t); renderLocs(); },
  // forward: highlight the instruction behind the Nth loc marker (whole instr)
  forwardMarker: (n) => {
    const l = locRanges[n];
    if (!l || !l.instr) return { ok: false };
    highlightOutputSegments(l.instr.segments);
    highlightInputRanges(instrSourceRanges(l.instr));
    return { ok: true, segs: l.instr.segments, src: instrSourceLines(l.instr) };
  },
  // forward by output line (innermost instr under the cursor)
  forwardLine: (line) => {
    const inst = innermostInstrAtLine(line - 1);
    if (!inst) return { ok: false };
    highlightOutputSegments(inst.segments);
    return { ok: true, segs: inst.segments, src: instrSourceLines(inst) };
  },
  // reverse at an exact character (line, column): picks the smallest source loc
  // whose span covers that character, exactly like the hover handler.
  reversePosition: (line, column) => {
    const hit = smallestLocAtPosition(line, column);
    if (!hit) return { ok: false };
    const segs = mergeSegments(hit.insts.map((i) => i.segments));
    highlightOutputSegments(segs);
    highlightInputRanges([[hit.loc.beginLine, Math.max(hit.loc.beginLine, hit.loc.endLine), hit.loc.beginCol, hit.loc.endCol]]);
    return { ok: true, count: hit.insts.length, segs, hl: outputHlDecos.length, loc: hit.loc };
  },
  get instrs() { return instrs.map((i) => ({ name: i.name, startLine: i.startLine, endLine: i.endLine, isBlock: i.isBlock, segs: i.segments })); },
  get locGroups() { return locGroups.map((g) => ({ start: g.start, end: g.end })); },
  // tokenize a dyno-IR snippet (for verifying the Monarch grammar)
  tokenize: (t) => {
    const lines = t.split("\n");
    const out = [];
    monaco.editor.tokenize(t, "dynoir").forEach((line, i) => {
      for (let j = 0; j < line.length; j++) {
        const tok = line[j];
        const end = j + 1 < line.length ? line[j + 1].offset : lines[i].length;
        out.push({ type: tok.type, text: lines[i].slice(tok.offset, end) });
      }
    });
    return out;
  },
  // current loc-decoration ranges (for verifying whole-[...]-group hiding)
  getLocDecoTexts: () => outputLocDecos.map((id) => {
    const r = outputEditor.getModel().getDecorationRange(id);
    return r ? outputEditor.getModel().getValueInRange(r) : null;
  }).filter(Boolean),
  get locs() { return locRanges.map((l) => ({ beginLine: l.beginLine, beginCol: l.beginCol, endLine: l.endLine, endCol: l.endCol })); },
  // current input highlight decoration ranges (column spans, 1-based)
  getInputHlRanges: () => inputHlDecos.map((id) => {
    const r = inputEditor.getModel().getDecorationRange(id);
    return r ? { sl: r.startLineNumber, sc: r.startColumn, el: r.endLineNumber, ec: r.endColumn } : null;
  }).filter(Boolean),
  graph: {
    renderDot: async (text) => renderDotGraph(text),
    get mode() { return graphMode; },
    get graphable() { return isGraphStage(); },
  },
  // tooltip data for passes / instructions (hover descriptions)
  get passTooltip() { return PASS_DESCRIPTIONS; },
  get instrTooltip() { return INSTR_DESCRIPTIONS; },
};

// ---- Boot ----------------------------------------------------------------
spawnWorker();
// Honor the browser-restored mode-select value (a reload can restore "test"
// without firing a change event).
setInputMode(modeSelect.value);
runCompile(); // populate the output
