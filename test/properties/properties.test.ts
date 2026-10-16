/**
 * Property-based invariants (testing.md §2) — seeded, always reproducible.
 * Exit criterion #3 of Phase 1.
 */
import { describe, expect, it } from "bun:test";
import { type Geometry, Geos } from "../../src/index.ts";
import { mulberry32, randomTriangle, toHex, triangleGeom } from "../helpers.ts";

const SEED = 0x5eed;

describe("roundtrip identity", () => {
  it("WKB → geom → WKB is byte-identical for 500 random triangles", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED);
    for (const byteOrder of ["little", "big"] as const) {
      for (let i = 0; i < 500; i++) {
        const g = triangleGeom(geos, randomTriangle(rnd));
        const wkb = geos.toWKB(g, { byteOrder });
        const back = geos.fromWKB(wkb);
        expect(toHex(geos.toWKB(back, { byteOrder })), `triangle ${i} ${byteOrder}`).toBe(
          toHex(wkb),
        );
        back.dispose();
      }
    }
  });

  it("WKT roundtrip is stable for random triangles", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 1);
    for (let i = 0; i < 200; i++) {
      const g = triangleGeom(geos, randomTriangle(rnd));
      const wkt = geos.toWKT(g);
      expect(geos.toWKT(geos.fromWKT(wkt))).toBe(wkt);
    }
  });

  it("GeoJSON roundtrip is identity for random triangles", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 2);
    for (let i = 0; i < 200; i++) {
      const g = triangleGeom(geos, randomTriangle(rnd));
      const gj = geos.toGeoJSON(g);
      const back = geos.fromGeoJSON(gj);
      expect(geos.equalsIdentical(g, back), `triangle ${i}`).toBe(true);
    }
  });

  it("Arrow roundtrip is identity for random triangles", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 3);
    for (let i = 0; i < 200; i++) {
      const g = triangleGeom(geos, randomTriangle(rnd));
      const back = geos.fromArrow(geos.toArrow(g));
      expect(geos.equalsIdentical(g, back), `triangle ${i}`).toBe(true);
    }
  });
});

describe("robustness contracts", () => {
  it("overlay outputs are valid on valid inputs", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 4);
    for (let i = 0; i < 200; i++) {
      const a = triangleGeom(geos, randomTriangle(rnd));
      const b = triangleGeom(geos, randomTriangle(rnd));
      using out = geos.intersection(a, b);
      expect(geos.isValid(out), `pair ${i}`).toBe(true);
      a.dispose();
      b.dispose();
    }
  });

  it("area additivity on disjoint unions", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 5);
    for (let i = 0; i < 100; i++) {
      // Two triangles in x<0 and x>100 — always disjoint.
      const left = geos.fromGeoJSON({
        type: "Polygon",
        coordinates: [
          [
            [-10 - rnd() * 50, 0],
            [-10 - rnd() * 50, 10],
            [-10 - rnd() * 50, 5],
            [-10 - rnd() * 50, 0],
          ],
        ],
      });
      const right = triangleGeom(
        geos,
        randomTriangle(rnd).map(([x, y]) => [x! + 200, y!]),
      );
      const u = geos.union(left, right);
      expect(geos.area(u)).toBeCloseTo(geos.area(left) + geos.area(right), 6);
      left.dispose();
      right.dispose();
      u.dispose();
    }
  });

  it("covers(a,b) ⇒ area(intersection) = area(b)", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 6);
    for (let i = 0; i < 100; i++) {
      const big = triangleGeom(geos, [
        [0, 0],
        [100, 0],
        [50, 100],
        [0, 0],
      ]);
      // A small triangle strictly inside via centroid scaling.
      const cx = 30 + rnd() * 20;
      const cy = 20 + rnd() * 20;
      const s = 2 + rnd() * 5;
      const small = triangleGeom(geos, [
        [cx - s, cy - s],
        [cx + s, cy - s],
        [cx, cy + s],
        [cx - s, cy - s],
      ]);
      if (!geos.covers(big, small)) continue;
      const inter = geos.intersection(big, small);
      expect(geos.area(inter)).toBeCloseTo(geos.area(small), 9);
      inter.dispose();
      small.dispose();
      big.dispose();
    }
  });
});

describe("builder fuzz (shim builders ≡ per-ring construction)", () => {
  it("random rings via build_polygon equal GEOS-parsed rings", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 7);
    for (let i = 0; i < 300; i++) {
      const shell = randomTriangle(rnd);
      // Build via the shim path:
      const coords = new Float64Array(shell.length * 2);
      shell.forEach(([x, y], k) => {
        coords[k * 2] = x!;
        coords[k * 2 + 1] = y!;
      });
      const built = geos.fromPolygonal({
        coords,
        ringOffsets: Int32Array.of(shell.length),
        partOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      });
      // Reference: parse the same shape from GeoJSON (JS-side path).
      const parsed = geos.fromGeoJSON({ type: "Polygon", coordinates: [shell] });
      expect(geos.equalsIdentical(built, parsed), `ring ${i}`).toBe(true);
      expect(geos.area(built)).toBeCloseTo(geos.area(parsed), 9);
      built.dispose();
      parsed.dispose();
    }
  });
});

describe("prepared-vs-batch foundations (Phase 2 will reuse these)", () => {
  it("intersection is commutative in area across random pairs", () => {
    using geos = new Geos();
    const rnd = mulberry32(SEED + 8);
    for (let i = 0; i < 100; i++) {
      const a: Geometry = triangleGeom(geos, randomTriangle(rnd));
      const b: Geometry = triangleGeom(geos, randomTriangle(rnd));
      const ab = geos.intersection(a, b);
      const ba = geos.intersection(b, a);
      expect(geos.area(ab)).toBeCloseTo(geos.area(ba), 9);
      ab.dispose();
      ba.dispose();
      a.dispose();
      b.dispose();
    }
  });
});
