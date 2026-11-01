# Design: architecture

> Status: describes the **implemented system** (0.1.0) — the original
> load-bearing core (dlopen + flat-buffer roundtrip + shim error path)
> was proven in the Phase 0 spike; see
> [spike results](../research/spike-results.md). Companion docs:
> [shim](shim.md), [memory](memory.md), [concurrency](concurrency.md),
> [io](io.md); the API-surface target is archived at
> [../archive/api-surface.md](../archive/api-surface.md).

## 1. Layer diagram

```
user code (TypeScript)
   │
   ▼
@shzd/bun-geos  (pure TS)
   ├── loader.ts          resolve platform package · BUN_GEOS_LIBRARY · version assert
   ├── symbols.ts         dlopen symbol table for geos_c (the _r set) + shim
   ├── geos.ts            Geos class: context handle, ops, disposal
   ├── geometry.ts        Geometry wrapper (numeric ptr + owning context)
   ├── arena.ts           arena contexts · bulk destroy
   ├── io/                geojson.ts · wkb.ts · arrow.ts · wkt.ts  (adapters)
   ├── spatial/           prepared.ts · strtree.ts (id registry over GEOS STRtree)
   └── parallel/          pool.ts · protocol.ts · worker.ts (worker-pool batch helper)
        │  bun:ffi — numbers, Float64Array, one crossing per geometry/array
        ▼
shim.so|dylib|dll        (~1.8k lines C: handlers, batch builders, strtree
        │                 collection, destroy_many, interrupt flag)
        ▼
libgeos_c → GEOS 3.14    (the C++ engine, untouched)
```

All three native artifacts (`shim`, `libgeos`, `libgeos_c`) ship together inside one
platform package — see [packaging](../operations/packaging.md).

## 2. Components

### Loader (`loader.ts`)
1. Compute expected platform package name from `process.platform` / `process.arch` /
   libc detection (spike-verified: `process.report.getReport().header.glibcVersionRuntime`
   cleanly detects glibc in Bun 1.4.3; needed because Bun's installer *ignores* the `libc`
   field and Linux users get both `-gnu` and `-musl` packages — spike results F2).
2. Resolve it relative to the main package (`import.meta.resolve` /
   `createRequire(import.meta.url).resolve`).
3. Unless `BUN_GEOS_LIBRARY` is set (D8): `dlopen` the bundled **shim**, which is already
   linked against the bundled `libgeos_c` — with `--disable-new-dtags` so DT_RPATH (not
   RUNPATH) resolves the transitive `libgeos.so` dependency (spike results F3).
4. Parse `GEOSversion()` (e.g. `"3.14.1-CAPI-1.18.2"`) and assert the `3.14` prefix.
   Mismatch — including via the env override — is a hard error with remediation text.
   (Spike note: `GEOSversion` is the one C API function with no `_r` variant.)
5. Install handlers *through the shim* (never via JSCallback — D4; empirically confirmed:
   a JSCallback handler receives only the `"%s"` format string, never the message).
6. If `dlopen` throws because the JIT is disabled (Bun 1.4+ makes every `bun:ffi` entry
   point throw `TypeError` in that mode), fail with a message stating bun-geos requires
   the JIT — there is no JIT-less fallback (pure-WASM is permanently out of scope, D1).

### Symbol table (`symbols.ts`)
One declarative map of every `geos_c` `_r` function we use, plus the shim exports.
Single source of truth for the FFI surface; the shim covers only what TS cannot
([shim](shim.md) draws the line explicitly).

### `Geos` class
Owns a `GEOSContextHandle_t` (D3). All operations are methods or free functions taking a
`Geos`. `Symbol.dispose` → destroy tracked/arena objects + `GEOS_finish_r`.
Geometries remember their owning `Geos`; using a geometry with a different context is a
programming error (`TypeError`) — the Rust-lesson rule enforced at the API level.

### `Geometry` wrapper
Holds: numeric `GEOSGeometry*`, owning context reference, cached `hasZ/hasM` and
envelope. Never a finalizer-dependent object (D10): explicit
`[Symbol.dispose]()`/`dispose()` is the primary path; the FinalizationRegistry is a
backstop only.

### Arenas
`using arena = geos.arena()` — every geometry created inside is registered; on exit the
shim's `destroy_many` frees them in one FFI call. For hot loops this is the difference
between N crossings and one.

### I/O adapters ([io](io.md))
GeoJSON (JS-side conversion), WKB (native readers/writers + batch variants), GeoArrow
(near zero-copy), WKT. Flat `Float64Array` + offsets is the canonical currency (D9).

### STRtree wrapper
JS-side `Geometry[]` registry (ids are sequential by construction, so the array IS the
id→geometry map); the tree stores integer ids as `void*` items
(borrowed-pointer rule from [GEOS research §4](../research/geos.md)). Query results
collected by the shim into a preallocated array → returned as `Int32Array`.

## 3. Design principles

1. **Batch-first.** Every op ships a singular and a plural form; the plural form is not a
   JS loop over the singular (Shapely's lesson). Plural forms take/return typed arrays.
2. **Flat buffers canonical.** Coordinates cross the FFI boundary as interleaved
   `Float64Array`s, never as JS object graphs or per-coordinate calls.
3. **No callbacks, no BigInts, no per-item crossings on hot paths.** The shim absorbs
   everything loop-shaped.
4. **Explicit memory, visible heap.** `using`/dispose/arenas are the contract; the
   registry is insurance; per-context byte accounting is reported.
5. **Strict 3.14.** No capability flags anywhere (D5).
6. **Errors carry context.** GEOS messages + op name + JS-side structural detail
   (ring/vertex indices) in every `GeosError` (D13).

## 4. Worked data flow — `unionAll(parcelGeometries)`

```
Geometry[] ──(extract cached ptrs)──► GEOSGeometry*[]
   │  shim: union_all(ctx, ptrArray, n) → GEOSGeometry*
   │        └─ internally: strategy dispatch —
   │             coverage-shaped input? → GEOSCoverageUnion_r
   │             disjoint subsets?      → GEOSDisjointSubsetUnion_r
   │             else                   → GEOSUnaryUnion_r
   ▼
GEOSGeometry* result ──► new Geometry wrapper (registered to arena if open)
```

Two FFI crossings total, regardless of input size. The singular `a.union(b)` is the same
path with `n = 2` and no dispatch (direct `GEOSUnion_r`).

## 5. Target repository layout (implementation phase)

```
bun-geos/
├── src/                    # the TS listed above (index.ts re-exports)
├── native/
│   └── shim.c              # the entire C surface, reviewed as prose
├── packages/               # generated per release (see packaging doc)
│   └── bun-geos-<platform>/…
├── test/
│   ├── unit/ · properties/ · soak/ · differential/
│   └── native/              # the C selftest (ASan/UBSan gate)
├── bench/                   # the published benchmark suite + regression check
└── docs/                   # this documentation
```

(`AGENTS.md` is the maintained map of this layout; the sketch above is the
Phase-5-era view. Toolchain rules in `AGENTS.md` — Bun-only, `bun check`,
`.ts` import extensions, `verbatimModuleSyntax` — all continue to apply.)
