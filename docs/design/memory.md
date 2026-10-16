# Design: memory & ownership

> Status: design target (post-spike). Implements D10; consumes the ownership rules from
> [GEOS research §4](../research/geos.md).

## 1. The two heaps

JS objects live in JavaScriptCore's heap; `GEOSGeometry`/`GEOSCoordSequence` live in the
C heap. **JSC cannot see the C heap.** Consequences:

- A million live geometries may occupy gigabytes while the JS wrappers look tiny → the GC
  never feels pressure and never runs.
- Finalizers exist but are unpredictable and hazardous at teardown.

Therefore: **explicit disposal is the contract; the GC is insurance.**

## 2. Ownership mapping

| C object | Created by | Freed by | JS representation |
|----------|-----------|----------|-------------------|
| `GEOSContextHandle_t` | `GEOS_init_r` (shim `geos_shim_init`) | `GEOS_finish_r` | `Geos` (`Symbol.dispose`) |
| `GEOSGeometry` | constructors/readers/ops | `GEOSGeom_destroy_r` — **by the creating context** | `Geometry` (numeric ptr + owning `Geos`) |
| `GEOSCoordSequence` | `CoordSeq_copyFromBuffer` | usually transferred into a geometry (destroying the geometry frees it) | never exposed; transient |
| WKT/WKB/GeoJSON output strings | readers/writers | `GEOSFree` — never `free()` (Windows CRT mismatch) | cloned into JS strings/`Uint8Array` at the boundary, C side freed immediately |
| `GEOSWKTReader/Writer`, `GEOSWKBReader/Writer` | create | matching `*_destroy` | pooled per `Geos`, not per call |
| `GEOSPreparedGeometry` | `GEOSPrepare` | `GEOSPreparedGeom_destroy` | `Prepared` (`using`-able; holds source alive) |
| STRtree items | — | **borrowed** — tree takes no ownership | integer ids; `Map<id, Geometry>` in JS |
| Shim-internal buffers | shim | shim (`destroy_many` frees both geoms and the pointer array) | invisible |

Two hard rules enforced at the API layer:

1. **Same-context destroy** — a `Geometry` used with a different `Geos` throws
   `TypeError` (the Rust lifetime lesson, enforced structurally: D11).
2. **Transfer semantics** — construction functions take ownership exactly as GEOS does;
   the shim's builders free what they allocated and hand GEOS the rest.

## 3. Disposal discipline

```ts
// One-off: explicit dispose
const g = geos.readWKT(wkt);
try { /* … */ } finally { g.dispose(); }       // or: using g = … (TS explicit resource mgmt)

// Hot loop: arena
using arena = geos.arena();
for (const w of wkts) {
  const g = arena.read(wkb);                   // registered, not individually freed
  results.push(geos.intersection(a, g));
}                                              // ← shim destroy_many: one FFI call

// Batch op outputs can be arena-allocated too:
const merged = geos.unionAll(parcels, { arena });  // caller frees `merged` or the arena does
```

- `using` / `Symbol.dispose` is the primary ergonomic path (Bun supports TS explicit
  resource management).
- Arenas never free geoms they didn't create (only registration counts).
- Nested arenas are allowed; child disposal is independent.

## 4. FinalizationRegistry — backstop only

A registry maps `Geometry` → `(ctx, ptr)` and destroys orphans on collection. Constraints
documented on the API:

- It is a **leak net, not a strategy**: collection timing is unspecified; at process
  teardown FFI calls may be unsafe, so orphans at exit are reported, not freed.
- `Geometry` finalization never touches the STRtree (borrowed-pointer rule): trees hold
  ids, and tree `dispose()` validates that registered geoms are still alive — stale ids
  are a `GeosError`, never a dangling pointer deref.

## 5. Making the invisible heap visible

Each `Geos` maintains counters fed by the shim (create/destroy hooks):

- live geometry count, approximate C-heap bytes,
- arena high-water marks.

Exposed as `geos.stats` and included in leak-test assertions. This is the go-geos lesson
(their README's "Memory management" warning) answered with instrumentation instead of
apology.

## 6. Pitfall checklist (encoded in tests)

| Pitfall | Guard |
|---------|-------|
| `free()` on GEOS memory (Windows CRT mismatch) | `GEOSFree` only; shim wraps all frees |
| Destroying a geometry with a foreign context | wrapper throws `TypeError` |
| Tree outliving indexed geoms | id registry + dispose-time validation |
| STRtree item pointers stored raw in JS | items are integer ids, never pointers |
| WKB output `Uint8Array` aliasing C memory | boundary always copies; C side freed immediately |
| Geometry used after dispose | wrapper flags disposed; use throws (debug) / is a no-op-safe error |
| Borrowed view used after its parent was disposed | view holds a weak parent ref; use throws `TypeError` (Phase 1, audit H1 — GEOS has no liveness query, so this is wrapper-side) |
| Finalizer ABA: stale queued finalizer destroys a recycled address | live-map entries carry the owning token; reap/destroy/renounce verify token identity before freeing (Phase 1, audit C1) |
| Transferred collection parts freed twice (duplicates / borrowed views) | `fromParts(transfer)` rejects duplicates and non-owned parts up front; renounce runs before the (throwing) take (audit C2) |
| Finalizer re-entering FFI at teardown | finalizers never run during `process` exit path; orphans reported |
