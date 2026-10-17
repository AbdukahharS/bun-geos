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
**Phase 4 amendment (portability):** the shim builds under GCC/Clang AND MSVC —
`SHIM_TLS` macro (`__declspec(thread)` on MSVC; the TCC lesson generalizes: there is no
TLS-free build), pre-C11 volatile atomics forced on `_MSC_VER` (its `<stdatomic.h>` is
incomplete), and Windows exports via `native/shim.def` (MSVC exports nothing by default;
LoadLibrary/GetProcAddress see only listed symbols) — sync-checked on every platform build
so drift never reaches the Windows job.

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
**Phase 4 amendment (Windows):** DLL dependency resolution is preload-based there — the
Windows search path excludes a loaded DLL's own directory, so the loader dlopens
`geos.dll` → `geos_c.dll` → `shim.dll` by absolute path and the later loads bind their NEEDED
names against already-mapped modules (the F3 pure-JS fallback generalized; tested by the
win32 platform smoke). `BUN_GEOS_PACKAGE_DIR` additionally overrides platform-package
resolution so the smoke can load the STAGED package before it exists on any registry.

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

## D16 — STRtree items are integer ids; `nearest` goes through a shim distance table

**Context.** The tree stores items as `void*`. Query/iterate only hand items
back, but **`GEOSSTRtree_nearest` casts stored items to `GEOSGeometry*` to
compute distances** (verified in geos_ts_c.cpp: it delegates to
`nearest_generic` with `GeometryDistance`, which dereferences items). With the
documented id-items design that is a wild-pointer deref; with pointer items it
works but puts per-candidate ptr→id mapping into JS and dangles if the tree
outlives a geometry.

**Decision.** Items stay integer ids, stored **1-BASED**
(`(void*)(intptr_t)(id + 1)`): `GEOSSTRtree_nearest_generic_r` returns the
stored item, so a 0-valued item would be indistinguishable from its NULL
"no answer" return — `nearest()` would misreport `-1` whenever item 0 was
the true nearest (audited blocker, pinned by a dedicated test). The shim
decodes `(item − 1)` at its three decode sites. `nearest()` calls
`GEOSSTRtree_nearest_generic_r` with a **shim-provided C distance callback**
(C-to-C — still zero JSCallbacks) over an id→geometry table the shim copies at
`build()` time (`geos_shim_strtree_bind_geoms`); the sentinel id `-1` maps to
the query geometry. The tree freezes at `build()` so the bound table stays in
sync. Liveness: the wrapper holds STRONG JS references to indexed geometries
and pins them (D17), so the C tree can never dangle; `tree.dispose()` releases
the pins. `GEOSSTRtree_remove_r`/`iterate_r` stay unbound (not in the API
surface).

**Consequences.** `query()` returns `Int32Array` ids with zero JS
post-processing; `nearest()` is one crossing. Benchmark: 122× over a naive JS
envelope scan (100k items × 1k queries). Removing an item requires a rebuild
(documented).

## D17 — Consumer pins: Prepared/STRtree take ownership-grade references

**Context.** `GEOSPrepare` documents "destroy the prepared geometry first, as
it has an internal reference to the base geometry". Two Phase 1 mechanisms
would silently violate this: `Geometry.dispose()` on a prepared/indexed
geometry, and arena teardown (`destroy_many` bypasses `dispose()` entirely).

**Decision.** `Geometry` carries a consumer set. `prepare()`/`tree.insert()`
register a consumer pin and **relinquish the geometry from any open arena**
(it becomes individually owned by the caller — the arena would have freed it
under the consumer). `dispose()` while pinned throws `TypeError` with
remediation text; `renounce()` refuses too. `Prepared`/`STRtree` register with
their `Geos` as *consumables*: `Geos[Symbol.dispose]` disposes them first
(releasing the pins), then bulk-destroys remaining geometries.

**Consequences.** Disposal order is enforced, not documented-and-hoped. An
arena-born geometry that was prepared survives arena exit by design (the
caller owns it afterwards).

## D18 — Batch masks are one shim crossing; first exception aborts, no partial masks

**Context.** `prep.intersectsAll(...)` as a JS loop over singulars pays
per-call FFI overhead and violates the batch-first principle (architecture.md
§3); but RelateNG prepared singulars are so fast (~50ns/call for points) that
batching only pays off when the per-item GEOS work is heavier or the input is
structured.

**Decision.** `*All` masks run as ONE shim call
(`geos_shim_prepared_pred_all` — predicate id switch in C, `Uint8Array` out)
that checks the atomic interrupt flag between items. The first GEOS exception
(char result 2) aborts the whole call — masks are all-or-nothing. Return
codes: 0 ok, 1 exception (message captured), 2 interrupted.

**Consequences.** Benchmarks show prepared singulars already beat unprepared
by ~32×; batch wins when the GEOS work per item is larger than the FFI
crossing (complex geometries) — the honest numbers live in `bench/results.json`.

## D19 — Interrupt: atomic global flag; same-thread sync calls cannot be interrupted mid-flight

**Context.** 3.14 offers per-context `GEOSContext_setInterruptCallback_r`. But
a synchronous FFI call **blocks the JS thread**, so an `AbortSignal` listener
on the calling thread can never fire during the call — including the
`setTimeout` that would flip the flag. The concurrency doc's original
"main-thread, still cancellable" model was wrong.

**Decision.** The shim keeps an **atomic process-global** `g_interrupt` (C11
`atomic_int`, volatile fallback pre-C11), read by the per-context callback
installed once at `geos_shim_init`. `geos_shim_interrupt_request/reset` are
thread-safe. `withSignal` (src/interrupt.ts) gives every op: pre-check,
listener→flag, reset in `finally`, and — on failure — `GeosError(op
"aborted", cause = signal.reason)`, also recognizing a cross-thread flip via
GEOS's `InterruptedException` message. **Honest limitation, documented in
concurrency.md:** mid-flight cancellation of a main-thread sync op requires
flipping the flag from another thread (Worker) — the abort schedule must live
on that thread. The ergonomic path is Phase 3 `parallel.*` (op on a Worker;
main thread stays free to run the listener and message the Worker).

**Consequences.** Verified end-to-end: a Worker flipping at t=40ms aborts a
~300ms main-thread buffer at t≈40ms; the flag resets in `finally` so the
context stays healthy. A stale flip between ops is also reset (hygiene rule:
`reset` runs after every signal-taking op). Interrupt error shape is UNIFORM
across singular and batch paths when a signal was supplied (op `"aborted"`,
the underlying `GeosError` as `cause`). Known limit (documented, Phase 3
concern): the flag is process-global, so two ops running concurrently on
DIFFERENT threads can erase each other's interrupt requests in their
`finally` resets — within one thread ops are sequential, and the Phase 3
worker pool will partition flag ownership by design.

## D20 — `unionAll` dispatch lives in the shim; `auto` validates before CoverageUnion

**Context.** `GEOSCoverageUnion_r` on a non-coverage does not error — it
returns a WRONG geometry. `GEOSDisjointSubsetUnion_r` is correct for arbitrary
inputs. The clone loop and temp collection are ownership-tricky and
loop-shaped (shim territory, shim.md §3).

**Decision.** One shim call `geos_shim_union_all(parts, n, strategy)`:
clone → temp GEOMETRYCOLLECTION → dispatch → result, temp always destroyed,
inputs never consumed, `n == 1` is a clone (identity). Strategies: `auto` =
`GEOSCoverageIsValid_r(gap 0)` first — valid ⇒ CoverageUnion; invalid OR
exception (non-polygonal) ⇒ DisjointSubsetUnion; `coverage` = validate then
union (rejection carries a remediation message); `disjointSubset`/`unary` are
direct. Raw `geos.coverageUnion()` skips validation — documented
caller-asserts fast path.

**Consequences.** Two crossings regardless of input size (architecture.md §4).
On a 961-tile aligned coverage: coverage 4.0ms vs unary 9.3ms (GEOS's own
scaling; the gap widens with n). The ladder is in `bench/results.json`.

## D21 — Coverage ops: `Geometry[]` in via shim clone-collect; owned clones out; diagnostics are strings

**Context.** The coverage C entries take ONE collection geometry and return a
collection (or aligned error-edge collection). Returning members as borrowed
views would need a strongly-reachable parent collection — impossible to
promise with the WeakRef-view design (a GC'd parent makes views silently
unsafe, the H1 audit hole). Attaching location geometries to thrown
`GeosError`s would put C resources inside exceptions — a disposal footgun.

**Decision.** Coverage ops accept `Geometry[]`, normalized through
`geos_shim_clone_collect` (one crossing; the collection consumes the clones).
Outputs are cloned out (`geos_shim_clone_members`) as OWNED registered
geometries. Temporary collections are destroyed via `Geos.destroyRaw` (the
sanctioned unregistered-temporary path). Repair diagnostics attached to
errors are STRINGS ONLY (`GeosErrorDiagnostics`: reason + location WKT) —
RESERVED: no Phase 2 throw site populates it; the public diagnostics API is
`isValidDetail()`/`isSimpleDetail()` (owned location geometry). Public
`isValidDetail()`/`isSimpleDetail()` hand out the location as an owned
geometry for callers who want it. `GEOSMakeValidParams`/
`GEOSCoverageCleanParams` are pooled per `Geos` — and **ALL values are
re-set on EVERY call** (omitted options reset to the documented defaults;
audited stale-pool bug where only provided options were written, leaking a
previous call's method/strategy into a later options-less call).
`GEOSOrientPolygons_r` mutates in place, so the wrapper clones first: user
input is never mutated. Note: `GEOSOrientPolygons_r` is an INT return (0 ok,
-1 failure) — no 0xff masking.

**Consequences.** Borrowed-view hazards cannot arise from coverage ops; one
extra clone per output member is the cost (bulk-cloneable in Phase 3 if it
ever shows in profiles).

---

## D22 — Batch op layer: one shim call per array, opId tables, all-or-nothing; the ≥5× axis moved to the pool

**Context.** ROADMAP Phase 3: "many-geometry overlay/predicate loops executed
in C (one FFI call per array — the literal Shapely-2.0 lesson)". The D18
prepared-mask machinery proved the pattern; Phase 3 generalizes it to overlay,
unprepared predicates, measures, buffer, batch WKB read, bulk Arrow builders,
and chunk weights.

**Decision.** A uniform `geos_shim_*_all` surface following D18 exactly: JS
passes a pointer array + a preallocated output array; the C loop checks the
atomic interrupt flag between items; first GEOS exception aborts the whole
call and **destroys partial C outputs before returning** (`0 ok / 1 exception
/ 2 interrupted`). Op-id tables (`SHIM_OVERLAY_*`/`SHIM_PRED_*`/
`SHIM_MEASURE_*`) mirror `OverlayOp`/`UnpreparedPred`/`MeasureOp` in
`src/types.ts` and are pinned by known-answer selftests (the `PreparedPred`
discipline). Batch inputs accept `Geometry[]` **or** Arrow-shaped values —
Arrow normalizes through bulk polygon/linestring builders. Arena handoff
(audited twice — the second audit caught the pool's async half): the SYNC
layer's `withBatchInputs` captures the caller's arena BEFORE opening the
transient one; the POOL's `withBatchInputsAsync` goes further and runs its
input arena **UNPUSHED** (explicit registration, never on the `currentArena`
stack), so nested main-API calls inside the pool cannot capture it, and
result materialization happens only after it closes. `Geos.takeMany` wraps n
owned pointers with full registration (stats + arena + finalization
backstop). There is deliberately NO element-wise `unionAll(a, bs)` — the
name is the Phase 2 aggregate (D20).

**Consequences — measured, and honestly stated.** Bun 1.4.x's engine-native
FFI makes per-object calls cheap (~tens of ns), so on THIS Bun the main-thread
batch paths converge toward GEOS's own per-item cost: ~1× on overlay workloads
(GEOS-bound; wrapper construction remains in both paths), 0.8–1.2× on
masks/measures (the singular path is already near-optimal). The batch layer's
measured ≥5× axis is the **worker pool** (D23): `parallel makeValid` at 10⁵
geometries measures ~3.9–5× over per-object calls across runs (best-of-3;
concurrency 12 + chunkFactor 3) — the ratio is bounded by main-thread WKB
serialization of the inputs, which pipelining reduces but cannot eliminate;
per-workload numbers live in `bench/results.json` + `docs/benchmarks.md`. The
one-crossing property stays load-bearing for: between-item interrupt
granularity, all-or-nothing error contracts, and future Bun versions where
per-call costs regress.

## D23 — `geos.parallel`: lazily-spawned worker pool, WKB transfer currency, chunk-by-cumulative-vertex-count, single-flight interrupt rule

**Context.** decisions.md open item #1 ("worker ownership rules —
`parallel()` chunking semantics, AbortSignal plumbing") and the D19 known
limit (process-global interrupt flag; concurrent flag-taking ops erase each
other's resets).

**Decision.**
1. **Pool**: lazily spawned on first `geos.parallel` use — after the main
   thread has loaded the libraries (D11 by construction). Size =
   `clamp(hardwareConcurrency − 1, 1, 8)` (`concurrency` option). Each Worker
   owns exactly one `Geos` (D3). The pool is a consumable: context dispose
   shuts it down via a **shutdown-ack protocol** (ack before terminate — a
   terminated worker skips its Geos disposal and leaks the C session; the
   interrupt-worker lesson promoted to the protocol).
2. **Transfer currency = WKB**: geometries never cross (D11). Chunks go out
   as one WKB buffer + byte offsets via postMessage **transfer lists**;
   geometry results come back the same way and re-read with one
   `fromWKBMany` crossing. Masks/measures cross as typed arrays.
3. **Chunking** (concurrency.md §4's TBD, now decided): weights from ONE
   `geos_shim_num_points_many` crossing (type-generic vertex counts — the C
   API's `GEOSGeomGetNumPoints_r` is linestring-only AND throws on points
   (SimpleCurve cast), so the shim sums polygon rings, recurses into
   collections, and counts points as 0/1 — all in C); cuts in **input order**
   by cumulative vertex count, ~`chunkFactor × workers` chunks (default 2),
   floor `minChunkGeoms` (default 64). Below `minChunkGeoms × 2` items the op
   runs on the calling thread — pool overhead dominates small batches.
   Results reassemble in input order (documented determinism).
4. **Interrupt partition** (fixes the D19 known limit, within its documented
   bounds): the op runs on workers, so the MAIN thread stays free — its
   abort listener flips the shim's atomic global flag directly, GEOS sees it
   inside the workers' C loops, and the pool resets the flag in `finally`
   (uniform `op: "aborted"` shape, D19 contract). The rule that makes the
   global flag safe: **at most ONE signal-taking parallel op in flight per
   pool** (others queue); ops without a signal bypass the gate. HONEST
   BOUNDS (audit): the flag is still process-global — a concurrent
   no-signal pool op's workers READ the same flag, so a foreign abort can
   fail their in-flight chunks too, and a concurrent main-thread
   `withSignal` op can re-shape a foreign `Interrupted!` as its own. The
   partition fixes the flag-ERASURE race (reset vs request); it cannot
   isolate readers. Hosts needing hard isolation run one pool per process.
5. **Failure aggregation**: all-or-nothing (D18/D22) — every chunk failure is
   collected (`Promise.allSettled`) and the op rejects with one
   `GeosParallelError` carrying per-chunk STRING diagnostics (D21).
6. **Determinism**: `parallel.unionAll` = per-chunk `unionAll(strategy)` +
   ONE final `unionAll(disjointSubset)` on the calling thread — a valid union,
   but bitwise identity with the main-thread result is NOT guaranteed for
   chunks > 1 (union is order-sensitive at float level).
7. **Engine-flake defenses** (measured on Bun 1.4.3): worker child processes
   can die pre-handshake with no parent-side signal, and dispatch from a
   large fragmented heap can deadlock the parent in an engine-internal futex
   wait (main thread blocked in native code — no JS watchdog can fire).
   Library defenses: `error` AND `exit` handlers reap dead workers;
   startup + job watchdogs (`jobTimeoutMs`, default 120s) terminate and
   fail loudly; long-running hosts should keep heavy churn off the pool
   path or run pool work in dedicated processes (the bench harness does
   exactly that — `bench/parallel.ts`). Re-verify on every Bun bump
   (the FFI smoke-test gate).

## D24 — Memory accounting: data-derived `statsPrecise()`, arena high-water marks, CI leak soak

**Context.** memory.md §5 promised "counters fed by the shim (create/destroy
hooks)" — but routing every create/destroy through the shim would change the
architecture (all `geos_c` calls would need shim wrappers). Rejected.

**Decision.** Keep `geos.stats` a cheap JS-side counting surface (floor byte
estimate = liveGeoms × 64). Add:
1. `geos.statsPrecise()` — ONE shim crossing (`geos_shim_heap_bytes`) over
   the live pointer set: per geometry 64 bytes + vertices × coordinate
   dimension × 8. Data-derived, still documented approximate (M ordinates
   are not per-geometry detectable on the C API).
2. `GeosStats.arenaHighWater` — max geometries under open arenas at any one
   time.
3. The long-run soak (`SOAK_SCALE=large`, `bun run test:soak`, nightly CI):
   batch-op arena churn + parallel-pool ops must return stats/`statsPrecise`
   to baseline with RSS bounded (testing.md §3 thresholds).

## D25 — Benchmarks: seeded generators, machine metadata, published results

**Decision.** Shared seeded generators (`bench/lib/gen.ts`) so every engine
measures identical inputs; results.json schema v2 carries machine metadata
(CPU model, Bun + GEOS versions, hw threads, commit); `bench:report` renders
`docs/benchmarks.md`; competitor adapters (`geos-wasm`/`turf`/
`polygon-clipping`) are optional devDependencies behind
`bench/competitors/run.ts` with runtime API checks — skipped, never failing,
when not installed; Shapely 2 stays a conceptual baseline. The parallel-pool
suite runs as its own process (`bench/parallel.ts`) — isolation is both the
D23 engine-flake workaround and better methodology. Positioning rule
unchanged: robust overlays, repair, indexed/batched workloads only.

---

## D26 — Stage-and-publish; raw TS source ships; token auth now, trusted publishing later

**Context.** Phase 4 needs a publish model for 8 packages (D6/D7) with three
constraints: dev and CI keep working unchanged; releases must not require
version-bump commits; and the published runtime must be exactly the tested
bytes (the whole Phase-4 gate philosophy smokes the staged package on every
runner before anything publishes).

**Decision.**
1. **Stage-and-publish** (esbuild precedent): the repo manifest stays
   `private: true` with the lockstep `version` as the single source; the
   release scripts (`scripts/package-platform.ts` / `package-main.ts`)
   generate all 8 publish trees under gitignored `packages/`, and
   `scripts/release.ts` publishes from there. The staged MAIN manifest
   drops `private` and the typescript peerDep (consumers bring their own
   TS) and gains `publishConfig.access: "public"` plus exact
   `optionalDependencies` pins.
2. **No bundler, raw TS ships** (supersedes any "build for publish" idea):
   Bun executes TS natively (D1) and TS 7 native reads `.ts` entry points,
   so `exports` points at `index.ts` and there is no build step — the
   published bytes are the tested bytes. `bun build --compile` stays a
   consumer-side scenario (packaging.md §6, #40076 documented per release).
   Contingency if a future Bun breaks direct-TS running: a
   `bun build --target=bun` step inside `package-main.ts` — localized by
   design.
3. **Auth: granular token now; trusted publishing is a designed-for
   switch.** `NPM_TOKEN` (granular, org-scoped, expiring) via the `release`
   GitHub environment; release.ts writes a per-package `.npmrc` with
   `${NPM_TOKEN}` interpolation (npm reads `.npmrc` from the project root
   only — never ancestors; the file carries no plaintext secret). The
   switch procedure and its verified constraints (per-package post-create
   config, 2-day validation window, immutable configs, calling-workflow
   name binding → `release.yml` is monolithic, `repository.url` exact,
   npm ≥ 11.5.1/Node ≥ 22.14) live in packaging.md §7.5.

**Consequences.** No release-time commits; accidental local publishes are
structurally impossible (repo is private, only CI holds the token);
platform smoke tests load the STAGED tree via `BUN_GEOS_PACKAGE_DIR`
(loader override), so what is smoked is what ships. The token is the only
long-lived secret until the OIDC switch retires it.

## D27 — Construction-op batch layer: one unary op-id table + one binary table; the corpus gate closes the loop

**Context.** Phase 5 M3 completed the api-surface construction ops (hulls,
simplification, clipping, triangulations, line ops, node/buildArea/
polygonize, centroid/interiorPoint/nearestPoints, clearance, inscribed and
empty circles, DBSCAN clustering, grid fractions). Most are loop-shaped
1-in-1-out geometry→geometry ops — D22's one-crossing principle applies —
but a dozen per-op shim functions would be shim bloat (shim.md §3).

**Decision.** TWO new shim functions with op-id tables, following the D18
contract exactly (0 ok / 1 exception / 2 interrupted; interrupt checks
between items; `destroy_partials` on every failure path; inputs borrowed):

- `geos_shim_unary_all(shim, opId, gs, n, d1..d4, out)` — `SHIM_UNARY_*`
  ids (convexHull, simplifyDP, simplifyTP, centroid, boundary,
  interiorPoint, node, lineMerge, clipByRect); `d1..d4` carry each op's
  scalar params (simplify tolerance, clip rectangle) and are ignored by
  the rest.
- `geos_shim_binary_all(shim, opId, a, gs, n, d1, out)` — `SHIM_BINARY_*`
  ids (snap with d1 = tolerance, sharedPaths). `a` broadcasts, matching
  the element-wise `*All` shape.

Both tables mirror `UnaryOp`/`BinaryOp` in `src/types.ts` and are pinned
by known-answer selftest scenarios (29–30, the D22 discipline). Ops with
rich or per-call C objects (concaveHull options, offset-curve params,
voronoi envelope, delaunay flags, lineSubstring fractions, nearestPoints'
coord-sequence return, clusterDBSCAN's ClusterInfo, grid fractions) stay
singular-only — there is no batch wrapper for an op whose param object
would be rebuilt per item anyway.

Engine facts recorded (they generalize): `GEOSMinimumClearance_r` is an
INT return (0 ok / 2 failure — NOT a masked char); `GEOSPolygonize_r`
borrows its input array; `GEOSSharedPaths_r` is LINEAL-only and throws
`IllegalArgumentException` on areal inputs; `GEOSClusterInfo_*` hands out
a GEOS-owned `size_t*` per-input id array (freed with `GEOSFree_r`;
SIZE_MAX = noise → -1 in the public `Int32Array`).

**Consequences.** The construction surface ships batch-first (convexHullAll,
centroidAll, simplifyAll, topologyPreserveSimplifyAll, clipByRectAll,
boundaryAll, interiorPointAll, nodeAll, lineMergeAll, snapAll,
sharedPathsAll); per-object calls remain the honest baseline on Bun 1.4.x
(the D22 note applies verbatim). The XML corpus differential gate now
executes the convexHull/simplify/centroid/interiorPoint/boundary/
minClearance corpus files — 8.7k+ ops, and the only sanctioned gap left is
`densify` (GEOS's Densifier is C++-only; permanent).

---

## D28 — GeoArrow shapes v2: tagged kinds, null bitmaps, dense-union collections, golden-byte conformance

**Context.** The Phase 1 Arrow shapes (`FlatCoords`/`LineArray`/`Polygonal`)
were deliberately honest about their limits: empty MULTI\* were
unrepresentable (indistinguishable from their singular empty), a batch of
MULTI\* geometries could not ride the flat shapes, GeometryCollection threw,
and there were no null slots — four throw sites said "Phase 5 adds this".

**Decision.** Tagged shapes v2 (`src/types.ts`), zero-dependency:

1. `kind` names the GeoArrow extension type; `fromArrow` accepts the
   tagged shapes AND the legacy untagged ones (inferred by shape);
   `toArrow` emits tagged only.
2. `validity?: Uint8Array` — the Arrow LSB bitmap on multi\* shapes.
   Batch slots honor `nullMode`: `"throw"` (default, names the slot) or
   `"skip"` (omits — cardinality change, documented loudly). Singular
   `fromArrow` rejects null slots. Null slots are NEVER constructed (their
   coord space may hold NaN padding — the reference implementation's does).
3. Empty MULTI\* = length-0 offsets; an empty MEMBER = a repeated offset
   (POINT EMPTY), mirroring Arrow's non-decreasing list offsets (point
   slots validate non-decreasing; ring/line/part offsets stay strict).
4. `geometrycollection` = the dense-union emulation: `types`/`offsets`
   into `children` (homogeneous typed arrays); unreferenced child members
   are disposed (ownership stays exact, all-or-nothing on bad slots).
5. The member rule: multi\* members are leaf geometries — one shape is one
   MULTI\* geometry and simultaneously a batch of member slots.
6. Conformance is differential, not asserted: `scripts/geoarrow-goldens.py`
   (geoarrow-pyarrow, the reference implementation) generates golden
   buffers — canonical `struct<x,y>` + int32 list offsets + LSB validity —
   committed as `test/differential/geoarrow-goldens.json`; the test maps
   canonical ↔ interleaved in BOTH directions (bytes → geometry → WKT, and
   geometry → packed bytes). Regeneration needs only the venv; the runtime
   carries zero dependencies.
7. The audit H3 guard survives: mixed-dimension members still throw
   (per-member stride check in every member-array builder).

**Consequences.** `geos.toArrow(MULTIPOINT EMPTY)` roundtrips; a batch of
n multipolygon slots rides one `geos_shim_build_polygonal_many` crossing;
null-bearing columns ingest with explicit null semantics; the
`geoarrow.*` extension-name mapping is documented (io.md §5) and pinned by
bytes, not prose. Cost: `toArrow` output is a breaking shape change
(tagged) — acceptable at 0.1.0, legacy input stays accepted.

---

## Open design work (tracked, not yet decided in detail)

1. ~~Worker ownership rules — `parallel()` chunking semantics, AbortSignal
   plumbing~~ **Decided in Phase 3** (D22/D23).
2. ~~**CI build matrix runbook** — per-platform flags, stripping, packaging,
   provenance.~~ **Decided in Phase 4** — the runbook is
   [packaging.md §7](operations/packaging.md); the per-target toolchain
   table is code (`scripts/native/targets.ts` + `lib.ts`).
3. **Full API reference draft** — JS API ↔ `geos_c` symbol mapping table.
