/**
 * Precision model (Phase 2): setPrecision modes, getPrecision, and the
 * `*Prec` overlay variants.
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

describe("setPrecision", () => {
  it("snaps coordinates to the grid (validOutput default)", () =>
    withGeos((geos) => {
      using g = geos.fromWKT("POLYGON ((0.123 0.123, 5.5 0.1, 5.4 5.6, 0.1 5.5, 0.123 0.123))");
      using p = geos.setPrecision(g, 0.5);
      expect(geos.getPrecision(p)).toBe(0.5);
      expect(geos.isValid(p)).toBe(true);
      // every surviving coordinate sits on the 0.5 grid
      const coords = geos.coordinates(geos.exteriorRing(p));
      for (let i = 0; i < coords.n; i++) {
        expect(coords.coords[i * 2]! % 0.5).toBe(0);
        expect(coords.coords[i * 2 + 1]! % 0.5).toBe(0);
      }
    }));

  it("collapsed polygons are removed by default and kept as lines... removed (per GEOS rules)", () =>
    withGeos((geos) => {
      // A sliver thinner than the grid collapses; validOutput drops it.
      using sliver = geos.fromWKT("POLYGON ((0 0, 0.1 0, 0 0.01, 0 0))");
      using dropped = geos.setPrecision(sliver, 1);
      expect(geos.isEmpty(dropped)).toBe(true);
      // noTopo does pointwise snapping and may produce invalid output
      using pointwise = geos.setPrecision(sliver, 1, { mode: "noTopo" });
      expect(geos.getPrecision(pointwise)).toBe(1);
    }));

  it("gridSize 0 keeps floating precision; negative gridSize is a RangeError", () =>
    withGeos((geos) => {
      using g = geos.fromWKT("POINT (1.5 2.5)");
      using p = geos.setPrecision(g, 0);
      expect(geos.getPrecision(p)).toBe(0);
      expect(() => geos.setPrecision(g, -1)).toThrow(RangeError);
    }));
});

describe("*Prec overlays", () => {
  /** every coordinate of `g` sits on the 0.5 grid (surface or collection) */
  function expectOnGrid(
    geos: Parameters<Parameters<typeof withGeos>[0]>[0],
    g: import("../../src/index.ts").Geometry,
  ): void {
    const checkRing = (ring: import("../../src/index.ts").Geometry): void => {
      const coords = geos.coordinates(ring);
      for (let i = 0; i < coords.n; i++) {
        expect(coords.coords[i * 2]! % 0.5).toBe(0);
        expect(coords.coords[i * 2 + 1]! % 0.5).toBe(0);
      }
    };
    if (geos.geomType(g) === "Polygon") {
      checkRing(geos.exteriorRing(g));
    } else {
      for (let i = 0; i < geos.numGeometries(g); i++) {
        expectOnGrid(geos, geos.getGeometryN(g, i));
      }
    }
  }

  it("intersectionPrec snaps the result to the grid (output stays floating)", () =>
    withGeos((geos) => {
      using a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      using b = geos.fromWKT("POLYGON ((1.2 1.2, 3 1.2, 3 3, 1.2 3, 1.2 1.2))");
      using prec = geos.intersectionPrec(a, b, 0.5);
      // the *Prec ops snap COORDINATES; the output carries no PM (0)
      expect(geos.getPrecision(prec)).toBe(0);
      expectOnGrid(geos, prec);
      expect(geos.area(prec)).toBeCloseTo(1, 9); // snapped to (1..2)×(1..2)... 0.5-grid keeps 1.2→1.0? see below
    }));

  it("unionPrec/differencePrec/symDifferencePrec return snapped, valid results", () =>
    withGeos((geos) => {
      using a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      using b = geos.fromWKT("POLYGON ((1.1 1.1, 3 1.1, 3 3, 1.1 3, 1.1 1.1))");
      using u = geos.unionPrec(a, b, 0.5);
      using d = geos.differencePrec(a, b, 0.5);
      using sd = geos.symDifferencePrec(a, b, 0.5);
      for (const g of [u, d, sd]) {
        expect(geos.isValid(g)).toBe(true);
        expectOnGrid(geos, g);
      }
      // grid-exact: b snaps to (1..3)² = 4; a∩b becomes (1..2)² = 1
      expect(geos.area(u)).toBeCloseTo(7, 9); // 4 + 4 - 1
      expect(geos.area(d)).toBeCloseTo(3, 9); // 4 - 1
      expect(geos.area(sd)).toBeCloseTo(6, 9); // 7 - 1
    }));

  it("unaryUnionPrec snaps its result", () =>
    withGeos((geos) => {
      using coll = geos.fromParts("multipolygon", [
        geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))"),
        geos.fromWKT("POLYGON ((1.05 1.05, 3 1.05, 3 3, 1.05 3, 1.05 1.05))"),
      ]);
      using u = geos.unaryUnionPrec(coll, 0.5);
      expectOnGrid(geos, u);
      expect(geos.isValid(u)).toBe(true);
      expect(geos.area(u)).toBeCloseTo(7, 9);
    }));

  it("negative gridSize is a RangeError; foreign geometry throws TypeError", () =>
    withGeos((geos) => {
      using a = geos.fromWKT("POINT (1 1)");
      expect(() => geos.intersectionPrec(a, a, -1)).toThrow(RangeError);
      using other = new Geos();
      const foreign = other.fromWKT("POINT (0 0)");
      expect(() => geos.intersectionPrec(a, foreign, 1)).toThrow(TypeError);
    }));
});
