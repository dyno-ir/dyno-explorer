# Debugging DynoHDL miscompiles (golden vs model cosim)

Advice for future agents debugging a wrong output (miscompile) in dyno, especially in
the golden vs model SoomRV cosim. This is general guidance, not specific to any one
bug. The overarching rule:

> **Ground every conclusion in actual output (IR dumps, logs, or custom debug
> output). Do not reason about IR in your head, and do not assume the first
> suspicious thing you spot is the real cause.**

A wrong netlist is touched by *many* passes. Any given output instruction has gone
through dozens of transformations. The first oddity you notice is usually a *symptom*
(the corrupted downstream value), not the *source*. You must bisect and confirm before
you commit to a root cause.

---

## 1. Understand the golden vs model cosim

The SoomRV cosim (`build/test/SoomRV/soomrv_sim`) runs **two** netlists side by side
each cycle and prints any register that differs:

- `args.dynoFile` (passed with `-i`) → compiled as `GTop` (the **golden**).
  Built from `sim_header_golden.h`.
- `design2.dyno` (hard-coded in `main()`) → compiled as `Top` (the **model**).
  Built from `sim_header.h`.

The two designs come from **different** optimization flows, so a mismatch means at
least one of them is wrong — it is **not** guaranteed to be the one you think. In
general the golden is *usually* right, and sometimes you can be 100% certain it is
by looking at the waves (the golden value is what the RTL should produce). But a
"golden" produced by a recently-changed pass can be the miscompiled side. **Ask the
maintainer before assuming which side is wrong** — it's a cheap question that avoids
hours of debugging the wrong netlist.

Mismatch output looks like:

```
(5)[soc.core.rn.tb.penc.gen_0_.s]: mismatch 256'hffff...fe != 256'heeee...ee
```

`aVal` is golden/`design.dyno`, `bVal` is model/`design2.dyno`.

### How the flows differ (as of the SoomRV bring-up)

- **golden `design.dyno`** ← `dyno-sv soomrv sim` → `-s=.../script.dyno`
- **`post_early_opt.dyno`** ← `dyno-sv soomrv` → `-s=.../run_flow.dyno`
  (`flow.dyno` `completeFlow`, currently early-opt only)
- **model `design2.dyno`** ← `dyno-sv script` → `-s=.../script_sim_harness.dyno`,
  which re-parses `post_early_opt.dyno` + xilinx flop/mem libs.

Commands are in `.vscode/launch.json`. The sandbox has no risc-v toolchain, so run
the sim with a pre-linked `a.out` (not a `.s`) — the sim shells out to
`riscv32-elf-{as,ld,readelf,objcopy}`; for an existing ELF only `readelf`/`objcopy`
are needed. `soomrv_sim` needs `libz.so` (symlink `/usr/lib/libz.so` →
`.../libz.so` if missing) and the build may need `llvm-ar`/`llvm-ranlib` (symlink to
`ar`/`ranlib`). Rebuild with `cmake --build build --target soomrv_sim -j$(nproc)`.

`dyno-sv` may be a stale binary linked against a newer `libfmt.so.12` than the
sandbox has (only `libfmt.so.10`). Rebuild `dyno-sv` instead of symlinking, since
the fmt ABI differs.

---

## 2. Reproduce first, then bisect between passes

Always regenerate the design with the *exact* script and confirm you can reproduce
the mismatch before hunting.

The single most effective technique is **dumping the IR between passes**. Copy the
flow script and sprinkle `DUMP_PASS` calls at every stage you care about:

```
meta.SSA_CONSTRUCT_PASS ...
meta.DUMP_PASS map("path": "dbg_after_ssa.dyno")
meta.INST_COMBINE_PASS
meta.DUMP_PASS map("path": "dbg_after_combine.dyno")
meta.LOAD_COALESCE_PASS
meta.DUMP_PASS map("path": "dbg_after_loadcoalesce.dyno")
...
```

Then diff the *one signal* you care about across dumps (grep for its register id /
the STORE that writes it). The stage where its computation first becomes wrong is
your culprit **pass**. In practice this collapses a multi-pass search to a single
pass in one run.

Note: watch for typos/leftover settings in copied scripts — e.g. a stale
`"dynamicToFullRegAccess": "00"` that the current DSL rejects. Just fix it to
`"0"`; the original design was generated without the typo.

---

## 3. Dump live values with wire/register IDs (not just names)

The `w12345` / `r12345` ids in a `.dyno` file are **real ObjIDs**. This lets you
catch a *specific* value at runtime:

- Catch a specific wire in a pass: `if (wire.getObjID() == 12345) { ... }`
- Get a full ref to a register each cycle:
  `ctx.resolve(ObjRef<Register>{ObjID{12345}})` and read it in the interpreter.
- Get register names from a context:
  `ctx.getCtx<dyno::HWDialectContext>().regNameInfo.getNames(registerRef)`.

In the SoomRV sim, the simplest hook is inside `compareRegs` (in `Top_tb.cpp`): it
already iterates every `(handleA, handleB)` pair with `handleX->getFull()`. Add a
conditional print when the register name contains your signal, dumping both sides
every cycle. This is how you confirm whether an input wire is actually equal in both
designs before assuming the bug is in the consumer (e.g. "IN_data is equal, so the
penc combinational logic is what's wrong").

Use this to verify *inputs are equal* before blaming a downstream block — it kills
whole classes of red herrings fast.

### Comb values can also be registers

A `REGISTER_DEF` is just a Verilog `reg` — it is **not** necessarily a flip-flop. It
can be a sequential element (written with `STORE_DEFER`, i.e. `<=` in Verilog) or a
combinational value (written with `STORE`, i.e. `always_comb`). So don't assume a
register is stateful; a register whose value is computed combinationally will still
show up in the cosim compare and can be the earliest mismatch even though it's not a
flip-flop.

### Footgun: ObjIDs are not stable across re-parses

The wire/register IDs are only meaningful **within a single run** of a tool. They
are **re-assigned when the `.dyno` is re-parsed**, so an ID you see in a `dyno-sv`
dump is **not** the same wire's ID inside `soomrv_sim` (which re-parses the design
from `.dyno`). You can match IDs between the `dyno-sv` dump files it generates
(e.g. `dbg_*.dyno`) because those are all from one run, but you cannot carry an ID
from a `.dyno` into the sim. For this reason `soomrv_sim` itself emits
`redump.dyno` / `redump2.dyno` when it loads the designs — dump those, find the
signal's **new** ID there, and use *that* in the sim. Matching by **name** (as in
the `compareRegs` hook above) is generally the more robust bet, since names survive
the re-parse — **but note that only registers carry names** (via `regNameInfo`);
wires have no names, so for wires you must fall back to the ID-mapping approach.

---

## 4. Use git history as a heuristic — but verify

A regression is very often a **recent change**. Check `git log --oneline` on the
files involved (the culprit pass, its pattern sources, the load/store code) and on
the *whole* history for commits whose message matches the area. Recent refactors are
prime suspects: they often leave a stale operand/edge case behind (e.g. an
insert-style change that updated one pattern but not a sibling).

This works well for young bugs. But sometimes the bug is old and merely exposed by a
newer design (dyno is only now being run on larger designs for the first time, so
long-lurking edge cases surface). **If you're not sure, ask** whether the bug is a
recent change or a long-lurking one — it changes how much weight to give git history
vs. fresh analysis.

Corroborate the git-history lead with the pass-bisection result (section 2) before
trusting it.

---

## 5. The pattern sources are in `.arrpat` files

Many InstCombine-style rewrites are **DSL patterns**, not hand-written C++:

- patterns: `tools/arrpat/test/test2.arrpat` (and siblings)
- compiler: `build/tools/arrpat/arrpat`, fed `test2.arrpat` → generates an `.inc`
  (see the `arrpat` launch config)

The `match { ... } with [...] replace { ... }` syntax lives only in `.arrpat`.
When a bug is localized to a pass that is pattern-driven, **search `.arrpat` files
first** — do not assume the logic is in the pass `.h`/`.cpp`. A wrong pattern (e.g.
an operand-count mismatch between a `match` and its `replace`) is a classic source.

---

## 6. Be careful reading large logs / dyno files

`design*.dyno` are multi-MB; `dump*.dyno` can be huge. Don't `cat` them — `grep`/
`sed` targeted regions. Use the register ids from `REGISTER_DEF` to find the STORE /
computation for the exact signal you care about, then read only that neighborhood.

### Four-state values

Dyno has four-state values, printed like `12h'xyz?uvw` where `uvw` is the **unknown
mask**. When the unknown mask bit is set, a `1` in the data side means `x` and a `0`
means `z`. So a value like `12h'xyz?uvw` isn't a plain bit pattern — you must combine
the data and unknown-mask halves to know which bits are `0/1/x/z`. Keep this in mind
when interpreting dumped constants (e.g. `#64'hffffffff_ffffffff?ffffffff_ffffffff`
is all-`x`/`z`, not all-ones).

---

## 7. Golden sim is not done — expect more bugs

Dyno is being brought up on larger designs for the first time, so there is a lot of
old code with small latent problems. Expect:

- more mismatches from edge-case patterns,
- bugs whose root cause is far "upstream" of the first observed mismatch (the
  earliest reported mismatch may already be a symptom),
- golden and model both being wrong in different ways.

Always: reproduce → bisect to a pass → verify inputs are equal → check recent git
history → read the actual pattern/code → confirm the fix produces matching output
for the whole sim, not just the one signal.
