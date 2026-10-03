import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  isStatusOnlyFailure,
  isStatusOnlySuccess,
  makeToolPreview,
  normalizeAndTruncate,
  normalizeSummaryValue,
  normalizeTerminalSentence,
} from "../output/normalize.js";
import { summarizeFeedbackUiFinalOutput } from "../output/summary.js";
import type {
  SingleResult,
  SubagentDetails,
  ToolActivity,
} from "../shared/types.js";

export type ThemeBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export type ProgressStatus = "running" | "success" | "error" | "cancelled";

export const STATUS_COLOR: Record<ProgressStatus, ThemeColor> = {
  success: "success",
  error: "error",
  cancelled: "error",
  running: "accent",
};

export const STATUS_ICON: Record<ProgressStatus, string> = {
  success: "✓",
  error: "✗",
  cancelled: "⊘",
  running: "⟳",
};

export const STATUS_BG: Record<ProgressStatus, ThemeBg> = {
  success: "toolSuccessBg",
  error: "toolErrorBg",
  cancelled: "toolErrorBg",
  running: "toolPendingBg",
};

export interface SubagentProgressState {
  role?: import("../roles/types.js").RoleMetadata | undefined;
  requestId: string;
  agent: string;
  instanceName?: string | undefined;
  taskPreview: string;
  status: ProgressStatus;
  startTime: number;
  durationMs?: number | undefined;
  activeToolActivity?: ToolActivity | undefined;
  lastToolPreview?: string | undefined;
  toolResultCompleted?: boolean | undefined;
  toolCount: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  contextTokens?: number | undefined;
  contextWindowTokens?: number | undefined;
  modelDisplay?: string | undefined;
  finalOutput?: string | undefined;
  errorText?: string | undefined;
}

const store = new Map<string, SubagentProgressState>();

export function createProgressState(
  requestId: string,
  agent: string,
  task: string,
  instanceName?: string,
  role?: import("../roles/types.js").RoleMetadata,
): void {
  store.set(requestId, {
    requestId,
    agent,
    instanceName,
    ...(role ? { role } : {}),
    taskPreview: makeTaskPreview(task),
    status: "running",
    startTime: Date.now(),
    toolCount: 0,
  });
}

export function getProgressState(
  requestId: string,
): SubagentProgressState | undefined {
  return store.get(requestId);
}
export function getAllProgressStates(): SubagentProgressState[] {
  return [...store.values()].sort((a, b) => b.startTime - a.startTime);
}

type ProgressTransientFields = Pick<
  SubagentProgressState,
  "activeToolActivity" | "lastToolPreview" | "toolResultCompleted"
>;

function stripTransientFields(
  merged: SubagentProgressState,
): Omit<SubagentProgressState, keyof ProgressTransientFields> {
  const { activeToolActivity, lastToolPreview, toolResultCompleted, ...base } =
    merged;
  return base;
}

export function patchProgressState(
  requestId: string,
  patch: Partial<SubagentProgressState>,
): void {
  const state = store.get(requestId);
  if (!state) return;
  const merged: SubagentProgressState = { ...state, ...patch };
  if (merged.modelDisplay === undefined || merged.modelDisplay === "") {
    delete merged.modelDisplay;
  }
  if (state.status !== "running") {
    store.set(requestId, stripTransientFields(merged));
    return;
  }
  store.set(requestId, merged);
}

function storeTerminalProgressState(
  requestId: string,
  patch: Partial<SubagentProgressState>,
): void {
  const state = store.get(requestId);
  if (!state) return;
  const durationMs = state.durationMs ?? Date.now() - state.startTime;
  store.set(requestId, {
    ...stripTransientFields({ ...state, ...patch }),
    durationMs,
  });
}

export function finalizeProgressState(
  requestId: string,
  finalOutput: string,
  outcome?: string,
): void {
  storeTerminalProgressState(requestId, {
    status: "success",
    finalOutput: makeProgressFinalOutput(finalOutput, outcome),
  });
}

export function failProgressState(requestId: string, errorText: string): void {
  const sentence = deriveFailureTerminalSentence(errorText);
  storeTerminalProgressState(requestId, {
    status: "error",
    errorText: sentence,
  });
}

export function cancelProgressState(requestId: string, reason?: string): void {
  storeTerminalProgressState(requestId, {
    status: "cancelled",
    errorText: reason ? normalizeTerminalSentence(reason) : undefined,
  });
}

export function clearProgressState(requestId: string): void {
  store.delete(requestId);
}
export function resetProgressStore(): void {
  store.clear();
}

export function makeTaskPreview(task: string): string {
  const flat = normalizeSummaryValue(task);
  return flat || "(agent default)";
}

function makeProgressFinalOutput(
  finalOutput: string,
  outcome?: string,
): string {
  const summary = summarizeFeedbackUiFinalOutput(finalOutput, outcome);
  if (isStatusOnlySuccess(summary)) return "completed task";
  return summary;
}

function deriveFailureTerminalSentence(errorText: string): string {
  const source = extractProgressSemanticErrorLine(errorText);
  if (!source || source === "Large unstructured error output omitted.")
    return source;
  const normalized = normalizeTerminalSentence(source);
  if (!normalized || isStatusOnlyFailure(normalized)) return "task failed";
  return normalized;
}

function extractProgressSemanticErrorLine(errorText: string): string {
  const lines = errorText
    .split(/\r?\n/)
    .map((line) => normalizeSummaryValue(line))
    .filter(Boolean);
  const statusLine = lines.find((line) =>
    /^(?:status|error|check):\s+/i.test(line),
  );
  if (statusLine) return statusLine;
  const semanticLine = lines.find((line) =>
    isMeaningfulProgressErrorLine(line),
  );
  return semanticLine ?? "Large unstructured error output omitted.";
}

function isMeaningfulProgressErrorLine(line: string): boolean {
  if (/^(?:at\s+|traceback\b|stack\b|\{|")/i.test(line)) return false;
  if (/^(?:debug|info|warn|warning|stderr|stdout|raw log):\s*/i.test(line))
    return false;
  if (/^Agent \S+:\s*\S+$/i.test(line)) return false;
  if (/^[\w.-]+:\d+:\d+/.test(line)) return false;
  return /[A-Za-z]/.test(line) && /\s/.test(line);
}

export interface DetailsProgress {
  lastToolPreview?: string;
  activityText?: string;
  activeToolActivity?: ToolActivity;
  progressLastToolPreview?: string;
  toolResultCompleted?: boolean;
  newToolCallIds: string[];
}

function trackNewToolCall(
  id: string,
  preview: string,
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  if (seenToolCallIds.has(id)) return;
  seenToolCallIds.add(id);
  state.newToolCallIds.push(id);
  state.lastToolPreview = preview;
}

function extractProgressFromExistingProgress(
  progress: {
    activityText?: string | undefined;
    activeToolActivity?: ToolActivity | undefined;
    lastToolPreview?: string | undefined;
    toolCalls: { id: string; preview: string }[];
    toolResultCompleted?: boolean | undefined;
  },
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  if (
    typeof progress.activityText === "string" &&
    progress.activityText.trim()
  ) {
    state.activityText = normalizeAndTruncate(progress.activityText);
  }
  if (progress.activeToolActivity) {
    state.activeToolActivity = progress.activeToolActivity;
  }
  const previewValue = progress.lastToolPreview;
  const truncatedPreview =
    typeof previewValue === "string" && previewValue.trim()
      ? normalizeAndTruncate(previewValue)
      : undefined;
  if (truncatedPreview) {
    state.progressLastToolPreview = truncatedPreview;
  }
  if (progress.toolResultCompleted) {
    state.toolResultCompleted = true;
  }
  const hasToolCalls = progress.toolCalls.some(isDerivedToolCall);
  for (const toolCall of progress.toolCalls) {
    if (!isDerivedToolCall(toolCall)) continue;
    const preview = normalizeAndTruncate(toolCall.preview);
    trackNewToolCall(toolCall.id, preview, seenToolCallIds, state);
  }
  if (truncatedPreview && !hasToolCalls) {
    state.lastToolPreview = truncatedPreview;
  }
}

function extractProgressFromMessages(
  messages: SingleResult["messages"] = [],
  seenToolCallIds: Set<string>,
  state: DetailsProgress,
): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (isToolCallPart(part)) {
        const preview = makeToolPreview(part.name, part.arguments);
        trackNewToolCall(part.id, preview, seenToolCallIds, state);
      }
    }
  }
}

export function extractProgressFromDetails(
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): DetailsProgress {
  const state: DetailsProgress = { newToolCallIds: [] };
  const results = Array.isArray(details.results) ? details.results : [];
  for (const result of results) {
    if (result.progress) {
      extractProgressFromExistingProgress(
        result.progress,
        seenToolCallIds,
        state,
      );
      continue;
    }
    const messages = Array.isArray(result.messages) ? result.messages : [];
    extractProgressFromMessages(messages, seenToolCallIds, state);
  }
  return state;
}

function isObjectWith(part: unknown): part is Record<string, unknown> {
  return typeof part === "object" && part !== null;
}

function isDerivedToolCall(part: unknown): part is {
  id: string;
  preview: string;
} {
  if (!isObjectWith(part)) return false;
  return typeof part["id"] === "string" && typeof part["preview"] === "string";
}

export function isToolCallPart(part: unknown): part is {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
} {
  if (!isObjectWith(part)) return false;
  return (
    part["type"] === "toolCall" &&
    typeof part["id"] === "string" &&
    typeof part["name"] === "string"
  );
}
