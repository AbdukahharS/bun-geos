/**
 * `Geometry` — JS wrapper around one `GEOSGeometry*` (memory.md §2).
 *
 * Discipline (D10): explicit disposal is the contract (`using`/`dispose()`);
 * the FinalizationRegistry is a leak net only. A geometry remembers its
 * owning `Geos`; using it with another context is a programming error
 * (`TypeError` — the Rust-lifetime lesson, enforced structurally).
 *
 * Two flavours: owned (the common case — created by constructors/ops; the
 * wrapper destroys the C object exactly once, verified against its
 * registration token so a recycled address can never be destroyed through a
 * stale wrapper) and borrowed (accessors like `exteriorRing()` hand out
 * GEOS-owned interior pointers; dispose is a no-op, and the view enforces
 * parent liveness — using it after the parent was disposed throws).
 */
import type { Arena } from "./arena.ts";
import type { Geos } from "./geos.ts";
import { dimensionsOf } from "./ops/accessors.ts";
import { Prepared } from "./spatial/prepared.ts";
import type { GeomPtr } from "./types.ts";

export class Geometry implements Disposable {
  readonly geos: Geos;
  readonly ptr: GeomPtr;
  readonly owned: boolean;

  /**
   * Side-channel for application data attached to this geometry. `fromGeoJSON`
   * stores non-GeoJSON members here; `toGeoJSON` merges them back (io.md §3).
   */
  userData: unknown;

  #disposed = false;
  /** FinalizationRegistry unregister token (owned geometries only). */
  #token: object | null;
  /** The arena this geometry was born into, if any (removed on dispose). */
  #arena: Arena | null;
  /** Borrowed views: the parent they alias (weak — never keeps it alive). */
  #parentRef: WeakRef<Geometry> | null;
  /**
   * Consumer pins (D17): Prepared / STRtree objects that reference this
   * geometry's C memory. A pinned geometry cannot be disposed (nor
   * arena-destroyed — pinning removes it from its arena) until every
   * consumer is disposed; the pin RE placed it under caller ownership.
   */
  #consumers: Set<object> | null = null;
  #hasZ: boolean | undefined;
  #hasM: boolean | undefined;
  /**
   * Cached bigint form of `ptr` (Phase 3): batch ops build `BigUint64Array`
   * pointer arrays once per call — caching the conversion per wrapper makes
   * repeated batch passes over the same inputs allocation-free. Strictly an
   * FFI-marshaling cache; never use it in place of `ptr`.
   */
  #bigint: bigint | null = null;

  /** @internal — create via `Geos` factories (`geos.fromWKT`, ops, …). */
  constructor(
    geos: Geos,
    ptr: GeomPtr,
    opts: {
      owned: boolean;
      token: object | null;
      arena: Arena | null;
      parent?: Geometry | undefined;
    },
  ) {
    this.geos = geos;
    this.ptr = ptr;
    this.owned = opts.owned;
    this.#token = opts.token;
    this.#arena = opts.arena;
    this.#parentRef = opts.parent ? new WeakRef(opts.parent) : null;
  }

  /** @internal — bigint form of the pointer for FFI pointer arrays (cached). */
  get bigint(): bigint {
    if (this.#bigint === null) this.#bigint = BigInt(this.ptr);
    return this.#bigint;
  }

  /** True once `[Symbol.dispose]()` has run. Use of a disposed geometry throws. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Lazily detected Z presence (3.14 CoordSeq accessors; cached). */
  get hasZ(): boolean {
    this.assertAlive();
    if (this.#hasZ === undefined) {
      const dims = dimensionsOf(this.geos, this);
      this.#hasZ = dims.hasZ;
      this.#hasM = dims.hasM;
    }
    return this.#hasZ;
  }

  /** Lazily detected M presence (cached with `hasZ`). */
  get hasM(): boolean {
    this.assertAlive();
    if (this.#hasM === undefined) this.hasZ; // fills both via dimensionsOf
    return this.#hasM ?? false;
  }

  /** @internal — throws when the wrapper is spent (pitfall table: use-after-dispose). */
  assertAlive(): void {
    if (this.#disposed) {
      throw new TypeError("bun-geos: geometry used after dispose()");
    }
    const parent = this.#parentRef?.deref();
    if (parent?.disposed) {
      // Borrowed views alias the parent's memory (H1): GEOS has no liveness
      // query, so this wrapper-side check is the guard.
      throw new TypeError(
        "bun-geos: borrowed view used after its parent geometry was disposed — " +
          "copy first (toWKB/toGeoJSON/toArrow) if you need it to outlive the parent",
      );
    }
  }

  /**
   * @internal — register a consumer pin (D17: `Prepared`, `STRtree`). The
   * pin takes the geometry out of any open arena: the arena's bulk teardown
   * would free the C object under the consumer (destroy_many does not go
   * through dispose). From the pin until consumer disposal the geometry is
   * individually owned by the caller.
   */
  pinBy(consumer: object): void {
    this.assertAlive();
    if (this.#consumers === null) this.#consumers = new Set();
    this.#consumers.add(consumer);
    if (this.#arena !== null) {
      this.#arena.remove(this.ptr);
      this.#arena = null;
    }
  }

  /** @internal — the consumer was disposed; the pin is released. */
  unpinBy(consumer: object): void {
    this.#consumers?.delete(consumer);
  }

  /** @internal — true while a Prepared/STRtree references this geometry. */
  get pinned(): boolean {
    return this.#consumers !== null && this.#consumers.size > 0;
  }

  /** @internal — refuse disposal while pinned (D17 contract). */
  assertUnpinned(): void {
    if (this.pinned) {
      throw new TypeError(
        "bun-geos: geometry is still referenced by a Prepared predicate or STRtree — " +
          "dispose the consumer first (it must not outlive the geometry it indexes)",
      );
    }
  }

  /**
   * @internal — throws unless this geometry belongs to `geos`
   * (pitfall table: destroying/using with a foreign context).
   */
  requireSame(geos: Geos): void {
    if (this.geos !== geos) {
      throw new TypeError(
        "bun-geos: geometry belongs to a different Geos context — " +
          "geometries never cross contexts or threads (D3/D11); transfer via toWKB()/toGeoJSON()/toArrow()",
      );
    }
    this.assertAlive();
  }

  /**
   * Dispose: destroys the underlying C geometry (once, token-verified) via
   * its owning context. Borrowed views: a complete no-op — the view stays
   * readable while its parent is alive (nothing was owned, nothing is
   * released). Idempotent.
   */
  [Symbol.dispose](): void {
    if (!this.owned || this.#disposed) return;
    this.assertUnpinned(); // D17: a consumer holds a raw pointer to this C object
    this.#disposed = true;
    const token = this.#token;
    if (token) {
      // Cheap no-op if already unregistered.
      this.geos.unregisterFinalizer(token);
      this.#token = null;
    }
    // Detach from the arena BEFORE freeing, or the arena's bulk teardown
    // would destroy an already-freed pointer.
    if (this.#arena) {
      this.#arena.remove(this.ptr);
      this.#arena = null;
    }
    if (token) this.geos.destroyOwned(this.ptr, token);
  }

  /**
   * @internal — ownership of the underlying pointer moved elsewhere (e.g.
   * `fromParts(..., { transfer: true })`): mark spent WITHOUT destroying,
   * and drop the finalization backstop for it.
   */
  renounce(): void {
    if (this.#disposed || !this.owned) return;
    this.assertUnpinned(); // a pinned part cannot be transferred (D17)
    this.#disposed = true;
    const token = this.#token;
    if (token) {
      this.geos.unregisterFinalizer(token);
      this.#token = null;
    }
    if (this.#arena) {
      this.#arena.remove(this.ptr);
      this.#arena = null;
    }
    if (token) this.geos.renounceOwnership(this.ptr, token);
  }

  /** Non-`using` alias for `[Symbol.dispose]()` (memory.md §3). */
  dispose(): void {
    this[Symbol.dispose]();
  }

  /**
   * Prepare this geometry for repeated predicate tests (3.13 RelateNG).
   * Pins the geometry until the `Prepared` is disposed (D17): dispose the
   * `Prepared` first, then the geometry. `using prep = geom.prepare()` is
   * the intended form.
   */
  prepare(): Prepared {
    return new Prepared(this.geos, this);
  }
}
