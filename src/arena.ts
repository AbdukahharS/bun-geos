/**
 * Arena (memory.md §3): register every geometry created inside the scope and
 * destroy them all in ONE FFI call on exit (`geos_shim_destroy_many`).
 *
 * `using arena = geos.arena()` is the hot-loop contract — the difference
 * between N teardown crossings and one. Nested arenas are allowed; child
 * disposal is independent, and an arena only ever frees geometries it
 * registered.
 */

import type { Geos } from "./geos.ts";
import type { GeomPtr } from "./types.ts";

export class Arena implements Disposable {
  readonly geos: Geos;
  readonly #ptrs: GeomPtr[] = [];
  #closed = false;

  /** @internal — create via `geos.arena()`. */
  constructor(geos: Geos) {
    this.geos = geos;
  }

  get size(): number {
    return this.#ptrs.length;
  }

  /** @internal — called by the `Geos` factory for geometries born inside. */
  add(ptr: GeomPtr): void {
    if (!this.#closed) this.#ptrs.push(ptr);
  }

  /** @internal — the geometry was disposed individually before arena exit. */
  remove(ptr: GeomPtr): void {
    const i = this.#ptrs.indexOf(ptr);
    if (i >= 0) this.#ptrs.splice(i, 1);
  }

  /**
   * Exit: one `destroy_many` crossing for everything still registered.
   * Idempotent; a closed arena stops accepting registrations (they fall
   * through to individual disposal).
   */
  [Symbol.dispose](): void {
    if (this.#closed) return;
    this.#closed = true;
    const geos = this.geos;
    geos.arenaClosed(this);
    if (this.#ptrs.length > 0) {
      geos.destroyMany(this.#ptrs);
      this.#ptrs.length = 0;
    }
  }

  dispose(): void {
    this[Symbol.dispose]();
  }
}
