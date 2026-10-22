/**
 * JSTS adapter — the most complete pure-JS geometry engine (a JTS port:
 * robust overlay, unary union, STRtree, WKT codec, buffer). The strongest
 * "JS-native library doing the same work" — and therefore the honest
 * pure-JS ceiling for every scenario it covers.
 *
 * Runtime-probed: the jsts 2.12 npm bundle omits prepared geometry and the
 * WKB codecs entirely (io is WKT/GeoJSON only), so prepared-scan skips and
 * ingest measures WKT parse; each scenario probes its entry points and
 * skips with a recorded reason when absent (no MakeValid — JSTS predates
 * JTS 1.20).
 */

import type { ScenarioOutput } from "../../lib/metrics.ts";
import { timeMs } from "../../lib/metrics.ts";
import {
  type Adapter,
  type BufferInputs,
  FIXED,
  type IngestInputs,
  type OverlayInputs,
  type PreparedInputs,
  type StrtreeInputs,
  type UnionInputs,
} from "../../lib/scenarios.ts";

interface JstsGeom {
  intersection(other: JstsGeom): JstsGeom;
  union(other?: JstsGeom): JstsGeom;
  intersects(other: JstsGeom): boolean;
  buffer(distance: number, quadSegs?: number): JstsGeom;
  getArea(): number;
  isEmpty(): boolean;
  getNumGeometries(): number;
}

interface JstsEnvelope {
  getMinX(): number;
  getMinY(): number;
  getMaxX(): number;
  getMaxY(): number;
}

interface JstsModule {
  version?: string;
  io: {
    WKTReader: new () => { read(wkt: string): JstsGeom };
    WKTWriter?: new () => { write(geom: JstsGeom): string };
  };
  geom: {
    Envelope: new (minX?: number, maxX?: number, minY?: number, maxY?: number) => JstsEnvelope;
    prepared?: {
      PreparedGeometryFactory: new () => {
        prepare(geom: JstsGeom): { intersects(geom: JstsGeom): boolean };
      };
    };
  };
  index: {
    strtree: {
      STRtree: new () => {
        insert(env: JstsEnvelope, item: unknown): void;
        /** jsts returns an ArrayList-like (size()/toArray()), not Array. */
        query(env: JstsEnvelope): { size(): number; toArray(): unknown[] };
        build?(): void;
      };
    };
  };
}

async function loadJsts(): Promise<JstsModule> {
  // jsts ships no package entry point ("main"/"exports" absent) — try the
  // bare specifier first, then the dist bundle. Non-literal specifiers:
  // optional devDependencies must not fail static resolution when absent.
  const bare = ["jsts"].join("");
  const dist = [bare, "dist", ["jsts.min.js"].join("")].join("/");
  for (const spec of [bare, dist]) {
    try {
      const mod = (await import(spec)) as unknown as JstsModule;
      if (mod.io?.WKTReader !== undefined) return mod;
    } catch {
      // try next specifier
    }
  }
  throw new Error("no resolvable entry (tried the bare specifier and the dist bundle)");
}

/* jsts probe note: the npm bundle exposes no WKBReader/WKBWriter (io has
 * WKTReader/WKTWriter/GeoJSONReader/GeoJSONWriter only), so the ingest
 * scenario measures WKT parse for this engine. */

/** "POLYGON ((…))" → "((…))" — full member body for MULTIPOLYGON assembly. */
function stripPolygon(wkt: string): string {
  return wkt.slice(wkt.indexOf("(("), wkt.lastIndexOf("))") + 2);
}

export default {
  engine: "jsts",
  boundary: "pure-js",
  reportNote: "JTS port in pure JS — the strongest JS-native engine",

  async probe() {
    const jsts = await loadJsts();
    cached = jsts;
    return jsts.version ?? "jsts";
  },

  overlay({ size, clipWkt, squareWkts }: OverlayInputs): ScenarioOutput {
    const jsts = get();
    const repeats = size >= 100_000 ? 1 : 3;
    const reader = new jsts.io.WKTReader();
    const clip = reader.read(clipWkt);
    const squares = squareWkts.map((s) => reader.read(s));

    const ms = timeMs(() => {
      let count = 0;
      let areaSum = 0;
      for (const s of squares) {
        const out = clip.intersection(s);
        if (!out.isEmpty()) {
          count++;
          areaSum += out.getArea();
        }
      }
      sink(count, areaSum);
    }, repeats);

    let count = 0;
    let areaSum = 0;
    for (const s of squares) {
      const out = clip.intersection(s);
      if (!out.isEmpty()) {
        count++;
        areaSum += out.getArea();
      }
    }
    return { variants: { singular: ms }, repeats, fingerprint: { count, areaSum } };
  },

  union({ tileWkts }: UnionInputs): ScenarioOutput | null {
    const jsts = get();
    // jsts 2.12 ships neither CascadedPolygonUnion nor a working
    // UnaryUnionOp static; Geometry.union() on a MultiPolygon IS the
    // unary-union path (JTS UnionOp under the hood).
    const reader = new jsts.io.WKTReader();
    const collection = reader.read(`MULTIPOLYGON (${tileWkts.map(stripPolygon).join(",")})`);

    let areaSum = 0;
    let count = 0;
    const ms = timeMs(() => {
      const out = collection.union();
      areaSum = out.getArea();
      count = out.getNumGeometries();
      sink(count, Math.round(areaSum));
    }, 3);
    return {
      variants: { unary: ms },
      repeats: 3,
      fingerprint: { count, areaSum },
      note: "Geometry.union() on a prebuilt MULTIPOLYGON (no coverage strategy in JSTS)",
    };
  },

  "prepared-scan"({ size, polyWkt, pointWkts }: PreparedInputs): ScenarioOutput | null {
    const jsts = get();
    const preparedFactory = jsts.geom.prepared?.PreparedGeometryFactory;
    if (preparedFactory === undefined) return null;
    const repeats = size >= 100_000 ? 1 : 3;
    const reader = new jsts.io.WKTReader();
    const poly = reader.read(polyWkt);
    const points = pointWkts.map((p) => reader.read(p));

    const unpreparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (poly.intersects(p)) hits++;
      sink(hits, 0);
    }, repeats);

    // Prepare ONCE outside the timed region — symmetric with the other
    // engines (PreparedGeometry supports one-shot preparation).
    const factory = new preparedFactory();
    const prep = factory.prepare(poly);
    const preparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (prep.intersects(p)) hits++;
      sink(hits, 0);
    }, repeats);

    let hits = 0;
    for (const p of points) if (prep.intersects(p)) hits++;
    return {
      variants: { unprepared: unpreparedMs, prepared: preparedMs },
      repeats,
      fingerprint: { areaSum: null, hits },
    };
  },

  strtree({ boxes, queries }: StrtreeInputs): ScenarioOutput | null {
    const jsts = get();
    let hits = 0;
    const envOf = (b: { minX: number; minY: number; maxX: number; maxY: number }): JstsEnvelope =>
      new jsts.geom.Envelope(b.minX, b.maxX, b.minY, b.maxY);
    const buildMs = timeMs(() => {
      const tree = new jsts.index.strtree.STRtree();
      for (const b of boxes) {
        tree.insert(envOf(b), b);
      }
      tree.build?.();
      hits = tree.query(envOf({ minX: 0, minY: 0, maxX: 90, maxY: 90 })).size(); // force + sanity
      sink(hits, 0);
    }, 3);

    // Rebuild untimed for the query ladder (the tree is build-once).
    const tree = new jsts.index.strtree.STRtree();
    for (const b of boxes) {
      tree.insert(envOf(b), b);
    }
    tree.build?.();
    const queryMs = timeMs(() => {
      hits = 0;
      for (const q of queries) {
        hits += tree.query(envOf(q)).size();
      }
      sink(hits, 0);
    }, 5);

    return {
      variants: { build: buildMs, query: queryMs },
      repeats: 5,
      fingerprint: { areaSum: null, hits },
    };
  },

  ingest({ squareWkts }: IngestInputs): ScenarioOutput | null {
    const jsts = get();
    const repeats = 2;
    const wktReader = new jsts.io.WKTReader();

    const wktMs = timeMs(() => {
      let n = 0;
      for (const w of squareWkts) {
        wktReader.read(w);
        n++;
      }
      sink(n, 0);
    }, repeats);

    let count = 0;
    for (const w of squareWkts) {
      wktReader.read(w);
      count++;
    }
    return {
      variants: { wkt: wktMs },
      repeats,
      fingerprint: { count, areaSum: null },
      note: "the jsts npm bundle ships no WKB codecs — WKT ingest only",
    };
  },

  buffer({ wobbleWkts }: BufferInputs): ScenarioOutput {
    const jsts = get();
    const reader = new jsts.io.WKTReader();
    const inputs = wobbleWkts.map((w) => reader.read(w));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const g of inputs) {
        const b = g.buffer(FIXED.bufferDistance, FIXED.bufferQuadSegs);
        count++;
        areaSum += b.getArea();
      }
      sink(count, areaSum);
    }, 3);
    return { variants: { buffer: ms }, repeats: 3, fingerprint: { count, areaSum } };
  },
} satisfies Adapter;

let cached: JstsModule | null = null;

function get(): JstsModule {
  if (cached === null) throw new Error("jsts: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
