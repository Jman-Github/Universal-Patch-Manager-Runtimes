import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {execFileSync} from "node:child_process";
import {affectsRuntime, releaseConfig, runtimes, selectedRuntimes} from "./runtime-release-config.mjs";
import {analyzeCommits, filterCommits} from "./runtime-commits.mjs";
import {buildInputReader} from "./runtime-build-inputs.mjs";

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
    ["build.gradle", all],
    ["build.gradle.kts", all],
    ["settings.gradle", all],
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
  const catalogText = (patcher, kotlin) => [
    "[versions]",
    'morphe-patcher = "' + patcher + '"',
    'kotlin = "' + kotlin + '"',
    "[plugins]",
    'kotlin-parcelize = { id = "org.jetbrains.kotlin.plugin.parcelize", version.ref = "kotlin" }',
  ].join("\n");
  const reseamBuild = version =>
    'plugins { alias(libs.plugins.kotlin.parcelize) }\nval reseamSdkVersion = "' + version + '"\n';
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    put(catalog, catalogText("2.1.0", "2.4.10"));
    put(transform, 'val affected = setOf(\n    "morphe-patcher-2.1.0.jar",\n)\n');
    put("reseam-runtime/build.gradle.kts", reseamBuild("0.37.1"));
    save("chore: baseline");
    git("checkout", "-b", "dev");
    put(catalog, catalogText("2.2.0", "2.4.10"));
    put(transform, 'val affected = setOf(\n    "morphe-patcher-2.1.0.jar",\n    "morphe-patcher-2.2.0.jar",\n)\n');
    put("reseam-runtime/build.gradle.kts", reseamBuild("0.38.0"));
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
    put(catalog, catalogText("2.3.0", "2.4.10"));
    await check([save("fix(morphe): update patcher")], ["morphe"]);
    put("reseam-runtime/build.gradle.kts", reseamBuild("0.39.0"));
    await check([save("fix(reseam): update SDK")], ["reseam"]);
    put(catalog, catalogText("2.3.0", "2.4.21"));
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

test("release analysis traces catalog and shared inputs through committed Gradle projects", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-build-owners-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
  const put = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), {recursive: true});
    writeFileSync(join(cwd, file), content);
  };
  const commit = message => {
    git("add", ".");
    git("commit", "-m", message);
    return {hash: git("rev-parse", "HEAD"), message};
  };
  const catalog = "gradle/libs.versions.toml";
  const shared = "shared/new-source/src/main/kotlin/Helper.kt";
  const vendor = "libs/new-helper.jar";
  const catalogText = (version, unused, testVersion, groovyVersion = "1") => [
    "[versions]",
    'runtime-sdk = { strictly = "' + version + '" }',
    'unused = "' + unused + '"',
    'test-sdk = "' + testVersion + '"',
    "[libraries]",
    'sdk = { module = "example:sdk", version.ref = "runtime-sdk" }',
    'test-sdk = { module = "example:test-sdk", version.ref = "test-sdk" }',
    'groovy-sdk = "example:groovy-sdk:' + groovyVersion + '"',
    "[bundles]",
    'sdk-bundle = ["sdk"]',
  ].join("\n");
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const [id, [module]] of Object.entries(runtimes)) {
      if (id !== "revanced-v21") put(module + "/build.gradle.kts", "// Runtime");
    }
    put("morphe-runtime/build.gradle.kts", 'dependencies { jvmHost(project(":custom-host", "hostJar")) }');
    put("revanced.v22-runtime-plugin/build.gradle.kts", 'dependencies { jvmHost(project(":custom-host", "hostJar")) }');
    put("custom-host/build.gradle.kts", [
      'dependencies { implementation(project(path = ":helpers:library-consumer")) }',
      'kotlin.srcDir("../shared/new-source/src/main/kotlin")',
      'dependencies { implementation(files("../libs/new-helper.jar")) }',
    ].join("\n"));
    put("helpers/library-consumer/build.gradle.kts", "dependencies { implementation(libs.bundles.sdk.bundle) }");
    put("shared-support/build.gradle.kts", 'dependencies { implementation(project(":helpers:groovy-consumer")) }');
    put("helpers/groovy-consumer/build.gradle", [
      "/* A block comment mentioning its opener /* inline */",
      "dependencies { implementation(libs.groovy.sdk) }",
      'dependencies { testImplementation("example:groovy-test:1") }',
    ].join("\n"));
    put("reseam-runtime/build.gradle.kts", [
      "// dependencies { implementation(libs.bundles.sdk.bundle) }",
      "/* An outer comment /* with an inner note */",
      "   implementation(libs.test.sdk)",
      "*/",
      "dependencies {",
      "    testImplementation(libs.test.sdk)",
      '    testRuntimeOnly("example:test-runner:1")',
      "}",
    ].join("\n"));
    put("tests/fixtures/example/settings.gradle.kts", "val sdk = libs.test.sdk");
    put(catalog, catalogText("1", "1", "1"));
    const baseline = commit("chore: fixture");

    put(catalog, catalogText("2", "1", "1"));
    const bump = commit("fix: bump SDK");
    put(catalog, "# Catalog\n" + catalogText("2", "2", "2"));
    const testAndUnused = commit("fix: update test and unused dependency");
    const reseamBuild = "reseam-runtime/build.gradle.kts";
    put(reseamBuild, readFileSync(join(cwd, reseamBuild), "utf8").replace("test-runner:1", "test-runner:2"));
    const testBuild = commit("fix: update inline test dependency");
    put(shared, "new shared code");
    put(vendor, "new vendored dependency");
    put("helpers/library-consumer/src/main/kotlin/Entry.kt", "new host dependency code");
    const hostChange = commit("fix: update host inputs");
    const nestedTest = "helpers/library-consumer/src/test/kotlin/EntryTest.kt";
    const nestedReadme = "helpers/library-consumer/README.md";
    put(nestedTest, "test cases");
    put(nestedReadme, "test instructions");
    const tests = commit("fix: update host test cases and docs");
    const groovyBuild = "helpers/groovy-consumer/build.gradle";
    put(groovyBuild, readFileSync(join(cwd, groovyBuild), "utf8").replace("groovy-test:1", "groovy-test:2"));
    const groovyTest = commit("fix: bump Groovy module test dependency");
    put("revanced.v21-runtime-plugin/build.gradle.kts", "// Add another runtime after the SDK bump");
    const addedRuntime = commit("feat: add another runtime");

    const readInputs = buildInputReader(cwd, runtimes);
    const impacts = (before, after, paths) => {
      const snapshots = readInputs([before.hash, after.hash]);
      assert(snapshots.every(Boolean), "expected a complete Gradle fixture");
      return Object.keys(runtimes).filter(id =>
        snapshots.every(snapshot => snapshot.consumers.has(id)) && affectsRuntime(id, paths, {}, snapshots));
    };
    const expected = ["revanced-v22", "morphe"];
    const sdkHistory = {cwd, commits: [bump]};
    assert.deepEqual(["revanced-v22", "morphe", "reseam"].map(id =>
      filterCommits(id, sdkHistory).map(({hash}) => hash)), [[bump.hash], [bump.hash], []]);
    const withNewRuntime = {cwd, lastRelease: {gitHead: baseline.hash}, nextRelease: {gitHead: addedRuntime.hash},
      commits: [addedRuntime, bump]};
    assert.deepEqual(filterCommits("morphe", withNewRuntime), [bump]);
    assert.deepEqual(filterCommits("reseam", withNewRuntime), []);
    assert.deepEqual(impacts(baseline, bump, [catalog]), expected);
    assert.deepEqual({
      catalog: impacts(bump, testAndUnused, [catalog]),
      tests: impacts(hostChange, tests, [nestedTest]),
      docs: impacts(hostChange, tests, [nestedReadme]),
      productionResource: impacts(hostChange, tests,
        ["helpers/library-consumer/src/main/resources/example/src/test/value.txt"]),
      history: filterCommits("morphe", {cwd, commits: [tests]}).map(({hash}) => hash),
      groovyTest: filterCommits("shared-support", {cwd, commits: [groovyTest]}).map(({hash}) => hash),
    }, {catalog: [], tests: [], docs: [], productionResource: expected, history: [], groovyTest: []});
    for (const file of [shared, vendor, "helpers/library-consumer/src/main/kotlin/Entry.kt"]) {
      assert.deepEqual(impacts(testBuild, hostChange, [file]), expected, file);
    }

    const context = {cwd, logger: {log() {}}, options: {}, lastRelease: {gitHead: baseline.hash},
      nextRelease: {gitHead: addedRuntime.hash}, commits: [addedRuntime, hostChange, testBuild, testAndUnused, bump]};
    assert.deepEqual(filterCommits("morphe", context).map(({hash}) => hash), [hostChange.hash, bump.hash]);
    assert.deepEqual(filterCommits("reseam", context), []);
    assert.deepEqual(filterCommits("revanced-v21", {cwd, commits: [addedRuntime]}), [addedRuntime]);
    assert.equal(await analyzeCommits(releaseConfig("morphe").plugins[0][1], context), "patch");

    put("helpers/library-consumer/build.gradle.kts", "// SDK removed");
    put(catalog, catalogText("3", "2", "2"));
    const removed = commit("fix: remove SDK");
    assert.deepEqual(impacts(hostChange, removed, [catalog]), expected);

    put("reseam-runtime/build.gradle.kts", 'dependencies { implementation(libs.findLibrary(aliasName).get()) }');
    const dynamic = commit("chore: use dynamic dependency lookup");
    put(catalog, catalogText("4", "2", "2"));
    const dynamicBump = commit("fix: update dynamic dependency");
    assert.deepEqual(impacts(dynamic, dynamicBump, [catalog]), ["reseam"]);

    put(catalog, "[versions");
    const invalid = commit("chore: incomplete catalog");
    put(catalog, catalogText("4", "2", "2"));
    const repaired = commit("fix: restore valid catalog");
    assert.deepEqual(impacts(invalid, repaired, [catalog]), Object.keys(runtimes));

    put("build.gradle.kts", 'subprojects { dependencies { add("implementation", project(":helpers:library-consumer")) } }');
    put("helpers/library-consumer/build.gradle.kts", "dependencies { implementation(libs.bundles.sdk.bundle) }");
    put("reseam-runtime/build.gradle.kts", "// No direct SDK dependency");
    const common = commit("chore: use SDK through root project wiring");
    put(catalog, catalogText("5", "2", "2"));
    const commonBump = commit("fix: bump shared SDK");
    assert.deepEqual(impacts(common, commonBump, [catalog]), Object.keys(runtimes));
    put(catalog, catalogText("5", "2", "2", "2"));
    const groovyBump = commit("fix: bump SDK used in Groovy script");
    assert.deepEqual(impacts(commonBump, groovyBump, [catalog]), ["shared-support"]);
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});

test("release ownership includes interpolated versions, later file arguments, and uncertain project links", () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-release-inputs-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
  const put = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), {recursive: true});
    writeFileSync(join(cwd, file), content);
  };
  const save = message => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const catalog = "gradle/libs.versions.toml";
  const vendor = "libs/runtime.jar";
  const source = "shared/imported/src/main/kotlin/Entry.kt";
  const externalJar = "vendor/engine.jar";
  const groovyJar = "vendor/groovy.jar";
  const externalSource = "included-source/bridge/Bridge.kt";
  const helper = "optional-host/src/main/kotlin/Host.kt";
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const [module] of Object.values(runtimes)) {
      if (module !== "shared-support") put(module + "/build.gradle.kts", "// Runtime");
    }
    put("shared-support/build.gradle", [
      "plugins { id 'example.plugin' }",
      "dependencies { implementation(files('../vendor/groovy.jar')) }",
      "dependencies { implementation(project(':morphe-runtime:helper')) }",
      "def example = '${libs.versions.engine.get()}'",
    ].join("\n"));
    put("morphe-runtime/build.gradle.kts", [
      'implementation("example:engine:${libs.versions.engine.get()}")',
      'implementation(files("../libs/runtime.jar"))',
      'implementation(files(rootProject.file("vendor/engine.jar")))',
      'implementation(files("../vendor/computed" + artifactSuffix))',
      'kotlin.srcDir("../shared/imported/src/main/kotlin")',
    ].join("\n"));
    put("revanced.v22-runtime-plugin/build.gradle.kts", [
      'implementation(files("../libs/first.jar", "../libs/runtime.jar"))',
      'kotlin.srcDirs("../shared/first/src/main/kotlin", "../shared/imported/src/main/kotlin")',
      'kotlin.srcDir("../included-source/bridge")',
      'val evaluatedVersion = "${versionCatalogs.named("libs").findVersion("template").get()}"',
    ].join("\n"));
    put("build.gradle.kts", "plugins { alias(libs.plugins.example) apply false }");
    put("morphe-runtime/helper/build.gradle.kts", 'sourceSets.main { kotlin.srcDir("../../optional-host/src/test/kotlin") }');
    put("optional-host/build.gradle.kts", "// Optional host");
    put("reseam-runtime/build.gradle.kts", [
      'val projectExample = """project(":optional-host")"""',
      'val lookupExample = """findVersion("engine")"""',
      'val dynamicExample = """findLibrary(aliasName)"""',
      'val pluginExample = """id("example.plugin")"""',
    ].join("\n"));
    const catalogText = (engine, template) => [
      "[versions]",
      'engine = "' + engine + '"',
      'template = "' + template + '"',
      "[plugins]",
      'example = { id = "example.plugin", version.ref = "engine" }',
    ].join("\n");
    put(catalog, catalogText("1", "1"));
    const baseline = save("chore: fixture");
    put(catalog, catalogText("2", "1"));
    put(vendor, "updated dependency");
    put(source, "updated source");
    put(externalJar, "updated runtime jar");
    put(groovyJar, "updated groovy jar");
    put(externalSource, "updated bridge");
    const update = save("fix: update dependencies and sources");
    put(catalog, catalogText("2", "2"));
    const templateUpdate = save("fix: update dependency used in a string expression");
    put("reseam-runtime/build.gradle.kts", "implementation(project(hostProjectPath))");
    const dynamic = save("chore: configure host by name");
    put(helper, "updated host source");
    const dynamicUpdate = save("fix: update optional host");

    const read = buildInputReader(cwd, runtimes);
    const ids = Object.keys(runtimes);
    const owners = (file, snapshots) => ids.filter(id => affectsRuntime(id, [file], {}, snapshots));
    // Both ":optional" and ":optional-host" exist. A computed path can select the latter.
    put("optional/build.gradle.kts", "// Optional base");
    put("reseam-runtime/build.gradle.kts", 'implementation(project(":optional" + hostSuffix))');
    const computedPath = save("chore: compute host project path");
    assert.deepEqual(owners(helper, read([computedPath, computedPath])), ["reseam"]);

    const updateInputs = read([baseline, update]);
    assert.deepEqual({
      catalog: owners(catalog, updateInputs),
      vendor: owners(vendor, updateInputs),
      source: owners(source, updateInputs),
      externalJar: owners(externalJar, updateInputs),
      groovyJar: owners(groovyJar, updateInputs),
      nestedModule: owners("morphe-runtime/helper/src/main/kotlin/Helper.kt", updateInputs),
      packagedTestSource: owners("optional-host/src/test/kotlin/Fixture.kt", updateInputs),
      externalSource: owners(externalSource, updateInputs),
      computedPrefix: owners("vendor/computed", updateInputs),
      quotedProject: owners(helper, updateInputs),
      evaluatedLookup: owners(catalog, read([update, templateUpdate])),
      dynamic: owners(helper, read([dynamic, dynamicUpdate])),
    }, {
      catalog: ["morphe", "shared-support"],
      vendor: ["revanced-v22", "morphe"],
      source: ["revanced-v22", "morphe"],
      externalJar: ["morphe"],
      groovyJar: ["shared-support"],
      nestedModule: ["shared-support"],
      packagedTestSource: ["shared-support"],
      externalSource: ["revanced-v22"],
      computedPrefix: [],
      quotedProject: [],
      evaluatedLookup: ["revanced-v22"],
      dynamic: ["reseam"],
    });
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});

test("wrapped and multiline test dependencies do not make a runtime release", () => {
  const cwd = mkdtempSync(join(tmpdir(), "upm-test-dependencies-"));
  const git = (...args) => execFileSync("git", args, {cwd, encoding: "utf8"}).trim();
  const put = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), {recursive: true});
    writeFileSync(join(cwd, file), content);
  };
  const save = message => {
    git("add", ".");
    git("commit", "-m", message);
    return {hash: git("rev-parse", "HEAD"), message};
  };
  const catalog = "gradle/libs.versions.toml";
  const build = "reseam-runtime/build.gradle.kts";
  const vendor = "libs/test-runner.jar";
  const shared = "libs/shared-runner.jar";
  const helper = "test-helper/src/main/kotlin/Helper.kt";
  const catalogText = version => '[libraries]\ntest-bom = "example:test-bom:' + version + '"\n';
  const buildText = version => [
    "dependencies {",
    "    testImplementation(platform(libs.test.bom)) /* This catalog entry is for tests.",
    "    implementation(libs.test.bom) would make it a production dependency. */",
    '    testImplementation(project(path = ":test-helper"))',
    '    testRuntimeOnly(files("../libs/test-runner.jar", "../libs/shared-runner.jar"))',
    "    testRuntimeOnly(",
    '        "example:test-runner:' + version + '"',
    "    )",
    "}",
  ].join("\n");
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const [module] of Object.values(runtimes)) put(module + "/build.gradle.kts", "// Runtime");
    put(build, buildText("1"));
    put("morphe-runtime/build.gradle.kts", 'implementation(files("../libs/shared-runner.jar"))');
    put("test-helper/build.gradle.kts", "// Helper");
    put(catalog, catalogText("1"));
    const baseline = save("chore: fixture");
    put(catalog, catalogText("2"));
    put(vendor, "test artifact");
    put(shared, "shared artifact");
    put(helper, "test code");
    const bump = save("fix: update test inputs");
    put(build, buildText("2"));
    const buildOnly = save("fix: update multiline test dependency");

    const generated = version => buildText("2") + '\nval generatedScript = """\n' +
      '    testImplementation("example:generated:' + version + '")\n    """.trimIndent()\n' +
      'android { defaultConfig { manifestPlaceholders["runtimePayload"] = generatedScript } }\n';
    put(build, generated("1"));
    save("chore: generate runtime resource");
    put(build, generated("2"));
    const payload = save("fix: update generated runtime resource");

    const snapshots = buildInputReader(cwd, runtimes)([baseline.hash, bump.hash]);
    const owners = file => Object.keys(runtimes).filter(id => affectsRuntime(id, [file], {}, snapshots));
    assert.deepEqual({
      catalog: owners(catalog),
      vendor: owners(vendor),
      shared: owners(shared),
      helper: owners(helper),
      build: filterCommits("reseam", {cwd, commits: [buildOnly]}).map(({hash}) => hash),
      payload: filterCommits("reseam", {cwd, commits: [payload]}).map(({hash}) => hash),
    }, {catalog: [], vendor: [], shared: ["morphe"], helper: [], build: [], payload: [payload.hash]});

    const configured = version => 'dependencies {\n' +
      '    val dependency = testImplementation("example:dual-use:' + version + '")\n' +
      '    implementation("example:runtime:" + checkNotNull(dependency).version)\n}\n';
    put(build, configured("1"));
    save("chore: configure a runtime dependency using the test declaration");
    put(build, configured("2"));
    const dependencyValue = save("fix: update derived runtime dependency");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [dependencyValue]}), [dependencyValue]);

    put(build, buildText("3") + '\nimplementation("example:runtime:1")\n');
    const mixed = save("fix: update runtime and test dependency together");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [mixed]}), [mixed]);

    put("shared-support/build.gradle.kts", "implementation(project(optionalPath))");
    const dynamic = save("chore: select optional project dynamically");
    put(vendor, "replacement test artifact");
    const testOnly = save("fix: replace test artifact");
    const dynamicInputs = buildInputReader(cwd, runtimes)([dynamic.hash, testOnly.hash]);
    assert.deepEqual(Object.keys(runtimes).filter(id => affectsRuntime(id, [vendor], {}, dynamicInputs)), []);

    const variantInputs = version => [
      "dependencies {",
      '    testDebugImplementation("example:unit:' + version + '")',
      '    androidTestReleaseImplementation("example:instrumented:' + version + '")',
      "}",
    ].join("\n");
    put(build, variantInputs("1"));
    save("chore: configure Android variant tests");
    put(build, variantInputs("2"));
    const variantBump = save("fix: update Android variant test dependencies");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [variantBump]}), []);

    put(build, 'testFixturesApi("example:fixtures:1")');
    save("chore: publish test fixtures");
    put(build, 'testFixturesApi("example:fixtures:2")');
    const fixturesBump = save("fix: update published test fixtures");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [fixturesBump]}), [fixturesBump]);

    const packaging = [
      'val bundled by configurations.creating {',
      '    extendsFrom(configurations.testRuntimeOnly.get(), configurations["testImplementation"])',
      '}',
      'tasks.named<Jar>("jar") { from(bundled) }',
    ].join("\n");
    put(build, buildText("3") + "\n" + packaging);
    const beforePackagingBump = save("chore: bundle dependencies from two configurations");
    put(build, buildText("4") + "\n" + packaging);
    const inlineBump = save("fix: bump bundled dependency in the build script");
    put(catalog, catalogText("3"));
    put(vendor, "replacement bundled artifact");
    const bundledBump = save("fix: bump bundled dependencies");

    const wiring = 'configurations { named("runtimeClasspath") { extendsFrom(getByName("testRuntimeOnly")) } }';
    put(build, buildText("4") + "\n" + wiring);
    save("chore: reuse a test configuration inside its container");
    put(build, buildText("5") + "\n" + wiring);
    const localReuse = save("fix: update dependency inherited by the runtime classpath");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [localReuse]}), [localReuse]);

    put(build, buildText("5"));
    put("build.gradle.kts", "subprojects {\n" + wiring + "\n}");
    save("chore: share runtime classpath configuration across subprojects");
    put(build, buildText("6"));
    const sharedReuse = save("fix: update dependency inherited through root project configuration");
    assert.deepEqual(filterCommits("reseam", {cwd, commits: [sharedReuse]}), [sharedReuse]);

    const bundledInputs = buildInputReader(cwd, runtimes)([beforePackagingBump.hash, bundledBump.hash]);
    const bundledOwners = file => Object.keys(runtimes).filter(id => affectsRuntime(id, [file], {}, bundledInputs));
    assert.deepEqual({
      catalog: bundledOwners(catalog),
      vendor: bundledOwners(vendor),
      inline: filterCommits("reseam", {cwd, commits: [inlineBump]}),
    }, {catalog: ["reseam", "shared-support"], vendor: ["reseam", "shared-support"], inline: [inlineBump]});
  } finally { rmSync(cwd, {recursive: true, force: true}); }
});
