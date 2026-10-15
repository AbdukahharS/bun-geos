/**
 * Phase 0 spike: minimal `_r`-only binding to the locally built GEOS 3.14.1.
 * Throwaway — the real symbol table (`src/symbols.ts`) graduates from this.
 */
import { CString, dlopen, type Pointer } from "bun:ffi";
import { join } from "node:path";

const LIB_DIR = join(import.meta.dir, "build", "geos-install", "lib");

/**
 * dlopen the C API library directly (no shim). The install-tree libs carry
 * their own $ORIGIN RPATH (patchelf'd in spike setup — mirroring what the
 * Phase 4 packaging will do), so the transitive `libgeos.so` dependency
 * resolves without LD_LIBRARY_PATH.
 */
export const lib = dlopen(join(LIB_DIR, "libgeos_c.so.1.20.5"), {
  // context lifecycle
  GEOS_init_r: { args: [], returns: "ptr" },
  GEOS_finish_r: { args: ["ptr"], returns: "void" },
  // NOTE: GEOSversion is the one function with no _r variant (process-global,
  // returns a static string — nothing to free). That is exactly why the
  // `cstring` return is safe here; GEOS-OWNED buffers must NOT use cstring
  // (the engine cannot GEOSFree them — leak; see F10 / cstring-semantics.test).
  GEOSversion: { args: [], returns: "cstring" },

  // flat-buffer coordinate sequences (the D9 canonical currency)
  GEOSCoordSeq_copyFromBuffer_r: {
    args: ["ptr", "ptr", "u32", "i32", "i32"],
    returns: "ptr",
  },
  GEOSCoordSeq_copyToBuffer_r: {
    args: ["ptr", "ptr", "ptr", "i32", "i32"],
    returns: "void",
  },
  GEOSCoordSeq_getSize_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },

  // construction (GEOS takes ownership of the coordseq / rings)
  GEOSGeom_createLinearRing_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeom_createPolygon_r: { args: ["ptr", "ptr", "ptr", "u32"], returns: "ptr" },

  // accessors (borrowed pointers — never destroy these)
  GEOSGeom_getCoordSeq_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGetExteriorRing_r: { args: ["ptr", "ptr"], returns: "ptr" },

  // overlay + measures
  GEOSIntersection_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSArea_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },

  // GEOS-OWNED return (caller must GEOSFree): bind returns:"ptr" — under the
  // 1.4 engine-native FFI, a cstring return clones to a JS string and the
  // buffer leaks (F10). Read via new CString(ptr), then GEOSFree_r the ptr.
  GEOSGeomToWKT_r: { args: ["ptr", "ptr"], returns: "ptr" },

  // teardown (owned objects only)
  GEOSGeom_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSCoordSeq_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSFree_r: { args: ["ptr", "ptr"], returns: "void" },
});

export type Ctx = Pointer;

/** RAII-ish context helper (the real `Geos` class is Phase 1). */
export function withContext<T>(fn: (ctx: Ctx) => T): T {
  const ctx = lib.symbols.GEOS_init_r() as Ctx;
  try {
    return fn(ctx);
  } finally {
    lib.symbols.GEOS_finish_r(ctx);
  }
}

/**
 * Build a closed polygon (no holes) from a flat interleaved XY buffer.
 * The caller owns the returned GEOSGeometry* (destroy with GEOSGeom_destroy_r).
 * Ownership: GEOS consumes the coordseq/ring on success; the spike does not
 * attempt to recover from NULL returns (leak on error path is acceptable here).
 */
export function polygonFromXY(ctx: Ctx, xy: Float64Array): Pointer {
  const cs = lib.symbols.GEOSCoordSeq_copyFromBuffer_r(ctx, xy, xy.length / 2, 0, 0) as Pointer;
  if (!cs) throw new Error("GEOSCoordSeq_copyFromBuffer_r returned NULL");
  const ring = lib.symbols.GEOSGeom_createLinearRing_r(ctx, cs) as Pointer;
  if (!ring) throw new Error("GEOSGeom_createLinearRing_r returned NULL");
  const poly = lib.symbols.GEOSGeom_createPolygon_r(ctx, ring, 0, 0) as Pointer;
  if (!poly) throw new Error("GEOSGeom_createPolygon_r returned NULL");
  return poly;
}

/** Exterior ring coordinates of a polygon, copied back to a flat buffer. */
export function exteriorRingXY(ctx: Ctx, poly: Pointer): Float64Array {
  const ring = lib.symbols.GEOSGetExteriorRing_r(ctx, poly) as Pointer;
  if (!ring) throw new Error("GEOSGetExteriorRing_r returned NULL");
  const cs = lib.symbols.GEOSGeom_getCoordSeq_r(ctx, ring) as Pointer;
  if (!cs) throw new Error("GEOSGeom_getCoordSeq_r returned NULL");
  const sizeOut = new Uint32Array(1);
  if (!lib.symbols.GEOSCoordSeq_getSize_r(ctx, cs, sizeOut)) {
    throw new Error("GEOSCoordSeq_getSize_r failed");
  }
  const n = sizeOut[0]!;
  const out = new Float64Array(n * 2);
  lib.symbols.GEOSCoordSeq_copyToBuffer_r(ctx, cs, out, 0, 0);
  return out;
}

/** Area of a geometry via GEOSArea_r (returns 0 when GEOS reports failure). */
export function area(ctx: Ctx, g: Pointer): number {
  const out = new Float64Array(1);
  const ok = lib.symbols.GEOSArea_r(ctx, g, out);
  return ok ? out[0]! : NaN;
}

/**
 * WKT of a geometry. GEOS owns the returned buffer, so the binding is
 * returns:"ptr" and this helper views it with CString and frees it with
 * GEOSFree_r (the F10 rule that src/symbols.ts graduates).
 */
export function toWKT(ctx: Ctx, g: Pointer): string {
  const ptr = lib.symbols.GEOSGeomToWKT_r(ctx, g) as Pointer;
  if (!ptr) throw new Error("GEOSGeomToWKT_r returned NULL");
  const s = new CString(ptr);
  lib.symbols.GEOSFree_r(ctx, ptr);
  return s;
}

/** Deterministic PRNG so property tests are reproducible across runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
