/**
 * Phase 0 spike, addendum: bun:ffi string-return semantics on Bun 1.4.x.
 *
 * Bun 1.4.0 rebuilt bun:ffi engine-native (inside JavaScriptCore, replacing
 * the TinyCC thunks) and changed `cstring` returns: they are now plain
 * strings (NULL → null), and `new CString(ptr)` no longer carries
 * `.ptr`/`.byteLength`/`.arrayBuffer`. Consequence for `src/symbols.ts`,
 * verified here (F10): a `returns: "cstring"` binding on a GEOS-OWNED
 * buffer (freed with `GEOSFree`) leaks it — the engine clones the string
 * and can never call GEOSFree. Owned-buffer returns must be bound
 * `returns: "ptr"` + `new CString(ptr)` + `GEOSFree_r`; `cstring` remains
 * correct only for no-free strings (statics like `GEOSversion`, or the
 * shim's thread-local buffers).
 *
 * Method: GEOSGeomToWKT_r on a ~1000-vertex polygon emits a ~36 KB buffer
 * per call. If the engine does not free it, RSS grows ~180 MB per epoch;
 * if it does (or we free it), the same allocator chunk recycles and RSS
 * flatlines — same methodology as soak.test.ts.
 *
 * Verdicts feed F10 in docs/research/spike-results.md.
 */

import { CString, dlopen, type Pointer } from "bun:ffi";
import { expect, test } from "bun:test";
import { gc } from "bun";
import { type Ctx, lib, polygonFromXY, withContext } from "./lib.ts";
import { GEOS_C_PATH } from "./native-paths.ts";
import { shim, withShim } from "./shim.ts";

/** Same libgeos_c, two binding namespaces (dlopen dedupes by inode). */
const STR_LIB = GEOS_C_PATH;
const strCstr = dlopen(STR_LIB, {
  GEOSGeomToWKT_r: { args: ["ptr", "ptr"], returns: "cstring" },
});
const strPtr = dlopen(STR_LIB, {
  GEOSGeomToWKT_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSFree_r: { args: ["ptr", "ptr"], returns: "void" },
});

const rssMB = (): number => process.memoryUsage().rss / 1048576;

/** Small closed triangle — the roundtrip golden. */
const TRI_XY = new Float64Array([1, 1, 3, 1, 1, 3, 1, 1]);

/** ~1000-vertex closed ring → ~36 KB of WKT text per write. */
const BIG_N = 1000;
const BIG_XY = new Float64Array(BIG_N * 2);
for (let i = 0; i < BIG_N; i++) {
  const t = (i / (BIG_N - 1)) * 2 * Math.PI;
  BIG_XY[2 * i] = 1000 + Math.cos(t) * 100;
  BIG_XY[2 * i + 1] = 1000 + Math.sin(t) * 100;
}
BIG_XY[2 * (BIG_N - 1)] = BIG_XY[0]!; // exact ring closure
BIG_XY[2 * (BIG_N - 1) + 1] = BIG_XY[1]!;

/** The 1.4 breaking change, asserted directly: no CString accessors. */
function expectPlainString(s: string): void {
  expect(typeof s).toBe("string");
  const probe = s as unknown as {
    ptr?: unknown;
    byteLength?: unknown;
    arrayBuffer?: unknown;
  };
  expect(probe.ptr).toBeUndefined();
  expect(probe.byteLength).toBeUndefined();
  expect(probe.arrayBuffer).toBeUndefined();
}

test("returns:'cstring' yields a plain string with no pointer accessors", () => {
  withContext((ctx) => {
    const poly = polygonFromXY(ctx, TRI_XY);
    const s = strCstr.symbols.GEOSGeomToWKT_r(ctx, poly);
    lib.symbols.GEOSGeom_destroy_r(ctx, poly);
    if (s === null) throw new Error("unexpected null WKT for a valid polygon");
    expectPlainString(s);
    expect(s.startsWith("POLYGON")).toBe(true);
  });
});

test("NULL pointer return arrives as JS null (fresh shim, no error yet)", () => {
  withShim((h) => {
    // geos_shim_last_error returns NULL when nothing has been captured;
    // declared returns:"cstring" → the engine must surface null (not 0)
    expect(shim.symbols.geos_shim_last_error(h.s)).toBe(null);
  });
});

test("new CString(ptr) returns a string; the kept pointer is still GEOSFree-able", () => {
  withContext((ctx) => {
    const poly = polygonFromXY(ctx, TRI_XY);
    const ptr = strPtr.symbols.GEOSGeomToWKT_r(ctx, poly) as Pointer;
    lib.symbols.GEOSGeom_destroy_r(ctx, poly);
    if (!ptr) throw new Error("GEOSGeomToWKT_ptr returned null"); // failed ptr returns are null (F6)
    expectPlainString(new CString(ptr)); // string VIEW — the C buffer is untouched
    strPtr.symbols.GEOSFree_r(ctx, ptr); // the documented pattern: free via the ptr you kept
  });
});

const WARM = 2_000;
const N = 6_000;
const EPOCH = 2_000;
/** No-leak RSS noise is single-digit MB; a leak is ≥ ~88 MB/epoch. */
const NO_LEAK_MB = 40;
const LEAK_MB = 120;

function soakWKT(label: string, call: (ctx: Ctx, poly: Pointer) => void): number {
  return withContext((ctx) => {
    const poly = polygonFromXY(ctx, BIG_XY);
    for (let i = 0; i < WARM; i++) call(ctx, poly);
    gc(true); // force full GC (from "bun") so warmup churn doesn't count as growth
    const rss = [rssMB()];
    for (let i = 1; i <= N; i++) {
      call(ctx, poly);
      if (i % EPOCH === 0) rss.push(rssMB());
    }
    lib.symbols.GEOSGeom_destroy_r(ctx, poly);
    const deltas = rss.slice(1).map((r, i) => r - rss[i]!);
    const total = rss[rss.length - 1]! - rss[0]!;
    console.log(
      `leak-check[${label}]: RSS deltas/epoch (MB) over ${N} writes: ` +
        deltas.map((d) => d.toFixed(1)).join(", ") +
        ` → total ${total.toFixed(1)} MB`,
    );
    return total;
  });
}

test(
  "VERDICT: returns:'cstring' on a GEOS-owned buffer LEAKS it (engine can't GEOSFree)",
  () => {
    const total = soakWKT("cstring", (ctx, poly) => {
      void strCstr.symbols.GEOSGeomToWKT_r(ctx, poly);
    });
    // Guarded verdict (F10): the engine clones the string but never frees the
    // C buffer. If a future Bun stops leaking, this trips — re-verify, then
    // relax the symbols.ts rule (and celebrate).
    expect(total).toBeGreaterThan(LEAK_MB);
  },
  { timeout: 60_000 },
);

test(
  "RULE: returns:'ptr' + new CString + GEOSFree_r does not leak",
  () => {
    const total = soakWKT("ptr+free", (ctx, poly) => {
      const ptr = strPtr.symbols.GEOSGeomToWKT_r(ctx, poly) as Pointer;
      const s = new CString(ptr);
      if (!s.startsWith("POLYGON")) throw new Error("bad WKT view");
      strPtr.symbols.GEOSFree_r(ctx, ptr);
    });
    expect(total).toBeLessThan(NO_LEAK_MB);
  },
  { timeout: 60_000 },
);
