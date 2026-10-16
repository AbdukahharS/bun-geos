/**
 * Shared seeded data generators for the benchmark suites and competitor
 * adapters (D25): every library measures identical inputs (WKT strings /
 * coordinate arrays — expressible in every engine). Seeded mulberry32 (the
 * property-test PRNG) — runs are reproducible.
 */

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
