import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseRolePrefix } from "../roles/request.js";
import { startSubagentJob } from "./subagent-orchestrator.js";

function parseRunArgs(
  args: string,
):
  | { agentName: string; task: string; debug: boolean; role?: string }
  | undefined {
  const input = args.trim();
  if (!input) return undefined;
  const debug = input.startsWith("--debug ");
  const command = debug ? input.slice("--debug ".length).trim() : input;
  if (!command) return undefined;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command);
  if (!match) return undefined;
  return {
    agentName: match[1] ?? "",
    ...parseRolePrefix(match[2] ?? ""),
    debug,
  };
}

export async function runCommandHandler(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  let parsed: ReturnType<typeof parseRunArgs>;
  try {
    parsed = parseRunArgs(args);
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }
  if (!parsed) {
    ctx.ui.notify(
      "Usage: /run <agent> [--role default|none|id] [task]",
      "error",
    );
    return;
  }
  const { agentName, task, debug, role } = parsed;
  const result = await startSubagentJob(
    pi,
    ctx,
    { agent: agentName, task, debug, ...(role !== undefined ? { role } : {}) },
    ctx.signal,
  );
  if (result.kind === "not_found")
    ctx.ui.notify(`Unknown agent: ${agentName}`, "error");
  else if (result.kind === "cancelled") ctx.ui.notify("Cancelled", "info");
}
