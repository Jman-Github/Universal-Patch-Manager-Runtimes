import {execFileSync} from "node:child_process";
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {releaseConfig, runtimes} from "./runtime-release-config.mjs";
import {success as backmerge} from "@cleyrop-org/semantic-release-backmerge";

const runCommand = (command, args) =>
  execFileSync(command, args, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]}).trim();

// Only retry the idempotent notes push. Preserve failures once retries are exhausted.
export async function retryNotesPush(push, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return push(); }
    catch (error) {
      if (attempt === 2) throw error;
      await wait(2000 * (attempt + 1));
    }
  }
}

export function releaseNotes(changelog, version) {
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find(text => new RegExp("^## \\[?" + version.replaceAll(".", "\\.") +
    "(?:\\]|\\s|\\()").test(text));
  if (!section) throw new Error("Missing changelog section for " + version);
  return section.trim();
}

async function finishRecoveredRelease(id, branch, tag, notes, repository) {
  if (branch !== "main") return;
  const options = {...releaseConfig(id), repositoryUrl: "https://github.com/" + repository + ".git"};
  const config = options.plugins.find(([name]) => name === "@cleyrop-org/semantic-release-backmerge")[1];
  await backmerge(config, {
    cwd: process.cwd(), env: process.env, options, branch: {name: branch},
    nextRelease: {version: tag.slice(id.length + 2), gitTag: tag, notes},
    lastRelease: {}, logger: {log: console.log, error: console.error},
  });
}

export async function recoverRuntimeRelease(id, branch, {
  run = runCommand,
  wait,
  repository = process.env.GITHUB_REPOSITORY,
  assetsRoot = "runtime-release-assets",
  afterPublish = finishRecoveredRelease,
} = {}) {
  if (!runtimes[id] || !["main", "dev"].includes(branch)) throw new Error("Invalid runtime recovery target");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required for release recovery");
  const tags = run("git", ["tag", "--merged", branch, "--sort=-version:refname", "--list", id + "-v*"])
    .split("\n").filter(Boolean);
  const tag = tags.find(tag => {
    const version = tag.slice(id.length + 2);
    return branch === "main" ? /^\d+\.\d+\.\d+$/.test(version) : /^\d+\.\d+\.\d+-dev\.\d+$/.test(version);
  });
  if (!tag) return false;
  const version = tag.slice(id.length + 2);
  // Bootstrap or hand-created tags are not evidence of an interrupted semantic release.
  const subject = run("git", ["show", "-s", "--format=%s", tag]);
  if (subject !== "chore(" + id + "): release " + tag + " [skip ci]") return false;

  // Listing succeeds for an absent release, while authentication/network errors still fail.
  const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp",
    "repos/" + repository + "/releases?per_page=100"])).flat();
  const release = releases.find(item => item.tag_name === tag);
  if (release && !release.draft) return false;

  const module = runtimes[id][0];
  const notes = releaseNotes(run("git", ["show", tag + ":" + module + "/CHANGELOG.md"]), version);
  const temporary = mkdtempSync(join(tmpdir(), "upm-release-recovery-"));
  try {
    console.log("Recovering interrupted runtime release " + tag);
    // Build precisely the source that was tagged, including its recorded versionCode.
    run("git", ["checkout", "--detach", tag]);
    run("bash", [".github/scripts/prepare-semantic-release.sh", id, version, branch]);
    run("git", ["diff", "--exit-code", "--", module + "/version.properties", module + "/CHANGELOG.md"]);
    const noteRef = "semantic-release-" + tag;
    const remoteNote = run("git", ["ls-remote", "origin", "refs/notes/" + noteRef]);
    if (remoteNote) {
      run("git", ["fetch", "origin", "refs/notes/" + noteRef]);
    } else {
      // semantic-release uses null for the default stable channel.
      run("git", ["notes", "--ref", noteRef, "add", "-f", "-m",
        JSON.stringify({channels: [branch === "dev" ? "dev" : null]}), tag]);
      await retryNotesPush(() => run("git", ["push", "origin", "refs/notes/" + noteRef]), wait);
    }
    const directory = join(assetsRoot, id);
    const assets = readdirSync(directory).map(name => join(directory, name));
    if (!assets.some(path => path.endsWith(".apk"))) throw new Error("Recovery produced no APK");
    const notesFile = join(temporary, "notes.md");
    writeFileSync(notesFile, notes);
    if (!release) {
      run("gh", ["release", "create", tag, "--repo", repository, "--verify-tag", "--draft",
        "--title", tag, "--notes-file", notesFile, ...(branch === "dev" ? ["--prerelease"] : [])]);
    }
    // Upload everything before making the release visible. A failed upload remains resumable.
    run("gh", ["release", "upload", tag, "--repo", repository, "--clobber", ...assets]);
    run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false",
      "--prerelease=" + (branch === "dev"), "--title", tag, "--notes-file", notesFile]);
    await afterPublish(id, branch, tag, notes, repository);
    return true;
  } finally {
    try { run("git", ["checkout", branch]); }
    finally { rmSync(temporary, {recursive: true, force: true}); }
  }
}
