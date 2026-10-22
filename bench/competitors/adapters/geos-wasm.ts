/**
 * geos-wasm adapter — the benchmark to beat (GEOS 3.13 compiled to WASM,
 * raw C API over the Emscripten heap). Everything goes through a small
 * pointer-plumbing wrapper — which is precisely the ergonomics gap
 * bun-geos exists to close; geos-wasm users write this wrapper by hand.
 *
 * Runtime-probed per the honesty rule (testing.md §4): if an op's API
 * shape isn't workable (e.g. STRtree query needs Emscripten callback
 * tables), the scenario is skipped with a recorded reason — never
 * silently dropped, never hard-failed.
 */

import type { ScenarioOutput } from "../../lib/metrics.ts";
import { timeMs } from "../../lib/metrics.ts";
import {
  type Adapter,
  type BufferInputs,
  FIXED,
  type IngestInputs,
  type MakeValidInputs,
  type OverlayInputs,
  type PreparedInputs,
  type StrtreeInputs,
  type UnionInputs,
} from "../../lib/scenarios.ts";

/** Reason from the last skipped strtree probe (surfaced via failures/notes). */
let lastStrtreeReason = "";

interface WasmModule {
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToUTF8(str: string, outPtr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  HEAPU8: Uint8Array;
  addFunction?: (fn: (...args: number[]) => number, sig: string) => number;
  removeFunction?: (ptr: number) => void;
}

interface WasmGeosBase {
  Module: WasmModule;
  GEOSFree(ptr: number): void;
}

/** Named GEOS C API functions resolved at runtime; the index side is the probe surface. */
type WasmGeos = WasmGeosBase & { [name: string]: ((...args: unknown[]) => unknown) | undefined };

const GEOS_MULTIPOLYGON = 6;

async function loadWasmGeos(): Promise<WasmGeos> {
  const spec = ["geos-wasm"].join(""); // non-literal: optional devDependency
  const mod = (await import(spec)) as {
    default?: (opts?: unknown) => Promise<WasmGeos>;
  };
  if (typeof mod.default !== "function") throw new Error("unexpected API shape");
  return await mod.default();
}

export default {
  engine: "geos-wasm",
  boundary: "wasm",
  reportNote: "GEOS 3.13 via Emscripten — raw C API, manual heap plumbing",

  async probe() {
    const geos = await loadWasmGeos();
    let ver = "geos-wasm";
    try {
      const versionFn = geos.GEOSversion;
      const v = typeof versionFn === "function" ? versionFn() : undefined;
      // geos-wasm wraps string-returning C functions to JS strings.
      ver = `geos-wasm / ${typeof v === "string" ? v : "GEOS"}`;
    } catch {
      // version is informational
    }
    cachedGeos = geos;
    return ver;
  },

  overlay({ size, clipWkt, squareWkts }: OverlayInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const repeats = size >= 100_000 ? 2 : 3;
    const clip = w.fromWKT(clipWkt);
    const squares = squareWkts.map((s) => w.fromWKT(s));

    const ms = timeMs(() => {
      let count = 0;
      let areaSum = 0;
      for (const s of squares) {
        const out = w.intersection(clip, s);
        if (!w.isEmpty(out)) {
          count++;
          areaSum += w.area(out);
        }
        w.destroy(out);
      }
      w.sink(count, areaSum);
    }, repeats);

    // Reference fingerprint pass (numbers captured; outputs destroyed).
    let count = 0;
    let areaSum = 0;
    for (const s of squares) {
      const out = w.intersection(clip, s);
      if (!w.isEmpty(out)) {
        count++;
        areaSum += w.area(out);
      }
      w.destroy(out);
    }
    w.destroy(clip);
    for (const s of squares) w.destroy(s);
    return { variants: { singular: ms }, repeats, fingerprint: { count, areaSum } };
  },

  union({ tileWkts }: UnionInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const tiles = tileWkts.map((t) => w.fromWKT(t));
    // Unary union needs ONE geometry: a multipolygon collection. The C API
    // collection consumes its members, so each repeat re-clones (recorded
    // in the note — it is the C-API input contract, paid by every GEOS
    // binding that isn't bun-geos).
    const buildCollection = (): number => {
      const clones = tiles.map((t) => w.clone(t));
      return w.createCollection(GEOS_MULTIPOLYGON, clones);
    };

    const run: Record<string, number> = {};
    let areaSum = 0;
    let count = 0;
    const notes: string[] = [];
    for (const variant of ["unary", "coverage-raw"] as const) {
      const op = variant === "unary" ? "GEOSUnaryUnion" : "GEOSCoverageUnion";
      try {
        run[variant] = timeMs(() => {
          const col = buildCollection();
          const out = w.callOp(op, col);
          areaSum = w.area(out);
          count = w.numGeometries(out);
          w.destroy(out);
          w.destroy(col);
        });
      } catch (e) {
        notes.push(`${op}: ${(e as Error).message}`);
      }
    }
    for (const t of tiles) w.destroy(t);
    if (run.unary === undefined) return null;
    return {
      variants: run,
      repeats: 3,
      fingerprint: { count, areaSum },
      note:
        notes.length > 0
          ? `${notes.join("; ")} — coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract)`
          : "coverage-raw is union-only (no validity pre-check); includes per-repeat clone + collection build (C-API input contract)",
    };
  },

  "prepared-scan"({ size, polyWkt, pointWkts }: PreparedInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const repeats = size >= 100_000 ? 1 : 3;
    const poly = w.fromWKT(polyWkt);
    const points = pointWkts.map((p) => w.fromWKT(p));

    const unpreparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (w.intersects(poly, p)) hits++;
      w.sink(hits, 0);
    }, repeats);

    // Prepare ONCE outside the timed region — symmetric with bun-geos,
    // Shapely and the C++ baseline (testing.md §4 preparation symmetry).
    const prep = w.prepare(poly);
    const preparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (w.preparedIntersects(prep, p)) hits++;
      w.sink(hits, 0);
    }, repeats);

    let hits = 0;
    for (const p of points) if (w.preparedIntersects(prep, p)) hits++;
    w.destroyPrepared(prep);
    w.destroy(poly);
    for (const p of points) w.destroy(p);
    return {
      variants: { unprepared: unpreparedMs, prepared: preparedMs },
      repeats,
      fingerprint: { areaSum: null, hits },
    };
  },

  strtree({ boxes, queries }: StrtreeInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    if (!w.supportsCallbacks()) return null;

    // Live probe: geos-wasm 3.1.1's GEOSSTRtree_query callback binding
    // hits an Emscripten call_indirect signature mismatch under Bun. If the
    // probe fails the scenario FAILS with that reason (recorded, reported);
    // if upstream fixes the binding, it runs.
    try {
      w.strtreeQueryProbe();
    } catch (e) {
      lastStrtreeReason = `GEOSSTRtree_query callback binding unusable (${(e as Error).message.slice(0, 80)})`;
      throw new Error(lastStrtreeReason);
    }

    const wktOf = (b: { minX: number; minY: number; maxX: number; maxY: number }): string =>
      `POLYGON ((${b.minX} ${b.minY}, ${b.maxX} ${b.minY}, ${b.maxX} ${b.maxY}, ${b.minX} ${b.maxY}, ${b.minX} ${b.minY}))`;
    const items = boxes.map((b) => w.fromWKT(wktOf(b)));
    const queryGeoms = queries.map((b) => w.fromWKT(wktOf(b)));

    let hits = 0;
    const buildMs = timeMs(() => {
      const tree = w.strtreeCreate();
      for (const it of items) w.strtreeInsert(tree, it, it);
      hits = w.strtreeQueryCount(tree, queryGeoms[0]!);
      w.strtreeDestroy(tree);
      w.sink(hits, 0);
    }, 3);

    const tree = w.strtreeCreate();
    for (const it of items) w.strtreeInsert(tree, it, it);
    const queryMs = timeMs(() => {
      hits = 0;
      for (const q of queryGeoms) hits += w.strtreeQueryCount(tree, q);
      w.sink(hits, 0);
    }, 5);
    w.strtreeDestroy(tree);

    for (const q of queryGeoms) w.destroy(q);
    for (const it of items) w.destroy(it);
    return {
      variants: { build: buildMs, query: queryMs },
      repeats: 5,
      fingerprint: { areaSum: null, hits },
    };
  },

  ingest({ size, squareWkts, wkb, offs }: IngestInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const repeats = 2;

    const wktMs = timeMs(() => {
      let n = 0;
      for (const s of squareWkts) {
        const g = w.fromWKT(s);
        w.destroy(g);
        n++;
      }
      w.sink(n, 0);
    }, repeats);

    const wkbMs = timeMs(() => {
      let n = 0;
      const reader = w.wkbReader();
      for (let i = 0; i < size; i++) {
        const start = i === 0 ? 0 : offs[i - 1]!;
        const g = w.wkbRead(reader, wkb.subarray(start, offs[i]!));
        w.destroy(g);
        n++;
      }
      w.wkbReaderDestroy(reader);
      w.sink(n, 0);
    }, repeats);

    let count = 0;
    for (const s of squareWkts) {
      w.destroy(w.fromWKT(s));
      count++;
    }
    return {
      variants: { wkt: wktMs, wkb: wkbMs },
      repeats,
      fingerprint: { count, areaSum: null },
    };
  },

  makevalid({ bowtieWkts }: MakeValidInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const inputs = bowtieWkts.map((b) => w.fromWKT(b));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const b of inputs) {
        const f = w.makeValid(b);
        if (w.isValid(f)) count++;
        areaSum += w.area(f);
        w.destroy(f);
      }
      w.sink(count, areaSum);
    }, 3);
    for (const b of inputs) w.destroy(b);
    return { variants: { makevalid: ms }, repeats: 3, fingerprint: { count, areaSum } };
  },

  buffer({ wobbleWkts }: BufferInputs): ScenarioOutput | null {
    const w = Wrapper.get();
    const inputs = wobbleWkts.map((s) => w.fromWKT(s));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      for (const g of inputs) {
        const b = w.buffer(g, FIXED.bufferDistance, FIXED.bufferQuadSegs);
        count++;
        areaSum += w.area(b);
        w.destroy(b);
      }
      w.sink(count, areaSum);
    }, 3);
    for (const g of inputs) w.destroy(g);
    return { variants: { buffer: ms }, repeats: 3, fingerprint: { count, areaSum } };
  },
} satisfies Adapter;

/* --------------------------------------------------------------- plumbing */

let cachedGeos: WasmGeos | null = null;

function firstFn(geos: WasmGeos, ...names: string[]): ((...args: unknown[]) => unknown) | null {
  for (const n of names) {
    const f = geos[n];
    if (typeof f === "function") return f as (...args: unknown[]) => unknown;
  }
  return null;
}

/**
 * The wrapper geos-wasm users must write by hand: malloc'd WKT strings,
 * out-parameter doubles, char predicates, explicit destroy of every
 * geometry. Cached per engine probe.
 */
const Wrapper = {
  get(): W {
    if (cachedGeos === null) throw new Error("geos-wasm: probe() first");
    return new W(cachedGeos);
  },
};

class W {
  #geos: WasmGeos;
  #reader: number;

  constructor(geos: WasmGeos) {
    this.#geos = geos;
    this.#reader = this.call("GEOSWKTReader_create")() as number;
  }

  private call(...names: string[]): (...args: unknown[]) => unknown {
    const f = firstFn(this.#geos, ...names);
    if (f === null) throw new Error(`geos-wasm: none of ${names.join("/")} present`);
    return f;
  }

  sink(a: number, b: number): void {
    if (a === Number.MIN_SAFE_INTEGER && b === Number.MAX_SAFE_INTEGER)
      throw new Error("unreachable");
  }

  supportsCallbacks(): boolean {
    return typeof this.#geos.Module.addFunction === "function";
  }

  fromWKT(wkt: string): number {
    const mod = this.#geos.Module;
    const bytes = wkt.length + 1;
    const strPtr = mod._malloc(bytes);
    try {
      mod.stringToUTF8(wkt, strPtr, bytes);
      const g = this.call("GEOSWKTReader_read")(this.#reader, strPtr) as number;
      if (!g) throw new Error(`geos-wasm: WKT read failed: ${wkt.slice(0, 40)}`);
      return g;
    } finally {
      mod._free(strPtr);
    }
  }

  destroy(g: number): void {
    this.call("GEOSGeom_destroy")(g);
  }

  clone(g: number): number {
    return this.call("GEOSGeom_clone")(g) as number;
  }

  createCollection(kind: number, members: number[]): number {
    const mod = this.#geos.Module;
    const arrPtr = mod._malloc(members.length * 4);
    const heap = new Uint32Array(mod.HEAPU8.buffer, arrPtr, members.length);
    heap.set(members);
    try {
      const col = this.call("GEOSGeom_createCollection")(kind, arrPtr, members.length) as number;
      if (!col) throw new Error("geos-wasm: createCollection failed");
      return col;
    } finally {
      mod._free(arrPtr);
    }
  }

  area(g: number): number {
    const mod = this.#geos.Module;
    const out = mod._malloc(8);
    try {
      this.call("GEOSArea")(g, out);
      return mod.getValue(out, "double");
    } finally {
      this.#geos.GEOSFree(out);
    }
  }

  isEmpty(g: number): boolean {
    return (this.call("GEOSisEmpty")(g) as number) !== 0;
  }

  isValid(g: number): boolean {
    return (this.call("GEOSisValid")(g) as number) !== 0;
  }

  numGeometries(g: number): number {
    return this.call("GEOSGetNumGeometries")(g) as number;
  }

  intersection(a: number, b: number): number {
    const out = this.call("GEOSIntersection")(a, b) as number;
    if (!out) throw new Error("geos-wasm: GEOSIntersection failed");
    return out;
  }

  intersects(a: number, b: number): boolean {
    return (this.call("GEOSIntersects")(a, b) as number) !== 0;
  }

  prepare(g: number): number {
    return this.call("GEOSPrepare")(g) as number;
  }

  preparedIntersects(prep: number, g: number): boolean {
    return (this.call("GEOSPreparedIntersects")(prep, g) as number) !== 0;
  }

  destroyPrepared(prep: number): void {
    this.call("GEOSPreparedGeom_destroy")(prep);
  }

  unaryUnion(g: number): number {
    return this.call("GEOSUnaryUnion")(g) as number;
  }

  /** Named-op variant used by the union ladder's probe-once-per-variant path. */
  callOp(op: string, g: number): number {
    const out = this.call(op)(g) as number;
    if (!out) throw new Error(`${op} failed`);
    return out;
  }

  makeValid(g: number): number {
    return this.call("GEOSMakeValid")(g) as number;
  }

  buffer(g: number, width: number, quadSegs: number): number {
    return this.call("GEOSBuffer")(g, width, quadSegs) as number;
  }

  wkbReader(): number {
    return this.call("GEOSWKBReader_create")() as number;
  }

  wkbReaderDestroy(reader: number): void {
    this.call("GEOSWKBReader_destroy")(reader);
  }

  wkbRead(reader: number, bytes: Uint8Array): number {
    const mod = this.#geos.Module;
    const ptr = mod._malloc(bytes.length);
    try {
      mod.HEAPU8.set(bytes, ptr);
      return this.call("GEOSWKBReader_read")(reader, ptr, bytes.length) as number;
    } finally {
      mod._free(ptr);
    }
  }

  /* --- STRtree (live-probed; the callback binding may be unusable) --- */

  /** Minimal insert+query against a 2-item tree; throws when the callback path is broken. */
  strtreeQueryProbe(): void {
    const a = this.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    const b = this.fromWKT("POLYGON ((5 0, 6 0, 6 1, 5 1, 5 0))");
    const q = this.fromWKT("POLYGON ((0.5 0.5, 0.6 0.5, 0.6 0.6, 0.5 0.6, 0.5 0.5))");
    const tree = this.strtreeCreate();
    try {
      this.strtreeInsert(tree, a, a);
      this.strtreeInsert(tree, b, b);
      const hits = this.strtreeQueryCount(tree, q);
      if (hits !== 1) throw new Error(`probe returned ${hits} hits, expected 1`);
    } finally {
      this.strtreeDestroy(tree);
      this.destroy(a);
      this.destroy(b);
      this.destroy(q);
    }
  }

  strtreeCreate(): number {
    return this.call("GEOSSTRtree_create")(10) as number;
  }

  strtreeInsert(tree: number, geom: number, item: number): void {
    this.call("GEOSSTRtree_insert")(tree, geom, item);
  }

  strtreeDestroy(tree: number): void {
    this.call("GEOSSTRtree_destroy")(tree);
  }

  /** One query through the Emscripten callback table; returns the hit count. */
  strtreeQueryCount(tree: number, query: number): number {
    const mod = this.#geos.Module;
    if (typeof mod.addFunction !== "function" || typeof mod.removeFunction !== "function") {
      throw new Error("Module.addFunction unavailable");
    }
    let hits = 0;
    const cb = mod.addFunction((_item: number, _userdata: number) => {
      hits++;
      return 1;
    }, "iii");
    try {
      this.call("GEOSSTRtree_query")(tree, query, cb, 0);
    } finally {
      mod.removeFunction(cb);
    }
    return hits;
  }
}
