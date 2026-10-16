/**
 * WKB I/O (io.md §4). Native reader/writer, one crossing per geometry.
 * Reading accepts ISO WKB and PostGIS EWKB (SRID rides along natively via
 * `GEOSGetSRID_r` — verified present in 3.14's geos_c.h; io.md's
 * "no SRID storage" side-channel note is outdated and was dropped).
 * Writing ALWAYS copies at the boundary — a returned `Uint8Array` never
 * aliases C memory (memory.md pitfall table).
 */
import { toArrayBuffer } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { ByteOrder, GeomPtr, WkbWriterPtr } from "../types.ts";
import { byteOrderToId } from "../types.ts";

export interface WKBOptions {
  /** Byte order. Default: native. Use "big" for stable goldens. */
  byteOrder?: ByteOrder;
  /** Output dimension: 2, 3 (Z) or 4 (ZM). Default 2. */
  outputDimension?: 2 | 3 | 4;
  /** Embed the SRID (EWKB). Requires `flavor: "extended"`. Default false. */
  includeSRID?: boolean;
  /** ISO (default, "more standard" for 3D) or extended (PostGIS EWKB). */
  flavor?: "iso" | "extended";
}

/** Parse WKB / EWKB bytes into a new owned geometry. */
export function fromWKB(geos: Geos, wkb: Uint8Array): Geometry {
  geos.assertOpen("fromWKB");
  const g = geos.native.geos.GEOSWKBReader_read_r(geos.ctx, geos.wkbReader(), wkb, wkb.length);
  return geos.take("GEOSWKBReader_read_r", g as GeomPtr | null);
}

/** WKB bytes of a geometry — a fresh copy, safe to hold and transfer. */
export function toWKB(geos: Geos, g: Geometry, opts: WKBOptions = {}): Uint8Array {
  g.requireSame(geos);
  const ops = geos.native.geos;
  const flavor = opts.flavor ?? "iso";
  if (opts.includeSRID === true && flavor !== "extended") {
    throw new RangeError(
      'toWKB: includeSRID requires flavor "extended" (ISO WKB cannot embed an SRID)',
    );
  }
  const w = ops.GEOSWKBWriter_create_r(geos.ctx);
  if (w === null) throw geos.fail("GEOSWKBWriter_create_r");
  const writer = w as WkbWriterPtr;
  try {
    if (opts.byteOrder !== undefined) {
      ops.GEOSWKBWriter_setByteOrder_r(geos.ctx, writer, byteOrderToId(opts.byteOrder));
    }
    if (opts.outputDimension !== undefined) {
      ops.GEOSWKBWriter_setOutputDimension_r(geos.ctx, writer, opts.outputDimension);
    }
    if (flavor === "extended") {
      ops.GEOSWKBWriter_setFlavor_r(geos.ctx, writer, 1 /* GEOS_WKB_EXTENDED */);
    }
    if (opts.includeSRID === true) {
      ops.GEOSWKBWriter_setIncludeSRID_r(geos.ctx, writer, 1);
    }
    const sizeOut = new BigUint64Array(1);
    const p = ops.GEOSWKBWriter_write_r(geos.ctx, writer, g.ptr, sizeOut);
    if (p === null) throw geos.fail("GEOSWKBWriter_write_r");
    try {
      const size = Number(sizeOut[0]!);
      // Copy at the boundary; the C buffer is freed immediately below.
      const view = new Uint8Array(toArrayBuffer(p, 0, size));
      return view.slice();
    } finally {
      ops.GEOSFree_r(geos.ctx, p);
    }
  } finally {
    ops.GEOSWKBWriter_destroy_r(geos.ctx, writer);
  }
}
