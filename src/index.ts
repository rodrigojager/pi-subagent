import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getCachedAgentCompletions,
  resetAgentDiscoveryCache,
} from "./agent/agent-cache.js";
import { isDirectoryAsync } from "./agent/agents.js";
import { cancelSubagentCommandHandler } from "./orchestration/cancel-command.js";
import { registerDelegationBridge } from "./orchestration/delegation-bridge.js";
import { jobsCommandHandler } from "./orchestration/jobs-command.js";
import { renderSubagentResultMessage } from "./orchestration/run.js";
import { runCommandHandler } from "./orchestration/run-command.js";
import {
  formatSubagentToolResult,
  SubagentParams,
  startSubagentJob,
} from "./orchestration/subagent-orchestrator.js";
import { renderSubagentCall, renderSubagentToolResult } from "./output/ui.js";
import { renderSubagentProgress } from "./progress/progress.js";

export { SubagentParams };

export function resetAgentCache() {
  resetAgentDiscoveryCache();
}

function normalizeWorkspaceRoot(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const root = cwd.trim();
  return root.length > 0 ? root : undefined;
}

export default function registerSubagentExtension(pi: ExtensionAPI) {
  registerDelegationBridge(pi);
  let activeWorkspaceRoot: string | undefined;
  const setActiveWorkspaceRoot = (
    cwd: string | undefined,
    fallback?: string,
  ) => {
    activeWorkspaceRoot = normalizeWorkspaceRoot(cwd ?? fallback);
  };
  const getRunArgumentCompletions = async (prefix: string) => {
    if (!activeWorkspaceRoot) return [];
    if (!(await isDirectoryAsync(activeWorkspaceRoot))) return [];
    return getCachedAgentCompletions(prefix, activeWorkspaceRoot);
  };
  pi.on("resources_discover", (event, ctx) => {
    setActiveWorkspaceRoot(ctx.cwd, event.cwd);
  });
  pi.on("session_start", (_event, ctx) => {
    setActiveWorkspaceRoot(ctx.cwd);
  });
  pi.registerMessageRenderer("subagent-progress", renderSubagentProgress);
  pi.registerMessageRenderer("subagent-result", renderSubagentResultMessage);
  pi.registerCommand("run", {
    description: "Run a subagent directly: /run <agent> [task]",
    getArgumentCompletions: getRunArgumentCompletions,
    handler: async (args, ctx) => {
      setActiveWorkspaceRoot(ctx.cwd);
      return runCommandHandler(pi, ctx as ExtensionContext, args);
    },
  });
  pi.registerCommand("cancel-subagent", {
    description:
      "Cancel active /run subagents: /cancel-subagent [requestId|all]",
    handler: async (args, ctx) => cancelSubagentCommandHandler(ctx, args),
  });
  pi.registerCommand("jobs", {
    description: "List all /run jobs and their statuses: /jobs",
    handler: async (args, ctx) => jobsCommandHandler(ctx, args),
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a subagent with isolated context.",
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await startSubagentJob(
        pi,
        ctx,
        params,
        signal ?? undefined,
        onUpdate ?? undefined,
      );
      return formatSubagentToolResult(params.agent, result);
    },
    renderCall(args, theme, _context) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, display, theme, _context) {
      return renderSubagentToolResult(result, theme, display);
    },
  });
}
