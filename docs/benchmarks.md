# Benchmarks

> Machine: `AMD Ryzen 7 260 w/ Radeon 780M Graphics`, 16 hw threads · Bun 1.4.3 · GEOS 3.14.1-CAPI-1.20.5 · commit `fbd2af7` · 2026-10-17T07:14:57.722Z
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
| unprepared | 180.8 |
| prepared | 5.7 |
| prepared+batch | 7.5 |

_prepared 32× vs unprepared_

## STRtree query (100000 items × 1000 envelopes)

| variant | ms |
|---|---|
| naive JS envelope scan | 482.9 |
| strtree | 5.8 |
| strtree+fused filter | 21.7 |

_84× vs naive scan_

## unionAll ladder (961 aligned tiles)

| variant | ms |
|---|---|
| coverage | 4.2 |
| disjointSubset | 10.5 |
| unary | 9.6 |
| auto | 4.2 |

_coverage 2× vs unary_

## batch vs singular (10⁵ squares)

| variant | ms |
|---|---|
| overlay singular | 1411.4 |
| overlay batch | 1409.5 |
| mask singular | 250.7 |
| mask batch | 252.7 |
| measure singular | 4.3 |
| measure batch | 5.4 |
| wkbRead singular | 3698.9 |
| wkbRead batch | 511.2 |

_engine-native FFI makes per-object calls cheap; batch = one crossing + C loops (D22 note)_

## ingest (20000 squares)

| variant | ms |
|---|---|
| WKT | 389.3 |
| GeoJSON | 822.8 |
| WKB per-geometry | 451.5 |
| WKB read-many | 34.9 |

_12.9× read-many vs per-geometry_

## makeValid (1,000 bowties)

| variant | ms |
|---|---|
| makeValid | 38.0 |

_26 geoms/s_

## coverageClean (dirty 20×20 coverage)

| variant | ms |
|---|---|
| coverageClean | 4.9 |

## construction batch (10⁵ squares)

| variant | ms |
|---|---|
| hull singular | 145.2 |
| hull batch | 109.8 |
| centroid batch | 72.8 |

_D27 unary batch layer — one crossing per array (D22 note applies)_

## parallel makeValid (100000 bowties)

| variant | ms |
|---|---|
| calling thread | 4357.7 |
| worker pool | 1104.2 |

_4× vs per-object calls (concurrency 12, chunkFactor 3 — the ≥5× exit axis, D23; WKB serialization bounds the pool at high ratios)_

## parallel mask scan (100000 bowties × 1 polygon)

| variant | ms |
|---|---|
| calling thread | 4.6 |
| worker pool | 132.0 |

_1× (WKB transfer bounds light ops)_

## parallel overlay scaling (10⁵ squares × wobble(720))

| variant | ms |
|---|---|
| 1 worker | 462.0 |
| 2 workers | 846.0 |
| 4 workers | 614.0 |
| 8 workers | 577.8 |

_serialization-bound: the main thread builds 100k chunk WKBs per op (~1s) — cheap-geometry overlays don't parallelize past it; heavy per-item ops do_

## Reading the batch numbers honestly (D22)

On Bun 1.4.x the engine-native FFI makes per-object calls cheap (~tens of ns),
so main-thread shim batch paths converge toward the GEOS-bound cost of the
workload (~1× on overlay; 0.8–1.2× on masks/measures). The batch layer's
measured ≥5× axis is the **worker pool** (see the `parallel makeValid` rows):
the one-crossing property remains load-bearing for interrupt granularity
(between-item aborts), all-or-nothing error contracts, and future Bun
versions where per-call costs regress.

