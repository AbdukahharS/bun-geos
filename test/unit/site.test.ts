/**
 * Cirth site gates (permanent). The site imports `site/` from `main`
 * directly and Cirth's changelog SECTION parses CHANGELOG.md itself (the
 * per-file sync and the generator that fed it were retired when Cirth
 * moved changelog syncing to the one-file model). The gates:
 *   1. CHANGELOG.md headings parse: every `## ` heading is either
 *      `## Unreleased` or a dated version heading `## [x.y.z] - YYYY-MM-DD`
 *      — Cirth turns each version heading into a dated feed entry, so a
 *      malformed heading would silently become intro/body text instead.
 *   2. Link discipline: every markdown link in a site page is
 *      site-absolute (/…), an in-page anchor, or external — Cirth preserves
 *      these verbatim and GitHub renders them as no-ops at worst.
 *   3. User-docs discipline: site pages never cite D-number decisions
 *      (that language stays in docs/). CHANGELOG.md is exempt — its
 *      D-references are its own historical record, and the feed mirrors it.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SITE = join(ROOT, "site");
const FENCE_RE = /^\s*(?:>\s*)?(```|~~~)/;
const UNRELEASED_HEADING = /^## Unreleased$/;
const VERSION_HEADING = /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/;

/** Site pages, as `<dir>/<name>` (or bare name at the root), sorted. */
function sitePages(): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(SITE).sort()) {
    const p = join(SITE, entry);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.endsWith(".md")) pages.push(`${entry}/${f}`);
    } else if (entry.endsWith(".md")) {
      pages.push(entry);
    }
  }
  return pages;
}

describe("cirth site gates", () => {
  it("CHANGELOG.md headings parse (dated version entries or Unreleased)", () => {
    const failures: string[] = [];
    const lines = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.startsWith("## ")) return;
      const ok = UNRELEASED_HEADING.test(line) || VERSION_HEADING.test(line);
      if (!ok) failures.push(`CHANGELOG.md:${i + 1} — unrecognized heading: ${line.trim()}`);
    });
    expect(failures).toEqual([]);
  });

  it("site pages use only site-absolute, anchor or external links", () => {
    const failures: string[] = [];
    for (const page of sitePages()) {
      const lines = readFileSync(join(SITE, page), "utf8").split("\n");
      let fenced = false;
      lines.forEach((line, i) => {
        if (FENCE_RE.test(line)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        if (/\]\(\s*(?!#|\/|https?:\/\/|mailto:)[^)\s]+/.test(line)) {
          failures.push(`site/${page}:${i + 1} — relative link: ${line.trim()}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("site pages never cite D-number decisions", () => {
    const failures: string[] = [];
    for (const page of sitePages()) {
      const lines = readFileSync(join(SITE, page), "utf8").split("\n");
      let fenced = false;
      lines.forEach((line, i) => {
        if (FENCE_RE.test(line)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        const m = line.match(/\bD\d+\b/);
        if (m) failures.push(`site/${page}:${i + 1} — cites "${m[0]}"`);
      });
    }
    expect(failures).toEqual([]);
  });
});
