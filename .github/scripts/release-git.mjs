// Adapted from UPM's .github/scripts/release-git.mjs.
// UPM's Crowdin status certification is specific to manager translations.
import {execFile} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
const exec = promisify(execFile);

export async function prepare(config, context) {
  const {cwd, env, branch, nextRelease, options, logger} = context;
  const assets = config.assets;
  await exec("git", ["add", "--", ...assets], {cwd, env});
  const {stdout: staged} = await exec("git", ["diff", "--cached", "--name-only", "--", ...assets], {cwd, env});
  if (!staged.trim()) return;
  const temporary = await mkdtemp(join(tmpdir(), "upm-runtime-release-"));
  try {
    const message = join(temporary, "message.txt");
    await writeFile(message, "chore(" + config.runtime + "): release " + nextRelease.gitTag +
      " [skip ci]\n\n" + nextRelease.notes, "utf8");
    await exec("git", ["commit", "-F", message], {cwd, env});
    await exec("git", ["push", options.repositoryUrl, "HEAD:" + branch.name], {cwd, env});
    logger.log("Prepared runtime release: %s", nextRelease.gitTag);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}
