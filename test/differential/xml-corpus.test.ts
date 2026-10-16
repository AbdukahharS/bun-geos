/**
 * XML corpus differential gate (Phase 2, testing.md §5): run the GEOS/JTS
 * `xmltester` validity corpus — vendored at the pinned 3.14.1 tag — through
 * our API. The corpus is the shared JTS/GEOS test capital: hundreds of
 * hand-authored validity cases with published expected results.
 *
 * Parsed here (regex — the format is flat): <case> blocks with <a>/<b> WKT
 * and ops `isValid` (true/false) and `makevalid` (expected WKT). Runs with a
 * FIXED precisionModel are emulated by setPrecision(pointwise) on the parsed
 * inputs, matching XMLTester's read-time snapping.
 *
 * Skips (loudly) when the vendored corpus is absent so a checkout without
 * `vendor/geos` still passes — CI requires it.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Geos } from "../../src/index.ts";

const CORPUS_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "vendor",
  "geos",
  "tests",
  "xmltester",
  "tests",
);
const FILES = [
  "general/TestValid.xml",
  "general/TestValid2.xml",
  "misc/TestIsValid.xml",
  "misc/makevalid.xml",
];

interface CorpusCase {
  file: string;
  desc: string;
  a: string;
  b: string | null;
  ops: Array<{ name: string; target: string; expected: string }>;
}

function stripTags(block: string): string {
  return block
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseFile(file: string, text: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const caseRe = /<case>([\s\S]*?)<\/case>/g;
  let m: RegExpExecArray | null = caseRe.exec(text);
  while (m !== null) {
    const body = m[1]!;
    const desc = stripTags(/<desc>([\s\S]*?)<\/desc>/.exec(body)?.[1] ?? "");
    const a = stripTags(/<a>([\s\S]*?)<\/a>/.exec(body)?.[1] ?? "");
    const b = stripTags(/<b>([\s\S]*?)<\/b>/.exec(body)?.[1] ?? "");
    if (a) {
      const ops: CorpusCase["ops"] = [];
      const opRe = /<op\s+name="([^"]+)"\s+([^>]*)>([\s\S]*?)<\/op>/g;
      let o: RegExpExecArray | null = opRe.exec(body);
      while (o !== null) {
        const attrs = o[2] ?? "";
        ops.push({
          name: o[1]!,
          target: (/arg1="([^"]+)"/.exec(attrs)?.[1] ?? "A").toUpperCase(),
          expected: stripTags(o[3] ?? ""),
        });
        o = opRe.exec(body);
      }
      if (ops.length > 0) cases.push({ file, desc, a, b: b || null, ops });
    }
    m = caseRe.exec(text);
  }
  return cases;
}

const hasCorpus = FILES.every((f) => existsSync(join(CORPUS_ROOT, f)));

describe.skipIf(!hasCorpus)("XML validity corpus (GEOS/JTS xmltester, pinned 3.14.1)", () => {
  it("isValid / makeValid agree with the published expectations", async () => {
    const failures: string[] = [];
    let checked = 0;
    let skipped = 0;
    using geos = new Geos();
    for (const file of FILES) {
      const text = readFileSync(join(CORPUS_ROOT, file), "utf8");
      const fixedScale = Number(/<precisionModel[^>]*scale="([\d.]+)"/.exec(text)?.[1] ?? "0");
      for (const c of parseFile(file, text)) {
        for (const op of c.ops) {
          const where = `${file}: ${c.desc || "(no desc)"} [${op.name}]`;
          try {
            if (op.name === "isValid") {
              const wkt = op.target === "B" && c.b ? c.b : c.a;
              using g = geos.fromWKT(wkt);
              const expected = op.expected === "true";
              if (geos.isValid(g) !== expected) {
                failures.push(`${where}: isValid expected ${expected}`);
              }
              checked++;
            } else if (op.name === "makevalid") {
              using g = geos.fromWKT(c.a);
              using snapped =
                fixedScale > 0 ? geos.setPrecision(g, 1 / fixedScale, { mode: "noTopo" }) : null;
              const input = snapped ?? g;
              using fixed = geos.makeValid(input);
              using expected = geos.fromWKT(op.expected);
              if (!geos.equals(fixed, expected)) {
                failures.push(
                  `${where}: makeValid gave ${geos.toWKT(fixed)}, expected ${op.expected}`,
                );
              }
              checked++;
            } else {
              skipped++;
            }
          } catch (err) {
            failures.push(`${where}: threw ${(err as Error).message}`);
          }
        }
      }
    }
    // the four files hold 87 + 752 + 3 + 15 validity/makevalid ops
    expect(checked).toBeGreaterThan(800);
    expect(`${failures.length} failures, ${skipped} non-validity ops skipped`).toBe(
      "0 failures, 0 non-validity ops skipped",
    );
    expect(failures).toEqual([]);
  }, 120_000);

  it("parser is sane on a known minimal case", () => {
    const cases = parseFile(
      "x.xml",
      `<run><case><desc>demo</desc><a>LINESTRING (0 0, 1 1)</a><test><op name="isValid" arg1="A">true</op></test></case></run>`,
    );
    expect(cases.length).toBe(1);
    expect(cases[0]!.ops[0]).toEqual({ name: "isValid", target: "A", expected: "true" });
  });
});
