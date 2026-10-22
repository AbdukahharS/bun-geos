// GEOS C++ direct baseline — the zero-boundary reference for the competitor
// benchmark suite. The same engine bun-geos binds (the vendored GEOS 3.14),
// called through the C API with no FFI, no WASM, no wrapper: it isolates
// what each boundary costs.
//
// Usage: baseline <scenario> <size> <workloadDir>
//   scenario: overlay | union | prepared-scan | strtree | ingest |
//             makevalid | buffer
// Emits one JSON object on stdout:
//   {"variants":{...},"repeats":N,"fingerprint":{...},"note":"..."}
// The GEOS version is printed on stderr as the first line ("geos ...").
//
// Workload inputs come from the canonical files the orchestrator
// materializes (bench/competitors/.workload): identical doubles to what
// every other engine measures — WKT text, little-endian WKB + cumulative
// u32 end-offsets, TSV envelopes.

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <geos_c.h>

namespace {

using Clock = std::chrono::steady_clock;

double elapsedMs(Clock::time_point t0, Clock::time_point t1) {
  return std::chrono::duration<double, std::milli>(t1 - t0).count();
}

template <typename F> double bestOf(int repeats, F &&fn) {
  fn(); // warm-up (excluded)
  double best = 1e30;
  for (int i = 0; i < repeats; i++) {
    const auto t0 = Clock::now();
    fn();
    best = std::min(best, elapsedMs(t0, Clock::now()));
  }
  return best;
}

std::vector<std::string> readLines(const std::string &path) {
  std::ifstream in(path);
  if (!in) {
    std::fprintf(stderr, "cannot read %s\n", path.c_str());
    std::exit(2);
  }
  std::vector<std::string> lines;
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty()) lines.push_back(line);
  }
  return lines;
}

std::vector<uint8_t> readBytes(const std::string &path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::fprintf(stderr, "cannot read %s\n", path.c_str());
    std::exit(2);
  }
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(in),
                              std::istreambuf_iterator<char>());
}

std::vector<uint32_t> readU32Le(const std::string &path, size_t count) {
  const auto bytes = readBytes(path);
  if (bytes.size() < count * 4) {
    std::fprintf(stderr, "offsets truncated: %s\n", path.c_str());
    std::exit(2);
  }
  std::vector<uint32_t> out(count);
  for (size_t i = 0; i < count; i++) {
    out[i] = static_cast<uint32_t>(bytes[i * 4]) |
             (static_cast<uint32_t>(bytes[i * 4 + 1]) << 8) |
             (static_cast<uint32_t>(bytes[i * 4 + 2]) << 16) |
             (static_cast<uint32_t>(bytes[i * 4 + 3]) << 24);
  }
  return out;
}

struct GeosHandle {
  GEOSContextHandle_t h;
  GEOSWKTReader *wktReader;
  GEOSWKBReader *wkbReader;

  explicit GeosHandle() : h(GEOS_init_r()) {
    if (h == nullptr) {
      std::fprintf(stderr, "GEOS_init_r failed\n");
      std::exit(2);
    }
    wktReader = GEOSWKTReader_create_r(h);
    wkbReader = GEOSWKBReader_create_r(h);
  }
  ~GeosHandle() {
    GEOSWKBReader_destroy_r(h, wkbReader);
    GEOSWKTReader_destroy_r(h, wktReader);
    GEOS_finish_r(h);
  }
};

std::vector<GEOSGeometry *> readWktGeoms(GeosHandle &g, const std::vector<std::string> &lines) {
  std::vector<GEOSGeometry *> out;
  out.reserve(lines.size());
  for (const auto &line : lines) {
    GEOSGeometry *geom = GEOSWKTReader_read_r(g.h, g.wktReader, line.c_str());
    if (geom == nullptr) {
      std::fprintf(stderr, "WKT read failed: %.40s\n", line.c_str());
      std::exit(2);
    }
    out.push_back(geom);
  }
  return out;
}

std::vector<GEOSGeometry *> readWkbGeoms(GeosHandle &g, const std::vector<uint8_t> &wkb,
                                         const std::vector<uint32_t> &offs) {
  std::vector<GEOSGeometry *> out;
  out.reserve(offs.size());
  size_t start = 0;
  for (size_t i = 0; i < offs.size(); i++) {
    const size_t end = offs[i];
    GEOSGeometry *geom =
        GEOSWKBReader_read_r(g.h, g.wkbReader, wkb.data() + start, end - start);
    if (geom == nullptr) {
      std::fprintf(stderr, "WKB read failed at slice %zu\n", i);
      std::exit(2);
    }
    out.push_back(geom);
    start = end;
  }
  return out;
}

void destroyAll(GeosHandle &g, const std::vector<GEOSGeometry *> &geoms) {
  for (GEOSGeometry *geom : geoms) GEOSGeom_destroy_r(g.h, geom);
}

GEOSGeometry *boxPolygon(GeosHandle &g, double minX, double minY, double maxX, double maxY) {
  GEOSCoordSequence *seq = GEOSCoordSeq_create_r(g.h, 5, 2);
  GEOSCoordSeq_setXY_r(g.h, seq, 0, minX, minY);
  GEOSCoordSeq_setXY_r(g.h, seq, 1, maxX, minY);
  GEOSCoordSeq_setXY_r(g.h, seq, 2, maxX, maxY);
  GEOSCoordSeq_setXY_r(g.h, seq, 3, minX, maxY);
  GEOSCoordSeq_setXY_r(g.h, seq, 4, minX, minY);
  GEOSGeometry *ring = GEOSGeom_createLinearRing_r(g.h, seq);
  return GEOSGeom_createPolygon_r(g.h, ring, nullptr, 0);
}

// ---- JSON out (numbers via %.17g) ----

void emitJson(const std::string &variants, int repeats, const std::string &fp,
              const char *note) {
  std::printf("{\"variants\":%s,\"repeats\":%d,\"fingerprint\":%s", variants.c_str(),
              repeats, fp.c_str());
  if (note != nullptr) std::printf(",\"note\":\"%s\"", note);
  std::printf("}\n");
}

std::string num(double v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.17g", v);
  return buf;
}

void queryCountCb(void * /*item*/, void *userdata) {
  (*static_cast<long *>(userdata))++;
}

// ---- scenarios ----

int runOverlay(GeosHandle &g, const std::string &dir, long size) {
  const auto clipWkb = readBytes(dir + "/clip720.wkb");
  const auto clip = readWkbGeoms(g, clipWkb, {static_cast<uint32_t>(clipWkb.size())});
  std::vector<uint32_t> offs = readU32Le(dir + "/squares-" + std::to_string(size) + ".offs.u32",
                                         static_cast<size_t>(size));
  auto squares = readWkbGeoms(g, readBytes(dir + "/squares-" + std::to_string(size) + ".wkb"), offs);
  const int repeats = size >= 100000 ? 2 : 3;

  long count = 0;
  double areaSum = 0.0;
  double area = 0.0;
  const double ms = bestOf(repeats, [&] {
    count = 0;
    areaSum = 0.0;
    for (GEOSGeometry *sq : squares) {
      GEOSGeometry *out = GEOSIntersection_r(g.h, clip[0], sq);
      if (out == nullptr) {
        std::fprintf(stderr, "GEOSIntersection_r failed\n");
        std::exit(2);
      }
      if (GEOSisEmpty_r(g.h, out) == 0) {
        count++;
        GEOSArea_r(g.h, out, &area);
        areaSum += area;
      }
      GEOSGeom_destroy_r(g.h, out);
    }
    if (count < 0) std::exit(2); // keep the loop observable
  });

  destroyAll(g, squares);
  destroyAll(g, clip);
  emitJson("{\"singular\":" + num(ms) + "}", repeats,
           "{\"count\":" + std::to_string(count) + ",\"areaSum\":" + num(areaSum) + "}",
           nullptr);
  return 0;
}

int runUnion(GeosHandle &g, const std::string &dir, long size) {
  if (size != 961) {
    std::fprintf(stderr, "union ladder is fixed at 961 tiles\n");
    return 2;
  }
  auto tiles = readWktGeoms(g, readLines(dir + "/tiles-961.wkt"));
  const int repeats = 3;

  double area = 0.0;
  double areaSum = 0.0;
  long count = 0;
  const std::string note =
      "includes per-repeat clone + collection build (C-API input contract)";

  const double unaryMs = bestOf(repeats, [&] {
    std::vector<GEOSGeometry *> clones;
    clones.reserve(tiles.size());
    for (GEOSGeometry *t : tiles) clones.push_back(GEOSGeom_clone_r(g.h, t));
    GEOSGeometry *col =
        GEOSGeom_createCollection_r(g.h, GEOS_MULTIPOLYGON, clones.data(), clones.size());
    GEOSGeometry *out = GEOSUnaryUnion_r(g.h, col);
    GEOSGetNumGeometries_r(g.h, out);
    count = GEOSGetNumGeometries_r(g.h, out);
    GEOSArea_r(g.h, out, &area);
    areaSum = area;
    GEOSGeom_destroy_r(g.h, out);
    GEOSGeom_destroy_r(g.h, col);
    if (count < 0) std::exit(2);
  });

  double coverageMs = -1.0;
  // GEOSCoverageUnion_r requires a VALID coverage — aligned tiles qualify.
  GEOSGeometry *probeCol = nullptr;
  {
    std::vector<GEOSGeometry *> clones;
    clones.reserve(tiles.size());
    for (GEOSGeometry *t : tiles) clones.push_back(GEOSGeom_clone_r(g.h, t));
    probeCol = GEOSGeom_createCollection_r(g.h, GEOS_MULTIPOLYGON, clones.data(), clones.size());
  }
  GEOSGeometry *probeOut = GEOSCoverageUnion_r(g.h, probeCol);
  if (probeOut != nullptr) {
    GEOSGeom_destroy_r(g.h, probeOut);
    GEOSGeom_destroy_r(g.h, probeCol);
    coverageMs = bestOf(repeats, [&] {
      std::vector<GEOSGeometry *> clones;
      clones.reserve(tiles.size());
      for (GEOSGeometry *t : tiles) clones.push_back(GEOSGeom_clone_r(g.h, t));
      GEOSGeometry *col =
          GEOSGeom_createCollection_r(g.h, GEOS_MULTIPOLYGON, clones.data(), clones.size());
      GEOSGeometry *out = GEOSCoverageUnion_r(g.h, col);
      count = GEOSGetNumGeometries_r(g.h, out);
      GEOSArea_r(g.h, out, &area);
      areaSum = area;
      GEOSGeom_destroy_r(g.h, out);
      GEOSGeom_destroy_r(g.h, col);
      if (count < 0) std::exit(2);
    });
  } else {
    GEOSGeom_destroy_r(g.h, probeCol);
  }

  destroyAll(g, tiles);
  std::string variants = "{\"unary\":" + num(unaryMs);
  if (coverageMs >= 0) variants += ",\"coverage-raw\":" + num(coverageMs);
  variants += "}";
  emitJson(variants, repeats,
           "{\"count\":" + std::to_string(count) + ",\"areaSum\":" + num(areaSum) + "}",
           note.c_str());
  return 0;
}

int runPreparedScan(GeosHandle &g, const std::string &dir, long size) {
  const auto clipWkb = readBytes(dir + "/clip720.wkb");
  const auto clip = readWkbGeoms(g, clipWkb, {static_cast<uint32_t>(clipWkb.size())});
  std::vector<uint32_t> offs =
      readU32Le(dir + "/points-" + std::to_string(size) + ".offs.u32", static_cast<size_t>(size));
  auto points = readWkbGeoms(g, readBytes(dir + "/points-" + std::to_string(size) + ".wkb"), offs);
  const int repeats = size >= 100000 ? 1 : 3;

  long hits = 0;
  const double unpreparedMs = bestOf(repeats, [&] {
    hits = 0;
    for (GEOSGeometry *p : points) {
      if (GEOSIntersects_r(g.h, clip[0], p)) hits++;
    }
    if (hits < 0) std::exit(2);
  });

  // Prepare once OUTSIDE the timed region — symmetric with bun-geos and
  // Shapely.
  const GEOSPreparedGeometry *prep = GEOSPrepare_r(g.h, clip[0]);
  const double preparedMs = bestOf(repeats, [&] {
    hits = 0;
    for (GEOSGeometry *p : points) {
      if (GEOSPreparedIntersects_r(g.h, prep, p)) hits++;
    }
    if (hits < 0) std::exit(2);
  });
  GEOSPreparedGeom_destroy_r(g.h, prep);

  // Captured hits from the prepared pass (identical to unprepared).
  destroyAll(g, points);
  destroyAll(g, clip);
  emitJson("{\"unprepared\":" + num(unpreparedMs) + ",\"prepared\":" + num(preparedMs) + "}",
           repeats, "{\"areaSum\":null,\"hits\":" + std::to_string(hits) + "}", nullptr);
  return 0;
}

int runStrtree(GeosHandle &g, const std::string &dir, long size) {
  const auto boxLines = readLines(dir + "/strtree-boxes.tsv");
  const auto queryLines = readLines(dir + "/strtree-queries.tsv");
  if (static_cast<long>(boxLines.size()) != size) {
    std::fprintf(stderr, "box count %zu != size %ld\n", boxLines.size(), size);
    return 2;
  }
  std::vector<GEOSGeometry *> boxes;
  boxes.reserve(boxLines.size());
  for (const auto &line : boxLines) {
    double v[4];
    if (std::sscanf(line.c_str(), "%lf %lf %lf %lf", &v[0], &v[1], &v[2], &v[3]) != 4) {
      std::fprintf(stderr, "bad box line: %.40s\n", line.c_str());
      return 2;
    }
    boxes.push_back(boxPolygon(g, v[0], v[1], v[2], v[3]));
  }
  std::vector<GEOSGeometry *> queries;
  queries.reserve(queryLines.size());
  for (const auto &line : queryLines) {
    double v[4];
    if (std::sscanf(line.c_str(), "%lf %lf %lf %lf", &v[0], &v[1], &v[2], &v[3]) != 4) {
      std::fprintf(stderr, "bad query line: %.40s\n", line.c_str());
      return 2;
    }
    queries.push_back(boxPolygon(g, v[0], v[1], v[2], v[3]));
  }

  long hits = 0;
  // "build" = create + insert + build-forcing first query (the C API has no
  // separate public build step; shapely/jsts/bun-geos do — noted in docs).
  const double buildMs = bestOf(3, [&] {
    GEOSSTRtree *tree = GEOSSTRtree_create_r(g.h, 10);
    for (GEOSGeometry *b : boxes) {
      GEOSSTRtree_insert_r(g.h, tree, b, b); // item = geometry pointer
    }
    hits = 0;
    GEOSSTRtree_query_r(g.h, tree, queries[0], queryCountCb, &hits);
    GEOSSTRtree_destroy_r(g.h, tree);
    if (hits < 0) std::exit(2);
  });

  GEOSSTRtree *tree = GEOSSTRtree_create_r(g.h, 10);
  for (GEOSGeometry *b : boxes) GEOSSTRtree_insert_r(g.h, tree, b, b);
  const double queryMs = bestOf(5, [&] {
    hits = 0;
    for (GEOSGeometry *q : queries) {
      GEOSSTRtree_query_r(g.h, tree, q, queryCountCb, &hits);
    }
    if (hits < 0) std::exit(2);
  });
  GEOSSTRtree_destroy_r(g.h, tree);

  destroyAll(g, queries);
  destroyAll(g, boxes);
  emitJson(
      "{\"build\":" + num(buildMs) + ",\"query\":" + num(queryMs) + "}", 5,
      "{\"areaSum\":null,\"hits\":" + std::to_string(hits) + "}",
      "build includes the build-forcing first query (C API has no explicit build)");
  return 0;
}

int runIngest(GeosHandle &g, const std::string &dir, long size) {
  const auto wktLines = readLines(dir + "/squares-" + std::to_string(size) + ".wkt");
  std::vector<uint32_t> offs =
      readU32Le(dir + "/squares-" + std::to_string(size) + ".offs.u32", static_cast<size_t>(size));
  const auto wkb = readBytes(dir + "/squares-" + std::to_string(size) + ".wkb");
  const int repeats = 2;

  const double wktMs = bestOf(repeats, [&] {
    long n = 0;
    for (const auto &line : wktLines) {
      GEOSGeometry *geom = GEOSWKTReader_read_r(g.h, g.wktReader, line.c_str());
      GEOSGeom_destroy_r(g.h, geom);
      n++;
    }
    if (n < 0) std::exit(2);
  });

  const double wkbMs = bestOf(repeats, [&] {
    long n = 0;
    size_t start = 0;
    for (size_t i = 0; i < offs.size(); i++) {
      GEOSGeometry *geom =
          GEOSWKBReader_read_r(g.h, g.wkbReader, wkb.data() + start, offs[i] - start);
      GEOSGeom_destroy_r(g.h, geom);
      start = offs[i];
      n++;
    }
    if (n < 0) std::exit(2);
  });

  emitJson("{\"wkt\":" + num(wktMs) + ",\"wkb\":" + num(wkbMs) + "}", repeats,
           "{\"count\":" + std::to_string(size) + ",\"areaSum\":null}", nullptr);
  return 0;
}

int runMakeValid(GeosHandle &g, const std::string &dir, long size) {
  auto bowties = readWktGeoms(g, readLines(dir + "/bowties-" + std::to_string(size) + ".wkt"));
  long count = 0;
  double areaSum = 0.0;
  double area = 0.0;
  const int repeats = 3;
  const double ms = bestOf(repeats, [&] {
    count = 0;
    areaSum = 0.0;
    for (GEOSGeometry *b : bowties) {
      GEOSGeometry *f = GEOSMakeValid_r(g.h, b);
      if (GEOSisValid_r(g.h, f) == 1) count++;
      GEOSArea_r(g.h, f, &area);
      areaSum += area;
      GEOSGeom_destroy_r(g.h, f);
    }
    if (count < 0) std::exit(2);
  });
  destroyAll(g, bowties);
  emitJson("{\"makevalid\":" + num(ms) + "}", repeats,
           "{\"count\":" + std::to_string(count) + ",\"areaSum\":" + num(areaSum) + "}", nullptr);
  return 0;
}

int runBuffer(GeosHandle &g, const std::string &dir, long size) {
  std::vector<uint32_t> offs =
      readU32Le(dir + "/wobbles-" + std::to_string(size) + ".offs.u32", static_cast<size_t>(size));
  auto wobbles = readWkbGeoms(g, readBytes(dir + "/wobbles-" + std::to_string(size) + ".wkb"), offs);
  long count = 0;
  double areaSum = 0.0;
  double area = 0.0;
  const int repeats = 3;
  const double ms = bestOf(repeats, [&] {
    count = 0;
    areaSum = 0.0;
    for (GEOSGeometry *w : wobbles) {
      GEOSGeometry *b = GEOSBuffer_r(g.h, w, 2.0, 8);
      count++;
      GEOSArea_r(g.h, b, &area);
      areaSum += area;
      GEOSGeom_destroy_r(g.h, b);
    }
    if (count < 0) std::exit(2);
  });
  destroyAll(g, wobbles);
  emitJson("{\"buffer\":" + num(ms) + "}", repeats,
           "{\"count\":" + std::to_string(count) + ",\"areaSum\":" + num(areaSum) + "}", nullptr);
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 4) {
    std::fprintf(stderr, "usage: baseline <scenario> <size> <workloadDir>\n");
    return 2;
  }
  GeosHandle g;
  const std::string version = GEOSversion();
  std::fprintf(stderr, "geos %s\n", version.c_str());

  const std::string scenario = argv[1];
  const long size = std::strtol(argv[2], nullptr, 10);
  const std::string dir = argv[3];

  if (scenario == "overlay") return runOverlay(g, dir, size);
  if (scenario == "union") return runUnion(g, dir, size);
  if (scenario == "prepared-scan") return runPreparedScan(g, dir, size);
  if (scenario == "strtree") return runStrtree(g, dir, size);
  if (scenario == "ingest") return runIngest(g, dir, size);
  if (scenario == "makevalid") return runMakeValid(g, dir, size);
  if (scenario == "buffer") return runBuffer(g, dir, size);
  std::fprintf(stderr, "unknown scenario: %s\n", scenario.c_str());
  return 2;
}
