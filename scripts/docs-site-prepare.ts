/**
 * The Cirth docs-site prepare step: assembles the `docs-site` orphan branch
 * that the Cirth GitHub importer consumes (bun-geos.cirth.app).
 *
 * Why a generated branch: the importer maps repo paths → page paths but does
 * NOT rewrite plain relative `.md` links between documents (only GitBook
 * `{% content-ref %}` constructs). The docs cross-link heavily (~60 links),
 * so this script rewrites every relative link to the final SITE-ABSOLUTE
 * page path, fails loudly on anything it cannot resolve (no silent 404s),
 * and commits the result as a root commit on `docs-site`. Re-run + push
 * after every release; the importer upserts pages by `github_path`.
 *
 * Layout contract (see the Cirth import path mapping):
 *   - `_index.md` is the ONLY root-level page. It slugifies to `index`, and
 *     `_` sorts before every letter, so it deterministically wins the
 *     first-root-page-created race and becomes the site home (`/`).
 *   - Everything else nests one level deep (design/, guide/, operations/,
 *     reference/, research/) or sits at the root as a top-level page
 *     (benchmarks, changelog, decisions, roadmap).
 *
 * Usage: bun run docs:site   (assemble + commit the branch; push separately)
 */

import { $ } from "bun";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

const GITHUB_RAW_BASE = "https://github.com/AbdukahharS/bun-geos";
const BRANCH = "docs-site";

/** Output path in the branch → source path in the repo. */
const SITE_FILES: Record<string, string> = {
  "_index.md": "README.md",
  "benchmarks.md": "docs/benchmarks.md",
  "changelog.md": "CHANGELOG.md",
  "decisions.md": "docs/decisions.md",
  "roadmap.md": "docs/ROADMAP.md",
  ...dir("design"),
  ...dir("guide"),
  ...dir("operations"),
  ...dir("reference"),
  ...dir("research"),
};

function dir(name: string): Record<string, string> {
  const files = Array.from(
    new Bun.Glob("*.md").scanSync({ cwd: `docs/${name}` }),
  ).sort();
  if (files.length === 0) {
    throw new Error(`docs-site-prepare: no markdown under docs/${name}`);
  }
  return Object.fromEntries(
    files.map((file) => [`${name}/${file}`, `docs/${name}/${file}`]),
  );
}

/** Repo path → literal URL, for targets that have no page on the site. */
const LINK_EXCEPTIONS: Record<string, string> = {
  LICENSE: `${GITHUB_RAW_BASE}/blob/main/LICENSE`,
  "docs/operations": `${GITHUB_RAW_BASE}/tree/main/docs/operations`,
};

/** Output path in the branch → public page path on the site. */
function pagePathOf(outputPath: string): string {
  if (outputPath === "_index.md") return "index";
  return outputPath.replace(/\.md$/, "");
}

/** Repo-relative source path → public page path (or null if unmapped). */
function pagePathForSource(sourcePath: string): string | null {
  for (const [output, source] of Object.entries(SITE_FILES)) {
    if (source === sourcePath) return pagePathOf(output);
  }
  return null;
}

/** Normalize `./`/`../` segments against a base directory. */
function resolveRepoPath(fromDir: string, link: string): string {
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

/** Rewrite links outside of ```/~~~ fences; return [content, rewriteCount]. */
function rewriteLinks(sourcePath: string, content: string): [string, number] {
  const fromDir = sourcePath.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
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
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:")
        ) {
          return whole;
        }
        const hash = target.indexOf("#");
        const path = hash === -1 ? target : target.slice(0, hash);
        const anchor = hash === -1 ? "" : target.slice(hash);
        const resolved = resolveRepoPath(fromDir, path);
        const mapped =
          pagePathForSource(resolved) ?? LINK_EXCEPTIONS[resolved + anchor];
        if (mapped === undefined) {
          throw new Error(
            `docs-site-prepare: unresolvable link ${JSON.stringify(target)} ` +
              `in ${sourcePath} (resolved to ${JSON.stringify(resolved)})`,
          );
        }
        rewrites += 1;
        const href = mapped.startsWith("http") ? mapped : `/${mapped}`;
        return `](${href}${anchor}${title})`;
      },
    );
  });
  return [out.join("\n"), rewrites];
}

function assertNoRelativeLinksLeft(outputPath: string, content: string): void {
  const lines = content.split("\n");
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
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

const ATTRIBUTION = [
  "",
  "---",
  "",
  "These docs live in the [bun-geos repository](https://github.com/AbdukahharS/bun-geos) " +
    "as plain Markdown and are served by [**Cirth**](https://cirth.app).",
  "",
];

async function git(...args: string[]): Promise<string> {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

async function gitWithInput(args: string[], input: string): Promise<string> {
  const tmp = `${tmpdir()}/docs-site-prepare-${crypto.randomUUID()}`;
  await Bun.write(tmp, input);
  try {
    const result = await $`git ${args} < ${tmp}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout.toString().trim();
  } finally {
    unlinkSync(tmp);
  }
}

// --- 1. Assemble + rewrite ---------------------------------------------------

const assembled = new Map<string, string>();
let totalRewrites = 0;
for (const [output, source] of Object.entries(SITE_FILES)) {
  const file = Bun.file(source);
  if (!(await file.exists())) {
    throw new Error(`docs-site-prepare: missing source ${source}`);
  }
  const [content, count] = rewriteLinks(source, await file.text());
  assertNoRelativeLinksLeft(output, content);
  const finalContent =
    output === "_index.md" ? content + ATTRIBUTION.join("\n") : content;
  assembled.set(output, finalContent);
  totalRewrites += count;
}

// --- 2. Plumb the orphan branch (no worktree, no index games) ----------------

const blobs = new Map<string, string>();
for (const [output, content] of assembled) {
  blobs.set(output, await gitWithInput(["hash-object", "-w", "--stdin"], content));
}

/** Build nested trees bottom-up; git sorts tree entries with dirs as `name/`. */
async function buildTree(prefix: string): Promise<string> {
  const children = new Map<string, { isDir: boolean; key: string }>();
  for (const output of assembled.keys()) {
    if (!output.startsWith(prefix)) continue;
    const rest = output.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    children.set(head, { isDir: tail.length > 0, key: rest });
  }
  const entries: string[] = [];
  for (const [name, { isDir }] of children) {
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
const commit = await git("commit-tree", rootTree, "-m",
  "docs: assemble the Cirth docs-site tree (generated by scripts/docs-site-prepare.ts)",
);
await git("branch", "-f", BRANCH, commit);

console.log(
  `docs-site-prepare: ${assembled.size} pages, ${totalRewrites} links ` +
    `rewritten → branch ${BRANCH} @ ${commit.slice(0, 12)}`,
);
console.log("Next: git push -f origin docs-site");
