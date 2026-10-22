/**
 * Shared seeded data generators for the benchmark suites and competitor
 * adapters (D25): every library measures identical inputs (WKT strings /
 * coordinate arrays — expressible in every engine). Seeded mulberry32 (the
 * property-test PRNG) — runs are reproducible.
 *
 * Coordinate-level twins (`*Rings`, `*Coords`) produce the SAME doubles the
 * WKT renderers emit (the `.toFixed(4)` sites round identically), so WKT text,
 * WKB bytes, and raw coordinate arrays are one canonical workload. The
 * competitor orchestrator materializes WKT/WKB files from these generators
 * for the subprocess engines (Shapely, the GEOS C++ baseline) — a single
 * source of truth for every boundary.
 */

/** Closed exterior ring as [x, y] pairs — the coords currency for adapters. */
export type Ring = Array<[number, number]>;

/** Axis-aligned envelope (the STRtree workload's items and queries). */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** n 5-vertex squares on a grid, deterministic — the overlay/mask workload. */
export function squareGrid(n: number): string[] {
  const wkt: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 320) * 0.2;
    const y = Math.floor(i / 320) * 0.2;
    wkt.push(
      `POLYGON ((${x} ${y}, ${x + 0.15} ${y}, ${x + 0.15} ${y + 0.15}, ${x} ${y + 0.15}, ${x} ${y}))`,
    );
  }
  return wkt;
}

/** n bowtie (self-crossing) polygons — the repair workload. */
export function bowties(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`POLYGON ((${i} 0, ${i + 2} 2, ${i + 2} 0, ${i} 2, ${i} 0))`);
  }
  return out;
}

/** n points on a ring (radius ≈ 40–48) — the prepared-scan workload. */
export function pointRing(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 40 + 8 * Math.sin(a * 31);
    out.push(`POINT (${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)})`);
  }
  return out;
}

/** Wobbly closed polygon with `segs` vertices, radius ≈ 50. */
export function wobble(segs: number): string {
  const pts: string[] = [];
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    pts.push(
      `${(Math.cos(a) * 50 * (1 + 0.05 * Math.sin(a * 9))).toFixed(4)} ${(Math.sin(a) * 50 * (1 + 0.05 * Math.sin(a * 9))).toFixed(4)}`,
    );
  }
  return `POLYGON ((${pts.join(",")}, ${pts[0]!}))`;
}

/** Aligned n×m tiling — the unionAll ladder workload. */
export function tiles(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push(`POLYGON ((${i} ${j}, ${i + 1} ${j}, ${i + 1} ${j + 1}, ${i} ${j + 1}, ${i} ${j}))`);
    }
  }
  return out;
}

/* ------------------------- coordinate-level twins (same doubles as above) */

function closed(pts: Array<[number, number]>): Ring {
  const ring = pts.slice() as Ring;
  ring.push([pts[0]![0]!, pts[0]![1]!]);
  return ring;
}

/** Coordinate twin of `squareGrid` — identical doubles, closed 5-point rings. */
export function squareGridRings(n: number): Ring[] {
  const rings: Ring[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i % 320) * 0.2;
    const y = Math.floor(i / 320) * 0.2;
    rings.push(
      closed([
        [x, y],
        [x + 0.15, y],
        [x + 0.15, y + 0.15],
        [x, y + 0.15],
      ]),
    );
  }
  return rings;
}

/** Coordinate twin of `tiles` — n×n closed unit squares. */
export function tilesRings(n: number): Ring[] {
  const rings: Ring[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      rings.push(
        closed([
          [i, j],
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1],
        ]),
      );
    }
  }
  return rings;
}

/** Coordinate twin of `bowties` — n self-crossing rings. */
export function bowtieRings(n: number): Ring[] {
  const rings: Ring[] = [];
  for (let i = 0; i < n; i++) {
    rings.push(
      closed([
        [i, 0],
        [i + 2, 2],
        [i + 2, 0],
        [i, 2],
      ]),
    );
  }
  return rings;
}

/**
 * Coordinate twin of `pointRing` — the doubles the `.toFixed(4)` WKT text
 * parses back to (4-decimal rounding applied here, not just at render).
 */
export function pointRingCoords(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 40 + 8 * Math.sin(a * 31);
    out.push([Number((Math.cos(a) * r).toFixed(4)), Number((Math.sin(a) * r).toFixed(4))]);
  }
  return out;
}

/** Coordinate twin of `wobble` — OPEN ring, same 4-decimal-rounded doubles. */
export function wobbleRing(segs: number): Ring {
  const pts: Ring = [];
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    const f = 50 * (1 + 0.05 * Math.sin(a * 9));
    pts.push([Number((Math.cos(a) * f).toFixed(4)), Number((Math.sin(a) * f).toFixed(4))]);
  }
  return pts;
}

/** `count` translated copies of `wobble(segs)` — distinct inputs, same shape (the buffer workload). */
export function wobbleRingsTranslated(count: number, segs: number): Ring[] {
  const base = wobbleRing(segs);
  const rings: Ring[] = [];
  for (let i = 0; i < count; i++) {
    rings.push(base.map(([x, y]) => [x + i * 0.01, y + i * 0.01] as [number, number]));
  }
  return rings;
}

/** Coordinate twin of the STRtree workload: `m` grid boxes, `q` big query windows. */
export function strtreeBoxes(m: number, q: number): { boxes: Box[]; queries: Box[] } {
  const boxes: Box[] = [];
  for (let i = 0; i < m; i++) {
    const x = (i % 316) * 0.316;
    const y = Math.floor(i / 316) * 0.316;
    boxes.push({ minX: x, minY: y, maxX: x + 0.2, maxY: y + 0.2 });
  }
  const queries: Box[] = [];
  for (let i = 0; i < q; i++) {
    const qx = i % 90;
    const qy = i % 87;
    queries.push({ minX: qx, minY: qy, maxX: qx + 5, maxY: qy + 5 });
  }
  return { boxes, queries };
}

/** Render a closed ring as WKT body text ("x y, x y, …") using shortest-repr doubles. */
export function ringToWktBody(ring: Ring): string {
  return ring.map(([x, y]) => `${x} ${y}`).join(",");
}

/** Render a ring as a POLYGON WKT (ring must be closed). */
export function ringToPolygonWkt(ring: Ring): string {
  return `POLYGON ((${ringToWktBody(ring)}))`;
}
