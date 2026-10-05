import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sendCompletionMessage } from "../src/orchestration/completion-delivery.js";
import type { SubagentDetails } from "../src/shared/types.js";

const details: SubagentDetails = {
  mode: "single",
  agentScope: "user",
  projectAgentsDir: null,
  results: [],
};
type DeliveryOptions = { deliverAs?: string; triggerTurn?: boolean };
function context(status?: string | null, sessionId = "owner") {
  const branch =
    status === undefined
      ? []
      : [
          {
            type: "custom",
            customType: "goal-state",
            data: { goal: status === null ? undefined : { status } },
          },
        ];
  return {
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
  } as unknown as ExtensionContext;
}

test.each([undefined, "active"])(
  "background result wakes an idle coordinator (goal=%s)",
  (status) => {
    const sent: unknown[][] = [];
    const pi = {
      sendMessage: (...args: unknown[]) => sent.push(args),
    } as unknown as ExtensionAPI;
    sendCompletionMessage(
      pi,
      context(status),
      "owner",
      0,
      "F05 completed",
      details,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  },
);

test.each([
  "paused",
  "blocked",
  "completed",
  "usage_limited",
  "budget_limited",
  null,
])("inactive goal %s receives result without being resumed", (status) => {
  const sent: unknown[][] = [];
  const pi = {
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  sendCompletionMessage(
    pi,
    context(status),
    "owner",
    0,
    "F05 completed",
    details,
  );
  expect(sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: false });
});

test("nested synchronous delegation does not trigger a duplicate parent turn", () => {
  const sent: unknown[][] = [];
  const pi = {
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  sendCompletionMessage(
    pi,
    context("active"),
    "owner",
    1,
    "Nested completed",
    details,
  );
  expect(sent[0]?.[1]).toEqual({ deliverAs: "followUp", triggerTurn: false });
});

test("a completion never writes into another selected session", () => {
  const sent: unknown[][] = [];
  const pi = {
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  sendCompletionMessage(
    pi,
    context("active", "another-session"),
    "owner",
    0,
    "F05 completed",
    details,
  );
  expect(sent).toHaveLength(0);
});

test("installed Pi host starts a turn when idle and queues a follow-up while streaming", async () => {
  const installed = process.env["PI_TEST_PACKAGE"];
  if (!installed)
    throw new Error("PI_TEST_PACKAGE must point to the installed Pi package");
  const { AgentSession } = await import(
    pathToFileURL(join(installed, "dist/core/agent-session.js")).href
  );
  const actions: string[] = [];
  const pending: Promise<void>[] = [];
  const host = {
    isStreaming: false,
    agent: {
      followUp: () => actions.push("followUp"),
      steer: () => actions.push("steer"),
    },
    _runAgentPrompt: async () => {
      actions.push("start_turn");
    },
    _appendCustomMessage: () => actions.push("append"),
  };
  const pi = {
    sendMessage: (message: unknown, options: DeliveryOptions) => {
      pending.push(
        AgentSession.prototype.sendCustomMessage.call(host, message, options),
      );
    },
  } as unknown as ExtensionAPI;
  sendCompletionMessage(
    pi,
    context("active"),
    "owner",
    0,
    "F05 completed",
    details,
  );
  await Promise.all(pending);
  expect(actions).toEqual(["start_turn"]);
  actions.length = 0;
  host.isStreaming = true;
  sendCompletionMessage(
    pi,
    context("active"),
    "owner",
    0,
    "F05 completed",
    details,
  );
  await Promise.all(pending);
  expect(actions).toEqual(["followUp"]);
}, 30_000);
