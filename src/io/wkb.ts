/**
 * WKB I/O (io.md §4). Native reader/writer, one crossing per geometry.
 * Reading accepts ISO WKB and PostGIS EWKB (SRID rides along natively via
 * `GEOSGetSRID_r` — verified present in 3.14's geos_c.h; io.md's
 * "no SRID storage" side-channel note is outdated and was dropped).
 * Writing ALWAYS copies at the boundary — a returned `Uint8Array` never
 * aliases C memory (memory.md pitfall table).
 */
import { toArrayBuffer } from "bun:ffi";
import type { Arena } from "../arena.ts";
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

/** Options for the batch WKB read (io.md §4). */
export interface FromWKBManyOptions {
  /** Register outputs with this arena instead of the innermost open one. */
  arena?: Arena;
}

/**
 * Batch WKB ingest (Phase 3, shim.md §2 sketch): n geometries from one
 * buffer in ONE shim crossing — the fast path for PostGIS-scale dumps.
 * `offsets[i]` is the end-byte of geometry i (offsets[0] = end of the
 * first), strictly increasing, last ≤ wkb.length (validated here — C has
 * no length info; an over-large offset would read out of bounds).
 * Failures are all-or-nothing (D22).
 */
export function fromWKBMany(
  geos: Geos,
  wkb: Uint8Array,
  offsets: Uint32Array,
  opts: FromWKBManyOptions = {},
): Geometry[] {
  geos.assertOpen("fromWKBMany");
  if (offsets.length === 0) return [];
  let prev = 0;
  for (let i = 0; i < offsets.length; i++) {
    const end = offsets[i]!;
    if (end <= prev) {
      throw new RangeError(
        `fromWKBMany: offsets must be strictly increasing (offsets[${i}] = ${end} <= ${prev})`,
      );
    }
    if (end > wkb.length) {
      throw new RangeError(
        `fromWKBMany: offsets[${i}] = ${end} exceeds the buffer length ${wkb.length}`,
      );
    }
    prev = end;
  }
  const out = new BigUint64Array(offsets.length);
  const r = geos.native.shim.geos_shim_read_wkb_many(
    geos.shim,
    geos.wkbReader(),
    wkb,
    offsets,
    offsets.length,
    out,
  );
  if (r !== 0) throw geos.fail("geos_shim_read_wkb_many");
  return geos.takeMany("geos_shim_read_wkb_many", out, opts.arena ?? geos.currentArena());
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
    configureWriter(geos, writer, opts);
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

/** Apply WKBOptions to a writer (factored so the batch path can set once). */
function configureWriter(geos: Geos, writer: WkbWriterPtr, opts: WKBOptions): void {
  const ops = geos.native.geos;
  if (opts.byteOrder !== undefined) {
    ops.GEOSWKBWriter_setByteOrder_r(geos.ctx, writer, byteOrderToId(opts.byteOrder));
  }
  if (opts.outputDimension !== undefined) {
    ops.GEOSWKBWriter_setOutputDimension_r(geos.ctx, writer, opts.outputDimension);
  }
  if ((opts.flavor ?? "iso") === "extended") {
    ops.GEOSWKBWriter_setFlavor_r(geos.ctx, writer, 1 /* GEOS_WKB_EXTENDED */);
  }
  if (opts.includeSRID === true) {
    ops.GEOSWKBWriter_setIncludeSRID_r(geos.ctx, writer, 1);
  }
}

export interface WkbManyBytes {
  buf: Uint8Array;
  offsets: Uint32Array;
}

/**
 * Serialize n geometries into ONE buffer with ONE writer (Phase 3, D23):
 * writer creation/destruction amortizes over the batch — the pool's chunk
 * serialization was paying 100k create/destroy pairs per op (measured as
 * the floor of the ≥5× parallel axis). Same boundary rule as `toWKB`: the
 * returned buffer never aliases C memory. Default options (native byte
 * order, dim 2, ISO) — the pool's transfer currency needs no options.
 */
export function wkbManyBytes(geos: Geos, gs: readonly Geometry[]): WkbManyBytes {
  geos.assertOpen("wkbManyBytes");
  const ops = geos.native.geos;
  const w = ops.GEOSWKBWriter_create_r(geos.ctx);
  if (w === null) throw geos.fail("GEOSWKBWriter_create_r");
  const writer = w as WkbWriterPtr;
  try {
    configureWriter(geos, writer, {});
    const bufParts: Array<[Uint8Array, number]> = [];
    const offsets = new Uint32Array(gs.length);
    const sizeOut = new BigUint64Array(1);
    let total = 0;
    for (let i = 0; i < gs.length; i++) {
      const p = ops.GEOSWKBWriter_write_r(geos.ctx, writer, gs[i]!.ptr, sizeOut);
      if (p === null) throw geos.fail("GEOSWKBWriter_write_r");
      try {
        const size = Number(sizeOut[0]!);
        const view = new Uint8Array(toArrayBuffer(p, 0, size));
        bufParts.push([view.slice(), size]); // boundary copy (never alias C)
        total += size;
        offsets[i] = total;
      } finally {
        ops.GEOSFree_r(geos.ctx, p);
      }
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const [part, size] of bufParts) {
      buf.set(part, off);
      off += size;
    }
    return { buf, offsets };
  } finally {
    ops.GEOSWKBWriter_destroy_r(geos.ctx, writer);
  }
}
