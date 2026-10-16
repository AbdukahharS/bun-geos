# Design: I/O layer

> Status: design target (post-spike). Implements D9. Factual basis:
> `GEOSCoordSeq_copyFromBuffer/copyToBuffer` take/produce interleaved `double` buffers
> ([GEOS research §5](../research/geos.md)).

## 1. The canonical currency

Everything internal — builder inputs, batch ops, worker transfer, benchmark harnesses —
speaks **flat typed arrays**:

```ts
interface FlatCoords {
  coords: Float64Array;   // interleaved X Y [Z [M]] × n  (same layout as GeoArrow)
  n: number;              // coordinate count
  hasZ: boolean;
  hasM: boolean;
}
interface Polygonal {     // ring/part structure as offsets into coord space
  coords: Float64Array;
  ringOffsets: Int32Array;    // end-index of each ring
  partOffsets: Int32Array;    // end-ring of each polygon (multipolygon)
  hasZ: boolean; hasM: boolean;
}
```

Why: this is (a) literally the input of `CoordSeq_copyFromBuffer`, (b) one FFI crossing
per array, (c) the GeoArrow layout, so `fromArrow`/`toArrow` are structure copies, not
conversions, and (d) trivially structured-cloned to Workers.

## 2. The layers

| Layer | Role | Path |
|-------|------|------|
| **GeoJSON** | Ergonomics; web audience | JS-side parse of `coordinates` → flat arrays → one shim build call. JS-side assembly on output. |
| **WKB** | Wire format; PostGIS/duckdb ingest; fastest general I/O | Native `GEOSWKBReader/Writer_r` wrapped directly + shim batch variants (`read_wkb_many`). |
| **GeoArrow** | Bulk/batch; analytics scale | Near zero-copy: validate + alias, feed builders. Spec conformance pass scheduled (Phase 5). |
| **WKT** | Debuggability, goldens, interop | Native reader/writer; string marshaling is fine at this size. |

## 3. GeoJSON specifics

- **Parsing is JS-side, deliberately.** GEOS has a GeoJSON reader (3.11+), but JS-side
  conversion produces precise errors — `GeosError: ring 2, vertex 17: expected 2
  ordinates, got 3` instead of a C-level "ParseException". Correctness errors are data
  errors; they deserve data-shaped messages (D13).
- RFC 7946 compliance notes: members other than `type`/`coordinates`/`geometries` are
  preserved on round-trip via a side-channel (geometry-level `userData`), not merged into
  the GEOS object; **ring winding is preserved as input** — RFC 7946's right-hand-rule
  recommendation is surfaced as an explicit `orientPolygons` helper (Phase 2,
  `GEOSOrientPolygons`) rather than silent normalization.
- **Ring-closure policy (frozen in Phase 1, M5):** polygon rings are NORMALIZED on
  input — unclosed rings are auto-closed by appending a copy of the first
  coordinate; rings with fewer than 3 distinct positions are rejected with a
  precise `GeosError` (`ring 0 has 2 positions; need ≥ 3`). Empty `coordinates`
  produce typed empties (`POLYGON EMPTY`). Output preserves what GEOS holds.
- Empty geometries: typed empties per GEOS (`POLYGON EMPTY` etc.), consistent with the
  Shapely-2.0 target behavior; `POINT (NaN NaN)` WKB quirk handled in the WKB layer.

## 4. WKB specifics

- Reader/writer options exposed: output dimension (2/3/4, incl. the 3.14
  `GeoJSONWriter_setOutputDimension` analog for GeoJSON), byte order (native default,
  big-endian for goldens), include-SRID.
- **PostGIS/EWKB note:** PostGIS `bytea` is EWKB (SRID flag + optional Z/M flags).
  GEOS reads it; **SRIDs are stored natively** via `GEOSGetSRID_r`/`GEOSSetSRID_r`
  (present in 3.14's geos_c.h — verified in Phase 1; the earlier "no SRID
  storage, JS side-channel" note was wrong and is dropped). A PostGIS `bytea`
  roundtrip preserves SRID — covered by a differential test in
  `test/unit/io.test.ts`; the live-PostGIS oracle stays Phase 2.
- Batch paths (`readWKBMany(buf, offsets) → Geometry[]`) go through the shim (one call
  per array) — the fast ingest for exports from databases. **(Phase 3: shipped —
  `geos.fromWKBMany`, with JS-side offset validation; the shim's batch WKB codec.)**

## 5. GeoArrow specifics

- The `FlatCoords`/`Polygonal` structures above mirror GeoArrow's interleaved coord
  buffers + int32/64 offsets; `fromArrow`/`toArrow` validate and (when alignment allows)
  alias without copying.
- Structured arrays (one column per geometry) are the target; extension-type metadata
  follows the spec as of our Phase 5 conformance pass (spec evolution explicitly
  tracked, since GeoArrow is young).
- This layer is what makes `unionAll`, prepared-mask scans, and worker chunking nearly
  free — batch ops accept Arrow arrays natively.

## 6. Z and M

- Detected via `GEOSCoordSeq_hasZ/hasM` (3.14 accessors) and preserved through builders.
- Ops that drop Z/M (documented per-op, GEOS "best effort") say so in their docs entry;
  nothing silently downsamples at the I/O layer.

## 7. Error quality goals (all layers)

| Failure | Message shape |
|---------|---------------|
| Malformed GeoJSON coordinates | `GeosError` + JSON path + index ("features[3].geometry: polygon ring 0 has 2 positions; need ≥ 4") |
| Malformed WKB | GEOS message + byte offset from reader state where available |
| Invalid input topology to a strict op | GEOS message + `isValidReasons`/`isSimpleDetail` attachment (repair suite, Phase 2) |
| Abort | `GeosError("aborted")`, `cause: signal.reason` |
