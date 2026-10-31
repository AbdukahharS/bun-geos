/**
 * Unit: the linear-only boundary (D31). GEOS 3.13+ can parse curved
 * geometry types (CircularString, CompoundCurve, CurvePolygon, MultiCurve,
 * MultiSurface) from WKT/WKB, but this library declares them NEVER — the
 * readers must reject them loudly at the boundary, name the type in the
 * message, and leave the Geos instance usable afterwards.
 */
import { describe, expect, it } from "bun:test";
import { GeosError } from "../../src/errors.ts";
import { Geos } from "../../src/index.ts";
import { geoTypeName } from "../../src/types.ts";

const CURVED_WKT = [
  ["CircularString", "CIRCULARSTRING(0 0, 1 1, 2 0)"],
  ["CompoundCurve", "COMPOUNDCURVE(CIRCULARSTRING(0 0, 1 1, 2 0))"],
  ["CurvePolygon", "CURVEPOLYGON(CIRCULARSTRING(0 0, 1 1, 2 0, 1 -1, 0 0))"],
  ["MultiCurve", "MULTICURVE(CIRCULARSTRING(0 0, 1 1, 2 0))"],
  ["MultiSurface", "MULTISURFACE(CURVEPOLYGON(CIRCULARSTRING(0 0, 1 1, 2 0, 1 -1, 0 0)))"],
] as const;

/** Little-endian WKB builder: header byte + u32 words + f64 coords. */
class Wkb {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private off = 0;
  constructor(n: number) {
    this.bytes = new Uint8Array(n);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(x: number): this {
    this.view.setUint8(this.off, x);
    this.off += 1;
    return this;
  }
  u32(x: number): this {
    this.view.setUint32(this.off, x, true);
    this.off += 4;
    return this;
  }
  pt(x: number, y: number): this {
    this.view.setFloat64(this.off, x, true);
    this.off += 8;
    this.view.setFloat64(this.off, y, true);
    this.off += 8;
    return this;
  }
  done(): Uint8Array {
    if (this.off !== this.bytes.length) throw new Error(`size mismatch: ${this.off}`);
    return this.bytes;
  }
}

/** CIRCULARSTRING(0 0, 1 1, 2 0) — 1 + 4 + 4 + 3·16 bytes. */
function circularStringWkb(): Uint8Array {
  return new Wkb(57).u8(1).u32(8).u32(3).pt(0, 0).pt(1, 1).pt(2, 0).done();
}

/** GEOMETRYCOLLECTION(CIRCULARSTRING(...)) — curve nested one level down. */
function collectionWithCurveWkb(): Uint8Array {
  return new Wkb(66).u8(1).u32(7).u32(1).u8(1).u32(8).u32(3).pt(0, 0).pt(1, 1).pt(2, 0).done();
}

/** k nested GEOMETRYCOLLECTIONs around POINT(1 2) — each level adds 9 bytes. */
function nestedCollectionWkb(levels: number): Uint8Array {
  const w = new Wkb(21 + levels * 9);
  const build = (lvl: number): void => {
    if (lvl === 0) {
      w.u8(1).u32(1).pt(1, 2); // POINT(1 2)
      return;
    }
    w.u8(1).u32(7).u32(1);
    build(lvl - 1);
  };
  build(levels);
  return w.done();
}

/** MULTICURVE(CIRCULARSTRING(...)) — curved collection, id 11. */
function multiCurveWkb(): Uint8Array {
  return new Wkb(66).u8(1).u32(11).u32(1).u8(1).u32(8).u32(3).pt(0, 0).pt(1, 1).pt(2, 0).done();
}

/** POINT(5 5) — 21 bytes, for the mixed batch test. */
function pointWkb(): Uint8Array {
  return new Wkb(21).u8(1).u32(1).pt(5, 5).done();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("D31 — curved types are rejected at the reader boundary", () => {
  it("fromWKT rejects every curved type, naming it in the message", () => {
    using geos = new Geos();
    for (const [name, wkt] of CURVED_WKT) {
      expect(() => geos.fromWKT(wkt)).toThrow(GeosError);
      expect(() => geos.fromWKT(wkt)).toThrow(
        new RegExp(`^GEOS fromWKT failed: ${name}: curved geometry types are not supported`),
      );
    }
  });

  it("fromWKT rejects a curve nested in a GEOMETRYCOLLECTION", () => {
    using geos = new Geos();
    expect(() => geos.fromWKT("GEOMETRYCOLLECTION(CIRCULARSTRING(0 0, 1 1, 2 0))")).toThrow(
      /CircularString: curved geometry types are not supported/,
    );
  });

  it("fromWKB rejects curved payloads, top-level and nested", () => {
    using geos = new Geos();
    expect(() => geos.fromWKB(circularStringWkb())).toThrow(GeosError);
    expect(() => geos.fromWKB(circularStringWkb())).toThrow(
      /^GEOS fromWKB failed: CircularString: curved geometry types are not supported — this library is linear-only \(D31\)$/,
    );
    expect(() => geos.fromWKB(collectionWithCurveWkb())).toThrow(/CircularString:/);
    expect(() => geos.fromWKB(multiCurveWkb())).toThrow(/MultiCurve:/);
  });

  it("fromWKBMany is all-or-nothing when one row is curved", () => {
    using geos = new Geos();
    const p = pointWkb();
    const buf = concat(p, p, circularStringWkb());
    const offsets = new Uint32Array([p.length, 2 * p.length, buf.length]);
    expect(() => geos.fromWKBMany(buf, offsets)).toThrow(GeosError);
    expect(() => geos.fromWKBMany(buf, offsets)).toThrow(/CircularString:/);
  });

  it("fromWKBMany's rejection happens in the crossing: the row index rides the message", () => {
    using geos = new Geos();
    const p = pointWkb();
    const buf = concat(p, circularStringWkb());
    const offsets = new Uint32Array([p.length, buf.length]);
    // The check runs shim-side (one crossing, no per-row JS); the message
    // names the offending row and keeps the D31 wording byte-identical.
    expect(() => geos.fromWKBMany(buf, offsets)).toThrow(
      /^GEOS geos_shim_read_wkb_many failed: read_wkb_many: row 1: CircularString: curved geometry types are not supported — this library is linear-only \(D31\)$/,
    );
  });

  it("fromWKBMany rejects a collection-hidden curve (the shim recursion path)", () => {
    using geos = new Geos();
    const buf = collectionWithCurveWkb();
    const offsets = new Uint32Array([buf.length]);
    expect(() => geos.fromWKBMany(buf, offsets)).toThrow(GeosError);
    expect(() => geos.fromWKBMany(buf, offsets)).toThrow(/CircularString:/);
  });

  it("fromWKBMany's shim-side nesting guard has depth parity with the single reader", () => {
    using geos = new Geos();
    // 12 levels: well inside the 32-level guard — parses through the batch.
    const ok = nestedCollectionWkb(12);
    const [g] = geos.fromWKBMany(ok, new Uint32Array([ok.length]));
    expect(geos.geomType(g!)).toBe("GeometryCollection");
    // 40 levels: the C-side guard (assert_linear) trips before GEOS's own
    // limits — the batch path pins the same >32 contract as the JS reader.
    const deep = nestedCollectionWkb(40);
    expect(() => geos.fromWKBMany(deep, new Uint32Array([deep.length]))).toThrow(
      /nesting exceeds 32 levels/,
    );
  });

  it("a rejected batch read leaves the instance usable", () => {
    using geos = new Geos();
    const p = pointWkb();
    const buf = concat(p, circularStringWkb());
    expect(() => geos.fromWKBMany(buf, new Uint32Array([p.length, buf.length]))).toThrow(GeosError);
    const [g] = geos.fromWKBMany(buf, new Uint32Array([p.length]));
    expect(geos.geomType(g!)).toBe("Point");
  });

  it("a rejected read leaves the instance usable", () => {
    using geos = new Geos();
    expect(() => geos.fromWKT("CIRCULARSTRING(0 0, 1 1, 2 0)")).toThrow(GeosError);
    const g = geos.fromWKT("POINT (1 2)");
    expect(geos.toWKT(g)).toBe("POINT (1 2)");
  });

  it("geoTypeName names the curved ids for diagnostics", () => {
    expect(geoTypeName(8)).toBe("CircularString");
    expect(geoTypeName(9)).toBe("CompoundCurve");
    expect(geoTypeName(10)).toBe("CurvePolygon");
    expect(geoTypeName(11)).toBe("MultiCurve");
    expect(geoTypeName(12)).toBe("MultiSurface");
    expect(geoTypeName(13)).toBe("Unknown(13)");
  });

  it("collection nesting beyond 32 levels throws; reasonable nesting parses", () => {
    using geos = new Geos();
    const nest = (levels: number): string =>
      `${"GEOMETRYCOLLECTION(".repeat(levels)}POINT (1 2)${")".repeat(levels)}`;
    // 12 levels: depth 0..11 — well inside the guard, parses fine.
    const g = geos.fromWKT(nest(12));
    expect(geos.geomType(g)).toBe("GeometryCollection");
    // 40 levels: the guard trips before GEOS's own limits.
    expect(() => geos.fromWKT(nest(40))).toThrow(/nesting exceeds 32 levels/);
  });
});
