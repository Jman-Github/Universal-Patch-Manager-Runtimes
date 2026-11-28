import {execFileSync} from "node:child_process";
import {posix as path} from "node:path";
import {isDeepStrictEqual} from "node:util";
import {parse, TomlError} from "smol-toml";

export const catalogPath = "gradle/libs.versions.toml";
export const isNonReleasePath = file => /^(?:\.github|docs|tests)\//.test(file);
// A computed first argument must retain the unknown-project fallback.
const literalProject = /\bproject\s*\(\s*(?:path\s*[:=]\s*)?(["'])(:[\w.:-]+)\1(?=\s*[),])/g;
const sections = ["versions", "libraries", "bundles", "plugins"];
const normalize = name => name.replace(/[_.-]/g, ".");
const quoted = /"""[\s\S]*?"""|"(?:\\.|[^"\\$]|\$(?:\{[^{}]*\})?)*"|'(?:\\.|[^'\\])*'/g;
const commentOrString = quoted.source + "|//[^\\r\\n]*|/\\*";
const blank = value => value.replace(/[^\r\n]/g, " ");
const testConfiguration = "(?:(?:androidTest|test(?!Fixtures))(?:[A-Z]\\w*)?|[a-z]\\w*UnitTest)(?:Implementation|Api|CompileOnly|RuntimeOnly|AnnotationProcessor)";
const testCall = new RegExp("\\b(" + testConfiguration + ")\\s*\\(", "g");
const testReference = new RegExp("\\b" + testConfiguration + "\\b(?!\\s*\\()", "g");
const testLookup = new RegExp(
  "\\b(?:configurations\\s*\\[\\s*|(?:configurations\\s*\\.\\s*|(?<!\\.\\s*))(?:named|getByName|findByName)\\s*\\(\\s*)([\"'])(" +
  testConfiguration + ")\\1", "g");
const dependencyFactories = new Set(["files", "file", "rootProject.file", "project", "kotlin",
  "platform", "enforcedPlatform", "testFixtures"]);
function withoutComments(source, nestedComments) {
  const tokens = new RegExp(commentOrString, "g");
  const blockMarkers = nestedComments ? /\/\*|\*\//g : /\*\//g;
  let result = "";
  let from = 0;
  for (let token; (token = tokens.exec(source));) {
    if (!token[0].startsWith("/")) continue;
    if (token[0] === "/*") {
      let depth = 1;
      blockMarkers.lastIndex = tokens.lastIndex;
      tokens.lastIndex = source.length;
      for (const marker of source.matchAll(blockMarkers)) {
        depth += marker[0] === "/*" ? 1 : -1;
        if (depth === 0) {
          tokens.lastIndex = marker.index + marker[0].length;
          break;
        }
      }
    }
    result += source.slice(from, token.index) + blank(source.slice(token.index, tokens.lastIndex));
    from = tokens.lastIndex;
  }
  return result + source.slice(from);
}

function reusedTestConfigurations(code, masked) {
  // A configuration can feed a production classpath or a packaging task.
  const reused = new Set([...masked.matchAll(testReference)].map(([name]) => name));
  for (const match of code.matchAll(testLookup)) {
    if (masked[match.index] !== " ") reused.add(match[2]);
  }
  return reused;
}

// Build scripts can configure their child projects, while convention scripts can
// supply shared configuration for any project.
function sharedTestConfigurations(source, file, buildScript) {
  const code = withoutComments(source, /\.kts?$/.test(file));
  const masked = code.replace(quoted, blank);
  if (!buildScript) return reusedTestConfigurations(code, masked);
  const reused = new Set();
  for (const block of masked.matchAll(/\b(?:allprojects|subprojects)\s*\{/g)) {
    const start = block.index + block[0].length;
    const end = closingDelimiter(masked, start, /[{}]/g, "{");
    if (end < 0) continue;
    for (const name of reusedTestConfigurations(code.slice(start, end), masked.slice(start, end))) reused.add(name);
  }
  return reused;
}

function testDependencies(source, nestedComments, inherited) {
  const code = withoutComments(source, nestedComments);
  const masked = code.replace(quoted, blank);
  const reused = reusedTestConfigurations(code, masked);
  for (const name of inherited) reused.add(name);
  const calls = [];
  let production = "";
  let from = 0;
  for (const match of masked.matchAll(testCall)) {
    if (match.index < from || reused.has(match[1])) continue;
    const argumentStart = match.index + match[0].length;
    const end = closingDelimiter(masked, argumentStart, /[()]/g, "(");
    if (end === -1) continue;
    const argumentsCode = masked.slice(argumentStart, end);
    // Keep expressions that could perform build configuration outside this dependency.
    if (/[{}]/.test(argumentsCode) || /(?<!\\)\$\{/.test(code.slice(argumentStart, end)) ||
        [...argumentsCode.matchAll(/\b([\w.]+)\s*\(/g)].some(([, factory]) =>
          !dependencyFactories.has(factory) && !/^libs\.[\w.]+\.(?:get|asProvider)$/.test(factory))) continue;

    // Strip declarations used as statements. Their return values or trailing
    // configuration can also feed production build logic.
    const lineStart = masked.lastIndexOf("\n", match.index - 1) + 1;
    const prefix = masked.slice(lineStart, match.index).trimEnd();
    if ((prefix && !/[{;]$/.test(prefix)) ||
        /(?:[=(:,?.]|\breturn)\s*$/.test(masked.slice(0, match.index)) ||
        /^\s*[.{?+*/%&|<>=\[]/.test(masked.slice(end + 1))) continue;
    const lineEnd = masked.indexOf("\n", end);
    const nextLine = lineEnd === -1 ? source.length : lineEnd + 1;
    // Keep adjacent comments intact, including block comments spanning later lines.
    const wholeLine = !source.slice(lineStart, match.index).trim() &&
      /^;?$/.test(source.slice(end + 1, nextLine).trim());
    production += source.slice(from, wholeLine ? lineStart : match.index);
    from = wholeLine ? nextLine : end + 1;
    calls.push(code.slice(match.index, end + 1));
  }
  return {production: production + source.slice(from), calls};
}

function closingDelimiter(code, start, delimiters, open) {
  let depth = 1;
  for (const match of code.slice(start).matchAll(delimiters)) {
    depth += match[0] === open ? 1 : -1;
    if (!depth) return start + match.index;
  }
  return -1;
}

// Resolve explicit file and source inputs relative to their Gradle project.
function localPaths(code, module) {
  const paths = new Set();
  const calls = /\b(srcDirs?|setSrcDirs|(?<!\.\s*)(?:(?:rootProject|project)\s*\.\s*)?files?)\s*\(/g;
  const tokens = new RegExp(quoted.source + "|[(),]", "g");
  const literal = new RegExp("^(?:" + quoted.source + ")$");
  for (const call of code.replace(quoted, blank).matchAll(calls)) {
    const args = code.slice(call.index + call[0].length);
    let depth = 1;
    let start = 0;
    for (const {0: token, index} of args.matchAll(tokens)) {
      if (token === "(") depth++;
      if (token === ")") depth--;
      if (depth !== 0 && !(depth === 1 && token === ",")) continue;
      const argument = args.slice(start, index).trim();
      start = index + 1;
      if (literal.test(argument)) {
        const quoteLength = argument.startsWith('"""') ? 3 : 1;
        const value = argument.slice(quoteLength, -quoteLength);
        const rootPrefix = argument.startsWith('"') ? value.match(/^\$(?:rootDir|\{rootDir\})\//) : null;
        const name = rootPrefix ? value.slice(rootPrefix[0].length) : value;
        if (name && !/[$\\:\r\n]/.test(name) && !path.isAbsolute(name)) {
          const base = rootPrefix || call[1].startsWith("rootProject") ? "." : module;
          const input = path.join(base, name).replace(/\/$/, "");
          const inRepository = input !== "." && input !== ".." && !input.startsWith("../");
          // Host support uses file-level include filters, which have explicit release owners.
          const filteredSourceSet = input === "host-support/src/main/java" && /^(?:srcDirs?|setSrcDirs)$/.test(call[1]);
          if (inRepository && !isNonReleasePath(input + "/") && !filteredSourceSet) paths.add(input);
        }
      }
      if (depth === 0) break;
    }
  }
  return paths;
}

// Preserve positions and evaluated interpolations while hiding literal text.
function maskStringLiterals(code) {
  return code.replace(quoted, value => {
    if (value.startsWith("'")) return blank(value);
    let masked = "";
    let from = 0;
    for (const match of value.matchAll(/(?<!\\)\$\{([^{}]*)\}|(?<!\\)\$(libs)\b/g)) {
      const expression = match[1] ?? match[2];
      const start = match.index + (match[1] !== undefined ? 2 : 1);
      masked += blank(value.slice(from, start)) + expression;
      from = start + expression.length;
    }
    return masked + blank(value.slice(from));
  });
}

function references(source, file, entries, module, inherited) {
  const nestedComments = /\.kts?$/.test(file);
  const {production, calls} = testDependencies(source, nestedComments, inherited);
  const code = withoutComments(production, nestedComments);
  const testPaths = localPaths(calls.join("\n"), module);
  const executable = maskStringLiterals(code);
  const inCode = index => executable[index] !== " ";
  const projectReferences = [...code.matchAll(literalProject)].filter(match => inCode(match.index));
  const projects = projectReferences.map(([, , name]) => name.slice(1).replaceAll(":", "/"));
  const resolvedProjectCalls = new Set(projectReferences.map(match => match.index));
  const paths = localPaths(code, module);
  const aliases = new Set();
  let unknownCatalog = false;
  const pluginIds = new Set();
  const pluginCalls = /\b(?:id\s*\(\s*|apply\s*\(\s*plugin\s*=\s*)(["'])([\w.-]+)\1\s*\)/g;
  const groovyPlugins = /\b(?:id\s+|apply\s+plugin\s*:\s*)(["'])([\w.-]+)\1/g;
  for (const pattern of nestedComments ? [pluginCalls] : [pluginCalls, groovyPlugins]) {
    for (const match of code.matchAll(pattern)) {
      if (inCode(match.index)) pluginIds.add(match[2]);
    }
  }
  for (const [key, entry] of entries) {
    if (!key.startsWith("plugins:")) continue;
    const id = typeof entry.value === "string" ? entry.value.split(":")[0] : entry.value?.id;
    if (pluginIds.has(id)) aliases.add(key);
  }
  const activeCode = module === "." ? code.replace(
    /\balias\s*\(\s*libs\.plugins\.[\w.]+\s*\)\s*apply\s+false\b/g,
    (match, index) => inCode(index) ? blank(match) : match) : code;
  const remaining = activeCode.replace(/(?:\b(?:named|getByName)\s*\(\s*"libs"\s*\)\s*\.\s*)?\bfind(Version|Library|Bundle|Plugin)\s*\(\s*"([\w.-]+)"\s*\)/g,
      (match, kind, name, index) => {
        if (!inCode(index)) return match;
        const section = {Version: "versions", Library: "libraries", Bundle: "bundles", Plugin: "plugins"}[kind];
        aliases.add(section + ":" + normalize(name));
        return blank(match);
      });
  const accessorCode = maskStringLiterals(remaining);
  const accessors = accessorCode.replace(/\blibs(?:\s*\.\s*[\w]+)+/g, match => {
    const [, ...parts] = match.replace(/\s/g, "").split(".");
    const section = sections.includes(parts[0]) && parts[0] !== "libraries" ? parts.shift() : "libraries";
    while (parts.length && !entries.has(section + ":" + parts.join(".")) &&
      /^(?:asProvider|get|getOrNull|map|flatMap|orElse|orNull|isPresent)$/.test(parts.at(-1))) parts.pop();
    const key = section + ":" + parts.join(".");
    if (entries.has(key)) aliases.add(key);
    else unknownCatalog = true;
    return blank(match);
  });

  const unresolvedCatalogCalls = /\b(?:named|getByName)\s*\(\s*"libs"\s*\)|\bfind(?:Version|Library|Bundle|Plugin)\s*\(/g;
  const projectCalls = /\bprojects\s*\.|\bproject\s*\(/g;
  return {
    aliases, paths, projects, testPaths, production,
    unknownCatalog: unknownCatalog || /\blibs\b/.test(accessors) ||
      [...remaining.matchAll(unresolvedCatalogCalls)].some(match => inCode(match.index)),
    unknownProjects: [...executable.matchAll(projectCalls)].some(match => !resolvedProjectCalls.has(match.index)),
  };
}

function readCatalog(source) {
  try {
    return parse(source);
  } catch (error) {
    // An intermediate commit can have invalid TOML even when the release tip is valid.
    if (!(error instanceof TomlError)) throw error;
    return null;
  }
}

function catalogEntries(catalog) {
  const entries = new Map();
  for (const section of sections) {
    for (const [name, value] of Object.entries(catalog[section] ?? {})) {
      const key = section + ":" + normalize(name);
      if (section === "bundles" && Array.isArray(value)) {
        entries.set(key, value.map(alias => entries.get("libraries:" + normalize(String(alias)))));
      } else {
        const ref = value?.version?.ref;
        entries.set(key, {value, version: typeof ref === "string" ? entries.get("versions:" + normalize(ref)) : undefined});
      }
    }
  }
  return entries;
}

// Read committed build inputs without checking out each revision. Cache by blob
// and snapshot for the duration of one release analysis.
export function buildInputReader(cwd, runtimes) {
  const blobs = new Map();
  const snapshots = new Map();
  const models = new Map();
  const git = (args, options = {}) => execFileSync("git", args, {cwd, maxBuffer: 32 * 1024 * 1024, ...options});
  const gitText = args => git(args, {encoding: "utf8"});

  function readBlobs(hashes) {
    const missing = [...new Set(hashes)].filter(hash => !blobs.has(hash));
    if (!missing.length) return;
    const output = git(["cat-file", "--batch"], {input: missing.join("\n") + "\n"});
    let offset = 0;
    for (const hash of missing) {
      const end = output.indexOf(10, offset);
      const [object, type, size] = output.toString("ascii", offset, end).split(" ");
      if (object !== hash || type !== "blob" || !/^\d+$/.test(size)) throw new Error("Invalid Git blob " + hash);
      offset = end + 1;
      blobs.set(hash, output.toString("utf8", offset, offset + Number(size)));
      offset += Number(size) + 1;
    }
  }

  function snapshot(revision) {
    if (!revision) return null;
    if (snapshots.has(revision)) return snapshots.get(revision);
    const tracked = new Map();
    for (const entry of gitText(["ls-tree", "-rz", revision]).split("\0").filter(Boolean)) {
      const [meta, file] = entry.split(/\t(.*)/s);
      if (isNonReleasePath(file)) continue;
      if (file === catalogPath || /\.gradle(?:\.kts)?$/.test(file) ||
          /^buildSrc\/src\/main\/.*\.(?:kt|java|groovy)$/.test(file)) {
        tracked.set(file, meta.split(" ")[2]);
      }
    }
    if (!Object.values(runtimes).some(([module]) => tracked.has(module + "/build.gradle.kts") ||
        tracked.has(module + "/build.gradle"))) {
      snapshots.set(revision, null);
      return null;
    }

    const modelKey = JSON.stringify([...tracked]);
    if (models.has(modelKey)) {
      const model = models.get(modelKey);
      snapshots.set(revision, model);
      return model;
    }

    readBlobs(tracked.values());
    const catalog = readCatalog(blobs.get(tracked.get(catalogPath)) ?? "");
    const entries = catalogEntries(catalog ?? {});
    const scripts = new Map();
    const global = [];
    const productionScripts = new Map();
    const sources = [];
    const sharedConfigurations = [];
    for (const [file, hash] of tracked) {
      if (file === catalogPath) continue;
      const module = path.dirname(file);
      const buildScript = /(?:^|\/)build\.gradle(?:\.kts)?$/.test(file);
      const source = blobs.get(hash);
      sources.push({file, module, buildScript, source});
      const names = sharedTestConfigurations(source, file, buildScript);
      if (names.size) sharedConfigurations.push({scope: buildScript ? module : ".", names});
    }
    for (const {file, module, buildScript, source} of sources) {
      const inherited = new Set();
      for (const {scope, names} of sharedConfigurations) {
        if (scope === "." || module.startsWith(scope + "/")) {
          for (const name of names) inherited.add(name);
        }
      }
      const inputs = references(source, file, entries, module, inherited);
      if (buildScript) productionScripts.set(file, inputs.production);
      if (buildScript && module !== "." && !module.startsWith("buildSrc")) scripts.set(module, inputs);
      else global.push(inputs);
    }

    const projectRoots = [...scripts.keys()];
    const explicitInputs = new Set();
    const testInputs = new Set();
    for (const {paths, testPaths} of [...scripts.values(), ...global]) {
      for (const input of paths) explicitInputs.add(input);
      for (const input of testPaths) testInputs.add(input);
    }
    const consumers = new Map();
    for (const [id, [root]] of Object.entries(runtimes)) {
      if (!scripts.has(root)) continue;
      const aliases = new Set();
      const paths = new Set();
      const modules = new Set();
      let unknownCatalog = false;
      let unknownProjects = false;
      function include(input) {
        for (const alias of input.aliases) aliases.add(alias);
        for (const file of input.paths) paths.add(file);
        unknownCatalog ||= input.unknownCatalog;
        unknownProjects ||= input.unknownProjects;
      }
      function visit(module) {
        if (modules.has(module)) return;
        modules.add(module);
        const inputs = scripts.get(module);
        if (inputs) {
          include(inputs);
          inputs.projects.forEach(visit);
        } else {
          unknownProjects = true;
        }
      }
      for (const input of global) {
        include(input);
        input.projects.forEach(visit);
      }
      visit(root);
      consumers.set(id, {aliases, modules, paths, unknownCatalog, unknownProjects});
    }

    const result = {catalog, entries, consumers, projectRoots, explicitInputs, testInputs, productionScripts};
    models.set(modelKey, result);
    snapshots.set(revision, result);
    return result;
  }

  return revisions => {
    if (revisions.length === 2) return revisions.map(snapshot);
    const [commit, parent] = gitText(["rev-list", "--parents", "-n", "1", revisions[0]]).trim().split(" ");
    return [snapshot(parent), snapshot(commit)];
  };
}

export function hasRuntimeBuildInputs(runtime, [before, after]) {
  return before?.consumers.has(runtime) && after?.consumers.has(runtime);
}

export function catalogAffectsRuntime(runtime, before, after) {
  if (!before.catalog || !after.catalog) return true;
  if (isDeepStrictEqual(before.catalog, after.catalog)) return false;
  if ([before, after].some(({catalog}) => Object.keys(catalog).some(key => !sections.includes(key)))) return true;
  const old = before.consumers.get(runtime);
  const current = after.consumers.get(runtime);
  if ([old, current].some(input => input.unknownCatalog || input.unknownProjects)) return true;
  for (const key of new Set([...old.aliases, ...current.aliases])) {
    if (!isDeepStrictEqual(before.entries.get(key), after.entries.get(key))) return true;
  }
  return false;
}

export function unchangedProductionScript(file, [before, after]) {
  const original = before?.productionScripts.get(file);
  return original !== undefined && original === after?.productionScripts.get(file);
}

function enclosingProject(file, roots) {
  let root = "";
  for (const project of roots) {
    if (project.length > root.length && file.startsWith(project + "/")) root = project;
  }
  return root;
}

function isAuxiliaryFile(file, root) {
  const separator = root ? root.length : file.indexOf("/");
  if (separator === -1) return false;
  const relative = file.slice(separator + 1);
  return /^(?:src\/(?:test|androidTest)\/|(?:README|CHANGELOG)\.md$)/.test(relative);
}

export function isAuxiliaryModulePath(file, snapshots) {
  const root = enclosingProject(file, snapshots.flatMap(snapshot => snapshot.projectRoots));
  return isAuxiliaryFile(file, root);
}

export function buildPathOwners(file, snapshots) {
  const owners = new Set();
  const includes = input => file === input || file.startsWith(input + "/");
  let recognized = false;
  for (const {projectRoots, explicitInputs, testInputs, consumers} of snapshots) {
    const root = enclosingProject(file, projectRoots);
    const auxiliary = isAuxiliaryFile(file, root);
    const productionInput = Boolean(root && !auxiliary) || [...explicitInputs].some(includes);
    recognized ||= auxiliary || productionInput || [...testInputs].some(includes);
    for (const [id, {modules, paths, unknownProjects}] of consumers) {
      // A nested Gradle project owns its own sources. Explicit inputs can cross that boundary.
      const moduleSource = !auxiliary && [...modules].some(module => module.length >= root.length && includes(module));
      if (moduleSource || [...paths].some(includes) || (unknownProjects && productionInput)) owners.add(id);
    }
  }
  return recognized || owners.size ? owners : null;
}
