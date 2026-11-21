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
test("release inputs follow their build consumers", () => {
  const all = Object.keys(runtimes);
  const jvmHosts = all.filter(id => id !== "reseam");
  const buildSrc = "buildSrc/src/main/kotlin/";
  const catalog = "gradle/libs.versions.toml";
  const transform = buildSrc + "PatcherClassMergerCompatTransform.kt";
  const consumers = (paths, lines) => all.filter(id => affectsRuntime(id, paths, lines));
  const cases = [
    [buildSrc + "LegacyRuntimeAssetsTask.kt", ["revanced-v21"]],
    [buildSrc + "ExtensionClassMergerFix.kt", jvmHosts],
    [transform, jvmHosts],
    [buildSrc + "PluginJvmHostTask.kt", jvmHosts],
    [buildSrc + "ShrinkJarTask.kt", jvmHosts],
    [buildSrc + "XzArchive.kt", ["shared-support"]],
    ["jvm-host/src/main/kotlin/HostMain.kt", jvmHosts],
    ["host-support/src/main/java/app/universal/patch/manager/patcher/runtime/usage/CpuUsageSampler.kt", ["morphe"]],
    ["host-support/src/main/java/app/universal/patch/manager/patcher/split/ApkEditorMergeProcess.java",
      ["revanced-v22", "shared-support"]],
    ["shared/revanced22/src/main/java/Entry.kt", ["revanced-v22"]],
    ["shared/runtime-plugin/src/main/java/Entry.kt", ["revanced-v21", "reseam"]],
    ["shared/runtime-framework/src/main/java/Framework.kt", ["revanced-v22", "shared-support"]],
    ["shared/merger-apkeditor/src/main/java/Merger.kt", ["revanced-v21", "revanced-v22", "reseam"]],
    ["shared/merger-arsclib/src/main/java/Merger.kt", ["revanced-v22", "morphe", "shared-support"]],
    ["libs/APKEditor-1.4.7.jar", ["revanced-v21", "revanced-v22", "reseam"]],
    ["shared/merger/src/main/java/Merger.kt", all],
    ["settings.gradle.kts", all],
    ["buildSrc/build.gradle.kts", all],
    [buildSrc + "NewSharedTask.kt", all],
    ["reseam-runtime/src/test/java/RuntimeTest.kt", []],
    ["jvm-host/src/test/kotlin/PersistentHostTest.kt", []],
    ["upm-patcher-core/README.md", []],
    ["shared-support/CHANGELOG.md", []],
  ];
  for (const [path, expected] of cases) assert.deepEqual(consumers([path]), expected, path);

  assert.deepEqual(consumers([catalog], {[catalog]: ['revanced-patcher = "21.1.0"']}), ["revanced-v21"]);
  assert.deepEqual(consumers([catalog], {[catalog]: ['revanced-patcher-v22 = "22.1.0"']}), ["revanced-v22"]);
  assert.deepEqual(consumers([catalog], {[catalog]: ['proguard = "7.8.2"']}), jvmHosts);
  assert.deepEqual(consumers([catalog], {[catalog]: ['arsclib = "abcdef"']}), ["revanced-v22", "morphe", "shared-support"]);
  assert.deepEqual(consumers([catalog], {[catalog]: ['hidden-api-stub = "4.3.3"']}), ["revanced-v21", "revanced-v22", "morphe"]);
  assert.deepEqual(consumers([catalog], {[catalog]: ['apksig = "9.0.0"']}), all);
  assert.deepEqual(consumers([transform], {[transform]: ['"revanced-patcher-21.1.0.jar",', '"patcher-jvm-22.1.0.jar"']}),
    ["revanced-v21", "revanced-v22"]);
  assert.deepEqual(consumers([catalog], {[catalog]: ['revanced-patcher = "21.1.0"', 'kotlin = "2.4.21"']}), all);
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
    await check([logic], ["revanced-v21", "revanced-v22", "morphe", "shared-support"]);

    const originalCheck = '    check(zip.getEntry("assets/jvm/$abi.zip.xz") != null) { "Missing JVM image for $abi" }';
    const updatedCheck = [
      '    val image = "assets/jvm/liberica-gpkg-2/$abi.zip.xz"',
      '    check(zip.getEntry(image) != null) { "Missing JVM image at $image" }',
    ].join("\n");
    const rootBuild = check => 'allprojects {}\nif (project.name == "shared-support") {\n' + check + '\n}\n';
    put("build.gradle.kts", rootBuild(originalCheck));
    const beforeLiberica = save("chore: establish package verifier");
    git("checkout", "-b", "liberica");
    put("build.gradle.kts", rootBuild(updatedCheck));
    for (const task of ["EmbeddedJvmAssetsTask", "PinnedDownloads", "PrepareEmbeddedJvmTask", "PrepareGlibcTask"]) {
      put("buildSrc/src/main/kotlin/" + task + ".kt", "// build a shared-support JVM image\n");
    }
    put("shared-support/build.gradle.kts", 'val jvm = "Liberica 25"\n');
    const liberica = save("perf(shared-support): package Liberica 25 with glibc");
    await check([liberica], ["shared-support"]);

    for (const id of Object.keys(runtimes)) {
      // A previous engine's tag can predate the shared-support change. Check both
      // per-commit filtering and the comparison against the published tree.
      const releaseContext = {
        ...context, commits: [liberica], lastRelease: {gitHead: beforeLiberica.hash},
        nextRelease: {gitHead: liberica.hash},
      };
      assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], releaseContext),
        id === "shared-support" ? "patch" : null, id);
    }

    git("checkout", "main");
    const mergeMessage = "perf: merge Liberica support";
    git("merge", "--no-ff", "liberica", "-m", mergeMessage);
    await check([{hash:git("rev-parse", "HEAD"), message:mergeMessage}], ["shared-support"]);

    put("build.gradle.kts", rootBuild(originalCheck).replace("allprojects {}", "allprojects { version = \"2\" }"));
    await check([save("fix: change support verification and shared Gradle logic")], Object.keys(runtimes));

    put("shared/merger/src/main/java/Merger.kt", "class Merger\n");
    await check([save("fix: update shared merger")], Object.keys(runtimes));
    put("jvm-host/src/main/kotlin/HostMain.kt", "fun main() {}\n");
    await check([save("fix: update JVM host")], ["revanced-v21", "revanced-v22", "morphe", "shared-support"]);

    put("reseam-runtime/src/test/java/RuntimeTest.kt", "class RuntimeTest\n");
    put("shared-support/CHANGELOG.md", "Release notes\n");
    await check([save("fix: update regression coverage and release notes")], []);
  } finally { rmSync(cwd, {recursive:true, force:true}); }
});

test("shared lines resembling diff headers still release all transform consumers", async () => {
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
    for (const id of Object.keys(runtimes)) {
      const usesTransform = id !== "reseam";
      assert.equal(filterCommits(id, context).length, usesTransform ? 1 : 0, `${id}: ${commit.message}`);
      assert.equal(await analyzeCommits(releaseConfig(id).plugins[0][1], context), usesTransform ? "patch" : null, id);
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
