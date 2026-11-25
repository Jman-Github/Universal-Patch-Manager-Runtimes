import {
  buildPathOwners, catalogAffectsRuntime, catalogPath, hasRuntimeBuildInputs, isAuxiliaryModulePath,
} from "./runtime-build-inputs.mjs";

// Release rules and plugin order adapted from UPM's .releaserc.
export const runtimes = {
  "revanced-v21": ["revanced.v21-runtime-plugin", "revanced21-patcher-core", "revanced-legacy-patcher-core"],
  "revanced-v22": ["revanced.v22-runtime-plugin", "revanced22-patcher-core"],
  morphe: ["morphe-runtime", "upm-patcher-core"],
  reseam: ["reseam-runtime"],
  "shared-support": ["shared-support", "tools-patcher-core"],
};
// Matrix jobs select one runtime; local/manual callers can still release all.
export function selectedRuntimes(id) {
  if (id === undefined) return Object.keys(runtimes);
  if (!Object.hasOwn(runtimes, id)) throw new Error("Unknown runtime: " + id);
  return [id];
}
// Shared build inputs can affect multiple runtime artifacts.
export const commonPaths = ["buildSrc/", "jvm-host/", "host-support/", "shared/", "gradle/",
  "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "gradle.properties", "gradlew", "gradlew.bat", "libs/"];
const jvmHosts = ["revanced-v21", "revanced-v22", "morphe", "shared-support"];
const apkEditor = ["revanced-v21", "revanced-v22", "reseam"];
const arscLib = ["revanced-v22", "morphe", "shared-support"];
const runtimeFramework = ["revanced-v22", "shared-support"];
const classMergerConsumers = ["revanced-v21", "revanced-v22", "morphe", "shared-support"];
const transformPath = "buildSrc/src/main/kotlin/PatcherClassMergerCompatTransform.kt";

// Scope inputs with verified consumers. Unlisted build files keep the shared default.
const scopedInputs = [
  ["shared-support", ["EmbeddedJvmAssetsTask", "ImageDelta", "PinnedDownloads",
    "PrepareEmbeddedJvmTask", "PrepareGlibcTask", "XzArchive"]],
  ["revanced-v21", ["LegacyRuntimeAssetsTask"]],
].flatMap(([runtime, tasks]) => tasks.map(task => ["buildSrc/src/main/kotlin/" + task + ".kt", [runtime]]));
const inputOwners = [
  ...scopedInputs,
  ["buildSrc/src/main/kotlin/ExtensionClassMergerFix.kt", classMergerConsumers],
  [transformPath, classMergerConsumers],
  ["buildSrc/src/main/kotlin/PluginJvmHostTask.kt", jvmHosts],
  ["buildSrc/src/main/kotlin/ShrinkJarTask.kt", jvmHosts],
  ["jvm-host/", jvmHosts],
  // Morphe's APK includes the Android samplers. The two host cores omit them.
  ["host-support/src/main/java/app/universal/patch/manager/patcher/runtime/usage/", ["morphe"]],
  ["host-support/src/main/java/", ["revanced-v22", "shared-support"]],
  ["shared/merger-apkeditor/", apkEditor],
  ["shared/merger-arsclib/", arscLib],
  ["shared/revanced22/", ["revanced-v22"]],
  ["shared/runtime-framework/", runtimeFramework],
  ["shared/runtime-plugin/", ["revanced-v21", "reseam"]],
  ["libs/APKEditor-1.4.7.jar", apkEditor],
];

const catalogOwners = new Map([
  ["morphe-patcher", ["morphe"]],
  ["morphe-library", ["morphe"]],
  ["revanced-patcher", ["revanced-v21"]],
  ["revanced-patcher-v22", ["revanced-v22"]],
  ["arsclib", arscLib],
  ["proguard", jvmHosts],
  ["hidden-api-stub", ["revanced-v21", "revanced-v22", "morphe"]],
]);

const rootBuildPath = "build.gradle.kts";
export const lineScopedPaths = [catalogPath, transformPath, rootBuildPath];

// The verifier's old and new image lookup both apply only to shared-support.
const supportVerifierLines = new Set([
  'check(zip.getEntry("assets/jvm/$abi.zip.xz") != null) { "Missing JVM image for $abi" }',
  'val image = "assets/jvm/liberica-gpkg-2/$abi.zip.xz"',
  'check(zip.getEntry(image) != null) { "Missing JVM image at $image" }',
]);

function lineOwners(path, line) {
  switch (path) {
    case catalogPath:
      return catalogOwners.get(line.match(/^\s*([\w-]+)\s*=/)?.[1]);
    case transformPath:
      if (/^\s*"morphe-patcher-[^"]+\.jar",?\s*$/.test(line)) return ["morphe"];
      if (/^\s*"revanced-patcher-[^"]+\.jar",?\s*$/.test(line)) return ["revanced-v21"];
      if (/^\s*"patcher-jvm-[^"]+\.jar",?\s*$/.test(line)) return ["revanced-v22"];
      return;
    case rootBuildPath:
      if (supportVerifierLines.has(line.trim())) return ["shared-support"];
  }
}

// Narrow a mixed-use file only when every changed line has known consumers.
function dependencyOwners(path, lines) {
  if (!lines?.length) return null;
  const owners = new Set();
  for (const line of lines) {
    const consumers = lineOwners(path, line);
    if (!consumers) return null;
    for (const runtime of consumers) owners.add(runtime);
  }
  return owners;
}

export function affectsRuntime(id, paths, changedLines = {}, snapshots = []) {
  if (!Object.hasOwn(runtimes, id)) throw new Error("Unknown runtime: " + id);
  const modeled = hasRuntimeBuildInputs(id, snapshots);
  return paths.some(path => {
    if (!modeled && isAuxiliaryModulePath(path, snapshots)) return false;
    if (modeled && path === catalogPath) return catalogAffectsRuntime(id, ...snapshots);
    const buildOwners = modeled ? buildPathOwners(path, snapshots) : null;
    if (buildOwners) return buildOwners.has(id);
    if (runtimes[id].some(module => path.startsWith(module + "/"))) return true;
    const owners = dependencyOwners(path, changedLines[path]);
    if (owners) return owners.has(id);
    const scoped = inputOwners.find(([input]) => input.endsWith("/") ? path.startsWith(input) : path === input);
    if (scoped) return scoped[1].includes(id);
    return commonPaths.some(prefix => prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix);
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
