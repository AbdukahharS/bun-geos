/**
 * Phase 0 spike, check #5: the soak.
 * 10⁵ geometry create/destroy cycles with interleaved overlay roundtrips
 * (pure-FFI context) and periodic error-path hits (shim context). No crashes,
 * no runaway growth. RSS deltas per epoch expose a leak signature (steady
 * linear growth) vs warmup (early growth that flattens).
 */

import type { Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { area, exteriorRingXY, lib, polygonFromXY, withContext } from "./lib.ts";
import { destroy, GeosError, readWKT, withShim } from "./shim.ts";

const N = 100_000;
const EPOCH = 10_000;
const THRESHOLD_MB = 150; // generous: flags real leaks, ignores malloc noise

test(`soak: ${N}× build/destroy + overlays, RSS bounded (pure FFI)`, () => {
  withContext((ctx) => {
    const rss: number[] = [process.memoryUsage().rss];
    const t0 = performance.now();
    const rand = (() => {
      let a = 0x50a4;
      return () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        return a / 0x7fffffff;
      };
    })();

    for (let i = 1; i <= N; i++) {
      // build two triangles, overlay, copy result back, destroy everything
      const x = rand() * 8;
      const a = polygonFromXY(ctx, new Float64Array([x, x, x + 4, x, x, x + 4, x, x]));
      const b = polygonFromXY(
        ctx,
        new Float64Array([x + 1, x + 1, x + 5, x + 1, x + 1, x + 5, x + 1, x + 1]),
      );
      const inter = lib.symbols.GEOSIntersection_r(ctx, a, b) as Pointer;
      const ring = exteriorRingXY(ctx, inter);
      expect(ring.length).toBe(8); // closed triangle: 4 points
      expect(area(ctx, inter)).toBeCloseTo(2.0, 6);
      lib.symbols.GEOSGeom_destroy_r(ctx, inter);
      lib.symbols.GEOSGeom_destroy_r(ctx, a);
      lib.symbols.GEOSGeom_destroy_r(ctx, b);

      if (i % EPOCH === 0) {
        rss.push(process.memoryUsage().rss);
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(2);
    const deltas = rss.slice(1).map((r, i) => (r - rss[i]!) / 1048576);
    const growth = (rss[rss.length - 1]! - rss[0]!) / 1048576;
    console.log(
      `soak: ${N} ops in ${secs}s, RSS deltas/epoch (MB): ` +
        deltas.map((d) => d.toFixed(1)).join(", ") +
        ` → total ${growth.toFixed(1)} MB`,
    );
    // leak signature = steady growth across ALL epochs; warmup flattens.
    const firstHalf = deltas.slice(0, deltas.length / 2).reduce((s, d) => s + d, 0);
    const secondHalf = deltas.slice(deltas.length / 2).reduce((s, d) => s + d, 0);
    expect(growth).toBeLessThan(THRESHOLD_MB);
    // later epochs must not keep growing like the early ones
    expect(secondHalf).toBeLessThan(firstHalf + 20);
  });
});

test(`soak: error path survives churn (1k failures through the shim)`, () => {
  withShim((h) => {
    let thrown = 0;
    for (let i = 0; i < 1_000; i++) {
      try {
        readWKT(h, `POLYGON((0 0, ${i} 0`); // truncated → parse error every time
      } catch (e) {
        expect(e).toBeInstanceOf(GeosError);
        thrown++;
      }
    }
    expect(thrown).toBe(1_000);
    // and a valid op still works after 1k failures
    const g = readWKT(h, "POINT(3 4)");
    destroy(h, g);
  });
});
