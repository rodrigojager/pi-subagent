import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isRoleId } from "./request.js";
import type { RoleCatalog, RoleDocument } from "./types.js";

export const hashRole = (content: string) =>
  createHash("sha256").update(content).digest("hex");
export async function nearestRolesRoot(
  cwd: string,
): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".pi", "roles");
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
export function parseRoleDocument(
  content: string,
  file: string,
  source: RoleDocument["source"],
): RoleDocument {
  const id = path.basename(file, ".md");
  if (!isRoleId(id)) throw new Error("Invalid or reserved filename ID");
  const text = content.replace(/^\uFEFF/, "");
  if (
    /^---\s*\r?\n/.test(text) &&
    !/^---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n|\s*$)/.test(text)
  )
    throw new Error("Unterminated frontmatter");
  const { frontmatter: f, body } =
    parseFrontmatter<Record<string, unknown>>(text);
  if (!f || typeof f !== "object" || Array.isArray(f))
    throw new Error("Invalid frontmatter object");
  if (f["id"] !== undefined && f["id"] !== id)
    throw new Error("Metadata ID disagrees with filename");
  if (!body.trim()) throw new Error("Empty role body");
  for (const key of [
    "name",
    "description",
    "category",
    "source_revision",
    "source",
  ])
    if (f[key] !== undefined && typeof f[key] !== "string")
      throw new Error(`Invalid ${key} metadata`);
  return {
    id,
    name:
      typeof f["name"] === "string" && f["name"].trim()
        ? f["name"].trim()
        : id
            .split(/[._-]/)
            .map((w) => w[0]?.toUpperCase() + w.slice(1))
            .join(" "),
    description: typeof f["description"] === "string" ? f["description"] : "",
    category: typeof f["category"] === "string" ? f["category"] : "",
    source,
    sourcePath: file,
    body,
    contentHash: hashRole(text),
    sourceRevision: f["source_revision"] as string | undefined,
    sourceUrl: f["source"] as string | undefined,
  };
}
async function scan(
  root: string,
  source: RoleDocument["source"],
  diagnostics: string[],
) {
  const entries = new Map<string, RoleDocument | "invalid" | "unreadable">();
  const duplicates = new Set<string>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return entries;
  }
  async function walk(dir: string): Promise<void> {
    let files: Dirent[];
    try {
      files = await readdir(dir, { withFileTypes: true });
    } catch {
      diagnostics.push(`${dir}: unreadable directory`);
      return;
    }
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const id = path.basename(entry.name, ".md");
      if (!isRoleId(id)) {
        diagnostics.push(`${file}: invalid filename ID`);
        continue;
      }
      if (entries.has(id)) {
        duplicates.add(id);
        entries.set(id, "invalid");
        diagnostics.push(`${source}: ambiguous role ID ${id}`);
        continue;
      }
      try {
        const resolved = await realpath(file);
        const relative = path.relative(canonicalRoot, resolved);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error("Role link leaves scope root");
        const content = await readFile(file, "utf8");
        try {
          entries.set(id, parseRoleDocument(content, file, source));
        } catch (error) {
          entries.set(id, "invalid");
          diagnostics.push(`${file}: ${String(error)}`);
        }
      } catch (error) {
        entries.set(id, "unreadable");
        diagnostics.push(`${file}: ${String(error)}`);
      }
    }
  }
  await walk(root);
  for (const id of duplicates) entries.set(id, "invalid");
  return entries;
}
/** Fresh filesystem snapshots avoid cross-workspace/trust cache leakage. No network. */
export async function discoverRoles(options: {
  cwd: string;
  agentDir?: string;
  allowProject?: boolean;
}): Promise<RoleCatalog> {
  const userRoot = path.join(options.agentDir ?? getAgentDir(), "roles");
  const projectRoot = options.allowProject
    ? await nearestRolesRoot(options.cwd)
    : undefined;
  const diagnostics: string[] = [];
  const [user, project] = await Promise.all([
    scan(userRoot, "user", diagnostics),
    projectRoot
      ? scan(projectRoot, "project", diagnostics)
      : new Map<string, RoleDocument | "invalid" | "unreadable">(),
  ]);
  const merged = new Map([...user, ...project]);
  const roles: RoleDocument[] = [];
  const rejected: RoleCatalog["rejected"] = new Map();
  for (const [id, entry] of merged) {
    if (typeof entry === "string") rejected.set(id, entry);
    else roles.push(entry);
  }
  return {
    roles: roles.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
    rejected,
    userRoot,
    projectRoot,
  };
}
