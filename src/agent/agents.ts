import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { declaredRole } from "../roles/request.js";
import { isValidSamplingValue } from "../shared/sampling.js";

export type AgentSource = "user" | "project";
export type AgentScope = AgentSource | "both";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
  role?: string | undefined;
  roleDiagnostic?: string | undefined;
  name: string;
  description: string;
  context?: false | undefined;
  tools?: string[] | undefined;
  skills?: string[] | false | undefined;
  extensions?: string[] | undefined;
  thinking?: ThinkingLevel | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  replacePrompt?: true | undefined;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryScopeResult {
  agents: AgentConfig[];
  markdownFiles: string[];
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  scopes: Record<AgentSource, AgentDiscoveryScopeResult>;
}

function mergeAgentLists(
  userResult: AgentDiscoveryScopeResult,
  projectResult: AgentDiscoveryScopeResult,
  projectAgentsDir: string | null,
): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of userResult.agents) agentMap.set(agent.name, agent);
  for (const agent of projectResult.agents) agentMap.set(agent.name, agent);
  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    scopes: {
      user: userResult,
      project: projectResult,
    },
  };
}

function parseCommaList(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseExtensions(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === false || Array.isArray(raw)) return [];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const items = trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return undefined;
}

function parseThinkingLevel(raw: unknown): ThinkingLevel | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(normalized)
    ? (normalized as ThinkingLevel)
    : undefined;
}

function parseOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isNonStringOptional(raw: unknown): boolean {
  return raw != null && typeof raw !== "string";
}

function parseSamplingValue(
  raw: unknown,
  field: string,
  agentName: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (isValidSamplingValue(raw)) return raw;
  console.warn(
    `Warning: Agent '${agentName}' has invalid '${field}' value: ${raw}`,
  );
  return undefined;
}

function parseAgentConfig(
  content: string,
  source: AgentSource,
  filePath: string,
): AgentConfig | null {
  let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    /* malformed frontmatter returns null to skip invalid agent files */
    return null;
  }
  const { frontmatter, body } = parsed;
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  )
    return null;
  const {
    name,
    description,
    context: rawContext,
    tools: rawTools,
    skills: rawSkills,
    extensions: rawExtensions,
    thinking: rawThinking,
    model: rawModel,
    provider: rawProvider,
    temperature: rawTemperature,
    top_p: rawTopP,
    replace_prompt: rawReplacePrompt,
  } = frontmatter;
  if (typeof name !== "string" || typeof description !== "string") return null;
  if (rawContext !== undefined && typeof rawContext !== "boolean") return null;
  if (rawReplacePrompt !== undefined && typeof rawReplacePrompt !== "boolean")
    return null;
  if (isNonStringOptional(rawTools)) return null;
  if (rawSkills != null && typeof rawSkills !== "string" && rawSkills !== false)
    return null;
  if (
    rawExtensions !== undefined &&
    rawExtensions !== false &&
    typeof rawExtensions !== "string" &&
    !(Array.isArray(rawExtensions) && rawExtensions.length === 0)
  )
    return null;
  if (isNonStringOptional(rawThinking)) return null;
  if (isNonStringOptional(rawModel)) return null;
  if (isNonStringOptional(rawProvider)) return null;
  const tools = parseCommaList(rawTools);
  const skills =
    rawSkills === false
      ? false
      : rawSkills !== undefined
        ? (parseCommaList(rawSkills) ?? [])
        : undefined;
  const thinking = parseThinkingLevel(rawThinking);
  const model = parseOptionalString(rawModel);
  const provider = parseOptionalString(rawProvider);
  if (provider !== undefined && model === undefined) return null;
  const temperature = parseSamplingValue(rawTemperature, "temperature", name);
  const topP = parseSamplingValue(rawTopP, "top_p", name);
  const extensions = parseExtensions(rawExtensions);
  if (rawReplacePrompt === true && body.trim().length === 0) return null;
  return {
    name,
    description,
    tools,
    skills,
    thinking,
    model,
    provider,
    systemPrompt: body,
    role: declaredRole(frontmatter["role"]),
    ...(frontmatter["role"] != null &&
    frontmatter["role"] !== "" &&
    !declaredRole(frontmatter["role"])
      ? { roleDiagnostic: "Invalid optional role ID; ignored" }
      : {}),
    source,
    filePath,
    ...(rawContext === false && { context: false }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { topP }),
    ...(extensions !== undefined && { extensions }),
    ...(rawReplacePrompt === true && { replacePrompt: true }),
  };
}

async function loadAgentEntryAsync(
  dir: string,
  entryName: string,
  source: AgentSource,
): Promise<AgentConfig | null> {
  const filePath = path.join(dir, entryName);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, "utf-8");
  } catch {
    /* unreadable files are skipped silently during agent discovery */
    return null;
  }
  return parseAgentConfig(content, source, filePath);
}

export function emptyScopeResult(): AgentDiscoveryScopeResult {
  return { agents: [], markdownFiles: [] };
}

async function loadAgentsFromDirAsync(
  dir: string,
  source: AgentSource,
): Promise<AgentDiscoveryScopeResult> {
  const markdownEntries = (await readMarkdownDirWithStatusAsync(dir)).entries;
  const markdownFiles = markdownEntries.map((entry) => entry.name);
  const parsedAgents = await Promise.all(
    markdownEntries.map((entry) =>
      loadAgentEntryAsync(dir, entry.name, source),
    ),
  );
  const agents = parsedAgents.filter(
    (agent): agent is AgentConfig => agent !== null,
  );
  return { agents, markdownFiles };
}

function isMarkdownDirent(entry: Dirent): boolean {
  return (
    entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())
  );
}

export interface MarkdownDirListing {
  entries: Dirent[];
  ok: boolean;
}

export async function readMarkdownDirWithStatusAsync(
  dir: string | null,
): Promise<MarkdownDirListing> {
  if (!dir) return { entries: [], ok: true };
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    return { entries: entries.filter(isMarkdownDirent), ok: true };
  } catch {
    /* missing or inaccessible directories return empty listing */
    return { entries: [], ok: false };
  }
}

export function getUserAgentsDir(): string {
  return path.join(getAgentDir(), "agents");
}

export async function isDirectoryAsync(p: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(p)).isDirectory();
  } catch {
    /* stat failures indicate non-existent or inaccessible paths */
    return false;
  }
}

async function findNearestProjectAgentsDirAsync(
  cwd: string,
): Promise<string | null> {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (await isDirectoryAsync(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export async function discoverAgentsAsync(
  cwd: string,
  scope: AgentScope,
): Promise<AgentDiscoveryResult> {
  const userDir = getUserAgentsDir();
  const projectAgentsDir = await findNearestProjectAgentsDirAsync(cwd);
  const [userDiscovery, projectDiscovery] = await Promise.all([
    scope === "project"
      ? emptyScopeResult()
      : loadAgentsFromDirAsync(userDir, "user"),
    scope === "user" || !projectAgentsDir
      ? emptyScopeResult()
      : loadAgentsFromDirAsync(projectAgentsDir, "project"),
  ]);
  return mergeAgentLists(userDiscovery, projectDiscovery, projectAgentsDir);
}

export function formatAgentList(
  agents: AgentConfig[],
  maxItems: number,
): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed
      .map((a) => `${a.name} (${a.source}): ${a.description}`)
      .join("; "),
    remaining,
  };
}
