import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function inside(path, directory) {
  return path === directory || path.startsWith(directory + sep);
}

function moduleOf(path, root) {
  const rel = relative(root, path).split(sep);
  if (rel.length < 3 || !["packages", "apps"].includes(rel[0])) return null;
  if (rel[2] !== "src") return null;
  return rel[0] + "/" + rel[1];
}

function importsIn(file, content) {
  const fileAst = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Set();
  const unresolved = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      imports.add(node.moduleReference.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      imports.add(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        imports.add(first.text);
      } else {
        const line = fileAst.getLineAndCharacterOfPosition(node.getStart(fileAst)).line + 1;
        const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require";
        unresolved.push({ kind, line });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fileAst);
  return { specifiers: [...imports], unresolved };
}

function destinationOf(specifier, file, root) {
  if (specifier.startsWith(".")) {
    const path = resolve(dirname(file), specifier);
    return { module: moduleOf(path, root), path, isRelative: true };
  }
  if (specifier.startsWith("@cookie/")) {
    const parts = specifier.split("/");
    if (parts.length < 2 || !parts[1]) return { module: null, path: null, isAlias: true };
    return { module: "packages/" + parts[1], path: null, isAlias: true, isPublic: parts.length === 2 };
  }
  return null;
}

export function checkFileImports({ root, file, content, exceptions = new Set() }) {
  const sourceModule = moduleOf(file, root);
  if (!sourceModule) return { failures: [], usedExceptions: [] };
  const from = relative(root, file).split(sep).join("/");
  const failures = [], usedExceptions = [];
  const scan = importsIn(file, content);
  for (const { kind, line } of scan.unresolved) {
    failures.push(from + ":" + line + ": computed " + kind + "() specifier cannot be audited (Issue #201)");
  }
  for (const specifier of scan.specifiers) {
    const destination = destinationOf(specifier, file, root);
    if (!destination) continue; // External packages and Node builtins.
    const label = from + " imports " + specifier;
    if (!destination.module) {
      failures.push(label + ": relative import escapes a production module");
      continue;
    }
    if (sourceModule === destination.module) {
      if (destination.isRelative && !inside(destination.path, join(root, sourceModule, "src"))) {
        failures.push(label + ": production code imports outside its own src directory");
      }
      continue;
    }
    if (destination.isAlias && destination.isPublic && ["packages/contracts", "packages/kernel"].includes(destination.module) && sourceModule !== "packages/contracts") {
      continue;
    }
    // Public capability entrypoints are the only allowed cross-package
    // relative imports. Keep these explicit until package exports/aliases are
    // configured. Kernel and Contracts must never depend on business/platform.
    if (
      destination.isRelative &&
      destination.module.startsWith("packages/") &&
      !["packages/kernel", "packages/contracts"].includes(sourceModule) &&
      destination.path === join(root, destination.module, "src/index.js")
    ) {
      continue;
    }
    const exception = from + "|" + specifier;
    if (exceptions.has(exception)) {
      usedExceptions.push(exception);
      continue;
    }
    failures.push(label + ": cross-module implementation import is not an approved public port (Issue #201)");
  }
  return { failures, usedExceptions };
}

/** Fail closed on direct and transitive module cycles, including legacy imports. */
export function findModuleCycles(dependencies) {
  const graph = new Map();
  for (const [from, to] of dependencies) {
    if (from === to) continue;
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  }
  const states = new Map();
  const stack = [];
  const cycles = [];
  function visit(module) {
    states.set(module, "visiting");
    stack.push(module);
    for (const dependency of [...(graph.get(module) || [])].sort()) {
      if (states.get(dependency) === "visiting") {
        const index = stack.indexOf(dependency);
        cycles.push([...stack.slice(index), dependency].join(" -> "));
      } else if (!states.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    states.set(module, "done");
  }
  for (const module of [...graph.keys()].sort()) {
    if (!states.has(module)) visit(module);
  }
  return cycles.sort();
}

async function sourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.(?:cts|mts|tsx|ts)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export async function checkRepository(root) {
  const debt = JSON.parse(await readFile(join(root, "scripts/module-boundaries-legacy.json"), "utf8"));
  const allowed = new Set();
  const failures = [];
  for (const [path, specifiers] of Object.entries(debt)) {
    if (!Array.isArray(specifiers)) {
      failures.push("Invalid legacy list for " + path);
      continue;
    }
    for (const specifier of specifiers) {
      const exception = path + "|" + specifier;
      if (allowed.has(exception)) failures.push("Duplicate legacy exception: " + exception);
      allowed.add(exception);
    }
  }
  const sources = [];
  for (const directory of [join(root, "packages"), join(root, "apps")]) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) sources.push(...(await sourceFiles(join(directory, entry.name, "src"))));
    }
  }
  const usedExceptions = new Set();
  const dependencies = [];
  for (const file of sources) {
    const content = await readFile(file, "utf8");
    const sourceModule = moduleOf(file, root);
    for (const specifier of importsIn(file, content).specifiers) {
      const destination = destinationOf(specifier, file, root);
      if (sourceModule && destination?.module && destination.module !== sourceModule) {
        dependencies.push([sourceModule, destination.module]);
      }
    }
    const report = checkFileImports({ root, file, content, exceptions: allowed });
    failures.push(...report.failures);
    for (const exception of report.usedExceptions) usedExceptions.add(exception);
  }
  for (const cycle of findModuleCycles(dependencies)) {
    failures.push("Module dependency cycle: " + cycle);
  }
  for (const exception of allowed) {
    if (!usedExceptions.has(exception)) failures.push("Stale legacy exception: " + exception + " (remove it from the baseline)");
  }
  return { failures, checkedFiles: sources.length, legacyImports: usedExceptions.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, checkedFiles, legacyImports } = await checkRepository(repositoryRoot);
  if (failures.length) {
    for (const failure of failures) process.stderr.write(failure + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("Module boundary check passed (" + checkedFiles + " production files; " + legacyImports + " explicitly grandfathered imports).\n");
  }
}
