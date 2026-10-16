/**
 * Platform smoke test (Phase 4 gate, testing.md §5 "per-platform native
 * smoke tests on runners"). Loads the library from a STAGED package tree
 * (or the dev tree) and exercises the load-bearing surface end to end:
 *
 *   loader → version assert → overlay known answer → flat-buffer build →
 *   makeValid → WKB roundtrip → prepared mask → strtree → error capture →
 *   FFI value roundtrips → worker preload.
 *
 * The point is to prove the artifacts (and the loader's resolution of them)
 * on the same runner that built them, BEFORE anything is published. Every
 * failure is a release blocker.
 *
 * Usage: bun run scripts/platform-smoke.ts
 *   BUN_GEOS_PACKAGE_DIR=<dir>  load natives from this staged package
 *                               (default: the dev tree / resolved package)
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Geos, GeosError } from "../index.ts";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

console.log(
  `platform-smoke: natives from ${process.env.BUN_GEOS_PACKAGE_DIR ?? "<resolved/dev tree>"}`,
);

// 1. Loader + version assert (D5) — openLibrary runs inside `new Geos()`.
{
  using geos = new Geos();
  check("loader + GEOS 3.14 version assert", () => {
    assert(/^3\.14\./.test(geos.version), `version=${geos.version}`);
  });

  // 2. Overlay known answer, exact in floats: box corner (2,2) lies on the
  // triangle's hypotenuse (x+y=4) → intersection is the full box, area 1.
  check("overlay known answer (boundary-touching)", () => {
    const tri = geos.fromWKT("POLYGON ((1 1, 3 1, 1 3, 1 1))");
    const box = geos.fromWKT("POLYGON ((1 1, 2 1, 2 2, 1 2, 1 1))");
    try {
      const inter = geos.intersection(tri, box);
      assert(geos.area(inter) === 1, `area=${geos.area(inter)}`);
    } finally {
      tri.dispose();
      box.dispose();
    }
  });

  // 3. Flat-buffer construction (D9: the canonical currency) + WKB
  // roundtrip + FFI f64 boundary (2**53 survives the boundary exactly).
  check("flat-buffer build + WKB roundtrip + f64 boundary", () => {
    const coords = new Float64Array([0, 0, 2, 0, 2, 2, 0, 2, 0, 0]);
    const g = geos.fromCoords({ coords, n: 5, hasZ: false, hasM: false }, "linestring");
    try {
      assert(
        geos.toWKT(g) === "LINESTRING (0 0, 2 0, 2 2, 0 2, 0 0)",
        `flat build: ${geos.toWKT(g)}`,
      );
      const wkb = geos.toWKB(g);
      using back = geos.fromWKB(wkb);
      assert(geos.equalsIdentical(g, back), "WKB roundtrip changed the geometry");
      const big = geos.point(2 ** 53, 1);
      try {
        const wktBig = geos.toWKT(big);
        using backBig = geos.fromWKB(geos.toWKB(big));
        assert(
          geos.toWKT(backBig) === wktBig,
          `2**53 boundary: ${geos.toWKT(backBig)} vs ${wktBig}`,
        );
      } finally {
        big.dispose();
      }
    } finally {
      g.dispose();
    }
  });

  // 4. Repair suite (the 3.14 differentiator).
  check("makeValid (bowtie → valid)", () => {
    const bowtie = geos.fromWKT("POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))");
    try {
      using fixed = geos.makeValid(bowtie, { method: "linework" });
      assert(geos.isValid(fixed), "makeValid output invalid");
    } finally {
      bowtie.dispose();
    }
  });

  // 5. Prepared predicate batch mask + STRtree (the Phase 2 surface, shim
  // loops under the hood).
  check("prepared mask + strtree query", () => {
    const poly = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    const pairs: readonly [number, number][] = [
      [1, 1],
      [5, 5],
      [20, 20],
    ];
    const pts = pairs.map(([x, y]) => geos.point(x, y));
    try {
      using prep = poly.prepare();
      const mask = prep.intersectsAll(pts);
      assert(mask[0] === 1 && mask[1] === 1 && mask[2] === 0, `mask=${[...mask]}`);
      const tree = geos.strtree(pts);
      const hits = tree.query(poly);
      assert(hits.length === 2, `tree hits=${hits.length}`);
      tree.dispose();
    } finally {
      for (const p of pts) p.dispose();
      poly.dispose();
    }
  });

  // 6. Error capture end to end: GEOS's message must arrive in the thrown
  // GeosError (the D4 shim handler, through the platform's dlopen).
  check("error capture (malformed WKT → GeosError with GEOS message)", () => {
    let caught: unknown;
    try {
      geos.fromWKT("POLYGON ((1 1, 3 1))");
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof GeosError, `expected GeosError, got ${String(caught)}`);
    const msg = (caught as GeosError).message;
    assert(/parse|expected|ring/i.test(msg), `message lacks GEOS detail: ${msg}`);
  });
}

// 7. Worker preload (the #40972 regression net): spawn a Worker that
// imports the package and computes an area — proves the dlopen + per-worker
// context story on this platform.
{
  const dir = mkdtempSync(join(tmpdir(), "geos-smoke-worker-"));
  const workerFile = join(dir, "worker.ts");
  // A file URL, not a raw path: backslashes in a Windows import specifier
  // would be parsed as escapes.
  const indexUrl = JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "index.ts")).href);
  writeFileSync(
    workerFile,
    [
      `import { Geos } from ${indexUrl};`,
      `using geos = new Geos();`,
      `const g = geos.fromWKT("POLYGON ((0 0, 4 0, 4 2, 0 2, 0 0))");`,
      `const a = geos.area(g);`,
      `if (a !== 8) throw new Error("worker area " + a);`,
      `postMessage("ok");`,
      `g.dispose();`,
    ].join("\n"),
  );
  const result = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerFile);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker preload timed out (10s)"));
    }, 10_000);
    worker.onmessage = (msg: MessageEvent) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(String(msg.data));
    };
    worker.onerror = (err: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`worker error: ${err.message}`));
    };
  });
  check("worker preload (per-worker Geos context)", () => {
    assert(result === "ok", `worker returned ${result}`);
  });
}

console.log(
  failures === 0 ? "platform-smoke: ALL CLEAN" : `platform-smoke: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
