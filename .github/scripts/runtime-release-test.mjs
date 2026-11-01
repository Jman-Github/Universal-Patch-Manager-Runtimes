import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {execFileSync} from "node:child_process";
import {affectsRuntime, releaseConfig} from "./runtime-release-config.mjs";
import {analyzeCommits, filterCommits} from "./runtime-commits.mjs";

test("configuration matches UPM branches, tags and publication plugins", () => {
  const config = releaseConfig("morphe");
  assert.deepEqual(config.branches, ["main", {name:"dev", prerelease:"dev"}]);
  assert.equal(config.tagFormat, "morphe-v${version}");
  assert.equal(config.plugins.find(([name]) => name === "@semantic-release/github")[1].assets[0].path,
    "runtime-release-assets/morphe/*");
  assert.equal(config.plugins.at(-1)[0], "@cleyrop-org/semantic-release-backmerge");
});
test("shared code reaches consumers while engine code remains independent", () => {
  assert(affectsRuntime("morphe", ["morphe-runtime/src/Entry.kt"]));
  assert(!affectsRuntime("reseam", ["morphe-runtime/src/Entry.kt"]));
  assert(affectsRuntime("revanced-v21", ["revanced-legacy-patcher-core/src/Entry.kt"]));
  assert(!affectsRuntime("morphe", ["docs/README.md"]));
  for (const id of ["morphe", "reseam", "revanced-v21", "revanced-v22", "shared-support"])
    assert(affectsRuntime(id, ["host-support/src/Host.kt"]));
});
test("real git history and UPM's analyzer release only affected runtimes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-runtime-history-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  try {
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    const commit = (path, message) => {
      mkdirSync(dirname(join(cwd,path)), {recursive:true}); writeFileSync(join(cwd,path), message);
      git("add", "."); git("commit", "-m", message);
      return {hash:git("rev-parse","HEAD"), message};
    };
    const commits = [
      commit("morphe-runtime/src/Entry.kt", "feat(morphe): add an option"),
      commit("reseam-runtime/src/Entry.kt", "fix(reseam): repair callbacks"),
      commit("docs/README.md", "docs: usage"),
    ];
    const context = {cwd, commits, logger:{log(){}}, options:{repositoryUrl:"https://example.invalid/repo"}};
    assert.deepEqual(filterCommits("morphe", context).map(c=>c.hash), [commits[0].hash]);
    assert.equal(await analyzeCommits(releaseConfig("morphe").plugins[0][1], context), "minor");
    assert.equal(await analyzeCommits(releaseConfig("reseam").plugins[0][1], context), "patch");
    assert.equal(await analyzeCommits(releaseConfig("shared-support").plugins[0][1], context), null);
    const shared = commit("shared/merger/src/Merger.kt", "fix: repair merger");
    assert.equal(await analyzeCommits(releaseConfig("morphe").plugins[0][1], {...context,commits:[shared]}), "patch");
    const breaking = commit("morphe-runtime/src/Entry.kt", "feat(morphe): replace protocol\n\nBREAKING CHANGE: callback contract changed");
    assert.equal(await analyzeCommits(releaseConfig("morphe").plugins[0][1], {...context,commits:[breaking]}), "major");
    const forced = commit("morphe-runtime/src/Entry.kt", "build(Needs bump): update SDK");
    assert.equal(await analyzeCommits(releaseConfig("morphe").plugins[0][1], {...context,commits:[forced]}), "patch");
  } finally { rmSync(cwd, {recursive:true,force:true}); }
});
