import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "../agent/agents.js";
import type { TerminationMetadata } from "../child/termination.js";
import type { RoleMetadata } from "../roles/types.js";

export const TOOL_RESULT_FAILED_MESSAGE = "Subagent tool result failed.";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindowTokens?: number;
  turns: number;
}

export interface ToolActivity {
  toolName: string;
  inputSummary?: string | undefined;
  instanceName?: string | undefined;
  child?: ToolActivity | undefined;
}

export interface StreamingProgressToolCall {
  id: string;
  preview: string;
}

export interface StreamingProgress {
  activityText?: string | undefined;
  activeToolActivity?: ToolActivity | undefined;
  toolCalls: StreamingProgressToolCall[];
  lastToolPreview?: string | undefined;
  toolResultCompleted?: boolean | undefined;
}

export interface SingleResult {
  role?: RoleMetadata | undefined;
  agent: string;
  instanceName?: string | undefined;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  finalOutput: string;
  stderr: string;
  usage: UsageStats;
  model?: string | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
  durationMs?: number | undefined;
  progress?: StreamingProgress | undefined;
  messages?: Message[] | undefined;
  termination?: TerminationMetadata | undefined;
  thinkingWarning?: string | undefined;
  outcome?: string | undefined;
}

export interface SubagentDetails {
  mode: "single";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  renderedByMessage?: true;
}

export interface SubagentToolResult {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}

export type OnUpdateCallback = (partial: {
  content: { type: "text"; text: string }[];
  details: SubagentDetails;
}) => void;
