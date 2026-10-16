/**
 * Shared test helpers: one context per suite, seeded PRNG (mulberry32,
 * spike-proven) so property tests are always reproducible.
 */
import { type Geometry, Geos } from "../src/index.ts";

export function withGeos<T>(fn: (geos: Geos) => T): T {
  using geos = new Geos();
  return fn(geos);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random closed triangle with coordinates rounded to 1/64. */
export function randomTriangle(rnd: () => number): number[][] {
  const q = (v: number) => Math.round(v * 64) / 64;
  const p1: number[] = [q(rnd() * 100), q(rnd() * 100)];
  const p2: number[] = [q(p1[0]! + rnd() * 50 + 1), q(p1[1]! + rnd() * 50 + 1)];
  const p3: number[] = [q(p1[0]! - rnd() * 50 - 1), q(p1[1]! + rnd() * 50 + 1)];
  return [p1, p2, p3, p1];
}

export function triangleGeom(geos: Geos, pts: number[][]): Geometry {
  return geos.fromGeoJSON({ type: "Polygon", coordinates: [pts] });
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
