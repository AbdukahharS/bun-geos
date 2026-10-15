/**
 * Phase 0 spike, check #3: the error path (kill-switch #2).
 * A real GEOS failure must surface its message through a thrown GeosError.
 */

import { CString, dlopen, JSCallback, type Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { GeosError, LIB_DIR, readWKT, shim, withShim } from "./shim.ts";

const GEOS_C = join(LIB_DIR, "libgeos_c.so.1.20.5");

test("error path: malformed WKT → GeosError carries the GEOS message", () => {
  withShim((h) => {
    expect(() => readWKT(h, "POLYGON((0 0, 1 0, 1 1, 0 0")).toThrow(GeosError);
    try {
      readWKT(h, "POLYGON((0 0, 1 0, 1 1, 0 0");
    } catch (e) {
      const err = e as GeosError;
      expect(err.name).toBe("GeosError");
      expect(err.op).toBe("GEOSGeomFromWKT_r");
      // the load-bearing assertion: GEOS's own words made it through the
      // variadic handler → thread-local buffer → thrown JS error
      expect(err.message.length).toBeGreaterThan(10);
      expect(err.message).toMatch(/[Pp]arse|[Uu]nexpected|[Ee]rror/);
    }
  });
});

test("messages differ per failure and are consumed on read (no stale errors)", () => {
  withShim((h) => {
    let m1 = "";
    try {
      readWKT(h, "POLYGON((0 0, 1 0, 1 1, 0 0");
    } catch (e) {
      m1 = (e as GeosError).message;
    }
    expect(m1.length).toBeGreaterThan(10);
    // consumed by the read inside readWKT
    expect(shim.symbols.geos_shim_last_error(h.s)).toBeNull();

    let m2 = "";
    try {
      readWKT(h, "BEGIN geography");
    } catch (e) {
      m2 = (e as GeosError).message;
    }
    expect(m2.length).toBeGreaterThan(10);
    expect(m2).not.toBe(m1);
  });
});

test("baseline without shim: message is lost (only NULL return reaches JS)", () => {
  // no shim → GEOS's default handler prints to stderr; JS sees only NULL.
  // This stderr noise is exactly what D4 exists to prevent.
  const plain = dlopen(GEOS_C, {
    GEOS_init_r: { args: [], returns: "ptr" },
    GEOS_finish_r: { args: ["ptr"], returns: "void" },
    GEOSGeomFromWKT_r: { args: ["ptr", "cstring"], returns: "ptr" },
  });
  const c = plain.symbols.GEOS_init_r();
  try {
    const g = plain.symbols.GEOSGeomFromWKT_r(c, "POLYGON((");
    expect(g).toBeNull(); // failure signaled, but the *why* never reached JS
  } finally {
    plain.symbols.GEOS_finish_r(c);
  }
});

test("INFORMATIONAL: JSCallback as variadic handler — works in practice? (D4 decision input)", () => {
  // The C standard says a non-variadic function invoked through a variadic
  // call site is UB (SysV: caller must set %al). bun:ffi cannot even
  // *declare* the variadic signature. This documents what actually happens
  // on this machine — it does not change the D4 decision (shim stands).
  const plain = dlopen(GEOS_C, {
    GEOS_init_r: { args: [], returns: "ptr" },
    GEOS_finish_r: { args: ["ptr"], returns: "void" },
    GEOSContext_setErrorHandler_r: { args: ["ptr", "ptr"], returns: "void" },
    GEOSGeomFromWKT_r: { args: ["ptr", "cstring"], returns: "ptr" },
  });
  const c = plain.symbols.GEOS_init_r();
  let captured: string | null = null;
  const cb = new JSCallback(
    (fmt: Pointer) => {
      captured = new CString(fmt);
    },
    { args: ["ptr"], returns: "void" },
  );
  try {
    plain.symbols.GEOSContext_setErrorHandler_r(c, cb.ptr);
    const g = plain.symbols.GEOSGeomFromWKT_r(c, "POLYGON((");
    expect(g).toBeNull();
    console.log(`JSCallback experiment: captured=${JSON.stringify(captured)}`);
  } finally {
    cb.close();
    plain.symbols.GEOS_finish_r(c);
  }
});
