# Quickstart

The five-minute tour: create a context, build two geometries, overlay them, repair
something, get out without leaking. Everything here is expanded in the
[guides](/guide/io) — this page is the spine.

## One context, own it explicitly

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos();
```

A `Geos` owns a GEOS context (and, on first construction in the process, loads the
native libraries). `using` — TypeScript's explicit resource management — disposes it at
scope exit. Creating it is cheap after the first time; the first call in a process
pays the library load.

## Build geometry from text, bytes, or JSON

```ts
// WKT — the universal debug format
const a = geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))");

// GeoJSON — the interchange format
const b = geos.fromGeoJSON({
  type: "Polygon",
  coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]],
});
```

`fromWKT` returns a **`Geometry`** — an owned handle around a native geometry. WKB and
GeoArrow round-trips work the same way ([Geometry I/O](/guide/io) has all four formats).

## Overlay

```ts
using overlap = geos.intersection(a, b); // OverlayNGRobust under the hood
console.log(geos.toWKT(overlap));        // "POLYGON ((2 2, 4 2, 4 4, 2 4, 2 2))"
console.log(geos.area(overlap));         // 4
```

`intersection`, `union`, `difference`, `symDifference` all take two geometries and
return a new one. The returned geometry is owned by **you** — hence the `using`. If you
generate geometry in a loop, don't dispose one at a time; use an arena
([Memory & disposal](/guide/memory)).

## Repair the real world

Real-world polygons are invalid — self-intersecting rings, spikes, nested holes. GEOS
3.14's repair is one call:

```ts
const broken = geos.fromWKT("POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))"); // bow-tie
using fixed = geos.makeValid(broken);
console.log(geos.isValid(broken)); // false
console.log(geos.isValid(fixed));  // true
```

`isValidDetail()` hands you the *reason* and *location* of an invalidity as geometry,
not prose. The full repair/validity story: [Overlays & operations](/guide/overlays).

## Ask spatial questions

```ts
console.log(geos.contains(a, geos.point(1, 1))); // true

using prep = a.prepare(); // prepared predicates: build once, ask many
console.log(prep.intersects(b)); // true
```

For "one geometry against ten thousand", skip the loop — the batch forms return typed
arrays in one FFI crossing, and the STRtree indexes for envelope queries:

```ts
const tree = geos.strtree(geometries, 10);
const hits: Int32Array = tree.query(envelope); // candidate ids, one crossing
```

[Predicates & indexing](/guide/predicates) is the whole story.

## Free it all

Dispose explicitly and scope-honestly:

```ts
{
  using geos = new Geos();
  using a = geos.fromWKT("POINT (0 0)");
  // …
} // a disposed, then geos (context + native library bookkeeping) — in order
```

Hot loops use `geos.arena()` so ten thousand temporaries die in **one** native call. A
`FinalizationRegistry` will eventually reclaim anything you forget — that is the leak
*net*, not a strategy. → [Memory & disposal](/guide/memory).

## When things throw

- `fromWKT("POLYGON ((0 0)")` → `GeosError` with the GEOS parser message.
- `geos.intersection(a, b)` where `b` came from a *different* `Geos` → `TypeError`.
  Geometries are context-bound; that's a programming error, not a runtime failure.
- Feeding lat/lon degrees to `buffer(1000)` → **no error at all**. Garbage answers, no
  exceptions. Project to a planar CRS first — see the warning on the
  [front page](/).

The complete error taxonomy: [Errors](/guide/errors).

## Where to next

- [Geometry I/O](/guide/io) — WKT/WKB/GeoJSON/Arrow, batch ingest, SRIDs
- [Overlays & operations](/guide/overlays) — the full op tour
- [Memory & disposal](/guide/memory) — arenas, stats, the three rules in depth
