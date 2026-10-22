/**
 * flatbush adapter — the static packed HBST (fastest JS index for
 * immutable data: bulk add + build, then query). Index angle only.
 */

import { type ScenarioOutput, timeMs } from "../../lib/metrics.ts";
import type { Adapter, StrtreeInputs } from "../../lib/scenarios.ts";
import { installedVersion } from "./pkg-version.ts";

interface FlatbushLike {
  add(minX: number, minY: number, maxX: number, maxY: number): void;
  /** flatbush v4 names the build step `finish()`. */
  finish(): void;
  search(minX: number, minY: number, maxX: number, maxY: number): Uint32Array | number[];
  readonly numItems: number;
}

interface FlatbushCtor {
  new (numItems: number): FlatbushLike;
}

async function loadFlatbush(): Promise<FlatbushCtor> {
  const spec = ["flatbush"].join(""); // non-literal: optional devDependency
  const mod = (await import(spec)) as { default: FlatbushCtor };
  return mod.default;
}

export default {
  engine: "flatbush",
  boundary: "pure-js",
  reportNote: "static packed index (index angle only, immutable data)",

  async probe() {
    cached = await loadFlatbush();
    return installedVersion("flatbush");
  },

  strtree({ boxes, queries }: StrtreeInputs): ScenarioOutput {
    const Flatbush = get();
    let hits = 0;
    const buildMs = timeMs(() => {
      const index = new Flatbush(boxes.length);
      for (const b of boxes) index.add(b.minX, b.minY, b.maxX, b.maxY);
      index.finish();
      hits = index.search(
        queries[0]!.minX,
        queries[0]!.minY,
        queries[0]!.maxX,
        queries[0]!.maxY,
      ).length;
      sink(hits, 0);
    }, 3);

    const index = new Flatbush(boxes.length);
    for (const b of boxes) index.add(b.minX, b.minY, b.maxX, b.maxY);
    index.finish();
    const queryMs = timeMs(() => {
      hits = 0;
      for (const q of queries) {
        hits += index.search(q.minX, q.minY, q.maxX, q.maxY).length;
      }
      sink(hits, 0);
    }, 5);

    return {
      variants: { build: buildMs, query: queryMs },
      repeats: 5,
      fingerprint: { areaSum: null, hits },
    };
  },
} satisfies Adapter;

let cached: FlatbushCtor | null = null;

function get(): FlatbushCtor {
  if (cached === null) throw new Error("flatbush: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
