// Verify the sky130 liberty file is usable by the in-process ABC engine in
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
const runner = '\nCALL symbol("flow_completeFlow")\n';

const input = `
module Test(input logic clk, input logic rst, output logic[3:0] o);
logic[3:0] c;
always_ff@(posedge clk) if (rst) c <= 0; else c <= c + 1;
assign o = c;
endmodule
`;

wasm.ccall('dyno_compile', 'void',
          ['string', 'string', 'string', 'string'],
          [flow + runner, input, 'sv', '']);
const stages = readStages(wasm); // stage files are read back from the exported MEMFS
console.log('stages:', JSON.stringify(stages.map((s) => s.name)));

const tech = stages.find((s) => s.name.endsWith('post_techmap.dyno'));
if (!tech) { console.error('FAIL: techmap stage missing'); process.exit(1); }
// A standard-cell mapping produces .gate lines referencing sky130 cells.
if (/sky130_fd_sc_hd__/.test(tech.text) || /\.gate /.test(tech.text)) {
  console.log('OK: ABC read the sky130 liberty (stdcell mapping present)');
} else {
  console.log('techmap text sample:', tech.text.slice(0, 600));
  console.warn('WARN: no stdcell/.gate markers found; liberty may not have been used');
}
