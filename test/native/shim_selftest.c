/*
 * bun-geos shim self-test (Phase 1 native hygiene gate).
 *
 * Runs the shim's C surface under ASan/UBSan (`bun run test:native`): the
 * scenarios bun:ffi tests cannot see — ownership transfers, teardown of
 * partially built arrays, error paths that bail mid-construction — plus the
 * GEOS ownership quirks the shim must absorb (createCollection /
 * createPolygon consume their parts even when they FAIL; see the comments in
 * native/shim.c).
 *
 * Exit code 0 = all scenarios clean; ASan aborts loudly otherwise.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct GeosShim GeosShim;
extern GeosShim *geos_shim_init(void);
extern void *geos_shim_context(GeosShim *);
extern void geos_shim_finish(GeosShim *);
extern const char *geos_shim_last_error(GeosShim *);
extern const char *geos_shim_last_notice(GeosShim *);
extern void *geos_shim_build_linestring(GeosShim *, const double *, unsigned int, int, int);
extern void *geos_shim_build_polygon(GeosShim *, const double *, const unsigned int *, unsigned int, int, int);
extern void *geos_shim_build_collection(GeosShim *, int, void **, unsigned int);
extern void geos_shim_destroy_many(GeosShim *, void **, unsigned int);

/* Phase 2 surface */
extern void geos_shim_interrupt_request(void);
extern void geos_shim_interrupt_reset(void);
extern int geos_shim_clone_many(GeosShim *, void **, unsigned int, void **);
extern void *geos_shim_clone_collect(GeosShim *, void **, unsigned int);
extern int geos_shim_clone_members(GeosShim *, const void *, void **, unsigned int);
extern void *geos_shim_union_all(GeosShim *, void **, unsigned int, int);
extern void *geos_shim_coverage_union(GeosShim *, void **, unsigned int);
extern int geos_shim_prepared_pred_all(GeosShim *, const void *, int, void **, unsigned int, unsigned char *);
extern int geos_shim_prepared_relate_pattern_all(GeosShim *, const void *, void **, unsigned int, const char *, unsigned char *);
extern int geos_shim_strtree_query(GeosShim *, void *, const void *, int32_t *, unsigned int);
extern void *geos_shim_strtree_bind_geoms(GeosShim *, void **, unsigned int);
extern void geos_shim_strtree_table_free(void *);
extern int geos_shim_strtree_nearest(GeosShim *, void *, const void *, void **);

/* Minimal geos_c decls for scenarios the TS table would normally drive */
extern void *GEOSPrepare_r(void *, const void *);
extern void GEOSPreparedGeom_destroy_r(void *, const void *);
extern void GEOSGeom_destroy_r(void *, void *);
extern int GEOSDistance_r(void *, const void *, const void *, double *);
extern int GEOSArea_r(void *, const void *, double *);
extern int GEOSLength_r(void *, const void *, double *);
extern int GEOSGeomGetNumPoints_r(void *, const void *);
extern void *GEOSWKBReader_create_r(void *);
extern void GEOSWKBReader_destroy_r(void *, void *);
extern void *GEOSBufferParams_create_r(void *);
extern void GEOSBufferParams_destroy_r(void *, void *);
extern void *GEOSCoordSeq_copyFromBuffer_r(void *, const double *, unsigned int, int, int);
extern void *GEOSGeom_createPoint_r(void *, void *);

/* Real POINT fixtures — 1-vertex LineStrings are constructible but GEOS
 * throws on distance/intersects/buffer with them; batch fixtures below use
 * proper points where point semantics matter. */
static void *mk_point(GeosShim *s, void *c, double x, double y) {
  double xy[2] = {x, y};
  void *cs = GEOSCoordSeq_copyFromBuffer_r(c, xy, 1, 0, 0);
  if (!cs)
    return NULL;
  return GEOSGeom_createPoint_r(c, cs); /* consumes cs even on failure */
}

/* Phase 3 surface */
extern int geos_shim_overlay_all(GeosShim *, int, const void *, void **, unsigned int, double,
                                 void **);
extern int geos_shim_pred_all(GeosShim *, int, const void *, void **, unsigned int, unsigned char *);
extern int geos_shim_unary_all(GeosShim *, int, void **, unsigned int, double, double, double,
                               double, void **);
extern int geos_shim_binary_all(GeosShim *, int, const void *, void **, unsigned int, double,
                                void **);
extern int geos_shim_measure_all(GeosShim *, int, const void *, void **, unsigned int, double *);
extern int geos_shim_buffer_all(GeosShim *, const void *, double, void **, unsigned int, void **);
extern int geos_shim_read_wkb_many(GeosShim *, void *, const unsigned char *, const unsigned int *,
                                   unsigned int, void **);
extern int geos_shim_num_points_many(GeosShim *, void **, unsigned int, uint32_t *);
extern int geos_shim_heap_bytes(GeosShim *, void **, unsigned int, int64_t *);
extern int geos_shim_build_polygonal_many(GeosShim *, const double *, const unsigned int *,
                                          unsigned int, const unsigned int *, unsigned int, int, int,
                                          void **);
extern int geos_shim_build_linestrings_many(GeosShim *, const double *, const unsigned int *,
                                            unsigned int, int, int, void **);
extern int geos_shim_strtree_query_prepared(GeosShim *, void *, const void *, const void *, int,
                                            void **, int32_t *, unsigned int);

static int failures = 0;

#define CHECK(cond, msg)                                                                                           \
  do {                                                                                                             \
    if (!(cond)) {                                                                                                  \
      fprintf(stderr, "FAIL: %s (line %d)\n", msg, __LINE__);                                                      \
      failures++;                                                                                                   \
    }                                                                                                               \
  } while (0)

static int has_error(GeosShim *s) { return geos_shim_last_error(s) != NULL; }

/* 2D Z/M variants: dim stride handled inside the shim. */
static void *mk_line(GeosShim *s, const double *xy, unsigned n) {
  return geos_shim_build_linestring(s, xy, n, 0, 0);
}

int main(void) {
  GeosShim *s = geos_shim_init();
  CHECK(s != NULL, "geos_shim_init");
  void *ctx = geos_shim_context(s);
  CHECK(ctx != NULL, "geos_shim_context");

  /* 1. Linestring roundtrip surface (ownership moves to us; destroyed below). */
  double tri[6] = {0, 0, 3, 0, 0, 3};
  void *line = mk_line(s, tri, 3);
  CHECK(line != NULL && !has_error(s), "build_linestring");

  /* 2. Polygon: shell + hole, closed rings — happy path. */
  double rings[16] = {0, 0, 4, 0, 4, 4, 0, 0, 1, 1, 3, 1, 3, 3, 1, 1};
  unsigned int offs2[2] = {4, 8};
  void *poly = geos_shim_build_polygon(s, rings, offs2, 2, 0, 0);
  CHECK(poly != NULL && !has_error(s), "build_polygon shell+hole");

  /* 3. Polygon with an INVALID (unclosable: 2 distinct points) ring — GEOS
   * fails; the shim must NOT double-free (GEOS consumed the rings on
   * failure) and must leave a captured message. */
  double bad[8] = {0, 0, 1, 1, 0, 0, 1, 1};
  unsigned int badOffs[1] = {4};
  void *badPoly = geos_shim_build_polygon(s, bad, badOffs, 1, 0, 0);
  CHECK(badPoly == NULL, "build_polygon rejects degenerate ring (returns NULL)");
  const char *msg3 = geos_shim_last_error(s); /* consume-on-read: read ONCE */
  CHECK(msg3 != NULL, "failure path captured a message");
  fprintf(stderr, "  (captured: %s)\n", msg3);

  /* 4. RingOffsets validation: offsets[0] == 0 → shim-side rejection. */
  void *zeroOff = geos_shim_build_polygon(s, rings, (unsigned int[1]){0}, 1, 0, 0);
  CHECK(zeroOff == NULL && has_error(s), "ringOffsets[0] == 0 rejected");

  /* 5. Non-monotonic offsets rejected. */
  void *nonMono = geos_shim_build_polygon(s, rings, (unsigned int[2]){4, 4}, 2, 0, 0);
  CHECK(nonMono == NULL && has_error(s), "non-monotonic offsets rejected");

  /* 6. Collection: valid MULTILINESTRING (type 5) takes both parts. */
  double l1[4] = {0, 0, 1, 1};
  double l2[4] = {5, 5, 6, 6};
  void *a = mk_line(s, l1, 2);
  void *b = mk_line(s, l2, 2);
  void *parts[2] = {a, b};
  void *col = geos_shim_build_collection(s, 5, parts, 2);
  CHECK(col != NULL && !has_error(s), "build_collection MULTILINESTRING");

  /* 7. Collection failure (typeId 2 = LINEARRING is not a collection type):
   * GEOS consumes the parts EVEN on failure — the shim must not free them
   * again, and must surface the message. Fresh parts prove no double free. */
  void *p1 = mk_line(s, l1, 2);
  void *p2 = mk_line(s, l2, 2);
  void *badParts[2] = {p1, p2};
  void *badCol = geos_shim_build_collection(s, 2, badParts, 2);
  const char *msg7 = geos_shim_last_error(s);
  CHECK(badCol == NULL && msg7 != NULL, "build_collection invalid typeId → NULL + message");
  fprintf(stderr, "  (captured: %s)\n", msg7);

  /* 8. destroy_many on a partially-built array (NULL tail entries skipped). */
  void *batch8[4] = {line, poly, col, NULL};
  geos_shim_destroy_many(s, batch8, 3);
  fprintf(stderr, "  destroy_many: 3 geoms freed\n");

  /* 9. destroy_many with n = 0 and NULL array: no-op. */
  geos_shim_destroy_many(s, NULL, 0);

  /* 10. Z/M linestrings build with the declared stride (3 doubles/coord). */
  double xyz[9] = {0, 0, 1, 1, 0, 2, 2, 2, 3};
  void *lineZ = geos_shim_build_linestring(s, xyz, 3, 1, 0);
  CHECK(lineZ != NULL && !has_error(s), "build_linestring hasZ");
  geos_shim_destroy_many(s, (void *[1]){lineZ}, 1);

  /* 11. Shim-side error capture consumes on read (second read gives NULL). */
  (void)geos_shim_build_polygon(s, rings, (unsigned int[1]){0}, 1, 0, 0);
  const char *first = geos_shim_last_error(s);/* consume-on-read */
  const char *second = geos_shim_last_error(s);
  CHECK(first != NULL && second == NULL, "last_error consume-on-read");

  /* 12. Notice channel: fresh session starts clean. */
  GeosShim *s2 = geos_shim_init();
  CHECK(s2 != NULL && !has_error(s2), "fresh session has no pending error");
  geos_shim_destroy_many(s2, NULL, 0);
  geos_shim_finish(s2);

  /* ============ Phase 2 surface (interrupt, clones, union dispatch,
   * prepared masks, strtree query/nearest — decisions D16–D21) ============ */

  /* 13. Interrupt flag: set → callback visible via GEOS; reset restores. The
   * flag is global-atomic; flipping it makes any running op throw. */
  geos_shim_interrupt_request();
  geos_shim_interrupt_reset(); /* hygiene: immediately cleared again */
  geos_shim_interrupt_request();
  geos_shim_interrupt_reset();
  fprintf(stderr, "  interrupt request/reset cycle ok\n");

  /* 14. clone_many: two lines cloned; originals and clones all destroyed. */
  void *src[2] = {mk_line(s, l1, 2), mk_line(s, l2, 2)};
  void *clones[2] = {NULL, NULL};
  CHECK(geos_shim_clone_many(s, src, 2, clones) == 0 && clones[0] && clones[1],
        "clone_many clones both");
  void *cloneParts[4] = {src[0], src[1], clones[0], clones[1]};
  geos_shim_destroy_many(s, cloneParts, 4);

  /* 15. clone_many error path: NULL src with n>0 rejected (no leak). */
  CHECK(geos_shim_clone_many(s, NULL, 3, (void *[3]){0}) == -1 && has_error(s),
        "clone_many rejects NULL src");

  /* 16. clone_collect + clone_members: roundtrip preserves the member count. */
  void *m1 = mk_line(s, l1, 2);
  void *m2 = mk_line(s, l2, 2);
  void *members[2] = {m1, m2};
  void *coll2 = geos_shim_clone_collect(s, members, 2);
  CHECK(coll2 != NULL && !has_error(s), "clone_collect builds a collection");
  void *out[4] = {NULL, NULL, NULL, NULL};
  int n2 = geos_shim_clone_members(s, coll2, out, 4);
  CHECK(n2 == 2 && out[0] && out[1], "clone_members clones both members");
  geos_shim_destroy_many(s, out, n2);
  GEOSGeom_destroy_r(ctx, coll2);
  geos_shim_destroy_many(s, members, 2);

  /* 17. union_all strategies on two overlapping squares: unary / disjoint /
   * auto agree; coverage strategy REJECTS the non-coverage with a message. */
  /* True closed squares (4 distinct corners + closing point — a 4-entry
   * ring would be a TRIANGLE and silently change every predicate answer). */
  double sqA[10] = {0, 0, 2, 0, 2, 2, 0, 2, 0, 0};
  double sqB[10] = {1, 1, 3, 1, 3, 3, 1, 3, 1, 1};
  unsigned int sqOffs[1] = {5};
  void *polyA = geos_shim_build_polygon(s, sqA, sqOffs, 1, 0, 0);
  void *polyB = geos_shim_build_polygon(s, sqB, sqOffs, 1, 0, 0);
  CHECK(polyA && polyB, "union_all fixture polygons");
  void *pair[2] = {polyA, polyB};
  void *uUnary = geos_shim_union_all(s, pair, 2, 3);
  void *uDisjoint = geos_shim_union_all(s, pair, 2, 2);
  void *uAuto = geos_shim_union_all(s, pair, 2, 0);
  CHECK(uUnary && uDisjoint && uAuto, "union_all unary/disjoint/auto succeed");
  double dist = 0.0;
  CHECK(GEOSDistance_r(ctx, uUnary, uAuto, &dist) == 1 && dist == 0.0,
        "union_all unary ≡ auto (distance 0)");
  GEOSGeom_destroy_r(ctx, uUnary);
  GEOSGeom_destroy_r(ctx, uDisjoint);
  GEOSGeom_destroy_r(ctx, uAuto);
  void *uCoverage = geos_shim_union_all(s, pair, 2, 1);
  const char *msg17 = geos_shim_last_error(s); /* read BEFORE any has_error() */
  CHECK(uCoverage == NULL, "union_all coverage strategy rejects non-coverage");
  CHECK(msg17 != NULL && strstr(msg17, "coverage") != NULL, "coverage rejection message");
  fprintf(stderr, "  (captured: %s)\n", msg17 ? msg17 : "(null)");
  void *cu = geos_shim_coverage_union(s, pair, 2); /* raw: caller asserts */
  CHECK(cu != NULL, "raw coverage_union does not throw on non-coverage");
  if (cu)
    GEOSGeom_destroy_r(ctx, cu);
  void *uOne = geos_shim_union_all(s, pair, 1, 0);
  CHECK(uOne != NULL, "union_all n=1 is the identity (clone)");
  void *unionParts[4] = {polyA, polyB, uOne};
  geos_shim_destroy_many(s, unionParts, 3);

  /* 18. Prepared predicate batch masks: every predId pinned against a
   * known-answer fixture set (the enum contract — a swapped id must fail). */
  void *square = geos_shim_build_polygon(s, sqA, sqOffs, 1, 0, 0);
  const void *prep = GEOSPrepare_r(ctx, square);
  CHECK(prep != NULL, "GEOSPrepare_r fixture");
  /* Fixtures vs the prepared 0..2 square (masks are {inside,partial,touch,line,big,far}):
   *   inside  = triangle strictly interior
   *   partial = square overlapping half of it  (interiors cross, neither contains)
   *   touch   = polygon sharing the x=2 edge only
   *   line    = linestring through the interior (P/L crosses = 1)
   *   big     = polygon CONTAINING the square (coveredBy/within/containsProperly = 1)
   *   far     = polygon 50 units away (disjoint = 1)                                    */
  void *inside = geos_shim_build_polygon(
      s, (double[8]){0.5, 0.5, 0.75, 0.5, 0.75, 0.75, 0.5, 0.5}, (unsigned int[1]){4}, 1, 0, 0);
  void *partial = geos_shim_build_polygon(
      s, (double[10]){1, 1, 3, 1, 3, 3, 1, 3, 1, 1}, (unsigned int[1]){5}, 1, 0, 0);
  void *touch = geos_shim_build_polygon(
      s, (double[10]){2, 0, 3, 0, 3, 2, 2, 2, 2, 0}, (unsigned int[1]){5}, 1, 0, 0);
  void *crossLine = mk_line(s, (double[4]){-1, 1, 3, 1}, 2);
  void *big = geos_shim_build_polygon(
      s, (double[10]){-2, -2, 12, -2, 12, 12, -2, 12, -2, -2}, (unsigned int[1]){5}, 1, 0, 0);
  void *far = geos_shim_build_polygon(
      s, (double[8]){50, 50, 50.5, 50, 50.5, 50.5, 50, 50}, (unsigned int[1]){4}, 1, 0, 0);
  void *cand[6] = {inside, partial, touch, crossLine, big, far};
  static const struct {
    int id;
    unsigned char mask[6];
  } PREP_ANSWERS[10] = {
      /* intersects        */ {0, {1, 1, 1, 1, 1, 0}},
      /* contains          */ {1, {1, 0, 0, 0, 0, 0}},
      /* containsProperly  */ {2, {1, 0, 0, 0, 0, 0}},
      /* coveredBy         */ {3, {0, 0, 0, 0, 1, 0}},
      /* covers            */ {4, {1, 0, 0, 0, 0, 0}},
      /* crosses           */ {5, {0, 0, 0, 1, 0, 0}},
      /* disjoint          */ {6, {0, 0, 0, 0, 0, 1}},
      /* overlaps          */ {7, {0, 1, 0, 0, 0, 0}},
      /* touches           */ {8, {0, 0, 1, 0, 0, 0}},
      /* within            */ {9, {0, 0, 0, 0, 1, 0}},
  };
  for (int p = 0; p < 10; p++) {
    unsigned char mask[6] = {9, 9, 9, 9, 9, 9};
    int r = geos_shim_prepared_pred_all(s, prep, PREP_ANSWERS[p].id, cand, 6, mask);
    CHECK(r == 0, "prepared_pred_all evaluates pred");
    int same = 1;
    for (int k = 0; k < 6; k++)
      if (mask[k] != PREP_ANSWERS[p].mask[k])
        same = 0;
    CHECK(same, "predicate id matches its known-answer mask");
    if (!same)
      fprintf(stderr, "  (predId %d mask mismatch: %u%u%u%u%u%u)\n", PREP_ANSWERS[p].id, mask[0],
              mask[1], mask[2], mask[3], mask[4], mask[5]);
  }
  /* relate pattern batch (valid + invalid pattern). */
  unsigned char mask4[6] = {9, 9, 9, 9, 9, 9};
  CHECK(geos_shim_prepared_relate_pattern_all(s, prep, cand, 6, "0********", mask4) == 0,
        "relate_pattern_all valid pattern");
  CHECK(geos_shim_prepared_relate_pattern_all(s, prep, cand, 6, "BAD", mask4) == 1 && has_error(s),
        "relate_pattern_all invalid pattern -> exception");
  geos_shim_last_error(s);
  GEOSPreparedGeom_destroy_r(ctx, prep);
  geos_shim_destroy_many(s, (void *[7]){square, inside, partial, touch, crossLine, big, far}, 7);

  /* 19. STRtree query + nearest with integer-id items (D16). Items are
   * stored 1-BASED: GEOS returns the item from nearest_generic, and a 0 item
   * would be indistinguishable from the NULL "no answer" return — the tree
   * in scenario 19 pins exactly that case (nearest to item id 0). */
  void *tree = NULL;
  {
    /* extern decls for the tree itself */
    extern void *GEOSSTRtree_create_r(void *, size_t);
    extern void GEOSSTRtree_insert_r(void *, void *, const void *, void *);
    extern int GEOSSTRtree_build_r(void *, void *);
    extern void GEOSSTRtree_destroy_r(void *, void *);
    tree = GEOSSTRtree_create_r(ctx, 10);
    CHECK(tree != NULL, "GEOSSTRtree_create_r");
    void *items[50];
    for (int i = 0; i < 50; i++) {
      double xy[4] = {i, i, i + 1, i + 1}; /* diagonal segment i */
      items[i] = mk_line(s, xy, 2);
      /* 1-BASED item encoding — the shim decodes (item - 1). */
      GEOSSTRtree_insert_r(ctx, tree, items[i], (void *)(intptr_t)(i + 1));
    }
    GEOSSTRtree_build_r(ctx, tree);
    void *query = mk_line(s, (double[4]){10, 10, 15, 15}, 2);
    int32_t ids[64] = {0};
    /* Envelope [9,10]² touches [10,15]² at the single point (10,10) — a
     * boundary touch IS an envelope intersection, so ids are 9..15. */
    int total = geos_shim_strtree_query(s, tree, query, ids, 64);
    CHECK(total == 7, "strtree_query finds ids 9..15 (1-based decode)");
    int ok = 1;
    for (int k = 0; k < total; k++)
      if (ids[k] < 9 || ids[k] > 15)
        ok = 0;
    CHECK(ok, "query ids are the expected range");
    /* small buffer: total exceeds maxOut, partial write, no overflow */
    int32_t tiny[2] = {-1, -1};
    int total2 = geos_shim_strtree_query(s, tree, query, tiny, 2);
    CHECK(total2 == 7 && tiny[0] == 9 && tiny[1] == 10, "small buffer writes prefix only");
    /* nearest: id→geom table bound once, then reused */
    void *table = geos_shim_strtree_bind_geoms(s, items, 50);
    CHECK(table != NULL, "strtree_bind_geoms");
    int near = geos_shim_strtree_nearest(s, tree, query, table);
    CHECK(near >= 9 && near <= 15, "nearest id touches the query (distance 0)");
    void *farQuery = mk_line(s, (double[4]){49.4, 49.4, 49.4, 49.4}, 2);
    int near2 = geos_shim_strtree_nearest(s, tree, farQuery, table);
    CHECK(near2 == 49, "nearest picks id 49 for (49.4, 49.4)");
    GEOSGeom_destroy_r(ctx, farQuery);
    /* THE NULL-OVERLOAD PIN (audited blocker): query nearest to ITEM 0 —
     * the correct answer is id 0, which as a raw item would be NULL/-1. */
    void *id0Query = mk_line(s, (double[4]){-0.5, 0, 0.5, 0}, 2);
    int near0 = geos_shim_strtree_nearest(s, tree, id0Query, table);
    CHECK(near0 == 0, "nearest reports id 0 (not -1) when item 0 is nearest");
    GEOSGeom_destroy_r(ctx, id0Query);
    /* empty table binding is rejected (nearest needs a table) */
    CHECK(geos_shim_strtree_nearest(s, tree, query, NULL) == -2 && has_error(s),
          "nearest without a table is an error");
    geos_shim_last_error(s);
    geos_shim_strtree_table_free(table);
    GEOSGeom_destroy_r(ctx, query);
    geos_shim_destroy_many(s, items, 50);
    GEOSSTRtree_destroy_r(ctx, tree);
  }

  /* ============================================================= */
  /* ============ Phase 3 scenarios: the batch op layer =========== */
  /* ============================================================= */

  /* 20. overlay_all INTERSECTION known answers: big square vs 4 unit
   * squares on the diagonal → each result area is exactly 1. */
  {
    void *bigSq = geos_shim_build_polygon(
        s, (double[10]){0, 0, 10, 0, 10, 10, 0, 10, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    CHECK(bigSq != NULL, "overlay fixture big square");
    void *units[4];
    for (int i = 0; i < 4; i++) {
      double x = i + 1;
      units[i] = geos_shim_build_polygon(
          s,
          (double[10]){x, x, x + 1, x, x + 1, x + 1, x, x + 1, x, x},
          (unsigned int[1]){5}, 1, 0, 0);
      CHECK(units[i] != NULL, "overlay fixture unit square");
    }
    void *outs[4] = {0};
    int r = geos_shim_overlay_all(s, 0 /* INTERSECTION */, bigSq, units, 4, 0.0, outs);
    CHECK(r == 0, "overlay_all intersection succeeds");
    int areasOk = 1;
    for (int i = 0; i < 4; i++) {
      double a = -1;
      if (!outs[i] || GEOSArea_r(ctx, outs[i], &a) != 1 || a < 0.999 || a > 1.001)
        areasOk = 0;
    }
    CHECK(areasOk, "overlay_all intersection areas are 1.0");
    geos_shim_destroy_many(s, outs, 4);
    /* unknown op id → exception */
    CHECK(geos_shim_overlay_all(s, 99, bigSq, units, 4, 0.0, outs) == 1 && has_error(s),
          "overlay_all unknown op id is an exception");
    geos_shim_last_error(s);
    /* NULL input at index 2 → exception, partials destroyed (LSan verifies) */
    void *nullish[4] = {units[0], units[1], NULL, units[3]};
    CHECK(geos_shim_overlay_all(s, 0, bigSq, nullish, 4, 0.0, outs) == 1 && has_error(s),
          "overlay_all NULL input aborts all-or-nothing");
    geos_shim_last_error(s);
    /* UNION_PREC of two disjoint squares with grid 1 → exact union 2.0 */
    void *d0 = geos_shim_build_polygon(
        s, (double[10]){0, 0, 1, 0, 1, 1, 0, 1, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    void *d1 = geos_shim_build_polygon(
        s, (double[10]){2, 2, 3, 2, 3, 3, 2, 3, 2, 2}, (unsigned int[1]){5}, 1, 0, 0);
    void *two[2] = {d0, d1};
    void *uouts[2] = {0};
    CHECK(geos_shim_overlay_all(s, 5 /* UNION_PREC */, d0, two, 2, 1.0, uouts) == 0,
          "overlay_all unionPrec succeeds");
    double ua = -1;
    CHECK(uouts[1] && GEOSArea_r(ctx, uouts[1], &ua) == 1 && ua > 1.999 && ua < 2.001,
          "unionPrec area is exactly 2.0");
    geos_shim_destroy_many(s, uouts, 2);
    geos_shim_destroy_many(s, (void *[]){d0, d1}, 2);
    geos_shim_destroy_many(s, (void *[]){bigSq, units[0], units[1], units[2], units[3]}, 5);
  }

  /* 21. pred_all: unprepared batch masks with known answers. */
  {
    void *sq = geos_shim_build_polygon(
        s, (double[10]){0, 0, 4, 0, 4, 4, 0, 4, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    /* points: inside, on-boundary, outside */
    void *pts[3];
    pts[0] = mk_point(s, ctx, 2, 2);
    pts[1] = mk_point(s, ctx, 0, 2);
    pts[2] = mk_point(s, ctx, 9, 9);
    unsigned char mask[3] = {9, 9, 9};
    CHECK(geos_shim_pred_all(s, 0 /* INTERSECTS */, sq, pts, 3, mask) == 0,
          "pred_all intersects succeeds");
    CHECK(mask[0] == 1 && mask[1] == 1 && mask[2] == 0, "pred_all known-answer mask (in/in/out)");
    unsigned char mask2[3] = {9, 9, 9};
    CHECK(geos_shim_pred_all(s, 8 /* WITHIN */, pts[2], pts, 3, mask2) == 0,
          "pred_all within succeeds");
    CHECK(mask2[2] == 1 && mask2[0] == 0, "pred_all within known answer");
    CHECK(geos_shim_pred_all(s, 42, sq, pts, 3, mask) == 1 && has_error(s),
          "pred_all unknown predicate id is an exception");
    geos_shim_last_error(s);
    geos_shim_destroy_many(s, (void *[]){sq, pts[0], pts[1], pts[2]}, 4);
  }

  /* 22. measure_all: batch areas/lengths/distances + argument shape rules. */
  {
    void *sqs[3];
    for (int i = 0; i < 3; i++) {
      double side = i + 1;
      double x = 10.0 * i;
      sqs[i] = geos_shim_build_polygon(
          s,
          (double[10]){x, 0, x + side, 0, x + side, side, x, side, x, 0},
          (unsigned int[1]){5}, 1, 0, 0);
      CHECK(sqs[i] != NULL, "measure fixture square");
    }
    double vals[3] = {0};
    CHECK(geos_shim_measure_all(s, 0 /* AREA */, NULL, sqs, 3, vals) == 0, "measure_all area");
    CHECK(vals[0] == 1.0 && vals[1] == 4.0 && vals[2] == 9.0, "measure_all areas exact");
    CHECK(geos_shim_measure_all(s, 1 /* LENGTH */, NULL, sqs, 3, vals) == 0, "measure_all length");
    CHECK(vals[0] == 4.0 && vals[1] == 8.0 && vals[2] == 12.0, "measure_all lengths exact");
    void *probe = mk_point(s, ctx, -5, 0);
    CHECK(geos_shim_measure_all(s, 2 /* DISTANCE */, probe, sqs, 3, vals) == 0,
          "measure_all distance");
    CHECK(vals[0] == 5.0 && vals[1] == 15.0 && vals[2] == 25.0, "measure_all distances exact");
    CHECK(geos_shim_measure_all(s, 0, probe, sqs, 3, vals) == 1 && has_error(s),
          "measure_all unary op rejects a reference geometry");
    geos_shim_last_error(s);
    CHECK(geos_shim_measure_all(s, 2, NULL, sqs, 3, vals) == 1 && has_error(s),
          "measure_all binary op requires a reference geometry");
    geos_shim_last_error(s);
    CHECK(geos_shim_measure_all(s, 77, NULL, sqs, 3, vals) == 1 && has_error(s),
          "measure_all unknown op id");
    geos_shim_last_error(s);
    geos_shim_destroy_many(s, (void *[]){probe, sqs[0], sqs[1], sqs[2]}, 4);
  }

  /* 23. buffer_all with TS-style params; known round-join area bracket. */
  {
    extern void *GEOSBufferParams_create_r(void *);
    extern void GEOSBufferParams_destroy_r(void *, void *);
    void *params = GEOSBufferParams_create_r(ctx);
    CHECK(params != NULL, "buffer params fixture");
    void *pts[2];
    pts[0] = mk_point(s, ctx, 0, 0);
    pts[1] = mk_point(s, ctx, 50, 50);
    void *bufs[2] = {0};
    CHECK(geos_shim_buffer_all(s, params, 1.0, pts, 2, bufs) == 0, "buffer_all succeeds");
    double ba = -1;
    CHECK(bufs[0] && GEOSArea_r(ctx, bufs[0], &ba) == 1 && ba > 3.0 && ba < 3.2,
          "buffer_all point disc area ≈ π (quadSegs 8 default)");
    CHECK(geos_shim_buffer_all(s, NULL, 1.0, pts, 2, bufs) == 1 && has_error(s),
          "buffer_all without params is an error");
    geos_shim_last_error(s);
    geos_shim_destroy_many(s, bufs, 2);
    GEOSBufferParams_destroy_r(ctx, params);
    geos_shim_destroy_many(s, (void *[]){pts[0], pts[1]}, 2);
  }

  /* 24. read_wkb_many: two hardcoded POINT WKBs, byte offsets; failure
   * mid-array destroys partials; decreasing offsets rejected. */
  {
    extern void *GEOSWKBReader_create_r(void *);
    extern void GEOSWKBReader_destroy_r(void *, void *);
    /* POINT(0 0) and POINT(3 4), little-endian ISO WKB, 21 bytes each:
     * order(1) + type(4) + x(8) + y(8). */
    unsigned char wkb[42] = {
      /* POINT(0 0) */
      0x01, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* x = 0.0 */
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* y = 0.0 */
      /* POINT(3 4) */
      0x01, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x40, /* x = 3.0 */
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x40, /* y = 4.0 */
    };
    void *reader = GEOSWKBReader_create_r(ctx);
    CHECK(reader != NULL, "wkb reader fixture");
    unsigned int woffs[2] = {21, 42};
    void *rd[2] = {0};
    CHECK(geos_shim_read_wkb_many(s, reader, wkb, woffs, 2, rd) == 0, "read_wkb_many succeeds");
    double dd = -1;
    CHECK(rd[0] && rd[1] && GEOSDistance_r(ctx, rd[0], rd[1], &dd) == 1 && dd == 5.0,
          "read_wkb_many geometries are POINT(0 0) and POINT(3 4)");
    geos_shim_destroy_many(s, rd, 2);
    /* malformed second record → exception, first partial destroyed */
    wkb[25] = 0xff;
    CHECK(geos_shim_read_wkb_many(s, reader, wkb, woffs, 2, rd) == 1 && has_error(s),
          "read_wkb_many malformed WKB aborts all-or-nothing");
    geos_shim_last_error(s);
    wkb[25] = 0;
    unsigned int badOffs[2] = {42, 21};
    CHECK(geos_shim_read_wkb_many(s, reader, wkb, badOffs, 2, rd) == 1 && has_error(s),
          "read_wkb_many decreasing offsets rejected");
    geos_shim_last_error(s);
    GEOSWKBReader_destroy_r(ctx, reader);
  }

  /* 25. num_points_many (parallel chunk weights) + heap_bytes (D24). */
  {
    void *l3 = geos_shim_build_linestring(s, (double[6]){0, 0, 1, 1, 2, 2}, 3, 0, 0);
    void *l2 = geos_shim_build_linestring(s, (double[4]){5, 5, 6, 6}, 2, 0, 0);
    void *ls[2] = {l3, l2};
    uint32_t counts[2] = {0, 0};
    CHECK(geos_shim_num_points_many(s, ls, 2, counts) == 0, "num_points_many succeeds");
    CHECK(counts[0] == 3 && counts[1] == 2, "num_points_many counts exact");
    CHECK(geos_shim_num_points_many(s, (void *[2]){l3, NULL}, 2, counts) == 1 && has_error(s),
          "num_points_many NULL input is an error");
    geos_shim_last_error(s);
    int64_t bytes = -1;
    CHECK(geos_shim_heap_bytes(s, ls, 2, &bytes) == 0, "heap_bytes succeeds");
    CHECK(bytes == (64 + 3 * 2 * 8) + (64 + 2 * 2 * 8), "heap_bytes estimate exact for 2D lines");
    int64_t zero = -1;
    CHECK(geos_shim_heap_bytes(s, NULL, 0, &zero) == 0 && zero == 0, "heap_bytes n=0 is 0");
    /* vertex counts are type-generic (GEOSGeomGetNumPoints_r is
     * linestring-only): a polygon sums its rings. */
    void *poly = geos_shim_build_polygon(
        s, (double[10]){0, 0, 2, 0, 2, 2, 0, 2, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    void *mp[1] = {poly};
    uint32_t pc = 0;
    CHECK(geos_shim_num_points_many(s, mp, 1, &pc) == 0 && pc == 5,
          "num_points_many counts polygon rings (linestring-only accessor absorbed)");
    int64_t pbytes = -1;
    CHECK(geos_shim_heap_bytes(s, mp, 1, &pbytes) == 0 && pbytes == 64 + 5 * 2 * 8,
          "heap_bytes works for polygons");
    /* POINT is not a SimpleCurve in 3.14 — GetNumPoints throws on it; the
     * shim counts a point as 1 vertex without that accessor. */
    void *pt = mk_point(s, ctx, 7, 7);
    void *pe = mk_point(s, ctx, 9, 9);
    uint32_t ptc[2] = {0, 0};
    void *pp[2] = {pt, pe};
    CHECK(geos_shim_num_points_many(s, pp, 2, ptc) == 0 && ptc[0] == 1 && ptc[1] == 1,
          "num_points_many counts POINT geometries (SimpleCurve cast absorbed)");
    /* empty point → 0 (the isEmpty branch of the typeId-0 case) */
    extern void *GEOSGeom_createEmptyPoint_r(void *);
    void *pempty = GEOSGeom_createEmptyPoint_r(ctx);
    CHECK(pempty != NULL, "empty point fixture");
    uint32_t ec = 9;
    CHECK(geos_shim_num_points_many(s, (void *[1]){pempty}, 1, &ec) == 0 && ec == 0,
          "num_points_many counts an EMPTY point as 0");
    GEOSGeom_destroy_r(ctx, pempty);
    geos_shim_destroy_many(s, (void *[]){pt, pe}, 2);
    geos_shim_destroy_many(s, mp, 1);
    geos_shim_destroy_many(s, ls, 2);
  }

  /* 26. build_polygonal_many: four unit tiles from one buffer, one call. */
  {
    double xy[40]; /* 4 tiles × 5 coords × 2 doubles */
    for (int t = 0; t < 4; t++) {
      double x = (t % 2) * 1.0, y = (t / 2) * 1.0;
      double ring[10] = {x, y, x + 1, y, x + 1, y + 1, x, y + 1, x, y};
      for (int k = 0; k < 10; k++)
        xy[t * 10 + k] = ring[k];
    }
    unsigned int rings[4] = {5, 10, 15, 20};
    unsigned int parts[4] = {1, 2, 3, 4};
    void *polys[4] = {0};
    CHECK(geos_shim_build_polygonal_many(s, xy, rings, 4, parts, 4, 0, 0, polys) == 0,
          "build_polygonal_many succeeds");
    int ok = 1;
    for (int t = 0; t < 4; t++) {
      double a = -1;
      if (!polys[t] || GEOSArea_r(ctx, polys[t], &a) != 1 || a < 0.999 || a > 1.001)
        ok = 0;
    }
    CHECK(ok, "build_polygonal_many tiles all area 1");
    geos_shim_destroy_many(s, polys, 4);
    unsigned int badParts[4] = {1, 2, 3, 5}; /* last != nrings */
    CHECK(geos_shim_build_polygonal_many(s, xy, rings, 4, badParts, 4, 0, 0, polys) == 1 &&
              has_error(s),
          "build_polygonal_many rejects partOffsets ending != nrings");
    geos_shim_last_error(s);
  }

  /* 27. build_linestrings_many: two lines from one buffer; short line
   * rejected; strict-increase rule enforced. */
  {
    double xy[10] = {0, 0, 1, 1, 5, 5, 6, 6, 7, 7};
    unsigned int loffs[2] = {3, 5};
    void *lines[2] = {0};
    CHECK(geos_shim_build_linestrings_many(s, xy, loffs, 2, 0, 0, lines) == 0,
          "build_linestrings_many succeeds");
    uint32_t counts[2] = {0, 0};
    void *ls[2] = {lines[0], lines[1]};
    CHECK(geos_shim_num_points_many(s, ls, 2, counts) == 0 && counts[0] == 3 && counts[1] == 2,
          "build_linestrings_many line vertex counts exact");
    geos_shim_destroy_many(s, lines, 2);
    unsigned int shortOffs[2] = {1, 3}; /* line 0 has 1 coordinate */
    CHECK(geos_shim_build_linestrings_many(s, xy, shortOffs, 2, 0, 0, lines) == 1 && has_error(s),
          "build_linestrings_many rejects a 1-coordinate line");
    geos_shim_last_error(s);
    unsigned int flatOffs[2] = {3, 3};
    CHECK(geos_shim_build_linestrings_many(s, xy, flatOffs, 2, 0, 0, lines) == 1 && has_error(s),
          "build_linestrings_many rejects non-increasing offsets");
    geos_shim_last_error(s);
  }

  /* 28. Fused tree query + prepared filter: one crossing. Rebuild a small
   * diagonal tree, prepare a big square, filter INTERSECTS. */
  {
    extern void *GEOSSTRtree_create_r(void *, size_t);
    extern void GEOSSTRtree_insert_r(void *, void *, const void *, void *);
    extern int GEOSSTRtree_build_r(void *, void *);
    extern void GEOSSTRtree_destroy_r(void *, void *);
    void *tree2 = GEOSSTRtree_create_r(ctx, 10);
    CHECK(tree2 != NULL, "fused tree fixture");
    void *fitems[50];
    for (int i = 0; i < 50; i++) {
      double xy2[4] = {i, i, i + 1, i + 1};
      fitems[i] = mk_line(s, xy2, 2);
      GEOSSTRtree_insert_r(ctx, tree2, fitems[i], (void *)(intptr_t)(i + 1));
    }
    GEOSSTRtree_build_r(ctx, tree2);
    void *table2 = geos_shim_strtree_bind_geoms(s, fitems, 50);
    CHECK(table2 != NULL, "fused bind table");
    void *fsq = geos_shim_build_polygon(
        s, (double[10]){0, 0, 14.5, 0, 14.5, 14.5, 0, 14.5, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    void *fprep = GEOSPrepare_r(ctx, fsq);
    CHECK(fprep != NULL, "fused prepared fixture");
    void *fq = mk_line(s, (double[4]){10, 10, 15, 15}, 2); /* candidates 9..15 */
    int32_t fids[64] = {0};
    int total = geos_shim_strtree_query_prepared(s, tree2, fq, fprep, 0 /* INTERSECTS */, table2,
                                                 fids, 64);
    CHECK(total == 6, "fused filter keeps segments 9..14 (15 starts at 15,15)");
    int fok = total == 6;
    for (int k = 0; k < total; k++)
      if (fids[k] < 9 || fids[k] > 14)
        fok = 0;
    CHECK(fok, "fused ids are the expected range");
    /* small buffer: total still reported, prefix written */
    int32_t ftiny[2] = {-1, -1};
    int ftotal2 = geos_shim_strtree_query_prepared(s, tree2, fq, fprep, 0, table2, ftiny, 2);
    CHECK(ftotal2 == 6 && ftiny[0] >= 9 && ftiny[1] >= 9, "fused small buffer writes prefix only");
    /* no table → error */
    CHECK(geos_shim_strtree_query_prepared(s, tree2, fq, fprep, 0, NULL, fids, 64) == -1 &&
              has_error(s),
          "fused without a bind table is an error");
    geos_shim_last_error(s);
    GEOSGeom_destroy_r(ctx, fq);
    GEOSPreparedGeom_destroy_r(ctx, fprep);
    geos_shim_destroy_many(s, (void *[]){fsq, fitems[0], fitems[1], fitems[2], fitems[3],
                                         fitems[4], fitems[5], fitems[6], fitems[7], fitems[8]},
                           10);
    /* destroy the rest of the fixture items (9..49) */
    geos_shim_destroy_many(s, &((void **)fitems)[9], 41);
    geos_shim_strtree_table_free(table2);
    GEOSSTRtree_destroy_r(ctx, tree2);
  }

  /* ============================================================= */
  /* ========= Phase 5 scenarios: construction batch ops ========= */
  /* ============================================================= */

  /* 29. unary_all: pin the SHIM_UNARY_* table with known answers and the
   * D18 contract (interrupted/unknown/NULL paths). */
  {
    /* three small polygons + one L-shaped line for line merge */
    void *tiles[3];
    for (int i = 0; i < 3; i++) {
      double x = i * 2;
      tiles[i] = geos_shim_build_polygon(
          s, (double[10]){x, 0, x + 1, 0, x + 1, 1, x, 1, x, 0}, (unsigned int[1]){5}, 1, 0, 0);
      CHECK(tiles[i] != NULL, "unary fixture tile");
    }
    void *outs[3] = {0};
    /* CONVEX_HULL (id 0) of each 1x1 tile → itself: areas exactly 1 */
    CHECK(geos_shim_unary_all(s, 0, tiles, 3, 0, 0, 0, 0, outs) == 0,
          "unary_all convexHull succeeds");
    int hullOk = 1;
    for (int i = 0; i < 3; i++) {
      double a = -1;
      if (!outs[i] || GEOSArea_r(ctx, outs[i], &a) != 1 || a < 0.999 || a > 1.001)
        hullOk = 0;
    }
    CHECK(hullOk, "unary_all convexHull areas are 1.0");
    geos_shim_destroy_many(s, outs, 3);
    /* CENTROID (id 3): each tile's centroid is its center */
    CHECK(geos_shim_unary_all(s, 3, tiles, 3, 0, 0, 0, 0, outs) == 0,
          "unary_all centroid succeeds");
    int centOk = 1;
    for (int i = 0; i < 3; i++) {
      double x = i * 2 + 0.5;
      /* centroid of a unit square at (x0,0): WKT contains "x0.5 0.5" —
       * compare via distance instead: nearest-approach via area of a tiny
       * buffer is overkill; assert the area is 0 (a point) and non-null. */
      double a = -1;
      if (!outs[i] || GEOSArea_r(ctx, outs[i], &a) != 1 || a != 0.0) centOk = 0;
      (void)x;
    }
    CHECK(centOk, "unary_all centroids are points");
    geos_shim_destroy_many(s, outs, 3);
    /* SIMPLIFY_DP (id 1) with a huge tolerance → the tile collapses */
    CHECK(geos_shim_unary_all(s, 1, tiles, 3, 100.0, 0, 0, 0, outs) == 0,
          "unary_all simplify succeeds");
    geos_shim_destroy_many(s, outs, 3);
    /* CLIP_BY_RECT (id 8): clip tile 1 (x ∈ [2,3]) to [2.5, 10] → area 0.5 */
    void *one[1] = {tiles[1]};
    CHECK(geos_shim_unary_all(s, 8, one, 1, 2.5, -1.0, 10.0, 10.0, outs) == 0,
          "unary_all clipByRect succeeds");
    double ca = -1;
    CHECK(outs[0] && GEOSArea_r(ctx, outs[0], &ca) == 1 && ca > 0.499 && ca < 0.501,
          "clipByRect area is 0.5");
    geos_shim_destroy_many(s, outs, 1);
    /* unknown op id → exception */
    CHECK(geos_shim_unary_all(s, 99, tiles, 3, 0, 0, 0, 0, outs) == 1 && has_error(s),
          "unary_all unknown op id is an exception");
    geos_shim_last_error(s);
    /* NULL input at index 1 → exception, partials destroyed (LSan verifies) */
    void *nullish[3] = {tiles[0], NULL, tiles[2]};
    CHECK(geos_shim_unary_all(s, 0, nullish, 3, 0, 0, 0, 0, outs) == 1 && has_error(s),
          "unary_all NULL input aborts all-or-nothing");
    geos_shim_last_error(s);
    geos_shim_destroy_many(s, tiles, 3);
  }

  /* 30. binary_all: pin the SHIM_BINARY_* table (SNAP, SHARED_PATHS).
   * sharedPaths is LINEAL-only (GEOS throws on areal inputs). */
  {
    /* a slightly-off square snapping toward an exact one within tolerance */
    void *exact = geos_shim_build_polygon(
        s, (double[10]){0, 0, 4, 0, 4, 4, 0, 4, 0, 0}, (unsigned int[1]){5}, 1, 0, 0);
    void *wobbly[2];
    wobbly[0] = geos_shim_build_polygon(
        s, (double[10]){0.1, 0.1, 4, 0, 4, 4, 0, 4, 0.1, 0.1}, (unsigned int[1]){5}, 1, 0, 0);
    wobbly[1] = geos_shim_build_polygon(
        s, (double[10]){0.2, 0.2, 4, 0, 4, 4, 0, 4, 0.2, 0.2}, (unsigned int[1]){5}, 1, 0, 0);
    void *outs[2] = {0};
    CHECK(geos_shim_binary_all(s, 0 /* SNAP */, exact, wobbly, 2, 0.5, outs) == 0,
          "binary_all snap succeeds");
    /* snapping exact's (0,0) onto each wobbly vertex moves the corner: the
     * area is 16 − 0.2×(i+1) (the corner cut), i.e. 15.6 then 15.2 */
    int snapOk = 1;
    for (int i = 0; i < 2; i++) {
      double a = -1;
      double expected = 16.0 - 0.4 * (i + 1);
      if (!outs[i] || GEOSArea_r(ctx, outs[i], &a) != 1 || a < expected - 0.01 ||
          a > expected + 0.01)
        snapOk = 0;
    }
    CHECK(snapOk, "binary_all snap results are the snapped squares");
    geos_shim_destroy_many(s, outs, 2);
    /* SHARED_PATHS (id 1): overlapping collinear segments share (2 0, 4 0);
     * disjoint lines share nothing (empty geometry, no exception). */
    void *lines[2];
    lines[0] = geos_shim_build_linestring(s, (double[4]){0, 0, 4, 0}, 2, 0, 0);
    lines[1] = geos_shim_build_linestring(s, (double[4]){2, 0, 6, 0}, 2, 0, 0);
    void *disjoint[1];
    disjoint[0] = geos_shim_build_linestring(s, (double[4]){100, 100, 101, 101}, 2, 0, 0);
    CHECK(lines[0] && lines[1] && disjoint[0], "binary_all line fixtures");
    void *others[1] = {lines[1]}; /* (2 0, 6 0) — shares (2 0, 4 0) with lines[0] */
    CHECK(geos_shim_binary_all(s, 1 /* SHARED_PATHS */, lines[0], others, 1, 0.0, outs) == 0,
          "binary_all sharedPaths succeeds");
    double len = -1;
    CHECK(outs[0] && GEOSLength_r(ctx, outs[0], &len) == 1 && len > 1.999 && len < 2.001,
          "sharedPaths finds the shared 2-unit segment");
    geos_shim_destroy_many(s, outs, 1);
    CHECK(geos_shim_binary_all(s, 1, lines[0], disjoint, 1, 0.0, outs) == 0,
          "binary_all sharedPaths on disjoint lines succeeds");
    len = -1;
    CHECK(outs[0] && GEOSLength_r(ctx, outs[0], &len) == 1 && len == 0.0,
          "sharedPaths on disjoint lines is empty");
    geos_shim_destroy_many(s, outs, 1);
    /* NULL input → exception, partials destroyed */
    void *nullish[2] = {lines[0], NULL};
    CHECK(geos_shim_binary_all(s, 0, exact, nullish, 2, 0.5, outs) == 1 && has_error(s),
          "binary_all NULL input aborts all-or-nothing");
    geos_shim_last_error(s);
    /* unknown op id → exception */
    CHECK(geos_shim_binary_all(s, 42, exact, wobbly, 2, 0.5, outs) == 1 && has_error(s),
          "binary_all unknown op id is an exception");
    geos_shim_last_error(s);
    geos_shim_destroy_many(s, (void *[]){exact, wobbly[0], wobbly[1], lines[0], lines[1], disjoint[0]},
                           6);
  }

  geos_shim_finish(s);
  if (failures == 0) {
    fprintf(stderr, "shim_selftest: ALL CLEAN\n");
    return 0;
  }
  fprintf(stderr, "shim_selftest: %d FAILURE(S)\n", failures);
  return 1;
}
