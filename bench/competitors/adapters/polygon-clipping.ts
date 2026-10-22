/**
 * polygon-clipping adapter — the maintained Martinez-family pure-JS
 * overlay engine (intersection/union/xor/difference on coordinate arrays).
 * Overlay only: it has no predicates, index, I/O codecs, buffer, or repair.
 */

import { mpStats, type ScenarioOutput, timeMs } from "../../lib/metrics.ts";
import type { Adapter, OverlayInputs } from "../../lib/scenarios.ts";
import { parseRingCoords } from "./coords.ts";
import { installedVersion } from "./pkg-version.ts";

interface PolygonClipping {
  intersection(a: number[][][], b: number[][][]): number[][][][];
  union(a: number[][][], b: number[][][]): number[][][][];
}

async function loadPc(): Promise<PolygonClipping> {
  const spec = ["polygon-clipping"].join(""); // non-literal: optional devDependency
  const mod = (await import(spec)) as { default?: PolygonClipping } & PolygonClipping;
  return mod.default ?? mod;
}

export default {
  engine: "polygon-clipping",
  boundary: "pure-js",
  reportNote: "Martinez-family clipping — overlay ops only",

  async probe() {
    cached = await loadPc();
    return installedVersion("polygon-clipping");
  },

  overlay({ size, clipWkt, squareWkts }: OverlayInputs): ScenarioOutput {
    const pc = get();
    const repeats = size >= 100_000 ? 1 : 3;
    const a = parseRingCoords(clipWkt);
    const bs = squareWkts.map((w) => parseRingCoords(w));

    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const b of bs) {
        const out = pc.intersection(a, b);
        if (out.length > 0) {
          count++;
          areaSum += mpStats(out).areaSum;
        }
      }
      sink(count, Math.round(areaSum));
    }, repeats);

    // Reference fingerprint pass (same work as the timed loop, numbers captured).
    count = 0;
    areaSum = 0;
    for (const b of bs) {
      const out = pc.intersection(a, b);
      if (out.length > 0) {
        count++;
        areaSum += mpStats(out).areaSum;
      }
    }
    return { variants: { singular: ms }, repeats, fingerprint: { count, areaSum } };
  },
} satisfies Adapter;

let cached: PolygonClipping | null = null;

function get(): PolygonClipping {
  if (cached === null) throw new Error("polygon-clipping: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
