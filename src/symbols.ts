/**
 * The FFI surface: one declarative table per library (D2, D15).
 *
 * Binding rules baked in from the spike (spike-results F6/F10):
 * 1. `const char*` ARGS → "cstring" (JS strings auto-encode to UTF-8).
 * 2. GEOS-OWNED string returns (every writer) → "ptr"; callers view with
 *    `new CString(ptr)` and `GEOSFree_r` the pointer. A "cstring" RETURN on
 *    a GEOS-owned buffer leaks under the 1.4 engine FFI (~85 MB/epoch
 *    measured) — never bind one.
 * 3. "cstring" returns are for strings needing no free: `GEOSversion`
 *    (static) and the shim's thread-local buffers.
 * 4. Failed pointer returns arrive as JS `null` — checks are `=== null`,
 *    never `=== 0` (F6).
 *
 * Types: the tables are the single source of truth; the exported symbol
 * interfaces are mechanically derived (keys, arity, arg kinds, return kinds)
 * via bun-types' `ConvertFns`, with one narrowing: "ptr" returns are typed
 * `Pointer | null` (the engine never yields bigint here — F6). Branded
 * handles (types.ts) are subtypes of Pointer, so they flow into any "ptr"
 * argument; mixing a `GeosShim*` into a `GEOSContextHandle_t` slot is a
 * compile error (D15.3, the F8 lesson).
 */

import type { FFIFunction, Pointer } from "bun:ffi";
import { dlopen } from "bun:ffi";

type FFISpec = { readonly args: readonly string[]; readonly returns: string };

/** The C shim (native/shim.c) — the only loop-shaped surface (D4). */
export const SHIM_TABLE = {
  geos_shim_init: { args: [], returns: "ptr" },
  geos_shim_context: { args: ["ptr"], returns: "ptr" },
  geos_shim_finish: { args: ["ptr"], returns: "void" },
  geos_shim_last_error: { args: ["ptr"], returns: "cstring" },
  geos_shim_last_notice: { args: ["ptr"], returns: "cstring" },

  geos_shim_build_linestring: { args: ["ptr", "ptr", "u32", "i32", "i32"], returns: "ptr" },
  geos_shim_build_polygon: { args: ["ptr", "ptr", "ptr", "u32", "i32", "i32"], returns: "ptr" },
  geos_shim_build_collection: { args: ["ptr", "i32", "ptr", "u32"], returns: "ptr" },
  geos_shim_destroy_many: { args: ["ptr", "ptr", "u32"], returns: "void" },

  // Phase 2 (D16–D21): interrupt, bulk clones, union dispatch, prepared
  // batch masks, STRtree query/nearest collection.
  geos_shim_interrupt_request: { args: [], returns: "void" },
  geos_shim_interrupt_reset: { args: [], returns: "void" },
  geos_shim_clone_many: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_clone_collect: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  geos_shim_clone_members: { args: ["ptr", "ptr", "ptr", "u32"], returns: "i32" },
  geos_shim_union_all: { args: ["ptr", "ptr", "u32", "i32"], returns: "ptr" },
  geos_shim_coverage_union: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  geos_shim_prepared_pred_all: { args: ["ptr", "ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_prepared_relate_pattern_all: {
    args: ["ptr", "ptr", "ptr", "u32", "cstring", "ptr"],
    returns: "i32",
  },
  // STRtree: query collects item ids in one crossing; nearest goes through
  // nearest_generic with a C distance callback over the bound id→geom table
  // (D16 — the plain GEOSSTRtree_nearest derefs items as geometry pointers).
  geos_shim_strtree_query: { args: ["ptr", "ptr", "ptr", "ptr", "u32"], returns: "i32" },
  geos_shim_strtree_query_all: {
    args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr", "u32"],
    returns: "i32",
  },
  geos_shim_strtree_bind_geoms: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  geos_shim_strtree_table_free: { args: ["ptr"], returns: "void" },
  geos_shim_strtree_nearest: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },

  // Phase 3 (D22/D24): the batch op layer — one FFI call per array — plus
  // bulk Arrow builders, fused tree filter, chunk weights, heap accounting.
  // All `*_all` returns: 0 ok / 1 exception / 2 interrupted (D18 contract).
  geos_shim_overlay_all: {
    args: ["ptr", "i32", "ptr", "ptr", "u32", "f64", "ptr"],
    returns: "i32",
  },
  geos_shim_pred_all: { args: ["ptr", "i32", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  // Phase 5 construction batches (D27): out[i] = op(gs[i]) / op(a, gs[i])
  geos_shim_unary_all: {
    args: ["ptr", "i32", "ptr", "u32", "f64", "f64", "f64", "f64", "ptr"],
    returns: "i32",
  },
  geos_shim_binary_all: { args: ["ptr", "i32", "ptr", "ptr", "u32", "f64", "ptr"], returns: "i32" },
  geos_shim_measure_all: { args: ["ptr", "i32", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_buffer_all: { args: ["ptr", "ptr", "f64", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_read_wkb_many: { args: ["ptr", "ptr", "ptr", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_num_points_many: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_heap_bytes: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
  geos_shim_build_polygonal_many: {
    args: ["ptr", "ptr", "ptr", "u32", "ptr", "u32", "i32", "i32", "ptr"],
    returns: "i32",
  },
  geos_shim_build_linestrings_many: {
    args: ["ptr", "ptr", "ptr", "u32", "i32", "i32", "ptr"],
    returns: "i32",
  },
  geos_shim_strtree_query_prepared: {
    args: ["ptr", "ptr", "ptr", "ptr", "i32", "ptr", "ptr", "u32"],
    returns: "i32",
  },
} as const satisfies Record<string, FFISpec>;

/**
 * The GEOS C API, `_r` set only (D3), strict 3.14 (D5). Every `_r` function
 * takes the context handle first. `GEOSversion` is the one symbol with no
 * `_r` variant (process-global static string — F6).
 */
export const GEOS_TABLE = {
  // version
  GEOSversion: { args: [], returns: "cstring" },

  // WKT reader/writer
  GEOSWKTReader_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSWKTReader_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSWKTReader_read_r: { args: ["ptr", "ptr", "cstring"], returns: "ptr" },
  // Kept bound for the Phase 3 bench harness only; toWKT() always uses the
  // writer (GEOSGeomToWKT_r emits untrimmed output on 3.14).
  GEOSGeomToWKT_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSWKTWriter_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSWKTWriter_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSWKTWriter_write_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSWKTWriter_setTrim_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKTWriter_setRoundingPrecision_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKTWriter_setOutputDimension_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKTWriter_setOld3D_r: { args: ["ptr", "ptr", "i32"], returns: "void" },

  // WKB reader/writer
  GEOSWKBReader_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSWKBReader_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSWKBReader_read_r: { args: ["ptr", "ptr", "ptr", "usize"], returns: "ptr" },
  GEOSWKBWriter_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSWKBWriter_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSWKBWriter_write_r: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSWKBWriter_setOutputDimension_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKBWriter_setByteOrder_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKBWriter_setIncludeSRID_r: { args: ["ptr", "ptr", "i32"], returns: "void" },
  GEOSWKBWriter_setFlavor_r: { args: ["ptr", "ptr", "i32"], returns: "void" },

  // flat-buffer coordinate sequences (the D9 currency)
  GEOSCoordSeq_copyFromBuffer_r: { args: ["ptr", "ptr", "u32", "i32", "i32"], returns: "ptr" },
  GEOSCoordSeq_copyToBuffer_r: { args: ["ptr", "ptr", "ptr", "i32", "i32"], returns: "i32" },
  GEOSCoordSeq_getSize_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSCoordSeq_hasZ_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSCoordSeq_hasM_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSCoordSeq_destroy_r: { args: ["ptr", "ptr"], returns: "void" },

  // construction (GEOS takes ownership of coordseqs / parts on success)
  GEOSGeom_createPoint_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeom_createLinearRing_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeom_createLineString_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeom_createPolygon_r: { args: ["ptr", "ptr", "ptr", "u32"], returns: "ptr" },
  GEOSGeom_createCollection_r: { args: ["ptr", "i32", "ptr", "u32"], returns: "ptr" },
  GEOSGeom_createEmptyPoint_r: { args: ["ptr"], returns: "ptr" },
  GEOSGeom_createEmptyLineString_r: { args: ["ptr"], returns: "ptr" },
  GEOSGeom_createEmptyPolygon_r: { args: ["ptr"], returns: "ptr" },
  GEOSGeom_createEmptyCollection_r: { args: ["ptr", "i32"], returns: "ptr" },

  // teardown
  GEOSGeom_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSFree_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSGeom_clone_r: { args: ["ptr", "ptr"], returns: "ptr" },

  // SRID (native storage — verified present in 3.14's geos_c.h)
  GEOSGetSRID_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSSetSRID_r: { args: ["ptr", "ptr", "i32"], returns: "void" },

  // accessors (borrowed pointers are marked at the call site, never destroyed)
  GEOSGeomType_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeomTypeId_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSisEmpty_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSEnvelope_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGetNumGeometries_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSGetGeometryN_r: { args: ["ptr", "ptr", "i32"], returns: "ptr" },
  GEOSGetNumInteriorRings_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSGetInteriorRingN_r: { args: ["ptr", "ptr", "i32"], returns: "ptr" },
  GEOSGetExteriorRing_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeom_getCoordSeq_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGeomGetNumPoints_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSGeom_getCoordinateDimension_r: { args: ["ptr", "ptr"], returns: "i32" },

  // predicates — char returns: 1 true, 0 false, 2 exception (geos_c.h)
  GEOSIntersects_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSDisjoint_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSTouches_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSCrosses_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSWithin_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSContains_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSOverlaps_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSCovers_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSCoveredBy_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSEquals_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSEqualsIdentical_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  // structural equality with tolerance (XMLTester's checkOverlaySuccess
  // fallback; corpus-gate use — no public wrapper yet)
  GEOSEqualsExact_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "i32" },
  // envelope extent (corpus-gate snap tolerance; candidate for the public
  // accessor surface — tracked with the M5 reference pass)
  GEOSGeom_getExtent_r: {
    args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr"],
    returns: "i32",
  },
  // in-place canonical re-ordering (XMLTester compares normalize()-d results;
  // the corpus gate uses it — no public wrapper yet, M5 reference will note it)
  GEOSNormalize_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSRelatePattern_r: { args: ["ptr", "ptr", "ptr", "cstring"], returns: "i32" },
  GEOSRelate_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSisValid_r: { args: ["ptr", "ptr"], returns: "i32" },

  // overlay / boolean ops (OverlayNGRobust underneath)
  GEOSIntersection_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSUnion_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSDifference_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSSymDifference_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSUnaryUnion_r: { args: ["ptr", "ptr"], returns: "ptr" },

  // buffer (params-object path; covers singleSided — M7 decision)
  GEOSBufferParams_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSBufferParams_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSBufferParams_setQuadrantSegments_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSBufferParams_setEndCapStyle_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSBufferParams_setJoinStyle_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSBufferParams_setMitreLimit_r: { args: ["ptr", "ptr", "f64"], returns: "i32" },
  GEOSBufferParams_setSingleSided_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSBufferWithParams_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },

  // measures — out-param via one-element Float64Array, i32 reports failure
  GEOSArea_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSLength_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSDistance_r: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  GEOSHausdorffDistance_r: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  GEOSFrechetDistance_r: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "i32" },

  // ===== Phase 2 (strict 3.14; interrupt install lives inside the shim) =====

  // prepared predicates (RelateNG, 3.13+) — char returns like the unprepared set
  GEOSPrepare_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSPreparedGeom_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSPreparedIntersects_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedIntersectsXY_r: { args: ["ptr", "ptr", "f64", "f64"], returns: "i32" },
  GEOSPreparedContains_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedContainsXY_r: { args: ["ptr", "ptr", "f64", "f64"], returns: "i32" },
  GEOSPreparedContainsProperly_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedCoveredBy_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedCovers_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedCrosses_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedDisjoint_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedOverlaps_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedTouches_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSPreparedWithin_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  // GEOS-owned DE-9IM string → "ptr" + CString + GEOSFree_r (rule 2 / F10)
  GEOSPreparedRelate_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSPreparedRelatePattern_r: { args: ["ptr", "ptr", "ptr", "cstring"], returns: "i32" },

  // STRtree (query/nearest go through the shim — D16)
  GEOSSTRtree_create_r: { args: ["ptr", "usize"], returns: "ptr" },
  GEOSSTRtree_build_r: { args: ["ptr", "ptr"], returns: "i32" },
  GEOSSTRtree_insert_r: { args: ["ptr", "ptr", "ptr", "ptr"], returns: "void" },
  GEOSSTRtree_destroy_r: { args: ["ptr", "ptr"], returns: "void" },

  // coverage / repair suite
  GEOSCoverageIsValid_r: { args: ["ptr", "ptr", "f64", "ptr"], returns: "i32" },
  GEOSCoverageSimplifyVW_r: { args: ["ptr", "ptr", "f64", "i32"], returns: "ptr" },
  GEOSCoverageCleanParams_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSCoverageCleanParams_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSCoverageCleanParams_setSnappingDistance_r: { args: ["ptr", "ptr", "f64"], returns: "i32" },
  GEOSCoverageCleanParams_setGapMaximumWidth_r: { args: ["ptr", "ptr", "f64"], returns: "i32" },
  GEOSCoverageCleanParams_setOverlapMergeStrategy_r: {
    args: ["ptr", "ptr", "i32"],
    returns: "i32",
  },
  GEOSCoverageCleanWithParams_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSMakeValidParams_create_r: { args: ["ptr"], returns: "ptr" },
  GEOSMakeValidParams_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  GEOSMakeValidParams_setKeepCollapsed_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSMakeValidParams_setMethod_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },
  GEOSMakeValid_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSMakeValidWithParams_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  // out-params: one-element BigUint64Array for reason (char*) + location (geom)
  GEOSisValidDetail_r: { args: ["ptr", "ptr", "i32", "ptr", "ptr"], returns: "i32" },
  GEOSisSimpleDetail_r: { args: ["ptr", "ptr", "i32", "ptr"], returns: "i32" },
  // in-place mutation → clone-then-orient at the wrapper layer
  GEOSOrientPolygons_r: { args: ["ptr", "ptr", "i32"], returns: "i32" },

  // precision model
  GEOSGeom_setPrecision_r: { args: ["ptr", "ptr", "f64", "i32"], returns: "ptr" },
  GEOSGeom_getPrecision_r: { args: ["ptr", "ptr"], returns: "f64" },
  GEOSIntersectionPrec_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  GEOSUnionPrec_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  GEOSDifferencePrec_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  GEOSSymDifferencePrec_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  GEOSUnaryUnionPrec_r: { args: ["ptr", "ptr", "f64"], returns: "ptr" },

  // ===== Phase 5 construction ops =====
  // hulls, simplification, clipping
  GEOSConvexHull_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSConcaveHull_r: { args: ["ptr", "ptr", "f64", "i32"], returns: "ptr" },
  GEOSSimplify_r: { args: ["ptr", "ptr", "f64"], returns: "ptr" },
  GEOSTopologyPreserveSimplify_r: { args: ["ptr", "ptr", "f64"], returns: "ptr" },
  GEOSClipByRect_r: { args: ["ptr", "ptr", "f64", "f64", "f64", "f64"], returns: "ptr" },
  // triangulations
  GEOSDelaunayTriangulation_r: { args: ["ptr", "ptr", "f64", "i32"], returns: "ptr" },
  GEOSConstrainedDelaunayTriangulation_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSVoronoiDiagram_r: { args: ["ptr", "ptr", "ptr", "f64", "i32"], returns: "ptr" },
  // line ops
  GEOSLineMerge_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSLineMergeDirected_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSLineSubstring_r: { args: ["ptr", "ptr", "f64", "f64"], returns: "ptr" },
  GEOSOffsetCurve_r: { args: ["ptr", "ptr", "f64", "i32", "i32", "f64"], returns: "ptr" },
  GEOSSharedPaths_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  GEOSSnap_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  // topology building
  GEOSNode_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSBuildArea_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSPolygonize_r: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  // accessors & derived points
  GEOSGetCentroid_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSBoundary_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSPointOnSurface_r: { args: ["ptr", "ptr"], returns: "ptr" },
  // returns a GEOSCoordSequence* (2 points) — caller destroys it
  GEOSNearestPoints_r: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
  // clearance & circles
  GEOSMinimumClearance_r: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  GEOSMinimumClearanceLine_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSMaximumInscribedCircle_r: { args: ["ptr", "ptr", "f64"], returns: "ptr" },
  GEOSLargestEmptyCircle_r: { args: ["ptr", "ptr", "ptr", "f64"], returns: "ptr" },
  // clustering (ClusterInfo*) + grids
  GEOSClusterDBSCAN_r: { args: ["ptr", "ptr", "f64", "u32"], returns: "ptr" },
  GEOSClusterInfo_destroy_r: { args: ["ptr", "ptr"], returns: "void" },
  // returns a GEOS-owned size_t* (per-input cluster id; SIZE_MAX = noise)
  GEOSClusterInfo_getClustersForInputs_r: { args: ["ptr", "ptr"], returns: "ptr" },
  GEOSGridIntersectionFractions_r: {
    args: ["ptr", "ptr", "f64", "f64", "f64", "f64", "u32", "u32", "ptr"],
    returns: "i32",
  },
} as const satisfies Record<string, FFISpec>;

export type ShimSpecs = typeof SHIM_TABLE;
export type GeosSpecs = typeof GEOS_TABLE;

/** Symbol types as bun-types derives them from a dlopen table. */
type SymsOf<Fns extends Record<string, FFIFunction>> = ReturnType<typeof dlopen<Fns>>["symbols"];

/**
 * Narrow bun's derived fn types: "ptr" returns are `Pointer | null` at
 * runtime (F6). The `[R] extends [...]` form is non-distributing so a
 * `string | null` (cstring) return does not get split into a union.
 */
type NarrowPtrReturns<F> = F extends (...args: infer A) => infer R
  ? [R] extends [Pointer | bigint | null]
    ? (...args: A) => Pointer | null
    : F
  : F;

export type ShimApi = {
  readonly [K in keyof ShimSpecs]: NarrowPtrReturns<SymsOf<ShimSpecs>[K]>;
};
export type GeosApi = {
  readonly [K in keyof GeosSpecs]: NarrowPtrReturns<SymsOf<GeosSpecs>[K]>;
};

export interface Native {
  readonly shim: ShimApi;
  readonly geos: GeosApi;
}

/**
 * dlopen the libraries (same-inode dedup makes repeat loads a no-op).
 *
 * `preloads` are mapped BEFORE geos_c — Windows only in practice: the DLL
 * search path excludes a loaded DLL's own directory, so `geos.dll` must be
 * mapped (by absolute path → module name) before `geos_c.dll` binds it as a
 * dependency. On Linux/macOS the list is empty (DT_RPATH/LC_RPATH resolve
 * transitively, F3).
 *
 * Preloading goes through kernel32!LoadLibraryA, NOT bun:ffi's dlopen:
 * dlopen requires a symbol table to bind (and an empty one is not a
 * supported shape), while a preload needs no symbols — it only has to map
 * the image so later loads resolve its name against the mapped module.
 */
export function openNative(shimPath: string, geosCPath: string, preloads: string[] = []): Native {
  if (preloads.length > 0) {
    const kernel32 = dlopen("kernel32.dll", {
      LoadLibraryA: { args: ["cstring"], returns: "ptr" },
    });
    for (const path of preloads) {
      // Failed ptr returns arrive as JS null (F6). A plain Error — the
      // loader wraps whatever escapes openNative with full context.
      const handle = kernel32.symbols.LoadLibraryA(path);
      if (handle === null) {
        throw new Error(`LoadLibraryA failed for ${path}`);
      }
    }
  }
  // geos_c FIRST (audit H4): with BUN_GEOS_LIBRARY the override must be the
  // copy the shim's NEEDED soname binds to (F3). Loading the shim first
  // would let its DT_RPATH bind the bundled libgeos_c and then map the
  // override as a SECOND instance — two C++ heaps, cross-copy handles, and
  // a version assert reading the wrong library. Loading geos_c first makes
  // the later shim load reuse the mapped soname in both modes.
  const geosLib = dlopen(geosCPath, GEOS_TABLE);
  const shimLib = dlopen(shimPath, SHIM_TABLE);
  return {
    shim: shimLib.symbols as unknown as ShimApi,
    geos: geosLib.symbols as unknown as GeosApi,
  };
}
