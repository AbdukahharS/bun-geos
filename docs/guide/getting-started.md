# Getting started

> User guide. For the design rationale behind anything here, follow the D-numbers into
> [the decision record](../decisions.md).

## Install

```sh
bun add @shzd/bun-geos
```

Nothing else is required — no system GEOS, no compiler. The platform package (binaries +
shim) is picked automatically. If the loader can't find a matching package it fails with an
actionable message listing what it looked for.

Exotic setup (debugging against a system GEOS, unsupported platforms):

```sh
BUN_GEOS_LIBRARY=/path/to/libgeos_c.so.1 bun run app.ts
```

The override is asserted to be GEOS **3.14.x** like any bundled binary — a mismatch is a hard
error with remediation text (D8). No compatibility promises are made against system GEOS.

## Your first overlay

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos();                      // one per thread (see the workers guide)

const a = geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))");
const b = geos.fromWKT("POLYGON ((2 2, 6 2, 6 6, 2 6, 2 2))");

using overlap = geos.intersection(a, b);      // OverlayNGRobust underneath
console.log(geos.area(overlap));              // 4
console.log(geos.toWKT(overlap));             // POLYGON ((2 2, 4 2, 4 4, 2 4, 2 2))
```

`using` (explicit resource management) disposes the C-side geometry deterministically. Every
`Geos`/`Geometry`/`Prepared`/`STRtree`/arena is disposable; when a scope exits, C memory is
freed — [details](./memory-and-disposal.md).

## I/O formats

| Format | In | Out | Notes |
|--------|----|-----|-------|
| WKT | `geos.fromWKT(s)` | `geos.toWKT(g, opts?)` | debugging, goldens |
| WKB | `geos.fromWKB(buf)` / `fromWKBMany(buf, offsets)` | `geos.toWKB(g, opts?)` | wire format; PostGIS `bytea` is EWKB and round-trips incl. SRID |
| GeoJSON | `geos.fromGeoJSON(obj)` | `geos.toGeoJSON(g, opts?)` | parsed **in JS** for precise errors: `ring 2, vertex 17: expected 2 ordinates, got 3` (D13) |
| GeoArrow | `geos.fromArrow(arr)` | `geos.toArrow(g)` | near zero-copy; the batch ops speak this natively |
| Flat buffers | `geos.fromCoords(flat)` | — | `Float64Array` + offsets — the canonical currency (D9) |

Ring-closure policy: unclosed polygon rings are auto-closed on input; rings with < 3 distinct
positions are rejected with a precise `GeosError`. Ring winding is preserved as input — RFC
7946's right-hand-rule recommendation is opt-in via `geos.orientPolygons(g, "ccw" | "cw")`,
never silent.

## The batch forms

Plural forms are not JS loops over the singular — they're one FFI crossing into C
([D22](../decisions.md)):

```ts
const masks: Uint8Array = prep.intersectsAll(candidates);      // 0/1 per item
const areas: Float64Array = geos.areaAll(geoms);
const fixed: Geometry[] = await geos.parallel.makeValid(dirty); // worker pool
const one = geos.unionAll(coverages);                           // strategy-dispatched aggregate
```

Naming: element-wise batches are `*All` — `intersectionAll(a, bs)[i] === intersection(a, bs[i])`.
`unionAll(gs)` is the aggregate (a single union of everything).

## Errors

Two families ([D13](../decisions.md)):

- **Programming errors** → `TypeError`/`RangeError`. Foreign-context geometry, use-after-dispose,
  malformed DE-9IM patterns. Fix your code.
- **Data / GEOS errors** → `GeosError` carrying `op` (the operation), the captured GEOS message,
  and JS-side structural detail (ring/vertex indices, byte offsets) where known. Repair paths can
  attach diagnostics. Parsing failures are `GeosError`s with JSON-path precision because GeoJSON
  conversion happens in JS.

Aborts are uniform: an op given `{ signal }` that is cancelled throws `GeosError` with
`op: "aborted"` and `cause: signal.reason` (see [workers guide](./workers-and-parallelism.md)).

## Version policy

The library ships its own GEOS 3.14 build — strictly (D5). You will never see a GEOS version,
never gate on capabilities; GEOS upgrades arrive as `@shzd/bun-geos` releases. The only version
logic anywhere is the load-time assertion. `geos.version` exists for bug reports.
