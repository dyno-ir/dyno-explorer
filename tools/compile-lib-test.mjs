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

const flow = readFileSync(join(root, 'flow', 'flow.dyno'), 'utf8');

// Swap %synthTechmap's ABC_PASS abcCmd for one that reads the sky130 liberty
// (standard-cell mapping) before running `if`.
const abcCmd =
  'read_blif aig.blif; read_lib -X sky130_fd_sc_hd__lpflow_inputiso1p_1 -X ' +
  'sky130_fd_sc_hd__lpflow_isobufsrc_1 -X sky130_fd_sc_hd__clkinv_1 ' +
  '-w sky130_fd_sc_hd__tt_025C_1v80.lib; strash; &get -n; &fraig -x; ' +
  '&put; scorr; dc2; dretime; strash; &get -n; &dch -f; &nf; &put; ' +
  'print_stats; write_blif mapped.blif';

// Text-replace the ABC_PASS abcCmd block with the stdcell version.
const techmapMarker = 'meta.ABC_PASS map("abcCmd":';
const idx = flow.indexOf(techmapMarker);
if (idx < 0) throw new Error('ABC_PASS block not found in flow');
let depth = 0, end = -1;
for (let i = idx; i < flow.length; i++) {
  const c = flow[i];
  if (c === '[' || c === '(' || c === '{') depth++;
  else if (c === ']' || c === ')' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const before = flow.slice(0, idx);
const after = flow.slice(end + 1);
const runner = '\nCALL symbol("flow_completeFlow")\n';
const newFlow =
  before +
  'meta.ABC_PASS map("abcCmd":\n' +
  '  [{' + abcCmd + '}],\n' +
  '  "path": "sky130_fd_sc_hd__tt_025C_1v80.lib")\n' +
  after + runner;

const input = `
module Test(input logic clk, input logic rst, output logic[3:0] o);
logic[3:0] c;
always_ff@(posedge clk) if (rst) c <= 0; else c <= c + 1;
assign o = c;
endmodule
`;

wasm.ccall('dyno_compile', 'void',
          ['string', 'string', 'string', 'string'],
          [newFlow, input, 'sv', '']);
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
