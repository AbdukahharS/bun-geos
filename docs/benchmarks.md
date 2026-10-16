# Benchmarks

> Machine: `AMD Ryzen 7 260 w/ Radeon 780M Graphics`, 16 hw threads · Bun 1.4.3 · GEOS 3.14.1-CAPI-1.20.5 · commit `46b141f` · 2026-10-16T13:16:51.167Z
>
> Best-of-N wall time, warm-up excluded (see `bench/run.ts`). Regenerate with
> `bun run bench`; this page is rendered by `bun run bench:report`. Competitor
> runs (geos-wasm / turf / polygon-clipping) are optional devDependencies —
> `bench/competitors/*.ts` merges into the same schema when installed.
> Positioning rule (testing.md §4): robust overlays, repair, and indexed/
> batched workloads — never trivial-op marketing.

## prepared scan (1 polygon × 100k points)

| variant | ms |
|---|---|
| unprepared | 182.8 |
| prepared | 5.7 |
| prepared+batch | 7.3 |

_prepared 32× vs unprepared_

## STRtree query (100000 items × 1000 envelopes)

| variant | ms |
|---|---|
| naive JS envelope scan | 541.8 |
| strtree | 4.2 |
| strtree+fused filter | 21.8 |

_129× vs naive scan_

## unionAll ladder (961 aligned tiles)

| variant | ms |
|---|---|
| coverage | 4.1 |
| disjointSubset | 10.8 |
| unary | 9.6 |
| auto | 4.1 |

_coverage 2× vs unary_

## batch vs singular (10⁵ squares)

| variant | ms |
|---|---|
| overlay singular | 1477.5 |
| overlay batch | 1420.3 |
| mask singular | 263.5 |
| mask batch | 265.7 |
| measure singular | 4.9 |
| measure batch | 6.1 |
| wkbRead singular | 4161.7 |
| wkbRead batch | 532.7 |

_engine-native FFI makes per-object calls cheap; batch = one crossing + C loops (D22 note)_

## ingest (20000 squares)

| variant | ms |
|---|---|
| WKT | 369.5 |
| GeoJSON | 832.5 |
| WKB per-geometry | 468.1 |
| WKB read-many | 37.4 |

_12.5× read-many vs per-geometry_

## makeValid (1,000 bowties)

| variant | ms |
|---|---|
| makeValid | 38.3 |

_26 geoms/s_

## coverageClean (dirty 20×20 coverage)

| variant | ms |
|---|---|
| coverageClean | 5.5 |

## parallel makeValid (100000 bowties)

| variant | ms |
|---|---|
| calling thread | 4602.3 |
| worker pool | 1111.3 |

_4× vs per-object calls (concurrency 12, chunkFactor 3 — the ≥5× exit axis, D23; WKB serialization bounds the pool at high ratios)_

## parallel mask scan (100000 bowties × 1 polygon)

| variant | ms |
|---|---|
| calling thread | 3.4 |
| worker pool | 162.1 |

_1× (WKB transfer bounds light ops)_

## parallel overlay scaling (10⁵ squares × wobble(720))

| variant | ms |
|---|---|
| 1 worker | 422.9 |
| 2 workers | 501.2 |
| 4 workers | 490.1 |
| 8 workers | 698.3 |

_serialization-bound: the main thread builds 100k chunk WKBs per op (~1s) — cheap-geometry overlays don't parallelize past it; heavy per-item ops do_

## Reading the batch numbers honestly (D22)

On Bun 1.4.x the engine-native FFI makes per-object calls cheap (~tens of ns),
so main-thread shim batch paths converge toward the GEOS-bound cost of the
workload (~1× on overlay; 0.8–1.2× on masks/measures). The batch layer's
measured ≥5× axis is the **worker pool** (see the `parallel makeValid` rows):
the one-crossing property remains load-bearing for interrupt granularity
(between-item aborts), all-or-nothing error contracts, and future Bun
versions where per-call costs regress.

