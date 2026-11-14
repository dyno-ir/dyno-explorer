// Read the stage files back from the wasm module's exported MEMFS. dyno_run
// runs the pipeline and writes the stage files (any DUMP_PASS /
// DUMP_VERILOG_PASS / DUMP_DOT_PASS outputs) to the MEMFS root; they're read
// via Module.FS (exposed by -sEXPORTED_RUNTIME_METHODS=FS). Only root-level
// *.dyno / *.v / *.dot are stages — inputs live under /input, preloaded files
// under /tools/.
export function readStages(wasm) {
  const FS = wasm.FS;
  const names = FS.readdir("/")
    .filter((n) => n !== "." && n !== ".." && /\.(dyno|v|dot)$/.test(n))
    .sort();
  return names.map((name) => ({
    name,
    text: FS.readFile("/" + name, { encoding: "utf8" }),
  }));
}
