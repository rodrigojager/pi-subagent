import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DELEGATION_CHANNEL,
  registerDelegationBridge,
} from "../src/orchestration/delegation-bridge.js";
import type { startSubagentJob } from "../src/orchestration/subagent-orchestrator.js";

const details = () => ({
  mode: "single" as const,
  agentScope: "both" as const,
  projectAgentsDir: null,
  results: [],
});
function bridge(start: typeof startSubagentJob) {
  let listener: ((data: unknown) => void) | undefined;
  const pi = {
    events: {
      on(channel: string, callback: (data: unknown) => void) {
        expect(channel).toBe(DELEGATION_CHANNEL);
        listener = callback;
      },
    },
  } as unknown as ExtensionAPI;
  registerDelegationBridge(pi, start);
  return { pi, emit: (data: unknown) => listener?.(data) };
}
async function request(start: typeof startSubagentJob) {
  const b = bridge(start);
  const context = {
    cwd: "/project",
    signal: new AbortController().signal,
  } as ExtensionContext;
  let accepted: (() => Promise<{ ok: boolean; message: string }>) | undefined;
  b.emit({
    agent: "scout",
    task: "Find the source files",
    context,
    accept: (run: typeof accepted) => {
      accepted = run;
    },
  });
  expect(accepted).toBeDefined();
  if (!accepted) throw new Error("Bridge did not accept the request");
  return { b, context, run: accepted };
}
describe("cross-extension delegation", () => {
  test("handshake does not launch work until the caller invokes the accepted operation", async () => {
    let calls = 0;
    const input = await request(async (pi, ctx, params, signal) => {
      calls++;
      expect(pi).toBe(input.b.pi);
      expect(ctx).toBe(input.context);
      expect(signal).toBe(input.context.signal);
      expect(params).toEqual({ agent: "scout", task: "Find the source files" });
      return {
        kind: "started",
        requestId: "job-1",
        instanceName: "#1",
        makeDetails: details,
      };
    });
    expect(calls).toBe(0);
    expect(await input.run()).toEqual({
      ok: true,
      message: "Subagent scout #1 started (job: job-1)",
    });
    expect(calls).toBe(1);
  });
  test.each(["not_found", "cancelled"] as const)(
    "returns %s without claiming a successful delegation",
    async (kind) => {
      const input = await request(async () => ({ kind, makeDetails: details }));
      const response = await input.run();
      expect(response.ok).toBe(false);
      expect(response.message).toContain(
        kind === "not_found" ? "Unknown subagent" : "cancelled",
      );
    },
  );
  test("nested synchronous completion is acknowledged", async () => {
    const input = await request(async () => ({
      kind: "completed",
      result: { content: [{ type: "text", text: "Done" }], details: details() },
    }));
    expect(await input.run()).toEqual({
      ok: true,
      message: "Subagent scout finished",
    });
  });
  test("execution errors become a failed response", async () => {
    const input = await request(async () => {
      throw new Error("Could not start child");
    });
    expect(await input.run()).toEqual({
      ok: false,
      message: "Could not start child",
    });
  });
  test("malformed requests do not activate the bridge", () => {
    const b = bridge(async () => {
      throw new Error("Must not run");
    });
    let accepted = false;
    for (const data of [
      null,
      {},
      {
        agent: "scout",
        task: "",
        context: { cwd: "/project" },
        accept: () => {
          accepted = true;
        },
      },
    ])
      b.emit(data);
    expect(accepted).toBe(false);
    registerDelegationBridge({} as ExtensionAPI);
  });
});
