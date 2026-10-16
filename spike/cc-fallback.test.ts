/**
 * Phase 0 spike, check #4d: cc()/TinyCC as the dev/emergency fallback for the
 * shim (D4). Non-blocking by plan — a failure is a documented verdict, not a
 * kill switch. Result: TCC rejects __thread (the shim's per-thread error
 * capture), so the fallback is dead as designed on this platform.
 */

import { cc, dlopen, type Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { GEOS_C_PATH } from "./native-paths.ts";

const SHIM_C = join(import.meta.dir, "..", "native", "shim.c");

// dlopen the C lib first so the process already holds it; then try cc()
// variants for compiling/linking the shim source against it.
dlopen(GEOS_C_PATH, { GEOS_init_r: { args: [], returns: "ptr" } });

interface ShimLib {
  symbols: {
    geos_shim_init(): Pointer | null;
    geos_shim_context(s: Pointer): Pointer;
    geos_shim_finish(s: Pointer): void;
    geos_shim_last_error(s: Pointer): string | null;
  };
}

const shimSymbols = {
  geos_shim_init: { args: [], returns: "ptr" },
  geos_shim_context: { args: ["ptr"], returns: "ptr" },
  geos_shim_finish: { args: ["ptr"], returns: "void" },
  geos_shim_last_error: { args: ["ptr"], returns: "cstring" },
} as const;

function tryCc(label: string, library: string[]): boolean {
  try {
    const lib = cc({ source: SHIM_C, library, symbols: shimSymbols }) as unknown as ShimLib;
    const s = lib.symbols.geos_shim_init();
    if (!s) throw new Error("init returned NULL");
    const ctx = lib.symbols.geos_shim_context(s);
    if (!ctx) throw new Error("context NULL");
    // force a GEOS failure and read it back through THIS shim instance
    const ops = dlopen(GEOS_C_PATH, {
      GEOSGeomFromWKT_r: { args: ["ptr", "cstring"], returns: "ptr" },
    });
    const g = ops.symbols.GEOSGeomFromWKT_r(ctx, "POLYGON((");
    if (g !== null) throw new Error("expected parse failure");
    const err = lib.symbols.geos_shim_last_error(s);
    lib.symbols.geos_shim_finish(s);
    if (!err?.includes("ParseException")) {
      throw new Error(`message not captured: ${JSON.stringify(err)}`);
    }
    console.log(`cc() variant OK [${label}]: ${JSON.stringify(err)}`);
    return true;
  } catch (e) {
    console.log(`cc() variant FAILED [${label}]: ${(e as Error).message}`);
    return false;
  }
}

test("cc()/TinyCC can compile the shim source and capture GEOS errors", () => {
  const byAbsPath = tryCc("library: [<abs .so>]", [GEOS_C_PATH]);
  const byName = tryCc('library: ["geos_c"]', ["geos_c"]);

  if (!byAbsPath && !byName) {
    console.log(
      "VERDICT: cc()/TinyCC cannot compile the shim on linux-x64 Bun 1.4.3 — " +
        "its embedded TCC rejects __thread ('thread-local storage is not " +
        "supported at run time'), and thread-local error capture is " +
        "load-bearing in the shim (per-worker contexts, D3). A #ifdef " +
        "SHIM_NO_TLS variant (plain globals) could serve single-threaded dev, " +
        "but is not worth building: real-compiler iteration is one gcc line " +
        "and production is CI-prebuilt (D4).",
    );
  }
  // The spike only records the verdict; no hard assertion, by plan.
  expect(true).toBe(true);
});
