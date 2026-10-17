/**
 * Phase 5 construction ops (M3): hulls, simplification, clipping,
 * triangulations, line ops, topology building, centers/clearance/clustering
 * — singular + batch agreement, error shapes, disposal hygiene.
 */
import { describe, expect, it } from "bun:test";
import { Geos, GeosError } from "../../src/index.ts";

describe("hulls & simplification", () => {
  it("convexHull of a point cloud is the hull polygon", () => {
    using geos = new Geos();
    const pts = [
      geos.point(0, 0),
      geos.point(10, 0),
      geos.point(10, 10),
      geos.point(0, 10),
      geos.point(5, 5), // interior — dropped by the hull
      geos.point(5, -1), // hull vertex
    ];
    using hull = geos.convexHull(geos.fromParts("multipoint", pts, { transfer: true }));
    expect(geos.geomType(hull)).toBe("Polygon");
    // pentagon (0,0)(5,-1)(10,0)(10,10)(0,10) — shoelace = 105
    expect(geos.area(hull)).toBeCloseTo(105, 6);
  });

  it("concaveHull tightens with smaller ratio; ratio validation is a RangeError", () => {
    using geos = new Geos();
    using mp = geos.fromParts(
      "multipoint",
      [
        geos.point(0, 0),
        geos.point(10, 0),
        geos.point(10, 10),
        geos.point(0, 10),
        geos.point(9, 9),
        geos.point(1, 9),
        geos.point(1, 1),
        geos.point(9, 1),
      ],
      { transfer: true },
    );
    using convex = geos.concaveHull(mp, 1);
    using tight = geos.concaveHull(mp, 0.1);
    expect(geos.area(tight) <= geos.area(convex) + 1e-9).toBe(true);
    expect(() => geos.concaveHull(mp, 1.5)).toThrow(RangeError);
    expect(() => geos.concaveHull(mp, -0.1)).toThrow(RangeError);
  });

  it("simplify collapses at large tolerance; topologyPreserveSimplify stays valid", () => {
    using geos = new Geos();
    using wobble = geos.fromWKT("LINESTRING (0 0, 1 0.4, 2 0, 3 0.4, 4 0, 5 0.4, 6 0, 7 0.4, 8 0)");
    using simple = geos.simplify(wobble, 1);
    expect(geos.numPoints(simple)).toBeLessThan(geos.numPoints(wobble));
    using poly = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 5 4.9, 0 10, 0 0))");
    using tp = geos.topologyPreserveSimplify(poly, 2);
    expect(geos.isValid(tp)).toBe(true);
  });

  it("clipByRect intersects with the rectangle; bad rect is a RangeError", () => {
    using geos = new Geos();
    using g = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    using clipped = geos.clipByRect(g, 2, 2, 6, 6);
    expect(geos.area(clipped)).toBeCloseTo(16, 10);
    expect(() => geos.clipByRect(g, 5, 0, 5, 10)).toThrow(RangeError);
  });
});

describe("triangulations", () => {
  it("delaunay triangles cover the square; onlyEdges gives linework", () => {
    using geos = new Geos();
    using mp = geos.fromParts(
      "multipoint",
      [geos.point(0, 0), geos.point(10, 0), geos.point(10, 10), geos.point(0, 10)],
      { transfer: true },
    );
    using tris = geos.delaunay(mp);
    // square split by a diagonal: total triangle area is 100 (± tolerance)
    let total = 0;
    for (let i = 0; i < geos.numGeometries(tris); i++) {
      using t = geos.getGeometryN(tris, i);
      total += geos.area(t);
    }
    expect(total).toBeCloseTo(100, 6);
    using edges = geos.delaunay(mp, { onlyEdges: true });
    expect(geos.geomType(edges)).toBe("MultiLineString");
  });

  it("constrainedDelaunay triangulates a polygon exactly", () => {
    using geos = new Geos();
    using poly = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    using tris = geos.constrainedDelaunay(poly);
    let total = 0;
    for (let i = 0; i < geos.numGeometries(tris); i++) {
      using t = geos.getGeometryN(tris, i);
      total += geos.area(t);
    }
    expect(total).toBeCloseTo(100, 6);
  });

  it("voronoi cells around a ring of points; options validated", () => {
    using geos = new Geos();
    using mp = geos.fromParts(
      "multipoint",
      [geos.point(0, 0), geos.point(10, 0), geos.point(10, 10), geos.point(0, 10)],
      { transfer: true },
    );
    using env = geos.envelope(mp);
    using cells = geos.voronoi(mp, { envelope: env, ordered: true });
    expect(geos.numGeometries(cells)).toBe(4);
    using edges = geos.voronoi(mp, { onlyEdges: true });
    expect(geos.geomType(edges)).toBe("MultiLineString");
    expect(() => geos.voronoi(mp, { tolerance: -1 })).toThrow(RangeError);
  });
});

describe("line ops", () => {
  it("lineMerge joins contiguous segments; directed keeps orientation", () => {
    using geos = new Geos();
    using ml = geos.fromWKT("MULTILINESTRING ((0 0, 1 0, 2 0), (2 0, 3 0), (5 0, 6 0))");
    using merged = geos.lineMerge(ml);
    expect(geos.numGeometries(merged)).toBe(2); // (0..3) + (5..6)
    using first = geos.getGeometryN(merged, 0);
    expect(geos.numPoints(first)).toBe(4); // 0 0, 1 0, 2 0, 3 0
  });

  it("lineSubstring extracts fractional ranges; rejects bad fractions", () => {
    using geos = new Geos();
    using line = geos.fromWKT("LINESTRING (0 0, 10 0)");
    using half = geos.lineSubstring(line, 0.25, 0.75);
    expect(geos.length(half)).toBeCloseTo(5, 10);
    expect(() => geos.lineSubstring(line, 0.8, 0.2)).toThrow(RangeError);
    expect(() => geos.lineSubstring(line, -0.1, 0.5)).toThrow(RangeError);
  });

  it("offsetCurve offsets left positive, right negative", () => {
    using geos = new Geos();
    using line = geos.fromWKT("LINESTRING (0 0, 10 0)");
    using left = geos.offsetCurve(line, 2);
    const lcoords = geos.coordinates(left);
    expect(lcoords.coords[1]).toBeCloseTo(2, 8); // (0, 2)
    using right = geos.offsetCurve(line, -2);
    const rcoords = geos.coordinates(right);
    expect(rcoords.coords[1]).toBeCloseTo(-2, 8);
  });

  it("snap moves vertices within tolerance", () => {
    using geos = new Geos();
    using exact = geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))");
    using wobbly = geos.fromWKT("POLYGON ((0.1 0.1, 4 0, 4 4, 0 4, 0.1 0.1))");
    using snapped = geos.snap(exact, wobbly, 0.5);
    expect(geos.area(snapped)).toBeCloseTo(15.6, 8);
  });

  it("sharedPaths finds shared linework (lineal inputs only)", () => {
    using geos = new Geos();
    using a = geos.fromWKT("LINESTRING (0 0, 4 0)");
    using b = geos.fromWKT("LINESTRING (2 0, 6 0)");
    using shared = geos.sharedPaths(a, b);
    expect(geos.length(shared)).toBeCloseTo(2, 8);
    using poly = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    expect(() => geos.sharedPaths(a, poly)).toThrow(GeosError);
  });
});

describe("topology building", () => {
  it("node splits crossings", () => {
    using geos = new Geos();
    using x = geos.fromWKT("MULTILINESTRING ((0 0, 4 4), (0 4, 4 0))");
    using noded = geos.node(x);
    // crossing at (2,2): 4 segments after noding
    let parts = 0;
    for (let i = 0; i < geos.numGeometries(noded); i++) {
      using g = geos.getGeometryN(noded, i);
      parts += geos.numGeometries(g);
    }
    expect(parts).toBe(4);
  });

  it("buildArea polygonizes enclosed linework; polygonize collects rings", () => {
    using geos = new Geos();
    using box = geos.fromWKT("MULTILINESTRING ((0 0, 4 0, 4 4, 0 4, 0 0))");
    using area = geos.buildArea(box);
    expect(geos.area(area)).toBeCloseTo(16, 8);
    using lines = geos.fromWKT(
      "MULTILINESTRING ((0 0, 4 0, 4 4, 0 4, 0 0), (5 0, 8 0, 8 3, 5 3, 5 0))",
    );
    using polys = geos.polygonize(lines);
    expect(geos.numGeometries(polys)).toBe(2);
    let total = 0;
    for (let i = 0; i < geos.numGeometries(polys); i++) {
      using p = geos.getGeometryN(polys, i);
      total += geos.area(p);
    }
    expect(total).toBeCloseTo(16 + 9, 8);
    expect(() => geos.polygonize([])).toThrow(RangeError);
  });
});

describe("centers, clearance, clustering, grids", () => {
  it("centroid / interiorPoint / boundary", () => {
    using geos = new Geos();
    using poly = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    using c = geos.centroid(poly);
    const cc = geos.coordinates(c);
    expect(cc.coords[0]).toBeCloseTo(5, 10);
    using ip = geos.interiorPoint(poly);
    expect(geos.intersects(poly, ip)).toBe(true);
    using b = geos.boundary(poly);
    // GEOS returns a closed LINESTRING (JTS's LinearRing analog)
    expect(geos.geomType(b)).toBe("LineString");
    expect(geos.length(b)).toBeCloseTo(40, 8);
  });

  it("nearestPoints returns one point on each input", () => {
    using geos = new Geos();
    using a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    using b = geos.fromWKT("POLYGON ((5 0, 8 0, 8 3, 5 3, 5 0))");
    const [pa, pb] = geos.nearestPoints(a, b);
    expect(geos.distance(pa, pb)).toBeCloseTo(3, 8);
    expect(geos.intersects(a, pa)).toBe(true);
    expect(geos.intersects(b, pb)).toBe(true);
    pa.dispose();
    pb.dispose();
  });

  it("minimumClearance + line", () => {
    using geos = new Geos();
    using narrow = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 5 5.1, 0 10, 0 0))");
    const mc = geos.minimumClearance(narrow);
    expect(mc).toBeGreaterThan(0);
    using line = geos.minimumClearanceLine(narrow);
    expect(geos.geomType(line)).toBe("LineString");
    expect(geos.length(line)).toBeCloseTo(mc, 6);
  });

  it("inscribed / empty circles are center→boundary lines", () => {
    using geos = new Geos();
    using square = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    using mic = geos.maximumInscribedCircle(square, 0.001);
    const ccoords = geos.coordinates(mic); // two-point line: center → boundary
    expect(ccoords.coords[0]).toBeCloseTo(5, 1);
    expect(ccoords.coords[1]).toBeCloseTo(5, 1);
    using lec = geos.largestEmptyCircle(square, 0.001);
    expect(geos.geomType(lec)).toBe("LineString");
    using ring = geos.fromWKT("POLYGON ((-5 -5, 15 -5, 15 15, -5 15, -5 -5))");
    using constrained = geos.largestEmptyCircle(square, 0.001, { boundary: ring });
    expect(geos.geomType(constrained)).toBe("LineString");
    expect(() => geos.maximumInscribedCircle(square, 0)).toThrow(RangeError);
  });

  it("clusterDBSCAN assigns ids per input, -1 for noise", () => {
    using geos = new Geos();
    // two tight pairs + one far singleton
    const pts = [
      geos.point(0, 0),
      geos.point(0.1, 0),
      geos.point(10, 10),
      geos.point(10.1, 10),
      geos.point(50, 50),
    ];
    const ids = geos.clusterDBSCAN(pts, 0.5, 2);
    expect(ids.length).toBe(5);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
    expect(ids[4]).toBe(-1); // noise
    for (const p of pts) p.dispose();
    // single collection input works too
    using col = geos.fromParts("multipoint", [geos.point(0, 0), geos.point(0.1, 0)], {
      transfer: true,
    });
    const ids2 = geos.clusterDBSCAN(col, 0.5, 2);
    expect(ids2.length).toBe(2);
    expect(ids2[0]).toBe(ids2[1]);
  });

  it("gridIntersectionFractions fills nx×ny coverage fractions", () => {
    using geos = new Geos();
    using poly = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    const frac = geos.gridIntersectionFractions(poly, {
      xmin: -5,
      ymin: -5,
      xmax: 15,
      ymax: 15,
      nx: 4,
      ny: 4,
    });
    expect(frac.length).toBe(16);
    // cell covering the polygon center is fully covered
    const mid = frac[1 * 4 + 1]!;
    expect(mid).toBeCloseTo(1, 5);
    let sum = 0;
    for (const v of frac) sum += v;
    expect(sum).toBeCloseTo(100 / 25, 3); // 100 units² over 25-unit cells
    expect(() =>
      geos.gridIntersectionFractions(poly, { xmin: 5, ymin: 0, xmax: 5, ymax: 5, nx: 2, ny: 2 }),
    ).toThrow(RangeError);
  });
});

describe("construction batches (D27)", () => {
  it("unary *All forms match the singulars element-wise", () => {
    using geos = new Geos();
    const gs = [
      geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))"),
      geos.fromWKT("POLYGON ((1 1, 6 1, 6 6, 1 6, 1 1))"),
    ];
    const hulls = geos.convexHullAll(gs);
    const centroids = geos.centroidAll(gs);
    const boundaries = geos.boundaryAll(gs);
    const interiors = geos.interiorPointAll(gs);
    const simplified = geos.simplifyAll(gs, 0.01);
    const tps = geos.topologyPreserveSimplifyAll(gs, 0.01);
    const clipped = geos.clipByRectAll(gs, 2, 2, 5, 5);
    const nodes = geos.nodeAll(gs);
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      using h = geos.convexHull(g);
      expect(geos.area(hulls[i]!)).toBeCloseTo(geos.area(h), 10);
      using c = geos.centroid(g);
      expect(geos.equalsIdentical(centroids[i]!, c)).toBe(true);
      using b = geos.boundary(g);
      expect(geos.equalsIdentical(boundaries[i]!, b)).toBe(true);
      using ip = geos.interiorPoint(g);
      expect(geos.equalsIdentical(interiors[i]!, ip)).toBe(true);
      using s = geos.simplify(g, 0.01);
      expect(geos.equalsIdentical(simplified[i]!, s)).toBe(true);
      using tp = geos.topologyPreserveSimplify(g, 0.01);
      expect(geos.equalsIdentical(tps[i]!, tp)).toBe(true);
      using cl = geos.clipByRect(g, 2, 2, 5, 5);
      expect(geos.area(clipped[i]!)).toBeCloseTo(geos.area(cl), 10);
      using n = geos.node(g);
      expect(geos.equalsIdentical(nodes[i]!, n)).toBe(true);
    }
    const merged = geos.lineMergeAll(gs);
    using lm = geos.lineMerge(gs[1]!);
    expect(geos.equalsIdentical(merged[1]!, lm)).toBe(true);
    for (const arr of [
      hulls,
      centroids,
      boundaries,
      interiors,
      simplified,
      tps,
      clipped,
      nodes,
      merged,
    ]) {
      for (const g of arr) g.dispose();
    }
    for (const g of gs) g.dispose();
  });

  it("binary *All forms broadcast `a`", () => {
    using geos = new Geos();
    using a = geos.fromWKT("LINESTRING (0 0, 4 0)"); // sharedPaths is LINEAL-only
    const bs = [geos.fromWKT("LINESTRING (2 0, 6 0)"), geos.fromWKT("LINESTRING (0 2, 0 6)")];
    // snap: broadcast `a` (line) against the same line shifted
    const targets = [
      geos.fromWKT("LINESTRING (0 0.2, 4 0.2)"),
      geos.fromWKT("LINESTRING (0 0.4, 4 0.4)"),
    ];
    const snapped = geos.snapAll(targets[0]!, bs, 0.5);
    using s0 = geos.snap(targets[0]!, bs[0]!, 0.5);
    expect(geos.length(snapped[0]!)).toBeCloseTo(geos.length(s0), 10);
    const shared = geos.sharedPathsAll(a, bs);
    expect(geos.length(shared[0]!)).toBeCloseTo(2, 8);
    expect(geos.length(shared[1]!)).toBeCloseTo(0, 8);
    for (const g of snapped) g.dispose();
    for (const g of shared) g.dispose();
    for (const g of targets) g.dispose();
    for (const g of bs) g.dispose();
    for (const g of [a]) g.dispose();
  });

  it("Arrow batch input normalizes through the bulk builders", () => {
    using geos = new Geos();
    // rows: triangle, 2-point line, square — hulls follow the input shape
    const coords = new Float64Array([
      0,
      0,
      4,
      0,
      2,
      3, // triangle
      0,
      0,
      1,
      0, // line
      0,
      0,
      4,
      0,
      4,
      4,
      0,
      4, // square
    ]);
    const lineOffsets = Int32Array.of(3, 5, 9);
    const hulls = geos.convexHullAll({ coords, lineOffsets, hasZ: false, hasM: false });
    expect(hulls.length).toBe(3);
    expect(geos.geomType(hulls[0]!)).toBe("Polygon");
    expect(geos.geomType(hulls[1]!)).toBe("LineString"); // degenerate 2-point hull
    expect(geos.geomType(hulls[2]!)).toBe("Polygon");
    const centroids = geos.centroidAll({ coords, lineOffsets, hasZ: false, hasM: false });
    expect(centroids.length).toBe(3);
    for (const c of centroids) {
      expect(geos.geomType(c)).toBe("Point");
      c.dispose();
    }
    for (const h of hulls) h.dispose();
  });
});
