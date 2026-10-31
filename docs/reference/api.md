# API reference

> Covers every public export of `@shzd/bun-geos` (0.2.0). Design rationale
> lives in the [decision record](../decisions.md) (D-numbers) and the
> archived [api-surface](../archive/api-surface.md) target; the JS ↔ `geos_c` symbol mapping
> is [symbols.md](./symbols.md). A freshness test
> (`test/unit/reference.test.ts`) fails when a public name is missing here.

## Conventions

- **Disposal (D10):** `Geos`, `Geometry`, `Prepared`, `STRtree`, `Arena`
  implement `[Symbol.dispose]` — prefer `using`. Disposing a pinned
  geometry throws `TypeError`; use-after-dispose throws.
- **Errors (D13):** data/GEOS failures throw `GeosError` (`op`,
  `geosMessage`, `detail`, `diagnostics`); programming errors (foreign
  context, bad option values) throw `TypeError`/`RangeError`.
- **Cancellation (D19):** every op accepts a trailing `{ signal }` where
  cancellation is meaningful; an aborted op throws `GeosError` with
  `op: "aborted"` and `cause: signal.reason`. A main-thread sync call
  cannot be interrupted mid-flight by a same-thread listener — use
  `geos.parallel.*` for true mid-flight cancellation.
- **Batch naming:** element-wise forms are `*All`
  (`intersectionAll(a, bs)[i] === intersection(a, bs[i])`);
  `unionAll(gs)` is the aggregate (D20). Batch inputs accept
  `Geometry[]` or a GeoArrow-shaped value (D9/D28).
- **One `Geos` per thread (D3/D11);** geometries never cross contexts —
  transfer WKB/GeoJSON/Arrow copies.
- **Planar CRS only.** Project lat/lon data first; there is no geodetic math.

## Lifecycle

### `new Geos(opts?: { library?: string })`
Owns one `GEOSContextHandle_t` (D3). `library` overrides the platform
package (the `BUN_GEOS_LIBRARY` escape hatch, D8) — still asserted to be
GEOS 3.14.x. Lazily loads the shim + GEOS; throws `LoaderError` with
remediation text on any failure.

### `geos.dispose()` / `[Symbol.dispose]`
Tears down consumables FIRST (Prepared, STRtree, the parallel pool — with
the shutdown-ack protocol, D23), then pooled params, then remaining
geometries, then the context.

### `geos.stats` / `geos.statsPrecise()`
`stats` — cheap JS counters: `liveGeoms`, `heapBytesApprox`,
`finalizerReaps`, `peakLiveGeoms`, `arenaHighWater` (D24).
`statsPrecise()` — one shim crossing over live pointers: per geometry
64 B + vertices × dims × 8. Documented approximate (M ordinates are not
per-geometry detectable).

### `geos.arena()`
`using arena = geos.arena()` — every geometry created inside registers;
exit frees them in ONE `geos_shim_destroy_many` call. Nested arenas are
allowed; pinning a geometry (prepare/strtree) relinquishes it from the
arena (D17).

### `geos.parallel`
The lazily-spawned worker pool (D23) — see [Parallel](#parallel).

### `geos.version`
The GEOS version string (informational only, D5).

## I/O

Linear geometries only (D31): the readers reject curved payloads
(`CIRCULARSTRING`, `COMPOUNDCURVE`, `CURVEPOLYGON`, `MULTICURVE`,
`MULTISURFACE` — including nested in a `GEOMETRYCOLLECTION`) with a
`GeosError` naming the type; nesting deeper than 32 collection levels
also throws (the shim's pathological-nesting guard). Batch reads are
all-or-nothing.

| op | notes |
|----|-------|
| `geos.fromWKT(wkt)` | parses via the pooled reader; errors carry the GEOS message |
| `geos.toWKT(g, opts?)` | `WKTOptions` (`trim`, `roundingPrecision`, `outputDimension`, `old3D`); default Shapely-style trimmed |
| `geos.fromWKB(buf)` / `geos.toWKB(g, opts?)` | `WKBOptions` (`byteOrder`, `outputDimension`, `includeSRID`); PostGIS `bytea` (EWKB) roundtrips incl. SRID |
| `geos.fromWKBMany(buf, offsets, opts?)` | n geometries from one buffer, one crossing (u32 byte offsets cap at 4 GB) |
| `geos.fromGeoJSON(obj)` / `geos.toGeoJSON(g, opts?)` | parsed/ assembled in JS for precise errors (D13); `GeoJSONOptions` (`feature`, `srid`); winding preserved as input |
| `geos.fromArrow(input)` / `geos.toArrow(g)` | GeoArrow shapes v2 (D28) — see below |
| `geos.fromCoords(flat, kind?)` | FlatCoords (`Float64Array` + `n`) → point/linestring; canonical currency (D9) |
| `geos.fromPolygonal(spec)` | ring/part offsets → polygon/multipolygon |
| `geos.fromParts(kind, parts, opts?)` | collection from owned parts; `transfer: true` consumes them; rejects duplicates (audit C2) |
| `geos.empty(kind, arena?)` | typed empties (`POINT EMPTY`, `MULTIPOLYGON EMPTY`, …) |
| `geos.point(x, y, z?, m?)` | convenience constructor; non-finite ordinates throw |

### GeoArrow shapes v2 (D28)

Tagged values whose `kind` names the extension type (`geoarrow.point`,
`geoarrow.linestring`, `geoarrow.polygon`, `geoarrow.multipoint`,
`geoarrow.multilinestring`, `geoarrow.multipolygon`,
`geoarrow.geometry`), with interleaved coord buffers, end-index member
offsets, and optional Arrow LSB `validity` bitmaps:

- multi\* members are the leaf geometries — one shape is one MULTI\*
  geometry AND a batch of member slots.
- empty MULTI\* = length-0 offsets (roundtrip); an empty member = a
  repeated offset (POINT EMPTY).
- `geometrycollection` = dense-union emulation (`types`/`offsets` into
  `children`).
- batch slots honor `nullMode`: `"throw"` (default, names the slot) or
  `"skip"` (omits — output is SHORTER than the slot count).
- legacy untagged Phase-1 shapes are still accepted; `toArrow` emits
  tagged only. Conformance is pinned against the reference
  implementation's canonical bytes (see
  `test/differential/geoarrow-goldens.test.ts`).

### `Geometry`

- `g.ptr`, `g.geos`, `g.owned`, `g.bigint` — branded handle + owner
  (same-context rule is enforced via `requireSame`).
- `g.userData` — side-channel (GeoJSON round-trip members ride here).
- `g.hasZ` / `g.hasM` / `g.disposed` / `g.pinned`.
- `g.dispose()` / `[Symbol.dispose]`; `g.prepare()` → `Prepared`.
- `g.assertAlive()`, `g.requireSame(geos)`, `g.pinBy(consumer)` /
  `g.unpinBy(consumer)`, `g.renounce()` — ownership plumbing (D17).

## Predicates

`geos.intersects`, `disjoint`, `touches`, `crosses`, `within`, `contains`,
`overlaps`, `covers`, `coveredBy`, `equals` (topological), `equalsIdentical`
(exact, 3.12), `relatesPattern(a, b, pattern)` (DE-9IM match),
`relateMatrix(a, b)` (the 9-char matrix).

## Prepared (RelateNG, 3.13+)

`using prep = a.prepare()` — pins the source (D17). Methods:
`intersects`, `contains`, `containsProperly`, `coveredBy`, `covers`,
`crosses`, `disjoint`, `overlaps`, `touches`, `within` — plus
`intersectsXY(x, y)` / `containsXY(x, y)` point fast paths, `relate(b)`
(full matrix), `relatePattern(b, pattern)`, and `*All` batch masks
(`intersectsAll` et al.) returning `Uint8Array` 0/1 (D18).

## Overlays & boolean ops

`geos.intersection`, `union`, `difference`, `symDifference`, `unaryUnion`
— OverlayNGRobust underneath (3.10+). `unionAll(gs, { strategy })` —
`"auto"` (validate → CoverageUnion, else DisjointSubsetUnion, else unary),
`"coverage"`, `"disjointSubset"`, `"unary"` (D20); `coverageUnion(gs)` is
the raw caller-asserts fast path.

## Precision model

`geos.setPrecision(g, gridSize, { mode })` (`"validOutput"`, `"noTopo"`,
`"keepCollapsed"`), `geos.getPrecision(g)`, and the `*Prec` overlays:
`intersectionPrec`, `unionPrec`, `differencePrec`, `symDifferencePrec`,
`unaryUnionPrec`.

## Topology repair

| op | notes |
|----|-------|
| `geos.isValid(g)` | |
| `geos.isValidDetail(g)` | `{ valid, reason, location? }` (owned location geometry) |
| `geos.isSimpleDetail(g, { findAll? })` | `{ simple, locations? }` (3.14) |
| `geos.makeValid(g, { method?, keepCollapsed? })` | `"linework"` / `"structure"`; params re-set every call (D21) |
| `geos.orientPolygons(g, dir?)` | clones first — input never mutated; INT return semantics |
| `geos.coverageIsValid(gs, opts?)` | `{ valid, errorEdges? }` |
| `geos.coverageClean(gs, opts?)` | `gapMaximumWidth`, `snappingDistance`, `overlapStrategy`; every option re-set per call (D21) |
| `geos.coverageSimplifyVW(gs, tolerance, opts?)` | coverage-aware Visvalingam |

## Measures

`geos.area`, `geos.length`, `geos.distance`, `geos.hausdorff`,
`geos.frechet`, and `geos.buffer(g, distance, opts?)` (`quadSegs`,
`join`, `mitreLimit`, `singleSided`).

## Construction ops (Phase 5, D27)

Hulls & simplification:

| op | notes |
|----|-------|
| `geos.convexHull(g)` | |
| `geos.concaveHull(g, ratio, { allowHoles? })` | ratio ∈ [0, 1]; 1 = convex |
| `geos.simplify(g, tolerance)` | Douglas-Peucker |
| `geos.topologyPreserveSimplify(g, tolerance)` | never introduces self-intersections |
| `geos.clipByRect(g, xmin, ymin, xmax, ymax)` | fast rectangular clip (not a robust overlay) |

Triangulations: `geos.delaunay(g, { tolerance?, onlyEdges? })`,
`geos.constrainedDelaunay(g)` (3.13), `geos.voronoi(g, { tolerance?,
onlyEdges?, envelope?, ordered? })`.

Line ops: `geos.lineMerge(g, { directed? })`, `geos.lineSubstring(g,
start, end)` (fractions ∈ [0, 1], start ≤ end), `geos.offsetCurve(g,
distance, { quadSegs?, join?, mitreLimit? })` (left positive),
`geos.sharedPaths(a, b)` (LINEAL-only — GEOS throws on areal inputs),
`geos.snap(a, b, tolerance)`.

Topology building: `geos.node(g)`, `geos.buildArea(g)`,
`geos.polygonize(g | gs)` (inputs borrowed).

Centers, distances, clustering:

| op | notes |
|----|-------|
| `geos.centroid(g)` | empty-safe |
| `geos.interiorPoint(g)` | `GEOSPointOnSurface` — guaranteed on the surface |
| `geos.nearestPoints(a, b)` | `[pOfA, pOfB]` (owned); for many queries use `STRtree.nearest` |
| `geos.minimumClearance(g)` / `geos.minimumClearanceLine(g)` | the distance at which the topology holds |
| `geos.maximumInscribedCircle(g, tolerance)` | two-point LINESTRING (center → boundary); tolerance REQUIRED |
| `geos.largestEmptyCircle(g, tolerance, { boundary? })` | same encoding; tolerance REQUIRED |
| `geos.clusterDBSCAN(gs, eps, minPoints)` | `Int32Array` of cluster ids per input, **-1 = noise** (D16 lesson: ids, never pointers) |
| `geos.gridIntersectionFractions(g, { xmin, ymin, xmax, ymax, nx, ny })` | `Float32Array` nx×ny coverage fractions in [0, 1] |

`geos.boundary(g)` lives with the accessors.

## Accessors

`geos.geomType`, `geos.typeId`, `geos.isEmpty`, `geos.isValid`,
`geos.envelope`, `geos.boundary`, `geos.numGeometries`,
`geos.getGeometryN`, `geos.numInteriorRings`, `geos.exteriorRing`,
`geos.interiorRingN`, `geos.numPoints`, `geos.coordinates` (FlatCoords),
`geos.srid`, `geos.setSrid`.

## Batch forms (`*All`, D22/D27)

One shim crossing per array; all-or-nothing (D18); interrupt checks
between items; inputs are `Geometry[]` or Arrow-shaped.

- Overlays: `intersectionAll`, `differenceAll`, `symDifferenceAll`,
  `intersectionPrecAll`, `differencePrecAll`, `symDifferencePrecAll`
  (NO element-wise `unionAll` — that name is the aggregate, D20).
- Masks: `intersectsAll`, `containsAll`, `coveredByAll`, `coversAll`,
  `crossesAll`, `disjointAll`, `overlapsAll`, `touchesAll`, `withinAll`
  (the nine unprepared predicates), or `predicateAll(name, a, bs)` with a
  `UnpreparedPredName`.
- Measures: `areaAll`, `lengthAll`, `distanceAll`, `hausdorffAll`,
  `frechetAll`.
- `bufferAll(gs, distance, opts?)` — params built once.
- Construction (D27): `convexHullAll`, `centroidAll`, `boundaryAll`,
  `interiorPointAll`, `simplifyAll(gs, tolerance)`,
  `topologyPreserveSimplifyAll(gs, tolerance)`, `clipByRectAll(gs, …)`,
  `nodeAll`, `lineMergeAll`, `snapAll(a, bs, tolerance)`,
  `sharedPathsAll(a, bs)`.

BatchOptions: `{ arena?, signal? }` — outputs register in `arena` (or the
innermost open one).

## STRtree

```ts
const tree = geos.strtree(geoms?, nodeCapacity = 10);
tree.insert(g): number;   // returns the id (input order)
tree.insertMany(geoms): number[];  // ONE crossing (D32); ids continue the sequence
tree.build(): void;       // frozen after build (D16: the id table binds here)
tree.query(env): Int32Array;      // candidate ids, one crossing
tree.queryAll(envs): { ids: Int32Array; offsets: Uint32Array };  // N queries, one crossing;
                                 // query i owns ids[offsets[i-1] .. offsets[i])
tree.queryFilter(env, prep, pred?): Int32Array;  // fused query+prepared filter
tree.nearest(g): number;          // -1 when the tree is empty
tree.dispose();
```
Items are integer ids, 1-based in C (D16); the wrapper holds strong pinned
references to indexed geometries (D17). Removing an item = rebuild
(documented). `insertMany` validates every input before the crossing and
continues the id sequence after prior `insert` calls (ids[i] = size-before
+ i) — all-or-nothing at the JS boundary (D32).

## Parallel

`geos.parallel.*` mirrors the batch core on the worker pool (D23):
`intersection`, `union`, `difference`, `symDifference`, the nine masks,
`distance`/`hausdorff`/`frechet`, `bufferAll`, `makeValid`, `unionAll`,
`areaAll`, `lengthAll` — all returning Promises. Options:
`ParallelOptions` (`concurrency`, `chunkFactor`, `minChunkGeoms`,
`jobTimeoutMs`, `signal`). At most ONE signal-taking op in flight per
pool; chunking by cumulative vertex count; results reassemble in input
order; failures aggregate into `GeosParallelError` (per-chunk string
diagnostics, D21). The pool is a consumable: disposing the `Geos` shuts it
down (shutdown-ack before terminate).

## Interrupt

`geos.interruptRequest()` / `geos.interruptReset()` — direct access to the
shim's atomic global flag (D19). `withSignal` wraps every signal-taking
op: pre-check, listener, reset in `finally`, uniform `op: "aborted"` shape.

## Errors

- `GeosError` — `op`, `geosMessage`, `detail` (ring/vertex/byteOffset/
  jsonPath), `diagnostics` (string-only repair diagnostics, D21).
- `LoaderError` — load/resolve failures with remediation text.
- `GeosParallelError` — per-chunk string diagnostics (D23.5).

## Op-id tables (values, exported for shim-ABI pinning)

`OverlayOp` (8), `UnpreparedPred` (9), `MeasureOp` (5), `PreparedPred`
(10), `UnionStrategy`, `PrecisionMode`, `MakeValidMethod`,
`OverlapMergeStrategy`, `UnaryOp` (9), `BinaryOp` (2), `GeoType` +
`geoTypeName` — each MUST match its `SHIM_*` enum in `native/shim.c`
(selftest-pinned).

## Types

`Geometry`, `Prepared`, `STRtree`, `Arena`, `Geos`, `GeosStats`,
`OpOptions`, `BatchInput`, `BatchOptions`, `BufferOptions`,
`BufferAllOptions`, `UnionAllOptions`/`UnionAllStrategy`,
`SetPrecisionOptions`, `MakeValidOptions`, `ValidityDetail`,
`SimpleDetail`, `CoverageIsValidOptions`/`CoverageCleanOptions`/
`CoverageSimplifyOptions`/`CoverageValidity`,
`WKTOptions`/`WKBOptions`/`FromWKBManyOptions`/`GeoJSONOptions`/
`GeoJSONGeometryObject`/`GeoJSONFeature`, the Arrow shapes v2
(`ArrowArray`, `ArrowInput`, `PointArray`, `LineStringArray`,
`PolygonArray`, `MultiPointArray`, `MultiLineStringArray`,
`MultiPolygonArray`, `GeometryCollectionArray`, `ArrowInput`),
`FlatCoords`/`LineArray`/`Polygonal` (canonical currency + legacy Arrow),
`ConcaveHullOptions`, `DelaunayOptions`, `VoronoiOptions`,
`LineMergeOptions`, `OffsetCurveOptions`, `LargestEmptyCircleOptions`,
`ParallelOptions`, `EmptyKind`, `FromPartsOptions`, `ByteOrder`,
`PreparedPredName`, `UnpreparedPredName`, `GeosErrorDetail`,
`GeosErrorDiagnostics`, and the branded pointer handles
(`GeomPtr`, `GeosCtx`, `ShimPtr`, `PreparedPtr`, `StrTreePtr`, …).
