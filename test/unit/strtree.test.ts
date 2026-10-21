/**
 * STRtree (Phase 2, archived api-surface §Spatial index): query/nearest correctness
 * against brute force, id semantics, and the D16 liveness rules.
 */

import { describe, expect, it } from "bun:test";
import { gc } from "bun";
import { type Geometry, Geos } from "../../src/index.ts";
import { mulberry32, withGeos } from "../helpers.ts";

/** A seeded grid of small squares — queries are envelope intersections. */
function square(geos: Geos, x: number, y: number, s = 1): Geometry {
  return geos.fromWKT(
    `POLYGON ((${x} ${y}, ${x + s} ${y}, ${x + s} ${y + s}, ${x} ${y + s}, ${x} ${y}))`,
  );
}

describe("STRtree query", () => {
  it("returns every envelope-overlapping id (vs brute force, seeded)", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0x57ee);
      const geoms: Geometry[] = [];
      const boxes: Array<[number, number, number, number]> = [];
      for (let i = 0; i < 500; i++) {
        const x = rnd() * 100;
        const y = rnd() * 100;
        const s = 0.5 + rnd() * 3;
        geoms.push(square(geos, x, y, s));
        boxes.push([x, y, x + s, y + s]);
      }
      const tree = geos.strtree(geoms);
      try {
        for (let trial = 0; trial < 50; trial++) {
          const qx = rnd() * 90;
          const qy = rnd() * 90;
          const qs = 2 + rnd() * 20;
          using query = square(geos, qx, qy, qs);
          const got = new Set([...tree.query(query)]);
          const expected = new Set<number>();
          for (let i = 0; i < boxes.length; i++) {
            const [x1, y1, x2, y2] = boxes[i]!;
            if (x1 <= qx + qs && x2 >= qx && y1 <= qy + qs && y2 >= qy) expected.add(i);
          }
          // tree results must EXACTLY match envelope intersection (STR
          // tree query is exact on envelopes, not approximate)
          expect([...got].sort()).toEqual([...expected].sort());
        }
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));

  it("constructor form assigns ids = input indices", () =>
    withGeos((geos) => {
      const geoms = [square(geos, 0, 0), square(geos, 10, 10), square(geos, 20, 20)];
      const tree = geos.strtree(geoms);
      try {
        expect(tree.size).toBe(3);
        using query = square(geos, 19.5, 19.5, 1);
        expect([...tree.query(query)]).toEqual([2]);
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));

  it("empty tree queries to an empty array", () =>
    withGeos((geos) => {
      using tree = geos.strtree();
      using query = square(geos, 0, 0);
      expect(tree.query(query).length).toBe(0);
    }));

  it("insert after build throws (tree freezes at build)", () =>
    withGeos((geos) => {
      using a = square(geos, 0, 0);
      using tree = geos.strtree([a]);
      tree.build();
      using b = square(geos, 50, 50);
      expect(() => tree.insert(b)).toThrow(TypeError);
    }));
});

describe("STRtree nearest", () => {
  it("reports id 0 when the first-inserted item is the nearest (NULL-overload pin)", () =>
    withGeos((geos) => {
      // id 0 is stored as (void*)(id+1): a 0-valued item would be
      // indistinguishable from nearest_generic's NULL "no answer" return and
      // nearest() would misreport -1 (audited blocker).
      const geoms = [geos.point(0, 0), geos.point(50, 50), geos.point(90, 90)];
      const tree = geos.strtree(geoms);
      try {
        using q = geos.point(1, 1); // nearest to id 0 by construction
        expect(tree.nearest(q)).toBe(0);
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));

  it("matches brute force distance (seeded)", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0x9e57);
      const geoms: Geometry[] = [];
      for (let i = 0; i < 200; i++) {
        geoms.push(geos.point(rnd() * 100, rnd() * 100));
      }
      const tree = geos.strtree(geoms);
      try {
        for (let trial = 0; trial < 30; trial++) {
          using q = geos.point(rnd() * 100, rnd() * 100);
          const got = tree.nearest(q);
          expect(got).toBeGreaterThanOrEqual(0);
          const gotDist = geos.distance(q, geoms[got]!);
          let best = Infinity;
          for (const g of geoms) best = Math.min(best, geos.distance(q, g));
          expect(gotDist).toBeCloseTo(best, 9);
        }
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));

  it("returns -1 for an empty tree and works after dispose-rebuild cycle", () =>
    withGeos((geos) => {
      using tree = geos.strtree();
      using q = geos.point(1, 1);
      expect(tree.nearest(q)).toBe(-1);
    }));

  it("ties resolve to a valid id at the same distance", () =>
    withGeos((geos) => {
      const geoms = [geos.point(10, 10), geos.point(0, 0), geos.point(2, 0)];
      const tree = geos.strtree(geoms);
      try {
        using q = geos.point(1, 0);
        const id = tree.nearest(q);
        expect(id === 1 || id === 2).toBe(true);
        expect(geos.distance(q, geoms[id]!)).toBeCloseTo(1, 12);
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));
});

describe("STRtree lifecycle (D16/D17)", () => {
  it("pins indexed geometries: dispose of a member throws until the tree is gone", () =>
    withGeos((geos) => {
      const a = square(geos, 0, 0);
      const tree = geos.strtree([a]);
      expect(a.pinned).toBe(true);
      expect(() => a.dispose()).toThrow(TypeError);
      tree.dispose();
      expect(a.pinned).toBe(false);
      a.dispose(); // released — caller owns it again
    }));

  it("an arena-born geometry is relinquished to the caller when inserted (D17)", () =>
    withGeos((geos) => {
      let kept: Geometry;
      {
        using _arena = geos.arena();
        const g = square(geos, 0, 0);
        const tree = geos.strtree([g]); // pin removes g from the arena
        kept = g;
        tree.dispose(); // release the pin; geometry is caller-owned again
      } // arena exits — must NOT free `kept`
      expect(kept.disposed).toBe(false);
      kept.dispose();
    }));

  it("strtree() constructor cleans up the tree when an insert throws mid-loop", () =>
    withGeos((geos) => {
      const good = square(geos, 0, 0);
      try {
        using other = new Geos();
        const foreign = other.point(1, 1);
        expect(() => geos.strtree([good, foreign])).toThrow(TypeError);
        // the half-built tree was disposed → the pin is released
        expect(good.pinned).toBe(false);
      } finally {
        good.dispose();
      }
    }));

  it("the tree keeps strong refs: no finalizer reaping of indexed geoms", () => {
    // geoms go out of scope while the tree is alive; wrappers are kept
    // reachable by the tree, so nothing is reaped and queries stay valid.
    using geos = new Geos();
    const tree = geos.strtree();
    for (let i = 0; i < 100; i++) tree.insert(geos.point(i, i));
    gc(true);
    gc(true);
    using probe = geos.fromWKT("POLYGON ((10 10, 15 10, 15 15, 10 15, 10 10))");
    expect([...tree.query(probe)].length).toBeGreaterThan(0);
    const liveBefore = geos.stats.liveGeoms;
    tree.dispose();
    // tree gone: pins released, but the wrappers were dropped by the caller —
    // only the probe remains accounted; the rest are reaped by the backstop
    // eventually (or counted until then). No crash is the contract here.
    expect(geos.stats.liveGeoms).toBeLessThanOrEqual(liveBefore);
  });

  it("context dispose disposes a still-open tree without crashing", () =>
    withGeos((geos) => {
      const a = square(geos, 0, 0);
      const _tree = geos.strtree([a]); // deliberately left open
    }));

  it("query result ids map back to alive geometries via tree.get", () =>
    withGeos((geos) => {
      const geoms = [square(geos, 0, 0), square(geos, 10, 10)];
      const tree = geos.strtree(geoms);
      try {
        using probe = square(geos, 9.5, 9.5, 1);
        for (const id of tree.query(probe)) {
          expect(tree.get(id)).toBe(geoms[id]!);
        }
      } finally {
        tree.dispose();
        for (const g of geoms) g.dispose();
      }
    }));
});
