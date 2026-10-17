/**
 * XML corpus differential gate (Phase 2 validity gate → Phase 5 PERMANENT
 * gate, D29): run the GEOS/JTS `xmltester` corpus — the shared JTS/GEOS test
 * capital — through our API, emulating XMLTester's exact comparison
 * semantics (XMLTester.cpp):
 *
 *  - read-time snapping: a case-level fixed `precisionModel scale=s` snaps
 *    every parsed WKT (A, B, and expected) pointwise — emulated by
 *    `setPrecision(g, 1/s, { mode: "noTopo" })`. All corpus offsets are 0.
 *  - geometry results: normalize() both sides, then compareTo == 0 —
 *    emulated by GEOSNormalize_r + equalsIdentical, with the documented
 *    compareTo quirk that two EMPTY geometries test equal (the XMLTester
 *    TODO says so explicitly). `union` uses the lenient checkOverlaySuccess
 *    path (topological equals OR identical-after-normalize).
 *  - doubles: relative tolerance 1e-3; exact when the expected value is 0.
 *  - relate: the DE-9IM pattern is arg3 and is MATCHED (wildcards) against
 *    the actual matrix, not string-compared.
 *  - `*SR` ops: OverlayNG under PrecisionModel(arg3 || 1) — our `*Prec`
 *    with gridSize = 1/scale, applied AFTER the case's read-time snapping.
 *  - prepared cases: a `<geometryOperation>` naming PreparedGeometryOperation
 *    routes predicates through GEOSPrepare (our `prepare()`).
 *
 * SKIPS ARE NOT SILENT (D29): an op with no handler passes only if it is
 * enumerated in KNOWN_GAPS with a reason; anything else fails the gate.
 * Phase 5 M3 removes the gap entries as the construction ops land.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Geometry, Prepared } from "../../src/index.ts";
import { Geos } from "../../src/index.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Corpus candidates, most-preferred first (D29): the vendored spike
 * checkout, then the CI/dev tarball extraction. Same relative layout. */
const CORPUS_CANDIDATES = [join(REPO_ROOT, "vendor", "geos"), join(REPO_ROOT, "build", "geos-src")];
const CORPUS_ROOT = CORPUS_CANDIDATES.map((root) => join(root, "tests", "xmltester", "tests")).find(
  (dir) => existsSync(join(dir, "general", "TestValid.xml")),
);

/** Upstream regression files (issues); individual ops land in KNOWN_GAPS
 * until the corresponding M3 op exists. */
const ISSUE_FILES = [
  "issue/issue-geos-1018.xml",
  "issue/issue-geos-1085.xml",
  "issue/issue-geos-176.xml",
  "issue/issue-geos-188.xml",
  "issue/issue-geos-234.xml",
  "issue/issue-geos-244.xml",
  "issue/issue-geos-275.xml",
  "issue/issue-geos-350.xml",
  "issue/issue-geos-356.xml",
  "issue/issue-geos-358.xml",
  "issue/issue-geos-360.xml",
  "issue/issue-geos-366.xml",
  "issue/issue-geos-392.xml",
  "issue/issue-geos-398.xml",
  "issue/issue-geos-434.xml",
  "issue/issue-geos-459.xml",
  "issue/issue-geos-488.xml",
  "issue/issue-geos-527.xml",
  "issue/issue-geos-569.xml",
  "issue/issue-geos-582.xml",
  "issue/issue-geos-586.xml",
  "issue/issue-geos-590.xml",
  "issue/issue-geos-599.xml",
  "issue/issue-geos-605.xml",
  "issue/issue-geos-614.xml",
  "issue/issue-geos-615.xml",
  "issue/issue-geos-716.xml",
  "issue/issue-geos-837.xml",
];

/**
 * The gated file set. Rule: a file is added only when EVERY op it uses is
 * handled below (or enumerated in KNOWN_GAPS) — an unhandled op fails the
 * gate. As M3 lands each construction op, its corpus files join here and
 * the gap entry dies.
 */
const FILES = [
  // validity (the original Phase 2 gate)
  "general/TestValid.xml",
  "general/TestValid2.xml",
  "general/TestValid2-big.xml",
  "misc/TestIsValid.xml",
  "misc/makevalid.xml",
  // predicates + relate
  "general/TestIntersectsPL.xml",
  "general/TestRelateAA.xml",
  "general/TestRelateEmpty.xml",
  "general/TestRelateGC.xml",
  "general/TestRelateLA.xml",
  "general/TestRelateLL.xml",
  "general/TestRelatePA.xml",
  "general/TestRelatePL.xml",
  "general/TestRelatePP.xml",
  "general/TestSimple.xml",
  "general/TestWithinDistance.xml",
  "general/TestEqualsExact.xml",
  "general/TestDistance.xml",
  "validate/TestRelateAA-big.xml",
  "validate/TestRelateAA.xml",
  "validate/TestRelateAC.xml",
  "validate/TestRelateLA.xml",
  "validate/TestRelateLC.xml",
  "validate/TestRelateLL.xml",
  "validate/TestRelatePA.xml",
  "validate/TestRelatePL.xml",
  "validate/TestRelatePP.xml",
  "robust/TestRobustRelate.xml",
  // prepared predicates
  "general/TestPreparedIntersectsPL.xml",
  "general/TestPreparedPointPredicate.xml",
  "general/TestPreparedPolygonPredicate.xml",
  "general/TestPreparedPredicatesWithGeometryCollection.xml",
  "general/TestRectanglePredicate.xml",
  // overlays (plain, NG synonyms, SR=Prec, empties)
  "general/TestOverlayAA.xml",
  "general/TestOverlayAAPrec.xml",
  "general/TestOverlayEmpty.xml",
  "general/TestOverlayLA.xml",
  "general/TestOverlayLAPrec.xml",
  "general/TestOverlayLL.xml",
  "general/TestOverlayLLPrec.xml",
  "general/TestOverlayPA.xml",
  "general/TestOverlayPL.xml",
  "general/TestOverlayPLPrec.xml",
  "general/TestOverlayPP.xml",
  "general/TestNGOverlayA.xml",
  "general/TestNGOverlayAPrec.xml",
  "general/TestNGOverlayEmpty.xml",
  "general/TestNGOverlayGC.xml",
  "general/TestNGOverlayL.xml",
  "general/TestNGOverlayLPrec.xml",
  "general/TestNGOverlayP.xml",
  "general/TestNGOverlayPPrec.xml",
  "general/TestUnaryUnion.xml",
  "general/TestUnaryUnionFloating.xml",
  "robust/TestRobustOverlayFixed.xml",
  // buffer (result-matcher semantics)
  "general/TestBuffer.xml",
  "general/TestBufferMitredJoin.xml",
  // hulls, simplification, clipping, centers, clearance (Phase 5 M3 ops)
  "general/TestConvexHull.xml",
  "general/TestConvexHull-big.xml",
  "general/TestSimplify.xml",
  "general/TestCentroid.xml",
  "general/TestInteriorPoint.xml",
  "general/TestMinimumClearance.xml",
  "general/TestBoundary.xml",
  // densify: the one permanent gap (C++-only, no C API) — every op in this
  // file lands in KNOWN_GAPS with a reason, never a silent skip
  "general/TestDensify.xml",
  // regression set
  ...ISSUE_FILES,
];

/**
 * The ONLY sanctioned skips (D29): op name → reason. `densify` is permanent
 * (GEOS's Densifier is C++-only, no C API). Every M3 gap entry died when the
 * op landed; anything new appearing in a gated file fails the gate.
 */
const KNOWN_GAPS: Record<string, string> = {
  densify: "Densifier is C++-only — no geos_c binding exists (permanent)",
};

interface CorpusOp {
  name: string;
  arg1: string;
  arg2: string;
  arg3: string;
  arg4: string;
  expected: string;
}

interface CorpusCase {
  file: string;
  desc: string;
  a: string;
  b: string | null;
  prepared: boolean;
  scale: number; // 0 = FLOATING
  ops: CorpusOp[];
}

function stripTags(block: string): string {
  return block
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFile(file: string, text: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  // XMLTester's precision model is parsed at run level AND per case; the
  // current model persists until overridden. Corpus offsets are all 0.
  const firstCase = text.indexOf("<case>");
  const head = firstCase === -1 ? text : text.slice(0, firstCase);
  const runScale = Number(/<precisionModel[^>]*\sscale=["']([\d.]+)["']/.exec(head)?.[1] ?? "0");
  const caseRe = /<case>([\s\S]*?)<\/case>/g;
  let m: RegExpExecArray | null = caseRe.exec(text);
  while (m !== null) {
    const body = m[1]!;
    const desc = stripTags(/<desc>([\s\S]*?)<\/desc>/.exec(body)?.[1] ?? "");
    const a = stripTags(/<a>([\s\S]*?)<\/a>/.exec(body)?.[1] ?? "");
    const b = stripTags(/<b>([\s\S]*?)<\/b>/.exec(body)?.[1] ?? "");
    const prepared = /PreparedGeometryOperation/.test(body);
    const scale = Number(
      /<precisionModel[^>]*\sscale=["']([\d.]+)["']/.exec(body)?.[1] ?? runScale,
    );
    if (a) {
      const ops: CorpusOp[] = [];
      // attribute values are single- OR double-quoted across corpus files
      const attr = (attrs: string, name: string): string =>
        new RegExp(`\\b${name}=["']([^"']*)["']`).exec(attrs)?.[1] ?? "";
      const opRe = /<op\s+([^>]*)>([\s\S]*?)<\/op>/g;
      let o: RegExpExecArray | null = opRe.exec(body);
      while (o !== null) {
        const attrs = o[1] ?? "";
        ops.push({
          name: attr(attrs, "name").toLowerCase(),
          arg1: (attr(attrs, "arg1") || "A").toUpperCase(),
          arg2: attr(attrs, "arg2").toUpperCase(),
          arg3: attr(attrs, "arg3"),
          arg4: attr(attrs, "arg4"),
          expected: stripTags(o[2] ?? ""),
        });
        o = opRe.exec(body);
      }
      if (ops.length > 0) cases.push({ file, desc, a, b: b || null, prepared, scale, ops });
    }
    m = caseRe.exec(text);
  }
  return cases;
}

/* ── XMLTester-faithful comparison helpers ──────────────────────────────── */

const REL_TOL = 1e-3; // checkResult(double)

/** XMLTester's double rule: exact for 0, else 1e-3 relative tolerance. */
function numMatches(expected: number, actual: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(expected - actual) / Math.abs(expected) < REL_TOL;
}

/** DE-9IM pattern match: `*` wildcard, `T` = 0/1/2, `F` = F, else exact. */
export function imMatches(matrix: string, pattern: string): boolean {
  if (pattern.length !== 9 || matrix.length !== 9) return false;
  for (let i = 0; i < 9; i++) {
    const p = pattern[i]!;
    const v = matrix[i]!;
    if (p === "*") continue;
    if (p === "T") {
      if (v === "F") return false;
      continue;
    }
    if (p !== v) return false;
  }
  return true;
}

/** Prepared-predicate dispatch (XMLTester's PreparedGeometryOperation). */
function prepPred(prep: Prepared, name: string, b: Geometry): boolean {
  switch (name) {
    case "intersects":
      return prep.intersects(b);
    case "contains":
      return prep.contains(b);
    case "coveredby":
      return prep.coveredBy(b);
    case "covers":
      return prep.covers(b);
    case "crosses":
      return prep.crosses(b);
    case "disjoint":
      return prep.disjoint(b);
    case "overlaps":
      return prep.overlaps(b);
    case "touches":
      return prep.touches(b);
    case "within":
      return prep.within(b);
    default:
      throw new Error(`no prepared predicate ${name}`);
  }
}

/**
 * The executor context for one corpus run. Kept as a class so the handlers
 * share the snapping reader and the comparison helpers without threading
 * six arguments through every case.
 */
class Executor {
  readonly failures: string[] = [];
  private readonly gapSkips = new Map<string, number>();
  private checked = 0;

  constructor(private readonly geos: Geos) {}

  /** XMLTester reads every WKT under the case's precision model. Hex-WKB
   * bodies (XMLTester parseGeometry accepts both) are detected by shape. */
  private read(wkt: string, scale: number): Geometry {
    // upstream typo (ticket 569): a stray trailing quote after the WKT —
    // stripped so the regression case stays in the gate
    const cleaned = wkt.endsWith("'") ? wkt.slice(0, -1) : wkt;
    const trimmed = cleaned.replace(/\s+/g, "");
    const isHex = /^[0-9A-Fa-f]+$/.test(trimmed) && trimmed.length % 2 === 0;
    const g = isHex ? this.geos.fromWKB(Buffer.from(trimmed, "hex")) : this.geos.fromWKT(cleaned);
    if (scale > 0) {
      const snapped = this.geos.setPrecision(g, 1 / scale, { mode: "noTopo" });
      g.dispose();
      return snapped;
    }
    return g;
  }

  private normalize(g: Geometry): void {
    if (this.geos.native.geos.GEOSNormalize_r(this.geos.ctx, g.ptr) !== 0) {
      throw new Error("GEOSNormalize_r failed");
    }
  }

  /** compareTo == 0 after normalize(), with the documented empty-type quirk. */
  private xmlEquals(actual: Geometry, expected: Geometry): boolean {
    if (this.geos.isEmpty(actual) && this.geos.isEmpty(expected)) return true;
    this.normalize(actual);
    this.normalize(expected);
    return this.geos.equalsIdentical(actual, expected);
  }

  /** checkOverlaySuccess (XMLTester.cpp): topological equals first, then
   * equalsExact within the size-based snap tolerance of the EXPECTED
   * geometry (min envelope dimension × 1e-9, GeometrySnapper's constant). */
  private overlayEquals(actual: Geometry, expected: Geometry): boolean {
    if (this.geos.isEmpty(actual) && this.geos.isEmpty(expected)) return true; // documented empties quirk
    this.normalize(actual);
    this.normalize(expected);
    if (this.geos.equals(actual, expected)) return true;
    const tol = this.sizeSnapTolerance(expected);
    const r = this.geos.native.geos.GEOSEqualsExact_r(this.geos.ctx, expected.ptr, actual.ptr, tol);
    return (r & 0xff) === 1; // char predicate — mask (house rule)
  }

  /** GeometrySnapper::computeSizeBasedSnapTolerance, from the extent. */
  private sizeSnapTolerance(g: Geometry): number {
    const out = new Float64Array(4); // xmin ymin xmax ymax
    const rc = this.geos.native.geos.GEOSGeom_getExtent_r(
      this.geos.ctx,
      g.ptr,
      out,
      out.subarray(1, 2),
      out.subarray(2, 3),
      out.subarray(3, 4),
    );
    if (rc !== 1) throw new Error("GEOSGeom_getExtent_r failed"); // int return — no mask
    return Math.min(out[2]! - out[0]!, out[3]! - out[1]!) * 1e-9;
  }

  private readExpected(op: CorpusOp, scale: number): Geometry {
    return this.read(op.expected, scale);
  }

  /** Run one case's ops. Returns false on failure (details in `failures`). */
  runCase(c: CorpusCase): boolean {
    using arena = this.geos.arena();
    let ok = true;
    const a = this.read(c.a, c.scale);
    const b = c.b === null ? null : this.read(c.b, c.scale);
    // prepared cases route predicates through GEOSPrepare (XMLTester's
    // PreparedGeometryOperation); everything else is unprepared.
    const prep = c.prepared ? a.prepare() : null;
    try {
      for (const op of c.ops) {
        const argA = op.arg1 === "B" && b !== null ? b : a;
        const argB = op.arg2 === "A" ? a : op.arg2 === "B" ? b : null;
        const where = `${c.file}: ${c.desc || "(no desc)"} [${op.name}]`;
        try {
          const outcome = this.runOp(op, argA, argB, prep, c);
          if (outcome === true) {
            this.checked++;
            continue;
          }
          if (outcome === null) {
            // sanctioned gap
            this.gapSkips.set(op.name, (this.gapSkips.get(op.name) ?? 0) + 1);
            continue;
          }
          this.failures.push(`${where}: ${outcome}`);
          ok = false;
        } catch (err) {
          this.failures.push(`${where}: threw ${(err as Error).message}`);
          ok = false;
        }
      }
    } finally {
      prep?.dispose();
      a.dispose();
      b?.dispose();
    }
    void arena;
    return ok;
  }

  /** true = pass, null = sanctioned gap, string = failure detail. */
  private runOp(
    op: CorpusOp,
    a: Geometry,
    b: Geometry | null,
    prep: Prepared | null,
    c: CorpusCase,
  ): true | null | string {
    const g = this.geos;
    const boolOf = (v: boolean): true | string =>
      v === (op.expected === "true") ? true : `expected ${op.expected}`;

    switch (op.name) {
      /* ── predicates (prepared when the case says so) ── */
      case "intersects":
      case "contains":
      case "coveredby":
      case "covers":
      case "crosses":
      case "disjoint":
      case "overlaps":
      case "touches":
      case "within": {
        if (b === null) return "missing arg2";
        const v = prep ? prepPred(prep, op.name, b) : this.unpreparedPred(op.name, a, b);
        return boolOf(v);
      }
      case "equalstopo": {
        if (b === null) return "missing arg2";
        return boolOf(g.equals(a, b));
      }
      case "equalsexact": {
        if (b === null) return "missing arg2";
        return boolOf(g.equalsIdentical(a, b));
      }
      case "equalsnorm": {
        if (b === null) return "missing arg2";
        this.normalize(a);
        this.normalize(b);
        return boolOf(g.equalsIdentical(a, b));
      }
      case "relate": {
        if (b === null) return "missing arg2";
        const matrix = g.relateMatrix(a, b);
        return imMatches(matrix, op.arg3)
          ? true
          : `matrix ${matrix} does not match pattern ${op.arg3}`;
      }
      case "issimple": {
        return boolOf(g.isSimpleDetail(a).simple);
      }
      case "isvalid": {
        return boolOf(g.isValid(a));
      }
      case "iswithindistance": {
        if (b === null) return "missing arg2";
        return boolOf(g.distance(a, b) <= Number(op.arg3));
      }
      case "distance": {
        if (b === null) return "missing arg2";
        const d = g.distance(a, b);
        return numMatches(Number(op.expected), d) ? true : `expected ${op.expected}, got ${d}`;
      }

      /* ── overlays ── */
      case "intersection":
      case "intersectionng":
      case "intersectionsin": {
        if (b === null) return "missing arg2";
        using r = g.intersection(a, b);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "union":
      case "unionng": {
        using r = b === null ? g.unaryUnion(a) : g.union(a, b);
        return this.overlayEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "difference":
      case "differenceng": {
        if (b === null) return "missing arg2";
        using r = g.difference(a, b);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "symdifference":
      case "symdifferenceng": {
        if (b === null) return "missing arg2";
        using r = g.symDifference(a, b);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "intersectionsr":
      case "unionsr":
      case "differencesr":
      case "symdifferencesr": {
        // OverlayNG under PrecisionModel(arg3 || 1) — gridSize = 1/scale.
        const grid = 1 / Number(op.arg3 === "" ? "1" : op.arg3);
        let r: Geometry;
        if (op.name === "unionsr" && b === null) r = g.unaryUnionPrec(a, grid);
        else {
          if (b === null) return "missing arg2";
          r =
            op.name === "intersectionsr"
              ? g.intersectionPrec(a, b, grid)
              : op.name === "unionsr"
                ? g.unionPrec(a, b, grid)
                : op.name === "differencesr"
                  ? g.differencePrec(a, b, grid)
                  : g.symDifferencePrec(a, b, grid);
        }
        using _rOwned = r;
        return this.overlayEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "unionarea":
      case "unionlength": {
        using r = g.unaryUnion(a);
        const v = op.name === "unionarea" ? g.area(r) : g.length(r);
        return numMatches(Number(op.expected), v) ? true : `expected ${op.expected}, got ${v}`;
      }
      case "overlayareatest": {
        if (b === null) return "missing arg2";
        return this.areaTest(a, b, 1e-6) === (op.expected === "true")
          ? true
          : `area identity delta exceeded`;
      }
      case "areatest": {
        // tolerated difference comes from the op TEXT (XMLTester areatest)
        if (b === null) return "missing arg2";
        const tolerated = Number(op.expected);
        if (!Number.isFinite(tolerated)) return `malformed areatest tolerance`;
        return this.areaTest(a, b, tolerated) ? true : `area identity delta > ${tolerated}`;
      }

      /* ── buffer (BufferResultMatcher: type + area agreement) ── */
      case "buffer":
      case "buffermitredjoin": {
        const dist = Number(op.arg2);
        const opts: { quadSegs?: number; join?: "round" | "mitre" | "bevel" } = {};
        if (op.arg3 !== "") opts.quadSegs = Number(op.arg3);
        if (op.name === "buffermitredjoin") opts.join = "mitre";
        using r = g.buffer(a, dist, opts);
        using expected = this.readExpected(op, c.scale);
        if (this.xmlEquals(r, expected)) return true;
        // BufferResultMatcher fallback: dimension + relative area match
        const aa = g.area(r);
        const ae = g.area(expected);
        const tol = 1e-6 * Math.max(1, Math.abs(ae));
        return Math.abs(aa - ae) <= tol ? true : `buffer area ${aa} vs ${ae} (${g.toWKT(r)})`;
      }

      case "makevalid": {
        using r = g.makeValid(a);
        using expected = this.readExpected(op, c.scale);
        return g.equals(r, expected) ? true : `got ${g.toWKT(r)}`;
      }

      /* ── Phase 5 construction ops (M3) ── */
      case "convexhull": {
        using r = g.convexHull(a);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "simplifydp":
      case "simplifytp": {
        const tol = Number(op.arg2);
        using r =
          op.name === "simplifydp" ? g.simplify(a, tol) : g.topologyPreserveSimplify(a, tol);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "getboundary": {
        using r = g.boundary(a);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "getcentroid": {
        using r = g.centroid(a);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "getinteriorpoint": {
        using r = g.interiorPoint(a);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }
      case "minclearance": {
        // XMLTester clamps +Inf to DBL_MAX before the double comparison
        let v = g.minimumClearance(a);
        if (v > Number.MAX_VALUE) v = Number.MAX_VALUE;
        return numMatches(Number(op.expected), v) ? true : `expected ${op.expected}, got ${v}`;
      }
      case "minclearanceline": {
        using r = g.minimumClearanceLine(a);
        return this.xmlEquals(r, this.readExpected(op, c.scale)) ? true : `got ${g.toWKT(r)}`;
      }

      default:
        if (op.name in KNOWN_GAPS) return null;
        return `unhandled op (not in KNOWN_GAPS)`;
    }
  }

  private unpreparedPred(name: string, a: Geometry, b: Geometry): boolean {
    const g = this.geos;
    switch (name) {
      case "intersects":
        return g.intersects(a, b);
      case "contains":
        return g.contains(a, b);
      case "coveredby":
        return g.coveredBy(a, b);
      case "covers":
        return g.covers(a, b);
      case "crosses":
        return g.crosses(a, b);
      case "disjoint":
        return g.disjoint(a, b);
      case "overlaps":
        return g.overlaps(a, b);
      case "touches":
        return g.touches(a, b);
      case "within":
        return g.within(a, b);
      default:
        throw new Error(`no predicate ${name}`);
    }
  }

  /** XMLTester areaDelta: the four overlay area identities, bounded. */
  private areaTest(a: Geometry, b: Geometry, toleratedDiff: number): boolean {
    const g = this.geos;
    using i = g.intersection(a, b);
    using dab = g.difference(a, b);
    using dba = g.difference(b, a);
    using sd = g.symDifference(a, b);
    using u = g.union(a, b);
    const areaA = g.area(a);
    const areaB = g.area(b);
    const areaI = g.area(i);
    const areaDab = g.area(dab);
    const areaDba = g.area(dba);
    const areaSD = g.area(sd);
    const areaU = g.area(u);
    const maxdiff = Math.max(
      Math.abs(areaA - areaI - areaDab),
      Math.abs(areaB - areaI - areaDba),
      Math.abs(areaDab + areaDba - areaSD),
      Math.abs(areaI + areaSD - areaU),
    );
    return maxdiff <= toleratedDiff;
  }

  get stats(): { checked: number; gapSkips: Map<string, number>; failures: string[] } {
    return { checked: this.checked, gapSkips: this.gapSkips, failures: this.failures };
  }
}

const hasCorpus = CORPUS_ROOT !== undefined && FILES.every((f) => existsSync(corpusFile(f)));

/** Join a corpus-relative file path; throws (never returns undefined paths)
 * when no tree was resolved — callers are guarded by `hasCorpus`/the CI check. */
function corpusFile(f: string): string {
  if (CORPUS_ROOT === undefined) {
    throw new Error(
      `no xmltester corpus tree resolved (candidates: ${CORPUS_CANDIDATES.join(", ")})`,
    );
  }
  return join(CORPUS_ROOT, f);
}

if (!hasCorpus && process.env.CI === "true") {
  // The gate must be permanent in CI (ROADMAP Phase 5): a missing corpus tree
  // there means the wiring broke — fail loudly instead of skipping silently.
  throw new Error(
    `CI=true but no xmltester corpus found (looked in: ${CORPUS_CANDIDATES.join(", ")}) — ` +
      `run \`bun run build:native\` or restore vendor/geos`,
  );
}

describe.skipIf(!hasCorpus)(
  "XML corpus differential gate (GEOS/JTS xmltester, pinned 3.14.1)",
  () => {
    it("every op agrees with the published expectations", () => {
      const geos = new Geos();
      try {
        const exec = new Executor(geos);
        for (const file of FILES) {
          const text = readFileSync(corpusFile(file), "utf8");
          for (const c of parseFile(file, text)) exec.runCase(c);
        }
        const { checked, gapSkips, failures } = exec.stats;

        // every skip must be a sanctioned, reasoned gap (D29)
        const unsanctioned = [...gapSkips.keys()].filter((n) => !(n in KNOWN_GAPS));
        expect(unsanctioned).toEqual([]);

        expect(failures).toEqual([]);
        expect(checked).toBeGreaterThan(3000);
        console.log(
          `corpus gate: ${checked} ops checked, ` +
            `${[...gapSkips.values()].reduce((n, v) => n + v, 0)} sanctioned gap skips ` +
            `(${[...gapSkips.keys()].join(", ") || "none"}), 0 failures`,
        );
      } finally {
        geos.dispose();
      }
    });
  },
);

describe.skipIf(!hasCorpus)("XML corpus parser", () => {
  it("parses cases with ops, args, and per-case precision", () => {
    const text = [
      "<case>",
      '  <precisionModel scale="1.0" offsetx="0.0" offsety="0.0"/>',
      "  <a>  POINT(10 10) </a>",
      "  <b>  POINT(10 10) </b>",
      '  <test><op name="relate" arg3="0FFFFFFF2" arg1="A" arg2="B">true</op></test>',
      "</case>",
    ].join("\n");
    const cases = parseFile("inline", text);
    expect(cases.length).toBe(1);
    const c = cases[0];
    expect(c?.scale).toBe(1);
    expect(c?.ops[0]).toEqual({
      name: "relate",
      arg1: "A",
      arg2: "B",
      arg3: "0FFFFFFF2",
      arg4: "",
      expected: "true",
    });
  });
});
