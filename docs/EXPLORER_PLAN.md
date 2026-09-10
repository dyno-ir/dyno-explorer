# Dyno Compiler Explorer — Implementation Plan

## Goal

A local-only, compiler-explorer-style web app that runs Dyno-SV (an HDL
synthesis tool) compiled to WebAssembly, in the browser. Users edit
SystemVerilog (or dyno-IR) on the left, and see synthesized IR at various
stages of the `flow.dyno` pipeline on the right, with source-location info
linked back to the input. It also supports custom dyno pass-pipeline scripts
and a `dyno-sv test` mode.

## Background / existing assets

The repo already has a working wasm32 port of dyno-sv (see `docs/WASM32_PORT.md`
and `docs/WASM_BUILD.md`). The port changes are in the working tree and the
toolchain (Emscripten at `/opt/emsdk`, wasm32) is set up. The existing build
produces:

- `wasm-sv/dyno-sv-wasm.{js,wasm,data}` — ES6 wasm module with ABI
  `char *dyno_run(const char *flow, const char *test)`, which runs the *test
  interpreter* (`dyno-sv test`).
- Preloaded stdcell files (`sky130_fd_sc_hd.dyno`, `example_memories.dyno`)
  needed by `meta.PARSE_DYNO_PASS` in `flow.dyno`.

The existing harness only runs tests. We need a **new harness function** that
runs the actual synthesis pass pipeline over an input and returns the IR dumps,
because that is what a compiler explorer shows.

## Architecture

```
┌────────────────────────────  browser (local only)  ───────────────────────────┐
│                                                                               │
│  Monaco editor panes:                                                         │
│   • Input pane  — SystemVerilog  OR  dyno-IR (mode toggle)                    │
│   • Output pane — IR text at a selected pipeline stage                        │
│   • Script pane — editable dyno pass-pipeline script (like flow.dyno)         │
│                                                                               │
│   Toolbar: mode (SV / dyno-IR / dyno-sv test), preset selector, run button    │
│                                                                               │
│   Output rendering: IR text is parsed for source-loc annotations like         │
│   ["config.code:7:5-10"] and each becomes a clickable/hoverable span that     │
│   scrolls+highlights the corresponding input line in the input pane.          │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ fetch of static wasm assets (same-origin)
┌───────────────────────────────────▼──────────────────────────────────────────┐
│  wasm-sv/dyno-sv-wasm.{js,wasm,data}  (Emscripten wasm32, MEMFS)             │
│                                                                               │
│  Exported ABI (extended):                                                     │
│    char *dyno_compile(flow, input, kind) → JSON string  [NEW]                 │
│    char *dyno_run(flow, test)  → results string  (existing, test mode)        │
│    void   dyno_free(char *)                                                  │
│                                                                               │
│  dyno_compile behavior:                                                       │
│    1. Build FatContext (HW/Core/Op/AIG/Type/Meta dialects) + ParseVerilogPass │
│    2. Parse input: kind "sv" → ParseVerilogPass(config.code);                │
│                    kind "ir" → Parser::parse                                  │
│    3. Parse flow script (flow.dyno + runner) into a block                    │
│    4. ResolveImports + MetaPassPipelineInterpreter.run                       │
│    5. Capture: final IR text (HWPrinter), every file dumped to MEMFS         │
│       (DUMP_PASS writes), captured stdout, and error string                  │
│    6. Return JSON { stages:[{name,text}], final, stdout, error }             │
└───────────────────────────────────┬──────────────────────────────────────────┘
```

### Why capture MEMFS files for stages

`flow.dyno`'s `%completeFlow` already emits `meta.DUMP_PASS` at every stage
boundary, writing files like `post_canon.dyno`, `post_techmap.dyno`. Under
Emscripten (MEMFS) those land in the virtual root `/`. `dyno_compile` enumerates
the root dir after the run and returns every dumped file's name + contents.
This means **one** compile produces all preset stages; the frontend just picks
which to display — no repeated compilation. For custom scripts, any
`DUMP_PASS` path the user writes is returned the same way.

### Source-loc linking

The IR printer already annotates each instruction with its source location,
e.g. `["config.code:7:5-10"]` (single line) or `["config.code:7.5-10.26"]`
(multi-line). The frontend parses these tokens, extracts the line, and turns
them into spans. Hovering/clicking highlights + scrolls to the input line.

## New files / changes

### Wasm harness — `tools/dyno-sv-wasm.cpp`
- Add `dyno_compile(flow, input, kind)` alongside existing `dyno_run`.
- Factor a shared `FatContext` setup helper.
- Redirect `std::cout` to a capture buffer during the run (DUMP_PASS writes to
  `/dev/stdout` for the final dump; test runner writes there too).
- Enumerate MEMFS root via `readdir` and read dumped files.
- Wrap everything in the existing fatal-error → exception mechanism so asserts /
  crashes become a returned `error` field instead of killing the module.
- Register `DumpPass` (so `DUMP_PASS` works) — it is registered by
  `HWDialectPasses`.

### Build — `CMakeLists.txt` (builds `dyno-sv-wasm`)
- Update `-sEXPORTED_FUNCTIONS` to include `_dyno_compile`.
- Keep preloaded stdcell files.

### Frontend — new directory `explorer/`
- `index.html`, `src/app.js`, `src/styles.css` — Monaco editor, layout, toolbar.
- Monaco loaded from the local `monaco-editor` npm package (offline, local-only)
  and bundled into `dist/` by esbuild.
- `scripts/build.mjs` bundles the app + workers and **copies the wasm module
  into `dist/wasm/`**, so `dist/` is a fully self-contained static site.
- Preset definitions: each maps to a flow script string = `flow.dyno` +
  runner that `CALL`s the relevant function (or `%completeFlow`) and a selected
  output stage.
- Source-loc linking logic in `src/app.js`.
- Test mode: builds a test script from the input pane, calls `dyno_run`, shows
  results.
- `dist/` (the deployable site) is served by any static server — e.g.
  `python3 -m http.server -d dist 8000`; `serve.js` is an optional convenience
  wrapper.

## Presets (stages of `flow.dyno`)

Derived from `%completeFlow`'s `DUMP_PASS` calls:

| Preset | flow runner | shows stage |
|--------|-------------|-------------|
| Early canonical | `CALL flow_earlyCanonFlow` | post_early_canon.dyno |
| Canonicalize | `CALL flow_synthCanonicalize` | post_canon.dyno |
| Early opt | `CALL flow_synthEarlyOpt` | post_early_opt.dyno |
| Lower control flow | `CALL flow_synthLowerControlFlow` | post_lower_cfg.dyno |
| Memory/FF mux | `CALL flow_synthMemoryFFMuxHandling` | post_memory_mux.dyno |
| Lower memory/FF | `CALL flow_synthLowerMemoryFF` | post_lower_memory.dyno | Techmap | `CALL flow_synthTechmap` | post_techmap.dyno |
| Full flow | `CALL flow_completeFlow` | all stages (selector) |

To show a stage that is *not* the final dump of its function, the runner calls
the function(s) and then `DUMP_PASS map("path":"/out.dyno")`, and the frontend
reads `/out.dyno`. (Simpler: run `%completeFlow` once and show whatever file
the stage name implies — no runner reconstruction needed.)

## Error handling (garbage input)

- `report_fatal_error` → `push_fatal_error_callback` throws `FatalError`, caught
  → returned in JSON `error` field. Module stays alive.
- `std::exception` / unknown exceptions caught similarly.
- The Emscripten `RuntimeError: memory access out of bounds` / `abort` from a
  hard crash is handled in JS: a `catch` around the `ccall` returns an
  "internal crash" message to the output pane, and the module is reloaded
  before the next run (fresh instance) so the explorer never wedges.
- Each run uses a fresh wasm module instance (re-init) to guarantee isolation
  from any partial memory corruption.

## Build steps

```sh
source /opt/emsdk/emsdk_env.sh
make wasm              # rebuilds wasm-sv with new ABI
cd explorer && npm install && npm run build   # -> dist/ (self-contained)
# serve dist/ with any static server, e.g.:
python3 -m http.server -d explorer/dist 8000  # open http://localhost:8000/
```

## Verification

- Native `dyno-sv` reference for IR text format.
- Node smoke test calling `dyno_compile` with a counter example → JSON with
  stages.
- Browser tests (Playwright + headless Chromium):
  - Each preset (canon → lowermem) compiles in ~100-250 ms and renders IR.
  - `post_techmap` hits a real dyno assertion → shown as "crashed (recovered)",
    the worker is respawned, and a subsequent valid run works.
  - dyno-IR input mode, custom script mode, and `dyno-sv test` mode all work.
  - Garbage SV shows a clean "slang: errors found during compilation" error.
  - Source-loc decorations (8 on the counter) highlight the input line on
    click/hover.
  - Full `dyno-sv` reference suite still passes: `PASSED: 36 FAILED: 0`.

## Status: COMPLETE

All planned features are implemented and tested in the browser:
- `tools/dyno-sv-wasm.cpp` — added `dyno_compile(flow, input, kind)`
  (runs a pass pipeline over SV/dyno-IR, returns JSON with `DUMP_PASS` stage
  outputs captured from MEMFS, final IR text, captured stdout, and error).
  `dyno_run(flow, test)` retained for test mode; both share a context-setup
  helper. See `explorer/README.md` for the ABI.
- `CMakeLists.txt` — builds `dyno-sv-wasm` (slang + in-process ABC + dyno-as-library); exports `_dyno_compile`.
- `explorer/` — Monaco-based UI (input / output / script panes), presets
  generated from `flow/flow.dyno`, source-loc linking, and a Web Worker that runs
  dyno with crash/timeout isolation. `scripts/build.mjs` produces a fully
  self-contained `dist/` (bundled app + copied wasm in `dist/wasm/`) that is
  served by any static server.
- Build: `make wasm` + `cd explorer && npm install && npm
  run build`, then serve `explorer/dist/` (e.g. `python3 -m http.server -d
  explorer/dist 8000`).

### Notes
- **ABC / techmap now works.** Berkeley-ABC (submodule `tools/abc`) is built
  as a wasm32 static library and driven in-process via
  `abc::Cmd_CommandExecute` (see `docs/WASM_BUILD.md`), replacing the native
  `system("yosys-abc ...")` subprocess that is unavailable in the browser. The
  full-flow preset (`post_techmap`) compiles to a sky130 stdcell netlist
  (`STDCELL_INSTANCE` to `sky130_fd_sc_hd__*` cells) in the browser — see
  `explorer/scripts/test-techmap.mjs`.

  The `%synthTechmap` abcCmd in `flow.dyno` maps to sky130 stdcells (`read_lib`
  of the preloaded sky130 liberty before `if`), matching the intended sky130
  flow in `flow.dyno`'s history (the original default abcCmd in `ABC.h`). The
  `${liberty-path}` placeholder is substituted with `config.path` at runtime.
- Each preset runs its own partial pipeline (up to its stage) and dumps
  `out.dyno`; this keeps later-stage crashes from losing earlier-stage output.
