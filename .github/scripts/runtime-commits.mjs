import {execFileSync} from "node:child_process";
import {analyzeCommits as analyze} from "@semantic-release/commit-analyzer";
import {generateNotes as notes} from "@semantic-release/release-notes-generator";
import {affectsRuntime, lineScopedPaths, runtimes} from "./runtime-release-config.mjs";
import {
  buildInputReader, catalogPath, hasRuntimeBuildInputs, isNonReleasePath, unchangedProductionScript,
} from "./runtime-build-inputs.mjs";

const diffTree = ["diff-tree", "--root", "--no-renames"];

function mergeComparisons({commits, cwd, lastRelease, nextRelease}) {
  const merges = execFileSync("git", ["log", "--no-walk=unsorted", "--merges", "--format=%H %P", "--stdin"],
    {cwd, encoding: "utf8", input: commits.map(({hash}) => hash).join("\n") + "\n"}).trim();
  if (!merges) return new Map();

  // A topic branch can merge in code already on the release branch. Compare
  // with its newest parent on the release branch's first-parent history.
  const history = execFileSync("git", ["rev-list", "--first-parent", nextRelease?.gitHead ?? "HEAD"],
    {cwd, encoding: "utf8"}).trim().split("\n");
  const releaseOrder = new Map(history.map((hash, index) => [hash, index]));
  const order = parent => releaseOrder.get(parent) ?? Infinity;
  const publishedHead = lastRelease?.gitHead;
  const publishedHistory = new Set(publishedHead ? execFileSync("git", ["rev-list", publishedHead],
    {cwd, encoding: "utf8"}).trim().split("\n") : []);
  return new Map(merges.split("\n").map(line => {
    const [hash, ...parents] = line.split(" ");
    if (parents.every(parent => publishedHistory.has(parent))) {
      return [hash, {base: publishedHead, publishedParentCount: parents.length}];
    }
    const firstParentBase = parents.reduce((latest, parent) => order(parent) < order(latest) ? parent : latest);
    const base = releaseOrder.has(firstParentBase) ? firstParentBase :
      parents.find(parent => publishedHistory.has(parent)) ?? firstParentBase;
    return [hash, {base}];
  }));
}

function changedPaths(cwd, revisions) {
  return execFileSync("git", [...diffTree, "--no-commit-id", "--name-only", "-r", "-z", ...revisions],
    {cwd, encoding: "utf8"}).split("\0").filter(Boolean);
}

function diffAffectsRuntime(runtime, cwd, revisions, paths, readInputs) {
  // CI/docs-only commits need no Gradle model. Other paths can belong to a
  // project reached through a release dependency, including a new project.
  const [before, after] = paths.some(path => !isNonReleasePath(path)) ?
    readInputs(revisions) : [];
  const snapshots = before && after ? [before, after] : [];
  const relevantPaths = paths.filter(path => !unchangedProductionScript(path, snapshots));
  const catalogModeled = hasRuntimeBuildInputs(runtime, snapshots);
  const changedLines = {};
  for (const path of relevantPaths.filter(path => lineScopedPaths.includes(path) &&
      !(catalogModeled && path === catalogPath))) {
    const patch = execFileSync("git", [...diffTree, "-p", "--no-color",
      "--no-ext-diff", "--unified=0", ...revisions, "--", path],
      {cwd}).toString();
    const lines = [];
    let inHunk = false;
    for (const line of patch.split("\n")) {
      if (line.startsWith("diff --git ")) inHunk = false;
      else if (line.startsWith("@@ ")) inHunk = true;
      // Source lines beginning with ++ or -- are not file headers inside a hunk.
      else if (inHunk && /^[+-]/.test(line)) lines.push(line.slice(1));
    }
    changedLines[path] = lines;
  }
  return affectsRuntime(runtime, relevantPaths, changedLines, snapshots);
}

export function filterCommits(runtime, context, readInputs = buildInputReader(context.cwd, runtimes)) {
  if (!context.commits.length) return [];
  const comparisons = mergeComparisons(context);
  return context.commits.filter(commit => {
    const comparison = comparisons.get(commit.hash);
    const revisions = comparison ? [comparison.base, commit.hash] : [commit.hash];
    let paths = changedPaths(context.cwd, revisions);
    if (comparison?.publishedParentCount && paths.length) {
      const mergePaths = new Set(changedPaths(context.cwd, ["--diff-merges=combined", commit.hash]));
      if (comparison.publishedParentCount === 2) {
        // Recreating the automatic merge also exposes explicit resolutions that match a parent.
        for (const path of changedPaths(context.cwd, ["--diff-merges=remerge", commit.hash])) {
          mergePaths.add(path);
        }
      }
      paths = paths.filter(path => mergePaths.has(path));
    }
    return diffAffectsRuntime(runtime, context.cwd, revisions, paths, readInputs);
  });
}
export async function analyzeCommits(config, context) {
  const {runtime, analysis} = config;
  const readInputs = buildInputReader(context.cwd, runtimes);
  const releaseType = await analyze(analysis, {...context, commits: filterCommits(runtime, context, readInputs)});
  const publishedHead = context.lastRelease?.gitHead;
  if (!releaseType || !publishedHead) return releaseType;

  // A cherry-pick can replay a release-worthy message with identical runtime inputs.
  const revisions = [publishedHead, context.nextRelease?.gitHead ?? "HEAD"];
  const paths = changedPaths(context.cwd, revisions);
  return diffAffectsRuntime(runtime, context.cwd, revisions, paths, readInputs) ? releaseType : null;
}
export async function generateNotes(config, context) {
  return notes({preset: "angular"}, {...context, commits: filterCommits(config.runtime, context)});
}
