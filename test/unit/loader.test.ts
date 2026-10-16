/**
 * Unit: loader resolution and guard rails (audit: the BUN_GEOS_LIBRARY
 * override and version-assert paths had zero coverage).
 */
import { describe, expect, it } from "bun:test";
import { Geos, LoaderError } from "../../src/index.ts";

describe("BUN_GEOS_LIBRARY override (D8)", () => {
  it("a missing override file is a LoaderError with remediation", () => {
    // The default library may already be open in this process (other suites
    // ran first); either the missing-file check or the one-GEOS-per-process
    // guard fires — both are LoaderErrors with actionable text.
    expect(() => new Geos({ library: "/nonexistent/libgeos_c.so" })).toThrow(LoaderError);
    expect(() => new Geos({ library: "/nonexistent/libgeos_c.so" })).toThrow(
      /missing file|already loaded with a different/,
    );
  });

  it("a different override on an already-loaded process is rejected (one GEOS per process)", () => {
    // First, whatever this process already loaded (default or nothing):
    const probe = new Geos();
    expect(probe.version).toMatch(/^3\.14\./);
    // Any different override — even a valid file — must now fail loudly
    // instead of being silently ignored (audit N2).
    expect(() => new Geos({ library: "/tmp/opencode/override/libgeos_c.so.1" })).toThrow(
      /already loaded with a different/,
    );
  });
});

describe("version assert (D5)", () => {
  it("accepts the bundled 3.14.x and rejects nothing else in-process", () => {
    using geos = new Geos();
    expect(geos.version).toMatch(/^3\.14\.\d+-CAPI-/);
  });
});
