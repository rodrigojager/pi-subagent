import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "../shared/types.js";

export function sendCompletionMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ownerSessionId: string,
  depth: number,
  content: string,
  details: SubagentDetails,
): void {
  // A background completion must never land in a different selected session.
  const selectedSessionId = ctx.sessionManager?.getSessionId?.();
  if (
    selectedSessionId &&
    ownerSessionId &&
    selectedSessionId !== ownerSessionId
  )
    return;
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const latestGoal = [...branch]
    .reverse()
    .find(
      (entry) => entry.type === "custom" && entry.customType === "goal-state",
    );
  const data =
    latestGoal?.type === "custom"
      ? (latestGoal.data as { goal?: { status?: string } } | undefined)
      : undefined;
  const inactiveGoal =
    latestGoal !== undefined && data?.goal?.status !== "active";
  const triggerTurn = depth === 0 && !inactiveGoal;
  pi.sendMessage(
    { customType: "subagent-result", content, display: true, details },
    {
      deliverAs: "followUp",
      triggerTurn,
    },
  );
}
