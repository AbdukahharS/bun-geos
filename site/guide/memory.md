---
description: Owning C memory without leaking — using-blocks as the default, arenas for one-teardown loops, live memory accounting, and a finalizer as the net rather than the strategy.
---

# Memory & disposal

Every `Geometry` you hold is a handle to C memory. This library's deal is honest: you
own what you create, the tools make ownership cheap, and a finalizer exists so a bug
becomes a statistic instead of a crash. Read this page once and you will never leak.

## The three rules, expanded

1. **Project to a planar CRS first.** Not memory — but it's rule 1 for a reason. Back to
   the [front page](/).
2. **Dispose what you create.** `using` everywhere; arenas for hot loops.
3. **One `Geos` per thread.** Geometry never crosses a context. → [Workers](/guide/workers).

## `using` is the default

Every resource-carrying object — `Geos`, `Geometry`, `Prepared`, `STRtree`, `Arena`,
`geos.parallel` — implements `Disposable`. Explicit resource management is the
ergonomic path:

```ts
{
  using geos = new Geos();
  using a = geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))");
  using prep = a.prepare();
  // …
} // disposed in reverse order, native memory freed, deterministically
```

Batch and bulk forms also accept `{ arena }` — [covered below](#ops-that-accept-an-arena).

## Arenas: one teardown crossing for the whole loop

Disposing N geometries individually is N FFI crossings. An arena registers everything
created inside it and destroys them all in **one** native call at exit
(`destroy_many`). This is the hot-loop contract:

```ts
using geos = new Geos();

using arena = geos.arena(); // anything created while open dies with it
for (const wkt of tenThousandWktStrings) {
  const g = geos.fromWKT(wkt);   // registered with the arena, no per-item dispose
  // … transient work …
} // ← one `using` scope exit = ONE bulk destroy
```

- Arenas **nest**. A child's disposal is independent; an arena only ever frees
  geometries it registered — individually-disposed geometries are removed from it.
- `arena.size` tells you how many handles are registered right now.
- After the arena closes, new geometry falls through to individual disposal — the
  footgun direction is forgetting the arena, and that direction fails safe.

> [!NOTE]
> The pattern for a function that returns geometry: open an arena inside, do the work,
> then hand results back via a format that survives (`toWKB`/`toGeoJSON` bytes), or
> take `{ arena }` from the caller. A `Geometry` outliving its arena is a programming
> error and will say so loudly the next time you touch it.

### Ops that accept an arena

Not every op takes an arena — the batch and bulk forms do:

```ts
geos.fromWKBMany(wkb, offsets, { arena });
geos.unionAll(gs, { strategy: "auto", arena });
geos.coverageUnion(gs, { arena });
geos.makeValid(g, { arena });
geos.coverageClean(gs, { arena });
geos.coverageSimplifyVW(gs, tolerance, { arena });
geos.areaAll(gs, { arena }); // every *All batch form
geos.empty(kind, arena);
```

The plain single-geometry constructors (`fromWKT`, `fromGeoJSON`, `fromWKB`,
`point`, …) and the plain overlays register with the innermost open arena, or with
the context if none is open — dispose them (or scope an arena around the work).

## How much is alive right now

```ts
geos.stats;
// {
//   liveGeoms: number;        // owned geometries currently alive in this context
//   heapBytesApprox: number;  // floor: liveGeoms × minimum per-geometry C-heap cost
//   finalized: number;        // geometries reclaimed by the FinalizationRegistry (the leak net)
//   peakLiveGeoms: number;    // high-water mark
//   arenaHighWater: number;   // high-water mark of geometries under open arenas
// }

geos.statsPrecise(); // { liveGeoms, heapBytesApprox } — exact count, walks the registry
```

`heapBytesApprox` is a **floor** (`liveGeoms × 64`), not a measurement of GEOS's
internal structures — `statsPrecise()` gives the exact live-geometry count, but the
heap number stays an estimate there too. Its job is to make a leak *visible as a
monotonic ramp in your metrics*, not to bill you for bytes.

## The finalization registry — the net, not the strategy

If a `Geometry` is garbage-collected without `dispose()`, a
`FinalizationRegistry` reclaims the native memory and bumps `stats.finalized`.
This converts a leak into a number you can alert on. It is not a strategy:

- GC timing is nondeterministic — "freed eventually" is not "freed" for a
  100-million-vertex batch at 3 AM.
- A nonzero, growing `finalized` counter means you missed a disposal site. Fix the
  site; don't celebrate the net.
- Geometries created while an arena is open skip the per-geometry net — the arena's
  bulk destroy is the backstop, and double-netting every batch item is wasted work
  (skipping it measurably speeds up `fromWKBMany`-scale ingests). Context-owned
  geometries keep the full net.

## Context discipline

- **`requireSame`**: every op asserts all geometries belong to the same `Geos`. A
  geometry from another context throws `TypeError` — context-mixing is a programming
  error, and mixing it silently would be a memory bug.
- **Pins**: ops that hold a geometry across a callback mark it `pinned` — every
  `prepare()` and every STRtree insert does this internally, so a pinned geometry
  refuses `dispose()` until released. You'll meet it as a loud throw, not silent
  corruption; lower-level escape hatches (`pinBy`/`unpinBy`/`renounce`) exist and
  are sharp edges — prefer the documented paths.

## The checklist

- `using` on every `Geos`, `Geometry`, `Prepared`, `STRtree`, arena, and the pool.
- Hot loop? `geos.arena()`.
- Returning from a scope? Bytes out, or caller-provided `{ arena }`.
- Watch `geos.stats.finalized` — nonzero and climbing means a missing `using`.
- Geometries never cross `Geos` contexts or threads — copy as WKB. → [Workers](/guide/workers).

## Where to next

- [Workers & parallelism](/guide/workers) — the thread-affinity rules in full
- [Quickstart](/quickstart) — the 5-minute version of this page
- [Errors](/guide/errors) — what a use-after-dispose looks like (a loud one)
