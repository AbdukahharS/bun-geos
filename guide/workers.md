# Workers & parallelism

Two different problems live on this page: **moving geometry across threads** (the
rules) and **not writing the threading code at all** (`geos.parallel`). The second
exists so you only ever need the first one for I/O boundaries.

## The thread rule

**One `Geos` per thread; geometries never cross it.** A `Geos` wraps a GEOS context,
the context is not thread-safe, and a `Geometry` is a handle into its owning context's
memory. Passing a `Geometry` to another Worker is not a race you might lose — it is a
segfault with extra steps.

To move geometry between threads, transfer a **copy** in a context-free format:

```ts
// main worker
const bytes = geos.toWKB(g);
worker.postMessage(bytes);

// inside the Worker — its own Geos, its own context
using geos = new Geos();
const g = geos.fromWKB(bytes);
```

WKB, GeoJSON, and GeoArrow values are all safe payloads. Geometry handles, `Prepared`,
`STRtree`, and arenas are not — they die with their context.

## `geos.parallel` — the batch mirror

For heavy batch work you should not hand-roll the postMessage dance. `geos.parallel`
is a worker pool bound to your `Geos` that mirrors the batch API in Promise form:
it serializes chunks to WKB, fans them out, and rehydrates results as real `Geometry`
objects on the calling thread — all owned by your context, so the thread rule stays
intact by construction.

```ts
using geos = new Geos();
using pool = geos.parallel;

const repaired: Geometry[] = await pool.makeValid(brokenParcels);
const masks: Uint8Array = await pool.intersectsAll(a, candidates);
const areas: Float64Array = await pool.areaAll(geoms);
const merged = await pool.unionAll(parcels);
```

What's mirrored: the predicate batches (`intersectsAll`, `containsAll`, `coveredByAll`,
`coversAll`, `crossesAll`, `disjointAll`, `overlapsAll`, `touchesAll`, `withinAll`),
the overlay batches (`intersectionAll`, `differenceAll`, `symDifferenceAll`), the
measures (`areaAll`, `lengthAll`, `distanceAll`, `hausdorffAll`, `frechetAll`),
`bufferAll`, `makeValid`, and `unionAll`.

Tuning (`ParallelOptions`):

| Option | Default | Meaning |
|--------|---------|---------|
| `concurrency` | `clamp(cores − 1, 1, 8)` | pool size |
| `chunkFactor` | `2` | chunks per worker (load-balancing oversubscription) |
| `minChunkGeoms` | `64` | chunk floor — amortizes WKB serialization |
| `jobTimeoutMs` | `120000` | per-chunk watchdog; the pool **never hangs** — a stuck worker is terminated and the job fails loudly |
| `signal` | — | `AbortSignal` cancellation |

**One honest caveat**: parallel `unionAll` unions per chunk, then reduces with one
final `unionAll("disjointSubset")` on the calling thread. The result is *a* valid
union — but for more than one chunk it is **not guaranteed bitwise-identical** to the
main-thread `geos.unionAll` (union is order-sensitive at float level). If your test
goldens compare exact bytes, union on one thread.

Failure is all-or-nothing: a `GeosParallelError` carries per-chunk diagnostics
(`chunkErrors: Array<{ chunk, message }>`) — you see exactly which slice of input
failed, not just "something threw".

## Cancellation: the honest table

Synchronous FFI calls block the JS thread, so cancellation has a shape you should know
rather than discover:

| Scenario | What you get |
|----------|--------------|
| signal already aborted | throws **before** any native call — `GeosError("aborted")`, `cause = signal.reason` |
| same-thread op, signal aborts mid-call | the listener can't fire (the thread is blocked in FFI). If the call then *fails*, the failure surfaces as `GeosError("aborted")` with `cause` carrying the underlying error (or the signal's reason); if the call *succeeds*, the result is returned normally — the abort bites on the next pre-check |
| abort fired **from another thread** | mid-flight cancellation — the interrupt flag is checked at GEOS's own interruption points |
| `geos.parallel.*` op | real cancellation: the main thread's listener is free, aborted chunks stop, in-flight work unwinds cleanly |

Every cancellable op takes `{ signal }` (`OpOptions`). There is also the manual switch:

```ts
// from another Worker: geos.interruptRequest() flips the flag the running op checks
```

The flag is process-global — cross-Worker setups must keep at most one signal-taking
op in flight per flag. Within one thread, ops are sequential and this cannot happen.

## Sizing

The default pool is `clamp(hardwareConcurrency − 1, 1, 8)` — leave it alone unless you
have measured a reason. More workers than cores is throughput theater; the
serialization boundary (WKB bytes across postMessage) dominates for small geometries,
which is exactly what `minChunkGeoms` exists to amortize. The sweet spot for mixed
workloads is usually the default with `chunkFactor: 2`.

## Where to next

- [Memory & disposal](/guide/memory) — who owns the rehydrated results (you do)
- [Predicates & indexing](/guide/predicates) — the single-threaded batch forms, first
- [Errors](/guide/errors) — `GeosParallelError` in detail
