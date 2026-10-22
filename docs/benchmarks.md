# Benchmarks

> Machine: `AMD Ryzen 7 260 w/ Radeon 780M Graphics`, 16 hw threads · Bun 1.4.3 · GEOS 3.14.1-CAPI-1.20.5 · commit `a1fffdc` · 2026-10-22T08:02:56.169Z
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
| unprepared | 181.9 |
| prepared | 5.5 |
| prepared+batch | 7.6 |

_prepared 33× vs unprepared_

## STRtree query (100000 items × 1000 envelopes)

| variant | ms |
|---|---|
| naive JS envelope scan | 546.0 |
| strtree | 6.0 |
| strtree queryAll | 3.9 |
| strtree+fused filter | 25.4 |

_90× vs naive scan_

## unionAll ladder (961 aligned tiles)

| variant | ms |
|---|---|
| coverage | 4.1 |
| disjointSubset | 10.6 |
| unary | 9.8 |
| auto | 4.2 |

_coverage 2× vs unary_

## batch vs singular (10⁵ squares)

| variant | ms |
|---|---|
| overlay singular | 1411.9 |
| overlay batch | 1364.6 |
| mask singular | 262.5 |
| mask batch | 257.4 |
| measure singular | 4.6 |
| measure batch | 4.6 |
| wkbRead singular | 3647.8 |
| wkbRead batch | 514.4 |

_engine-native FFI makes per-object calls cheap; batch = one crossing + C loops (D22 note)_

## ingest (20000 squares)

| variant | ms |
|---|---|
| WKT | 336.9 |
| GeoJSON | 1004.5 |
| WKB per-geometry | 484.2 |
| WKB read-many | 24.7 |

_19.6× read-many vs per-geometry_

## makeValid (1,000 bowties)

| variant | ms |
|---|---|
| makeValid | 34.6 |

_29 geoms/s_

## coverageClean (dirty 20×20 coverage)

| variant | ms |
|---|---|
| coverageClean | 4.6 |

## construction batch (10⁵ squares)

| variant | ms |
|---|---|
| hull singular | 79.3 |
| hull batch | 75.4 |
| centroid batch | 39.3 |

_D27 unary batch layer — one crossing per array (D22 note applies)_

## parallel makeValid (100000 bowties)

| variant | ms |
|---|---|
| calling thread | 3893.3 |
| worker pool | 1053.6 |

_4× vs per-object calls (concurrency 12, chunkFactor 3 — the ≥5× exit axis, D23; WKB serialization bounds the pool at high ratios)_

## parallel mask scan (100000 bowties × 1 polygon)

| variant | ms |
|---|---|
| calling thread | 5.0 |
| worker pool | 111.6 |

_1× (WKB transfer bounds light ops)_

## parallel overlay scaling (10⁵ squares × wobble(720))

| variant | ms |
|---|---|
| 1 worker | 416.5 |
| 2 workers | 354.0 |
| 4 workers | 404.3 |
| 8 workers | 423.3 |

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
> Run `2026-10-22T08:01:08.571Z` on `AMD Ryzen 7 260 w/ Radeon 780M Graphics` · commit `a1fffdc` — regenerate with
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
| bun-geos | GEOS 3.14.1-CAPI-1.20.5 / bun-geos 0.1.0 | native-ffi | ran |
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
| 1000 | bun-geos | singular | 19.7 | 50,707 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | bun-geos | batch | 19.8 | 50,560 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | geos-cpp | singular | 18.8 | 53,137 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 1000 | geos-wasm | singular | 66.9 | 14,946 | 3.39× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 1000 | jsts | singular | 47.6 | 20,990 | 2.42× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 1000 | polygon-clipping | singular | 542.7 | 1,843 | 27.52× | ✓ | Martinez-family clipping — overlay ops only |
| 1000 | shapely | singular | 21.6 | 46,356 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 1000 | shapely | batch | 19.0 | 52,683 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 1000 | turf | singular | 3862.8 | 259 | 195.87× | ✓ | web-mapping algorithm ports — GeoJSON-native, planar CRS not enforced |
| 10000 | bun-geos | singular | 197.8 | 50,547 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | batch | 194.7 | 51,374 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | geos-cpp | singular | 187.7 | 53,278 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-wasm | singular | 623.3 | 16,043 | 3.20× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | jsts | singular | 340.9 | 29,334 | 1.75× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 10000 | polygon-clipping | singular | 5642.3 | 1,772 | 28.99× | ✓ | Martinez-family clipping — overlay ops only |
| 10000 | shapely | singular | 217.5 | 45,968 | 1.12× | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 10000 | shapely | batch | 189.1 | 52,875 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 10000 | turf | singular | 44032.9 | 227 | 226.21× | ✓ | web-mapping algorithm ports — GeoJSON-native, planar CRS not enforced |
| 100000 | bun-geos | singular | 1381.7 | 72,374 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | batch | 1347.2 | 74,228 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | geos-cpp | singular | 1300.9 | 76,868 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-wasm | singular | 3670.5 | 27,244 | 2.72× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | shapely | singular | 1541.4 | 64,876 | 1.14× | ✓ | shapely vectorized ufuncs = the batch-layer parallel |
| 100000 | shapely | batch | 1316.8 | 75,942 | ≈ | ✓ | shapely vectorized ufuncs = the batch-layer parallel |

## union

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100 | turf | unary | 15.9 | 6,289 | — | — | pairwise fold (no cascaded union); 100-tile ladder cap |
| 961 | bun-geos | coverage-safe | 4.2 | 229,959 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | coverage-raw | 0.5 | 1,983,578 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | unary | 9.5 | 101,672 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | bun-geos | auto | 4.1 | 236,592 | — | — | coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp |
| 961 | geos-cpp | unary | 9.4 | 102,101 | 19.43× | ✓ | includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-cpp | coverage-raw | 0.4 | 2,153,284 | ≈ | ✓ | includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-wasm | unary | 22.9 | 41,959 | 47.27× | ✓ | coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract) |
| 961 | geos-wasm | coverage-raw | 1.4 | 709,646 | 2.80× | ✓ | coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract) |
| 961 | jsts | unary | 60.2 | 15,974 | 124.18× | ✓ | Geometry.union() on a prebuilt MULTIPOLYGON (no coverage strategy in JSTS) |
| 961 | shapely | unary | 9.8 | 98,531 | 20.13× | ✓ | coverage-raw = union only (coverage_union_all does NO validity pre-check) |
| 961 | shapely | coverage-raw | 0.5 | 2,088,486 | ≈ | ✓ | coverage-raw = union only (coverage_union_all does NO validity pre-check) |

## prepared-scan

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 10000 | bun-geos | unprepared | 18.1 | 552,202 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | prepared | 0.7 | 15,148,853 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | bun-geos | prepared+batch | 0.8 | 12,744,698 | — | — | reference column — native FFI to GEOS 3.14 |
| 10000 | geos-cpp | unprepared | 18.1 | 552,793 | 27.40× | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-cpp | prepared | 0.5 | 21,179,979 | 0.72× | ✓ | GEOS C API called directly — zero boundary |
| 10000 | geos-wasm | unprepared | 30.7 | 325,564 | 46.53× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | geos-wasm | prepared | 1.4 | 6,956,459 | 2.18× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 10000 | shapely | unprepared | 19.8 | 505,235 | 29.98× | ✓ | vectorized; prepare() then auto-used by intersects |
| 10000 | shapely | prepared | 0.5 | 21,153,500 | 0.72× | ✓ | vectorized; prepare() then auto-used by intersects |
| 10000 | turf | unprepared | 23.4 | 426,878 | 35.49× | ✓ | ray-casting point-in-polygon (no prepared mode) |
| 100000 | bun-geos | unprepared | 182.0 | 549,302 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | prepared | 5.8 | 17,125,525 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | prepared+batch | 7.9 | 12,645,721 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | geos-cpp | unprepared | 181.4 | 551,254 | 31.07× | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-cpp | prepared | 4.8 | 20,946,756 | 0.82× | ✓ | GEOS C API called directly — zero boundary |
| 100000 | geos-wasm | unprepared | 309.7 | 322,910 | 53.03× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | geos-wasm | prepared | 15.1 | 6,603,225 | 2.59× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100000 | shapely | unprepared | 195.8 | 510,608 | 33.54× | ✓ | vectorized; prepare() then auto-used by intersects |
| 100000 | shapely | prepared | 4.8 | 21,028,265 | 0.81× | ✓ | vectorized; prepare() then auto-used by intersects |
| 100000 | turf | unprepared | 234.2 | 426,960 | 40.11× | ✓ | ray-casting point-in-polygon (no prepared mode) |

## strtree

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100000 | bun-geos | build | 31.5 | 3,172,852 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query | 3.7 | — | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query-batch | 3.6 | — | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | bun-geos | query+fused | 21.2 | 4,719,709 | — | — | reference column — native FFI to GEOS 3.14 |
| 100000 | flatbush | build | 8.1 | 12,323,280 | 2.28× | ✓ | static packed index (index angle only, immutable data) |
| 100000 | flatbush | query | 3.8 | — | ≈ | ✓ | static packed index (index angle only, immutable data) |
| 100000 | geos-cpp | build | 14.1 | 7,097,898 | 3.96× | ✓ | build includes the build-forcing first query (C API has no explicit build) |
| 100000 | geos-cpp | query | 1.7 | — | 0.47× | ✓ | build includes the build-forcing first query (C API has no explicit build) |
| 100000 | jsts | build | 24.3 | 4,110,433 | 6.84× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100000 | jsts | query | 7.7 | — | 2.16× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100000 | rbush | build | 14.7 | 6,823,395 | 4.12× | ✓ | dynamic R-tree specialist (index angle only) |
| 100000 | rbush | query | 7.8 | — | 2.20× | ✓ | dynamic R-tree specialist (index angle only) |
| 100000 | shapely | build | 15.7 | 6,370,636 | 4.41× | ✓ |  |
| 100000 | shapely | query | 2.8 | — | 0.79× | ✓ |  |

## ingest

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 20000 | bun-geos | wkt | 45.5 | 439,823 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | geojson | 34.5 | 579,577 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | wkb | 11.0 | 1,824,722 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | bun-geos | wkb-batch | 10.9 | 1,832,717 | — | — | reference column — native FFI to GEOS 3.14 |
| 20000 | geos-cpp | wkt | 23.9 | 837,089 | 2.19× | ✓ | GEOS C API called directly — zero boundary |
| 20000 | geos-cpp | wkb | 3.5 | 5,701,061 | 0.32× | ✓ | GEOS C API called directly — zero boundary |
| 20000 | geos-wasm | wkt | 166.6 | 120,050 | 15.27× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 20000 | geos-wasm | wkb | 19.4 | 1,031,749 | 1.78× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 20000 | jsts | wkt | 55.1 | 363,080 | 5.05× | ✓ | the jsts npm bundle ships no WKB codecs — WKT ingest only |
| 20000 | shapely | wkt | 72.0 | 277,637 | 6.60× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkt-batch | 34.2 | 585,419 | 3.13× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkb | 35.6 | 561,153 | 3.27× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | shapely | wkb-batch | 4.8 | 4,156,553 | 0.44× | ✓ | per-item loop vs vectorized ufunc |
| 20000 | wkx | wkt | 27.4 | 728,898 | 2.51× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkb | 3.6 | 5,618,536 | 0.33× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkt-write | 17.1 | 1,169,369 | 1.57× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |
| 20000 | wkx | wkb-write | 4.5 | 4,476,471 | 0.41× | ✓ | pure-JS WKB/WKT codec (ingest angle only) |

## makevalid

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 1000 | bun-geos | makevalid | 38.1 | 26,277 | — | — | reference column — native FFI to GEOS 3.14 |
| 1000 | geos-cpp | makevalid | 40.8 | 24,494 | ≈ | ✓ | GEOS C API called directly — zero boundary |
| 1000 | geos-wasm | makevalid | 96.5 | 10,366 | 2.53× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 1000 | shapely | makevalid | 39.6 | 25,233 | ≈ | ✓ |  |

## buffer

| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |
|---|---|---|---|---|---|---|---|
| 100 | bun-geos | buffer | 14.6 | 6,849 | — | — | reference column — native FFI to GEOS 3.14 |
| 100 | geos-cpp | buffer | 12.2 | 8,214 | 0.83× | ✓ | GEOS C API called directly — zero boundary |
| 100 | geos-wasm | buffer | 18.5 | 5,396 | 1.27× | ✓ | GEOS 3.13 via Emscripten — raw C API, manual heap plumbing |
| 100 | jsts | buffer | 17.9 | 5,575 | 1.23× | ✓ | JTS port in pure JS — the strongest JS-native engine |
| 100 | shapely | buffer | 12.6 | 7,948 | 0.86× | ✓ |  |
| 100 | turf | buffer | 84.1 | 1,189 | 5.76× | ✗ | geographic projection built in — planar fingerprint mismatch expected |

## Failures & skips

- `geos-wasm` strtree@100000: GEOSSTRtree_query callback binding unusable (call_indirect to a signature that does not match (evaluating '$(A)(g, I, B)'))
- `jsts` prepared-scan: _skipped_ — op not workable against the installed package's API

