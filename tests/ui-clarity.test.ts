import { afterEach, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatSubagentTitle,
  renderRunsBoard,
  type SubagentTheme,
} from "../src/output/ui.js";
import {
  createProgressState,
  patchProgressState,
  renderSubagentProgress,
  resetProgressStore,
} from "../src/progress/progress.js";
import { generateSubagentInstanceName } from "../src/shared/instance-name.js";

const theme: SubagentTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

afterEach(() => resetProgressStore());

test("numbered labels stay distinct across rapid launches without random nicknames", () => {
  const labels = Array.from({ length: 200 }, () =>
    generateSubagentInstanceName(),
  );
  expect(new Set(labels).size).toBe(labels.length);
  for (let i = 1; i < labels.length; i++) {
    expect(Number(labels[i]?.slice(1))).toBe(
      Number(labels[i - 1]?.slice(1)) + 1,
    );
  }
  const title = formatSubagentTitle("review", labels[0], theme);
  expect(title).toMatch(/^review #[1-9]\d*$/);
  expect(title).not.toContain("\x1b[3m");
});

test("compact live cards put task and current activity before model and statistics", () => {
  createProgressState(
    "clarity-live",
    "review",
    "Check the video exporter",
    "#1",
  );
  patchProgressState("clarity-live", {
    activeToolActivity: {
      toolName: "read",
      inputSummary: "read: source/exporter.cpp",
    },
    modelDisplay: "gpt-6-luna · high",
    toolCount: 3,
    durationMs: 32000,
    contextTokens: 18000,
    contextWindowTokens: 100000,
  });
  const card = renderSubagentProgress(
    { details: { requestId: "clarity-live" } },
    { expanded: false },
    theme,
  );
  const text = card?.render(100).join("\n") ?? "";
  expect(text).toContain("review #1 [running]");
  expect(text).toContain("Task: Check the video exporter");
  expect(text).toContain("→ read: source/exporter.cpp");
  expect(text.indexOf("Task:")).toBeLessThan(text.indexOf("→ read:"));
  expect(text.indexOf("→ read:")).toBeLessThan(
    text.indexOf("3 tools · 18% ctx · 32.0s"),
  );
  expect(text.indexOf("3 tools")).toBeLessThan(text.indexOf("gpt-6-luna"));
});

test.each(["success", "error", "cancelled"] as const)(
  "%s cards retain their task without expansion",
  (status) => {
    createProgressState(
      `clarity-${status}`,
      "build",
      "Implement video export",
      "#2",
    );
    patchProgressState(`clarity-${status}`, {
      status,
      finalOutput: status === "success" ? "Export implemented" : undefined,
      errorText: status !== "success" ? "Stopped by user" : undefined,
      durationMs: 1000,
    });
    const card = renderSubagentProgress(
      { details: { requestId: `clarity-${status}` } },
      { expanded: false },
      theme,
    );
    const text = card?.render(80).join("\n") ?? "";
    expect(text).toContain("Task: Implement video export");
    expect(text.match(/Task:/g)).toHaveLength(1);
    expect(text).toContain(`[${status}]`);
  },
);

test("compact Unicode tasks fit narrow terminals and expansion reveals the full task", () => {
  const task = `${"检验视频输出 ".repeat(40)}END_OF_TASK`;
  createProgressState("clarity-width", "review", task, "#3");
  const compact = renderSubagentProgress(
    { details: { requestId: "clarity-width" } },
    { expanded: false },
    theme,
  );
  const expanded = renderSubagentProgress(
    { details: { requestId: "clarity-width" } },
    { expanded: true },
    theme,
  );
  const compactLines = compact?.render(24) ?? [];
  expect(compactLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  expect(compactLines.join("\n")).toContain("…");
  expect(compactLines.join("\n")).not.toContain("END_OF_TASK");
  expect(expanded?.render(100).join("\n")).toContain("END_OF_TASK");
});

test("jobs board shows live nested activity beneath the task and keeps display numbers", () => {
  const text = renderRunsBoard(
    [
      {
        requestId: "clarity-board",
        agent: "review",
        instanceName: "#4",
        taskPreview: "Review source changes",
        status: "running",
        startTime: 0,
        durationMs: 1200,
        toolCount: 2,
        activeToolActivity: {
          toolName: "subagent",
          inputSummary: "subagent: audit",
          instanceName: "#1",
          child: {
            toolName: "read",
            inputSummary: "read: source/exporter.cpp",
          },
        },
        modelDisplay: "gpt-6-luna · high",
      },
    ],
    theme,
    100,
  )
    .render(100)
    .join("\n");
  expect(text).toContain("review #4 [running]");
  expect(text).toContain("Task: Review source changes");
  expect(text).toContain("subagent: audit [#1] - read: source/exporter.cpp");
  expect(text.indexOf("Task:")).toBeLessThan(text.indexOf("subagent: audit"));
  expect(text.indexOf("subagent: audit")).toBeLessThan(text.indexOf("2 tools"));
});

test("jobs task truncation keeps emoji code points intact", () => {
  const text = renderRunsBoard(
    [
      {
        requestId: "clarity-emoji",
        agent: "review",
        instanceName: "#5",
        taskPreview: `${"A".repeat(118)}😀${"B".repeat(40)}`,
        status: "running",
        startTime: 0,
        durationMs: 0,
        toolCount: 0,
      },
    ],
    theme,
    160,
  )
    .render(160)
    .join("\n");
  expect(text).toContain("Task:");
  expect(text).toContain("…");
  expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});
