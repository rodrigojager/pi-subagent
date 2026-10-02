import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getCachedAgentDiscovery } from "../src/agent/agent-cache.js";
import { resetAgentCache } from "../src/index.js";
import {
  cancelRunJob,
  getRunJob,
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  clearProgressState,
  createProgressState,
  getProgressState,
  patchProgressState,
} from "../src/progress/progress.js";
import {
  type FakeTheme,
  type RegisteredEventHandler,
  type RegisteredMessageRenderer,
  type SendMessageArg,
  setupHooks,
  setupTest,
  waitFor,
  waitForRunJobCount,
  waitForRunJobsCleared,
  waitForSentMessage,
  waitForSentMessageCount,
} from "./helpers.js";

setupHooks();

async function emitSessionStart(
  tool: { registeredEventHandlers: Map<string, RegisteredEventHandler[]> },
  cwd: string,
) {
  for (const handler of tool.registeredEventHandlers.get("session_start") ??
    []) {
    await handler({ type: "session_start", reason: "startup" }, {
      cwd,
    } as ExtensionCommandContext);
  }
}

test("/run handler resolves before child completion and cancel command reaches active job", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  await runCommand?.handler("hang task", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(sentMessages).toHaveLength(1);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getRunJob(requestId)?.agentName).toBe("hang");
  cancelCommand?.handler(requestId, {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(getRunJob(requestId)?.cancelReason).toBe(
    "Cancelled by /cancel-subagent",
  );
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(notices).toEqual([`Cancelled /run job ${requestId}.`]);
});

test("/run startup reuses completion discovery cache", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  await emitSessionStart(tool, cwd);
  expect(await runCommand?.getArgumentCompletions?.("hang")).toEqual([
    { value: "hang", label: "hang" },
  ]);
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "fresh.md"),
    `---
name: fresh
description: Fresh project agent
---
Fresh prompt`,
  );
  await runCommand?.handler("fresh task", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["Unknown agent: fresh"]);
  expect(listRunJobs()).toEqual([]);
});

test("/run registry registers active job and removes it after internal cancellation", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const promise = runCommand?.handler("hang task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const active = listRunJobs();
  expect(active.map((job) => job.requestId)).toContain(requestId);
  expect(active.find((job) => job.requestId === requestId)?.agentName).toBe(
    "hang",
  );
  expect(cancelRunJob(requestId, "test cancel")).toBe(true);
  expect(cancelRunJob(requestId, "test cancel again")).toBe(true);
  await promise;
  await waitForRunJobsCleared();
  expect(listRunJobs()).toHaveLength(0);
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("/run registry removes job after host signal cancellation", async () => {
  resetRunRegistry();
  const controller = new AbortController();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const promise = runCommand?.handler("hang task", {
    cwd,
    signal: controller.signal,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(1);
  controller.abort();
  await promise;
  await waitForRunJobsCleared();
  expect(listRunJobs()).toHaveLength(0);
  expect(notices).toHaveLength(0);
});

test("/cancel-subagent no-args opens interactive selector and cancels selected agent", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  const promise = runCommand?.handler("hang task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(1);
  const requestId = listRunJobs()[0]?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const job = getRunJob(requestId);
  await cancelCommand?.handler("", {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, options: string[]) => {
        expect(options[0]).toBe(`hang ${job?.instanceName} (${requestId})`);
        return options[0];
      },
    },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual([`Cancelled /run job ${requestId}.`]);
  expect(getRunJob(requestId)?.cancelReason).toBe(
    "Cancelled by /cancel-subagent",
  );
  await promise;
  await waitForRunJobsCleared();
});

test("/cancel-subagent dismiss selector performs no cancellation", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  const promise = runCommand?.handler("hang task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(1);
  const requestId = listRunJobs()[0]?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await cancelCommand?.handler("", {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, _options: string[]) => undefined,
    },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual([]);
  expect(getRunJob(requestId)?.cancelReason).toBeUndefined();
  cancelRunJob(requestId, "cleanup");
  await promise;
  await waitForRunJobsCleared();
});

test("/cancel-subagent selector all cancels every active job", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  const first = runCommand?.handler("hang one", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const second = runCommand?.handler("hang two", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(2);
  await cancelCommand?.handler("", {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, _options: string[]) =>
        "All running subagents",
    },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["Cancelled 2 /run jobs."]);
  await Promise.all([first, second]);
  await waitForRunJobsCleared();
});

test("/cancel-subagent no-args with no jobs notifies without opening selector", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  let selectCalled = false;
  const { tool, cwd } = await setupTest();
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  await cancelCommand?.handler("", {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, _options: string[]) => {
        selectCalled = true;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["No active /run jobs."]);
  expect(selectCalled).toBe(false);
});

test("/cancel-subagent whitespace args with no jobs notifies without opening selector", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  let selectCalled = false;
  const { tool, cwd } = await setupTest();
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  await cancelCommand?.handler("   ", {
    cwd,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, _options: string[]) => {
        selectCalled = true;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["No active /run jobs."]);
  expect(selectCalled).toBe(false);
});

test("/cancel-subagent cancels matching request id with reason", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  const promise = runCommand?.handler("hang task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(1);
  const requestId = listRunJobs()[0]?.requestId ?? "";
  cancelCommand?.handler(requestId, {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(getRunJob(requestId)?.cancelReason).toBe(
    "Cancelled by /cancel-subagent",
  );
  await promise;
  await waitForRunJobsCleared();
  const state = getProgressState(requestId);
  expect(notices).toEqual([`Cancelled /run job ${requestId}.`]);
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("Cancelled by /cancel-subagent");
  expect(state?.lastToolPreview).toBeUndefined();
  expect(listRunJobs()).toHaveLength(0);
});

test("/cancel-subagent all cancels every active job", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  const first = runCommand?.handler("hang one", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  const second = runCommand?.handler("hang two", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobCount(2);
  cancelCommand?.handler("all", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await Promise.all([first, second]);
  await waitForRunJobsCleared();
  expect(notices).toEqual(["Cancelled 2 /run jobs."]);
  expect(listRunJobs()).toHaveLength(0);
});

test("/cancel-subagent reports missing and already-finished jobs", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  cancelCommand?.handler("missing", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await runCommand?.handler("hang done", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  const requestId =
    [...(getProgressState("missing") ? ["missing"] : [])][0] ?? "finished";
  cancelCommand?.handler(requestId, {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  cancelCommand?.handler("all", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual([
    "No active /run job missing.",
    `No active /run job ${requestId}.`,
    "No active /run jobs.",
  ]);
});

test("/cancel-subagent lists no jobs when called without a target", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest();
  const cancelCommand = tool.registeredCommands.get("cancel-subagent");
  cancelCommand?.handler("   ", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["No active /run jobs."]);
});

test("/run without args reports usage without starting a job", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("   ", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["Usage: /run <agent> [task]"]);
  expect(listRunJobs()).toHaveLength(0);
});

test("/run unknown agent reports an error without starting a job", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("missing task", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  expect(notices).toEqual(["Unknown agent: missing"]);
  expect(listRunJobs()).toHaveLength(0);
});

test("/run pre-aborted host signal cancels before worker starts", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const controller = new AbortController();
  controller.abort("already cancelled");
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' worker-ran > worker-ran.txt
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang task", {
    cwd,
    signal: controller.signal,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  expect(sentMessages).toHaveLength(0);
  expect(await Bun.file(path.join(cwd, "worker-ran.txt")).exists()).toBe(false);
  expect(notices).toEqual(["Cancelled"]);
  expect(listRunJobs()).toHaveLength(0);
});

test("/run worker launch waits for a macrotask turn", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' worker-ran > worker-ran.txt
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await Promise.resolve();
  expect(await Bun.file(path.join(cwd, "worker-ran.txt")).exists()).toBe(false);
  expect(sentMessages.map((msg) => msg.customType)).toEqual([
    "subagent-progress",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitForSentMessageCount(sentMessages, 2);
  expect(await Bun.file(path.join(cwd, "worker-ran.txt")).exists()).toBe(true);
  expect(sentMessages.map((msg) => msg.customType)).toEqual([
    "subagent-progress",
    "subagent-result",
  ]);
});

test("run slash command sends one subagent-progress message and one final result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
while [ ! -f release-child ]; do sleep 0.01; done
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand).toBeDefined();
  const handlerPromise = runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 1);
  const messagesSentBeforeChildExit = sentMessages.length;
  await Bun.write(path.join(cwd, "release-child"), "");
  await handlerPromise;
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  const details = sentMessages[0]?.details as
    | { agent?: unknown; instanceName?: unknown; requestId?: unknown }
    | undefined;
  if (typeof details?.requestId !== "string")
    throw new Error("progress request id missing");
  expect(details.requestId.length).toBeGreaterThan(0);
  expect(details.agent).toBe("hang");
  expect(details.instanceName).toMatch(/^#[1-9]\d*$/);
  expect(Object.keys(details)).toEqual(["agent", "instanceName", "requestId"]);
  expect(messagesSentBeforeChildExit).toBe(1);
});

test("run slash command patches context window into progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages[0]?.details as
    | { requestId?: string }
    | undefined;
  const requestId = details?.requestId;
  if (!requestId) throw new Error("progress request id missing");
  const state = getProgressState(requestId);
  expect(state?.contextTokens).toBe(30);
  expect(state?.contextWindowTokens).toBe(128000);
  clearProgressState(requestId);
});

test("run slash command keeps context window unknown without metadata", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":30,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages[0]?.details as
    | { requestId?: string }
    | undefined;
  const requestId = details?.requestId;
  if (!requestId) throw new Error("progress request id missing");
  const state = getProgressState(requestId);
  expect(state?.contextTokens).toBe(30);
  expect(state?.contextWindowTokens).toBeUndefined();
  clearProgressState(requestId);
});

test("patchProgressState missing usage fields keeps existing context window", () => {
  const requestId = "manual-progress-context-window";
  clearProgressState(requestId);
  createProgressState(requestId, "agent", "task");
  patchProgressState(requestId, { contextWindowTokens: 128000 });
  patchProgressState(requestId, { inputTokens: 10 });
  expect(getProgressState(requestId)?.contextWindowTokens).toBe(128000);
  clearProgressState(requestId);
});

test("run slash command does not append progress refresh messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
sleep 0.6
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const progressMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-progress",
  );
  expect(progressMessages).toHaveLength(1);
  for (const message of progressMessages) {
    expect(message.content).toBe("");
    expect(
      Object.keys((message.details as Record<string, unknown>) ?? {}),
    ).toEqual(["agent", "instanceName", "requestId"]);
  }
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const countAfterCompletion = sentMessages.length;
  expect(sentMessages).toHaveLength(countAfterCompletion);
});

test("/run without task sends an agent-default prompt instead of empty Task label", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const runPromise = runCommand?.handler("hang", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await runPromise;
  await waitForRunJobsCleared();
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).not.toContain("Task:");
  expect(argsText).toContain("Run according to your system prompt");
});

test("/run with task preserves Task label", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const runPromise = runCommand?.handler("hang explicit task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await runPromise;
  await waitForRunJobsCleared();
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).toContain("Task: explicit task");
});

test("getArgumentCompletions returns matching active workspace suggestions", async () => {
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand?.getArgumentCompletions).toBeDefined();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "test-agent.md"),
    `---\nname: test-agent\ndescription: test\n---\nPrompt`,
  );
  const originalCwd = process.cwd;
  process.cwd = () => path.dirname(cwd);
  try {
    await emitSessionStart(tool, cwd);
    expect(await runCommand?.getArgumentCompletions?.("te")).toEqual([
      { value: "test-agent", label: "test-agent" },
    ]);
    expect(await runCommand?.getArgumentCompletions?.("x")).toEqual([]);
  } finally {
    process.cwd = originalCwd;
  }
});

test("getArgumentCompletions returns empty without valid active workspace", async () => {
  const { tool, cwd } = await setupTest();
  const runCommand = tool.registeredCommands.get("run");
  expect(await runCommand?.getArgumentCompletions?.("hang")).toEqual([]);
  await emitSessionStart(tool, path.join(cwd, "missing"));
  expect(await runCommand?.getArgumentCompletions?.("hang")).toEqual([]);
});

test("/run progress onUpdate mutates state without refresh messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const statusUpdates: [string, string | undefined][] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  expect(runCommand).toBeDefined();
  await runCommand?.handler("hang test task", {
    cwd,
    ui: {
      notify: () => {},
      setStatus: (key: string, text: string | undefined) =>
        statusUpdates.push([key, text]),
    },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBeGreaterThan(0);
  expect(statusUpdates.length).toBeGreaterThan(0);
  expect(statusUpdates.some(([, text]) => text === undefined)).toBe(true);
});

test("/run non-debug progress consumes derived data without raw messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/foo"}},{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/foo"}}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":4,"output":5,"totalTokens":9,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Feedback:\\nLooks good.\\n\\nOutcome: shipped fix"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":6,"output":7,"totalTokens":13,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const progressDetails = sentMessages[0]?.details as { requestId?: string };
  expect(Object.keys(progressDetails)).toEqual([
    "agent",
    "instanceName",
    "requestId",
  ]);
  const requestId = progressDetails.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBe(2);
  expect(state?.inputTokens).toBe(12);
  expect(state?.outputTokens).toBe(15);
  expect(state?.contextTokens).toBe(13);
  expect(state?.contextWindowTokens).toBe(128000);
  expect(state?.finalOutput).toBe("looks good");
  expect(state?.lastToolPreview).toBeUndefined();
  const resultDetails = sentMessages[1]?.details as {
    results?: { messages?: unknown }[];
  };
  expect(resultDetails.results?.[0]?.messages).toBeUndefined();
  clearProgressState(requestId);
});

test("/run progress refresh does not emit fallback notifications", async () => {
  const notifyCalls: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    hasUI: true,
    ui: {
      notify: (msg: string) => notifyCalls.push(msg),
    },
  } as unknown as ExtensionCommandContext);
  expect(notifyCalls).toHaveLength(0);
});

test("/run fallback is silent when hasUI is false", async () => {
  const notifyCalls: string[] = [];
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    hasUI: false,
    ui: {
      notify: (msg: string) => notifyCalls.push(msg),
    },
  } as unknown as ExtensionCommandContext);
  expect(notifyCalls).toHaveLength(0);
});

test("/run success marks state success with trimmed finalOutput and clears transient fields", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("done");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("completed task");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("/run whitespace-only output treats as no-output for result and progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"   "}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("(no output)");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.finalOutput).toBe("(no output)");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("/run child failure marks state error with concise error text and clears transient fields", async () => {
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' 'child exploded' >&2
exit 7
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBeTruthy();
  expect(state?.lastToolPreview).toBeUndefined();
  expect(notices.length).toBeGreaterThanOrEqual(1);
  expect(notices[0]).toContain("child exploded");
  if (notices.length > 1) {
    expect(notices[1]).toContain("✗");
  }
});

test("/run final result send failure marks state error and sends fallback", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const sentMessages: SendMessageArg[] = [];
  let failNextResult = true;
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => {
      if (msg.customType === "subagent-result" && failNextResult) {
        failNextResult = false;
        throw new Error("send failed");
      }
      sentMessages.push(msg);
    },
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("send failed");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("error");
  expect(state?.errorText).toBe("send failed");
  expect(notices.length).toBeGreaterThanOrEqual(1);
  expect(notices[0]).toBe("send failed");
  if (notices.length > 1) {
    expect(notices[1]).toContain("✗");
  }
  expect(listRunJobs()).toHaveLength(0);
});

test("/run project-agent confirmation failure cancels job and propagates error", async () => {
  resetRunRegistry();
  const { cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project agent
---
Prompt`,
  );
  const sentMessages: SendMessageArg[] = [];
  const { tool } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await expect(
    runCommand?.handler("proj-agent task", {
      cwd,
      hasUI: true,
      ui: {
        notify: () => {},
        confirm: async () => {
          throw new Error("confirm failed hard");
        },
      },
    } as unknown as ExtensionCommandContext),
  ).rejects.toThrow("confirm failed hard");
  await waitForRunJobsCleared();
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("/run project-agent denial creates no side effects", async () => {
  resetRunRegistry();
  const notices: string[] = [];
  const { cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "proj-agent.md"),
    `---
name: proj-agent
description: Project agent
---
Prompt`,
  );
  const sentMessages: SendMessageArg[] = [];
  const { tool } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("proj-agent task", {
    cwd,
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  expect(sentMessages).toHaveLength(0);
  expect(notices).toEqual(["Cancelled"]);
  expect(listRunJobs()).toHaveLength(0);
});

test("/run result dumps subagent summary and feedback keeps semantic one-liner", async () => {
  const sentMessages: SendMessageArg[] = [];
  const finalOutput =
    "Outcome: Updated src/index.ts from raw final output.\nAll tests pass.";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "SECRET_COMMAND" } }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const resultMessage = sentMessages.at(-1);
  expect(resultMessage?.content).toBe(finalOutput);
  expect(resultMessage?.content).toContain("All tests pass");
  expect(resultMessage?.content).not.toContain("SECRET_COMMAND");
  const details = resultMessage?.details as {
    results?: { finalOutput?: string }[];
  };
  expect(details.results?.[0]?.finalOutput).toBe(finalOutput);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.finalOutput).toBe(
    "outcome: updated src/index.ts from raw final output",
  );
});

test("/run success after agent_end_timeout keeps final content and hides metadata", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const finalOutput = "Outcome: completed after timeout";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe(finalOutput);
  const details = sentMessages.at(-1)?.details as {
    results?: {
      finalOutput?: string;
      messages?: unknown;
      termination?: unknown;
    }[];
  };
  expect(details.results?.[0]?.finalOutput).toBe(finalOutput);
  expect(details.results?.[0]?.messages).toBeUndefined();
  expect(details.results?.[0]?.termination).toBeUndefined();
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(getProgressState(requestId)?.finalOutput).toBe(
    "outcome: completed after timeout",
  );
});

test("/run debug exposes agent_end_timeout metadata", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Outcome: debug timeout" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("--debug hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as {
    results?: {
      termination?: { cancelReason?: string };
      messages?: unknown[];
    }[];
  };
  expect(sentMessages.at(-1)?.content).toBe("Outcome: debug timeout");
  expect(details.results?.[0]?.messages).toHaveLength(1);
  expect(details.results?.[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("/run debug includes child messages in final details", async () => {
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "DEBUG_COMMAND", token: "password-value" } }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "benign preface token=abc benign suffix" }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Outcome: done" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("--debug hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as {
    results?: { messages?: unknown[] }[];
  };
  expect(details.results?.[0]?.messages).toHaveLength(3);
  const messageJson = JSON.stringify(details.results?.[0]?.messages);
  expect(messageJson).toContain("DEBUG_COMMAND");
  expect(messageJson).toContain("benign preface");
  expect(messageJson).toContain("benign suffix");
  expect(messageJson).not.toContain("password-value");
  expect(messageJson).not.toContain("token=abc");
  expect(messageJson).toContain("[redacted]");
});

test("/run debug without env opt-in uses non-debug details", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' 'STDERR_SECRET' >&2
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", id: "tc-1", arguments: { command: "DEBUG_COMMAND", token: "password-value" } }] } })}'
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Outcome: done" }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("--debug hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as {
    results?: {
      messages?: unknown[];
      stderr?: string;
      termination?: unknown;
    }[];
  };
  expect(details.results?.[0]?.messages).toBeUndefined();
  expect(details.results?.[0]?.termination).toBeUndefined();
  expect(details.results?.[0]?.stderr).toBe("");
  expect(JSON.stringify(details)).not.toContain("password-value");
  expect(JSON.stringify(details)).not.toContain("STDERR_SECRET");
});

test("/run context hygiene: sent message content excludes child internals", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "process.stderr.write('STDERR_SECRET');console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',name:'bash',id:'tc-1',arguments:{command:'TOOL_SECRET'}}]}}));console.log(JSON.stringify({type:'tool_result_end',message:{role:'toolResult',content:[{type:'text',text:'TOOL_RESULT_SECRET'}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}}));console.log(JSON.stringify({type:'agent_end'}));"
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  for (const message of sentMessages) {
    const content = String(message.content ?? "");
    expect(content).not.toContain("TOOL_SECRET");
    expect(content).not.toContain("TOOL_RESULT_SECRET");
    expect(content).not.toContain("STDERR_SECRET");
    expect(content).not.toContain("toolCall");
    expect(content).not.toContain("requestId");
  }
  expect(sentMessages[0]?.content).toBe("");
  expect(sentMessages[0]?.details).toMatchObject({
    agent: "hang",
    instanceName: expect.stringMatching(/^#[1-9]\d*$/),
    requestId: (sentMessages[0]?.details as { requestId?: string })?.requestId,
  });
  expect(sentMessages.at(-1)?.content).toBe("done");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.finalOutput).toBe("completed task");
  const resultDetails = JSON.stringify(sentMessages.at(-1)?.details ?? {});
  expect(resultDetails).not.toContain("TOOL_SECRET");
  expect(resultDetails).not.toContain("TOOL_RESULT_SECRET");
  expect(resultDetails).not.toContain("STDERR_SECRET");
  expect(resultDetails).not.toContain('"messages"');
});

test("/run context hygiene: sendMessage details has only requestId and progress state has no raw child data", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "const args={command:'A'.repeat(80),secret:'SECRET_VALUE'};console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',name:'bash',id:'tc-1',arguments:args}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}}));console.log(JSON.stringify({type:'agent_end'}));"
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  const msgDetails = sentMessages[0]?.details as Record<string, unknown>;
  expect(Object.keys(msgDetails)).toEqual([
    "agent",
    "instanceName",
    "requestId",
  ]);
  const requestId = msgDetails["requestId"] as string;
  const state = getProgressState(requestId);
  expect(state).toBeDefined();
  const stateStr = JSON.stringify(state);
  expect(stateStr).not.toContain('"messages"');
  expect(stateStr).not.toContain("SECRET_VALUE");
  expect((state?.lastToolPreview ?? "").length).toBeLessThan(80);
});

test("/run error hygiene: errorText is concise when child stderr is large", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
node -e "process.stderr.write('E'.repeat(5000));process.exit(7);"
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error progress state");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("error");
  expect((state?.errorText ?? "").length).toBeLessThanOrEqual(300);
});

test("/run accumulates toolCount across multiple distinct tool calls", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"write","id":"tc-3","arguments":{"path":"/tmp/y"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.toolCount).toBe(3);
  expect(state?.status).toBe("success");
});

test("/run retains progress state after terminal transition", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state).toBeDefined();
  expect(state?.status).toBe("success");
  const stateAgain = getProgressState(requestId);
  expect(stateAgain).toBeDefined();
  expect(stateAgain?.requestId).toBe(requestId);
});

test("/run abort marks state cancelled with signal from ctx", async () => {
  const controller = new AbortController();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  const promise = runCommand?.handler("hang task", {
    cwd,
    signal: controller.signal,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessage(sentMessages);
  controller.abort();
  await promise;
  await waitForRunJobsCleared();
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("cancelled");
});

test("/run abort after child starts records aborted worker failure as cancellation", async () => {
  const controller = new AbortController();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' started > started.txt
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang task", {
    cwd,
    signal: controller.signal,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessage(sentMessages);
  await waitFor(
    () => existsSync(path.join(cwd, "started.txt")) || undefined,
    "child process start",
  );
  controller.abort("host stopped");
  await waitForRunJobsCleared();
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("host stopped");
});

test("/run abort during skill discovery records failed result as cancellation", async () => {
  const controller = new AbortController();
  const sentMessages: SendMessageArg[] = [];
  const originalReload = DefaultResourceLoader.prototype.reload;
  let releaseReload!: () => void;
  let enteredReload!: () => void;
  const reloadEntered = new Promise<void>((resolve) => {
    enteredReload = resolve;
  });
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await Bun.write(
    path.join(agentDir, "agents", "badskill.md"),
    `---
name: badskill
description: Bad skill
skills: missing-skill
---
Prompt`,
  );
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    enteredReload();
    await reloadRelease;
    return originalReload.call(this);
  };
  const runCommand = tool.registeredCommands.get("run");
  try {
    await runCommand?.handler("badskill task", {
      cwd,
      signal: controller.signal,
      ui: { notify: () => {} },
    } as unknown as ExtensionCommandContext);
    await reloadEntered;
    controller.abort("host stopped");
    releaseReload();
    await waitForRunJobsCleared();
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("cancelled");
  expect(state?.errorText).toBe("Aborted");
  expect(sentMessages).toHaveLength(1);
});

test("/run success sends final result message with raw subagent summary", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("/run final result message renderer hides header and keeps success background", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    { expanded: false, outputPad: 2 },
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(renderedText).toContain("[success]✓[/success]");
  expect(renderedText).toContain(
    "[success]✓[/success] [toolTitle]*hang*[/toolTitle]",
  );
  expect(renderedText).toContain("[toolOutput]done");
  expect(renderedText).toContain("[/toolOutput]");
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

test("/run collision: project agent with same-named user agent emits warning", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, agentDir, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "reviewer.md"),
    `---\nname: reviewer\ndescription: Project reviewer\n---\nProject prompt.`,
  );
  await Bun.write(
    path.join(agentDir, "agents", "reviewer.md"),
    `---\nname: reviewer\ndescription: User reviewer\n---\nUser prompt.`,
  );
  resetAgentCache();
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("reviewer task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  const collisionMsg = sentMessages.find(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("Using project agent"),
  );
  expect(collisionMsg).toBeDefined();
  expect(collisionMsg?.content).toContain(
    'Using project agent "reviewer"; user agent with same name also exists.',
  );
  expect(sentMessages.some((msg) => msg.customType === "subagent-result")).toBe(
    true,
  );
});

test("/run collision uses cached user discovery", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, agentDir, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  const userAgentPath = path.join(agentDir, "agents", "cached-reviewer.md");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "cached-reviewer.md"),
    `---\nname: cached-reviewer\ndescription: Project reviewer\n---\nProject prompt.`,
  );
  await Bun.write(
    userAgentPath,
    `---\nname: cached-reviewer\ndescription: User reviewer\n---\nUser prompt.`,
  );
  resetAgentCache();
  const cachedUserDiscovery = await getCachedAgentDiscovery(cwd, "user");
  expect(
    cachedUserDiscovery.agents.some((a) => a.name === "cached-reviewer"),
  ).toBe(true);
  await Bun.write(
    userAgentPath,
    `---\nname: renamed-reviewer\ndescription: User reviewer\n---\nUser prompt.`,
  );
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("cached-reviewer task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  const collisionMsg = sentMessages.find(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("Using project agent"),
  );
  expect(collisionMsg?.content).toBe(
    'Using project agent "cached-reviewer"; user agent with same name also exists.',
  );
  expect(sentMessages.indexOf(collisionMsg as SendMessageArg)).toBe(0);
});

test("/run no collision when only project agent exists", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "only-project.md"),
    `---\nname: only-project\ndescription: Only project\n---\nPrompt.`,
  );
  resetAgentCache();
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("only-project task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  const collisionMsg = sentMessages.find(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("Using project agent"),
  );
  expect(collisionMsg).toBeUndefined();
  expect(sentMessages.some((msg) => msg.customType === "subagent-result")).toBe(
    true,
  );
});

test("/run collision reuses derived user cache from completion", async () => {
  resetRunRegistry();
  const sentMessages: SendMessageArg[] = [];
  const { tool, agentDir, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  const userAgentPath = path.join(agentDir, "agents", "derived-reviewer.md");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "derived-reviewer.md"),
    `---\nname: derived-reviewer\ndescription: Project reviewer\n---\nProject prompt.`,
  );
  await Bun.write(
    userAgentPath,
    `---\nname: derived-reviewer\ndescription: User reviewer\n---\nUser prompt.`,
  );
  resetAgentCache();
  await emitSessionStart(tool, cwd);
  const runCommand = tool.registeredCommands.get("run");
  const completions = await runCommand?.getArgumentCompletions?.("derived");
  expect(completions).toEqual([
    { value: "derived-reviewer", label: "derived-reviewer" },
  ]);
  await Bun.write(
    userAgentPath,
    `---\nname: renamed-reviewer\ndescription: User reviewer\n---\nUser prompt.`,
  );
  await runCommand?.handler("derived-reviewer task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForRunJobsCleared();
  const collisionMsg = sentMessages.find(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("Using project agent"),
  );
  expect(collisionMsg?.content).toBe(
    'Using project agent "derived-reviewer"; user agent with same name also exists.',
  );
  expect(sentMessages.indexOf(collisionMsg as SendMessageArg)).toBe(0);
});

test("/run final result renders raw summary and feedback uses semantic content", async () => {
  const sentMessages: SendMessageArg[] = [];
  const finalOutput =
    "Hello! I can help.\nError: noisy stack line\nOutcome: Updated semantic summary";
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalOutput }], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } })}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const runCommand = tool.registeredCommands.get("run");
  await runCommand?.handler("hang test task", {
    cwd,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  await waitForSentMessageCount(sentMessages, 2);
  const renderer = tool.registeredMessageRenderers.get("subagent-result");
  if (!renderer) throw new Error("subagent-result renderer missing");
  const fakeTheme: FakeTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `*${text}*`,
  };
  const rendered = renderer(
    sentMessages.at(-1) as Parameters<RegisteredMessageRenderer>[0],
    { expanded: false, outputPad: 2 },
    fakeTheme as Parameters<RegisteredMessageRenderer>[2],
  ) as unknown as { render: (width: number) => string[] };
  const renderedText = rendered.render(10000).join("\n");
  expect(sentMessages.at(-1)?.content).toBe(finalOutput);
  expect(renderedText).toContain("Hello! I can help.");
  expect(renderedText).toContain("Error: noisy stack line");
  expect(renderedText).toContain("Outcome: Updated semantic summary");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.finalOutput).toBe("noisy stack line");
});

test("/run repeated completions reuse cached discovery without redundant scans", async () => {
  resetRunRegistry();
  const { tool, cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "agent-alpha.md"),
    `---\nname: agent-alpha\ndescription: Alpha\n---\nAlpha prompt`,
  );
  await Bun.write(
    path.join(projectAgentsDir, "agent-beta.md"),
    `---\nname: agent-beta\ndescription: Beta\n---\nBeta prompt`,
  );
  resetAgentCache();
  await emitSessionStart(tool, cwd);
  const runCommand = tool.registeredCommands.get("run");
  const result1 = await runCommand?.getArgumentCompletions?.("agent");
  const result2 = await runCommand?.getArgumentCompletions?.("agent");
  const result3 = await runCommand?.getArgumentCompletions?.("agent");
  const sorted1 = result1?.sort((a, b) => a.value.localeCompare(b.value));
  const sorted2 = result2?.sort((a, b) => a.value.localeCompare(b.value));
  const sorted3 = result3?.sort((a, b) => a.value.localeCompare(b.value));
  expect(sorted1).toEqual([
    { value: "agent-alpha", label: "agent-alpha" },
    { value: "agent-beta", label: "agent-beta" },
  ]);
  expect(sorted2).toEqual(sorted1);
  expect(sorted3).toEqual(sorted1);
});

test("/run completion with different prefixes reuses same cache entry", async () => {
  resetRunRegistry();
  const { tool, cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "reviewer.md"),
    `---\nname: reviewer\ndescription: Reviewer\n---\nReviewer prompt`,
  );
  await Bun.write(
    path.join(projectAgentsDir, "builder.md"),
    `---\nname: builder\ndescription: Builder\n---\nBuilder prompt`,
  );
  resetAgentCache();
  await emitSessionStart(tool, cwd);
  const runCommand = tool.registeredCommands.get("run");
  const revResult = await runCommand?.getArgumentCompletions?.("rev");
  const buildResult = await runCommand?.getArgumentCompletions?.("build");
  const emptyResult = await runCommand?.getArgumentCompletions?.("xyz");
  expect(revResult).toEqual([{ value: "reviewer", label: "reviewer" }]);
  expect(buildResult).toEqual([{ value: "builder", label: "builder" }]);
  expect(emptyResult).toEqual([]);
});

test("resources_discover event sets active workspace root for completion", async () => {
  resetRunRegistry();
  const { tool, cwd } = await setupTest();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await Bun.write(
    path.join(projectAgentsDir, "resource-agent.md"),
    `---\nname: resource-agent\ndescription: Resource agent\n---\nResource prompt`,
  );
  resetAgentCache();
  const resourcesHandlers =
    tool.registeredEventHandlers.get("resources_discover") ?? [];
  for (const handler of resourcesHandlers) {
    await handler({ type: "resources_discover", cwd: undefined }, {
      cwd,
    } as ExtensionCommandContext);
  }
  const runCommand = tool.registeredCommands.get("run");
  const completions = await runCommand?.getArgumentCompletions?.("resource");
  expect(completions).toEqual([
    { value: "resource-agent", label: "resource-agent" },
  ]);
});
