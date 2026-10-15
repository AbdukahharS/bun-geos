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
  [oven-sh/bun#44906](https://github.com/oven-sh/bun/issues/44906)); runs in a separate
  "bun-compat" job triggered on new Bun majors. Seeded by
  `spike/ffi-values.test.ts` (passes on Bun 1.4.3 — see
  [spike results](../research/spike-results.md) F5).
- **Worker race test:** spawn N workers that immediately load the package (regression
  net for the [#40972](https://github.com/oven-sh/bun/issues/40972) class; depends on the
  main-thread preload).

## 4. Benchmarks (match the marketing)

Run on pinned hardware in CI (manual trigger), results committed as JSON + rendered in
docs. Competitors: **geos-wasm** (same GEOS semantics, WASM), **turf**, and
**polygon-clipping**; **Shapely 2** as a conceptual native baseline (different runtime —
directional, not headline).

| Benchmark | Sizes | What it proves |
|-----------|-------|----------------|
| Overlay throughput | 10³–10⁶ total vertices | native vs WASM boundary vs pure JS |
| `unionAll` strategy ladder | aligned coverage, disjoint subsets, pathological overlap | strategy dispatch wins, not just "GEOS fast" |
| Prepared predicate scan | 10⁶ points vs 1 polygon; 10⁴×10⁴ pairs | RelateNG prepared + typed-array masks |
| STRtree query | 10⁵–10⁶ items | one-call shim collection vs naive JS loops |
| WKB/GeoJSON/Arrow ingest | exports from PostGIS-scale dumps | I/O layer isn't the new bottleneck |
| makeValid / coverageClean | dirty coverages | the repair suite at scale |

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
