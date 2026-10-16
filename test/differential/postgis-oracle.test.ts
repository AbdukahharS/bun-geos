/**
 * PostGIS oracle (Phase 2 gate, testing.md §5): cross-checks overlay and
 * predicate results against a live PostGIS — the strongest different-engine
 * oracle for planar geometry semantics.
 *
 * SKIPPED unless `BUN_GEOS_PG_URI` is set, e.g.:
 *
 *   docker run --rm -d --name bun-geos-pg -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgis/postgis:17-3.5
 *   BUN_GEOS_PG_URI='postgres://postgres:postgres@localhost:5432/postgres' \
 *     bun test test/differential/postgis-oracle.test.ts
 *
 * CI wires this as its own job (operations/testing.md §5); local `bun test`
 * passes without Postgres running.
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";

const URI = process.env.BUN_GEOS_PG_URI;
const describePg = URI ? describe : describe.skip;

if (!URI) {
  it("postgis oracle: SKIPPED (set BUN_GEOS_PG_URI to enable — see file header)", () => {
    expect(true).toBe(true);
  });
}

describePg("PostGIS oracle", () => {
  it("WKB ingest matches ST_AsBinary; overlays agree with ST_Intersection/ST_Union", async () => {
    using geos = new Geos();
    const { SQL } = await import("bun");
    const sql = new SQL(URI!);

    const CASES = [
      ["POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))", "POLYGON ((2 2, 6 2, 6 6, 2 6, 2 2))"],
      ["POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))", "POLYGON ((1 1, 3 3, 3 1, 1 3, 1 1))"], // bowties
      ["LINESTRING (0 0, 4 4)", "LINESTRING (0 4, 4 0)"],
      [
        "MULTIPOLYGON (((0 0, 2 0, 2 2, 0 2, 0 0)), ((3 3, 5 3, 5 5, 3 5, 3 3)))",
        "POLYGON ((1 1, 4 1, 4 4, 1 4, 1 1))",
      ],
    ] as const;

    let checked = 0;
    for (const [wktA, wktB] of CASES) {
      const rows = await sql`
        SELECT
          ST_AsBinary(ST_GeomFromText(${wktA})) AS a_wkb,
          ST_AsBinary(ST_GeomFromText(${wktB})) AS b_wkb,
          ST_AsBinary(ST_Intersection(ST_GeomFromText(${wktA}), ST_GeomFromText(${wktB}))) AS inter,
          ST_AsBinary(ST_Union(ST_GeomFromText(${wktA}), ST_GeomFromText(${wktB}))) AS uni,
          ST_IsValid(ST_GeomFromText(${wktA})) AS a_valid
      `;
      const row = rows[0]!;
      using a = geos.fromWKB(row.a_wkb as Uint8Array);
      using b = geos.fromWKB(row.b_wkb as Uint8Array);

      // 1. our WKT parse of the same text equals PostGIS's geometry (WKB roundtrip)
      using localA = geos.fromWKT(wktA);
      using localB = geos.fromWKT(wktB);
      expect(geos.equals(a, localA)).toBe(true);
      expect(geos.equals(b, localB)).toBe(true);

      // 2. validity agreement
      expect(geos.isValid(a)).toBe(Boolean(row.a_valid));

      // 3. overlay agreement (topological equality — vertex order may differ)
      using interPg = geos.fromWKB(row.inter as Uint8Array);
      using uniPg = geos.fromWKB(row.uni as Uint8Array);
      using interUs = geos.intersection(a, b);
      using uniUs = geos.union(a, b);
      const sameInter =
        (geos.isEmpty(interPg) && geos.isEmpty(interUs)) || geos.equals(interPg, interUs);
      const sameUnion = geos.equals(uniPg, uniUs);
      if (!sameInter) {
        expect(`intersection(${wktA}, ${wktB})`).toBe("matched");
      }
      expect(sameInter).toBe(true);
      expect(sameUnion).toBe(true);
      checked += 4;
    }

    await sql.end();
    expect(checked).toBeGreaterThanOrEqual(16);
  }, 60_000);
});
