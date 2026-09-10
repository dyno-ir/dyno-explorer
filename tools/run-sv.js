// Node test runner for the dyno-sv wasm build. Loads
// wasm-sv/dyno-sv-wasm.{js,wasm,data} (built by `make wasm`) and runs the full
// tools/dyno-test/dyno-ir/test.dyno (incl. slang PARSE_VERILOG_PASS and
// memory-synthesis tests) inside the wasm module.
// Usage: node tools/run-sv.js [outputDir]
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = process.argv[2] || join(root, 'wasm-sv');

// dyno_run is void and prints to stdout; capture it via the module's `print`
// callback (stderr would go to `printErr`).
const outLines = [];
const { default: init } = await import(join(outDir, 'dyno-sv-wasm.js'));
const wasm = await init({
  locateFile: (p) => join(outDir, p),
  print: (line) => outLines.push(line),
});

const flow = readFileSync(join(root, 'flow', 'flow.dyno'), 'utf8');
const test = readFileSync(
  join(root, 'dyno', 'tools', 'dyno-test', 'dyno-ir', 'test.dyno'), 'utf8');

wasm.ccall('dyno_run', 'void', ['string', 'string', 'string'], [flow, test, '']);
const lines = outLines;
const passed = lines.filter((l) => /^passed/.test(l)).length;
const failed = lines.filter((l) => /^failed/.test(l)).length;
console.log(`PASSED: ${passed}  FAILED: ${failed}`);
if (failed) {
  console.log(lines.filter((l) => /^failed|FATAL/i.test(l)).join('\n'));
  process.exit(1);
}
