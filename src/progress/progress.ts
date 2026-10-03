/**
 * Subagent progress rendering and formatting.
 *
 * Aggregates progress-state management (re-exported from `progress-state.js`),
 * elapsed/token formatters, and the live TUI progress component that renders
 * subagent execution status inline in the parent agent's output stream.
 *
 * `renderSubagentProgress` hooks into the pi message pipeline. It produces a
 * `DynamicSubagentProgressText` component that re-reads the progress store on
 * each render tick, so updates from child process streaming appear instantly
 * without explicit message-passing.
 *
 * All progress state lives in the store managed by `progress-state.js`.
 * This module is purely presentational — it queries state and formats output.
 *
 * @module progress
 */

import type { Component } from "@earendil-works/pi-tui";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatSubagentTitle, type SubagentTheme } from "../output/ui.js";
import { formatRole } from "../roles/resolver.js";
import {
  formatHeaderStats,
  renderToolActivityForDisplay,
} from "./progress-format.js";
import {
  getProgressState,
  STATUS_BG,
  STATUS_COLOR,
  STATUS_ICON,
  type SubagentProgressState,
} from "./progress-state.js";

export { makeToolPreview } from "../output/normalize.js";
export {
  formatElapsed,
  formatHeaderStats,
  renderToolActivity,
} from "./progress-format.js";
export {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  makeTaskPreview,
  patchProgressState,
  resetProgressStore,
  type SubagentProgressState,
} from "./progress-state.js";

/**
 * Create a live-updating TUI progress component from a pi message.
 *
 * Called by the pi message renderer for messages with a `requestId` in
 * their `details`. Returns `undefined` when no progress state exists for
 * the request (e.g. before streaming starts or after cleanup).
 *
 * The returned `DynamicSubagentProgressText` component re-reads the
 * progress store on every render tick, so tool counts, context usage,
 * and output update in real time as the child process streams.
 *
 * @param message  - A pi message object. Must carry `details.requestId`.
 * @param options  - `expanded` controls whether the collapsed or full
 *                    progress view is rendered.
 * @param theme    - Subagent color theme for styling the output.
 * @returns A dynamic TUI component, or `undefined` if no active state.
 */
export function renderSubagentProgress(
  message: {
    customType?: string;
    content?: unknown;
    display?: boolean;
    details?: unknown;
  },
  options: { expanded: boolean },
  theme: SubagentTheme,
): Component | undefined {
  const details = message.details as { requestId?: string } | undefined;
  const requestId = details?.requestId;
  if (!requestId || !getProgressState(requestId)) return undefined;
  return new DynamicSubagentProgressText(requestId, options, theme);
}

class DynamicSubagentProgressText implements Component {
  private readonly requestId: string;
  private readonly options: { expanded: boolean };
  private readonly theme: SubagentTheme;
  constructor(
    requestId: string,
    options: { expanded: boolean },
    theme: SubagentTheme,
  ) {
    this.requestId = requestId;
    this.options = options;
    this.theme = theme;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const state = getProgressState(this.requestId);
    if (!state) return [];
    return renderProgressBox(state, this.options, this.theme, width).render(
      width,
    );
  }
}

function renderProgressBox(
  state: SubagentProgressState,
  options: { expanded: boolean },
  theme: SubagentTheme,
  width: number,
): Box {
  const status = state.status;
  const title = formatSubagentTitle(state.agent, state.instanceName, theme);
  const header = `${theme.fg(STATUS_COLOR[status], STATUS_ICON[status])} ${title} ${theme.fg("dim", `[${status}]`)}`;
  const box = new Box(1, 1, (line) => theme.bg(STATUS_BG[status], line));
  box.addChild(new Text(header, 0, 0));
  const task = options.expanded
    ? state.taskPreview
    : truncateToWidth(state.taskPreview, Math.max(1, width - 10));
  box.addChild(new Text(theme.fg("toolOutput", `Task: ${task}`), 2, 0));
  if (state.role)
    box.addChild(new Text(theme.fg("muted", formatRole(state.role)), 2, 0));
  if (options.expanded && state.role)
    box.addChild(
      new Text(
        theme.fg(
          "dim",
          `Role ID: ${state.role.effectiveId ?? "none"} · Origin: ${state.role.origin}`,
        ),
        2,
        0,
      ),
    );
  for (const line of makeProgressBody(state, theme, width)) box.addChild(line);
  box.addChild(new Text(theme.fg("muted", formatHeaderStats(state)), 0, 0));
  if (state.modelDisplay)
    box.addChild(new Text(theme.fg("dim", state.modelDisplay), 0, 0));
  return box;
}

function makeProgressBody(
  state: SubagentProgressState,
  theme: SubagentTheme,
  width: number,
): Text[] {
  if (state.status === "running") {
    const preview = renderToolActivityForDisplay(
      state.activeToolActivity,
      Math.max(0, width - 8),
    );
    const activity = preview
      ? formatRunningToolPreview(preview, theme)
      : theme.fg(
          "dim",
          state.toolCount === 0 ? "Waiting for activity…" : "Working…",
        );
    return [new Text(activity, 2, 0)];
  }
  if (state.status === "error" || state.status === "cancelled")
    return state.errorText
      ? [new Text(theme.fg("error", state.errorText), 2, 0)]
      : [];
  const output = state.finalOutput?.trim().split("\n")[0] ?? "";
  return output ? [new Text(theme.fg("toolOutput", output), 2, 0)] : [];
}

function formatRunningToolPreview(
  preview: string,
  theme: SubagentTheme,
): string {
  const separatorIndex = preview.indexOf(":");
  const arrow = theme.fg("muted", "→");
  if (separatorIndex === -1) return `${arrow} ${theme.fg("accent", preview)}`;
  const toolName = preview.slice(0, separatorIndex);
  const rest = preview.slice(separatorIndex);
  return `${arrow} ${theme.fg("accent", toolName)}${theme.fg("dim", rest)}`;
}
