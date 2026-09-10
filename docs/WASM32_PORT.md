# Porting Dyno from wasm64 to regular wasm32

**Goal:** Build Dyno (the dyno-sv wasm module) as plain wasm32 instead of the
Emscripten wasm64 / memory64 build currently used. This drops the memory64
dependency entirely, so the output runs on any modern browser and node 20+,
not just node 23+/24+.

**Scope verdict:** The current `docs/WASM_BUILD.md` claims wasm32 is
"fundamentally incompatible" because the object store "requires
`sizeof(void*) == 8`". That is **overstated**. The wasm64 choice was driven
almost entirely by **one** store, and nearly everything else adapts via
`uintptr_t`/`size_t` automatically. The lift is roughly **seven small source
edits**, a **build flag flip**, and **one wasm32-specific codegen fix** in
`tuple_iterator` (a miscompile, not UB).

This document records what the port actually required. It corrects several
claims in the original estimate (notably: `FatDynObjRef<>` is 16 bytes on
wasm32 too, the `FixedFlatObjStore.h` include must be removed, `Operand`'s
inline storage must be pointer-sized, `MAXIMUM_MEMORY` must be 4 GB, and
`std::stable_sort` on the `tuple_iterator` is miscompiled at `-O1+`).

---

## 1. The main blocker — the flat store

`include/hw/HWContext.h` was the **only** `FixedFlatObjStore` in the codebase:

```cpp
FixedFlatObjStore<Wire> wires;
```

`FixedFlatObjStore<Wire>` holds a `FlatAddressSpace<Wire, 2^32>` which mmaps
`2^32 * sizeof(Wire)` bytes (~128 GB of virtual address space, reserved with
`MAP_NORESERVE`) and indexes it directly by 32-bit object ID. That is
impossible in a 32-bit address space, hence wasm64.

But `Wire` is the **only** user of the flat store, and `NewDeleteObjStore<Wire>`
exposes the identical API (`.create()/.resolve()/iteration`). Evidence:

- `tools/ObjTest.cpp` already instantiates `NewDeleteObjStore<Wire>` directly.
- The only real usages of `HWContext::getWires()` are `.create()` and
  `.resolve()`.

**Actions (two changes, not one):**

1. Swap the store type:
   ```cpp
   NewDeleteObjStore<Wire> wires;   // was: FixedFlatObjStore<Wire> wires;
   ```
2. **Remove** `#include "dyno/FixedFlatObjStore.h"`. Even with the store
   uninstantiated, `FlatAddressSpace<T, 2^32>` narrows `2^32` to a 32-bit
   `size_t` and fails to compile on wasm32. (The include is unused once the
   store is swapped.)

`NewDeleteObjStore` (malloc-backed), `IDObjStore`, and `ObjMapVec` (growable
vectors) all work fine on wasm32 — no address-space reservation.

---

## 2. Pointer-width-sensitive code to fix

These are the actual places that assume `pointer == 64 bits`:

### 2a. `include/dyno/Obj.h`

| # | Location | Problem on wasm32 | Fix |
|---|----------|-------------------|-----|
| 1 | `static_assert(sizeof(FatObjRef<int>) == 16)` | `FatObjRef` = ObjID(4) + custom(2) + special(2) + ptr(4) = **12** bytes | `static_assert(sizeof(FatObjRef<int>) == (sizeof(void*) == 8 ? 16 : 12))` |
| 2 | `static_assert(sizeof(FatDynObjRef<>) == 16)` | **16 bytes on BOTH** — `DynObjRef` carries `alignas(uint64_t)`, so the 12-byte layout pads to 16. **Leave unchanged.** (The original estimate's 12-byte claim was wrong.) |
| 3 | `std::hash<DynObjRef>`: `std::bit_cast<size_t>(ref)` | `size_t`=4 vs `DynObjRef`=8 → `std::bit_cast` requires equal sizes → **compile error** | `std::bit_cast<uint64_t>(ref)` (`uint64_t` is always 8 bytes) |

### 2b. `include/dyno/Instr.h` — `Operand::custom`

`Operand` holds an inline storage for a custom payload:

```cpp
InlineStorage<8> custom;   // was: fixed 8 bytes
InlineStorage<sizeof(void *)> custom;   // now: pointer-sized
```

On wasm32 a pointer is 4 bytes. `custom` is used as a pointer/ref holder via
`custom.as<T*>()`, so it must be at least `sizeof(void*)`. Making it
pointer-sized keeps it 8 bytes on wasm64 and 4 bytes on wasm32, and keeps
`sizeof(Operand) == 16` / `alignof(Operand) == 8` on both targets (verified:
`FatDynObjRef<void>` is also 16/8, so they stay layout-compatible).

---

## 3. Adapts automatically — verify, don't fix

- **`include/support/PointerVariant.h`** (`PointerIntPair` /
  `PointersIntsVariant`) — uses `uintptr_t`, so pointer-tagging still works on
  wasm32 (malloc is 8/16-byte aligned). **Watch out:** ints stored in a variant
  get only ~30 bits on wasm32 (vs ~62 on 64-bit). Current uses are fine
  (`TreeVec` = all pointers; `FlipFlopMapping` = small enum + pointer), but a
  future 32-bit int in a variant would silently overflow — add a
  `static_assert(bit_mask_sz<T> <= 30)`-style guard if you touch it.
- **`include/support/PtrBitField.h`** — `clog2(alignof(T)) >= N` still holds on
  wasm32 malloc alignment.
- **`alignas(uint64_t)`** on `DynObjRef` — harmless, just forces 8-byte align
  (and is what keeps `FatDynObjRef<>` at 16 bytes).
- **`rawNoPtr()`**, **`DenseMapInfo<DynObjRef>`** (`bit_cast<uint64_t>`,
  matches 8-byte ref), **`std::hash<IsPureObjRef>`** (`bit_cast<uint32_t>`
  matches ObjRef=4), **`InlineStorage`** (size/align-templated), **`SAT` raw64**
  packing (data, not pointers) — all fine.

---

## 4. wasm32 codegen bug — `std::stable_sort` on `tuple_iterator`

**The original estimate missed this entirely.** Emscripten's wasm32 backend
miscompiles `std::stable_sort`/`std::sort` when applied directly to the
`support/Ranges.h` `tuple_iterator` at `-O1` and above: it raises
`RuntimeError: memory access out of bounds` inside the sort's element move.
It is triggered only when a swap/move is actually needed (a comparator that
returns false never crashes). It reproduces in a minimal program with a
malloc'd array of `tuple<3>`, and disappears at `-O0`; `std::sort`/`stable_sort`
on raw-pointer ranges and plain `std::tuple<F&,...>` assignment both work
correctly.

### Is it UB or a miscompile? It's a miscompile (no UB).

A bisection narrowed the trigger to the `base_iterator` CRTP decrement chain
inherited by `tuple_iterator`:

```cpp
// base_iterator
operator--()      { (self()) -= 1; }     // -> operator-= 
operator-=(n)     { self() += -n; }      // -> operator+=
```

This is ordinary pointer arithmetic on a valid iterator — no UB. Evidence that
it is a genuine toolchain miscompile, not a language bug:

- The same code works at `-O0` and fails at `-O1+` on wasm32 (UB would not be
  that deterministic across opt levels).
- It works on x86-64 native and wasm64 at `-O2`.
- A semantically identical iterator with **inline** `operator--`/`operator-=`
  (direct `it -= N` / `it -= N*d` instead of the chained `-= 1 -> += -n`)
  works at every opt level. Overriding `operator+`, `operator-` (which still
  routes through the inherited `operator-=`), or `operator[]` does *not* fix
  it — only breaking the chained decrement does.

The wasm32 backend miscompiles the chained `operator-- -> operator-= ->
operator+=( -n )` call sequence, producing wrong addresses that make
`std::sort`/`stable_sort` read/write out of bounds when it decrements the
iterator.

### Fix (root cause, in `support/Ranges.h`)

Override the decrement in `tuple_iterator` with direct pointer arithmetic so it
no longer relies on the miscompiled `base_iterator` chain. This is
semantically identical and correct at every optimization level:

```cpp
tuple_iterator &operator-=(difference_type d) requires(isRandom) {
  it -= N * d;
  return *this;
}
tuple_iterator &operator--() {
  it -= N;
  return *this;
}
```

No call-site changes are needed; `buildGEP`'s original tuple `stable_sort` is
restored. Verified on wasm32 (`-O0`..`-O3`), native, and wasm64: `PASSED: 36
FAILED: 0`. If a future change adds another tuple sort, the fix already covers
it (the bug was in the iterator, not the call site).

---

## 5. Out of scope / non-issues

- **`tools/dyno-sim/dyno-sim.cpp`** `std::bit_cast<vpiHandle>(ref)` would break
  (VPI handle is a 4-byte ptr vs the 8-byte ref) — **moot**, no VPI in wasm.
- **`uint`** (`include/support/ArrayRef.h`) — unchanged.

---

## 6. Build changes

- `tools/wasm/build-slang-wasm.sh`: `--target=wasm64` → `--target=wasm32`
  (both `C_FLAGS` and `CXX_FLAGS`).
- `tools/dyno-sv-wasm.cpp` (via CMakeLists): `--target=wasm32` **and**
  `-sMAXIMUM_MEMORY=8GB` → `-sMAXIMUM_MEMORY=4GB` (wasm32's hard memory cap).
- Flags that **carry over unchanged**:
  - `-sSTACK_SIZE=67108864` (critical — deep FatContext/pass recursion)
  - `-sNO_DISABLE_EXCEPTION_CATCHING` (keep module alive across `dyno_run`)
  - `-sFORCE_FILESYSTEM=1` + `--preload-file` (stdcell files via `MMap`)
- **Payoff:** no memory64 → runs on any modern browser and node 20+, not just
  node 23+/24+ (drop the emsdk-bundled node requirement).

---

## 7. Verification

- wasm32: `node tools/wasm/run-sv.js` → **`PASSED: 36  FAILED: 0`** (the slang
  `PARSE_VERILOG_PASS` cases and memory-synthesis tests pass, proving the `Wire`
  store swap preserves behavior).
- wasm64 reference (before flipping the build back): `PASSED: 36  FAILED: 0`.
- Native x86-64: `dyno-sv test flow.dyno test.dyno` → all 36 pass, exit 0,
  confirming the edits are pointer-width-neutral.

---

## 8. Work estimate

Roughly: one store swap + include removal, two static_asserts, one `std::hash`
fix, one `Operand` sizing fix, the build flag flip + `MAXIMUM_MEMORY` cap, and
the `buildGEP` sort workaround. Risk is mostly in the build/toolchain (the
`tuple_iterator` miscompile was the hardest part).

## 9. File/commit checklist

- [ ] `include/hw/HWContext.h` — `FixedFlatObjStore<Wire>` → `NewDeleteObjStore<Wire>`; remove `#include "dyno/FixedFlatObjStore.h"`
- [ ] `include/dyno/Obj.h` — `sizeof(FatObjRef<int>)` assert made pointer-width-neutral; `std::hash<DynObjRef>` `bit_cast<size_t>` → `bit_cast<uint64_t>` (`FatDynObjRef<>` stays 16)
- [ ] `include/dyno/Instr.h` — `Operand::custom`: `InlineStorage<8>` → `InlineStorage<sizeof(void *)>`
- [ ] `include/support/Ranges.h` — `tuple_iterator`: override `operator--`/`operator-=` with direct pointer arithmetic (wasm32 codegen fix)
- [ ] `tools/wasm/build-slang-wasm.sh` — `--target=wasm32`
- [ ] `tools/wasm/build-wasm-sv.sh` — `--target=wasm32`; `-sMAXIMUM_MEMORY=4GB`
- [ ] `tools/wasm/build-wasm.sh` — `--target=wasm32`; `-sMAXIMUM_MEMORY=4GB`
- [ ] Rebuild slang wasm + dyno-sv wasm; run `node tools/wasm/run-sv.js` → `PASSED: 36  FAILED: 0`
