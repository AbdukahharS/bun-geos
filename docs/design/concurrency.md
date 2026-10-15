# Design: concurrency model

> Status: design target (post-spike). Implements D3 and D11. Factual inputs:
> GEOS context handles are thread-local ([GEOS research §3](../research/geos.md));
> concurrent `dlopen` from freshly spawned Bun Workers has caused intermittent SIGSEGVs
> ([oven-sh/bun#40972](https://github.com/oven-sh/bun/issues/40972)).

## 1. The model

```
main thread                          worker threads (Bun Workers)
───────────                          ────────────────────────────
import "@shzd/bun-geos"
  └─ loader dlopens shim+libgeos     new Worker("./job.ts")
     on the MAIN thread first  ───►     └─ import "@shzd/bun-geos"
                                           └─ dlopen = no-op refcount (lib mapped)
Geos (context A)                        Geos (context B)   ← GEOS_init_r per thread
geometry work A                         geometry work B
```

- **One `Geos` context per thread**, matching GEOS's reentrant design (D3). The main
  thread's instance is the default export's singleton; each Worker that imports the
  package lazily creates its own.
- **Preload rule:** the loader runs on the main thread before any Worker is spawned
  (documented + enforced by a helpful error if a Worker is the first loader and #40972
  still reproduces). This removes the concurrent-`dlopen` race class entirely.
- `bun:ffi` has no supported `AsyncFunction` on the threadpool in current docs — async
  GEOS execution does not exist. Sync calls are the feature (they're where the speed
  comes from), and Workers are the concurrency story.

## 2. Cross-worker boundary rules

| Object | Across workers? | Instead |
|--------|-----------------|---------|
| `Geometry` | **never** — its pointer belongs to the creating context | `geometry.toWKB()` / `toGeoJSON()` / `toArrow()` — a copy |
| `Geos` instance | never | each thread creates its own |
| `Prepared`, `STRtree` | never | rebuild on the worker (prepare cost is usually the cheap part) |
| Typed arrays (coords, masks, WKB) | freely (structured clone / SharedArrayBuffer) | — |

These are hard errors, not warnings: using a `Geometry` with another thread's `Geos`
throws (same-context rule, [memory §2](memory.md)).

## 3. Event-loop behavior & cancellation

- Every GEOS call is synchronous and **blocks the calling thread's event loop** for the
  duration of the C call. For sub-millisecond ops this is invisible; for a 30-second
  overlay it is not.
- **Cooperative cancellation:** the shim exposes an interrupt flag
  (`geos_shim_interrupt_request/reset`); an `AbortSignal` listener flips it, GEOS's
  `GEOSInterruptCallback` polls it mid-operation, the op aborts, the flag resets, and the
  call throws `GeosError("aborted")`.

```ts
const out = await geos.parallel.intersection(bigA, bigB, { signal });  // worker-based
const out2 = geos.intersection(a, b, { signal });                      // main-thread, still cancellable
```

- Guidance in docs: anything expected to exceed ~a frame belongs on a Worker — the
  `parallel.*` mirrors exist to make that the easy path, not the expert path.

## 4. `geos.parallel()` — worker-pool helper (Phase 3)

Sketch (chunking semantics are on the [open design list](../decisions.md)):

- A lazily-spawned pool (default: `navigator.hardwareConcurrency - 1`, clamped), each
  Worker owning one `Geos`.
- Batch ops chunk their input by cumulative vertex count (not by geometry count — one
  10⁶-vertex geom is not a fair "chunk of 1000").
- Inputs cross as WKB or GeoArrow buffers; results return the same way (the canonical
  currency makes chunking nearly free — D9).
- Chunk-local failures aggregate into a single `GeosError` with per-chunk diagnostics.
- `signal` propagates to every in-flight chunk; the pool drains idempotently.
- Determinism note: overlay results are deterministic per chunk, but `parallel.unionAll`
  must preserve a defined concat order (documented: input order, strategy-dependent).

## 5. Anti-patterns this design forbids

1. Sharing one `Geos` across threads "because locking" — GEOS gives no cross-thread
   guarantees on one handle; per-thread contexts are free.
2. `SharedArrayBuffer`-backed coordinate views handed to GEOS while another thread may
   resize them — inputs are copied or pinned for the call's duration.
3. Long-running ops on the main thread without `signal` or Worker offload.
4. Spawning Workers before the loader has run on the main thread.
