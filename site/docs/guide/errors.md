---
description: The error model as a two-column table — your bug throws TypeError or RangeError, your data throws GeosError carrying the operation and the exact structural location.
---

# Errors

The error model is a two-column table: **your bug** or **your data**. Programming
mistakes throw standard `TypeError`/`RangeError`. Data and GEOS failures throw
`GeosError`, which carries the operation name, the GEOS message, and — where known —
the exact structural location of the offense. Nothing throws a bare string; nothing
fails silently.

## `GeosError` — data and GEOS failures

```ts
import { GeosError } from "@shzd/bun-geos";

try {
  geos.fromGeoJSON(badJson);
} catch (e) {
  if (e instanceof GeosError) {
    e.name;         // "GeosError"
    e.op;           // "fromGeoJSON" — the operation that failed
    e.geosMessage;  // the captured GEOS message, when GEOS produced one
    e.detail;       // structural context: { jsonPath?, ring?, vertex?, byteOffset? }
    e.message;      // 'GEOS fromGeoJSON failed: expected a finite number (at geometry.coordinates[0][2][1])'
  }
}
```

The `message` format is stable: `GEOS <op> failed: <geosMessage>` — plus
`(at <jsonPath>, ring N, vertex N, byte N)` when structural detail is known. Log
`op` + `message` and your support ticket writes itself.

Where each detail field comes from:

| Field | Thrown by |
|-------|-----------|
| `jsonPath` | GeoJSON parsing — the exact path of the offending value (rooted at `geometry.`) |
| `ring` | ring-level structural violations in GeoJSON polygonal input |
| `vertex` | position-level violations in direct construction (`point`/`fromCoords`/`fromPolygonal`) |

(Bad WKB fails with the GEOS message and no structural detail; the `byteOffset` detail
slot exists in the type but no current throw site populates it.)

One further field, `e.diagnostics`, is the reserved carrier for repair-op validity
context — string-only by design, because a thrown error must never own native memory.
No current throw site populates it; for invalidity detail today, use
`geos.isValidDetail(g)` or `geos.isSimpleDetail(g)`, which hand the location to you as
a real geometry instead.

## `RangeError` / `TypeError` — your bug, loudly

These never indicate native trouble; they indicate the call was wrong before any C
code ran:

- `geos.fromWKBMany(wkb, offsets)` with non-increasing offsets → `RangeError` (with
  the offending index), because a bad offset table would read out of bounds in C —
  it's validated at the boundary instead.
- `geos.unionAll([])` → `RangeError`: needs at least one geometry.
- Passing a `Geometry` from another `Geos` context → `TypeError`. Context-mixing is a
  memory bug in the making; it's rejected, not absorbed.
- Using a disposed `Geometry`/`Geos`/`Prepared`/`STRtree` → loud throw, not a
  use-after-free.

## Cancellation: `GeosError("aborted")`

An already-aborted `AbortSignal` surfaces as `GeosError` with `op = "aborted"` and
`cause = signal.reason`; a call that *fails* while its signal is aborted keeps the
underlying error as `cause`:

```ts
try {
  await pool.makeValid(huge, { signal: controller.signal });
} catch (e) {
  if (e instanceof GeosError && e.op === "aborted") {
    console.log("cancelled:", (e.cause as Error)?.message);
  }
}
```

The same-thread caveat (the listener can't fire while the JS thread is blocked in FFI)
is tabulated in [Workers & parallelism](/guide/workers).

## `GeosParallelError` — all-or-nothing parallel failure

A parallel batch fails as one error with per-chunk diagnostics:

```ts
catch (e) {
  if (e instanceof GeosParallelError) {
    for (const { chunk, message } of e.chunkErrors) {
      console.error(`chunk ${chunk} failed: ${message}`);
    }
  }
}
```

Chunks are input slices (see `chunkFactor`/`minChunkGeoms`), so you can locate and
retry the failing slice of input. The pool never hangs: a worker that neither returns
nor dies trips the watchdog (`jobTimeoutMs`, default 120 s) and the job fails with
this error.

## `LoaderError` — environment failures

`new Geos()` throws `LoaderError` when the native side can't come up: platform package
missing, shim damaged, `BUN_GEOS_LIBRARY` pointing at a missing or version-mismatched
library, or two different overrides in one process. Every message carries remediation
text — the full catalog with fixes lives in [Install & platforms](/install#loader-errors-and-what-each-one-means).

## The catch-all pattern

```ts
import { GeosError, GeosParallelError, LoaderError } from "@shzd/bun-geos";

try {
  // geometry work
} catch (e) {
  if (e instanceof GeosParallelError) {
    retryOrSplit(e.chunkErrors); // per-chunk diagnostics — retry the bad slices
  } else if (e instanceof LoaderError) {
    throw e; // the environment is broken — crash loudly, this won't heal
  } else if (e instanceof GeosError) {
    quarantine(e.op, e.message, e.detail); // data problem — park the input
  } else {
    throw e; // TypeError/RangeError: fix the call site
  }
}
```

> [!NOTE]
> The most dangerous "error" is the one that doesn't throw: planar-CRS misuse produces
> confidently wrong numbers. No exception will save you from degrees-as-meters —
> project first. See the [front page](/).

## Where to next

- [Workers & parallelism](/guide/workers) — chunking, watchdogs, cancellation semantics
- [Install & platforms](/install) — the `LoaderError` catalog
- [API reference](/reference) — every throwing surface, annotated
