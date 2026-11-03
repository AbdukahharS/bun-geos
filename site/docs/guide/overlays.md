---
description: The single-geometry vocabulary — boolean overlays, buffers, validity repair, measures, hulls, triangulation, and accessors, every signature on this page real.
---

# Overlays & operations

The operations tour. Every signature here is real — this page mirrors the public
surface one-to-one, grouped by what you're trying to do. Batch (`*All`) forms and the
parallel mirrors live in [Predicates & indexing](/guide/predicates) and
[Workers & parallelism](/guide/workers); this page is the single-geometry vocabulary.

All methods live on `Geos`. Geometries in, geometries out, one FFI crossing each.

## Boolean overlays

```ts
using i = geos.intersection(a, b);
using u = geos.union(a, b);
using d = geos.difference(a, b);
using sd = geos.symDifference(a, b);
```

- Overlays run through **OverlayNGRobust** — the precision-hardened pipeline, not the
  classic snapping heuristic. You get the PostGIS-grade answer for the classic
  robustness nightmares (nearly-touching edges, infinitesimal slivers).
- `unaryUnion(g)` unions the parts of a single geometry (a MULTI*'s members, a
  collection's children).

### N-ary union: `unionAll`

```ts
using merged = geos.unionAll(parcels); // the fastest correct union of many
```

Strategy, in one table:

| `strategy` | Behavior |
|------------|----------|
| `"auto"` (default) | valid aligned coverage → CoverageUnion; otherwise DisjointSubsetUnion (correct for any input) |
| `"coverage"` | force CoverageUnion — fastest, requires a valid aligned coverage |
| `"disjointSubset"` | DisjointSubsetUnion — correct for any input, wins on spatially partitioned data |
| `"unary"` | classic unary union — the portable baseline |

If you know your input is a clean coverage, `"coverage"` unions it the fast way — but
it **still validates first** and hard-fails on non-coverage input rather than
producing a wrong answer. Only raw `coverageUnion(gs)` skips the check, for callers
who guarantee coverage validity themselves. If you don't know your input, `"auto"`
knows for you.

For coverages specifically there are also `coverageUnion(gs)`,
`coverageIsValid(gs)`, `coverageClean(gs)` (repairs gaps/overlaps), and
`coverageSimplifyVW(gs, tolerance)` — coverage-safe simplification.

### Fixed-precision overlays

The `*Prec` variants (`intersectionPrec`, `unionPrec`, `differencePrec`,
`symDifferencePrec`, `unaryUnionPrec`) overlay in a fixed precision model and snap
their **result** to a grid of `gridSize` — the same speed/robustness dial PostGIS
exposes through its precision model. Options: `PrecisionMode` — `validOutput`
(default), `noTopo`, `keepCollapsed`. `setPrecision(g, gridSize)` / `getPrecision(g)`
manage the geometry's persistent precision model.

## Buffers

```ts
using ring = geos.buffer(geom, 100);      // positive out, negative in
using left = geos.buffer(road, 5, { singleSided: true }); // positive = left side
```

| `BufferOptions` | Default | Meaning |
|--------|---------|---------|
| `quadSegs` | `8` | quadrant segments per quarter circle (round joins) |
| `join` | `"round"` | `"round"`, `"mitre"`, `"bevel"` |
| `mitreLimit` | `5.0` | mitre ratio limit |
| `singleSided` | `false` | one-sided buffer |

And `offsetCurve(g, distance, opts?)` — the line-parallel cousin of the buffer.

## Validity & repair

Real data is invalid. The repair toolkit:

```ts
if (!geos.isValid(g)) {
  const detail = geos.isValidDetail(g); // { reason, location } — location is an owned Geometry
  using fixed = geos.makeValid(g);      // GEOSMakeValidWithParams
}
```

- `makeValid(g, { method, keepCollapsed })` — `"linework"` (default) or `"structure"`;
  `keepCollapsed` keeps collapsed linear elements under the structure method.
- `isValidDetail(g)` → invalidity **reason** + **location geometry** (not prose).
- `isSimpleDetail(g, { findAll })` → the same idea for simplicity violations.
- `orientPolygons(g, "ccw" | "cw")` — normalize ring orientation.

> [!WARNING]
> `makeValid` changes shape by definition — an invalid geometry has no single valid
> answer. Check the area of the output before you ship it to a database.

## Measures

```ts
geos.area(g);              geos.length(g);
geos.distance(a, b);       geos.hausdorff(a, b);      geos.frechet(a, b);
```

## Hulls & simplification

```ts
using hull = geos.convexHull(g);
using soft = geos.concaveHull(g, 0.3);       // ratio: 1 → convex
using s1 = geos.simplify(g, 0.01);           // Douglas-Peucker — fast, can break topology
using s2 = geos.topologyPreserveSimplify(g, 0.01); // slower, valid output guaranteed
using clip = geos.clipByRect(g, 0, 0, 10, 10);     // rectangle clip
```

## Triangulation

```ts
using d  = geos.delaunay(geom, opts?);          // Delaunay triangulation
using cd = geos.constrainedDelaunay(geom);      // edges of the input are constraints
using v  = geos.voronoi(geom, opts?);           // Voronoi diagram of the nodes
```

## Lines

```ts
using merged = geos.lineMerge(nodedLines);       // MergeLinearEdges
using seg = geos.lineSubstring(line, 0.25, 0.5); // fractional substring
using off = geos.offsetCurve(line, 2);
using sp  = geos.sharedPaths(a, b);
```

## Building from linework

```ts
using noded = geos.node(lines);            // node a set of lineworks
using poly  = geos.buildArea(noded);       // polygonize a single noded arrangement
using polys = geos.polygonize(lines);      // polygonize all fully-noded rings
using snapped = geos.snap(a, b, tolerance); // snap a to b
```

## Points of interest

```ts
using c  = geos.centroid(g);               // centroid point
using ip = geos.interiorPoint(g);          // a point guaranteed inside
const [p1, p2] = geos.nearestPoints(a, b); // owned pair
geos.minimumClearance(g);                  // the largest "safe" buffer distance
using line = geos.minimumClearanceLine(g);
using mic = geos.maximumInscribedCircle(g, tolerance); // largest inner circle center
using lec = geos.largestEmptyCircle(obstacles, tolerance, opts?);
const ids = geos.clusterDBSCAN(geoms, eps, minPoints); // Int32Array: cluster id or -1 = noise
const frac = geos.gridIntersectionFractions(g, { xmin: 0, ymin: 0, xmax: 10, ymax: 10, nx: 100, ny: 100 });
```

`gridIntersectionFractions` reports the fraction of each grid cell covered by the
geometry — rasterization-by-numbers, a `Float32Array` of `nx × ny` cells.

## Accessors

```ts
geos.geomType(g);          // "Polygon" | "Point" | …
geos.typeId(g);            // numeric GeoType id (stable, ABI-pinned)
geos.isEmpty(g);           geos.isValid(g);
using env = geos.envelope(g);
using bnd = geos.boundary(g);
geos.numGeometries(g);     geos.getGeometryN(g, 2);
geos.numInteriorRings(poly);  using er = geos.exteriorRing(poly);
geos.numPoints(g);
const flat = geos.coordinates(g); // { coords: Float64Array, n, hasZ, hasM }
```

## Where to next

- [Predicates & indexing](/guide/predicates) — asking questions about these geometries, fast
- [Memory & disposal](/guide/memory) — you now own a lot of geometries; here's how to not leak
- [API reference](/reference) — every signature on one page
