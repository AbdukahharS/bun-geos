/**
 * GeoArrow golden conformance (Phase 5, D28): buffers generated from the
 * REFERENCE implementation (geoarrow-pyarrow) via
 * scripts/geoarrow-goldens.py — committed as
 * test/differential/geoarrow-goldens.json.
 *
 * The reference emits the GeoArrow CANONICAL layout: struct<x,y> coord
 * fields + int32 list offsets + LSB validity bitmaps. bun-geos typed
 * arrays use the INTERLEAVED profile (one Float64Array) with end-index
 * member offsets. The struct↔interleaved conversion and the
 * offsets-encoding mapping are the documented conformance surface this
 * test pins in BOTH directions:
 *   golden bytes → our shapes → geometry (WKT must match the golden WKT)
 *   our geometry → toArrow → packed canonical bytes (must equal the goldens)
 *
 * Regen: python3 -m venv /tmp/opencode/geoarrow-venv &&
 *        /tmp/opencode/geoarrow-venv/bin/pip install pyarrow geoarrow-pyarrow &&
 *        /tmp/opencode/geoarrow-venv/bin/python scripts/geoarrow-goldens.py
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Geos } from "../../src/index.ts";
import { geometriesFromArrow } from "../../src/io/arrow.ts";
import type {
  ArrowArray,
  MultiLineStringArray,
  MultiPointArray,
  MultiPolygonArray,
} from "../../src/types.ts";

const GOLDENS = join(import.meta.dir, "geoarrow-goldens.json");
const hasGoldens = existsSync(GOLDENS);
describe.skipIf(!hasGoldens)("GeoArrow golden conformance (geoarrow-pyarrow reference)", () => {
  const { cases } = JSON.parse(readFileSync(GOLDENS, "utf8")) as {
    cases: Array<{
      name: string;
      wkt: string[];
      shape: string;
      coord: { x: string; y: string };
      levels: Array<{ offsets: string; validity: string | null }>;
      struct_validity?: string;
      slots?: number;
    }>;
  };

  function hexBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function f64LE(bytes: Uint8Array): Float64Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float64Array(bytes.length / 8);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat64(i * 8, true);
    return out;
  }
  function i32LE(bytes: Uint8Array): Int32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Int32Array(Math.floor(bytes.length / 4));
    for (let i = 0; i < out.length; i++) out[i] = view.getInt32(i * 4, true);
    return out;
  }
  function i32Hex(values: Int32Array): string {
    const view = new DataView(new ArrayBuffer(values.length * 4));
    for (let i = 0; i < values.length; i++) view.setInt32(i * 4, values[i]!, true);
    return [...new Uint8Array(view.buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  /** canonical struct<x,y> fields → interleaved XY */
  function deinterleave(x: Float64Array, y: Float64Array): Float64Array {
    const out = new Float64Array(x.length * 2);
    for (let i = 0; i < x.length; i++) {
      out[i * 2] = x[i]!;
      out[i * 2 + 1] = y[i]!;
    }
    return out;
  }
  function interleave(coords: Float64Array): { x: string; y: string } {
    const view = new DataView(coords.buffer, coords.byteOffset, coords.byteLength);
    const hexAt = (i: number): string =>
      [...new Uint8Array(view.buffer, view.byteOffset + i * 8, 8)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    let x = "";
    let y = "";
    for (let i = 0; i < coords.length / 2; i++) {
      x += hexAt(i * 2);
      y += hexAt(i * 2 + 1);
    }
    return { x, y };
  }
  const arrowize = (endIndexes: Int32Array): Int32Array => Int32Array.from([0, ...endIndexes]);
  const multiKindOf = (shape: string): string =>
    shape === "point" ? "multipoint" : shape === "linestring" ? "multilinestring" : "multipolygon";

  it("golden bytes build our shapes; our shapes pack back to the golden bytes", () => {
    using geos = new Geos();
    for (const c of cases) {
      if (c.name === "point-with-null") continue; // separate null-slot test
      const n = c.wkt.length;
      const coords = deinterleave(f64LE(hexBytes(c.coord.x)), f64LE(hexBytes(c.coord.y)));
      // Level-count disambiguates a COLUMN of singular geometries (each
      // WKT = one list row) from a single MULTI* GEOMETRY (one row whose
      // members are the inner list / struct entries).
      let arr: ArrowArray;
      if (c.shape === "point") {
        if (c.levels.length === 0 && n === 1) {
          arr = { kind: "point", coords, hasZ: false, hasM: false };
        } else {
          // point column (bare struct) → multipoint members
          arr = {
            kind: "multipoint",
            coords,
            pointOffsets: Int32Array.from({ length: n }, (_, i) => i + 1),
            hasZ: false,
            hasM: false,
          } as MultiPointArray;
        }
      } else if (c.shape === "linestring") {
        const lineOffsets = i32LE(hexBytes(c.levels[0]!.offsets)).slice(1);
        arr =
          n === 1
            ? { kind: "linestring", coords, lineOffsets, hasZ: false, hasM: false }
            : { kind: "multilinestring", coords, lineOffsets, hasZ: false, hasM: false };
      } else if (c.shape === "polygon") {
        const ringOffsets = i32LE(hexBytes(c.levels[1]!.offsets)).slice(1);
        arr =
          n === 1
            ? { kind: "polygon", coords, ringOffsets, hasZ: false, hasM: false }
            : {
                kind: "multipolygon",
                coords,
                ringOffsets,
                partOffsets: i32LE(hexBytes(c.levels[0]!.offsets)).slice(1),
                hasZ: false,
                hasM: false,
              };
      } else if (c.shape === "multipoint") {
        // one MULTIPOINT geometry = one row; members are its coord entries
        const row = i32LE(hexBytes(c.levels[0]!.offsets));
        const count = row[1]! - row[0]!;
        arr = {
          kind: "multipoint",
          coords,
          pointOffsets: Int32Array.from({ length: count }, (_, i) => i + 1),
          hasZ: false,
          hasM: false,
        } as MultiPointArray;
      } else if (c.shape === "multilinestring") {
        // inner level = member linestring boundaries (absolute)
        const lineOffsets = i32LE(hexBytes(c.levels[1]!.offsets)).slice(1);
        arr = {
          kind: "multilinestring",
          coords,
          lineOffsets,
          hasZ: false,
          hasM: false,
        } as MultiLineStringArray;
      } else {
        // multipolygon row: level1 = member polygons (rings), level2 = rings (coords)
        const ringOffsets = i32LE(hexBytes(c.levels[2]!.offsets)).slice(1);
        arr = {
          kind: "multipolygon",
          coords,
          ringOffsets,
          partOffsets: i32LE(hexBytes(c.levels[1]!.offsets)).slice(1),
          hasZ: false,
          hasM: false,
        } as MultiPolygonArray;
      }

      // golden → geometry: WKT agreement. A one-row golden (n === 1) is ONE
      // geometry — multi* shapes' members are the row's leaves — so build it
      // singularly; an n>1 COLUMN expands to n members via the batch path.
      if (n === 1) {
        using whole = geos.fromArrow(arr);
        using expected = geos.fromWKT(c.wkt[0]!);
        expect(geos.equalsIdentical(whole, expected)).toBe(true);
        if (
          arr.kind === "multipoint" ||
          arr.kind === "multilinestring" ||
          arr.kind === "multipolygon"
        ) {
          // the batch view of a multi* shape yields the row's members
          const members = geometriesFromArrow(geos, arr, undefined, { nullMode: "throw" });
          for (const m of members) m.dispose();
        }
      } else {
        const members = geometriesFromArrow(geos, arr, undefined, { nullMode: "throw" });
        expect(members.length).toBe(n);
        for (let i = 0; i < n; i++) {
          using expected = geos.fromWKT(c.wkt[i]!);
          expect(geos.equalsIdentical(members[i]!, expected)).toBe(true);
          members[i]!.dispose();
        }
      }

      // geometry → canonical bytes: our toArrow packs back to the goldens
      // (n = 1 only — the singular shapes align 1:1 with a one-row column)
      if (n === 1) {
        using g = geos.fromWKT(c.wkt[0]!);
        const out = geos.toArrow(g);
        if (out.kind === "geometrycollection")
          throw new Error("unexpected GC for a singular golden");
        const packed = interleave(out.coords);
        expect(packed.x).toBe(c.coord.x);
        expect(packed.y).toBe(c.coord.y);
        const levelOf = (idx: number): string => c.levels[idx]?.offsets ?? "<missing level>";
        const rowLevel = (members: number): string => i32Hex(Int32Array.of(0, members));
        if (out.kind === "linestring") {
          expect(i32Hex(arrowize(out.lineOffsets))).toBe(levelOf(0));
        } else if (out.kind === "polygon") {
          expect(i32Hex(arrowize(out.ringOffsets))).toBe(levelOf(1));
        } else if (out.kind === "multipoint") {
          // canonical multipoint = ONE row of N coord entries (just [0] when empty)
          const row =
            out.pointOffsets.length === 0
              ? Int32Array.of(0)
              : Int32Array.of(0, out.pointOffsets.length);
          expect(i32Hex(row)).toBe(levelOf(0));
        } else if (out.kind === "multilinestring") {
          expect(rowLevel(out.lineOffsets.length)).toBe(levelOf(0));
          expect(i32Hex(arrowize(out.lineOffsets))).toBe(levelOf(1));
        } else if (out.kind === "multipolygon") {
          expect(rowLevel(out.partOffsets.length)).toBe(levelOf(0));
          expect(i32Hex(arrowize(out.partOffsets))).toBe(levelOf(1));
          expect(i32Hex(arrowize(out.ringOffsets))).toBe(levelOf(2));
        }
      }
      void multiKindOf; // (kept for future column-level mappings)
    }
  });

  it("a struct-level null slot maps to our validity semantics (batch skip)", () => {
    using geos = new Geos();
    const c = cases.find((x) => x.name === "point-with-null")!;
    const coords = deinterleave(f64LE(hexBytes(c.coord.x)), f64LE(hexBytes(c.coord.y)));
    const slots = c.slots ?? 2;
    const arr = {
      kind: "multipoint",
      coords,
      pointOffsets: Int32Array.from({ length: slots }, (_, i) => i + 1),
      hasZ: false,
      hasM: false,
      validity: hexBytes(c.struct_validity!),
    } as MultiPointArray;
    const members = geometriesFromArrow(geos, arr, undefined, { nullMode: "skip" });
    expect(members.length).toBe(1);
    using expected = geos.fromWKT(c.wkt[0]!);
    expect(geos.equalsIdentical(members[0]!, expected)).toBe(true);
    members[0]!.dispose();
  });
});
