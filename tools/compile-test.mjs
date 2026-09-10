// Node smoke test for dyno_compile: runs the full flow.dyno pipeline (incl.
// the in-process ABC/techmap stage) over a counter design and checks the
// techmap stage is produced.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readStages } from './wasm-fs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = process.argv[2] || join(root, 'wasm-sv');

const { default: init } = await import(join(outDir, 'dyno-sv-wasm.js'));
const wasm = await init({ locateFile: (p) => join(outDir, p) });

const flow = readFileSync(join(root, 'flow', 'flow.dyno'), 'utf8');
const runner = '\nCALL symbol("flow_completeFlow")\n'; // full flow, ends at techmap
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

wasm.ccall('dyno_compile', 'void',
          ['string', 'string', 'string', 'string'],
          [flow + runner, input, 'sv', '']);
const stages = readStages(wasm); // stage files are read back from the exported MEMFS
const stageNames = stages.map((s) => s.name);
console.log('stages:', JSON.stringify(stageNames, null, 1));
const outDyno = stages.find((s) => s.name === 'out.dyno');
console.log('out.dyno IR bytes:', outDyno ? outDyno.text.length : 0);
const tech = stageNames.find((n) => n.endsWith('post_techmap.dyno'));
if (!tech) {
  console.error('FAIL: post_techmap.dyno stage missing (ABC/techmap did not run)');
  process.exit(1);
}
console.log('OK: post_techmap.dyno present -> ABC (in-process) ran');
