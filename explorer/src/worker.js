// Web worker that runs the dyno-sv wasm module in isolation, so a long-running
// or hanging compile never freezes the UI and a hard crash (assert / memory
// fault / abort) can be contained by terminating and respawning the worker.
//
// Protocol (main -> worker): { id, cmd: "compile"|"test", flow, input, kind }
// Worker -> main: { id, ok, result?, stdout, stderr, lines, ... } where `result`
// is the compile JSON or test-results string, and stdout/stderr/lines carry the
// terminal output captured at the JS level (both C stdio and C++ iostream funnel
// through fd 1/2, so slang + dyno diagnostics the C++ harness never sees).

let wasmPromise = null;

// Sink for the wasm's print/printErr callbacks, reset per run. `lines` keeps
// interleaved emission order so the console shows stdout/stderr as one stream.
let capture = null;

let currentId = null; // id of the in-flight message (tags incremental log lines)

// The worker is bundled to dist/worker.js; the wasm module is copied to
// dist/wasm/ by the build, so it is self-contained next to this worker.
const wasmDir = new URL("./wasm/", self.location.href).href;

// Serialize message handling: `onmessage` is async and `getWasm()` awaits, so a
// burst of messages would otherwise let a second handler start while the first
// is still initializing, clobbering the shared currentId/capture. Chaining onto
// this promise ensures one run executes at a time.
let queue = Promise.resolve();

// ---- wasm source-map decoding (crash backtrace line numbers) --------------
// The build emits dyno-sv-wasm.wasm.map (-gline-tables-only -gsource-map): a
// source-map v3 file whose segments map wasm bytecode offsets to {source, line}.
// A trap stack reports `wasm-function[N]:0xOFFSET`, so decoding the index lets
// us turn each frame's offset into file:line.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
let wasmMap = null; // { index: [{offset, src, line}], sources: [] } or null

// Decode one comma-separated VLQ segment into its (signed) integer fields.
function decodeSeg(seg) {
  const out = [];
  let i = 0;
  while (i < seg.length) {
    let v = 0, s = 0;
    while (true) {
      const d = B64.indexOf(seg[i]);
      if (d < 0) return null; // malformed
      i++;
      v |= (d & 31) << s;
      if (d & 32) s += 5; else break;
    }
    out.push((v & 1 ? -1 : 1) * (v >> 1));
  }
  return out;
}

// Fetch + decode the wasm source map into a sorted offset -> {source,line}
// index. Best-effort: on failure wasmMap stays null and frames show no lines.
async function loadSourceMap() {
  try {
    const res = await fetch(wasmDir + "dyno-sv-wasm.wasm.map");
    if (!res.ok) throw new Error("map fetch " + res.status);
    const map = await res.json();
    const index = [];
    let genCol = 0, src = 0, sLine = 0;
    for (const line of map.mappings.split(";")) {
      for (const seg of line.split(",")) {
        if (!seg) continue;
        const d = decodeSeg(seg);
        if (!d) continue;
        genCol += d[0]; // byte offset always advances
        // Only segments carrying a source location become resolution points.
        if (d.length >= 4) {
          src += d[1];
          sLine += d[2];
          index.push({ offset: genCol, src, line: sLine });
        }
      }
    }
    index.sort((a, b) => a.offset - b.offset);
    wasmMap = { index, sources: map.sources };
  } catch (e) {
    wasmMap = null;
  }
}

// Binary-search the index for the last entry with offset <= `off`.
function resolveOffset(off) {
  if (!wasmMap || !wasmMap.index.length) return null;
  const { index, sources } = wasmMap;
  let lo = 0, hi = index.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].offset <= off) { ans = index[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (!ans) return null;
  // Source paths are absolute build-dir paths that don't exist in the browser,
  // so show just the base name + 1-based line.
  const base = (sources[ans.src] || "").split("/").pop();
  return base ? base + ":" + (ans.line + 1) : null;
}

// Rewrite each wasm frame of a trap stack to append its resolved [file:line].
function resolveBacktrace(stack) {
  if (!stack || !wasmMap) return "";
  const out = [];
  for (const line of String(stack).split("\n")) {
    const l = line.trim();
    if (!l || !/\S+\.wasm(\s|:|$)/.test(l) || !/wasm-function\[\d+\]/.test(l))
      continue;
    const m = l.match(/wasm-function\[\d+\]:0x([0-9a-fA-F]+)/);
    let loc = "";
    if (m) {
      const r = resolveOffset(parseInt(m[1], 16));
      if (r) loc = "   [" + r + "]";
    }
    // Drop the `module@http://...wasm:` (Firefox) / `at fn (http://...wasm:`
    // (V8) URL noise but keep the demangled C++ name + wasm frame token.
    const wtok = (l.match(/wasm-function\[\d+\]:0x[0-9a-fA-F]+/) || [""])[0];
    let fn = l.split("@")[0];                        // Firefox: fn@url:frame
    const v8 = l.match(/^at\s+(\S+)\s+\(/);          // V8: at fn (url:frame)
    if (v8) fn = v8[1];
    fn = fn.replace(/^dyno-sv-wasm\.wasm\./, "");
    out.push((fn && fn !== wtok ? fn + "  " : "") + wtok + loc);
  }
  return out.join("\n");
}

// Forward one line of dyno output to the main thread immediately (the main
// thread still receives messages while the worker is blocked in the synchronous
// wasm call), and keep it in the per-run capture so the final state is complete.
function emitLog(stream, line) {
  const text = String(line);
  if (capture) {
    if (stream === "stdout") capture.stdout.push(line);
    else capture.stderr.push(line);
    capture.lines.push({ stream, text });
  }
  if (currentId)
    self.postMessage({ id: currentId, type: "log", stream, text });
}

async function initWasm() {
  const { default: init } = await import(wasmDir + "dyno-sv-wasm.js");
  // print/printErr are wired by the runtime to fd 1 / fd 2, so they capture
  // everything written to stdout/stderr (std::cout, std::cerr, slang, etc.).
  const wasm = await init({
    locateFile: (p) => wasmDir + p,
    print: (line) => emitLog("stdout", line),
    printErr: (line) => emitLog("stderr", line),
  });
  // Decode the source map once per worker so a crash can resolve file:line.
  await loadSourceMap();
  // Report map status so the page can confirm backtrace lines are available.
  self.postMessage({
    type: "mapReady",
    loaded: !!wasmMap,
    entries: wasmMap ? wasmMap.index.length : 0,
  });
  return wasm;
}

function takeCapture() {
  const out = capture ? {
    stdout: capture.stdout.join("\n"),
    stderr: capture.stderr.join("\n"),
    lines: capture.lines,
  } : { stdout: "", stderr: "", lines: [] };
  capture = null;
  return out;
}

function beginCapture() { capture = { stdout: [], stderr: [], lines: [] }; }

function getWasm() {
  if (wasmPromise === null) {
    wasmPromise = initWasm().catch((e) => {
      wasmPromise = null;
      throw e;
    });
  }
  return wasmPromise;
}

// ---- MEMFS stage-file access ------------------------------------------------
// The module exposes its virtual FS via Module.FS; dyno_compile runs the pipeline
// and writes the stage files (out.dyno + DUMP_PASS outputs) to the FS root. We
// read them back here instead of having C++ JSON-escape every stage, and clean
// them up front because MEMFS persists across runs. Only root-level
// *.dyno / *.v / *.dot are stages (preloaded files live under /tools/).
function stageNames(FS) {
  return FS.readdir("/").filter(
    (n) => n !== "." && n !== ".." && /\.(dyno|v|dot)$/.test(n)
  );
}
function cleanStageFiles(FS) {
  for (const name of stageNames(FS)) FS.unlink("/" + name);
}
function readStageFiles(FS) {
  const stages = stageNames(FS)
    .sort()
    .map((name) => ({
      name,
      text: FS.readFile("/" + name, { encoding: "utf8" }),
    }));
  return JSON.stringify({ stages });
}

// Returns true for errors that indicate the wasm module is dead (hard crash).
function isHardCrash(msg) {
  return /abort|Aborted|RuntimeError|out of bounds|memory access|unreachable|stack overflow/i.test(
    msg
  );
}

self.onmessage = (e) => {
  // Queue each message so runs are handled strictly one at a time.
  queue = queue.then(() => runMessage(e.data)).catch((err) => {
    // runMessage catches internally; this is a safety net only.
    self.postMessage({ id: (e.data && e.data.id) || "unknown", ok: false, error: String((err && err.message) || err), crashed: true, stdout: "", stderr: "", lines: [] });
    wasmPromise = null;
  });
};

async function runMessage(data) {
  const { id, cmd, flow, input, kind, extraArgs } = data;
  currentId = id;
  try {
    const wasm = await getWasm();
    beginCapture();
    // Both C entry points are void: output goes to stdout/stderr (captured
    // above) and compile reads its stage files back from MEMFS.
    let result = "";
    if (cmd === "test") {
      wasm.ccall("dyno_run", "void", ["string", "string", "string"], [
        flow,
        input,
        extraArgs || "",
      ]);
    } else {
      cleanStageFiles(wasm.FS); // MEMFS persists across runs
      wasm.ccall(
        "dyno_compile",
        "void",
        ["string", "string", "string", "string"],
        [flow, input, kind || "sv", extraArgs || ""]
      );
      result = readStageFiles(wasm.FS);
    }
    const cap = takeCapture();
    currentId = null;
    self.postMessage({ id, ok: true, result, stdout: cap.stdout, stderr: cap.stderr, lines: cap.lines });
  } catch (err) {
    const msg = String((err && err.message) || err);
    const crashed = isHardCrash(msg);
    const cap = takeCapture();
    currentId = null;
    // A trap's stack carries the demangled C++ call chain; resolve each frame's
    // offset against the source map for [file:line].
    const stack = (err && err.stack) ? String(err.stack) : "";
    const bt = resolveBacktrace(stack);
    self.postMessage({ id, ok: false, error: msg, crashed, stack, bt, stdout: cap.stdout, stderr: cap.stderr, lines: cap.lines });
    // The instance may be corrupted after a hard crash; reset so the next run
    // gets a fresh one. On a hard crash, close so the main thread respawns us.
    wasmPromise = null;
    if (crashed) self.close();
  }
}
