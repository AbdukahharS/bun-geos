# Decision Record

> Status: **living document**. Each decision records the context, the choice, and the
> consequences. Decisions are numbered and referenced across the docs (e.g. "D4").
> Made during project planning, October 2026.

---

## D1 — Bun-native, `bun:ffi`-based; no Node-API addon, no Node/browser support

**Context.** The three ways to call native code from Bun: `bun:ffi` (`dlopen` + symbol table),
a Node-API addon (`.node` file), or WASM. Bun's own docs flag `bun:ffi` as *experimental*
("do not rely on it in production") and recommend Node-API as the stable path.

**Decision.** Build directly on `bun:ffi`. Accept the experimental status — this package is
experimental too. No Node or browser compatibility targets, ever, for the foreseeable future.

**Consequences.**
- We can use Bun-only affordances throughout: `using` / `Symbol.dispose`, `import … with
  { type: "file" }` for shipping C source, Bun Workers, `Bun.$` build scripts, `bun test`.
- A Bun release can change `bun:ffi` behavior under us → mitigation: a tested-Bun-range pin
  in docs/CI plus FFI value-roundtrip smoke tests per Bun release
  ([testing](operations/testing.md)).
- The riskiest `bun:ffi` surfaces (callbacks, varargs, cross-thread `dlopen`) are engineered
  around rather than leaned on — see [bun-ffi research](research/bun-ffi.md) and the
  [shim design](design/shim.md).

## D2 — Bind to the GEOS C API only

**Context.** GEOS ships two APIs: a C++ API that "may change in every release" (their words),
and a C API (`geos_c.h`) with long-term API **and** ABI stability. Every mature binding
(Shapely, R `sf`, go-geos, LibGEOS.jl, php-geos) wraps the C API.

**Decision.** Bind exclusively to `libgeos_c` via `geos_c.h` declarations. Never touch the
C++ API, never link `libgeos` symbols directly from JS.

**Consequences.** We can swap GEOS binaries per release without rebuilding callers; symbol
decls in TS are stable across GEOS patch releases.

## D3 — Reentrant `_r` API only; one `GEOSContextHandle_t` per JS thread

**Context.** Every GEOS C function exists as `foo()` (process-global state) and
`foo_r(ctx, …)` (reentrant, thread-local state carried by the context handle).

**Decision.** Only `_r` functions are ever declared or called. One context per JS thread:
one on the main thread, one per Worker.

**Consequences.** Maps 1:1 onto Bun's worker model (each Worker is a separate JS thread);
no global init/finish (`initGEOS`/`finishGEOS` are never used); geometries are tied to their
creating context (see D11).

## D4 — A tiny C shim, precompiled in CI, shipped in the platform package

**Context.** Four things pure `bun:ffi` cannot do, or cannot do fast:
1. GEOS's error/notice handlers are **variadic** (`void(const char* fmt, ...)`) — variadic
   function pointers are inexpressible in `bun:ffi`; passing a non-variadic function where a
   variadic one is invoked is UB.
2. Building a polygon from JS costs 2–3 FFI calls **per ring**; 10⁵ rings = 10⁵⁺ crossings.
3. `GEOSSTRtree_query` invokes a callback per candidate hit — the least mature part of
   `bun:ffi`.
4. Arena-style bulk destruction needs a loop in C, not N round trips.

**Decision.** Ship `shim.c` (~300 lines) compiled by real clang/MSVC in CI, linked against
`libgeos_c`, delivered inside each platform package. ~~TinyCC's `cc()` (Bun's runtime C
compiler) is a **dev/fallback** path only~~ **Amendment (Phase 0 spike, Oct 2026):** the
cc()/TinyCC fallback is **dropped** — Bun's embedded TCC rejects `__thread` ("thread-local
storage is not supported at run time"), and thread-local error capture is load-bearing in
the shim (D3). Dev iteration compiles with the system compiler; production with CI clang/MSVC.

**Consequences.** Zero JSCallbacks and zero per-ring/per-item FFI crossings on hot paths;
production requires no runtime compiler; the native surface is one reviewable `.c` file.
Spike evidence: the pure-FFI JSCallback handler receives only the `"%s"` format string
(GEOS calls `handler("%s", message)`), making the shim empirically mandatory, not just
standard-compliant. See [shim design](design/shim.md) and
[spike results](research/spike-results.md) (F4, F7).

## D5 — Strict GEOS 3.14; no capability flags

**Context.** System GEOS versions range from 3.11 (Debian 12) to 3.14 (Homebrew). Feature
detection (capability flags) is the traditional answer — and a permanent tax on API and docs.

**Decision.** The package ships its own GEOS 3.14 build (D6). API surface = the 3.14 C API,
permanently. Users never see a GEOS version; GEOS upgrades ship as `@shzd/bun-geos` releases.
The only version logic is a load-time assertion (`GEOSversion()` starts with `3.14`).

**Consequences.** No `if (geos.supports.coverageClean)` anywhere; every bug report is
reproducible against one known binary; `CoverageClean`, prepared RelateNG, DBSCAN clustering
etc. are first-class API with no gating.

## D6 — Bundled prebuilt binaries (sharp / @swc / esbuild model)

**Context.** Strict 3.14 forces shipping binaries: no major distro ships GEOS 3.14, and
requiring a from-source GEOS build makes the package unusable.

**Decision.** CI builds GEOS 3.14 per platform; each binary set publishes as its own npm
package selected at install time via `optionalDependencies` + `os`/`cpu`/`libc` fields.
System lib is an opt-in escape hatch only (`BUN_GEOS_LIBRARY`), with the same hard version
assert (D8).

**Consequences.** `bun add` works everywhere with zero external steps; cost is release
engineering (a 7-artifact build matrix) and ~4–8 MB per install. **Amendment (Phase 0
spike):** Bun's installer ignores the `libc` field (verified: `bun add sharp` installs both
glibc and musl variants where npm installs one). Keep publishing `libc` fields — npm users
still get single-variant installs — but Bun users on Linux download both; the loader
self-selects via `process.report.getReport().header.glibcVersionRuntime` (verified working
in Bun 1.4.3). See [packaging](operations/packaging.md) and
[spike results](research/spike-results.md) (F2).

## D7 — All 8 packages live in the `@shzd` scope

**Context.** npm package names are exactly two segments (`@scope/name`); paths like
`@shzd/bun-geos/linux-x64-gnu` are not publishable. Platform binaries are *sibling packages*.
Precedents: `@swc/core` → `@swc/core-linux-x64-gnu` (same scope); esbuild/sharp use separate
orgs (a choice, not a requirement).

**Decision.** `@shzd/bun-geos` plus
`@shzd/bun-geos-{darwin-arm64, darwin-x64, linux-arm64-gnu, linux-arm64-musl,
linux-x64-gnu, linux-x64-musl, win32-x64}`.

**Consequences.** 8 packages, 1 scope, 0 new orgs, 1 npm token. Publishing requires
`publishConfig.access: "public"` on all of them (scoped packages are private-by-default).

## D8 — System library = opt-in escape hatch only

**Decision.** `BUN_GEOS_LIBRARY=/path/to/libgeos_c.so` overrides the bundled binary for
exotic platforms and debugging. The loader asserts the loaded library is GEOS 3.14.x
regardless of origin; a mismatch is a hard error with a clear message.

**Consequences.** Unsupported-but-possible path; no compatibility promises against system
GEOS; support issues pointing at the env var get one standard answer.

## D9 — I/O layering: GeoJSON ergonomic-first; WKB and GeoArrow first-class; flat buffers canonical

**Context.** GEOS's `CoordSeq_copyFromBuffer/copyToBuffer` consume/produce flat
interleaved `double` buffers — which is also the GeoArrow layout. Shapely's decade-long
lesson: per-call overhead dominates, so the canonical representation must minimize FFI
crossings.

**Decision.** Internal/bulk currency = flat `Float64Array` coordinates + offset arrays.
GeoJSON conversion happens JS-side (for precise error messages), WKB uses the native
readers/writers, GeoArrow is near zero-copy in both directions.

**Consequences.** Batch ops speak Arrow-shaped buffers natively; GeoJSON and WKB become
thin adapters. See [I/O design](design/io.md).

## D10 — Explicit disposal primary (`using`, arenas); FinalizationRegistry backstop only

**Context.** The C heap is invisible to the JS GC (the go-geos author documents this
explicitly for Go's runtime): a million live geometries exert zero GC pressure because the
JS wrapper objects are tiny. Finalizers are also fragile during teardown.

**Decision.** Primary discipline: `Symbol.dispose` / `using` on geometries and contexts;
`geos.arena()` for hot loops (bulk destroy via the shim's `destroy_many`). A
FinalizationRegistry exists solely to reclaim leaked geometries, never relied upon in normal
operation. Per-context C-heap accounting makes the invisible heap visible.

## D11 — Workers with per-worker contexts; preload on main thread; no cross-worker geometry sharing

**Context.** GEOS context state is thread-local (D3). Concurrent `dlopen` from freshly
spawned Workers has caused intermittent SIGSEGVs in Bun
([oven-sh/bun#40972](https://github.com/oven-sh/bun/issues/40972)).

**Decision.** One `Geos` instance (context) per Worker; the native library is loaded on the
main thread before workers spawn; `Geometry` objects never cross worker boundaries — WKB or
GeoJSON copies do. Long operations run on workers; cooperative cancellation via
`GEOSInterruptCallback` wired to `AbortSignal`.

**Consequences.** Deterministic memory model; predictable event-loop behavior; see
[concurrency design](design/concurrency.md).

## D12 — LGPL compliance via dynamic linking; never static-link GEOS

**Context.** GEOS is LGPL-2.1+. Static linking would trigger LGPL §6 obligations (object
files / relinkability) for zero technical benefit — the C shim is tiny and the heavy code is
GEOS's own compiled units.

**Decision.** Platform packages ship unmodified, dynamically-linked GEOS binaries plus the
license text and source link. This is the same model as Shapely's wheels, geos-wasm, and
Julia's GEOS_jll. `@shzd/bun-geos`'s own code is MIT (planned).

**Consequences.** Legally boring; see [licensing](operations/licensing.md).

## D13 — Error model: throw on invalid API use; typed errors for bad data and GEOS failures

**Context.** The C API signals errors by returning `NULL`/`0` after invoking the message
handler; input-data errors (malformed WKB, ring with 2 vertices) and programming errors
(cross-context destroy) want different ergonomics.

**Decision.** Programming errors → `TypeError`/`RangeError`-class throws. Data/GEOS errors →
`GeosError` carrying: the captured GEOS message, the operation name, and (for repair paths)
`isValidReasons` / `isSimpleDetail` diagnostics. Parsing failures return thrown `GeosError`
with JS-side context ("ring 2, vertex 17: expected 2 ordinates, got 3") because conversion
happens in JS (D9).

## D14 — Name: `bun-geos`, published as `@shzd/bun-geos`

Confirmed by the maintainer. Platform packages per D7.

## D15 — Toolchain: Biome lint/format; tsc as the type gate; branded pointer handles

**Context.** Phase 0 proved the FFI + shim model ([spike results](research/spike-results.md)).
The observed failure modes are runtime-level — pointer misuse (the `GeosShim*`-as-context
segfault, F8), silent coercions, leaked temporaries — and are invisible to syntactic
linters. The repo needs enforcement that scales from one file to the Phase 1 layout
without a heavy toolchain.

**Decision.**
1. **Biome** (single Rust binary) is the linter, formatter, and import organizer
   (`biome.jsonc`). No ESLint, no Prettier. `noExplicitAny: error`; type-aware rules
   (`noFloatingPromises` et al.) enabled; `noNonNullAssertion: warn` — FFI out-params
   legitimately use `!` under `noUncheckedIndexedAccess`, so it stays visible-but-passing.
2. **tsc (`bun check`) remains the type gate.** Beyond `strict` +
   `noUncheckedIndexedAccess` + `verbatimModuleSyntax`: `exactOptionalPropertyTypes`,
   `noUncheckedSideEffectImports`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
   `forceConsistentCasingInFileNames`.
3. **Branded pointer handles (Phase 1 code, codifying F8):** `GEOSContextHandle_t`,
   `GeosShim*`, and `GEOSGeometry*` are distinct branded `number` types in TS
   (`type GeosCtx = number & { readonly __brand: "ctx" }` …), so passing one where another
   belongs is a **compile error**, and the FFI symbol table is `satisfies`-checked against
   the geos_c signature map.

**Consequences.** Zero `any` in the codebase; formatting is mechanical; CI gates lint +
types + native spike tests on every push (single ubuntu job — the 7-platform matrix stays
Phase 4). If a floating-promise class of bug ever escapes Biome's type-aware rules,
typescript-eslint is added for that rule only — not as a second formatter or default
linter.

---

## Open design work (tracked, not yet decided in detail)

1. **Shim symbol list + C source sketch** — exact function set, thread-local layout.
2. **Worker ownership rules** — `parallel()` chunking semantics, AbortSignal plumbing.
3. **CI build matrix runbook** — per-platform flags, stripping, packaging, provenance.
4. **Full API reference draft** — JS API ↔ `geos_c` symbol mapping table.
