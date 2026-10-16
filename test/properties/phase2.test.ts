/**
 * Phase 2 property-based invariants (testing.md §2), seeded and
 * reproducible: prepared/unprepared agreement, batch/singular agreement,
 * unionAll strategy agreement, repair contracts, STRtree query superset.
 */
import { describe, expect, it } from "bun:test";
import type { Geometry } from "../../src/index.ts";
import { mulberry32, randomTriangle, withGeos } from "../helpers.ts";

describe("prepared/unprepared agreement (property)", () => {
  it("every prepared predicate ≡ its unprepared twin across a seeded corpus", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2501);
      const geoms: Geometry[] = [];
      for (let i = 0; i < 40; i++) {
        geoms.push(geos.fromGeoJSON({ type: "Polygon", coordinates: [randomTriangle(rnd)] }));
        geoms.push(geos.point(rnd() * 100, rnd() * 100));
        geoms.push(
          geos.fromWKT(`LINESTRING (${rnd() * 100} ${rnd() * 100}, ${rnd() * 100} ${rnd() * 100})`),
        );
      }
      // one geometry prepared, all others tested against it
      const prep = geoms[0]!.prepare();
      try {
        const pairs = [
          ["intersects", "intersects"],
          ["contains", "contains"],
          ["covers", "covers"],
          ["coveredBy", "coveredBy"],
          ["crosses", "crosses"],
          ["touches", "touches"],
          ["overlaps", "overlaps"],
          ["within", "within"],
          ["disjoint", "disjoint"],
        ] as const;
        let checked = 0;
        for (const [prepName, plainName] of pairs) {
          const p = prep[prepName].bind(prep) as (b: Geometry) => boolean;
          const plain = (geos[plainName] as (a: Geometry, b: Geometry) => boolean).bind(geos);
          for (const g of geoms) {
            expect(p(g)).toBe(plain(geoms[0]!, g));
            checked++;
          }
        }
        expect(checked).toBe(9 * geoms.length);
      } finally {
        prep.dispose(); // release the pin BEFORE disposing the corpus
        for (const g of geoms) g.dispose();
      }
    }));

  it("batch masks match element-wise singulars on the seeded corpus", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2502);
      const geoms: Geometry[] = [];
      for (let i = 0; i < 60; i++) {
        geoms.push(geos.point(rnd() * 100, rnd() * 100));
      }
      using target = geos.fromGeoJSON({
        type: "Polygon",
        coordinates: [
          [
            [30, 30],
            [70, 30],
            [70, 70],
            [30, 70],
            [30, 30],
          ],
        ],
      });
      using prep = target.prepare();
      const mask = prep.intersectsAll(geoms);
      for (let i = 0; i < geoms.length; i++) {
        expect(mask[i]).toBe(prep.intersects(geoms[i]!) ? 1 : 0);
      }
      for (const g of geoms) g.dispose();
    }));
});

describe("unionAll strategy agreement (property)", () => {
  it("auto ≡ unary ≡ disjointSubset in AREA on random overlapping triangles", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2503);
      for (let trial = 0; trial < 25; trial++) {
        const gs = Array.from({ length: 5 }, () =>
          geos.fromGeoJSON({ type: "Polygon", coordinates: [randomTriangle(rnd)] }),
        );
        try {
          using auto = geos.unionAll(gs);
          using unary = geos.unionAll(gs, { strategy: "unary" });
          using disjoint = geos.unionAll(gs, { strategy: "disjointSubset" });
          const a1 = geos.area(auto);
          expect(a1).toBeCloseTo(geos.area(unary), 6);
          expect(a1).toBeCloseTo(geos.area(disjoint), 6);
          expect(geos.isValid(auto)).toBe(true);
        } finally {
          for (const g of gs) g.dispose();
        }
      }
    }));

  it("an aligned grid coverage: auto result ≡ explicit coverage result", () =>
    withGeos((geos) => {
      const gs: Geometry[] = [];
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          gs.push(
            geos.fromWKT(
              `POLYGON ((${i} ${j}, ${i + 1} ${j}, ${i + 1} ${j + 1}, ${i} ${j + 1}, ${i} ${j}))`,
            ),
          );
        }
      }
      try {
        using auto = geos.unionAll(gs);
        using cov = geos.unionAll(gs, { strategy: "coverage" });
        using raw = geos.coverageUnion(gs);
        expect(geos.area(auto)).toBeCloseTo(16, 9);
        expect(geos.equals(auto, cov)).toBe(true);
        expect(geos.equals(auto, raw)).toBe(true);
      } finally {
        for (const g of gs) g.dispose();
      }
    }));
});

describe("repair contracts (property)", () => {
  it("makeValid always returns a valid geometry; area is conserved for disjoint unions", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2505);
      for (let trial = 0; trial < 30; trial++) {
        // self-crossing quads are reliably invalid inputs (ring closed properly)
        const pts = Array.from(
          { length: 4 },
          () => `${(rnd() * 10).toFixed(3)} ${(rnd() * 10).toFixed(3)}`,
        );
        const wkt = `POLYGON ((${pts[0]}, ${pts[1]}, ${pts[2]}, ${pts[3]}, ${pts[0]}))`;
        using g = geos.fromWKT(wkt);
        if (geos.isValid(g)) continue;
        using fixed = geos.makeValid(g);
        expect(geos.isValid(fixed)).toBe(true);
      }
    }));

  it("area additivity on disjoint unions via unionAll", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2506);
      for (let trial = 0; trial < 20; trial++) {
        const x = rnd() * 50;
        const a = geos.fromWKT(
          `POLYGON ((${x} ${x}, ${x + 2} ${x}, ${x + 2} ${x + 2}, ${x} ${x + 2}, ${x} ${x}))`,
        );
        const y = x + 20 + rnd() * 10;
        const b = geos.fromWKT(
          `POLYGON ((${y} ${y}, ${y + 2} ${y}, ${y + 2} ${y + 2}, ${y} ${y + 2}, ${y} ${y}))`,
        );
        try {
          using u = geos.unionAll([a, b]);
          expect(geos.area(u)).toBeCloseTo(8, 9);
        } finally {
          a.dispose();
          b.dispose();
        }
      }
    }));
});

describe("STRtree query superset property", () => {
  it("tree query ⊇ exact predicate scan on seeded point sets", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbe2507);
      const pts: Geometry[] = [];
      const coords: Array<[number, number]> = [];
      for (let i = 0; i < 300; i++) {
        const x = rnd() * 100;
        const y = rnd() * 100;
        coords.push([x, y]);
        pts.push(geos.point(x, y));
      }
      const tree = geos.strtree(pts);
      try {
        // candidates from the tree must include every TRUE hit of an exact
        // prepared-intersects scan against the query polygon
        using query = geos.fromWKT("POLYGON ((40 40, 60 40, 60 60, 40 60, 40 40))");
        using preparedQuery = query.prepare();
        const candidates = new Set([...tree.query(query)]);
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = coords[i]!;
          const exactlyInside = x >= 40 && x <= 60 && y >= 40 && y <= 60;
          if (exactlyInside) expect(candidates.has(i)).toBe(true);
          expect(preparedQuery.intersects(pts[i]!)).toBe(exactlyInside);
        }
      } finally {
        tree.dispose();
        for (const p of pts) p.dispose();
      }
    }));
});
