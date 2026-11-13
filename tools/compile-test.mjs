// Node smoke test for dyno_run: runs the full flow.dyno pipeline (incl. the
// in-process ABC/techmap stage) over a counter design and checks the techmap
// stage is produced. Files are written into the wasm MEMFS and passed as a
// normal dyno-sv command line.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readStages } from './wasm-fs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = process.argv[2] || join(root, 'wasm-sv');

const { default: init } = await import(join(outDir, 'dyno-sv-wasm.js'));
const wasm = await init({ locateFile: (p) => join(outDir, p) });

const flow = readFileSync(join(root, 'dyno', 'tools', 'dyno-opt', 'dyno-ir', 'flow.dyno'), 'utf8');
const runner = `
CALL symbol("flow_completeFlow_generic")
meta.PARSE_DYNO_PASS map("path": "/tools/dyno-opt/dyno-ir/sky130_fd_sc_hd.dyno", "newModulesActive": "0")
meta.PARSE_DYNO_PASS map("path": "/tools/dyno-opt/dyno-ir/example_memories.dyno", "newModulesActive": "0")
meta.POPULATE_INLINE_CACHES_PASS
CALL symbol("flow_completeFlow_tgt_specific")
`;
const input = `
module Test#(parameter N = 8)
(
  input logic clk,
  input logic rst,
  input logic IN_en,
  output logic[N-1:0] OUT_cnt
);
logic[N-1:0] cnt;
always_ff@(posedge clk)
  if (rst) cnt <= 0;
  else if (IN_en) cnt <= cnt + 1;
  else if (cnt == 42) cnt <= 0;
assign OUT_cnt = cnt;
endmodule
`;

try { wasm.FS.stat('/input'); } catch { wasm.FS.mkdir('/input'); }
wasm.FS.writeFile('/input/flow.dyno', flow + runner);
wasm.FS.writeFile('/input/design.sv', input);
wasm.ccall('dyno_run', 'void', ['string'], [
  'synth -s /input/flow.dyno -l /sky130_fd_sc_hd__tt_025C_1v80.lib /input/design.sv',
]);
const stages = readStages(wasm);
const stageNames = stages.map((s) => s.name);
console.log('stages:', JSON.stringify(stageNames, null, 1));
const tech = stages.find((s) => s.name === 'post_techmap.dyno');
if (!tech) {
  console.error('FAIL: post_techmap.dyno stage missing (ABC/techmap did not run)');
  process.exit(1);
}
console.log('post_techmap.dyno IR bytes:', tech.text.length);
console.log('OK: post_techmap.dyno present -> ABC (in-process) ran');
