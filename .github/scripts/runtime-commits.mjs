import {execFileSync} from "node:child_process";
import {analyzeCommits as analyze} from "@semantic-release/commit-analyzer";
import {generateNotes as notes} from "@semantic-release/release-notes-generator";
import {affectsRuntime, engineDependencyPaths} from "./runtime-release-config.mjs";

export function filterCommits(runtime, context) {
  return context.commits.filter(commit => {
    // Include both sides of merges and deleted/renamed paths.
    const paths = execFileSync("git", ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", commit.hash],
      {cwd: context.cwd}).toString().split("\0").filter(Boolean);
    const changedLines = {};
    for (const path of engineDependencyPaths.filter(path => paths.includes(path))) {
      const patch = execFileSync("git", ["diff-tree", "--root", "-m", "-p", "--no-color",
        "--no-ext-diff", "--no-renames", "--unified=0", commit.hash, "--", path],
        {cwd: context.cwd}).toString();
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
    return affectsRuntime(runtime, paths, changedLines);
  });
}
export async function analyzeCommits(config, context) {
  return analyze(config.analysis, {...context, commits: filterCommits(config.runtime, context)});
}
export async function generateNotes(config, context) {
  return notes({preset: "angular"}, {...context, commits: filterCommits(config.runtime, context)});
}
