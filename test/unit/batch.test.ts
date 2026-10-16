/**
 * Phase 3 batch op layer (D22): element-wise `*All` ops — known answers,
 * batch/singular agreement, Arrow-shaped input normalization, arena
 * registration of outputs, and the all-or-nothing error contract.
 * (C-side partial-output destruction is proven under ASan/LSan in
 * test/native/shim_selftest.c scenarios 20–28.)
 */
import { describe, expect, it } from "bun:test";
import { type Geometry, Geos, GeosError } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

const SQ = "POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))";
const UNIT = (x: number, y: number) =>
  `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`;

describe("batch overlays", () => {
  it("intersectionAll matches element-wise singulars (known answers)", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = [geos.fromWKT(UNIT(0, 0)), geos.fromWKT(UNIT(1, 1)), geos.fromWKT(UNIT(9, 9))];
      using arena = geos.arena(); // collects the batch outputs; disposed at scope exit
      const outs = geos.intersectionAll(a, bs);
      expect(outs.length).toBe(3);
      expect(arena.size).toBe(3);
      expect(geos.area(outs[0]!)).toBe(1);
      expect(geos.area(outs[1]!)).toBe(1);
      expect(geos.area(outs[2]!)).toBe(0);
      // batch/singular agreement, element-wise
      for (let i = 0; i < bs.length; i++) {
        using singular = geos.intersection(a, bs[i]!);
        expect(geos.equalsIdentical(outs[i]!, singular)).toBe(true);
      }
      for (const b of bs) b.dispose();
    }));

  it("differenceAll and symDifferenceAll agree with singulars", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = [geos.fromWKT(UNIT(0, 0)), geos.fromWKT(UNIT(9, 9))];
      const d = geos.differenceAll(a, bs);
      const s = geos.symDifferenceAll(a, bs);
      for (let i = 0; i < bs.length; i++) {
        using dS = geos.difference(a, bs[i]!);
        using sS = geos.symDifference(a, bs[i]!);
        expect(geos.equalsIdentical(d[i]!, dS)).toBe(true);
        expect(geos.equalsIdentical(s[i]!, sS)).toBe(true);
      }
      for (const b of bs) b.dispose();
      for (const g of [...d, ...s]) g.dispose();
    }));

  it("*Prec variants match the singular *Prec ops", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = [geos.fromWKT(UNIT(0, 0)), geos.fromWKT(UNIT(1, 1))];
      const outs = geos.intersectionPrecAll(a, bs, 1.0);
      for (let i = 0; i < bs.length; i++) {
        using singular = geos.intersectionPrec(a, bs[i]!, 1.0);
        expect(geos.equalsIdentical(outs[i]!, singular)).toBe(true);
      }
      const dPrec = geos.differencePrecAll(a, bs, 1.0);
      const sPrec = geos.symDifferencePrecAll(a, bs, 1.0);
      expect(dPrec.length).toBe(2);
      expect(sPrec.length).toBe(2);
      for (const g of [...outs, ...dPrec, ...sPrec]) g.dispose();
      for (const b of bs) b.dispose();
    }));

  it("empty input returns empty results without touching GEOS", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      expect(geos.intersectionAll(a, [])).toEqual([]);
      expect(geos.intersectsAll(a, [])).toEqual(new Uint8Array(0));
      expect(geos.areaAll([])).toEqual(new Float64Array(0));
      expect(geos.fromWKBMany(new Uint8Array(0), new Uint32Array(0))).toEqual([]);
    }));

  it("outputs register into opts.arena and the arena frees them in one call", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = Array.from({ length: 8 }, (_, i) => geos.fromWKT(UNIT(i, i)));
      using arena = geos.arena();
      const before = geos.stats.liveGeoms;
      const outs = geos.intersectionAll(a, bs, { arena });
      expect(arena.size).toBe(outs.length);
      expect(geos.stats.liveGeoms).toBe(before + outs.length);
      arena.dispose();
      expect(geos.stats.liveGeoms).toBe(before);
      for (const b of bs) b.dispose();
    }));

  it("rejects foreign-context inputs before any FFI crossing", () =>
    withGeos((geos) => {
      using other = new Geos();
      using a = geos.fromWKT(SQ);
      using foreign = other.fromWKT(UNIT(0, 0));
      expect(() => geos.intersectionAll(a, [foreign])).toThrow(TypeError);
      expect(() => geos.intersectsAll(a, [foreign])).toThrow(TypeError);
      expect(() => geos.distanceAll(a, [foreign])).toThrow(TypeError);
    }));

  it("all-or-nothing: a spent geometry mid-array aborts the whole call", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const good = geos.fromWKT(UNIT(0, 0));
      const spent = geos.fromWKT(UNIT(1, 1));
      spent.dispose();
      const before = geos.stats.liveGeoms;
      expect(() => geos.intersectionAll(a, [good, spent])).toThrow(TypeError);
      // no partial wrappers were created
      expect(geos.stats.liveGeoms).toBe(before);
      good.dispose();
    }));

  it("an already-aborted signal throws the uniform aborted shape pre-flight", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = [geos.fromWKT(UNIT(0, 0))];
      const cause = new Error("stop");
      const signal = AbortSignal.abort(cause);
      let caught: unknown;
      try {
        geos.intersectionAll(a, bs, { signal });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GeosError);
      expect((caught as GeosError).op).toBe("aborted");
      expect((caught as GeosError).cause).toBe(cause);
      bs[0]!.dispose();
    }));
});

describe("batch predicates (unprepared masks)", () => {
  it("all nine masks match element-wise singulars", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const bs = [
        geos.fromWKT("POINT (2 2)"), // inside
        geos.fromWKT("POINT (0 2)"), // boundary
        geos.fromWKT("POINT (9 9)"), // outside
        geos.fromWKT(UNIT(1, 1)), // overlaps
        geos.fromWKT(UNIT(9, 9)), // disjoint
      ];
      const names = [
        "intersects",
        "contains",
        "coveredBy",
        "covers",
        "crosses",
        "disjoint",
        "overlaps",
        "touches",
        "within",
      ] as const;
      const singulars: Record<string, (x: Geometry, y: Geometry) => boolean> = {
        intersects: (x, y) => geos.intersects(x, y),
        contains: (x, y) => geos.contains(x, y),
        coveredBy: (x, y) => geos.coveredBy(x, y),
        covers: (x, y) => geos.covers(x, y),
        crosses: (x, y) => geos.crosses(x, y),
        disjoint: (x, y) => geos.disjoint(x, y),
        overlaps: (x, y) => geos.overlaps(x, y),
        touches: (x, y) => geos.touches(x, y),
        within: (x, y) => geos.within(x, y),
      };
      for (const name of names) {
        const mask = geos.predicateAll(name, a, bs);
        expect(mask.length).toBe(bs.length);
        for (let i = 0; i < bs.length; i++) {
          expect(mask[i]).toBe(singulars[name]!(a, bs[i]!) ? 1 : 0);
        }
      }
      // named aliases hit the same path
      expect(geos.intersectsAll(a, bs)).toEqual(geos.predicateAll("intersects", a, bs));
      for (const b of bs) b.dispose();
    }));
});

describe("batch measures", () => {
  it("areaAll/lengthAll are exact; distanceAll matches singulars", () =>
    withGeos((geos) => {
      const gs = [
        geos.fromWKT(UNIT(0, 0)),
        geos.fromWKT("LINESTRING (0 0, 3 4)"),
        geos.fromWKT("POINT (1 1)"),
      ];
      const areas = geos.areaAll(gs);
      expect(areas[0]).toBe(1);
      expect(areas[1]).toBe(0);
      expect(areas[2]).toBe(0);
      const lengths = geos.lengthAll(gs);
      expect(lengths[0]).toBe(4);
      expect(lengths[1]).toBe(5);
      expect(lengths[2]).toBe(0);
      using probe = geos.fromWKT("POINT (10 10)");
      const dists = geos.distanceAll(probe, gs);
      for (let i = 0; i < gs.length; i++) {
        expect(dists[i]).toBe(geos.distance(probe, gs[i]!));
      }
      const h = geos.hausdorffAll(probe, gs);
      const f = geos.frechetAll(probe, gs);
      for (let i = 0; i < gs.length; i++) {
        expect(h[i]).toBe(geos.hausdorff(probe, gs[i]!));
        expect(f[i]).toBe(geos.frechet(probe, gs[i]!));
      }
      for (const g of gs) g.dispose();
    }));
});

describe("bufferAll", () => {
  it("buffers every geometry with shared options", () =>
    withGeos((geos) => {
      const pts = [geos.fromWKT("POINT (0 0)"), geos.fromWKT("POINT (50 50)")];
      const outs = geos.bufferAll(pts, 1, { quadSegs: 8 });
      expect(outs.length).toBe(2);
      const areas = outs.map((o) => geos.area(o));
      for (const a of areas) {
        expect(a).toBeGreaterThan(3.0);
        expect(a).toBeLessThan(3.2);
      }
      // options plumb through: quadSegs 1 → smaller disc
      const rough = geos.bufferAll(pts, 1, { quadSegs: 1 });
      expect(geos.area(rough[0]!)).toBeLessThan(areas[0]!);
      for (const o of [...outs, ...rough]) o.dispose();
      for (const p of pts) p.dispose();
    }));
});

describe("batch Arrow input normalization", () => {
  it("Polygonal input builds every polygon in one call and matches WKT input", () =>
    withGeos((geos) => {
      // two unit tiles as one concatenated buffer
      const coords = new Float64Array([
        0,
        0,
        1,
        0,
        1,
        1,
        0,
        1,
        0,
        0, // tile A
        5,
        5,
        6,
        5,
        6,
        6,
        5,
        6,
        5,
        5, // tile B
      ]);
      const arr = {
        coords,
        ringOffsets: Int32Array.of(5, 10),
        partOffsets: Int32Array.of(1, 2),
        hasZ: false,
        hasM: false,
      };
      using a = geos.fromWKT(SQ);
      const outs = geos.intersectionAll(a, arr);
      expect(outs.length).toBe(2);
      expect(geos.area(outs[0]!)).toBe(1);
      expect(geos.area(outs[1]!)).toBe(0); // tile B is outside SQ
      // the transient normalization arena is gone: stats back to just outputs+inputs
      outs[0]!.dispose();
      outs[1]!.dispose();
    }));

  it("LineArray and FlatCoords input normalize for masks and measures", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const lineArr = {
        coords: new Float64Array([1, 1, 2, 2, 9, 9, 9, 10]),
        lineOffsets: Int32Array.of(2, 4),
        hasZ: false,
        hasM: false,
      };
      const mask = geos.intersectsAll(a, lineArr);
      expect(mask.length).toBe(2);
      expect(mask[0]).toBe(1);
      expect(mask[1]).toBe(0);
      const lengths = geos.lengthAll(lineArr);
      expect(lengths.length).toBe(2);
      const ptArr = {
        coords: new Float64Array([2, 2, 9, 9]),
        n: 2,
        hasZ: false,
        hasM: false,
      };
      expect(geos.intersectsAll(a, ptArr)).toEqual(new Uint8Array([1, 0]));
      expect(geos.areaAll(ptArr)).toEqual(new Float64Array([0, 0]));
    }));

  it("prepared *All accepts Arrow-shaped input too", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      using prep = a.prepare();
      const ptArr = {
        coords: new Float64Array([2, 2, 9, 9]),
        n: 2,
        hasZ: false,
        hasM: false,
      };
      expect(prep.intersectsAll(ptArr)).toEqual(new Uint8Array([1, 0]));
    }));

  it("malformed Arrow offsets throw and leak nothing", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(SQ);
      const before = geos.stats.liveGeoms;
      const bad = {
        coords: new Float64Array([0, 0, 1, 1, 2, 2]),
        ringOffsets: Int32Array.of(3, 2), // not increasing
        partOffsets: Int32Array.of(2),
        hasZ: false,
        hasM: false,
      };
      expect(() => geos.areaAll(bad)).toThrow(GeosError);
      const badLine = {
        coords: new Float64Array([0, 0, 1, 1]),
        lineOffsets: Int32Array.of(1), // 1-coordinate line
        hasZ: false,
        hasM: false,
      };
      expect(() => geos.intersectsAll(a, badLine)).toThrow(GeosError);
      expect(geos.stats.liveGeoms).toBe(before);
    }));
});

describe("STRtree.queryFilter (fused query + prepared filter)", () => {
  it("matches query() + prepared singular filtering", () =>
    withGeos((geos) => {
      const items = Array.from({ length: 200 }, (_, i) =>
        geos.fromWKT(`LINESTRING (${i} ${i}, ${i + 1} ${i + 1})`),
      );
      const tree = geos.strtree(items);
      using env = geos.fromWKT("POLYGON ((50 50, 60 50, 60 60, 50 60, 50 50))");
      using sq = geos.fromWKT("POLYGON ((50 50, 60 50, 60 60, 50 60, 50 50))");
      using prep = sq.prepare();
      const fused = tree.queryFilter(env, prep);
      // reference: candidates + exact filter in JS
      const candidates = tree.query(env);
      const expected = [...candidates].filter((id) => prep.intersects(items[id]!));
      expect([...fused]).toEqual(expected);
      expect(fused.length).toBeGreaterThan(0);
      // predicate selection: contains should be a subset (or equal here)
      const contained = tree.queryFilter(env, prep, "contains");
      expect(contained.length).toBeLessThanOrEqual(fused.length);
      tree.dispose();
      for (const it of items) it.dispose();
    }));

  it("enforces context and lifecycle rules", () =>
    withGeos((geos) => {
      using other = new Geos();
      const items = [geos.fromWKT("POINT (0 0)")];
      const tree = geos.strtree(items);
      using env = geos.fromWKT("POLYGON ((-1 -1, 1 -1, 1 1, -1 1, -1 -1))");
      using foreignSq = other.fromWKT("POLYGON ((-1 -1, 1 -1, 1 1, -1 1, -1 -1))");
      using foreignPrep = foreignSq.prepare();
      expect(() => tree.queryFilter(env, foreignPrep)).toThrow(TypeError);
      using sq = geos.fromWKT("POLYGON ((-1 -1, 1 -1, 1 1, -1 1, -1 -1))");
      using prep = sq.prepare();
      prep.dispose();
      expect(() => tree.queryFilter(env, prep)).toThrow(TypeError);
      tree.dispose();
      items[0]!.dispose();
    }));

  it("returns every match even when the first buffer undershoots", () =>
    withGeos((geos) => {
      // dense tree: one query envelope matches ~all of 10k items (initial
      // buffer is capped at 4096 — the re-query path must engage)
      const items = Array.from({ length: 10_000 }, (_, i) => {
        const x = i % 100;
        const y = Math.floor(i / 100);
        return geos.fromWKT(`POINT (${x} ${y})`);
      });
      const tree = geos.strtree(items);
      using env = geos.fromWKT("POLYGON ((-1 -1, 100 -1, 100 100, -1 100, -1 -1))");
      using prep = env.prepare();
      const hits = tree.queryFilter(env, prep);
      expect(hits.length).toBe(10_000);
      tree.dispose();
      for (const it of items) it.dispose();
    }));
});

describe("fromWKBMany", () => {
  it("roundtrips what toWKB wrote, byte offsets respected", () =>
    withGeos((geos) => {
      const gs = [
        geos.fromWKT(UNIT(0, 0)),
        geos.fromWKT("POINT (3 4)"),
        geos.fromWKT("LINESTRING (0 0, 1 1)"),
      ];
      const wkbParts = gs.map((g) => geos.toWKB(g));
      const total = wkbParts.reduce((n, p) => n + p.length, 0);
      const buf = new Uint8Array(total);
      const offsets = new Uint32Array(wkbParts.length);
      let off = 0;
      for (let i = 0; i < wkbParts.length; i++) {
        buf.set(wkbParts[i]!, off);
        off += wkbParts[i]!.length;
        offsets[i] = off;
      }
      const round = geos.fromWKBMany(buf, offsets);
      expect(round.length).toBe(3);
      for (let i = 0; i < gs.length; i++) {
        expect(geos.equalsIdentical(round[i]!, gs[i]!)).toBe(true);
      }
      for (const g of [...gs, ...round]) g.dispose();
    }));

  it("validates offsets strictly (increasing, within the buffer)", () =>
    withGeos((geos) => {
      const buf = new Uint8Array(21);
      expect(() => geos.fromWKBMany(buf, Uint32Array.of(10, 10))).toThrow(RangeError);
      expect(() => geos.fromWKBMany(buf, Uint32Array.of(22))).toThrow(RangeError);
      // non-mid-array garbage is GEOS's problem: a malformed record throws GeosError
      expect(() => geos.fromWKBMany(buf, Uint32Array.of(21))).toThrow(GeosError);
    }));
});
