import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type AgentConfig, discoverAgentsAsync } from "../src/agent/agents.js";
import type { ModelRegistry } from "../src/child/model-resolution.js";
import { buildPiArgs } from "../src/child/pi-args.js";
import {
  makeEmitUpdate,
  type RunSingleAgentResult,
  runSingleAgent,
} from "../src/child/process.js";
import {
  resolvePackageExtensionPath,
  resolveSamplingExtensionPath,
} from "../src/child/process-utils.js";
import { SUBAGENT_RESULT_CONTRACT } from "../src/child/prompt-contract.js";
import {
  addMessageToResult,
  initRuntimeResult,
  type RuntimeResult,
  rebuildResultFromMessages,
} from "../src/child/result-builder.js";
import defaultSamplingExtension, {
  patchPayload,
} from "../src/child/sampling-extension.js";
import { parseSamplingParams } from "../src/shared/sampling.js";
import {
  type SingleResult,
  TOOL_RESULT_FAILED_MESSAGE,
} from "../src/shared/types.js";
import {
  resetResolvedAgentExtensionPathsCache,
  resetResolvedAgentSkillArgsCache,
  resolveAgentSkillArgs,
} from "../src/shared/utils.js";
import {
  CAPTURE_ARGS_PI_SCRIPT,
  emitAgentEnd,
  emitMessageEnd,
  flagValues,
  hangAgent,
  makeAssistantMessage,
  makeModelAgent,
  makeSubagentDetails,
  makeSubagentToolUpdateLine,
  modelFixture,
  registryFixture,
  setupFakePi,
  setupHooks,
  setupTest,
  shellQuote,
  unconfirmedWarning,
  waitFor,
  withMkdtempCapture,
} from "./helpers.js";

setupHooks();

type CapturableParentModel = {
  provider?: string | undefined;
  id?: string | undefined;
};

async function runCapturedModelAgent(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  parentThinking: AgentConfig["thinking"] = "off",
  options?: { registry?: ModelRegistry },
): Promise<{ args: string[]; result: SingleResult }> {
  const { cwd } = await setupTest({
    piScript: CAPTURE_ARGS_PI_SCRIPT,
  });
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    parentModel,
    parentThinking ?? "off",
    false,
    options,
  );
  expect(result.exitCode).toBe(0);
  return {
    args: fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n"),
    result,
  };
}

async function captureRunSingleAgentArgs(
  agent: AgentConfig,
  parentModel: CapturableParentModel | undefined,
  options: { registry?: ModelRegistry } = { registry: registryFixture([]) },
): Promise<string[]> {
  return (await runCapturedModelAgent(agent, parentModel, "off", options)).args;
}

test("runSingleAgent reports unknown agents with available names", async () => {
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "missing",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.agentSource).toBe("unknown");
  expect(result.stderr).toBe(
    'Unknown agent: "missing". Available agents: "hang".',
  );
});

test("runSingleAgent reports an externally terminated child instead of treating it as a clean exit", async () => {
  const { cwd } = await setupTest();
  const scriptPath = path.join(cwd, "external-termination-child.mjs");
  const pidPath = path.join(cwd, "external-termination-child.pid");
  fs.writeFileSync(
    scriptPath,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetTimeout(() => process.exit(0), 15000);\n`,
  );
  const controller = new AbortController();
  let pid: number | undefined;
  try {
    const pending = runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      controller.signal,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      { piInvocation: { command: "node", args: [scriptPath] } },
    );
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(pidPath)).toBe(true);
    pid = Number(fs.readFileSync(pidPath, "utf8"));
    process.kill(pid, "SIGKILL");
    const { result } = await pending;
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toMatch(
      /terminated by signal|exited with code/,
    );
  } finally {
    controller.abort();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already ended */
      }
    }
  }
});

test("runSingleAgent reports default depth limit with effective max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "3";
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 3/3");
});

test("runSingleAgent uses env-configured max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "4";
  process.env.PI_SUBAGENT_MAX_DEPTH = "5";
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("runSingleAgent reports clamped env max depth", async () => {
  process.env.PI_SUBAGENT_DEPTH = "10";
  process.env.PI_SUBAGENT_MAX_DEPTH = "99";
  const { result } = await runSingleAgent(
    "/tmp",
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("depth 10/10");
});

test("runSingleAgent resolves child model flags independently from agent and parent settings", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    providerFlags: string[];
    modelFlags: string[];
  }[] = [
    {
      name: "inherits both parent fields without overrides",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["parent-model"],
    },
    {
      name: "omits provider-only flag when agent overrides provider without model",
      agent: makeModelAgent({ provider: "agent-provider" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "inherits provider and overrides model",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["agent-model"],
    },
    {
      name: "overrides both fields",
      agent: makeModelAgent({
        provider: "agent-provider",
        model: "agent-model",
      }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["agent-provider"],
      modelFlags: ["agent-model"],
    },
    {
      name: "omits provider flag when parent model id is absent",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider" },
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "emits model only when parent provider remains absent",
      agent: makeModelAgent({}),
      parentModel: { id: "parent-model" },
      providerFlags: [],
      modelFlags: ["parent-model"],
    },
    {
      name: "omits provider flag without model when parent model absent",
      agent: makeModelAgent({ provider: "agent-provider" }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "emits model only without parent provider",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: ["agent-model"],
    },
    {
      name: "omits both flags without any effective settings",
      agent: makeModelAgent({ provider: undefined, model: undefined }),
      parentModel: undefined,
      providerFlags: [],
      modelFlags: [],
    },
    {
      name: "inherits parent when blank-normalized agent fields are absent",
      agent: makeModelAgent({ provider: undefined, model: undefined }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      providerFlags: ["parent-provider"],
      modelFlags: ["parent-model"],
    },
    {
      name: "passes invalid runtime strings unchanged",
      agent: makeModelAgent({ provider: "not/a/provider", model: "???" }),
      parentModel: undefined,
      providerFlags: ["not/a/provider"],
      modelFlags: ["???"],
    },
  ];
  for (const testCase of cases) {
    const args = await captureRunSingleAgentArgs(
      testCase.agent,
      testCase.parentModel,
    );
    expect(flagValues(args, "--provider"), testCase.name).toEqual(
      testCase.providerFlags,
    );
    expect(flagValues(args, "--model"), testCase.name).toEqual(
      testCase.modelFlags,
    );
  }
});

test("runSingleAgent applies effective model settings to thinking resolution", async () => {
  const { result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "high" }),
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    "low",
    { registry: registryFixture([]) },
  );
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain("provider: openai");
  expect(result.thinkingWarning).toContain("model: gpt-4");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent treats provider-only agent override as partial model", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "agent-provider", thinking: "high" }),
    { provider: "openai", id: "gpt-4" },
    "low",
  );
  expect(flagValues(args, "--provider")).toEqual([]);
  expect(flagValues(args, "--model")).toEqual([]);
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("agent-provider ･ high");
  expect(result.thinkingWarning).toContain("provider: agent-provider");
  expect(result.thinkingWarning).toContain("model: unknown");
  expect(result.thinkingWarning).toContain("requesting as-is");
});

test("runSingleAgent preserves requested thinking for partial or absent effective models", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    expectedModel: string;
  }[] = [
    {
      name: "model only",
      agent: makeModelAgent({ thinking: undefined }),
      parentModel: { id: "parent-model" },
      expectedModel: "parent-model ･ high",
    },
    {
      name: "provider only",
      agent: makeModelAgent({
        provider: "agent-provider",
        thinking: undefined,
      }),
      parentModel: undefined,
      expectedModel: "agent-provider ･ high",
    },
    {
      name: "absent model",
      agent: makeModelAgent({ thinking: undefined }),
      parentModel: undefined,
      expectedModel: "high",
    },
  ];
  for (const testCase of cases) {
    const { result } = await runCapturedModelAgent(
      testCase.agent,
      testCase.parentModel,
      "high",
    );
    expect(result.thinkingWarning, testCase.name).toBeDefined();
    expect(result.thinkingWarning, testCase.name).toContain("requesting as-is");
    expect(result.model, testCase.name).toBe(testCase.expectedModel);
  }
});

test("runSingleAgent prefers live registry match over static catalog", async () => {
  const live = modelFixture({
    provider: "openai",
    id: "gpt-4",
    reasoning: true,
  });
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({
      provider: "openai",
      model: "gpt-4",
      thinking: "high",
    }),
    undefined,
    "off",
    { registry: registryFixture([live]) },
  );
  expect(flagValues(args, "--provider")).toEqual(["openai"]);
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ high");
  expect(result.thinkingWarning).toBeUndefined();
});

test("runSingleAgent falls back to static catalog when live registry misses", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({
      provider: "openai",
      model: "gpt-4",
      thinking: "high",
    }),
    undefined,
    "off",
    { registry: registryFixture([]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent keeps requested thinking in child args when estimate clamps", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({
      provider: "openai",
      model: "gpt-4",
      thinking: "high",
    }),
    undefined,
    "off",
    { registry: registryFixture([]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent inherits parent thinking request when agent omits it", async () => {
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
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: undefined }),
    undefined,
    "high",
    { registry: registryFixture([live]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ high");
  expect(result.thinkingWarning).toBeUndefined();
});

test("runSingleAgent retains parent thinking request through catalog clamp", async () => {
  const { args, result } = await runCapturedModelAgent(
    makeModelAgent({ provider: "openai", model: "gpt-4", thinking: undefined }),
    undefined,
    "high",
    { registry: registryFixture([]) },
  );
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("runSingleAgent emits unavailable registry diagnostic and continues", async () => {
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "high" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["high"]);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("openai ･ gpt-4 ･ off");
    expect(warnSpy).toHaveBeenCalledWith(
      "Live model registry unavailable; falling back to static catalog.",
    );
  } finally {
    warnSpy.mockRestore();
  }
});

describe("unconfirmed thinking display propagation", () => {
  test("unknown model preserves requested level and emits exact unconfirmed warning", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({
        provider: "unknown",
        model: "unknown",
        thinking: "high",
      }),
      undefined,
      "off",
      { registry: registryFixture([]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["high"]);
    expect(result.model).toBe("unknown ･ unknown ･ high");
    expect(result.thinkingWarning).toBe(
      unconfirmedWarning("high", "unknown", "unknown"),
    );
  });

  test("missing identifiers preserve requested level with unknown placeholders", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ thinking: "medium" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["medium"]);
    expect(result.model).toBe("medium");
    expect(result.thinkingWarning).toBe(
      unconfirmedWarning("medium", undefined, undefined),
    );
  });

  test("missing identifiers with off thinking stay warning-free", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ thinking: "off" }),
      undefined,
      "off",
    );
    expect(flagValues(args, "--thinking")).toEqual(["off"]);
    expect(result.model).toBe("off");
    expect(result.thinkingWarning).toBeUndefined();
  });

  test("confirmed live model shows requested level without warning", async () => {
    const live = modelFixture({
      provider: "custom",
      id: "reasoner",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
      },
    });
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({
        provider: "custom",
        model: "reasoner",
        thinking: "medium",
      }),
      undefined,
      "off",
      { registry: registryFixture([live]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["medium"]);
    expect(result.model).toBe("custom ･ reasoner ･ medium");
    expect(result.thinkingWarning).toBeUndefined();
  });

  test("reasoning-disabled off request retains unsupported warning", async () => {
    const { args, result } = await runCapturedModelAgent(
      makeModelAgent({ provider: "openai", model: "gpt-4", thinking: "off" }),
      undefined,
      "off",
      { registry: registryFixture([]) },
    );
    expect(flagValues(args, "--thinking")).toEqual(["off"]);
    expect(result.model).toBe("openai ･ gpt-4 ･ off");
    expect(result.thinkingWarning).toContain('using "off" instead');
  });
});

test("runSingleAgent formats result model from effective non-empty parts", async () => {
  const cases: {
    name: string;
    agent: AgentConfig;
    parentModel: CapturableParentModel | undefined;
    expectedModel: string;
  }[] = [
    {
      name: "inherits full parent model",
      agent: makeModelAgent({}),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      expectedModel: "parent-provider ･ parent-model ･ off",
    },
    {
      name: "overrides model without leading slash",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: undefined,
      expectedModel: "agent-model ･ off",
    },
    {
      name: "omits empty provider with model override",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: undefined },
      expectedModel: "agent-model ･ off",
    },
    {
      name: "preserves effective provider and model suffix",
      agent: makeModelAgent({ model: "agent-model" }),
      parentModel: { provider: "parent-provider", id: "parent-model" },
      expectedModel: "parent-provider ･ agent-model ･ off",
    },
  ];
  for (const testCase of cases) {
    const { result } = await runCapturedModelAgent(
      testCase.agent,
      testCase.parentModel,
      "off",
      { registry: registryFixture([]) },
    );
    expect(result.model, testCase.name).toBe(testCase.expectedModel);
  }
});

test("runSingleAgent reports effective model display on skill resolution failure", async () => {
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [
      makeModelAgent({
        name: "bad-skill-model",
        model: "agent-model",
        skills: ["missing-skill"],
      }),
    ],
    "bad-skill-model",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    { provider: "parent-provider", id: "parent-model" },
    "off",
    false,
    { registry: registryFixture([]) },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.model).toBe("parent-provider ･ agent-model ･ off");
});

test("runSingleAgent truncates stderr to env-configured byte cap", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "7";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'abcdefghij' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("abcdefg");
});

test("runSingleAgent truncates multibyte stderr at valid UTF-8 byte boundaries", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "7";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'a😀b中c' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("a😀b");
  expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(7);
  expect(result.stderr).not.toContain("�");
});

test("runSingleAgent keeps empty stderr under configured byte cap", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "1";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.stderr).toBe("");
});

test("runSingleAgent caps spawn error stderr by configured byte limit", async () => {
  process.env.PI_SUBAGENT_MAX_STDERR_BYTES = "6";
  const { cwd } = await setupTest();
  const originalArgv1 = process.argv[1];
  const originalExecPath = process.execPath;
  process.argv[1] = "/non/existent/pi";
  process.execPath = "/non/existent/pi_exec";
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(6);
    expect(result.stderr).not.toContain("�");
  } finally {
    if (originalArgv1 !== undefined) process.argv[1] = originalArgv1;
    process.execPath = originalExecPath;
  }
});

test("runSingleAgent routes sleep inhibitor acquisition to the orchestrator PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'child pid %s' "$$" >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor(pid) {
        acquired.push(pid);
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  const childPid = Number(result.stderr.replace("child pid ", ""));
  expect(acquired).toEqual([process.pid]);
  expect(acquired[0]).not.toBe(childPid);
  expect(releases).toBe(1);
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toMatch(/^child pid \d+$/);
  expect(result.termination).toBeUndefined();
  expect(result.usage.input).toBe(1);
  expect(result.usage.output).toBe(1);
});

test("runSingleAgent rejects invalid orchestrator PIDs before sleep inhibitor acquisition", async () => {
  for (const orchestratorPid of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    let acquisitionAttempts = 0;
    const { cwd } = await setupTest();
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        getOrchestratorPid() {
          return orchestratorPid;
        },
        async acquireSleepInhibitor() {
          acquisitionAttempts += 1;
          return {
            async release() {},
          };
        },
      },
    );
    expect(acquisitionAttempts).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(result.termination).toBeUndefined();
  }
});

test("runSingleAgent handles throwing getOrchestratorPid gracefully", async () => {
  let acquisitionAttempts = 0;
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      getOrchestratorPid() {
        throw new Error("pid resolution failed");
      },
      async acquireSleepInhibitor() {
        acquisitionAttempts += 1;
        return {
          async release() {},
        };
      },
    },
  );
  expect(acquisitionAttempts).toBe(0);
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.termination).toBeUndefined();
});

test("runSingleAgent keeps acquisition and release failures invisible", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'child stderr' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result: releaseFailure } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            throw new Error("release failed");
          },
        };
      },
    },
  );
  const { result: acquisitionFailure } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        throw new Error("acquire failed");
      },
    },
  );
  expect(releaseFailure.exitCode).toBe(0);
  expect(releaseFailure.stderr).toBe("child stderr");
  expect(releaseFailure.finalOutput).toBe("done");
  expect(releaseFailure.termination).toBeUndefined();
  expect(acquisitionFailure.exitCode).toBe(0);
  expect(acquisitionFailure.stderr).toBe("child stderr");
  expect(acquisitionFailure.finalOutput).toBe("done");
  expect(acquisitionFailure.termination).toBeUndefined();
});

test("runSingleAgent settles immediate exit before delayed orchestrator sleep inhibitor acquisition", async () => {
  let acquiredPid: number | undefined;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'delayed stderr' >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"delayed done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resultPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor(pid) {
        acquiredPid = pid;
        return new Promise(() => {});
      },
    },
  );
  const result = await Promise.race([
    resultPromise,
    Bun.sleep(500).then(() => new Error("timed out waiting for result")),
  ]);
  expect(result).not.toBeInstanceOf(Error);
  const outcome = result as RunSingleAgentResult;
  expect(acquiredPid).toBe(process.pid);
  expect(outcome.kind).toBe("completed");
  expect(outcome.result.exitCode).toBe(0);
  expect(outcome.result.finalOutput).toBe("delayed done");
  expect(outcome.result.stderr).toBe("delayed stderr");
});

test("runSingleAgent handles host abort before delayed sleep inhibitor acquisition resolves", async () => {
  let acquired = false;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired = true;
        return new Promise(() => {});
      },
    },
  );
  await waitFor(
    () => acquired || undefined,
    "delayed sleep inhibitor acquisition",
  );
  controller.abort("host abort while acquiring");
  const outcome = await Promise.race([
    promise,
    Bun.sleep(500).then(() => {
      throw new Error("timed out waiting for abort");
    }),
  ]);
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination?.cancelReason).toBe(
    "host abort while acquiring",
  );
});

test("runSingleAgent releases injected sleep inhibitor after cancellation", async () => {
  let releases = 0;
  let acquired = false;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired = true;
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  await waitFor(() => acquired || undefined, "sleep inhibitor acquisition");
  controller.abort("cancelled");
  const cancelledOutcome = await promise;
  expect(cancelledOutcome.kind).toBe("aborted");
  expect(cancelledOutcome.result.termination?.cancelReason).toBe("cancelled");
  expect(cancelledOutcome.result.stderr).toBe("");
  expect(releases).toBe(1);
});

test("runSingleAgent releases injected sleep inhibitor after agent-end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toBe("");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
  expect(releases).toBe(1);
});

test("runSingleAgent releases injected sleep inhibitor after pre-aborted host signal", async () => {
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  controller.abort("host abort");
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  const preAbortedOutcome = await promise;
  expect(preAbortedOutcome.kind).toBe("aborted");
  expect(preAbortedOutcome.result.termination?.cancelReason).toBe("host abort");
  expect(preAbortedOutcome.result.stderr).toBe("");
  expect(releases).toBe(1);
});

test("runSingleAgent releases late-acquired sleep inhibitor handle after child completion", async () => {
  const releaseLog: string[] = [];
  let resolveAcquisition!: () => void;
  const acquisitionBarrier = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        await acquisitionBarrier;
        return {
          async release() {
            releaseLog.push("released");
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  resolveAcquisition();
  await Bun.sleep(20);
  expect(releaseLog).toEqual(["released"]);
});

test("runSingleAgent suppresses unhandled rejection from late-acquired release failure", async () => {
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let resolveAcquisition!: () => void;
  const acquisitionBarrier = new Promise<void>((resolve) => {
    resolveAcquisition = resolve;
  });
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      false,
      {
        async acquireSleepInhibitor() {
          await acquisitionBarrier;
          return {
            async release() {
              throw new Error("late release failure");
            },
          };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    resolveAcquisition();
    await Bun.sleep(20);
    expect(unhandledRejections).toHaveLength(0);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("runSingleAgent handles repeated release on the same handle silently", async () => {
  let releaseCalls = 0;
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            releaseCalls += 1;
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(releaseCalls).toBe(1);
});

test("runSingleAgent suppresses release failure on already-resolved handle", async () => {
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        return {
          async release() {
            throw new Error("release on resolved handle");
          },
        };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

test("runSingleAgent keeps concurrent sleep inhibitors independent", async () => {
  const releasePath = path.join("release-held");
  const releaseCounts = { cancelled: 0, held: 0 };
  const acquired = { cancelled: false, held: false };
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *cancelled-child*) trap 'exit 0' TERM; sleep 10 & wait $! ;;
  *held-child*) while [ ! -f release-held ]; do sleep 0.01; done; printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"held done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'; printf '%s\n' '{"type":"agent_end","messages":[]}'; exit 0 ;;
esac
`,
  });
  const controller = new AbortController();
  const cancelledPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "cancelled-child",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.cancelled = true;
        return {
          async release() {
            releaseCounts.cancelled += 1;
          },
        };
      },
    },
  );
  const heldPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "held-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.held = true;
        return {
          async release() {
            releaseCounts.held += 1;
          },
        };
      },
    },
  );
  await waitFor(
    () => (acquired.cancelled && acquired.held) || undefined,
    "concurrent sleep inhibitor acquisition",
  );
  controller.abort("cancelled child only");
  const cancelledOutcome2 = await cancelledPromise;
  expect(cancelledOutcome2.kind).toBe("aborted");
  expect(releaseCounts.cancelled).toBe(1);
  expect(releaseCounts.held).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const heldResult = await heldPromise;
  expect(heldResult.kind).toBe("completed");
  expect(heldResult.result.exitCode).toBe(0);
  expect(heldResult.result.finalOutput).toBe("held done");
  expect(heldResult.result.stderr).toBe("");
  expect(heldResult.result.usage.input).toBe(2);
  expect(heldResult.result.usage.output).toBe(3);
  expect(heldResult.result.termination).toBeUndefined();
  expect(releaseCounts.held).toBe(1);
});

test("runSingleAgent preserves default stdout drain after agent_end", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 0.05
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done after agent_end"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done after agent_end");
});

test("runSingleAgent honors explicit lower agent-end grace", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const startedAt = Date.now();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent cancels cleanly with nonstandard abort reason", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  controller.abort(null);
  const nonStandardOutcome = await promise;
  expect(nonStandardOutcome.kind).toBe("aborted");
});

test("runSingleAgent starts skill resolution and prompt setup concurrently", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "fast");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: fast
description: Fast skill
---
Use fast skill.
`,
  );
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let releaseReload = () => {};
  let reloadStarted = false;
  let writeStarted = false;
  let released = false;
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    reloadStarted = true;
    await reloadRelease;
    return originalReload.call(this);
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      writeStarted = true;
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "concurrent",
    description: "Concurrent agent",
    thinking: "off",
    systemPrompt: "Concurrent prompt.",
    source: "user",
    filePath: "concurrent.md",
    skills: ["fast"],
  };
  const promise = runSingleAgent(
    cwd,
    [agent],
    "concurrent",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseReload();
  };
  try {
    await waitFor(() => reloadStarted || undefined, "skill discovery start");
    await waitFor(() => writeStarted || undefined, "prompt write start");
    releaseOnce();
    const outcome = await promise;
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    releaseOnce();
    await promise.catch(() => {});
  }
});

test("runSingleAgent uses warmed skill cache without blocking prompt setup", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "warm");
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    skillPath,
    `---
name: warm
description: Warm skill
---
Use warm skill.
`,
  );
  resetResolvedAgentSkillArgsCache();
  expect(await resolveAgentSkillArgs(cwd, ["warm"])).toEqual({
    args: ["--skill", skillPath],
  });
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let reloadCalled = false;
  let promptWriteStarted = false;
  DefaultResourceLoader.prototype.reload = async function failWarmReload() {
    reloadCalled = true;
    throw new Error("warm cache missed");
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      if (String(args[1]).includes("Warm prompt.")) promptWriteStarted = true;
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "warm-agent",
    description: "Warm agent",
    thinking: "off",
    systemPrompt: "Warm prompt.",
    source: "user",
    filePath: "warm-agent.md",
    skills: ["warm"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "warm-agent",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(reloadCalled).toBe(false);
    expect(promptWriteStarted).toBe(true);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    resetResolvedAgentSkillArgsCache();
  }
});

test("runSingleAgent cleans prompt temp file when skill resolution fails after prompt creation", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "badskill",
    description: "Bad skill",
    thinking: "off",
    systemPrompt: "Prompt that creates a temp file.",
    source: "user",
    filePath: "badskill.md",
    skills: ["missing-skill"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "badskill",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown skill: "missing-skill"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent cleans prompt temp file when replacePrompt true and skill resolution fails", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "replace-badskill",
    description: "Replace bad skill",
    thinking: "off",
    systemPrompt: "Replacement prompt that creates a temp file.",
    replacePrompt: true,
    source: "user",
    filePath: "replace-badskill.md",
    skills: ["missing-skill"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "replace-badskill",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown skill: "missing-skill"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent cleans prompt temp file when extension resolution fails after prompt creation", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "badext",
    description: "Bad extension",
    thinking: "off",
    systemPrompt: "Prompt that creates a temp file.",
    source: "user",
    filePath: "badext.md",
    extensions: ["missing-ext"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "badext",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown extension: "missing-ext"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent returns skill error when both skill and extension resolution fail", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    name: "dual-fail",
    description: "Dual failure",
    thinking: "off",
    systemPrompt: "Prompt.",
    source: "user",
    filePath: "dual-fail.md",
    skills: ["missing-skill"],
    extensions: ["missing-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    "dual-fail",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.stderr).not.toContain('"missing-ext"');
});

test("runSingleAgent returns completed error when prompt setup fails", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  const writeError = new Error("ENOSPC: no space left on device");
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      const content = args[1];
      if (
        typeof content === "string" &&
        content.includes("Prompt setup fail.")
      ) {
        throw writeError;
      }
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "prompt-fail",
    description: "Prompt failure",
    thinking: "off",
    systemPrompt: "Prompt setup fail.",
    source: "user",
    filePath: "prompt-fail.md",
  };
  try {
    const outcome = await runSingleAgent(
      cwd,
      [agent],
      "prompt-fail",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(1);
    expect(outcome.result.stderr).toContain("Failed to write prompt");
    expect(outcome.result.stderr).toContain("ENOSPC");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
});

test("nested activity triggers onUpdate without appending messages", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading file.ts"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(1);
  const nestedUpdate = updates.find(
    (u) => u.text === "subagent - Reading file.ts",
  );
  expect(nestedUpdate).toBeDefined();
  expect(nestedUpdate?.messageCount).toBe(1);
});

test("nested activity with sensitive keywords is redacted", async () => {
  let capturedText = "";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Reading secret-token.yaml"))}
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      capturedText = partial.content[0]?.text ?? "";
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(capturedText).toBe("(running...)");
});

test("nested activity handles no-message no-terminal child exit", async () => {
  const updates: { text: string; messageCount: number }[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild running"))}
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      const text = partial.content[0]?.text ?? "";
      const msgCount = partial.details.results[0]?.messages?.length ?? 0;
      updates.push({ text, messageCount: msgCount });
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(0);
  expect(result.progress?.activityText).toBe("subagent - Grandchild running");
  expect(updates).toContainEqual({
    text: "subagent - Grandchild running",
    messageCount: 0,
  });
});

test("child tool events replace nested activity in subsequent updates", async () => {
  const texts: string[] = [];
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' ${shellQuote(makeSubagentToolUpdateLine("Grandchild working"))}
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"ls"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(texts).toContain("subagent - Grandchild working");
  expect(texts.some((t) => t.includes("bash"))).toBe(true);
  const nestedIdx = texts.indexOf("subagent - Grandchild working");
  const toolIdx = texts.findIndex((t) => t.includes("bash"));
  expect(toolIdx).toBeGreaterThan(nestedIdx);
});

test("SUBAGENT_RESULT_CONTRACT contains complete tool instructions", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toContain(
    "Write the complete task result as assistant text",
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /Call `complete` as the final action/,
  );
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(/one-sentence progress/i);
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(/Outcome: <short/);
});

test("SUBAGENT_RESULT_CONTRACT narrows code-block constraint to entire-result wrapper", () => {
  expect(SUBAGENT_RESULT_CONTRACT).toMatch(
    /NEVER.*wrap the entire result in a code block/i,
  );
  expect(SUBAGENT_RESULT_CONTRACT).not.toMatch(
    /NEVER.*wrap result in code blocks/i,
  );
});

// Helper: build a minimal RuntimeResult with a tool-call message so deriveStreamingProgress produces activeToolActivity
function makeRuntimeWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
) {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-1", name: toolName, arguments: args },
      ],
    },
  ] as Message[];
  return {
    agent: "test",
    agentSource: "user" as const,
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
    messages,
  } as SingleResult & { messages: Message[] };
}

test("makeEmitUpdate merge: inputSummary === toolName fallback does not overwrite parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary from makeToolPreview("subagent", ...) → "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends bare toolName fallback (inputSummary === toolName) — should retain parent's richer value
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "subagent" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
});

test("makeEmitUpdate merge: inputSummary !== toolName overwrites parent inputSummary", () => {
  // deriveStreamingProgress produces inputSummary: "subagent" (bare toolName from makeToolPreview)
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Parser sends richer inputSummary from nested child (different from toolName "subagent")
  emitUpdate({
    toolActivity: { toolName: "subagent", inputSummary: "bash: scan src" },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "bash: scan src",
  });
});

test("makeEmitUpdate merge: incoming without inputSummary preserves parent inputSummary", () => {
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const emitUpdate = makeEmitUpdate(result, undefined, makeSubagentDetails);
  // Incoming has no inputSummary — merge should keep parent's richer semantic value
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      child: { toolName: "bash", inputSummary: "bash: ls" },
    },
  });
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
    child: { toolName: "bash", inputSummary: "bash: ls" },
  });
});

test("makeEmitUpdate streaming integration: subagent preview starts with semantic target then updated to richer parser inputSummary", () => {
  // deriveStreamingProgress produces activeToolActivity with inputSummary from semantic lookup: "subagent: builder"
  const result = makeRuntimeWithToolCall("subagent", {
    agent: "builder",
    task: "fix bugs",
    agentScope: "project",
  });
  const texts: string[] = [];
  const emitUpdate = makeEmitUpdate(
    result,
    (partial) => {
      texts.push(partial.content[0]?.text ?? "");
    },
    makeSubagentDetails,
  );
  // First call triggers deriveStreamingProgress and sets result.progress
  emitUpdate();
  // progress derived from messages: makeToolPreview("subagent", ...) → "subagent: builder" (semantic lookup)
  expect(result.progress?.activeToolActivity).toEqual({
    toolName: "subagent",
    inputSummary: "subagent: builder",
  });
  expect(result.progress?.activityText).toBe("subagent: builder");
  // Parser sends richer nested child data — merge prefers incoming inputSummary
  emitUpdate({
    toolActivity: {
      toolName: "subagent",
      inputSummary: "bash: scan src",
      child: { toolName: "bash", inputSummary: "bash: scan src" },
    },
  });
  expect(result.progress?.activeToolActivity?.inputSummary).toBe(
    "bash: scan src",
  );
  // renderToolActivity walks full tree: parent + child joined with " - "
  expect(result.progress?.activityText).toBe("bash: scan src - bash: scan src");
});

test("runSingleAgent releases sleep inhibitor after spawn error with valid PID", async () => {
  const acquired: number[] = [];
  let releases = 0;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'spawn error stderr' >&2
exit 1
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor(pid) {
        acquired.push(pid);
        return {
          async release() {
            releases += 1;
          },
        };
      },
    },
  );
  expect(acquired).toHaveLength(1);
  expect(Number.isFinite(acquired[0])).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(releases).toBe(1);
});

test("runSingleAgent agent-end timeout with empty output returns exit code 1", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.finalOutput).toBe("");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent treats earlier assistant text as completed output after agent-end timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"earlier done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"pwd"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("earlier done");
  expect(result.messages).toHaveLength(2);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

describe("agent_end message snapshot rebuild", () => {
  async function runSnapshotScript(lines: string[]): Promise<SingleResult> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
${lines.join("\n")}
exit 0
`,
    });
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    return result;
  }

  test("non-empty agent_end messages restore missed final streamed message", async () => {
    const streamed = makeAssistantMessage("streamed", {
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0.1 },
      },
    });
    const missed = makeAssistantMessage("missed final", {
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 7,
        cost: { total: 0.2 },
      },
      stopReason: "length",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([streamed, missed]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("missed final");
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(4);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cacheRead).toBe(1);
    expect(result.usage.cacheWrite).toBe(2);
    expect(result.usage.cost).toBeCloseTo(0.3);
    expect(result.stopReason).toBe("length");
  });

  test("empty agent_end messages preserve streamed state", async () => {
    const streamed = makeAssistantMessage("streamed only", {
      usage: {
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { total: 0.4 },
      },
      stopReason: "stop",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(streamed),
      emitAgentEnd([]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("streamed only");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.input).toBe(5);
    expect(result.usage.output).toBe(6);
    expect(result.usage.cost).toBe(0.4);
    expect(result.stopReason).toBe("stop");
  });

  test("snapshot rebuild recomputes derived result fields", async () => {
    const stale = makeAssistantMessage("stale", {
      usage: {
        input: 100,
        output: 200,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 300,
        cost: { total: 9 },
      },
      stopReason: "length",
      errorMessage: "stale error",
    });
    const authoritative = makeAssistantMessage("authoritative", {
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 6,
        cost: { total: 0.7 },
      },
      stopReason: "error",
      errorMessage: "final error",
    });
    const result = await runSnapshotScript([
      emitMessageEnd(stale),
      emitAgentEnd([authoritative]),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.messages).toHaveLength(1);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(2);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBe(0.7);
    expect(result.usage.contextTokens).toBe(6);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("final error");
  });
});

test("runSingleAgent writes unknown events to stderr when debug diagnostics enabled", async () => {
  const stderrWrite = process.stderr.write;
  const written: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\n' 'malformed json'
printf '%s\n' '{"type":"unknown_type","data":1}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(written.some((w) => w.includes("malformed"))).toBe(true);
    expect(written.some((w) => w.includes("unknown"))).toBe(true);
  } finally {
    process.stderr.write = stderrWrite;
  }
});

test("runSingleAgent acquisition failure on one concurrent child does not affect the other", async () => {
  const releaseCounts = { failing: 0, succeeding: 0 };
  const acquired = { failing: false, succeeding: false };
  const releasePath = path.join("release-succeeding");
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
case "$*" in
  *failing-child*) exit 1 ;;
  *succeeding-child*) while [ ! -f release-succeeding ]; do sleep 0.01; done; printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"succeeding done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'; printf '%s\n' '{"type":"agent_end","messages":[]}'; exit 0 ;;
esac
`,
  });
  const failingPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "failing-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.failing = true;
        throw new Error("acquire failed");
      },
    },
  );
  const succeedingPromise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "succeeding-child",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      async acquireSleepInhibitor() {
        acquired.succeeding = true;
        return {
          async release() {
            releaseCounts.succeeding += 1;
          },
        };
      },
    },
  );
  await waitFor(
    () => (acquired.failing && acquired.succeeding) || undefined,
    "concurrent acquisition attempts",
  );
  const failingResult = await failingPromise;
  expect(failingResult.kind).toBe("completed");
  expect(failingResult.result.exitCode).toBe(1);
  expect(releaseCounts.failing).toBe(0);
  await fs.promises.writeFile(path.join(cwd, releasePath), "release");
  const succeedingResult = await succeedingPromise;
  expect(succeedingResult.kind).toBe("completed");
  expect(succeedingResult.result.exitCode).toBe(0);
  expect(succeedingResult.result.finalOutput).toBe("succeeding done");
  expect(releaseCounts.succeeding).toBe(1);
});

test("runSingleAgent default host adapter returns no-op handle on non-darwin platform", async () => {
  const { cwd } = await setupTest();
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
  expect(result.stderr).toBe("");
});

describe("usage accumulation via runSingleAgent", () => {
  async function runUsageTest(
    piScript: string,
    options?: { debug?: boolean },
  ): Promise<SingleResult> {
    const { cwd } = await setupTest({ piScript });
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      options?.debug,
    );
    return result;
  }

  test("assistant messages increment turns and aggregate usage fields", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"fake-model","usage":{"input":10,"output":5,"cacheRead":3,"cacheWrite":2,"totalTokens":15,"cost":{"total":0.5}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"fake-model-2","usage":{"input":20,"output":10,"cacheRead":7,"cacheWrite":4,"totalTokens":30,"cost":{"total":1.0}},"stopReason":"length","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(30);
    expect(result.usage.output).toBe(15);
    expect(result.usage.cacheRead).toBe(10);
    expect(result.usage.cacheWrite).toBe(6);
    expect(result.usage.cost).toBe(1.5);
    expect(result.usage.contextTokens).toBe(30);
    expect(result.model).toBe("off");
    expect(result.stopReason).toBe("length");
  });

  test("messages without usage keep defaults and increment turns", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no usage"}],"api":"fake","provider":"fake","model":"fake","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(0);
    expect(result.usage.output).toBe(0);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheWrite).toBe(0);
    expect(result.usage.cost).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
    expect(result.usage.contextWindowTokens).toBeUndefined();
  });

  test("non-assistant messages do not affect usage", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"toolResult","content":[{"type":"text","text":"tool result"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":5,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":10,"cost":{"total":0.1}},"timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(0);
    expect(result.usage.input).toBe(0);
    expect(result.usage.output).toBe(0);
    expect(result.usage.cacheRead).toBe(0);
    expect(result.usage.cacheWrite).toBe(0);
    expect(result.usage.cost).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
  });

  test("missing cost keeps cost at zero", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no cost"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(1);
    expect(result.usage.output).toBe(2);
    expect(result.usage.cost).toBe(0);
  });

  test("missing totalTokens keeps contextTokens at zero", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no totalTokens"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextTokens).toBe(0);
  });

  test("contextWindowTokens omitted when model not found", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"no context window"}],"api":"fake","provider":"fake","model":"nonexistent","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextWindowTokens).toBeUndefined();
  });

  test("multiple assistant messages accumulate cache and cost correctly", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":5,"totalTokens":150,"cost":{"total":2.5}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":200,"output":100,"cacheRead":20,"cacheWrite":10,"totalTokens":300,"cost":{"total":5.0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"third"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":50,"output":25,"cacheRead":5,"cacheWrite":2,"totalTokens":75,"cost":{"total":1.25}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.turns).toBe(3);
    expect(result.usage.input).toBe(350);
    expect(result.usage.output).toBe(175);
    expect(result.usage.cacheRead).toBe(35);
    expect(result.usage.cacheWrite).toBe(17);
    expect(result.usage.cost).toBe(8.75);
    expect(result.usage.contextTokens).toBe(75);
  });

  test("model and stopReason set from last assistant message", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"api":"fake","provider":"fake","model":"model-a","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"second"}],"api":"fake","provider":"fake","model":"model-b","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"length","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("off");
    expect(result.stopReason).toBe("length");
  });

  test("contextWindowTokens set from valid model provider and model", async () => {
    const piScript = `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"openai","model":"gpt-4","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
    const result = await runUsageTest(piScript);
    expect(result.exitCode).toBe(0);
    expect(result.usage.contextWindowTokens).toBe(8192);
  });
});

test("tool_result_end event sets toolResultCompleted flag", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"tool_result_end","message":{"role":"toolResult","content":[{"type":"text","text":"tool output"}],"api":"fake","provider":"fake","model":"fake","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.progress?.toolResultCompleted).toBe(true);
});

test("tool_execution_update event updates activity text", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"tool_execution_update","toolName":"bash","partialResult":{"content":[],"details":{}}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  let lastUpdate: unknown;
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    (update) => {
      lastUpdate = update;
    },
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(lastUpdate).toBeDefined();
});

test("debug event diagnostics logs malformed JSON", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' 'not valid json'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(
      stderrChunks.some((chunk) =>
        chunk.includes("[pi-subagent:unknown-event] malformed:"),
      ),
    ).toBe(true);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("debug event diagnostics logs unknown event types", async () => {
  const piScript = `#!/bin/sh
printf '%s\n' '{"type":"unknown_type","data":"test"}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(
      stderrChunks.some((chunk) =>
        chunk.includes("[pi-subagent:unknown-event] unknown:"),
      ),
    ).toBe(true);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("pre-aborted signal triggers immediate termination", async () => {
  const piScript = `#!/bin/sh
sleep 10
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const controller = new AbortController();
  controller.abort("pre-aborted");
  const outcome = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.termination).toBeDefined();
  expect(outcome.result.termination?.cancelReason).toBe("pre-aborted");
});

test("runSingleAgent injects the complete extension", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).toContain("--extension");
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(1);
  expect(extPaths[0] ?? "").toContain("complete-extension");
});

test("runSingleAgent omits --tools when agent has no tools", async () => {
  const args = await captureRunSingleAgentArgs(makeModelAgent({}), undefined);
  expect(args).not.toContain("--tools");
});

test("runSingleAgent appends complete to the agent tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "write", "complete"]);
  expect(agent.tools).toEqual(["read", "write"]);
});

test("runSingleAgent preserves existing complete in the tool allowlist", async () => {
  const agent = makeModelAgent({ tools: ["read", "complete", "write"] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual(["read", "complete", "write"]);
});

test("runSingleAgent injects complete into an empty tool allowlist", async () => {
  const agent = makeModelAgent({ tools: [] });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["complete"]);
  expect(agent.tools).toEqual([]);
});

test("runSingleAgent deduplicates complete in the tool allowlist", async () => {
  const agent = makeModelAgent({
    tools: ["read", "complete", "complete", "write", "complete"],
  });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--tools");
  const toolsList = flagValues(args, "--tools")[0] ?? "";
  expect(toolsList.split(",")).toEqual(["read", "complete", "write"]);
  expect(agent.tools).toEqual([
    "read",
    "complete",
    "complete",
    "write",
    "complete",
  ]);
});

test("runSingleAgent extracts outcome from toolResult details", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"A beautiful outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"A beautiful outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("A beautiful outcome");
});

test("runSingleAgent suppresses outcome from assistant arguments when toolResult is missing", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Assistant outcome"}}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("Assistant outcome");
});

test("runSingleAgent prefers toolResult details.outcome over assistant arguments.outcome", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Assistant outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Tool outcome beats assistant"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("Assistant outcome");
});

test("runSingleAgent ignores blank or malformed outcomes", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"   "}}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent ignores outcome on failed complete call", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Should be ignored"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.outcome).toBe("Should be ignored");
});

test("runSingleAgent handles multiple complete calls, newer invalid/blank calls do not block older valid outcomes", async () => {
  const piScript = `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"First valid"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"First valid"}}}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-2","name":"complete","arguments":{"outcome":"   "}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-2","details":{"outcome":"   "}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`;
  const { cwd } = await setupTest({ piScript });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("First valid");
});

test("runSingleAgent preserves outcome during agent-end timeout with no assistant text", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Timed out outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Timed out outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("Timed out outcome");
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
});

test("runSingleAgent deletes extracted outcome when child exits non-zero", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Should be deleted"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Should be deleted"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 1
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent deletes extracted outcome when host aborts after outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
trap 'exit 0' TERM
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Aborted outcome"}}]}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","details":{"outcome":"Aborted outcome"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const controller = new AbortController();
  const promise = runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    controller.signal,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  controller.abort("host abort after outcome");
  const outcome = await promise;
  expect(outcome.kind).toBe("aborted");
  expect(outcome.result.outcome).toBeUndefined();
  expect(outcome.result.termination?.cancelReason).toBe(
    "host abort after outcome",
  );
});

describe("T-003: parseSamplingParams", () => {
  test("parses valid full sampling parameters", () => {
    const res = parseSamplingParams('{"temperature":0.5,"topP":0.8}');
    expect(res).toEqual({ temperature: 0.5, topP: 0.8 });
  });

  test("parses valid single temperature parameter", () => {
    const res = parseSamplingParams('{"temperature":0.7}');
    expect(res).toEqual({ temperature: 0.7 });
  });

  test("parses valid single topP parameter", () => {
    const res = parseSamplingParams('{"topP":0.1}');
    expect(res).toEqual({ topP: 0.1 });
  });

  test("returns undefined for missing or empty env val", () => {
    expect(parseSamplingParams()).toBeUndefined();
    expect(parseSamplingParams("")).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    expect(parseSamplingParams("{invalid}")).toBeUndefined();
  });

  test("returns undefined for non-object JSON", () => {
    expect(parseSamplingParams("42")).toBeUndefined();
    expect(parseSamplingParams('"string"')).toBeUndefined();
    expect(parseSamplingParams("[]")).toBeUndefined();
  });

  test("ignores unsupported keys", () => {
    const res = parseSamplingParams('{"temperature":0.5,"unsupported":123}');
    expect(res).toEqual({ temperature: 0.5 });
  });

  test("ignores invalid temperature values", () => {
    expect(parseSamplingParams('{"temperature":1.5}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":-0.1}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":"0.5"}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":NaN}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":Infinity}')).toBeUndefined();
  });

  test("ignores invalid topP values", () => {
    expect(parseSamplingParams('{"topP":1.1}')).toBeUndefined();
    expect(parseSamplingParams('{"topP":-0.01}')).toBeUndefined();
    expect(parseSamplingParams('{"topP":null}')).toBeUndefined();
  });

  test("accepts valid value when other value is invalid in both directions", () => {
    const res1 = parseSamplingParams('{"temperature":0.5,"topP":1.5}');
    expect(res1).toEqual({ temperature: 0.5 });
    const res2 = parseSamplingParams('{"temperature":-0.5,"topP":0.8}');
    expect(res2).toEqual({ topP: 0.8 });
  });

  test("returns undefined for unsupported-only and invalid-only inputs", () => {
    expect(parseSamplingParams('{"unsupported":123}')).toBeUndefined();
    expect(parseSamplingParams('{"temperature":-1}')).toBeUndefined();
    expect(parseSamplingParams('{"topP":2}')).toBeUndefined();
  });

  test("accepts boundary values 0 and 1", () => {
    const res = parseSamplingParams('{"temperature":0,"topP":1}');
    expect(res).toEqual({ temperature: 0, topP: 1 });
  });
});

describe("T-004: patchPayload", () => {
  test("patches flat payloads without mutating original", () => {
    const payload = Object.freeze({ model: "claude-3-5", messages: [] });
    const params = { temperature: 0.2, topP: 0.9 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "claude-3-5",
      messages: [],
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(patched).not.toBe(payload);
  });

  test("patches flat payload with temperature only", () => {
    const payload = { model: "gpt-4", prompt: "hi" };
    const params = { temperature: 0.5 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      prompt: "hi",
      temperature: 0.5,
    });
  });

  test("patches flat payload with topP only", () => {
    const payload = { model: "gpt-4", prompt: "hi" };
    const params = { topP: 0.3 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      prompt: "hi",
      top_p: 0.3,
    });
  });

  test("patches generationConfig payloads without mutating original", () => {
    const innerConfig = Object.freeze({ maxOutputTokens: 100 });
    const payload = Object.freeze({
      model: "gemini",
      generationConfig: innerConfig,
    });
    const params = { temperature: 0.4, topP: 0.7 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.4,
        topP: 0.7,
      },
    });
    expect(patched).not.toBe(payload);
    expect(patched["generationConfig"]).not.toBe(innerConfig);
  });

  test("patches generationConfig payload with single field", () => {
    const payload = { model: "gemini", generationConfig: { topP: 0.1 } };
    const params = { temperature: 0.9 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: {
        topP: 0.1,
        temperature: 0.9,
      },
    });
  });

  test("overwrites existing sampling keys in flat payload", () => {
    const payload = { model: "gpt-4", temperature: 0.9, top_p: 0.2 };
    const params = { temperature: 0.5, topP: 0.8 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gpt-4",
      temperature: 0.5,
      top_p: 0.8,
    });
  });

  test("treats non-object generationConfig as empty object", () => {
    const payload = { model: "gemini", generationConfig: null };
    const params = { temperature: 0.3, topP: 0.6 };
    const patched = patchPayload(payload, params);
    expect(patched).toEqual({
      model: "gemini",
      generationConfig: { temperature: 0.3, topP: 0.6 },
    });
  });
});

describe("T-004: sampling extension hook registration and execution", () => {
  function makeTrackingPi(): {
    pi: ExtensionAPI;
    getHandler: () => ((event: { payload: unknown }) => unknown) | undefined;
  } {
    let hookHandler: ((event: { payload: unknown }) => unknown) | undefined;
    const pi = {
      on(event: string, handler: (event: { payload: unknown }) => unknown) {
        if (event === "before_provider_request") hookHandler = handler;
      },
    } as unknown as ExtensionAPI;
    return { pi, getHandler: () => hookHandler };
  }

  function withSamplingEnv(params: string, fn: () => void): void {
    process.env["PI_SAMPLING_PARAMS"] = params;
    try {
      fn();
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  }

  test("registers before_provider_request and patches when PI_SAMPLING_PARAMS is set", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      const patched = handler?.({
        payload: { model: "claude-3", messages: [] },
      });
      expect(patched).toEqual({
        model: "claude-3",
        messages: [],
        temperature: 0.1,
      });
    });
  });

  test("does not register handler when PI_SAMPLING_PARAMS is not set", () => {
    const { pi, getHandler } = makeTrackingPi();
    defaultSamplingExtension(pi);
    expect(getHandler()).toBeUndefined();
  });

  test("does not register handler when PI_SAMPLING_PARAMS contains invalid JSON", () => {
    withSamplingEnv("{invalid}", () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      expect(getHandler()).toBeUndefined();
    });
  });

  test("does not mutate original payload in hook execution", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      const payload = Object.freeze({
        model: "claude-3",
        messages: Object.freeze([]),
      });
      const patched = handler?.({ payload });
      expect(patched).toEqual({
        model: "claude-3",
        messages: [],
        temperature: 0.1,
      });
      expect(patched).not.toBe(payload);
    });
  });

  test("returns undefined for non-object payload", () => {
    withSamplingEnv(JSON.stringify({ temperature: 0.1 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      expect(handler?.({ payload: null })).toBeUndefined();
      expect(handler?.({ payload: "string" })).toBeUndefined();
    });
  });

  test("returns undefined for array payload", () => {
    withSamplingEnv(JSON.stringify({ topP: 0.5 }), () => {
      const { pi, getHandler } = makeTrackingPi();
      defaultSamplingExtension(pi);
      const handler = getHandler();
      expect(handler).toBeDefined();
      expect(handler?.({ payload: [] })).toBeUndefined();
    });
  });
});

describe("T-002: Wire child-scoped sampling env and extension loading", () => {
  async function runCapturedAgentWithParams(
    agent: AgentConfig,
  ): Promise<{ args: string[]; envSampling: string; result: SingleResult }> {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' "$PI_SAMPLING_PARAMS" > env_sampling.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
    });
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const envSampling = fs
      .readFileSync(path.join(cwd, "env_sampling.txt"), "utf8")
      .trim();
    return { args, envSampling, result };
  }

  function getExtensionPaths(args: string[]): string[] {
    return args.flatMap((arg, i) =>
      arg === "--extension" ? [args[i + 1] ?? ""] : [],
    );
  }

  function expectExtensions(args: string[], count: number): void {
    const extensions = getExtensionPaths(args);
    expect(extensions).toHaveLength(count);
    expect(extensions[0]).toContain("complete-extension");
    if (count > 1) expect(extensions[1]).toContain("sampling-extension");
  }

  test("sampling-enabled agent spawn includes correct environment variable and both complete and sampling extension args", async () => {
    const agent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.7,
      topP: 0.9,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.7,"topP":0.9}');
    expectExtensions(args, 2);
  });

  test("agent with temperature only includes only temperature in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "temp-only-agent",
      temperature: 0.3,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"temperature":0.3}');
    expectExtensions(args, 2);
  });

  test("agent with topP only includes only topP in environment variable and loads sampling extension", async () => {
    const agent = makeModelAgent({
      name: "topp-only-agent",
      topP: 0.25,
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe('{"topP":0.25}');
    expectExtensions(args, 2);
  });

  test("agent without sampling values omits sampling env and sampling extension args while still loading the complete extension", async () => {
    const agent = makeModelAgent({
      name: "no-sampling-agent",
    });
    const { args, envSampling } = await runCapturedAgentWithParams(agent);

    expect(envSampling).toBe("");
    expectExtensions(args, 1);
    expect(args.join(" ")).not.toContain("sampling-extension");
  });

  test("concurrent or sequential different agents do not leak sampling values across runs", async () => {
    const samplingAgent = makeModelAgent({
      name: "sampling-agent",
      temperature: 0.5,
    });
    const plainAgent = makeModelAgent({
      name: "plain-agent",
    });

    const run1 = await runCapturedAgentWithParams(samplingAgent);
    const run2 = await runCapturedAgentWithParams(plainAgent);

    expect(run1.envSampling).toBe('{"temperature":0.5}');
    expect(run2.envSampling).toBe("");
  });

  test("no-sampling agent removes inherited parent PI_SAMPLING_PARAMS from child env", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.1}';
    try {
      const agent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const { args, envSampling } = await runCapturedAgentWithParams(agent);
      expect(envSampling).toBe("");
      expect(args.join(" ")).not.toContain("sampling-extension");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });

  test("concurrent mixed sampling and no-sampling runs are isolated and do not contaminate or leak", async () => {
    process.env["PI_SAMPLING_PARAMS"] = '{"temperature":0.8}';
    try {
      const samplingAgent = makeModelAgent({
        name: "sampling-agent",
        temperature: 0.4,
      });
      const noSamplingAgent = makeModelAgent({
        name: "no-sampling-agent",
      });
      const [run1, run2] = await Promise.all([
        runCapturedAgentWithParams(samplingAgent),
        runCapturedAgentWithParams(noSamplingAgent),
      ]);
      expect(run1.envSampling).toBe('{"temperature":0.4}');
      expect(run2.envSampling).toBe("");
    } finally {
      delete process.env["PI_SAMPLING_PARAMS"];
    }
  });
});

describe("T-006: resolveSamplingExtensionPath", () => {
  function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sampling-ext-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("returns primary runtime extension when sampling-extension.ts exists", () => {
    withTempDir((dir) => {
      const expected = path.join(dir, "sampling-extension.ts");
      fs.writeFileSync(expected, "");
      const resolved = resolveSamplingExtensionPath(dir);
      expect(resolved).toBe(expected);
    });
  });

  test("falls back to alternate extension when only sampling-extension.js exists", () => {
    withTempDir((dir) => {
      const expected = path.join(dir, "sampling-extension.js");
      fs.writeFileSync(expected, "");
      const resolved = resolveSamplingExtensionPath(dir);
      expect(resolved).toBe(expected);
    });
  });

  test("throws when neither sampling-extension.ts nor sampling-extension.js exists", () => {
    withTempDir((dir) => {
      expect(() => resolveSamplingExtensionPath(dir)).toThrow(
        /sampling-extension not found/,
      );
    });
  });

  test("defaults to module directory and returns existing file", () => {
    const resolved = resolveSamplingExtensionPath();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toMatch(/sampling-extension\.ts$/);
    expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe("process cleanup", () => {
  test("runSingleAgent destroys idle streams when the child exits with an inherited open pipe", async () => {
    const { cwd } = await setupTest({
      piScript: `#!/bin/sh
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\n' '{"type":"agent_end","messages":[]}'
(sleep 0.5 &)
exit 0
`,
    });
    const startedAt = Date.now();
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
  });
});

test("runSingleAgent adds sampling extension when agent provides temperature or topP", async () => {
  const agent = makeModelAgent({ temperature: 0.5, topP: 0.9 });
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const extPaths = flagValues(args, "--extension");
  expect(extPaths.length).toBe(2);
  expect(extPaths.some((p) => p.includes("sampling-extension"))).toBe(true);
  expect(extPaths.some((p) => p.includes("complete-extension"))).toBe(true);
});

test("runSingleAgent emits unknown-event diagnostics when debugEventDiagnostics is enabled", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' 'not valid json'
printf '%s\\n' '{"type":"unknown_kind","payload":1}'
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const stderrChunks: string[] = [];
  const writeSpy = spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    const { result } = await runSingleAgent(
      cwd,
      [hangAgent],
      "hang",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
      true,
    );
    expect(result.exitCode).toBe(0);
    const diagnostic = stderrChunks.join("");
    expect(diagnostic).toContain("[pi-subagent:unknown-event]");
    expect(diagnostic).toContain("malformed:");
    expect(diagnostic).toContain("unknown:");
  } finally {
    writeSpy.mockRestore();
  }
});

test("runSingleAgent strips leading Terminated lines from stderr on agent_end_timeout", async () => {
  process.env.PI_SUBAGENT_AGENT_END_GRACE_MS = "25";
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf 'Terminated\\nother stderr\\n' >&2
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
sleep 10 &
wait $!
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.termination?.cancelReason).toBe("agent_end_timeout");
  expect(result.stderr).not.toContain("Terminated");
  expect(result.stderr).toContain("other stderr");
});

test("runSingleAgent sets errorMessage when a toolResult error occurs without a complete outcome", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"false"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"content":[{"type":"text","text":"error"}]}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBeUndefined();
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent preserves complete outcome when complete toolResult errors", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"complete","arguments":{"outcome":"Completed despite error"}}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"tool_result_end","message":{"role":"toolResult","toolCallId":"tc-1","isError":true,"details":{"outcome":"Completed despite error"}}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("Completed despite error");
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
});

test("runSingleAgent extracts complete outcome from agent_end snapshot despite toolResult error", async () => {
  const assistantMsg = makeAssistantMessage("used complete", {
    content: [
      {
        type: "toolCall",
        id: "tc-complete",
        name: "complete",
        arguments: { outcome: "Snapshot succeeded" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-complete",
    isError: true,
    content: [{ type: "text", text: "complete toolResult error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistantMsg)}
${emitAgentEnd([assistantMsg, toolError])}
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.outcome).toBe("Snapshot succeeded");
  expect(result.messages).toHaveLength(2);
});

test("runSingleAgent rebuilds agent_end snapshot and propagates toolResult error", async () => {
  const assistant = makeAssistantMessage("used tool", {
    content: [
      {
        type: "toolCall",
        id: "tc-1",
        name: "bash",
        arguments: { command: "false" },
      },
    ],
  });
  const toolError = {
    role: "toolResult",
    toolCallId: "tc-1",
    isError: true,
    content: [{ type: "text", text: "error" }],
  } as Record<string, unknown>;
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
${emitMessageEnd(assistant)}
${emitAgentEnd([assistant, toolError])}
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  expect(result.messages).toHaveLength(2);
  expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
  expect(result.outcome).toBeUndefined();
});

test("runSingleAgent succeeds when sleep inhibitor acquisition fails", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const { result } = await runSingleAgent(
    cwd,
    [hangAgent],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
    false,
    {
      acquireSleepInhibitor: async () => {
        throw new Error("inhibitor unavailable");
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.finalOutput).toBe("done");
});

describe("T-004: runtime finalOutput construction invariants", () => {
  function makeResult(model?: string): RuntimeResult {
    return initRuntimeResult("agent", "user", "task", model ?? "display-model");
  }

  function makeTextMessage(text: string): Message {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
    } as unknown as Message;
  }

  function makeToolCallMessage(
    name: string,
    args: Record<string, unknown>,
  ): Message {
    return {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name, arguments: args }],
    } as unknown as Message;
  }

  function makeToolResultMessage(isError: boolean): Message {
    return {
      role: "toolResult",
      toolCallId: "tc-1",
      isError,
      content: [{ type: "text", text: "tool output" }],
    } as unknown as Message;
  }

  test("initRuntimeResult starts with empty finalOutput", () => {
    const result = makeResult();
    expect(result.finalOutput).toBe("");
    expect(result.messages).toHaveLength(0);
  });

  test("addMessageToResult updates finalOutput from assistant text", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("first"));
    expect(result.finalOutput).toBe("first");
    addMessageToResult(result, makeTextMessage("second"));
    expect(result.finalOutput).toBe("second");
  });

  test("addMessageToResult updates finalOutput when assistant text follows a tool call", () => {
    const result = makeResult();
    addMessageToResult(result, makeToolCallMessage("bash", { command: "ls" }));
    expect(result.finalOutput).toBe("");
    addMessageToResult(result, makeTextMessage("done"));
    expect(result.finalOutput).toBe("done");
  });

  test("addMessageToResult keeps finalOutput empty for tool-only complete outcome", () => {
    const result = makeResult();
    addMessageToResult(
      result,
      makeToolCallMessage("complete", { outcome: "Completed" }),
    );
    expect(result.finalOutput).toBe("");
    addMessageToResult(result, makeToolResultMessage(false));
    expect(result.finalOutput).toBe("");
  });

  test("addMessageToResult truncates finalOutput to configured output limits", () => {
    process.env.PI_SUBAGENT_MAX_OUTPUT_LINES = "2";
    process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES = "100000";
    try {
      const result = makeResult();
      const long = "line1\nline2\nline3";
      addMessageToResult(result, makeTextMessage(long));
      expect(result.finalOutput).toContain("[TRUNCATED:");
      expect(result.finalOutput).toContain("line1");
      expect(result.finalOutput).not.toContain("line3");
    } finally {
      delete process.env.PI_SUBAGENT_MAX_OUTPUT_LINES;
      delete process.env.PI_SUBAGENT_MAX_OUTPUT_BYTES;
    }
  });

  test("addMessageToResult records toolResult errors and assistant error messages", () => {
    const result = makeResult();
    addMessageToResult(result, makeToolResultMessage(true));
    expect(result.errorMessage).toBe(TOOL_RESULT_FAILED_MESSAGE);
    addMessageToResult(result, makeTextMessage("retry") as unknown as Message);
    expect(result.errorMessage).toBeUndefined();
    addMessageToResult(result, {
      role: "assistant",
      content: [{ type: "text", text: "api error" }],
      errorMessage: "provider error",
    } as unknown as Message);
    expect(result.errorMessage).toBe("provider error");
  });

  test("rebuildResultFromMessages replaces stale finalOutput with newer assistant text", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("stale"));
    rebuildResultFromMessages(result, [makeTextMessage("authoritative")]);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.messages).toHaveLength(1);
  });

  test("rebuildResultFromMessages refreshes usage, stopReason, and errorMessage", () => {
    const result = makeResult();
    const stale = {
      role: "assistant",
      content: [{ type: "text", text: "stale" }],
      usage: {
        input: 100,
        output: 200,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 300,
        cost: { total: 9 },
      },
      stopReason: "length",
      errorMessage: "stale error",
    } as unknown as Message;
    const authoritative = {
      role: "assistant",
      content: [{ type: "text", text: "authoritative" }],
      usage: {
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 6,
        cost: { total: 0.7 },
      },
      stopReason: "error",
      errorMessage: "final error",
    } as unknown as Message;
    addMessageToResult(result, stale);
    rebuildResultFromMessages(result, [authoritative]);
    expect(result.finalOutput).toBe("authoritative");
    expect(result.usage.input).toBe(2);
    expect(result.usage.output).toBe(3);
    expect(result.usage.cacheRead).toBe(4);
    expect(result.usage.cacheWrite).toBe(5);
    expect(result.usage.cost).toBe(0.7);
    expect(result.usage.contextTokens).toBe(6);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("final error");
  });

  test("rebuildResultFromMessages with empty messages clears finalOutput and errors", () => {
    const result = makeResult();
    addMessageToResult(result, makeTextMessage("stale"));
    addMessageToResult(result, makeToolResultMessage(true));
    rebuildResultFromMessages(result, []);
    expect(result.finalOutput).toBe("");
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
    expect(result.messages).toHaveLength(0);
  });
});

test("buildPiArgs appends --no-context-files when agent.context is false", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
  };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--no-context-files");
  expect(args.filter((a) => a === "--no-context-files")).toHaveLength(1);
});

test("buildPiArgs omits --no-context-files when agent.context is undefined", async () => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).not.toContain("--no-context-files");
});

test("buildPiArgs --no-context-files coexists with approval, model, provider, thinking, tools, prompt, and complete extension", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    tools: ["bash", "read"],
    thinking: "high",
    model: "gpt-4",
    provider: "openai",
  };
  const { args, result } = await runCapturedModelAgent(
    agent,
    { provider: "anthropic", id: "claude-3-7-sonnet-20250219" },
    "off",
    { registry: registryFixture([]) },
  );
  expect(args).toContain("--no-context-files");
  expect(args).toContain("--approve");
  expect(flagValues(args, "--provider")).toEqual(["openai"]);
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
  expect(args).toContain("--thinking");
  expect(flagValues(args, "--thinking")).toEqual(["high"]);
  expect(args).toContain("--tools");
  expect(args).toContain("--append-system-prompt");
  expect(args.some((a) => a.startsWith("Task: "))).toBe(true);
  expect(result.model).toBe("openai ･ gpt-4 ･ off");
  expect(result.thinkingWarning).toContain('using "off" instead');
});

test("buildPiArgs --no-context-files coexists with sampling extension args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    temperature: 0.7,
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(0);
  const args = fs
    .readFileSync(path.join(cwd, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args).toContain("--no-context-files");
  expect(flagValues(args, "--extension")).toContain(
    resolveSamplingExtensionPath(),
  );
});

test("buildPiArgs omits --no-context-files for depth-limit and unknown-agent failures", async () => {
  process.env.PI_SUBAGENT_DEPTH = "3";
  const { result: depthResult } = await runSingleAgent(
    "/tmp",
    [{ ...hangAgent, context: false }],
    "hang",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(depthResult.exitCode).toBe(1);
  expect(depthResult.stderr).toContain("depth 3/3");
  const { result: unknownResult } = await runSingleAgent(
    "/tmp",
    [{ ...hangAgent, context: false }],
    "missing",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(unknownResult.exitCode).toBe(1);
  expect(unknownResult.stderr).toContain("Unknown agent");
});

test("buildPiArgs always includes --no-themes", async () => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).toContain("--no-themes");
});

test("buildPiArgs always includes --no-prompt-templates", async () => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).toContain("--no-prompt-templates");
});

test("buildPiArgs --no-themes and --no-prompt-templates coexist with --no-context-files and model flags", async () => {
  const agent: AgentConfig = {
    ...hangAgent,
    context: false,
    model: "gpt-4",
    provider: "openai",
  };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  expect(args).toContain("--no-themes");
  expect(args).toContain("--no-prompt-templates");
  expect(args).toContain("--no-context-files");
  expect(flagValues(args, "--model")).toEqual(["gpt-4"]);
});

test("buildPiArgs appends --no-skills with no paths when agent.skills is false", async () => {
  const agent: AgentConfig = { ...hangAgent, skills: false };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const idx = args.indexOf("--no-skills");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).not.toBe(undefined);
  const nextFlag = args[idx + 1];
  expect(nextFlag?.startsWith("--") || nextFlag?.startsWith("Task:")).toBe(
    true,
  );
});

test("buildPiArgs appends --no-skills with no paths when agent.skills is empty array", async () => {
  const agent: AgentConfig = { ...hangAgent, skills: [] };
  const args = await captureRunSingleAgentArgs(agent, undefined);
  const idx = args.indexOf("--no-skills");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).not.toBe(undefined);
  const nextFlag = args[idx + 1];
  expect(nextFlag?.startsWith("--") || nextFlag?.startsWith("Task:")).toBe(
    true,
  );
});

test("buildPiArgs omits --no-skills when agent.skills is undefined", async () => {
  const args = await captureRunSingleAgentArgs(hangAgent, undefined);
  expect(args).not.toContain("--no-skills");
});

test("discovery-normalized context true omits --no-context-files from child args", async () => {
  const { agentDir, cwd } = await setupFakePi();
  const agentsDir = path.join(agentDir, "agents");
  await fs.promises.writeFile(
    path.join(agentsDir, "context-true.md"),
    `---
name: context-true
context: true
description: Context true agent
---
Prompt.`,
  );
  const discovery = await discoverAgentsAsync(cwd, "user");
  const discoveredAgent = discovery.agents.find(
    (a) => a.name === "context-true",
  );
  if (!discoveredAgent) throw new Error("context-true agent not discovered");
  expect(Object.hasOwn(discoveredAgent, "context")).toBe(false);
  expect(discoveredAgent.context).toBeUndefined();
  const args = await captureRunSingleAgentArgs(discoveredAgent, undefined);
  expect(args).not.toContain("--no-context-files");
  expect(args).toContain("--approve");
});

// --- T-003: extension flag construction ---

function buildArgsWithExtensions(
  agentOverrides: Partial<AgentConfig>,
  resolvedExtensionPaths?: string[],
): string[] {
  return buildPiArgs({
    agent: { ...hangAgent, ...agentOverrides },
    task: "task",
    effectiveModel: { id: "test-model" },
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
    resolvedExtensionPaths,
  });
}

function extensionFlags(args: string[]): { path: string; index: number }[] {
  return args.flatMap((arg, i) =>
    arg === "--extension" ? [{ path: args[i + 1] ?? "", index: i }] : [],
  );
}

test("buildPiArgs omitted extensions emits no --no-extensions and no index extension", () => {
  const agent: AgentConfig = { ...hangAgent };
  expect(Object.hasOwn(agent, "extensions")).toBe(false);
  const args = buildArgsWithExtensions(agent);
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(args).not.toContain(pkgPath);
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
});

test("buildPiArgs extensions false emits --no-extensions and package index", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).toContain(pkgPath);
});

test("buildPiArgs extensions empty parsed string emits --no-extensions and package index", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const argFlags = extensionFlags(args);
  const pkgPath = resolvePackageExtensionPath();
  expect(args).toContain("--no-extensions");
  expect(argFlags.map((f) => f.path)).toContain(pkgPath);
});

test("buildPiArgs named extensions emits --no-extensions, index, and named paths", () => {
  const fakePaths = ["/ext/a.js", "/ext/b.js"];
  const args = buildArgsWithExtensions(
    { extensions: ["ext-a", "ext-b"] },
    fakePaths,
  );
  expect(args).toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  const exts = flagValues(args, "--extension");
  expect(exts).toContain(pkgPath);
  expect(exts).toContain("/ext/a.js");
  expect(exts).toContain("/ext/b.js");
});

test("buildPiArgs named extensions with resolved path equal to index de-duplicates index path", () => {
  const pkgPath = resolvePackageExtensionPath();
  const fakePaths = ["/ext/unique.js", pkgPath];
  const args = buildArgsWithExtensions(
    { extensions: ["unique", "self"] },
    fakePaths,
  );
  expect(args).toContain("--no-extensions");
  const exts = flagValues(args, "--extension");
  const pkgCount = exts.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
  expect(exts).toContain("/ext/unique.js");
});

test("buildPiArgs index extension appears exactly once when no named paths provided", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const pkgPath = resolvePackageExtensionPath();
  const exts = flagValues(args, "--extension");
  const pkgCount = exts.filter((p) => p === pkgPath).length;
  expect(pkgCount).toBe(1);
});

test("buildPiArgs complete extension present when extensions disabled", () => {
  const args = buildArgsWithExtensions({ extensions: [] });
  const exts = extensionFlags(args);
  const completeIdx = exts.findIndex((f) =>
    f.path.includes("complete-extension"),
  );
  expect(completeIdx).toBeGreaterThanOrEqual(0);
});

test("buildPiArgs absent extension field regression: no --no-extensions and no index injection", () => {
  const args = buildArgsWithExtensions({});
  expect(args).not.toContain("--no-extensions");
  const pkgPath = resolvePackageExtensionPath();
  expect(flagValues(args, "--extension")).not.toContain(pkgPath);
  expect(args).toContain("--approve");
  expect(args).toContain("--no-themes");
});

test("buildPiArgs named extensions preserves complete extension after named paths", () => {
  const args = buildArgsWithExtensions({ extensions: ["ext-a"] }, [
    "/ext/a.js",
  ]);
  const exts = extensionFlags(args);
  const paths = exts.map((f) => f.path);
  const pkgIdx = paths.indexOf(resolvePackageExtensionPath());
  const namedIdx = paths.indexOf("/ext/a.js");
  const completeIdx = paths.findIndex((p) => p.includes("complete-extension"));
  expect(pkgIdx).toBeGreaterThanOrEqual(0);
  expect(namedIdx).toBeGreaterThan(pkgIdx);
  expect(completeIdx).toBeGreaterThan(namedIdx);
});

test("buildPiArgs named extensions preserves first-seen order from resolved paths", () => {
  const fakePaths = ["/ext/c.js", "/ext/a.js", "/ext/b.js"];
  const args = buildArgsWithExtensions(
    { extensions: ["c", "a", "b"] },
    fakePaths,
  );
  const exts = extensionFlags(args);
  const pkgPath = resolvePackageExtensionPath();
  const namedFlags = exts.filter(
    (f) => f.path !== pkgPath && !f.path.includes("complete-extension"),
  );
  expect(namedFlags.map((f) => f.path)).toEqual([
    "/ext/c.js",
    "/ext/a.js",
    "/ext/b.js",
  ]);
});

// --- T-002: buildPiArgs contract delivery invariants ---

function buildContractArgs(
  task: string,
  tmpPrompt: { filePath: string } | null,
  agentOverrides: Partial<AgentConfig> = {},
  resolvedExtensionPaths?: string[],
  samplingEnv?: string,
): string[] {
  return buildPiArgs({
    agent: { ...hangAgent, ...agentOverrides },
    task,
    effectiveModel: { id: "test-model" },
    thinking: "off",
    resolvedSkills: { args: [] },
    tmpPrompt,
    resolvedExtensionPaths,
    samplingEnv,
  });
}

describe("T-002: buildPiArgs contract delivery invariants", () => {
  test("tmpPrompt present places contract as last append after body prompt", () => {
    const args = buildContractArgs("task", {
      filePath: "/tmp/fake-prompt.md",
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual(["/tmp/fake-prompt.md", SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("tmpPrompt absent places contract as the only append value", () => {
    const args = buildContractArgs("task", null);
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual([SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("empty task fallback with body prompt receives contract last", () => {
    const args = buildContractArgs("", {
      filePath: "/tmp/fake-prompt.md",
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual(["/tmp/fake-prompt.md", SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("empty task fallback without body prompt receives contract as only append", () => {
    const args = buildContractArgs("", null);
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends).toEqual([SUBAGENT_RESULT_CONTRACT]);
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("contract remains last append when extensions are disabled", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: [] },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    expect(args.at(-1)).not.toContain("Subagent Result Contract");
  });

  test("contract remains last append with named extensions and preserves complete extension", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: ["ext-a"] },
      ["/ext/a.js"],
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    const exts = flagValues(args, "--extension");
    expect(exts.some((p) => p.includes("complete-extension"))).toBe(true);
  });

  test("contract remains last append with custom tools containing complete and deduplicates complete", () => {
    const args = buildContractArgs("task", null, {
      tools: ["complete", "bash"],
    });
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args.at(-1)).toBe("Task: task");
    const tools = flagValues(args, "--tools")[0]?.split(",") ?? [];
    expect(tools.filter((t) => t === "complete")).toHaveLength(1);
    expect(tools).toContain("bash");
  });

  test("contract remains last append with context disabled and preserves unrelated flags", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { context: false },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args).toContain("--no-context-files");
    expect(args).toContain("--approve");
    expect(args).toContain("--no-themes");
    expect(args).toContain("--no-prompt-templates");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("contract remains last append with skills disabled", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { skills: false },
    );
    const appends = flagValues(args, "--append-system-prompt");
    expect(appends.at(-1)).toBe(SUBAGENT_RESULT_CONTRACT);
    expect(args).toContain("--no-skills");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("contract appears exactly once among appended system prompts", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { extensions: ["ext-a"] },
      ["/ext/a.js"],
    );
    const appends = flagValues(args, "--append-system-prompt");
    const contractCount = appends.filter(
      (a) => a === SUBAGENT_RESULT_CONTRACT,
    ).length;
    expect(contractCount).toBe(1);
  });

  test("sampling extension is loaded before the contract append", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { temperature: 0.7, topP: 0.9 },
      undefined,
      JSON.stringify({ temperature: 0.7, topP: 0.9 }),
    );
    const contractIdx = args.indexOf(SUBAGENT_RESULT_CONTRACT);
    const exts = flagValues(args, "--extension");
    expect(exts.some((p) => p.includes("sampling-extension"))).toBe(true);
    const samplingIdx = args.indexOf(
      exts.find((p) => p.includes("sampling-extension")) ?? "",
    );
    expect(contractIdx).toBeGreaterThan(samplingIdx);
    expect(args.at(-1)).toBe("Task: task");
  });

  test("task prompt arg never contains contract text across configurations", () => {
    const configs: {
      name: string;
      task: string;
      tmpPrompt: { filePath: string } | null;
      overrides: Partial<AgentConfig>;
      resolvedPaths?: string[];
    }[] = [
      {
        name: "task with body",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: {},
      },
      {
        name: "task without body",
        task: "task",
        tmpPrompt: null,
        overrides: {},
      },
      {
        name: "empty task with body",
        task: "",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: {},
      },
      {
        name: "empty task without body",
        task: "",
        tmpPrompt: null,
        overrides: {},
      },
      {
        name: "extensions disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { extensions: [] },
      },
      {
        name: "named extensions",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { extensions: ["ext-a"] },
        resolvedPaths: ["/ext/a.js"],
      },
      {
        name: "custom tools with complete",
        task: "task",
        tmpPrompt: null,
        overrides: { tools: ["complete", "bash"] },
      },
      {
        name: "context disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { context: false },
      },
      {
        name: "skills disabled",
        task: "task",
        tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
        overrides: { skills: false },
      },
    ];
    for (const config of configs) {
      const args = buildContractArgs(
        config.task,
        config.tmpPrompt,
        config.overrides,
        config.resolvedPaths,
      );
      const taskArg = args.at(-1) ?? "";
      expect(taskArg, config.name).not.toContain("Subagent Result Contract");
      expect(taskArg, config.name).not.toContain("MANDATORY");
    }
  });

  test("replacePrompt true routes body via --system-prompt and keeps contract last", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args.indexOf("--system-prompt")).toBeGreaterThan(-1);
    expect(args.indexOf(SUBAGENT_RESULT_CONTRACT)).toBeGreaterThan(
      args.indexOf("--system-prompt"),
    );
    expect(args.at(-1)).toBe("Task: task");
  });

  test("replacePrompt false keeps --append-system-prompt body delivery", () => {
    const agent = {
      ...hangAgent,
      replacePrompt: false,
    } as unknown as AgentConfig;
    const args = buildPiArgs({
      agent,
      task: "task",
      effectiveModel: { id: "test-model" },
      thinking: "off",
      resolvedSkills: { args: [] },
      tmpPrompt: { filePath: "/tmp/fake-prompt.md" },
    });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });

  test("replacePrompt omitted keeps --append-system-prompt body delivery", () => {
    const args = buildContractArgs("task", { filePath: "/tmp/fake-prompt.md" });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });

  test("replacePrompt true with empty task uses --system-prompt and default task prompt last", () => {
    const args = buildContractArgs(
      "",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args.at(-1)).toBe(
      "Run according to your system prompt. If no explicit task was provided, use the default context described there.",
    );
  });

  test("replacePrompt true preserves unrelated flags", () => {
    const args = buildContractArgs(
      "task",
      { filePath: "/tmp/fake-prompt.md" },
      { replacePrompt: true, context: false, tools: ["bash"] },
    );
    expect(flagValues(args, "--system-prompt")).toEqual([
      "/tmp/fake-prompt.md",
    ]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
    expect(args).toContain("--no-context-files");
    expect(flagValues(args, "--tools")[0]?.split(",")).toContain("bash");
    expect(args.at(-1)).toBe("Task: task");
  });

  test("replacePrompt true with no body omits --system-prompt and appends contract only", () => {
    const args = buildContractArgs("task", null, { replacePrompt: true });
    expect(flagValues(args, "--system-prompt")).toEqual([]);
    expect(flagValues(args, "--append-system-prompt")).toEqual([
      SUBAGENT_RESULT_CONTRACT,
    ]);
  });
});

// --- T-004: pre-spawn extension resolution and cleanup ---

test("runSingleAgent disabled-without-names skips loader discovery for extensions", async () => {
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  const { cwd } = await setupTest();
  try {
    const agent: AgentConfig = {
      ...hangAgent,
      extensions: [],
    };
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent omitted extensions skips loader discovery for extensions", async () => {
  let reloadCalls = 0;
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function trackReload() {
    reloadCalls += 1;
    return originalReload.call(this);
  };
  const { cwd } = await setupTest();
  try {
    const agent: AgentConfig = { ...hangAgent };
    expect(Object.hasOwn(agent, "extensions")).toBe(false);
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    expect(reloadCalls).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent unknown extension names return error result before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await fs.promises.writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  await fs.promises.chmod(path.join(binDir, "pi"), 0o755);
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["nonexistent-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  expect(result.stderr).toContain("Available extensions:");
  expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
});

test("runSingleAgent loader reload failure returns error result before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await fs.promises.writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  await fs.promises.chmod(path.join(binDir, "pi"), 0o755);
  const originalReload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = async function failReload() {
    throw new Error("loader crashed");
  };
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["some-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to discover extensions");
    expect(result.stderr).toContain("loader crashed");
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("runSingleAgent getExtensions errors return actionable diagnostics before child spawn", async () => {
  const { cwd, binDir } = await setupTest();
  await fs.promises.writeFile(
    path.join(binDir, "pi"),
    `#!/bin/sh
echo "should not run" > spawn-marker.txt
exit 0
`,
  );
  await fs.promises.chmod(path.join(binDir, "pi"), 0o755);
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions =
    function errorGetExtensions() {
      return {
        extensions: [],
        errors: [
          { path: "/broken/ext", error: "ENOENT" },
          { path: "/bad/ext", error: "EACCES" },
        ],
        runtime: {} as never,
      };
    };
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["some-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to discover extensions");
    expect(result.stderr).toContain("/broken/ext: ENOENT");
    expect(result.stderr).toContain("/bad/ext: EACCES");
    expect(fs.existsSync(path.join(cwd, "spawn-marker.txt"))).toBe(false);
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent cleans prompt temp file after extension resolution failure", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    name: "badext",
    systemPrompt: "Prompt that creates a temp file.",
    extensions: ["nonexistent-ext"],
  };
  let _result: SingleResult | undefined;
  const getTmpDir = await withMkdtempCapture(async (getTmpDir) => {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "badext",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    _result = result;
    return getTmpDir;
  });
  if (!_result) throw new Error("result missing");
  expect(_result.exitCode).toBe(1);
  expect(_result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  const tmpDir = getTmpDir();
  expect(tmpDir).toBeDefined();
  expect(fs.existsSync(tmpDir ?? "")).toBe(false);
});

test("runSingleAgent skill failure takes precedence over concurrent extension failure", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    skills: ["missing-skill"],
    extensions: ["nonexistent-ext"],
    systemPrompt: "Prompt.",
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown skill: "missing-skill"');
  expect(result.stderr).not.toContain("extension");
});

test("runSingleAgent starts skill resolution, extension resolution, and prompt setup concurrently", async () => {
  const { cwd, agentDir } = await setupTest();
  const skillDir = path.join(agentDir, "skills", "conext");
  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: conext
description: Concurrent extension skill
---
Use conext skill.
`,
  );
  const extDir = path.join(agentDir, "extensions");
  await fs.promises.mkdir(extDir, { recursive: true });
  const extResolvedPath = path.join(extDir, "conext", "index.js");
  await fs.promises.mkdir(path.dirname(extResolvedPath), { recursive: true });
  await fs.promises.writeFile(
    extResolvedPath,
    "module.exports = function() {}",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = function mockGetExtensions() {
    return {
      extensions: [
        {
          path: "extensions/conext",
          resolvedPath: extResolvedPath,
          sourceInfo: {
            path: extResolvedPath,
            source: "extensions/conext",
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
  resetResolvedAgentExtensionPathsCache();
  const originalReload = DefaultResourceLoader.prototype.reload;
  const originalWriteFile = fs.promises.writeFile;
  let releaseReload = () => {};
  let reloadStarted = false;
  let writeStarted = false;
  let released = false;
  const reloadRelease = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  DefaultResourceLoader.prototype.reload = async function delayedReload() {
    reloadStarted = true;
    await reloadRelease;
    return originalReload.call(this);
  };
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async (...args: unknown[]) => {
      writeStarted = true;
      return Reflect.apply(originalWriteFile, fs.promises, args);
    },
  });
  const agent: AgentConfig = {
    name: "conext-agent",
    description: "Concurrent extension agent",
    thinking: "off",
    systemPrompt: "Concurrent prompt.",
    source: "user",
    filePath: "conext-agent.md",
    skills: ["conext"],
    extensions: ["conext"],
  };
  const promise = runSingleAgent(
    cwd,
    [agent],
    "conext-agent",
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    undefined,
    "off",
  );
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseReload();
  };
  try {
    await waitFor(
      () => reloadStarted || undefined,
      "skill + extension discovery start",
    );
    await waitFor(() => writeStarted || undefined, "prompt write start");
    releaseOnce();
    const outcome = await promise;
    expect(outcome.kind).toBe("completed");
    expect(outcome.result.exitCode).toBe(0);
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    releaseOnce();
    await promise.catch(() => {});
  }
});

test("runSingleAgent named extensions flow through to child args via runSingleAgent", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(
    cwd,
    ".pi",
    "extensions",
    "my-ext",
    "index.js",
  );
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/my-ext",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/my-ext",
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
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["my-ext"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("my-ext");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent single-file extension resolves by file stem and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(cwd, ".pi", "extensions", "helper.ts");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(
    resolvedPath,
    "export default function setup() {}",
  );
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/helper.ts",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: ".pi/extensions/helper.ts",
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
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["helper"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent version-pinned npm package extension resolves and flows to child args", async () => {
  const { cwd } = await setupTest({
    piScript: `#!/bin/sh
printf '%s\\n' "$@" > args.txt
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"api":"fake","provider":"fake","model":"fake","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}},"stopReason":"stop","timestamp":0}}'
printf '%s\\n' '{"type":"agent_end","messages":[]}'
exit 0
`,
  });
  const resolvedPath = path.join(cwd, "node_modules", "helper", "index.js");
  await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.promises.writeFile(resolvedPath, "module.exports = function() {}");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: "node_modules/helper",
        resolvedPath,
        sourceInfo: {
          path: resolvedPath,
          source: "npm:helper@1.2.3",
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
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["helper"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("done");
    const args = fs
      .readFileSync(path.join(cwd, "args.txt"), "utf8")
      .trimEnd()
      .split("\n");
    const pkgPath = resolvePackageExtensionPath();
    expect(args).toContain("--no-extensions");
    expect(flagValues(args, "--extension")).toContain(pkgPath);
    const resolvedExt = flagValues(args, "--extension").find(
      (p) => p !== pkgPath && !p.includes("complete-extension"),
    );
    expect(resolvedExt).toBeDefined();
    expect(resolvedExt).toContain("helper");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent extension resolution error reports missing names with sorted available names", async () => {
  const { cwd } = await setupTest();
  const extPath = path.join(cwd, ".pi", "extensions");
  const originalGetExtensions = DefaultResourceLoader.prototype.getExtensions;
  DefaultResourceLoader.prototype.getExtensions = () => ({
    extensions: [
      {
        path: ".pi/extensions/zebra-ext",
        resolvedPath: path.join(extPath, "zebra-ext", "index.js"),
        sourceInfo: {
          path: path.join(extPath, "zebra-ext", "index.js"),
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
        resolvedPath: path.join(extPath, "alpha-ext", "index.js"),
        sourceInfo: {
          path: path.join(extPath, "alpha-ext", "index.js"),
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
  });
  resetResolvedAgentExtensionPathsCache();
  const agent: AgentConfig = {
    ...hangAgent,
    extensions: ["missing-a", "missing-b"],
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      agent.name,
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Unknown extensions: "missing-a", "missing-b"',
    );
    expect(result.stderr).toContain("Available extensions:");
    expect(result.stderr).toContain("alpha-ext");
    expect(result.stderr).toContain("zebra-ext");
  } finally {
    DefaultResourceLoader.prototype.getExtensions = originalGetExtensions;
  }
});

test("runSingleAgent reports extension resolution error with model display", async () => {
  const { cwd } = await setupTest();
  const agent: AgentConfig = {
    ...hangAgent,
    model: "agent-model",
    extensions: ["nonexistent-ext"],
  };
  const { result } = await runSingleAgent(
    cwd,
    [agent],
    agent.name,
    "task",
    undefined,
    undefined,
    makeSubagentDetails,
    { provider: "parent-provider", id: "parent-model" },
    "off",
    false,
    { registry: registryFixture([]) },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Unknown extension: "nonexistent-ext"');
  expect(result.model).toBe("parent-provider ･ agent-model ･ off");
});

test("runSingleAgent returns error result when prompt file write fails", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  const writeFileError = new Error("ENOSPC: no space left on device");
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async () => {
      throw writeFileError;
    },
  });
  const agent: AgentConfig = {
    ...hangAgent,
    name: "write-fail",
    systemPrompt: "Prompt that triggers a write failure.",
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "write-fail",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write prompt");
    expect(result.stderr).toContain("ENOSPC");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
});

test("runSingleAgent returns error result when prompt file write fails with non-Error value", async () => {
  const { cwd } = await setupTest();
  const originalWriteFile = fs.promises.writeFile;
  Object.defineProperty(fs.promises, "writeFile", {
    configurable: true,
    value: async () => {
      throw "disk full";
    },
  });
  const agent: AgentConfig = {
    ...hangAgent,
    name: "write-fail-string",
    systemPrompt: "Prompt that triggers a write failure.",
  };
  try {
    const { result } = await runSingleAgent(
      cwd,
      [agent],
      "write-fail-string",
      "task",
      undefined,
      undefined,
      makeSubagentDetails,
      undefined,
      "off",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to write prompt");
    expect(result.stderr).toContain("disk full");
  } finally {
    Object.defineProperty(fs.promises, "writeFile", {
      value: originalWriteFile,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
});
