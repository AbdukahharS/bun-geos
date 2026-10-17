/**
 * The Phase 3 batch op layer (api-surface §Conventions; ROADMAP Phase 3;
 * D22): many-geometry overlay/predicate/measure/buffer loops executed in C
 * — ONE FFI call per array, the literal Shapely-2.0 lesson. Every function
 * here follows the D18 contract: first GEOS exception aborts the whole call
 * (no partial results), interrupt checks run between items, and when a
 * signal was supplied an interruption shapes as `op: "aborted"` with the
 * underlying `GeosError` as `cause` — uniform with singular ops.
 *
 * Naming: `*All` is ELEMENT-WISE (`intersectionAll(a, bs)[i] =
 * intersection(a, bs[i])`), matching the Prepared masks. The one exception
 * is `unionAll(gs)` — the Phase 2 aggregate (D20); there is deliberately no
 * element-wise `unionAll(a, bs)` because the name is taken by the reduce.
 *
 * Batch inputs are `Geometry[]` or an Arrow-shaped value (D9): Arrow input
 * is normalized through the shim's bulk builders inside a TRANSIENT arena
 * that is disposed before this call returns — callers only ever see their
 * own geometry wrappers plus the batch outputs.
 */
import { Arena } from "../arena.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { abortError, type OpOptions, withSignal } from "../interrupt.ts";
import { geometriesFromArrow } from "../io/arrow.ts";
import { geomPtrArray } from "../ptrs.ts";
import type { ArrowInput, BufferParamsPtr } from "../types.ts";
import { BinaryOp, MeasureOp, OverlayOp, UnaryOp, UnpreparedPred } from "../types.ts";
import { type BufferOptions, bufferParams } from "./buffer.ts";

/** A batch op input: ready wrappers or an Arrow-shaped value (normalized). */
export type BatchInput = readonly Geometry[] | ArrowInput;

export interface BatchOptions extends OpOptions {
  /** Register batch outputs with this arena instead of the innermost open one. */
  arena?: Arena;
}

/**
 * Run `fn` with the batch inputs normalized to `Geometry[]`. Arrow-shaped
 * input is built inside a transient arena (shim bulk builders, one crossing
 * per array) that is ALWAYS disposed before this returns — the wrappers the
 * caller passed in are never touched.
 *
 * `fn` receives the caller's arena (captured BEFORE the transient arena is
 * opened) so batch OUTPUTS can be registered there — capturing it inside
 * `fn` would grab the transient arena and free the outputs on return (the
 * use-after-free this parameterization makes unrepresentable).
 *
 * SYNC contract: the main-thread batch layer is synchronous end to end. The
 * parallel pool pipelines across awaits — it uses `withBatchInputsAsync`,
 * whose arena closes when the work SETTLES, not when the callback returns.
 */
export function withBatchInputs<T>(
  geos: Geos,
  bs: BatchInput,
  op: string,
  fn: (gs: readonly Geometry[], outArena: Arena | null) => T,
): T {
  geos.assertOpen(op);
  const outArena = geos.currentArena();
  if (isGeometryArray(bs)) return fn(bs, outArena);
  const inputArena = geos.arena();
  try {
    return fn(geometriesFromArrow(geos, bs), outArena);
  } finally {
    inputArena[Symbol.dispose]();
  }
}

/**
 * The async twin (pool only): the transient input arena is UNPUSHED — it is
 * never on the `currentArena()` stack. A pushed arena would poison every
 * nested main-API call made inside `fn` (their `currentArena()` captures
 * would grab the pool's transient arena and free the outputs when it closes
 * — audited C1). Inputs are registered into it explicitly instead, and it
 * closes when `fn` SETTLES.
 */
export async function withBatchInputsAsync<T>(
  geos: Geos,
  bs: BatchInput,
  op: string,
  fn: (gs: readonly Geometry[], outArena: Arena | null) => T | Promise<T>,
): Promise<T> {
  geos.assertOpen(op);
  const outArena = geos.currentArena();
  if (isGeometryArray(bs)) return await fn(bs, outArena);
  const inputArena = new Arena(geos); // unpushed — see the doc comment
  try {
    // SINGLE registration (audited N1): the builder registers into the
    // unpushed arena explicitly. An `add` on top of an ambient-default
    // registration would double-register and double-free.
    const gs = geometriesFromArrow(geos, bs, inputArena);
    return await fn(gs, outArena);
  } finally {
    inputArena[Symbol.dispose]();
  }
}

/** `Array.isArray` does not narrow `readonly T[]` — explicit predicate. */
function isGeometryArray(bs: BatchInput): bs is readonly Geometry[] {
  return Array.isArray(bs);
}

/** The uniform D18 error contract for `0 ok / 1 exception / 2 interrupted`. */
function batchCode(geos: Geos, op: string, r: number, signal: AbortSignal | undefined): void {
  if (r === 0) return;
  const underlying = geos.fail(op);
  if (r === 2 && signal !== undefined) throw abortError(signal, underlying);
  throw underlying;
}

/* ------------------------------------------------------- overlay batch
 * out[i] = overlay(a, gs[i]); NO element-wise union — the name `unionAll`
 * is the Phase 2 aggregate (D20); `union(a, b)` + `unionAll` cover it.
 */

function overlayBatch(
  geos: Geos,
  op: string,
  opId: number,
  a: Geometry,
  bs: BatchInput,
  grid: number,
  opts: BatchOptions & OpOptions,
): Geometry[] {
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, bs, op, (gs, outArena) => {
      a.requireSame(geos);
      const ptrs = geomPtrArray(geos, gs, `${op} (batch)`);
      const out = new BigUint64Array(gs.length);
      const r = geos.native.shim.geos_shim_overlay_all(
        geos.shim,
        opId,
        a.ptr,
        ptrs,
        gs.length,
        grid,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return geos.takeMany(op, out, opts.arena ?? outArena);
    }),
  );
}

export function intersectionAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(geos, "geos_shim_overlay_all", OverlayOp.intersection, a, bs, 0, opts);
}

export function differenceAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(geos, "geos_shim_overlay_all", OverlayOp.difference, a, bs, 0, opts);
}

export function symDifferenceAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(geos, "geos_shim_overlay_all", OverlayOp.symDifference, a, bs, 0, opts);
}

export function intersectionPrecAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  gridSize: number,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(
    geos,
    "geos_shim_overlay_all",
    OverlayOp.intersectionPrec,
    a,
    bs,
    gridSize,
    opts,
  );
}

export function differencePrecAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  gridSize: number,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(
    geos,
    "geos_shim_overlay_all",
    OverlayOp.differencePrec,
    a,
    bs,
    gridSize,
    opts,
  );
}

export function symDifferencePrecAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  gridSize: number,
  opts: BatchOptions = {},
): Geometry[] {
  return overlayBatch(
    geos,
    "geos_shim_overlay_all",
    OverlayOp.symDifferencePrec,
    a,
    bs,
    gridSize,
    opts,
  );
}

/* --------------------------------------------------- unprepared masks */

export type UnpreparedPredName = keyof typeof UnpreparedPred;

/**
 * Element-wise unprepared predicate masks — the free-function mirror of
 * `Prepared.*All` (D18): `out[i] = pred(a, bs[i])` as a `Uint8Array` of
 * 0/1, one shim crossing per array.
 */
export function predicateAll(
  geos: Geos,
  pred: UnpreparedPredName,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Uint8Array {
  const op = `geos_shim_pred_all:${pred}`;
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, bs, op, (gs) => {
      a.requireSame(geos);
      const ptrs = geomPtrArray(geos, gs, `${op} (batch)`);
      const out = new Uint8Array(gs.length);
      const r = geos.native.shim.geos_shim_pred_all(
        geos.shim,
        UnpreparedPred[pred],
        a.ptr,
        ptrs,
        gs.length,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return out;
    }),
  );
}

/* ---------------------------------------------------------- measures */

/** `out[i] = area(gs[i])` — one crossing per array. */
export function areaAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Float64Array {
  const op = "geos_shim_measure_all:area";
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, gs, op, (items) => {
      const ptrs = geomPtrArray(geos, items, `${op} (batch)`);
      const out = new Float64Array(items.length);
      const r = geos.native.shim.geos_shim_measure_all(
        geos.shim,
        MeasureOp.area,
        null,
        ptrs,
        items.length,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return out;
    }),
  );
}

/** `out[i] = length(gs[i])` — one crossing per array. */
export function lengthAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Float64Array {
  const op = "geos_shim_measure_all:length";
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, gs, op, (items) => {
      const ptrs = geomPtrArray(geos, items, `${op} (batch)`);
      const out = new Float64Array(items.length);
      const r = geos.native.shim.geos_shim_measure_all(
        geos.shim,
        MeasureOp.length,
        null,
        ptrs,
        items.length,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return out;
    }),
  );
}

function binaryMeasure(
  geos: Geos,
  opId: number,
  name: string,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions,
): Float64Array {
  const op = `geos_shim_measure_all:${name}`;
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, bs, op, (gs) => {
      a.requireSame(geos);
      const ptrs = geomPtrArray(geos, gs, `${op} (batch)`);
      const out = new Float64Array(gs.length);
      const r = geos.native.shim.geos_shim_measure_all(
        geos.shim,
        opId,
        a.ptr,
        ptrs,
        gs.length,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return out;
    }),
  );
}

/** `out[i] = distance(a, bs[i])`. */
export function distanceAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Float64Array {
  return binaryMeasure(geos, MeasureOp.distance, "distance", a, bs, opts);
}

/** `out[i] = hausdorff(a, bs[i])`. */
export function hausdorffAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Float64Array {
  return binaryMeasure(geos, MeasureOp.hausdorff, "hausdorff", a, bs, opts);
}

/** `out[i] = frechet(a, bs[i])`. */
export function frechetAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Float64Array {
  return binaryMeasure(geos, MeasureOp.frechet, "frechet", a, bs, opts);
}

/* ------------------------------------------- construction batches (D27)
 * Phase 5: the loop-shaped construction ops through `geos_shim_unary_all`
 * (d1..d4 carry each op's scalar params — simplify tolerance, clip rect)
 * and the 2-ary ops through `geos_shim_binary_all` (d1 = snap tolerance).
 * Same D18 contract as every batch path above.
 */

function unaryBatch(
  geos: Geos,
  op: string,
  opId: number,
  gs: BatchInput,
  d1: number,
  d2: number,
  d3: number,
  d4: number,
  opts: BatchOptions,
): Geometry[] {
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, gs, op, (items, outArena) => {
      const ptrs = geomPtrArray(geos, items, `${op} (batch)`);
      const out = new BigUint64Array(items.length);
      const r = geos.native.shim.geos_shim_unary_all(
        geos.shim,
        opId,
        ptrs,
        items.length,
        d1,
        d2,
        d3,
        d4,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return geos.takeMany(op, out, opts.arena ?? outArena);
    }),
  );
}

function binaryBatch(
  geos: Geos,
  op: string,
  opId: number,
  a: Geometry,
  bs: BatchInput,
  d1: number,
  opts: BatchOptions,
): Geometry[] {
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, bs, op, (gs, outArena) => {
      a.requireSame(geos);
      const ptrs = geomPtrArray(geos, gs, `${op} (batch)`);
      const out = new BigUint64Array(gs.length);
      const r = geos.native.shim.geos_shim_binary_all(
        geos.shim,
        opId,
        a.ptr,
        ptrs,
        gs.length,
        d1,
        out,
      );
      batchCode(geos, op, r, opts.signal);
      return geos.takeMany(op, out, opts.arena ?? outArena);
    }),
  );
}

/** `out[i] = convexHull(gs[i])`. */
export function convexHullAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(
    geos,
    "geos_shim_unary_all:convexHull",
    UnaryOp.convexHull,
    gs,
    0,
    0,
    0,
    0,
    opts,
  );
}

/** `out[i] = simplify(gs[i], tolerance)`. */
export function simplifyAll(
  geos: Geos,
  gs: BatchInput,
  tolerance: number,
  opts: BatchOptions = {},
): Geometry[] {
  return unaryBatch(
    geos,
    "geos_shim_unary_all:simplify",
    UnaryOp.simplifyDP,
    gs,
    tolerance,
    0,
    0,
    0,
    opts,
  );
}

/** `out[i] = topologyPreserveSimplify(gs[i], tolerance)`. */
export function topologyPreserveSimplifyAll(
  geos: Geos,
  gs: BatchInput,
  tolerance: number,
  opts: BatchOptions = {},
): Geometry[] {
  return unaryBatch(
    geos,
    "geos_shim_unary_all:simplifyTP",
    UnaryOp.simplifyTP,
    gs,
    tolerance,
    0,
    0,
    0,
    opts,
  );
}

/** `out[i] = clipByRect(gs[i], xmin, ymin, xmax, ymax)`. */
export function clipByRectAll(
  geos: Geos,
  gs: BatchInput,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  opts: BatchOptions = {},
): Geometry[] {
  return unaryBatch(
    geos,
    "geos_shim_unary_all:clipByRect",
    UnaryOp.clipByRect,
    gs,
    xmin,
    ymin,
    xmax,
    ymax,
    opts,
  );
}

/** `out[i] = centroid(gs[i])`. */
export function centroidAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(geos, "geos_shim_unary_all:centroid", UnaryOp.centroid, gs, 0, 0, 0, 0, opts);
}

/** `out[i] = boundary(gs[i])`. */
export function boundaryAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(geos, "geos_shim_unary_all:boundary", UnaryOp.boundary, gs, 0, 0, 0, 0, opts);
}

/** `out[i] = interiorPoint(gs[i])`. */
export function interiorPointAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(
    geos,
    "geos_shim_unary_all:interiorPoint",
    UnaryOp.interiorPoint,
    gs,
    0,
    0,
    0,
    0,
    opts,
  );
}

/** `out[i] = node(gs[i])`. */
export function nodeAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(geos, "geos_shim_unary_all:node", UnaryOp.node, gs, 0, 0, 0, 0, opts);
}

/** `out[i] = lineMerge(gs[i])`. */
export function lineMergeAll(geos: Geos, gs: BatchInput, opts: BatchOptions = {}): Geometry[] {
  return unaryBatch(geos, "geos_shim_unary_all:lineMerge", UnaryOp.lineMerge, gs, 0, 0, 0, 0, opts);
}

/** `out[i] = snap(a, bs[i], tolerance)` — `a` broadcasts. */
export function snapAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  tolerance: number,
  opts: BatchOptions = {},
): Geometry[] {
  return binaryBatch(geos, "geos_shim_binary_all:snap", BinaryOp.snap, a, bs, tolerance, opts);
}

/** `out[i] = sharedPaths(a, bs[i])` — `a` broadcasts. */
export function sharedPathsAll(
  geos: Geos,
  a: Geometry,
  bs: BatchInput,
  opts: BatchOptions = {},
): Geometry[] {
  return binaryBatch(
    geos,
    "geos_shim_binary_all:sharedPaths",
    BinaryOp.sharedPaths,
    a,
    bs,
    0,
    opts,
  );
}

/* ------------------------------------------------------------ buffer */

export type BufferAllOptions = BufferOptions & BatchOptions;

/** `out[i] = buffer(gs[i], distance)` — params built once, one crossing. */
export function bufferAll(
  geos: Geos,
  gs: BatchInput,
  distance: number,
  opts: BufferAllOptions = {},
): Geometry[] {
  return withSignal(geos, opts.signal, () =>
    withBatchInputs(geos, gs, "geos_shim_buffer_all", (items, outArena) => {
      let params: BufferParamsPtr | null = null;
      try {
        params = bufferParams(geos, opts);
        const ptrs = geomPtrArray(geos, items, "geos_shim_buffer_all (batch)");
        const out = new BigUint64Array(items.length);
        const r = geos.native.shim.geos_shim_buffer_all(
          geos.shim,
          params,
          distance,
          ptrs,
          items.length,
          out,
        );
        batchCode(geos, "geos_shim_buffer_all", r, opts.signal);
        return geos.takeMany("geos_shim_buffer_all", out, opts.arena ?? outArena);
      } finally {
        if (params !== null) {
          geos.native.geos.GEOSBufferParams_destroy_r(geos.ctx, params);
        }
      }
    }),
  );
}
