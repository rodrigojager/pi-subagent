import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { makeEmitUpdate } from "../src/child/process.js";
import {
  cancelProgressState,
  clearProgressState,
  createProgressState,
  extractProgressFromDetails,
  failProgressState,
  finalizeProgressState,
  formatElapsed,
  formatHeaderStats,
  getProgressState,
  makeTaskPreview,
  makeToolPreview,
  patchProgressState,
  renderSubagentProgress,
  resetProgressStore,
} from "../src/progress/progress.js";
import {
  renderToolActivity,
  renderToolActivityForDisplay,
  SENSITIVE_PATTERN,
} from "../src/progress/progress-format.js";
import {
  getAllProgressStates,
  isToolCallPart,
} from "../src/progress/progress-state.js";
import {
  patchProgressFromDetails,
  sanitizeDetailsForDisplay,
} from "../src/progress/result-details.js";
import type {
  StreamingProgress,
  SubagentDetails,
  ToolActivity,
} from "../src/shared/types.js";
import { CANONICAL_SUMMARY_FIXTURES } from "./fixtures.js";

const realDateNow = Date.now;

function setDateNow(now: number): void {
  Date.now = () => now;
}

function makeDetails(
  messages: { role: string; content: unknown[]; usage?: unknown }[],
): SubagentDetails {
  return {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test-agent",
        agentSource: "user",
        task: "test task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: messages as unknown as Message[],
      },
    ],
  };
}

afterEach(() => {
  Date.now = realDateNow;
  clearProgressState("req-1");
  clearProgressState("req-2");
  clearProgressState("rend-live");
  clearProgressState("iso-success");
  clearProgressState("iso-error");
  clearProgressState("iso-running");
  for (let i = 1; i <= 12; i++) clearProgressState(`rend-${i}`);
  clearProgressState("inv-1");
});

test("createProgressState initializes defaults", () => {
  const before = Date.now();
  createProgressState("req-1", "my-agent", "do the thing");
  const state = getProgressState("req-1");
  expect(state).toBeDefined();
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("my-agent");
  expect(state?.taskPreview).toBe("do the thing");
  expect(state?.status).toBe("running");
  expect(state?.startTime).toBeGreaterThanOrEqual(before);
  expect(state?.toolCount).toBe(0);
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.modelDisplay).toBeUndefined();
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
});

test("patchProgressState sets modelDisplay", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { modelDisplay: "claude-3-5-sonnet" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
});

test("terminal helpers preserve modelDisplay and strip transient tool fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    modelDisplay: "claude-3-5-sonnet",
    lastToolPreview: "bash: ls",
  });
  finalizeProgressState("req-1", "all done");
  const successState = getProgressState("req-1");
  expect(successState?.modelDisplay).toBe("claude-3-5-sonnet");
  expect(successState?.lastToolPreview).toBeUndefined();

  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", {
    modelDisplay: "gpt-4o",
    lastToolPreview: "read: /tmp/file",
  });
  failProgressState("req-2", "child failed");
  const errorState = getProgressState("req-2");
  expect(errorState?.modelDisplay).toBe("gpt-4o");
  expect(errorState?.lastToolPreview).toBeUndefined();

  createProgressState("req-3", "agent-c", "task c");
  patchProgressState("req-3", {
    modelDisplay: "gemini-1.5-pro",
    lastToolPreview: "write: safe.txt",
  });
  cancelProgressState("req-3", "user aborted");
  const cancelledState = getProgressState("req-3");
  expect(cancelledState?.modelDisplay).toBe("gemini-1.5-pro");
  expect(cancelledState?.lastToolPreview).toBeUndefined();
});

test("empty or undefined modelDisplay leaves footer data absent", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { modelDisplay: "" });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  patchProgressState("req-1", { modelDisplay: "claude-3-5-sonnet" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
  patchProgressState("req-1", { modelDisplay: undefined });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  patchProgressState("req-1", { modelDisplay: "gemini-1.5-pro" });
  expect(getProgressState("req-1")?.modelDisplay).toBe("gemini-1.5-pro");
  patchProgressState("req-1", { modelDisplay: "" });
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
});

describe("unconfirmed thinking progress propagation", () => {
  function makeDetailsWithModel(model: string): SubagentDetails {
    return {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user",
          task: "test task",
          exitCode: 0,
          finalOutput: "",
          stderr: "",
          model,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        },
      ],
    };
  }

  test("patchProgressFromDetails propagates requested level to modelDisplay", () => {
    createProgressState("req-1", "agent-a", "task a");
    const seen = new Set<string>();
    patchProgressFromDetails(
      "req-1",
      makeDetailsWithModel("unknown ･ unknown ･ high"),
      seen,
    );
    expect(getProgressState("req-1")?.modelDisplay).toBe(
      "unknown ･ unknown ･ high",
    );
  });

  test("renderSubagentProgress shows requested level in progress box", () => {
    createProgressState("req-1", "agent-a", "task a");
    patchProgressState("req-1", { modelDisplay: "unknown ･ unknown ･ high" });
    const rendered = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId: "req-1" },
      },
      { expanded: false },
      makeTheme(),
    );
    expect(renderText(rendered)).toContain("unknown ･ unknown ･ high");
  });

  test("finalized progress state retains requested-level modelDisplay", () => {
    createProgressState("req-1", "agent-a", "task a");
    patchProgressState("req-1", { modelDisplay: "unknown ･ unknown ･ high" });
    finalizeProgressState("req-1", "all done");
    expect(getProgressState("req-1")?.modelDisplay).toBe(
      "unknown ･ unknown ･ high",
    );
  });
});

test("getProgressState returns undefined for unknown request id", () => {
  expect(getProgressState("nonexistent")).toBeUndefined();
});

test("patchProgressState merges fields without replacing unpatched fields", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 3, lastToolPreview: "bash: ls" });
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.agent).toBe("agent-a");
  expect(state?.status).toBe("running");
});

test("finalizeProgressState sets success status and semantic final output", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "all done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("all done");
  expect(state?.errorText).toBeUndefined();
});

for (const fixture of CANONICAL_SUMMARY_FIXTURES) {
  test(`progress final output matches canonical summary for ${fixture.name}`, () => {
    createProgressState("req-fixture", "agent-fixture", "task fixture");
    finalizeProgressState("req-fixture", fixture.finalOutput, fixture.outcome);
    expect(getProgressState("req-fixture")?.finalOutput).toBe(
      fixture.expectedProgress,
    );
  });
}

test("progress final output substitutes status-only success after canonical derivation", () => {
  createProgressState("req-1", "agent-a", "task a");
  finalizeProgressState("req-1", "ignored output", "done");
  expect(getProgressState("req-1")?.finalOutput).toBe("completed task");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-2", "ignored output", "Success");
  expect(getProgressState("req-2")?.finalOutput).toBe("completed task");
});

test("terminal failure normalizes status prefixes and status-only text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "FAILURE: child failed");
  expect(getProgressState("req-1")?.errorText).toBe("child failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "FAILURE: FAILURE");
  expect(getProgressState("req-2")?.errorText).toBe("task failed");
  createProgressState("req-3", "agent-c", "task c");
  failProgressState("req-3", "Error: ERROR");
  expect(getProgressState("req-3")?.errorText).toBe("task failed");
  createProgressState("req-4", "agent-d", "task d");
  failProgressState("req-4", "FAILURE: Error: permission denied");
  expect(getProgressState("req-4")?.errorText).toBe("permission denied");
});

test("terminal helpers clear transient tool fields and compact semantic text", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: noisy command" });
  const longOutcome = `Outcome: implemented ${"x".repeat(600)}`;
  finalizeProgressState("req-1", longOutcome);
  const successState = getProgressState("req-1");
  expect(successState?.lastToolPreview).toBeUndefined();
  expect(successState?.finalOutput).toStartWith("outcome: implemented ");
  expect(successState?.finalOutput).toEndWith("…");
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "read: /tmp/file" });
  const longCause = `migration failed ${"e".repeat(600)}`;
  failProgressState("req-2", longCause);
  const errorState = getProgressState("req-2");
  expect(errorState?.lastToolPreview).toBeUndefined();
  expect(errorState?.errorText).toStartWith("migration failed ");
  expect(errorState?.errorText).toEndWith("…");
});

test("progress error omits long unstructured blobs", () => {
  createProgressState("req-1", "agent-a", "task a");
  const blob = Array.from(
    { length: 60 },
    (_, index) => `at Object.fn (/tmp/noisy-${index}.js:1:1)`,
  ).join("\n");
  failProgressState("req-1", blob);
  const state = getProgressState("req-1");
  expect(state?.errorText).toBe("Large unstructured error output omitted.");
  expect(state?.errorText).not.toContain("noisy-1");
});

test("progress error chooses status error check then semantic line", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState(
    "req-1",
    "debug: noisy\nCheck: bun test failed\nmeaningful fallback line",
  );
  expect(getProgressState("req-1")?.errorText).toBe("bun test failed");
  createProgressState("req-2", "agent-b", "task b");
  failProgressState("req-2", "debug: noisy\nmeaningful fallback line");
  expect(getProgressState("req-2")?.errorText).toBe("meaningful fallback line");
});

test("failProgressState sets error status and error text", () => {
  createProgressState("req-1", "agent-a", "task a");
  failProgressState("req-1", "something exploded");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBe("something exploded");
  expect(state?.finalOutput).toBeUndefined();
});

test("cancelProgressState sets cancelled status with unprefixed reason", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1", "Status: user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("user aborted");
});

test("cancelled progress ignores late tool previews", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "bash: running" });
  cancelProgressState("req-1", "user cancelled");
  patchProgressState("req-1", { lastToolPreview: "read: stale" });
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.errorText).toBe("user cancelled");
});

test("cancelProgressState with no reason leaves errorText undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  cancelProgressState("req-1");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBeUndefined();
});

test("terminal helpers capture deterministic duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  setDateNow(3450);
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.durationMs).toBe(2450);
  setDateNow(2000);
  createProgressState("req-2", "agent-b", "task b");
  setDateNow(7600);
  failProgressState("req-2", "something exploded");
  expect(getProgressState("req-2")?.durationMs).toBe(5600);
});

test("terminal helper no-ops for missing state", () => {
  expect(() => finalizeProgressState("req-1", "all done")).not.toThrow();
  expect(getProgressState("req-1")).toBeUndefined();
});

test("terminal helpers preserve existing duration", () => {
  setDateNow(1000);
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { durationMs: 123 });
  setDateNow(9000);
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.durationMs).toBe(123);
  expect(state?.status).toBe("cancelled");
});

test("terminal durations stay isolated by request", () => {
  setDateNow(1000);
  createProgressState("iso-success", "agent-a", "task a");
  setDateNow(2000);
  createProgressState("iso-error", "agent-b", "task b");
  setDateNow(3000);
  createProgressState("iso-running", "agent-c", "task c");
  setDateNow(5500);
  finalizeProgressState("iso-success", "all done");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBeUndefined();
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
  setDateNow(9000);
  failProgressState("iso-error", "child failed");
  expect(getProgressState("iso-success")?.durationMs).toBe(4500);
  expect(getProgressState("iso-error")?.durationMs).toBe(7000);
  setDateNow(12_500);
  const theme = makeTheme();
  const runningResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "iso-running" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(runningResult)).toContain("9.5s");
  expect(getProgressState("iso-running")?.durationMs).toBeUndefined();
});

test("clearProgressState removes state", () => {
  createProgressState("req-1", "agent-a", "task a");
  clearProgressState("req-1");
  expect(getProgressState("req-1")).toBeUndefined();
});

test("clearProgressState is a no-op for unknown id", () => {
  expect(() => clearProgressState("nonexistent")).not.toThrow();
});

test("makeTaskPreview returns full text when within bound", () => {
  expect(makeTaskPreview("short task")).toBe("short task");
});

test("makeTaskPreview labels empty task as agent default", () => {
  expect(makeTaskPreview("")).toBe("(agent default)");
});

test("makeTaskPreview keeps long semantic task text", () => {
  const long = "a".repeat(100);
  const preview = makeTaskPreview(long);
  expect(preview).toBe(long);
  expect(preview).not.toContain("...");
});

test("makeTaskPreview collapses whitespace", () => {
  expect(makeTaskPreview("line one\nline two")).toBe("line one line two");
});

test("makeToolPreview formats tool name and first arg value", () => {
  const preview = makeToolPreview("bash", { command: "ls -la" });
  expect(preview).toBe("bash: ls -la");
});

test("makeToolPreview collapses multiline whitespace", () => {
  const preview = makeToolPreview("bash", {
    command: "printf 'a'\n\t  echo b",
  });
  expect(preview).toBe("bash: printf 'a' echo b");
  expect(preview).not.toContain("\n");
});

test("makeToolPreview truncates after whitespace normalization", () => {
  const command = `${"x".repeat(100)}\n\t${"y".repeat(40)}`;
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"bash: "}${"x".repeat(100)} ${"y".repeat(12)}…`);
  expect(preview).not.toContain("\n");
});

test("makeToolPreview keeps semantic target without ellipsis", () => {
  const path = "a".repeat(100);
  const preview = makeToolPreview("read", { path });
  expect(preview).toBe(`read: ${path}`);
  expect(preview).not.toContain("...");
});

test("makeToolPreview leaves 120 displayed characters unchanged", () => {
  const command = "λ".repeat(114);
  const preview = makeToolPreview("bash", { command });
  expect(preview).toBe(`bash: ${command}`);
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(false);
});

test("makeToolPreview truncates long previews to 120 displayed characters", () => {
  const command = "λ".repeat(115);
  const preview = makeToolPreview("bash", { command });
  expect(Array.from(preview).length).toBe(120);
  expect(preview.endsWith("…")).toBe(true);
  expect(preview).toBe(`${"bash: "}${"λ".repeat(113)}…`);
});

test("makeToolPreview truncates long path preview after tool prefix", () => {
  const path = `/tmp/${"x".repeat(130)}`;
  const preview = makeToolPreview("read", { path });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toBe(`${"read: "}${path.slice(0, 113)}…`);
  expect(preview).not.toContain("x".repeat(115));
});

test("makeToolPreview omits unknown tool arguments", () => {
  const args = {
    token: "secret-token",
    password: "secret-password",
    nested: { value: "secret-nested" },
  };
  const preview = makeToolPreview("unknown_tool", args);
  expect(preview).toBe("unknown_tool");
  expect(preview).not.toContain(":");
  expect(preview).not.toContain("secret");
});

test("makeToolPreview includes agent for subagent", () => {
  const preview = makeToolPreview("subagent", {
    agent: "builder",
    task: `${"review ".repeat(30)}sentinel`,
    agentScope: "project",
  });
  expect(preview).toBe("subagent: builder");
});

test("makeToolPreview uses query for web_search", () => {
  const preview = makeToolPreview("web_search", { query: "typescript" });
  expect(preview).toBe("web_search: typescript");
});

test("makeToolPreview uses url for fetch_url", () => {
  const preview = makeToolPreview("fetch_url", { url: "https://example.com" });
  expect(preview).toBe("fetch_url: https://example.com");
});

test("makeToolPreview uses action for computer_use", () => {
  const preview = makeToolPreview("computer_use", { action: "click" });
  expect(preview).toBe("computer_use: click");
});

test("makeToolPreview handles empty args", () => {
  expect(makeToolPreview("bash", {})).toBe("bash");
  expect(makeToolPreview("bash", undefined)).toBe("bash");
});

test("makeToolPreview omits blank semantic targets", () => {
  expect(makeToolPreview("bash", { command: "\n\t  " })).toBe("bash");
});

test("makeToolPreview includes safe first string for unknown tools", () => {
  expect(makeToolPreview("unknown_tool", { project: "my-project" })).toBe(
    "unknown_tool: my-project",
  );
  expect(
    makeToolPreview("unknown_tool", {
      project: "my-project",
      count: 42,
    }),
  ).toBe("unknown_tool: my-project");
});

test("makeToolPreview suppresses fallback when only secret-like keys present", () => {
  expect(makeToolPreview("unknown_tool", { token: "x", password: "y" })).toBe(
    "unknown_tool",
  );
  expect(
    makeToolPreview("unknown_tool", { token: "x", password: "y" }),
  ).not.toContain(":");
});

test("multiple independent request ids are isolated", () => {
  createProgressState("req-1", "agent-a", "task a");
  createProgressState("req-2", "agent-b", "task b");
  finalizeProgressState("req-1", "output a");
  const s1 = getProgressState("req-1");
  const s2 = getProgressState("req-2");
  expect(s1?.status).toBe("success");
  expect(s2?.status).toBe("running");
  expect(s2?.agent).toBe("agent-b");
});

test("SENSITIVE_PATTERN matches sensitive terms and mixed content", () => {
  expect(SENSITIVE_PATTERN.test("secret")).toBe(true);
  expect(SENSITIVE_PATTERN.test("token")).toBe(true);
  expect(SENSITIVE_PATTERN.test("password")).toBe(true);
  expect(SENSITIVE_PATTERN.test("apiToken")).toBe(true);
  expect(SENSITIVE_PATTERN.test("user_password")).toBe(true);
  expect(SENSITIVE_PATTERN.test("benign preface token=abc benign suffix")).toBe(
    true,
  );
  expect(SENSITIVE_PATTERN.test("safe context only")).toBe(false);
});

test("sanitizeDetailsForDisplay redacts sensitive debug message content", () => {
  const details = makeDetails([
    {
      role: "assistant",
      usage: { input: 1, output: 2 },
      content: [
        { type: "text", text: "safe context" },
        { type: "text", text: "secret launch token" },
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: {
            command: "echo benign",
            token: "abc123",
            nested: { password: "hunter2" },
          },
        },
      ],
    },
  ]);
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messageJson = JSON.stringify(sanitized.results[0]?.messages);
  expect(sanitized.results[0]?.messages?.map((m) => m.role)).toEqual([
    "assistant",
  ]);
  expect(messageJson).toContain("safe context");
  expect(messageJson).toContain("echo benign");
  expect(messageJson).toContain("launch");
  expect(messageJson).toContain("usage");
  expect(messageJson).not.toContain("secret launch token");
  expect(messageJson).not.toContain("abc123");
  expect(messageJson).not.toContain("hunter2");
  expect(messageJson).toContain("[redacted] launch [redacted]");
});

test("sanitizeDetailsForDisplay handles unusual debug message shapes", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.messages = [
    null,
    "password inline",
    { role: "assistant", content: null },
    {
      role: "toolResult",
      content: [{ type: "text", text: ["token nested", "benign"] }],
      usage: { input: 1, output: 2 },
    },
  ] as unknown as Message[];
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messageJson = JSON.stringify(sanitized.results[0]?.messages);
  expect(messageJson).toContain("benign");
  expect(messageJson).toContain('"input":1');
  expect(messageJson).toContain("inline");
  expect(messageJson).toContain("nested");
  expect(messageJson).not.toContain("password inline");
  expect(messageJson).not.toContain("token nested");
});

test("sanitizeDetailsForDisplay preserves benign mixed debug detail", () => {
  const details = makeDetails([
    {
      role: "assistant",
      usage: { input: 3, output: 4, totalTokens: 7 },
      content: [
        {
          type: "text",
          text: "benign preface token=abc benign suffix",
        },
        {
          type: "toolCall",
          id: "tc-1",
          name: "write",
          arguments: {
            path: "safe.txt",
            metadata: { label: "benign field" },
            password: "hunter2",
          },
        },
      ],
    },
    {
      role: "user",
      usage: { input: 5, output: 0 },
      content: [{ type: "text", text: "ordinary follow up" }],
    },
  ]);
  const sanitized = sanitizeDetailsForDisplay(details, true);
  const messages = sanitized.results[0]?.messages ?? [];
  const messageJson = JSON.stringify(messages);
  expect(messages.map((message) => message.role)).toEqual([
    "assistant",
    "user",
  ]);
  expect(messageJson).toContain("benign preface");
  expect(messageJson).toContain("benign suffix");
  expect(messageJson).toContain("safe.txt");
  expect(messageJson).toContain("benign field");
  expect(messageJson).toContain("ordinary follow up");
  expect(messageJson).toContain('"input":3');
  expect(messageJson).not.toContain("token=abc");
  expect(messageJson).not.toContain("hunter2");
  expect(messageJson).toContain("[redacted]");
});

test("extractProgressFromDetails returns empty result for details with no messages", () => {
  const details = makeDetails([]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails returns derived progress without messages", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  delete firstResult.messages;
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: ls" },
      { id: "safe-2", preview: "read: /tmp/foo" },
    ],
    lastToolPreview: "read: /tmp/foo",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1", "safe-2"]);
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
});

test("extractProgressFromDetails prefers derived progress over legacy messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "raw-1",
          name: "bash",
          arguments: { command: "secret-token" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "safe-1", preview: "bash" }],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
  expect(seen.has("raw-1")).toBe(false);
});

test("extractProgressFromDetails ignores malformed derived progress ids", () => {
  const details = makeDetails([]) as unknown as SubagentDetails;
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash" },
      { id: 7, preview: "bad" },
      { id: "bad", preview: null },
    ] as unknown as { id: string; preview: string }[],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-1"]);
  expect(result.lastToolPreview).toBe("bash");
});

test("extractProgressFromDetails normalizes derived progress previews", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "safe-1", preview: "bash: printf 'a'\n\t  echo b" },
      { id: "safe-2", preview: `read: /tmp/foo\n${"x".repeat(130)}` },
    ],
  };
  const seen = new Set<string>(["safe-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["safe-2"]);
  expect(result.lastToolPreview).toBe(`read: /tmp/foo ${"x".repeat(104)}…`);
  expect([...seen]).toEqual(["safe-1", "safe-2"]);
});

test("extractProgressFromDetails returns new tool call ids from assistant messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toContain("tc-1");
  expect(result.newToolCallIds).toContain("tc-2");
  expect(result.newToolCallIds.length).toBe(2);
});

test("extractProgressFromDetails skips already-seen tool call ids", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set(["tc-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-2"]);
});

test("extractProgressFromDetails returns undefined lastToolPreview but populated activityText when all derived progress tool calls are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: ls" },
      { id: "tc-2", preview: "read: /tmp/file" },
    ],
    activityText: "read: /tmp/file",
    lastToolPreview: "read: /tmp/file",
  };
  const seen = new Set(["tc-1", "tc-2"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("read: /tmp/file");
});

test("extractProgressFromDetails mutates seen ids and reports count delta", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
        { type: "toolCall", id: "tc-2", name: "read", arguments: {} },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect([...seen].sort()).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails handles malformed and nested message data safely", () => {
  const details = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      { messages: null },
      { messages: [{ role: "assistant", content: null }] },
      {
        messages: [
          {
            role: "assistant",
            content: [
              null,
              { type: "toolCall", id: 42, name: "bad" },
              {
                type: "toolCall",
                id: "tc-nested",
                name: "outer",
                arguments: { nested: { path: "/tmp/x" } },
              },
            ],
          },
        ],
      },
    ],
  } as unknown as SubagentDetails;
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-nested"]);
  expect(result.lastToolPreview).toBe("outer");
});

test("extractProgressFromDetails returns last tool preview", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "tc-2",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("read: /tmp/foo");
});

test("extractProgressFromDetails omits unknown secret arguments", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-secret",
          name: "unknown_tool",
          arguments: {
            token: "secret-token",
            password: "secret-password",
            nested: { value: "secret-nested" },
          },
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("unknown_tool");
  expect(result.lastToolPreview).not.toContain(":");
  expect(result.lastToolPreview).not.toContain("secret");
});

test("extractProgressFromDetails ignores non-assistant messages", () => {
  const details = makeDetails([
    { role: "user", content: [{ type: "text", text: "do something" }] },
    {
      role: "toolResult",
      content: [
        {
          type: "toolResultContent",
          toolCallId: "tc-x",
          content: [{ type: "text", text: "done" }],
        },
      ],
    },
  ]);
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails handles empty output when no results", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails returns activityText from nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails prefers child tool preview over nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "Reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.activityText).toBe("Reading file.ts");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails does not create tool-call IDs for nested activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Scanning codebase",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(seen.size).toBe(0);
});

test("extractProgressFromDetails normalizes and truncates nested activity text", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const longActivity = `${"x".repeat(150)}`;
  firstResult.progress = {
    toolCalls: [],
    activityText: `Reading ${longActivity}`,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeDefined();
  const chars = Array.from(result.activityText ?? "");
  expect(chars.length).toBeLessThanOrEqual(120);
  expect(result.activityText).toEndWith("…");
});

test("nested-only update changes running preview without changing toolCount", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading config.ts",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Reading config.ts");
  expect(state?.toolCount).toBe(0);
  expect([...seen]).toEqual([]);
});

test("child-owned tool updates regain preview precedence after nested activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: scanning files" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: scanning files",
  );
  patchProgressState("req-1", {
    lastToolPreview: "bash: ls -la",
    toolCount: 1,
  });
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: ls -la");
  expect(state?.toolCount).toBe(1);
});

test("terminal states clear nested activity preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: reading file.ts" });
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Nested: reading file.ts",
  );
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  createProgressState("req-2", "agent-b", "task b");
  patchProgressState("req-2", { lastToolPreview: "Nested: scanning" });
  failProgressState("req-2", "child failed");
  expect(getProgressState("req-2")?.lastToolPreview).toBeUndefined();
  createProgressState("req-3", "agent-c", "task c");
  patchProgressState("req-3", { lastToolPreview: "Nested: working" });
  cancelProgressState("req-3", "user aborted");
  expect(getProgressState("req-3")?.lastToolPreview).toBeUndefined();
});

test("extractProgressFromDetails ignores whitespace-only activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "   ",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails ignores empty activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails ignores non-string activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: 42 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails normalizes nested activity whitespace", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts\n\twith tabs",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading file.ts with tabs");
});

test("extractProgressFromDetails redacts sensitive nested activity keywords", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading secret-token.yaml",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Reading secret-token.yaml");
});

test("extractProgressFromDetails updates seen set without tool-call drift from activity", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-child",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: ls" }],
    activityText: "Nested: reading file.ts",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect([...seen]).toEqual(["tc-child"]);
  expect(result.activityText).toBe("Nested: reading file.ts");
});

test("extractProgressFromDetails ignores already-seen derived previews with activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: stale" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: stale",
  };
  const seen = new Set<string>(["tc-child"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("Nested: reading fresh.ts");
  expect([...seen]).toEqual(["tc-child"]);
});

test("extractProgressFromDetails keeps last fresh preview ahead of repeated IDs", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-child", preview: "bash: fresh" },
      { id: "tc-child", preview: "bash: stale" },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-child"]);
  expect(result.lastToolPreview).toBe("bash: fresh");
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails uses nested activity when child tool id repeats", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "bash: original",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: changed" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: changed",
  };
  const seen = new Set<string>(["tc-child"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Nested: reading fresh.ts");
  expect(state?.toolCount).toBe(1);
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails preserves parent fields during nested-only updates", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    lastToolPreview: "bash: child-owned",
    toolCount: 2,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.agent = "other-agent";
  firstResult.instanceName = "other-instance";
  firstResult.task = "other task";
  firstResult.exitCode = 1;
  firstResult.finalOutput = "SHOULD_NOT_COPY";
  firstResult.usage = {
    ...firstResult.usage,
    input: 99,
    output: 88,
    contextTokens: 77,
    contextWindowTokens: 66,
  };
  firstResult.progress = {
    toolCalls: [{ id: "tc-child", preview: "bash: child-owned" }],
    activityText: "Nested: reading fresh.ts",
    lastToolPreview: "bash: child-owned",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: child-owned",
      },
    },
  };
  const seen = new Set<string>(["tc-child"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("subagent: build - bash: child-owned");
  expect(state?.requestId).toBe("req-1");
  expect(state?.agent).toBe("agent-a");
  expect(state?.instanceName).toBe("able-falcon");
  expect(state?.taskPreview).toBe("task a");
  expect(state?.status).toBe("running");
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(99);
  expect(state?.outputTokens).toBe(88);
  expect(state?.contextTokens).toBe(77);
  expect(state?.contextWindowTokens).toBe(66);
  expect(state?.finalOutput).toBeUndefined();
  expect(state?.errorText).toBeUndefined();
  expect(firstResult.progress.toolCalls).toEqual([
    { id: "tc-child", preview: "bash: child-owned" },
  ]);
  expect([...seen]).toEqual(["tc-child"]);
});

test("patchProgressFromDetails gives fresh child tool preview precedence", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { lastToolPreview: "Nested: scanning" });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: ls -la" }],
    activityText: "Nested: stale scan",
    lastToolPreview: "bash: ls -la",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: ls -la");
  expect(state?.toolCount).toBe(1);
  expect([...seen]).toEqual(["tc-fresh"]);
});

test("patchProgressFromDetails maintains lastToolPreview via activityText fallback on repeated update with no new tool calls", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
});

test("child default preview fallback: extractProgressFromDetails returns no new tool-call IDs when all child IDs are already seen", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual([]);
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.activityText).toBe(childDefaultPreview);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("child default preview fallback after nested activity: message update repeats default child preview with no fresh tool-call IDs", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning codebase",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 200,
    output: 80,
    contextTokens: 280,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(2);
  // activityText updates the activity and preview
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.inputTokens).toBe(200);
  expect(state?.outputTokens).toBe(80);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("child default preview fallback after nested activity: tool-result update repeats default child preview with no fresh tool-call IDs", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: reading config.ts",
    toolCount: 3,
    inputTokens: 150,
    outputTokens: 60,
    contextTokens: 210,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "read: /tmp/file";
  firstResult.progress = {
    toolCalls: [
      { id: "child-tool-1", preview: "bash: ls" },
      { id: "child-tool-2", preview: childDefaultPreview },
    ],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 300,
    output: 120,
    contextTokens: 420,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1", "child-tool-2"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  // activityText updates the activity and preview
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "read: /tmp/file",
  });
  expect(state?.lastToolPreview).toBe("read: /tmp/file");
  expect(state?.inputTokens).toBe(300);
  expect(state?.outputTokens).toBe(120);
  expect([...seen]).toEqual(["child-tool-1", "child-tool-2"]);
});

test("fresh child tool-call ID distinguishes normal preview update from child default preview fallback", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning codebase",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "child-tool-seen", preview: "bash: ls" },
      { id: "child-tool-fresh", preview: "read: /tmp/new" },
    ],
    activityText: "read: /tmp/new",
    lastToolPreview: "read: /tmp/new",
  };
  const seen = new Set<string>(["child-tool-seen"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(3);
  expect(state?.lastToolPreview).toBe("read: /tmp/new");
  expect([...seen]).toEqual(["child-tool-seen", "child-tool-fresh"]);
});

test("child default preview fallback fixture preserves normalization truncation seen-tool tracking and usage observability", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = `bash: ${"x".repeat(150)}`;
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: childDefaultPreview,
    lastToolPreview: childDefaultPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 120,
    output: 45,
    contextTokens: 165,
    contextWindowTokens: 500,
  };
  const seen = new Set<string>(["child-tool-1"]);
  const extracted = extractProgressFromDetails(details, seen);
  expect(extracted.activityText).toBeDefined();
  const activityChars = Array.from(extracted.activityText ?? "");
  expect(activityChars.length).toBeLessThanOrEqual(120);
  expect(extracted.activityText).toEndWith("…");
  expect(extracted.activityText).not.toContain("\n");
  expect(extracted.newToolCallIds).toEqual([]);
  expect([...seen]).toEqual(["child-tool-1"]);
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: prior activity",
    toolCount: 1,
  });
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  const previewChars = Array.from(state?.lastToolPreview ?? "");
  expect(previewChars.length).toBeLessThanOrEqual(120);
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(120);
  expect(state?.outputTokens).toBe(45);
  expect(state?.contextTokens).toBe(165);
  expect(state?.contextWindowTokens).toBe(500);
});

test("successive nested activity updates replace prior preserved nested preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = { toolCalls: [], activityText: "Scanning src directory" };
  const seen2 = new Set<string>();
  patchProgressFromDetails("req-1", details2, seen2);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Scanning src directory",
  );
  expect(getProgressState("req-1")?.toolCount).toBe(0);
});

test("fresh child tool call via patchProgressFromDetails supersedes nested activity set via patchProgressFromDetails", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: echo hello" }],
    activityText: "bash: echo hello",
    lastToolPreview: "bash: echo hello",
  };
  const seen2 = new Set<string>();
  patchProgressFromDetails("req-1", details2, seen2);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("bash: echo hello");
  expect(state?.toolCount).toBe(1);
  expect([...seen2]).toEqual(["tc-fresh"]);
});

test("supersession chain: nested activity then fresh child tool then new nested activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  const d3 = makeDetails([]);
  const r3 = d3.results[0];
  if (!r3) throw new Error("missing result");
  r3.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "Scanning dependencies",
    lastToolPreview: "bash: ls",
  };
  const s3 = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", d3, s3);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "Scanning dependencies",
  );
  expect(getProgressState("req-1")?.toolCount).toBe(1);
});

test("terminal success clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  finalizeProgressState("req-1", "all done");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("success");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("success");
});

test("terminal error clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  failProgressState("req-1", "child failed");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("error");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("error");
});

test("terminal cancellation clears preserved nested activity and rejects late patchProgressFromDetails preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "Reading config.ts" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("Reading config.ts");
  cancelProgressState("req-1", "user aborted");
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("cancelled");
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-late", preview: "bash: stale" }],
    activityText: "bash: stale",
    lastToolPreview: "bash: stale",
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
  expect(getProgressState("req-1")?.status).toBe("cancelled");
});

test("nested activity passes through when activityText differs from child progress lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Prior nested activity",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  const childDefaultPreview = "bash: ls";
  const genuineActivity = "Scanning utils";
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: childDefaultPreview }],
    activityText: genuineActivity,
    lastToolPreview: childDefaultPreview,
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: childDefaultPreview,
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 200,
    output: 80,
    contextTokens: 280,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(2);
  expect(state?.lastToolPreview).toBe("subagent: build - bash: ls");
  expect(state?.inputTokens).toBe(200);
  expect(state?.outputTokens).toBe(80);
  expect(state?.contextTokens).toBe(280);
  expect(state?.contextWindowTokens).toBe(1000);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("repeated identical nested activity update is a no-op when stored preview matches incoming preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const nestedPreview = "Reading config.ts";
  patchProgressState("req-1", {
    lastToolPreview: nestedPreview,
    toolCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: nestedPreview }],
    activityText: nestedPreview,
    lastToolPreview: nestedPreview,
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(1);
  expect(state?.lastToolPreview).toBe(nestedPreview);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
  expect(state?.contextTokens).toBe(150);
  expect([...seen]).toEqual(["child-tool-1"]);
});

test("default fallback detection allows update when stored progress has no lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.toolCount).toBe(0);
});

test("default fallback detection returns false when child has no activityText", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual([]);
});

test("default fallback detection skips when activityText mismatches child progress lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: scanning",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "child-tool-1", preview: "bash: ls" }],
    activityText: "genuine nested activity",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>(["child-tool-1"]);
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.lastToolPreview).toBe(
    "genuine nested activity",
  );
});

test("default fallback detection handles empty progress with no fields set", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "Nested: prior",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.toolCount).toBe(1);
  expect(state?.lastToolPreview).toBe("Nested: prior");
});

test("extractProgressFromDetails skips non-string progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: 123 as unknown as string,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails skips empty progress lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "scanning",
    lastToolPreview: "   ",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.activityText).toBe("scanning");
});

test("extractProgressFromDetails captures activityText and progressLastToolPreview independently", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "genuine nested activity",
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("genuine nested activity");
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("patchProgressFromDetails handles details with no results gracefully", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")?.toolCount).toBe(0);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
});

test("patchProgressFromDetails handles undefined effectivePreview gracefully", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", { toolCount: 1 });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  firstResult.usage = {
    ...firstResult.usage,
    input: 50,
    output: 30,
    contextTokens: 80,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  expect(getProgressState("req-1")?.inputTokens).toBe(50);
  expect(getProgressState("req-1")?.outputTokens).toBe(30);
  expect(getProgressState("req-1")?.lastToolPreview).toBeUndefined();
});

test("nested-only update detection returns false when latestResult progress is missing", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  delete firstResult.progress;
  firstResult.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
  ] as unknown as Message[];
  firstResult.usage = {
    ...firstResult.usage,
    input: 50,
    output: 30,
    contextTokens: 80,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
  expect(getProgressState("req-1")?.lastToolPreview).toBe("bash: ls");
  expect(getProgressState("req-1")?.inputTokens).toBe(50);
});

test("nested-only update allows usage when previous progress has matching activityText and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details1 = makeDetails([]);
  const r1 = details1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = {
    toolCalls: [{ id: "tc-1", preview: "Read" }],
    activityText: "Read",
    lastToolPreview: "Read",
  };
  const seen1 = new Set<string>();
  patchProgressFromDetails("req-1", details1, seen1);
  const details2 = makeDetails([]);
  const r2 = details2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-1", preview: "Read" }],
    activityText: "Read",
    lastToolPreview: "Read",
  };
  r2.usage = {
    ...r2.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen2 = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", details2, seen2);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("Read");
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
});

function makeTheme() {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
  };
}

function makeMarkerTheme() {
  return {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => text,
  };
}

function renderLines(
  rendered: { render(width: number): string[] } | undefined,
): string[] {
  if (!rendered) return [];
  return rendered.render(120);
}

function renderLinesAtWidth(
  rendered: { render(width: number): string[] } | undefined,
  width: number,
): string[] {
  if (!rendered) return [];
  return rendered.render(width);
}

function stripAnsiAndWrappers(text: string): string {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text
    .replace(ansiPattern, "")
    .replace(/\[(?:toolPendingBg|toolSuccessBg|toolErrorBg)\]/g, "")
    .replace(/\[\/(?:toolPendingBg|toolSuccessBg|toolErrorBg)\]/g, "");
}

function renderText(
  rendered: { render(width: number): string[] } | undefined,
): string {
  return renderLines(rendered).join("\n");
}

test("formatElapsed renders seconds for short durations", () => {
  expect(formatElapsed(2500)).toBe("2.5s");
});

test("formatElapsed renders minutes and seconds for long durations", () => {
  expect(formatElapsed(90000)).toBe("1m 30s");
});

test("formatElapsed renders 0s for zero", () => {
  expect(formatElapsed(0)).toBe("0.0s");
});

test("renderSubagentProgress returns undefined for missing state", () => {
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "no-such-id" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeUndefined();
});

test("renderSubagentProgress formats segmented agent and instance title", () => {
  createProgressState("rend-1", "my-agent", "do the thing", "able-falcon");
  const theme = {
    fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
    bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => `<bold>${text}</bold>`,
    italic: (text: string) => `<italic>${text}</italic>`,
  };
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain(
    "<toolTitle><bold>my-agent</bold></toolTitle> <accent><italic>able-falcon</italic></accent>",
  );
  expect(text).toContain("<dim>[running]</dim>");
  expect(text).toContain("<muted>0 tools · --% ctx ·");
});

test("renderSubagentProgress uses ANSI italic fallback for instance title", () => {
  createProgressState("rend-2", "my-agent", "do the thing", "able-falcon");
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain(
    "<toolTitle>my-agent</toolTitle> <accent>\x1b[3mable-falcon\x1b[23m</accent> <dim>[running]</dim>",
  );
  expect(text.indexOf("\x1b[23m</accent> <dim>[running]")).toBeGreaterThan(-1);
});

test("renderSubagentProgress keeps single title when instance is absent or empty", () => {
  createProgressState("rend-1", "my-agent", "do the thing", "");
  createProgressState("rend-2", "other-agent", "do the thing");
  patchProgressState("rend-2", {});
  const theme = makeMarkerTheme();
  const first = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const second = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  const firstText = renderText(first);
  const secondText = renderText(second);
  expect(firstText).toContain(
    "<toolTitle>my-agent</toolTitle> <dim>[running]</dim>",
  );
  expect(firstText).not.toContain("my-agent  ");
  expect(firstText).not.toContain("\x1b[3m");
  expect(secondText).toContain(
    "<toolTitle>other-agent</toolTitle> <dim>[running]</dim>",
  );
  expect(secondText).not.toContain("other-agent  ");
  expect(secondText).not.toContain("\x1b[3m");
});

test("renderSubagentProgress collapsed running colors tool preview segments", () => {
  setDateNow(1000);
  createProgressState("rend-1", "my-agent", "do the thing", "rend-1");
  setDateNow(3500);
  patchProgressState("rend-1", {
    toolCount: 3,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls -la" },
    lastToolPreview: "bash: ls -la",
    contextTokens: 18_000,
    contextWindowTokens: 240_000,
    inputTokens: 1200,
    outputTokens: 300,
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(text).toContain(
    "my-agent</toolTitle> <accent>\x1b[3mrend-1\x1b[23m</accent>",
  );
  expect(text).toContain("running");
  expect(text).toContain("3 tools · 8%");
  expect(text.indexOf("\x1b[23m</accent> <dim>[running]")).toBeLessThan(
    text.indexOf("3 tools · 8%"),
  );
  expect(text).toContain("ctx · 2.5s");
  expect(text).not.toContain("1.2k in");
  expect(text).not.toContain("300 out");
  expect(text).not.toContain("1.2k in · 300 out · 8% ctx");
  expect(text).not.toContain("2 turns");
  expect(text).not.toContain("18k ctx");
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent><dim>: ls -la</dim>",
  );
  expect(text).not.toContain("bash: ls -la (");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolPendingBg]") && line.endsWith("[/toolPendingBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress collapsed running colors targetless tool preview", () => {
  createProgressState("rend-2", "my-agent", "do the thing");
  patchProgressState("rend-2", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash" },
    lastToolPreview: "bash",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent>",
  );
  expect(toolLine).not.toContain("<dim>:");
  expect(toolLine).not.toContain("</accent>:");
  expect(text).toContain("Task: do the thing");
});

test("renderSubagentProgress running omits unknown tool arguments", () => {
  createProgressState("rend-12", "my-agent", "do the thing");
  patchProgressState("rend-12", {
    activeToolActivity: {
      toolName: "unknown_tool",
      inputSummary: "unknown_tool",
    },
    lastToolPreview: makeToolPreview("unknown_tool", {
      token: "secret-token",
      password: "secret-password",
      nested: { value: "secret-nested" },
    }),
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-12" },
    },
    { expanded: false },
    theme,
  );
  const text = renderText(result);
  const toolLine = renderLines(result).find((line) =>
    line.includes("unknown_tool"),
  );
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <muted>→</muted> <accent>unknown_tool</accent>",
  );
  expect(toolLine).not.toContain(":");
  expect(text).not.toContain("secret");
});

test("renderSubagentProgress expanded running includes truncated tool preview and full task preview", () => {
  const toolSentinel = "SHOULD_NOT_RENDER";
  const taskSentinel = "TASK_SHOULD_RENDER";
  const taskPreview = `do the thing ${taskSentinel}`;
  const longCommand = `${"x".repeat(160)}${toolSentinel}`;
  const lastToolPreview = makeToolPreview("bash", { command: longCommand });
  createProgressState("rend-2", "my-agent", taskPreview);
  patchProgressState("rend-2", {
    toolCount: 1,
    activeToolActivity: { toolName: "bash", inputSummary: lastToolPreview },
    lastToolPreview,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(lastToolPreview).toEndWith("…");
  expect(text).toContain("→ bash:");
  expect(text).toContain("…");
  expect(text).toContain(taskPreview);
  expect(text.indexOf("\x1b[23m [running]")).toBeLessThan(
    text.indexOf(taskPreview),
  );
  expect(text).not.toContain(toolSentinel);
});

test("renderSubagentProgress component reads patched state on later renders", () => {
  createProgressState("rend-live", "live-agent", "live task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-live" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(result)).toContain("0 tools · --% ctx");
  patchProgressState("rend-live", {
    toolCount: 2,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: pwd" },
    lastToolPreview: "bash: pwd",
    contextTokens: 10_000,
    inputTokens: 1200,
    outputTokens: 300,
  });
  const text = renderText(result);
  expect(text).toContain("2 tools · --% ctx");
  expect(text).not.toContain("1.2k in");
  expect(text).not.toContain("300 out");
  expect(text).not.toContain("1.2k in · 300 out · --% ctx");
  expect(text).not.toContain("3 turns");
  expect(text).not.toContain("10k ctx");
  expect(text).not.toContain("1.2k in / 300 out");
  expect(text).toContain("→ bash: pwd");
  expect(text).not.toContain("bash: pwd (");
});

test("renderSubagentProgress renders modelDisplay footer if present", () => {
  createProgressState("rend-model", "model-agent", "model task");
  patchProgressState("rend-model", { modelDisplay: "gemini-1.5-pro" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-model" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gemini-1.5-pro");
});

test("renderSubagentProgress renders modelDisplay footer for expanded running state", () => {
  createProgressState("rend-model-exp", "model-agent", "model task");
  patchProgressState("rend-model-exp", {
    modelDisplay: "gemini-1.5-pro",
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-model-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gemini-1.5-pro");
  expect(text).toContain("model task");
  expect(text).toContain("bash: ls");
});

test("renderSubagentProgress renders modelDisplay footer for error state", () => {
  createProgressState("rend-err", "err-agent", "error task");
  failProgressState("rend-err", "something exploded");
  patchProgressState("rend-err", { modelDisplay: "claude-3-5-sonnet" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-err" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("claude-3-5-sonnet");
  expect(text).toContain("something exploded");
});

test("renderSubagentProgress renders modelDisplay footer for expanded error state", () => {
  createProgressState("rend-err-exp", "err-agent", "error task");
  failProgressState("rend-err-exp", "something exploded");
  patchProgressState("rend-err-exp", { modelDisplay: "claude-3-5-sonnet" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-err-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("claude-3-5-sonnet");
  expect(text).toContain("something exploded");
  expect(text).toContain("error task");
});

test("renderSubagentProgress renders modelDisplay footer for cancelled state", () => {
  createProgressState("rend-cancel", "cancel-agent", "cancel task");
  cancelProgressState("rend-cancel", "user cancelled");
  patchProgressState("rend-cancel", { modelDisplay: "gpt-4o" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-cancel" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gpt-4o");
  expect(text).toContain("cancelled");
});

test("renderSubagentProgress renders modelDisplay footer for expanded cancelled state", () => {
  createProgressState("rend-cancel-exp", "cancel-agent", "cancel task");
  cancelProgressState("rend-cancel-exp", "user cancelled");
  patchProgressState("rend-cancel-exp", { modelDisplay: "gpt-4o" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-cancel-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("gpt-4o");
  expect(text).toContain("cancel task");
});

test("renderSubagentProgress renders modelDisplay footer for success state", () => {
  createProgressState("rend-ok", "ok-agent", "success task");
  finalizeProgressState("rend-ok", "all done");
  patchProgressState("rend-ok", { modelDisplay: "provider/model:compact" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-ok" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("provider/model:compact");
  expect(text).toContain("all done");
});

test("renderSubagentProgress renders modelDisplay footer for expanded success state", () => {
  createProgressState("rend-ok-exp", "ok-agent", "success task");
  finalizeProgressState("rend-ok-exp", "all done");
  patchProgressState("rend-ok-exp", { modelDisplay: "provider/model:compact" });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-ok-exp" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("provider/model:compact");
  expect(text).toContain("success task");
  expect(text).toContain("all done");
});

test("format header stats renders tool count context percent and elapsed", () => {
  const stats = formatHeaderStats({
    requestId: "req-1",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running",
    startTime: 0,
    durationMs: 2500,
    toolCount: 3,
    contextTokens: 18_000,
    contextWindowTokens: 240_000,
    inputTokens: 7100,
    outputTokens: 890,
  });
  expect(stats).toBe("3 tools · 8% ctx · 2.5s");
  expect(stats).not.toContain("7.1k in");
  expect(stats).not.toContain("890 out");
});

test("format header stats pluralizes zero singular and plural tool counts", () => {
  const base = {
    requestId: "req-1",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 0,
    durationMs: 2500,
  };
  expect(formatHeaderStats({ ...base, toolCount: 0 })).toBe(
    "0 tools · --% ctx · 2.5s",
  );
  expect(formatHeaderStats({ ...base, toolCount: 1 })).toBe(
    "1 tool · --% ctx · 2.5s",
  );
  expect(formatHeaderStats({ ...base, toolCount: 2 })).toBe(
    "2 tools · --% ctx · 2.5s",
  );
});

test("format header stats handles zero usage and context fallbacks", () => {
  setDateNow(4000);
  const base = {
    requestId: "req-1",
    agent: "agent-a",
    instanceName: "able-falcon",
    taskPreview: "task a",
    status: "running" as const,
    startTime: 1000,
    toolCount: 0,
  };
  expect(formatHeaderStats(base)).toBe("0 tools · --% ctx · 3.0s");
  expect(
    formatHeaderStats({ ...base, contextTokens: -1, contextWindowTokens: 100 }),
  ).toBe("0 tools · 0% ctx · 3.0s");
  expect(
    formatHeaderStats({
      ...base,
      contextTokens: Number.NaN,
      contextWindowTokens: 100,
    }),
  ).toBe("0 tools · 0% ctx · 3.0s");
  expect(
    formatHeaderStats({ ...base, contextTokens: 50, contextWindowTokens: 0 }),
  ).toBe("0 tools · --% ctx · 3.0s");
  expect(
    formatHeaderStats({
      ...base,
      contextTokens: 50,
      contextWindowTokens: Number.POSITIVE_INFINITY,
    }),
  ).toBe("0 tools · --% ctx · 3.0s");
});

test("renderSubagentProgress error state shows error text", () => {
  createProgressState("rend-3", "err-agent", "a task", "rend-3");
  failProgressState("rend-3", "something exploded");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-3" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("err-agent \x1b[3mrend-3\x1b[23m");
  expect(text).toContain("error");
  expect(text).toContain("something exploded");
  expect(text).not.toContain("FAILURE: something exploded");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress terminal renderer keeps compact state text", () => {
  createProgressState("rend-1", "ok-agent", "success task");
  finalizeProgressState(
    "rend-1",
    "Outcome: completed first line\nraw detail SHOULD_NOT_RENDER",
  );
  createProgressState("rend-2", "neutral-agent", "neutral task");
  finalizeProgressState(
    "rend-2",
    "Result: needs follow-up review\nraw detail SHOULD_NOT_RENDER",
  );
  const theme = makeTheme();
  const collapsed = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  const expanded = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-2" },
    },
    { expanded: true },
    theme,
  );
  expect(renderText(collapsed)).toContain("completed first line");
  expect(renderText(expanded)).toContain("needs follow-up review");
  expect(renderText(collapsed)).not.toContain("SUCCESS:");
  expect(renderText(collapsed)).not.toContain("SHOULD_NOT_RENDER");
  expect(renderText(expanded)).not.toContain("SUCCESS:");
  expect(renderText(expanded)).not.toContain("SHOULD_NOT_RENDER");
});

test("renderSubagentProgress expanded success ignores patched raw multiline output", () => {
  createProgressState("rend-3", "ok-agent", "success task");
  finalizeProgressState("rend-3", "done");
  patchProgressState("rend-3", {
    finalOutput: "done\nraw detail SHOULD_NOT_RENDER",
    lastToolPreview: "SHOULD_NOT_RENDER_TOOL",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-3" },
    },
    { expanded: true },
    theme,
  );
  const text = renderText(result);
  expect(text).toContain("done");
  expect(text).not.toContain("SHOULD_NOT_RENDER");
  expect(text).not.toContain("SHOULD_NOT_RENDER_TOOL");
});

test("renderSubagentProgress final success with output uses text fallback when no Markdown", () => {
  createProgressState("rend-4", "ok-agent", "a task", "able-falcon");
  finalizeProgressState("rend-4", "final result text");
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-4" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("final result text");
  expect(text.indexOf("\x1b[23m</accent> <dim>[success]")).toBeLessThan(
    text.indexOf("final result text"),
  );
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolSuccessBg]") && line.endsWith("[/toolSuccessBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress cancelled state shows cancelled", () => {
  createProgressState("rend-5", "some-agent", "a task", "rend-5");
  cancelProgressState("rend-5", "user cancelled");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-5" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("some-agent \x1b[3mrend-5\x1b[23m");
  expect(text).toContain("cancelled");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
    ),
  ).toBe(true);
});

test("renderSubagentProgress terminal states omit patched tool preview", () => {
  createProgressState("rend-10", "ok-agent", "success task");
  finalizeProgressState("rend-10", "final result text");
  patchProgressState("rend-10", { lastToolPreview: "SHOULD_NOT_RENDER" });
  createProgressState("rend-11", "err-agent", "error task");
  failProgressState("rend-11", "child failed");
  patchProgressState("rend-11", { lastToolPreview: "SHOULD_NOT_RENDER" });
  createProgressState("rend-12", "cancel-agent", "cancel task");
  cancelProgressState("rend-12", "user cancelled");
  patchProgressState("rend-12", { lastToolPreview: "SHOULD_NOT_RENDER" });
  const theme = makeTheme();
  for (const requestId of ["rend-10", "rend-11", "rend-12"]) {
    const result = renderSubagentProgress(
      {
        customType: "subagent-progress",
        content: "",
        display: true,
        details: { requestId },
      },
      { expanded: true },
      theme,
    );
    expect(renderText(result)).not.toContain("SHOULD_NOT_RENDER");
  }
});

test("renderSubagentProgress expanded error includes error text", () => {
  createProgressState("rend-6", "err-agent", "error task");
  failProgressState("rend-6", "child failed");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-6" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("error task");
  expect(text).toContain("child failed");
  expect(text).not.toContain("FAILURE:");
});

test("renderSubagentProgress freezes success elapsed after completion", () => {
  setDateNow(1000);
  createProgressState("rend-7", "ok-agent", "a task");
  setDateNow(2500);
  finalizeProgressState("rend-7", "final result text");
  setDateNow(9000);
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-7" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(result)).toContain("1.5s");
  expect(renderText(result)).not.toContain("8.0s");
});

test("renderSubagentProgress freezes error and cancelled elapsed after completion", () => {
  setDateNow(1000);
  createProgressState("rend-8", "err-agent", "error task");
  setDateNow(4000);
  failProgressState("rend-8", "child failed");
  setDateNow(10_000);
  const theme = makeTheme();
  const errorResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-8" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(errorResult)).toContain("3.0s");
  expect(renderText(errorResult)).not.toContain("9.0s");
  setDateNow(2000);
  createProgressState("rend-9", "cancel-agent", "cancel task");
  setDateNow(6500);
  cancelProgressState("rend-9", "user cancelled");
  setDateNow(12_000);
  const cancelResult = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-9" },
    },
    { expanded: false },
    theme,
  );
  expect(renderText(cancelResult)).toContain("4.5s");
  expect(renderText(cancelResult)).not.toContain("10.0s");
});

test("DynamicSubagentProgressText invalidate is a no-op", () => {
  createProgressState("inv-1", "agent", "task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "inv-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  expect(() => result?.invalidate()).not.toThrow();
});

test("renderSubagentProgress keeps running elapsed live", () => {
  setDateNow(1000);
  createProgressState("rend-live", "live-agent", "live task");
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-live" },
    },
    { expanded: false },
    theme,
  );
  setDateNow(2500);
  expect(renderText(result)).toContain("1.5s");
  setDateNow(5200);
  expect(renderText(result)).toContain("4.2s");
});
test("getAllProgressStates returns empty array for empty store", () => {
  resetProgressStore();
  expect(getAllProgressStates()).toEqual([]);
});

test("activeToolActivity reset on fresh direct child tool call", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "nested old" },
    lastToolPreview: "nested old",
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-fresh", preview: "bash: new" }],
    activityText: "bash: new",
    lastToolPreview: "bash: new",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: new",
  });
  expect(state?.lastToolPreview).toBe("bash: new");
  expect([...seen]).toEqual(["tc-fresh"]);
});
test("activeToolActivity builds from parent subagent frame plus nested leaf", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: scan src",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: {
      toolName: "bash",
      inputSummary: "bash: scan src",
    },
  });
  expect(state?.lastToolPreview).toBe("subagent: build - bash: scan src");
});
test("activeToolActivity preserves immutability across updates", () => {
  createProgressState("req-1", "agent-a", "task a");
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = { toolCalls: [], activityText: "first nested" };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  const activity1 = getProgressState("req-1")?.activeToolActivity;
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = { toolCalls: [], activityText: "second nested" };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  const activity2 = getProgressState("req-1")?.activeToolActivity;
  expect(activity1).toEqual({ toolName: "tool", inputSummary: "first nested" });
  expect(activity2).toEqual({
    toolName: "tool",
    inputSummary: "second nested",
  });
  expect(activity1).not.toBe(activity2);
});
test("activeToolActivity preserves parent on nested tool_result_end completion", () => {
  createProgressState("req-1", "agent-a", "task a", "able-falcon");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "able-falcon",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
    lastToolPreview: "subagent: build [able-falcon] - bash: scan src",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "able-falcon",
      child: {
        toolName: "bash",
        inputSummary: "bash: scan src",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "able-falcon",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [able-falcon]");
  expect(state?.toolResultCompleted).toBe(true);
});
test("activeToolActivity clears activity and preview when leaf completes with no parent", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: single" },
    lastToolPreview: "bash: single",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: { toolName: "bash", inputSummary: "bash: single" },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
  expect(state?.toolResultCompleted).toBe(true);
});
test("activeToolActivity tool_result_end does not mutate stored activity tree", () => {
  createProgressState("req-1", "agent-a", "task a");
  const storedActivity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: {
      toolName: "bash",
      inputSummary: "bash: ls",
    },
  };
  patchProgressState("req-1", {
    activeToolActivity: storedActivity,
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: ls",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  // Original stored tree is not mutated
  expect(storedActivity.child).toBeDefined();
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
  });
});
test("nested-only activity batch preserves token accounting", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: scanning",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: scanning",
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 999,
    output: 888,
    contextTokens: 777,
    contextWindowTokens: 666,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("subagent: build - bash: scanning");
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(999);
  expect(state?.outputTokens).toBe(888);
  expect(state?.contextTokens).toBe(777);
  expect(state?.contextWindowTokens).toBe(666);
});
test("nested-only update applies token accounting when usage data is present", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
    inputTokens: 40,
    outputTokens: 20,
    contextTokens: 60,
    contextWindowTokens: 500,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: linting",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: {
        toolName: "bash",
        inputSummary: "bash: linting",
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 300,
    output: 150,
    contextTokens: 450,
    contextWindowTokens: 2000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.lastToolPreview).toBe("subagent: build - bash: linting");
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(300);
  expect(state?.outputTokens).toBe(150);
  expect(state?.contextTokens).toBe(450);
  expect(state?.contextWindowTokens).toBe(2000);
});
test("terminal success clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
  });
  finalizeProgressState("req-1", "done");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("success");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});
test("terminal error clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  failProgressState("req-1", "child failed");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("error");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});
test("terminal cancellation clears activeToolActivity and lastToolPreview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 1,
  });
  cancelProgressState("req-1", "user aborted");
  const state = getProgressState("req-1");
  expect(state?.status).toBe("cancelled");
  expect(state?.activeToolActivity).toBeUndefined();
  expect(state?.lastToolPreview).toBeUndefined();
});
test("patchProgressFromDetails extracts and propagates toolResultCompleted", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.toolResultCompleted).toBe(true);
});
test("activeToolActivity preserved on progress update with no tool calls or activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "existing" },
    lastToolPreview: "existing",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [] };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "existing",
  });
  expect(state?.lastToolPreview).toBe("existing");
});
test("depth-3 activity tree composition through child progress details", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
    child: {
      toolName: "subagent",
      inputSummary: "subagent: review",
      instanceName: "sharp-finch",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
  });
  expect(state?.lastToolPreview).toBe(
    "subagent: build [swift-harbor] - subagent: review [sharp-finch] - bash: make build",
  );
});
test("depth-3 activity tree strips leaf child on tool_result_end", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
    lastToolPreview:
      "subagent: build [swift-harbor] - subagent: review [sharp-finch] - bash: make build",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: review",
        instanceName: "sharp-finch",
        child: {
          toolName: "bash",
          inputSummary: "bash: make build",
        },
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  // toolResultCompleted strips the immediate child (entire subtree)
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state?.toolResultCompleted).toBe(true);
});
test("getAllProgressStates returns all states sorted by startTime desc", () => {
  resetProgressStore();
  createProgressState("sort-a", "agent-a", "task-a");
  createProgressState("sort-b", "agent-b", "task-b");
  createProgressState("sort-c", "agent-c", "task-c");
  const states = getAllProgressStates();
  expect(states).toHaveLength(3);
  const requestIds = states.map((s) => s.requestId);
  // Creation order is a, b, c but startTime may vary slightly.
  // Verify sort is descending: startTime[i] >= startTime[i+1].
  for (let i = 0; i < states.length - 1; i++) {
    const a = states[i];
    const b = states[i + 1];
    if (a && b) {
      expect(a.startTime).toBeGreaterThanOrEqual(b.startTime);
    }
  }
  // All expected request ids are present.
  expect(requestIds).toContain("sort-a");
  expect(requestIds).toContain("sort-b");
  expect(requestIds).toContain("sort-c");
  resetProgressStore();
});
test("back-to-back nested completion preserves accumulated tokens through child strip transition", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    lastToolPreview: "subagent: build [swift-harbor] - bash: make build",
    toolCount: 3,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const d1 = makeDetails([]);
  const r1 = d1.results[0];
  if (!r1) throw new Error("missing result");
  r1.progress = {
    toolCalls: [],
    activityText: "bash: make build",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    toolResultCompleted: true,
  };
  r1.usage = {
    ...r1.usage,
    input: 999,
    output: 888,
    contextTokens: 777,
    contextWindowTokens: 1000,
  };
  const s1 = new Set<string>();
  patchProgressFromDetails("req-1", d1, s1);
  const state1 = getProgressState("req-1");
  expect(state1?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state1?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state1?.inputTokens).toBe(999);
  expect(state1?.outputTokens).toBe(888);
  expect(state1?.contextTokens).toBe(777);
  expect(state1?.contextWindowTokens).toBe(1000);
  const d2 = makeDetails([]);
  const r2 = d2.results[0];
  if (!r2) throw new Error("missing result");
  r2.progress = {
    toolCalls: [{ id: "tc-post-strip", preview: "bash: echo done" }],
    activityText: "bash: echo done",
    lastToolPreview: "bash: echo done",
  };
  r2.usage = {
    ...r2.usage,
    input: 200,
    output: 100,
    contextTokens: 300,
    contextWindowTokens: 1000,
  };
  const s2 = new Set<string>();
  patchProgressFromDetails("req-1", d2, s2);
  const state2 = getProgressState("req-1");
  expect(state2?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: echo done",
  });
  expect(state2?.lastToolPreview).toBe("bash: echo done");
  expect(state2?.inputTokens).toBe(200);
  expect(state2?.outputTokens).toBe(100);
  expect(state2?.contextTokens).toBe(300);
});
test("child repeating same preview updates tokens without changing activity", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
    toolCount: 1,
    inputTokens: 50,
    outputTokens: 25,
    contextTokens: 75,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: "bash: ls",
    lastToolPreview: "bash: ls",
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>(["tc-1"]);
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
});
test("activityText without activeToolActivity builds single-node activity tree", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "Reading file.ts" },
    lastToolPreview: "Reading file.ts",
    toolCount: 1,
    inputTokens: 50,
    outputTokens: 25,
    contextTokens: 75,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Reading file.ts",
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 100,
    output: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "Reading file.ts",
  });
  expect(state?.lastToolPreview).toBe("Reading file.ts");
  expect(state?.toolCount).toBe(1);
  expect(state?.inputTokens).toBe(100);
  expect(state?.outputTokens).toBe(50);
});
test("new activityText replaces existing activity tree and updates preview", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: { toolName: "tool", inputSummary: "Reading file.ts" },
    lastToolPreview: "Reading file.ts",
    toolCount: 1,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "Scanning src directory",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "Scanning src directory",
  });
  expect(state?.lastToolPreview).toBe("Scanning src directory");
  expect(state?.toolCount).toBe(1);
});
test("activityText without tree replaces multi-level activity with single node", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
    lastToolPreview: "subagent: build - bash: ls",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: ls",
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  // activityText builds a single-node tree, replacing the multi-level one
  expect(state?.activeToolActivity).toEqual({
    toolName: "tool",
    inputSummary: "bash: ls",
  });
  expect(state?.lastToolPreview).toBe("bash: ls");
  expect(state?.toolCount).toBe(2);
});
test("nested activity details update parent and append child in activity tree", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
    },
    lastToolPreview: "subagent: build",
    toolCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    contextTokens: 150,
    contextWindowTokens: 1000,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activityText: "bash: scanning src",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: scanning src",
      },
    },
  };
  firstResult.usage = {
    ...firstResult.usage,
    input: 999,
    output: 888,
    contextTokens: 777,
    contextWindowTokens: 1000,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
    child: {
      toolName: "bash",
      inputSummary: "bash: scanning src",
    },
  });
  expect(state?.lastToolPreview).toBe(
    "subagent: build [swift-harbor] - bash: scanning src",
  );
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(999);
  expect(state?.outputTokens).toBe(888);
  expect(state?.contextTokens).toBe(777);
  expect(state?.contextWindowTokens).toBe(1000);
});
test("renderToolActivity returns undefined for undefined activity", () => {
  expect(renderToolActivity(undefined)).toBeUndefined();
});
test("renderToolActivity returns toolName when no inputSummary", () => {
  expect(renderToolActivity({ toolName: "bash" })).toBe("bash");
});
test("renderToolActivity renders depth-1 with inputSummary", () => {
  expect(renderToolActivity({ toolName: "bash", inputSummary: "ls -la" })).toBe(
    "ls -la",
  );
});
test("renderToolActivity annotates instanceName at depth-1", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
    }),
  ).toBe("subagent: build [swift-harbor]");
});
test("renderToolActivity renders depth-2 joining parent and child", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    }),
  ).toBe("subagent: build [swift-harbor] - bash: make build");
});
test("renderToolActivity renders depth-3 joining all levels", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "subagent: plan",
      instanceName: "outer-inst",
      child: {
        toolName: "subagent",
        inputSummary: "subagent: build",
        instanceName: "inner-inst",
        child: {
          toolName: "bash",
          inputSummary: "bash: make test",
        },
      },
    }),
  ).toBe(
    "subagent: plan [outer-inst] - subagent: build [inner-inst] - bash: make test",
  );
});
test("renderToolActivity renders depth-4 traversing full chain", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "level-1",
      child: {
        toolName: "subagent",
        inputSummary: "level-2",
        child: {
          toolName: "subagent",
          inputSummary: "level-3",
          child: {
            toolName: "bash",
            inputSummary: "level-4",
          },
        },
      },
    }),
  ).toBe("level-1 - level-2 - level-3 - level-4");
});
test("renderToolActivity skips nodes without inputSummary", () => {
  expect(
    renderToolActivity({
      toolName: "subagent",
      inputSummary: "parent-summary",
      child: {
        toolName: "wrapper",
        child: {
          toolName: "bash",
          inputSummary: "grandchild-summary",
        },
      },
    }),
  ).toBe("parent-summary - grandchild-summary");
});

test("depth-2 parent activity remains visible after child tool_result_end", () => {
  createProgressState("req-1", "parent-agent", "parent task");
  patchProgressState("req-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    lastToolPreview: "subagent: build [swift-harbor] - bash: make build",
    toolCount: 2,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      instanceName: "swift-harbor",
      child: {
        toolName: "bash",
        inputSummary: "bash: make build",
      },
    },
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  const state = getProgressState("req-1");
  expect(state?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    instanceName: "swift-harbor",
  });
  expect(state?.lastToolPreview).toBe("subagent: build [swift-harbor]");
  expect(state?.toolResultCompleted).toBe(true);
});
test("renderToolActivityForDisplay returns undefined for undefined activity", () => {
  expect(renderToolActivityForDisplay(undefined, 80)).toBeUndefined();
});
test("renderToolActivityForDisplay returns toolName when no inputSummary", () => {
  expect(renderToolActivityForDisplay({ toolName: "bash" }, 80)).toBe("bash");
});
test("renderToolActivityForDisplay renders depth-1 with budget", () => {
  expect(
    renderToolActivityForDisplay(
      { toolName: "bash", inputSummary: "ls -la" },
      80,
    ),
  ).toBe("ls -la");
});
test("renderToolActivityForDisplay truncates joined result once not segments independently", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary:
      "first-segment-that-is-sixty-characters-long-padding-here-now",
    child: {
      toolName: "bash",
      inputSummary:
        "second-segment-that-is-also-sixty-characters-long-padding-here",
    },
  };
  const result = renderToolActivityForDisplay(activity, 80);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(80);
  expect(result).toContain("first-segment");
  expect(result).toContain("second-segment");
  expect(result).toMatch(/…$/);
});
test("renderToolActivityForDisplay preserves full text when within budget", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "short-one",
    child: {
      toolName: "bash",
      inputSummary: "short-two",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe(
    "short-one - short-two",
  );
});
test("renderToolActivityForDisplay redacts sensitive keywords in joined text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "secret-token.yaml",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe("(running...)");
});
test("renderToolActivityForDisplay annotates instanceName before joining", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "parent-task",
    instanceName: "alpha",
    child: {
      toolName: "bash",
      inputSummary: "child-task",
    },
  };
  expect(renderToolActivityForDisplay(activity, 80)).toBe(
    "parent-task [alpha] - child-task",
  );
});
test("renderToolActivityForDisplay applies tight budget correctly", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "this-is-a-very-long-first-segment",
    child: {
      toolName: "bash",
      inputSummary: "this-is-a-very-long-second-segment",
    },
  };
  const result = renderToolActivityForDisplay(activity, 30);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(30);
  expect(result).toMatch(/…$/);
});
test("makeEmitUpdate merge prefers parser inputSummary when richer than bare toolName fallback", () => {
  const result = {
    agent: "test-agent",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "tc-1",
            name: "bash",
            arguments: { command: "docker build ." },
          },
        ],
      },
    ] as unknown as Message[],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    progress: undefined as unknown as StreamingProgress,
  };
  const makeDetails = () =>
    ({
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [],
    }) as SubagentDetails;
  const emit = makeEmitUpdate(
    result as unknown as Parameters<typeof makeEmitUpdate>[0],
    undefined,
    makeDetails,
  );
  emit({
    toolActivity: {
      toolName: "bash",
      inputSummary: "bash: docker build --no-cache .",
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: docker build --no-cache .",
  );
  expect(result.progress?.activeToolActivity?.toolName).toBe("bash");
});
test("makeEmitUpdate merge retains parent inputSummary when parser sends bare toolName fallback", () => {
  const result = {
    agent: "test-agent",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "tc-1",
            name: "bash",
            arguments: { command: "npm test" },
          },
        ],
      },
    ] as unknown as Message[],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    progress: undefined as unknown as StreamingProgress,
  };
  const makeDetails = () =>
    ({
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [],
    }) as SubagentDetails;
  const emit = makeEmitUpdate(
    result as unknown as Parameters<typeof makeEmitUpdate>[0],
    undefined,
    makeDetails,
  );
  emit({
    toolActivity: {
      toolName: "bash",
      inputSummary: "bash",
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: npm test",
  );
  expect(result.progress?.activeToolActivity?.toolName).toBe("bash");
});
test("makeEmitUpdate merge preserves instanceName and child from incoming activity", () => {
  const result = {
    agent: "test-agent",
    agentSource: "user" as const,
    task: "test task",
    exitCode: 0,
    finalOutput: "",
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "tc-1",
            name: "subagent",
            arguments: { agent: "builder" },
          },
        ],
      },
    ] as unknown as Message[],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    progress: undefined as unknown as StreamingProgress,
  };
  const makeDetails = () =>
    ({
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      results: [],
    }) as SubagentDetails;
  const emit = makeEmitUpdate(
    result as unknown as Parameters<typeof makeEmitUpdate>[0],
    undefined,
    makeDetails,
  );
  emit({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "coder",
      instanceName: "sharp-finch",
      child: {
        toolName: "bash",
        inputSummary: "bash: cargo build",
      },
    },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "coder",
    instanceName: "sharp-finch",
    child: {
      toolName: "bash",
      inputSummary: "bash: cargo build",
    },
  });
  expect(result.progress?.activityText).toBe(
    "coder [sharp-finch] - bash: cargo build",
  );
});
test("renderToolActivityForDisplay respects narrow width budget", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary:
      "bash: this-is-a-very-long-command-that-exceeds-narrow-budget",
  };
  const result = renderToolActivityForDisplay(activity, 20);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(20);
  expect(result).toMatch(/…$/);
});
test("renderToolActivityForDisplay returns empty string for zero budget", () => {
  expect(
    renderToolActivityForDisplay(
      { toolName: "bash", inputSummary: "bash: ls" },
      0,
    ),
  ).toBe("");
});
test("renderToolActivityForDisplay returns empty string for negative budget", () => {
  expect(
    renderToolActivityForDisplay(
      { toolName: "bash", inputSummary: "bash: ls" },
      -5,
    ),
  ).toBe("");
});
test("renderToolActivityForDisplay returns empty string for zero budget with sensitive text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading secret-token.yaml",
  };
  expect(renderToolActivityForDisplay(activity, 0)).toBe("");
});
test("renderToolActivityForDisplay redacts sensitive text only when budget fits (running...)", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: { toolName: "bash", inputSummary: "cat secret-token.yaml" },
  };
  expect(renderToolActivityForDisplay(activity, 12)).toBe("(running...)");
  expect(renderToolActivityForDisplay(activity, 11)).toBe("");
});
test("renderToolActivityForDisplay handles very narrow budget gracefully", () => {
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary: "bash: command",
  };
  const result = renderToolActivityForDisplay(activity, 5);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(5);
});
test("renderToolActivityForDisplay truncates nested activity at narrow width", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "subagent: build-task-with-long-description",
    child: {
      toolName: "bash",
      inputSummary: "bash: make-build-with-verbose-output",
    },
  };
  const result = renderToolActivityForDisplay(activity, 40);
  expect(result).toBeDefined();
  expect(result?.length).toBeLessThanOrEqual(40);
  expect(result).toContain("subagent");
  expect(result).toMatch(/…$/);
});
test("running progress renders long single activity as one line at narrow width", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(200)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(200)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 60);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(60);
  expect(toolLines[0]).toContain("…");
});
test("running progress renders nested activity chain as one line at medium width", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build-with-long-task-description",
      child: {
        toolName: "bash",
        inputSummary: "bash: make-build-with-verbose-compiler-output",
      },
    },
    lastToolPreview:
      "subagent: build-with-long-task-description - bash: make-build-with-verbose-compiler-output",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 80);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(80);
  expect(toolLines[0]).toContain("subagent");
});
test("running progress handles very narrow render width without wrapping", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: "bash: ls",
    },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 30);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(30);
});
test("running progress at width 120 keeps long activity within budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(150)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(150)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 120);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(120);
  expect(toolLines[0]).toContain("…");
});
test("stored preview truncation remains unchanged at 120 characters", () => {
  const longCommand = "x".repeat(150);
  const preview = makeToolPreview("bash", { command: longCommand });
  expect(Array.from(preview).length).toBe(120);
  expect(preview).toEndWith("…");
  expect(preview).toBe(`bash: ${"x".repeat(113)}…`);
});
test("emitted progress preview truncation remains at 120 characters", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: `bash: ${"y".repeat(150)}` }],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBeDefined();
  if (result.lastToolPreview) {
    expect(Array.from(result.lastToolPreview).length).toBe(120);
    expect(result.lastToolPreview).toEndWith("…");
  }
});
test("sensitive activity redaction applies to joined display text", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "reading config",
    child: {
      toolName: "bash",
      inputSummary: "bash: cat secret-token.yaml",
    },
  };
  const result = renderToolActivityForDisplay(activity, 80);
  expect(result).toBe("(running...)");
});
test("collapsed running presentation preserves targetless tool formatting", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash" },
    lastToolPreview: "bash",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const toolLine = renderLines(result).find((line) => line.includes("bash"));
  expect(toolLine).toStartWith(
    "[toolPendingBg]   <muted>→</muted> <accent>bash</accent>",
  );
  expect(toolLine).not.toContain("<dim>:");
});
test("expanded running presentation includes task preview on separate line", () => {
  createProgressState("rend-1", "agent", "do the important task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: true },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("do the important task");
  expect(text).toContain("→ bash: ls");
  const lines = renderLines(result);
  const taskLineIndex = lines.findIndex((line) =>
    line.includes("do the important task"),
  );
  const toolLineIndex = lines.findIndex((line) => line.includes("→ bash: ls"));
  expect(taskLineIndex).toBeGreaterThan(-1);
  expect(toolLineIndex).toBeGreaterThan(-1);
  expect(taskLineIndex).not.toBe(toolLineIndex);
});
test("header stats remain unchanged with width-aware preview", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    toolCount: 5,
    contextTokens: 50_000,
    contextWindowTokens: 200_000,
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("5 tools · 25% ctx ·");
});
test("status coloring remains unchanged with width-aware preview", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeMarkerTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const text = renderText(result);
  expect(text).toContain("<accent>⟳</accent>");
  expect(text).toContain("<dim>[running]</dim>");
  expect(
    renderLines(result).every(
      (line) =>
        line.startsWith("[toolPendingBg]") && line.endsWith("[/toolPendingBg]"),
    ),
  ).toBe(true);
});
test("running progress omits activity row when render width leaves no budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "bash", inputSummary: "bash: ls" },
    lastToolPreview: "bash: ls",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines8 = renderLinesAtWidth(result, 8);
  expect(lines8.filter((line) => line.includes("→")).length).toBe(0);
  const lines7 = renderLinesAtWidth(result, 7);
  expect(lines7.filter((line) => line.includes("→")).length).toBe(0);
  const header = renderLinesAtWidth(result, 60).find((line) =>
    line.includes("running"),
  );
  expect(header).toBeDefined();
});
test("running progress truncates long toolName fallback at narrow positive width", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `very-long-tool-name-${"x".repeat(100)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const width = 25;
  const lines = renderLinesAtWidth(result, width);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
  expect(visibleText.length).toBeLessThanOrEqual(width);
  expect(toolLines[0]).toContain("…");
});
test("running progress omits activity row for long toolName fallback at zero budget", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `very-long-tool-name-${"x".repeat(100)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 8);
  expect(lines.filter((line) => line.includes("→")).length).toBe(0);
});
test("running progress omits activity row for long toolName fallback at no-row budget", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `very-long-tool-name-${"x".repeat(100)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 5);
  expect(lines.filter((line) => line.includes("→")).length).toBe(0);
});
test("running progress prevents toolName fallback wrapping at previously-wrapping widths", () => {
  createProgressState("rend-1", "agent", "task");
  const longToolName = `tool-with-very-long-name-${"z".repeat(80)}`;
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: longToolName },
    lastToolPreview: longToolName,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [15, 20, 25, 30, 40]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress single activity stays within render width across sweep", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "bash",
      inputSummary: `bash: ${"x".repeat(200)}`,
    },
    lastToolPreview: `bash: ${"x".repeat(200)}`,
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [10, 20, 40, 60, 80, 120]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress nested activity chain stays within budget at very narrow widths", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build-with-long-description-here",
      child: {
        toolName: "bash",
        inputSummary: "bash: make-build-verbose-compiler-output-here",
      },
    },
    lastToolPreview:
      "subagent: build-with-long-description-here - bash: make-build-verbose-compiler-output-here",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  for (const width of [15, 20, 30]) {
    const lines = renderLinesAtWidth(result, width);
    const toolLines = lines.filter((line) => line.includes("→"));
    expect(toolLines.length).toBeLessThanOrEqual(1);
    if (toolLines.length === 1) {
      const visibleText = stripAnsiAndWrappers(toolLines[0] ?? "");
      expect(visibleText.length).toBeLessThanOrEqual(width);
    }
  }
});
test("running progress redacts sensitive toolName fallback at sufficient budget", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "secret-manager" },
    lastToolPreview: "secret-manager",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 60);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines).toHaveLength(1);
  expect(toolLines[0]).toContain("(running...)");
  expect(toolLines[0]).not.toContain("secret-manager");
});
test("running progress omits sensitive toolName fallback when budget too small for redaction", () => {
  createProgressState("rend-1", "agent", "task");
  patchProgressState("rend-1", {
    activeToolActivity: { toolName: "secret-manager" },
    lastToolPreview: "secret-manager",
  });
  const theme = makeTheme();
  const result = renderSubagentProgress(
    {
      customType: "subagent-progress",
      content: "",
      display: true,
      details: { requestId: "rend-1" },
    },
    { expanded: false },
    theme,
  );
  expect(result).toBeDefined();
  const lines = renderLinesAtWidth(result, 19);
  const toolLines = lines.filter((line) => line.includes("→"));
  expect(toolLines.length).toBe(0);
});
test("renderToolActivity retains existing 120 character truncation for stored previews", () => {
  const longSummary = "x".repeat(200);
  const activity: ToolActivity = {
    toolName: "bash",
    inputSummary: longSummary,
  };
  const result = renderToolActivity(activity);
  expect(result).toBeDefined();
  if (result) {
    expect(Array.from(result).length).toBeLessThanOrEqual(120);
    expect(result).toEndWith("…");
  }
});
test("renderToolActivity depth-2 retains truncation for stored previews", () => {
  const activity: ToolActivity = {
    toolName: "subagent",
    inputSummary: "parent-summary",
    child: {
      toolName: "bash",
      inputSummary: "x".repeat(200),
    },
  };
  const result = renderToolActivity(activity);
  expect(result).toBeDefined();
  if (result) {
    expect(result).toContain("parent-summary");
    expect(result).toContain(" - ");
  }
});

test("isToolCallPart rejects non-objects", () => {
  expect(isToolCallPart(null)).toBe(false);
  expect(isToolCallPart(undefined)).toBe(false);
  expect(isToolCallPart(42)).toBe(false);
  expect(isToolCallPart("string")).toBe(false);
  expect(isToolCallPart(true)).toBe(false);
});

test("isToolCallPart rejects objects missing required fields", () => {
  expect(isToolCallPart({})).toBe(false);
  expect(isToolCallPart({ type: "text" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall", id: "tc-1" })).toBe(false);
  expect(isToolCallPart({ type: "toolCall", id: "tc-1", name: 42 })).toBe(
    false,
  );
  expect(isToolCallPart({ type: "toolCall", id: 42, name: "bash" })).toBe(
    false,
  );
});

test("isToolCallPart accepts valid tool call parts", () => {
  expect(
    isToolCallPart({
      type: "toolCall",
      id: "tc-1",
      name: "bash",
      arguments: { command: "ls" },
    }),
  ).toBe(true);
  expect(isToolCallPart({ type: "toolCall", id: "tc-2", name: "read" })).toBe(
    true,
  );
});

test("extractProgressFromDetails skips non-object entries in derived toolCalls", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [
            null,
            42,
            "string",
            { id: "valid-1", preview: "bash: ls" },
            { id: false, preview: "bad" },
            { id: "bad", preview: 123 },
          ] as unknown as { id: string; preview: string }[],
        },
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["valid-1"]);
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails handles toolResultCompleted and activeToolActivity in progress", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [],
          activityText: "bash: running",
          lastToolPreview: "bash: running",
          toolResultCompleted: true,
          activeToolActivity: {
            toolName: "bash",
            inputSummary: "bash: running",
          },
        },
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("bash: running");
  expect(result.lastToolPreview).toBe("bash: running");
  expect(result.toolResultCompleted).toBe(true);
  expect(result.activeToolActivity).toEqual({
    toolName: "bash",
    inputSummary: "bash: running",
  });
});

test("extractProgressFromDetails skips non-assistant messages and non-array content", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "test",
        agentSource: "user",
        task: "task",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: null },
          { role: "assistant", content: "not-an-array" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "hello" },
              {
                type: "toolCall",
                id: "tc-1",
                name: "bash",
                arguments: { command: "ls" },
              },
            ],
          },
        ] as unknown as Message[],
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails blank activityText with valid tool calls uses tool-call preview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: ls" },
      { id: "tc-2", preview: "read: /tmp/file" },
    ],
    activityText: "   ",
    lastToolPreview: "read: /tmp/file",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBe("read: /tmp/file");
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect(result.progressLastToolPreview).toBe("read: /tmp/file");
});

test("extractProgressFromDetails preview-only progress with tool calls sets progressLastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: echo hello" }],
    lastToolPreview: "bash: echo hello",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBe("bash: echo hello");
  expect(result.lastToolPreview).toBe("bash: echo hello");
  expect(result.activityText).toBeUndefined();
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails empty toolCalls with lastToolPreview sets lastToolPreview via fallback", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    lastToolPreview: "bash: stale preview",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: stale preview");
  expect(result.progressLastToolPreview).toBe("bash: stale preview");
  expect(result.newToolCallIds).toEqual([]);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails non-string activityText with valid tool calls ignores activity", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
    activityText: 42 as unknown as string,
    lastToolPreview: "bash: ls",
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual(["tc-1"]);
});

test("extractProgressFromDetails progress with only toolResultCompleted sets completion flag", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [],
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.toolResultCompleted).toBe(true);
  expect(result.activityText).toBeUndefined();
  expect(result.lastToolPreview).toBeUndefined();
  expect(result.newToolCallIds).toEqual([]);
});

test("extractProgressFromDetails multiple results with mixed progress and messages", () => {
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "agent-a",
        agentSource: "user",
        task: "task a",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        progress: {
          toolCalls: [{ id: "tc-1", preview: "bash: ls" }],
          activityText: "running ls",
          lastToolPreview: "bash: ls",
        },
      },
      {
        agent: "agent-b",
        agentSource: "user",
        task: "task b",
        exitCode: 0,
        finalOutput: "",
        stderr: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-2",
                name: "read",
                arguments: { path: "/tmp/file" },
              },
            ],
          },
        ] as unknown as Message[],
      },
    ],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  // tc-1 from first result progress; tc-2 from second result messages
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect(result.activityText).toBe("running ls");
  // lastToolPreview is set by the last valid tool call processed
  expect(result.lastToolPreview).toBe("read: /tmp/file");
  // progressLastToolPreview is set from the first result's progress.lastToolPreview
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect([...seen]).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails falsy progress on result falls through to messages", () => {
  const details = makeDetails([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-msg",
          name: "bash",
          arguments: { command: "echo hi" },
        },
      ],
    },
  ]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  (firstResult as unknown as { progress: unknown }).progress = false;
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-msg"]);
  expect(result.lastToolPreview).toBe("bash: echo hi");
});

test("extractProgressFromDetails valid progress populates all derived fields", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [
      { id: "tc-1", preview: "bash: build" },
      { id: "tc-2", preview: "read: output.log" },
    ],
    activityText: "Building project",
    activeToolActivity: {
      toolName: "subagent",
      inputSummary: "subagent: build",
      child: { toolName: "bash", inputSummary: "bash: build" },
    },
    lastToolPreview: "read: output.log",
    toolResultCompleted: true,
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBe("Building project");
  expect(result.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: build",
    child: { toolName: "bash", inputSummary: "bash: build" },
  });
  expect(result.lastToolPreview).toBe("read: output.log");
  expect(result.progressLastToolPreview).toBe("read: output.log");
  expect(result.toolResultCompleted).toBe(true);
  expect(result.newToolCallIds).toEqual(["tc-1", "tc-2"]);
  expect([...seen]).toEqual(["tc-1", "tc-2"]);
});

test("extractProgressFromDetails does not set activityText for whitespace-only string", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], activityText: "   " };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.activityText).toBeUndefined();
});

test("extractProgressFromDetails does not set progressLastToolPreview for whitespace-only lastToolPreview", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], lastToolPreview: "   " };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.progressLastToolPreview).toBeUndefined();
  expect(result.lastToolPreview).toBeUndefined();
});

test("patchProgressFromDetails copies latestResult.model to modelDisplay", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "claude-3-5-sonnet";
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBe("claude-3-5-sonnet");
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
  expect(getProgressState("req-1")?.outputTokens).toBe(5);
});

test("patchProgressFromDetails does not set modelDisplay when model is undefined", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = undefined;
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
});

test("patchProgressFromDetails does not set modelDisplay when model is empty string", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "";
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
});

test("patchProgressFromDetails does not throw when details have no results", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [],
  };
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
});

test("patchProgressFromDetails updates modelDisplay alongside existing usage metric patching", () => {
  createProgressState("req-1", "agent-a", "task a");
  patchProgressState("req-1", {
    toolCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: 15,
    contextWindowTokens: 100,
  });
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "gpt-4o";
  firstResult.usage = {
    ...firstResult.usage,
    input: 20,
    output: 10,
    contextTokens: 30,
    contextWindowTokens: 200,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBe("gpt-4o");
  expect(getProgressState("req-1")?.inputTokens).toBe(20);
  expect(getProgressState("req-1")?.outputTokens).toBe(10);
  expect(getProgressState("req-1")?.contextTokens).toBe(30);
  expect(getProgressState("req-1")?.contextWindowTokens).toBe(200);
  expect(getProgressState("req-1")?.toolCount).toBe(1);
});

test("extractProgressFromDetails skips null entries in toolCalls", () => {
  const details = makeDetails([]) as unknown as SubagentDetails;
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = {
    toolCalls: [null, { id: "tc-1", preview: "bash: ls" }] as unknown as {
      id: string;
      preview: string;
    }[],
  };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.newToolCallIds).toEqual(["tc-1"]);
  expect(result.lastToolPreview).toBe("bash: ls");
});

test("extractProgressFromDetails sets lastToolPreview from progress.lastToolPreview when toolCalls has no derivable entries", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.progress = { toolCalls: [], lastToolPreview: "bash: ls" };
  const seen = new Set<string>();
  const result = extractProgressFromDetails(details, seen);
  expect(result.lastToolPreview).toBe("bash: ls");
  expect(result.progressLastToolPreview).toBe("bash: ls");
  expect(result.newToolCallIds).toEqual([]);
});

test("patchProgressFromDetails does not throw when no progress state exists", () => {
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "claude-3-5-sonnet";
  const seen = new Set<string>();
  expect(() => patchProgressFromDetails("req-1", details, seen)).not.toThrow();
  expect(getProgressState("req-1")).toBeUndefined();
});

test("patchProgressFromDetails does not set modelDisplay when model is whitespace-only string", () => {
  createProgressState("req-1", "agent-a", "task a");
  const details = makeDetails([]);
  const firstResult = details.results[0];
  if (!firstResult) throw new Error("missing result");
  firstResult.model = "   ";
  firstResult.usage = {
    ...firstResult.usage,
    input: 10,
    output: 5,
  };
  const seen = new Set<string>();
  patchProgressFromDetails("req-1", details, seen);
  expect(getProgressState("req-1")?.modelDisplay).toBeUndefined();
  expect(getProgressState("req-1")?.inputTokens).toBe(10);
});

test("finalizeProgressState prefers outcome parameter when supplied", () => {
  createProgressState("req-out-1", "agent-x", "task-x");
  finalizeProgressState(
    "req-out-1",
    "raw final output noise",
    "Actual typed outcome!",
  );
  expect(getProgressState("req-out-1")?.finalOutput).toBe(
    "actual typed outcome",
  );
});

test("finalizeProgressState falls back to finalOutput when outcome parameter is absent or blank", () => {
  createProgressState("req-out-2", "agent-x", "task-x");
  finalizeProgressState("req-out-2", "Outcome: Parsed text fallback", "");
  expect(getProgressState("req-out-2")?.finalOutput).toBe(
    "outcome: parsed text fallback",
  );

  createProgressState("req-out-3", "agent-x", "task-x");
  finalizeProgressState(
    "req-out-3",
    "Outcome: Parsed text fallback",
    undefined,
  );
  expect(getProgressState("req-out-3")?.finalOutput).toBe(
    "outcome: parsed text fallback",
  );
});

test("getFeedbackSummaryText prefers outcome from SingleResult inside details", () => {
  const {
    getFeedbackSummaryText,
  } = require("../src/progress/result-details.js");
  const toolResult = {
    content: [{ type: "text", text: "raw text content" }],
    details: {
      mode: "single",
      agentScope: "project",
      projectAgentsDir: null,
      results: [
        {
          agent: "tester",
          agentSource: "project",
          task: "check",
          exitCode: 0,
          finalOutput: "raw final output",
          outcome: "Exhaustive testing verified successfully!",
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        },
      ],
    },
  };
  expect(getFeedbackSummaryText(toolResult)).toBe(
    "exhaustive testing verified successfully",
  );
});

test("getFeedbackSummaryText falls back when outcome is blank or missing", () => {
  const {
    getFeedbackSummaryText,
  } = require("../src/progress/result-details.js");
  const toolResult = {
    content: [{ type: "text", text: "raw text content" }],
    details: {
      mode: "single",
      agentScope: "project",
      projectAgentsDir: null,
      results: [
        {
          agent: "tester",
          agentSource: "project",
          task: "check",
          exitCode: 0,
          finalOutput: "Outcome: Falls back to finalOutput",
          outcome: "  ",
          stderr: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
        },
      ],
    },
  };
  expect(getFeedbackSummaryText(toolResult)).toBe(
    "outcome: falls back to finaloutput",
  );
});
