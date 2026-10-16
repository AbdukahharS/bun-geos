/**
 * The install-matrix overlay: the exact script the clean-machine gate runs
 * after `bun add @shzd/bun-geos` (ROADMAP Phase 4 exit criterion). Lives in
 * the repo; the CI job copies it into a fresh temp project so it exercises
 * the INSTALLED package from node_modules, never the checkout.
 *
 * Also proves the documented quickstart verbatim (README "Quickstart").
 */

import { Geos } from "@shzd/bun-geos";

using geos = new Geos();

const parcels = [
  geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))"),
  geos.fromWKT("POLYGON ((2 2, 6 2, 6 6, 2 6, 2 2))"),
];
const overlap = geos.intersection(parcels[0]!, parcels[1]!);
const area = geos.area(overlap);

// Overlap of the two squares = the 2×2 square from (2,2) to (4,4).
if (area !== 4) {
  throw new Error(`install-overlay: expected area 4, got ${area}`);
}
if (!/^3\.14\./.test(geos.version)) {
  throw new Error(`install-overlay: expected GEOS 3.14.x, got ${geos.version}`);
}

const wkb = geos.toWKB(overlap);
using back = geos.fromWKB(wkb);
if (!geos.equalsIdentical(overlap, back)) {
  throw new Error("install-overlay: WKB roundtrip changed the geometry");
}

for (const p of parcels) p.dispose();
console.log(`install-overlay OK — GEOS ${geos.version}, intersection area ${area}`);
