# Roadmap

> Status: **planned**, October 2026. Phases are sequenced so that the riskiest unknowns
> (the Phase 0 spike) are retired before any bulk implementation. Each phase has explicit
> exit criteria.

---

## Phase 0 — Spike (kill-or-continue gate)

> **Status: COMPLETE — GO** (October 2026). All exit criteria met on Linux x64/glibc
> (Bun 1.4.3, GEOS 3.14.1). Evidence, findings, and Phase 1 carry-forwards:
> [spike results](research/spike-results.md). Notable: libc gating is ignored by Bun's
> installer (loader self-selects instead), and the cc()/TinyCC fallback is dropped
> (TCC cannot compile the shim's thread-local capture).

**Goal.** Prove the four riskiest assumptions on this machine, in days not weeks.

1. Build GEOS 3.14 from source; `dlopen` it from Bun via `bun:ffi`.
2. Roundtrip: flat `Float64Array` → `CoordSeq_copyFromBuffer` → polygon build →
   `GEOSIntersection_r` → `copyToBuffer` → correct numbers, zero crashes.
3. Compile the C shim (clang) with variadic error/notice handlers → thread-local capture →
   thrown `GeosError` with the GEOS message.
4. Micro-verifications:
   - Bun's handling of `libc` fields on Linux `optionalDependencies` (musl vs glibc gating).
   - FFI value-roundtrip test set (i32/u32/f64/double coercions) — guards against the
     bug class of [oven-sh/bun#44906](https://github.com/oven-sh/bun/issues/44906).
   - `bun build --compile` consuming an embedded `.so` (known rough edges:
     [#44238](https://github.com/oven-sh/bun/issues/44238),
     [#40076](https://github.com/oven-sh/bun/issues/40076)).
   - `cc()`/TinyCC as dev fallback (non-blocking if Windows behavior is rough).

**Exit criteria.** Overlay roundtrip works with correct results; error path surfaces a real
GEOS message through a thrown error; no crashes across a 10⁵-geometry soak.

**Explicitly non-goals for the spike:** API polish, packaging, Windows build of GEOS.

## Phase 1 — Core

- Loader/resolver: platform package resolution, `BUN_GEOS_LIBRARY` override, version assert.
- Context lifecycle: `Geos` class, `Symbol.dispose`, arena contexts.
- Error model: shim handler capture → `GeosError` (D13).
- I/O: WKT, WKB, GeoJSON, GeoArrow adapters ([io design](design/io.md)).
- Geometry construction: point → collection from flat buffers via shim builders.
- Predicates (unprepared), overlay ops (intersection, union, difference, symdifference),
  buffer, measures (area, length, distance, Hausdorff, Frechet), envelope/accessors.

**Exit criteria.** Roundtrip-identical results against a WKB golden corpus; no leaks under
a create/destroy soak; property-based invariants green.

## Phase 2 — Differentiators (all un-gated, GEOS 3.14)

- **Prepared predicates** via RelateNG: `prepare()` + `*All` batch forms returning
  `Uint8Array` masks; `PreparedRelate`/`PreparedRelatePattern` (DE-9IM).
- **STRtree**: insert/query/nearest with JS-side id registry (items are borrowed pointers).
- **`unionAll` strategy dispatch**: CoverageUnion (aligned coverages) → DisjointSubsetUnion →
  cascaded/unary union; automatic selection + manual override.
- **Repair suite**: `makeValid` (method/keepCollapsed params), `coverageClean` (+ params),
  `coverageIsValid`, `coverageSimplifyVW`; `isValidReasons` / `isSimpleDetail` surfaced in
  error diagnostics.
- **Precision model**: `setPrecision`, `*Prec` overlay variants.
- **Interrupt**: `AbortSignal` → `GEOSInterruptCallback` flag.

**Exit criteria.** Prepared/STRtree paths beat unprepared baselines in the benchmark suite
by the expected orders (10–100× on indexed workloads); repair suite passes the JTS corpus
validity cases.

## Phase 3 — Performance & scale

- Shim batch ops: many-geometry overlay/predicate loops executed in C (one FFI call per
  array — the literal Shapely-2.0 lesson).
- `geos.parallel()`: worker-pool helper for batch ops (chunking semantics TBD, see
  [concurrency](design/concurrency.md)).
- Memory accounting surfaces; long-run leak soak in CI.
- Full benchmark suite vs geos-wasm, turf, polygon-clipping (Shapely 2 as conceptual
  baseline) — see [testing](operations/testing.md).

**Exit criteria.** Batch paths show ≥5× over per-object calls on 10⁵-geometry workloads;
benchmarks published and reproducible.

## Phase 4 — Packaging & release

- CI build matrix producing the 7 platform packages + main package
  ([packaging](operations/packaging.md)).
- LGPL files in every platform package ([licensing](operations/licensing.md)).
- Release pipeline: publish platform packages → verify registry resolution → publish main
  (`access: public`, exact version pins, lockstep bumping).
- Docs: planar-CRS warning front and center; worker rules; memory/disposal guide.

**Exit criteria.** A clean machine (`macOS arm64`, `Ubuntu 24.04`, `Alpine`, `Windows`) runs
`bun add @shzd/bun-geos` and an overlay in < 60 s total, with no other installs.

## Phase 5 — Hardening & polish

- ASan/Valgrind shim gates and soak tests wired into CI.
- JTS/GEOS XML test corpus as a permanent differential gate.
- GeoArrow spec conformance pass.
- Docs site; API reference; benchmark dashboard.
- **0.1.0.**

---

## Sequencing rule

Nothing in Phase N+1 starts before Phase N's exit criteria hold. The single kill-switch is
Phase 0: if the FFI + shim model cannot demonstrably roundtrip overlays on this machine,
the architecture is revisited before any further investment.
