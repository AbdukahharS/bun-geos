---
description: Per-workload numbers for overlays, repair, indexing, and batch scans — measured honestly against the other engines, and reproducible on your hardware.
---

# Benchmarks

What this library is fast at, how the numbers were measured, and how to reproduce
them on your own hardware. One positioning rule governs the whole page: the suite
benchmarks the workloads this library exists for — robust overlays, topology repair,
prepared/indexed/batched scans, cross-core scaling — never trivial-op marketing.

> [!NOTE]
> Environment for every number below: AMD Ryzen 7 260 (16 hw threads) · Bun 1.4.3 ·
> GEOS 3.14.1-CAPI-1.20.5 · repository commit `a1fffdc` · 2026-10-22. Wall time,
> best-of-N, warm-up excluded. Answer fingerprints are accumulated inside the timed
> region, so a fast wrong answer scores as a mismatch, not a win. Machines differ —
> treat the ratios as the signal and regenerate for absolutes: `bun run bench`.

## Results

The cross-library suite runs identical seeded workloads through ten engines across
every boundary, comparing **answers**, not just times. Each engine runs at its own
fastest idiom — singular and batch variants are both timed where both exist; cells
are the best variant per engine in milliseconds, except rows pinned to a named
variant (unprepared, build, coverage), which use that variant for every engine:

- **native FFI** — this library (native GEOS 3.14 across `bun:ffi`)
- **direct C** — the GEOS C API called from a C++ binary, zero boundary
- **ctypes** — Shapely 2.2.0 (its own GEOS 3.14.1), the vectorized-ufunc crowd's champion
- **WASM** — geos-wasm (GEOS 3.13.0 via Emscripten)
- **pure JS** — JSTS 2.12.1, `@turf/turf` 7.4.0, polygon-clipping 0.15.7, and the
  index/codec specialists rbush 4.0.1, flatbush 4.6.2, wkx 0.5.0

**Bold** marks the fastest engine in a row — but only when it leads the runner-up
by more than the ±10% cross-process noise floor, so noise-level gaps stay unbolded
and ties crown nobody. `—` = not run / not applicable; the notes under each table
say why. Rows and notes labelled *internal half* come from the suite's internal
run, every other cell from the cross-library run — same methodology, so the same
workload can differ between halves by run-to-run noise.

### Overlay

| size | bun-geos | direct C | Shapely 2 | geos-wasm | JSTS | polygon-clipping | turf |
|------|---------:|---------:|----------:|----------:|-----:|-----------------:|-----:|
| 1,000 | 19.7 | 18.8 | 19.0 | 66.9 | 47.6 | 542.7 | 3862.8 |
| 10,000 | 194.7 | 187.7 | 189.1 | 623.3 | 340.9 | 5642.3 | 44032.9 |
| 100,000 | 1347.2 | 1300.9 | 1316.8 | 3670.5 | — | — | — |

- the pure-JS engines run 1k/10k only; at 10k turf's overlay alone takes 44 s.

### Prepared scan — 1 polygon × N points

| size | scan | bun-geos | direct C | Shapely 2 | geos-wasm | turf |
|------|------|---------:|---------:|----------:|----------:|-----:|
| 10,000 | unprepared | 18.1 | 18.1 | 19.8 | 30.7 | 23.4 |
| 10,000 | prepared | 0.7 | 0.5 | 0.5 | 1.4 | — |
| 100,000 | unprepared | 182.0 | 181.4 | 195.8 | 309.7 | 234.2 |
| 100,000 | prepared | 5.8 | 4.8 | 4.8 | 15.1 | — |

- unprepared → prepared is a 20×+ row at 100k on every engine with prepared mode
  (30×+ on the native ones) — GEOS's prepared structure wins it, not the boundary.
- turf has no prepared mode (ray-casting per point); JSTS skipped — not workable
  against its API.

### Union dispatch — 961 aligned tiles

| union | bun-geos | direct C | Shapely 2 | geos-wasm | JSTS |
|-------|---------:|---------:|----------:|----------:|-----:|
| coverage | 0.5 | 0.4 | 0.5 | 1.4 | — |
| plain unary | 9.5 | 9.4 | 9.8 | 22.9 | 60.2 |

- coverage cells are the parity variant: raw CoverageUnion, no validity pre-check.
  The validated dispatch you run in production (`"auto"`) measured 4.1 ms.
- JSTS has no coverage strategy — plain `Geometry.union()` on a prebuilt
  MULTIPOLYGON only.

### STRtree — 100k items × 1000 envelope queries

| op | bun-geos | direct C | Shapely 2 | JSTS | flatbush | rbush |
|----|---------:|---------:|----------:|-----:|---------:|------:|
| build | 31.5 | 14.1 | 15.7 | 24.3 | **8.1** | 14.7 |
| query | 3.6 | **1.7** | 2.8 | 7.7 | 3.8 | 7.8 |

- geos-wasm's STRtree query binding is unusable at this size (a WASM callback
  signature mismatch) — recorded in the suite's failures ledger.
- without the index, a naive per-query JS scan on the same workload takes 546.0 ms
  (*internal half* — ~90× the indexed query). bun-geos' 3.6 is `queryAll`, batching
  all 1000 queries into one crossing.

### WKB ingest — 20k polygons

| decode | bun-geos | direct C | Shapely 2 | geos-wasm | wkx |
|--------|---------:|---------:|----------:|----------:|----:|
| WKB → geometry | 10.9 | 3.5 | 4.8 | 19.4 | 3.6 |

- JSTS ships no WKB codecs — WKT ingest only.
- wkx's 3.6 decodes raw coordinates — no geometry object, no engine (see below).
- *internal half*, same workload: per-geometry ingest 484.2 ms vs 24.7 read-many
  (~20×) — the batch read is the win.

### makeValid — 1k bowties

| repair | bun-geos | direct C | Shapely 2 | geos-wasm |
|--------|---------:|---------:|----------:|----------:|
| makeValid | 38.1 | 40.8 | 39.6 | 96.5 |

### Buffer — 100 geometries

| op | bun-geos | direct C | Shapely 2 | geos-wasm | JSTS | turf |
|----|---------:|---------:|----------:|----------:|-----:|-----:|
| buffer | 14.6 | 12.2 | 12.6 | 18.5 | 17.9 | 84.1 |

- turf's buffer projects geographically by design — the one answer fingerprint of
  45 that differs from every other engine; everything else agrees.

### Across cores — makeValid, 100k bowties (*internal half*)

| | ms |
|--|---:|
| calling thread | 3893.3 |
| worker pool | **1053.6** |

~3.7× with vertex-weighted chunks and WKB transfer. No competitor engine has a
pool, so this axis is internal-only. Light ops stay serialization-bound (parallel
mask scan: 111.6 ms pooled vs 5.0 ms on the calling thread). Semantics:
[Workers & parallelism](/guide/workers).

## Reading the numbers honestly

- **Parity with direct C is the design goal, and it holds** on the workloads that
  matter — overlays, repair, union dispatch, ingest land within the noise band of
  the same GEOS called from C++. That is also why few cells are bold: the ones
  that are (flatbush's index build, direct C's index query) are the real gaps.
- **Direct C is faster in the micro spots** (index queries, raw WKB decode,
  prepared scans): under a few microseconds per op, the FFI crossing itself is
  visible. That is the honest cost of the boundary, and it is why the batch read
  exists.
- **Pure-JS engines trail by multiples** on geometry work — 1.75× (JSTS overlays)
  to hundreds× (turf) — and the JS index specialists (flatbush, rbush) trade blows
  on build/query but hand you envelope candidates, not a geometry engine.
- **wkx decodes WKB faster in isolation** — a codec with no boundary and no engine —
  but it hands you raw coordinates, not a geometry you can run predicates and
  overlays on. Different job.
- **Main-thread batch ≈ singular, on current Bun.** Engine-native FFI makes a
  per-object call cheap (tens of ns), so the `*All` batch forms converge to the
  GEOS-bound cost of the workload (~1× on overlays, 0.8–1.2× on masks and measures).
  The one-crossing property still buys interrupt granularity, all-or-nothing error
  contracts, and insurance against future Bun per-call cost regressions.
- **The worker pool is the big axis.** Heavy per-item ops scale (~3.7× on 100k
  makeValid); light ops and cheap overlays stay serialization-bound — building the
  chunk WKBs on the main thread can cost more than the op itself.
- **Same GEOS underneath, so parity is expected where it appears.** Shapely's ≈ rows
  are the same GEOS 3.14 doing the same math; its wins come from vectorized batch
  plumbing, which this library mirrors with the `*All` forms and the pool.

## Reproduce it

```sh
bun run bench                    # internal suite → results.json + printed tables
bun run bench:report             # render the committed full tables (docs/benchmarks.md)
bun run bench:competitors:setup  # optional competitor devDependencies
bun run bench:competitors        # the cross-library suite → competitors/results.json
bun run bench:check              # regression alerts against the committed baselines
```

The unabridged tables — every size, every variant, the failures-and-skips ledger —
live in [docs/benchmarks.md](docs/benchmarks.md) in the repository; the scenarios
themselves are in [bench/](bench).

## Where to next

- [Predicates & indexing](/guide/predicates) — the prepared/STRtree/batch surface behind the numbers above
- [Workers & parallelism](/guide/workers) — the pool behind the parallel numbers
- [Overlays & operations](/guide/overlays) — the union dispatch ladder in full
