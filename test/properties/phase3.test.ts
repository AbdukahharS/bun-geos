/**
 * Phase 3 property tests (testing.md §5 gate: "batch/singular agreement").
 * Seeded (mulberry32) and reproducible: every batch op must equal its
 * element-wise singular twin across randomized corpora, and the prepared
 * masks must agree with the unprepared batch masks (Robustness contracts,
 * testing.md §2 — extended to the Phase 3 layer).
 */
import { describe, expect, it } from "bun:test";
import type { Geometry, Geos } from "../../src/index.ts";
import { mulberry32, randomTriangle, triangleGeom, withGeos } from "../helpers.ts";

const ROUNDS = 24;

/** A triangle WKT-pair corpus: some overlapping, some disjoint, some equal. */
function triangleBatch(geos: Geos, rnd: () => number, n: number): Geometry[] {
  const gs: Geometry[] = [];
  for (let i = 0; i < n; i++) gs.push(triangleGeom(geos, randomTriangle(rnd)));
  return gs;
}

describe("batch/singular agreement (seeded)", () => {
  it("overlay batches equal element-wise singulars across randomized triangles", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xc0ffee);
      for (let round = 0; round < ROUNDS; round++) {
        using clip = triangleGeom(geos, randomTriangle(rnd));
        const bs = triangleBatch(geos, rnd, 12);
        const inter = geos.intersectionAll(clip, bs);
        const diff = geos.differenceAll(clip, bs);
        const sym = geos.symDifferenceAll(clip, bs);
        const prec = geos.intersectionPrecAll(clip, bs, 1 / 64);
        for (let i = 0; i < bs.length; i++) {
          using sI = geos.intersection(clip, bs[i]!);
          using sD = geos.difference(clip, bs[i]!);
          using sS = geos.symDifference(clip, bs[i]!);
          using sP = geos.intersectionPrec(clip, bs[i]!, 1 / 64);
          expect(geos.equalsIdentical(inter[i]!, sI)).toBe(true);
          expect(geos.equalsIdentical(diff[i]!, sD)).toBe(true);
          expect(geos.equalsIdentical(sym[i]!, sS)).toBe(true);
          expect(geos.equalsIdentical(prec[i]!, sP)).toBe(true);
          // robustness contract (testing.md §2): overlay outputs on valid
          // inputs stay valid
          expect(geos.isValid(inter[i]!)).toBe(true);
        }
        for (const g of [...inter, ...diff, ...sym, ...prec, ...bs]) g.dispose();
      }
    }));

  it("unprepared batch masks equal element-wise singulars (all nine predicates)", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xbeef01);
      const preds = {
        intersects: (a: Geometry, b: Geometry) => geos.intersects(a, b),
        contains: (a: Geometry, b: Geometry) => geos.contains(a, b),
        coveredBy: (a: Geometry, b: Geometry) => geos.coveredBy(a, b),
        covers: (a: Geometry, b: Geometry) => geos.covers(a, b),
        crosses: (a: Geometry, b: Geometry) => geos.crosses(a, b),
        disjoint: (a: Geometry, b: Geometry) => geos.disjoint(a, b),
        overlaps: (a: Geometry, b: Geometry) => geos.overlaps(a, b),
        touches: (a: Geometry, b: Geometry) => geos.touches(a, b),
        within: (a: Geometry, b: Geometry) => geos.within(a, b),
      } as const;
      for (let round = 0; round < ROUNDS; round++) {
        using a = triangleGeom(geos, randomTriangle(rnd));
        const bs = triangleBatch(geos, rnd, 10);
        for (const [name, singular] of Object.entries(preds)) {
          const mask = geos.predicateAll(name as keyof typeof preds, a, bs);
          for (let i = 0; i < bs.length; i++) {
            expect(mask[i]).toBe(singular(a, bs[i]!) ? 1 : 0);
          }
        }
        // prepared masks agree with the unprepared batch masks (RelateNG
        // short-circuits must not change answers — testing.md §2)
        using prep = a.prepare();
        expect(prep.intersectsAll(bs)).toEqual(geos.intersectsAll(a, bs));
        expect(prep.disjointAll(bs)).toEqual(geos.disjointAll(a, bs));
        for (const b of bs) b.dispose();
      }
    }));

  it("batch measures equal element-wise singulars", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xfeed02);
      for (let round = 0; round < ROUNDS; round++) {
        const gs = triangleBatch(geos, rnd, 8);
        using probe = triangleGeom(geos, randomTriangle(rnd));
        const areas = geos.areaAll(gs);
        const lengths = geos.lengthAll(gs);
        const dists = geos.distanceAll(probe, gs);
        for (let i = 0; i < gs.length; i++) {
          expect(areas[i]).toBe(geos.area(gs[i]!));
          expect(lengths[i]).toBe(geos.length(gs[i]!));
          expect(dists[i]).toBe(geos.distance(probe, gs[i]!));
        }
        for (const g of gs) g.dispose();
      }
    }));

  it("bufferAll equals singular buffer element-wise", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xd065);
      const gs = triangleBatch(geos, rnd, 8);
      const dist = 0.5 + rnd();
      const outs = geos.bufferAll(gs, dist, { quadSegs: 4 });
      for (let i = 0; i < gs.length; i++) {
        using singular = geos.buffer(gs[i]!, dist, { quadSegs: 4 });
        expect(geos.area(outs[i]!)).toBeCloseTo(geos.area(singular), 6);
      }
      for (const g of [...gs, ...outs]) g.dispose();
    }));

  it("fromWKBMany roundtrips byte-identical WKB across a randomized corpus", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0x51ba);
      for (let round = 0; round < 8; round++) {
        const gs = triangleBatch(geos, rnd, 16);
        const parts = gs.map((g) => geos.toWKB(g, { byteOrder: "little" }));
        const total = parts.reduce((n, p) => n + p.length, 0);
        const buf = new Uint8Array(total);
        const offsets = new Uint32Array(parts.length);
        let off = 0;
        for (let i = 0; i < parts.length; i++) {
          buf.set(parts[i]!, off);
          off += parts[i]!.length;
          offsets[i] = off;
        }
        const round_ = geos.fromWKBMany(buf, offsets);
        for (let i = 0; i < gs.length; i++) {
          expect(geos.equalsIdentical(round_[i]!, gs[i]!)).toBe(true);
        }
        for (const g of [...gs, ...round_]) g.dispose();
      }
    }));

  it("Arrow-normalized batch input equals WKT-built input", () =>
    withGeos((geos) => {
      const rnd = mulberry32(0xa11ce);
      for (let round = 0; round < ROUNDS; round++) {
        const gs = triangleBatch(geos, rnd, 6);
        // each triangle to a Polygonal-shaped batch (one ring each)
        const flats = gs.map((g) => geos.coordinates(geos.exteriorRing(g)));
        const coords = new Float64Array(flats.reduce((n, f) => n + f.coords.length, 0));
        const ringOffsets = new Int32Array(flats.length);
        const partOffsets = new Int32Array(flats.length);
        let off = 0;
        let coordEnd = 0;
        for (let i = 0; i < flats.length; i++) {
          coords.set(flats[i]!.coords, off);
          off += flats[i]!.coords.length;
          coordEnd += flats[i]!.n;
          ringOffsets[i] = coordEnd;
          partOffsets[i] = i + 1;
        }
        const fromArrow = geos.areaAll({
          coords,
          ringOffsets,
          partOffsets,
          hasZ: false,
          hasM: false,
        });
        for (let i = 0; i < gs.length; i++) {
          expect(fromArrow[i]).toBeCloseTo(geos.area(gs[i]!), 9);
        }
        for (const g of gs) g.dispose();
      }
    }));
});
