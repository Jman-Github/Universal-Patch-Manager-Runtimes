import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const body = [
  "This pull request merges `dev` into `main`.",
  "",
  "Merge when the runtime changes are ready for a stable release.",
  "Merging to `main` runs the Release workflow for affected runtimes.",
].join("\n");

export function openDevPullRequest(repo, gh) {
  // Unlike "gh pr list --head dev", the REST filter also identifies the owner.
  const owner = repo.split("/")[0];
  const existing = JSON.parse(gh([
    "api", `repos/${repo}/pulls?state=open&base=main&head=${encodeURIComponent(owner + ":dev")}`,
  ]));
  if (existing.length) return { status: "existing", url: existing[0].html_url };

  const comparison = JSON.parse(gh([
    "api", `repos/${repo}/compare/main...dev`,
  ]));
  // Release backmerges can add a commit without changing the resulting tree.
  if (comparison.ahead_by === 0 || comparison.files.length === 0) {
    return { status: "unchanged" };
  }

  const directory = mkdtempSync(join(tmpdir(), "upm-dev-pr-"));
  const bodyFile = join(directory, "body.md");
  try {
    writeFileSync(bodyFile, body);
    const url = gh([
      "pr", "create", "--repo", repo, "--base", "main", "--head", "dev",
      "--title", "chore: merge dev into main", "--body-file", bodyFile, "--draft",
    ]).trim();
    return { status: "created", url };
  } finally {
    try { unlinkSync(bodyFile); } finally { rmdirSync(directory); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GH_REPO;
  if (!repo) throw new Error("GH_REPO is required");
  const result = openDevPullRequest(repo, args =>
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  );
  console.log(JSON.stringify(result));
}
