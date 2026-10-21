# Design: concurrency model

> Status: describes the **implemented system** (0.1.0). Implements D3 and D11. Factual inputs:
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
- **Cooperative cancellation (D19 — amended in Phase 2).** The shim keeps an ATOMIC
  GLOBAL interrupt flag read by the per-context `GEOSContextInterruptCallback` at GEOS's
  own interruption points; `geos_shim_interrupt_request/reset` are thread-safe.
  `{ signal }` on an op gives: a pre-check, a listener that flips the flag, a reset in
  `finally`, and `GeosError("aborted", cause = signal.reason)` on failure.
- **THE SAME-THREAD LIMITATION (measured, not theoretical):** a synchronous FFI call
  blocks the JS thread, so a listener on the calling thread — including its timers —
  CANNOT fire mid-call. Mid-flight cancellation of a main-thread op therefore requires
  flipping the flag from ANOTHER thread: a Worker calls `geos.interruptRequest()` on its
  own schedule (the test helper `test/helpers/interrupt-worker.ts` shows the pattern).
  Main-thread `signal` still always delivers the pre-check and the aborted-error shape.
- The real ergonomic path is Phase 3 `geos.parallel.*`: the op runs on a Worker, the
  main thread stays free, its listener can message the Worker, and the Worker flips the
  flag while its own GEOS call executes.

```ts
const out = await geos.parallel.intersection(bigA, bigB, { signal });  // Phase 3 — truly mid-flight cancellable
const out2 = geos.intersection(a, b, { signal });                      // pre-check + cross-thread flip + aborted shape
```

- Guidance in docs: anything expected to exceed ~a frame belongs on a Worker — the
  `parallel.*` mirrors exist to make that the easy path, not the expert path.

## 4. `geos.parallel` — worker-pool helper (Phase 3 — **implemented, D23**)

Decided and implemented (decisions.md D23; `src/parallel/`):

- A lazily-spawned pool (default: `clamp(navigator.hardwareConcurrency - 1, 1, 8)`,
  `concurrency` option), each Worker owning one `Geos`. First use happens on
  the main thread after the loader has run — the D11 preload rule holds by
  construction. Dispose = shutdown-ack per worker, then terminate (leak-safe).
- **Chunking is by cumulative vertex count** (weights from one
  `geos_shim_num_points_many` crossing — type-generic: polygons sum rings,
  collections recurse, in C), cut in input order, ~`chunkFactor × workers`
  chunks (default 2), floor `minChunkGeoms = 64`. Below `minChunkGeoms × 2`
  items the op runs on the calling thread (pool overhead dominates).
- **Inputs cross as WKB buffers** (transfer lists) — one `fromWKBMany`
  crossing per chunk on the worker; geometry results return as WKB and are
  re-read with one crossing; masks/measures cross as typed arrays. Arrow
  input normalizes on the calling thread before serialization.
- **Chunk-local failures aggregate** into one `GeosParallelError` with
  per-chunk string diagnostics (all-or-nothing, D21/D22).
- **`signal` propagates by partition** (D23.4): the main thread's listener
  flips the global flag directly (it is not blocked — the op runs on
  workers); workers unwind through GEOS interrupt checks; the pool resets
  the flag in `finally`. At most ONE signal-taking parallel op is in flight
  per pool; further ones queue. **Honest bounds:** the flag is
  process-global, so concurrent no-signal pool ops and main-thread
  `withSignal` ops still READ it — a foreign abort can fail their in-flight
  chunks; the partition fixes the flag-ERASURE race, not reader isolation.
  Hard isolation = one pool per process.
- **Determinism note:** results reassemble in input order;
  `parallel.unionAll` is per-chunk `unionAll(strategy)` + one final
  `disjointSubset` union — a valid union, but bitwise identity with the
  main-thread result is not guaranteed for chunks > 1.
- **Engine-flake note (Bun 1.4.3, D23.7):** worker children can die
  pre-handshake without a parent-side signal, and dispatch from a large
  fragmented heap can deadlock the parent in a futex wait. The pool reaps on
  `error`/`exit` + watchdogs (`jobTimeoutMs`) and fails loudly; run
  pool-heavy, long-lived hosts on dedicated processes (as the bench does) and
  re-verify on Bun bumps.

## 5. Anti-patterns this design forbids

1. Sharing one `Geos` across threads "because locking" — GEOS gives no cross-thread
   guarantees on one handle; per-thread contexts are free.
2. `SharedArrayBuffer`-backed coordinate views handed to GEOS while another thread may
   resize them — inputs are copied or pinned for the call's duration.
3. Long-running ops on the main thread without `signal` or Worker offload.
4. Spawning Workers before the loader has run on the main thread.
