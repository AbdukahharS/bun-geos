/**
 * Unit: context lifecycle, disposal discipline, arena semantics, error
 * model, and the structural guards (D3/D10/D13, memory.md pitfall table).
 */
import { describe, expect, it } from "bun:test";
import { Arena, Geos, GeosError, GeoType } from "../../src/index.ts";

describe("Geos lifecycle", () => {
  it("reports the strict GEOS 3.14 version (D5)", () => {
    using geos = new Geos();
    expect(geos.version).toMatch(/^3\.14\./);
  });

  it("double dispose is a no-op", () => {
    const geos = new Geos();
    geos.dispose();
    geos.dispose();
  });

  it("use after dispose throws TypeError", () => {
    const geos = new Geos();
    geos.dispose();
    expect(() => geos.fromWKT("POINT (0 0)")).toThrow(TypeError);
  });
});

describe("Geometry disposal discipline (D10)", () => {
  it("using-dispose returns liveGeoms to zero", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const b = geos.fromWKT("POLYGON ((1 0, 3 0, 3 2, 1 2, 1 0))");
    expect(geos.stats.liveGeoms).toBe(2);
    using _kept = a;
    b.dispose();
    expect(geos.stats.liveGeoms).toBe(1);
  });

  it("use-after-dispose throws TypeError (pitfall table)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (1 1)");
    g.dispose();
    expect(() => geos.area(g)).toThrow(TypeError);
  });

  it("foreign-context use throws TypeError (same-context rule)", () => {
    using geos1 = new Geos();
    using geos2 = new Geos();
    const g1 = geos1.fromWKT("POINT (0 0)");
    expect(() => geos2.area(g1)).toThrow(TypeError);
    expect(() => geos2.fromWKT("POINT (0 0)").ptr).toBeDefined();
  });

  it("borrowed views (rings, sub-geometries) dispose as no-ops", () => {
    using geos = new Geos();
    const poly = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const ring = poly.geos.exteriorRing(poly);
    expect(ring.owned).toBe(false);
    const before = geos.stats.liveGeoms;
    ring.dispose();
    expect(geos.stats.liveGeoms).toBe(before);
    // Borrowed view remains readable while the parent is alive.
    expect(poly.geos.geomType(ring)).toBe("LinearRing");
  });
});

describe("Arena (memory.md §3)", () => {
  it("one destroy_many crossing frees everything registered", () => {
    using geos = new Geos();
    let inside: number;
    {
      using arena = geos.arena();
      for (let i = 0; i < 100; i++) {
        geos.fromWKT(`POINT (${i} ${i})`);
      }
      inside = geos.stats.liveGeoms;
      expect(inside).toBeGreaterThanOrEqual(100);
      expect(arena.size).toBe(inside);
    }
    expect(geos.stats.liveGeoms).toBe(0);
  });

  it("individual dispose inside an arena removes it from the bulk teardown", () => {
    using geos = new Geos();
    {
      using arena = geos.arena();
      const g = geos.fromWKT("POINT (1 1)");
      expect(arena.size).toBe(1);
      g.dispose();
      expect(arena.size).toBe(0);
      geos.fromWKT("POINT (2 2)");
    }
    expect(geos.stats.liveGeoms).toBe(0);
  });

  it("nested arenas dispose independently", () => {
    using geos = new Geos();
    let outerSize: number;
    {
      using outer = geos.arena();
      geos.fromWKT("POINT (0 0)");
      {
        using _inner = geos.arena();
        geos.fromWKT("POINT (1 1)");
        geos.fromWKT("POINT (2 2)");
        expect(geos.stats.liveGeoms).toBe(3);
      }
      expect(geos.stats.liveGeoms).toBe(1);
      geos.fromWKT("POINT (3 3)");
      outerSize = outer.size;
    }
    expect(outerSize).toBe(2);
    expect(geos.stats.liveGeoms).toBe(0);
  });

  it("Geos dispose closes open arenas and frees remaining geometries", () => {
    const geos = new Geos();
    const _arena = geos.arena();
    geos.fromWKT("POINT (0 0)");
    geos.fromWKT("POINT (1 1)");
    expect(geos.stats.liveGeoms).toBe(2);
    geos.dispose();
    expect(geos.stats.liveGeoms).toBe(0);
  });
});

describe("Error model (D13)", () => {
  it("malformed WKT throws GeosError with the GEOS message", () => {
    using geos = new Geos();
    try {
      geos.fromWKT("POLYGON ((");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GeosError);
      const ge = err as GeosError;
      expect(ge.op).toBe("GEOSWKTReader_read_r");
      expect(ge.geosMessage).toContain("ParseException");
    }
  });

  it("error state does not poison later operations (spike soak semantics)", () => {
    using geos = new Geos();
    for (let i = 0; i < 50; i++) {
      expect(() => geos.fromWKT("LINESTRING (")).toThrow(GeosError);
    }
    const ok = geos.fromWKT("POINT (5 5)");
    expect(geos.area(ok)).toBe(0);
  });

  it("data validation errors carry ring/vertex detail", () => {
    using geos = new Geos();
    try {
      geos.fromPolygonal({
        coords: new Float64Array([0, 0, 1, 1]),
        ringOffsets: Int32Array.of(2),
        partOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      });
      throw new Error("should have thrown");
    } catch (err) {
      const ge = err as GeosError;
      expect(ge.detail?.ring).toBe(0);
      expect(ge.message).toContain("need ≥ 3");
    }
  });

  it("invalid DE-9IM pattern surfaces the GEOS message", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POINT (0 0)");
    const b = geos.fromWKT("POINT (1 1)");
    expect(() => geos.relatesPattern(a, b, "XX")).toThrow(GeosError);
  });
});

describe("stats (memory.md §5)", () => {
  it("tracks live and peak geometry counts", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POINT (0 0)");
    const b = geos.fromWKT("POINT (1 1)");
    void a;
    void b;
    expect(geos.stats.liveGeoms).toBe(2);
    expect(geos.stats.peakLiveGeoms).toBe(2);
    expect(geos.stats.heapBytesApprox).toBeGreaterThan(0);
    b.dispose();
    expect(geos.stats.peakLiveGeoms).toBe(2);
    expect(geos.stats.liveGeoms).toBe(1);
  });
});

describe("collections and transfer semantics", () => {
  it("fromParts clones by default — caller's geometries stay alive", () => {
    using geos = new Geos();
    const p1 = geos.fromWKT("POINT (0 0)");
    const p2 = geos.fromWKT("POINT (1 1)");
    const col = geos.fromParts("multipoint", [p1, p2]);
    expect(col.geos.typeId(col)).toBe(GeoType.MultiPoint);
    expect(geos.numGeometries(col)).toBe(2);
    // Originals still usable after the collection was built:
    expect(geos.toWKT(p1)).toBe("POINT (0 0)");
    expect(geos.stats.liveGeoms).toBe(3);
  });

  it("fromParts with transfer:true renounces the caller's wrappers", () => {
    using geos = new Geos();
    const p1 = geos.fromWKT("POINT (0 0)");
    const p2 = geos.fromWKT("POINT (1 1)");
    const col = geos.fromParts("multipoint", [p1, p2], { transfer: true });
    expect(geos.numGeometries(col)).toBe(2);
    expect(p1.disposed).toBe(true);
    expect(p2.disposed).toBe(true);
    expect(() => geos.area(p1)).toThrow(TypeError);
  });
});

describe("Arena class identity", () => {
  it("arena() returns an Arena implementing Disposable", () => {
    using geos = new Geos();
    using arena = geos.arena();
    expect(arena).toBeInstanceOf(Arena);
    expect(arena.size).toBe(0);
  });
});
