/**
 * Coverage algebra (ROADMAP Phase 2 repair suite, api-surface §Topology
 * repair): `coverageIsValid`, `coverageClean`, `coverageSimplifyVW`.
 *
 * The C entries take ONE geometry — a collection of the coverage members —
 * and return a collection (or an aligned error-edge collection). The
 * wrapper normalizes `Geometry[]` input through the shim's
 * `clone_collect` (one crossing, clone loop in C), and clones output
 * members out as OWNED geometries (D21: borrowed views would need a
 * strongly-reachable parent collection, which the WeakRef-view design
 * cannot promise). Temporary collections are destroyed via
 * `Geos.destroyRaw` — the sanctioned unregistered-temporary path.
 */
import type { Arena } from "../arena.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { geomPtrArray, ptrOf } from "../ptrs.ts";
import type { GeomPtr } from "../types.ts";
import { OverlapMergeStrategy } from "../types.ts";

export interface CoverageValidity {
  valid: boolean;
  /**
   * Error-edge MULTILINESTRINGs aligned with the input (owned; EMPTY where a
   * polygon participates validly). Present only when invalid.
   */
  errorEdges?: Geometry[];
}

export interface CoverageIsValidOptions {
  /** Maximum width of gaps to detect. Default 0 (exact edges). */
  gapWidth?: number;
}

/** Validate a polygonal coverage (GEOSCoverageIsValid). */
export function coverageIsValid(
  geos: Geos,
  gs: readonly Geometry[],
  opts: CoverageIsValidOptions = {},
): CoverageValidity {
  geos.assertOpen("coverageIsValid()");
  if (gs.length === 0) throw new RangeError("coverageIsValid: needs at least one geometry");
  const coll = collectClone(geos, gs);
  try {
    const edgesOut = new BigUint64Array(1);
    const r =
      geos.native.geos.GEOSCoverageIsValid_r(geos.ctx, coll, opts.gapWidth ?? 0, edgesOut) & 0xff;
    if (r === 2) throw geos.fail("GEOSCoverageIsValid_r");
    if (r === 1 || edgesOut[0] === 0n) return { valid: r === 1 };
    const edgesColl = ptrOf(edgesOut[0]!) as unknown as GeomPtr;
    let edges: Geometry[];
    try {
      edges = cloneMembers(geos, edgesColl, "GEOSCoverageIsValid_r");
    } finally {
      geos.destroyRaw(edgesColl);
    }
    return { valid: false, errorEdges: edges };
  } finally {
    geos.destroyRaw(coll);
  }
}

export interface CoverageCleanOptions {
  /** Snap vertices within this distance before cleaning. */
  snappingDistance?: number;
  /** Remove gaps narrower than this. */
  gapMaximumWidth?: number;
  /** Which neighbour absorbs an overlap. Default "longestBorder". */
  overlapStrategy?: keyof typeof OverlapMergeStrategy;
  /** Arena for the returned geometries (default: innermost open). */
  arena?: Arena;
}

/** Clean small gaps/overlaps out of a polygonal coverage (3.14). */
export function coverageClean(
  geos: Geos,
  gs: readonly Geometry[],
  opts: CoverageCleanOptions = {},
): Geometry[] {
  geos.assertOpen("coverageClean()");
  if (gs.length === 0) throw new RangeError("coverageClean: needs at least one geometry");
  const p = geos.coverageCleanParams(); // pooled; values re-set per call
  const ops = geos.native.geos;
  if (opts.snappingDistance !== undefined) {
    if (
      ops.GEOSCoverageCleanParams_setSnappingDistance_r(geos.ctx, p, opts.snappingDistance) === 0
    ) {
      throw geos.fail("GEOSCoverageCleanParams_setSnappingDistance_r");
    }
  }
  if (opts.gapMaximumWidth !== undefined) {
    if (ops.GEOSCoverageCleanParams_setGapMaximumWidth_r(geos.ctx, p, opts.gapMaximumWidth) === 0) {
      throw geos.fail("GEOSCoverageCleanParams_setGapMaximumWidth_r");
    }
  }
  if (opts.overlapStrategy !== undefined) {
    const id = OverlapMergeStrategy[opts.overlapStrategy];
    if (ops.GEOSCoverageCleanParams_setOverlapMergeStrategy_r(geos.ctx, p, id) === 0) {
      throw geos.fail("GEOSCoverageCleanParams_setOverlapMergeStrategy_r");
    }
  }
  const coll = collectClone(geos, gs);
  try {
    const out = ops.GEOSCoverageCleanWithParams_r(geos.ctx, coll, p);
    if (out === null) throw geos.fail("GEOSCoverageCleanWithParams_r");
    try {
      return cloneMembers(geos, out as GeomPtr, "GEOSCoverageCleanWithParams_r", opts.arena);
    } finally {
      geos.destroyRaw(out as GeomPtr);
    }
  } finally {
    geos.destroyRaw(coll);
  }
}

export interface CoverageSimplifyOptions {
  /** Keep boundary vertices fixed (default false). */
  preserveBoundary?: boolean;
  arena?: Arena;
}

/**
 * Visvalingam–Whyatt simplification that PRESERVES coverage topology —
 * edges keep matching, so the result is still a coverage (GEOSCoverageSimplifyVW).
 */
export function coverageSimplifyVW(
  geos: Geos,
  gs: readonly Geometry[],
  tolerance: number,
  opts: CoverageSimplifyOptions = {},
): Geometry[] {
  geos.assertOpen("coverageSimplifyVW()");
  if (gs.length === 0) throw new RangeError("coverageSimplifyVW: needs at least one geometry");
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(
      `coverageSimplifyVW: tolerance must be a non-negative number, got ${tolerance}`,
    );
  }
  const coll = collectClone(geos, gs);
  try {
    const out =
      geos.native.geos.GEOSCoverageSimplifyVW_r(
        geos.ctx,
        coll,
        tolerance,
        opts.preserveBoundary === true ? 1 : 0,
      ) ?? null;
    if (out === null) throw geos.fail("GEOSCoverageSimplifyVW_r");
    try {
      return cloneMembers(geos, out as GeomPtr, "GEOSCoverageSimplifyVW_r", opts.arena);
    } finally {
      geos.destroyRaw(out as GeomPtr);
    }
  } finally {
    geos.destroyRaw(coll);
  }
}

/* ------------------------------------------------------------------ helpers */

/** `Geometry[]` → one GEOMETRYCOLLECTION of clones (one shim crossing). */
function collectClone(geos: Geos, gs: readonly Geometry[]): GeomPtr {
  const ptrs = geomPtrArray(geos, gs, "coverage op");
  const coll = geos.native.shim.geos_shim_clone_collect(geos.shim, ptrs, gs.length);
  if (coll === null) throw geos.fail("geos_shim_clone_collect");
  return coll as GeomPtr;
}

/** Clone a collection's members out as owned, registered geometries. */
export function cloneMembers(geos: Geos, coll: GeomPtr, op: string, arena?: Arena): Geometry[] {
  const n = geos.native.geos.GEOSGetNumGeometries_r(geos.ctx, coll);
  if (n < 0) throw geos.fail(op);
  const out = new BigUint64Array(n);
  const m = geos.native.shim.geos_shim_clone_members(geos.shim, coll, out, n);
  if (m < 0) throw geos.fail(op);
  const result: Geometry[] = [];
  for (let i = 0; i < m; i++) {
    result.push(geos.take(op, ptrOf(out[i]!) as unknown as GeomPtr, arena ?? undefined));
  }
  return result;
}
