import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Markdown,
  type MarkdownTheme,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentScope } from "../agent/agents.js";
import {
  formatContextPercent,
  formatElapsed,
  renderToolActivityForDisplay,
} from "../progress/progress-format.js";
import {
  makeTaskPreview,
  type ProgressStatus,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
  type ThemeBg,
} from "../progress/progress-state.js";
import type { SubagentDetails, UsageStats } from "../shared/types.js";
import { hasSubagentFailed } from "../shared/utils.js";
import {
  extractSemanticToolTarget,
  normalizeSummaryValue,
} from "./normalize.js";

/**
 * Abstraction for theme-aware text formatting.
 */
export type SubagentTheme = {
  fg: (color: ThemeColor, text: string) => string;
  bg: (color: ThemeBg, text: string) => string;
  bold: (text: string) => string;
  italic?: (text: string) => string;
};

const ANSI_ITALIC_ON = "\x1b[3m";
const ANSI_ITALIC_OFF = "\x1b[23m";
const ANSI_STRIKETHROUGH_ON = "\x1b[9m";
const ANSI_STRIKETHROUGH_OFF = "\x1b[29m";
const ANSI_UNDERLINE_ON = "\x1b[4m";
const ANSI_UNDERLINE_OFF = "\x1b[24m";

function italicText(text: string, theme: SubagentTheme): string {
  return theme.italic
    ? theme.italic(text)
    : `${ANSI_ITALIC_ON}${text}${ANSI_ITALIC_OFF}`;
}

/**
 * Formats the shared subagent title from agent and optional instance name.
 */
export function formatSubagentTitle(
  agent: string,
  instanceName: string | undefined,
  theme: SubagentTheme,
): string {
  const agentSegment = theme.fg("toolTitle", theme.bold(agent));
  if (!instanceName) return agentSegment;
  if (/^#\d+$/.test(instanceName))
    return `${agentSegment} ${theme.fg("muted", instanceName)}`;
  return `${agentSegment} ${theme.fg("accent", italicText(instanceName, theme))}`;
}

/**
 * Formats token counts into human-readable strings (e.g., "1.2k", "1.5M").
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Formats the plural-aware turn count string.
 */
function formatTurns(turns: number): string {
  return `${turns} turn${turns > 1 ? "s" : ""}`;
}

function formatIoTokens(input: number, output: number): string {
  const tokens: string[] = [];
  if (input) tokens.push(`↑${formatTokens(input)}`);
  if (output) tokens.push(`↓${formatTokens(output)}`);
  return tokens.join(" ");
}

function formatCacheStats(cacheRead: number, cacheWrite: number): string {
  const cache: string[] = [];
  if (cacheRead) cache.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) cache.push(`W${formatTokens(cacheWrite)}`);
  return `cache:${cache.join("/")}`;
}

/**
 * Builds common usage stat parts: turns, context tokens, and cost.
 * Shared between formatUsageStats and formatResultFooter.
 */
function formatUsageCore(usage: UsageStats): string[] {
  const parts: string[] = [];
  if (usage.turns) parts.push(formatTurns(usage.turns));
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts;
}

/**
 * Formats cumulative usage statistics for compact UI display.
 */
export function formatUsageStats(
  usage: UsageStats,
  model?: string,
  compact?: boolean,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(formatTurns(usage.turns));
  if (usage.input || usage.output)
    parts.push(formatIoTokens(usage.input, usage.output));
  if (!compact && (usage.cacheRead || usage.cacheWrite))
    parts.push(formatCacheStats(usage.cacheRead, usage.cacheWrite));
  if (!compact && usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

/**
 * Formats the footer for subagent result cards, including model, context, turns, and cost.
 */
export function formatResultFooter(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (model) parts.push(model);
  parts.push(...formatUsageCore(usage));
  return parts.join(" · ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
  forceJson = false,
): string {
  const target = normalizeSummaryValue(
    extractSemanticToolTarget(args, forceJson),
  );
  if (!target) return themeFg("accent", toolName);
  return themeFg("accent", toolName) + themeFg("dim", ` ${target}`);
}

export { extractFinalOutputFromMessages as getFinalOutput } from "../shared/utils.js";

function makeMarkdownTheme(theme: SubagentTheme): MarkdownTheme {
  const fg = (c: ThemeColor) => (text: string) => theme.fg(c, text);
  return {
    heading: fg("mdHeading"),
    link: fg("mdLink"),
    linkUrl: fg("mdLinkUrl"),
    code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"),
    codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"),
    quoteBorder: fg("mdQuoteBorder"),
    hr: fg("mdHr"),
    listBullet: fg("mdListBullet"),
    bold: (text) => theme.bold(text),
    italic: (text) => `${ANSI_ITALIC_ON}${text}${ANSI_ITALIC_OFF}`,
    strikethrough: (text) =>
      `${ANSI_STRIKETHROUGH_ON}${text}${ANSI_STRIKETHROUGH_OFF}`,
    underline: (text) => `${ANSI_UNDERLINE_ON}${text}${ANSI_UNDERLINE_OFF}`,
  };
}

export function renderSubagentCall(
  args: { agent?: string; task?: string; agentScope?: AgentScope },
  theme: SubagentTheme,
): Text {
  const scope: AgentScope = args.agentScope ?? "both";
  const agentName = args.agent || "...";
  // Parser-owned preview suppresses task text: show agent + scope only
  const target = args.agent ? `[${scope}]` : JSON.stringify(args);
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName) +
    theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", target)}`;
  return new Text(text, 0, 0, (line) => theme.bg("toolPendingBg", line));
}

export function renderSubagentToolResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: SubagentTheme,
  display?: { isPartial?: boolean },
): Component {
  const details = result.details as SubagentDetails | undefined;
  if (details?.renderedByMessage) return new Text("", 0, 0);
  return renderSubagentResult(result, theme, display);
}

// Invariants: Red background = failure, green = success. Shows usage stats + duration in footer.
export function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  theme: SubagentTheme,
  display?: { isPartial?: boolean },
  bodyOverride?: string,
): Component {
  const details = result.details as SubagentDetails | undefined;
  const r = details?.results?.[0];
  if (!r) {
    const text = result.content[0];
    return new Text(
      text?.type === "text" ? (text.text ?? "(no output)") : "(no output)",
      0,
      0,
    );
  }
  const failed = hasSubagentFailed(r);
  const cancelled = r.stopReason === "aborted";
  const resultStatus: ProgressStatus = cancelled
    ? "cancelled"
    : failed
      ? "error"
      : "success";
  const finalOutput = r.finalOutput ?? "";
  const title = formatSubagentTitle(r.agent, r.instanceName, theme);
  let effectiveBody = bodyOverride ?? finalOutput;
  if (display?.isPartial && !finalOutput?.trim() && !bodyOverride) {
    effectiveBody =
      result.content[0]?.text ||
      r.progress?.activityText ||
      r.progress?.lastToolPreview ||
      "(running...)";
  }
  const bodyText = effectiveBody.trim();
  const toolCount = r.progress?.toolCalls?.length ?? 0;
  const ctxPercent = formatContextPercent({
    contextTokens: r.usage.contextTokens,
    contextWindowTokens: r.usage.contextWindowTokens,
  });
  const metadata = formatProgressMetadata(
    toolCount,
    ctxPercent,
    formatElapsed(r.durationMs ?? 0),
  );
  const usageStr = formatResultFooter(r.usage, r.model);
  return renderStatusCard(
    {
      status: resultStatus,
      title,
      variant: "full",
      task: makeTaskPreview(r.task),
      metadata,
      body: bodyText,
      footer: usageStr,
    },
    theme,
  );
}

type StatusCardVariant = "full" | "abridged";

type StatusCardOptions = {
  status: ProgressStatus;
  title: string;
  variant: StatusCardVariant;
  metadata?: string;
  task?: string;
  body?: string;
  footer?: string;
};

function renderStatusCard(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  const box = new Box(1, 1, (line) =>
    theme.bg(STATUS_BG[options.status], line),
  );
  const icon = theme.fg(
    STATUS_COLOR[options.status],
    STATUS_ICON[options.status],
  );
  const status = theme.fg("dim", `[${options.status}]`);
  box.addChild(new Text(`${icon} ${options.title} ${status}`, 0, 0));
  if (options.task)
    box.addChild(
      new Text(
        theme.fg(
          "toolOutput",
          `Task: ${truncateToWidth(options.task, BODY_PREVIEW_MAX)}`,
        ),
        2,
        0,
      ),
    );
  box.addChild(makeStatusCardBody(options, theme));
  if (options.metadata)
    box.addChild(new Text(theme.fg("muted", options.metadata), 0, 0));
  if (options.footer)
    box.addChild(new Text(theme.fg("dim", options.footer), 0, 0));
  return box;
}

function makeStatusCardBody(
  options: StatusCardOptions,
  theme: SubagentTheme,
): Box {
  const body = new Box(2, options.variant === "full" || options.footer ? 1 : 0);
  const bodyText = options.body ?? "";
  if (bodyText && options.variant === "full") {
    body.addChild(
      new Markdown(bodyText, 0, 0, makeMarkdownTheme(theme), {
        color: (text) => theme.fg("toolOutput", text),
      }),
    );
  } else if (bodyText) {
    body.addChild(new Text(theme.fg("toolOutput", bodyText), 0, 0));
  } else {
    body.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }
  return body;
}

const BODY_PREVIEW_MAX = 120;

function formatProgressMetadata(
  toolCount: number,
  ctxPercent: string,
  elapsed: string,
): string {
  const toolLabel = toolCount === 1 ? "tool" : "tools";
  return `${toolCount} ${toolLabel} · ${ctxPercent} ctx · ${elapsed}`;
}

function renderJobCard(
  state: SubagentProgressState,
  theme: SubagentTheme,
  width: number,
): Box {
  const title = formatSubagentTitle(state.agent, state.instanceName, theme);
  const elapsed = formatElapsed(
    state.durationMs ?? Date.now() - state.startTime,
  );
  const ctxPercent = formatContextPercent(state);
  const metadata = formatProgressMetadata(state.toolCount, ctxPercent, elapsed);
  const bodyText =
    state.status === "running"
      ? renderToolActivityForDisplay(
          state.activeToolActivity,
          Math.max(0, width - 8),
        ) || (state.toolCount === 0 ? "Waiting for activity…" : "Working…")
      : state.finalOutput?.trim() || state.errorText?.trim() || "";
  const preview =
    bodyText.length > BODY_PREVIEW_MAX
      ? `${bodyText.slice(0, BODY_PREVIEW_MAX - 1)}…`
      : bodyText;
  const options: StatusCardOptions = {
    status: state.status,
    title,
    variant: "abridged",
    metadata,
    task: state.taskPreview,
    body: preview,
  };
  if (state.modelDisplay) options.footer = state.modelDisplay;
  return renderStatusCard(options, theme);
}

function sortByStartTimeDesc(
  a: SubagentProgressState,
  b: SubagentProgressState,
): number {
  return b.startTime - a.startTime;
}

/** Ordered section definitions: label → status filter for the runs board. */
const BOARD_SECTIONS: [string, ProgressStatus][] = [
  ["ACTIVE", "running"],
  ["FAILED", "error"],
  ["CANCELLED", "cancelled"],
  ["SUCCEEDED", "success"],
];

// Jobs render in status-specific sections, each sorted by `startTime` descending.
// Status icons preserve the existing /jobs contract for running and cancelled jobs.
export function renderRunsBoard(
  states: SubagentProgressState[],
  theme: SubagentTheme,
  width = 80,
): Component {
  if (states.length === 0) {
    return new Text(theme.fg("muted", "No /run jobs in this session."), 0, 0);
  }
  const grouped = new Map<ProgressStatus, SubagentProgressState[]>();
  for (const s of states) {
    const bucket = grouped.get(s.status);
    if (bucket) bucket.push(s);
    else grouped.set(s.status, [s]);
  }
  for (const bucket of grouped.values()) bucket.sort(sortByStartTimeDesc);
  const box = new Box(0, 0);
  const addSection = (
    label: string,
    sectionStates: SubagentProgressState[],
  ) => {
    if (sectionStates.length === 0) return;
    const sectionHeader = `${label} (${sectionStates.length})`;
    const ruler = "─".repeat(Math.max(0, width - sectionHeader.length - 1));
    box.addChild(new Text(theme.fg("dim", `${sectionHeader} ${ruler}`), 0, 0));
    for (const state of sectionStates)
      box.addChild(renderJobCard(state, theme, width));
  };
  for (const [label, status] of BOARD_SECTIONS)
    addSection(label, grouped.get(status) ?? []);
  return box;
}
