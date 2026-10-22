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
    // Inlined `requireSame` + `assertAlive` (identical checks and messages):
    // this loop runs once per element of every batch call — 10⁵-element
    // masks pay a measurable tax for the method-call indirection.
    if (g.geos !== geos) {
      throw new TypeError(
        "bun-geos: geometry belongs to a different Geos context — " +
          "geometries never cross contexts or threads (D3/D11); transfer via toWKB()/toGeoJSON()/toArrow()",
      );
    }
    g.assertAlive();
    arr[i] = g.bigint; // cached per wrapper (Phase 3) — no BigInt() per call
  }
  return arr;
}

/** Convert one bigint read back from a C out-param into a branded pointer. */
export function ptrOf(v: bigint): number {
  return Number(v);
}
