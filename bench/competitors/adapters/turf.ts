/**
 * turf adapter — the web-mapping default (@turf/turf). Pure-JS algorithm
 * ports; overlay historically Martinez-family. Known quirks surface
 * honestly through fingerprints: turf's buffer projects geographically
 * (its answer will NOT match the planar GEOS/JTS answer — the report
 * flags it rather than hiding it), and its union is a pairwise fold
 * (ladder capped to 100 tiles).
 */

import { geojsonPlanarArea, type ScenarioOutput, timeMs } from "../../lib/metrics.ts";
import {
  type Adapter,
  type BufferInputs,
  FIXED,
  type OverlayInputs,
  type PreparedInputs,
  type UnionInputs,
} from "../../lib/scenarios.ts";
import { parseRingCoords } from "./coords.ts";
import { installedVersion } from "./pkg-version.ts";

interface TurfFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
}

interface TurfModule {
  version?: string;
  polygon(ring: number[][][]): TurfFeature;
  point(coords: number[]): TurfFeature;
  featureCollection(features: TurfFeature[]): {
    type: "FeatureCollection";
    features: TurfFeature[];
  };
  intersect(input: unknown): TurfFeature | null;
  union(input: unknown): TurfFeature;
  buffer(geojson: TurfFeature, radius: number, options?: { units?: string }): TurfFeature | null;
  booleanPointInPolygon(point: TurfFeature, polygon: TurfFeature): boolean;
  area(geojson: unknown): number;
}

async function loadTurf(): Promise<TurfModule> {
  const spec = ["@turf", "turf"].join("/"); // non-literal: optional devDependency
  return (await import(spec)) as unknown as TurfModule;
}

/** turf has no version export — read the installed package manifest (best-effort). */
function turfVersion(): string {
  return installedVersion(["@turf", "turf"].join("/"));
}

/**
 * Planar fingerprint area: turf's `area()` is GEODESIC (m² on the sphere),
 * which would ✗ every fingerprint against the planar workload. Cross-engine
 * fingerprints use the same planar shoelace math as every other engine;
 * turf's geodesic buffer answer still shows up honestly as a ✗ (different
 * algorithm, not different fingerprint math).
 */
function planarArea(f: TurfFeature | null): number {
  if (f === null) return 0;
  return geojsonPlanarArea(f.geometry as { type: string; coordinates: unknown });
}

export default {
  engine: "turf",
  boundary: "pure-js",
  reportNote: "web-mapping algorithm ports — GeoJSON-native, planar CRS not enforced",

  async probe() {
    const turf = await loadTurf();
    cached = turf;
    return turfVersion();
  },

  ladderOverride: {
    union: [100], // pairwise fold: quadratic-ish growth caps the ladder
  },

  overlay({ size, clipWkt, squareWkts }: OverlayInputs): ScenarioOutput {
    const turf = get();
    const repeats = size >= 100_000 ? 1 : 3;
    const a = turf.polygon(parseRingCoords(clipWkt));
    const bs = squareWkts.map((w) => turf.polygon(parseRingCoords(w)));

    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const b of bs) {
        const out = turf.intersect(turf.featureCollection([a, b]));
        if (out !== null) {
          count++;
          areaSum += planarArea(out);
        }
      }
      sink(count, Math.round(areaSum));
    }, repeats);

    return { variants: { singular: ms }, repeats, fingerprint: { count, areaSum } };
  },

  union({ tileWkts }: UnionInputs): ScenarioOutput | null {
    const turf = get();
    const polys = tileWkts.map((w) => turf.polygon(parseRingCoords(w)));

    let areaSum = 0;
    let count = 0;
    const ms = timeMs(() => {
      // turf 7 folds pairwise via a FeatureCollection; turf 6 is (a, b).
      let acc: TurfFeature = polys[0]!;
      for (let i = 1; i < polys.length; i++) {
        const two = turf.featureCollection([acc, polys[i]!]);
        const out = (turf.union as (input: unknown) => TurfFeature | null)(two);
        if (out !== null) acc = out;
      }
      areaSum = planarArea(acc);
      count = 1;
      sink(count, Math.round(areaSum));
    }, 1);

    return {
      variants: { unary: ms },
      repeats: 1,
      fingerprint: { count, areaSum },
      note: "pairwise fold (no cascaded union); 100-tile ladder cap",
    };
  },

  "prepared-scan"({ size, polyWkt, pointCoords }: PreparedInputs): ScenarioOutput {
    const turf = get();
    const repeats = size >= 100_000 ? 1 : 3;
    const poly = turf.polygon(parseRingCoords(polyWkt));
    const points = pointCoords.map(([x, y]) => turf.point([x, y]));

    let hits = 0;
    const ms = timeMs(() => {
      hits = 0;
      for (const p of points) if (turf.booleanPointInPolygon(p, poly)) hits++;
      sink(hits, 0);
    }, repeats);

    // Ray-casting only — no prepared mode exists; report under "unprepared".
    return {
      variants: { unprepared: ms },
      repeats,
      fingerprint: { areaSum: null, hits },
      note: "ray-casting point-in-polygon (no prepared mode)",
    };
  },

  buffer({ wobbleWkts }: BufferInputs): ScenarioOutput {
    const turf = get();
    const inputs = wobbleWkts.map((w) => turf.polygon(parseRingCoords(w)));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const g of inputs) {
        const b = turf.buffer(g, FIXED.bufferDistance, { units: "kilometers" });
        if (b !== null) {
          count++;
          areaSum += planarArea(b);
        }
      }
      sink(count, Math.round(areaSum));
    }, 3);
    return {
      variants: { buffer: ms },
      repeats: 3,
      fingerprint: { count, areaSum },
      note: "geographic projection built in — planar fingerprint mismatch expected",
    };
  },
} satisfies Adapter;

let cached: TurfModule | null = null;

function get(): TurfModule {
  if (cached === null) throw new Error("turf: probe() first");
  return cached;
}

function sink(a: number, b: number): void {
  if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
    throw new Error("unreachable");
}
