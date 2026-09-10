// Regenerate explorer/src/presets.js from flow/flow.dyno. The preset runners
// (which flow_* functions each stage calls) are static; only FLOW_DYNO (the flow
// library snapshot) is refreshed.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const flowPath = join(root, "flow", "flow.dyno");
const outPath = join(here, "..", "src", "presets.js");

const flow = readFileSync(flowPath, "utf8");
// Escape for embedding in a template literal: backslash, backtick, and "${"
// (flow.dyno's abcCmd uses ${liberty-path}, substituted by ABC.h at runtime).
const escapedFlow = flow
  .replace(/\\/g, "\\\\")
  .replace(/\$/g, "\\$")
  .replace(/`/g, "\\`");

// Static preset definitions (runners call the exported flow_* functions).
const presets = [
  { key: "frontend", label: "frontend",
    runner: 'CALL symbol("flow_frontend")' },
  { key: "post_early_canon", label: "post_early_canon",
    runner: 'CALL symbol("flow_earlyCanonFlow")' },
  { key: "post_canon", label: "post_canon",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")' },
  { key: "post_early_opt", label: "post_early_opt",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")\nCALL symbol("flow_synthEarlyOpt")' },
  { key: "post_lower_cfg", label: "post_lower_cfg",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")\nCALL symbol("flow_synthEarlyOpt")\nCALL symbol("flow_synthLowerControlFlow")' },
  { key: "post_memory_mux", label: "post_memory_mux",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")\nCALL symbol("flow_synthEarlyOpt")\nCALL symbol("flow_synthLowerControlFlow")\nCALL symbol("flow_synthMemoryFFMuxHandling")' },
  { key: "post_lower_memory", label: "post_lower_memory",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")\nCALL symbol("flow_synthEarlyOpt")\nCALL symbol("flow_synthLowerControlFlow")\nCALL symbol("flow_synthMemoryFFMuxHandling")\nCALL symbol("flow_synthLowerMemoryFF")' },
  { key: "post_techmap", label: "post_techmap",
    runner: 'CALL symbol("flow_earlyCanonFlow")\nCALL symbol("flow_synthCanonicalize")\nCALL symbol("flow_synthEarlyOpt")\nCALL symbol("flow_synthLowerControlFlow")\nCALL symbol("flow_synthMemoryFFMuxHandling")\nCALL symbol("flow_synthLowerMemoryFF")\nCALL symbol("flow_synthTechmap")\nDUMP_VERILOG_PASS map("fileName": "dump.v")' },
];

const out =
  "// Generated presets. FLOW_DYNO is the contents of flow/flow.dyno.\n" +
  "// Regenerate with: node scripts/gen-presets.mjs\n" +
  "export const FLOW_DYNO = `" + escapedFlow + "`;\n\n" +
  "export const PRESETS = " + JSON.stringify(presets, null, 2) + ";\n";

writeFileSync(outPath, out);
console.log("wrote", outPath, "(" + flow.length + " chars of flow)");
