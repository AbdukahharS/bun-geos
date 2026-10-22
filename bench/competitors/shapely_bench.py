#!/usr/bin/env python3
"""Shapely 2 competitor adapter — the vectorized-batch parallel.

Shapely 2's ufuncs are the direct analog of bun-geos's `*All` layer (the
"Shapely-2.0 lesson" the library cites), so this adapter measures both
axes everywhere: per-item calls from a Python loop AND one-call vectorized
arrays. Reads the canonical .workload files the JS orchestrator
materializes (identical doubles at every boundary) and emits the shared
record schema on stdout.

Usage: python3 shapely_bench.py <workloadDir>
Provisioned via `bun run bench:competitors:setup` (bench/competitors/.venv).
"""

import json
import math
import sys
import time
from pathlib import Path

import shapely

WORKLOAD = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / ".workload")

records = []
failures = []


def best_of(repeats, fn):
    fn()  # warm-up, excluded
    best = math.inf
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        best = min(best, (time.perf_counter() - t0) * 1000.0)
    return best


def read_wkts(path):
    return [line for line in path.read_text().splitlines() if line]


def read_clip():
    # from_wkb on a scalar buffer returns a single geometry (not an array).
    return shapely.from_wkb((WORKLOAD / "clip720.wkb").read_bytes())


def read_wkb(path, size):
    buf = path.read_bytes()
    offs = []
    raw = path.with_suffix(path.suffix.replace(".wkb", ".offs.u32")).read_bytes()
    for i in range(size):
        offs.append(int.from_bytes(raw[i * 4 : i * 4 + 4], "little"))
    slices = []
    start = 0
    for end in offs:
        slices.append(buf[start:end])
        start = end
    return slices


def record(scenario, size, variants, repeats, count=None, area_sum=None, hits=None, note=None):
    fp = {"areaSum": area_sum}
    if count is not None:
        fp["count"] = int(count)
    if hits is not None:
        fp["hits"] = int(hits)
    entry = {
        "engine": "shapely",
        "engineVersion": f"shapely {shapely.__version__} / GEOS {'.'.join(map(str, shapely.geos_version))}",
        "boundary": "ctypes",
        "scenario": scenario,
        "size": size,
        "variants": variants,
        "repeats": repeats,
        "fingerprint": fp,
    }
    if note:
        entry["note"] = note
    records.append(entry)


def fail(scenario, error):
    failures.append({"engine": "shapely", "scenario": scenario, "error": str(error)[:200]})


# ------------------------------------------------------------------ overlay

def scenario_overlay(size):
    try:
        clip = read_clip()
        squares = shapely.from_wkb(read_wkb(WORKLOAD / f"squares-{size}.wkb", size))

        def timed_singular():
            count = 0
            area_sum = 0.0
            for sq in squares:
                out = shapely.intersection(clip, sq)
                if not shapely.is_empty(out):
                    count += 1
                    area_sum += shapely.area(out)
            return count, area_sum

        def timed_vectorized():
            out = shapely.intersection(clip, squares)
            count = int((~shapely.is_empty(out)).sum())
            return count, float(shapely.area(out).sum())

        repeats = 2 if size >= 100_000 else 3
        singular_ms = best_of(repeats, timed_singular)
        vectorized_ms = best_of(repeats, timed_vectorized)

        count, area_sum = timed_vectorized()
        record(
            "overlay",
            size,
            {"singular": singular_ms, "batch": vectorized_ms},
            repeats,
            count=count,
            area_sum=area_sum,
            note="shapely vectorized ufuncs = the batch-layer parallel",
        )
    except Exception as exc:  # noqa: BLE001 — degrade, never crash the run
        fail(f"overlay@{size}", exc)


# -------------------------------------------------------------------- union

def scenario_union(size):
    try:
        tiles = shapely.from_wkt(read_wkts(WORKLOAD / f"tiles-{size}.wkt"))
        variants = {}

        def unary():
            out = shapely.union_all(tiles)
            return int(shapely.get_num_geometries(out)), float(shapely.area(out))

        count, area_sum = unary()
        variants["unary"] = best_of(3, unary)

        try:

            def coverage():
                out = shapely.coverage_union_all(tiles)
                return int(shapely.get_num_geometries(out)), float(shapely.area(out))

            c_count, c_area = coverage()
            variants["coverage-raw"] = best_of(3, coverage)
            count, area_sum = c_count, c_area
        except (TypeError, ValueError, AttributeError):
            pass  # shapely without coverage_union_all

        record(
            "union",
            size,
            variants,
            3,
            count=count,
            area_sum=area_sum,
            note="coverage-raw = union only (coverage_union_all does NO validity pre-check)",
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"union@{size}", exc)


# ------------------------------------------------------------ prepared-scan

def scenario_prepared(size):
    try:
        clip = read_clip()
        points = shapely.from_wkb(read_wkb(WORKLOAD / f"points-{size}.wkb", size))
        repeats = 1 if size >= 100_000 else 3

        def unprepared():
            return int(shapely.intersects(clip, points).sum())

        unprepared_ms = best_of(repeats, unprepared)

        shapely.prepare(clip)

        def prepared():
            return int(shapely.intersects(clip, points).sum())

        prepared_ms = best_of(repeats, prepared)
        hits = unprepared()
        record(
            "prepared-scan",
            size,
            {"unprepared": unprepared_ms, "prepared": prepared_ms},
            repeats,
            area_sum=None,
            hits=hits,
            note="vectorized; prepare() then auto-used by intersects",
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"prepared-scan@{size}", exc)


# ------------------------------------------------------------------ strtree

def scenario_strtree(size):
    try:
        boxes = [
            tuple(float(v) for v in line.split())
            for line in (WORKLOAD / "strtree-boxes.tsv").read_text().splitlines()
            if line
        ]
        queries = [
            tuple(float(v) for v in line.split())
            for line in (WORKLOAD / "strtree-queries.tsv").read_text().splitlines()
            if line
        ]
        box_polys = shapely.from_wkt(
            [
                f"POLYGON (({x0} {y0}, {x1} {y0}, {x1} {y1}, {x0} {y1}, {x0} {y0}))"
                for (x0, y0, x1, y1) in boxes
            ]
        )
        query_polys = shapely.from_wkt(
            [
                f"POLYGON (({x0} {y0}, {x1} {y0}, {x1} {y1}, {x0} {y1}, {x0} {y0}))"
                for (x0, y0, x1, y1) in queries
            ]
        )

        def build():
            tree = shapely.STRtree(box_polys)
            tree.query(query_polys[0])
            return tree

        build_ms = best_of(3, build)
        tree = build()

        def query_all():
            # Array input → shape (2, n) pairs: (input indices, tree indices).
            return tree.query(query_polys)

        query_ms = best_of(5, query_all)
        hits = int(query_all().shape[1])
        record("strtree", size, {"build": build_ms, "query": query_ms}, 5, area_sum=None, hits=hits)
    except Exception as exc:  # noqa: BLE001
        fail(f"strtree@{size}", exc)


# ------------------------------------------------------------------- ingest

def scenario_ingest(size):
    try:
        wkts = read_wkts(WORKLOAD / f"squares-{size}.wkt")
        wkbs = read_wkb(WORKLOAD / f"squares-{size}.wkb", size)
        repeats = 2

        wkt_loop_ms = best_of(repeats, lambda: [shapely.from_wkt(w) for w in wkts])
        wkt_batch_ms = best_of(repeats, lambda: shapely.from_wkt(wkts))
        wkb_loop_ms = best_of(repeats, lambda: [shapely.from_wkb(w) for w in wkbs])
        wkb_batch_ms = best_of(repeats, lambda: shapely.from_wkb(wkbs))

        record(
            "ingest",
            size,
            {"wkt": wkt_loop_ms, "wkt-batch": wkt_batch_ms, "wkb": wkb_loop_ms, "wkb-batch": wkb_batch_ms},
            repeats,
            count=size,
            area_sum=None,
            note="per-item loop vs vectorized ufunc",
        )
    except Exception as exc:  # noqa: BLE001
        fail(f"ingest@{size}", exc)


# ---------------------------------------------------------------- makevalid

def scenario_makevalid(size):
    try:
        bowties = shapely.from_wkt(read_wkts(WORKLOAD / f"bowties-{size}.wkt"))

        def timed():
            out = shapely.make_valid(bowties)
            return int(shapely.is_valid(out).sum()), float(shapely.area(out).sum())

        ms = best_of(3, timed)
        count, area_sum = timed()
        record("makevalid", size, {"makevalid": ms}, 3, count=count, area_sum=area_sum)
    except Exception as exc:  # noqa: BLE001
        fail(f"makevalid@{size}", exc)


# ------------------------------------------------------------------- buffer

def scenario_buffer(size):
    try:
        wobbles = shapely.from_wkb(read_wkb(WORKLOAD / f"wobbles-{size}.wkb", size))

        def timed():
            out = shapely.buffer(wobbles, 2.0, quad_segs=8)
            return int((~shapely.is_empty(out)).sum()), float(shapely.area(out).sum())

        ms = best_of(3, timed)
        count, area_sum = timed()
        record("buffer", size, {"buffer": ms}, 3, count=count, area_sum=area_sum)
    except Exception as exc:  # noqa: BLE001
        fail(f"buffer@{size}", exc)


def main():
    overlay_sizes = [1_000, 10_000, 100_000]
    prepared_sizes = [10_000, 100_000]
    for size in overlay_sizes:
        scenario_overlay(size)
    scenario_union(961)
    for size in prepared_sizes:
        scenario_prepared(size)
    scenario_strtree(100_000)
    scenario_ingest(20_000)
    scenario_makevalid(1_000)
    scenario_buffer(100)

    json.dump(
        {
            "engineVersion": f"shapely {shapely.__version__} / GEOS {'.'.join(map(str, shapely.geos_version))}",
            "records": records,
            "failures": failures,
        },
        sys.stdout,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
