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
  void *partial[4] = {line, poly, col, NULL};
  geos_shim_destroy_many(s, partial, 3);
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

  geos_shim_finish(s);
  if (failures == 0) {
    fprintf(stderr, "shim_selftest: ALL CLEAN\n");
    return 0;
  }
  fprintf(stderr, "shim_selftest: %d FAILURE(S)\n", failures);
  return 1;
}
