import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {execFileSync} from "node:child_process";
import {Writable} from "node:stream";
import semanticRelease from "semantic-release";

test("semantic-release keeps each tag namespace and computes dev prereleases", async () => {
  const root = mkdtempSync(join(tmpdir(), "upm-semantic-engine-"));
  const cwd = join(root, "work");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  const sink = new Writable({write(chunk, encoding, callback) { callback(); }});
  try {
    git("init", "--bare", "-b", "main", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(cwd, "source"), "baseline"); git("add", "."); git("commit", "-m", "chore: baseline");
    git("tag", "morphe-v1.0.0"); git("tag", "reseam-v1.5.0");
    git("remote", "add", "origin", remote); git("branch", "dev");
    git("push", "origin", "main", "dev", "--tags");
    writeFileSync(join(cwd, "source"), "fixed"); git("add", "."); git("commit", "-m", "fix: patch");
    git("push", "origin", "main");
    const run = (id) => semanticRelease({branches:["main",{name:"dev", prerelease:"dev"}],
      repositoryUrl:pathToFileURL(remote).href, tagFormat:id+"-v${version}", dryRun:true, ci:false,
      plugins:[{analyzeCommits:async()=> "patch", generateNotes:async()=> "fixture"}]},
      {cwd, env:{...process.env, GITHUB_ACTIONS:"", GITHUB_REF:"", GITHUB_REF_NAME:"", CI:""}, stdout:sink, stderr:sink});
    const stable = await run("morphe");
    assert.equal(stable.nextRelease.gitTag, "morphe-v1.0.1");
    assert.equal((await run("reseam")).nextRelease.gitTag, "reseam-v1.5.1");
    git("checkout", "dev"); git("merge", "--ff-only", "main"); git("push", "origin", "dev");
    const pre = await run("morphe");
    assert.equal(pre.nextRelease.gitTag, "morphe-v1.0.1-dev.1");
    assert.equal(git("tag", "--list", "*v1.0.1*"), "", "Dry-run must not publish a tag");
  } finally { rmSync(root, {recursive:true,force:true}); }
});


test("release commits, tags, backmerges and stable promotion work across runtimes", async () => {
  const {releaseConfig, runtimes} = await import("./runtime-release-config.mjs");
  const root = mkdtempSync(join(tmpdir(), "upm-runtime-pipeline-"));
  const cwd = join(root, "work");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  const sink = new Writable({write(chunk, encoding, callback) { callback(); }});
  const script = name => fileURLToPath(new URL(name, import.meta.url));
  const plugin = name => fileURLToPath(new URL("../../node_modules/" + name, import.meta.url));
  try {
    git("init", "--bare", "-b", "main", remote);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    for (const [module, version] of [["morphe-runtime", "1.0.0"], ["reseam-runtime", "1.5.0"]]) {
      mkdirSync(join(cwd,module), {recursive:true});
      writeFileSync(join(cwd,module,"version.properties"), "versionName="+version+"\nversionCode=2\n");
    }
    git("add", "."); git("commit", "-m", "chore: baseline");
    git("tag", "morphe-v1.0.0"); git("tag", "reseam-v1.5.0");
    git("remote", "add", "origin", remote); git("branch", "dev");
    git("push", "origin", "main", "dev", "--tags");
    mkdirSync(join(cwd,"shared"), {recursive:true});
    writeFileSync(join(cwd,"shared/Host.kt"), "feature");
    git("add", "."); git("commit", "-m", "feat: shared feature"); git("push", "origin", "main");
    const run = async id => {
      const config = releaseConfig(id);
      const module = runtimes[id][0];
      const plugins = [
        [script("./runtime-commits.mjs"), config.plugins[0][1]],
        [plugin("@semantic-release/changelog/index.js"), config.plugins[1][1]],
        {prepare: async (_, context) => writeFileSync(join(cwd,module,"version.properties"),
          "versionName="+context.nextRelease.version+"\nversionCode=3\n")},
        [script("./release-git.mjs"), config.plugins[3][1]],
        {publish:async()=> ({name:"Local fixture publication"})},
        [plugin("@cleyrop-org/semantic-release-backmerge/dist/index.js"), {...config.plugins[5][1], fetchDelay:0}],
      ];
      return semanticRelease({...config, plugins, repositoryUrl:pathToFileURL(remote).href, ci:false, noCi:true},
        {cwd, env:{...process.env, GITHUB_ACTIONS:"", GITHUB_REF:"", GITHUB_REF_NAME:"", CI:""}, stdout:sink, stderr:sink});
    };
    for (const [id, version] of [["morphe","1.1.0"],["reseam","1.6.0"]]) {
      git("checkout", "main");
      const result = await run(id);
      assert.equal(result.nextRelease.gitTag, id+"-v"+version);
      const tagged = git("show", result.nextRelease.gitTag+":"+runtimes[id][0]+"/version.properties");
      assert.match(tagged, new RegExp("versionName="+version.replaceAll(".","\\.")));
    }
    assert.equal(git("rev-parse", "origin/dev"), git("rev-parse", "origin/main"));
    git("checkout", "dev");
    writeFileSync(join(cwd,"morphe-runtime/Fix.kt"), "fix");
    git("add", "."); git("commit", "-m", "fix(morphe): repair feature"); git("push", "origin", "dev");
    const pre = await run("morphe");
    assert.equal(pre.nextRelease.gitTag, "morphe-v1.1.1-dev.1");
    git("checkout", "dev");
    assert.equal(await run("reseam"), false, "Another runtime must not receive this prerelease");
    git("checkout", "main"); git("merge", "--ff-only", "dev"); git("push", "origin", "main");
    const stable = await run("morphe");
    assert.equal(stable.nextRelease.gitTag, "morphe-v1.1.1");
    assert.equal(git("rev-parse", "origin/dev"), git("rev-parse", "origin/main"));
  } finally { rmSync(root, {recursive:true,force:true}); }
});
