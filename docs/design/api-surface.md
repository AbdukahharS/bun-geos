# Design: target API surface

> Status: **design target, not a contract** (post-spike). The surface is fixed at the
> GEOS 3.14 C API (D5) — no capability flags exist anywhere in this document. Method
> names are provisional; grouping and semantics are the stable part.
>
> **Phase 2 status (Oct 2026):** Prepared §, Spatial index §, Overlays (unionAll/
> `*Prec`) §, repair suite §, and interrupt are IMPLEMENTED. Documented deviations
> from the sketches below: `isValidDetail`/`isSimpleDetail` (GEOS's names; singular
> reason + owned location) instead of `isValidReasons`; `coverageIsValid` returns
> `{ valid, errorEdges?: Geometry[] }` (per-input error-edge geoms) instead of index
> pairs; `coverageClean` uses GEOS's `gapMaximumWidth`/`snappingDistance`/
> `overlapStrategy` param names (the sketch's `gapWidth` is the *coverageIsValid*
> option, which is implemented as `gapWidth`); diagnostics on `GeosError` are
> STRINGS (`GeosErrorDiagnostics`, reserved — no throw site populates it yet), never
> geometries; the tree/`Prepared`/ops modules live in `src/spatial/` +
> `src/ops/` (not `src/index/` — avoids the index.ts import ambiguity);
> `orientPolygons` and the interrupt plumbing shipped alongside (io.md §3 /
> D19). Batch input forms take `Geometry[]` in Phase 2; ArrowArray normalization
> lands with the Phase 3 batch layer.

## Conventions

- All plural/batch forms accept `Geometry[]` **or** GeoArrow-style typed arrays and
  return typed arrays — never a JS loop over the singular form.
- Coordinates in/out are flat `Float64Array` + offsets ([io](io.md)).
- Every operation accepts an optional trailing `options` object; all ops accept
  `{ signal?: AbortSignal }` ([concurrency](concurrency.md)).
- Disposables (`Geos`, `Geometry`, `Prepared`, `STRtree`, arenas) implement
  `[Symbol.dispose]()` ([memory](memory.md)).

```ts
class Geos implements Disposable {
  constructor(opts?: { threads?: never /* contexts are per-thread by construction */ });
  get [Symbol.dispose](): () => void;
  arena(): Arena;                       // using arena = geos.arena()
  get stats(): { liveGeoms: number; heapBytesApprox: number; /* … */ };
}
```

## Construction & I/O

```ts
geos.fromWKT(wkt: string): Geometry;
geos.fromWKB(wkb: Uint8Array): Geometry;
geos.fromWKBMany(buf: Uint8Array, offsets: Uint32Array): Geometry[];
geos.fromGeoJSON(geo: GeoJSONGeometry | GeoJSONFeature): Geometry;
geos.fromArrow(arr: ArrowGeometryArray): Geometry;
geos.fromCoords(flat: FlatCoords | Polygonal): Geometry;   // builders via shim
geos.point(x: number, y: number): Geometry;                // convenience

geom.toWKT(opts?): string;
geom.toWKB(opts?: { byteOrder?: "little" | "big"; outputDimension?: 2 | 3 | 4 }): Uint8Array;
geom.toGeoJSON(opts?): GeoJSONGeometry;
geom.toArrow(): ArrowGeometryArray;
geom.envelope(): Geometry;  geom.isEmpty(): boolean;  geom.type: string;
geom.hasZ: boolean;  geom.hasM: boolean;  geom.srid: number | null;   // side-channel
```

## Predicates

```ts
geos.intersects(a, b): boolean;         // + equals, disjoint, touches, crosses,
geos.contains(a, b): boolean;           //   within, overlaps, covers, coveredBy
geos.relates(a, b, pattern: string): boolean;      // DE-9IM
geos.relateMatrix(a, b): string;
geos.equalsIdentical(a, b): boolean;    // exact (3.12)
```

## Prepared (RelateNG, 3.13+)

```ts
using prep = a.prepare();
prep.intersects(b): boolean;
prep.intersectsAll(others: Geometry[] | ArrowGeometryArray): Uint8Array;   // 0/1 mask
prep.containsProperlyAll(others): Uint8Array;
prep.relate(b): string;                 // full DE-9IM, prepared
prep.relatePattern(b, pattern): boolean;
```

## Overlays & boolean ops

```ts
geos.intersection(a, b): Geometry;      // OverlayNGRobust under the hood (3.10+)
geos.union(a, b): Geometry;
geos.difference(a, b): Geometry;
geos.symDifference(a, b): Geometry;
geos.unaryUnion(g): Geometry;

// Fixed-precision variants (precision model):
geos.intersectionPrec(a, b, gridSize): Geometry;   // + unionPrec, differencePrec, symDifferencePrec
geos.setPrecision(g, gridSize, mode?): Geometry;

// Batch strategies (Phase 2) — dispatch is automatic, override is explicit:
geos.unionAll(gs, opts?: { strategy?: "auto" | "coverage" | "disjointSubset" | "unary" }): Geometry;
//   auto: CoverageUnion when input validates as a coverage;
//         DisjointSubsetUnion when spatially partitioned; else UnaryUnion.
```

## Topology repair (the "repair suite", Phase 2)

```ts
geos.isValid(g): boolean;
geos.isValidReasons(g): { valid: boolean; reasons: string[] };        // diagnostics
geos.makeValid(g, opts?: { method?: "linework" | "structure"; keepCollapsed?: boolean }): Geometry;
geos.coverageIsValid(gs): { valid: boolean; errorLayers?: [number, number][] };
geos.coverageClean(gs, opts?: { gapWidth?: number;
                               overlapStrategy?: "longestBorder" | "maxArea" | "minArea" }): Geometry[];
geos.coverageUnion(gs): Geometry;              // aligned coverages; very fast
geos.coverageSimplifyVW(gs, tolerance, opts?): Geometry[];
geos.node(g): Geometry;  geos.buildArea(g): Geometry;  geos.polygonize(g): Geometry;
geos.isSimpleDetail(g): { simple: boolean; locations?: Geometry[] };  // 3.14 diagnostics
```

## Measures & construction ops

```ts
geos.area(g): number;  geos.length(g): number;  geos.distance(a, b): number;
geos.hausdorff(a, b): number;  geos.frechet(a, b): number;
geos.nearestPoints(a, b): [Geometry, Geometry];
geos.buffer(g, dist, opts?: { quadSegs?: number; join?: "round" | "mitre" | "bevel";
                              mitreLimit?: number; singleSided?: boolean }): Geometry;
geos.offsetCurve(g, dist, opts?): Geometry;
geos.simplify(g, tol): Geometry;  geos.topologyPreserveSimplify(g, tol): Geometry;
geos.clipByRect(g, xmin, ymin, xmax, ymax): Geometry;   // fast rectangular clip
geos.convexHull(g): Geometry;  geos.concaveHull(g, ratio, opts?): Geometry;
geos.voronoi(g, opts?): Geometry;  geos.delaunay(g, opts?): Geometry;
geos.lineMerge(g, opts?): Geometry;  geos.lineSubstring(g, start, end): Geometry;
geos.sharedPaths(a, b): Geometry;  geos.snap(a, b, tol): Geometry;
geos.maximumInscribedCircle(g): Geometry;  geos.largestEmptyCircle(g, obs?): Geometry;
geos.constrainedDelaunay(g): Geometry;
geos.clusterDBSCAN(gs, eps, minPoints): Int32Array;     // 3.14, cluster ids per input
geos.gridIntersectionFractions(grid, polygon): Float64Array;  // 3.14
```

## Spatial index

```ts
const tree = geos.strtree(geoms, nodeCapacity = 10);    // ids = input indices
tree.query(env: Geometry): Int32Array;                  // candidate ids, one shim call
tree.nearest(g): number;                                // id of nearest item
tree.build(): void;                                     // force build (3.12)
tree implements Disposable;
// Exact filtering is caller's choice — commonly prepared predicates on candidates:
const hits = ids.filter(i => prep.intersects(geoms[i]));   // or the fused Phase-3 helper
```

## Parallel & utility

```ts
geos.parallel.unionAll(gs, opts?: { signal?: AbortSignal }): Promise<Geometry>;  // Phase 3
geos.parallel.intersectsAll(a, bs, opts?): Promise<Uint8Array>;
geos.orientPolygons(g, dir?: "ccw" | "cw"): Geometry;   // explicit, never silent
geos.version(): "3.14.x-CAPI-x";                        // informational only (D5)
```

## Errors

```ts
class GeosError extends Error {
  op: string;                    // "GEOSIntersection_r"
  geosMessage?: string;          // captured via shim thread-local buffer
  detail?: { ring?: number; vertex?: number; byteOffset?: number; jsonPath?: string };
  diagnostics?: { validReasons?: string[]; simpleDetail?: Geometry[] };  // repair ops
}
```

Programming errors (foreign context, use-after-dispose, invalid pattern string) are
`TypeError`/`RangeError`, per D13.

## Deliberately out of scope (initial)

- Curve types (CircularString etc., new in 3.13) — C API exists; surface after 0.1.
- Precision-model *construction* beyond `setPrecision`/`*Prec` (no PolygonalCoverage
  plumbing) — revisit on demand.
- Any browser/WASM build — permanently out of scope (D1); geos-wasm is the recommended
  browser alternative.
