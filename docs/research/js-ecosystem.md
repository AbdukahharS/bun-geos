# Research: the JS/TS geospatial landscape

> Status: reference, verified against npm registry data and project repositories,
> October 2026. Conclusion: the native-GEOS niche in JS/TS is empty; this package fills it.

## The options today

| Package | Approach | State (2026) | Assessment |
|---------|----------|--------------|------------|
| `geos` (npm) | node-gyp C++ addon | v0.0.4, last published **August 2013**; requires Node ≥ 0.10; builds with node-gyp + CoffeeScript | Dead. The native slot on npm has been vacant for over a decade. |
| `node-geos` (GitHub) | the same project's repo | Unmaintained; the bindings page of libgeos.org still points at it | Dead. |
| `geos-wasm` | Emscripten build of GEOS **3.13** | Latest 3.1.1 (Dec 2024); LGPL; works in browser, Node, **Bun**, Deno | The only live real-GEOS option. See below. |
| `@turf/turf` | Pure-JS ports of JTS subsets | Active | No true overlay topology engine; boolean ops historically via the Martinez algorithm; robustness on degenerate/pathological inputs is a known weakness; performance is a re-implementation tax. |
| `polygon-clipping` / `martinez-*` | Pure-JS boolean clipping | Maintained-ish | Good for modest inputs; no validity repair, no spatial index, no prepared predicates, no coverage ops. |
| `wkx` / `@syncpoint/wkx` | Pure-JS WKB/WKT codecs | OK | Confirms demand for format codecs; our native WKB reader/writer outperforms these at scale. |

## geos-wasm in detail (the benchmark to beat, and the fallback story)

- GEOS 3.13.0 compiled with Emscripten; exposes the **raw C API** over the WASM heap.
- Ergonomics are pointer-plumbing: every operation is a pile of manual memory calls.
  Their own README example for *computing an area*:

```js
const reader = geos.GEOSWKTReader_create()
const wktPtr  = geos.Module._malloc(wkt.length + 1)
geos.Module.stringToUTF8(wkt, wktPtr, size)
const geomPtr = geos.GEOSWKTReader_read(reader, wktPtr)
const areaPtr = geos.Module._malloc(8)
geos.GEOSArea(geomPtr, areaPtr)
const area = geos.Module.getValue(areaPtr, 'double')
geos.GEOSWKTReader_destroy(reader)
geos.GEOSGeom_destroy(geomPtr)
geos.GEOSFree(areaPtr)
geos.Module._free(wktPtr)
```

That verbosity is not a design flaw of geos-wasm specifically — it's what "raw GEOS with
no wrapper layer" looks like. **Nobody has built the wrapper layer natively.**

- Constraints by construction: single-threaded (WASM), boundary crossing per call, no
  access to OverlayNG-era threading wins, and a GC-invisible heap like any FFI.
- **Uses for us:** (a) the benchmark baseline that proves native's advantage; (b) the
  recommended package for users who need *browser* GEOS — we are Bun-only by design and
  should happily redirect browser workloads to geos-wasm.

## Why turf never solved this

Turf is indispensable for web mapping, but it is a collection of algorithm ports, not a
topology engine: no robust overlay noding, no validity model, no coverage algebra.
Projects that need PostGIS-grade answers in JS today either run PostGIS/DuckDB or reach
for geos-wasm and accept the pointer plumbing.

## The gap, stated precisely

There is no JS/TS package that simultaneously offers:

1. **the real PostGIS-grade engine** (GEOS, current major),
2. **native speed** (no WASM boundary, no reimplementation),
3. **a typed, GC-safe API** (numeric pointers + explicit disposal, not raw malloc/free),
4. **batch/vectorized operations** (the Shapely-2.0 lesson, applied from day one).

Every one of the four is directly enabled by the GEOS C API + `bun:ffi`'s typed-array
model. That intersection is this project. Demand signal: geos-wasm exists and is used
*despite* its ergonomics, because there is nothing else.

## Competitive positioning summary

| Workload | Who wins today | Why it flips with @shzd/bun-geos |
|----------|----------------|----------------------------------|
| Massive robust overlays / unions | PostGIS (server), geos-wasm (slow) | Native OverlayNGRobust + CoverageUnion strategies, batch I/O |
| Topology repair (make-valid, coverage cleaning) | Nobody in JS | GEOS 3.14 `MakeValidWithParams` + `CoverageClean` as first-class API |
| Indexed spatial predicates | JS brute force / turf booleans | STRtree + RelateNG prepared predicates returning typed-array masks |
| Small browser-side geometry math | turf, geos-wasm | **Not our market** — we are Bun-only and will say so |
