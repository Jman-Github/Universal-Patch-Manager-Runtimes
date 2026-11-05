// Release rules and plugin order adapted from UPM's .releaserc.
export const runtimes = {
  "revanced-v21": ["revanced.v21-runtime-plugin", "revanced21-patcher-core", "revanced-legacy-patcher-core"],
  "revanced-v22": ["revanced.v22-runtime-plugin", "revanced22-patcher-core"],
  morphe: ["morphe-runtime", "upm-patcher-core"],
  reseam: ["reseam-runtime"],
  "shared-support": ["shared-support", "tools-patcher-core"],
};
export const commonPaths = ["buildSrc/", "jvm-host/", "host-support/", "shared/", "gradle/",
  "build.gradle.kts", "settings.gradle.kts", "gradle.properties", "gradlew", "gradlew.bat", "libs/", ".github/scripts/", ".github/workflows/"];
export const engineDependencyPaths = [
  "gradle/libs.versions.toml",
  "buildSrc/src/main/kotlin/PatcherClassMergerCompatTransform.kt",
];

// Only narrow shared files when every changed line belongs to a known engine.
// Unrecognized edits (including shared dependency changes) retain the broad rule.
function dependencyOwners(path, lines) {
  if (!lines?.length) return null;
  const owners = new Set();
  for (const line of lines) {
    let owner;
    if (path === "gradle/libs.versions.toml") {
      if (/^\s*morphe-(patcher|library)\s*=/.test(line)) owner = "morphe";
    } else if (path === engineDependencyPaths[1]) {
      if (/^\s*"morphe-patcher-[^"]+\.jar",?\s*$/.test(line)) owner = "morphe";
    }
    if (!owner) return null;
    owners.add(owner);
  }
  return owners;
}

export function affectsRuntime(id, paths, changedLines = {}) {
  if (!runtimes[id]) throw new Error("Unknown runtime: " + id);
  return paths.some(path => {
    if (runtimes[id].some(module => path.startsWith(module + "/"))) return true;
    if (!commonPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))) return false;
    const owners = dependencyOwners(path, changedLines[path]);
    return owners ? owners.has(id) : true;
  });
}
export const analysis = { preset: "angular", releaseRules: [
  {breaking: true, release: "major"}, {type: "feat", release: "minor"},
  {type: "fix", release: "patch"}, {type: "perf", release: "patch"},
  {type: "revert", release: "patch"}, {type: "build", scope: "Needs bump", release: "patch"},
]};
export function releaseConfig(id) {
  if (!runtimes[id]) throw new Error("Unknown runtime: " + id);
  const module = runtimes[id][0];
  return {
    branches: ["main", {name: "dev", prerelease: "dev"}],
    tagFormat: id + "-v${version}",
    plugins: [
      ["./.github/scripts/runtime-commits.mjs", {runtime: id, analysis}],
      ["@semantic-release/changelog", {changelogFile: module + "/CHANGELOG.md",
        changelogTitle: "# Changelog\n\nGenerated from Conventional Commits affecting this runtime."}],
      ["@semantic-release/exec", {prepareCmd:
        "bash .github/scripts/prepare-semantic-release.sh " + id + " ${nextRelease.version} ${branch.name}"}],
      ["./.github/scripts/release-git.mjs", {runtime: id, assets: [module + "/CHANGELOG.md", module + "/version.properties"]}],
      ["@semantic-release/github", {assets: [{path: "runtime-release-assets/" + id + "/*"}], successComment: false}],
      ["@cleyrop-org/semantic-release-backmerge", {
        backmergeBranches: [{from: "main", to: "dev"}], backmergeStrategy: "merge", clearWorkspace: true,
        message: "chore: backmerge " + id + "-v${nextRelease.version} into dev [skip ci]",
      }],
    ],
  };
}
