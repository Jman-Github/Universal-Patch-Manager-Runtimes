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
