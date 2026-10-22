# Memory & disposal

> User guide. The design contract lives in [memory.md](../design/memory.md) (D10); this page is
> what you need to *use* it.

## The one-paragraph model

Your JS objects live in JavaScriptCore's heap. The geometry data lives in the **C heap**, which
JSC cannot see: a million live geometries can occupy gigabytes while the JS wrappers look tiny,
so the GC never feels pressure and never runs. Therefore **explicit disposal is the contract;
the GC is insurance.**

## `using` — the everyday path

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos();              // disposing the context tears down everything it owns
using a = geos.fromWKT(wkt);
using prep = a.prepare();
// ... scope exit frees a, prep, then the context — in dependency order
```

Bun supports TypeScript explicit resource management natively. If you can't use `using`
(e.g. dynamic lifetimes), call `.dispose()` yourself — disposal is idempotent-ish: disposing
a geometry twice, or using one after disposal, throws a `TypeError` with remediation text
rather than corrupting memory.

## Arenas — hot loops

```ts
using arena = geos.arena();
for (const w of tenThousandWkts) {
  const g = arena.read(wkb);          // registered, NOT individually freed
  results.push(geos.area(g));
}                                     // one FFI crossing frees all 10k
```

Nested arenas are allowed; a child's disposal is independent. A geometry that escapes the arena
(e.g. it was *prepared* or indexed — those take ownership-grade references, D17) is
relinquished from the arena at pin time and becomes individually owned by you. Disposing a
pinned geometry while its consumer lives throws.

## Watching the invisible heap

```ts
geos.stats;             // { liveGeoms, heapBytesApprox, finalizerReaps, peakLiveGeoms, arenaHighWater, ... }
geos.statsPrecise();    // one shim crossing over live pointers: 64 B + vertices × dims × 8 each
```

Both feed the leak tests in CI (a 10M create/destroy soak must return to baseline; batch-op
arena churn and pool ops must too — D24). If your long-running service's `stats` climbs, you
are leaking geometries: look for a loop that dropped its `using`.

## The FinalizationRegistry

A registry reaps geometries you *forgot* to dispose, when the GC eventually collects the
wrapper. It is a **leak net, not a strategy**: collection timing is unspecified, and at process
teardown orphans are reported, not freed (FFI calls during exit are unsafe). If you ever see
`finalizerReaps` move, fix the disposal bug — don't rely on it.

**Arena-owned geometries skip the registry.** When an output is born inside an explicit
arena, the arena's bulk `destroy_many` *is* the backstop, so the per-geometry registry
registration is redundant work and is skipped (a measurable ~40% of batch-output
wrapping). Semantics per flavour:

- dispose individually → still works (the registry-unregister call is a documented no-op
  for an unregistered token);
- drop the wrapper undisposed → memory is held until arena exit instead of the wrapper's
  collection — the arena lifetime model, unchanged for the caller. (Sub-case: if the
  geometry was pinned *after* birth, pinning already relinquished arena ownership, so the
  hold extends to **context** dispose — still bounded, still safe in `using`-style usage);
- stats → unaffected: `#live` bookkeeping and arena teardown accounting are identical
  (the D24 soak asserts the return-to-baseline invariant with the fast path active).

Context-owned geometries (no arena) keep the full registry net.

## Pitfall checklist (each guarded by a test)

| Pitfall | What happens instead |
|---------|----------------------|
| `free()` on GEOS memory | never exposed; all frees go through `GEOSFree_r` (Windows CRT mismatch is real) |
| Destroying with a foreign context | `TypeError` — geometries remember their owner |
| STRtree outliving indexed geoms | trees hold strong pinned references; disposal order is enforced (D17) |
| WKB output aliasing C memory | the boundary always copies; the C buffer is freed immediately |
| Stale finalizer after pointer reuse | reap/destroy verify ownership tokens before freeing |
| Borrowed view used after parent disposal | the view holds a weak parent; use throws `TypeError` |

## Z and M

`GEOSCoordSeq` Z/M presence is detected via the 3.14 accessors and preserved through builders
and I/O. Ops that drop Z/M (GEOS "best effort") say so in their docs entry; the I/O layer never
silently downsamples.
