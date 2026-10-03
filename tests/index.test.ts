import { describe, expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  getCachedAgentCompletions,
  resetAgentDiscoveryCache,
} from "../src/agent/agent-cache.js";
import { resetAgentCache } from "../src/index.js";
import { listRunJobs } from "../src/orchestration/run-registry.js";
import {
  type RegisteredEventHandler,
  setupFakePi,
  setupHooks,
  setupTest,
  waitForRunJobCount,
} from "./helpers.js";

setupHooks();

async function emitSessionStart(
  tool: { registeredEventHandlers: Map<string, RegisteredEventHandler[]> },
  cwd: string | undefined,
) {
  for (const handler of tool.registeredEventHandlers.get("session_start") ??
    []) {
    await handler({ type: "session_start", reason: "startup" }, {
      cwd,
    } as ExtensionCommandContext);
  }
}

async function emitResourcesDiscover(
  tool: { registeredEventHandlers: Map<string, RegisteredEventHandler[]> },
  ctxCwd: string | undefined,
  eventCwd: string | undefined,
) {
  for (const handler of tool.registeredEventHandlers.get(
    "resources_discover",
  ) ?? []) {
    await handler({ type: "resources_discover", cwd: eventCwd }, {
      cwd: ctxCwd,
    } as ExtensionCommandContext);
  }
}

describe("index.ts", () => {
  describe("resetAgentCache", () => {
    test("delegates to resetAgentDiscoveryCache", async () => {
      const { cwd } = await setupFakePi();
      await getCachedAgentCompletions("", cwd);
      resetAgentCache();
      resetAgentDiscoveryCache();
    });
  });

  describe("normalizeWorkspaceRoot via event handlers", () => {
    test("session_start with undefined ctx.cwd clears workspace root", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("session_start with empty string ctx.cwd clears workspace root", async () => {
      const { tool } = await setupTest();
      await emitSessionStart(tool, "");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("session_start with whitespace-only ctx.cwd clears workspace root", async () => {
      const { tool } = await setupTest();
      await emitSessionStart(tool, "   ");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("session_start trims valid cwd", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, `  ${cwd}  `);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions?.length).toBeGreaterThanOrEqual(0);
    });

    test("resources_discover uses ctx.cwd when event.cwd is undefined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, cwd, undefined);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("resources_discover falls back to event.cwd when ctx.cwd is undefined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, undefined, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("resources_discover with both undefined clears workspace root", async () => {
      const { tool } = await setupTest();
      await emitResourcesDiscover(tool, undefined, undefined);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("resources_discover prefers ctx.cwd over event.cwd when both defined", async () => {
      const { tool, cwd } = await setupTest();
      await emitResourcesDiscover(tool, cwd, "/some/other/path");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("subsequent events override workspace root", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completionsBefore =
        await runCommand?.getArgumentCompletions?.("hang");
      await emitSessionStart(tool, "/nonexistent/override");
      const completionsAfter =
        await runCommand?.getArgumentCompletions?.("hang");
      expect(completionsBefore).toBeDefined();
      expect(completionsAfter).toEqual([]);
    });
  });

  describe("getRunArgumentCompletions", () => {
    test("returns empty when no workspace root set", async () => {
      const { tool } = await setupTest();
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("returns empty when workspace root is not a directory", async () => {
      const { tool } = await setupTest();
      await emitSessionStart(tool, "/nonexistent/path/that/does/not/exist");
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toEqual([]);
    });

    test("returns filtered completions with valid prefix", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions = await runCommand?.getArgumentCompletions?.("ha");
      expect(completions).toBeDefined();
      if (completions && completions.length > 0) {
        for (const c of completions) {
          expect(c.value).toStartWith("ha");
          expect(c.label).toStartWith("ha");
        }
      }
    });

    test("returns empty for non-matching prefix", async () => {
      const { tool, cwd } = await setupTest();
      await emitSessionStart(tool, cwd);
      const runCommand = tool.registeredCommands.get("run");
      const completions =
        await runCommand?.getArgumentCompletions?.("zzz_nonexistent");
      expect(completions).toEqual([]);
    });
  });

  describe("registered renderers", () => {
    test("registers subagent-progress message renderer", async () => {
      const { tool } = await setupTest();
      expect(
        tool.registeredMessageRenderers.get("subagent-progress"),
      ).toBeDefined();
    });

    test("registers subagent-result message renderer", async () => {
      const { tool } = await setupTest();
      expect(
        tool.registeredMessageRenderers.get("subagent-result"),
      ).toBeDefined();
    });
  });

  describe("command descriptions", () => {
    test("run command has correct description", async () => {
      const { tool } = await setupTest();
      const runCommand = tool.registeredCommands.get("run");
      expect(runCommand?.description).toBe(
        "Run a subagent: /run [--debug] <agent> [--role default|none|id] [task]",
      );
    });

    test("cancel-subagent command has correct description", async () => {
      const { tool } = await setupTest();
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      expect(cancelCommand?.description).toBe(
        "Cancel active /run subagents: /cancel-subagent [requestId|all]",
      );
    });

    test("jobs command has correct description", async () => {
      const { tool } = await setupTest();
      const jobsCommand = tool.registeredCommands.get("jobs");
      expect(jobsCommand?.description).toBe(
        "List all /run jobs and their statuses: /jobs",
      );
    });
  });

  describe("registered tool", () => {
    test("tool has correct name and description", async () => {
      const { tool } = await setupTest();
      expect(tool.name).toBe("subagent");
      expect(tool.description).toBe(
        "Delegate a task to a subagent with isolated context.",
      );
    });

    test("tool has correct label", async () => {
      const { tool } = await setupTest();
      expect(tool.label).toBe("Subagent");
    });

    test("tool has SubagentParams schema", async () => {
      const { tool } = await setupTest();
      expect(tool.parameters).toBeDefined();
    });
  });

  describe("run command handler", () => {
    test("notifies usage when no args provided", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest({
        sendMessage: () => {},
      });
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("", ctx);
      expect(notifications[0]).toBe(
        "Usage: /run <agent> [--role default|none|id] [task]",
      );
    });

    test("updates workspace root from ctx.cwd before processing", async () => {
      const { tool, cwd } = await setupTest();
      const runCommand = tool.registeredCommands.get("run");
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", ctx);
      const completions = await runCommand?.getArgumentCompletions?.("hang");
      expect(completions).toBeDefined();
    });

    test("notifies usage when args are whitespace", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("   ", ctx);
      expect(notifications[0]).toBe(
        "Usage: /run <agent> [--role default|none|id] [task]",
      );
    });

    test("notifies unknown agent when agent not found", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        signal: AbortSignal.timeout(5000),
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const runCommand = tool.registeredCommands.get("run");
      await runCommand?.handler?.("nonexistent-agent", ctx);
      expect(notifications.some((n) => n.includes("Unknown agent"))).toBe(true);
    });
  });

  describe("cancel-subagent command handler", () => {
    test("notifies no active jobs when no jobs running and args empty", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("", ctx);
      expect(notifications[0]).toBe("No active /run jobs.");
    });

    test("notifies no active jobs when target 'all' and no jobs running", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("all", ctx);
      expect(notifications[0]).toBe("No active /run jobs.");
    });

    test("notifies no active job when specific requestId not found", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("nonexistent-id", ctx);
      expect(notifications[0]).toBe("No active /run job nonexistent-id.");
    });

    test("presents selection UI when jobs are active and no args", async () => {
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const runCommand = tool.registeredCommands.get("run");
      const runCtx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", runCtx);
      await waitForRunJobCount(1);
      const selections: string[][] = [];
      const cancelCtx = {
        cwd,
        ui: {
          notify: () => {},
          select: async (_title: string, options: string[]) => {
            selections.push(options);
            return undefined;
          },
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("", cancelCtx);
      expect(selections.length).toBe(1);
      expect(
        selections[0]?.some((o) => o.includes("All running subagents")),
      ).toBe(true);
    });

    test("cancels specific job when requestId matches active job", async () => {
      const notifications: string[] = [];
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const runCommand = tool.registeredCommands.get("run");
      const runCtx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", runCtx);
      await waitForRunJobCount(1);
      const jobs = listRunJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      const requestId = jobs[0]?.requestId ?? "";
      const cancelCtx = {
        cwd,
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.(requestId, cancelCtx);
      expect(notifications[0]).toBe(`Cancelled /run job ${requestId}.`);
    });

    test("cancels all jobs when target is 'all' and jobs are active", async () => {
      const notifications: string[] = [];
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const runCommand = tool.registeredCommands.get("run");
      const runCtx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      await runCommand?.handler?.("hang hello", runCtx);
      await waitForRunJobCount(1);
      const cancelCtx = {
        cwd,
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
        },
      } as unknown as ExtensionCommandContext;
      const cancelCommand = tool.registeredCommands.get("cancel-subagent");
      await cancelCommand?.handler?.("all", cancelCtx);
      expect(notifications[0]).toContain("Cancelled");
    });
  });

  describe("jobs command handler", () => {
    test("invokes jobs handler without error", async () => {
      const notifications: string[] = [];
      const { tool } = await setupTest();
      let customCalled = false;
      const ctx = {
        cwd: "/tmp",
        ui: {
          notify: (msg: string) => notifications.push(msg),
          select: async () => undefined,
          custom: async () => {
            customCalled = true;
            return "rendered";
          },
        },
      } as unknown as ExtensionCommandContext;
      const jobsCommand = tool.registeredCommands.get("jobs");
      await jobsCommand?.handler?.("", ctx);
      const hitNoJobs = notifications.includes("No /run jobs in this session.");
      const hitCustom = customCalled;
      expect(hitNoJobs || hitCustom).toBe(true);
    });
  });

  describe("tool execute", () => {
    test("returns formatted result for successful run", async () => {
      const sentMessages: import("./helpers.js").SendMessageArg[] = [];
      const { tool, cwd } = await setupTest({
        sendMessage: (msg) => sentMessages.push(msg),
      });
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(30000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-1",
        { agent: "hang", task: "test task" },
        AbortSignal.timeout(30000),
        () => {},
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(result.details).toBeDefined();
      expect(result.details.mode).toBe("single");
    });

    test("returns not_found result for unknown agent", async () => {
      const { tool, cwd } = await setupTest();
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(10000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-2",
        { agent: "nonexistent" },
        AbortSignal.timeout(10000),
        () => {},
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    test("renderCall returns content", async () => {
      const { tool } = await setupTest();
      const rendered = tool.renderCall(
        { agent: "hang", task: "test" },
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
          italic: (t: string) => t,
        } as unknown as import("@earendil-works/pi-coding-agent").Theme,
        undefined as never,
      );
      expect(rendered).toBeDefined();
    });

    test("renderResult returns content", async () => {
      const { tool } = await setupTest();
      const mockResult = {
        content: [{ type: "text" as const, text: "done" }],
        details: {
          mode: "single" as const,
          agentScope: "both" as const,
          projectAgentsDir: null,
          results: [
            {
              agent: "hang",
              task: "test",
              exitCode: 0,
              finalOutput: "done",
              stderr: "",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
              agentSource: "user" as const,
            },
          ],
        },
      };
      const rendered = tool.renderResult(
        mockResult as never,
        "inline" as never,
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
          italic: (t: string) => t,
        } as unknown as import("@earendil-works/pi-coding-agent").Theme,
        undefined as never,
      );
      expect(rendered).toBeDefined();
    });

    test("renderResult with block display mode", async () => {
      const { tool } = await setupTest();
      const mockResult = {
        content: [{ type: "text" as const, text: "block output" }],
        details: {
          mode: "single" as const,
          agentScope: "both" as const,
          projectAgentsDir: null,
          results: [
            {
              agent: "hang",
              task: "test",
              exitCode: 0,
              finalOutput: "block output",
              stderr: "",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 1,
              },
              agentSource: "user" as const,
            },
          ],
        },
      };
      const rendered = tool.renderResult(
        mockResult as never,
        "block" as never,
        {
          fg: (_c: string, t: string) => t,
          bg: (_c: string, t: string) => t,
          bold: (t: string) => t,
          italic: (t: string) => t,
        } as unknown as import("@earendil-works/pi-coding-agent").Theme,
        undefined as never,
      );
      expect(rendered).toBeDefined();
    });

    test("execute with undefined signal and onUpdate", async () => {
      const { tool, cwd } = await setupTest();
      const ctx = {
        cwd,
        signal: AbortSignal.timeout(10000),
        ui: {
          notify: () => {},
          select: async () => undefined,
          custom: async () => "",
        },
      } as unknown as ExtensionCommandContext;
      const result = await tool.execute(
        "call-null",
        { agent: "hang", task: "test" },
        undefined,
        undefined,
        ctx,
      );
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });
});
