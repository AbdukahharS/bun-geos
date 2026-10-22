/**
 * rbush adapter — the de-facto JS dynamic R-tree (used across the mapping
 * ecosystem). Measures the STRtree angle only: bulk build + envelope query,
 * against the same boxes/queries every other engine gets.
 */

import type { Box } from "../../lib/gen.ts";
import { boxIntersects, type ScenarioOutput, timeMs } from "../../lib/metrics.ts";
import type { Adapter, StrtreeInputs } from "../../lib/scenarios.ts";
import { installedVersion } from "./pkg-version.ts";

interface RBushItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface RBush {
  load(items: RBushItem[]): void;
  search(bbox: RBushItem): RBushItem[];
  clear(): void;
}

interface RBushCtor {
  new (): RBush;
}

async function loadRBush(): Promise<RBushCtor> {
  const spec = ["rbush"].join(""); // non-literal: optional devDependency
  const mod = (await import(spec)) as { default: RBushCtor };
  return mod.default;
}

/** The exact-answer reference: brute-force envelope intersection counts per query. */
export function bruteForceHits(boxes: Box[], queries: Box[]): number {
  let hits = 0;
  for (const q of queries) for (const b of boxes) if (boxIntersects(b, q)) hits++;
  return hits;
}

export default {
  engine: "rbush",
  boundary: "pure-js",
  reportNote: "dynamic R-tree specialist (index angle only)",

  async probe() {
    cached = await loadRBush();
    return installedVersion("rbush");
  },

  strtree({ boxes, queries }: StrtreeInputs): ScenarioOutput {
    const RBush = get();
    let hits = 0;
    const buildMs = timeMs(() => {
      const tree = new RBush();
      tree.load(boxes);
      hits = tree.search(queries[0]!).length;
      sink(hits, 0);
    }, 3);

    const tree = new RBush();
    tree.load(boxes);
    const queryMs = timeMs(() => {
      hits = 0;
      for (const q of queries) hits += tree.search(q).length;
      sink(hits, 0);
    }, 5);

    return {
      variants: { build: buildMs, query: queryMs },
      repeats: 5,
      fingerprint: { areaSum: null, hits },
    };
  },
} satisfies Adapter;

let cached: RBushCtor | null = null;

function get(): RBushCtor {
  if (cached === null) throw new Error("rbush: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
