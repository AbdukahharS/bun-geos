/**
 * Phase 0 spike: JS side of the shim slice.
 * Proves D4/D13 — handlers installed in C, messages surfaced as GeosError.
 */
import { dlopen, type Pointer } from "bun:ffi";
import { GEOS_C_PATH, SHIM_PATH } from "./native-paths.ts";

/** Kept for the historic tests that join filenames under it (Phase 0 tree).
 * On the Phase 1 fallback tree those tests use GEOS_C_PATH directly. */
export const LIB_DIR = GEOS_C_PATH.replace(/\/libgeos_c\.so.*$/, "");

/** D13 error type: GEOS message + operation name (+ JS context later). */
export class GeosError extends Error {
  constructor(
    public readonly op: string,
    message: string,
  ) {
    super(`GEOS ${op} failed: ${message}`);
    this.name = "GeosError";
  }
}

/**
 * The prebuilt shim (spike/build/shim.so). Its $ORIGIN RUNPATH resolves the
 * bundled libgeos_c — no LD_LIBRARY_PATH needed. This is the production
 * loading model from docs/design/architecture.md §loader.
 */
export const shim = dlopen(SHIM_PATH, {
  geos_shim_init: { args: [], returns: "ptr" },
  geos_shim_context: { args: ["ptr"], returns: "ptr" },
  geos_shim_finish: { args: ["ptr"], returns: "void" },
  // cstring returns are CORRECT here: the shim hands back pointers into its
  // thread-local buffers (nothing to free). cstring is only wrong for
  // GEOS-OWNED heap returns — those leak (F10).
  geos_shim_last_error: { args: ["ptr"], returns: "cstring" },
  geos_shim_last_notice: { args: ["ptr"], returns: "cstring" },
});

/**
 * The GEOS C API, bound separately (same file the shim already loaded — the
 * dynamic linker dedupes by inode, so both views share one instance).
 * In Phase 1 this is one declarative table in src/symbols.ts covering both.
 */
export const ops = dlopen(GEOS_C_PATH, {
  // cstring (not ptr) for `const char*` args: JS strings then auto-encode to
  // null-terminated UTF-8 for the duration of the call
  GEOSGeomFromWKT_r: { args: ["ptr", "cstring"], returns: "ptr" },
  GEOSGeom_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
});

export interface ShimSession {
  /** Opaque shim wrapper — ONLY for finish/last_error, never for geos_c ops. */
  s: Pointer;
  /** The real GEOSContextHandle_t — pass to every geos_c function. */
  ctx: Pointer;
}

/** Shim-owned context: init installs handlers, finish tears down. */
export function withShim<T>(fn: (h: ShimSession) => T): T {
  const s = shim.symbols.geos_shim_init() as Pointer;
  if (!s) throw new Error("geos_shim_init failed (malloc?)");
  const ctx = shim.symbols.geos_shim_context(s) as Pointer;
  try {
    return fn({ s, ctx });
  } finally {
    shim.symbols.geos_shim_finish(s);
  }
}

/** Read a WKT string; on GEOS failure throw GeosError with the real message. */
export function readWKT(h: ShimSession, wkt: string): Pointer {
  const g = ops.symbols.GEOSGeomFromWKT_r(h.ctx, wkt);
  if (!g) {
    const msg = shim.symbols.geos_shim_last_error(h.s);
    throw new GeosError("GEOSGeomFromWKT_r", msg ?? "(no message captured)");
  }
  return g as Pointer;
}

export function destroy(h: ShimSession, g: Pointer): void {
  ops.symbols.GEOSGeom_destroy_r(h.ctx, g);
}
