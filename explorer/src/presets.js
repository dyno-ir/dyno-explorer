// Generated preset runners.
// Regenerate with: node scripts/gen-presets.mjs
export const PRESETS = [
  {
    "key": "frontend",
    "label": "frontend",
    "runner": "DUMP_PASS map(\"path\": \"post_frontend.dyno\")"
  },
  {
    "key": "post_early_canon",
    "label": "post_early_canon",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nDUMP_PASS map(\"path\": \"post_early_canon.dyno\")"
  },
  {
    "key": "post_canon",
    "label": "post_canon",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nDUMP_PASS map(\"path\": \"post_canon.dyno\")"
  },
  {
    "key": "post_early_opt",
    "label": "post_early_opt",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nCALL symbol(\"flow_synthEarlyOpt\")\nDUMP_PASS map(\"path\": \"post_early_opt.dyno\")"
  },
  {
    "key": "post_lower_cfg",
    "label": "post_lower_cfg",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nCALL symbol(\"flow_synthEarlyOpt\")\nCALL symbol(\"flow_synthLowerControlFlow\")\nDUMP_PASS map(\"path\": \"post_lower_cfg.dyno\")"
  },
  {
    "key": "post_memory_mux",
    "label": "post_memory_mux",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nCALL symbol(\"flow_synthEarlyOpt\")\nCALL symbol(\"flow_synthLowerControlFlow\")\nCALL symbol(\"flow_synthMemoryFFMuxHandling\")\nDUMP_PASS map(\"path\": \"post_memory_mux.dyno\")"
  },
  {
    "key": "post_lower_memory",
    "label": "post_lower_memory",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nCALL symbol(\"flow_synthEarlyOpt\")\nCALL symbol(\"flow_synthLowerControlFlow\")\nCALL symbol(\"flow_synthMemoryFFMuxHandling\")\nCALL symbol(\"flow_synthLowerMemoryFF\")\nDUMP_PASS map(\"path\": \"post_lower_memory.dyno\")"
  },
  {
    "key": "post_techmap",
    "label": "post_techmap",
    "runner": "CALL symbol(\"flow_earlyCanonFlow\")\nCALL symbol(\"flow_synthCanonicalize\")\nCALL symbol(\"flow_synthEarlyOpt\")\nCALL symbol(\"flow_synthLowerControlFlow\")\nCALL symbol(\"flow_synthMemoryFFMuxHandling\")\nCALL symbol(\"flow_synthLowerMemoryFF\")\nCALL symbol(\"flow_synthTechmap\")\nDUMP_PASS map(\"path\": \"post_techmap.dyno\")\nDUMP_DOT_PASS map(\"path\": \"post_techmap.dot\")\nDUMP_VERILOG_PASS map(\"fileName\": \"dump.v\")"
  }
];
