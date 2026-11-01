# Operations: testing & benchmarking

> Status: design target (post-spike). Strategy informed by the language-bindings research:
> the JTS/GEOS shared XML corpus is free differential-testing capital, and Shapely/PostGIS
> are the cross-implementation oracles.

## 1. Test pyramid

| Layer | What | Source of truth |
|-------|------|-----------------|
| **Unit** | Every wrapper op vs hand-written goldens; FFI roundtrips; shim behavior | this repo |
| **Differential (corpus)** | GEOS/JTS `xmltester` cases — thousands of overlay/predicate scenarios with expected results, parsed from the upstream XML and executed through our API | GEOS/JTS repos (pinned tag) |
| **Oracles** | Cross-checks against **PostGIS** (Docker, pinned) and **Shapely 2** on gnarly/degenerate inputs | external |
| **Property-based** | Invariants below | this repo (seeded, reproducible) |
| **Native hygiene** | ASan/Valgrind on the shim; leak soaks; FFI value-roundtrips | this repo + CI jobs |

## 2. Property-based invariants (seeded, always reproducible)

- **Roundtrip identity:** GeoJSON → geom → GeoJSON equal (mod RFC-7946 winding option);
  WKB → geom → WKB byte-identical (same settings); WKT roundtrip; Arrow roundtrip
  alias-then-copy equality.
- **Robustness contracts:** `isValid(out)` holds for overlay outputs on valid inputs;
  area additivity on disjoint unions; `covers(a, b) ⇒ area(intersection) = area(b)`.
- **Prepared/unprepared agreement:** every prepared predicate returns identical results
  to its unprepared twin across the corpus (RelateNG short-circuits must not change
  answers).
- **Batch/singular agreement:** `unionAll([a,b])` ≡ `union(a,b)`; every `*All` mask
  matches element-wise singular calls.
- **Builder fuzz:** shim builders with randomized offsets/degenerate rings produce
  geometry identical to per-ring construction (and never leak — ASan job).
- **Empty/degenerate coverage:** typed empties, single-point rings (rejected with the
  right error), `POINT (NaN NaN)` WKB, collinear lines, zero-area polygons.

## 3. Native hygiene gates

- **ASan/Valgrind CI job** over the shim suite (ownership transfers, `destroy_many` on
  partially built arrays, error paths that bail mid-construction).
- **Leak soak:** 10M create/destroy cycles; `geos.stats.heapBytesApprox` must return to
  baseline; RSS bounded.
- **FFI value-roundtrip smoke per Bun release:** declare every arg/return type used and
  assert values survive (guards the coercion bug class — cf.
  [oven-sh/bun#44906](https://github.com/oven-sh/bun/issues/44906)); runs inside the
  `check` job's spike suite on every push/PR — and therefore on every Bun bump. Seeded by
  `spike/ffi-values.test.ts` (passes on Bun 1.4.3 — see
  [spike results](../research/spike-results.md) F5).
- **Worker race test:** spawn N workers that immediately load the package (regression
  net for the [#40972](https://github.com/oven-sh/bun/issues/40972) class; depends on the
  main-thread preload).
- **PostGIS oracle (Phase 2):** `test/differential/postgis-oracle.test.ts` cross-checks
  WKB ingest, validity, and overlay results against a live PostGIS. Skipped unless
  `BUN_GEOS_PG_URI` is set; CI runs it as its own job against a pinned
  `postgis/postgis` image (local:
  `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgis/postgis:17-3.5`).

## 4. Benchmarks (match the marketing)

Run on pinned hardware in CI (manual trigger), results committed as JSON + rendered in
docs. Two suites:

- **Internal** (`bun run bench`): bun-geos against itself — batch vs singular, prepared
  vs unprepared, pool vs calling thread. Results in `bench/results.json` (schema 2),
  regression-gated by `bun run bench:check`.
- **Competitors** (`bun run bench:competitors`, provisioned by
  `bun run bench:competitors:setup`): every alternative engine measures the SAME seeded
  workloads with the SAME methodology. Results in `bench/competitors/results.json`
  (schema 3, engine-tagged), merged into `docs/benchmarks.md` by `bun run bench:report`.

### Competitor matrix

| Engine | Boundary | Scenarios covered |
|--------|----------|-------------------|
| bun-geos (reference) | native FFI | all |
| geos-cpp (direct C API against the same vendored GEOS) | none — the zero-boundary baseline | all |
| geos-wasm | WASM | overlay, union, prepared-scan, ingest, makevalid, buffer (STRtree query skipped when its callback binding is unusable) |
| Shapely 2 (Python venv, subprocess) | ctypes/Cython | all — its vectorized ufuncs are the batch-layer parallel |
| JSTS | pure JS | overlay, union (unary via `Geometry.union()`), strtree, ingest (WKT only — the npm bundle ships no WKB codecs), buffer (prepared geometry is absent from the npm bundle) |
| turf | pure JS | overlay, union (pairwise fold, capped to 100 tiles), prepared-scan (ray-casting), buffer |
| polygon-clipping | pure JS | overlay |
| rbush / flatbush | pure JS | strtree (index specialists) |
| wkx | pure JS | ingest (WKB/WKT codec specialist) |

Engines degrade to `skipped (reason)` when not installed or when an op is not workable
against the installed API — never hard-fail, never silently dropped.

### Shared methodology (the "same benchmark" contract)

- **Inputs:** one seeded workload source (`bench/lib/gen.ts`). The orchestrator
  materializes canonical files (WKT text, little-endian WKB + cumulative u32
  end-offsets, TSV envelopes) under `bench/competitors/.workload/` for the subprocess
  engines — identical doubles at every boundary.
- **Timing:** warm-up run excluded, then best-of-N wall ms (`repeats` recorded per
  record; slow engines may use fewer repeats — recorded, never hidden).
- **Noise floor:** each engine runs in its own process at a different moment; CPU
  boost/allocator drift between windows is ±10% on this hardware (measured by
  interleaved re-runs: bun-geos and geos-cpp swap the overlay lead between suite runs,
  and an interleaved 12/8-sample probe puts cpp ~6% ahead with nearly disjoint
  distributions). Ratios within [0.9, 1.1] are rendered "≈" (tie) in the report —
  near-parity rows mean "the boundary is free", which IS the claim; only deltas beyond
  ~25% are meaningful rankings. The same floor applies to `bench:check`: baseline
  variants under 10 ms are advisory (`noisy`), never regressions. bun-geos cannot beat
  geos-cpp on engine-bound work by construction (same GEOS binary + one extra boundary)
  — where it wins outright is parallelism (`geos.parallel.*` vs every single-threaded
  baseline here) and the safe batch/typed API surface.
- **Preparation symmetry:** every engine prepares ONCE outside the timed region
  (bun-geos, Shapely, geos-cpp, geos-wasm, JSTS all support one-shot preparation);
  the prepared variant measures only the per-point predicate work.
- **Fingerprint accumulation symmetry:** every engine accumulates through its own batch
  measure API inside the timed region (bun-geos `areaAll`, Shapely's vectorized
  `area().sum()`) — the overlay/makeValid/buffer loops measure the op per item (or the
  one-crossing batch), then aggregate areas in one call on both sides.
- **Optimization note (2026-10-22):** arena-owned batch outputs skip the redundant
  per-geometry FinalizationRegistry registration (D10 refinement — the arena's bulk
  destroy is the backstop; ~40% of batch-output wrapping). `STRtree.queryAll` (one
  crossing for N envelope queries, D18 contract, selftest-pinned) is the batch twin of
  `query`.
- **Work:** answer fingerprints (result counts, area sums, hit counts) are accumulated
  INSIDE the timed region for every engine, so a fast number can't mean "did less".
- **Honesty anchor:** every record carries its fingerprint; the report flags ✗ when an
  engine's answer differs from bun-geos at the same size (counts exact, areas at 1e-9
  relative). Fingerprint math is planar everywhere — turf's geodesic `area()` is
  normalized to the same shoelace so its buffer ✗ reflects the algorithm, not the
  metric.
- **Ceilings are explicit:** pure-JS engines cap the overlay ladder at 10⁴; turf's
  union caps at 100 tiles (pairwise fold); sizes the engine didn't run simply don't
  appear.

| Benchmark | Sizes | What it proves |
|-----------|-------|----------------|
| Overlay throughput | 10³ / 10⁴ / 10⁵ squares × wobble(720) | native vs WASM boundary vs pure JS vs vectorized Python |
| `union` strategy ladder | 961 aligned tiles | `coverage-safe` (validate+union, D20 — CoverageUnion is *silently wrong* on non-coverages) vs `coverage-raw` (union-only, the parity row vs Shapely's `coverage_union_all` and the C++ baseline — the ~9× gap between them IS the validity check) |
| Prepared predicate scan | 10⁴ / 10⁵ points × wobble(720) | RelateNG prepared + typed-array masks |
| STRtree query | 10⁵ boxes × 10³ envelopes (build + query timed) | one-call shim collection vs rbush/flatbush/JTS/GEOS trees |
| Ingest | 2×10⁴ squares (WKT / WKB / batch) | the I/O layer isn't the new bottleneck (bun-geos includes per-geometry GC-safe wrapper registration the C baseline doesn't pay) |
| makeValid | 10³ bowties | the repair suite vs the only two engines that have it |
| Buffer | 10² wobble(720) copies, +2, quadsegs 8 | the most-used real op, at scale |

**Positioning rule** (from the go-geos lesson): never headline trivial ops (`area` of a
small polygon) — pure-JS and flat-layout implementations can match those. The claims are
robust overlays, repair, coverage algebra, and indexed/batched predicates.

## 5. CI gates per phase

| Phase | Gates added |
|-------|-------------|
| 0 | overlay roundtrip; error-capture test; FFI roundtrip set |
| 1 | unit + roundtrip properties; leak soak; ASan job |
| 2 | XML corpus differential; prepared/unprepared agreement; PostGIS oracle job |
| 3 | benchmark suite; batch/singular agreement |
| 4 | per-platform native smoke tests on runners; install matrix (bun/npm/pnpm; glibc/musl) |
| 5 | full gate set enforced on PRs; benchmark regression alerts |

Runner note: tests run on the same GitHub Actions matrix that builds the platform
packages — each platform artifact is loaded and smoke-tested natively before publish.
