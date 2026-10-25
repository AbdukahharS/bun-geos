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
> treat the ratios as the signal and regenerate for absolutes: `bun run bench`. The
> two tables below come from the suite's two halves — the internal suite and the
> cross-library suite (a separate run over coordinate-level twins of the same
> scenarios) — so a workload appearing in both (prepared: 5.5 vs 5.8 ms) differs by
> run-to-run noise.

## Headline numbers

| Workload | Result | The mechanism |
|----------|--------|---------------|
| prepared scan — 1 polygon × 100k points | 5.5 ms vs 181.9 ms unprepared (**~33×**) | `prepare()` builds the prepared structure once; every test after skips the repeated intersection work |
| STRtree — 100k items × 1000 envelopes | 6.0 ms vs 546.0 ms naive JS scan (**~90×**); `queryAll` batches the queries to 3.9 ms | envelope index queried in C, candidate ids back in one crossing |
| union dispatch — 961 aligned tiles | coverage 4.1 ms vs plain unary 9.8 ms; `"auto"` picks the fast path for you | the strategy ladder: validate + coverage-union, else disjoint-subset, else unary |
| WKB ingest — 20k polygons | read-many 24.7 ms vs per-geometry 484.2 ms (**~20×**) | one FFI crossing for the whole buffer, the loop runs in C |
| parallel makeValid — 100k bowties | pool 1053.6 ms vs calling thread 3893.3 ms (**~3.7×**) | worker pool with vertex-weighted chunks and WKB transfer |

## Against the other engines

The cross-library suite runs identical seeded workloads through ten engines across
every boundary, comparing **answers**, not just times. Each engine runs at its own
fastest idiom — singular and batch variants are both timed where both exist:

- **native FFI** — this library (native GEOS 3.14 across `bun:ffi`)
- **direct C** — the GEOS C API called from a C++ binary, zero boundary
- **ctypes** — Shapely 2.2.0 (its own GEOS 3.14.1), the vectorized-ufunc crowd's champion
- **WASM** — geos-wasm (GEOS 3.13.0 via Emscripten)
- **pure JS** — JSTS 2.12.1, `@turf/turf` 7.4.0, polygon-clipping 0.15.7, and the
  index/codec specialists rbush 4.0.1, flatbush 4.6.2, wkx 0.5.0

Best variant per engine, in milliseconds:

| Workload | bun-geos | direct C | Shapely 2 | geos-wasm | JSTS | pure-JS specialists |
|----------|---------:|---------:|----------:|----------:|-----:|---------------------|
| overlay · 100k | **1347** | 1301 | 1317 | 3671 | 341 *(10k)* | turf 44033 · polygon-clipping 5642 *(10k)* |
| prepared scan · 100k | **5.8** | 4.8 | 4.8 | 15.1 | — | turf 234 |
| union · 961 tiles, coverage ¹ | **0.5** | 0.4 | 0.5 | 1.4 | 60.2 *(unary)* | — |
| STRtree · 100k — build / query | 31.5 / 3.6 | 14.1 / 1.7 | 15.7 / 2.8 | ² | 24.3 / 7.7 | flatbush 8.1 / 3.8 · rbush 14.7 / 7.8 |
| WKB ingest · 20k | **10.9** | 3.5 | 4.8 | 19.4 | ³ | wkx 3.6 |
| makeValid · 1k | **38.1** | 40.8 | 39.6 | 96.5 | — | — |
| buffer · 100 | **14.6** | 12.2 | 12.6 | 18.5 | 17.9 | turf 84.1 ⁴ |

¹ the parity variant: raw coverage union, no validity pre-check. The validated
dispatch you run in production (`"auto"`) measured 4.1 ms in the headline table.
² geos-wasm's STRtree query binding is unusable at this size (a WASM callback
signature mismatch) — recorded in the suite's failures ledger.
³ the JSTS npm bundle ships no WKB codecs — WKT ingest only.
⁴ turf's buffer projects geographically by design — the one answer fingerprint of 45
that differs from every other engine; everything else agrees.

How to read that table:

- **Parity with direct C is the design goal, and it holds** on the workloads that
  matter — overlays, repair, union dispatch land within the noise band of the same
  GEOS called from C++.
- **Direct C is faster in the micro spots** (prepared scans, index queries, raw WKB
  decode): under a few microseconds per op, the FFI crossing itself is visible. That
  is the honest cost of the boundary, and it is why the batch read exists.
- **Pure-JS engines trail by multiples** on geometry work — 1.75× (JSTS overlays) to
  hundreds× (turf) — and the JS index specialists (flatbush, rbush) trade blows on
  build/query but hand you envelope candidates, not a geometry engine.
- **wkx decodes WKB faster in isolation** — a codec with no boundary and no engine —
  but it hands you raw coordinates, not a geometry you can run predicates and
  overlays on. Different job.

## Reading the numbers honestly

- **Main-thread batch ≈ singular, on current Bun.** Engine-native FFI makes a
  per-object call cheap (tens of ns), so the `*All` batch forms converge to the
  GEOS-bound cost of the workload (~1× on overlays, 0.8–1.2× on masks and measures).
  The one-crossing property still buys interrupt granularity, all-or-nothing error
  contracts, and insurance against future Bun per-call cost regressions — and bulk
  WKB ingest is a genuine ~20× win today.
- **The worker pool is the big axis.** Heavy per-item ops scale (~3.7× on 100k
  makeValid); light ops and cheap overlays stay serialization-bound — building the
  chunk WKBs on the main thread can cost more than the op itself. The semantics:
  [Workers & parallelism](/guide/workers).
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

- [Predicates & indexing](/guide/predicates) — the prepared/STRtree/batch surface behind the headline numbers
- [Workers & parallelism](/guide/workers) — the pool behind the parallel numbers
- [Overlays & operations](/guide/overlays) — the union dispatch ladder in full
