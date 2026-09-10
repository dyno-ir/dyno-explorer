// Read the stage files back from the wasm module's exported MEMFS. dyno_compile
// runs the pipeline and writes the stage files (out.dyno + any DUMP_PASS /
// DUMP_VERILOG_PASS / DUMP_DOT_PASS outputs) to the MEMFS root; they're read
// via Module.FS (exposed by -sEXPORTED_RUNTIME_METHODS=FS). Only root-level
// *.dyno / *.v / *.dot are stages — preloaded stdcell files live under /tools/.
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
