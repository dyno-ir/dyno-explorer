# Building Dyno for WebAssembly (browser)

Goal: compile Dyno (an HDL compiler/IR tool) to WebAssembly so the test suite
(`tools/dyno-test/dyno-ir/test.dyno`) runs in a browser — compiler-explorer
style "dyno explorer".

**Status: complete.** `dyno-sv test flow.dyno test.dyno` (the build that links
slang) compiles to wasm32 and **all 36 tests pass** under node, including the
slang `PARSE_VERILOG_PASS` cases and the memory-synthesis tests that read
stdcell files.

```
$ node tools/run-sv.js
PASSED: 36  FAILED: 0
```

## Why wasm32?

The current build targets **Emscripten wasm32** (`--target=wasm32`): 32-bit
pointers over a single 32-bit linear memory. This runs in any modern browser
and in node ≥ 18 — **no memory64 support is needed**.

Earlier documentation described a wasm64 (memory64) build, but the toolchain
now builds and runs as wasm32: slang, ABC, and the dyno harness are all
compiled with `--target=wasm32` and linked together, and all 36 tests pass.

The wasm module has a single memory with 32-bit indices that starts at
128 MB (`-sINITIAL_MEMORY=134217728`, 2048 pages) and can grow to 4 GB
(`-sMAXIMUM_MEMORY=4GB`, 65536 pages) via `-sALLOW_MEMORY_GROWTH=1`.

## Requirements

### 1. Emscripten SDK

Install and activate (we used v6.0.7):

```sh
git clone https://github.com/emscripten-core/emscripten.git emsdk
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh     # puts emcc/em++/emcmake on PATH
```

> The Makefile looks for the SDK at `${EMSDK:-/opt/emsdk}` and sources
> `$EMSDK/emsdk_env.sh` automatically if `em++` is not already on PATH.
> Set `EMSDK=/path/to/emsdk` if you installed it elsewhere.

### 2. `uint` type

The codebase uses `uint` (provided by glibc/libstdc++, absent in libc++). This
is already handled in `include/support/ArrayRef.h`:

```cpp
#ifdef _LIBCPP_VERSION
using uint = unsigned int;
#endif
```

## Build steps

Everything is built by the top-level CMake (`CMakeLists.txt`), which consumes
dyno as a library (`add_subdirectory(dyno/lib)`), builds slang from the dyno
submodule (`add_subdirectory(dyno/tools/dyno-sv/slang)`), builds Berkeley-ABC
from `third-party/abc`, and links them into the `dyno-sv-wasm` executable.
`make wasm` wraps it:

```sh
make wasm          # = emcmake cmake -B build/wasm && cmake --build --target dyno-sv-wasm
# -> wasm-sv/dyno-sv-wasm.{js,wasm,data}
```

### A. slang

slang is a git submodule at `dyno/tools/dyno-sv/slang` (inside the dyno
submodule), built by the CMake as a subproject. **Threads are disabled**
(`-DSLANG_USE_THREADS=OFF` — slang's thread pool fails in single-threaded
wasm) and mimalloc is off.

> `SLANG_BOOST_SINGLE_HEADER` is auto-selected by slang's CMake when system
> Boost is absent (it uses the vendored `external/boost_unordered.hpp`). The
> harness compile also defines `-DSLANG_BOOST_SINGLE_HEADER`, so the headers
> agree.

### B. dyno-sv-wasm + Berkeley-ABC (in-process synthesis engine)

The ABC pass (`meta.ABC_PASS` in `flow.dyno`'s `%synthTechmap`) shells out to
`yosys-abc` via `system()` natively, which is impossible in the browser. The
wasm build instead drives **Berkeley-ABC in-process** through ABC's library
API (`abc::Cmd_CommandExecute`) — no subprocess, no external binary.

- ABC is a git submodule at `third-party/abc` (it lives *here*, not in dyno,
  because only `dyno-sv-wasm` needs it). The CMake builds `libabc.a` via ABC's
  GNU-make build with `CC=em++ CXX=em++ AR=emar`, `ABC_USE_NAMESPACE=abc`,
  and pthreads/readline/thread-local disabled for single-threaded wasm.
- `dyno/include/hw/passes/ABC.h` calls `abc::Cmd_CommandExecute` when compiled
  with `-DDYNO_USE_ABC` (falls back to `system("yosys-abc ...")` otherwise) —
  this support is already in dyno's clean mainline. The sky130 liberty file is
  preloaded into MEMFS so ABC's `read_lib` works (`compile-lib-test.mjs`
  verifies it reads the library and maps to sky130 stdcells).
- The wasm flow (`flow/flow.dyno`, a copy of dyno's mainline `flow.dyno`) maps
  `%synthTechmap` to sky130 stdcells (`read_lib` of the preloaded liberty
  before `if`). Its `${liberty-path}` placeholder is substituted with the
  ABC_PASS `path` by `ABC.h` before the in-process call.

### C. Run the tests (node)

```sh
node tools/run-sv.js [OUTPUT_DIR]             # 36-test suite (PASSED: 36 FAILED: 0)
node tools/compile-test.mjs [OUTPUT_DIR]      # full flow through ABC (post_techmap)
node tools/compile-lib-test.mjs [OUTPUT_DIR]  # ABC reads the sky130 liberty
# any modern node (>= 18) works; the emsdk-bundled one is used if the system
# node is too old
```

## Browser ABI

`dyno-sv-wasm.js` is an ES6 module; the default export is an `init()` promise.

```js
const wasm = await init({ locateFile: (p) => '/path/to/' + p });

// Test mode (`dyno-sv test`):
const out = wasm.ccall('dyno_run', 'string', ['string', 'string'],
                       [flowSource, testSource]);
console.log(out);          // "passed test: ..." lines + final ALL TESTS PASSED

// Compile mode (synthesis pipeline over an input):
const json = wasm.ccall('dyno_compile', 'string',
                        ['string', 'string', 'string'],
                        [flowScript, inputSource, kind]); // kind = "sv" | "ir"
const data = JSON.parse(json);
// { stages:[{name,text}...], final, stdout, error }

wasm.ccall('dyno_free', null, ['number'], [outPtr]);   // free the string
```

Exported functions:
- `char *dyno_run(const char *flow, const char *test)` — parse and run the
  dyno-IR tests from `flow.dyno` + `test.dyno` source text. Returns a malloc'd,
  null-terminated results string; caller must `dyno_free()` it.
- `char *dyno_compile(const char *flow, const char *input, const char *kind,
                      const char *extraArgs)`
  — run a dyno pass-pipeline script (`flow`, e.g. `flow.dyno` + a runner that
  `CALL`s flow functions) over an input (`kind` = `"sv"` or `"ir"`). Returns a
  JSON string:
  - `stages`: every file written by `DUMP_PASS` during the run (detected by
    diffing the MEMFS filesystem before/after), each `{name, text}`.
  - `final`: the full context IR text after the pipeline (via `HWPrinter`).
  Terminal output (stdout + stderr) is not in the JSON — it is captured at the
  JS level by the worker's `print`/`printErr` callbacks (fd 1/2) and streamed
  live. A fatal error aborts the module and surfaces via the worker's crash
  path (reason on stderr), not via the JSON. On success it returns valid JSON,
  so callers can always `JSON.parse`.
- `char *dyno_run(const char *flow, const char *test, const char *extraArgs)`
  — run the dyno-sv test suite.
- `void dyno_free(char *p)`.

`extraArgs` carries the CLI-style extra args (e.g. `--debug-passes=...`, `-d`)
for that run; it is applied inside `dyno_compile`/`dyno_run` via dyno's **own**
`CmdLineArg` parsing + `PassRegistry::setDebugEnForPasses` — exactly how the
native `dyno-sv` binary handles `--debug-passes`/`-d` (no custom debug-target
registry). Resets all debug first, so the args fully determine the debug state
for the run. The explorer worker passes the contents of its "Extra args" box
directly as `extraArgs` on each run call.

The build defines `-DDYNO_ENABLE_DEBUG=1`, so all `DYNO_DBG` blocks are
compiled in. Pass debug ids are auto-assigned from the pass's dialect (see
`include/support/Debug.h`); analyses (`KnownBitsAnalysis`, `HWInterpreter`,
`LoopbackPartitionAnalysis`) use manually-assigned ids but stay disabled by
default (even under `-d`), matching the native binary. Debug output goes to
stderr (fd 2 → `printErr`), which the explorer worker streams to the console
incrementally.

Fatal errors (parse errors, missing ops, missing files) do **not** terminate
the module; they are captured and returned in the `error` field / as
`FATAL ERROR: ...` in the output, so the module stays alive across many
invocations (compiler-explorer style). Hard asserts (`abort`) still trap — the
`explorer/` frontend runs the module inside a Web Worker and respawns it after
a hard crash or timeout.

## Key build flags

- `-DDYNO_ENABLE_DEBUG=1` — compile in every `DYNO_DBG` block (per-pass debug
  output, enabled at runtime via `--debug-passes`). Without it the debug code
  is compiled out entirely.
- `--target=wasm32` — 32-bit pointers over a 32-bit linear memory (see
  "Why wasm32" above).
- `-sSTACK_SIZE=67108864` — **critical.** Dyno's `FatContext` (~40KB) plus deep
  parser/pass recursion overflows the default 64KB wasm stack. That overflow
  **silently corrupts memory** and shows up as bizarre crashes (bad indirect
  calls, "already registered?" assertions, out-of-bounds). Without a large
  stack nothing works.
- `-sNO_DISABLE_EXCEPTION_CATCHING` — lets `dyno_run` catch the exception thrown
  by the fatal-error callback (so `report_fatal_error` doesn't `exit()` the
  module, keeping it alive across runs).
- `-sFORCE_FILESYSTEM=1` + `--preload-file` — slang's `PARSE_DYNO_PASS` reads
  stdcell files by path via `MMap` (mmap). The two stdcell files are preloaded
  into Emscripten's virtual FS (MEMFS) at their exact repo-relative paths, and
  `MMap` works on them.

## How the harness works

`tools/wasm/dyno-sv-wasm.cpp` mirrors `dyno-sv test` from
`tools/dyno-sv/dyno-sv.cpp`:

- Sets up a `FatContext` with `HWDialectContext`, `CoreDialectContext`,
  `OpDialectContext`, `AIGDialectContext`, `TypeDialectContext`, then
  `TestDialectContext` + `MetaDialectContext`.
- Registers `ParseVerilogPass` (slang) and `AssertExistsPass<TestPrinter>` on
  both the main context and the sandbox.
- Parses `flow` + `test` from memory buffers (`Parser::parse(ArrayRef<char>, ...)`
  — no file needed), runs `ResolveImportsPass`, then `TestInterpreter::execBlock`.
- Wraps `report_fatal_error` via `push_fatal_error_callback([] { throw FatalError{...}; })`
  so fatal errors unwind as exceptions instead of `exit()`.

## Repository layout

- `tools/dyno-sv-wasm.cpp` — the dyno-sv wasm harness (the full build; slang +
  in-process ABC). This is the only wasm harness — the simpler no-slang
  `dyno-wasm.cpp` was superseded and removed.
- `tools/run-sv.js`, `compile-test.mjs`, `compile-lib-test.mjs` — node runners.
- `CMakeLists.txt` — builds `dyno-sv-wasm` (slang + in-process ABC + dyno-as-library).
- `flow/flow.dyno` — the wasm-specific synthesis flow (ABC `read_lib`).
- `include/support/ArrayRef.h` — `using uint` under `_LIBCPP_VERSION`.
- `include/support/SmallVec.h` — `std::array::data()` (raw pointer) for
  `CexprVec`/`StaticVec` iterators (libc++-compat; also correct on libstdc++).
- `include/support/ErrorRecovery.h` / `lib/support/ErrorRecovery.cpp` — added
  `last_fatal_error_reason()` so the harness can surface the fatal-error message
  instead of `exit()`.
- `docs/WASM_BUILD.md` (this file).

## Environment notes (for a fresh sandbox)

The original build was done in an **ephemeral sandbox** where the Emscripten SDK
was installed at `/opt/emsdk` (v6.0.7) with a bundled node `24.19.0`. That SDK
**is not persistent** — on a fresh environment you must reinstall it (see
Requirements). The Makefile handles a configurable `EMSDK` path.

Build outputs (`wasm/`, `wasm-sv/`) and slang's wasm build
(`tools/dyno-sv/slang/build-wasm/`) are gitignored and are **not** part of the
repo — rebuild them with the scripts above.

## Troubleshooting

- **"thread constructor failed: Not supported"** — slang was built with threads.
  Rebuild slang with `-DSLANG_USE_THREADS=OFF` (build-slang-wasm.sh does this).
- **Bizarre memory corruption / bad indirect calls** — almost always the stack
  overflow; make sure `-sSTACK_SIZE` is large (64MB) and
  `-sALLOW_MEMORY_GROWTH=1`.
- **`could not open file: tools/dyno-opt/dyno-ir/...`** — the stdcell files
  weren't preloaded; rebuild with the `--preload-file` flags (see CMakeLists).
