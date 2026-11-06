import assert from "node:assert/strict";
import test from "node:test";
import { openDevPullRequest } from "./open-dev-pr.mjs";

const repo = "owner/runtimes";
function runner(responses) {
  const calls = [];
  return {
    calls,
    gh(args) {
      calls.push(args);
      const result = responses.shift();
      if (result instanceof Error) throw result;
      assert.notEqual(result, undefined, "Unexpected GitHub mutation");
      return result;
    },
  };
}

test("reuse an open PR without editing or creating another", () => {
  const mock = runner(['[{"number":12,"html_url":"https://example.com/12"}]']);
  assert.deepEqual(openDevPullRequest(repo, mock.gh), {
    status: "existing", url: "https://example.com/12",
  });
  assert.equal(mock.calls.length, 1);
  const endpoint = new URL(mock.calls[0][1], "https://api.github.com/");
  assert.equal(endpoint.searchParams.get("head"), "owner:dev");
  assert.equal(endpoint.searchParams.get("base"), "main");
  assert.equal(endpoint.searchParams.get("state"), "open");
});

for (const comparison of [
  { ahead_by: 0, files: [{ filename: "source.kt" }] },
  { ahead_by: 1, files: [] },
]) {
  test("skip a branch without new content: " + JSON.stringify(comparison), () => {
    const mock = runner(["[]", JSON.stringify(comparison)]);
    assert.equal(openDevPullRequest(repo, mock.gh).status, "unchanged");
    assert.equal(mock.calls.length, 2);
  });
}

test("create a draft dev-to-main PR for new content", () => {
  const mock = runner(["[]", '{"ahead_by":2,"files":[{"filename":"source.kt"}]}', "https://example.com/13\n"]);
  assert.deepEqual(openDevPullRequest(repo, mock.gh), { status: "created", url: "https://example.com/13" });
  const args = mock.calls[2];
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.equal(args[args.indexOf("--head") + 1], "dev");
  assert.ok(args.includes("--draft"));
});

test("a failed lookup stops before creation", () => {
  const mock = runner([new Error("GitHub unavailable")]);
  assert.throws(() => openDevPullRequest(repo, mock.gh), /GitHub unavailable/);
  assert.equal(mock.calls.length, 1);
});

test("a fork's dev PR does not suppress the repository's dev PR", () => {
  const calls = [];
  const result = openDevPullRequest(repo, args => {
    calls.push(args);
    if (args[0] === "api" && args[1].includes("/pulls?")) {
      const endpoint = new URL(args[1], "https://api.github.com/");
      // A branch-only lookup would return the fork's unrelated open PR.
      return endpoint.searchParams.get("head") === "owner:dev"
        ? "[]" : '[{"html_url":"https://example.com/fork"}]';
    }
    if (args[0] === "api") return '{"ahead_by":1,"files":[{"filename":"source.kt"}]}';
    return "https://example.com/official";
  });
  assert.deepEqual(result, { status: "created", url: "https://example.com/official" });
  assert.equal(calls.length, 3);
});
