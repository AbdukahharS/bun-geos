/**
 * The Cirth docs-site prepare step: assembles the `docs-site` orphan branch
 * that the Cirth GitHub importer consumes (bun-geos.cirth.app).
 *
 * Source of truth is `site/` — the hand-written USER documentation set, kept
 * versioned with the library. `site/_index.md` is the site home; the only
 * generated page is `changelog.md`, assembled from the root CHANGELOG.md at
 * prepare time (never hand-copied). The development docs under `docs/` are
 * NOT part of the site.
 *
 * Gates (both fail loudly — no silent rot):
 *   1. Links: every link in the assembled tree must be site-absolute (`/…`,
 *      i.e. a real page in this set, with a real heading when an anchor is
 *      given), an in-page anchor, or an approved external URL. Relative
 *      `.md` links are resolved against `site/` first.
 *   2. Symbols: every `geos.<name>` token in the hand-written docs must exist
 *      on the actual `Geos` class (extracted from `src/geos.ts`), and
 *      `geos.parallel.<op>` on the Parallel pool — `@internal` methods are
 *      denylisted, not documented. The generated changelog is exempt (it
 *      mirrors the upstream file verbatim).
 *   3. Discipline: the hand-written pages contain no D-number decision
 *      references — user-level language only.
 *
 * Layout contract (see the Cirth import path mapping): `_index.md` is the only
 * page that slugifies to `index`, and `_` sorts before every lowercase letter,
 * so it deterministically wins the first-root-page race and becomes the site
 * home. Other root-level pages (install, quickstart, reference, benchmarks,
 * changelog) are top-level nav entries; everything else nests under guide/.
 *
 * Usage: bun run docs:site   (assemble + commit the branch; push separately)
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { $ } from "bun";

const GITHUB_BASE = "https://github.com/AbdukahharS/bun-geos";
const BRANCH = "docs-site";
const SITE_DIR = "site";

/** Output path in the branch → source path (site/ relative, or a generator). */
const SITE_FILES: Record<string, string> = {
  "_index.md": "_index.md",
  "changelog.md": "@CHANGELOG.md", // generated from the repo's CHANGELOG.md
  "reference.md": "reference.md",
  "install.md": "install.md",
  "quickstart.md": "quickstart.md",
  "benchmarks.md": "benchmarks.md",
  ...dir("guide"),
};

function dir(name: string): Record<string, string> {
  const files = Array.from(new Bun.Glob("*.md").scanSync({ cwd: `${SITE_DIR}/${name}` })).sort();
  if (files.length === 0) {
    throw new Error(`docs-site-prepare: no markdown under ${SITE_DIR}/${name}`);
  }
  return Object.fromEntries(files.map((file) => [`${name}/${file}`, `${name}/${file}`]));
}

/** Output path in the branch → public page path on the site. */
function pagePathOf(outputPath: string): string {
  if (outputPath === "_index.md") return "index";
  return outputPath.replace(/\.md$/, "");
}

/** Set of public page paths, for link-target validation. */
function allPagePaths(): Set<string> {
  return new Set(Object.keys(SITE_FILES).map(pagePathOf));
}

/** Normalize `./`/`../` segments against a base directory. */
function resolvePath(fromDir: string, link: string): string {
  const segments: string[] = [];
  const base = fromDir === "" ? [] : fromDir.split("/");
  for (const segment of [...base, ...link.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function stripExt(path: string): string {
  return path.replace(/\.md$/i, "");
}

/**
 * Rewrite links outside of ```/~~~ fences; return [content, rewriteCount].
 * Relative links resolve against the file's own directory in site/, then
 * against the repo root. Everything else must already be site-absolute,
 * an anchor, or external — the assertion below enforces it.
 */
function rewriteLinks(sourcePath: string, content: string): [string, number] {
  const fromDir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  const lines = content.split("\n");
  let fenced = false;
  let rewrites = 0;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    return line.replace(
      /\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
      (whole, target: string, title: string) => {
        if (
          target.startsWith("#") ||
          target.startsWith("/") ||
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:")
        ) {
          return whole;
        }
        const hash = target.indexOf("#");
        const path = hash === -1 ? target : target.slice(0, hash);
        const anchor = hash === -1 ? "" : target.slice(hash);
        const fromSite = resolvePath(fromDir, path);
        const resolved = SITE_FILES[stripExt(fromSite) + ".md"]
          ? stripExt(fromSite) + ".md"
          : resolvePath("", path);
        const mapped =
          SITE_FILES[resolved] !== undefined
            ? `/${pagePathOf(resolved)}`
            : // Fallback: a REAL repo path with no site page points at the
              // repo itself (the changelog references docs/ROADMAP.md, …).
              // A path that exists nowhere is a typo — fail the build.
              existsSync(resolved)
              ? `${GITHUB_BASE}/blob/main/${resolved}${anchor}`
              : undefined;
        if (mapped === undefined) {
          throw new Error(
            `docs-site-prepare: unresolvable link ${JSON.stringify(target)} ` +
              `in site/${sourcePath} (resolved to ${JSON.stringify(resolved)})`,
          );
        }
        rewrites += 1;
        return `](${mapped}${anchor}${title})`;
      },
    );
  });
  return [out.join("\n"), rewrites];
}

/**
 * Fences toggle on ```/~~~ — including inside blockquotes (a `> ``` block
 * must not desync the walker for the rest of the file).
 */
const FENCE_RE = /^\s*(?:>\s*)?(```|~~~)/;

/** Outside fences, every link must be site-absolute, an anchor, or external. */
function assertLinksResolved(outputPath: string, content: string): void {
  const lines = content.split("\n");
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (/\]\(\s*(?!#|\/|https?:\/\/|mailto:)[^)\s]+/.test(line)) {
      throw new Error(
        `docs-site-prepare: ${outputPath}:${index + 1} still has a ` +
          `relative link: ${line.trim()}`,
      );
    }
  });
}

/** GitHub-style heading slug (lowercase, punctuation stripped, each space → dash). */
function headingSlug(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replaceAll(/`/g, "")
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replaceAll(/\s/g, "-")
    .toLowerCase();
}

/** pagePath → set of heading slugs, so anchors can be validated. */
function collectHeadings(content: string): Set<string> {
  const slugs = new Set<string>();
  let fenced = false;
  for (const line of content.split("\n")) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^#{1,6}\s/.test(line)) slugs.add(headingSlug(line));
  }
  return slugs;
}

/**
 * Every site-absolute link must hit a real page, and its anchor (if any)
 * must hit a real heading in that page. A bare `](/)` is the home link —
 * always valid. Same-page `](#anchor)` validates against the file itself.
 */
function assertTargetsExist(
  outputPath: string,
  content: string,
  pages: Set<string>,
  headings: Map<string, Set<string>>,
): void {
  const own = pagePathOf(outputPath);
  const lines = content.split("\n");
  let fenced = false;
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/\]\(\/([^)#\s]*)(#[^)\s]+)?\)/g)) {
      const page = match[1]!;
      const anchor = match[2]?.slice(1);
      if (page === "") continue; // `](/)` — the home link
      if (!pages.has(page)) {
        throw new Error(
          `docs-site-prepare: ${outputPath}:${index + 1} links to ` +
            `/${page} which is not a page in this set`,
        );
      }
      if (anchor !== undefined) {
        const slug = anchor.toLowerCase();
        const ok = headings.get(page)?.has(slug) ?? (page === own && headings.get(own)?.has(slug));
        if (!ok) {
          throw new Error(
            `docs-site-prepare: ${outputPath}:${index + 1} anchors to ` +
              `/${page}#${anchor} which is not a heading there`,
          );
        }
      }
    }
    for (const match of line.matchAll(/\]\(#([^)\s]+)\)/g)) {
      const slug = match[1]!.toLowerCase();
      if (!headings.get(own)?.has(slug)) {
        throw new Error(
          `docs-site-prepare: ${outputPath}:${index + 1} anchors to ` +
            `#${match[1]} which is not a heading of this page`,
        );
      }
    }
  });
}

/**
 * Extract the Geos method/getter names from src/geos.ts, so the docs can be
 * checked against the real surface instead of a hand-maintained list.
 */
async function extractGeosSurface(): Promise<Set<string>> {
  const source = await Bun.file("src/geos.ts").text();
  const names = new Set<string>();
  // Methods: two-space-indented `name(` / `async name(` at class level.
  for (const m of source.matchAll(/^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)[(<]/gm)) {
    names.add(m[1]!);
  }
  // Getters: `get name()`.
  for (const m of source.matchAll(/^ {2}get ([a-zA-Z][a-zA-Z0-9]*)\(/gm)) {
    names.add(m[1]!);
  }
  return names;
}

/** Parallel pool methods, extracted from src/parallel/pool.ts. */
async function extractParallelSurface(): Promise<Set<string>> {
  const source = await Bun.file("src/parallel/pool.ts").text();
  const names = new Set<string>();
  for (const m of source.matchAll(/^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)[(<]/gm)) {
    names.add(m[1]!);
  }
  for (const m of source.matchAll(/^ {2}get ([a-zA-Z][a-zA-Z0-9]*)\(/gm)) {
    names.add(m[1]!);
  }
  return names;
}

/**
 * Methods that exist on the class but are @internal plumbing — referencing
 * them in user docs is a defect even though the existence gate alone would
 * let them through.
 */
const INTERNAL_DENYLIST = new Set([
  "take",
  "takeMany",
  "borrow",
  "fail",
  "destroyOwned",
  "destroyRaw",
  "destroyMany",
  "arenaClosed",
  "unregisterFinalizer",
  "renounceOwnership",
  "registerConsumable",
  "unregisterConsumable",
  "assertOpen",
  "requirePtr",
  "currentArena",
  "wktReader",
  "wkbReader",
  "makeValidParams",
  "coverageCleanParams",
]);

/**
 * `geos.<token>` and `geos.parallel.<token>` tokens in the docs must exist on
 * the real surfaces — code fences INCLUDED, because code samples are exactly
 * where a drift typo would ship. `@internal` names are denied outright.
 */
function assertSymbolsExist(
  outputPath: string,
  content: string,
  geosSurface: Set<string>,
  parallelSurface: Set<string>,
): void {
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    for (const m of line.matchAll(/\bgeos\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const name = m[1]!;
      if (INTERNAL_DENYLIST.has(name)) {
        throw new Error(
          `docs-site-prepare: ${outputPath}:${index + 1} references ` +
            `geos.${name}() which is @internal — user docs must not use it`,
        );
      }
      if (!geosSurface.has(name)) {
        throw new Error(
          `docs-site-prepare: ${outputPath}:${index + 1} references ` +
            `geos.${name}() which does not exist on Geos (src/geos.ts)`,
        );
      }
    }
    for (const m of line.matchAll(/\bgeos\.parallel\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      const name = m[1]!;
      if (!parallelSurface.has(name)) {
        throw new Error(
          `docs-site-prepare: ${outputPath}:${index + 1} references ` +
            `geos.parallel.${name}() which does not exist on Parallel ` +
            "(src/parallel/pool.ts)",
        );
      }
    }
  });
}

/** The hand-written pages speak user-level language — no D-number refs. */
function assertNoDecisionRefs(outputPath: string, content: string): void {
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const m = line.match(/\bD\d+\b/);
    if (m) {
      throw new Error(
        `docs-site-prepare: ${outputPath}:${index + 1} references ` +
          `"${m[0]}" — user docs must not cite internal decision numbers`,
      );
    }
  });
}

async function git(...args: string[]): Promise<string> {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

async function gitWithInput(args: string[], input: string): Promise<string> {
  const tmp = `${tmpdir()}/docs-site-prepare-${crypto.randomUUID()}`;
  await Bun.write(tmp, input);
  try {
    const result = await $`git ${args} < ${tmp}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString().trim();
  } finally {
    unlinkSync(tmp);
  }
}

// --- 1. Assemble + gate ------------------------------------------------------

const assembled = new Map<string, string>();
let totalRewrites = 0;
for (const [output, source] of Object.entries(SITE_FILES)) {
  const file = Bun.file(source.startsWith("@") ? source.slice(1) : `${SITE_DIR}/${source}`);
  if (!(await file.exists())) {
    throw new Error(`docs-site-prepare: missing source ${source}`);
  }
  const [content, count] = rewriteLinks(source, await file.text());
  assertLinksResolved(output, content);
  assembled.set(output, content);
  totalRewrites += count;
}

const pages = allPagePaths();
const headings = new Map<string, Set<string>>();
for (const [output, content] of assembled) {
  headings.set(pagePathOf(output), collectHeadings(content));
}
const geosSurface = await extractGeosSurface();
const parallelSurface = await extractParallelSurface();
for (const [output, content] of assembled) {
  assertTargetsExist(output, content, pages, headings);
  // The changelog mirrors the upstream CHANGELOG.md verbatim — it may name
  // repo-internal things (geos.dll is the Windows GEOS binary, not a method;
  // D-numbers are its own historical record). Every hand-written page is
  // held to the user-docs discipline.
  if (output !== "changelog.md") {
    assertSymbolsExist(output, content, geosSurface, parallelSurface);
    assertNoDecisionRefs(output, content);
  }
}

// --- 2. Plumb the orphan branch (no worktree, no index games) ----------------

const blobs = new Map<string, string>();
for (const [output, content] of assembled) {
  blobs.set(output, await gitWithInput(["hash-object", "-w", "--stdin"], content));
}

/** Build nested trees bottom-up; git sorts tree entries with dirs as `name/`. */
async function buildTree(prefix: string): Promise<string> {
  const children = new Map<string, boolean>(); // name → isDir
  for (const output of assembled.keys()) {
    if (!output.startsWith(prefix)) continue;
    const rest = output.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    children.set(head!, tail.length > 0);
  }
  const entries: string[] = [];
  for (const [name, isDir] of children) {
    if (isDir) {
      const sha = await buildTree(`${prefix}${name}/`);
      entries.push(`040000 tree ${sha}\t${name}`);
    } else {
      entries.push(`100644 blob ${blobs.get(`${prefix}${name}`)}\t${name}`);
    }
  }
  entries.sort((a, b) => {
    const nameOf = (entry: string) => {
      const name = entry.slice(entry.indexOf("\t") + 1);
      return entry.startsWith("040000") ? `${name}/` : name;
    };
    return nameOf(a) < nameOf(b) ? -1 : nameOf(b) < nameOf(a) ? 1 : 0;
  });
  return gitWithInput(["mktree"], `${entries.join("\n")}\n`);
}

const rootTree = await buildTree("");
const commit = await git(
  "commit-tree",
  rootTree,
  "-m",
  "docs: assemble the Cirth docs-site tree (generated by scripts/docs-site-prepare.ts)",
);
await git("branch", "-f", BRANCH, commit);

console.log(
  `docs-site-prepare: ${assembled.size} pages, ${totalRewrites} links ` +
    `rewritten → branch ${BRANCH} @ ${commit.slice(0, 12)}`,
);
console.log("Next: git push -f origin docs-site");
