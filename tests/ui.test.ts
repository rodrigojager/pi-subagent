import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
import {
  formatResultFooter,
  formatTokens,
  formatToolCall,
  formatUsageStats,
  getFinalOutput,
  renderRunsBoard,
  renderSubagentCall,
  renderSubagentResult,
} from "../src/output/ui.js";
import type { SubagentProgressState } from "../src/progress/progress.js";
import { getProgressState } from "../src/progress/progress.js";
import type { SubagentDetails } from "../src/shared/types.js";
import {
  createDefaultFakeTheme,
  getSubagentTool,
  makeBareCtx,
  makeSubagentToolUpdateLine,
  type RegisteredMessageRenderer,
  type SendMessageArg,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

function renderToString(component: unknown, width = 10000): string {
  if (component == null) return "";
  return (component as { render: (w: number) => string[] })
    .render(width)
    .join("\n");
}

test("renderResult output aggregation and truncation", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const fakeContext = {} as unknown as ExtensionContext;
  const messages = [
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "thought 1" },
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -l" },
          id: "2",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "tool result 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file1.txt" },
          id: "3",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file2.txt" },
          id: "4",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 2" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "read",
          arguments: { path: "file3.txt" },
          id: "5",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "file contents 3" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final text line 1\nfinal text line 2\nfinal text line 3\nfinal text line 4",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          finalOutput:
            "final text line 1\nfinal text line 2\nfinal text line 3\nfinal text line 4",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolTitle]*test-agent*[/toolTitle]");
  expect(text).not.toContain("[toolTitle]*test-agent *[/toolTitle]");
  expect(text).not.toContain("\x1b[3m");
  expect(text).toContain("[success]✓[/success]");
  expect(text).not.toContain("[accent]");
  expect(text).toContain("[toolOutput]final text line 1[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 2[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 3[/toolOutput]");
  expect(text).toContain("[toolOutput]final text line 4[/toolOutput]");
});

test("renderResult suppresses direct nested result when message rendered it", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const fakeContext = {} as unknown as ExtensionContext;
  const rendered = tool.renderResult?.(
    {
      content: [{ type: "text" as const, text: "done" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        renderedByMessage: true as const,
        results: [
          {
            agent: "nested-agent",
            agentSource: "user" as const,
            task: "nested",
            exitCode: 0,
            finalOutput: "done",
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
    } as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = renderToString(rendered);
  expect(text).toBe("");
  expect(text).not.toContain("nested-agent");
  expect(text).not.toContain("done");
  expect(text).not.toContain("[success]");
});

test("renderResult expanded output", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const fakeContext = {} as unknown as ExtensionContext;
  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "bash",
          arguments: { command: "ls -la" },
          id: "1",
        },
      ],
    },
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "result" }],
    },
    {
      role: "assistant" as const,
      content: [
        {
          type: "text" as const,
          text: "final output line\nvery long output that would be truncated if it was collapsed",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 1,
          stopReason: "error",
          errorMessage: "some error",
          finalOutput:
            "final output line\nvery long output that would be truncated if it was collapsed",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    fakeContext as never,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolTitle]*test-agent*[/toolTitle]");
  expect(text).toContain("[error]✗[/error]");
  expect(text).not.toContain("[error][error][/error]");
  expect(text).toContain("[toolOutput]final output line[/toolOutput]");
});

test("result details track tool calls from subagent execution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
  const resultDetails = sentMessages.at(-1)?.details as
    | SubagentDetails
    | undefined;
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).toBe("bash: ls");
});

test("result details show tool call name not final output text", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as
    | SubagentDetails
    | undefined;
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).toBe("bash: ls");
  expect(resultDetails?.results[0]?.progress?.lastToolPreview).not.toBe(
    "final",
  );
});

test("non-debug result details expose derived progress without raw child data", async () => {
  const sentMessages: SendMessageArg[] = [];
  const longCommand = "0123456789".repeat(7);
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"old"}]}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"old result"}],"toolCallId":"old"}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"fresh result"}],"toolCallId":"1"}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"2","arguments":{"command":"${longCommand}"}}]}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails | undefined;
  const result = details?.results[0];
  const json = JSON.stringify(result);
  expect(result?.messages).toBeUndefined();
  expect(result?.termination).toBeUndefined();
  expect(result?.stderr).toBe("");
  expect(result?.progress?.activityText).toBe(`bash: ${longCommand}`);
  expect(result?.progress?.lastToolPreview).toBe(`bash: ${longCommand}`);
  expect(result?.progress?.toolCalls).toEqual([
    { id: "2", preview: `bash: ${longCommand}` },
  ]);
  expect(json).not.toContain("command");
});

test("debug result details include child messages in sent result card", async () => {
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"checkpoint"}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"debug-1","arguments":{"path":"safe.txt"}}]}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails | undefined;
  const result = details?.results[0];
  expect(result?.messages?.map((m) => m.role)).toEqual([
    "assistant",
    "assistant",
  ]);
  expect(JSON.stringify(result?.messages)).toContain("safe.txt");
});

test("renderResult with partial details after tool error does not show error icon", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const afterFailedTool: AgentToolResult<SubagentDetails> = {
    content: [{ type: "text" as const, text: "bash: false" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "hang",
          agentSource: "user" as const,
          task: "test",
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
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  name: "bash",
                  id: "1",
                  arguments: { command: "false" },
                },
              ],
            },
            {
              role: "toolResult" as const,
              content: [{ type: "text" as const, text: "failed" }],
              toolCallId: "1",
              isError: true,
            },
          ] as never[],
        },
      ],
    },
  };
  expect(
    renderToString(
      tool.renderResult?.(
        afterFailedTool,
        { expanded: false, isPartial: true },
        fakeTheme as never,
        {} as never,
      ),
    ),
  ).toContain("[error]✗[/error]");
  const afterLaterToolCall: AgentToolResult<SubagentDetails> = {
    content: [{ type: "text" as const, text: "read: later.txt" }],
    details: {
      ...afterFailedTool.details,
      results: [
        {
          ...(afterFailedTool.details.results[0] as NonNullable<
            SubagentDetails["results"][0]
          >),
          messages: [
            ...(afterFailedTool.details.results[0]?.messages ?? []),
            {
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  name: "read",
                  id: "2",
                  arguments: { path: "later.txt" },
                },
              ],
            } as never,
          ],
        },
      ],
    },
  };
  const renderedLaterToolCallText = renderToString(
    tool.renderResult?.(
      afterLaterToolCall,
      { expanded: false, isPartial: true },
      fakeTheme as never,
      {} as never,
    ),
  );
  expect(renderedLaterToolCallText).not.toContain("[accent]read[/accent]");
  expect(renderedLaterToolCallText).not.toContain(
    "Subagent tool result failed.",
  );
});

test("renderResult subagent and unknown tools", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const messages = [
    {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          name: "subagent",
          arguments: { agent: "another-agent" },
          id: "1",
        },
        {
          type: "toolCall" as const,
          name: "unknown",
          arguments: { foo: "bar" },
          id: "2",
        },
        {
          type: "toolCall" as const,
          name: "unknown_long",
          arguments: { foo: "bar".repeat(50) },
          id: "3",
        },
      ],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: false, isPartial: false },
    fakeTheme as never,
    {} as never,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).not.toContain("[accent]subagent[/accent]");
  expect(renderedText).not.toContain("[accent]unknown[/accent]");
  expect(renderedText).not.toContain("[accent]unknown_long[/accent]");
});

test("renderResult expanded output truncation for > 2000 chars", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const messages = [
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A".repeat(2005) }],
    },
  ];
  const result = {
    content: [{ type: "text" as const, text: "output" }],
    details: {
      mode: "single" as const,
      agentScope: "user" as const,
      projectAgentsDir: null,
      results: [
        {
          agent: "test-agent",
          agentSource: "user" as const,
          task: "some task",
          exitCode: 0,
          stopReason: "stop",
          finalOutput: "A".repeat(2005),
          messages: messages,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: 0,
            cacheRead: 0,
            cacheWrite: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const rendered = tool.renderResult?.(
    result as unknown as AgentToolResult<SubagentDetails>,
    { expanded: true, isPartial: false },
    fakeTheme as never,
    {} as never,
  );
  const text = renderToString(rendered);
  expect(text).toBeDefined();
  expect(text).toContain("[toolOutput]AAAA");
});

test("renderCall formats tool execution correctly", () => {
  const tool = getSubagentTool();
  const fakeTheme = createDefaultFakeTheme();
  const rendered = tool.renderCall?.(
    {
      agent: "test-agent",
      task: "long task description that should exceed 60 characters so it gets truncated and ends up shorter",
    },
    fakeTheme as never,
    {} as never,
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[toolTitle]*subagent *[/toolTitle][accent]test-agent[/accent][muted] [both][/muted]",
  );
  // Parser-owned preview suppresses task text: only shows [scope] when agent present
  expect((rendered as unknown as { text: string }).text).not.toContain(
    "long task description that should exceed 60 characters",
  );
  expect((rendered as unknown as { text: string }).text).toContain(
    "[dim][both][/dim]",
  );
  const renderedShort = tool.renderCall?.(
    { agent: "...", task: "short" },
    fakeTheme as never,
    {} as never,
  );
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[accent]...[/accent]",
  );
  // Task text suppressed: shows [scope] not task
  expect((renderedShort as unknown as { text: string }).text).toContain(
    "[dim][both][/dim]",
  );
});

test("renderSubagentResult formats units, fallback output, and failed tool results", () => {
  const fakeTheme = createDefaultFakeTheme();
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1500)).toBe("1.5k");
  expect(formatTokens(15_000)).toBe("15k");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(
    formatResultFooter(
      {
        turns: 3,
        input: 12_000,
        output: 1100,
        cacheRead: 999,
        cacheWrite: 1500,
        cost: 0.012,
        contextTokens: 38_000,
      },
      "provider/model:high",
    ),
  ).toBe("provider/model:high · 3 turns · ctx:38k · $0.0120");
  expect(
    formatResultFooter(
      {
        turns: 0,
        input: 12_000,
        output: 1100,
        cacheRead: 999,
        cacheWrite: 1500,
        cost: 0,
        contextTokens: 0,
      },
      undefined,
    ),
  ).toBe("");
  expect(
    formatUsageStats(
      {
        turns: 2,
        input: 1500,
        output: 15_000,
        cacheRead: 999,
        cacheWrite: 1_500_000,
        cost: 0.12345,
        contextTokens: 42,
      },
      "provider/model:high",
    ),
  ).toBe(
    "2 turns · ↑1.5k ↓15k · cache:R999/W1.5M · ctx:42 · $0.1235 · provider/model:high",
  );
  // Subagent now extracts agent via semantic key lookup
  expect(formatToolCall("subagent", { agent: "child" }, fakeTheme.fg)).toBe(
    "[accent]subagent[/accent][dim] child[/dim]",
  );
  expect(
    formatToolCall(
      "unknown",
      { token: "secret", password: "hidden", nested: { value: "leak" } },
      fakeTheme.fg,
    ),
  ).toBe("[accent]unknown[/accent]");
  expect(
    formatToolCall("unknown", { token: "secret" }, fakeTheme.fg, true),
  ).toBe('[accent]unknown[/accent][dim] {"token":"secret"}[/dim]');
  expect(
    formatToolCall("unknown", { project: "my-project" }, fakeTheme.fg),
  ).toBe("[accent]unknown[/accent][dim] my-project[/dim]");
  expect(
    formatToolCall("unknown", { token: "x", password: "y" }, fakeTheme.fg),
  ).toBe("[accent]unknown[/accent]");
  expect(formatToolCall("bash", { command: "bun test" }, fakeTheme.fg)).toBe(
    "[accent]bash[/accent][dim] bun test[/dim]",
  );
  expect(
    formatToolCall("bash", { command: "printf 'a'\n\t  echo b" }, fakeTheme.fg),
  ).toBe("[accent]bash[/accent][dim] printf 'a' echo b[/dim]");
  expect(formatToolCall("bash", { command: "\n\t  " }, fakeTheme.fg)).toBe(
    "[accent]bash[/accent]",
  );
  // subagent ignores task, uses agent only
  expect(
    formatToolCall(
      "subagent",
      { agent: "child", task: "line one\n\t  line two" },
      fakeTheme.fg,
    ),
  ).toBe("[accent]subagent[/accent][dim] child[/dim]");
  const call = renderSubagentCall({}, fakeTheme) as unknown as {
    text: string;
    render: (width: number) => string[];
  };
  const callText = call.text;
  expect(callText).toContain(
    "[accent]...[/accent][muted] [both][/muted]\n  [dim]{}[/dim]",
  );
  expect(
    call
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolPendingBg]") &&
          line.endsWith("[/toolPendingBg]"),
      ),
  ).toBe(true);
  expect(
    (
      renderSubagentResult({ content: [] }, fakeTheme) as unknown as {
        text: string;
      }
    ).text,
  ).toBe("(no output)");
  const success = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool-success",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
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
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const failed = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool-failure",
            agentSource: "project",
            task: "fail",
            exitCode: 0,
            messages: [{ role: "toolResult", content: [], isError: true }],
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
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  expect(
    success
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
  expect(
    failed
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
  const failedText = renderToString(failed);
  expect(failedText).toContain("[error]✗[/error]");
  expect(failedText).toContain("[muted](no output)[/muted]");
});

test("subagent result keeps subagent call chrome unchanged", () => {
  const fakeTheme = createDefaultFakeTheme();
  const call = renderSubagentCall({}, fakeTheme) as unknown as {
    text: string;
    render: (width: number) => string[];
  };
  // Parser-owned preview: no agent → falls back to JSON.stringify(args)
  expect(call.text).toContain(
    "[accent]...[/accent][muted] [both][/muted]\n  [dim]{}[/dim]",
  );
  expect(
    call
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolPendingBg]") &&
          line.endsWith("[/toolPendingBg]"),
      ),
  ).toBe(true);
});
test("subagent result markdown invokes theme callbacks", () => {
  const fakeTheme = createDefaultFakeTheme();
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const markdown = `# Heading\n\n[docs](https://example.com) and \`inline\`\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\n> quoted **bold** and *italic* and ~~gone~~\n\n---\n\n- item`;
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            instanceName: "able-falcon",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: markdown,
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  resetCapabilitiesCache();
  expect(renderedText).toContain(
    "[toolTitle]*builder*[/toolTitle] [accent]\x1b[3mable-falcon\x1b[23m[/accent]",
  );
  expect(renderedText.indexOf("\x1b[23m[/accent]")).toBeLessThan(
    renderedText.indexOf("[mdHeading]"),
  );
  expect(renderedText).toContain("[mdHeading]");
  expect(renderedText).toContain("[mdLink]");
  expect(renderedText).toContain(
    "[mdLinkUrl] (https://example.com)[/mdLinkUrl]",
  );
  expect(renderedText).toContain("[mdCode]inline[/mdCode]");
  expect(renderedText).toContain(
    "[mdCodeBlockBorder]```ts[/mdCodeBlockBorder]",
  );
  expect(renderedText).toContain("[mdCodeBlock]const x = 1[/mdCodeBlock]");
  expect(renderedText).toContain("[mdQuoteBorder]│ [/mdQuoteBorder]");
  expect(renderedText).toContain("[mdQuote]");
  expect(renderedText).toContain("[mdHr]");
  expect(renderedText).toContain("[mdListBullet]- [/mdListBullet]");
  expect(renderedText).toContain("\x1b[3mitalic\x1b[23m");
  expect(renderedText).toContain("\x1b[9mgone\x1b[29m");
  expect(renderedText).toContain("\x1b[4m");
});

test("subagent-result message renderer uses summarized content and preserves result chrome", () => {
  const tool = getSubagentTool();
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  const fakeTheme = createDefaultFakeTheme();
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "runner",
        agentSource: "project",
        task: "pass",
        exitCode: 0,
        finalOutput: "raw child output must stay hidden from run card",
        messages: [],
        stderr: "",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 0,
          turns: 1,
        },
      },
    ],
  };
  if (!renderer) throw new Error("subagent-result renderer missing");
  const rendered = renderer(
    {
      role: "custom",
      customType: "subagent-result",
      content: "summarized semantic outcome",
      display: true,
      timestamp: 0,
      details,
    },
    { expanded: false, outputPad: 2 },
    fakeTheme as never,
  ) as unknown as { render: (width: number) => string[] };
  const lines = rendered.render(120);
  const text = lines.join("\n");
  expect(text).toContain("[toolOutput]summarized semantic outcome");
  expect(text).toContain("[/toolOutput]");
  expect(text).not.toContain("raw child output must stay hidden from run card");
  expect(text).toContain("[dim]1 turn · $0.0100[/dim]");
  expect(
    lines.every(
      (line) =>
        line.startsWith("[toolSuccessBg]") && line.endsWith("[/toolSuccessBg]"),
    ),
  ).toBe(true);
  expect(details.results[0]?.finalOutput).toBe(
    "raw child output must stay hidden from run card",
  );
});

test("normal subagent tool rendering continues to use raw final output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "formatted parent content" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "tool",
            instanceName: "clear-marten",
            agentSource: "user",
            task: "pass",
            exitCode: 0,
            finalOutput: "raw final output remains body",
            messages: [],
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
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const text = renderToString(rendered);
  expect(text).toContain(
    "[toolTitle]*tool*[/toolTitle] [accent]\x1b[3mclear-marten\x1b[23m[/accent]",
  );
  expect(text).not.toContain("[toolTitle]*tool clear-marten*[/toolTitle]");
  expect(text).toContain(
    "[toolOutput]raw final output remains body[/toolOutput]",
  );
  expect(text).not.toContain("formatted parent content");
});

test("subagent result backgrounds cover representative success and failure cards", () => {
  const fakeTheme = createDefaultFakeTheme();
  const success = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput:
              "Outcome: shipped\nChanged: src/ui.ts\nVerification: bun test\nNext: none",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    name: "bash",
                    id: "tc-1",
                    arguments: { command: "bun test" },
                  },
                ],
              },
            ],
            stderr: "",
            usage: {
              input: 1000,
              output: 2000,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const failure = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "breaker",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput: "first failure line\nsecond failure line",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    name: "read",
                    id: "tc-2",
                    arguments: { path: "src/ui.ts" },
                  },
                ],
              },
            ],
            stderr: "",
            usage: {
              input: 3000,
              output: 4000,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.02,
              contextTokens: 0,
              turns: 2,
            },
          },
        ],
      },
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const successText = renderToString(success);
  expect(successText).toContain("[success]✓[/success]");
  expect(successText).not.toContain("[accent]bash[/accent]");
  expect(successText).toContain("Outcome: shipped");
  expect(successText).toContain("1 turn · $0.0100");
  expect(successText).not.toContain("↑1.0k");
  expect(successText).not.toContain("↓2.0k");
  expect(
    success
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
  const failureText = renderToString(failure);
  expect(failureText).toContain("[error]✗[/error]");
  expect(failureText).not.toContain("[accent]read[/accent]");
  expect(failureText).toContain("[toolOutput]first failure line[/toolOutput]");
  expect(failureText).toContain("2 turns · $0.0200");
  expect(failureText).not.toContain("↑3.0k");
  expect(failureText).not.toContain("↓4.0k");
  expect(
    failure
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders cancelled result with appropriate icon and error background", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "runner",
            agentSource: "user",
            task: "abort",
            exitCode: 0,
            stopReason: "aborted",
            finalOutput: "was doing work",
            messages: [],
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
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[error]⊘[/error]");
  expect(renderedText).not.toContain("[success]✓[/success]");
  expect(renderedText).toContain("[toolTitle]*runner*[/toolTitle]");
  expect(renderedText).toContain("[toolOutput]was doing work[/toolOutput]");
  expect(
    rendered
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolErrorBg]") && line.endsWith("[/toolErrorBg]"),
      ),
  ).toBe(true);
});

test("subagent result renders outcome-only output instead of no output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: "Outcome: shipped",
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]Outcome: shipped[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("subagent result renders compact structured success output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput:
              "Outcome: shipped\nChanged: src/ui.ts\nVerification: bun test\nNext: none",
            messages: [],
            stderr: "",
            model: "provider/model:high",
            durationMs: 1234,
            usage: {
              input: 12_000,
              output: 1_100,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.012,
              contextTokens: 38_000,
              turns: 3,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[success]✓[/success]");
  expect(renderedText).toContain("[toolTitle]*builder*[/toolTitle]");
  expect(renderedText).not.toContain("[muted]1.2s[/muted]");
  expect(renderedText).toContain("Outcome: shipped");
  expect(renderedText).toContain("[toolOutput]Changed: src/ui.ts[/toolOutput]");
  expect(renderedText).toContain(
    "provider/model:high · 3 turns · ctx:38k · $0.0120",
  );
  expect(renderedText).not.toContain("↑12k");
  expect(renderedText).not.toContain("↓1.1k");
});

test("subagent result suppresses success no-op fields and keeps fallback", () => {
  const fakeTheme = createDefaultFakeTheme();
  const render = (finalOutput: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "project",
              task: "pass",
              exitCode: 0,
              finalOutput,
              messages: [],
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
      },
      fakeTheme,
    ) as unknown as { text: string };
  const partialText = renderToString(
    render(
      "Outcome: shipped\nChanged: none\nVerification: bun test\nNext: n/a",
    ),
  );
  expect(partialText).toContain("Outcome: shipped");
  expect(partialText).toContain("[toolOutput]Changed: none[/toolOutput]");
  expect(partialText).toContain(
    "[toolOutput]Verification: bun test[/toolOutput]",
  );
  expect(partialText).not.toContain("[muted]Outcome:[/muted]");
  const fallbackText = renderToString(
    render(
      "Outcome: none\nChanged: no changes\nVerification: not applicable\nNext: unchanged",
    ),
  );
  expect(fallbackText).toContain("Outcome: none");
  expect(fallbackText).toContain(
    "[toolOutput]Changed: no changes[/toolOutput]",
  );
});

test("subagent result parses labels and normalizes display without mutating raw output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const longNext = "x".repeat(200);
  const rawOutput = `- outcome: **shipped across\nmultiple lines**\n**Changed:** \`src/ui.ts\`\n### Verification\n\`bun test\`\nNext: \`${longNext}\``;
  const result = {
    content: [{ type: "text", text: "raw `content`" }],
    details: {
      mode: "single",
      agentScope: "both",
      projectAgentsDir: null,
      results: [
        {
          agent: "builder",
          agentSource: "project",
          task: "pass",
          exitCode: 0,
          finalOutput: rawOutput,
          messages: [],
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
  const rendered = renderSubagentResult(
    result as AgentToolResult<SubagentDetails>,
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("outcome");
  expect(renderedText).toContain("shipped");
  expect(renderedText).toContain("src/ui.ts");
  expect(renderedText).not.toContain("[muted]Outcome:[/muted]");
  expect(result.content[0]?.text).toBe("raw `content`");
  expect(result.details.results[0]?.finalOutput).toBe(rawOutput);
});

test("subagent result compacts only clear changed path lists", () => {
  const fakeTheme = createDefaultFakeTheme();
  const renderChanged = (changed: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "project",
              task: "pass",
              exitCode: 0,
              finalOutput: `Outcome: shipped\nChanged: ${changed}\nVerification: bun test\nNext: none`,
              messages: [],
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
      },
      fakeTheme,
    ) as unknown as { text: string };
  const compactedText = renderToString(
    renderChanged(
      "`src/ui.ts, test/index.test.ts, src/process.ts, README.md, package.json`",
    ),
  );
  expect(compactedText).toContain("Changed:");
  expect(compactedText).toContain("src/ui.ts");
  expect(compactedText).not.toContain("[muted]Changed:[/muted]");
  expect(
    renderToString(
      renderChanged("updated src/ui.ts, test/index.test.ts, and docs"),
    ),
  ).toContain("Changed: updated src/ui.ts");
  expect(
    renderToString(renderChanged("alpha, beta, gamma, delta, epsilon")),
  ).toContain("Changed: alpha, beta, gamma, delta, epsilon");
});

test("subagent result renders compact structured failure output", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: compile failed\nVerification: tsc error\nNext: fix types",
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[error]✗[/error]");
  expect(renderedText).toContain(
    "[toolOutput]Cause: compile failed[/toolOutput]",
  );
  expect(renderedText).toContain(
    "[toolOutput]Verification: tsc error[/toolOutput]",
  );
  expect(renderedText).toContain("[toolOutput]Next: fix types[/toolOutput]");
  expect(renderedText).not.toContain("[muted]Cause:[/muted]");
});

test("subagent result derives failure cause only when output lacks parsed cause", () => {
  const fakeTheme = createDefaultFakeTheme();
  const render = (finalOutput: string) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "ignored" }],
        details: {
          mode: "single",
          agentScope: "both",
          projectAgentsDir: null,
          results: [
            {
              agent: "builder",
              agentSource: "user",
              task: "fail",
              exitCode: 1,
              errorMessage: "derived process error",
              finalOutput,
              messages: [],
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
      },
      fakeTheme,
    ) as unknown as { text: string };
  const withHeadingCauseText = renderToString(
    render(
      "Outcome: failed at build\n### Cause\nactual compiler error\nVerification: tsc failed\nNext: fix types",
    ),
  );
  expect(withHeadingCauseText).toContain("[error]✗[/error]");
  expect(withHeadingCauseText).toContain("Outcome: failed at build");
  const withoutCauseText = renderToString(
    render(
      "Outcome: failed at build\nVerification: tsc failed\nNext: fix types",
    ),
  );
  expect(withoutCauseText).toContain("[error]✗[/error]");
  expect(withoutCauseText).toContain("Outcome: failed at build");
});

test("subagent result suppresses failure no-op fields and keeps fallback", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "user",
            task: "fail",
            exitCode: 1,
            finalOutput:
              "Cause: none\nVerification: not applicable\nNext: unchanged",
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]Cause: none[/toolOutput]");
  expect(renderedText).toContain(
    "[toolOutput]Verification: not applicable[/toolOutput]",
  );
  expect(renderedText).toContain("[toolOutput]Next: unchanged[/toolOutput]");
  expect(renderedText).not.toContain("[muted]Cause:[/muted]");
});

test("subagent result preserves raw output lines in UI", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "plain",
            agentSource: "user",
            task: "plain",
            exitCode: 0,
            finalOutput:
              "hello\nsorry about that\nerror: details\nfirst\n\nsecond\nthird",
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]hello[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]sorry about that[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]error: details[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]first[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]second[/toolOutput]");
  expect(renderedText).toContain("[toolOutput]third[/toolOutput]");
});

test("subagent-result renderer uses compact content instead of full final output", () => {
  const { registeredMessageRenderers } = getSubagentTool();
  const renderer = registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme = createDefaultFakeTheme();
  const details: SubagentDetails = {
    mode: "single",
    agentScope: "both",
    projectAgentsDir: null,
    results: [
      {
        agent: "plain",
        agentSource: "user",
        task: "plain",
        exitCode: 0,
        finalOutput: "# Full result\n\nParagraph one.\n\nParagraph two.",
        messages: [],
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
  };
  const originalDetails = structuredClone(details);
  const rendered = renderer(
    {
      role: "assistant",
      customType: "subagent-result",
      content: [{ type: "text", text: "Compact parent summary." }],
      details,
    } as unknown as Parameters<RegisteredMessageRenderer>[0],
    {} as Parameters<RegisteredMessageRenderer>[1],
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  );
  const renderedText = renderToString(rendered, 40);
  expect(renderedText).toContain("Compact parent");
  expect(renderedText).toContain("summary.");
  expect(renderedText).not.toContain("Full result");
  expect(renderedText).not.toContain("Paragraph one.");
  expect(renderedText).not.toContain("Paragraph two.");
  expect(details).toEqual(originalDetails);
});

test("/run final result message renderer hides header and keeps success background", async () => {
  const { cwd } = await setupFakePi();
  const sentMessages: SendMessageArg[] = [];
  const { registeredCommands, registeredMessageRenderers } = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const renderer = registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    {} as Parameters<RegisteredMessageRenderer>[1],
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(renderedText).not.toContain("[success]✓[/success]");
  expect(renderedText).not.toContain("[toolTitle]*hang*[/toolTitle]");
  expect(
    rendered
      .render(120)
      .every(
        (line) =>
          line.startsWith("[toolSuccessBg]") &&
          line.endsWith("[/toolSuccessBg]"),
      ),
  ).toBe(true);
});

test("formatResultFooter excludes duration from output", () => {
  const footer = formatResultFooter(
    {
      turns: 5,
      input: 10000,
      output: 2000,
      cacheRead: 500,
      cacheWrite: 1000,
      cost: 0.05,
      contextTokens: 50000,
      contextWindowTokens: 200000,
    },
    "test-model",
  );
  expect(footer).toBe("test-model · 5 turns · ctx:50k · $0.0500");
  expect(footer).not.toMatch(/\d+(\.\d+)?(ms|s|m \d+s)/);
});

describe("unconfirmed thinking UI footer propagation", () => {
  function renderResultModel(result: { model?: string; finalOutput?: string }) {
    const fakeTheme = createDefaultFakeTheme();
    const rendered = renderSubagentResult(
      {
        content: [{ type: "text" as const, text: "ignored" }],
        details: {
          mode: "single" as const,
          agentScope: "both" as const,
          projectAgentsDir: null,
          results: [
            {
              agent: "test-agent",
              agentSource: "user" as const,
              task: "test task",
              exitCode: 0,
              finalOutput: result.finalOutput ?? "done",
              stderr: "",
              model: result.model,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
              messages: [],
            },
          ],
        },
      },
      fakeTheme,
    ) as unknown as { render: (width: number) => string[] };
    return rendered.render(120).join("\n");
  }

  test("renderSubagentResult footer includes requested unconfirmed level", () => {
    const text = renderResultModel({
      model: "unknown ･ unknown ･ high",
    });
    expect(text).toContain("[dim]unknown ･ unknown ･ high · 1 turn[/dim]");
  });

  test("renderSubagentResult footer omits model when absent", () => {
    const text = renderResultModel({});
    expect(text).toContain("[dim]1 turn[/dim]");
    expect(text).not.toContain("unknown");
  });

  test("renderSubagentResult footer shows confirmed requested level", () => {
    const text = renderResultModel({
      model: "custom ･ reasoner ･ medium",
    });
    expect(text).toContain("[dim]custom ･ reasoner ･ medium · 1 turn[/dim]");
  });
});

test("renderSubagentResult includes metadata in header with tools, context, and elapsed time", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            finalOutput: "done",
            stderr: "",
            usage: {
              input: 10000,
              output: 2000,
              cacheRead: 500,
              cacheWrite: 1000,
              cost: 0.05,
              contextTokens: 150000,
              contextWindowTokens: 200000,
              turns: 5,
            },
            model: "test-model",
            durationMs: 45200,
            progress: {
              toolCalls: [
                { name: "read", id: "1", args: {} },
                { name: "write", id: "2", args: {} },
                { name: "bash", id: "3", args: {} },
              ],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toMatch(/\d+ tools? · \d+% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
  expect(text).toContain("3 tools");
  expect(text).toContain("75% ctx");
  expect(text).toContain("45.2s");
});

test("renderSubagentResult metadata handles undefined toolCalls", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            finalOutput: "done",
            stderr: "",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              contextWindowTokens: 200000,
              turns: 1,
            },
            durationMs: 1500,
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("0 tools");
  expect(text).toMatch(/0 tools · \d+% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
});

test("renderSubagentResult metadata handles undefined contextWindowTokens", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            finalOutput: "done",
            stderr: "",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              turns: 1,
            },
            durationMs: 2000,
            progress: {
              toolCalls: [{ name: "read", id: "1", args: {} }],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("--% ctx");
  expect(text).toMatch(/\d+ tools? · --% ctx · \d+(\.\d+)?(ms|s|m \d+s)/);
});

test("renderSubagentResult metadata handles undefined durationMs", () => {
  const fakeTheme = createDefaultFakeTheme();
  const result = renderSubagentResult(
    {
      content: [{ type: "text", text: "test" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "project",
            task: "test task",
            exitCode: 0,
            finalOutput: "done",
            stderr: "",
            usage: {
              input: 1000,
              output: 500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 5000,
              contextWindowTokens: 200000,
              turns: 1,
            },
            progress: {
              toolCalls: [{ name: "read", id: "1", args: {} }],
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(result);
  expect(text).toContain("0.0s");
  expect(text).toMatch(/\d+ tools? · \d+% ctx · 0\.0s/);
});

test("renderRunsBoard renders empty board", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("No /run jobs in this session.");
  expect(text).toContain("[muted]");
});

test("renderRunsBoard renders status sections in fixed order", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      instanceName: "able-falcon",
      taskPreview: "build stuff",
      status: "success",
      startTime: now - 300000,
      durationMs: 280000,
      toolCount: 5,
      contextTokens: 20000,
      contextWindowTokens: 50000,
      finalOutput: "Built all the things successfully",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review code",
      status: "running",
      startTime: now - 60000,
      toolCount: 2,
      contextTokens: 8000,
      contextWindowTokens: 50000,
      lastToolPreview: "read: src/ui.ts",
    },
    {
      requestId: "r3",
      agent: "test-runner",
      taskPreview: "run tests",
      status: "error",
      startTime: now - 200000,
      durationMs: 150000,
      toolCount: 3,
      contextTokens: 12000,
      contextWindowTokens: 50000,
      errorText: "bun test failed with exit code 1",
    },
    {
      requestId: "r4",
      agent: "scanner",
      taskPreview: "scan files",
      status: "cancelled",
      startTime: now - 100000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: "scanning...",
      errorText: "Cancelled by user",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never, 32);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  expect(lines).toBeArray();
  expect(text).toContain("[dim]ACTIVE (1) ─────────────────────[/dim]");
  expect(text).toContain("[dim]FAILED (1) ─────────────────────[/dim]");
  expect(text).toContain("[dim]CANCELLED (1) ──────────────────[/dim]");
  expect(text).toContain("[dim]SUCCEEDED (1) ──────────────────[/dim]");
  expect(text).not.toContain("ACTIVE (0)");
  expect(text).not.toContain("COMPLETED");
  expect(text.indexOf("ACTIVE (1)")).toBeLessThan(text.indexOf("FAILED (1)"));
  expect(text.indexOf("FAILED (1)")).toBeLessThan(
    text.indexOf("CANCELLED (1)"),
  );
  expect(text.indexOf("CANCELLED (1)")).toBeLessThan(
    text.indexOf("SUCCEEDED (1)"),
  );
  const headerLines = lines.filter(
    (l) =>
      l.includes("[running]") ||
      l.includes("[success]") ||
      l.includes("[error]") ||
      l.includes("[cancelled]"),
  );
  expect(headerLines).toHaveLength(4);
  expect(headerLines[0]).toStartWith("[toolPendingBg]");
  expect(headerLines[1]).toStartWith("[toolErrorBg]");
  expect(headerLines[2]).toStartWith("[toolErrorBg]");
  expect(headerLines[3]).toStartWith("[toolSuccessBg]");
  expect(
    headerLines.every((line) =>
      /\[\/tool(?:Pending|Error|Success)Bg\]$/.test(line),
    ),
  ).toBe(true);
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(24);
  expect(
    cardLines.every((line) =>
      /^\[tool(?:Pending|Error|Success)Bg\].*\[\/tool(?:Pending|Error|Success)Bg\]$/.test(
        line,
      ),
    ),
  ).toBe(true);
  expect(headerLines[0]).toContain(
    "[accent]⟳[/accent] [toolTitle]*reviewer*[/toolTitle] [dim][running][/dim]",
  );
  expect(headerLines[1]).toContain(
    "[error]✗[/error] [toolTitle]*test-runner*[/toolTitle] [dim][error][/dim]",
  );
  expect(headerLines[2]).toContain(
    "[error]⊘[/error] [toolTitle]*scanner*[/toolTitle] [dim][cancelled][/dim]",
  );
  expect(headerLines[3]).toContain(
    "[success]✓[/success] [toolTitle]*builder*[/toolTitle] [accent]\x1b[3mable-falcon\x1b[23m[/accent] [dim][success][/dim]",
  );
  expect(text).toContain(
    "[toolSuccessBg]   [toolOutput]Built all the things successfully[/toolOutput]",
  );
  expect(text).toContain(
    "[toolErrorBg]   [toolOutput]bun test failed with exit code 1[/toolOutput]",
  );
  expect(text).toContain(
    "[toolErrorBg]   [toolOutput]scanning...[/toolOutput]",
  );
});

test("renderRunsBoard omits empty status sections", () => {
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: Date.now() - 10000,
    toolCount: 1,
    finalOutput: "working",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("ACTIVE (1)");
  expect(text).not.toContain("FAILED (0)");
  expect(text).not.toContain("CANCELLED (0)");
  expect(text).not.toContain("SUCCEEDED (0)");
  expect(text).not.toContain("COMPLETED");
});

test("renderRunsBoard truncates body preview after 120 chars", () => {
  const exactOutput = "A".repeat(120);
  const longOutput = "B".repeat(121);
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "do work",
      status: "success",
      startTime: Date.now() - 10000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: exactOutput,
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review work",
      status: "success",
      startTime: Date.now() - 9000,
      durationMs: 4000,
      toolCount: 1,
      finalOutput: longOutput,
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain(exactOutput);
  expect(text).toContain(`${longOutput.slice(0, 119)}…`);
  expect(text).not.toContain(longOutput);
});

test("renderRunsBoard uses body source priority and fallback", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "task preview",
      status: "error",
      startTime: now - 10000,
      durationMs: 5000,
      toolCount: 1,
      finalOutput: "final output",
      errorText: "error text",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "fallback preview",
      status: "error",
      startTime: now - 9000,
      durationMs: 4000,
      toolCount: 1,
      finalOutput: " ",
      errorText: "error only",
    },
    {
      requestId: "r3",
      agent: "planner",
      taskPreview: "preview only",
      status: "running",
      startTime: now - 8000,
      toolCount: 1,
      finalOutput: "",
      errorText: "",
    },
    {
      requestId: "r4",
      agent: "empty",
      taskPreview: "",
      status: "success",
      startTime: now - 7000,
      durationMs: 3000,
      toolCount: 1,
      finalOutput: "",
      errorText: " ",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]final output[/toolOutput]");
  expect(text).not.toContain("[toolOutput]error text[/toolOutput]");
  expect(text).toContain("[toolOutput]error only[/toolOutput]");
  expect(text).toContain("[toolOutput]Task: preview only[/toolOutput]");
  expect(text).toContain("[muted](no output)[/muted]");
});

test("abridged status cards without footer keep existing line output", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(5);
  expect(text).toContain("[toolOutput]Waiting for activity…[/toolOutput]");
});

test("abridged progress job card with modelDisplay renders dim model footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 3,
    contextTokens: 10000,
    contextWindowTokens: 50000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:high[/dim]");
});

test("abridged progress job card with modelDisplay excludes usage/cost/turn/context footer segments", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 4,
    contextTokens: 5000,
    contextWindowTokens: 200000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const footerLine = text
    .split("\n")
    .find((l) => l.includes("[dim]") && l.includes("provider/model:high"));
  expect(footerLine).toBeDefined();
  expect(footerLine).not.toContain("turn");
  expect(footerLine).not.toContain("ctx:");
  expect(footerLine).not.toContain("$");
  expect(footerLine).not.toContain("↑");
  expect(footerLine).not.toContain("↓");
});

test("abridged progress job card with modelDisplay and zero tool count preserves compact body", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "empty-tool",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
    modelDisplay: "provider/model:fast",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:fast[/dim]");
  expect(text).toContain("[toolOutput]Waiting for activity…[/toolOutput]");
});

test("abridged progress job card with modelDisplay and long body preview truncates and preserves footer", () => {
  const now = Date.now();
  const longBody = "X".repeat(200);
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "verbose",
    taskPreview: "",
    status: "success",
    startTime: now - 10000,
    toolCount: 1,
    finalOutput: longBody,
    modelDisplay: "provider/model:verbose",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain(`${longBody.slice(0, 119)}…`);
  expect(text).not.toContain(longBody);
  expect(text).toContain("[dim]provider/model:verbose[/dim]");
});

test("abridged progress job card without modelDisplay renders no dim model footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 2,
    contextTokens: 5000,
    contextWindowTokens: 50000,
    finalOutput: "working on it",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const dimParts = text.match(/\[dim\]([^[]+)\[\/dim\]/g) ?? [];
  const modelFooter = dimParts.filter((p) => p.includes("model"));
  expect(modelFooter).toHaveLength(0);
});

test("abridged progress job card with undefined modelDisplay excludes footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 10000,
    toolCount: 0,
    modelDisplay: undefined,
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]Waiting for activity…[/toolOutput]");
  const dimParts = text.match(/\[dim\]([^[]+)\[\/dim\]/g) ?? [];
  const modelFooter = dimParts.filter((p) => p.includes("model"));
  expect(modelFooter).toHaveLength(0);
});

test("progress model footer regression: exact footer line is dim model only", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 3,
    contextTokens: 10000,
    contextWindowTokens: 50000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const footerLines = lines.filter(
    (l) => l.includes("[dim]") && l.includes("provider/model:high"),
  );
  expect(footerLines).toHaveLength(1);
  const fl0 = footerLines[0] as string;
  expect(fl0.trim()).toMatch(
    /^\[toolPendingBg\] \[dim\]provider\/model:high\[\/dim\]\s+\[\/toolPendingBg\]$/,
  );
});

test("progress model footer regression: footer line rejects all completed-card segments", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 60000,
    toolCount: 5,
    inputTokens: 12000,
    outputTokens: 8000,
    contextTokens: 50000,
    contextWindowTokens: 200000,
    modelDisplay: "provider/model:high",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const footerLine = lines.find(
    (l) => l.includes("[dim]") && l.includes("provider/model:high"),
  );
  expect(footerLine).toBeDefined();
  const fl = footerLine as string;
  expect(fl).toContain("[dim]provider/model:high[/dim]");
  expect(fl).not.toContain("turn");
  expect(fl).not.toContain("ctx:");
  expect(fl).not.toContain("$");
  expect(fl).not.toContain("↑");
  expect(fl).not.toContain("↓");
  expect(fl).not.toMatch(/\d+s\b/);
  expect(fl).not.toMatch(/\dm \d+s/);
  expect(fl).not.toMatch(/\dtools?\b/);
});

test("progress model footer regression: empty string modelDisplay excludes footer", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "running",
    startTime: now - 10000,
    toolCount: 1,
    modelDisplay: "",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  const dimFooters = (text.match(/\[dim\][^[]*\[\/dim\]/g) ?? []).filter((m) =>
    m.includes("model"),
  );
  expect(dimFooters).toHaveLength(0);
});

test("progress model footer regression: footer exclusive to modelDisplay-bearing cards in mixed board", () => {
  const now = Date.now();
  const states: SubagentProgressState[] = [
    {
      requestId: "r1",
      agent: "builder",
      taskPreview: "build",
      status: "running",
      startTime: now - 10000,
      toolCount: 3,
      contextTokens: 10000,
      contextWindowTokens: 50000,
      modelDisplay: "provider/model:high",
      finalOutput: "building...",
    },
    {
      requestId: "r2",
      agent: "reviewer",
      taskPreview: "review",
      status: "running",
      startTime: now - 5000,
      toolCount: 1,
      contextTokens: 5000,
      contextWindowTokens: 50000,
      finalOutput: "reviewing...",
    },
    {
      requestId: "r3",
      agent: "tester",
      taskPreview: "test",
      status: "error",
      startTime: now - 20000,
      durationMs: 15000,
      toolCount: 2,
      modelDisplay: undefined,
      errorText: "tests failed",
    },
    {
      requestId: "r4",
      agent: "scanner",
      taskPreview: "scan",
      status: "running",
      startTime: now - 30000,
      toolCount: 0,
      modelDisplay: "provider/model:fast",
      finalOutput: " ",
    },
  ];
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard(states, fakeTheme as never);
  const text = renderToString(rendered);
  const dimModelFooters = (
    text.match(/\[dim\](provider\/model[^[]+)\[\/dim\]/g) ?? []
  ).map((m) => m.replace("[dim]", "").replace("[/dim]", ""));
  expect(dimModelFooters).toHaveLength(2);
  expect(dimModelFooters).toContain("provider/model:high");
  expect(dimModelFooters).toContain("provider/model:fast");
});

test("full status card footer still renders after abridged footer support", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: "provider/model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model · 1 turn · $0.0100[/dim]");
});

test("empty footer text does not render a blank footer line on status card", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
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
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  const lines = text.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(8);
});

test("result detail shape compatible with preserved nested activity progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: completed"}],"usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.01}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "shape compat" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]).toBeDefined();
  expect(resultDetails.results[0]?.exitCode).toBe(0);
  expect(resultDetails.results[0]?.usage).toBeDefined();
  expect(resultDetails.results[0]?.progress).toBeDefined();
  expect(Array.isArray(resultDetails.results[0]?.progress?.toolCalls)).toBe(
    true,
  );
});

test("sanitized result details preserve progress tool calls without internal fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Scanning dependencies"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-read","arguments":{"path":"package.json"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":5,"output":10,"totalTokens":15,"cost":{"total":0.005}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "sanitized progress" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  const progress = resultDetails.results[0]?.progress;
  expect(progress).toBeDefined();
  expect(progress?.toolCalls).toBeDefined();
  expect(progress?.toolCalls.length).toBeGreaterThanOrEqual(1);
  expect(progress?.toolCalls[0]?.id).toBe("tc-read");
  expect(progress?.toolCalls[0]?.preview).toBe("read: package.json");
});

test("renderResult isPartial=true uses content[0].text when finalOutput is empty", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
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
              activityText: "running bash: ls",
              lastToolPreview: "bash: ls",
            },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]bash: ls[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to activityText when content[0].text is absent", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
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
            progress: { activityText: "reading file" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]reading file[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to activityText when content[0].text is empty string", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
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
            progress: { activityText: "reading file" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]reading file[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to lastToolPreview when activityText is absent", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
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
            progress: { lastToolPreview: "read: config.ts" },
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]read: config.ts[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=true falls back to (running...) when all sources are empty", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
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
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput](running...)[/toolOutput]");
  expect(renderedText).not.toContain("[muted](no output)[/muted]");
});

test("renderResult isPartial=false keeps using finalOutput as body", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
            exitCode: 0,
            finalOutput: "final result text",
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
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: false },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]final result text[/toolOutput]");
  expect(renderedText).not.toContain("bash: ls");
});

test("renderResult isPartial=true with non-empty finalOutput still uses finalOutput", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "bash: ls" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "test-agent",
            agentSource: "user" as const,
            task: "test",
            exitCode: 0,
            finalOutput: "final result text",
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
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[toolOutput]final result text[/toolOutput]");
  expect(renderedText).not.toContain("bash: ls");
});

test("formatResultFooter outputs model only when all usage fields are zero", () => {
  const footer = formatResultFooter(
    {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
    },
    "provider/model",
  );
  expect(footer).toBe("provider/model");
  expect(footer).not.toContain(" · ");
});

test("formatResultFooter with model and turns only suppresses context and cost when zero", () => {
  const footer = formatResultFooter(
    {
      turns: 3,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
    },
    "provider/model",
  );
  expect(footer).toBe("provider/model · 3 turns");
  expect(footer).not.toContain("ctx");
  expect(footer).not.toContain("$");
});

test("formatResultFooter with model and contextTokens only suppresses turns and cost when zero", () => {
  const footer = formatResultFooter(
    {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 38000,
    },
    "provider/model",
  );
  expect(footer).toBe("provider/model · ctx:38k");
  expect(footer).not.toContain("turn");
  expect(footer).not.toContain("$");
});

test("formatResultFooter with model and cost only suppresses turns and context when zero", () => {
  const footer = formatResultFooter(
    {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      contextTokens: 0,
    },
    "provider/model",
  );
  expect(footer).toBe("provider/model · $0.0100");
  expect(footer).not.toContain("turn");
  expect(footer).not.toContain("ctx");
});

test("formatResultFooter without model but with usage fields keeps correct order", () => {
  const footer = formatResultFooter(
    {
      turns: 2,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      contextTokens: 50000,
    },
    undefined,
  );
  expect(footer).toBe("2 turns · ctx:50k · $0.0200");
  expect(footer).not.toContain("model");
});

test("completed result card footer renders model, turns, context, cost in fixed order", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: "claude-sonnet-4-20250514",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.005,
              contextTokens: 12400,
              turns: 3,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  const footerIdx = renderedText.indexOf("[dim]claude-sonnet-4-20250514");
  expect(footerIdx).toBeGreaterThan(0);
  const afterFooter = renderedText.slice(footerIdx);
  const modelIdx = afterFooter.indexOf("claude-sonnet-4-20250514");
  const turnsIdx = afterFooter.indexOf("3 turns");
  const ctxIdx = afterFooter.indexOf("ctx:12k");
  const costIdx = afterFooter.indexOf("$0.0050");
  expect(modelIdx).toBeGreaterThanOrEqual(0);
  expect(turnsIdx).toBeGreaterThan(0);
  expect(ctxIdx).toBeGreaterThan(turnsIdx);
  expect(costIdx).toBeGreaterThan(ctxIdx);
  expect(afterFooter).not.toContain("↑");
  expect(afterFooter).not.toContain("↓");
  expect(afterFooter).not.toMatch(/\d+(ms|s|m \d+s)/);
});

test("completed result card footer excludes token arrow metrics", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: "provider/model",
            usage: {
              input: 5000,
              output: 2500,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 10000,
              turns: 2,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain(
    "provider/model · 2 turns · ctx:10k · $0.0100",
  );
  expect(renderedText).not.toContain("↑5.0k");
  expect(renderedText).not.toContain("↓2.5k");
});

test("completed result card footer suppresses model segment when model is undefined", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: undefined,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.01,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]1 turn · $0.0100[/dim]");
  expect(renderedText).not.toContain("[dim]undefined[/dim]");
});

test("completed result card footer suppresses context segment when contextTokens is zero", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]test-model · 1 turn[/dim]");
  expect(renderedText).not.toMatch(/\[dim\]test-model · 1 turn · ctx/);
  expect(renderedText).not.toMatch(/\[dim\]test-model · 1 turn · \$/);
});

test("completed result card footer suppresses cost segment when cost is zero", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 10000,
              turns: 1,
            },
          },
        ],
      },
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("[dim]test-model · 1 turn · ctx:10k[/dim]");
  expect(renderedText).not.toContain("$");
});

test("abridged job card renders modelDisplay footer for error state", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "build failed",
    status: "error",
    startTime: now - 30000,
    durationMs: 25000,
    toolCount: 2,
    errorText: "build collapsed",
    modelDisplay: "provider/model:err",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:err[/dim]");
  expect(text).toContain("FAILED");
  expect(text).toContain("build collapsed");
});

test("abridged job card renders modelDisplay footer for cancelled state", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "cancelled task",
    status: "cancelled",
    startTime: now - 30000,
    durationMs: 25000,
    toolCount: 1,
    modelDisplay: "provider/model:cancel",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:cancel[/dim]");
  expect(text).toContain("CANCELLED");
});

test("abridged job card renders modelDisplay footer for success state", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "passed tests",
    status: "success",
    startTime: now - 30000,
    durationMs: 25000,
    toolCount: 3,
    finalOutput: "all tests pass",
    modelDisplay: "provider/model:ok",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[dim]provider/model:ok[/dim]");
  expect(text).toContain("SUCCEEDED");
  expect(text).toContain("all tests pass");
});

test("abridged job card with modelDisplay uses errorText as body when finalOutput is empty", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "do work",
    status: "error",
    startTime: now - 30000,
    durationMs: 25000,
    toolCount: 1,
    errorText: "specific error message",
    finalOutput: "",
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]specific error message[/toolOutput]");
  expect(text).toContain("[dim]provider/model[/dim]");
});

test("abridged job card with modelDisplay falls back body from taskPreview when no finalOutput or errorText", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "fallback preview text",
    status: "running",
    startTime: now - 30000,
    toolCount: 1,
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("fallback preview text");
  expect(text).not.toContain("(no output)");
});

test("abridged job card with modelDisplay shows (no output) when all body sources are empty", () => {
  const now = Date.now();
  const state: SubagentProgressState = {
    requestId: "r1",
    agent: "builder",
    taskPreview: "",
    status: "running",
    startTime: now - 30000,
    toolCount: 0,
    modelDisplay: "provider/model",
  };
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderRunsBoard([state], fakeTheme as never);
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]Waiting for activity…[/toolOutput]");
});

test("completed result card footer is empty when model and usage all missing", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "done",
            messages: [],
            stderr: "",
            model: undefined,
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  const lines = renderedText.split("\n");
  const cardLines = lines.filter((line) =>
    /^\[tool(?:Pending|Error|Success)Bg\]/.test(line),
  );
  expect(cardLines).toHaveLength(8);
  expect(renderedText).not.toMatch(/\[dim\].*·.*\[\/dim\]/);
});

test("renderSubagentResult shows finalOutput only from assistant text and performs no hidden outcome synthesis", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project",
            task: "pass",
            exitCode: 0,
            finalOutput: "pure assistant text here",
            outcome: "should-not-be-synthesized-into-body",
            messages: [],
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
    },
    fakeTheme,
  );
  const renderedText = renderToString(rendered);
  expect(renderedText).toContain("pure assistant text here");
  expect(renderedText).not.toContain("should-not-be-synthesized-into-body");
});

test("getFinalOutput returns last assistant text and tolerates non-array content", () => {
  const fakeTheme = createDefaultFakeTheme();
  expect(getFinalOutput([])).toBe("");
  const stringContent = [
    { role: "assistant", content: "plain string" },
  ] as unknown as Message[];
  expect(getFinalOutput(stringContent)).toBe("");
  const toolOnly = [
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: {}, id: "1" }],
    },
  ] as unknown as Message[];
  expect(getFinalOutput(toolOnly)).toBe("");
  const textMessages = [
    { role: "user", content: [{ type: "text", text: "user" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "toolCall", name: "bash", arguments: {}, id: "1" },
        { type: "text", text: "last" },
      ],
    },
  ] as unknown as Message[];
  expect(getFinalOutput(textMessages)).toBe("last");
  const fallbackResult = renderSubagentResult(
    {
      content: [{ type: "text", text: "subagent text" }],
      details: {
        mode: "single",
        agentScope: "both",
        projectAgentsDir: null,
        results: [
          {
            agent: "fallback",
            agentSource: "project",
            task: "task",
            exitCode: 0,
            finalOutput: "",
            messages: textMessages,
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
    },
    fakeTheme,
  ) as unknown as { render: (width: number) => string[] };
  const fallbackText = renderToString(fallbackResult);
  expect(fallbackText).toContain("[muted](no output)[/muted]");
  expect(fallbackText).not.toContain("last");
});

test("completed result card renders from finalOutput and ignores stale messages", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "preserved final output",
            messages: [
              {
                role: "assistant" as const,
                content: [
                  { type: "text" as const, text: "stale message output" },
                ],
              },
            ],
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
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]preserved final output[/toolOutput]");
  expect(text).not.toContain("stale message output");
});

test("completed result card shows (no output) when finalOutput is blank even with messages", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "   ",
            messages: [
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "message text" }],
              },
            ],
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
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[muted](no output)[/muted]");
  expect(text).not.toContain("message text");
});

test("completed result card renders sanitized details without messages from finalOutput", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "sanitized final output",
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
    },
    fakeTheme,
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]sanitized final output[/toolOutput]");
});

test("partial result card still prefers finalOutput over live content", () => {
  const fakeTheme = createDefaultFakeTheme();
  const rendered = renderSubagentResult(
    {
      content: [{ type: "text" as const, text: "live content text" }],
      details: {
        mode: "single" as const,
        agentScope: "both" as const,
        projectAgentsDir: null,
        results: [
          {
            agent: "builder",
            agentSource: "project" as const,
            task: "pass",
            exitCode: 0,
            finalOutput: "existing final output",
            progress: { activityText: "running activity" },
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
            messages: [],
          },
        ],
      },
    },
    fakeTheme,
    { isPartial: true },
  );
  const text = renderToString(rendered);
  expect(text).toContain("[toolOutput]existing final output[/toolOutput]");
  expect(text).not.toContain("live content text");
  expect(text).not.toContain("running activity");
});
