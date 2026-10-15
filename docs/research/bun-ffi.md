# Research: `bun:ffi` deep dive

> Status: reference, verified against Bun's official docs (runtime/ffi, runtime/c-compiler,
> runtime/node-api) and the oven-sh/bun issue tracker, October 2026 (Bun 1.4.x era).
> This page is the factual basis for D1 and the [shim design](../design/shim.md).

## 1. What it is and how it's fast

`bun:ffi` loads shared libraries (`dlopen`) and binds C-ABI functions with a declared
symbol table. The implementation is **in-engine**: JavaScriptCore natively implements
`dlopen`, `linkSymbols`, `CFunction`, and `JSCallback`; argument conversion, arity handling,
and result boxing happen inside the engine, and hot call sites compile through the DFG/FTL
JIT tiers into **direct native calls with no per-argument JS shim**.

Bun's published benchmark: **roughly 2–6× faster than Node.js FFI through Node-API.**
Since 1.4.0 the FFI is engine-native end to end (the embedded TinyCC's role is reduced
to `cc()` runtime compilation — the FFI call path no longer touches it), with its own
published numbers: no-op call 2.13 → **0.70 ns** (3×), `new CString(ptr)` 92.5 →
**24.1 ns** (3.8×).

Why this matters less than it seems for GEOS: GEOS operations are coarse-grained (µs to ms
each). The FFI tax only matters *per-coordinate* and *per-item* — which is exactly what the
shim + flat-buffer design eliminates. The numbers above are headroom, not the product.

## 2. API surface relevant to GEOS

### dlopen + symbol table

```ts
import { dlopen, FFIType, suffix } from "bun:ffi";

const lib = dlopen("/path/libgeos_c.so", {
  GEOSIntersection_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
});
lib.symbols.GEOSIntersection_r(ctx, a, b);
```

Supported `FFIType`s (subset we need): `ptr` (aliases `pointer`, `void*`, `char*`),
`buffer` (must be TypedArray/DataView), `cstring`, `f64`, `i32`, `u32`, `usize`/`u64`
(arrives as BigInt — avoid on hot paths), `bool`, `function`, plus `buffer_length`
(a "length twin" arg filled from the same TypedArray atomically — engine-native only).
Structs are **not** supported — irrelevant for GEOS, whose C API is opaque pointers +
doubles + ints + strings. This alignment is not an accident of luck; it's the main reason
`bun:ffi` + GEOS is a good fit.

### Pointers are numbers

Pointers are plain JS **numbers** (52-bit address space fits comfortably in float64; Bun
deliberately avoids BigInt on this path because BigInts allocate). A `GEOSGeometry*` is a
number — cheap to store in Maps, typed arrays, and wrapper objects. Windows `HANDLE`s are
the documented exception (use `u64`) — not applicable to GEOS.

### TypedArray ↔ pointer interop (the core of our marshaling)

- Passing a `TypedArray` where a `ptr`/`buffer` arg is declared passes **its memory
  directly** — zero copy.
- `buffer_length` args receive the paired view's byte length atomically at call time.
- `toArrayBuffer(ptr, byteOffset, byteLength)` wraps foreign memory (optional deleter
  callback; may run on a GC thread — must not re-enter JS).
- `read.f64(ptr, offset)` etc. for cheap scalar peeks without building a DataView.
- **Memory is not managed**: every allocation GEOS makes must be explicitly freed
  (`GEOSGeom_destroy`, `GEOSFree`) — see [memory design](../design/memory.md).

### Strings

- `cstring` **args** accept JS strings directly; the engine transcodes to null-terminated
  UTF-8 for the duration of the call (WKT input in one line, no manual encode).
- `cstring` **returns** give a plain JS string; a NULL pointer arrives as `null`.
  **Owned-buffer trap (F10, verified):** the engine clones the text and has no way to
  call `GEOSFree`, so a cstring return on a GEOS-owned buffer **leaks** it — and the
  pre-1.4 `.ptr` escape hatch is gone. Every writer return must be bound
  `returns: "ptr"`, viewed with `new CString(ptr)`, and freed with `GEOSFree_r`
  (modeled by `toWKT()` in `spike/lib.ts`; guarded by
  `spike/cstring-semantics.test.ts`). `cstring` returns are only for strings that need
  no free at all: `GEOSversion`'s static, the shim's thread-local buffers.
- `new CString(ptr)` is the ptr→string view; on 1.4 it returns a plain string (no
  `.ptr`/`.byteLength`/`.arrayBuffer`) — keep the original pointer to free it.

### Callbacks — `JSCallback`

```ts
const cb = new JSCallback((ptr, len) => { /* … */ }, { returns: "bool", args: ["ptr", "usize"] });
// … later, mandatory: cb.close();
```

- Must be `.close()`d; there are long-standing sharp edges (allocation, re-entrancy).
- Experimental `threadsafe: true` exists for callbacks invoked from foreign threads;
  the C side must then treat the return as `void`.
- **Our policy:** JSCallback is allowed only for signatures that are genuinely simple and
  rare (the `GEOSInterruptCallback` idea — `void(void)`). Everything on hot paths uses the
  shim instead (D4). This is the single most important bun:ffi discipline in the project.
- **Variadic callbacks are impossible** — and GEOS's error/notice handlers are variadic.
  See [shim](../design/shim.md).

### `cc()` — Bun embeds TinyCC

`cc({ source, symbols, library, flags, define })` compiles C at runtime (Bun embeds
TinyCC), links external libraries by name, and can even take `napi_env`/`napi_value` for
raw JS-value interop. Notable: `--no-ffi-cc` / `--no-addons` disable it; Workers inherit
the setting.

**Update (Phase 0 spike): this path is dead for the shim.** Bun 1.4.3's embedded TCC
(`tinycc 05f0fafa`) rejects `__thread` — "thread-local storage is not supported at run
time" — and thread-local error capture is load-bearing in the shim (D3). Verified
empirically; see [spike results](spike-results.md) (F7). Dev iteration uses the system
compiler (one gcc line); production is CI-prebuilt.

## 3. Maturity assessment

The docs banner is unambiguous (Oct 2026):

> `bun:ffi` is **experimental**, with known bugs and limitations. Do not rely on it in
> production. The most stable way to interact with native code from Bun is to write a
> Node-API module.

We are consciously declining that advice (D1: Bun-native, experimental package). What
matters is *where* the risk actually lives. Issue search shows ~200 open `bun:ffi`-related
issues; the relevant clusters:

| Risk | Evidence | Our mitigation |
|------|----------|----------------|
| Variadic callbacks impossible; non-variadic fn in a variadic call is UB | GEOS handler signature vs FFI type set | C shim installs the handlers (D4) |
| Fresh JSCallback sharp edges (must `.close()`, re-entrancy) | Tracker cluster | No callbacks on hot paths; shim result buffers |
| **Concurrent `dlopen()` from freshly-spawned Workers → intermittent SIGSEGV** | [#40972](https://github.com/oven-sh/bun/issues/40972) (closed 2026-08) | Preload on the main thread before spawning workers (D11) |
| Type coercion bugs still being filed | [#44906](https://github.com/oven-sh/bun/issues/44906) (2026-10: a double passed to an i32/u32/i16 arg arrives as 0) | FFI value-roundtrip smoke tests per Bun release in CI. **Phase 0:** bug does not reproduce on 1.4.3 — fractional values truncate C-style, boundaries exact (`spike/ffi-values.test.ts` is the CI seed) |
| `cstring` return on an owned buffer leaks (1.4 engine FFI — the engine cannot call `GEOSFree`) | Verified: ~85 MB/epoch RSS growth over WKT writes ([spike results F10](spike-results.md)) | Owned returns bound `ptr` + `CString` + `GEOSFree_r`; verdict test in CI |
| `dlopen()` throws `TypeError` when the JIT is disabled (1.4+) | Docs | Loader surfaces a remediation message ([architecture §loader](../design/architecture.md)) |
| `bun build --compile` + embedded native libs: re-extraction every run / TMPDIR leaks | [#44238](https://github.com/oven-sh/bun/issues/44238), [#40076](https://github.com/oven-sh/bun/issues/40076) | **Phase 0 tested on 1.4.3:** works — dlopens via `$bunfs`, ~0.1 ms load; but leaks one `.bun-*.so` in `$TMPDIR` per run (#40076 live). Only affects user-compiled apps; re-verify per Bun release |
| ~~`cc()` can be disabled (`--no-ffi-cc`, `--no-addons`)~~ | Docs | Moot — the cc() fallback is dropped entirely (TCC cannot compile the shim's `__thread` usage) |
| `AsyncFunction` (threadpool FFI calls) absent from current docs | Docs | Don't build on it — concurrency comes from Workers (D11) |
| A stable successor may exist someday | Proposal [#40331](https://github.com/oven-sh/bun/issues/40331) ("Bun.TypedFunction") | Watch; not load-bearing |

### What is genuinely solid

Plain synchronous calls — `dlopen` + declared symbols + numeric/pointer/typed-array args —
are the mature 80%, and they are *exactly* the surface a shim-centric architecture uses.
The immature parts (callbacks, cross-thread `dlopen`, exotic coercions) are all avoidable
**by design**, not by vigilance.

## 4. Verdict

Green light for a Bun-first experimental library, with the risk concentrated in four known
spots, each with a structural mitigation:

1. variadic handlers → C shim
2. callbacks on hot paths → banned; shim buffers instead
3. worker `dlopen` races → main-thread preload
4. coercion regressions → CI roundtrip tests per Bun release

If Bun ever makes Node-API the *only* stable path (i.e., deprecates `bun:ffi` entirely),
the shim + symbol-table design ports to a NAPI addon with the C code unchanged — the
architecture deliberately keeps that door open.
