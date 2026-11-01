import {execFileSync} from "node:child_process";
import {analyzeCommits as analyze} from "@semantic-release/commit-analyzer";
import {generateNotes as notes} from "@semantic-release/release-notes-generator";
import {affectsRuntime} from "./runtime-release-config.mjs";

export function filterCommits(runtime, context) {
  return context.commits.filter(commit => {
    // Include both sides of merges and deleted/renamed paths.
    const paths = execFileSync("git", ["diff-tree", "--root", "-m", "--no-commit-id", "--name-only", "-r", "-z", commit.hash],
      {cwd: context.cwd}).toString().split("\0").filter(Boolean);
    return affectsRuntime(runtime, paths);
  });
}
export async function analyzeCommits(config, context) {
  return analyze(config.analysis, {...context, commits: filterCommits(config.runtime, context)});
}
export async function generateNotes(config, context) {
  return notes({preset: "angular"}, {...context, commits: filterCommits(config.runtime, context)});
}
