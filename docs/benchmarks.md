# Benchmarks

> Machine: `AMD Ryzen 7 260 w/ Radeon 780M Graphics`, 16 hw threads · Bun 1.4.4 · GEOS 3.14.1-CAPI-1.20.5 · commit `6fe2b0b` · 2026-11-01T09:46:18.012Z
>
> Best-of-N wall time, warm-up excluded (see `bench/run.ts`). Regenerate with
> `bun run bench`; this page is rendered by `bun run bench:report`. The competitor
> comparison below renders when `bench/competitors/results.json` exists —
> `bun run bench:competitors` (provision with `bench:competitors:setup`).
> Positioning rule (testing.md §4): robust overlays, repair, and indexed/
> batched workloads — never trivial-op marketing.

## prepared scan (1 polygon × 100k points)

| variant | ms |
|---|---|
| unprepared | 178.8 |
| prepared | 5.1 |
| prepared+batch | 7.3 |

_prepared 35× vs unprepared_

## STRtree query (100000 items × 1000 envelopes)

| variant | ms |
|---|---|
| naive JS envelope scan | 491.7 |
| strtree | 4.6 |
| strtree queryAll | 3.9 |
| strtree+fused filter | 21.9 |

_107× vs naive scan_

## unionAll ladder (961 aligned tiles)

| variant | ms |
|---|---|
| coverage | 4.0 |
| disjointSubset | 10.0 |
| unary | 9.3 |
| auto | 4.1 |

_coverage 2× vs unary_

## batch vs singular (10⁵ squares)

| variant | ms |
|---|---|
| overlay singular | 1343.1 |
| overlay batch | 1316.0 |
| mask singular | 257.9 |
| mask batch | 259.8 |
| measure singular | 4.5 |
| measure batch | 4.7 |
| wkbRead singular | 3812.9 |
| wkbRead batch | 449.0 |

_engine-native FFI makes per-object calls cheap; batch = one crossing + C loops (D22 note)_

## ingest (20000 squares)

| variant | ms |
|---|---|
| WKT | 338.3 |
| GeoJSON | 768.2 |
| WKB per-geometry | 433.8 |
| WKB read-many | 30.3 |

_14.3× read-many vs per-geometry_

## makeValid (1,000 bowties)

| variant | ms |
|---|---|
| makeValid | 36.2 |

_28 geoms/s_

## coverageClean (dirty 20×20 coverage)

| variant | ms |
|---|---|
| coverageClean | 4.9 |

## construction batch (10⁵ squares)

| variant | ms |
|---|---|
| hull singular | 92.0 |
| hull batch | 76.3 |
| centroid batch | 41.9 |

_D27 unary batch layer — one crossing per array (D22 note applies)_

## parallel makeValid (100000 bowties)

| variant | ms |
|---|---|
| calling thread | 4390.5 |
| worker pool | 956.9 |

_5× vs per-object calls (concurrency 12, chunkFactor 3 — the ≥5× exit axis, D23; WKB serialization bounds the pool at high ratios)_

## parallel mask scan (100000 bowties × 1 polygon)

| variant | ms |
|---|---|
| calling thread | 3.5 |
| worker pool | 131.9 |

_1× (WKB transfer bounds light ops)_

## parallel overlay scaling (10⁵ squares × wobble(720))

| variant | ms |
|---|---|
| 1 worker | 340.5 |
| 2 workers | 360.0 |
| 4 workers | 347.3 |
| 8 workers | 368.7 |

_serialization-bound: the main thread builds 100k chunk WKBs per op (~1s) — cheap-geometry overlays don't parallelize past it; heavy per-item ops do_

## Reading the batch numbers honestly (D22)

On Bun 1.4.x the engine-native FFI makes per-object calls cheap (~tens of ns),
so main-thread shim batch paths converge toward the GEOS-bound cost of the
workload (~1× on overlay; 0.8–1.2× on masks/measures). The batch layer's
measured ≥5× axis is the **worker pool** (see the `parallel makeValid` rows):
the one-crossing property remains load-bearing for interrupt granularity
(between-item aborts), all-or-nothing error contracts, and future Bun
versions where per-call costs regress.

---

# Competitor comparison

> Same seeded workloads, same methodology (best-of-N wall ms, warm-up excluded,
> answer fingerprints accumulated inside the timed region), every boundary:
> native FFI (bun-geos), direct C (geos-cpp), WASM (geos-wasm), ctypes (Shapely),
> and pure JS (JSTS / turf / polygon-clipping / rbush / flatbush / wkx).
> Run `2026-11-01T09:51:59.813Z` on `AMD Ryzen 7 260 w/ Radeon 780M Graphics` · commit `6fe2b0b` — regenerate with
> `bun run bench:competitors` (optional devDependencies: `bun run bench:competitors:setup`).
>
> **fp** = answer fingerprint vs bun-geos at the same size (✓ agree / ✗ differs —
> read the engine's note before trusting a ✗ row, e.g. turf's buffer projects
> geographically by design). **× vs bun-geos** compares each engine's variant
> against the reference's BEST variant at that size; ratios within [0.9, 1.1]
> render as ≈ (the cross-process noise floor). Speedups are same-machine,
> same-input numbers.

## Engines

| engine | version | boundary | status |
|---|---|---|---|
| bun-geos | GEOS 3.14.1-CAPI-1.20.5 / bun-geos 0.3.0 | native-ffi | ran |
| geos-wasm | geos-wasm / 3.13.0-CAPI-1.19.0 | wasm | ran |
| jsts | 2.12.1 | pure-js | ran |
| turf | @turf/turf 7.4.0 | pure-js | ran |
| polygon-clipping | polygon-clipping 0.15.7 | pure-js | ran |
| rbush | rbush 4.0.1 | pure-js | ran |
| flatbush | flatbush 4.6.2 | pure-js | ran |
| wkx | wkx 0.5.0 | pure-js | ran |
| shapely | shapely 2.2.0 / GEOS 3.14.1 | ctypes | ran |
| geos-cpp | geos 3.14.1-CAPI-1.20.5 | c-direct | ran |

## overlay

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 1000 | bun-geos | singular | 19.3 | 51,874 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | bun-geos | batch | 19.5 | 51,330 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | geos-cpp | singular | 18.4 | 54,263 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 1000 | geos-wasm | singular | 64.6 | 15,475 | 3.35× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 1000 | jsts | singular | 54.7 | 18,290 | 2.84× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 1000 | polygon-clipping | singular | 435.9 | 2,294 | 22.61× | ✓ | Martinez-family clipping — overlay ops only |
| 1000 | shapely | singular | 21.7 | 46,165 | 1.12× | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 1000 | shapely | batch | 18.8 | 53,234 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 1000 | turf | singular | 4780.4 | 209 | 247.98× | ✓ | web-mapping algorithm ports — GeoJSON-native, planar CRS not enforced |
| 10000 | bun-geos | singular | 193.7 | 51,617 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | batch | 193.4 | 51,719 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | geos-cpp | singular | 183.1 | 54,626 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-wasm | singular | 601.7 | 16,619 | 3.11× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | jsts | singular | 371.7 | 26,902 | 1.92× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 10000 | polygon-clipping | singular | 5231.7 | 1,911 | 27.06× | ✓ | Martinez-family clipping — overlay ops only |
| 10000 | shapely | singular | 214.9 | 46,529 | 1.11× | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 10000 | shapely | batch | 192.1 | 52,063 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 10000 | turf | singular | 48293.7 | 207 | 249.77× | ✓ | web-mapping algorithm ports — GeoJSON-native, planar CRS not enforced |
| 100000 | bun-geos | singular | 1348.7 | 74,147 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | batch | 1325.0 | 75,471 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | geos-cpp | singular | 1244.1 | 80,381 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-wasm | singular | 3744.3 | 26,707 | 2.83× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | shapely | singular | 1503.7 | 66,502 | 1.13× | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 100000 | shapely | batch | 1285.4 | 77,794 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |

## union

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100 | turf | unary | 14.1 | 7,100 | — | — | pairwise fold (no cascaded union); 100-tile ladder cap |
| 961 | bun-geos | coverage-safe | 4.0 | 241,993 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | coverage-raw | 0.5 | 2,029,061 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | unary | 9.4 | 102,181 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | auto | 4.0 | 239,923 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | geos-cpp | unary | 9.2 | 104,678 | 19.38× | ✓ | includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-cpp | coverage-raw | 0.4 | 2,238,450 | ≈ | ✓ | includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-wasm | unary | 23.1 | 41,668 | 48.70× | ✓ | coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-wasm | coverage-raw | 1.3 | 714,469 | 2.84× | ✓ | coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract) |
| 961 | jsts | unary | 72.9 | 13,180 | 153.95× | ✓ | Geometry.union() on a prebuilt MULTIPOLYGON (no coverage strategy in JSTS) |
| 961 | shapely | unary | 9.3 | 103,111 | 19.68× | ✓ | coverage-raw = union only (coverage_union_all does NO validity pre-check) |
| 961 | shapely | coverage-raw | 0.5 | 2,099,317 | ≈ | ✓ | coverage-raw = union only (coverage_union_all does NO validity pre-check) |

## prepared-scan

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 10000 | bun-geos | unprepared | 17.9 | 558,633 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | prepared | 0.6 | 15,977,912 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | prepared+batch | 0.8 | 12,549,492 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | geos-cpp | unprepared | 17.8 | 560,834 | 28.49× | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-cpp | prepared | 0.5 | 22,050,182 | 0.72× | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-wasm | unprepared | 31.8 | 314,938 | 50.73× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | geos-wasm | prepared | 1.4 | 6,979,249 | 2.29× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | shapely | unprepared | 26.5 | 377,078 | 42.37× | ✓ | vectorized; prepare() then auto-used by intersects |
| 10000 | shapely | prepared | 0.5 | 21,996,296 | 0.73× | ✓ | vectorized; prepare() then auto-used by intersects |
| 10000 | turf | unprepared | 21.6 | 462,018 | 34.58× | ✓ | ray-casting point-in-polygon (no prepared mode) |
| 100000 | bun-geos | unprepared | 183.9 | 543,693 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | prepared | 6.7 | 14,921,195 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | prepared+batch | 8.4 | 11,909,916 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | geos-cpp | unprepared | 177.8 | 562,573 | 26.52× | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-cpp | prepared | 4.5 | 22,441,692 | 0.66× | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-wasm | unprepared | 315.7 | 316,773 | 47.10× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | geos-wasm | prepared | 14.3 | 6,989,839 | 2.13× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | shapely | unprepared | 263.1 | 380,153 | 39.25× | ✓ | vectorized; prepare() then auto-used by intersects |
| 100000 | shapely | prepared | 4.5 | 22,278,150 | 0.67× | ✓ | vectorized; prepare() then auto-used by intersects |
| 100000 | turf | unprepared | 218.5 | 457,593 | 32.61× | ✓ | ray-casting point-in-polygon (no prepared mode) |

## strtree

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100000 | bun-geos | build | 24.4 | 4,099,462 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query | 3.6 | — | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query-batch | 3.8 | — | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query+fused | 22.2 | 4,513,872 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | flatbush | build | 7.7 | 12,954,949 | 2.13× | ✓ | static packed index (index angle only, immutable data) |
| 100000 | flatbush | query | 3.5 | — | ≈ | ✓ | static packed index (index angle only, immutable data) |
| 100000 | geos-cpp | build | 12.7 | 7,904,482 | 3.50× | ✓ | build includes the build-forcing first query (C API has no explicit build) |
| 100000 | geos-cpp | query | 1.6 | — | 0.46× | ✓ | build includes the build-forcing first query (C API has no explicit build) |
| 100000 | jsts | build | 29.9 | 3,344,388 | 8.26× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100000 | jsts | query | 8.9 | — | 2.46× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100000 | rbush | build | 14.1 | 7,085,387 | 3.90× | ✓ | dynamic R-tree specialist (index angle only) |
| 100000 | rbush | query | 6.4 | — | 1.78× | ✓ | dynamic R-tree specialist (index angle only) |
| 100000 | shapely | build | 13.7 | 7,283,282 | 3.79× | ✓ |  |
| 100000 | shapely | query | 2.6 | — | 0.72× | ✓ |  |

## ingest

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 20000 | bun-geos | wkt | 32.6 | 613,925 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | geojson | 25.9 | 773,562 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | wkb | 10.0 | 1,992,203 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | wkb-batch | 8.0 | 2,508,104 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | geos-cpp | wkt | 21.2 | 944,791 | 2.65× | ✓ | GEOS C API called directly — zero boundary |
| 20000 | geos-cpp | wkb | 3.1 | 6,405,491 | 0.39× | ✓ | GEOS C API called directly — zero boundary |
| 20000 | geos-wasm | wkt | 159.1 | 125,744 | 19.95× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 20000 | geos-wasm | wkb | 17.7 | 1,130,701 | 2.22× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 20000 | jsts | wkt | 55.2 | 362,130 | 6.93× | ✓ | the jsts npm bundle ships no WKB codecs — WKT ingest only |
| 20000 | shapely | wkt | 65.0 | 307,716 | 8.15× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkt-batch | 31.2 | 640,088 | 3.92× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkb | 35.3 | 565,926 | 4.43× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkb-batch | 4.5 | 4,438,965 | 0.57× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | wkx | wkt | 28.9 | 690,982 | 3.63× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkb | 2.5 | 8,022,099 | 0.31× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkt-write | 13.9 | 1,439,900 | 1.74× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkb-write | 4.0 | 4,973,557 | 0.50× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |

## makevalid

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 1000 | bun-geos | makevalid | 36.6 | 27,337 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | geos-cpp | makevalid | 39.3 | 25,451 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 1000 | geos-wasm | makevalid | 103.7 | 9,647 | 2.83× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 1000 | shapely | makevalid | 37.9 | 26,396 | ≈ | ✓ |  |

## buffer

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100 | bun-geos | buffer | 12.4 | 8,067 | — | — | reference column — native FFI to GEOS 3.14 |
| 100 | geos-cpp | buffer | 12.3 | 8,127 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 100 | geos-wasm | buffer | 19.3 | 5,187 | 1.56× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100 | jsts | buffer | 17.9 | 5,574 | 1.45× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100 | shapely | buffer | 12.0 | 8,330 | ≈ | ✓ |  |
| 100 | turf | buffer | 65.2 | 1,533 | 5.26× | ✗ | geographic projection built in — planar fingerprint mismatch expected |

## Failures & skips

- `geos-wasm` strtree@100000: GEOSSTRtree_query callback binding unusable (call_indirect to a signature that does not match (evaluating '$(A)(g, I, B)'))
- `jsts` prepared-scan: _skipped_ — op not workable against the installed package's API

