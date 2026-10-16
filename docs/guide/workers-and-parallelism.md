# Workers & parallelism

> User guide. The model is [concurrency.md](../design/concurrency.md) (D3/D11/D19/D23); this
> page is the rules and the ergonomics.

## The rules (hard errors, not warnings)

1. **One `Geos` per thread.** GEOS's reentrant API is thread-local; each Bun Worker that
   imports the package gets its own context. Sharing a `Geos` (or a `Geometry` created by it)
   across threads throws — GEOS gives no cross-thread guarantees on one handle, and per-thread
   contexts are free.
2. **Geometries never cross a worker boundary.** To move one, transfer a **copy**:
   `toWKB()` / `toGeoJSON()` / `toArrow()`. Typed arrays (coords, masks, WKB) cross freely.
3. **The native library loads on the main thread before Workers spawn.** With `geos.parallel`
   this holds by construction (the pool is lazily spawned on first use from the main thread).
   Spawning a raw Worker that's the *first* thing to import the package is the known Bun
   SIGSEGV class ([#40972](https://github.com/oven-sh/bun/issues/40972)) — don't.

## Sync calls block — that's the feature

Every GEOS call is synchronous and blocks the calling thread's event loop for the duration.
Sub-millisecond ops: invisible. A 30-second overlay: very visible. Anything expected to exceed
~a frame belongs on a Worker — and the `parallel.*` mirrors exist to make that the easy path.

## `geos.parallel.*` — the ergonomic path

```ts
const fixed = await geos.parallel.makeValid(dirtyParcels, {
  signal: controller.signal,     // truly mid-flight cancellable
  concurrency: 12,               // default: clamp(hardwareConcurrency - 1, 1, 8)
  chunkFactor: 3,                // ~workers × factor chunks
});
```

- **Transfers are WKB**: chunks go out as one buffer + offsets via postMessage transfer lists;
  masks/measures cross as typed arrays. Geometries never cross (rule 2).
- **Chunking is by cumulative vertex count**, cut in input order; results reassemble in input
  order. Below `minChunkGeoms × 2` items the op runs on the calling thread (pool overhead
  dominates small batches).
- **Failures aggregate**: all-or-nothing — every chunk failure is collected and the op rejects
  with one `GeosParallelError` carrying per-chunk string diagnostics.
- **Determinism**: `parallel.unionAll` = per-chunk strategy union + one final disjoint-subset
  union — a valid union, but bitwise identity with the main-thread result is NOT guaranteed
  for chunks > 1 (union is order-sensitive at float level).
- **The pool is a consumable**: disposing the `Geos` shuts it down (workers acknowledge before
  terminate — a terminated worker would leak its C session).

Measured honestly: `parallel makeValid` at 10⁵ geometries is ~4–5× over per-object calls
(WKB serialization on the main thread bounds lighter ops — see
[benchmarks](../benchmarks.md) and [D22](../decisions.md) for why the batch axis lives here).

## Cancellation (D19's honest limits)

```ts
const out = await geos.parallel.intersection(a, b, { signal }); // main thread stays free;
                                                                // its listener flips the flag
const res = geos.intersection(a, b, { signal });                // sync: pre-check + aborted
                                                                // error shape, but the call
                                                                // itself blocks the thread
```

The interrupt flag is an **atomic process-global** in the shim, checked by GEOS at its own
interruption points; every op resets it in `finally`. Consequences, stated plainly:

- A synchronous main-thread call **cannot** be interrupted mid-flight by a listener on the
  *same* thread (it's blocked). Cross-thread flips work: a Worker (or `parallel.*`) can flip
  the flag while the main thread's GEOS call runs.
- **At most one signal-taking `parallel` op in flight per pool**; others queue (the flag is
  global — the pool partitions its *ownership*, it cannot isolate *readers*). A concurrent
  no-signal op's workers read the same flag, so a foreign abort can fail their in-flight
  chunks. Hosts needing hard isolation run one pool per process.
- Aborted errors are uniform (`op: "aborted"`, `cause: signal.reason`) across singular, batch,
  and pool paths.

## Engine-flake notes (Bun 1.4.3, D23.7)

Worker children can die pre-handshake without a parent-side signal, and dispatch from a large
fragmented heap can deadlock the parent. The pool defends: `error`/`exit` handlers reap dead
workers; startup + job watchdogs (`jobTimeoutMs`, default 120s) terminate and fail loudly.
Long-running hosts should run pool-heavy work in dedicated processes and re-verify on Bun
bumps (the FFI smoke-test gate does exactly that).
