/**
 * `Prepared` — GEOS 3.13 RelateNG prepared geometry (api-surface §Prepared):
 * an indexed structure over one source geometry that makes repeated
 * predicate tests dramatically faster. Since 3.13 every predicate — and the
 * full DE-9IM (`relate`/`relatePattern`) — is available prepared.
 *
 * Lifecycle (D17): the prepared structure references the source geometry's
 * C memory, so creation pins the source (arena ownership is relinquished)
 * and disposal order is enforced — dispose the `Prepared` first, then the
 * source. Batch masks (`*All`) run as ONE shim crossing per array (D18),
 * never a JS loop over singulars.
 */
import { CString } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { OpOptions } from "../interrupt.ts";
import { abortError, withSignal } from "../interrupt.ts";
import { charResult } from "../ops/predicates.ts";
import { geomPtrArray } from "../ptrs.ts";
import type { GeomPtr, PreparedPtr } from "../types.ts";
import { PreparedPred } from "../types.ts";

interface PredSpec {
  id: number;
  op: string;
}

/** Names ↔ shim predId ↔ C symbol. Ids MUST match `PreparedPred`/`SHIM_PREP_*`. */
const PREPS = {
  intersects: { id: PreparedPred.intersects, op: "GEOSPreparedIntersects_r" },
  contains: { id: PreparedPred.contains, op: "GEOSPreparedContains_r" },
  containsProperly: { id: PreparedPred.containsProperly, op: "GEOSPreparedContainsProperly_r" },
  coveredBy: { id: PreparedPred.coveredBy, op: "GEOSPreparedCoveredBy_r" },
  covers: { id: PreparedPred.covers, op: "GEOSPreparedCovers_r" },
  crosses: { id: PreparedPred.crosses, op: "GEOSPreparedCrosses_r" },
  disjoint: { id: PreparedPred.disjoint, op: "GEOSPreparedDisjoint_r" },
  overlaps: { id: PreparedPred.overlaps, op: "GEOSPreparedOverlaps_r" },
  touches: { id: PreparedPred.touches, op: "GEOSPreparedTouches_r" },
  within: { id: PreparedPred.within, op: "GEOSPreparedWithin_r" },
} as const satisfies Record<string, PredSpec>;

type PredName = keyof typeof PREPS;

type PredFn = (geos: Geos, pg: PreparedPtr, g: GeomPtr) => number;

const SINGULAR: Record<PredName, PredFn> = {
  intersects: (g, pg, a) => g.native.geos.GEOSPreparedIntersects_r(g.ctx, pg, a),
  contains: (g, pg, a) => g.native.geos.GEOSPreparedContains_r(g.ctx, pg, a),
  containsProperly: (g, pg, a) => g.native.geos.GEOSPreparedContainsProperly_r(g.ctx, pg, a),
  coveredBy: (g, pg, a) => g.native.geos.GEOSPreparedCoveredBy_r(g.ctx, pg, a),
  covers: (g, pg, a) => g.native.geos.GEOSPreparedCovers_r(g.ctx, pg, a),
  crosses: (g, pg, a) => g.native.geos.GEOSPreparedCrosses_r(g.ctx, pg, a),
  disjoint: (g, pg, a) => g.native.geos.GEOSPreparedDisjoint_r(g.ctx, pg, a),
  overlaps: (g, pg, a) => g.native.geos.GEOSPreparedOverlaps_r(g.ctx, pg, a),
  touches: (g, pg, a) => g.native.geos.GEOSPreparedTouches_r(g.ctx, pg, a),
  within: (g, pg, a) => g.native.geos.GEOSPreparedWithin_r(g.ctx, pg, a),
};

export class Prepared implements Disposable {
  readonly geos: Geos;
  readonly ptr: PreparedPtr;
  /** The indexed geometry — strongly held (it must outlive this object). */
  readonly source: Geometry;

  #disposed = false;

  /** @internal — create via `geometry.prepare()`. */
  constructor(geos: Geos, source: Geometry) {
    source.requireSame(geos);
    const p = geos.native.geos.GEOSPrepare_r(geos.ctx, source.ptr);
    if (p === null) throw geos.fail("GEOSPrepare_r");
    this.geos = geos;
    this.ptr = p as PreparedPtr;
    this.source = source;
    source.pinBy(this); // D17: arena relinquishes; source disposal blocked
    geos.registerConsumable(this);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  #assertOpen(what: string): void {
    if (this.#disposed) {
      throw new TypeError(`bun-geos: Prepared used after dispose (in ${what})`);
    }
    this.geos.assertOpen(what);
  }

  #test(name: PredName, b: Geometry): boolean {
    this.#assertOpen(PREPS[name].op);
    b.requireSame(this.geos);
    return charResult(this.geos, PREPS[name].op, SINGULAR[name](this.geos, this.ptr, b.ptr));
  }

  intersects(b: Geometry): boolean {
    return this.#test("intersects", b);
  }
  contains(b: Geometry): boolean {
    return this.#test("contains", b);
  }
  containsProperly(b: Geometry): boolean {
    return this.#test("containsProperly", b);
  }
  coveredBy(b: Geometry): boolean {
    return this.#test("coveredBy", b);
  }
  covers(b: Geometry): boolean {
    return this.#test("covers", b);
  }
  crosses(b: Geometry): boolean {
    return this.#test("crosses", b);
  }
  disjoint(b: Geometry): boolean {
    return this.#test("disjoint", b);
  }
  overlaps(b: Geometry): boolean {
    return this.#test("overlaps", b);
  }
  touches(b: Geometry): boolean {
    return this.#test("touches", b);
  }
  within(b: Geometry): boolean {
    return this.#test("within", b);
  }

  /** Point-coordinate fast paths (no geometry allocation needed). */
  intersectsXY(x: number, y: number): boolean {
    this.#assertOpen("GEOSPreparedIntersectsXY_r");
    return charResult(
      this.geos,
      "GEOSPreparedIntersectsXY_r",
      this.geos.native.geos.GEOSPreparedIntersectsXY_r(this.geos.ctx, this.ptr, x, y),
    );
  }

  containsXY(x: number, y: number): boolean {
    this.#assertOpen("GEOSPreparedContainsXY_r");
    return charResult(
      this.geos,
      "GEOSPreparedContainsXY_r",
      this.geos.native.geos.GEOSPreparedContainsXY_r(this.geos.ctx, this.ptr, x, y),
    );
  }

  /** Full DE-9IM matrix, prepared (GEOS-owned string → CString + GEOSFree, F10). */
  relate(b: Geometry): string {
    this.#assertOpen("GEOSPreparedRelate_r");
    b.requireSame(this.geos);
    const p = this.geos.native.geos.GEOSPreparedRelate_r(this.geos.ctx, this.ptr, b.ptr);
    if (p === null) throw this.geos.fail("GEOSPreparedRelate_r");
    try {
      return new CString(p);
    } finally {
      this.geos.native.geos.GEOSFree_r(this.geos.ctx, p);
    }
  }

  relatePattern(b: Geometry, pattern: string): boolean {
    this.#assertOpen("GEOSPreparedRelatePattern_r");
    b.requireSame(this.geos);
    const r = this.geos.native.geos.GEOSPreparedRelatePattern_r(
      this.geos.ctx,
      this.ptr,
      b.ptr,
      pattern,
    );
    return charResult(this.geos, "GEOSPreparedRelatePattern_r", r);
  }

  // ------------------------------------------------------------- batch masks

  /**
   * One shim crossing per array (D18): C loop over the prepared predicate,
   * 0/1 into a `Uint8Array`. First GEOS exception aborts with the captured
   * message — no partial masks. Interrupt-aware between items: when a
   * signal was supplied, an interruption shapes as `op: "aborted"` — the
   * SAME contract as singular ops (audited inconsistency, fixed).
   */
  #all(name: PredName, bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return withSignal(this.geos, opts?.signal, () => {
      this.#assertOpen(PREPS[name].op);
      const ptrs = geomPtrArray(this.geos, bs, `${PREPS[name].op} (batch)`);
      const out = new Uint8Array(bs.length);
      const r = this.geos.native.shim.geos_shim_prepared_pred_all(
        this.geos.shim,
        this.ptr,
        PREPS[name].id,
        ptrs,
        bs.length,
        out,
      );
      if (r !== 0) {
        const underlying = this.geos.fail(PREPS[name].op);
        if (r === 2 && opts?.signal !== undefined) throw abortError(opts.signal, underlying);
        throw underlying;
      }
      return out;
    });
  }

  intersectsAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("intersects", bs, opts);
  }
  containsAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("contains", bs, opts);
  }
  containsProperlyAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("containsProperly", bs, opts);
  }
  coveredByAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("coveredBy", bs, opts);
  }
  coversAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("covers", bs, opts);
  }
  crossesAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("crosses", bs, opts);
  }
  disjointAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("disjoint", bs, opts);
  }
  overlapsAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("overlaps", bs, opts);
  }
  touchesAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("touches", bs, opts);
  }
  withinAll(bs: readonly Geometry[], opts?: OpOptions): Uint8Array {
    return this.#all("within", bs, opts);
  }

  relatePatternAll(bs: readonly Geometry[], pattern: string, opts?: OpOptions): Uint8Array {
    return withSignal(this.geos, opts?.signal, () => {
      this.#assertOpen("GEOSPreparedRelatePattern_r");
      const ptrs = geomPtrArray(this.geos, bs, "GEOSPreparedRelatePattern_r (batch)");
      const out = new Uint8Array(bs.length);
      const r = this.geos.native.shim.geos_shim_prepared_relate_pattern_all(
        this.geos.shim,
        this.ptr,
        ptrs,
        bs.length,
        pattern,
        out,
      );
      if (r !== 0) {
        const underlying = this.geos.fail("GEOSPreparedRelatePattern_r");
        if (r === 2 && opts?.signal !== undefined) throw abortError(opts.signal, underlying);
        throw underlying;
      }
      return out;
    });
  }

  // ---------------------------------------------------------------- disposal

  /** Dispose order (D17): this first, the source geometry after. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.geos.unregisterConsumable(this);
    this.source.unpinBy(this);
    this.geos.native.geos.GEOSPreparedGeom_destroy_r(this.geos.ctx, this.ptr);
  }

  dispose(): void {
    this[Symbol.dispose]();
  }
}
