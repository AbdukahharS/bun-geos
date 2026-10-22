/**
 * Shared WKT→coordinate-array extraction for the pure-JS engines that
 * consume plain ring arrays (turf, polygon-clipping). Parse happens
 * OUTSIDE every timed region — the timed work is the geometry op itself.
 */

import type { Ring } from "../../lib/gen.ts";

/** Extract the first (exterior) ring of a POLYGON WKT string as [x, y] pairs. */
export function parseRingCoords(wkt: string): number[][][] {
  const inner = wkt.slice(wkt.indexOf("((") + 2, wkt.lastIndexOf("))"));
  const ring: Ring = inner.split(",").map((pair) => {
    const [x, y] = pair.trim().split(/\s+/).map(Number);
    return [x!, y!] as [number, number];
  });
  return [ring.map(([x, y]) => [x, y]) as number[][]];
}
