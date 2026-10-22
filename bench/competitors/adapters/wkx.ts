/**
 * wkx adapter — the standard pure-JS WKB/WKT codec. Measures the ingest
 * angle only: parse + serialize against the canonical workload bytes.
 */

import { type ScenarioOutput, timeMs } from "../../lib/metrics.ts";
import type { Adapter, IngestInputs } from "../../lib/scenarios.ts";
import { installedVersion } from "./pkg-version.ts";

interface WkbGeometry {
  toWkt(): string;
  toWkb(): Buffer;
}

interface Wkx {
  Geometry: {
    parse(value: Buffer | string): WkbGeometry;
  };
}

async function loadWkx(): Promise<Wkx> {
  const spec = ["wkx"].join(""); // non-literal: optional devDependency
  const mod = (await import(spec)) as { default?: Wkx } & Wkx;
  return mod.default ?? mod;
}

/** Slice the canonical WKB buffer per cumulative end-offsets. */
export function slices(wkb: Uint8Array, offs: Uint32Array): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < offs.length; i++) {
    const start = i === 0 ? 0 : offs[i - 1]!;
    out.push(Buffer.from(wkb.subarray(start, offs[i]!)));
  }
  return out;
}

export default {
  engine: "wkx",
  boundary: "pure-js",
  reportNote: "pure-JS WKB/WKT codec (ingest angle only)",

  async probe() {
    cached = await loadWkx();
    return installedVersion("wkx");
  },

  ingest({ squareWkts, wkb, offs }: IngestInputs): ScenarioOutput {
    const wkx = get();
    const repeats = 2;
    const buffers = slices(wkb, offs);

    const wktMs = timeMs(() => {
      let n = 0;
      for (const w of squareWkts) {
        wkx.Geometry.parse(w);
        n++;
      }
      sink(n, 0);
    }, repeats);

    const wkbMs = timeMs(() => {
      let n = 0;
      for (const buf of buffers) {
        wkx.Geometry.parse(buf);
        n++;
      }
      sink(n, 0);
    }, repeats);

    const wktWriteMs = timeMs(() => {
      let n = 0;
      for (const buf of buffers) {
        wkx.Geometry.parse(buf).toWkt();
        n++;
      }
      sink(n, 0);
    }, repeats);

    const wkbWriteMs = timeMs(() => {
      let n = 0;
      for (const buf of buffers) {
        wkx.Geometry.parse(buf).toWkb();
        n++;
      }
      sink(n, 0);
    }, repeats);

    return {
      variants: { wkt: wktMs, wkb: wkbMs, "wkt-write": wktWriteMs, "wkb-write": wkbWriteMs },
      repeats,
      fingerprint: { count: buffers.length, areaSum: null },
    };
  },
} satisfies Adapter;

let cached: Wkx | null = null;

function get(): Wkx {
  if (cached === null) throw new Error("wkx: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
