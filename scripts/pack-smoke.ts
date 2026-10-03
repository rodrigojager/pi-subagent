import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type PackedFile = {
  path?: string;
};

type PackResult = {
  files?: PackedFile[];
};

const root = process.cwd();
const requiredFiles = [
  "package.json",
  "README.md",
  "tsconfig.json",
  "src/index.ts",
  "src/roles/index.ts",
  "scripts/import-agency-roles.ts",
  "docs/roles.md",
  "docs/roles-migration.md",
  "skills/pi-subagent-usage/SKILL.md",
];
const forbiddenPatterns = [
  /^test\//,
  /^\.github\//,
  /^proposals\//,
  /^best-practices-proposal\.md$/,
  /^bun\.lock$/,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stats = statSync(path);
    return stats.isDirectory()
      ? sourceFiles(path)
      : [relative(root, path).replaceAll("\\", "/")];
  });
}

function parsePackOutput(output: string): PackResult {
  const results = JSON.parse(output) as PackResult[];
  const result = results[0];
  if (!result) throw new Error("npm pack returned no package metadata");
  return result;
}

function assertNoMissing(
  files: Set<string>,
  expected: string[],
  label: string,
): void {
  const missing = expected.filter((file) => !files.has(file));
  if (missing.length > 0)
    throw new Error(
      `${label} missing from npm package:\n${missing.map((file) => `  - ${file}`).join("\n")}`,
    );
}

function assertNoForbidden(files: string[]): void {
  const forbidden = files.filter((file) =>
    forbiddenPatterns.some((pattern) => pattern.test(file)),
  );
  if (forbidden.length > 0)
    throw new Error(
      `Forbidden files included in npm package:\n${forbidden.map((file) => `  - ${file}`).join("\n")}`,
    );
}

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
});
const pack = parsePackOutput(output);
const packedFiles = (pack.files ?? [])
  .map((file) => file.path)
  .filter((path): path is string => Boolean(path));
const packedFileSet = new Set(packedFiles);
assertNoMissing(packedFileSet, requiredFiles, "Required files");
assertNoMissing(packedFileSet, sourceFiles(join(root, "src")), "Source files");
assertNoForbidden(packedFiles);
console.log(`npm pack dry-run passed (${packedFiles.length} files)`);
