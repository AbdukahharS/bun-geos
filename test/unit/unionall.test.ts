/**
 * unionAll strategy dispatch (Phase 2, D20): equivalence properties and the
 * auto-strategy ladder.
 */
import { describe, expect, it } from "bun:test";
import { type Geometry, type Geos, GeosError } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

/** n×n grid of unit square tiles — a textbook aligned coverage. */
function tiles(geos: Geos, n: number, origin = 0): Geometry[] {
  const out: Geometry[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = origin + i;
      const y = origin + j;
      out.push(
        geos.fromWKT(
          `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`,
        ),
      );
    }
  }
  return out;
}

function disposeAll(gs: readonly Geometry[]): void {
  for (const g of gs) g.dispose();
}

describe("unionAll", () => {
  it("unionAll([a, b]) ≡ union(a, b)", () =>
    withGeos((geos) => {
      using a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      using b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))");
      using pair = geos.unionAll([a, b]);
      using binary = geos.union(a, b);
      expect(geos.equals(pair, binary)).toBe(true);
      expect(geos.area(pair)).toBeCloseTo(7, 9);
    }));

  it("all strategies agree on overlapping (non-coverage) input", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      const b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))");
      const c = geos.fromWKT("POLYGON ((2 2, 4 2, 4 4, 2 4, 2 2))");
      try {
        using auto = geos.unionAll([a, b, c]);
        using unary = geos.unionAll([a, b, c], { strategy: "unary" });
        using disjoint = geos.unionAll([a, b, c], { strategy: "disjointSubset" });
        const area = geos.area(auto);
        expect(area).toBeCloseTo(geos.area(unary), 9);
        expect(area).toBeCloseTo(geos.area(disjoint), 9);
        expect(geos.isValid(auto)).toBe(true);
      } finally {
        disposeAll([a, b, c]);
      }
    }));

  it("auto picks CoverageUnion on an aligned coverage (fast path, exact result)", () =>
    withGeos((geos) => {
      const ts = tiles(geos, 6);
      try {
        using u = geos.unionAll(ts); // auto
        expect(geos.isValid(u)).toBe(true);
        expect(geos.geomType(u)).toBe("Polygon"); // a full grid unions to one square
        expect(geos.area(u)).toBeCloseTo(36, 9);
        using cov = geos.unionAll(ts, { strategy: "coverage" });
        expect(geos.area(cov)).toBeCloseTo(36, 9);
      } finally {
        disposeAll(ts);
      }
    }));

  it("strategy 'coverage' rejects a non-coverage; raw coverageUnion is caller-asserts", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      const b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))"); // overlaps a
      try {
        expect(() => geos.unionAll([a, b], { strategy: "coverage" })).toThrow(GeosError);
        // raw path: documented garbage-in-garbage-out; must not throw
        using raw = geos.coverageUnion([a, b]);
        expect(raw.disposed).toBe(false);
      } finally {
        disposeAll([a, b]);
      }
    }));

  it("line input unions fine via auto (falls back off the coverage path)", () =>
    withGeos((geos) => {
      const lines = [
        geos.fromWKT("LINESTRING (0 0, 1 1)"),
        geos.fromWKT("LINESTRING (1 1, 2 2)"),
        geos.fromWKT("LINESTRING (5 5, 6 6)"),
      ];
      try {
        using u = geos.unionAll(lines);
        const t = geos.geomType(u);
        expect(t === "MultiLineString" || t === "LineString").toBe(true);
        // lengths are conserved by any correct union strategy
        const total =
          t === "MultiLineString"
            ? Array.from({ length: geos.numGeometries(u) }, (_, i) =>
                geos.length(geos.getGeometryN(u, i)),
              ).reduce((s, x) => s + x, 0)
            : geos.length(u);
        expect(total).toBeCloseTo(3 * Math.SQRT2, 9);
      } finally {
        disposeAll(lines);
      }
    }));

  it("single input is the identity; empty input is a RangeError", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
      try {
        using one = geos.unionAll([a]);
        expect(geos.equals(one, a)).toBe(true);
        expect(() => geos.unionAll([])).toThrow(RangeError);
      } finally {
        a.dispose();
      }
    }));

  it("arena option registers the result with the given arena", () =>
    withGeos((geos) => {
      const ts = tiles(geos, 2);
      try {
        {
          using arena = geos.arena();
          using _u = geos.unionAll(ts, { arena });
          expect(arena.size).toBe(1);
        } // arena exit frees the union result
        expect(geos.stats.liveGeoms).toBe(ts.length);
      } finally {
        disposeAll(ts);
      }
    }));

  it("does not consume inputs (inputs stay usable afterwards)", () =>
    withGeos((geos) => {
      const ts = tiles(geos, 2);
      try {
        using u = geos.unionAll(ts);
        expect(geos.area(u)).toBe(4);
        for (const t of ts) expect(geos.area(t)).toBe(1);
      } finally {
        disposeAll(ts);
      }
    }));
});
