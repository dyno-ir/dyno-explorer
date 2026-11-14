// Verify the sky130 liberty file is usable by the in-process ABC engine in
// wasm: run a techmap whose abcCmd does `read_lib` of the preloaded liberty
// (standard-cell mapping) instead of bare LUT mapping.
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
module Test(input logic clk, input logic rst, output logic[3:0] o);
logic[3:0] c;
always_ff@(posedge clk) if (rst) c <= 0; else c <= c + 1;
assign o = c;
endmodule
`;

try { wasm.FS.stat('/input'); } catch { wasm.FS.mkdir('/input'); }
wasm.FS.writeFile('/input/flow.dyno', flow + runner);
wasm.FS.writeFile('/input/design.sv', input);
wasm.ccall('dyno_run', 'void', ['string'], [
  'synth -s /input/flow.dyno -l /sky130_fd_sc_hd__tt_025C_1v80.lib /input/design.sv',
]);
const stages = readStages(wasm);
console.log('stages:', JSON.stringify(stages.map((s) => s.name)));

const tech = stages.find((s) => s.name.endsWith('post_techmap.dyno'));
if (!tech) { console.error('FAIL: techmap stage missing'); process.exit(1); }
if (/sky130_fd_sc_hd__/.test(tech.text) || /\.gate /.test(tech.text)) {
  console.log('OK: ABC read the sky130 liberty (stdcell mapping present)');
} else {
  console.log('techmap text sample:', tech.text.slice(0, 600));
  console.warn('WARN: no stdcell/.gate markers found; liberty may not have been used');
}
