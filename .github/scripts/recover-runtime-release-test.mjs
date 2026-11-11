import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {recoverRuntimeRelease, releaseNotes, retryNotesPush} from "./recover-runtime-release.mjs";

function fixture({published = false, draft = false, branch = "main", failure, remoteNote = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), "upm-recover-test-"));
  const tag = branch === "main" ? "reseam-v1.0.5" : "reseam-v1.0.5-dev.1";
  const version = tag.slice("reseam-v".length);
  const commands = [];
  let attempts = 0;
  const run = (command, args) => {
    commands.push([command, ...args]);
    if (failure?.(command, args)) throw new Error("injected failure");
    if (command === "bash") {
      const assets = join(root, "reseam");
      mkdirSync(assets);
      for (const name of ["reseam-runtime.apk", "runtime-release.json", "SHA256SUMS", "runtime-icon.svg"])
        writeFileSync(join(assets, name), name);
    }
    if (command === "gh" && args[0] === "api")
      return JSON.stringify([published || draft ? [{tag_name: tag, draft}] : []]);
    if (command !== "git") return "";
    if (args[0] === "tag") return tag + "\nreseam-v1.0.4";
    if (args[0] === "show" && args.includes("--format=%s")) return "chore(reseam): release " + tag + " [skip ci]";
    if (args[0] === "show") return "# Changelog\n\n## [" + version + "](compare)\n\nSDK update\n\n## [1.0.4](old)\nOld";
    if (args[0] === "ls-remote") return remoteNote ? "abc refs/notes/semantic-release-" + tag : "";
    if (args[0] === "push" && attempts++ < 1) throw new Error("transient notes rejection");
    return "";
  };
  return {tag, commands, options: {run, wait: async () => {}, afterPublish: async () => commands.push(["backmerge"]), repository: "fixture/repo", assetsRoot: root},
    cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test("notes push retries transient rejection and propagates persistent failure", async () => {
  let count = 0;
  await retryNotesPush(() => { if (++count < 3) throw Error("retry"); }, async () => {});
  assert.equal(count, 3);
  await assert.rejects(retryNotesPush(() => { throw Error("denied"); }, async () => {}), /denied/);
});
test("notes select the exact version and exclude the previous release", () => {
  assert.equal(releaseNotes("# Changelog\n\n## [1.0.5](url)\nFix\n\n## [1.0.4](url)\nOld", "1.0.5"),
    "## [1.0.5](url)\nFix");
  assert.throws(() => releaseNotes("## [1.0.50](url)", "1.0.5"));
});
for (const branch of ["main", "dev"]) {
  test("recover orphaned " + branch + " tag with verified assets and notes before publication", async () => {
    const f = fixture({branch});
    try {
      assert.equal(await recoverRuntimeRelease("reseam", branch, f.options), true);
      const commands = f.commands;
      assert(commands.some(c => c.join(" ") === "git checkout --detach " + f.tag));
      assert(commands.some(c => c[0] === "bash" && c.at(-1) === branch));
      assert.equal(commands.filter(c => c[0] === "git" && c[1] === "push").length, 2);
      const note = commands.find(c => c[1] === "notes");
      assert.deepEqual(JSON.parse(note.at(-2)), {channels: [branch === "dev" ? "dev" : null]});
      const create = commands.findIndex(c => c.includes("create"));
      const upload = commands.findIndex(c => c.includes("upload"));
      const publish = commands.findIndex(c => c.includes("--draft=false"));
      const backmerge = commands.findIndex(c => c[0] === "backmerge");
      assert(create < upload && upload < publish && publish < backmerge);
      assert(commands[create].includes("--verify-tag") && commands[create].includes("--draft"));
      assert.equal(commands[upload].length, 11); // command, verb, options and all four assets
      assert.deepEqual(commands.at(-1), ["git", "checkout", branch]);
    } finally { f.cleanup(); }
  });
}
test("published releases are skipped without a rebuild or any writes", async () => {
  const f = fixture({published: true});
  try {
    assert.equal(await recoverRuntimeRelease("reseam", "main", f.options), false);
    assert(!f.commands.some(c => ["bash", "checkout", "push"].includes(c[0]) || c[1] === "checkout"));
  } finally { f.cleanup(); }
});
test("resume draft uploads without creating another release and preserve existing notes", async () => {
  const f = fixture({draft: true, remoteNote: true});
  try {
    assert.equal(await recoverRuntimeRelease("reseam", "main", f.options), true);
    assert(f.commands.some(c => c[1] === "fetch"));
    assert(!f.commands.some(c => c.includes("create") || c[1] === "notes"));
  } finally { f.cleanup(); }
});
test("upload failure retains draft, fails the run, and restores the branch", async () => {
  const f = fixture({failure: (command, args) => command === "gh" && args[1] === "upload"});
  try {
    await assert.rejects(recoverRuntimeRelease("reseam", "main", f.options), /injected failure/);
    assert(!f.commands.some(c => c.includes("--draft=false")));
    assert.deepEqual(f.commands.at(-1), ["git", "checkout", "main"]);
  } finally { f.cleanup(); }
});
test("API failure is not mistaken for a missing release", async () => {
  const f = fixture({failure: (command, args) => command === "gh" && args[0] === "api"});
  try {
    await assert.rejects(recoverRuntimeRelease("reseam", "main", f.options), /injected failure/);
    assert(!f.commands.some(c => c[0] === "bash"));
  } finally { f.cleanup(); }
});

test("bootstrap tags are left to the bootstrap workflow", async () => {
  const f = fixture();
  const run = f.options.run;
  f.options.run = (command, args) => command === "git" && args.includes("--format=%s") ?
    "chore: bootstrap runtime" : run(command, args);
  try {
    assert.equal(await recoverRuntimeRelease("reseam", "main", f.options), false);
    assert(!f.commands.some(c => c[0] === "gh"));
  } finally { f.cleanup(); }
});
test("build failure restores the branch before any publication", async () => {
  const f = fixture({failure: command => command === "bash"});
  try {
    await assert.rejects(recoverRuntimeRelease("reseam", "main", f.options), /injected failure/);
    assert(!f.commands.some(c => c.includes("create") || c.includes("upload")));
    assert.deepEqual(f.commands.at(-1), ["git", "checkout", "main"]);
  } finally { f.cleanup(); }
});
test("persistent notes rejection cannot publish an untracked release", async () => {
  const f = fixture({failure: (command, args) => command === "git" && args[0] === "push"});
  try {
    await assert.rejects(recoverRuntimeRelease("reseam", "main", f.options), /injected failure/);
    assert.equal(f.commands.filter(c => c[1] === "push").length, 3);
    assert(!f.commands.some(c => c.includes("create") || c.includes("upload")));
  } finally { f.cleanup(); }
});
