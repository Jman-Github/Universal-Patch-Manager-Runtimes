import {test} from "node:test";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";

// semantic-release hooks stdout. Keep it outside Node's test-worker IPC stream.
test("semantic-release computes stable and dev versions in isolated local git repositories", () => {
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  execFileSync(process.execPath, [fileURLToPath(new URL("./semantic-engine-check.mjs", import.meta.url))],
    {env, stdio:"pipe", timeout:90000});
});
