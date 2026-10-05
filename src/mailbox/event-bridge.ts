import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getRunJob,
  listRunJobs,
  removeRunJob,
} from "../orchestration/run-registry.js";
import { refreshBackgroundActivity } from "../progress/background-activity.js";
import {
  cancelProgressState,
  failProgressState,
  finalizeProgressState,
  getProgressState,
  markUnknownProgressState,
  patchProgressState,
} from "../progress/progress-state.js";
import { patchProgressFromDetails } from "../progress/result-details.js";
import type { SubagentDetails } from "../shared/types.js";

interface MailboxEvent {
  job_id?: string;
  event_type?: string;
  payload?: unknown;
}

export function registerMailboxEventBridge(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const seenToolCalls = new Map<string, Set<string>>();
  const refreshActivity = () => {
    if (!context) return;
    const sessionId = context.sessionManager.getSessionId();
    const states = listRunJobs()
      .filter((job) => job.sessionId === sessionId)
      .flatMap((job) => {
        const state = getProgressState(job.requestId);
        return state ? [state] : [];
      });
    refreshBackgroundActivity(context, pi, states);
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  pi.on("session_before_switch", () => {
    context = undefined;
  });
  pi.on("session_shutdown", () => {
    context = undefined;
  });
  pi.events?.on("rodrigojager:pi-agent-mailbox:health:v1", (data) => {
    const event = data as {
      sessionId?: string;
      state?: "responsive" | "disconnected" | "suspected_stall";
    };
    if (
      !context ||
      event.sessionId !== context.sessionManager.getSessionId() ||
      !event.state
    )
      return;
    for (const job of listRunJobs())
      patchProgressState(job.requestId, { health: event.state });
    refreshActivity();
    if (context.hasUI) {
      context.ui.setStatus("subagent-mailbox-health", `${Date.now()}`);
      context.ui.setStatus("subagent-mailbox-health", undefined);
    }
  });
  pi.events?.on("rodrigojager:pi-agent-mailbox:event:v1", (data) => {
    const event = data as MailboxEvent;
    const id = event?.job_id;
    if (!id || !getRunJob(id)) return;
    if (event.event_type === "progress") {
      patchProgressState(id, { jobHealth: "responsive" });
      const details = event.payload as SubagentDetails;
      const seen = seenToolCalls.get(id) ?? new Set<string>();
      seenToolCalls.set(id, seen);
      patchProgressFromDetails(id, details, seen);
    } else if (event.event_type === "suspected_stall") {
      patchProgressState(id, { jobHealth: "suspected_stall" });
    } else if (event.event_type === "terminal") {
      const payload = event.payload as
        | { state?: string; summary?: string }
        | undefined;
      if (payload?.state === "succeeded")
        finalizeProgressState(id, payload.summary ?? "Completed");
      else if (payload?.state === "cancelled")
        cancelProgressState(id, payload.summary);
      else failProgressState(id, payload?.summary ?? "Subagent failed");
      removeRunJob(id);
      seenToolCalls.delete(id);
    } else if (
      event.event_type === "worker_exit" ||
      event.event_type === "worker_error"
    ) {
      failProgressState(id, "Subagent worker stopped unexpectedly");
      removeRunJob(id);
      seenToolCalls.delete(id);
    } else if (
      event.event_type === "supervision_lost" ||
      event.event_type === "persistence_failed"
    ) {
      markUnknownProgressState(
        id,
        "Supervisor lost; subagent result is indeterminate",
      );
    }
    refreshActivity();
    if (context?.hasUI) {
      const key = `subagent-mailbox:${id}`;
      context.ui.setStatus(key, `${Date.now()}`);
      context.ui.setStatus(key, undefined);
    }
  });
}
