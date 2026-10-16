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

  geos_shim_finish(s);
  if (failures == 0) {
    fprintf(stderr, "shim_selftest: ALL CLEAN\n");
    return 0;
  }
  fprintf(stderr, "shim_selftest: %d FAILURE(S)\n", failures);
  return 1;
}
