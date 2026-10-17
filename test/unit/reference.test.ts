/**
 * Reference-doc freshness gate (Phase 5 M5): every public export and every
 * Geos method must appear in docs/reference/api.md. A name may appear in a
 * table cell or prose — the gate catches a FORGOTTEN op, not prose style.
 * The symbol table (docs/reference/symbols.md) is generated and cannot
 * drift; this file is hand-maintained and therefore gated.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pkg from "../../src/index.ts";

const DOC = readFileSync(join(import.meta.dir, "..", "..", "docs", "reference", "api.md"), "utf8");

function appears(name: string): boolean {
  return new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(DOC);
}

function methodNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === "constructor") return false;
    const d = Object.getOwnPropertyDescriptor(proto, name)!;
    return typeof d.value === "function"; // getters are not invoked
  });
}

/**
 * @internal members excluded from the reference. Removing an entry means
 * the member became PUBLIC — document it in api.md instead of deleting it
 * from this set.
 */
const INTERNAL = new Set([
  // ownership/plumbing (used by the ops modules and tests)
  "wktReader",
  "wkbReader",
  "makeValidParams",
  "coverageCleanParams",
  "registerConsumable",
  "unregisterConsumable",
  "assertOpen",
  "fail",
  "take",
  "takeMany",
  "borrow",
  "requirePtr",
  "currentArena",
  "destroyOwned",
  "destroyRaw",
  "destroyMany",
  "arenaClosed",
  "unregisterFinalizer",
  "renounceOwnership",
  "assertUnpinned",
]);

describe("reference freshness", () => {
  it("documents every value export", () => {
    const missing = Object.keys(pkg).filter((name) => !appears(name));
    expect(missing).toEqual([]);
  });

  it("documents every Geos method", () => {
    const missing = methodNames(pkg.Geos.prototype).filter(
      (name) => !appears(name) && !INTERNAL.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("documents every Geometry method and accessor", () => {
    // accessors included: get-property names must appear too
    const members = Object.getOwnPropertyNames(pkg.Geometry.prototype).filter(
      (n) => n !== "constructor",
    );
    const missing = members.filter((name) => !appears(name) && !INTERNAL.has(name));
    expect(missing).toEqual([]);
  });
});
