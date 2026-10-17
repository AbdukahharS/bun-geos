#!/usr/bin/env python3
"""
Generate GeoArrow golden buffers from a reference implementation
(geoarrow-pyarrow) for the conformance differential test
(test/differential/geoarrow-goldens.test.ts).

Run:
  python3 -m venv /tmp/opencode/geoarrow-venv
  /tmp/opencode/geoarrow-venv/bin/pip install pyarrow geoarrow-pyarrow
  /tmp/opencode/geoarrow-venv/bin/python scripts/geoarrow-goldens.py

Layout note (D28): the reference emits the GeoArrow CANONICAL layout —
struct<x: double, y: double> coordinates + int32 list offsets + LSB
validity bitmaps. bun-geos typed arrays use the INTERLEAVED profile
(coords: X Y [Z [M]] in one Float64Array); the test converts struct →
interleaved per the documented mapping, which is itself part of what the
golden bytes pin.

Output: test/differential/geoarrow-goldens.json
  cases: [{
    name, wkt: [...], extension, shape,
    coord: { x: hex, y: hex },          # struct field buffers, f64 LE
    levels: [ { offsets: hex, validity: hex | null }, ... ]  # outer→inner, i32 LE
  }]
"""

import json
import pathlib

import geoarrow.pyarrow as ga
import pyarrow as pa

CASES = [
    ("point-1", ["POINT (30 10)"]),
    ("point-2", ["POINT (30 10)", "POINT (10 30)"]),
    ("linestring-1", ["LINESTRING (0 0, 1 1, 2 2)"]),
    ("linestring-2", ["LINESTRING (0 0, 1 1)", "LINESTRING (2 2, 3 3, 4 4)"]),
    ("polygon-1", ["POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 1 2, 1 1))"]),
    ("polygon-2", ["POLYGON ((0 0, 1 0, 0 1, 0 0))", "POLYGON ((2 0, 3 0, 2 1, 2 0))"]),
    ("multipoint-1", ["MULTIPOINT ((0 0), (2 2), (4 4))"]),
    ("multipoint-null", ["MULTIPOINT EMPTY"]),
    ("multilinestring-1", ["MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))"]),
    ("multipolygon-1", ["MULTIPOLYGON (((0 0, 1 0, 0 1, 0 0)), ((2 0, 3 0, 2 1, 2 0)))"]),
    ("point-with-null", None),  # special: one null slot
]


def hexbuf(b):
    if b is None:
        return None
    if hasattr(b, "to_pybytes"):  # Buffer
        return b.to_pybytes().hex()
    # Int32Array offsets — concatenate raw buffer bytes (bit-packed, no offset)
    inner = b.buffers()[1]
    return inner.to_pybytes().hex() if inner is not None else None


def walk_lists(arr, levels):
    """Collect (offsets, validity) per list level, outermost first."""
    if isinstance(arr.type, pa.ListType):
        levels.append({
            "offsets": hexbuf(arr.offsets) if arr.offsets is not None else hexbuf(arr.buffers()[1]),
            "validity": hexbuf(arr.buffers()[0]),
        })
        walk_lists(arr.values, levels)


def emit(name, wkts, out):
    if name == "multipoint-null":
        # a MULTIPOINT EMPTY — the multipoint column with zero slots
        mt = ga.multipoint()
        empty_storage = pa.array(
            [],
            pa.list_(pa.field(
                "points",
                pa.struct([pa.field("x", pa.float64(), nullable=False),
                           pa.field("y", pa.float64(), nullable=False)]),
                nullable=False,
            )),
        )
        g = pa.ExtensionArray.from_storage(mt, empty_storage)
        shape = "multipoint"
    else:
        g = ga.as_geoarrow(pa.array(wkts))
        first = g.type.__str__()
        shape = (
            "point" if "geoarrow.point<" in first and "multi" not in first
            else "linestring" if "geoarrow.linestring" in first
            else "polygon" if "geoarrow.polygon" in first
            else "multipoint" if "geoarrow.multipoint" in first
            else "multilinestring" if "geoarrow.multilinestring" in first
            else "multipolygon" if "geoarrow.multipolygon" in first
            else None
        )
        if shape is None:
            raise SystemExit(f"unrecognized type {first}")
    extension = "geoarrow." + shape
    storage = g.storage

    # struct<x, y> coord buffers (the last two non-offset buffers)
    def find_struct(a):
        if isinstance(a.type, pa.StructType):
            return a
        if isinstance(a.type, pa.ListType):
            return find_struct(a.values)
        raise SystemExit("no struct found")

    st = find_struct(storage)
    coord = {"x": hexbuf(st.field(0).buffers()[1]), "y": hexbuf(st.field(1).buffers()[1])}

    levels = []
    walk_lists(storage, levels)

    out["cases"].append({
        "name": name,
        "wkt": wkts if wkts is not None else ["MULTIPOINT EMPTY"],
        "extension": extension,
        "shape": shape,
        "coord": coord,
        "levels": levels,
    })


def emit_null_case(out):
    # one non-null point + one null slot → validity bitmap present
    arr = pa.array(["POINT (5 5)", None], type=pa.string())
    g = ga.as_geoarrow(arr)
    storage = g.storage
    case = {
        "name": "point-with-null",
        "wkt": ["POINT (5 5)"],
        "extension": "geoarrow.point",
        "shape": "point",
        "coord": {
            "x": hexbuf(storage.field(0).buffers()[1]),
            "y": hexbuf(storage.field(1).buffers()[1]),
        },
        "levels": [],
        # struct-level validity bitmap (LSB): slot 0 valid, slot 1 null
        "struct_validity": hexbuf(storage.buffers()[0]),
        "slots": 2,
    }
    out["cases"].append(case)


def main():
    out = {"schema": 1, "cases": []}
    for name, wkts in CASES:
        if name == "point-with-null":
            continue
        emit(name, wkts, out)
    emit_null_case(out)
    dest = pathlib.Path(__file__).parent.parent / "test" / "differential" / "geoarrow-goldens.json"
    dest.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dest} ({len(out['cases'])} cases)")


if __name__ == "__main__":
    main()
