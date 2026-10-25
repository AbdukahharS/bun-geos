# Predicates & indexing

Spatial questions, three speeds: single predicates, prepared predicates, and indexed
or batch forms. The rule of thumb: **if you're writing a JS loop over a spatial
question, you're using the wrong API** — there is a batch form that does it in one FFI
crossing, or an index that skips most of the work entirely.

## The predicates

```ts
geos.intersects(a, b);  geos.disjoint(a, b);
geos.touches(a, b);     geos.crosses(a, b);
geos.within(a, b);      geos.contains(a, b);
geos.overlaps(a, b);    geos.covers(a, b);     geos.coveredBy(a, b);
```

Two flavors of equality:

```ts
geos.equals(a, b);            // topological equality (POINT (0 0) == MULTIPOINT((0 0)))
geos.equalsIdentical(a, b);   // structural identity — same coordinates, same structure
```

And the full DE-9IM, when you need the raw relation:

```ts
const matrix = geos.relateMatrix(a, b);   // "212101212" — the DE-9IM string
const ok = geos.relatesPattern(a, b, "T*T***T**"); // query by mask
```

## Prepared predicates — build once, ask many

If one geometry participates in many tests, prepare it. Preparation builds an internal
structure once; each subsequent predicate skips the repeated work. On scan-heavy
workloads this is the difference measured in the repo's
[benchmark suite](/benchmarks) at **~33×** over unprepared scans.

```ts
using prep = a.prepare();

prep.intersects(b);        prep.contains(b);       prep.covers(b);
prep.coveredBy(b);         prep.crosses(b);        prep.disjoint(b);
prep.overlaps(b);          prep.touches(b);        prep.within(b);
prep.containsProperly(b);

// point tests without building a point geometry:
prep.intersectsXY(x, y);   prep.containsXY(x, y);

// the full DE-9IM, prepared:
prep.relate(b);            // matrix string
prep.relatePattern(b, "T*T***T**");
```

`Prepared` is disposable — `using` it like any geometry. It holds a reference to its
source geometry; disposing the source before the prepared structure is a programming
error and throws.

## Batch predicates — one crossing, a typed-array answer

One geometry against ten thousand: the `*All` forms run the whole batch in **one**
shim crossing and return a `Uint8Array` mask (1/0 per input) — no JS loop over FFI
calls, no per-item allocation:

```ts
const hits: Uint8Array = geos.intersectsAll(a, candidates);
const inside: Uint8Array = geos.containsAll(a, candidates);

// every predicate has a batch form, including via name:
const m: Uint8Array = geos.predicateAll("within", a, candidates);
```

Also batched (same `BatchInput`, typed-array or `Geometry[]` answers):
`coveredByAll`, `coversAll`, `crossesAll`, `disjointAll`, `overlapsAll`,
`touchesAll`, `withinAll` — and the measure/geometry forms
(`areaAll`, `lengthAll`, `distanceAll`, `bufferAll`, `centroidAll`, `simplifyAll`,
`clipByRectAll`, `nodeAll`, `lineMergeAll`, `snapAll`, …). The full list:
[API reference](/reference).

> [!NOTE]
> `*All` masks are aligned to the input order. `hits[i] === 1` means
> `candidates[i]` answered yes — there is no result reordering anywhere.

## STRtree — the spatial index

Envelope-index many geometries, query by envelope, get **ids** back:

```ts
const tree = geos.strtree(geometries, 10); // nodeCapacity 10 is the classic default

const hits: Int32Array = tree.query(envelope); // candidate ids, ONE crossing
const id = tree.nearest(queryGeom);            // -1 for an empty tree
const g = tree.get(id);                        // the inserted geometry back

// many envelopes, still ONE crossing:
const { ids, offsets } = tree.queryAll(envelopes); // query i owns ids[offsets[i-1] … offsets[i])
```

- **Candidates, not answers**: `query` returns envelope hits. The exact filter is your
  job — typically a prepared predicate on the returned ids. That split (index narrows,
  predicate decides) is the standard GEOS/PostGIS pattern and it is why the query is
  one crossing.
- `query` builds the tree on first use; `build()` is there if you want to pay the cost
  explicitly. After build, the tree is frozen — `insert` on a built tree throws.
- `queryAll(envs)` runs N envelope queries in one crossing and returns the flat
  candidate ids plus cumulative `Uint32Array` offsets — slice `ids` per query instead
  of looping `query` in JS.
- `queryFilter(env, prepared, pred)` pushes the exact predicate into the C callback:
  one crossing that returns only the ids that pass, when you'd otherwise loop in JS.
- `nearest` walks a C distance table — correct nearest-neighbor, no JS loop.

The index measured **~90×** over a naive JS scan in the repo's
[benchmark suite](/benchmarks); the point isn't the number, it's that the crossing
count stops mattering.

## Choosing the right speed

| Situation | Use |
|-----------|-----|
| one question, two geometries | plain predicate |
| one geometry, many questions | `prepare()` |
| one question, many geometries | `*All` batch form |
| many questions, huge set, envelope-shaped | `STRtree` + `queryFilter` |
| the batch doesn't fit one core | `geos.parallel.*` → [Workers & parallelism](/guide/workers) |

## Where to next

- [Workers & parallelism](/guide/workers) — when one core isn't enough
- [Memory & disposal](/guide/memory) — `Prepared` and `STRtree` own native resources too
- [API reference](/reference) — the full predicate/batch surface
