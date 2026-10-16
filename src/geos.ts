/**
 * `Geos` (architecture.md §2): owns one `GEOSContextHandle_t` (D3 — one
 * context per JS thread) plus the shim session that installs the variadic
 * handlers (D4). All construction and disposal flows through this class so
 * ownership stays in one reviewable place (F8 rule: the shim wrapper handle
 * goes only to `geos_shim_*`, the context handle only to `geos_c`).
 *
 * The library itself is dlopened once per process (loader.ts); each `Geos`
 * is an independent context on top of it.
 *
 * Memory model (D10): every owned `GEOSGeometry*` is registered here
 * (stats + cleanup) and either disposed individually, bulk-freed by its
 * arena, or reaped by the FinalizationRegistry backstop.
 */
import { Arena } from "./arena.ts";
import {
  type EmptyKind,
  empty,
  type FromPartsOptions,
  fromCoords,
  fromParts,
  fromPolygonal,
} from "./construct.ts";
import { GeosError, lastError } from "./errors.ts";
import { Geometry } from "./geometry.ts";
import { type OpOptions, withSignal } from "./interrupt.ts";
import { fromArrow, toArrow } from "./io/arrow.ts";
import { fromGeoJSON, toGeoJSON } from "./io/geojson.ts";
import { fromWKB, toWKB, type WKBOptions } from "./io/wkb.ts";
import { fromWKT, toWKT, type WKTOptions } from "./io/wkt.ts";
import { openLibrary } from "./loader.ts";
import {
  coordinates,
  envelope,
  exteriorRing,
  geomType,
  geomTypeId,
  getGeometryN,
  interiorRingN,
  isEmpty,
  isValid,
  numGeometries,
  numInteriorRings,
  numPoints,
  setSrid,
  sridOf,
} from "./ops/accessors.ts";
import { type BufferOptions, buffer } from "./ops/buffer.ts";
import {
  type CoverageCleanOptions,
  type CoverageIsValidOptions,
  type CoverageSimplifyOptions,
  coverageClean,
  coverageIsValid,
  coverageSimplifyVW,
} from "./ops/coverage.ts";
import { area, distance, frechet, hausdorff, length } from "./ops/measure.ts";
import {
  coverageUnion,
  difference,
  intersection,
  symDifference,
  type UnionAllOptions,
  unaryUnion,
  union,
  unionAll,
} from "./ops/overlay.ts";
import {
  differencePrec,
  getPrecision,
  intersectionPrec,
  type SetPrecisionOptions,
  setPrecision,
  symDifferencePrec,
  unaryUnionPrec,
  unionPrec,
} from "./ops/precision.ts";
import {
  contains,
  coveredBy,
  covers,
  crosses,
  disjoint,
  equals,
  equalsIdentical,
  intersects,
  overlaps,
  relateMatrix,
  relatesPattern,
  touches,
  within,
} from "./ops/predicates.ts";
import {
  isSimpleDetail,
  isValidDetail,
  type MakeValidOptions,
  makeValid,
  orientPolygons,
  type SimpleDetail,
  type ValidityDetail,
} from "./ops/repair.ts";
import { STRtree } from "./spatial/strtree.ts";
import type { Native } from "./symbols.ts";
import type {
  ArrowArray,
  CollectionKind,
  CoverageCleanParamsPtr,
  FlatCoords,
  GeomPtr,
  GeosCtx,
  GeoTypeId,
  MakeValidParamsPtr,
  Polygonal,
  ShimPtr,
  WkbReaderPtr,
  WktReaderPtr,
} from "./types.ts";

export interface GeosStats {
  /** Owned geometries currently alive in this context. */
  liveGeoms: number;
  /** Floor estimate: liveGeoms × minimum per-geometry C-heap cost. */
  heapBytesApprox: number;
  /** Geometries reclaimed by the FinalizationRegistry (leak net, D10). */
  finalized: number;
  /** High-water mark of live geometries. */
  peakLiveGeoms: number;
}

/** Floor estimate of C-heap bytes for one live GEOSGeometry. */
const GEOM_MIN_BYTES = 64;

interface FinalizerPayload {
  geos: Geos;
  ptr: GeomPtr;
  arena: Arena | null;
  token: object;
}

/** Live-geometry accounting entry — the token is the ownership proof. */
interface LiveEntry {
  bytes: number;
  token: object;
  arena: Arena | null;
}

/** Set on process exit: finalizers must not touch FFI during teardown (D10). */
let exiting = false;
try {
  process.on("exit", () => {
    exiting = true;
  });
} catch {
  // Non-process embeds (tests may re-import); worst case the backstop runs.
}

export class Geos implements Disposable {
  /** @internal — FFI symbol tables (shared per process, read-only). */
  readonly native: Native;
  /** The GEOS context handle — pass to `geos_c` calls only. @internal */
  readonly ctx: GeosCtx;
  /** The shim session handle — pass to `geos_shim_*` calls only. @internal */
  readonly shim: ShimPtr;

  #disposed = false;
  readonly #live = new Map<GeomPtr, LiveEntry>();
  readonly #arenaStack: Arena[] = [];
  /** Pooled WKT/WKB readers (stateless; memory.md §2: pooled per `Geos`). */
  #wktReader: WktReaderPtr | null = null;
  #wkbReader: WkbReaderPtr | null = null;
  /** Pooled repair params objects (values re-set per call; D21). */
  #makeValidParams: MakeValidParamsPtr | null = null;
  #coverageCleanParams: CoverageCleanParamsPtr | null = null;
  /**
   * Consumer objects that reference context memory and MUST be disposed
   * before the context tears down (D17): `Prepared`, `STRtree`.
   */
  readonly #consumables: Disposable[] = [];
  readonly #registry = new FinalizationRegistry<FinalizerPayload>((payload) => {
    payload.geos.#reap(payload);
  });
  #finalized = 0;
  #peak = 0;

  /** @internal */
  constructor(opts?: { library?: string }) {
    const { native } = openLibrary(opts);
    this.native = native;
    const shim = native.shim.geos_shim_init();
    if (shim === null) {
      throw new GeosError("geos_shim_init", "shim session allocation failed");
    }
    this.shim = shim as ShimPtr;
    const ctx = native.shim.geos_shim_context(this.shim);
    if (ctx === null) {
      throw new GeosError("geos_shim_context", "no context handle from shim session");
    }
    this.ctx = ctx as GeosCtx;
  }

  /** GEOS version string of the loaded binary, e.g. `"3.14.1-CAPI-1.18.2"`. */
  get version(): string {
    return openLibrary().version;
  }

  get stats(): GeosStats {
    return {
      liveGeoms: this.#live.size,
      heapBytesApprox: this.#live.size * GEOM_MIN_BYTES,
      finalized: this.#finalized,
      peakLiveGeoms: this.#peak,
    };
  }

  /**
   * Open an arena: `using arena = geos.arena()`. Geometries created while it
   * is open are registered into it and freed in one FFI call at exit.
   */
  arena(): Arena {
    this.assertOpen("arena()");
    const arena = new Arena(this);
    this.#arenaStack.push(arena);
    return arena;
  }

  // ---------------------------------------------------------------- internals

  /** @internal — pooled WKT reader (created lazily, destroyed at dispose). */
  wktReader(): WktReaderPtr {
    this.assertOpen("wktReader()");
    if (this.#wktReader === null) {
      const r = this.native.geos.GEOSWKTReader_create_r(this.ctx);
      if (r === null) throw this.fail("GEOSWKTReader_create_r");
      this.#wktReader = r as WktReaderPtr;
    }
    return this.#wktReader;
  }

  /** @internal */
  wkbReader(): WkbReaderPtr {
    this.assertOpen("wkbReader()");
    if (this.#wkbReader === null) {
      const r = this.native.geos.GEOSWKBReader_create_r(this.ctx);
      if (r === null) throw this.fail("GEOSWKBReader_create_r");
      this.#wkbReader = r as WkbReaderPtr;
    }
    return this.#wkbReader;
  }

  /** @internal — pooled GEOSMakeValidParams (values re-set per makeValid call). */
  makeValidParams(): MakeValidParamsPtr {
    this.assertOpen("makeValidParams()");
    if (this.#makeValidParams === null) {
      const p = this.native.geos.GEOSMakeValidParams_create_r(this.ctx);
      if (p === null) throw this.fail("GEOSMakeValidParams_create_r");
      this.#makeValidParams = p as MakeValidParamsPtr;
    }
    return this.#makeValidParams;
  }

  /** @internal — pooled GEOSCoverageCleanParams (values re-set per call). */
  coverageCleanParams(): CoverageCleanParamsPtr {
    this.assertOpen("coverageCleanParams()");
    if (this.#coverageCleanParams === null) {
      const p = this.native.geos.GEOSCoverageCleanParams_create_r(this.ctx);
      if (p === null) throw this.fail("GEOSCoverageCleanParams_create_r");
      this.#coverageCleanParams = p as CoverageCleanParamsPtr;
    }
    return this.#coverageCleanParams;
  }

  /**
   * @internal — register a Prepared/STRtree consumer: disposed before the
   * context tears down, so its C object never outlives the context (D17).
   */
  registerConsumable(consumable: Disposable): void {
    this.#consumables.push(consumable);
  }

  /** @internal — the consumer disposed itself; drop it from the teardown list. */
  unregisterConsumable(consumable: Disposable): void {
    const i = this.#consumables.indexOf(consumable);
    if (i >= 0) this.#consumables.splice(i, 1);
  }

  /** @internal */
  assertOpen(what: string): void {
    if (this.#disposed) {
      throw new TypeError(`bun-geos: Geos context used after dispose (in ${what})`);
    }
  }

  /** @internal — error helper: consume the thread-local GEOS message. */
  fail(op: string): GeosError {
    return lastError(this.native.shim, this.shim, op);
  }

  /**
   * @internal — THE factory for owned geometries. Null (GEOS failure) throws
   * `GeosError(op)` with the captured message; otherwise registers the
   * pointer (stats, innermost arena, finalization backstop) and wraps it.
   */
  take(
    op: string,
    ptr: GeomPtr | null,
    arena: Arena | null = this.#arenaStack.at(-1) ?? null,
  ): Geometry {
    this.assertOpen(op);
    if (ptr === null) throw this.fail(op);
    const bytes = GEOM_MIN_BYTES;
    const token: object = {};
    this.#live.set(ptr, { bytes, token, arena });
    this.#peak = Math.max(this.#peak, this.#live.size);
    const geom = new Geometry(this, ptr, { owned: true, token, arena });
    // Backstop only (D10): fires if the wrapper is collected undisposed.
    this.#registry.register(geom, { geos: this, ptr, arena, token }, token);
    if (arena) arena.add(ptr);
    return geom;
  }

  /**
   * @internal — wrap a GEOS-owned interior pointer (accessors): never
   * destroyed through this wrapper. `parent` enforces liveness: using the
   * view after the parent was disposed throws instead of reading freed
   * memory (audit H1).
   */
  borrow(ptr: GeomPtr | null, op: string, parent?: Geometry): Geometry {
    this.assertOpen(op);
    if (ptr === null) throw this.fail(op);
    return new Geometry(this, ptr, { owned: false, token: null, arena: null, parent });
  }

  /** @internal — raw pointer check for callers that build Geometry themselves. */
  requirePtr(op: string, ptr: GeomPtr | null): GeomPtr {
    if (ptr === null) throw this.fail(op);
    return ptr;
  }

  /**
   * @internal — destroy one owned geometry (from `Geometry[Symbol.dispose]`).
   * The token is the ownership proof: if the live entry's token differs, the
   * pointer's original owner is gone and the address was recycled (ABA) —
   * destroying here would kill a live geometry that merely reused the
   * address. Silently treated as already-freed.
   */
  destroyOwned(ptr: GeomPtr, token: object): void {
    if (this.#disposed) return;
    const entry = this.#live.get(ptr);
    if (!entry || entry.token !== token) return;
    this.#live.delete(ptr);
    this.native.geos.GEOSGeom_destroy_r(this.ctx, ptr);
  }

  /**
   * @internal — destroy a raw GEOS pointer that this context allocated but
   * deliberately never registered (mid-construction failure cleanup in the
   * builders). The ONLY sanctioned raw-destroy outside the shim.
   */
  destroyRaw(ptr: GeomPtr): void {
    if (this.#disposed) return;
    this.native.geos.GEOSGeom_destroy_r(this.ctx, ptr);
  }

  /** @internal — one `destroy_many` crossing for arena teardown. */
  destroyMany(ptrs: GeomPtr[]): void {
    if (this.#disposed) return;
    const arr = new BigUint64Array(ptrs.length);
    for (let i = 0; i < ptrs.length; i++) arr[i] = BigInt(ptrs[i]!);
    this.native.shim.geos_shim_destroy_many(this.shim, arr, ptrs.length);
    for (const p of ptrs) this.#live.delete(p);
  }

  /** @internal — arena exited. */
  arenaClosed(arena: Arena): void {
    const i = this.#arenaStack.indexOf(arena);
    if (i >= 0) this.#arenaStack.splice(i, 1);
  }

  /** @internal — FinalizationRegistry unregister hook (from Geometry.dispose). */
  unregisterFinalizer(token: object): void {
    this.#registry.unregister(token);
  }

  /**
   * @internal — ownership of `ptr` left this context (transfer semantics):
   * remove it from live accounting so teardown never frees it again.
   */
  renounceOwnership(ptr: GeomPtr, token: object): void {
    const entry = this.#live.get(ptr);
    if (!entry || entry.token !== token) return; // ABA guard (same as destroyOwned)
    this.#live.delete(ptr);
  }

  #reap(payload: FinalizerPayload): void {
    if (exiting || this.#disposed) return; // never touch FFI at teardown (D10)
    const { ptr, arena, token } = payload;
    // ABA guard: the live entry must carry THIS finalizer's token. A bare
    // pointer match is not enough — after the address is freed and recycled
    // by a new geometry, a stale queued finalizer would otherwise destroy
    // the new (live) geometry and empty its accounting entry.
    const entry = this.#live.get(ptr);
    if (!entry || entry.token !== token) return;
    this.#live.delete(ptr);
    this.#registry.unregister(token);
    if (arena) arena.remove(ptr);
    this.#finalized++;
    this.native.geos.GEOSGeom_destroy_r(this.ctx, ptr);
  }

  // ---------------------------------------------------------------- disposal

  /**
   * Dispose the context: arenas close first (innermost first), then any
   * still-live geometries are bulk-destroyed, then `GEOS_finish_r` runs via
   * the shim. Idempotent.
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Consumers first (D17): Prepared/STRtree objects hold raw pointers into
    // this context — they must release (and unpin) before any geometry is
    // freed. Their dispose calls unregisterConsumable → iterate a copy.
    for (const c of [...this.#consumables]) c[Symbol.dispose]();
    for (const arena of [...this.#arenaStack].reverse()) arena[Symbol.dispose]();
    if (this.#live.size > 0) {
      const rest = [...this.#live.keys()];
      const arr = new BigUint64Array(rest.length);
      for (let i = 0; i < rest.length; i++) arr[i] = BigInt(rest[i]!);
      this.native.shim.geos_shim_destroy_many(this.shim, arr, rest.length);
      this.#live.clear();
    }
    if (this.#wktReader !== null) {
      this.native.geos.GEOSWKTReader_destroy_r(this.ctx, this.#wktReader);
      this.#wktReader = null;
    }
    if (this.#wkbReader !== null) {
      this.native.geos.GEOSWKBReader_destroy_r(this.ctx, this.#wkbReader);
      this.#wkbReader = null;
    }
    if (this.#makeValidParams !== null) {
      this.native.geos.GEOSMakeValidParams_destroy_r(this.ctx, this.#makeValidParams);
      this.#makeValidParams = null;
    }
    if (this.#coverageCleanParams !== null) {
      this.native.geos.GEOSCoverageCleanParams_destroy_r(this.ctx, this.#coverageCleanParams);
      this.#coverageCleanParams = null;
    }
    this.native.shim.geos_shim_finish(this.shim);
  }

  dispose(): void {
    this[Symbol.dispose]();
  }

  // ------------------------------------------------------------- public API
  // Thin delegates to the ops/io modules (api-surface.md is the contract).

  // Construction & I/O
  fromWKT(wkt: string): Geometry {
    return fromWKT(this, wkt);
  }
  toWKT(g: Geometry, opts?: WKTOptions): string {
    return toWKT(this, g, opts);
  }
  fromWKB(wkb: Uint8Array): Geometry {
    return fromWKB(this, wkb);
  }
  toWKB(g: Geometry, opts?: WKBOptions): Uint8Array {
    return toWKB(this, g, opts);
  }
  fromGeoJSON(
    geo: import("./io/geojson.ts").GeoJSONGeometryObject | import("./io/geojson.ts").GeoJSONFeature,
  ): Geometry {
    return fromGeoJSON(this, geo);
  }
  toGeoJSON(
    g: Geometry,
    opts?: import("./io/geojson.ts").GeoJSONOptions,
  ): import("./io/geojson.ts").GeoJSONGeometryObject {
    return toGeoJSON(this, g, opts);
  }
  fromArrow(arr: ArrowArray): Geometry {
    return fromArrow(this, arr);
  }
  toArrow(g: Geometry): ArrowArray {
    return toArrow(this, g);
  }
  fromCoords(spec: FlatCoords, kind?: "point" | "linestring"): Geometry {
    return fromCoords(this, spec, kind);
  }
  fromPolygonal(spec: Polygonal): Geometry {
    return fromPolygonal(this, spec);
  }
  fromParts(kind: CollectionKind, parts: Geometry[], opts?: FromPartsOptions): Geometry {
    return fromParts(this, kind, parts, opts);
  }
  empty(kind: EmptyKind): Geometry {
    return empty(this, kind);
  }
  /** Convenience: `geos.point(1, 2)`. */
  point(x: number, y: number, z?: number, m?: number): Geometry {
    const hasZ = z !== undefined;
    const hasM = m !== undefined;
    const coords = new Float64Array(
      hasZ && hasM ? [x, y, z!, m!] : hasZ ? [x, y, z!] : hasM ? [x, y, m!] : [x, y],
    );
    return fromCoords(this, { coords, n: 1, hasZ, hasM }, "point");
  }

  // Predicates
  intersects(a: Geometry, b: Geometry): boolean {
    return intersects(this, a, b);
  }
  disjoint(a: Geometry, b: Geometry): boolean {
    return disjoint(this, a, b);
  }
  touches(a: Geometry, b: Geometry): boolean {
    return touches(this, a, b);
  }
  crosses(a: Geometry, b: Geometry): boolean {
    return crosses(this, a, b);
  }
  within(a: Geometry, b: Geometry): boolean {
    return within(this, a, b);
  }
  contains(a: Geometry, b: Geometry): boolean {
    return contains(this, a, b);
  }
  overlaps(a: Geometry, b: Geometry): boolean {
    return overlaps(this, a, b);
  }
  covers(a: Geometry, b: Geometry): boolean {
    return covers(this, a, b);
  }
  coveredBy(a: Geometry, b: Geometry): boolean {
    return coveredBy(this, a, b);
  }
  equals(a: Geometry, b: Geometry): boolean {
    return equals(this, a, b);
  }
  equalsIdentical(a: Geometry, b: Geometry): boolean {
    return equalsIdentical(this, a, b);
  }
  relatesPattern(a: Geometry, b: Geometry, pattern: string): boolean {
    return relatesPattern(this, a, b, pattern);
  }
  relateMatrix(a: Geometry, b: Geometry): string {
    return relateMatrix(this, a, b);
  }

  // Overlays & boolean ops (long ops accept `{ signal }` — D19)
  intersection(a: Geometry, b: Geometry, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => intersection(this, a, b));
  }
  union(a: Geometry, b: Geometry, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => union(this, a, b));
  }
  difference(a: Geometry, b: Geometry, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => difference(this, a, b));
  }
  symDifference(a: Geometry, b: Geometry, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => symDifference(this, a, b));
  }
  unaryUnion(g: Geometry, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => unaryUnion(this, g));
  }
  unionAll(gs: readonly Geometry[], opts?: UnionAllOptions): Geometry {
    return withSignal(this, opts?.signal, () => unionAll(this, gs, opts));
  }
  coverageUnion(gs: readonly Geometry[], opts?: { arena?: Arena }): Geometry {
    return coverageUnion(this, gs, opts);
  }

  // Buffer & measures
  buffer(g: Geometry, distance: number, opts?: BufferOptions): Geometry {
    return withSignal(this, opts?.signal, () => buffer(this, g, distance, opts));
  }
  area(g: Geometry): number {
    return area(this, g);
  }
  length(g: Geometry): number {
    return length(this, g);
  }
  distance(a: Geometry, b: Geometry): number {
    return distance(this, a, b);
  }
  hausdorff(a: Geometry, b: Geometry): number {
    return hausdorff(this, a, b);
  }
  frechet(a: Geometry, b: Geometry): number {
    return frechet(this, a, b);
  }

  // Envelope & accessors
  geomType(g: Geometry): string {
    return geomType(this, g);
  }
  typeId(g: Geometry): GeoTypeId {
    return geomTypeId(this, g);
  }
  isEmpty(g: Geometry): boolean {
    return isEmpty(this, g);
  }
  isValid(g: Geometry): boolean {
    return isValid(this, g);
  }
  envelope(g: Geometry): Geometry {
    return envelope(this, g);
  }
  numGeometries(g: Geometry): number {
    return numGeometries(this, g);
  }
  getGeometryN(g: Geometry, n: number): Geometry {
    return getGeometryN(this, g, n);
  }
  numInteriorRings(g: Geometry): number {
    return numInteriorRings(this, g);
  }
  exteriorRing(g: Geometry): Geometry {
    return exteriorRing(this, g);
  }
  interiorRingN(g: Geometry, n: number): Geometry {
    return interiorRingN(this, g, n);
  }
  numPoints(g: Geometry): number {
    return numPoints(this, g);
  }
  coordinates(g: Geometry): FlatCoords {
    return coordinates(this, g);
  }
  srid(g: Geometry): number | null {
    return sridOf(this, g);
  }
  setSrid(g: Geometry, srid: number | null): void {
    setSrid(this, g, srid);
  }

  // ============================================================ Phase 2 ====

  // Interrupt (D19): the low-level, thread-safe flag controls. `{ signal }`
  // on individual ops is the structured path (see interrupt.ts for the
  // same-thread honesty note).
  interruptRequest(): void {
    this.assertOpen("interruptRequest()");
    this.native.shim.geos_shim_interrupt_request();
  }
  interruptReset(): void {
    this.native.shim.geos_shim_interrupt_reset();
  }

  // Spatial index (api-surface §Spatial index)
  strtree(geoms?: readonly Geometry[], nodeCapacity = 10): STRtree {
    this.assertOpen("strtree()");
    const tree = new STRtree(this, nodeCapacity);
    if (geoms !== undefined) {
      // A mid-loop throw (foreign context, disposed geometry) must not leave
      // an unreachable tree holding unreleasable pins — dispose it first
      // (audited leak; consumables have no finalizer backstop).
      try {
        for (const g of geoms) tree.insert(g);
      } catch (err) {
        tree.dispose();
        throw err;
      }
    }
    return tree;
  }

  // Topology repair (api-surface §Topology repair)
  makeValid(g: Geometry, opts?: MakeValidOptions & OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => makeValid(this, g, opts));
  }
  isValidDetail(g: Geometry): ValidityDetail {
    return isValidDetail(this, g);
  }
  isSimpleDetail(g: Geometry, opts?: { findAll?: boolean }): SimpleDetail {
    return isSimpleDetail(this, g, opts);
  }
  coverageIsValid(
    gs: readonly Geometry[],
    opts?: CoverageIsValidOptions & OpOptions,
  ): ReturnType<typeof coverageIsValid> {
    return withSignal(this, opts?.signal, () => coverageIsValid(this, gs, opts));
  }
  coverageClean(gs: readonly Geometry[], opts?: CoverageCleanOptions & OpOptions): Geometry[] {
    return withSignal(this, opts?.signal, () => coverageClean(this, gs, opts));
  }
  coverageSimplifyVW(
    gs: readonly Geometry[],
    tolerance: number,
    opts?: CoverageSimplifyOptions & OpOptions,
  ): Geometry[] {
    return withSignal(this, opts?.signal, () => coverageSimplifyVW(this, gs, tolerance, opts));
  }
  orientPolygons(g: Geometry, dir?: "ccw" | "cw"): Geometry {
    return orientPolygons(this, g, dir);
  }

  // Precision model (api-surface §Overlays)
  setPrecision(g: Geometry, gridSize: number, opts?: SetPrecisionOptions & OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => setPrecision(this, g, gridSize, opts));
  }
  getPrecision(g: Geometry): number {
    return getPrecision(this, g);
  }
  intersectionPrec(a: Geometry, b: Geometry, gridSize: number, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => intersectionPrec(this, a, b, gridSize));
  }
  unionPrec(a: Geometry, b: Geometry, gridSize: number, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => unionPrec(this, a, b, gridSize));
  }
  differencePrec(a: Geometry, b: Geometry, gridSize: number, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => differencePrec(this, a, b, gridSize));
  }
  symDifferencePrec(a: Geometry, b: Geometry, gridSize: number, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => symDifferencePrec(this, a, b, gridSize));
  }
  unaryUnionPrec(g: Geometry, gridSize: number, opts?: OpOptions): Geometry {
    return withSignal(this, opts?.signal, () => unaryUnionPrec(this, g, gridSize));
  }
}
