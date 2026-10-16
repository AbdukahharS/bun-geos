/**
 * `STRtree` — Sort-Tile-Recursive packed R-tree over inserted geometries
 * (api-surface §Spatial index). Items stored in the C tree are INTEGER IDS
 * (1-based `(void*)(intptr_t)(id+1)` — 0 would collide with
 * `nearest_generic`'s NULL "no answer" return; D16), never geometry
 * pointers; a JS-side `Map<id, Geometry>` is the registry.
 *
 * `nearest` needs special machinery (D16): GEOS's plain
 * `GEOSSTRtree_nearest` casts items back to `GEOSGeometry*` to compute
 * distances — with id items that is a wild pointer deref. We go through
 * `GEOSSTRtree_nearest_generic_r` with a shim-provided C distance callback
 * over an id→geometry table bound (in C) once at `build()` time.
 *
 * Liveness (D16/D17): the tree holds STRONG JS references to indexed
 * geometries and pins them (arena relinquished, disposal blocked), so the
 * C tree can never dangle. Dispose the tree to release its geometries.
 * The tree freezes at `build()` (auto-invoked by query/nearest) because the
 * bound table is a snapshot of the inserted set.
 */
import type { Pointer } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr, StrTreePtr } from "../types.ts";
import { PreparedPred } from "../types.ts";
import type { Prepared } from "./prepared.ts";

export type PreparedPredName = keyof typeof PreparedPred;

export class STRtree implements Disposable {
  readonly geos: Geos;
  readonly nodeCapacity: number;

  #tree: StrTreePtr;
  /** id → geometry (STRONG — the liveness mechanism, D16). */
  #items = new Map<number, Geometry>();
  /** id-ordered raw pointers, snapshotted into the C table at build(). */
  #ptrs: GeomPtr[] = [];
  /** Shim-owned id→geometry table (freed at dispose). */
  #table: Pointer | null = null;
  #built = false;
  #disposed = false;

  /** @internal — create via `geos.strtree(geoms?, nodeCapacity?)`. */
  constructor(geos: Geos, nodeCapacity = 10) {
    geos.assertOpen("strtree()");
    if (!Number.isInteger(nodeCapacity) || nodeCapacity < 1) {
      throw new RangeError(
        `bun-geos: strtree nodeCapacity must be a positive integer, got ${nodeCapacity}`,
      );
    }
    const t = geos.native.geos.GEOSSTRtree_create_r(geos.ctx, nodeCapacity);
    if (t === null) throw geos.fail("GEOSSTRtree_create_r");
    this.geos = geos;
    this.nodeCapacity = nodeCapacity;
    this.#tree = t as StrTreePtr;
    geos.registerConsumable(this);
  }

  get size(): number {
    return this.#items.size;
  }

  get built(): boolean {
    return this.#built;
  }

  #assertOpen(what: string): void {
    if (this.#disposed) {
      throw new TypeError(`bun-geos: STRtree used after dispose (in ${what})`);
    }
    this.geos.assertOpen(what);
  }

  /**
   * Insert a geometry; returns its id. Ids are assigned sequentially — for
   * `geos.strtree(geoms)` the id equals the input index. Insertion after
   * `build()` throws: the bound id→geometry table must stay in sync.
   *
   * The C tree stores the id 1-BASED: `GEOSSTRtree_nearest_generic_r`'s NULL
   * "no answer" return would be indistinguishable from a 0-valued item, so
   * item 0 could never be reported as nearest (audited NULL-overload
   * collision). The shim decodes (item − 1) on the way out.
   */
  insert(g: Geometry): number {
    this.#assertOpen("insert()");
    if (this.#built) {
      throw new TypeError(
        "bun-geos: STRtree insert after build() — the tree is frozen once built (dispose and rebuild to change the item set)",
      );
    }
    g.requireSame(this.geos);
    const id = this.#items.size;
    const item = (id + 1) as unknown as Pointer;
    this.geos.native.geos.GEOSSTRtree_insert_r(this.geos.ctx, this.#tree, g.ptr, item);
    this.#items.set(id, g);
    this.#ptrs.push(g.ptr);
    g.pinBy(this); // D17: tree holds the geometry alive (strong ref + pin)
    return id;
  }

  /**
   * Build the tree (idempotent; forced implicitly by query/nearest). Binds
   * the id→geometry table used by `nearest` (D16). Freeze point. INT return:
   * 1 ok, 0 exception — never masked.
   */
  build(): void {
    this.#assertOpen("build()");
    if (this.#built) return;
    const r = this.geos.native.geos.GEOSSTRtree_build_r(this.geos.ctx, this.#tree);
    if (r !== 1) throw this.geos.fail("GEOSSTRtree_build_r");
    const ptrs = new BigUint64Array(this.#ptrs.length);
    for (let i = 0; i < this.#ptrs.length; i++) ptrs[i] = BigInt(this.#ptrs[i]!);
    const table = this.geos.native.shim.geos_shim_strtree_bind_geoms(
      this.geos.shim,
      ptrs,
      this.#ptrs.length,
    );
    if (table === null) throw this.geos.fail("geos_shim_strtree_bind_geoms");
    this.#table = table;
    this.#built = true;
  }

  /**
   * Envelope-intersection candidates as ids (`Int32Array`), ONE shim
   * crossing. Candidates only — exact filtering is the caller's job
   * (typically prepared predicates on the returned ids).
   */
  query(env: Geometry): Int32Array {
    this.#assertOpen("query()");
    env.requireSame(this.geos);
    if (this.#items.size === 0) return new Int32Array(0);
    this.build();
    const shim = this.geos.native.shim;
    let out = new Int32Array(Math.max(32, Math.min(this.#items.size, 4096)));
    let total = shim.geos_shim_strtree_query(this.geos.shim, this.#tree, env.ptr, out, out.length);
    if (total < 0) throw this.geos.fail("geos_shim_strtree_query");
    if (total > out.length) {
      // Callback counted more candidates than the buffer held: one requery
      // with the exact size (query itself never derefs items, so a retry is
      // always safe).
      out = new Int32Array(total);
      total = shim.geos_shim_strtree_query(this.geos.shim, this.#tree, env.ptr, out, out.length);
      if (total < 0) throw this.geos.fail("geos_shim_strtree_query");
    }
    return total === out.length ? out : out.slice(0, total);
  }

  /**
   * Id of the nearest item to `g`, or -1 for an empty tree. Correctness
   * goes through the shim's C distance table (D16). A GEOS failure (e.g.
   * empty geometries carry no distance) surfaces as a `GeosError`.
   */
  nearest(g: Geometry): number {
    this.#assertOpen("nearest()");
    g.requireSame(this.geos);
    if (this.#items.size === 0) return -1;
    this.build();
    const r = this.geos.native.shim.geos_shim_strtree_nearest(
      this.geos.shim,
      this.#tree,
      g.ptr,
      this.#table,
    );
    if (r === -2) throw this.geos.fail("geos_shim_strtree_nearest");
    return r; // item id, or -1 (no answer)
  }

  /**
   * Fused candidate + exact filter (api-surface §Spatial index "fused
   * Phase-3 helper", Phase 3 D22): STRtree query and a prepared predicate
   * evaluated IN ONE SHIM CROSSING — C collects candidates and compacts the
   * matching ids; no per-candidate JS round trip (the `query()` + `filter`
   * pattern minus the intermediate array).
   *
   * Returns the matching ids (`Int32Array`); candidates whose predicate is
   * false are dropped. The `Prepared` must belong to this tree's context —
   * the same foreign-context rule as any geometry use. When more ids match
   * than the initial buffer holds, the filter re-runs once with a
   * right-sized buffer (the `query()` contract).
   */
  queryFilter(env: Geometry, pg: Prepared, pred: PreparedPredName = "intersects"): Int32Array {
    this.#assertOpen("queryFilter()");
    env.requireSame(this.geos);
    if (pg.geos !== this.geos) {
      throw new TypeError(
        "bun-geos: Prepared belongs to a different Geos context — geometries and prepared structures never cross contexts (D3/D11)",
      );
    }
    if (pg.disposed) {
      throw new TypeError("bun-geos: Prepared used after dispose (in queryFilter)");
    }
    if (this.#items.size === 0) return new Int32Array(0);
    this.build();
    const shim = this.geos.native.shim;
    const run = (out: Int32Array): number =>
      shim.geos_shim_strtree_query_prepared(
        this.geos.shim,
        this.#tree,
        env.ptr,
        pg.ptr,
        PreparedPred[pred],
        this.#table,
        out,
        out.length,
      );
    let out = new Int32Array(Math.max(32, Math.min(this.#items.size, 4096)));
    let total = run(out);
    if (total === -1) throw this.geos.fail("geos_shim_strtree_query_prepared");
    if (total === -2) throw this.geos.fail("geos_shim_strtree_query_prepared (interrupted)");
    if (total > out.length) {
      out = new Int32Array(total);
      total = run(out);
      if (total === -1) throw this.geos.fail("geos_shim_strtree_query_prepared");
      if (total === -2) throw this.geos.fail("geos_shim_strtree_query_prepared (interrupted)");
    }
    return total === out.length ? out : out.slice(0, total);
  }

  /** The geometry registered under `id` (throws on unknown ids). */
  get(id: number): Geometry {
    const g = this.#items.get(id);
    if (g === undefined) throw new RangeError(`bun-geos: STRtree has no item ${id}`);
    return g;
  }

  /** Release the pins this tree holds on its geometries. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.geos.unregisterConsumable(this);
    for (const g of this.#items.values()) g.unpinBy(this);
    this.#items.clear();
    this.#ptrs.length = 0;
    if (this.#table !== null) {
      this.geos.native.shim.geos_shim_strtree_table_free(this.#table);
      this.#table = null;
    }
    this.geos.native.geos.GEOSSTRtree_destroy_r(this.geos.ctx, this.#tree);
  }

  dispose(): void {
    this[Symbol.dispose]();
  }
}
