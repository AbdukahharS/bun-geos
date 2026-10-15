/**
 * Phase 0 spike, check #2: the core bet.
 * flat Float64Array → CoordSeq_copyFromBuffer → polygon → GEOSIntersection_r
 * → copyToBuffer → correct numbers, zero crashes.
 */
import { expect, test } from "bun:test";
import type { Pointer } from "bun:ffi";
import {
  area,
  exteriorRingXY,
  lib,
  mulberry32,
  polygonFromXY,
  withContext,
  type Ctx,
} from "./lib.ts";

/** Destroy a list of owned geometry pointers. */
function destroyAll(ctx: Ctx, geoms: Pointer[]) {
  for (const g of geoms) lib.symbols.GEOSGeom_destroy_r(ctx, g);
}

test("GEOS version is 3.14.x (D5 assert)", () => {
  const version = lib.symbols.GEOSversion();
  expect(version).toMatch(/^3\.14\./);
});

test("buffer roundtrip identity: flat buffer → polygon → flat buffer", () => {
  withContext((ctx) => {
    const xy = new Float64Array([0, 0, 4, 0, 0, 4, 0, 0]); // closed triangle
    const poly = polygonFromXY(ctx, xy);
    try {
      const out = exteriorRingXY(ctx, poly);
      expect(out).toEqual(xy);
    } finally {
      destroyAll(ctx, [poly]);
    }
  });
});

test("overlay known answer: A ∩ B = (1,1),(3,1),(1,3), area 2.0", () => {
  withContext((ctx) => {
    const a = polygonFromXY(ctx, new Float64Array([0, 0, 4, 0, 0, 4, 0, 0]));
    const b = polygonFromXY(ctx, new Float64Array([1, 1, 5, 1, 1, 5, 1, 1]));
    try {
      const inter = lib.symbols.GEOSIntersection_r(ctx, a, b) as Pointer;
      expect(inter).not.toBeNull();
      try {
        // exact-area check (integer coordinates → shoelace is exact in f64)
        expect(area(ctx, inter)).toBe(2.0);
        // coordinate check (orientation may vary → compare as a set)
        const ring = exteriorRingXY(ctx, inter);
        const pts = new Set<string>();
        for (let i = 0; i < ring.length; i += 2) {
          pts.add(`${ring[i]},${ring[i + 1]}`);
        }
        expect(pts.has("1,1")).toBe(true);
        expect(pts.has("3,1")).toBe(true);
        expect(pts.has("1,3")).toBe(true);
      } finally {
        destroyAll(ctx, [inter]);
      }
    } finally {
      destroyAll(ctx, [a, b]);
    }
  });
});

test(
  "randomized triangles: intersection area ≤ min(inputs), no crashes (n=500)",
  () => {
    withContext((ctx) => {
      const rand = mulberry32(0x5eed);
      const tri = (): Float64Array => {
        // random CCW triangle in [-10,10]², closed ring
        const p = [0, 1, 2].map(() => [rand() * 20 - 10, rand() * 20 - 10]);
        p.sort(([, ya], [, yb]) => ya! - yb!); // crude CCW-ish ordering
        const flat = new Float64Array(8);
        for (let i = 0; i < 3; i++) {
          flat[i * 2] = p[i]![0]!;
          flat[i * 2 + 1] = p[i]![1]!;
        }
        flat[6] = flat[0]!;
        flat[7] = flat[1]!;
        return flat;
      };

      for (let i = 0; i < 500; i++) {
        const bufA = tri();
        const bufB = tri();
        const a = polygonFromXY(ctx, bufA);
        const b = polygonFromXY(ctx, bufB);
        try {
          const areaA = area(ctx, a);
          const areaB = area(ctx, b);
          const inter = lib.symbols.GEOSIntersection_r(ctx, a, b) as Pointer;
          try {
            const areaI = area(ctx, inter);
            if (!Number.isNaN(areaI)) {
              // intersection ⊆ both inputs; empty results report area 0
              expect(areaI).toBeLessThanOrEqual(Math.min(areaA, areaB) + 1e-9);
            }
          } finally {
            destroyAll(ctx, [inter]);
          }
        } finally {
          destroyAll(ctx, [a, b]);
        }
      }
    });
  },
);
