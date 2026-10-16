/**
 * Interrupt (Phase 2, D19): pre-check, cross-thread flag flip, GEOS
 * InterruptedException recognition, flag hygiene, and the honest
 * same-thread limitation (the signal listener cannot fire mid-block).
 *
 * The heavy op here takes ~150-400ms; the worker flips the flag at 40ms,
 * leaving a wide margin for slow CI machines.
 */
import { describe, expect, it } from "bun:test";
import { Geos, GeosError } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

function bigWobblePolygon(): string {
  const pts: string[] = [];
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 1000 * (1 + 0.01 * Math.sin(a * 977));
    pts.push(`${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)}`);
  }
  return `POLYGON ((${pts.join(",")}, ${pts[0]!}))`;
}

describe("interrupt", () => {
  it("an already-aborted signal throws before any C call (op: aborted, cause = reason)", () =>
    withGeos((geos) => {
      const ac = new AbortController();
      const reason = new Error("user changed their mind");
      ac.abort(reason);
      try {
        geos.intersection(geos.point(0, 0), geos.point(1, 1), { signal: ac.signal });
        throw new Error("should not reach");
      } catch (e) {
        expect(e).toBeInstanceOf(GeosError);
        expect((e as GeosError).op).toBe("aborted");
        expect((e as Error).cause).toBe(reason);
      }
    }));

  it("raw flag set before an op aborts it instantly; manual reset restores health", () =>
    withGeos((geos) => {
      const wkt = bigWobblePolygon();
      using big = geos.fromWKT(wkt);
      geos.interruptRequest();
      const t0 = performance.now();
      expect(() => geos.buffer(big, 25, { quadSegs: 32 })).toThrow(GeosError);
      expect(performance.now() - t0).toBeLessThan(50); // far below the full ~300ms
      geos.interruptReset();
      using after = geos.buffer(big, 0.001, { quadSegs: 1 });
      expect(geos.isValid(after)).toBe(true);
    }));

  it("a signal that never aborts does not perturb results", () =>
    withGeos((geos) => {
      const ac = new AbortController();
      using a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      using b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))");
      using u = geos.union(a, b, { signal: ac.signal });
      expect(geos.area(u)).toBeCloseTo(7, 9);
    }));

  it("cross-thread flip (worker) aborts the op mid-flight and reports the aborted shape", async () => {
    using geos = new Geos();
    using big = geos.fromWKT(bigWobblePolygon());
    const worker = new Worker(new URL("../helpers/interrupt-worker.ts", import.meta.url).href);
    await new Promise<void>((resolve) => {
      worker.onmessage = () => resolve();
    });
    const ac = new AbortController();
    worker.postMessage({ abortAfterMs: 40 });
    try {
      using _out = geos.buffer(big, 25, { signal: ac.signal, quadSegs: 32 });
      throw new Error("op should have been interrupted");
    } catch (e) {
      expect(e).toBeInstanceOf(GeosError);
      const err = e as GeosError;
      expect(err.op).toBe("aborted");
      expect(err.message).toContain("aborted");
    } finally {
      await worker.terminate();
    }
    // withSignal reset the flag in its finally — the context stays healthy
    using after = geos.buffer(big, 0.001, { quadSegs: 1 });
    expect(geos.isValid(after)).toBe(true);
  }, 30_000);

  it("no signal + external flip surfaces the raw InterruptedException (not swallowed)", () =>
    withGeos((geos) => {
      const wkt = bigWobblePolygon();
      using big = geos.fromWKT(wkt);
      geos.interruptRequest();
      try {
        geos.buffer(big, 25, { quadSegs: 32 });
        throw new Error("should not reach");
      } catch (e) {
        expect((e as GeosError).geosMessage).toContain("Interrupted!");
      }
      geos.interruptReset();
    }));
});
