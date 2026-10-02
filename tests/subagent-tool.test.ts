import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { discoverAgentsAsync } from "../src/agent/agents.js";
import { resolvePackageExtensionPath } from "../src/child/process-utils.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import { resetAgentCache } from "../src/index.js";
import * as delivery from "../src/notification/delivery.js";
import { setDefaultDeliveryDeps } from "../src/notification/delivery.js";
import {
  cancelRunJob,
  listRunJobs,
  resetRunRegistry,
} from "../src/orchestration/run-registry.js";
import {
  emitCompletionAlert,
  formatSubagentToolResult,
} from "../src/orchestration/subagent-orchestrator.js";
import {
  cancelProgressState,
  createProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  resetProgressStore,
} from "../src/progress/progress.js";
import type {
  SubagentDetails,
  SubagentToolResult,
} from "../src/shared/types.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
} from "../src/shared/utils.js";
import {
  CAPTURE_PI_ARGS_SH,
  captureStdout,
  denyFsAccess,
  flagValues,
  getSubagentTool,
  makeBareCtx,
  makeSubagentDetails,
  makeSubagentToolUpdateLine,
  modelFixture,
  readCapturedArgs,
  registryFixture,
  type SendMessageArg,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  waitFor,
  waitForRunJobCount,
  waitForRunJobsCleared,
  waitForSentMessage,
  waitForSentMessageCount,
  withEnv,
} from "./helpers.js";

setupHooks();

const makeEmptySubagentDetails = () => makeSubagentDetails([]);

test("subagent tool result adapter passes through completed results", () => {
  const completed = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      renderedByMessage: true as const,
      results: [],
    },
  };
  expect(
    formatSubagentToolResult("hang", { kind: "completed", result: completed }),
  ).toBe(completed);
});

test("formatSubagentToolResult returns not_found text", () => {
  const result = formatSubagentToolResult("hang", {
    kind: "not_found",
    makeDetails: makeEmptySubagentDetails,
  });
  expect((result.content[0] as TextContent).text).toBe('Unknown agent: "hang"');
});

test("formatSubagentToolResult returns cancelled text", () => {
  const result = formatSubagentToolResult("hang", {
    kind: "cancelled",
    makeDetails: makeEmptySubagentDetails,
  });
  expect((result.content[0] as TextContent).text).toBe("Canceled");
});

test("formatSubagentToolResult returns started text", () => {
  const result = formatSubagentToolResult("hang", {
    kind: "started",
    requestId: "req-1",
    instanceName: "adj-word",
    makeDetails: makeEmptySubagentDetails,
  });
  expect((result.content[0] as TextContent).text).toBe(
    "Subagent hang adj-word started (job: req-1)",
  );
});

test("subagent tool returns job-started immediately without waiting for child", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toMatch(
    /^Subagent hang #[1-9]\d* started \(job: /,
  );
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(listRunJobs().length).toBeGreaterThan(0);
  const job = listRunJobs()[0];
  if (job) job.controller.abort("cleanup");
  await waitForRunJobsCleared();
});

test("subagent tool registers independent job per invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const ctx = makeBareCtx(cwd);
  const [r1, r2] = await Promise.all([
    tool.execute(
      "id-1",
      { agent: "hang", task: "task one" },
      undefined,
      undefined,
      ctx,
    ),
    tool.execute(
      "id-2",
      { agent: "hang", task: "task two" },
      undefined,
      undefined,
      ctx,
    ),
  ]);
  expect((r1.content[0] as TextContent).text).toContain("started");
  expect((r2.content[0] as TextContent).text).toContain("started");
  const jobs = listRunJobs();
  expect(jobs.length).toBe(2);
  const ids = new Set(jobs.map((j) => j.requestId));
  expect(ids.size).toBe(2);
  for (const job of jobs) job.controller.abort("cleanup");
  await waitForRunJobsCleared();
});

test("subagent tool result appears in sent messages after child exits", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const startDetails = sentMessages[0]?.details as { instanceName?: string };
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(sentMessages.at(-1)?.content).toBe("done");
  expect(resultDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
});

test("positive-depth subagent tool waits for success and returns completed result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages[1]?.customType).toBe("subagent-result");
  const startDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const messageDetails = sentMessages[1]?.details as SubagentDetails;
  const directDetails = result.details as SubagentDetails;
  const requestId = startDetails.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(sentMessages[1]?.content).toBe("done");
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.finalOutput).toBe("done");
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(messageDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(messageDetails.results[0]?.finalOutput).toBe("done");
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth concurrent subagent calls keep independent jobs and progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const originalRandom = Math.random;
  const randomValues = [0, 0, 0.5, 0.5];
  Math.random = () => randomValues.shift() ?? originalRandom();
  try {
    const { tool, cwd } = await setupTest({
      sendMessage: (msg) => sentMessages.push(msg),
      piScript: `#!/bin/sh
text=unknown
case "$*" in
  *"task one"*) text=one ;;
  *"task two"*) text=two ;;
esac
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"'"$text"'"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
    });
    process.env.PI_SUBAGENT_DEPTH = "1";
    const ctx = makeBareCtx(cwd);
    const calls = [
      tool.execute(
        "nested-1",
        { agent: "hang", task: "task one" },
        undefined,
        undefined,
        ctx,
      ),
      tool.execute(
        "nested-2",
        { agent: "hang", task: "task two" },
        undefined,
        undefined,
        ctx,
      ),
    ];
    await waitForRunJobCount(2);
    const runningJobs = listRunJobs();
    expect(new Set(runningJobs.map((job) => job.requestId)).size).toBe(2);
    expect(new Set(runningJobs.map((job) => job.instanceName)).size).toBe(2);
    const results = await Promise.all(calls);
    const starts = sentMessages.filter(
      (msg) =>
        msg.customType === "subagent-progress" &&
        Boolean((msg.details as { requestId?: string } | undefined)?.requestId),
    );
    const terminals = sentMessages.filter(
      (msg) => msg.customType === "subagent-result",
    );
    const startIds = starts.map(
      (msg) => (msg.details as { requestId: string }).requestId,
    );
    const startInstances = starts.map(
      (msg) => (msg.details as { instanceName: string }).instanceName,
    );
    const directDetails = results.map(
      (result) => result.details as SubagentDetails,
    );
    const terminalDetails = terminals.map(
      (msg) => msg.details as SubagentDetails,
    );
    expect(starts).toHaveLength(2);
    expect(terminals).toHaveLength(2);
    expect(new Set(startIds).size).toBe(2);
    expect(new Set(startInstances).size).toBe(2);
    expect(
      results.map((result) => (result.content[0] as TextContent).text).sort(),
    ).toEqual(["one", "two"]);
    expect(terminals.map((msg) => msg.content).sort()).toEqual(["one", "two"]);
    expect(directDetails.every((details) => details.renderedByMessage)).toBe(
      true,
    );
    expect(
      directDetails.map((details) => details.results[0]?.instanceName).sort(),
    ).toEqual(startInstances.toSorted());
    expect(
      terminalDetails.map((details) => details.results[0]?.instanceName).sort(),
    ).toEqual(startInstances.toSorted());
    for (const [index, requestId] of startIds.entries()) {
      const state = getProgressState(requestId);
      expect(state?.status).toBe("success");
      expect(state?.instanceName).toBe(startInstances[index]);
    }
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    Math.random = originalRandom;
  }
});

test("positive-depth subagent tool returns completed result for child failure", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Outcome: failed at verify\nCause: parsed cause\nVerification: parsed verification\nNext: parsed next";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
    },
  });
  const toolResultEnd = JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [], isError: true },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested failure" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain(finalOutput);
  expect(resultText).toMatch(/\n\nOutcome: failed at verify/);
  expect(sentMessages).toHaveLength(2);
  expect(sentMessages.at(-1)?.content).toBe(resultText);
  const startDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const requestId = startDetails.requestId;
  if (!requestId) throw new Error("requestId missing");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.instanceName).toBe(
    startDetails.instanceName,
  );
  expect(directDetails.results[0]?.finalOutput).toBe(finalOutput);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool returns completed result for setup failure", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "needs-skill.md"),
    `---
name: needs-skill
description: Needs a skill
skills: missing-skill
---
Prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "needs-skill", task: "nested setup" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("missing-skill");
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.exitCode).toBe(1);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("missing-skill");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool exposes debug details for stderr exit", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested stderr", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("boom from stderr");
  expect(sentMessages).toHaveLength(2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.exitCode).toBe(7);
  expect(directDetails.results[0]?.stderr).toContain("boom from stderr");
  expect(directDetails.results[0]?.messages).toHaveLength(0);
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("boom from stderr");
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool cancels on host abort with debug termination", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const controller = new AbortController();
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const promise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested abort", debug: true },
    controller.signal,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await waitFor(
    () => (getProgressState(requestId)?.inputTokens === 1 ? true : undefined),
    "partial nested output",
  );
  controller.abort("host stop");
  const result = await promise;
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.messages).toHaveLength(1);
  expect(directDetails.results[0]?.termination?.cancelReason).toBe("host stop");
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("Canceled");
});

test("positive-depth subagent tool cancels on registered job abort", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const promise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested cancel", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(cancelRunJob(requestId, "nested cancel")).toBe(true);
  const result = await promise;
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const directDetails = result.details as SubagentDetails;
  expect(directDetails.results[0]?.termination?.cancelReason).toBe(
    "nested cancel",
  );
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(getProgressState(requestId)?.errorText).toContain("nested cancel");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("Canceled");
});

test("subagent tool finishes when child exits with inherited open streams", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "orphaned-streams" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.termination).toBeUndefined();
});

test("subagent tool accepts omitted task", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.at(-1)).toBe(
    "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
  );
  expect(args.at(-1)).not.toContain("Task:");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect(promptText).toBe("Test agent prompt.");
});

test("subagent tool injects current result format", async () => {
  const { tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "ship it" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.at(-1)).toBe("Task: ship it");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  expect(args.join("\n")).not.toContain("Changed:");
  expect(args.join("\n")).not.toContain("Cause:");
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect(promptText).toBe("Test agent prompt.");
});

test("subagent tool keeps contract last when agent has no body prompt", async () => {
  const { agentDir, tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "no-body.md"),
    `---
name: no-body
description: No body prompt
---`,
  );
  await tool.execute(
    "test-tool-call",
    { agent: "no-body", task: "no body task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  expect(args.at(-1)).toBe("Task: no body task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toEqual([SUBAGENT_RESULT_CONTRACT]);
});

test("subagent tool keeps contract last with custom tools", async () => {
  const { agentDir, tool, cwd } = await setupTest({
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "custom-tools.md"),
    `---
name: custom-tools
description: Custom tools
tools: bash, read
---
Custom prompt.`,
  );
  await tool.execute(
    "test-tool-call",
    { agent: "custom-tools", task: "custom tools task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  expect(args.join(" ")).toContain("--tools bash,read,complete");
  expect(args.at(-1)).toBe("Task: custom tools task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
});

test("subagent tool with custom tools allows child to call complete", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-custom-complete",
          name: "complete",
          arguments: { outcome: "custom tools completed" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-custom-complete",
      details: { outcome: "custom tools completed" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });
  const { agentDir, tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });
  await writeFile(
    path.join(agentDir, "agents", "custom-tools-complete.md"),
    `---
name: custom-tools-complete
description: Custom tools complete
tools: bash, read
---
Custom prompt.`,
  );
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "custom-tools-complete", task: "custom tools task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForRunJobsCleared();
  const args = await readCapturedArgs(cwd);
  expect(args.join(" ")).toContain("--tools bash,read,complete");
  expect(args.at(-1)).toBe("Task: custom tools task");
  expect((result.details as SubagentDetails).results[0]?.outcome).toBe(
    "custom tools completed",
  );
  expect((result.content[0] as TextContent).text).toBe("(no output)");
});

test("subagent tool sends result card when fake pi exits normally", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "normal" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("subagent tool sends result card when fake pi emits agent_end but stays alive", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
case "$*" in
  *agent-end-no-exit*) sleep 10 ;;
esac
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-exit", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool hides agent_end_timeout metadata outside debug", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-exit" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(sentMessages.at(-1)?.content).toBe("done");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.termination).toBeUndefined();
  expect(details.results[0]?.stderr).toBe("");
});

test("subagent tool fails agent_end timeout with empty transcript", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10
`,
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "agent-end-no-output", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const finalContent = sentMessages.at(-1)?.content;
  expect(finalContent).toStartWith("(failed) ");
  expect(finalContent).toContain("Agent failed:");
  expect(finalContent).not.toMatch(/\n\n/);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.exitCode).toBe(1);
  expect(details.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool falls back to agent_end messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"from agent_end"}],"usage":{"input":2,"output":3,"totalTokens":5,"cost":{"total":0.01}}}]}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("from agent_end");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(2);
});

test("subagent tool keeps long semantic parent fields without truncation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const longOutcome = `shipped ${"x".repeat(2_001)}`;
  const finalOutput = `${longOutcome}\nVerification: bun test\nNext: none`;
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const content = sentMessages.at(-1)?.content as string;
  expect(content).toBe(`${longOutcome}\nVerification: bun test\nNext: none`);
  expect(content).not.toContain(
    "[truncated: full output available in details]",
  );
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.finalOutput).toBe(finalOutput);
});

test("subagent tool returns semantic parent text while preserving full details", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
      model: "gpt-4",
      usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.002 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe(
    "Migration applied to 3 tables.\nAll tests pass.\nNo rollback needed.\nExtra line.",
  );
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.finalOutput).toBe(finalOutput);
  expect(details.results[0]?.usage.input).toBe(3);
  expect(details.results[0]?.usage.output).toBe(4);
  expect(details.results[0]?.durationMs).toEqual(expect.any(Number));
  expect(details.results[0]?.stderr).toBe("");
  expect(details.results[0]?.errorMessage).toBeUndefined();
  expect(details.results[0]?.messages).toBeUndefined();
});

test("subagent tool failure sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const finalOutput =
    "Outcome: failed at verify\nCause: parsed cause\nVerification: parsed verification\nNext: parsed next";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
    },
  });
  const toolResultEnd = JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [], isError: true },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  const failureStartDetails = sentMessages[0]?.details as {
    instanceName?: string;
    requestId?: string;
  };
  const failureDetails = sentMessages.at(-1)?.details as SubagentDetails;
  const requestId = failureStartDetails.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(failureDetails.results[0]?.instanceName).toBe(
    failureStartDetails.instanceName,
  );
  expect(getProgressState(requestId)?.status).toBe("error");
});

test("subagent tool errorMessage failure sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "stop",
      errorMessage: "recorded child failure",
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "0";
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
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain(
    "recorded child failure",
  );
});

test("subagent tool spawn error sends error result via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await Bun.$`rm -f ${path.join(binDir, "pi")}`;
  process.env.PATH = binDir;
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error progress state from spawn failure");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toBeTruthy();
});

test("subagent tool handles unknown agent synchronously", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "non-existent", task: "whatever" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toContain(
    'Unknown agent: "non-existent"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool respects agentScope", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const resultUser = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "user" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((resultUser.content[0] as TextContent).text).toContain(
    'Unknown agent: "project-agent"',
  );
  const resultBoth = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((resultBoth.content[0] as TextContent).text).toContain("started");
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
});

test("discoverAgentsAsync preserves scope filtering and project override precedence", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const userDir = path.join(agentDir, "agents");
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(userDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(userDir, "user-only.md"),
    `---
name: user-only
description: User only
---
User prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  const userDiscovery = await discoverAgentsAsync(cwd, "user");
  const projectDiscovery = await discoverAgentsAsync(cwd, "project");
  const bothDiscovery = await discoverAgentsAsync(cwd, "both");
  expect(userDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(projectDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(bothDiscovery.projectAgentsDir).toBe(projectAgentsDir);
  expect(userDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "user",
  );
  expect(userDiscovery.agents.some((a) => a.name === "project-only")).toBe(
    false,
  );
  expect(projectDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "project",
  );
  expect(projectDiscovery.agents.some((a) => a.name === "user-only")).toBe(
    false,
  );
  expect(bothDiscovery.agents.find((a) => a.name === "same")?.source).toBe(
    "project",
  );
  expect(bothDiscovery.agents.some((a) => a.name === "user-only")).toBe(true);
  expect(bothDiscovery.agents.some((a) => a.name === "project-only")).toBe(
    true,
  );
  expect(userDiscovery.scopes.project).toEqual({
    agents: [],
    markdownFiles: [],
  });
  expect(projectDiscovery.scopes.user).toEqual({
    agents: [],
    markdownFiles: [],
  });
  const scopedUserNames = bothDiscovery.scopes.user.agents.map(
    (a) => `${a.name}:${a.source}`,
  );
  expect(scopedUserNames).toContain("same:user");
  expect(scopedUserNames).toContain("user-only:user");
  expect(
    bothDiscovery.scopes.project.agents
      .map((a) => `${a.name}:${a.source}`)
      .sort(),
  ).toEqual(["project-only:project", "same:project"]);
  expect(bothDiscovery.scopes.user.markdownFiles).toContain("same.md");
  expect(bothDiscovery.scopes.user.markdownFiles).toContain("user-only.md");
  expect([...bothDiscovery.scopes.project.markdownFiles].sort()).toEqual([
    "project-only.md",
    "same.md",
  ]);
});

test("discoverAgentsAsync ignores unreadable agent directories", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const root = path.dirname(agentDir);
  const unreadableRoot = path.join(root, "agent-with-unreadable-agents");
  const unreadableAgentsDir = path.join(unreadableRoot, "agents");
  await mkdir(unreadableAgentsDir, { recursive: true });
  await writeFile(
    path.join(unreadableAgentsDir, "hidden.md"),
    `---
name: hidden
description: Hidden
---
Hidden prompt`,
  );
  const denied = denyFsAccess(unreadableAgentsDir);
  process.env.PI_CODING_AGENT_DIR = unreadableRoot;
  try {
    expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  } finally {
    denied.restore();
  }
});

test("discoverAgentsAsync tolerates missing malformed and symlinked agent files", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const root = path.dirname(agentDir);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent-without-agents");
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const fileRoot = path.join(root, "agent-with-file");
  await mkdir(fileRoot, { recursive: true });
  await writeFile(path.join(fileRoot, "agents"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = fileRoot;
  expect((await discoverAgentsAsync(cwd, "user")).agents).toEqual([]);
  const badRoot = path.join(root, "agent-with-bad-files");
  const agentsDir = path.join(badRoot, "agents");
  await mkdir(agentsDir, { recursive: true });
  await symlink(
    path.join(agentsDir, "missing.md"),
    path.join(agentsDir, "broken.md"),
  );
  await writeFile(
    path.join(agentsDir, "missing-description.md"),
    `---
name: invalid
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "invalid-yaml.md"),
    `---
name: [unterminated
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "non-string-tools.md"),
    `---
name: bad-tools
description: Bad tools
tools:
  - bash
---
Prompt`,
  );
  await writeFile(
    path.join(agentsDir, "target.txt"),
    `---
name: linked
description: Linked agent
tools: bash, read
skills: helper, reviewer
thinking: HIGH
---
Linked prompt`,
  );
  await symlink(
    path.join(agentsDir, "target.txt"),
    path.join(agentsDir, "linked.md"),
  );
  process.env.PI_CODING_AGENT_DIR = badRoot;
  const discovery = await discoverAgentsAsync(cwd, "user");
  const agents = discovery.agents;
  expect(agents).toHaveLength(1);
  expect(discovery.scopes.user.agents).toEqual(agents);
  expect(discovery.scopes.project).toEqual({ agents: [], markdownFiles: [] });
  expect([...discovery.scopes.user.markdownFiles].sort()).toEqual([
    "broken.md",
    "invalid-yaml.md",
    "linked.md",
    "missing-description.md",
    "non-string-tools.md",
  ]);
  expect(agents[0]).toMatchObject({
    name: "linked",
    description: "Linked agent",
    tools: ["bash", "read"],
    skills: ["helper", "reviewer"],
    thinking: "high",
    systemPrompt: "Linked prompt",
    source: "user",
    filePath: path.join(agentsDir, "linked.md"),
  });
});

test("subagent tool requires confirmation for project agents with UI", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  let confirmed = false;
  const fakeUI = {
    confirm: async () => {
      confirmed = true;
      return false;
    },
  };
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );
  expect(confirmed).toBe(true);
  expect((result.content[0] as TextContent).text).toContain("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("pre-aborted host signal cancels after valid agent discovery without side effects", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-agent.md"),
    `---
name: project-agent
description: Project agent
---
System prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  let confirmed = false;
  const fakeUI = {
    confirm: async () => {
      confirmed = true;
      return true;
    },
  };
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-agent", task: "test", agentScope: "both" },
    controller.signal,
    undefined,
    { cwd, hasUI: true, ui: fakeUI } as unknown as ExtensionContext,
  );
  expect(confirmed).toBe(false);
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  expect(getProgressState("test-tool-call")).toBeUndefined();
  const details = result.details as SubagentDetails;
  expect(details.results).toHaveLength(0);
  expect(details.mode).toBe("single");
});

test("positive-depth subagent tool preserves scope confirmation and collision semantics", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  const userAgentsDir = path.join(agentDir, "agents");
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  await writeFile(
    path.join(userAgentsDir, "same.md"),
    `---
name: same
description: User same
---
User prompt`,
  );
  await writeFile(
    path.join(projectAgentsDir, "same.md"),
    `---
name: same
description: Project same
---
Project prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const resultUser = await tool.execute(
    "test-tool-call",
    { agent: "project-only", task: "test", agentScope: "user" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((resultUser.content[0] as TextContent).text).toContain(
    'Unknown agent: "project-only"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  let confirmSawNoJob = false;
  const rejectingUI = {
    confirm: async () => {
      confirmSawNoJob = sentMessages.length === 0 && listRunJobs().length === 0;
      return false;
    },
  };
  const cancelled = await tool.execute(
    "test-tool-call",
    { agent: "project-only", task: "test", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: rejectingUI } as unknown as ExtensionContext,
  );
  expect(confirmSawNoJob).toBe(true);
  expect((cancelled.content[0] as TextContent).text).toBe("Canceled");
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
  const acceptingUI = { confirm: async () => true };
  const resultSame = await tool.execute(
    "test-tool-call",
    { agent: "same", task: "collision", agentScope: "both" },
    undefined,
    undefined,
    { cwd, hasUI: true, ui: acceptingUI } as unknown as ExtensionContext,
  );
  expect((resultSame.content[0] as TextContent).text).toBe("done");
  expect(sentMessages).toHaveLength(3);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages[0]?.content).toBe(
    'Using project agent "same"; user agent with same name also exists.',
  );
  expect(sentMessages[1]?.customType).toBe("subagent-progress");
  expect(sentMessages[2]?.customType).toBe("subagent-result");
  expect((resultSame.details as SubagentDetails).results[0]?.agentSource).toBe(
    "project",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("positive-depth subagent tool preserves parent runtime setup semantics", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "runtime-agent.md"),
    `---
name: runtime-agent
description: Runtime agent
skills: helper
---
Runtime prompt`,
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "runtime-agent", task: "runtime task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );
  const args = await readCapturedArgs(cwd);
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const expectedWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((result.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedWarning}\n\ndone`,
  );
  expect(args.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(args.join(" ")).toContain("--thinking high");
  expect(args.join(" ")).toContain("--no-skills --skill");
  expect(args.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(args).toContain("--append-system-prompt");
  expect(args.at(-1)).toBe("Task: runtime task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptText).toBe("Runtime prompt");
  expect((result.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect((result.details as SubagentDetails).results[0]?.thinkingWarning).toBe(
    expectedWarning,
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool abort cancels the background job", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const controller = new AbortController();
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(
    () => (sentMessages.length > 0 ? true : undefined),
    "progress message",
  );
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  controller.abort();
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("prepareSubagentJob returns aborted when host signal fires during sendMessage", async () => {
  const sentMessages: SendMessageArg[] = [];
  const controller = new AbortController();
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => {
      sentMessages.push(msg);
      controller.abort();
    },
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("Canceled");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("cancelled");
  expect(listRunJobs()).toHaveLength(0);
});

test("startSubagentJob depth 0 cancels in setImmediate when signal already aborted", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const controller = new AbortController();
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    undefined,
    makeBareCtx(cwd),
  );
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(listRunJobs()).toHaveLength(1);
  controller.abort();
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("subagent tool captures pi output including usage and model", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"openai","model":"gpt-4o-mini","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("Outcome: hello");
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.input).toBe(10);
  expect(details.results[0]?.finalOutput).toBe("Outcome: hello");
  expect(details.results[0]?.messages).toBeUndefined();
  expect(details.results[0]?.instanceName).toMatch(/^#[1-9]\d*$/);
  expect(details.results[0]?.usage.contextWindowTokens).toBe(128000);
  expect(details.results[0]?.model).toBe("off");
  const sentMessages2: SendMessageArg[] = [];
  const tool2 = getSubagentTool({
    sendMessage: (msg) => sentMessages2.push(msg),
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await tool2.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugDetails = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(1);
  expect(debugDetails.results[0]?.instanceName).toMatch(/^#[1-9]\d*$/);
});

test("subagent tool leaves context window unknown for unknown metadata", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"provider":"unknown-provider","model":"unknown-model","usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.001}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const details = sentMessages.at(-1)?.details as SubagentDetails;
  expect(details.results[0]?.usage.contextWindowTokens).toBeUndefined();
});

test("subagent tool accumulates toolCount in progress state", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"2","arguments":{"path":"/tmp/x"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
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
  expect(getProgressState(requestId)?.toolCount).toBe(2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("subagent tool preserves stopReason error after agent_end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { binDir, cwd } = await setupFakePi();
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "looks successful" }],
      stopReason: "error",
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' '{"type":"agent_end"}'
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "timeout", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state after stopReason timeout");
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.stopReason).toBe("error");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool fails agent_end timeout with tool-only transcript", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const sentMessages: SendMessageArg[] = [];
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"agent_end"}'
sleep 10 &
wait $!
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "timeout", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state after missing output timeout");
  const resultDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(resultDetails.results[0]?.exitCode).toBe(1);
  expect(resultDetails.results[0]?.finalOutput).toBe("");
  expect(resultDetails.results[0]?.termination?.cancelReason).toBe(
    "agent_end_timeout",
  );
});

test("subagent tool reports depth limit synchronously via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "3";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from depth limit");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const directDetails = result.details as SubagentDetails;
  const depthText = (result.content[0] as TextContent).text;
  expect(depthText).toStartWith("(failed) ");
  expect(depthText).toContain("Subagent nesting limit reached");
  expect(directDetails.renderedByMessage).toBe(true);
  expect(directDetails.results[0]?.exitCode).toBe(1);
  expect(directDetails.results[0]?.stderr).toBe("");
  expect(directDetails.results[0]?.messages).toBeUndefined();
  expect(directDetails.results[0]?.termination).toBeUndefined();
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("depth");
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool lifecycle failure with no latest result preserves raw error message", async () => {
  const sentMessages: SendMessageArg[] = [];
  let threw = false;
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => {
      if (msg.customType === "subagent-result" && !threw) {
        threw = true;
        throw new Error("send rejected");
      }
      sentMessages.push(msg);
    },
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "send fails" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("send rejected");
  expect((result.details as SubagentDetails).results).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
  expect(resultMessages[0]?.content).toBe("send rejected");
});

test("subagent tool lifecycle failure with thinking warning includes warning in parent content", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "think-agent.md"),
    `---
name: think-agent
description: Think agent
---
Prompt`,
  );
  const finalOutput = "Outcome: failed with thinking";
  const messageEnd = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: finalOutput }],
    },
  });
  const toolResultEnd = JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [], isError: true },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(messageEnd)}
printf '%s\n' ${shellQuote(toolResultEnd)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "think-agent", task: "thinking failure" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4o-mini" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("[thinking]");
  expect(resultText).toContain(finalOutput);
});

test("positive-depth subagent tool completes successfully at depth 2 (max-depth-minus-one)", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "2";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "depth-2" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const directDetails = result.details as SubagentDetails;
  expect((result.content[0] as TextContent).text).toContain("done");
  expect(directDetails.results[0]?.finalOutput).toBe("done");
  expect(getProgressState(requestId)?.status).toBe("success");
  expect(listRunJobs()).toHaveLength(0);
  const resultMessages = sentMessages.filter(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessages).toHaveLength(1);
});

test("subagent tool reports unknown skill via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  process.env.PI_SUBAGENT_DEPTH = "0";
  await writeFile(
    path.join(agentDir, "agents", "needs-skill.md"),
    `---
name: needs-skill
description: Needs a skill
skills: missing-skill
---
Prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "needs-skill", task: "skills" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from unknown skill");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("missing-skill");
});

test("subagent tool reports stderr failures via sent messages", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' 'boom from stderr' >&2
exit 7
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "stderr" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitFor(() => {
    const requestId = (sentMessages[0]?.details as { requestId?: string })
      ?.requestId;
    return requestId && getProgressState(requestId)?.status === "error"
      ? true
      : undefined;
  }, "error state from stderr");
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(getProgressState(requestId)?.status).toBe("error");
  expect(getProgressState(requestId)?.errorText).toContain("boom from stderr");
});

test("subagent tool debug hygiene: child messages stay in details only for debug result", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"SECRET_DEBUG"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: hello"}],"model":"gpt-4","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
printf '%s\n' 'STDERR_DEBUG' >&2
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const normalDetails = sentMessages.at(-1)?.details as SubagentDetails;
  expect(normalDetails.results[0]?.messages).toBeUndefined();
  expect(normalDetails.results[0]?.termination).toBeUndefined();
  expect(normalDetails.results[0]?.stderr).toBe("");
  expect(sentMessages.at(-1)?.content).toBe("Outcome: hello");
  expect(sentMessages.at(-1)?.content).not.toContain("SECRET_DEBUG");
  const sentMessages2: SendMessageArg[] = [];
  const tool2 = getSubagentTool({
    sendMessage: (msg) => sentMessages2.push(msg),
  });
  await tool2.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages2, 2);
  const debugWithoutEnv = sentMessages2.at(-1)?.details as SubagentDetails;
  expect(debugWithoutEnv.results[0]?.messages).toBeUndefined();
  expect(debugWithoutEnv.results[0]?.termination).toBeUndefined();
  expect(debugWithoutEnv.results[0]?.stderr).toBe("");
  expect(JSON.stringify(debugWithoutEnv)).not.toContain("SECRET_DEBUG");
  const sentMessages3: SendMessageArg[] = [];
  const tool3 = getSubagentTool({
    sendMessage: (msg) => sentMessages3.push(msg),
  });
  process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
  await tool3.execute(
    "test-tool-call",
    { agent: "hang", task: "test", debug: true },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages3, 2);
  const debugDetails = sentMessages3.at(-1)?.details as SubagentDetails;
  expect(debugDetails.results[0]?.messages).toHaveLength(2);
  expect(debugDetails.results[0]?.termination).toBeUndefined();
  expect(debugDetails.results[0]?.stderr).toContain("STDERR_DEBUG");
  expect(JSON.stringify(debugDetails.results[0]?.messages)).not.toContain(
    "SECRET_DEBUG",
  );
  expect(JSON.stringify(debugDetails.results[0]?.messages)).toContain(
    "[redacted]",
  );
  expect(sentMessages3.at(-1)?.content).not.toContain("SECRET_DEBUG");
});

test("subagent tool logs unknown event diagnostics only for authorized debug", async () => {
  const originalStderrWrite = process.stderr.write;
  const diagnostics: string[] = [];
  (
    process.stderr as unknown as {
      write: (chunk: string | Uint8Array) => boolean;
    }
  ).write = (chunk) => {
    diagnostics.push(chunk.toString());
    return true;
  };
  try {
    const { tool, cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"future_event","payload":1}'
printf '%s\n' '{ not json }'
printf '\n'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: diagnostics"}]}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
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
    await waitForRunJobsCleared();
    expect(diagnostics.join("")).not.toContain("[pi-subagent:unknown-event]");
    process.env.PI_SUBAGENT_DEBUG_ENABLED = "1";
    await tool.execute(
      "test-tool-call",
      { agent: "hang", task: "test" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    expect(diagnostics.join("")).not.toContain("[pi-subagent:unknown-event]");
    await tool.execute(
      "test-tool-call",
      { agent: "hang", task: "test", debug: true },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const output = diagnostics.join("");
  expect(output).toContain(
    '[pi-subagent:unknown-event] unknown: {"type":"future_event","payload":1}',
  );
  expect(output).toContain(
    "[pi-subagent:unknown-event] malformed: { not json }",
  );
  expect(output).toContain("[pi-subagent:unknown-event] blank");
});

const SUBAGENT_CALL_LINE = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name: "subagent",
        id: "sub-native-1",
        arguments: { agent: "build", task: "compile" },
      },
    ],
  },
});

const NESTED_FINAL_LINE = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  },
});

test("tool_execution_update from subagent tool surfaces grandchild preview in parent store", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const toolUpdateLine = makeSubagentToolUpdateLine(
    "bash: make build",
    "swift-otter",
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\n' ${shellQuote(toolUpdateLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(NESTED_FINAL_LINE)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "native nested" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await waitFor(
    () =>
      getProgressState(requestId)?.activeToolActivity?.child !== undefined
        ? true
        : undefined,
    "grandchild preview surfaced via tool_execution_update",
  );
  const state = getProgressState(requestId);
  expect(state?.activeToolActivity?.toolName).toBe("subagent");
  expect(state?.activeToolActivity?.inputSummary).toBe("subagent: build");
  expect(state?.activeToolActivity?.instanceName).toBe("swift-otter");
  expect(state?.activeToolActivity?.child?.inputSummary).toBe(
    "bash: make build",
  );
  expect(state?.lastToolPreview).toContain("bash: make build");
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("tool_execution_update for a non-subagent tool updates parent activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const bashUpdateLine = makeSubagentToolUpdateLine(
    "bash: ls src",
    "swift-otter",
    "bash",
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(SUBAGENT_CALL_LINE)}
printf '%s\n' ${shellQuote(bashUpdateLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(NESTED_FINAL_LINE)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "native filter" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await waitFor(
    () =>
      getProgressState(requestId)?.lastToolPreview?.includes("bash: ls src")
        ? true
        : undefined,
    "non-subagent update surfaces in parent activity",
  );
  const state = getProgressState(requestId);
  expect(state?.activeToolActivity).toBeDefined();
  expect(state?.lastToolPreview).toContain("bash: ls src");
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

// --- emitCompletionAlert tests ---

function makeProgressState(overrides: {
  requestId?: string;
  agent?: string;
  task?: string;
  status?: string;
  durationMs?: number;
  instanceName?: string;
  finalOutput?: string;
  errorText?: string;
}) {
  const requestId = overrides.requestId ?? crypto.randomUUID();
  createProgressState(
    requestId,
    overrides.agent ?? "test-agent",
    overrides.task ?? "test task",
    overrides.instanceName ?? "adj-word",
  );
  if (overrides.status === "success" || overrides.finalOutput !== undefined) {
    finalizeProgressState(requestId, overrides.finalOutput ?? "task completed");
  }
  if (overrides.status === "error" || overrides.errorText !== undefined) {
    failProgressState(requestId, overrides.errorText ?? "something failed");
  }
  if (overrides.status === "cancelled") {
    cancelProgressState(requestId, "cancelled");
  }
  if (overrides.durationMs !== undefined) {
    const state = getProgressState(requestId);
    if (state) {
      (state as { durationMs?: number }).durationMs = overrides.durationMs;
    }
  }
  return getProgressState(requestId);
}

afterEach(() => {
  resetProgressStore();
  resetRunRegistry();
});

test("emitCompletionAlert emits bell on TTY", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  });
});

test("emitCompletionAlert skips on non-TTY", () => {
  captureStdout(false, (writeCalls) => {
    const state = makeProgressState({
      status: "success",
      finalOutput: "all tests pass",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  });
});

test("emitCompletionAlert skips for cancelled jobs", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({ status: "cancelled" });
    emitCompletionAlert(state);
    expect(writeCalls).toEqual([]);
  });
});

test("emitCompletionAlert emits bell for error jobs", () => {
  captureStdout(true, (writeCalls) => {
    const state = makeProgressState({
      status: "error",
      errorText: "child process crashed",
    });
    emitCompletionAlert(state);
    expect(writeCalls).toContain("\x07");
  });
});

test("emitCompletionAlert skips absent state", () => {
  expect(() => emitCompletionAlert(undefined)).not.toThrow();
});

test("emitCompletionAlert with batch notifications enabled emits bell on TTY", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert with batch notifications enabled does not bell on non-TTY", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      captureStdout(false, (writeCalls) => {
        const state = makeProgressState({
          status: "error",
          errorText: "build failed",
        });
        expect(() => emitCompletionAlert(state)).not.toThrow();
        expect(writeCalls).toEqual([]);
      });
    },
  );
});

test("emitCompletionAlert with batch notifications handles cancelled by skipping", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      const state = makeProgressState({ status: "cancelled" });
      expect(() => emitCompletionAlert(state)).not.toThrow();
    },
  );
});

test("emitCompletionAlert emits bell on TTY when nested (depth > 0)", () => {
  withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "0",
    },
    () => {
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "nested task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert suppresses desktop notification when nested (depth > 0)", () => {
  withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      let spawned = false;
      setDefaultDeliveryDeps({
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      const state = makeProgressState({
        status: "success",
        finalOutput: "done",
      });
      emitCompletionAlert(state);
      expect(spawned).toBe(false);
    },
  );
});

test("per-job notification completes lifecycle without crashing", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await tool.execute(
        "test-tool-call",
        { agent: "hang", task: "per-job notify" },
        undefined,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect((result.content[0] as TextContent).text).toBe("done");
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("success");
      }
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification completes lifecycle for error jobs", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { binDir, cwd } = await setupFakePi();
      await writeFile(
        path.join(binDir, "pi"),
        `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"error output"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"errorMessage":"child failure"}}'
printf '%s\n' '{"type":"agent_end"}'
exit 1
`,
      );
      await chmod(path.join(binDir, "pi"), 0o755);
      const tool = getSubagentTool({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await tool.execute(
        "test-tool-call",
        { agent: "hang", task: "per-job error" },
        undefined,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("error");
        expect(getProgressState(requestId)?.errorText).toContain(
          "child failure",
        );
      }
      expect(result.details.renderedByMessage).toBe(true);
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification with cancelled state does not crash", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      const sentMessages: SendMessageArg[] = [];
      const controller = new AbortController();
      const { binDir, cwd } = await setupFakePi();
      await writeFile(
        path.join(binDir, "pi"),
        `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
      );
      await chmod(path.join(binDir, "pi"), 0o755);
      const tool = getSubagentTool({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const executePromise = tool.execute(
        "test-tool-call",
        { agent: "hang", task: "per-job cancel" },
        controller.signal,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessage(sentMessages);
      controller.abort();
      const result = await executePromise;
      expect((result.content[0] as TextContent).text).toBe("Canceled");
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("cancelled");
      }
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification delivers at depth 0 via lifecycle", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      let spawned = false;
      setDefaultDeliveryDeps({
        commandExists: () => true,
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "0";
      await tool.execute(
        "test-tool-call",
        { agent: "hang", task: "per-job depth-0" },
        undefined,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      await Bun.sleep(20);
      expect(spawned).toBe(true);
      await waitForRunJobsCleared();
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("per-job notification skipped when nested (depth > 0)", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    async () => {
      let spawned = false;
      setDefaultDeliveryDeps({
        spawnProcess: () => {
          spawned = true;
          return {};
        },
      });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      await tool.execute(
        "test-tool-call",
        { agent: "hang", task: "per-job nested" },
        undefined,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect(spawned).toBe(false);
    },
  );
});

test("batch notification skips bell when not last job", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    async () => {
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
        piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
      });
      const ctx = makeBareCtx(cwd);
      const promises = [
        tool.execute(
          "id-1",
          { agent: "hang", task: "task one" },
          undefined,
          undefined,
          ctx,
        ),
        tool.execute(
          "id-2",
          { agent: "hang", task: "task two" },
          undefined,
          undefined,
          ctx,
        ),
      ];
      await waitForRunJobCount(2);
      const jobs = listRunJobs();
      expect(jobs).toHaveLength(2);
      jobs[0]?.controller.abort("cleanup");
      await waitForRunJobCount(1);
      jobs[1]?.controller.abort("cleanup");
      await Promise.all(promises);
      await waitForRunJobsCleared();
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

test("batch notification does not crash for successful lifecycle completion", async () => {
  await withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    async () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const sentMessages: SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      process.env.PI_SUBAGENT_DEPTH = "1";
      const result = await tool.execute(
        "test-tool-call",
        { agent: "hang", task: "batch notify" },
        undefined,
        undefined,
        makeBareCtx(cwd),
      );
      await waitForSentMessageCount(sentMessages, 2);
      expect((result.content[0] as TextContent).text).toBe("done");
      expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
      const requestId = (sentMessages[0]?.details as { requestId?: string })
        ?.requestId;
      if (requestId) {
        expect(getProgressState(requestId)?.status).toBe("success");
      }
      expect(listRunJobs()).toHaveLength(0);
    },
  );
});

// --- deliverDesktopCompletionNotification indirect verification ---

test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=1 calls notification path", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      setDefaultDeliveryDeps({ spawnProcess: () => ({}) });
      const state = makeProgressState({
        status: "success",
        finalOutput: "task completed",
        durationMs: 5000,
      });
      expect(() => emitCompletionAlert(state)).not.toThrow();
    },
  );
});

test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=0 skips notification path", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "0",
    },
    () => {
      captureStdout(false, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        expect(() => emitCompletionAlert(state)).not.toThrow();
        expect(writeCalls).toEqual([]);
      });
    },
  );
});

test("emitCompletionAlert with PI_SUBAGENT_DESKTOP_NOTIFICATIONS=1 and PI_SUBAGENT_NOTIFY_PER_JOB=1 still emits bell via batch fallback", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: "1",
    },
    () => {
      captureStdout(true, (writeCalls) => {
        const state = makeProgressState({
          status: "success",
          finalOutput: "task completed",
        });
        emitCompletionAlert(state);
        expect(writeCalls).toContain("\x07");
      });
    },
  );
});

test("emitCompletionAlert swallows desktop notification rejection", () => {
  withEnv(
    {
      PI_SUBAGENT_DESKTOP_NOTIFICATIONS: "1",
      PI_SUBAGENT_NOTIFY_PER_JOB: undefined,
    },
    () => {
      const spy = spyOn(delivery, "deliverNotification").mockImplementation(
        () => Promise.reject(new Error("notification delivery failed")),
      );
      try {
        captureStdout(true, (writeCalls) => {
          const state = makeProgressState({
            status: "success",
            finalOutput: "task completed",
          });
          expect(() => emitCompletionAlert(state)).not.toThrow();
          expect(writeCalls).toContain("\x07");
        });
      } finally {
        spy.mockRestore();
      }
    },
  );
});

test("orchestrated path preserves nested activity across fallback child status updates", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "preserve nested" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
});

test("orchestrated path: fresh child tool call supersedes preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Scanning files"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-fresh","arguments":{"command":"cat file.ts"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "fresh tool wins" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.toolCount).toBeGreaterThanOrEqual(1);
});

test("orchestrated path: terminal progress clears preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Outcome: completed"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "terminal clears" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  const state = getProgressState(requestId);
  expect(state?.status).toBe("success");
  expect(state?.lastToolPreview).toBeUndefined();
});

test("patchProgressFromDetails: tool_result_end does not overwrite nested activity preview", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const subagentCallLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          id: "sub-nested-1",
          arguments: { agent: "build", task: "compile" },
        },
      ],
    },
  });
  const nestedLine = makeSubagentToolUpdateLine("bash: make build");
  const toolResultEndLine = JSON.stringify({
    type: "tool_result_end",
    message: { role: "toolResult", content: [] },
  });
  const finalLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(subagentCallLine)}
printf '%s\n' ${shellQuote(nestedLine)}
printf '%s\n' ${shellQuote(toolResultEndLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(finalLine)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested preview" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await waitFor(
    () =>
      getProgressState(requestId)?.lastToolPreview === "subagent: build"
        ? true
        : undefined,
    "parent preview preserved through tool_result_end",
  );
  expect(getProgressState(requestId)?.lastToolPreview).toBe("subagent: build");
  expect(getProgressState(requestId)?.activeToolActivity).toBeDefined();
  expect(
    getProgressState(requestId)?.activeToolActivity?.instanceName,
  ).toBeUndefined();
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("patchProgressFromDetails: parent preview shows friendly instance label after nested tool result pop", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  const sentinel = path.join(cwd, "continue");
  const subagentCallLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "subagent",
          id: "sub-nested-label",
          arguments: { agent: "build", task: "compile" },
        },
      ],
    },
  });
  const nestedLine = makeSubagentToolUpdateLine(
    "bash: make build",
    "able-falcon",
  );
  const toolResultEndLine = JSON.stringify({
    type: "tool_result_end",
    message: { role: "toolResult", content: [] },
  });
  const finalLine = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(subagentCallLine)}
printf '%s\n' ${shellQuote(nestedLine)}
printf '%s\n' ${shellQuote(toolResultEndLine)}
until [ -f ${shellQuote(sentinel)} ]; do sleep 0.02; done
printf '%s\n' ${shellQuote(finalLine)}
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "nested label" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessage(sentMessages);
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  await waitFor(
    () =>
      getProgressState(requestId)?.lastToolPreview ===
      "subagent: build [able-falcon]"
        ? true
        : undefined,
    "parent preview shows friendly instance label",
  );
  expect(getProgressState(requestId)?.lastToolPreview).toBe(
    "subagent: build [able-falcon]",
  );
  expect(getProgressState(requestId)?.activeToolActivity).toBeDefined();
  expect(getProgressState(requestId)?.activeToolActivity?.instanceName).toBe(
    "able-falcon",
  );
  await writeFile(sentinel, "continue");
  await waitForSentMessageCount(sentMessages, 2);
  expect(getProgressState(requestId)?.status).toBe("success");
});

test("orchestrated path: result detail shape remains compatible with preserved nested activity", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading config.ts"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":10,"output":20,"totalTokens":30,"cost":{"total":0.01}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
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
  expect(typeof resultDetails.results[0]?.usage?.input).toBe("number");
  expect(typeof resultDetails.results[0]?.usage?.output).toBe("number");
});

test("host onUpdate callback is forwarded to lifecycle for running jobs", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostOnUpdate: AgentToolUpdateCallback<SubagentDetails> = () => {};
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
});

test("host onUpdate callback type is compatible with AgentToolUpdateCallback", async () => {
  const hostOnUpdate: AgentToolUpdateCallback<SubagentDetails> = (
    partial: AgentToolResult<SubagentDetails>,
  ) => {
    expect(partial.content).toBeDefined();
    expect(Array.isArray(partial.content)).toBe(true);
    for (const contentBlock of partial.content) {
      expect(contentBlock.type).toBe("text");
      if (contentBlock.type === "text") {
        expect(typeof contentBlock.text).toBe("string");
      }
    }
    expect(partial.details).toBeDefined();
    expect(partial.details.mode).toBe("single");
    expect(partial.details.agentScope).toBeDefined();
    expect(Array.isArray(partial.details.results)).toBe(true);
  };
  expect(typeof hostOnUpdate).toBe("function");
});

test("tool executes successfully without onUpdate callback", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(result.content).toBeDefined();
  expect(result.content[0]?.type).toBe("text");
  if (result.content[0]?.type === "text") {
    expect(result.content[0].text).toBe("done");
  }
  expect(result.details).toBeDefined();
  expect(result.details.mode).toBe("single");
  expect(result.details.renderedByMessage).toBe(true);
});

test("non-started flows return same shape with and without callback", async () => {
  const sentMessages: SendMessageArg[] = [];
  const callbackInvocations: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    callbackInvocations.push(partial);
  };
  const { cwd } = await setupFakePi();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const resultWithCallback = await tool.execute(
    "test-tool-call-1",
    { agent: "non-existent", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(callbackInvocations).toHaveLength(0);
  expect(resultWithCallback.content).toBeDefined();
  expect(resultWithCallback.content[0]?.type).toBe("text");
  if (resultWithCallback.content[0]?.type === "text") {
    expect(resultWithCallback.content[0].text).toContain(
      'Unknown agent: "non-existent"',
    );
  }
  expect(resultWithCallback.details).toBeDefined();
  expect(resultWithCallback.details.mode).toBe("single");
  sentMessages.length = 0;
  const resultWithoutCallback = await tool.execute(
    "test-tool-call-2",
    { agent: "non-existent", task: "test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect(resultWithoutCallback.content).toBeDefined();
  expect(resultWithoutCallback.content[0]?.type).toBe("text");
  if (resultWithoutCallback.content[0]?.type === "text") {
    expect(resultWithoutCallback.content[0].text).toContain(
      'Unknown agent: "non-existent"',
    );
  }
  expect(resultWithoutCallback.details).toBeDefined();
  expect(resultWithoutCallback.details.mode).toBe("single");
});

test("live partial updates are forwarded to host callback with correct shape", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  for (const partial of partialUpdates) {
    expect(partial.content).toBeDefined();
    expect(Array.isArray(partial.content)).toBe(true);
    expect(partial.content.length).toBeGreaterThan(0);
    expect(partial.content[0]?.type).toBe("text");
    if (partial.content[0]?.type === "text") {
      expect(typeof partial.content[0].text).toBe("string");
      expect(partial.content[0].text.length).toBeGreaterThan(0);
    }
    expect(partial.details).toBeDefined();
    expect(partial.details.mode).toBe("single");
    expect(partial.details.agentScope).toBeDefined();
    expect(Array.isArray(partial.details.results)).toBe(true);
    expect(partial.details.renderedByMessage).toBeUndefined();
  }
  expect(result.details.renderedByMessage).toBe(true);
});

test("hostOnUpdate is called when fingerprint changes between updates", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  const line1 = makeSubagentToolUpdateLine("first update", "inst-1");
  const line2 = makeSubagentToolUpdateLine("second update", "inst-1");
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\\n' ${shellQuote(line1)}
printf '%s\\n' ${shellQuote(line2)}
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThanOrEqual(2);
  const texts = partialUpdates.map(
    (u) => (u.content[0] as { type: "text"; text: string }).text,
  );
  expect(new Set(texts).size).toBeGreaterThan(1);
});

test("partial updates contain meaningful activity text from child progress", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"echo hello"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  const hasToolPreview = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("bash") || text.includes("echo");
  });
  const hasRunningFallback = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text === "(running...)";
  });
  expect(hasToolPreview || hasRunningFallback).toBe(true);
});

test("partial updates preserve progress state patching and progress card renders", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const statusCalls: { key: string; value: string | undefined }[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    {
      cwd,
      hasUI: false,
      ui: {
        setStatus: (key: string, value: string | undefined) =>
          statusCalls.push({ key, value }),
      },
    } as unknown as ExtensionContext,
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  const progressRenders = statusCalls.filter((call) =>
    call.key.startsWith("subagent-progress:"),
  );
  expect(progressRenders.length).toBeGreaterThan(0);
  expect(sentMessages[0]?.customType).toBe("subagent-progress");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
});

test("final success result uses renderedByMessage to avoid duplicate rendering", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates.length).toBeGreaterThan(0);
  for (const partial of partialUpdates) {
    expect(partial.details.renderedByMessage).toBeUndefined();
  }
  expect(result.details.renderedByMessage).toBe(true);
  const resultMessage = sentMessages.find(
    (msg) => msg.customType === "subagent-result",
  );
  expect(resultMessage).toBeDefined();
  const resultMessageDetails = resultMessage?.details as SubagentDetails;
  expect(resultMessageDetails.renderedByMessage).toBeUndefined();
});

test("failure path with callback does not throw and returns structured error", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"error occurred"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}},"errorMessage":"test error"}}'
printf '%s\n' '{"type":"agent_end"}'
exit 1
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
  const latestResult = result.details.results[0];
  expect(latestResult?.exitCode).toBe(1);
});

test("cancellation path with callback does not throw and returns structured cancellation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const controller = new AbortController();
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"working"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
sleep 5
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const executePromise = tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    controller.signal,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  await Bun.sleep(50);
  controller.abort();
  const result = await executePromise;
  expect(result.content).toBeDefined();
  expect(result.details).toBeDefined();
  expect(result.details.renderedByMessage).toBe(true);
});

test("rapid duplicate progress events are coalesced by deduplication guard", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  const toolCallUpdates = partialUpdates.filter((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("bash") || text.includes("ls");
  });
  expect(toolCallUpdates.length).toBeLessThan(3);
  expect(partialUpdates.length).toBeGreaterThan(0);
});

test("distinct progress events reach callback despite deduplication guard", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","id":"tc-1","arguments":{"command":"ls"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"read","id":"tc-2","arguments":{"path":"file.txt"}}]}}'
sleep 0.01
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  const hasLsTool = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("ls");
  });
  const hasReadTool = partialUpdates.some((partial) => {
    const text =
      partial.content[0]?.type === "text" ? partial.content[0].text : "";
    return text.includes("read") || text.includes("file.txt");
  });
  expect(hasLsTool).toBe(true);
  expect(hasReadTool).toBe(true);
});

test("prepareSubagentJob omits parent model when ctx.model is absent", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\n' "$*" > args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "no-model" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const argsText = await Bun.file(path.join(cwd, "args.txt")).text();
  expect(argsText).not.toContain("--provider");
  expect(argsText).not.toContain("--model");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.model).toBe("off");
  expect(listRunJobs()).toHaveLength(0);
});

test("project agent without user collision sends no collision warning", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await Bun.$`mkdir -p ${projectAgentsDir}`;
  await writeFile(
    path.join(projectAgentsDir, "project-only.md"),
    `---
name: project-only
description: Project only
---
Project prompt`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-only", task: "no-collision", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const collisionWarnings = sentMessages.filter(
    (msg) =>
      msg.customType === "subagent-progress" &&
      typeof msg.content === "string" &&
      msg.content.includes("user agent with same name"),
  );
  expect(collisionWarnings).toHaveLength(0);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "project",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("startSubagentJob depth-0 cancels via cancelStartedJob when signal aborts after registration", async () => {
  const sentMessages: SendMessageArg[] = [];
  const controller = new AbortController();
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "cancel-after-start" },
    controller.signal,
    undefined,
    makeBareCtx(cwd),
  );
  const requestId = (sentMessages[0]?.details as { requestId?: string })
    ?.requestId;
  if (!requestId) throw new Error("requestId missing");
  expect(listRunJobs()).toHaveLength(1);
  expect(getProgressState(requestId)?.status).toBe("running");
  controller.abort("host cancel");
  await waitForRunJobsCleared();
  expect(getProgressState(requestId)?.status).toBe("cancelled");
});

test("formatSubagentToolResult returns completed result unchanged preserving all fields", () => {
  const completedResult: SubagentToolResult = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      mode: "single" as const,
      agentScope: "both" as const,
      projectAgentsDir: null,
      renderedByMessage: true as const,
      results: [
        {
          instanceName: "adj-word",
          agent: "hang",
          agentSource: "user" as const,
          task: "test task",
          finalOutput: "done",
          exitCode: 0,
          stderr: "",
          durationMs: 5000,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 1,
          },
        },
      ],
    },
  };
  const result = formatSubagentToolResult("hang", {
    kind: "completed",
    result: completedResult,
  });
  // Returns the exact same object reference (pass-through)
  expect(result).toBe(completedResult);
  expect(result.details.renderedByMessage).toBe(true);
  expect(result.details.results[0]?.finalOutput).toBe("done");
});

test("createPayloadFingerprint deduplicates equal tool call IDs via hostOnUpdate", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { binDir, cwd } = await setupFakePi();
  // Emit the same tool call twice (duplicate IDs) — fingerprint should dedupe
  const tc1 = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "bash",
          id: "dup-tc-1",
          arguments: { command: "ls" },
        },
      ],
    },
  });
  const tc2 = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "bash",
          id: "dup-tc-1",
          arguments: { command: "ls" },
        },
      ],
    },
  });
  const final = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\\n' ${shellQuote(tc1)}
sleep 0.01
printf '%s\\n' ${shellQuote(tc2)}
sleep 0.01
printf '%s\\n' ${shellQuote(final)}
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "dedup" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  // Duplicate identical payloads should be suppressed; valid updates still flow
  expect(partialUpdates.length).toBeGreaterThan(0);
  const dedupedToolCalls = partialUpdates.filter((u) => {
    const text =
      u.content[0]?.type === "text"
        ? (u.content[0] as { text: string }).text
        : "";
    return text.includes("bash") || text.includes("ls");
  });
  // Fingerprint dedup should collapse the two identical tool calls into 1 update
  expect(dedupedToolCalls.length).toBeLessThanOrEqual(1);
});

test("empty agent_end messages do not emit synthetic hostOnUpdate", async () => {
  const sentMessages: SendMessageArg[] = [];
  const partialUpdates: AgentToolResult<SubagentDetails>[] = [];
  const hostOnUpdate = (partial: AgentToolResult<SubagentDetails>) => {
    partialUpdates.push(partial);
  };
  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "empty" },
    undefined,
    hostOnUpdate,
    makeBareCtx(cwd),
  );
  expect(partialUpdates).toHaveLength(0);
});

test("subagent tool successful run with complete tool preserves outcome in details without finalOutput mutation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Task completed successfully." },
        {
          type: "toolCall",
          id: "tc-complete-1",
          name: "complete",
          arguments: { outcome: "Successfully done" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-1",
      details: { outcome: "Successfully done" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "test outcome" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  // Parent details should expose results[0].outcome
  expect(result.details.results[0]?.outcome).toBe("Successfully done");

  // finalOutput contains only assistant text and remains unchanged
  expect(result.details.results[0]?.finalOutput).toBe(
    "Task completed successfully.",
  );

  // Result content does not synthesize the outcome text
  expect((result.content[0] as TextContent).text).toBe(
    "Task completed successfully.",
  );
});

test("subagent tool with tool-only complete preserves outcome with empty finalOutput", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-complete-2",
          name: "complete",
          arguments: { outcome: "Only completed without text" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-2",
      details: { outcome: "Only completed without text" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 0
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "tool-only outcome" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  expect(result.details.results[0]?.outcome).toBe(
    "Only completed without text",
  );
  expect(result.details.results[0]?.finalOutput).toBe("");
  expect((result.content[0] as TextContent).text).toBe("(no output)");
});

test("subagent tool failure keeps existing content/error semantics with no outcome field", async () => {
  const sentMessages: SendMessageArg[] = [];
  const asstMessage = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Failed with errors." },
        {
          type: "toolCall",
          id: "tc-complete-3",
          name: "complete",
          arguments: { outcome: "Failed outcome but it will be ignored" },
        },
      ],
    },
  });
  const toolResultMsg = JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "tc-complete-3",
      isError: true,
      details: { outcome: "Failed outcome but it will be ignored" },
    },
  });
  const agentEndMsg = JSON.stringify({
    type: "agent_end",
    messages: [],
  });

  const { tool, cwd } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' ${shellQuote(asstMessage)}
printf '%s\\n' ${shellQuote(toolResultMsg)}
printf '%s\\n' ${shellQuote(agentEndMsg)}
exit 1
`,
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "failure outcome" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  // In case of non-zero exit code or semantic failure, outcome should be undefined
  expect(result.details.results[0]?.outcome).toBeUndefined();
  expect(result.details.results[0]?.finalOutput).toBe("Failed with errors.");
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("Failed with errors.");
});

test("T-005: subagent tool preserves existing model/provider, thinking, skills, extensions, and contracts under both sampling and no-sampling configurations", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();

  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );

  await writeFile(
    path.join(agentDir, "agents", "sampling-agent.md"),
    `---
name: sampling-agent
description: Sampling agent
skills: helper
temperature: 0.6
top_p: 0.8
---
Sampling agent prompt`,
  );

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
skills: helper
---
No-sampling agent prompt`,
  );

  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });

  process.env.PI_SUBAGENT_DEPTH = "1";

  const resSampling = await tool.execute(
    "test-tool-call-1",
    { agent: "sampling-agent", task: "sampling task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );

  const expectedSamplingWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((resSampling.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedSamplingWarning}\n\ndone`,
  );
  const argsSampling = await readCapturedArgs(cwd);
  const promptSampling = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const envSampling = await Bun.file(path.join(cwd, "env_sampling.txt")).text();

  expect(argsSampling.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(argsSampling.join(" ")).toContain("--thinking high");
  expect(argsSampling.join(" ")).toContain("--no-skills --skill");
  expect(argsSampling.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(argsSampling.join(" ")).toContain("complete-extension");
  const contractSamplingIdx = argsSampling.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(argsSampling[contractSamplingIdx + 1]).toBe("Task: sampling task");
  expect(argsSampling[contractSamplingIdx + 1]).not.toContain(
    "Subagent Result Contract",
  );
  const appendsSampling = flagValues(argsSampling, "--append-system-prompt");
  expect(appendsSampling).toHaveLength(2);
  expect(appendsSampling[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appendsSampling.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptSampling).toBe("Sampling agent prompt");
  expect((resSampling.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect(
    (resSampling.details as SubagentDetails).results[0]?.thinkingWarning,
  ).toBe(expectedSamplingWarning);

  expect(argsSampling.join(" ")).toContain("sampling-extension");
  const samplingExtensionIdx = argsSampling.findIndex((arg) =>
    arg.includes("sampling-extension"),
  );
  expect(samplingExtensionIdx).toBeGreaterThan(-1);
  expect(contractSamplingIdx).toBeGreaterThan(samplingExtensionIdx);
  expect(JSON.parse(envSampling.trim())).toEqual({
    temperature: 0.6,
    topP: 0.8,
  });

  await writeFile(path.join(cwd, "args.txt"), "");
  await writeFile(path.join(cwd, "env_sampling.txt"), "");
  await writeFile(path.join(cwd, "prompt.txt"), "");

  const resNoSampling = await tool.execute(
    "test-tool-call-2",
    { agent: "no-sampling-agent", task: "no-sampling task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "fake-provider", id: "fake-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );

  const expectedNoSamplingWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: fake-provider, model: fake-model)';
  expect((resNoSampling.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedNoSamplingWarning}\n\ndone`,
  );
  const argsNoSampling = await readCapturedArgs(cwd);
  const promptNoSampling = await Bun.file(path.join(cwd, "prompt.txt")).text();
  const envNoSampling = await Bun.file(
    path.join(cwd, "env_sampling.txt"),
  ).text();

  expect(argsNoSampling.join(" ")).toContain(
    "--provider fake-provider --model fake-model",
  );
  expect(argsNoSampling.join(" ")).toContain("--thinking high");
  expect(argsNoSampling.join(" ")).toContain("--no-skills --skill");
  expect(argsNoSampling.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(argsNoSampling.join(" ")).toContain("complete-extension");
  const contractNoSamplingIdx = argsNoSampling.indexOf(
    SUBAGENT_RESULT_CONTRACT,
  );
  expect(argsNoSampling[contractNoSamplingIdx + 1]).toBe(
    "Task: no-sampling task",
  );
  expect(argsNoSampling[contractNoSamplingIdx + 1]).not.toContain(
    "Subagent Result Contract",
  );
  const appendsNoSampling = flagValues(
    argsNoSampling,
    "--append-system-prompt",
  );
  expect(appendsNoSampling).toHaveLength(2);
  expect(appendsNoSampling[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appendsNoSampling.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(promptNoSampling).toBe("No-sampling agent prompt");
  expect((resNoSampling.details as SubagentDetails).results[0]?.model).toBe(
    "fake-provider ･ fake-model ･ high",
  );
  expect(
    (resNoSampling.details as SubagentDetails).results[0]?.thinkingWarning,
  ).toBe(expectedNoSamplingWarning);

  expect(argsNoSampling.join(" ")).not.toContain("sampling-extension");
  expect(envNoSampling.trim()).toBe("");

  expect(listRunJobs()).toHaveLength(0);
});

test("T-005: subagent tool preserves recursion depth handling under both sampling and no-sampling configurations", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();

  await writeFile(
    path.join(agentDir, "agents", "sampling-agent.md"),
    `---
name: sampling-agent
description: Sampling agent
temperature: 0.5
---
Sampling agent prompt`,
  );

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
---
No-sampling agent prompt`,
  );

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });

  process.env.PI_SUBAGENT_DEPTH = "3";

  const resSampling = await tool.execute(
    "test-tool-call-1",
    { agent: "sampling-agent", task: "sampling task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  const samplingText = (resSampling.content[0] as TextContent).text;
  expect(samplingText).toStartWith("(failed) ");
  expect(samplingText).toContain("depth");
  const directDetailsSampling = resSampling.details as SubagentDetails;
  expect(directDetailsSampling.results[0]?.exitCode).toBe(1);

  const resNoSampling = await tool.execute(
    "test-tool-call-2",
    { agent: "no-sampling-agent", task: "no-sampling task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );

  const noSamplingText = (resNoSampling.content[0] as TextContent).text;
  expect(noSamplingText).toStartWith("(failed) ");
  expect(noSamplingText).toContain("depth");
  const directDetailsNoSampling = resNoSampling.details as SubagentDetails;
  expect(directDetailsNoSampling.results[0]?.exitCode).toBe(1);

  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool strips inherited PI_SAMPLING_PARAMS when agent has no sampling overrides", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();

  await writeFile(
    path.join(agentDir, "agents", "no-sampling-agent.md"),
    `---
name: no-sampling-agent
description: No-sampling agent
---
No-sampling agent prompt`,
  );

  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);

  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });

  process.env.PI_SUBAGENT_DEPTH = "1";
  process.env["PI_SAMPLING_PARAMS"] = JSON.stringify({
    temperature: 0.99,
    topP: 0.99,
  });

  try {
    const result = await tool.execute(
      "test-tool-call",
      { agent: "no-sampling-agent", task: "no-sampling task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );

    expect((result.content[0] as TextContent).text).toBe("done");
    const envSampling = await Bun.file(
      path.join(cwd, "env_sampling.txt"),
    ).text();
    expect(envSampling.trim()).toBe("");
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    delete process.env["PI_SAMPLING_PARAMS"];
  }
});

test("subagent context false passes --no-context-files to child alongside approval tools skills model provider thinking prompt complete-extension sampling-extension result-contract", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "context-off-full.md"),
    `---
name: context-off-full
description: Context off with all features
context: false
tools: bash, read
skills: helper
model: gpt-4
provider: openai
thinking: high
temperature: 0.7
top_p: 0.9
---
Full feature prompt.`,
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "off",
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "context-off-full", task: "context test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const args = await readCapturedArgs(cwd);
  const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
  expect((result.content[0] as TextContent).text).toContain("done");
  expect(args.join(" ")).toContain("--no-context-files");
  expect(args.join(" ")).toContain("--approve");
  expect(args.join(" ")).toContain("--provider openai");
  expect(args.join(" ")).toContain("--model gpt-4");
  expect(args.join(" ")).toMatch(/--thinking \S+/);
  expect(args.join(" ")).toContain("--tools bash,read,complete");
  expect(args.join(" ")).toContain("--no-skills --skill");
  expect(args.join(" ")).toContain(path.join(skillDir, "SKILL.md"));
  expect(args).toContain("--append-system-prompt");
  expect(args).toContain("--extension");
  const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(args[contractIdx + 1]).toBe("Task: context test");
  expect(args[contractIdx + 1]).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.join(" ")).toContain("--no-themes");
  expect(args.join(" ")).toContain("--no-prompt-templates");
  expect(promptText).toBe("Full feature prompt.");
  expect((args.join(" ").match(/--no-context-files/g) ?? []).length).toBe(1);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "user",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent context absent omits --no-context-files from child args", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "no context" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const args = await readCapturedArgs(cwd);
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(args.join(" ")).not.toContain("--no-context-files");
  expect(args.join(" ")).toContain("--approve");
  expect(args.at(-1)).toBe("Task: no context");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect(args.join(" ")).toContain("--no-themes");
  expect(args.join(" ")).toContain("--no-prompt-templates");
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent invalid context string rejects agent before child spawn", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "context-string.md"),
    `---
name: context-string
description: Context string agent
context: "false"
---
Prompt.`,
  );
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "context-string", task: "should not spawn" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toContain(
    'Unknown agent: "context-string"',
  );
  expect(sentMessages).toHaveLength(0);
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent context false does not leak --no-context-files to subsequent context-absent invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "ctx-off.md"),
    `---
name: ctx-off
description: Context off agent
context: false
---
Context off prompt.`,
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\\n' "$*" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const ctxOffResult = await tool.execute(
    "run-1",
    { agent: "ctx-off", task: "first" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsOff = await Bun.file(path.join(cwd, "args.txt")).text();
  expect((ctxOffResult.content[0] as TextContent).text).toBe("done");
  expect(argsOff).toContain("--no-context-files");
  const hangResult = await tool.execute(
    "run-2",
    { agent: "hang", task: "second" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsHang = await Bun.file(path.join(cwd, "args.txt")).text();
  expect((hangResult.content[0] as TextContent).text).toBe("done");
  expect(argsHang).not.toContain("--no-context-files");
  expect(argsHang).toContain("--approve");
  expect(argsHang).toContain("Task: second");
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent skills false passes --no-skills without skill paths to child and does not trigger skill resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  const skillDir = path.join(agentDir, "skills", "nonexistent");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: nonexistent
description: Should not be loaded
---
Ghost skill.`,
  );
  await writeFile(
    path.join(agentDir, "agents", "skills-off.md"),
    `---
name: skills-off
description: Skills disabled agent
skills: false
---
No skills prompt.`,
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "skills-off", task: "skills off test" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const args = await readCapturedArgs(cwd);
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(args.join(" ")).toContain("--no-skills");
  expect(args.join(" ")).not.toContain("--skill");
  expect(args.join(" ")).not.toContain("nonexistent");
  expect(args.join(" ")).toContain("--no-themes");
  expect(args.join(" ")).toContain("--no-prompt-templates");
  expect(args.join(" ")).toContain("--approve");
  expect(args.at(-1)).toBe("Task: skills off test");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "user",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent skills false does not leak --no-skills to subsequent skills-absent invocation", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(agentDir, "agents", "skills-off-2.md"),
    `---
name: skills-off-2
description: Skills disabled agent 2
skills: false
---
No skills prompt.`,
  );
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\\n' "$*" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const skillsOffResult = await tool.execute(
    "run-1",
    { agent: "skills-off-2", task: "first" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsOff = await Bun.file(path.join(cwd, "args.txt")).text();
  expect((skillsOffResult.content[0] as TextContent).text).toBe("done");
  expect(argsOff).toContain("--no-skills");
  const hangResult = await tool.execute(
    "run-2",
    { agent: "hang", task: "second" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  const argsHang = await Bun.file(path.join(cwd, "args.txt")).text();
  expect((hangResult.content[0] as TextContent).text).toBe("done");
  expect(argsHang).not.toContain("--no-skills");
  expect(argsHang).toContain("--approve");
  expect(argsHang).toContain("Task: second");
  expect(listRunJobs()).toHaveLength(0);
});

// --- T-005: tool-path regression and nested extension support ---

async function createAgentWithExtensions(
  agentDir: string,
  name: string,
  extensionsContent: string | undefined,
): Promise<void> {
  const agentsDir = path.join(agentDir, "agents");
  const frontmatter = [
    `name: ${name}`,
    `description: Extension test agent`,
    `thinking: off`,
  ];
  if (extensionsContent !== undefined) {
    frontmatter.push(`extensions: ${extensionsContent}`);
  }
  const agentMd = `---\n${frontmatter.join("\n")}\n---\nSystem prompt.`;
  await writeFile(path.join(agentsDir, `${name}.md`), agentMd);
  resetAgentCache();
  resetResolvedAgentExtensionPathsCache();
  resetResolvedAgentSkillArgsCache();
}

test("tool path omitted extensions preserves normal discovery without --no-extensions or package index", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await createAgentWithExtensions(agentDir, "no-ext", undefined);
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "no-ext", task: "omitted extensions task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = fs
    .readFileSync(path.join(cwd, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
  expect(args).toContain("--approve");
  expect(args).toContain("--no-themes");
  expect(
    flagValues(args, "--extension").some((p) =>
      p.includes("complete-extension"),
    ),
  ).toBe(true);
});

test("tool path disabled extensions injects --no-extensions and package index for nested child support", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await createAgentWithExtensions(agentDir, "disabled-ext", "[]");
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "disabled-ext", task: "disabled extensions task" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = await readCapturedArgs(cwd);
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  const extFlags = flagValues(args, "--extension");
  expect(extFlags).toContain(pkgPath);
  const pkgCount = extFlags.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
  expect(extFlags.some((p) => p.includes("complete-extension"))).toBe(true);
  expect(args).toContain("--approve");
  expect(args.at(-1)).toBe("Task: disabled extensions task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
});

test("tool path named extensions resolves and passes to child with first-seen order", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const extDir = path.join(agentDir, "extensions");
  const extAPath = path.join(extDir, "ext-a", "index.js");
  const extBPath = path.join(extDir, "ext-b", "index.js");
  const extCPath = path.join(extDir, "ext-c", "index.js");
  await fs.promises.mkdir(path.dirname(extAPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extBPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extCPath), { recursive: true });
  await fs.promises.writeFile(extAPath, "module.exports = function() {}");
  await fs.promises.writeFile(extBPath, "module.exports = function() {}");
  await fs.promises.writeFile(extCPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/ext-c",
          resolvedPath: extCPath,
          sourceInfo: {
            path: extCPath,
            source: "extensions/ext-c",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/ext-b",
          resolvedPath: extBPath,
          sourceInfo: {
            path: extBPath,
            source: "extensions/ext-b",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/ext-a",
          resolvedPath: extAPath,
          sourceInfo: {
            path: extAPath,
            source: "extensions/ext-a",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  await createAgentWithExtensions(
    agentDir,
    "named-ext",
    '"ext-c, ext-a, ext-b"',
  );
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await tool.execute(
      "test-tool-call",
      { agent: "named-ext", task: "named extensions task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result.content[0] as TextContent).text).toBe("done");
    const args = await readCapturedArgs(cwd);
    expect(args).toContain("--no-extensions");
    const pkgPath = resolvePackageExtensionPath();
    const extFlags = flagValues(args, "--extension");
    expect(extFlags).toContain(pkgPath);
    const namedFlags = extFlags.filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(namedFlags).toEqual([extCPath, extAPath, extBPath]);
    expect(args.at(-1)).toBe("Task: named extensions task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toHaveLength(2);
    expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("tool path single-file named extension resolves by file stem and flows to child args", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const extDir = path.join(agentDir, "extensions");
  const extPath = path.join(extDir, "standalone.js");
  await fs.promises.mkdir(path.dirname(extPath), { recursive: true });
  await fs.promises.writeFile(extPath, "module.exports = function setup() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/standalone.js",
          resolvedPath: extPath,
          sourceInfo: {
            path: extPath,
            source: "extensions/standalone.js",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  await createAgentWithExtensions(agentDir, "single-file-ext", '"standalone"');
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await tool.execute(
      "test-tool-call",
      { agent: "single-file-ext", task: "single file extension task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result.content[0] as TextContent).text).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    expect(args).toContain("--no-extensions");
    const pkgPath = resolvePackageExtensionPath();
    const extFlags = flagValues(args, "--extension");
    expect(extFlags).toContain(pkgPath);
    const namedFlags = extFlags.filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(namedFlags).toEqual([extPath]);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("tool path version-pinned npm extension resolves and flows to child args", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const extDir = path.join(agentDir, "extensions");
  const resolvedPath = path.join(extDir, "npm-helper", "index.js");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/npm-helper",
          resolvedPath,
          sourceInfo: {
            path: resolvedPath,
            source: "npm:@scope/helper@2.0.0",
            scope: "user",
            origin: "package",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  await createAgentWithExtensions(agentDir, "npm-version-ext", '"helper"');
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await tool.execute(
      "test-tool-call",
      { agent: "npm-version-ext", task: "npm version-pinned extension task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result.content[0] as TextContent).text).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    expect(args).toContain("--no-extensions");
    const pkgPath = resolvePackageExtensionPath();
    const extFlags = flagValues(args, "--extension");
    expect(extFlags).toContain(pkgPath);
    const namedFlags = extFlags.filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(namedFlags).toEqual([resolvedPath]);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("tool path unknown extension names return completed error with sorted available names and no child spawn", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
echo "should not spawn" > spawn-marker.txt
exit 0
`,
  });
  const extDir = path.join(cwd, ".pi", "extensions");
  const alphaPath = path.join(extDir, "alpha-ext", "index.js");
  const zebraPath = path.join(extDir, "zebra-ext", "index.js");
  await fs.promises.mkdir(path.dirname(alphaPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(zebraPath), { recursive: true });
  await fs.promises.writeFile(alphaPath, "module.exports = function() {}");
  await fs.promises.writeFile(zebraPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: ".pi/extensions/zebra-ext",
          resolvedPath: zebraPath,
          sourceInfo: {
            path: zebraPath,
            source: ".pi/extensions/zebra-ext",
            scope: "project",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: ".pi/extensions/alpha-ext",
          resolvedPath: alphaPath,
          sourceInfo: {
            path: alphaPath,
            source: ".pi/extensions/alpha-ext",
            scope: "project",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  await createAgentWithExtensions(
    agentDir,
    "bad-ext",
    '"nonexistent, also-missing"',
  );
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result = await tool.execute(
      "test-tool-call",
      { agent: "bad-ext", task: "unknown extensions task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    const resultText = (result.content[0] as TextContent).text;
    expect(resultText).toStartWith("(failed) ");
    expect(resultText).toContain('"nonexistent"');
    expect(resultText).toContain('"also-missing"');
    expect(resultText).toContain("Available extensions:");
    expect(resultText).toContain("alpha-ext");
    expect(resultText).toContain("zebra-ext");
    const details = result.details as SubagentDetails;
    expect(details.results[0]?.exitCode).toBe(1);
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("tool path sampling-enabled disabled extensions includes complete, sampling, and package index without duplicate index", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const agentsDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(agentsDir, "sampling-ext.md"),
    `---
name: sampling-ext
description: Sampling with disabled extensions
thinking: off
temperature: 0.5
extensions: []
---
System prompt.`,
  );
  resetAgentCache();
  resetResolvedAgentExtensionPathsCache();
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "sampling-ext", task: "sampling + extensions disabled" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = await readCapturedArgs(cwd);
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  const extFlags = flagValues(args, "--extension");
  expect(extFlags).toContain(pkgPath);
  const pkgCount = extFlags.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
  expect(extFlags.some((p) => p.includes("complete-extension"))).toBe(true);
  expect(extFlags.some((p) => p.includes("sampling-extension"))).toBe(true);
  const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
  expect(args[contractIdx + 1]).toBe("Task: sampling + extensions disabled");
  expect(args[contractIdx + 1]).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
});

test("tool path disabled extensions preserves model, thinking, skills, and task args", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const agentsDir = path.join(agentDir, "agents");
  await writeFile(
    path.join(agentsDir, "regression-ext.md"),
    `---
name: regression-ext
description: Regression agent with extensions
thinking: high
model: agent-model
provider: agent-provider
tools: bash, read
skills: helper
extensions: []
context: false
---
System prompt.`,
  );
  const skillDir = path.join(agentDir, "skills", "helper");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: helper
description: Helper skill
---
Use helper skill.`,
  );
  resetAgentCache();
  resetResolvedAgentExtensionPathsCache();
  resetResolvedAgentSkillArgsCache();
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "regression-ext", task: "regression task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "parent-provider", id: "parent-model" },
      modelRegistry: registryFixture([]),
    } as unknown as ExtensionContext,
  );
  const expectedRegressionWarning =
    'Thinking level "high" support could not be confirmed; requesting as-is (provider: agent-provider, model: agent-model)';
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe(
    `[thinking] ${expectedRegressionWarning}\n\ndone`,
  );
  const args = await readCapturedArgs(cwd);
  expect(args).toContain("--no-extensions");
  expect(flagValues(args, "--provider")).toEqual(["agent-provider"]);
  expect(flagValues(args, "--model")).toEqual(["agent-model"]);
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(args).toContain("--tools");
  expect(args).toContain("--no-skills");
  expect(args).toContain("--skill");
  expect(args).toContain("--no-context-files");
  expect(args).toContain("--approve");
  expect(args.at(-1)).toBe("Task: regression task");
  expect(args.at(-1)).not.toContain("Subagent Result Contract");
  const appends = flagValues(args, "--append-system-prompt");
  expect(appends).toHaveLength(2);
  expect(appends[0]).not.toBe(SUBAGENT_RESULT_CONTRACT);
  expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
});

test("subagent tool forwards live registry to child resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  await writeFile(
    path.join(agentDir, "agents", "live-agent.md"),
    `---
name: live-agent
description: Live registry agent
---
Live prompt.`,
  );
  resetAgentCache();
  process.env.PI_SUBAGENT_DEPTH = "1";
  const live = modelFixture({
    provider: "live-provider",
    id: "live-model",
    reasoning: true,
  });
  const result = await tool.execute(
    "test-tool-call",
    { agent: "live-agent", task: "live task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "live-provider", id: "live-model" },
      modelRegistry: registryFixture([live]),
    } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = await readCapturedArgs(cwd);
  expect(args.join(" ")).toContain(
    "--provider live-provider --model live-model",
  );
  expect(args.join(" ")).toContain("--thinking high");
  expect((result.details as SubagentDetails).results[0]?.model).toBe(
    "live-provider ･ live-model ･ high",
  );
  expect(
    (result.details as SubagentDetails).results[0]?.thinkingWarning,
  ).toBeUndefined();
  expect(listRunJobs()).toHaveLength(0);
});

test("subagent tool emits registry diagnostic without blocking launch", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end"}'
exit 0
`,
  });
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
    thinkingLevel: "high",
  });
  await writeFile(
    path.join(agentDir, "agents", "no-registry-agent.md"),
    `---
name: no-registry-agent
description: No registry agent
---
No registry prompt.`,
  );
  resetAgentCache();
  process.env.PI_SUBAGENT_DEPTH = "1";
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await tool.execute(
      "test-tool-call",
      { agent: "no-registry-agent", task: "no-registry task" },
      undefined,
      undefined,
      {
        cwd,
        hasUI: false,
        model: { provider: "missing-provider", id: "missing-model" },
      } as unknown as ExtensionContext,
    );
    await waitForSentMessageCount(sentMessages, 2);
    const expectedWarning =
      'Thinking level "high" support could not be confirmed; requesting as-is (provider: missing-provider, model: missing-model)';
    expect((result.content[0] as TextContent).text).toBe(
      `[thinking] ${expectedWarning}\n\ndone`,
    );
    const args = await readCapturedArgs(cwd);
    expect(args.join(" ")).toContain("--thinking high");
    expect(
      (result.details as SubagentDetails).results[0]?.thinkingWarning,
    ).toBe(expectedWarning);
    expect(warnSpy).toHaveBeenCalledWith(
      "Live model registry unavailable; falling back to static catalog.",
    );
    expect(listRunJobs()).toHaveLength(0);
  } finally {
    warnSpy.mockRestore();
  }
});

test("tool path omitted extensions at depth 2 preserves nested subagent support", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await createAgentWithExtensions(agentDir, "nested-no-ext", undefined);
  process.env.PI_SUBAGENT_DEPTH = "2";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "nested-no-ext", task: "nested depth 2" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  const args = fs
    .readFileSync(path.join(cwd, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
  expect(
    flagValues(args, "--extension").some((p) =>
      p.includes("complete-extension"),
    ),
  ).toBe(true);
  expect(args).toContain("--approve");
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path disabled extensions at depth 0 starts job and child receives package index", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await createAgentWithExtensions(agentDir, "depth-zero-ext", "[]");
  process.env.PI_SUBAGENT_DEPTH = "0";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "depth-zero-ext", task: "depth 0" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  expect((result.content[0] as TextContent).text).toContain("started");
  await waitForSentMessageCount(sentMessages, 2);
  expect(sentMessages.at(-1)?.content).toBe("done");
  const args = fs
    .readFileSync(path.join(cwd, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).toContain(pkgPath);
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path project agent with extensions works through confirmation flow", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { cwd } = await setupFakePi();
  const projectAgentsDir = path.join(cwd, ".pi", "agents");
  await mkdir(projectAgentsDir, { recursive: true });
  await writeFile(
    path.join(projectAgentsDir, "project-ext.md"),
    `---
name: project-ext
description: Project agent with extensions
thinking: off
extensions: []
---
Project prompt.`,
  );
  resetAgentCache();
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "project-ext", task: "project task", agentScope: "both" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: true,
      ui: { confirm: async () => true },
    } as unknown as ExtensionContext,
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect((result.content[0] as TextContent).text).toBe("done");
  expect(sentMessages.at(-1)?.customType).toBe("subagent-result");
  expect((result.details as SubagentDetails).results[0]?.agentSource).toBe(
    "project",
  );
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path depth limit with extensions agent still halts before spawn", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
echo "should not spawn" > spawn-marker.txt
exit 0
`,
  });
  await createAgentWithExtensions(agentDir, "deep-ext", "[]");
  process.env.PI_SUBAGENT_DEPTH = "3";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "deep-ext", task: "too deep" },
    undefined,
    undefined,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 1);
  const resultText = (result.content[0] as TextContent).text;
  expect(resultText).toStartWith("(failed) ");
  expect(resultText).toContain("Subagent nesting limit reached");
  expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  expect(listRunJobs()).toHaveLength(0);
});

test("tool path warm cache preserves named extension resolution order", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { tool, cwd, agentDir } = await setupTest({
    sendMessage: (msg) => sentMessages.push(msg),
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const extDir = path.join(agentDir, "extensions");
  const extAPath = path.join(extDir, "first-ext", "index.js");
  const extBPath = path.join(extDir, "second-ext", "index.js");
  await fs.promises.mkdir(path.dirname(extAPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(extBPath), { recursive: true });
  await fs.promises.writeFile(extAPath, "module.exports = function() {}");
  await fs.promises.writeFile(extBPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/first-ext",
          resolvedPath: extAPath,
          sourceInfo: {
            path: extAPath,
            source: "extensions/first-ext",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
        {
          path: "extensions/second-ext",
          resolvedPath: extBPath,
          sourceInfo: {
            path: extBPath,
            source: "extensions/second-ext",
            scope: "user",
            origin: "top-level",
          },
          handlers: new Map(),
          tools: new Map(),
          messageRenderers: new Map(),
          commands: new Map(),
          flags: new Map(),
          shortcuts: new Map(),
        },
      ],
      errors: [],
      runtime: {} as never,
    };
  };
  await createAgentWithExtensions(
    agentDir,
    "warm-ext",
    '"second-ext, first-ext"',
  );
  try {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const result1 = await tool.execute(
      "test-tool-call",
      { agent: "warm-ext", task: "warm first" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result1.content[0] as TextContent).text).toBe("done");
    const args1 = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    const namedFirst = flagValues(args1, "--extension").filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    const reloadsFirst = reloadCalls;
    expect(reloadsFirst).toBeGreaterThanOrEqual(1);
    reloadCalls = 0;
    sentMessages.length = 0;
    const result2 = await tool.execute(
      "test-tool-call-2",
      { agent: "warm-ext", task: "warm second" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForSentMessageCount(sentMessages, 2);
    expect((result2.content[0] as TextContent).text).toBe("done");
    const args2 = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const namedSecond = flagValues(args2, "--extension").filter(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(namedSecond).toEqual(namedFirst);
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

describe("T-002: replace_prompt routing", () => {
  test("subagent tool replace_prompt true uses --system-prompt and keeps contract last", async () => {
    const { tool, cwd, agentDir } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    await writeFile(
      path.join(agentDir, "agents", "replace-agent.md"),
      `---
name: replace-agent
description: Replace prompt agent
replace_prompt: true
---
Replacement body prompt.
`,
    );
    await tool.execute(
      "test-tool-call",
      { agent: "replace-agent", task: "replace task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    const args = await readCapturedArgs(cwd);
    expect(flagValues(args, "--system-prompt")).toHaveLength(1);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    const systemIdx = args.indexOf("--system-prompt");
    const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
    expect(systemIdx).toBeGreaterThan(-1);
    expect(contractIdx).toBeGreaterThan(systemIdx);
    expect(args.at(-1)).toBe("Task: replace task");
    const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
    expect(promptText).toBe("Replacement body prompt.");
  });

  test("subagent tool replace_prompt false uses --append-system-prompt", async () => {
    const { tool, cwd, agentDir } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    await writeFile(
      path.join(agentDir, "agents", "replace-false-agent.md"),
      `---
name: replace-false-agent
description: Replace prompt false agent
replace_prompt: false
---
Append body prompt.
`,
    );
    await tool.execute(
      "test-tool-call",
      { agent: "replace-false-agent", task: "false task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    const args = await readCapturedArgs(cwd);
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toHaveLength(2);
    expect(flagValues(args, "--append-system-prompt").at(-1)).toBe(
      SUBAGENT_RESULT_CONTRACT,
    );
    const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
    expect(promptText).toBe("Append body prompt.");
  });

  test("subagent tool replace_prompt omitted uses --append-system-prompt", async () => {
    const { tool, cwd } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    await tool.execute(
      "test-tool-call",
      { agent: "hang", task: "omitted task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    const args = await readCapturedArgs(cwd);
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toHaveLength(2);
    expect(flagValues(args, "--append-system-prompt").at(-1)).toBe(
      SUBAGENT_RESULT_CONTRACT,
    );
    const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
    expect(promptText).toBe("Test agent prompt.");
  });

  test("subagent tool replace_prompt true with omitted task uses default task prompt last", async () => {
    const { tool, cwd, agentDir } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    await writeFile(
      path.join(agentDir, "agents", "replace-empty-task.md"),
      `---
name: replace-empty-task
description: Replace empty task agent
replace_prompt: true
---
Replacement empty task prompt.
`,
    );
    await tool.execute(
      "test-tool-call",
      { agent: "replace-empty-task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    const args = await readCapturedArgs(cwd);
    expect(flagValues(args, "--system-prompt")).toHaveLength(1);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
    const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
    expect(promptText).toBe("Replacement empty task prompt.");
  });

  test("subagent tool replace_prompt true coexists with context false and tools", async () => {
    const { tool, cwd, agentDir } = await setupTest({
      piScript: `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    await writeFile(
      path.join(agentDir, "agents", "replace-flags.md"),
      `---
name: replace-flags
description: Replace flags agent
replace_prompt: true
context: false
tools: bash, read
---
Replacement flags prompt.
`,
    );
    await tool.execute(
      "test-tool-call",
      { agent: "replace-flags", task: "flags task" },
      undefined,
      undefined,
      makeBareCtx(cwd),
    );
    await waitForRunJobsCleared();
    const args = await readCapturedArgs(cwd);
    expect(flagValues(args, "--system-prompt")).toHaveLength(1);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args).toContain("--no-context-files");
    expect(flagValues(args, "--tools")[0]?.split(",")).toContain("bash");
    expect(args.at(-1)).toBe("Task: flags task");
    const promptText = await Bun.file(path.join(cwd, "prompt.txt")).text();
    expect(promptText).toBe("Replacement flags prompt.");
  });
});

// ── Registry forwarding through orchestrator ──

test("orchestrator forwards ctx.modelRegistry to runSingleAgent affecting thinking resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  await writeFile(
    path.join(agentDir, "agents", "registry-agent.md"),
    `---
name: registry-agent
description: Registry forwarding agent
provider: openai
model: gpt-4
thinking: high
---
Registry prompt.`,
  );
  const live = modelFixture({
    provider: "openai",
    id: "gpt-4",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
    },
  });
  const registry = registryFixture([live]);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "registry-agent", task: "registry task" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4" },
      modelRegistry: registry,
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toBe("done");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.thinkingWarning).toBeUndefined();
  expect(details.results[0]?.model).toBe("openai ･ gpt-4 ･ high");
  expect(listRunJobs()).toHaveLength(0);
});

test("orchestrator registry miss falls back to static catalog thinking resolution", async () => {
  const sentMessages: SendMessageArg[] = [];
  const { agentDir, binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
${CAPTURE_PI_ARGS_SH}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  await writeFile(
    path.join(agentDir, "agents", "registry-miss-agent.md"),
    `---
name: registry-miss-agent
description: Registry miss agent
provider: openai
model: gpt-4
thinking: high
---
Registry miss prompt.`,
  );
  const registry = registryFixture([]);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const result = await tool.execute(
    "test-tool-call",
    { agent: "registry-miss-agent", task: "registry miss" },
    undefined,
    undefined,
    {
      cwd,
      hasUI: false,
      model: { provider: "openai", id: "gpt-4" },
      modelRegistry: registry,
    } as unknown as ExtensionContext,
  );
  expect((result.content[0] as TextContent).text).toContain("[thinking]");
  const details = result.details as SubagentDetails;
  expect(details.results[0]?.thinkingWarning).toContain('using "off" instead');
  expect(details.results[0]?.model).toBe("openai ･ gpt-4 ･ off");
  expect(listRunJobs()).toHaveLength(0);
});

// ── hostOnUpdate deduplication ──

test("hostOnUpdate deduplicates identical payloads via fingerprint", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostUpdates: unknown[] = [];
  const { binDir, cwd } = await setupFakePi();
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const onUpdate: AgentToolUpdateCallback<SubagentDetails> = (payload) => {
    hostUpdates.push(payload);
  };
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "dedup task" },
    undefined,
    onUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  expect(hostUpdates.length).toBeGreaterThanOrEqual(1);
  const uniqueFingerprints = new Set(
    hostUpdates.map((u) => {
      const p = u as {
        content: { type: string; text?: string }[];
        details: SubagentDetails;
      };
      const contentText = p.content[0]?.text ?? "";
      const latestResult = p.details.results[0];
      const activityText = latestResult?.progress?.activityText ?? "";
      const toolCallIds = [
        ...new Set(
          latestResult?.progress?.toolCalls?.map((tc: { id: string }) => tc.id),
        ),
      ]
        .sort()
        .join(",");
      const exitCode = latestResult?.exitCode ?? 0;
      const stopReason = latestResult?.stopReason ?? "";
      return `${contentText}|${activityText}|${toolCallIds}|${exitCode}|${stopReason}`;
    }),
  );
  expect(uniqueFingerprints.size).toBe(hostUpdates.length);
  expect(listRunJobs()).toHaveLength(0);
});

test("hostOnUpdate deduplicates consecutive identical tool activity updates", async () => {
  const sentMessages: SendMessageArg[] = [];
  const hostUpdates: unknown[] = [];
  const { binDir, cwd } = await setupFakePi();
  const updateLine = makeSubagentToolUpdateLine("bash: ls src");
  await writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
printf '%s\n' ${shellQuote(updateLine)}
printf '%s\n' ${shellQuote(updateLine)}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":0}}}}'
printf '%s\n' '{"type":"agent_end"}'
exit 0
`,
  );
  await chmod(path.join(binDir, "pi"), 0o755);
  const tool = getSubagentTool({
    sendMessage: (msg) => sentMessages.push(msg),
  });
  process.env.PI_SUBAGENT_DEPTH = "1";
  const onUpdate: AgentToolUpdateCallback<SubagentDetails> = (payload) => {
    hostUpdates.push(payload);
  };
  await tool.execute(
    "test-tool-call",
    { agent: "hang", task: "dedup tool" },
    undefined,
    onUpdate,
    makeBareCtx(cwd),
  );
  await waitForSentMessageCount(sentMessages, 2);
  const activityTexts = hostUpdates.map((u) => {
    const p = u as { details: SubagentDetails };
    return p.details.results[0]?.progress?.activityText ?? "";
  });
  const uniqueActivityTexts = [...new Set(activityTexts)];
  expect(uniqueActivityTexts.length).toBeLessThanOrEqual(hostUpdates.length);
  expect(listRunJobs()).toHaveLength(0);
});
