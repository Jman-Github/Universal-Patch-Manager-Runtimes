import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {execFileSync} from "node:child_process";
import {affectsRuntime, releaseConfig, runtimes, selectedRuntimes} from "./runtime-release-config.mjs";
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
    const baseline = commit("docs/README.md", "docs: baseline");
    git("branch", "ci-only");
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

    git("checkout", "ci-only");
    const workflow = commit(".github/workflows/build.yml", "fix(ci): retry runtime builds");
    const script = commit(".github/scripts/assemble-release.sh", "fix(reseam): retry Gradle downloads");
    git("checkout", "main");
    const mergeMessage = "fix(ci): merge build automation";
    git("merge", "--no-ff", "ci-only", "-m", mergeMessage);
    const merge = {hash:git("rev-parse", "HEAD"), message:mergeMessage};
    git("tag", "reseam-v1.0.0");
    git("checkout", "ci-only");
    const followup = commit(".github/workflows/release.yml", "fix(ci): update release automation");
    const syncMessage = "fix(ci): sync release branch";
    git("merge", "--no-ff", "main", "-m", syncMessage);
    const sync = {hash:git("rev-parse", "HEAD"), message:syncMessage};
    git("checkout", "main");
    git("merge", "--no-ff", "ci-only", "-m", "chore: merge CI followup");

    git("checkout", "-b", "stale-ci", baseline.hash);
    git("merge", "--no-ff", "main", "-m", syncMessage);
    const staleSync = {hash:git("rev-parse", "HEAD"), message:syncMessage};
    git("checkout", "main");
    git("merge", "--no-ff", "stale-ci", "-m", "chore: merge branch sync");

    const ciOnly = {...context, commits:[workflow, script, merge, followup, sync, staleSync]};
    assert.deepEqual(filterCommits("reseam", ciOnly), []);
    for (const id of Object.keys(runtimes)) {
      assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], ciOnly), null, id);
    }

    writeFileSync(join(cwd, ".github/workflows/build.yml"), "update review build");
    const mixed = commit("reseam-runtime/build.gradle.kts", "fix(ci): update ReSeam SDK and review build");
    for (const id of Object.keys(runtimes)) {
      assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], {...context, commits:[mixed]}),
        id === "reseam" ? "patch" : null, id);
    }

    git("branch", "ci-from-topic");
    git("branch", "released-options");
    git("checkout", "-b", "released-topic");
    commit("reseam-runtime/src/Entry.kt", "fix(reseam): repair session loading");
    git("checkout", "main");
    git("merge", "--no-ff", "released-topic", "-m", "chore: merge ReSeam fix");
    git("checkout", "released-options");
    commit("reseam-runtime/src/Options.kt", "fix(reseam): restore option defaults");
    git("checkout", "main");
    git("merge", "--no-ff", "released-options", "-m", "chore: merge ReSeam options");
    git("tag", "reseam-v1.0.1");
    git("checkout", "ci-from-topic");
    commit(".github/workflows/build.yml", "fix(ci): improve build diagnostics");
    git("merge", "--no-ff", "released-topic", "-m", "fix(ci): sync released code");
    git("checkout", "main");
    git("merge", "--no-ff", "ci-from-topic", "-m", "chore: merge diagnostics");

    const lastRelease = {gitHead:git("rev-parse", "reseam-v1.0.1")};
    const sinceRelease = () => git("log", "--format=%H", lastRelease.gitHead + "..HEAD").split("\n")
      .map(hash => ({hash, message:git("show", "-s", "--format=%B", hash)}));
    const analyzeReseam = () => analyzeCommits(releaseConfig("reseam").plugins[0][1],
      {...context, lastRelease, commits:sinceRelease()});
    assert.equal(await analyzeReseam(), null, "sync of one previously released topic");

    git("checkout", "-b", "ci-from-two-topics", "released-options");
    git("merge", "--no-ff", "released-topic", "-m", "feat(ci): sync released topics");
    commit(".github/workflows/logs.yml", "fix(ci): show build diagnostics on failure");
    git("checkout", "main");
    git("merge", "--no-ff", "ci-from-two-topics", "-m", "chore: merge diagnostic logging");
    assert.equal(await analyzeReseam(), null, "sync of two previously released topics");

    git("checkout", "-b", "merge-with-runtime-rollback", "released-topic");
    git("merge", "--no-ff", "--no-commit", "released-options");
    git("restore", "--source=HEAD", "--staged", "--worktree", "--", "reseam-runtime/src/Options.kt");
    git("commit", "-m", "fix(reseam): roll back option defaults");
    git("checkout", "main");
    git("merge", "--no-ff", "merge-with-runtime-rollback", "-m", "chore: merge option rollback");
    assert.equal(await analyzeReseam(), "patch", "intentional merge rollback to a parent's contents");

    commit("reseam-runtime/src/Entry.kt", "fix(reseam): handle a missing session");
    assert.equal(await analyzeReseam(), "patch", "new runtime change after a CI sync");

    git("checkout", "-b", "merge-with-runtime-edit", "released-options");
    git("merge", "--no-ff", "--no-commit", "released-topic");
    const mergeEdit = commit("reseam-runtime/src/Session.kt", "feat(reseam): add session validation");
    git("checkout", "main");
    git("merge", "--no-ff", "merge-with-runtime-edit", "-m", "chore: merge session validation");
    assert(filterCommits("reseam", {...context, lastRelease, commits:sinceRelease()})
      .some(commit => commit.hash === mergeEdit.hash));
    assert.equal(await analyzeReseam(), "minor", "new runtime code written during a merge");
  } finally { rmSync(cwd, {recursive:true,force:true}); }
});

test("a cherry-picked fix with identical runtime inputs does not bump the version", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-runtime-cherry-pick-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  const entry = "reseam-runtime/src/Entry.kt";
  const workflow = ".github/workflows/build.yml";
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), {recursive:true});
    writeFileSync(join(cwd, path), content);
  };
  const commit = (path, content, message) => {
    write(path, content);
    git("add", "--", path);
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    commit(entry, "original", "chore: baseline");
    git("branch", "ci");
    const publishedFix = commit(entry, "fixed", "fix(reseam): handle missing settings");
    git("tag", "reseam-v1.0.0");

    git("checkout", "ci");
    commit(workflow, "retry the build", "fix(ci): retry workflow");
    git("cherry-pick", publishedFix);
    git("checkout", "main");
    git("merge", "--no-ff", "ci", "-m", "chore: merge CI fix");

    const config = releaseConfig("reseam").plugins[0][1];
    const analyzeHead = () => analyzeCommits(config, {
      cwd, logger: {log() {}}, options: {}, lastRelease: {gitHead: publishedFix},
      commits: git("log", "--format=%H", publishedFix + "..HEAD").split("\n")
        .map(hash => ({hash, message: git("show", "-s", "--format=%B", hash)})),
    });
    assert.equal(git("diff", "--name-only", publishedFix, "HEAD"), workflow);
    assert.equal(await analyzeHead(), null);
    commit(entry, "additional fix", "fix(reseam): preserve the selected settings");
    assert.equal(await analyzeHead(), "patch");
  } finally { rmSync(cwd, {recursive:true, force:true}); }
});

test("SDK updates in shared build files release only their engines", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-sdk-history-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), {recursive:true});
    writeFileSync(join(cwd, path), text);
  };
  const save = message => {
    git("add", "."); git("commit", "-m", message);
    return {hash:git("rev-parse", "HEAD"), message};
  };
  const catalog = "gradle/libs.versions.toml";
  const transform = "buildSrc/src/main/kotlin/PatcherClassMergerCompatTransform.kt";
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    put(catalog, '[versions]\nmorphe-patcher = "2.1.0"\nkotlin = "2.4.10"\n');
    put(transform, 'val affected = setOf(\n    "morphe-patcher-2.1.0.jar",\n)\n');
    put("reseam-runtime/build.gradle.kts", 'val reseamSdkVersion = "0.37.1"\n');
    save("chore: baseline");
    git("checkout", "-b", "dev");
    put(catalog, '[versions]\nmorphe-patcher = "2.2.0"\nkotlin = "2.4.10"\n');
    put(transform, 'val affected = setOf(\n    "morphe-patcher-2.1.0.jar",\n    "morphe-patcher-2.2.0.jar",\n)\n');
    put("reseam-runtime/build.gradle.kts", 'val reseamSdkVersion = "0.38.0"\n');
    const update = save("fix(runtimes): update ReSeam and Morphe");
    const context = {cwd, commits:[update], logger:{log(){}}, options:{}};
    const check = async (commits, expected) => {
      for (const id of ["morphe", "reseam", "revanced-v21", "revanced-v22", "shared-support"]) {
        const selected = {...context, commits};
        assert.equal(filterCommits(id, selected).length, expected.includes(id) ? commits.length : 0, id);
        assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], selected),
          expected.includes(id) ? "patch" : null, id);
      }
    };
    await check([update], ["morphe", "reseam"]);
    git("checkout", "main"); git("merge", "--no-ff", "dev", "-m", "fix: merge SDK updates");
    await check([{hash:git("rev-parse", "HEAD"), message:"fix: merge SDK updates"}], ["morphe", "reseam"]);
    put(catalog, '[versions]\nmorphe-patcher = "2.3.0"\nkotlin = "2.4.10"\n');
    await check([save("fix(morphe): update patcher")], ["morphe"]);
    put("reseam-runtime/build.gradle.kts", 'val reseamSdkVersion = "0.39.0"\n');
    await check([save("fix(reseam): update SDK")], ["reseam"]);
    put(catalog, '[versions]\nmorphe-patcher = "2.3.0"\nkotlin = "2.4.21"\n');
    const shared = save("fix: update shared Kotlin dependency");
    await check([shared], ["morphe", "reseam", "revanced-v21", "revanced-v22", "shared-support"]);
    put(transform, 'val affected = emptySet<String>()\n');
    const logic = save("fix: change shared transform logic");
    await check([logic], ["morphe", "reseam", "revanced-v21", "revanced-v22", "shared-support"]);
  } finally { rmSync(cwd, {recursive:true, force:true}); }
});

test("shared lines resembling diff headers still release all runtimes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-shared-diff-history-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding:"utf8"}).trim();
  const transform = "buildSrc/src/main/kotlin/PatcherClassMergerCompatTransform.kt";
  const put = (version, statement = "") => {
    mkdirSync(dirname(join(cwd, transform)), {recursive:true});
    writeFileSync(join(cwd, transform), "fun sharedCounter(): Int {\n    var count = 0\n" +
      (statement ? statement + "\n" : "") + '    val affected = setOf(\n        "morphe-patcher-' +
      version + '.jar",\n    )\n    return count\n}\n');
  };
  const save = message => {
    git("add", "."); git("commit", "-m", message);
    return {hash:git("rev-parse", "HEAD"), message};
  };
  const check = async commit => {
    const context = {cwd, commits:[commit], logger:{log(){}}, options:{}};
    for (const id of ["morphe", "reseam", "revanced-v21", "revanced-v22", "shared-support"]) {
      assert.equal(filterCommits(id, context).length, 1, `${id}: ${commit.message}`);
      assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], context), "patch", id);
    }
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    put("2.1.0"); save("chore: baseline");
    let version = 1;
    for (const statement of ["++count", "--count"]) {
      // Kotlin permits column-zero statements; their patch lines resemble file headers.
      put(`2.${++version}.0`, statement);
      await check(save(`fix: update Morphe and add shared ${statement}`));
      put(`2.${++version}.0`);
      await check(save(`fix: update Morphe and remove shared ${statement}`));
    }
  } finally { rmSync(cwd, {recursive:true, force:true}); }
});

test("matrix jobs select exactly one runtime and reject unknown targets", () => {
  assert.deepEqual(selectedRuntimes(), Object.keys(runtimes));
  for (const id of Object.keys(runtimes)) assert.deepEqual(selectedRuntimes(id), [id]);
  for (const id of ["", "unknown", "constructor", "__proto__"])
    assert.throws(() => selectedRuntimes(id), /Unknown runtime/);
});

test("release workflow attempts every runtime serially with independent checkouts", () => {
  const workflow = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8");
  const ids = workflow.match(/^        runtime: \[([^\]]+)\]$/m)[1].split(",").map(id => id.trim());
  assert.deepEqual(ids, Object.keys(runtimes));
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /max-parallel: 1/);
  assert(workflow.includes("RUNTIME_ID: ${{ matrix.runtime }}"));
  assert(workflow.includes("ref: ${{ github.ref_name }}"));
  assert(workflow.includes("name: runtime-release-${{ matrix.runtime }}"));
});
