import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agent/agents.js";
import { composeRolePrompt } from "../roles/prompt.js";
import type { RoleResolution } from "../roles/types.js";

export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  // mkdtemp guarantees a unique directory per call; no concurrent writer can hold this path.
  try {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (error) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return { dir: tmpDir, filePath };
}

export type TempPrompt = { dir: string; filePath: string };

export type PromptSetupResult =
  | { tmpPrompt: TempPrompt | null }
  | { error: unknown };

export async function cleanupTempPrompt(tmpPrompt: TempPrompt): Promise<void> {
  try {
    await fs.promises.unlink(tmpPrompt.filePath);
    await fs.promises.rmdir(tmpPrompt.dir);
  } catch {
    /* temp file cleanup failures are non-fatal; OS will clean up eventually */
  }
}

export function beginPromptSetup(
  agent: AgentConfig,
  role?: RoleResolution,
): Promise<PromptSetupResult> {
  const prompt = composeRolePrompt(agent.systemPrompt, role);
  if (!prompt.trim()) return Promise.resolve({ tmpPrompt: null });
  return writePromptToTempFile(agent.name, prompt).then(
    (tmpPrompt) => ({ tmpPrompt }),
    (error: unknown) => ({ error }),
  );
}

export async function cleanupPromptSetupResult(
  setup: PromptSetupResult,
): Promise<void> {
  if ("tmpPrompt" in setup && setup.tmpPrompt) {
    await cleanupTempPrompt(setup.tmpPrompt);
  }
}
