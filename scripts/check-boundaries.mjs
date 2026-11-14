import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protectedPackages = [
  { name: "contracts", path: join(root, "packages/contracts/src") },
  { name: "kernel", path: join(root, "packages/kernel/src") },
];

async function typescriptFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typescriptFiles(path)));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function inside(path, directory) {
  return path === directory || path.startsWith(directory + sep);
}

const failures = [];
let checkedFiles = 0;

for (const target of protectedPackages) {
  for (const file of await typescriptFiles(target.path)) {
    checkedFiles += 1;
    const source = await readFile(file, "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;

    for (const item of imports) {
      const specifier = item.fileName;
      let violates = false;

      if (specifier.startsWith("@cookie/")) {
        // Kernel and contracts are upstream, never depend on platform/domain.
        violates = !["@cookie/contracts", "@cookie/kernel"].includes(specifier);
      } else if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier);
        const packageRoot = join(root, "packages");
        const appRoot = join(root, "apps");
        // Relative imports may only use this package or upstream contracts.
        violates =
          inside(resolved, appRoot) ||
          (inside(resolved, packageRoot) &&
            !inside(resolved, target.path) &&
            !inside(resolved, join(root, "packages/contracts/src")) &&
            !inside(resolved, join(root, "packages/kernel/src")));
      }

      if (violates) {
        failures.push(`${relative(root, file)} imports forbidden layer: ${specifier}`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const violation of failures) process.stderr.write(`${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Module boundary check passed (${checkedFiles} source files).\n`);
}
