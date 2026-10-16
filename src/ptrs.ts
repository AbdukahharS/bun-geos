/**
 * @internal — JS-side `GEOSGeometry*[]` as a `BigUint64Array`, the array
 * shape every Phase 2 shim batch function takes. One crossing per array;
 * the per-element `requireSame` check keeps the foreign-context rule (D3)
 * before any pointer leaves JS.
 */
import type { Geometry } from "./geometry.ts";
import type { Geos } from "./geos.ts";

export function geomPtrArray(geos: Geos, gs: readonly Geometry[], op: string): BigUint64Array {
  const arr = new BigUint64Array(gs.length);
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    if (g === undefined) throw new RangeError(`${op}: input[${i}] is undefined`);
    g.requireSame(geos);
    arr[i] = BigInt(g.ptr);
  }
  return arr;
}

/** Convert one bigint read back from a C out-param into a branded pointer. */
export function ptrOf(v: bigint): number {
  return Number(v);
}
