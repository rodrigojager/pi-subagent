import type { Message } from "@earendil-works/pi-ai";
import type { TerminationMetadata } from "../child/termination.js";
import {
  formatSubagentResultForParent,
  summarizeFeedbackUiFinalOutput,
} from "../output/summary.js";
import { roleMetadata } from "../roles/resolver.js";
import {
  type SingleResult,
  type StreamingProgress,
  type SubagentDetails,
  type SubagentToolResult,
  TOOL_RESULT_FAILED_MESSAGE,
  type ToolActivity,
} from "../shared/types.js";
import {
  extractProgressFromDetails,
  getProgressState,
  patchProgressState,
  type SubagentProgressState,
} from "./progress.js";
import { renderToolActivity, SENSITIVE_PATTERN } from "./progress-format.js";

export type DetailsOptions = {
  includeMessages?: boolean;
  recentMessages?: Message[];
};

export function createSubagentError(result: SingleResult): Error {
  const formatted = formatSubagentResultForParent(result);
  const errorMessage = result.errorMessage?.trim();
  if (errorMessage && errorMessage !== TOOL_RESULT_FAILED_MESSAGE)
    return new Error(`Agent ${result.stopReason || "failed"}: ${errorMessage}`);
  const msg =
    formatted ||
    result.stderr ||
    errorMessage ||
    result.finalOutput ||
    "(no output)";
  return new Error(`Agent ${result.stopReason || "failed"}: ${msg}`);
}

const DEBUG_REDACTED_PLACEHOLDER = "[redacted]";
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:secret|password|[A-Za-z0-9_-]*token)(?:\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SENSITIVE_TERM_PATTERN = new RegExp(SENSITIVE_PATTERN.source, "gi");
const TOKEN_COUNT_KEY_PATTERN = /tokens$/i;

function redactSensitiveDebugString(text: string): string {
  return text
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, DEBUG_REDACTED_PLACEHOLDER)
    .replace(SENSITIVE_TERM_PATTERN, DEBUG_REDACTED_PLACEHOLDER);
}

function isSensitiveDebugKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  if (TOKEN_COUNT_KEY_PATTERN.test(lowerKey)) return false;
  return (
    lowerKey.includes("secret") ||
    lowerKey.includes("password") ||
    lowerKey.endsWith("token")
  );
}

function redactSensitiveDebugValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveDebugString(value);
  if (Array.isArray(value)) return value.map(redactSensitiveDebugValue);
  if (typeof value !== "object" || value === null) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveDebugKey(key)
      ? DEBUG_REDACTED_PLACEHOLDER
      : redactSensitiveDebugValue(child);
  }
  return redacted;
}

function redactSensitiveDebugMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map(redactSensitiveDebugValue);
}

function sanitizeProgressObject(
  progress: SingleResult["progress"],
  _includeDebugMessages: boolean,
): StreamingProgress | undefined {
  if (!progress) return undefined;
  const {
    activityText,
    activeToolActivity,
    lastToolPreview,
    toolResultCompleted,
    ...progBase
  } = progress;
  return {
    toolCalls: progBase.toolCalls.map((tc) => ({
      id: tc.id,
      preview: tc.preview,
    })),
    ...(activityText !== undefined && { activityText }),
    ...(activeToolActivity !== undefined && { activeToolActivity }),
    ...(lastToolPreview !== undefined && { lastToolPreview }),
    ...(toolResultCompleted !== undefined && { toolResultCompleted }),
  };
}

function sanitizeTerminationObject(
  termination: TerminationMetadata | undefined,
  includeMessages: boolean,
  includeDebugMessages: boolean,
): TerminationMetadata | undefined {
  if (!includeMessages || !includeDebugMessages || !termination)
    return undefined;
  const { cancelReason, terminationSignal, fallbackCause, ...termBase } =
    termination;
  return {
    ...termBase,
    ...(cancelReason !== undefined && { cancelReason }),
    ...(terminationSignal !== undefined && { terminationSignal }),
    ...(fallbackCause !== undefined && { fallbackCause }),
  };
}

export function sanitizeResultDetails(
  result: SingleResult,
  includeDebugMessages: boolean,
  options: DetailsOptions | undefined,
): SingleResult {
  const includeMessages =
    includeDebugMessages && (options?.includeMessages ?? true);
  const { messages, termination, progress, stderr, usage, role, ...core } =
    result;
  const { contextWindowTokens, ...usageBase } = usage;
  const sanitized: SingleResult = {
    ...core,
    stderr: includeDebugMessages ? stderr : "",
    usage: {
      ...usageBase,
      ...(contextWindowTokens !== undefined && { contextWindowTokens }),
    },
  };
  if (role) {
    try {
      sanitized.role = roleMetadata(role);
    } catch {
      /* Old or malformed metadata is not displayed. */
    }
  }
  const progressValue = sanitizeProgressObject(progress, includeDebugMessages);
  if (progressValue !== undefined) sanitized.progress = progressValue;
  if (includeMessages) {
    sanitized.messages = options?.recentMessages
      ? [...options.recentMessages]
      : messages !== undefined
        ? [...messages]
        : undefined;
  }
  const terminationValue = sanitizeTerminationObject(
    termination,
    includeMessages,
    includeDebugMessages,
  );
  if (terminationValue !== undefined) sanitized.termination = terminationValue;
  return sanitized;
}

export function sanitizeDetailsForDisplay(
  details: SubagentDetails,
  includeMessages = false,
): SubagentDetails {
  return {
    ...details,
    results: details.results.map((result) => {
      const sanitized = sanitizeResultDetails(
        result,
        includeMessages,
        undefined,
      );
      if (includeMessages && sanitized.messages) {
        return {
          ...sanitized,
          messages: redactSensitiveDebugMessages(sanitized.messages),
        };
      }
      return sanitized;
    }),
  } as SubagentDetails;
}

export function getLatestResult(
  details: SubagentDetails,
): SingleResult | undefined {
  return details.results[0];
}

export function patchProgressFromDetails(
  requestId: string,
  details: SubagentDetails,
  seenToolCallIds: Set<string>,
): void {
  const latestResult = getLatestResult(details);
  const {
    newToolCallIds,
    lastToolPreview,
    activityText,
    activeToolActivity,
    toolResultCompleted,
  } = extractProgressFromDetails(details, seenToolCallIds);
  const current = getProgressState(requestId);
  if (!current) return;
  const patch: Partial<SubagentProgressState> = {
    toolCount: current.toolCount + newToolCallIds.length,
    ...(latestResult?.role ? { role: latestResult.role } : {}),
  };
  let nextActivity: ToolActivity | undefined;
  if (newToolCallIds.length > 0 && lastToolPreview) {
    nextActivity = { toolName: "tool", inputSummary: lastToolPreview };
  } else if (activeToolActivity) {
    nextActivity = activeToolActivity;
  } else if (activityText) {
    nextActivity = { toolName: "tool", inputSummary: activityText };
  } else if (current.activeToolActivity) {
    nextActivity = current.activeToolActivity;
  }
  if (toolResultCompleted && nextActivity?.child) {
    const { child, ...rest } = nextActivity;
    nextActivity = rest;
  } else if (toolResultCompleted) {
    nextActivity = undefined;
  }
  patch["activeToolActivity"] = nextActivity;
  const renderedPreview = renderToolActivity(nextActivity);
  if (renderedPreview) {
    patch["lastToolPreview"] = renderedPreview;
  } else if (toolResultCompleted && !nextActivity) {
    patch["lastToolPreview"] = undefined;
  }
  if (toolResultCompleted) {
    patch["toolResultCompleted"] = true;
  }
  if (latestResult?.usage) {
    patch["inputTokens"] = latestResult.usage.input;
    patch["outputTokens"] = latestResult.usage.output;
    patch["contextTokens"] = latestResult.usage.contextTokens;
    patch["contextWindowTokens"] = latestResult.usage.contextWindowTokens;
  }
  if (latestResult?.model?.trim()) {
    patch["modelDisplay"] = latestResult.model;
  }
  patchProgressState(requestId, patch);
}

export function getFeedbackSummaryText(result: SubagentToolResult): string {
  const latestResult = getLatestResult(result.details);
  const rawFinalOutput = latestResult?.finalOutput ?? "";
  const outcome = latestResult?.outcome;
  if (!outcome?.trim() && !rawFinalOutput.trim()) {
    return "(no output)";
  }
  return summarizeFeedbackUiFinalOutput(rawFinalOutput, outcome);
}
