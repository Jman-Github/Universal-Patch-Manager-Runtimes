import semanticRelease from "semantic-release";
import {execFileSync} from "node:child_process";
import {appendFileSync} from "node:fs";
import {releaseConfig, runtimes} from "./runtime-release-config.mjs";

const branch = process.env.GITHUB_REF_NAME;
if (!["main", "dev"].includes(branch)) throw new Error("Releases must run on main or dev");
if (process.env.GITHUB_EVENT_NAME === "push" && branch !== "main") throw new Error("Automatic releases require main");
let count = 0;
for (const id of Object.keys(runtimes)) {
  // Bootstrap each plugin once to publish its initial assets and establish
  // the version tag used by subsequent semantic releases.
  const tags = execFileSync("git", ["tag", "--list", id + "-v*"], {encoding: "utf8"}).trim();
  if (!tags) {
    console.log("::notice::Bootstrap " + id + " with the Bootstrap runtime workflow first.");
    continue;
  }
  execFileSync("git", ["checkout", branch], {stdio: "inherit"});
  const result = await semanticRelease(releaseConfig(id));
  if (result) count++;
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "released=" + (count > 0) + "\n");
