---
description: Every public export on one page — complete signatures for construction and I/O, predicates, overlays, repair, measures, precision, batch forms, and the parallel pool.
---

# API reference

Every public export, one page. Signatures are complete; behaviors live in the
[guides](/guide/io). All geometry methods hang off a `Geos` instance — geometries in,
geometries out, one FFI crossing each.

- [Classes](#classes)
- [Construction & I/O](#construction--io)
- [Predicates](#predicates)
- [Overlays & buffers](#overlays--buffers)
- [Construction ops](#construction-ops)
- [Measures & points of interest](#measures--points-of-interest)
- [Validity, repair & coverage](#validity-repair--coverage)
- [Precision](#precision)
- [Accessors](#accessors)
- [Batch forms](#batch-forms)
- [Interrupt & context infra](#interrupt--context-infra)
- [Errors](#errors)

## Classes

| Export | One-liner |
|--------|-----------|
| `Geos` | owns a GEOS context; every op is a method on it |
| `Geometry` | an owned handle to a native geometry; `Disposable` |
| `Arena` | bulk-destroy scope: everything created inside dies in one call |
| `Prepared` | prepared predicate structure from `g.prepare()` |
| `STRtree` | envelope index; `query` → `Int32Array` of ids |
| `GeosError` | data/GEOS failure: `op`, `geosMessage`, `detail` |
| `LoaderError` | native load / environment failure |
| `GeosParallelError` | all-or-nothing parallel failure with `chunkErrors` |

`new Geos(opts?: { library?: string })` — the first construction in a process loads
the native libraries; the library setting is pinned process-wide.

### `Geos` infrastructure

```ts
geos.version: string
geos.stats: GeosStats          // { liveGeoms, heapBytesApprox, finalized, peakLiveGeoms, arenaHighWater }
geos.statsPrecise(): { liveGeoms: number; heapBytesApprox: number }
geos.arena(): Arena
geos.parallel: Parallel        // worker pool — see below
geos.dispose(): void
```

## Construction & I/O

```ts
fromWKT(wkt: string): Geometry
toWKT(g, opts?: WKTOptions): string                  // { precision, trim, outputDimension, old3D }
fromWKB(wkb: Uint8Array): Geometry                   // ISO + PostGIS EWKB
toWKB(g, opts?: WKBOptions): Uint8Array              // { byteOrder, outputDimension, flavor, includeSRID }
fromWKBMany(wkb: Uint8Array, offsets: Uint32Array, opts?: { arena? }): Geometry[]
fromGeoJSON(geo: GeoJSONGeometryObject | GeoJSONFeature): Geometry
toGeoJSON(g, opts?: { includeZ?: boolean }): GeoJSONGeometryObject
fromArrow(arr: ArrowInput): Geometry                 // tagged geoarrow.* or legacy shapes
toArrow(g): ArrowArray
```

The WKT/WKB readers are **linear-only**: curved payloads (`CIRCULARSTRING`,
`CURVEPOLYGON`, …) throw a `GeosError` naming the type — curves nested inside a
`GEOMETRYCOLLECTION` included. → [Geometry I/O](/guide/io).

Direct constructors:

```ts
point(x: number, y: number, z?: number, m?: number): Geometry
fromCoords(spec: FlatCoords, kind?: "point" | "linestring"): Geometry
fromPolygonal(spec: Polygonal): Geometry             // rings + part offsets; >1 part = multipolygon
fromParts(kind: CollectionKind, parts: Geometry[], opts?): Geometry
empty(kind: EmptyKind, arena?: Arena): Geometry
```

Accessors: `coordinates(g): FlatCoords` — `{ coords: Float64Array, n, hasZ, hasM }`.
SRIDs: `srid(g): number | null`, `setSrid(g, srid | null)` — a label that round-trips
through EWKB, never a transformation.

## Predicates

```ts
intersects(a, b): boolean      disjoint(a, b): boolean
touches(a, b): boolean         crosses(a, b): boolean
within(a, b): boolean          contains(a, b): boolean
overlaps(a, b): boolean        covers(a, b): boolean      coveredBy(a, b): boolean
equals(a, b): boolean          equalsIdentical(a, b): boolean
relateMatrix(a, b): string                       // DE-9IM string
relatesPattern(a, b, pattern: string): boolean   // query by DE-9IM mask
```

### `Prepared` — from `g.prepare()`

```ts
intersects/contains/containsProperly/coveredBy/covers/crosses/disjoint/overlaps/touches/within(b): boolean
intersectsXY(x, y): boolean        containsXY(x, y): boolean
relate(b): string                  relatePattern(b, pattern): boolean
// batch masks, one crossing each:
intersectsAll/containsAll/containsProperlyAll/coveredByAll/coversAll/
  crossesAll/disjointAll/overlapsAll/touchesAll/withinAll(bs, opts?): Uint8Array
relatePatternAll(bs, pattern, opts?): Uint8Array
```

### `STRtree` — from `geos.strtree(geoms?, nodeCapacity = 10)`

```ts
insert(g): number                  // pre-build only
build(): void                      // query() auto-builds; insert after build throws
query(env: Geometry): Int32Array   // envelope candidates — exact filter is yours
queryAll(envs): { ids: Int32Array; offsets: Uint32Array }  // N queries, one crossing
nearest(g): number                 // id, or -1 for an empty tree
queryFilter(env, pg: Prepared, pred?: PreparedPredName): Int32Array  // index + exact predicate, one crossing
get(id): Geometry
size: number                       built: boolean
```

## Overlays & buffers

```ts
intersection(a, b, opts?): Geometry     union(a, b, opts?): Geometry
difference(a, b, opts?): Geometry       symDifference(a, b, opts?): Geometry
unaryUnion(g, opts?): Geometry
unionAll(gs, opts?: UnionAllOptions): Geometry   // strategy: "auto" | "coverage" | "disjointSubset" | "unary"
coverageUnion(gs, opts?): Geometry
buffer(g, distance, opts?: BufferOptions): Geometry  // { quadSegs=8, join="round"|"mitre"|"bevel", mitreLimit=5, singleSided }
```

`opts?` on overlays is `OpOptions` (`{ signal }`). Fixed-precision overlays:
`intersectionPrec/unionPrec/differencePrec/symDifferencePrec/unaryUnionPrec(a, b, gridSize, opts?)`.

## Construction ops

```ts
convexHull(g): Geometry                              concaveHull(g, ratio, opts?): Geometry
simplify(g, tolerance): Geometry                     topologyPreserveSimplify(g, tolerance): Geometry
clipByRect(g, xmin, ymin, xmax, ymax): Geometry
delaunay(g, opts?): Geometry                         constrainedDelaunay(g): Geometry
voronoi(g, opts?): Geometry
lineMerge(g, opts?): Geometry                        lineSubstring(g, start, end): Geometry
offsetCurve(g, distance, opts?): Geometry            sharedPaths(a, b): Geometry
snap(a, b, tolerance): Geometry                      node(g): Geometry
buildArea(g): Geometry                               polygonize(g | gs): Geometry
orientPolygons(g, dir?: "ccw" | "cw"): Geometry
```

## Measures & points of interest

```ts
area(g): number              length(g): number
distance(a, b): number       hausdorff(a, b): number      frechet(a, b): number
centroid(g): Geometry        interiorPoint(g): Geometry
nearestPoints(a, b): [Geometry, Geometry]
minimumClearance(g): number  minimumClearanceLine(g): Geometry
maximumInscribedCircle(g, tolerance): Geometry
largestEmptyCircle(g, tolerance, opts?): Geometry
clusterDBSCAN(gs, eps, minPoints): Int32Array        // cluster id per input, -1 = noise
gridIntersectionFractions(g, { xmin, ymin, xmax, ymax, nx, ny }): Float32Array
```

## Validity, repair & coverage

```ts
isValid(g): boolean                 isEmpty(g): boolean
isValidDetail(g): ValidityDetail            // { valid, reason, location: Geometry }
isSimpleDetail(g, opts?): SimpleDetail      // { simple, location: Geometry | null }
makeValid(g, opts?): Geometry               // { method: "linework" | "structure", keepCollapsed }
coverageIsValid(gs, opts?): CoverageValidity
coverageClean(gs, opts?): Geometry[]
coverageSimplifyVW(gs, tolerance, opts?): Geometry[]
```

## Precision

```ts
setPrecision(g, gridSize, opts?): Geometry   // PrecisionMode: validOutput | noTopo | keepCollapsed
getPrecision(g): number
```

## Accessors

```ts
geomType(g): string          typeId(g): GeoTypeId
numGeometries(g): number     getGeometryN(g, n): Geometry
numInteriorRings(g): number  exteriorRing(g): Geometry    interiorRingN(g, n): Geometry
numPoints(g): number         envelope(g): Geometry        boundary(g): Geometry
hasZ / hasM: boolean         // on Geometry
```

## Batch forms

One FFI crossing per call; masks are `Uint8Array` aligned to input order, measures are
`Float64Array`, geometry answers are `Geometry[]`. `bs` is a `BatchInput` (array of
`Geometry`, or a batch shape):

```ts
// predicates → Uint8Array masks
intersectsAll / disjointAll / touchesAll / crossesAll / withinAll / containsAll /
overlapsAll / coversAll / coveredByAll(a, bs, opts?): Uint8Array
predicateAll(pred: UnpreparedPredName, a, bs, opts?): Uint8Array

// measures → Float64Array
areaAll(gs, opts?)    lengthAll(gs, opts?)
distanceAll / hausdorffAll / frechetAll(a, bs, opts?): Float64Array

// geometry → Geometry[]
intersectionAll / differenceAll / symDifferenceAll(a, bs, opts?)
bufferAll(gs, distance, opts?)   convexHullAll(gs, opts?)
simplifyAll / topologyPreserveSimplifyAll(gs, tolerance, opts?)
clipByRectAll(gs, xmin, ymin, xmax, ymax, opts?) centroidAll / boundaryAll / interiorPointAll(gs, opts?)
nodeAll / lineMergeAll(gs, opts?)   snapAll / sharedPathsAll(a, bs, opts?)
intersectionPrecAll / differencePrecAll / symDifferencePrecAll(a, bs, gridSize, opts?)
```

## Interrupt & context infra

```ts
// OpOptions = { signal?: AbortSignal } — accepted by every cancellable op
interruptRequest(): void   // flip the process-global interrupt flag (cross-thread cancellation)
interruptReset(): void
```

## `Parallel` — from `geos.parallel`

Promise mirrors of the batch forms on a worker pool
(`concurrency`, `chunkFactor`, `minChunkGeoms`, `jobTimeoutMs`, `signal`):
`intersectionAll`, `differenceAll`, `symDifferenceAll`, the nine predicate masks,
`areaAll`–`frechetAll`, `bufferAll`, `makeValid`, `unionAll`. Failure is
all-or-nothing via `GeosParallelError`. See [Workers & parallelism](/guide/workers).

## Errors

```ts
class GeosError extends Error {
  op: string                    // e.g. "fromGeoJSON", "aborted"
  geosMessage?: string          // the captured GEOS message
  detail?: { jsonPath?, ring?, vertex?, byteOffset? }
  diagnostics?: { validReason?, locationWKT?, simpleLocationsWKT? }  // reserved slot
}
class LoaderError extends Error {}                       // environment / native load
class GeosParallelError extends GeosError {
  chunkErrors: Array<{ chunk: number; message: string }>
}
```

Programming errors throw `TypeError`/`RangeError`. Data and GEOS failures throw
`GeosError`. The taxonomy: [Errors](/guide/errors).

## Constants & enums

Exported as values + types (numeric ids are ABI-pinned, safe to serialize):
`GeoType`, `geoTypeName()`, `OverlayOp`, `BinaryOp`, `UnaryOp`, `MeasureOp`,
`PreparedPred`, `UnpreparedPred`, `UnionStrategy`, `MakeValidMethod`
(`linework`/`structure`), `PrecisionMode` (`validOutput`/`noTopo`/`keepCollapsed`),
`OverlapMergeStrategy`. Key types: `Geometry`, `FlatCoords`, `Polygonal`, `LineArray`,
the `geoarrow.*` array shapes, `GeoJSONFeature`, `WKTOptions`, `WKBOptions`,
`GeoJSONOptions`, `BatchInput`, `OpOptions`, `ParallelOptions`, `GeosStats`.
