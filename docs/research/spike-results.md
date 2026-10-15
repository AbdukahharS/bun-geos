# Phase 0 spike — results

> Status: **complete, GO** — October 2026. Machine: Arch Linux, x86_64, glibc 2.44,
> Bun 1.4.3, gcc 16.2.1 (clang broken on this box: missing `libLLVM.so.23.1`), no system
> GEOS. Every check below is reproducible via `spike/setup.sh` + `bun test spike/`
> (23 tests, all green). Results doc by check:

## Exit criteria

| Criterion (ROADMAP Phase 0) | Result |
|---|---|
| Overlay roundtrip with correct results, zero crashes | ✅ exact known-answer (triangle (1,1),(3,1),(1,3), area exactly 2.0) + 500 seeded random triangles |
| Error path surfaces a real GEOS message through a thrown error | ✅ `"ParseException: Expected number but encountered end of stream"` → `GeosError` |
| No crashes across a 10⁵-geometry soak | ✅ 100k build/overlay/destroy cycles in 0.66 s (~150k ops/s); RSS flatlines after warmup (0.0 MB/epoch tail) |
| FFI value-roundtrip set (the #44906 class) | ✅ no silent mis-coercions on Bun 1.4.3 (details below) |
| libc gating on Linux `optionalDependencies` | ⚠️ **Bun ignores `libc`** (npm respects it) — loader must self-select; see F2 |
| `bun build --compile` consuming an embedded `.so` | ⚠️ works; leaks one temp file per run (see F9) |
| `cc()`/TinyCC dev fallback | ❌ dead as designed — TCC rejects `__thread` (see F7) |

Neither kill switch fired. Phase 1 is unblocked.

## F1 — dlopen + flat-buffer roundtrip (the core bet)

`Float64Array` → `GEOSCoordSeq_copyFromBuffer_r` → ring → polygon → `GEOSIntersection_r` →
`copyToBuffer` returns bit-identical coordinates. TypedArray-passed-as-ptr is genuinely
zero-copy: C reads live memory (JS mutation visible across calls), and the address C
receives, XOR-masked and recovered, reads back the buffer's contents. Roundtrip identity,
exact-area overlay, and randomized triangle properties all hold.

**Carry-forward:** the D9 flat-buffer currency works exactly as designed; nothing to change.

## F2 — libc gating is ignored by Bun (packaging impact)

Empirical A/B on real packages: `bun add sharp@0.35.5` on this glibc machine installs
**both** `@img/sharp-linux-x64` (`libc: ["glibc"]`) **and** `@img/sharp-linuxmusl-x64`
(`libc: ["musl"]`); npm installs only the glibc one. `os`/`cpu` gating works in Bun;
`libc` does not. Consequence until Bun changes: Linux users of `@shzd/bun-geos` download
both the `-gnu` and `-musl` platform packages (~2× size for Linux only).

**Loader mitigation (verified available):** `process.report.getReport().header.glibcVersionRuntime`
→ `"2.44"` in Bun 1.4.3 — clean glibc detection in JS; pick the matching variant, keep the
runtime wrong-libc dlopen error (with remediation text) as backstop. Keep publishing `libc`
fields — npm users still benefit.

## F3 — `DT_RUNPATH` is not transitive (loader/packaging)

shim linked with `-Wl,-rpath,$ORIGIN/...` resolved its own `libgeos_c.so.1`, but
`libgeos_c`'s dependency `libgeos.so.3.14.1` was **not** found: RUNPATH only applies to the
owning object's direct dependencies. Two fixes, both verified:

- `-Wl,--disable-new-dtags` → `DT_RPATH`, which the loader consults for the whole chain (used for the shim); and
- baking `$ORIGIN` into the libs themselves via `-DCMAKE_INSTALL_RPATH='$ORIGIN'` (used for the install tree; CI packaging can use patchelf to the same effect).

A pure-JS fallback also works if ever needed: dlopen `libgeos.so.3.14.1` by absolute path
first; the later `libgeos_c` load resolves its NEEDED soname against the mapped library.

## F4 — JSCallback as GEOS handler demonstrably loses the message (D4 confirmed)

With a `JSCallback((fmt) => new CString(fmt))` installed via
`GEOSContext_setErrorHandler_r`, the JS side received **`"%s"`** — the format string, not
the message. GEOS internally invokes the old-style handler as `handler("%s", message)`, so
the text lives in the varargs, unreachable from a non-variadic JS callback (and the call
site is UB per C standard regardless). The shim's C-side `vsnprintf` captures the full text.
D4 is no longer just theoretical — it is empirically load-bearing.

## F5 — FFI coercion table (Bun 1.4.3, linux-x64)

- `i32/u32/i16` exact at boundaries (`INT32_MAX`, `UINT32_MAX`, ±`INT16_MAX/MIN`).
- `f64` bit-exact across 1e-300…1e300 and `2**53`; `NaN` round-trips.
- The #44906 class **does not reproduce**: a fractional JS number into an i32/u32-typed arg truncates C-style (`3.7 → 3`), never the reported silent `0`.
- Out-of-range wraparound documented (`2**31` into i32 → `-2147483648`) — GEOS u32 sizes stay within range in practice; keep them declared `u32`.
- `bool` round-trips.

**Carry-forward:** keep the per-Bun-release smoke test in CI (D1); the table in
`spike/ffi-values.test.ts` is the seed.

## F6 — FFI declaration gotchas (feed `src/symbols.ts`)

- `const char*` args must be declared **`cstring`** to accept JS strings; declared `ptr`, the engine rejects strings (`TypeError: To convert a string to a pointer…`).
- Failed `ptr` returns arrive as JS **`null`**, not `0` — all null-checks in TS must be `=== null`/falsy, never `=== 0`.
- `GEOSversion` is the one C API function with **no `_r` variant** (process-global, static string, nothing to free).
- Pointers are plain numbers (52-bit) as documented; storing them in typed arrays works.
- Bun quirk: `process.memoryUsage.rss` is a *function* (callable directly); use `process.memoryUsage().rss` for the Node-style call.

## F7 — `cc()`/TinyCC fallback is dead as designed

Bun's embedded TCC (`tinycc 05f0fafa`) rejects thread-local storage at runtime:
`error: thread-local storage is not supported at run time`. Thread-local error/notice
capture is load-bearing in the shim (per-worker contexts, D3), so the fallback cannot
compile the real shim on linux-x64. A `#ifdef SHIM_NO_TLS` variant (plain globals) could
serve single-threaded dev, but is not worth building: real-compiler iteration is one gcc
line and production is CI-prebuilt. **Decision:** drop cc() from the plan-of-record; dev
compiles with the system compiler via `spike/setup.sh` (Phase 1: a `bun run build:native` script).

## F8 — the wrapper-pointer lesson (our bug, caught by the soak process)

Passing the shim's `GeosShim*` wrapper where `GEOSContextHandle_t` was expected "worked"
for several calls (first 8 bytes happen to alias the ctx) and then segfaulted Bun with a
fixed bogus address. Real compilers and gdb masked it differently — the pure-C driver using
`s->ctx` was always correct. **Fix / rule:** the shim exposes `geos_shim_context()`; JS passes
that handle to every geos_c function and the wrapper only to `geos_shim_*` functions.
Phase 1 codifies this in the `Geos` class (one opaque handle, one place).

## F9 — `bun build --compile` + embedded `.so`

A `--compile` binary dlopens an embedded `.so` from `/$bunfs/root/values-*.so`: works,
runs from any cwd, load+call ≈ 0.1 ms. But each run **leaves `.bun-<uid>-<hash>.so` in
`$TMPDIR`** (full extraction; verified with a fresh `TMPDIR`) — #40076 live on 1.4.3.
Not load-bearing for our distribution model (users `bun add`; only user-compiled apps hit
this). Document per Bun version; re-verify each release.

## F10 — bun:ffi string-return semantics on engine-native Bun 1.4.x

Bun 1.4.0 rebuilt `bun:ffi` inside JavaScriptCore (the TinyCC thunks are gone
from the FFI call path; hot call sites JIT to direct native calls) and changed
string returns. Verified in `spike/cstring-semantics.test.ts` on 1.4.3:

- `returns: "cstring"` now yields a **plain string** — no `.ptr`,
  `.byteLength`, or `.arrayBuffer` — and a NULL return arrives as JS `null`
  (asserted via the shim's fresh-session `geos_shim_last_error`).
- **`cstring` on a GEOS-OWNED buffer leaks.** 6,000 `GEOSGeomToWKT_r` writes
  of a ~36 KB WKT grew RSS linearly at ~85 MB/epoch (257 MB total): the
  engine clones the text and can never call `GEOSFree`. The pre-1.4 escape
  hatch (reading `.ptr` off the returned `CString`) no longer exists.
- **The rule that does not leak:** bind the return `"ptr"`, view with
  `new CString(ptr)` (plain string; the C buffer is untouched), then
  `GEOSFree_r(ctx, ptr)` — RSS flatlined (0.3 MB/epoch after warmup).

**Binding rules for `src/symbols.ts`** (supersede the F6-era cstring-return
note):

1. `const char*` **args** → `cstring` (unchanged; auto UTF-8 encode).
2. Returns that need **no free** → `returns: "cstring"` (`GEOSversion`'s
   static string; the shim's thread-local `last_error`/`last_notice` buffers).
3. Returns **GEOS owns** (every writer: WKT/GeoJSON outputs) →
   `returns: "ptr"` + `CString` view + `GEOSFree_r` (modeled by `toWKT()`
   in `spike/lib.ts`).

The leak test is a guarded verdict: if a future Bun frees the buffer, the
test trips and rule 3 can be relaxed.

## Soak numbers

- 100,000 × (2 polygons built from flat buffers + intersection + ring copy-back + 3 destroys) in **0.66 s**.
- RSS: ~11–20 MB warmup (JIT + malloc arenas), then **0.0 MB/epoch** — no leak signature. Assertions: total growth < 150 MB; second-half growth ≤ first-half + 20 MB.
- Error-path soak: 1,000 consecutive malformed-WKT failures through the shim — every one thrown as `GeosError`, no degradation, valid ops unaffected afterwards.

## Environment pin for reproducibility

- GEOS **3.14.1** (tag), built Release, shared, `-DCMAKE_INSTALL_RPATH='$ORIGIN'`, gcc 16.2.1 / CMake 4.4.4 / ninja 1.13.2.
- Bun **1.4.3** (`bun test spike/` — 23 tests).
- Shim compile: `gcc -O2 -fPIC -shared -Wall -Wextra native/shim.c -o spike/build/shim.so -Lspike/build/geos-install/lib -lgeos_c -Wl,--disable-new-dtags -Wl,-rpath,'$ORIGIN/geos-install/lib'`.

## Carry-forwards into Phase 1

1. `native/shim.c` graduates as-is (66 lines: init/finish/context/last_error/last_notice, thread-local capture).
2. `src/symbols.ts`: cstring-decl rule for every `const char*` **arg**; owned-buffer
   returns bound `ptr` + `CString` view + `GEOSFree_r` (F10 — a cstring return leaks
   them); `GEOSversion` bound without `_r`; null-not-zero pointer checks.
3. Loader: prefer shim DT_RPATH; keep `BUN_GEOS_LIBRARY` escape hatch with the 3.14 assert; libc self-selection via `glibcVersionRuntime` (F2).
4. Packaging (Phase 4): keep `libc` fields (npm benefit), accept Bun's double download, CI bakes `$ORIGIN` RPATH into all three artifacts, link shim with `--disable-new-dtags`.
5. Drop cc() from the plan-of-record (F7); dev/native build script instead.
6. Tested pin: Bun 1.4.3 + GEOS 3.14.1; FFI smoke table gates every Bun bump.
