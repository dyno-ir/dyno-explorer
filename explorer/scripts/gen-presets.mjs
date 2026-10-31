import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "src", "presets.js");

const stagePresets = [
  {
    key: "post_early_canon",
    label: "post_early_canon",
    calls: ["flow_earlyCanonFlow"],
    dump: "post_early_canon.dyno",
  },
  {
    key: "post_canon",
    label: "post_canon",
    calls: ["flow_earlyCanonFlow", "flow_synthCanonicalize"],
    dump: "post_canon.dyno",
  },
  {
    key: "post_early_opt",
    label: "post_early_opt",
    calls: ["flow_earlyCanonFlow", "flow_synthCanonicalize", "flow_synthEarlyOpt"],
    dump: "post_early_opt.dyno",
  },
  {
    key: "post_lower_cfg",
    label: "post_lower_cfg",
    calls: [
      "flow_earlyCanonFlow",
      "flow_synthCanonicalize",
      "flow_synthEarlyOpt",
      "flow_synthLowerControlFlow",
    ],
    dump: "post_lower_cfg.dyno",
  },
  {
    key: "post_memory_mux",
    label: "post_memory_mux",
    calls: [
      "flow_earlyCanonFlow",
      "flow_synthCanonicalize",
      "flow_synthEarlyOpt",
      "flow_synthLowerControlFlow",
      "flow_synthMemoryFFMuxHandling",
    ],
    dump: "post_memory_mux.dyno",
  },
  {
    key: "post_lower_memory",
    label: "post_lower_memory",
    calls: [
      "flow_earlyCanonFlow",
      "flow_synthCanonicalize",
      "flow_synthEarlyOpt",
      "flow_synthLowerControlFlow",
      "flow_synthMemoryFFMuxHandling",
      "flow_synthLowerMemoryFF",
    ],
    dump: "post_lower_memory.dyno",
  },
  {
    key: "post_techmap",
    label: "post_techmap",
    calls: [
      "flow_earlyCanonFlow",
      "flow_synthCanonicalize",
      "flow_synthEarlyOpt",
      "flow_synthLowerControlFlow",
      "flow_synthMemoryFFMuxHandling",
      "flow_synthLowerMemoryFF",
      "flow_synthTechmap",
    ],
    dump: "post_techmap.dyno",
    extra: [
      'DUMP_DOT_PASS map("path": "post_techmap.dot")',
      'DUMP_VERILOG_PASS map("fileName": "dump.v")',
    ],
  },
];

const presets = [
  // SV input is already parsed by the harness.
  {
    key: "frontend",
    label: "frontend",
    runner: 'DUMP_PASS map("path": "post_frontend.dyno")',
  },
  ...stagePresets.map((p) => {
    const runner = [
      ...p.calls.map((name) => `CALL symbol("${name}")`),
      `DUMP_PASS map("path": "${p.dump}")`,
      ...(p.extra || []),
    ].join("\n");
    return { key: p.key, label: p.label, runner };
  }),
];

const out =
  "// Generated preset runners.\n" +
  "// Regenerate with: node scripts/gen-presets.mjs\n" +
  "export const PRESETS = " + JSON.stringify(presets, null, 2) + ";\n";

writeFileSync(outPath, out);
console.log("wrote", outPath);
