import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { discoverRoles, hashRole, isRoleId } from "../src/roles/index.js";

const git = promisify(execFile);
const SOURCE = "https://github.com/msitarzewski/agency-agents";
const CATEGORIES = new Set([
  "academic",
  "design",
  "engineering",
  "finance",
  "game-development",
  "gis",
  "healthcare",
  "marketing",
  "paid-media",
  "product",
  "project-management",
  "research",
  "sales",
  "security",
  "spatial-computing",
  "specialized",
  "support",
  "testing",
]);
interface ImportedRole {
  sourcePath: string;
  id: string;
  category: string;
  name: string;
  description: string;
  body: string;
  originalHash: string;
}
interface ManagedRole {
  id: string;
  destination: string;
  originalHash: string;
  installedHash: string;
  revision: string;
}
interface Manifest {
  source: string;
  revision: string;
  roles: Record<string, ManagedRole>;
}
export interface ImportOptions {
  source: string;
  rolesRoot: string;
  provenanceRoot: string;
  list?: boolean;
  all?: boolean;
  select?: string[];
  categories?: string[];
  dryRun?: boolean;
  update?: boolean;
  resolve?: "keep" | "replace";
  mappings?: Record<string, string>;
}
async function existing(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function scanAgencyRoles(
  source: string,
  mappings: Record<string, string> = {},
): Promise<ImportedRole[]> {
  const roles: ImportedRole[] = [];
  async function walk(dir: string, category: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !/translations|examples|integrations|scripts|runbooks/i.test(entry.name)
      ) {
        await walk(file, category);
        continue;
      }
      if (
        !entry.isFile() ||
        !/^[a-z0-9][a-z0-9._-]*\.md$/.test(entry.name) ||
        /^(readme|license|contributing)|(?:^|[-_.])(zh|cn|ja|ko)(?:[-_.]|$)/i.test(
          entry.name,
        )
      )
        continue;
      const content = await readFile(file, "utf8");
      let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
      try {
        parsed = parseFrontmatter<Record<string, unknown>>(content);
      } catch {
        continue;
      }
      const f = parsed.frontmatter;
      if (
        typeof f["name"] !== "string" ||
        typeof f["description"] !== "string" ||
        !f["name"].trim() ||
        !f["description"].trim() ||
        !parsed.body.trim()
      )
        continue;
      const sourcePath = path.relative(source, file).split(path.sep).join("/");
      const filename = entry.name.slice(0, -3);
      const id =
        mappings[sourcePath] ??
        (filename.startsWith(`${category}-`)
          ? filename.slice(category.length + 1)
          : filename);
      if (!isRoleId(id))
        throw new Error(`Invalid mapping ${sourcePath} -> ${id}`);
      // Preserve the original instruction body, including whitespace/newlines.
      const match = content
        .replace(/^\uFEFF/, "")
        .match(
          /^---[^\r\n]*\r?\n[\s\S]*?\r?\n---[^\r\n]*(?:\r?\n|$)([\s\S]*)$/,
        );
      if (!match) continue;
      roles.push({
        sourcePath,
        id,
        category,
        name: f["name"],
        description: f["description"],
        body: match[1] ?? "",
        originalHash: hashRole(content),
      });
    }
  }
  for (const entry of await readdir(source, { withFileTypes: true }))
    if (entry.isDirectory() && CATEGORIES.has(entry.name))
      await walk(path.join(source, entry.name), entry.name);
  return roles.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}
export async function importAgencyRoles(options: ImportOptions) {
  // Validate source/revision/license and all collisions before catalog mutation.
  const revision = (
    await git("git", ["rev-parse", "HEAD"], { cwd: options.source })
  ).stdout.trim();
  const license = await readFile(path.join(options.source, "LICENSE"), "utf8");
  if (!license.includes("MIT License"))
    throw new Error(
      "Expected MIT license; inspect the current source license before importing.",
    );
  const manifestFile = path.join(options.provenanceRoot, "manifest.json");
  const previousText = await existing(manifestFile);
  const previous = previousText
    ? (JSON.parse(previousText) as Manifest)
    : undefined;
  const mappings = {
    ...Object.fromEntries(
      Object.entries(previous?.roles ?? {}).map(([key, role]) => [
        key,
        role.id,
      ]),
    ),
    ...options.mappings,
  };
  const catalog = await scanAgencyRoles(options.source, mappings);
  const duplicates = catalog.filter((r, i) =>
    catalog.some((other, j) => j !== i && other.id === r.id),
  );
  if (duplicates.length)
    throw new Error(
      `Role ID collisions; provide --map <JSON-file> with source-path to unique ID mappings: ${duplicates.map((r) => `${r.sourcePath} -> ${r.id}`).join(", ")}`,
    );
  if (options.list)
    return {
      revision,
      catalog: catalog.map(({ body: _body, ...metadata }) => metadata),
    };
  if (!options.all && !options.select?.length && !options.categories?.length)
    throw new Error(
      "Select --all, --select <IDs>, or --category <categories>; use --list for a preview.",
    );
  for (const id of options.select ?? [])
    if (!catalog.some((r) => r.id === id))
      throw new Error(`Unknown selected role: ${id}`);
  for (const category of options.categories ?? [])
    if (!CATEGORIES.has(category))
      throw new Error(`Unknown category: ${category}`);
  const selected = catalog.filter(
    (r) =>
      options.all ||
      options.select?.includes(r.id) ||
      options.categories?.includes(r.category),
  );
  const counts = {
    imported: 0,
    updated: 0,
    unchanged: 0,
    conflicts: 0,
    skipped: catalog.length - selected.length,
    failed: 0,
  };
  const managed = { ...previous?.roles };
  const conflicts: string[] = [];
  const localCatalog = await discoverRoles({
    cwd: options.rolesRoot,
    agentDir: path.dirname(options.rolesRoot),
  });
  const scheduled: {
    destination: string;
    content: string;
    role: ImportedRole;
    hash: string;
    prior?: string;
  }[] = [];
  for (const role of selected) {
    const record = managed[role.sourcePath];
    const relativeDestination =
      record?.destination ?? `${role.category}/${role.id}.md`;
    if (
      path.isAbsolute(relativeDestination) ||
      relativeDestination.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid managed destination path");
    const destination = path.join(options.rolesRoot, relativeDestination);
    const content = `---\nname: ${JSON.stringify(role.name)}\ndescription: ${JSON.stringify(role.description)}\ncategory: ${JSON.stringify(role.category)}\nsource: ${SOURCE}\nsource_path: ${role.sourcePath}\nsource_revision: ${revision}\n---\n${role.body}`;
    const hash = hashRole(content);
    const installed = await existing(destination);
    const other = localCatalog.roles.find(
      (r) =>
        r.id === role.id &&
        path.resolve(r.sourcePath) !== path.resolve(destination),
    );
    const edited =
      installed !== undefined &&
      (!record || hashRole(installed) !== record.installedHash);
    if (
      other ||
      localCatalog.rejected.has(role.id) ||
      (edited && options.resolve !== "replace")
    ) {
      counts.conflicts++;
      conflicts.push(role.id);
      if (!options.dryRun && options.resolve !== "keep")
        await atomicWrite(
          path.join(
            options.provenanceRoot,
            "conflicts",
            `${role.id}.proposed.md`,
          ),
          content,
        );
      continue;
    }
    if (installed === content) {
      counts.unchanged++;
      continue;
    }
    if (
      record &&
      installed !== undefined &&
      !options.update &&
      options.resolve !== "replace"
    ) {
      counts.skipped++;
      continue;
    }
    if (installed === undefined) counts.imported++;
    else counts.updated++;
    scheduled.push({
      destination,
      content,
      role,
      hash,
      ...(installed !== undefined ? { prior: installed } : {}),
    });
    managed[role.sourcePath] = {
      id: role.id,
      destination: relativeDestination,
      originalHash: role.originalHash,
      installedHash: hash,
      revision,
    };
  }
  if (!options.dryRun) {
    await atomicWrite(path.join(options.provenanceRoot, "LICENSE"), license);
    for (const write of scheduled) {
      if (write.prior !== undefined && options.resolve === "replace")
        await atomicWrite(
          path.join(
            options.provenanceRoot,
            "backups",
            `${write.role.id}.${crypto.randomUUID()}.md`,
          ),
          write.prior,
        );
      await mkdir(path.dirname(write.destination), { recursive: true });
      if (write.prior === undefined)
        await writeFile(write.destination, write.content, { flag: "wx" });
      else {
        if ((await existing(write.destination)) !== write.prior)
          throw new Error(
            `Role changed during import: ${write.role.id}; preserved current file`,
          );
        await atomicWrite(write.destination, write.content);
      }
    }
    await atomicWrite(
      manifestFile,
      `${JSON.stringify({ source: SOURCE, revision, roles: managed }, null, 2)}\n`,
    );
  }
  return {
    revision,
    rolesRoot: options.rolesRoot,
    dryRun: options.dryRun ?? false,
    counts,
    conflicts,
  };
}
async function main(args: string[]) {
  const flags = new Set(["--list", "--all", "--dry-run", "--update"]);
  const values = new Set([
    "--source",
    "--scope",
    "--cwd",
    "--select",
    "--category",
    "--resolve",
    "--map",
  ]);
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") continue; // Bun run argument forwarding
    if (flags.has(arg)) parsed[arg] = true;
    else if (values.has(arg) && args[i + 1] && !args[i + 1]?.startsWith("--"))
      parsed[arg] = args[++i] ?? "";
    else throw new Error(`Invalid or missing importer argument: ${arg}`);
  }
  const scope = parsed["--scope"] ?? "user";
  if (scope !== "user" && scope !== "project")
    throw new Error("Scope must be user or project");
  const resolve = parsed["--resolve"];
  if (resolve !== undefined && resolve !== "keep" && resolve !== "replace")
    throw new Error("--resolve must be keep or replace");
  const cwd = path.resolve(String(parsed["--cwd"] ?? process.cwd()));
  const base = scope === "user" ? getAgentDir() : path.join(cwd, ".pi");
  const provenanceRoot = path.join(base, "role-sources", "agency-agents");
  let source = parsed["--source"]
    ? path.resolve(String(parsed["--source"]))
    : path.join(getAgentDir(), "role-sources", "agency-agents");
  if (!parsed["--source"]) {
    try {
      await stat(path.join(source, ".git"));
    } catch {
      if (parsed["--dry-run"])
        throw new Error(
          "Dry-run requires an existing source checkout; supply --source.",
        );
      await mkdir(path.dirname(source), { recursive: true });
      await git("git", ["clone", "--depth", "1", `${SOURCE}.git`, source]);
    }
    if (parsed["--update"] && !parsed["--dry-run"]) {
      await git("git", ["fetch", "origin", "main", "--depth", "1"], {
        cwd: source,
      });
      await git("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: source });
    }
  }
  source = path.resolve(source);
  const mappings = parsed["--map"]
    ? (JSON.parse(await readFile(String(parsed["--map"]), "utf8")) as Record<
        string,
        string
      >)
    : {};
  const output = await importAgencyRoles({
    source,
    rolesRoot: path.join(base, "roles"),
    provenanceRoot,
    list: parsed["--list"] === true,
    all: parsed["--all"] === true,
    dryRun: parsed["--dry-run"] === true,
    update: parsed["--update"] === true,
    ...(resolve ? { resolve } : {}),
    select: String(parsed["--select"] ?? "")
      .split(",")
      .filter(Boolean),
    categories: String(parsed["--category"] ?? "")
      .split(",")
      .filter(Boolean),
    mappings,
  });
  console.log(JSON.stringify(output, null, 2));
}
if (import.meta.main)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
