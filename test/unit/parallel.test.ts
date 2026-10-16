/**
 * geos.parallel (Phase 3, D23): worker-pool batch ops — correctness vs the
 * main-thread batch layer, ordered reassembly, small-batch local path,
 * chunk-failure aggregation, mid-flight abort (the D19 partition: the main
 * thread flips the flag while workers run), and lifecycle rules.
 */
import { describe, expect, it } from "bun:test";
import { Geos, GeosError, GeosParallelError } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

const SQ = "POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))";

/** n small squares (some inside SQ, some outside) — the standard workload. */
function squares(geos: Geos, n: number): import("../../src/index.ts").Geometry[] {
  const gs: import("../../src/index.ts").Geometry[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 20) * 2 - 5;
    const y = Math.floor(i / 20) * 2 - 5;
    gs.push(
      geos.fromWKT(
        `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`,
      ),
    );
  }
  return gs;
}

describe("parallel pool basics", () => {
  it("spawns lazily and stays within the desired size", async () =>
    withPool(async (geos, pool) => {
      expect(pool.size).toBe(0); // nothing spawned yet
      const gs = squares(geos, 300);
      await geos.areaAll(gs);
      await pool.areaAll(gs);
      expect(pool.size).toBeGreaterThan(0);
      expect(pool.size).toBeLessThanOrEqual(8);
      for (const g of gs) g.dispose();
    }));

  it("small batches run on the calling thread (no workers)", async () =>
    withPool(async (geos, pool) => {
      const gs = squares(geos, 50); // below minChunkGeoms × 2
      const areas = await pool.areaAll(gs);
      expect(areas.length).toBe(50);
      expect(pool.size).toBe(0);
      for (const g of gs) g.dispose();
    }));
});

describe("parallel correctness vs the main-thread batch layer", () => {
  it("overlays: parallel intersectionAll equals element-wise singulars, in order", async () =>
    withPool(async (geos, pool) => {
      using a = geos.fromWKT(SQ);
      const bs = squares(geos, 400);
      const outs = await pool.intersectionAll(a, bs);
      expect(outs.length).toBe(400);
      for (let i = 0; i < bs.length; i++) {
        using singular = geos.intersection(a, bs[i]!);
        expect(geos.equalsIdentical(outs[i]!, singular)).toBe(true);
      }
      for (const g of [...outs, ...bs]) g.dispose();
    }));

  it("differenceAll and symDifferenceAll match the main thread exactly", async () =>
    withPool(async (geos, pool) => {
      using a = geos.fromWKT(SQ);
      const bs = squares(geos, 200);
      const d = await pool.differenceAll(a, bs);
      const s = await pool.symDifferenceAll(a, bs);
      for (let i = 0; i < bs.length; i++) {
        using dS = geos.difference(a, bs[i]!);
        using sS = geos.symDifference(a, bs[i]!);
        expect(geos.equalsIdentical(d[i]!, dS)).toBe(true);
        expect(geos.equalsIdentical(s[i]!, sS)).toBe(true);
      }
      for (const g of [...d, ...s, ...bs]) g.dispose();
    }));

  it("masks and measures reassemble in input order", async () =>
    withPool(async (geos, pool) => {
      using a = geos.fromWKT(SQ);
      const bs = squares(geos, 400);
      const mask = await pool.intersectsAll(a, bs);
      expect(mask.length).toBe(400);
      for (let i = 0; i < bs.length; i++) {
        expect(mask[i]).toBe(geos.intersects(a, bs[i]!) ? 1 : 0);
      }
      const areas = await pool.areaAll(bs);
      for (let i = 0; i < bs.length; i++) expect(areas[i]).toBe(geos.area(bs[i]!));
      using probe = geos.fromWKT("POINT (-10 -10)");
      const dists = await pool.distanceAll(probe, bs);
      for (let i = 0; i < bs.length; i++) {
        expect(dists[i]).toBeCloseTo(geos.distance(probe, bs[i]!), 9);
      }
      for (const g of bs) g.dispose();
    }));

  it("bufferAll and makeValid roundtrip through WKB identically", async () =>
    withPool(async (geos, pool) => {
      const pts = squares(geos, 150).map((g) => {
        return g;
      });
      const bufs = await pool.bufferAll(pts, 0.5, { quadSegs: 4 });
      for (let i = 0; i < pts.length; i++) {
        using singular = geos.buffer(pts[i]!, 0.5, { quadSegs: 4 });
        expect(geos.area(bufs[i]!)).toBeCloseTo(geos.area(singular), 6);
      }
      const bowties = Array.from({ length: 150 }, (_, i) =>
        geos.fromWKT(`POLYGON ((${i} 0, ${i + 2} 2, ${i + 2} 0, ${i} 2, ${i} 0))`),
      );
      const fixed = await pool.makeValid(bowties);
      for (let i = 0; i < bowties.length; i++) {
        expect(geos.isValid(fixed[i]!)).toBe(true);
        using singular = geos.makeValid(bowties[i]!);
        expect(geos.area(fixed[i]!)).toBeCloseTo(geos.area(singular), 9);
      }
      for (const g of [...pts, ...bufs, ...bowties, ...fixed]) g.dispose();
    }));

  it("unionAll: a valid union covering the same area (order-independent check)", async () =>
    withPool(async (geos, pool) => {
      const gs = squares(geos, 300); // non-overlapping → union area = sum
      const parallel = await pool.unionAll(gs);
      const main = geos.unionAll(gs);
      expect(geos.isValid(parallel)).toBe(true);
      expect(geos.area(parallel)).toBeCloseTo(geos.area(main), 6);
      parallel.dispose();
      main.dispose();
      for (const g of gs) g.dispose();
    }));
});

describe("parallel failure aggregation", () => {
  it("chunk failures aggregate into one GeosParallelError (all-or-nothing)", async () =>
    withPool(async (geos, pool) => {
      // overlapping tiles with strategy "coverage" fail the per-chunk
      // coverage validation in every worker — deterministic failure
      const gs = squares(geos, 400);
      const overlapping = gs.map((g, i) => {
        g.dispose();
        const x = i * 0.5,
          y = 0;
        return geos.fromWKT(
          `POLYGON ((${x} ${y}, ${x + 2} ${y}, ${x + 2} ${y + 2}, ${x} ${y + 2}, ${x} ${y}))`,
        );
      });
      let caught: unknown;
      try {
        await pool.unionAll(overlapping, { strategy: "coverage" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GeosParallelError);
      const err = caught as GeosParallelError;
      expect(err.op).toBe("parallel.unionAll");
      expect(err.chunkErrors.length).toBeGreaterThan(0);
      expect(err.chunkErrors[0]!.message).toContain("coverage");
      for (const g of overlapping) g.dispose();
    }));
});

describe("parallel abort (D19 partition — the main thread flips the flag)", () => {
  it(
    "mid-flight abort delivers the uniform aborted shape and resets the flag",
    async () =>
      withPool(async (geos, pool) => {
        // makeValid of ~30k bowties ≈ 1.2s in a single thread (bench: ~24/s);
        // chunks run in parallel — still comfortably > the abort deadline.
        const bowties = Array.from({ length: 30_000 }, (_, i) =>
          geos.fromWKT(`POLYGON ((${i} 0, ${i + 2} 2, ${i + 2} 0, ${i} 2, ${i} 0))`),
        );
        const controller = new AbortController();
        const started = Date.now();
        const pending = pool.makeValid(bowties, { signal: controller.signal, minChunkGeoms: 512 });
        // BUSY-GATE (audited C3): a fixed sleep races the op — abort only
        // once workers are verifiably mid-op, so the test cannot pass
        // vacuously (op finished) or fail when the machine is fast.
        for (let i = 0; i < 200; i++) {
          if (pool.debugState().some((w) => w.busy)) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(pool.debugState().some((w) => w.busy)).toBe(true);
        controller.abort();
        let caught: unknown;
        try {
          await pending;
        } catch (e) {
          caught = e;
        }
        const elapsed = Date.now() - started;
        expect(caught).toBeInstanceOf(GeosError);
        expect((caught as GeosError).op).toBe("aborted");
        expect(elapsed).toBeLessThan(5000);
        for (const g of bowties) g.dispose();
        // the flag was reset in finally: a follow-up op must succeed
        const after = geos.area(geos.fromWKT(SQ));
        expect(after).toBe(100);
      }),
    20_000,
  );

  it("an already-aborted signal fails pre-flight without spawning workers", async () =>
    withPool(async (geos, pool) => {
      const gs = squares(geos, 200);
      const signal = AbortSignal.abort("nope");
      let caught: unknown;
      try {
        await pool.areaAll(gs, { signal });
      } catch (e) {
        caught = e;
      }
      expect((caught as GeosError).op).toBe("aborted");
      expect(pool.size).toBe(0);
      for (const g of gs) g.dispose();
    }));
});

describe("audit regressions (C1/C2, Risk 1)", () => {
  it("Arrow input to a pool geometry op: outputs stay ALIVE after settle (C1)", async () =>
    withPool(async (geos, pool) => {
      using clip = geos.fromWKT("POLYGON ((0 0, 40 0, 40 40, 0 40, 0 0))");
      // pooled path: ≥ minChunkGeoms × 2 items, Arrow-shaped input
      const coords = new Float64Array(512 * 10);
      const ringOffsets = new Int32Array(512);
      const partOffsets = new Int32Array(512);
      for (let i = 0; i < 512; i++) {
        const x = (i % 16) * 2 - 2;
        const y = Math.floor(i / 16) * 2 - 2;
        coords.set([x, y, x + 1, y, x + 1, y + 1, x, y + 1, x, y], i * 10);
        ringOffsets[i] = (i + 1) * 5;
        partOffsets[i] = i + 1;
      }
      const before = geos.stats.liveGeoms;
      const outs = await pool.intersectionAll(clip, {
        coords,
        ringOffsets,
        partOffsets,
        hasZ: false,
        hasM: false,
      });
      expect(outs.length).toBe(512);
      // THE C1 PIN: outputs must be alive — countable AND usable
      expect(geos.stats.liveGeoms).toBe(before + 512);
      let area = 0;
      for (const o of outs) {
        area += geos.area(o); // use-after-free would throw/abort here
        o.dispose();
      }
      expect(area).toBeGreaterThan(0);
    }));

  it("small-batch Arrow input (local path): outputs stay alive too (C1)", async () =>
    withPool(async (geos, pool) => {
      using clip = geos.fromWKT("POLYGON ((0 0, 40 0, 40 40, 0 40, 0 0))");
      const coords = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
      const before = geos.stats.liveGeoms;
      const outs = await pool.intersectionAll(clip, {
        coords,
        ringOffsets: Int32Array.of(5),
        partOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      });
      expect(outs.length).toBe(1);
      expect(geos.stats.liveGeoms).toBe(before + 1);
      expect(geos.area(outs[0]!)).toBe(1);
      outs[0]!.dispose();
    }));

  it("pool ops handle ≥128 POINT geometries (C2: chunk weights)", async () =>
    withPool(async (geos, pool) => {
      const pts = Array.from({ length: 300 }, (_, i) =>
        geos.fromWKT(`POINT (${(i % 20) * 2} ${Math.floor(i / 20) * 2})`),
      );
      const areas = await pool.areaAll(pts);
      expect(areas.length).toBe(300);
      for (const a of areas) expect(a).toBe(0);
      for (const p of pts) p.dispose();
    }));

  it("negative Arrow offsets are rejected in JS, before any FFI crossing (Risk 1)", () =>
    withGeos((geos) => {
      const before = geos.stats.liveGeoms;
      const negativeRing = {
        coords: new Float64Array([0, 0, 1, 1, 2, 2]),
        ringOffsets: Int32Array.of(-5), // wraps to ~4.29e9 as unsigned
        partOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      };
      expect(() => geos.areaAll(negativeRing)).toThrow(GeosError);
      const negativeLine = {
        coords: new Float64Array([0, 0, 1, 1]),
        lineOffsets: Int32Array.of(-3),
        hasZ: false,
        hasM: false,
      };
      expect(() => geos.lengthAll(negativeLine)).toThrow(/increase from 0/);
      expect(geos.stats.liveGeoms).toBe(before);
    }));

  it("small-batch unionAll resolves to a real geometry, not undefined (N2)", async () =>
    withPool(async (geos, pool) => {
      // < minChunkGeoms × 2 items → the local path; its result shape must
      // match unionAll's tail (audited N2: bare Geometry read as undefined,
      // leaking the computed union)
      const gs = squares(geos, 50);
      const u = await pool.unionAll(gs);
      expect(geos.typeId(u)).toBe(6); // MultiPolygon — a real geometry, not undefined
      expect(geos.isValid(u)).toBe(true);
      expect(geos.area(u)).toBeCloseTo(50, 6);
      u.dispose();
      for (const g of gs) g.dispose();
      // the N2 leak would show up here: the orphaned union never got disposed
      expect(geos.stats.liveGeoms).toBe(0);
    }));

  it("chunking options are validated up front (audit Risk 5)", async () =>
    withPool(async (geos, pool) => {
      const gs = squares(geos, 300);
      await expect(pool.areaAll(gs, { minChunkGeoms: 0 })).rejects.toThrow(RangeError);
      await expect(pool.areaAll(gs, { chunkFactor: 0.5 })).rejects.toThrow(RangeError);
      for (const g of gs) g.dispose();
    }));
});

describe("parallel lifecycle", () => {
  it("dispose acks workers before terminating; use-after-dispose throws", async () =>
    withPool(async (geos, pool) => {
      const gs = squares(geos, 300);
      await pool.areaAll(gs);
      expect(pool.size).toBeGreaterThan(0);
      pool.dispose();
      pool.dispose(); // idempotent
      expect(() => pool.areaAll(gs)).toThrow(TypeError);
      for (const g of gs) g.dispose();
    }));

  it("disposing the Geos context shuts the pool down as a consumable", async () => {
    const geos = new Geos();
    const gs = squares(geos, 300);
    await geos.parallel.areaAll(gs);
    expect(geos.parallel.size).toBeGreaterThan(0);
    for (const g of gs) g.dispose();
    geos.dispose(); // consumable teardown must not hang or leak
  });
});

/** One Geos + its pool per test; the context disposal also reaps the pool. */
async function withPool(
  fn: (geos: Geos, pool: import("../../src/index.ts").Geos["parallel"]) => Promise<void>,
) {
  const geos = new Geos();
  try {
    await fn(geos, geos.parallel);
  } finally {
    geos.dispose();
  }
}
